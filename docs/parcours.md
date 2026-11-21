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

## API (`blueprints/parcours.py`)

| Route | Rôle |
|---|---|
| `GET /parcours` | La page (`render_app_page('parcours')`) |
| `GET /api/parcours` | `{parcours, finds: {first, last}, maxDays}` — `finds` borne le formulaire de création |
| `GET /api/parcours/suggestions` | Parcours suggérés `{suggestions: [{kind: trip / day, start, end, days, findDays, finds, place}]}` (lot 7, ci-dessous), hors plages déjà enregistrées |
| `POST /api/parcours` | Création `{name, date_start, date_end?, include_labs?, include_dnf?}` ; `date_end` absente = une journée |
| `GET` / `PATCH` / `DELETE /api/parcours/<id>` | Lecture, patch (clé absente = inchangée), suppression. Un rétrécissement de la plage qui laisserait des lieux datés ou des ajustements « journée » dehors est refusé (409 `out-of-range`, compteurs `places`/`days`) : confirmation puis renvoi avec `drop_orphans` — les lieux datés sont supprimés, la journée des ajustements effacée |
| `POST /api/parcours/<id>/duplicate` | Copie sélection, ajustements et lieux (`<nom> (copie)` ; pas les photos ni les traces) |
| `GET /api/parcours/<id>/export` | Document JSON réimportable `{format: mygcflow-parcours, version: 1, parcours, overrides, places}` |
| `POST /api/parcours/import` | Recrée un parcours depuis un export — mêmes validations qu'à la création, tout ou rien |
| `GET /api/parcours/<id>/inputs` | Entrées de la reconstruction (ci-dessous), avec `overrides` et `places` |
| `PATCH /api/parcours/<id>/overrides` | `{overrides: [{key, rank?, pinnedTime?, day?, excluded?, legMode?, visitMin?}]}` : un champ présent remplace (null efface), un absent est gardé ; tout ou rien ; une étape sans plus d'ajustement perd sa ligne. Renvoie `{overrides, places}` |
| `DELETE /api/parcours/<id>/overrides` | Annule tous les ajustements (les lieux restent) |
| `POST /api/parcours/<id>/places` | Lieu `{kind: place, name, lat, lon, date, time?, category?, icon?}` ou base `{kind: base, name, lat, lon, date?, role?, category?, icon?}` (base sans date : toutes les journées ; `role` : `both`/`start`/`end` ; `category` : `other`/`parking`/`meal`/`viewpoint`/`lodging`/`supply`/`custom`, `icon` : classe `ti-…` seulement pour `custom`) |
| `PATCH` / `DELETE /api/parcours/<id>/places/<pid>` | Modification (patch), suppression |
| `POST /api/parcours/<id>/photos` | Envoi d'une photo (multipart, champ `photo`, 15 Mo au plus) ; la même photo deux fois n'est gardée qu'une fois |
| `GET /api/parcours/<id>/photos/<ph>/file` / `thumb` | Photo normalisée / vignette 320 px (cache long, nom = empreinte) |
| `PATCH` / `DELETE /api/parcours/<id>/photos/<ph>` | Rattachement manuel `{stopKey}` (null : automatique), affichage `{hidden, caption, aspect, focusX, focusY, zoom}` (lot 8 ; tout ou rien) ; suppression (fichiers compris) |
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
| `static/js/parcours_data.js` | Module de page : liste, création, suppression, étapes, plan, actions depuis la carte, moteur de lecture, tête et trait |
| `templates/menu_data_parcours.html` | Onglet Données |

Dans l'onglet Données, chaque étape porte son heure d'arrivée (exacte pour
une ancre, « ≈ » sinon) et la raison de sa place ; chaque journée, sa
distance et le verdict sur l'ordre des logs.

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
    points (Icône / Vectoriel) n'y a donc aucun effet visible : un
    avertissement sous le commutateur le dit et propose de passer en
    `theme` (`#parcoursThemePointsHint`, 2026-11-21 — sans lui, « Icône »
    semblait ne rien afficher).
  - `theme` : les points du thème (onglet Points) sont affichés ; le plan
    et la lecture n'y ajoutent que le numéro, dans une petite pastille en
    haut à droite (`themeNumberBadge`, posée d'après le rayon approché du
    point : centre + contour). Au repos, un disque invisible garde l'étape
    survolable et cliquable.
  - En lecture, une étape qui arrive grossit de rien à sa taille en 3
    quanta (`stopPopScale`, léger dépassement) ; la dernière arrivée est
    dessinée au-dessus (au repos, c'est le n° 1). Lieux et bases gardent
    leur couleur et leur pastille de catégorie dans les deux rendus.
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
  et l'heure passent au lendemain.

Les jours sans étape sont sautés, mais `{jour}` garde le rang de la date
dans la plage.

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

Trois crochets optionnels ont été ajoutés au contrat du moteur :
- `infosValues(now)` : valeurs texte qui priment sur les compteurs et sur la
  date du moteur ;
- `frameActive(now)` : entretient le rendu entre deux quanta ;
- `camera(leadMs, msPerDay)` : pose la vue avant chaque rendu (lot 7,
  ci-dessous).

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
| `parcours_playback` | `{pace: regular / proportional, hours: approx / exact / slots / none, camera: follow / fixed, day_cards, head: mode / dot, estimated_dashed}` (défauts : `regular`, `approx`, `follow`, `true`, `mode`, `false`) |
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

Ctrl+← / → saute d'une arrivée à l'autre ; le saut lui-même est celui de
toutes les pages (`seekAnimationToDate`, aperçu ouvert en pause). L'étiquette
au curseur (date, heure, étapes, instant de la vidéo) a une largeur fixe sur
cette page : sa longueur varie d'une étape à l'autre et la piste se
décalait sous le pointeur. La série et les repères sont mémoïsés sur
`timelineRevision` (incrémenté à chaque chronologie) et le réglage des
heures.

### Finitions (lot 7)

Réglages de la carte « Lecture » de l'onglet Données, lus à chaque image :
ils s'appliquent aussi en pleine lecture.

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
  Le dézoom est tenu 1,5 s avant de rezoomer (une balade garde un seul
  cadre, pas un par cache), la vitesse est bornée à 2,5 niveaux/s (le
  dézoom d'un long trajet ou de la nuit commence donc un peu avant le
  départ), puis le tout est lissé (σ = 4 quanta, résolution en logarithme) ;
- après la dernière étape, la vue d'ensemble (85 % du demi-écran) est une
  cible comme une autre ;
- le géocacheur est enfin gardé à 40 px du bord au moins (filet de
  sécurité, normalement inutile).

Avant le 2026-11-18, la caméra lissait des cadres par segment (le trajet
entier, l'étape) : elle partait vers le trajet suivant pendant l'arrêt
(jusqu'à 230 px par image), restait fixe pendant que le géocacheur
traversait l'écran, et le zoom pompait d'une cache à l'autre (jusqu'à
7,8 niveaux/s). Les réglages sont dans `CAMERA_DEFAULTS` ; les tests
(`tests/js/parcours_camera.test.mjs`) vérifient ces critères de confort.

La pose ne dépend que de la position du moteur : aperçu, saut et vidéo image
par image cadrent pareil. `mapgl.js` appelle le crochet `camera` après
`frameVars`, dans le pré-rendu. La vue posée s'applique donc à l'image
suivante : en capture image par image, `leadMs` (une image) la fait tomber
sur la bonne, comme la piste de caméra du mode principal.

Les tuiles de la suite sont demandées d'avance (`prefetchBasemapTiles`, pose
1,5 s plus loin, une fois par seconde d'écran). Glisser ou zoomer la carte
pendant la lecture suspend la caméra jusqu'à la lecture suivante. À la fin,
la vue d'avant la lecture revient, sauf si l'utilisateur a repris la main.

**Nuit et cartons** (réglage « Nuit et carton », défaut : oui) :
- la nuit assombrit la carte en cloche (`nightLevelAt` : 30 % de la nuit
  pour monter, 30 % pour redescendre ; voile bleu nuit à 50 % au cœur) ;
- le carton « Jour 2 » et la date longue (`dayCardAt`), pour un parcours
  de plusieurs journées :
  - le premier dès le début ;
  - les suivants du quart de la nuit jusqu'à 6 quanta après la première
    étape du jour, avec un fondu de 3 quanta ;
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
remplit le formulaire.

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
  hôtel, dormir ailleurs).

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
  le lieu retire ses déplacements de l'historique. Le point provisoire du formulaire de pose
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
| heure de confiance, sans position | celle dont la visite estimée (± 10 min) contient l'heure, sinon l'arrivée la plus proche à 45 min au plus |
| sinon | aucune (vignette estompée) |

**Heure de confiance** : celle d'un téléphone (photo géolocalisée : son
horloge suit le réseau), ou d'un appareil recalé. Un recalage à 0 compte
aussi : c'est l'utilisateur qui dit l'horloge juste. Une photo rattachée à
la main ou par position, à heure de confiance et le jour même, devient une
**ancre** de son étape : raison `photo`, heure exacte. Une heure épinglée
ou une heure Lab primeraient. Le rattachement par l'heure découle de
l'horaire : il ne peut pas le caler.

`reconstructWithPhotos` fait donc deux passes :
1. reconstruction sans photo ;
2. rattachement, puis ancres ;
3. reconstruction finale, puis rattachement final.

**Recalage d'un appareil** (carte Photos) : saisie du décalage en minutes,
ou « Caler l'horloge sur l'étape », proposé pour une photo sans position
rattachée à une étape à heure sûre (épinglée, Lab) : décalage = heure de
l'étape − heure de la photo.

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
- les photos sont préchargées fenêtré autour de la position de lecture :
  les miniatures (vignettes épinglées sur la carte) toutes d'office, les
  pleines tailles seulement pour les créneaux proches de la tête (~4 jours
  d'avance, un peu derrière pour l'effacement et les retours) — ouvrir un
  long parcours très illustré ne télécharge plus des centaines d'images
  2048 px. En lecture, une photo encore en chargement n'est simplement pas
  dessinée. Avant un enregistrement, elles sont toutes chargées et
  attendues (`parcoursPhotosReady`, plafond 3 s, branché sur le
  `whenImagesReady` de l'image par image et, en capture rapide, avant le
  départ de l'animation) : une photo encore en vol ne manque pas dans la
  vidéo.

La mise en page et le cadre décrits ci-dessus sont ceux par défaut ; ils se
règlent depuis le lot 9 (ci-dessous).

## Onglet Photos (lots 8 à 10)

Les photos ont leur onglet (`#photos`, `templates/menu_photos_parcours.html`),
à la place de l'onglet Images, masqué sur `/parcours` : bibliothèque,
appareils, détail d'une photo, lieux proposés, réglages d'affichage. Un
contrôle d'un onglet fermé n'est pas visible : les specs ouvrent
`a[href="#photos"]` avant d'y toucher.

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
- **Légende** : la balise `{legende}` du gabarit d'affichage.
- **Cadrage** (`photoCropRect`, `parcours_photo_layout.mjs`) : la plus
  grande fenêtre aux proportions voulues, réduite de 1/zoom, centrée sur le
  point focal et gardée dans l'image. Sélecteur sur la vignette (glisser, ou
  flèches : 1 %, Maj = 10 %), enregistré au relâchement. Légende et cadrage
  ne touchent que le dessin : la photo est remplacée en mémoire, sans
  reconstruction.

### Affichage dans la vidéo (lot 9)

Préférence globale `parcours_photo_display` (`coerce_parcours_photo_display`
de settings_manager.py, `normalizePhotoDisplay` côté client, mêmes bornes),
envoyée entière à chaque changement :

| Clé | Valeurs (défaut en premier) |
|---|---|
| `layout` | `stop` (près de l'étape), `fixed` (emplacement fixe), `strip` (bande), `none` (aucune photo) |
| `side` | près de l'étape : `auto` (vers le centre de l'écran ; haut-droite près du centre, pour que la caméra qui suit ne la fasse pas basculer), `top-right`, `top-left`, `bottom-right`, `bottom-left` |
| `anchor` | emplacement fixe : `top-right` et les 7 autres ancres des images, à 16 px du bord |
| `leader` | trait de l'étape vers la carte (près de l'étape, emplacement fixe) : `false` |
| `stack` | pile (près de l'étape, emplacement fixe) : les photos d'une étape se posent les unes sur les autres, décalées et inclinées selon leur rang, et la pile s'efface d'un bloc après la dernière : `false` |
| `pin`, `pin_size` | vignettes sur la carte (près de l'étape, emplacement fixe) : au lieu de s'effacer, chaque photo (la pile entière avec `stack`) descend en 4 quanta vers une petite pile attachée à son étape, et y reste jusqu'à la fin ; grand côté 40-160 px CSS : `false`, 72 |
| `strip_edge`, `strip_reset` | bande : `bottom` / `top` ; vidée à l'arrivée sur la première étape d'une nouvelle journée : `false` |
| `size` | grand côté de l'image, 120-600 px CSS : 220 |
| `frame` | `postcard` (marge blanche, ombre), `polaroid` (marge basse épaisse), `rounded` (coins arrondis, ombre), `plain` |
| `tilt` | ± 2,5° en alternance : `true` |
| `effect` | `fade`, `slide`, `zoom` (courbes d'`images_render.mjs`) |
| `ken_burns` | zoom lent (+ 8 %) pendant l'affichage : `false` |
| `duration`, `max_per_stop` | 1,5 s par photo (0,5-6), 4 photos au plus en temps cumulé par étape (1-12) |
| `caption` | gabarit `{legende}`, `{etape}`, `{heure}`, `{jour}`, `{date}` (120 caractères ; vide : pas de légende) |

- **Chronologie** : `photoSlots` (créneaux : arrivée + 2 quanta, puis une
  photo après l'autre, fondu de 2 quanta). `duration`, `max_per_stop` et
  `none` changent le temps d'écran (`photoTimelineOptions`), donc la
  chronologie — appliqués à la fin d'une lecture en cours, comme le rythme.
- **Mise en page** : `photoFrameAt(timeline, q, réglages, vue)` rend les
  cartes du quantum (centre, taille, cadre, rotation, opacité, effet, zoom
  lent, légende, trait) en px du canevas ; `parcours_photo_draw.mjs` les
  peint dans le `postrender` de la couche de la tête : filmées, et à la
  bonne échelle en capture haute résolution (`ratio`).
- **Bande** : la photo entre en grand au-dessus de la bande (en dessous pour
  une bande en haut), puis rejoint sa case en rétrécissant pendant le
  dernier tiers de son temps (4 quanta au plus) ; la bande défile vers la
  gauche quand elle déborde, les vignettes sorties s'effacent.
- **Vignettes sur la carte** : côté choisi par `pinDirection` parmi 8
  directions, la moins encombrée par le trajet (tout le parcours, chemins
  réels compris, passé et à venir) et les autres étapes dans un rayon de
  500 m, chaque point pesant d'autant plus qu'il est proche et dans l'axe.
  Calculé en distances au sol, une fois par étape : le côté ne change ni
  avec le zoom ni quand la caméra suit. Une vignette suit son étape, avec
  un trait vers elle ; gardée dans l'écran tant que l'étape y est, pas
  dessinée sinon. Peintes depuis les miniatures (320 px), sous les photos
  montrées.
- **Légende** (`photoCaptionText`) : une balise vide ne laisse pas de
  séparateur orphelin. `{heure}` : celle de la photo si elle est de
  confiance, sinon celle de l'étape (« ≈ » selon « Heures affichées »).
  Écrite dans la marge (carte postale, polaroid) ou sur un bandeau dégradé
  (coins arrondis, sans cadre), tronquée (…).
- **« Voir sur la carte »** (détail d'une photo, et « Voir la première photo
  sur la carte ») : ouvre l'aperçu en pause (`startPausedPreview`) et saute
  au créneau de la photo (`seekAnimationToDate`) — pour régler l'affichage
  sans rejouer le parcours.

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
  sans route possible y est gardé sans géométrie : il n'est plus redemandé.
  « Pas de route » portant sur toute une requête de plusieurs trajets, elle
  est re-découpée par dichotomie jusqu'à isoler le ou les coupables
  (`_route_chunk`) — les trajets routables voisins gardent leur itinéraire.
  « Recalculer » ignore le cache (`force`) ; « Réessayer », proposé après
  un échec ou une annulation, reprend le calcul sans l'ignorer ;
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
  données (24 h), servi au favori par `/api/logs/receive/state`.
- **Collecte** : le favori confirme (« Parcours « … » : relire ses N
  caches ? »), ne lit que ces codes et n'envoie aucune couverture ; chaque
  fragment porte `X-MyGCFlow-Request`. Au scellement, l'aperçu garde
  `request_id` / `parcours_id` et la demande disparaît.
- **Validation** : la carte relève `/api/logs/status` toutes les 4 s tant
  qu'une demande ou un export est attendu (onglet Données affiché) :
  `collection_in_progress.request_id` → « Collecte en cours », puis
  `pending_import` du parcours → bilan (`caches_in_file`,
  `caches_corrected`, `favorites_mine`) et « Valider l'import »
  (`/api/logs/import/commit`, tâche suivie, puis rechargement du
  parcours). Pas la fenêtre d'aperçu de « Mes logs » : sans couverture,
  rien ne peut être retiré.
- Relevé e2e : `getParcoursCollectSnapshot()` (`collect`, `pending`,
  `progress`, `polling`).
- **Ce qui en sort** (lot 13) : PF donnés (cœur, envol, `{pf}`), total de
  PF et nombre de trouvailles dans la bulle (§ Entrées). Le favori lit le
  nombre de trouvailles dans les compteurs de la fiche
  (`#ctl00_ContentBody_lblFindCounts` : Found it + Attended + Webcam) ;
  sans compteurs lisibles, il le signale une fois dans la console.
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
   travel_trail.mjs), orienté depuis la veille. Sinon, toutes les étapes
   mises de côté s'insèrent au moindre détour en minutes de trajet, sans
   réordonner l'ossature.

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
  `tests/js/app_mode.test.mjs`.
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
