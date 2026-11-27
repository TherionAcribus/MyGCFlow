# Page Parcours

La page `/parcours` rejoue une journée ou des vacances **cache par cache**,
dans l'ordre de passage, avec la progression des heures et des jours. C'est
le quatrième mode de l'application, à côté de « Mes Géocaches » (`/`),
« Évolution » (`/evolution`) et « Mes poses » (`/poses`), atteint par le
lien `#linkParcoursMode` de l'en-tête.

Plan, choix produit et découpage : `MyGCFlow_Plan_Parcours.md`. État au
2026-11-16 : **lots 0 à 6** — parcours enregistrés, ordre de passage et
heures reconstruits, lecture et vidéo (géocacheur, trait, heure, distance),
ajustements manuels (ordre, heure épinglée, journée, exclusion, lieux et
bases), photos (rattachement, heure comme ancre, carte postale), traces GPS
(heures de passage, vrai chemin, fuseau), itinéraires réels (FOSSGIS ou
openrouteservice, cache local). Le 2026-11-17 : **lots 8 à 10** — onglet
Photos, réglages par photo (masquée, légende, cadrage), affichage modulable
(près de l'étape, emplacement fixe, bande de vignettes), lieux proposés pour
les photos hors étapes.

## Parcours enregistrés

Un parcours est une **sélection** : nom (80 caractères au plus), plage de
dates (92 jours au plus, `parcours_store.MAX_DAYS`), sources retenues en
plus des trouvailles (étapes Lab, DNF). Table `parcours` (migration v10).

Principe : on stocke la sélection et les ajustements de l'utilisateur
(tables `parcours_override` et `parcours_place`, migration v11), **jamais
l'ordre ni les heures reconstruits**. Ils sont recalculés à chaque
ouverture : un réimport du GPX ne perd rien, une amélioration de la
reconstruction profite aux anciens parcours. Supprimer un parcours supprime
ses ajustements et ses lieux.

Les parcours vivent hors de `/clear_database` : vider la base des
trouvailles laisse les parcours, qui se retrouvent simplement vides.

Trois exports, trois usages. Sur la liste, « Exporter » produit le document
JSON réimportable (sélection, ajustements, lieux — pas de photos ni de
traces). Les lieux copiés ou recréés reçoivent un nouvel id : les clés
« place:<id> » des ajustements y sont recollées (duplication comme
import). Toujours sur la liste, « Exporter tout » produit une archive ZIP
de sauvegarde (`parcours_export.py`, `GET /api/parcours/<id>/export.zip`) :
le même document JSON **enrichi** des métadonnées `photos`, `cameras` et
`tracks` — un sur-ensemble du document v1, que l'import actuel ignore sans
relever de version — plus les fichiers, photos normalisées sous `photos/`
et traces reconstruites en GPX sous `tracks/` (géométrie et heures de la
trace simplifiée ; le fichier d'origine n'est pas conservé). But :
sauvegarde et transfert entre machines ; la réimportation de l'archive
reste à faire. Sur un parcours ouvert, « Exporter GPX » du menu « ⋯ » de la
barre des étapes (`#btnParcoursExportGpx`, `parcours_gpx.mjs` côté client — l'itinéraire
reconstruit suffit, rien ne repasse par le serveur) télécharge un fichier
lisible par un GPS : une `<rte>` par journée, les étapes dans l'ordre,
`<time>` = heure d'arrivée prévue convertie en UTC via le décalage du
parcours ; les étapes exclues ou sans position n'y figurent pas.

## API (`blueprints/parcours.py`)

Toute erreur annule la transaction : `db.session.rollback()` vit dans
`_store_error` et dans les chemins « refusé » (fichier non pris, itinéraire
invalide), jamais dans les routes.

| Route | Rôle |
|---|---|
| `GET /parcours` | La page (`render_app_page('parcours')`) |
| `GET /api/parcours` | `{parcours, finds: {first, last}, maxDays, home, suggestions, suggestionsTotal}` — `finds` borne le formulaire de création ; le relevé des journées de trouvailles est partagé entre le centre habituel et les suggestions, et mémoïsé (`find_days`) sur l'empreinte du fichier de données : tout commit le rebâtit |
| `GET /api/parcours/suggestions` | Parcours suggérés `{suggestions: [{kind: trip / day, start, end, days, findDays, finds, place}], total}` (lot 7, ci-dessous), hors plages déjà enregistrées — seul « … et N autres » l'appelle encore (`limit=0`), la liste les reçoit déjà avec `GET /api/parcours` |
| `POST /api/parcours` | Création `{name, date_start, date_end?, include_labs?, include_dnf?}` ; `date_end` absente = une journée |
| `GET` / `PATCH` / `DELETE /api/parcours/<id>` | Lecture, patch (clé absente = inchangée), suppression. Un rétrécissement de la plage qui laisserait des lieux datés ou des ajustements « journée » dehors est refusé (409 `out-of-range`, compteurs `places`/`days`) : confirmation puis renvoi avec `drop_orphans` — les lieux datés sont supprimés, la journée des ajustements effacée |
| `POST /api/parcours/<id>/duplicate` | Copie sélection, ajustements et lieux (`<nom> (copie)` ; pas les photos ni les traces) |
| `GET /api/parcours/<id>/export` | Document JSON réimportable `{format: mygcflow-parcours, version: 1, parcours, overrides, places}` |
| `GET /api/parcours/<id>/export.zip` | Sauvegarde complète (« Exporter tout ») : le même document enrichi (`photos`, `cameras`, `tracks` — clés ignorées par l'import v1) + photos normalisées et traces reconstruites en GPX (`parcours_export.py`) |
| `POST /api/parcours/import` | Recrée un parcours depuis un export — mêmes validations qu'à la création, tout ou rien |
| `GET /api/parcours/<id>/inputs` | Entrées de la reconstruction (ci-dessous), avec `overrides` et `places` |
| `GET /api/parcours/<id>/adjustments` | Relecture légère après un geste : `{overrides, places, photos, cameras}` (journées et parkings ne sont pas reconstruits) ; `?tracks=1` ajoute les traces avec leurs points |
| `PATCH /api/parcours/<id>/overrides` | `{overrides: [{key, rank?, pinnedTime?, day?, excluded?, legMode?, visitMin?}]}` : un champ présent remplace (null efface), un absent est gardé ; tout ou rien ; une étape sans plus d'ajustement perd sa ligne. Renvoie `{overrides}` |
| `DELETE /api/parcours/<id>/overrides` | Annule tous les ajustements (les lieux restent). Renvoie `{overrides}` |
| `POST /api/parcours/<id>/places` | Lieu `{kind: place, name, lat, lon, date, time?, category?, icon?}` ou base `{kind: base, name, lat, lon, date?, role?, category?, icon?}` (base sans date : toutes les journées ; `role` : `both`/`start`/`end` ; `category` : `other`/`parking`/`meal`/`viewpoint`/`lodging`/`supply`/`custom`, `icon` : classe `ti-…` seulement pour `custom`) |
| `PATCH` / `DELETE /api/parcours/<id>/places/<pid>` | Modification (patch), suppression |
| `POST /api/parcours/<id>/photos` | Envoi d'une photo (multipart, champ `photo`, 15 Mo au plus) ; la même photo deux fois n'est gardée qu'une fois |
| `GET /api/parcours/<id>/photos/<ph>/file` / `thumb` | Photo normalisée / vignette 320 px (cache long, nom = empreinte) |
| `PATCH` / `DELETE /api/parcours/<id>/photos/<ph>` | Rattachement manuel `{stopKey}` (null : automatique), affichage `{hidden, caption, aspect, focusX, focusY, zoom}` (lot 8 ; tout ou rien) ; suppression (fichiers compris) |
| `PATCH /api/parcours/<id>/photos` | Sélection de l'onglet Photos : `{ids, changes}`, mêmes champs que ci-dessus, appliqués à toutes ou à aucune (un id inconnu ou en double refuse tout) → `{photos, cameras}` |
| `POST /api/parcours/<id>/photos/delete` | Suppression d'une sélection `{ids}`, tout ou rien, fichiers après le commit → `{photos, cameras}` |
| `PUT /api/parcours/<id>/cameras` | Décalage d'horloge d'un appareil `{camera, offsetMinutes}` (null : l'oublie ; ±2 jours au plus) |
| `POST /api/parcours/<id>/tracks` | Envoi d'une trace GPX (multipart, champ `track`, 30 Mo au plus), simplifiée à l'import |
| `DELETE /api/parcours/<id>/tracks/<tid>` | Suppression d'une trace |
| `PATCH /api/parcours/<id>` `{utc_offset_minutes}` | Heure locale des traces (minutes, −12 h à +14 h ; null : automatique) |
| `POST /api/parcours/routes` | Itinéraires d'une suite de trajets `{profile: foot / bike / car, waypoints, force?}` → `{legs, provider, requested, error, message}` ; 409 si les itinéraires ne sont pas activés |

Erreurs : `{success: false, error, message}` avec les codes `not-found`,
`name-empty`, `name-too-long`, `date-invalid`, `range-reversed`,
`range-too-long`, `time-invalid` (« HH:MM » attendu), `day-out-of-range`,
`override-invalid`, `place-invalid`, `place-not-found`, `photo-not-found`,
`photo-invalid`, `photos-full` (300 photos par parcours), `camera-invalid`,
`photo-refused` (fichier refusé : `reason` comme l'onglet Images),
`track-refused` (`reason` : `too_large`, `not_gpx`, `no_time`),
`tracks-full` (50 traces par parcours), `track-not-found`,
`utc-offset-invalid`, `out-of-range` (409).

## Entrées (`parcours_dataset.py`)

Un jour par date de la plage, **même vide** (un jour sans cache compte dans
un voyage), chacun avec ses étapes :

| `kind` | Source | Clé | Indices |
|---|---|---|---|
| `find` | `geocache` (My Finds) | code GC | `logId` : plus petit identifiant de log de trouvaille du même jour (`log_event`, compte du joueur) |
| `lab` | `lab_discovery` résolue et datée | `lab:<uuid d'étape>` (sinon `local_uid`) | `localTime` : heure locale réelle (`lab_geojson.found_local_time`) |
| `dnf` | `log_event` (DNF du joueur) | `dnf:<log_id>` | `logId` |

- **Position** d'une trouvaille ou d'un DNF : `log_store.cache_position`
  (fiche `cache_ref` et ligne `geocache`), dans l'ordre : position saisie
  dans « Caches sans position », coordonnées corrigées lues par le favori,
  My Finds (qui porte déjà les corrigées du site au jour de l'export),
  coordonnées publiées de la fiche. `posSource` vaut `corrected` ou
  `manual` dans les deux premiers cas (`null` sinon) ; la liste des étapes
  l'affiche (« coordonnées corrigées », « position saisie ») et le porte
  en `data-pos-source`.
- **PF et chiffres de la fiche** (lot 13) : `favorite` (vrai quand un log
  de trouvaille du joueur ce jour-là porte un point favori,
  `log_event.favorite`), `favoritePoints` et `foundCount` (total de PF et
  nombre de trouvailles de la fiche `cache_ref`), `factsAt` (jour de
  l'export qui les porte : `source_exported_at`, sinon `updated_at`).
  Valeurs **du jour de la collecte**, jamais de celui du passage : la bulle
  de l'étape les date (« 87 PF · 1 505 trouvailles au 21 nov. 2026 »), la
  liste dit « PF donné ».
- **Propriétaire** (`owner`, fiche des caches) : le « placée par » du My
  Finds (`geocache.placed_by`, le nom que montre geocaching.com), sinon le
  propriétaire lu par le favori (`cache_ref.owner_name`), sinon le compte
  propriétaire du GPX (`geocache.owner`) ; `null` pour une étape Lab.
- **Parkings** (lot 14) : `parkings` à côté de `days`, `[{code, name, lat,
  lon}]` — waypoints « parking » des caches du parcours (`cache_waypoint`,
  lus sur leur fiche par le favori). Proposés par la page, jamais posés
  d'office (§ Compléter depuis geocaching.com).
- `logId` croît avec l'ordre de **saisie** des logs, pas forcément avec
  l'ordre de passage. `logsAvailable` est faux sans logs importés ou sans
  compte identifié.
- Un DNF est écarté quand la même cache est trouvée le même jour : la
  trouvaille représente déjà le passage.
- L'heure des trouvailles (`time_find`) n'est **jamais** servie : elle est
  factice dans les GPX (19:00 / 20:00 UTC).
- Une étape sans position est comptée dans `counts.missing_position`, jamais
  placée.

## Client

| Fichier | Rôle |
|---|---|
| `static/js/parcours_reconstruct.mjs` | Pur : ordre de passage, heures, confiance (ci-dessous). Tests : `tests/js/parcours_reconstruct.test.mjs` |
| `static/js/parcours_timeline.mjs` | Pur : temps écran (quanta), position du géocacheur, heure et distance affichées, nuit, cartons de jour, mode de la tête. Tests : `tests/js/parcours_timeline.test.mjs` |
| `static/js/parcours_camera.mjs` | Pur : pose de la caméra de la lecture (lot 7). Tests : `tests/js/parcours_camera.test.mjs` |
| `static/js/parcours_model.mjs` | Pur : utilitaires (étapes du parcours, emprise, jours d'une plage). Tests : `tests/js/parcours_model.test.mjs` |
| `static/js/parcours_style.mjs` | Pur : apparence des étapes et du trait (normalisation, numéros, contraste). Copie de `parcours_style.py`. Tests : `tests/js/parcours_style.test.mjs`, `tests/test_parcours_style.py` |
| `static/js/parcours_stack.mjs` | Pur : étapes empilées (piles, libellé, éventail). Tests : `tests/js/parcours_stack.test.mjs` |
| `static/js/parcours_labels.mjs` | Libellés et formatage de la page (dates, distances, icônes, diagnostics) — pur, `parcours_data.js` lui passe l'état courant. `parcours_gpx.mjs` : export GPX (ci-dessus) |
| `static/js/parcours_tbar.mjs` | Barre de chronologie : série, repères (nuits, jours, DNF, photos), textes et sauts de journée pour `timeline_bar.js`, survol (`hoverAt` : halo de l'étape visée sur le plan). Fabrique `createParcoursTimelineBar` — l'état du parcours ouvert arrive par `getState()` |
| `static/js/parcours_stops_panel.mjs` | Liste des étapes par journée : pliage, recherche (nom, code GC, accents ignorés ; journées dépliées et réordonnancement masqués en vue filtrée), filtre « à vérifier » (`CONFIDENCE_GEO`, combiné à la recherche), réordonnancement (flèches, glisser-déposer), panneau d'ajustement, parkings suggérés. Fabrique `createStopsPanel` — `editKey`/`collapsedDays`/`dragged`/`filterText`/`filterReview` y sont internes. Les journées portent `content-visibility: auto` : seules celles à l'écran sont rendues |
| `static/js/parcours_place_form.mjs` | Pose et déplacement d'un lieu au clic carte + formulaire (journée, type, rôle, catégorie, icône). Fabrique `createPlaceForm` — `picking`/`placeDraft`/écouteur de clic y sont internes |
| `static/js/parcours_adjust.mjs` | Moteur des ajustements : file d'écritures PATCH (fusion locale, ordre des gestes), historique Annuler/Rétablir (y compris lieux recréés : `remapPlaceId`), gestes rang/journée, CRUD des lieux. Écritures en `keepalive` et renvoi de secours de celles encore en file à la fermeture de la page (`closingWrites` sur `pagehide`, dans `parcours_data.js` — une écriture déjà reçue s'applique sans effet). Fabrique `createParcoursAdjust` — `undoStack`/`redoStack`/`overridesQueued`/`pendingWrites` y sont internes |
| `static/js/parcours_style_ui.mjs` | Panneau « Style du parcours » : contrôles ↔ objet `parcours_style` normalisé (rendu, numéros, palette des journées, lecture, trait). Fabrique `createParcoursStyleUI` — écriture dans le thème injectée |
| `static/js/parcours_paints.mjs` | Peintures des étapes du plan et de la lecture : pastilles numérotées, lieux/bases, piles et éventails, halo, cœur des PF, lignes de journées, points du thème. Fabrique `createParcoursPaints` — mémoïsé par objet de réglages ; l'état de la pile (`fan`) est injecté, il vit dans `parcours_plan.mjs` |
| `static/js/parcours_tracks_panel.mjs` | Panneau « Traces GPS » : liste, réglage du décalage UTC, envoi et suppression. Fabrique `createTracksPanel` — état par `getState()`, opérations du parcours injectées |
| `static/js/parcours_photos_panel.mjs` | Panneau « Photos » : grille, lieux proposés, détail (rattachement, légende, cadrage), réglages d'affichage. Fabrique `createPhotosPanel` — `photoDetailId`/`photosDirty` y sont internes |
| `static/js/parcours_upload.mjs` | Envois mutualisés photos/traces (`createParcoursUploads` : concurrence bornée, « Arrêter », cible figée au départ) et glisser-déposer de fichiers sur la page (`bindParcoursFileDrop`) |
| `static/js/parcours_play.mjs` | Dessin de la lecture : couches `parcours-trail`/`parcours-head` (postrender), trait parcouru et trajet en cours, géocacheur, étapes atteintes, nuit, cartons, crédits des itinéraires, cartes postales des photos (chargement vignette/pleine taille, `photosReady`, `previewPhoto`). Fabrique `createParcoursPlayDraw` — couches et caches d'images y sont internes, état par `getState()`, peintures partagées via `paints` |
| `static/js/parcours_list.mjs` | Liste des parcours (ouvrir, modifier, dupliquer, exporter, supprimer), formulaire de création/modification (import JSON, plages rétrécies avec `drop_orphans`), parcours suggérés, export GPX. Fabrique `createParcoursList` — édition en cours et suggestions y sont internes |
| `static/js/parcours_routing_ui.mjs` | Carte « Itinéraires » : réglages (activation, fournisseur, clé ORS), calcul des routes en chaîne, cache de page, progression et « Réessayer »/« Arrêter »/« Recalculer ». Fabrique `createParcoursRouting` — `routeCache`/`routeSeq`/`routeState`/`routeRunsNow`/`routeEffectsNow` y sont internes, `computeRuns` sert la reconstruction |
| `static/js/parcours_camera_ui.mjs` | Caméra de la lecture : suivi du géocacheur (pose pré-rendu de `parcours_camera.mjs`), vue sauvegardée/restituée, suspension quand l'utilisateur reprend la main, tuiles préchargées. Fabrique `createParcoursCamera` |
| `static/js/parcours_playback_ui.mjs` | Section « Lecture » (onglet Animation & vidéo) et sous-onglet « Caméra » : rythme, heures, caméra, tête, cartons, nuit — persiste `parcours_playback` et redessine ou reporte la chronologie. Fabrique `createParcoursPlaybackUI` |
| `static/js/parcours_plan.mjs` | Plan du parcours au repos : couche `parcours` (z 1060, étapes reliées par journée, traces GPS, point provisoire de la pose), piles et éventail, lien liste/barre ↔ carte (halo, lignes surlignées — le survol de la piste de chronologie entoure aussi l'étape visée), glisser des repères (lieu, base, étape → ajustement), bulle d'actions au clic, menu « Poser un lieu / une base » au clic droit, cadrage sur l'emprise. Fabrique `createParcoursPlan` — couche, piles, éventail, survol et glisser y sont internes |
| `static/js/parcours_data.js` | Module de page : liste, création, suppression, étapes, plan, actions depuis la carte, moteur de lecture |
| `templates/menu_data_parcours.html` | Onglet Données |

Dans l'onglet Données, chaque étape porte son heure d'arrivée (exacte pour
une ancre, « ≈ » sinon) et la raison de sa place ; chaque journée, sa
distance et le verdict sur l'ordre des logs. L'en-tête de journée
(« Samedi 12 juillet 2025 », majuscule au premier mot seulement, compte
d'étapes au singulier comme au pluriel) est plus grand que les étapes et
souligné. Les actions d'une ligne (lire depuis ici, monter, descendre,
poignée) sont effacées au repos et apparaissent au survol, au focus clavier,
au survol du point sur la carte (`is-map-hover`) et pendant l'ajustement
(`is-editing`) — opacité, pas `display` : la ligne ne bouge pas.

Disposition de l'onglet (grille `.parcours-data-grid`, trois zones) :
« Mes parcours », « Étapes », « Enrichir le parcours ». Large : étapes à
droite. Étroit — fenêtre < 992 px ou panneau latéral, où le viewport reste
large — : une colonne, étapes juste sous la liste. Le formulaire de
création (suggestions et import compris) est replié derrière « Nouveau
parcours » dès qu'un parcours existe ; il s'ouvre d'office sans parcours
et en modification (crayon), « Fermer » le replie. « Enrichir le
parcours » regroupe Traces GPS, Itinéraires et Compléter depuis
geocaching.com en `<details>` repliés (`data-enrich-key` : `tracks`,
`routing`, `collect`), avec un état lisible dans l'en-tête ; l'ouverture
est retenue par le navigateur (`localStorage` `parcours.enrichOpen`). Un
envoi de traces ouvre leur section, une demande de collecte ou un export
reçu celle de geocaching.com.

Le cadrage automatique sur l'emprise du parcours (`fitParcours`,
parcours_plan.mjs) est refait quand la carte change de taille
(disposition, séparateur, fenêtre) tant que la vue n'a pas bougé depuis et
qu'aucune lecture ne tourne — une vue déplacée par l'utilisateur n'est
jamais recadrée. Un clic sur une étape de la carte referme le panneau
d'ajustement d'une autre étape (`closeDetailsExcept`). Sans parcours, l'état
vide de la carte porte un bouton « Créer un parcours » (onglet Données,
curseur dans le nom). Dans la liste des parcours, les comptes s'écrivent
en clair et s'accordent (« 1 ajustement », « 5 étapes »).

**Plan au repos** : couche vectorielle propre (`parcoursLayer`, zIndex 1060,
au-dessus des points WebGL pour garder les numéros lisibles), points
numérotés colorés par nature (trouvaille, Lab, DNF) et une ligne par jour
(la nuit n'est pas un trajet). Masqué pendant la lecture. Rien n'entre dans
`pointsByDate`. Le dernier parcours ouvert est retenu
(`localStorage['parcours.lastId']`) et cadré (zoom 16 au plus).

**Apparence des étapes et du trait** (bloc du thème `points.parcours_style`,
`parcours_style.py` / `parcours_style.mjs`, depuis le 2026-11-19) :

| Clé | Valeurs (défaut en premier) | Où |
|---|---|---|
| `render` | `stops` (pastilles du parcours), `theme` (points du thème) | Style › Points, carte « Étapes du parcours » |
| `numbers` | `trip` (rang sur tout le parcours), `day` (rang dans la journée), `none` | Style › Points, carte « Étapes du parcours » |
| `size` | rayon des pastilles, 7-18 px : 11 | idem |
| `color_by` | `kind` (par nature : `colors`), `day` (par journée : `day_palette`), `type` (par type de cache : couleurs Geocaching, `defaultGcColors`) | idem |
| `colors` | `find` #0072c6, `lab` #f59f00, `dnf` #868e96, `place` #ae3ec9, `base` #343a40 | idem |
| `plan_line` | `dashed`, `solid`, `none` | Style › Trajet (sous-onglet propre à la page) |
| `trail_color`, `trail_width`, `trail_opacity` | #00b8d4, 1-12 px : 3, 10-100 % : 100 | idem |
| `trail_by_day` | `false` ; vrai : trait, ligne du plan et géocacheur aux couleurs des journées | idem |
| `play_current` | `true` : l'étape en cours entourée d'un anneau qui pulse | Style › Points, rubrique « Pendant la lecture » |
| `play_past` | `normal`, `dim` (étapes quittées atténuées), `dim_days` (celles des journées précédentes) | idem — rendu « pastilles » |
| `play_preview` | `false` ; vrai : aperçu pâle des étapes à venir de la journée, reliées par un fil | idem — rendu « pastilles » |
| `favorite_mark` | `true` : cœur sur un rond blanc en haut à gauche des étapes où un PF a été donné (une pile : si l'une de ses étapes en a un), au repos, en lecture et dans la vidéo | Style › Points, rubrique « Points favoris donnés » |
| `favorite_burst` | `true` : envol de cinq cœurs à l'arrivée sur l'étape (`favoriteBurst`, 12 quanta, la durée d'une visite au rythme régulier) | idem |
| `day_palette` | 2 à 12 couleurs, `DAY_PALETTE` (8) par défaut | Style › Points, sous « Couleur des étapes » (montrée en couleur par journée ou avec `trail_by_day`) |

**Lecture plus lisible** (depuis le 2026-11-20, `playPhase` et
`currentRingRadius` de `parcours_style.mjs`) :
- une étape est « en cours » de son arrivée (`q`) à son départ
  (`departQ`) : anneau de sa couleur, sur un voile blanc léger, dont le
  rayon pulse d'une seconde d'écran (de +6 à +12 px : il déborde du
  géocacheur, posé sur l'étape pendant la visite). Fonction de la position
  du moteur seule, donc identique en capture image par image. Une pile
  qui contient l'étape en cours est entourée ; un lieu aussi, pas une base ;
- étapes passées (`dim` : quittées ; `dim_days` : des journées d'avant
  celle du géocacheur — la nuit compte pour le lendemain) : opacité 0,4,
  échelle 0,85 ; une pile n'est atténuée que si toutes ses étapes le sont ;
- aperçu de la suite : étapes comptées de la journée du géocacheur pas
  encore atteintes, opacité 0,3, reliées depuis lui par un fil pointillé
  fin de la couleur du trait ; pas de piles dans l'aperçu ;
- atténuation et aperçu demandent le rendu « pastilles » (contrôles grisés
  en points du thème : les points WebGL y apparaissent seuls) ;
- sans réglage : en lecture, un lieu apparaît en grossissant comme les
  étapes ; une base n'apparaît qu'à sa première occurrence (sa journée),
  une seule fois, en grossissant — avant, toutes les bases étaient là dès
  le début de la vidéo.

Coût par image (banc `tests/js/parcours_perf_bench.mjs` et
`tests/e2e/parcours-perf.spec.mjs`, parcours de 500 étapes) : les requêtes
pures de la chronologie (trajet, tête, compteurs, scène — bissections et
préfixes mémorisés) pèsent ~2 µs ; le dessin est l'essentiel. Trois
mécanismes le bornent : les piles sont regroupées par mémo (`playStacksMemo`)
dont la résolution est lue par paliers de ~3 % (en zoom continu, le
regroupement serait sinon refait à chaque image) ; les piles hors écran ne
sont pas peintes (`drawn` du relevé = peintes ; `dimmed`, `favorites`,
`piles`, `current`, `ring` restent des états atteints) ; anneau et cœurs
réutilisent leurs styles (palier de 0,25 px ; style muté en place) au lieu
d'allouer à chaque image. Mesuré : dessin médian 1,1 → 0,2 ms/image.

**Couleur par journée ou par type** (depuis le 2026-11-20, `stopPaint` de
`parcours_style.mjs`) :
- palette du thème (`day_palette`, depuis le 2026-11-20) : une case par
  couleur, « + » (la première couleur par défaut absente, sinon la teinte la
  plus éloignée de celles de la palette, `nextPaletteColor`), « − » (la
  dernière), « Palette par défaut » (`DAY_PALETTE` / `PARCOURS_DAY_PALETTE`,
  huit couleurs, comparées par le test JS avec les bornes `PALETTE_SIZE`).
  Elle reprend au début après sa dernière couleur. Une liste invalide ou de
  moins de deux couleurs valides retombe sur la valeur courante.
  L'index d'une journée est son rang dans la plage du parcours, jours vides
  compris (`dayIndexes` de parcours_data.js) : une journée garde sa couleur
  quand une autre se vide ;
- par type de cache : couleur Geocaching du type (`Adventure Lab` pour une
  étape Lab), à défaut celle de la nature ;
- hors du mode par nature, un DNF n'a plus de couleur propre : il passe en
  **pastille creuse** (fond blanc, contour et numéro de la couleur) ;
- lieux et bases gardent toujours leur couleur ;
- la liste suit : pastille de l'étape, et point de couleur devant la date
  de chaque journée (couleur par journée ou trait aux couleurs des journées) ;
- trait aux couleurs des journées : un trajet prend la couleur de la
  journée de son arrivée — la nuit, celle du lendemain ; le géocacheur,
  celle du trajet en cours ou de la dernière étape atteinte. Les trajets
  terminés sont regroupés par nature et par journée (`doneTrailGroups`).

- La liste de l'onglet Données reprend la couleur et le numéro du plan
  (sans numéros sur la carte, elle garde le rang sur tout le parcours).
- Le numéro passe en sombre sur une couleur claire (`contrastTextColor`) et
  rétrécit à partir de trois chiffres (`numberFontPx`).
- La ligne du plan prend la couleur (celle de sa journée avec
  `trail_by_day`) et l'épaisseur du trait, à 55 % de son opacité ; le
  géocacheur prend la couleur du trait, opaque.
- **Un seul rendu** (depuis le 2026-11-20), au repos, pendant la lecture
  et dans la vidéo :
  - `stops` : les étapes comptées sont des pastilles numérotées, dessinées
    par la page — le plan au repos, `drawPlayStops` image par image en
    lecture. La couche WebGL des points du thème est masquée (moteur ›
    `hidesPoints`, lu par `mainPointsHidden` de mapgl.js) mais garde ses
    features : flashs, compteurs et étendue en dépendent. Le graphisme des
    points du thème (Icône / Vectoriel, apparition animée, persistance —
    les pastilles ont leur propre apparition) n'y a donc aucun effet
    visible : son bloc (`#pointsThemeBlock`, `#iconeOptions`) est masqué
    par la classe `parcours-stops-render` de `#points`, et un bandeau le
    remplace, qui propose de passer en `theme` (`#parcoursThemePointsHint`,
    2026-11-21 — sans lui, « Icône » semblait ne rien afficher ; bloc
    masqué depuis le 2026-11-23). Sur /parcours, la carte « Étapes du
    parcours » ouvre l'onglet Points, avant ce bloc.
  - `theme` : les points du thème (onglet Points) sont affichés ; le plan
    et la lecture n'y ajoutent que le numéro, dans une petite pastille en
    haut à droite (`themeNumberBadge`, posée d'après le rayon approché du
    point : centre + contour). Au repos, un disque invisible garde l'étape
    survolable et cliquable.
  - En lecture, une étape qui arrive grossit de rien à sa taille en 3
    quanta (`stopPopScale`, léger dépassement) ; la dernière arrivée est
    dessinée au-dessus (au repos, c'est le n° 1). Lieux et bases gardent
    leur couleur et leur pastille de catégorie dans les deux rendus.
  - En mouvement réduit (`prefers-reduced-motion`, aperçu seulement — la
    vidéo enregistrée garde le dynamisme complet) : pastilles à taille
    pleine dès l'arrivée, anneau fixe à mi-amplitude, pas d'envol de
    cœurs, photos qui entrent au fondu et sans Ken Burns.
  - Avant, le plan posait ses pastilles PAR-DESSUS les points du thème,
    affichés aussi au repos, et la lecture ne montrait que les points du
    thème, sans numéros : la vidéo ne ressemblait pas au plan préparé.
- Le sous-onglet Trajet du mode principal reste masqué sur les pages cycle
  de vie : le thème étant partagé, régler `trail` d'ici changerait la page
  principale. Avant ce bloc, la lecture lisait `trail.color` / `trail.width`
  sans aucun moyen de les régler depuis `/parcours`.
- Un thème chargé passe par `syncPointOptionsUI` (→ `syncParcoursStyleUI`)
  puis `refreshPoints` (→ moteur › `styleChanged`, qui redessine le plan et
  la liste).

**Onglets** : Données, Style, Animation & vidéo, Préférences. Stats et
Images ne sont pas encore branchés : leurs volets restent dans la page
(ui.js les attend), sans onglet. La plage de dates et le champ « jours par
seconde » de l'onglet Animation sont masqués par CSS
(`body[data-mode="parcours"]`) ; la barre de chronologie est adaptée
(ci-dessous).

## Lecture et vidéo (`parcours_timeline.mjs`, `parcours_data.js`)

La page passe par le moteur « cycle de vie » d'Évolution et de Mes poses
(`isLifecyclePage()` est vrai sur `/parcours`, `lifecycle_engine.mjs`).
Un « jour » du moteur y est un **quantum de temps écran** : 100 ms à la
vitesse naturelle, 10 quanta par seconde.
- Chaque étape est une feature WebGL dont `placedDay` est le quantum de son
  arrivée : le shader la fait apparaître, `mapgl.js` joue le flash. En
  rendu « pastilles », cette couche est masquée et les pastilles sont
  peintes par la page (voir « Apparence des étapes et du trait »).
- Les dates du moteur partent d'une origine fictive (1er janvier 2000), qui
  n'est jamais affichée.
- Durée totale, calage sur la musique, pause, enregistrement image par image
  et MediaRecorder : tout passe par le moteur existant, qui ne fait que
  changer la durée d'un quantum.

**Temps écran** (`buildParcoursTimeline`, réglage « Rythme des étapes ») :

| | Durée d'une étape | Durée d'un trajet |
|---|---|---|
| **Régulier** (défaut) | 12 quanta (1,2 s) | 6·√km quanta, borné entre 4 et 30 |
| **Proportionnel** | visite reconstruite, 1 quantum pour 2 min (3 au moins) | trajet reconstruit, même échelle (1 au moins) |

S'y ajoutent :
- 5 quanta avant la première étape et 10 après la dernière ;
- une **nuit** de 20 quanta entre deux journées : trajet pointillé, la date
  et l'heure passent au lendemain. Un trou calendaire l'allonge — ellipse
  ressentie : ×1,5 pour un jour sauté, plafond ×2.

Les jours sans étape sont sautés, mais `{jour}` garde le rang de la date
dans la plage — c'est lui qui fait ressortir le trou ci-dessus.

**Sous le quantum naturel** (durée imposée, musique, rythme au-delà de
10 quanta/s), la compression ne rend pas illisible ce qui doit être lu :
les contenus « à lire » — photos, nuit (le carton du jour s'y affiche),
intro, outro et carton final — gardent leur durée écran naturelle, qui
devient un plancher de quanta (`timing` de `buildParcoursTimeline`). Le
temps manquant est pris sur les visites et les trajets, qui se
compressent. En durée imposée ou calée sur la musique, le total de quanta
est conservé (`fixedTotal` : la durée annoncée tient exactement) ; en
vitesse libre, la chronologie s'allonge d'autant. Quand les planchers ne
tiennent plus ensemble dans la durée voulue, ils se partagent jusqu'à
70 % du temps écran. La chronologie est reconstruite au changement du
plan (`mygcflow:timing-plan`), différée à la fin de lecture comme un
changement de rythme. Maintien et fondu du carton de jour suivent le même
principe (`sceneTimingOptions`).

**À chaque image**, `frameVars` donne la position fractionnaire du moteur
(dernier quantum joué + part écoulée). Elle reste calée sur les apparitions
même quand le moteur rattrape plusieurs quanta dans une image. De cette
position se déduisent :
- **la tête** (le géocacheur) : interpolation adoucie le long du trajet en
  cours (`headAt`), dessinée par la couche `parcours-head` (zIndex 1050) ;
- **le trait** : trajets terminés, plus la part faite du trajet en cours
  (`trailAt`), dessiné par la couche `parcours-trail` (zIndex 1000) ;
- **la ligne d'infos** : `infosValues` (`stateAt`).

Les deux couches dessinent dans leur `postrender` : la capture vidéo, qui
compose tous les canevas de la carte, les filme. Leur couleur, leur
épaisseur et leur opacité sont celles du thème (`points.parcours_style`,
ci-dessus).

Coût par image : l'état à `currentQ` (trait, tête, journée, pictogramme) est
mémoïsé une fois par image (`frame` de `parcours_play.mjs`) au lieu d'être
relu par chaque dessin ; les balayages de la chronologie sont bornés
(`reachedIndex`, dichotomies de `trailAt`, `legIndexAt`, `stopsInRange`,
`headModeAt`), les comptes de `stateAt` viennent de sommes préfixes
calculées à la construction, la table des nuits de `dayCardAt` est gardée
par chronologie, et les géométries de travail (tête, aperçu, point partagé)
sont réutilisées au lieu d'être allouées à chaque image.

**Ligne d'infos** (modèle `parcours_infos_template`, onglet Style ›
Titres) :
- `{date}` : la vraie date du jour, pas le quantum du moteur ;
- `{heure}` : interpolée entre les heures reconstruites. Pendant un
  trajet, de l'heure de départ à l'heure d'arrivée ; la nuit, l'heure
  d'arrivée du lendemain. Elle suit le réglage « Heures affichées » :
  approximatives (« ≈ » si une extrémité est estimée), exactes, moments de
  la journée (matin < 12 h, midi < 14 h, après-midi < 18 h, soir) ou
  aucune ;
- `{jour}`, `{jours}`, `{km}` ;
- compteurs animés `{etapes}`, `{caches}`, `{labs}`, `{pf}` (PF donnés sur
  les trouvailles atteintes), et `{total}`.

Crochets optionnels ajoutés au contrat du moteur :
- `infosValues(now)` : valeurs texte qui priment sur les compteurs et sur la
  date du moteur ;
- `frameActive(now)` : entretient le rendu entre deux quanta ;
- `camera(leadMs, msPerDay)` : pose la vue avant chaque rendu (lot 7,
  ci-dessous) ;
- `titleText()` : titre de la carte et de la vidéo imposé par la page (nom
  du parcours, réglage `title`) ; `null` rend celui du thème ;
- `timingUnits()` : tête de la synthèse du minutage de l'onglet Animation
  (« 5 étapes · 2 jours » au lieu de « 178 jours · 10 jours/s », des
  quanta) ; les mentions en jours qui suivent (« jours par image », jours
  regroupés) sont alors omises.

Ouvrir un autre parcours ou changer le rythme pendant une lecture : appliqué
à la fin (`applyPending`).

**Préférences globales** (settings.json), toutes propres à la page — le
repli de `perPage` sur la page principale faisait réécrire ses clés
(`animation`, avec le suivi de caméra remis à `false`, et
`last_profile_uid`) :

| Clé | Contenu |
|---|---|
| `parcours_animation` | Rythme (défaut : « Vitesse » 10 quanta/s ; préréglages lent ×0,5 / normal / rapide ×2), durée totale, musique ; jamais de suivi de caméra du mode principal |
| `parcours_infos_template` | Modèle de la ligne d'infos (défaut `{date} · {heure} · {etapes} / {total} · {km}`) |
| `parcours_playback` | `{pace: regular / proportional, hours: approx / exact / slots / none, camera: follow / fixed, framing: tight / balanced / wide, day_cards, head: mode / dot, estimated_dashed, title: name / theme}` (défauts : `regular`, `approx`, `follow`, `balanced`, `true`, `mode`, `false`, `name`) — `title` : titre de la carte et de la vidéo, nom du parcours ouvert ou titre du thème (Style › Titres, « Titre affiché ») ; le titre du thème, partagé avec les autres pages, n'est jamais réécrit — le crochet moteur `titleText()` le remplace à l'affichage (`updateTitleFrame`, frames.js), et la vidéo peint `#titleFrame` |
| `parcours_last_profile_uid` | Dernier thème de la page (thèmes du mode principal ; première visite : celui de la page principale) |
| `stats.parcours_panels`, `images.parcours_items` | Listes par page, vides tant que les onglets ne sont pas branchés |

Limites actuelles :
- trajets en lignes droites sans itinéraires (option du lot 6, désactivée
  par défaut) ;
- un DNF apparaît comme une cache de son type.

### Barre de chronologie

La barre commune (`timeline_bar.js`, bouton `#btnTimelineBar`) compte en
jours du moteur, donc ici en quanta sur des dates fictives. Le moteur de la
page lui passe un crochet `timelineBar` (`PARCOURS_TIMELINE_BAR` de
parcours_data.js, contrat dans lifecycle_engine.mjs) qui remplace ce qui
supposait de vraies dates :

| | Page principale | Parcours |
|---|---|---|
| Piste | plage + marges grisées | le parcours entier, sans marges |
| Histogramme / courbe | trouvailles par jour, cumul | arrivées aux étapes par quantum (Labs empilés), étapes atteintes (`barSeries`) |
| Repères de fond | débuts d'année | nuits en bandes, « Jour n » ; journée unique : heures pleines, sauf heures masquées ou en tranches (`barTicks`) |
| Repères du haut | trouvailles rondes, DNF, poseur, images | DNF, photos d'une étape (carré ambré, au début de la première) |
| Bouts, étiquette, bulle | dates | vraie date et heure ; bulle : jour, étape / trajet (mode, km) / nuit, total en étapes et km |
| Bornes tirables, clic droit | oui | non (`rangeEditable: false`) |
| Pg.Préc / Pg.Suiv | un mois | journée suivante / précédente (arrivée à sa première étape) |
| Molette | un jour par cran | 5 quanta (½ s) par cran |

Le survol de la piste (hors geste et enregistrement) entoure d'un halo le
point de l'étape visée sur le plan — destination du trajet sous le
pointeur, étape atteinte sinon — via le crochet `hoverAt` de l'adaptateur
(optionnel : les autres pages ne l'ont pas). Le sens inverse, survol d'une
ligne de la liste → halo sur le plan, existait déjà.

Ctrl+← / → saute d'une arrivée à l'autre ; le saut lui-même est celui de
toutes les pages (`seekAnimationToDate`, aperçu ouvert en pause). L'étiquette
au curseur (date, heure, étapes, instant de la vidéo) a une largeur fixe sur
cette page : sa longueur varie d'une étape à l'autre et la piste se
décalait sous le pointeur. Elle tient sur deux lignes (« date · heure »,
puis étapes et instant de la vidéo — saut de ligne posé par
`barPositionText`, `white-space: pre-line`), 14em au lieu de 22em, et les
bouts sont courts (la date seule sur plusieurs journées, l'heure seule sur
une journée) : en panneau latéral, la piste n'avait plus que ~190 px sur
une barre de 890 px (452 px depuis le 2026-11-23). Une barre étroite
(< 520 px) remet l'étiquette sur une ligne et masque les bouts. Les
étiquettes de la piste (journées ; années sur la page principale) ont un
liseré de la couleur du voile, lisibles sur une barre de l'histogramme.
La série et les repères sont mémoïsés sur
`timelineRevision` (incrémenté à chaque chronologie) et le réglage des
heures.

### Chapitres de la vidéo

Une vidéo de parcours sur plusieurs journées porte un chapitre par journée
(`parcours_chapters.mjs`, côté serveur `video_chapters.py`) :

- **Bornes.** Un chapitre commence avec la nuit qui précède sa journée
  (`timeline.days[i].startQ` : trajet de nuit et carton « n jours plus
  tard » inclus, comme dans la chronologie) ; le premier commence à 0 s et
  couvre le carton d'ouverture.
- **Instants relevés, pas recalculés.** `parcoursStep` note l'instant
  vidéo (`recordingVideoTimeMs` de mapgl.js : images capturées ÷ fps en mode
  images, temps actif en MediaRecorder) au premier pas qui atteint chaque
  borne. Pré-roll, pauses et images de caméra sont ainsi comptés tels qu'ils
  sont dans le fichier. Le ralentissement MediaRecorder est retiré à l'envoi
  (`serverNormalizationFactor`). Un aperçu ne note rien.
- **Envoi.** Champ `chapters` (JSON `[{start, day, date}]`, date déjà
  formatée) de `/start_create_video` et de `/process_recorded_video` ;
  moins de deux chapitres : rien. `parse_chapters` écarte toute entrée mal
  formée sans faire échouer l'export.
- **Dans le MP4.** Tous les chapitres, quelle que soit leur durée : fichier
  de métadonnées ffmpeg passé en entrée (`-f ffmetadata`, `-map_chapters`)
  dans l'encodage existant, sans passe de plus. Titres « Jour n — date »
  traduits côté serveur. Lus par VLC, mpv… ; `video_validator.py` les
  rapporte (`chapters`).
- **Pour YouTube.** `<vidéo>.youtube.txt`, à côté du MP4, et bloc
  « Copier pour YouTube » de l'écran « Vidéo prête ». YouTube ignore toute
  la liste si un chapitre dure moins de 10 s ou s'il y en a moins de
  trois : une journée trop courte rejoint la précédente (« Jours 3 à 4 »),
  la première rejoint la suivante ; sous trois chapitres, pas de fichier
  et l'écran le dit. La suppression d'une vidéo (« Dernières vidéos »)
  emporte son `.youtube.txt`.

Relevé : `getParcoursSnapshot().chapters` (journal de la dernière capture,
ms bruts) et `timeline.dayStartQ`.

### Fiche des caches (`points.parcours_info`)

Nom, D/T, propriétaire et PF de la fiche (`favoritePoints`) d'une étape,
**au choix** (quatre cases ; rien de coché = rien d'affiché). Bloc du thème
`points.parcours_info` (`parcours_info.py`, copie `parcours_info.mjs`, table
comparée via `tests/fixtures/parcours/parcours_info.json`), sous-onglet
Style › Fiches propre à la page (`menu_info_parcours.html`,
`parcours_info_ui.mjs`). **Coupée par défaut** (`near` et `fixed` à
`none`) : un thème antérieur garde son rendu.

- **Contenu** (`infoContent`) : un élément inconnu est omis — Lab sans D/T
  ni propriétaire, PF connus seulement après « Compléter depuis
  geocaching.com ». Lieux et bases n'ont jamais de fiche.
- **À côté de la cache** (`near`) : `current` (« temporaire ») = la
  dernière étape comptée atteinte, de son arrivée jusqu'à son départ et au
  moins `duration` s d'écran (converties en quanta par `msPerDay`), coupée
  à l'arrivée de la suivante (`infoAlpha`, `currentInfo`) ; `all`
  (« permanent ») = toutes les étapes atteintes. Placement glouton sans
  chevauchement (`placeInfoLabels` : droite, gauche, dessus, dessous, puis
  les quatre diagonales) par priorité — étape en cours toujours posée
  (`force` : la place qui recouvre le moins, ramenée dans l'image si elle
  en sortait — jamais hors cadre), puis de la plus récente à la plus
  ancienne ; les fiches sans place sont masquées (`hidden` du relevé). Obstacles : pastilles des étapes et cartouches HTML
  de la carte (titre, ligne d'infos, légende). Dans une pile, seule la plus
  récente garde sa fiche. L'étape en cours la pose au-delà de l'anneau et
  du géocacheur (`ring`), avec un trait de rappel. Le placement est
  **stable d'une image à l'autre** : chaque fiche retient son côté
  (`memory` de `placeInfoLabels`, clé = étape) et ne le quitte que s'il ne
  tient plus — sinon les fiches changeraient de côté à chaque mouvement de
  caméra. Apparitions et disparitions en **fondu** de 0,3 s
  (`createInfoVisibility` : une fiche qui perd ou regagne sa place ne
  saute pas ; celle qui disparaît finit son fondu à sa dernière place,
  sans trait de rappel, depuis l'opacité qu'elle avait — une fiche
  temporaire en fin de fenêtre, déjà éteinte, ne ressurgit pas). Le temps
  des fondus est celui de la chronologie en lecture, pause et
  enregistrement (déterministe pour la vidéo image par image), l'horloge
  réelle au repos — où le rendu est redemandé tant qu'un fondu n'est pas
  fini. Un saut en arrière fige l'état (tout net, pas de fiche fantôme) ;
  lecture réduite : fondus nuls. Le relevé `near`/`hidden` ne voit que le
  placement de l'image (les fiches en fondu de sortie n'y figurent pas).
- **Ailleurs** (`fixed`) : cartouche de l'étape en cours (même fenêtre que
  le temporaire), 1,3× plus grand, en haut, en bas ou dans un coin ;
  `fixedInfoPosition` le décale sous (en haut) ou au-dessus (en bas) des
  cartouches HTML qu'il chevaucherait et le borne dans l'image — même
  décalé par plusieurs cartouches ou trop large, il reste visible, quitte
  en tout dernier recours à recouvrir ce qu'il évitait. L'agrandissement
  est réduit quand le cartouche dépasserait la largeur de l'image
  (`fixedInfoScale` : long nom, grande taille, vidéo verticale).
- **Au repos** (couche du plan, postrender) : permanent = toutes les
  étapes seules à leur place (une pile fermée n'en a pas, son éventail
  oui) ; temporaire = l'étape survolée, sur la carte ou dans la liste.
  **Sous-onglet Style › Fiches ouvert** : une vraie fiche d'exemple est
  épinglée sur l'étape la plus proche du centre de la vue — même fiche
  coupée, pour juger les réglages tout de suite — et le survol d'une
  autre étape montre la sienne (en permanent, tout est déjà visible).
  L'étape épinglée est gardée tant qu'elle reste visible à l'écran, pour
  ne pas sauter d'étape en étape au fil du panoramique ; l'exemple
  disparaît dès que le sous-onglet — ou l'onglet Style — est quitté. Le
  cartouche, lui, n'a pas d'exemple au repos (il suit l'étape en cours,
  qui n'existe qu'en lecture).
- **Design** (`parcours_info_draw.mjs`, canevas, filmé) : `tag` (une
  ligne en pilule), `card` (nom, D et T en pastilles, PF, propriétaire,
  barre d'accent), `banner` (fond à la couleur d'accent, texte contrasté),
  `text` (texte seul, liseré de la couleur du fond) ; police (piles de
  `name_labels.mjs`), taille, couleurs du texte et du fond, opacité,
  accent « couleur de l'étape » (`paintOfStop`) ou fixe. Fondu de 0,3 s
  (et glissement du cartouche), sans mouvement en lecture réduite — borné
  au quart de la fenêtre de l'étape : une fenêtre courte (étapes
  rapprochées, la suivante coupe la durée réglée) garde une fiche nette à
  l'opacité pleine sur sa moitié centrale au lieu de clignoter sans
  jamais s'afficher franchement. Les vignettes des designs dessinent une
  fiche d'exemple avec les réglages courants.

Relevé : `getParcoursSnapshot().info` — `settings`, `play` (`current`,
`near`, `hidden`, `fixed`, `alpha`, `size` de la dernière image) et `rest`
(`near`, `hidden`, `hover`, `preview` — clé de la fiche d'exemple épinglée
ou `null`). Tests : `tests/test_parcours_info.py`,
`tests/js/parcours_info.test.mjs`, `test_stop_owner_for_the_cache_card` de
test_parcours_api.py, e2e `tests/e2e/parcours-info.spec.mjs`.

### Finitions (lot 7)

Réglages de la section « Lecture » de l'onglet Animation & vidéo (sous-onglet
« Dates & rythme » ; caméra, cadrage et géocacheur dans le sous-onglet
« Caméra »), lus à chaque image : ils s'appliquent aussi en pleine lecture.

**Caméra** (`parcours_camera.mjs`, réglage « Caméra », défaut « Suit le
géocacheur ») :
- deux pistes précalculées une fois par chronologie et par taille de vue
  (un échantillon par demi-quantum, interpolées entre deux) ;
- centre : la position du géocacheur (`headAt`), lissée par une gaussienne
  (σ = 4 quanta), plus une avance dans le sens de la marche (le déplacement
  de 3 quanta, au plus 30 % du demi-écran). La caméra suit le chemin et
  ne part pas avant le géocacheur ;
- zoom : ce que le géocacheur parcourt de 0,4 s avant à 0,8 s après doit
  tenir dans 70 % du demi-écran (900 m de côté au moins, zoom 16 au plus).
  Un rezoom de moins de 6 s n'a pas lieu (fermeture du besoin de zoom :
  maximum puis minimum glissants sur 6 s, signal prolongé par ses bords) :
  en road trip, une étape — même avec photos ou deux ou trois caches
  proches — garde le cadre de la route au lieu de zoomer puis dézoomer ;
  une balade plus longue entre deux trajets garde son cadre serré. Seuls
  les trajets (nuits comprises) bordent un creux comblé : la vue
  d'ensemble du début et de la fin n'en est pas un, la descente du carton
  d'ouverture va donc jusqu'au départ même si la première balade est brève.
  Le dézoom est tenu 1,5 s avant de rezoomer (une balade garde un seul
  cadre, pas un par cache), la vitesse est bornée à 2,5 niveaux/s (le
  dézoom d'un long trajet ou de la nuit commence donc un peu avant le
  départ), puis le tout est lissé (σ = 4 quanta, résolution en logarithme) ;
- après la dernière étape, la vue d'ensemble (85 % du demi-écran) est une
  cible comme une autre ;
- le géocacheur est enfin gardé à 40 px du bord au moins (filet de
  sécurité, normalement inutile) ;
- cadrage (réglage « Cadrage », `parcours_playback.framing`) : « Équilibré »
  par défaut ; « Serré » vise une emprise ×0,7 et « Large » ×1,5 — les
  pistes sont recalculées avec l'emprise multipliée (`frame`), le
  dézoom tenu, la vitesse et le plancher de zoom restent tels quels. Sans
  effet en caméra fixe (le réglage est alors grisé).

Les constantes de temps de la caméra (lissages, fenêtres, maintien de
dézoom, vitesse de zoom) sont lues en **temps écran** : `msPerDay` les
convertit du rythme naturel vers le rythme courant — une durée imposée
accélère le contenu sans accélérer la caméra, le confort (2,5 niveaux/s,
σ = 0,4 s) vaut à tous les rythmes.

Avant le 2026-11-18, la caméra lissait des cadres par segment (le trajet
entier, l'étape) : elle partait vers le trajet suivant pendant l'arrêt
(jusqu'à 230 px par image), restait fixe pendant que le géocacheur
traversait l'écran, et le zoom pompait d'une cache à l'autre (jusqu'à
7,8 niveaux/s). Jusqu'au 2026-11-23, le seul maintien de 1,5 s ne
couvrait pas une étape entre deux trajets en voiture (1,2 s d'arrêt, dézoom
du trajet suivant anticipé par la vitesse bornée) : un aller-retour de zoom
par cache, 16 changements de sens sur un road trip de 10 étapes, plus de
70 niveaux parcourus en 80 s avec des grappes de caches. Les réglages sont dans `CAMERA_DEFAULTS` ; les tests
(`tests/js/parcours_camera.test.mjs`) vérifient ces critères de confort.

La pose ne dépend que de la position du moteur : aperçu, saut et vidéo image
par image cadrent pareil. `mapgl.js` appelle le crochet `camera` après
`frameVars`, dans le pré-rendu. La vue posée s'applique donc à l'image
suivante : en capture image par image, `leadMs` (une image) la fait tomber
sur la bonne, comme la piste de caméra du mode principal.

Les tuiles de la suite sont demandées d'avance (`prefetchBasemapTiles`, pose
1,5 s plus loin, une fois par seconde d'écran). Glisser ou zoomer la carte
pendant la lecture suspend la caméra — y compris pour un saut en pause, qui
la respecte. Tout changement de vue que la caméra n'a pas posé elle-même
suspend pareil (`change:center`/`resolution`/`rotation` de la vue, hors
drapeau `applyingPose`) : double-clic, pincement, clavier, maj+glisser ou
tout recadrage extérieur comptent donc aussi, sans énumérer les gestes. Un
bouton flottant « Reprendre le suivi » apparaît alors sur la carte : le
clic lève la suspension et recale la vue tout de suite sur la pose du point
courant. Sinon la suspension tient jusqu'à la lecture suivante ; à la fin,
la vue d'avant la lecture revient, sauf si l'utilisateur a repris la main.

Un saut en pause (barre de chronologie, Ctrl+flèches, « Voir sur la carte »
d'une photo) pose la vue sur la pose de la piste au point visé : le
géocacheur ne part pas hors écran. Le `begin` du moteur, rappelé alors qu'il
tourne encore, ne réécrit ni la vue gardée pour la fin ni la suspension —
`seekAnimationToDate` pose la vue via le crochet `camera` du moteur.

« Lire depuis ici » (`playFromQ`) démarre ou reprend la lecture à un quantum
donné : bouton de chaque ligne d'étape et de chaque en-tête de journée (la
journée repart de sa nuit, carton « Jour n » compris), et entrée de la bulle
d'étape sur la carte. Depuis le repos, l'aperçu démarre en pause
(`startPausedPreview`), saute au point visé puis reprend ; en cours de
lecture ou en pause, même saut puis reprise. En enregistrement, refus : la
vidéo se joue toujours depuis le début.

Pendant la lecture, la liste suit : la dernière étape atteinte
(`lastStopReached`, dichotomie sur les quanta) porte la classe
`is-playing` et est amenée en vue (`markPlaying` de
parcours_stops_panel.mjs, appelé par `step` et par `begin` — un saut en
pause ne rappelle que `begin`, état de la veille). La marque reste en
pause, disparaît à la fin de la lecture ; une journée repliée le reste.
Relevé : `listPlaying` de `getParcoursSnapshot()`.

**Nuit et cartons** (réglage « Nuit et carton », défaut : oui) :
- le carton d'ouverture (`openCardAt`) lance la lecture : `openCardQ`
  (30) quanta de carton — nom du parcours, ses dates (`formatRange`) et
  son bilan (étapes, distance, journées) — posés sur la vue d'ensemble du
  parcours (la caméra la vise comme à la fin), puis `openDescentQ` (15)
  quanta de descente vers le départ, à la vitesse de zoom bornée — elle
  se poursuit dans la première étape si l'échelle du parcours l'exige.
  « Jour 1 » prend le relais pendant la descente (`dayCardAt` attend la
  fin de `openCardQ`). Carton en plancher, descente élastique sous durée
  imposée. Cartons inactifs : rien d'ajouté, l'intro reste `introQ` ;
- la nuit assombrit la carte en cloche (`nightLevelAt` : 30 % de la nuit
  pour monter, 30 % pour redescendre ; voile bleu nuit à 50 % au cœur) ;
- le carton « Jour 2 » et la date longue (`dayCardAt`), pour un parcours
  de plusieurs journées :
  - le premier dès la fin de l'ouverture ;
  - les suivants du quart de la nuit jusqu'à 6 quanta après la première
    étape du jour, avec un fondu de 3 quanta ;
  - après des journées sautées, « n jours plus tard » précède la date
    (`dayStats().gapDays`) — l'ellipse se lit aussi dans la durée de la
    nuit, allongée d'autant ;
  - une troisième ligne donne le bilan de la journée (`dayStats`) :
    étapes comptées et km parcourus dans la journée (le trajet de nuit
    qui l'amène n'y compte pas) ;
- le carton final de synthèse (`endCardAt`), pour tout parcours : nom du
  parcours, étapes, distance et journées ; `endCardQ` (24) quanta de
  clôture ajoutés après l'outro quand les cartons sont actifs, fondu de
  3 quanta aux deux bouts.

**Tête** (réglage « Géocacheur », défaut : pictogramme) : un rond de la
couleur du trait et un glyphe Tabler (`ti-walk`, `ti-bike`, `ti-car`,
`ti-plane`, `ti-moon`), lu dans la feuille de style et dessiné au canevas.
Le mode vient de `headModeAt` / `legTravelMode` :
- l'itinéraire ou le mode imposé ;
- sur une trace ou en ligne droite, déduit de la vitesse de l'horaire :
  moins de 7 km/h à pied, moins de 22 km/h à vélo, au-delà en voiture,
  au-delà de 250 km/h en avion ;
- en ligne droite au-delà de 150 km : l'avion ;
- à l'arrêt, le mode du trajet d'arrivée.

Sans police chargée, la tête redevient un point.

**Trajets estimés en pointillés** (option, désactivée par défaut) : un
trajet sans trace ni itinéraire se dessine en tirets dans le trait de la
lecture.

**Crédits des itinéraires** :
- à l'écran, dans l'attribution de la carte (sources du plan et du trait) ;
- dans la vidéo, peints en bas à droite par la couche de la tête, car la
  capture ne compose que les canevas.

Ils n'apparaissent que si un trajet suit un itinéraire.

**Parcours suggérés** (`parcours_suggest.py`, carte « Nouveau parcours ») :
- centre habituel : la case de 0,5° qui compte le plus de journées de
  trouvailles. Une journée est placée à la médiane de ses trouvailles ;
- **séjours** : jours consécutifs à plus de 100 km de ce centre. Un ou deux
  jours sans trouvaille ne coupent pas le séjour ; il faut 3 trouvailles au
  moins ; un séjour est coupé à 92 jours ;
- **grosses journées** : 20 trouvailles ou plus hors séjour ;
- nom : la région si elle fait 60 % d'un séjour dans un seul pays (80 %),
  sinon le pays, sinon les deux pays principaux. La page y ajoute les dates.

Les six plus récents sont proposés, hors plages déjà enregistrées. Un clic
remplit le formulaire (replié derrière « Nouveau parcours » quand des
parcours existent).

## Ajustements manuels (lot 3)

Dans l'onglet Données :
- **les flèches** d'une étape et **le glisser-déposer** dans sa journée
  fixent l'ordre de la journée : un rang pour chacune de ses étapes ;
- **un clic sur une étape** ouvre son panneau : heure épinglée (« Épingler »
  / « Retirer »), durée de visite (vide : durée estimée du type de l'étape),
  journée (logs datés du mauvais jour), « Exclure du parcours » ;
- **« Poser un lieu ou une base sur la carte »** attend un clic sur la carte
  (Échap annule ; un point provisoire cerclé de pointillés marque l'endroit
  tant que le formulaire est ouvert), puis un petit formulaire : type, nom,
  journée, heure facultative, catégorie (parking, repas, point de vue,
  hébergement, ravitaillement, personnalisée à icône libre), et pour une
  base son rôle (départ et retour, ou une seule extrémité — partir d'un
  hôtel, dormir ailleurs) ;
- **la recherche** (champ de la barre des étapes) filtre la liste sur le
  nom, le code GC, la clé ou l'adventure d'une Lab — casse et accents
  ignorés, frappe temporisée. Une journée sans résultat disparaît ; les
  autres sont dépliées et le réordonnancement y est masqué (inopérant dans
  une liste tronquée). Le compteur d'en-tête devient « k étapes sur n » ;
- **le filtre « à vérifier »** (bouton du champ de recherche,
  `filterReview`) ne garde que les étapes dont l'heure est déduite de la
  géographie seule (`stop.confidence === CONFIDENCE_GEO`). Combinable avec
  la recherche, mêmes règles de vue filtrée ;
- **le menu « ⋯ »** de la barre d'outils regroupe les actions secondaires :
  « Tout plier / Tout déplier », « Exporter GPX » et « Réinitialiser les
  ajustements » — ce dernier masqué (son `<li>`) tant qu'il n'y a pas
  d'ajustement. Annuler / Rétablir et « Poser un lieu » restent dans la
  barre.

Le résumé d'en-tête rappelle aussi l'état d'enrichissement du parcours
ouvert, suffixé par « · » : photos et traces posées, itinéraires calculés
(`itinéraires done/total`, quand l'option « Suivre les routes » est active)
et caches jamais relues — ce dernier relevé à la cadence de la collecte
(~4 s), le résumé au prochain rendu de la liste.

**Agir depuis la carte** (au repos, depuis le 2026-11-20 ; rien pendant une
lecture, même en pause) :
- **clic sur une étape** : bulle d'actions (la bulle `#gcPopup` de
  mapgl.js, remplie par le crochet moteur `popupAt` avant les points du
  thème) — numéro et nom, heure et raison de sa place, champ d'heure et
  « Épingler » (« Retirer » si épinglée), « Exclure » (étape comptée) ou
  « Supprimer » (lieu, base : avec confirmation), « Détails » (le panneau
  de l'onglet Données). La ligne de la liste est amenée en vue ; chaque
  geste ferme la bulle, comme un plan refait (`renderLayer`) ;
- **glisser un lieu ou une base** (curseur « attraper ») : la position est
  enregistrée au lâcher (`ol.interaction.Translate`, `movePlaceTo`) ; un
  refus remet le repère en place. Le déplacement entre dans l'historique
  des ajustements (boutons Annuler / Rétablir, Ctrl+Z / Ctrl+Y) ; supprimer
  le lieu retire ses déplacements de l'historique. La création comme la
  suppression d'un lieu ou d'une base sont elles-mêmes annulables :
  l'annulation d'une suppression recrée le lieu tel qu'il était (nouvel
  identifiant — ses ajustements et ses photos sont recollés sur la
  nouvelle clé). L'identifiant d'un lieu supprimé n'est jamais
  réattribué (`AUTOINCREMENT`, migration v26) : sans cela, le lieu
  suivant héritait des ajustements et des photos gardés pour l'annulation.
  Le point provisoire du formulaire de pose
  se glisse aussi (coordonnées du formulaire mises à jour) ;
- **glisser une étape comptée** (lot 15, depuis le 2026-11-21 ; seule ou
  sortie de sa pile par l'éventail) : sa position devient un ajustement
  (`parcours_override.latitude/longitude`, migration v21, champ
  `position: {lat, lon}` des overrides, arrondi à 6 décimales). Elle prime
  sur toute autre (`applyAdjustments` : `posSource: 'manual'`,
  `positionMoved`) — le recours pour une mystery résolue jamais corrigée
  sur geocaching.com. Ordre, itinéraires, caméra et rattachement des
  photos suivent la nouvelle position. Annuler / Rétablir comme les autres
  ajustements ; la liste dit « position déplacée sur la carte », la bulle
  propose « Position d'origine » (`position: null`) ;
- **clic droit** : sur une étape, sa bulle ; ailleurs, « Poser un lieu ici »
  / « Poser une base ici », qui ouvre le formulaire de pose à cet endroit,
  type choisi d'avance (onglet Données affiché). Sans parcours ouvert, le
  menu du navigateur.

**Étapes empilées** (depuis le 2026-11-20, `parcours_stack.mjs`) : au zoom
courant, les étapes comptées d'une même journée dont les centres sont à
moins de 1,5 rayon de pastille (`STACK_DISTANCE`) forment une **pile** —
deux journées ne s'empilent jamais, lieux et bases jamais.
- Regroupement glouton dans l'ordre du parcours : une étape rejoint la pile
  la plus proche dont la PREMIÈRE étape est à portée (pas de chaîne qui
  s'étire), sinon en ouvre une. Il est stable par préfixe : la lecture,
  qui regroupe les étapes déjà atteintes au zoom de l'image, retrouve à la
  fin les piles du repos.
- La pile prend la place de sa première étape : pastille un peu plus
  grande (rayon + 2) posée sur une seconde décalée, libellé « 4–7 » si les
  numéros se suivent, « ×4 » sinon ou sans numéros. En lecture, le libellé
  grandit (« 1–2 » puis « 1–3 ») et la pile regrossit à chaque arrivée.
- Au repos, les autres étapes sont cachées (`stacked` : ni dessin ni clic).
  Survol de la pile : toutes ses lignes surlignées ; survol d'une de ses
  lignes : la pile mise en évidence. Recalcul à chaque changement de zoom
  (`moveend`, `updateStacks`) et à chaque plan refait.
- **Clic sur une pile** : elle s'écarte en **éventail** (cercle jusqu'à
  neuf étapes, spirale au-delà, `fanOffsets`), chaque étape reliée au
  centre par un fil ; un clic sur l'une ouvre sa bulle. Un clic ailleurs,
  Échap, un zoom ou une lecture le referment. Le crochet `popupAt` répond
  alors sans `coordinate` : mapgl.js ne montre pas de bulle.
- En rendu « points du thème », la pile ne regroupe que les numéros : les
  points WebGL restent chacun à leur place.

Gestes communs à la bulle et au panneau : `pinStopTime`, `excludeStop`,
`openStopDetails`. Les bulles de mapgl.js (`openPopupAt`) se posent sous le
point quand la place manque au-dessus, et se décalent vers l'intérieur près
d'un bord latéral ; ouvertes, elles passent au-dessus des cartouches
(titre, infos).

Ce que la reconstruction en fait (`applyAdjustments`, puis
`reconstructDay`) :

| Ajustement | Effet |
|---|---|
| `rank` | Les étapes classées gardent l'ordre choisi, les autres s'y insèrent au moindre détour ; il prime sur tout, y compris sur l'heure des ancres. Raison `manual`, confiance `manual` (ordre sûr, heure estimée). La journée porte `manual` : badge « ordre manuel » et « Ordre automatique », qui efface les rangs de la journée |
| `pinnedTime` | Ancre exacte, raison `pinned` |
| `visitMin` | Durée de visite imposée en minutes (0 à 720, null : estimée selon le type) ; les arrivées des étapes suivantes s'en décalent, et la chronologie proportionnelle allonge l'arrêt à l'écran |
| `day` | L'étape passe à une autre journée de la plage (`movedFrom` garde la date d'origine, « déplacée du… ») ; son rang est effacé |
| `excluded` | L'étape sort du parcours, de la chronologie et des comptes ; listée barrée en fin de journée, « Réintégrer » |
| lieu (`place`) | Une étape de plus dans sa journée, à son heure si elle en a une (raison `pinned`), sinon au moindre détour ; visite de 30 min ; jamais comptée (`index` null, `{etapes}`, résumé) |
| base (`base`) | Départ et retour de chaque journée qui a des étapes (clés `place:<id>:<date>:start` / `:end`, visite 0) ; une base datée prime sur une base « toutes les journées » ; elle oriente l'ordre géographique de la journée. Son `role` restreint l'extrémité servie : `start` (départ seul), `end` (retour seul) ou `both` — pour chaque extrémité, la base datée prime (rôle précis puis `both`), sinon celle de toutes les journées |

Pendant la lecture, lieux et bases n'ont pas de point WebGL. Ils sont
dessinés par la couche de la tête, avec le même marqueur : les bases
toujours, les lieux une fois atteints. Au repos, le plan les montre en un
seul symbole (`placeStyle`) : carré sombre pour une base, rond violet pour un
lieu (couleurs du thème), avec au centre, en blanc, l'icône Tabler de la
catégorie — à défaut celle du type (maison, drapeau). La liste la reprend
dans le badge et le détail de l'étape. La catégorie est purement
affichage : le comportement reste celui du type. Une base dure 4 quanta à
l'écran. Les ajustements sont refusés pendant une lecture (« Arrêtez la
lecture… »).

## Photos (lot 4 : `parcours_photos.py`, `parcours_photos.mjs`)

**À l'envoi**, dans cet ordre :
1. l'EXIF est lu : heure murale de l'appareil (`DateTimeOriginal`),
   `OffsetTimeOriginal`, GPS, marque et modèle ;
2. l'image est normalisée comme dans l'onglet Images (redressée, 2048 px,
   HEIC décodé — **l'EXIF disparaît du fichier gardé**, position comprise) ;
3. une vignette de 320 px est tirée ;
4. le tout est rangé dans `parcours_photos/<parcours>/` du dossier de
   données. Supprimer le parcours supprime le dossier.

Les envois (photos comme traces) partent par **trois à la fois** ; le
bouton « Arrêter » à côté du compteur interrompt : les fichiers partis se
terminent, les suivants ne partent pas. Côté serveur, les écritures d'un
même parcours sont sérialisées par `parcours_store.save_lock` : un contenu
envoyé deux fois rend la même photo, et les plafonds restent exacts.

Table `parcours_photo`, décalages d'horloge dans `parcours_camera`
(migration v12).

**Rattachement** (calculé côté client, jamais stocké, sauf le choix manuel) :

| Photo | Étape |
|---|---|
| choisie à la main (`stopKey`) | celle-là |
| géolocalisée | la plus proche à moins de 150 m, le jour de la photo (bases exclues) |
| sans GPS, datée, prise pendant une trace | comme géolocalisée, à la position lue sur la trace (source `track`) |
| datée, sans position | celle dont la visite estimée (± 10 min) contient l'heure, sinon l'arrivée la plus proche à 45 min au plus ; deux visites voisines dont les marges contiennent l'heure : celle dont la visite elle-même est la plus proche (une photo prise à l'arrivée n'est pas donnée à l'étape d'avant — défaut corrigé le 2026-11-23) |
| sinon | aucune (vignette estompée) |

**Situées par la trace** (`locatePhotosOnTracks`, parcours_tracks.mjs) :
une photo sans GPS datée (heure de l'appareil, recalée s'il y a lieu) ;
convertie en UTC (décalage du parcours), elle donne une position sur les
traces, interpolée entre les deux points qui l'encadrent — la
simplification à l'import (distance synchronisée) garantit que cette
interpolation reste à 10 m près. Marge de 2 min hors d'un segment ; un
trou évident (plus de 30 min sans point et plus de 500 m parcourus) ne
situe rien — un trou plus court reste interpolé en ligne droite, limite
connue. La photo se rattache alors comme une photo géolocalisée (150 m,
le jour même, source `track`, « (trace) » dans l'onglet) et peut devenir
un lieu proposé, mais n'est jamais une ancre : la trace cale déjà l'étape,
et ne sert pas non plus à déduire le fuseau (calculé sur les seules
positions EXIF, avant). Relevé : `photos[].trackPosition` de
`getParcoursSnapshot()`. Le détail dit pourquoi une photo n'est pas
située (prise hors des heures des traces) et propose de recaler une
horloge décalée. Exemple e2e :
« appareil sans GPS recalé » de `parcours-photos.spec.mjs`.

Une étape choisie à la main qui disparaît du parcours (cache exclue, lieu
supprimé) n'est pas oubliée : `stopKey` reste stocké, pour que la photo la
retrouve si elle revient (annulation, cache réincluse). En attendant, la
photo suit le rattachement automatique (position, heure — elle peut donc
caler son étape, ou être proposée comme lieu) et son rattachement porte
`lostKey`. Le détail garde l'étape disparue choisie dans la liste, avec une
explication ; « Automatique » l'oublie. Avant le 2026-11-23, une telle photo
restait « non rattachée » sans retour possible et la liste s'affichait vide.

**Heure d'une photo** : celle de l'appareil, **supposée juste** — corrigée
de son décalage quand l'utilisateur l'a recalé (`photoTimeTrusted` : toute
photo datée). Une photo rattachée à la main ou par position, datée du jour
même de son étape, devient une **ancre** de cette étape : raison `photo`,
heure exacte. Une heure épinglée ou une heure Lab primeraient. Le
rattachement par l'heure découle de l'horaire : il ne peut pas le caler.
Une horloge très fausse s'écarte d'elle-même (une ancre ne vaut que le jour
de l'étape) ; une horloge décalée de quelques heures (fuseau d'un appareil
photo) se corrige par un recalage.

Avant le 2026-11-23, seule une photo géolocalisée ou d'un appareil recalé
avait une heure utilisable — c'est désormais l'heure **vérifiée**
(`photoTimeVerified`), qui ne sert plus qu'aux références d'un recalage par
une paire. Une journée sans logs (collecte antérieure au voyage) et sans
base, photographiée au téléphone sans GPS ni marque/modèle dans l'EXIF,
n'avait ainsi aucune ancre : le plus court chemin, parcouru dans les deux
sens, sortait à l'envers.

`reconstructWithPhotos` fait donc deux passes :
1. reconstruction sans photo ;
2. rattachement, puis ancres ;
3. reconstruction finale, puis rattachement final.

**Recalage d'un appareil** (carte Photos) : saisie du décalage en minutes,
ou « Caler l'horloge sur l'étape », proposé pour une photo sans position
rattachée à une étape à heure sûre (épinglée, Lab) : décalage = heure de
l'étape − heure de la photo. Ou « Caler sur une autre photo » (détail d'une
photo sans position d'un appareil) : on choisit une photo de RÉFÉRENCE
prise au même moment — téléphone géolocalisé, ou autre appareil déjà
recalé (`pairCandidates`, heure vérifiée, les plus proches en heure
d'abord) — et le
décalage vaut heure de la référence (corrigée) − heure brute de la photo
(`pairOffset`, absolu : celui déjà posé n'y entre pas ; ±2 jours au plus,
comme le serveur). Avec une trace GPS, c'est le chemin le plus court pour
situer toute une carte mémoire.

**Clé d'appareil** (`cameraKey`, parcours_photos.mjs) : « marque modèle »,
suivie de « #numéro de série » quand l'EXIF donne celui du boîtier
(`BodySerialNumber`, colonne `camera_serial`, migration v23) — deux
appareils du même modèle ont chacun leur horloge. Le numéro n'est lu qu'à
l'envoi (l'EXIF ne survit pas à la normalisation) : les photos envoyées
avant n'en ont pas, et un boîtier sans recalage propre prend celui de son
modèle (`photoCameraOffset`) — un parcours commencé avant garde ainsi ses
heures. La carte Appareils montre une ligne par clé, et garde celle du
modèle tant qu'un boîtier en hérite (« recalée comme le modèle »). Tous
les appareils n'écrivent pas ce champ (beaucoup de Sony et de Fujifilm le
rangent dans leurs notes de fabricant, illisibles ici ; les téléphones,
jamais) : ceux-là restent regroupés par modèle. Les photos datées sans
marque ni modèle partagent la clé `UNKNOWN_CAMERA` (« ? », ligne
« Appareil inconnu »), recalable comme les autres.

**Lecture et vidéo** :
- chaque photo ajoute 15 quanta (1,5 s) au temps d'écran de son étape (4
  photos au plus en temps cumulé, partagé au-delà) ;
- pendant ce temps, une **carte postale** (bordure blanche, ombre, légère
  inclinaison, 220 px CSS de grand côté) apparaît au-dessus à droite de
  l'étape, gardée dans l'écran. Les photos d'une étape passent l'une après
  l'autre, avec un fondu de 2 quanta ;
- elle est dessinée dans le `postrender` de la couche de la tête, donc
  filmée. L'image est servie par le serveur local (même origine) : le
  canevas reste exportable, ce que vérifie un export du spec e2e ;
- les photos sont préchargées fenêtré autour de la position de lecture —
  celles des créneaux de la chronologie (`photoSlots`), photos en chemin
  comprises (avant le 2026-11-23, seules celles des étapes : une photo en
  chemin pouvait manquer dans la vidéo) :
  les miniatures (vignettes épinglées sur la carte) toutes d'office, les
  pleines tailles seulement pour les créneaux proches de la tête (~4 jours
  d'avance, un peu derrière pour l'effacement et les retours) — ouvrir un
  long parcours très illustré ne télécharge plus des centaines d'images
  2048 px. Hors enregistrement, la lecture libère en plus les pleines
  tailles passées : au-delà de ~40 quanta derrière la tête, l'image est
  relâchée — un retour en arrière la recharge depuis le cache disque
  (`Cache-Control: immutable`), quasi gratuit ; les photos des cartons et
  les vignettes ne sont jamais évincées. En lecture, une photo encore en
  chargement n'est simplement pas dessinée. Avant un enregistrement, elles
  sont toutes chargées et
  attendues (`parcoursPhotosReady`, branché sur le `whenImagesReady` de
  l'image par image et, en capture rapide, avant le départ de
  l'animation) : une photo encore en vol ne manque pas dans la vidéo.
  L'attente est proportionnelle au nombre de photos (3 s + 30 ms par
  photo, 30 s au plus — un plafond fixe de 3 s laissait partir la vidéo
  sans photos sur un parcours très illustré) et résout dès que tout est
  prêt ; au-delà de ~800 ms, un toast « Préparation des photos n / N »
  suit la progression et propose « Filmer sans les photos restantes »
  (`parcoursPhotosPrep`, mapgl.js), qui interrompt l'attente. Celles qui
  manqueraient quand même — échec de chargement, attente dépassée ou
  départ anticipé — sont comptées (`parcoursPhotosMissing`) et signalées
  par un toast au départ de la capture.

La mise en page et le cadre décrits ci-dessus sont ceux par défaut ; ils se
règlent depuis le lot 9 (ci-dessous).

## Onglet Photos (lots 8 à 10)

Les photos ont leur onglet (`#photos`, `templates/menu_photos_parcours.html`),
à la place de l'onglet Images, masqué sur `/parcours` : bibliothèque,
appareils, détail d'une photo, lieux proposés, réglages d'affichage. Un
contrôle d'un onglet fermé n'est pas visible : les specs ouvrent
`a[href="#photos"]` avant d'y toucher.

**Grille** (`photoGridGroups`, parcours_photos.mjs) : une rubrique par
journée de prise de vue (date corrigée par le recalage de l'appareil), les
photos sans heure en dernier ; filtres Toutes / Non rattachées / Masquées,
avec leurs comptes. Clic simple : détail de la photo. Ctrl (Cmd) + clic
ajoute ou retire une photo de la sélection — celle dont le détail était
ouvert y entre aussi —, Maj + clic ajoute la plage depuis le dernier clic,
et « Tout sélectionner » prend une journée. La barre de la sélection
rattache à une étape (ou rend l'automatique), masque, montre ou supprime
(après confirmation), en une requête. La sélection se réduit aux photos
affichées : une photo qui sort du filtre (rattachée sous « Non
rattachées ») la quitte. Les conteneurs masqués par `hidden` n'ont pas de
`d-flex` (AGENTS.md) : leur `display` vient de la feuille de style.

**Photos d'une étape ailleurs dans la page** (`stopPhotoStrip`,
parcours_data.js) : la bulle d'une étape sur la carte (4 vignettes au
plus) et sa ligne dans la liste des étapes (5, sous le texte — hors du
bouton, qui n'en contient pas d'autre) montrent ses photos, celles que
montre la lecture (masquées exclues), puis « +n ». Un clic ouvre la photo
dans l'onglet Photos (`showPhoto` du panneau : bulle fermée, sélection
vidée, filtre « Toutes » si le courant la cachait, vignette et détail
amenés en vue).

**Glisser-déposer** (`bindFileDrop`, parcours_data.js) : des fichiers déposés
n'importe où sur la page vont au parcours ouvert — les images aux photos
(l'onglet Photos s'ouvre), les `.gpx` aux traces, une musique à Animation >
Musique ; les autres sont signalés, et rien n'est envoyé sans parcours
ouvert. Sans ce gestionnaire, le navigateur ouvrait le fichier à la place
de l'application.

### Réglages par photo (lot 8, migration v15)

Colonnes de `parcours_photo` : `hidden`, `caption` (200 caractères, espaces
resserrés), `aspect` (`original`, `1:1`, `4:3`, `3:4`, `16:9`), `focus_x` /
`focus_y` (0-100 %), `zoom` (100-300 %). Null = défaut (photo entière,
centre, 100 %).

- **Masquée** : toujours un indice (rattachement, ancre d'heure), mais
  absente de `photosByStop` — ni dessinée ni comptée dans le temps d'écran.
  La changer reconstruit le parcours (refusé pendant une lecture).
- **Favorite** (`favorite`, migration v24, aussi en sélection groupée et
  en filtre de la grille) : orne les cartons — ouverture (la première
  favorite montrée), journées (la première de chaque journée ; « Jour 1 »
  ne répète pas celle de l'ouverture), fin (mosaïque carrée de 5 au plus,
  réparties sur tout le parcours) — et passe en premier au-delà du
  plafond quand il ne garde que les premières (`photoFavorites` de
  `buildParcoursTimeline`). Choix : `cardPhotos` (parcours_photo_layout.mjs,
  parmi les photos que la chronologie montre, dans son ordre — photos
  prises en chemin comprises (`legPauses`), à la journée de l'étape d'où
  part leur trajet ; aucune avec « Aucune photo dans la vidéo »). Sans
  favorite, les cartons restent du texte. Peintes
  au-dessus du texte (pleine taille préchargée dès l'ouverture, attendues
  avant un enregistrement, comptées dans les photos manquantes). Relevés :
  `scene.cardPhotos` (choix) et `scene.cardPhotosDrawn` (peintes à la
  dernière image) de `getParcoursSnapshot()`. La changer reconstruit le
  parcours (refusé pendant une lecture), comme « Masquée ».
- **Légende** : la balise `{legende}` du gabarit d'affichage.
- **Cadrage** (`photoCropRect`, `parcours_photo_layout.mjs`) : la plus
  grande fenêtre aux proportions voulues, réduite de 1/zoom, centrée sur le
  point focal et gardée dans l'image. Sélecteur sur la vignette (glisser, ou
  flèches : 1 %, Maj = 10 %), enregistré au relâchement ; au clavier, la
  fenêtre suit chaque appui mais l'envoi attend 400 ms sans frappe (ou la
  sortie du sélecteur) — une touche maintenue envoyait une requête par
  répétition, dans le désordre possible. Proportions, zoom et point focal
  passent par ce même brouillon (`saveCrop`, parcours_photos_panel.mjs),
  dont les envois se suivent. Légende et cadrage ne touchent que le
  dessin : la photo est remplacée en mémoire, sans reconstruction, et seul
  le détail est redessiné (pas la grille des vignettes).

### Affichage dans la vidéo (lot 9)

Préférence globale `parcours_photo_display` (`coerce_parcours_photo_display`
de settings_manager.py, `normalizePhotoDisplay` côté client, mêmes bornes) :
c'est le **défaut**, surchargé par le parcours ouvert depuis le 2026-11-23
(colonne `photo_display`, migration v25, JSON épars validé par
`clean_parcours_photo_display_value` ; copié par la duplication et
l'export) — même principe que `playback` : avec un parcours ouvert, un
réglage ne vaut que pour lui ; sans parcours ouvert, il écrit le défaut.
Un bandeau en tête de la carte dit la portée (`photoDisplayScope`) et,
quand le parcours a ses propres réglages, propose « Revenir aux réglages
par défaut » (surcharges oubliées) et « En faire les réglages par défaut »
(le défaut prend les réglages effectifs, le parcours n'a plus de
surcharge). Clés :

| Clé | Valeurs (défaut en premier) |
|---|---|
| `layout` | `stop` (près de l'étape), `fixed` (emplacement fixe), `strip` (bande), `none` (aucune photo) |
| `side` | près de l'étape : `auto` (vers le centre de l'écran ; haut-droite près du centre, pour que la caméra qui suit ne la fasse pas basculer ; choisi à la première image d'une pile et gardé tant qu'elle est montrée — `sideMemo` —, la caméra lissée déplaçant encore l'étape à l'arrivée et au départ), `top-right`, `top-left`, `bottom-right`, `bottom-left` |
| `anchor` | emplacement fixe : `top-right` et les 7 autres ancres des images, à 16 px du bord |
| `leader` | trait de l'étape vers la carte (près de l'étape, emplacement fixe) : `false` |
| `stack` | pile (près de l'étape, emplacement fixe) : les photos d'une étape se posent les unes sur les autres, décalées et inclinées selon leur rang, et la pile s'efface d'un bloc après la dernière : `false` |
| `pin`, `pin_size` | vignettes sur la carte (près de l'étape, emplacement fixe) : au lieu de s'effacer, chaque photo (la pile entière avec `stack`) descend en 4 quanta vers une petite pile attachée à son étape, et y reste jusqu'à la fin ; grand côté 40-160 px CSS : `false`, 72 |
| `pin_shape` | forme des vignettes : `card` (la carte en petit, en petite pile inclinée) ou `round` (médaillon : voir ci-dessous) : `card` |
| `pin_group` | regroupement des vignettes qui se chevauchent à l'écran (voir ci-dessous) : `true` |
| `strip_edge`, `strip_reset` | bande : `bottom` / `top` ; vidée à l'arrivée sur la première étape d'une nouvelle journée : `false` |
| `size` | grand côté de l'image, 120-600 px CSS : 220 |
| `frame` | `postcard` (marge blanche, ombre), `polaroid` (marge basse épaisse), `rounded` (coins arrondis, ombre), `plain`, `stamp` (timbre : papier blanc dentelé, un chemin creusé de demi-cercles — rien n'est effacé du canevas de la carte), `tape` (marge de carte postale et deux bandes de scotch translucides aux coins du haut), `film` (pellicule : bandes noires perforées en haut et en bas, légende sur bandeau) |
| `tilt` | ± 2,5° en alternance : `true` |
| `effect` | `fade`, `slide`, `zoom` (courbes d'`images_render.mjs`), `pop` (« Depuis l'étape » : la photo sort du point de son étape en grandissant, avec un léger rebond, et y rentre à la sortie ; repli sur `zoom` quand l'étape est hors de l'écran ; en bande, elle part de son étape vers sa place en grand) |
| `ken_burns` | zoom lent pendant l'affichage, mouvement alterné d'une photo à l'autre (voir ci-dessous) : `false` |
| `flash` | éclair de déclencheur sur l'étape (ou le point d'arrêt d'une photo en chemin) à l'arrivée de chaque photo, 5 quanta (`photoFlashesAt`, `drawShutterFlash`), sous les cartes ; coupé en mouvement réduit ; relevé `photoFlashes` : `false` |
| `duration`, `max_per_stop` | 1,5 s par photo (0,5-6), 4 photos au plus en temps cumulé par étape (1-12) |
| `overflow` | au-delà du plafond : `share` (toutes, chacune plus brève), `first` (les favorites puis les premières prises, à leur durée entière, montrées dans l'ordre de prise de vue ; les suivantes n'ont pas de créneau, donc ni pile, ni vignette, ni repère sur la barre) |
| `en_route` | photos prises en chemin (voir ci-dessous) : `false` |
| `pano_pan` | panoramas parcourus : une photo d'au moins 2:1 sans cadrage choisi (`isPanorama` ; un cadrage ou un zoom prime) est montrée dans une fenêtre 16:9 qui glisse de gauche à droite pendant son créneau (`pan` des cartes, adouci ; `panoramaRect` au dessin) — vignettes et piles gardent la dernière position ; coupé, la photo entière en bande : `true` |
| `day_recap` | planche de la journée (voir ci-dessous) : `false` |
| `caption` | gabarit `{legende}`, `{etape}`, `{heure}`, `{jour}`, `{date}` (120 caractères ; vide : pas de légende) |

- **Chronologie** : `photoSlots` (créneaux : arrivée + 2 quanta, puis une
  photo après l'autre, fondu de 2 quanta). Avec `overflow: first`,
  `buildParcoursTimeline` ne garde que les premières photos de l'étape
  (`stops[].photos`) — les rattachements (`photoStops` du relevé) ne
  changent pas. `duration`, `max_per_stop`, `overflow` et
  `none` changent le temps d'écran (`photoTimelineOptions`), donc la
  chronologie — appliqués à la fin d'une lecture en cours, comme le rythme.
  En **pause**, ils s'appliquent tout de suite : l'aperçu est arrêté (sa
  fin applique la chronologie), puis rouvert en pause sur la même photo
  (`reopenPausedAt`, parcours_data.js ; la première si elle n'a plus de
  créneau).
- **Styles tout faits** (`PHOTO_DISPLAY_PRESETS`, `photoDisplayPreset`) :
  Carte postale (= défaut), Carnet de voyage (scotch, pile, vignettes,
  depuis l'étape), Sobre (emplacement fixe, coins arrondis, zoom lent),
  Pellicule (bande vidée chaque jour, cadre pellicule). Ils ne posent que placement et
  apparence — jamais durée, plafond, photos en chemin, légende ni taille ;
  le bouton du style que les réglages reproduisent est pressé
  (`aria-pressed`). Les réglages sont rangés sous des intertitres
  (Placement, Apparence, Mouvement, Temps d'écran), sans repli.
- **Temps d'écran** (`photoScreenTime`, sous l'intertitre du même nom) :
  « n photos montrées : 45 s sur 6 min 20 s de vidéo », au rythme courant
  (quanta des créneaux × durée d'un quantum) — refait à chaque
  reconstruction de la chronologie (réglage photo, rythme, durée imposée).
- **Aperçu automatique** (case « Montrer chaque réglage sur la carte »,
  cochée par défaut, retenue par navigateur dans `localStorage`
  `parcoursPhotoAutoPreview`) : un réglage changé au repos ouvre l'aperçu en
  pause sur la photo du détail (si la lecture la montre), sinon la
  première ; en pause sans photo à l'écran, il y saute. Jamais en lecture.
- **Mise en page** : `photoFrameAt(timeline, q, réglages, vue)` rend les
  cartes du quantum (centre, taille, cadre, rotation, opacité, effet, zoom
  lent, légende, trait) en px du canevas ; `parcours_photo_draw.mjs` les
  peint dans le `postrender` de la couche de la tête : filmées, et à la
  bonne échelle en capture haute résolution (`ratio`). Avec les vignettes
  sur la carte ou la bande, TOUTES les photos passées sont remises en page
  à chaque image : légendes mémorisées par créneau (`memoCaption`,
  parcours_play.mjs) et photos indexées par id — composer les légendes et
  chercher les photos linéairement coûtait ~17 ms par image pour 300
  photos (mesuré sous Node, 2026-11-23).
- **Bande** : la photo entre en grand au-dessus de la bande (en dessous pour
  une bande en haut), puis rejoint sa case en rétrécissant pendant le
  dernier tiers de son temps (4 quanta au plus) ; la bande défile vers la
  gauche quand elle déborde, les vignettes sorties s'effacent.
- **Vignettes sur la carte** : côté choisi par `pinDirection` parmi 8
  directions, la moins encombrée par le trajet (tout le parcours, chemins
  réels compris, passé et à venir) et les autres étapes dans un rayon de
  500 m, chaque point pesant d'autant plus qu'il est proche et dans l'axe.
  Calculé en distances au sol, une fois par étape : le côté ne change ni
  avec le zoom ni quand la caméra suit. Une vignette suit son étape à
  décalage fixe, avec un trait vers elle : rognée par le bord de l'écran
  plutôt que déplacée (elle ne glisse jamais par rapport à la carte), plus
  dessinée quand elle est hors de l'écran. Peintes depuis les miniatures
  (320 px), sous les photos montrées. Photo prise en chemin :
  `pointPinDirection`, même calcul autour de son point d'arrêt — posée
  sur son trajet, qui la traverse, sa vignette part en travers (elle
  allait toujours en haut à droite, souvent sur le trait).
- **Vignettes préparées** (`pinSprite`, parcours_play.mjs) : une vignette
  posée est dessinée une fois dans un petit canevas, puis recopiée à
  chaque image (opacité appliquée à la recopie, trait et nombre dessinés
  à part). Mesure (2026-11-24, `drawPhotoCard` × 300 vignettes,
  miniature 320 px, cadre carte postale) : en rendu logiciel (Chromium de
  Playwright), 26 ms par image en 1080p (dont ~6 ms d'ombre floutée,
  ~7 ms de réduction en qualité haute, le reste en découpe et tracés),
  77 ms en capture deux fois plus fine ; recopie : 1,6 et 7 ms. Dans
  Chrome accéléré, l'écart est noyé dans le bruit (l'ombre y est
  quasi gratuite). Clé : image, taille, cadre, inclinaison, forme,
  cercle, résolution (une capture haute résolution prépare les siennes) ;
  oubliées après 120 images sans servir, et avec l'image (`evictImage`).
  Relevé : `photosPinSprites` de `getParcoursSnapshot()`.
- **Médaillons** (`pin_shape: 'round'`) : un par étape, sans décalage ni
  inclinaison — chaque photo se pose sur la précédente, seule celle du
  dessus est dessinée. Pendant la seconde moitié de la descente, la carte
  s'efface et le médaillon paraît à sa taille (`round` 0..1, `pinSize`) ;
  posé, il fait `pin_size` de diamètre. Photo au cadrage carré (point
  focal), liseré blanc, cercle de la couleur de la journée
  (`dayColor` de la palette du style, journée de l'étape ou du trajet
  d'une photo en chemin — que les étapes soient colorées par journée ou
  non). Le trait vers l'étape s'arrête au bord du cercle. Nombre de photos
  (`badge`) dans une pastille de la même couleur dès que le médaillon en
  porte plusieurs.
- **Regroupement** (`pin_group`, `groupPins`) : à chaque image, en partant
  de la plus récente, une vignette (la pile d'une étape) dont le centre
  tombe à moins de 0,75 × `pin_size` d'une vignette gardée s'y ajoute et
  n'est plus dessinée — sa pile compte dans le nombre affiché par la
  gardée (médaillon : toujours ; carte : seulement quand elle en a absorbé
  d'autres, sa propre pile se voit déjà). En pixels écran : la vue
  d'ensemble regroupe, le zoom sépare. Grille de la taille du seuil, 9
  cases regardées par vignette.
- **Zoom lent** (`ken_burns`, `kenBurnsMotion`) : selon le rang de la
  photo, en alternance, avancée (+ 8 %), recul (− 8 %) ou travelling
  (fenêtre serrée de 12 % qui glisse d'un bord à l'autre, adouci, sens
  alterné à chaque cycle) ; un panorama n'a que l'avancée. La fenêtre
  (`kenBurnsRect`) garde le point focal du cadrage à sa place : le zoom va
  vers lui (centré pour un point focal au milieu). Relevé `kenBurns`,
  `kenBurnsShift` des `photoCards`.
- **Légende** (`photoCaptionText`) : une balise vide ne laisse pas de
  séparateur orphelin. `{heure}` : celle de la photo si elle est
  datée, sinon celle de l'étape (« ≈ » selon « Heures affichées »).
  Écrite dans la marge (carte postale, polaroid) ou sur un bandeau dégradé
  (coins arrondis, sans cadre), tronquée (…).
- **« Voir sur la carte »** (détail d'une photo, et « Voir la première photo
  sur la carte ») : ouvre l'aperçu en pause (`startPausedPreview`) et saute
  au créneau de la photo (`seekAnimationToDate`) — pour régler l'affichage
  sans rejouer le parcours.

### Planche de la journée (option `day_recap`)

Coupée par défaut, réglable par parcours. À la fin de chaque journée qui a
montré au moins `DAY_RECAP_MIN` (2) photos — étapes et photos en chemin
comprises, la dernière journée aussi —, le géocacheur reste sur sa
dernière étape `DAY_RECAP_Q` (30 quanta, 3 s) de plus, après les photos de
celle-ci et avant la nuit : la carte s'assombrit (comme la nuit), le titre
de la journée paraît, puis ses photos en vignettes carrées à bord blanc,
l'une après l'autre (fondu et petit rebond, fondu seul en mouvement
réduit), légèrement inclinées si « Légère inclinaison » est cochée.

- **Chronologie** (`buildParcoursTimeline`, option `dayRecapQ` posée par
  `photoTimelineOptions`) : `recapQ` et `recapPhotos` sur la dernière étape
  de la journée, inclus dans son `departQ` ; `dayRecaps(timeline)` →
  `[{ day, stop, photos, fromQ, toQ }]`, `dayRecapAt(timeline, q)` ajoute
  `progress` et `alpha`. Sous durée imposée, c'est un contenu à lire
  (plancher, comme un bloc photo). Compté dans le temps d'écran des
  photos (`photoScreenTime`).
- **Choix des photos** (`pickRecapPhotos`) : toutes jusqu'à
  `DAY_RECAP_MAX` (9) ; au-delà, les favorites d'abord, puis les autres
  réparties du début à la fin de la journée, dans l'ordre d'apparition.
- **Disposition** (`recapSheetLayout`, parcours_photo_layout.mjs) : grille
  (1 à 3 en une rangée, 2 × 2, 3 × 2, 4 × 2, 3 × 3), rangée du bas
  centrée, dans 72 % × 66 % de l'écran, 240 px CSS de côté au plus, écart
  de 14 % du côté (bord blanc et inclinaison ne se touchent pas) ; les
  vignettes arrivent pendant les premiers 45 % de la planche.
- **Dessin** (`drawDayRecap`, parcours_play.mjs) : peintes depuis les
  miniatures 320 px (préchargées pour toutes les photos montrées), la
  pleine taille à défaut ; carré au cadrage de la photo (point focal).
- **Relevé** : `scene.recaps` (planches de la chronologie) et
  `scene.recap` (`{ day, photos, alpha }` peinte à la dernière image) de
  `getParcoursSnapshot()` — exemple : « planche de la journée » de
  `parcours-photo-display.spec.mjs`.

### Photos en chemin (option `en_route`)

Choix du § 14 : une photo rattachée à rien n'est pas montrée — l'option,
coupée par défaut, revient dessus pour celles prises ENTRE deux étapes
(paysages, belvédères). Sélection (`routePhotos`, parcours_photos.mjs) :
géolocalisées (EXIF ou trace), datées, non masquées, sans
étape ; chacune va au trajet de sa journée dont la fenêtre [départ de A,
arrivée en B] contient son heure (45 min de marge ; à égalité, le trajet
le plus proche) — avant la première étape ou après la dernière : aucune.

Chronologie (`buildParcoursTimeline`, option `photosByLeg`) : chaque
trajet de jour porte ses photos (`leg.photos` : fraction de distance `f`
et point du trajet le plus proche, triées par f ; même plafond et même
dépassement qu'une étape) et s'allonge de leur temps d'écran. Le
géocacheur s'ARRÊTE au point de chaque photo le temps de la montrer
(`legPauses` : l'avancement `legTime` exclut les arrêts, l'adoucissement
du trajet est gardé) ; l'heure affichée passe par celle de la photo
(`legClock`). En durée imposée, l'arrêt est un plancher, comme les photos
d'une étape. Créneaux (`photoSlots`) : `route`, `leg`, `at` (point
d'arrêt), `stop: null`, fusionnés par fromQ ; chacun a sa pile, ancrée au
point (`view.pointPixel`) — vignette laissée sur la carte, trait, légende
(`{etape}` vide) comme les autres ; repère « en chemin » sur la barre de
chronologie. Elles restent proposées comme lieux (le texte de la carte
« photos hors des étapes » le dit selon l'option). Exemple e2e : « photos
en chemin » de `parcours-photos.spec.mjs`.

### Lieux proposés (lot 10)

Une photo géolocalisée à plus de 150 m de toute étape n'est rattachée à
rien, donc pas montrée. `suggestPhotoPlaces` (parcours_photos.mjs) regroupe
ces photos par journée du parcours : une photo rejoint un groupe à moins de
75 m de sa première photo, toutes sont donc à moins de 150 m du centre, où
le lieu est posé. Chaque groupe propose « Créer ce lieu » (nom facultatif,
heure de la première photo) : `POST /places`, puis les photos s'y rattachent
par position. Rien n'est stocké pour une proposition ignorée ; les photos
masquées, sans heure, hors des dates du parcours ou rattachées à la main ne
sont pas proposées.

## Traces GPS (lot 5 : `parcours_tracks.py`, `parcours_tracks.mjs`)

**À l'import** (table `parcours_track`, migration v13 ; colonne
`parcours.utc_offset_minutes`) :
- seuls les points de trace (`trk/trkseg/trkpt`) **horodatés** sont gardés,
  segment par segment (GPX 1.0 et 1.1) ;
- chaque segment est simplifié par un Douglas-Peucker en **distance
  synchronisée** (10 m) : un point est comparé à la position qu'aurait le
  marcheur à son heure sur le tronçon gardé. Un Douglas-Peucker purement
  spatial effaçait une pause sur place (points alignés), et l'heure
  interpolée était fausse de toute sa durée ;
- au-delà de 50 000 points après simplification, éclaircissement uniforme.

**Heure locale** (`resolveUtcOffset`), les traces étant en UTC :

| Ordre | Source |
|---|---|
| 1 | réglage du parcours (« Heure locale des traces », carte Traces GPS) |
| 2 | médiane des `OffsetTimeOriginal` des photos |
| 3 | médiane des écarts entre heures murales situées sur la trace (étapes Lab, photos géolocalisées, à moins de 50 m) et heure UTC du passage, au quart d'heure |
| 4 | fuseau de l'ordinateur à la date du parcours |

**Rattachement** (`matchStopsToTracks`) :
- la distance est mesurée au **tronçon** de trace (projection, heure
  interpolée), pas aux points : une ligne droite simplifiée n'en garde que
  les bouts ;
- un **passage** est une suite de tronçons à moins de 100 m de l'étape,
  le jour de l'étape. Le passage retenu est celui qui dure le plus (on
  cherche la cache ; un aller-retour repasse vite) ;
- l'**arrivée** est le premier instant du passage à moins de max(30 m,
  2 × distance minimale) ;
- les bases ne sont pas rattachées.

Cette heure devient une **ancre** : raison `track`, après l'heure épinglée
et celle des Labs, avant celle des photos.

**Vrai chemin** (`trackLegPaths`) : entre deux étapes consécutives
rattachées au même segment d'une trace, dans l'ordre du temps, le trajet est
la portion de trace. Sa longueur remplace la distance à vol d'oiseau, et
le trait comme le géocacheur la suivent (`legCut`, `legPoints` de
parcours_timeline.mjs). Ces trajets ont le mode `track`.

**Rythme proportionnel** : la durée d'un trajet vient désormais de
l'horaire (arrivée − départ, ancres comprises), et non plus de
l'estimation seule.

Au repos, les traces sont tracées sous le plan (fin trait gris). La
`reconstructWithEvidence` de parcours_tracks.mjs enchaîne traces puis
photos et remplace `reconstructWithPhotos` dans la page.

## Itinéraires (lot 6 : `parcours_routing.py`, `parcours_routing.mjs`)

Option globale `parcours_routing`, **désactivée par défaut** (carte
« Itinéraires » de l'onglet Données).

| Fournisseur | Accès | Conditions |
|---|---|---|
| **FOSSGIS** (défaut) | OSRM, `routing.openstreetmap.de/routed-<foot\|bike\|car>/route/v1/driving/...`, sans clé | 1 requête/s au plus, sans garantie de disponibilité ; adresse réglable (`fossgis_url`) |
| **openrouteservice** (option « plus fiable ») | `api.openrouteservice.org/v2/directions/<profil>/geojson`, clé gratuite de l'utilisateur | 2 000 itinéraires par jour, 40 par minute, 50 points par itinéraire |

**Côté serveur** :
- appels faits par Flask, jamais par la page, avec un User-Agent
  « MyGCFlow/<version> » et un débit limité par fournisseur ;
- une requête par **suite** de trajets consécutifs de même profil dans une
  journée (50 points au plus), découpée ensuite trajet par trajet : les
  étapes d'OSRM, les `way_points` d'openrouteservice ;
- chaque trajet est gardé dans **`route_leg_cache`** (fournisseur, profil,
  extrémités arrondies au 1e-5°), partagé par tous les parcours. Un trajet
  sans route possible y est gardé sans géométrie : le verdict est
  re-vérifié après 30 jours (`NO_ROUTE_TTL_DAYS`) — une route nouvelle ou
  un fournisseur réparé peut alors répondre ; les itinéraires trouvés, eux,
  sont gardés (vidéo reproductible). « Pas de route » portant sur toute
  une requête de plusieurs trajets, elle
  est re-découpée par dichotomie jusqu'à isoler le ou les coupables
  (`_route_chunk`) — les trajets routables voisins gardent leur itinéraire.
  « Recalculer » ignore le cache (`force`) ; « Réessayer », proposé après
  un échec ou une annulation, reprend le calcul sans l'ignorer ; « Vider
  le cache » oublie tous les itinéraires gardés (tous fournisseurs, tous
  parcours — `GET`/`DELETE /api/parcours/routes/cache`), qui seront
  recalculés au prochain besoin ;
- une erreur « indisponible » (réseau, serveur) est retentée une fois,
  espacée (`RETRY_DELAY_S` par fournisseur) : une panne passagère ne
  suspend pas tout le calcul ; quota et clé ne sont jamais retentés ;
- en cas d'échec (réseau, quota, clé), les trajets restent non calculés,
  avec un message, et l'API répond quand même 200 ;
- la clé openrouteservice est stockée dans settings.json mais **jamais
  renvoyée** par `GET /api/settings` (`ors_key_set` seulement).

**Mode d'un trajet** (`legModeFor`) :
- celui imposé depuis l'étape de départ (« Trajet vers l'étape suivante » :
  à pied, vélo, voiture, ligne droite ; `legMode` des ajustements,
  migration v14) ;
- sinon à pied jusqu'à 1,5 km, en voiture jusqu'à 300 km, en ligne droite
  au-delà (avion, ferry).

Ni la nuit ni un trajet déjà sur une trace GPS ne sont routés. Sans
itinéraire, un mode imposé change quand même l'estimation (vélo : 15 km/h,
détour ×1,2).

**Côté page** (`rebuild` puis `ensureRoutes` de parcours_data.js) :
1. le parcours s'affiche d'abord avec ce qui est connu ;
2. les suites dont un trajet manque sont demandées, puis tout est
   reconstruit ;
3. les durées des itinéraires (`legHints`, stationnement de 5 min ajouté en
   voiture) remplacent les estimations dans l'horaire, et leurs chemins
   s'ajoutent aux tracés (la trace GPS reste prioritaire). Un trajet routé
   garde son mode (`walk`, `bike`, `car`).

Après un échec (ou une annulation), les nouvelles tentatives sont
suspendues jusqu'à une action (réglage, « Réessayer », « Recalculer ») :
sinon chaque reconstruction relancerait le fournisseur en panne.

Attribution affichée dans la carte : « Itinéraires © contributeurs
OpenStreetMap, calculés par FOSSGIS ou openrouteservice ».

Vérifié une fois contre le vrai FOSSGIS (2026-11-16) : deux trajets à pied
à Annecy, 670 m / 9 min et 1,26 km / 17 min, 89 et 68 points.
openrouteservice n'est testé que par des réponses simulées (format v2).

## Compléter depuis geocaching.com (lot 12 : `parcours_collect.js`)

Carte de l'onglet Données (MyGCFlow_Plan_Parcours.md § 15). Le favori
« MyGCFlow — Mes logs » (docs/logs-geocaching.md) relit les caches **du
parcours ouvert seulement** : fiche (coordonnées corrigées, total de PF,
état) et carnet filtré sur les logs du joueur (PF donné). Le My Finds
porte déjà les coordonnées corrigées des trouvailles : l'apport tient aux
PF, aux DNF (fiche et position) et à l'indication « coordonnées
corrigées » de la liste.

- **Demande** : `POST /api/parcours/<id>/collect` (`mode` : `unread` =
  caches sans fiche lue par le favori, `all` = toutes). Codes =
  trouvailles et DNF de la plage (`collect_codes`, parcours_dataset.py),
  étapes exclues et caches sans position comprises ; ni Labs ni lieux. Au
  plus `MAX_COLLECT_CODES` (1 000) : au-delà, refus. `GET` donne
  `total`, `unread`, la demande du parcours (`request`) ou celle d'un autre
  (`otherRequest`, remplacée par la suivante) ; `DELETE` l'annule. Une
  seule demande à la fois, fichier `logs_collect_request.json` des
  données (24 h), servi au favori par `/api/logs/receive/state` ;
  supprimer le parcours retire sa demande (celle d'un autre parcours
  survit).
- **Collecte** : le favori confirme (« Parcours « … » : relire ses N
  caches ? »), ne lit que ces codes et n'envoie aucune couverture ; chaque
  fragment porte `X-MyGCFlow-Request`. Au scellement, l'aperçu garde
  `request_id` / `parcours_id` et la demande disparaît.
- **Validation** : la carte relève `/api/logs/status` toutes les 4 s tant
  qu'une demande ou un export est attendu (onglet Données affiché) :
  `collection_in_progress.request_id` → « Collecte en cours », puis
  `pending_import` du parcours → bilan (`caches_in_file`,
  `caches_corrected`, `favorites_mine`, `parkings`, `facts_count`) et
  « Valider l'import »
  (`/api/logs/import/commit`, tâche suivie, puis rechargement du
  parcours). Pas la fenêtre d'aperçu de « Mes logs » : sans couverture,
  rien ne peut être retiré.
- Relevé e2e : `getParcoursCollectSnapshot()` (`collect`, `pending`,
  `progress`, `polling`).
- **Ce qui en sort** (lot 13) : PF donnés (cœur, envol, `{pf}`), total de
  PF et nombre de trouvailles dans la bulle (§ Entrées). Le favori lit le
  nombre de trouvailles dans les compteurs de la fiche
  (`#ctl00_ContentBody_lblFindCounts` : Found it + Attended + Webcam) ;
  sans compteurs lisibles, il le signale une fois dans la console. Le
  bilan de la collecte affiche le nombre de parkings relevés et les
  fiches dont les compteurs ont été lus (`facts_count`) : un « 0 »
  inattendu y trahit une casse des sélecteurs de la fiche, muette sinon.
- **Parkings** (lot 14) : sous le bilan de chaque journée, un bloc replié
  « N parkings connus pour cette journée » (`suggestParkings`,
  parcours_parkings.mjs) : parkings des étapes gardées de la journée, ceux
  à moins de 40 m fusionnés (caches qui partagent un parking), ceux à
  moins de 60 m d'un lieu ou d'une base de la journée (ou sans date)
  écartés. « Créer ce lieu » pose un lieu de catégorie `parking`, sans
  heure : la reconstruction le place, et son tronçon se règle comme les
  autres (`legMode` : voiture jusqu'au parking, puis à pied). Rien n'est
  retenu d'une proposition ignorée. Relevé `parkings` (date → liste) de
  `getParcoursSnapshot()`.

## Reconstruction (`parcours_reconstruct.mjs`)

Journée par journée, la dernière étape de la veille orientant la suivante.

**Ordre de passage** :

1. **Ancres** : étapes à heure sûre (heure de validation des Labs ; plus
   tard heure épinglée, trace, photo). Ossature dans l'ordre chronologique.
2. **Ordre des logs** :
   - les types souvent logués après coup (virtuelle, earthcache, webcam,
     locationless) sont mis de côté (`late-type`) ;
   - puis les **intrus**, une étape qu'il est nettement plus court de visiter
     ailleurs dans la chaîne (économie > max(0,5 km, 15 % du chemin), au
     plus 20 % des étapes) : log tardif de n'importe quel type
     (`intruder`) ;
   - l'ordre restant est **retenu** si son chemin fait au plus 1,3 fois le
     meilleur chemin géographique (ou le dépasse de moins de 300 m) ; sinon
     il est écarté et la géographie décide.
   - Ordre retenu : les ancres s'y insèrent dans l'ordre chronologique, au
     moindre détour.
3. **Géographie** : sans ordre des logs retenu ni deux ancres, plus court
   chemin de la journée (plus proche voisin + 2-opt, `orderStops` de
   travel_trail.mjs). Il se parcourt dans les deux sens : le sens vient du
   premier indice disponible (`reversedIsBetter`) — départ (base de
   départ, ou dernière étape de la veille), arrivée (base de retour), heure
   d'une ancre seule (le sens où son arrivée estimée depuis 9 h tombe le
   plus près), tendance des logs (corrélation des rangs position / saisie :
   un ordre de saisie écarté garde un sens). Sans aucun indice — journée
   sans logs, ancre, base ni veille —, le sens d'`orderStops` (départ à
   l'extrémité du nuage) reste arbitraire. Avant le 2026-11-23, seule la
   veille orientait. Banc : indicateurs inchangés (les Labs masquées
   gardent deux ancres), 7 journées de l'historique retournées sur 746
   ordonnées par la géographie, temps de calcul identique. Sinon, toutes les étapes
   mises de côté s'insèrent au moindre détour en minutes de trajet
   (marche puis voiture, sans saut : `detourMinutes`), sans réordonner
   l'ossature.

**Heures** :
- départ à 9 h sans ancre ;
- durée de visite par type (traditionnelle 10 min, multi 40, mystery 15,
  event 90…, étape Lab 1, DNF 15) ;
- trajet à pied jusqu'à 1,5 km (4,5 km/h, détour ×1,25), en voiture au-delà
  (50 km/h, 80 au-delà de 30 km, détour ×1,3, +5 min de stationnement).

Entre deux ancres, les durées sont mises à l'échelle pour tomber juste.
Avant la première, l'horaire se calcule à rebours, sans descendre sous 5 h.
Une journée qui finirait après 22 h est comprimée (`compressed`).

**Confiance** (`anchored`, `logged`, `geo`) et **raison** (`time`,
`log-order`, `late-type`, `intruder`, `geo`, `inserted`) par étape ;
`diagnostics` par journée : `logOrder` (`trusted` / `rejected` / `none`),
`logRatio`, `lateTypes`, `intruders`, `anchors`, `compressed`.

### Banc sur un historique réel

`tools/parcours_bench_export.py` exporte les journées d'une base, sur une
COPIE, en y fusionnant au besoin les identifiants de logs d'un GPX My Finds.
`tools/parcours_bench.mjs` les rejoue.

```
python tools/parcours_bench_export.py --out jours.json --myfinds MyFinds.gpx
node tools/parcours_bench.mjs jours.json
```

Mesures du 2026-11-16 (historique de l'auteur : 1 058 journées d'au moins
deux étapes, 19 591 trouvailles, 4 774 étapes Lab horodatées) :

- **Les identifiants de logs ne donnent pas l'heure.** Ils croissent avec
  l'heure d'ENVOI. Environ la moitié des journées de 4 trouvailles ou plus
  sont loguées le jour même. L'étendue médiane des identifiants d'une
  journée vaut ~0,07 jour de logs mondiaux : une séance de saisie groupée,
  pas un étalement sur la journée. L'ordre de saisie reste un indice
  d'ordre, jugé géométriquement.
- **Ordre des logs** (862 journées de 4 étapes à log ou plus) : rapport
  chemin des logs / meilleur chemin p25 1,06, p50 1,18, p75 1,40, p90
  1,66 ; ordre retenu pour 65,5 % des journées à 1,3. Seuil 1,2 : 53 % ;
  1,5 : 82 %. 431 étapes de types tardifs mises de côté, 149 intrus (84
  traditionnelles, 38 mystery…). **Aucune vérité terrain** pour les
  géocaches : ces chiffres décrivent le verdict, ils ne le valident pas.
- **Heures Lab masquées** (199 journées d'au moins 4 Labs horodatées, une
  heure sur deux masquée, 2 231 étapes) : erreur p50 4,9 min, p75 34, p90
  120 ; étape replacée entre ses deux vraies ancres voisines : 46,7 %. Sur
  ces étapes, 800 sont à moins de 30 m d'une ancre voisine : la géographie
  ne peut pas trancher. Plafond structurel, pas un défaut de réglage.
- **Insertion qui tient compte du temps** (pénalité de dépassement du temps
  entre deux ancres, avec ou sans les bornes de la journée en ancres
  virtuelles) : toujours moins bonne (entre ses ancres : 36 à 43 %, erreur
  p50 6 à 10 min). Retirée.
- **Coût du détour continu** (2026-11-23, `detourMinutes`) : l'insertion
  comptait le détour avec `legForKm`, dont le saut marche → voiture à
  1,5 km casse l'inégalité triangulaire (marcher 1 km : 17 min ; rouler
  2 km : 8). Constaté sur une journée sans logs ancrée par des photos
  (col du Vršič) : étapes de la vallée logées entre deux photos à 15 min
  d'écart, celles du départ au milieu de la montée. Désormais : marche
  jusqu'à 1,5 km, puis seuls les km au-delà en voiture, sans
  stationnement (courbe concave). Heures Lab masquées, même historique
  (199 journées, 2 231 étapes) — avant / km seuls / continu : erreur p50
  4,4 / 5,1 / 4,2 min, p75 26,2 / 30,4 / 22,5, p90 111,5 / 111,9 / 103,3 ;
  entre ses ancres 49,2 / 46,9 / 50,9 %. Les km seuls réparaient la
  journée mais dégradaient les Labs : les minutes portent l'écart de
  vitesse, seul le saut posait problème.
- **Labs consécutives** : au même endroit, écart médian 12 s (d'où la
  visite Lab à 1 min) ; 0,2 à 1,5 km, vitesse à vol d'oiseau p50 2,5 km/h,
  visite comprise (modèle : 3,6 km/h hors visite). Au-delà de 5 km, p50
  14,5 km/h, mais ces paires incluent les géocaches trouvées entre deux Labs :
  le modèle voiture n'est pas recalé dessus.
- **Temps de calcul** : p50 0,03 ms, p99 0,9 ms, max 6 ms par journée
  (jusqu'à 818 étapes).

## Tests

- Python : `tests/test_parcours_api.py` (CRUD, validation, entrées, DNF,
  Labs, ajustements, migration), `tests/test_parcours_photos.py` (EXIF
  synthétique, envoi, doublon, vignette, rattachement, appareils,
  suppression), `tests/test_parcours_tracks.py` (lecture GPX, simplification
  qui garde une pause, envoi, refus, décalage UTC),
  `tests/test_parcours_routing.py` (réponses OSRM et openrouteservice
  simulées, découpage par trajet, cache, échecs, API),
  `tests/test_parcours_suggest.py` (centre habituel, séjours, grosses
  journées, noms, API) ; préférences de la
  page dans `tests/test_global_preferences.py`
  (`test_parcours_preferences_have_their_own_keys`, clé openrouteservice
  jamais renvoyée, `parcours_photo_display` borné).
- JS : `tests/js/parcours_reconstruct.test.mjs`,
  `tests/js/parcours_timeline.test.mjs` (dont `barSeries` / `barTicks` de la
  barre de chronologie), `tests/js/parcours_photos.test.mjs`,
  `tests/js/parcours_tracks.test.mjs`, `tests/js/parcours_routing.test.mjs`,
  `tests/js/parcours_camera.test.mjs`, `tests/js/parcours_model.test.mjs`,
  `tests/js/parcours_photo_layout.test.mjs` (cadrage, réglages, légende,
  créneaux, trois placements, effets, dessin sur un contexte factice),
  `tests/js/parcours_chapters.test.mjs`, `tests/js/app_mode.test.mjs`.
- Chapitres : `tests/test_video_chapters.py` (validation, formats,
  regroupement YouTube, encodages ffmpeg réels avec et sans musique),
  `test_delete_takes_the_youtube_chapters_along` de
  test_recent_videos.py ; e2e : « export vidéo » (chapitres lus dans le
  MP4, deux modes) et « écran de fin » de parcours-page.spec.mjs.
- Compléter depuis geocaching.com : `CollectRequestTests` et
  `test_stop_positions_follow_cache_position`,
  `test_favorite_and_cache_facts` et `test_parkings_of_the_parcours_caches`
  de test_parcours_api.py, `tests/js/parcours_parkings.test.mjs`,
  demande et favori dans tests/test_logs_api.py, mode « demande » du cœur
  dans `tests/js/logs_collect_core.test.mjs`, e2e
  `tests/e2e/parcours-gc-collect.spec.mjs` (export du favori simulé par un
  envoi direct à `/api/logs/receive/fragment`).
- E2E : `tests/e2e/parcours-page.spec.mjs` (lots 0 à 2),
  `tests/e2e/parcours-adjust.spec.mjs` (lot 3),
  `tests/e2e/parcours-photos.spec.mjs` (lot 4, photos de
  `tests/e2e/fixtures/parcours-photos/`, générées par `photo_bytes` de
  test_parcours_photos.py), `tests/e2e/parcours-tracks.spec.mjs` (lot 5,
  trace `tests/e2e/fixtures/parcours-trace.gpx` — `*.gpx` est ignoré :
  `git add -f`) et `tests/e2e/parcours-routing.spec.mjs` (lot 6 : faux
  serveur OSRM local sur un port libre, `parcours_routing.fossgis_url` pointé
  dessus — aucun appel réseau ; le cache `route_leg_cache` est partagé par le
  runtime, les comptes de requêtes sont relatifs) et
  `tests/e2e/parcours-finitions.spec.mjs` (lot 7 : caméra, nuit, carton,
  pictogramme, carte déplacée, réglages, suggestions simulées par
  `page.route`), `tests/e2e/parcours-photo-display.spec.mjs` (lots 9-10 :
  réglages, trois placements relevés par `photoCards`, lieu proposé ;
  fixtures `belvedere*.jpg`), `tests/e2e/parcours-timeline-bar.spec.mjs`
  (barre de chronologie : repères, sauts, clavier, bulle ; relevé
  `getTimelineBarSnapshot()`, `ticks` et `rangeEditable`),
  `tests/e2e/parcours-style.spec.mjs` (apparence des étapes et du trait :
  relevés `style`, `stopStyles` (`favorite` : cœur affiché), `planLine`,
  `trail`, `playStops` (`favorites`, `bursts`) ; PF servis par
  `page.route` sur `/inputs`), aides communes dans
  `tests/e2e/parcours-helpers.mjs`. Fixture
  `tests/e2e/fixtures/my-finds-parcours.gpx` (deux journées, compte 4242 :
  ordre des logs retenu le premier jour, earthcache loguée après coup le
  second).
  - Nettoyage (`cleanUp`) : logs, parcours (et donc leurs ajustements,
    lieux et photos), `parcours_animation` (10 quanta/s),
    `parcours_playback`, `parcours_photo_display`
    (`PHOTO_DISPLAY_DEFAULTS` de parcours-helpers.mjs) et
    `parcours_infos_template` (modèle par défaut).
  - Lecture complète, et export vidéo dans les deux pipelines (durée
    contrôlée par `video_validator.py`, MP4 supprimé ensuite).
  - Ajustements : flèches, glisser-déposer (`dragTo`), persistance,
    heure, journée, exclusion, annulation, base posée d'un clic sur la carte.
  - Relevé : `window.getParcoursSnapshot()` (`timeline`, `running`,
    `currentQ`, `head`, `infos`, `playLayers`, `camera`, `scene`,
    `routeCredit`, `suggestions`, `overrides`, `places`, `photos`
    (`hidden`, `caption`, `crop`), `photoDisplay`, `photoSlots`,
    `photoCards` (cartes peintes à la dernière image, px du canevas
    `photoView`),
    `days[].manual` / `excluded`, `adjustmentRevision` — à attendre après
    un ajustement) ; signal `window.mygcflowParcoursLoaded` / événement
    `mygcflow:parcours-loaded`.
