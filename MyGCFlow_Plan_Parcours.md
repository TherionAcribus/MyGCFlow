# Parcours : une journée ou des vacances, cache par cache

Plan rédigé le 2026-11-16. **Rien n'est codé.**

Idée : animer un parcours court (une journée, un week-end, des vacances) non
plus jour par jour, mais **cache par cache**, avec la progression des heures
et des jours. Le géocacheur se déplace sur la carte d'étape en étape ; chaque
cache apparaît à son arrivée.

Difficulté centrale : les données ne disent ni l'heure ni l'ordre réels.
- l'heure des logs GPX (`time_find`) est fictive (19:00/20:00 UTC, minuit du
  Pacifique, sur 96 % d'une base réelle) ;
- les logs sont souvent saisis en bloc le soir, parfois dans le désordre (les
  virtuelles et earthcaches loguées après coup, une fois les réponses
  envoyées).

Le parcours est donc **reconstruit** à partir de tous les indices disponibles,
avec un niveau de confiance par étape, et l'utilisateur peut l'ajuster.

Choix validés avec l'utilisateur (2026-11-16) :
- **un 4e mode de page** (`/parcours`), construit sur le gabarit commun
  (`app.html`, `data-mode`, sélecteur de l'en-tête) comme `/poses` : les
  spécificités (caches affichées, photos nombreuses, heures, modes de
  déplacement) ne polluent pas la carte standard, mais fond de carte, style
  des points, flashs, musique, enregistrement, habillage, panneaux et images
  sont partagés ;
- les **traces GPS** existent parfois, rarement pour tout le parcours : elles
  doivent pouvoir être **partielles** ;
- l'**heure affichée** est une option laissée à l'utilisateur ;
- les **photos** de l'utilisateur servent d'indices (EXIF heure + position,
  ou rattachement manuel à une cache ou un lieu) et s'affichent dans
  l'animation ;
- les **itinéraires réels** (à pied, vélo, voiture) sont voulus, en option.

## 0. État d'avancement

**Lot 0 livré le 2026-11-16** : mode `parcours` (`app_mode.mjs`, page
`/parcours`, lien d'en-tête), table `parcours` (migration v10),
`parcours_store.py`, `parcours_dataset.py`, `blueprints/parcours.py`,
`parcours_model.mjs` (ordre provisoire), `parcours_data.js` (liste,
création, suppression, étapes par jour, couche carte numérotée). Doc :
`docs/parcours.md`.

**Lot 1 livré le 2026-11-16** : `parcours_reconstruct.mjs` (ancres, ordre
des logs avec types tardifs et intrus, verdict géométrique, insertion au
moindre détour, horaire, confiance et raison par étape), branché dans
l'onglet Données (heure « ≈ », raison, bilan par jour), banc
`tools/parcours_bench_export.py` + `tools/parcours_bench.mjs`, mesures dans
`docs/parcours.md`.

**Lot 2 livré le 2026-11-16** : `parcours_timeline.mjs` (temps écran en
quanta, rythmes régulier et proportionnel, nuit entre deux journées,
position du géocacheur, heure et distance affichées), moteur de lecture
dans `parcours_data.js`, tête et trait dessinés pendant la lecture et dans
la vidéo, ligne d'infos à balises, réglages de lecture (rythme des étapes,
heures affichées), préférences propres à la page. Export vérifié dans les
deux pipelines.

**Lot 3 livré le 2026-11-16** : ajustements manuels dans l'onglet Données
(flèches et glisser-déposer pour l'ordre d'une journée, heure épinglée,
journée corrigée, exclusion et réintégration, « Ordre automatique »,
« Annuler les ajustements »), lieux et bases posés d'un clic sur la carte.
Tables `parcours_override` et `parcours_place` (migration v11), API
`/overrides` et `/places`, `applyAdjustments` + `reconstructDay` dans
parcours_reconstruct.mjs.

**Lot 4 livré le 2026-11-16** : photos. Lecture EXIF avant normalisation,
`parcours_photos.py` (stockage, vignettes, appareils), tables
`parcours_photo` et `parcours_camera` (migration v12), rattachement et
ancres dans `parcours_photos.mjs`, carte « Photos » de l'onglet Données,
carte postale dans la lecture et la vidéo.

**Lot 5 livré le 2026-11-16** : traces GPS. `parcours_tracks.py` (lecture
GPX, simplification, stockage), table `parcours_track` et colonne
`parcours.utc_offset_minutes` (migration v13), `parcours_tracks.mjs`
(heure locale, rattachement, ancres, vrai chemin, `reconstructWithEvidence`),
trajets sur la trace dans la lecture et la vidéo, carte « Traces GPS » de
l'onglet Données.

**Lot 6 livré le 2026-11-16** : itinéraires réels. FOSSGIS par défaut,
openrouteservice en option « plus fiable » (choix de l'utilisateur,
question 4 du § 13). `parcours_routing.py` (fournisseurs, débit, cache
`route_leg_cache`, migration v14), `parcours_routing.mjs` (mode par trajet,
suites de requêtes, durées et chemins), mode imposé par étape (`legMode`),
carte « Itinéraires ».

**Lot 7 livré le 2026-11-16** : finitions. Caméra qui suit le géocacheur
(`parcours_camera.mjs`, crochet `camera` du moteur), nuit assombrie et
cartons de jour, tête en pictogramme du mode de déplacement, trajets estimés
en pointillés (option), crédits des itinéraires à l'écran et dans la vidéo,
parcours suggérés (`parcours_suggest.py`, `GET /api/parcours/suggestions`).
Tout le plan est livré ; restent les questions du § 13.

**Suite (2026-11-17)** : photos dans la lecture, modulables (§ 14, lots 8
à 10). **Lots 8 à 10 livrés le 2026-11-17** : onglet Photos, réglages par
photo (migration v15), préférence `parcours_photo_display` et trois
placements (`parcours_photo_layout.mjs`, `parcours_photo_draw.mjs`), lieux
proposés (`suggestPhotoPlaces`).

**Barre de chronologie (2026-11-17)** : la barre des autres pages, jusque-là
masquée sur `/parcours`, y est branchée par un crochet `timelineBar` du
moteur (`barSeries` / `barTicks` de parcours_timeline.mjs) : arrivées aux
étapes, nuits et journées (ou heures d'une journée unique), DNF et photos,
vraies dates et heures dans les bouts, l'étiquette et la bulle, Pg.Préc /
Pg.Suiv de journée en journée. Pas de bornes tirables : la plage reste le
parcours entier. Détails dans docs/parcours.md › Barre de chronologie.

**Suite (2026-11-21)** : compléter un parcours depuis geocaching.com
(coordonnées corrigées, PF donnés, parkings), collecte limitée aux caches
du parcours en cours (§ 15, lots 11 à 15). **Rien n'est codé.**

Écarts et constats des lots 8 à 10 :
- **Côté « auto »** : vers le centre de l'écran, mais haut-droite tant que
  l'étape est près du centre — avec la caméra qui suit, l'étape y est
  presque toujours, et un choix par position exacte faisait basculer la
  carte d'un côté à l'autre pendant son affichage.
- **Vignettes de la bande = cartes réduites** (même cadre, légende effacée)
  : le passage de la grande photo à sa case est un simple rétrécissement.
- **Trait vers l'étape** : vaut aussi pour l'emplacement fixe.
- **Lieux proposés** : une photo rejoint un groupe à moins de 75 m (moitié
  du rayon) de sa première photo, pour que toutes se rattachent seules au
  lieu posé au centre. Créés depuis l'onglet Photos (nom facultatif), sans
  passer par le formulaire de l'onglet Données.
- **« Voir sur la carte »** : aperçu en pause calé sur la photo, pour régler
  l'affichage sans rejouer le parcours ; il sert aussi aux specs.

Écarts et constats du lot 7 :
- **Caméra calculée, pas simulée** : la pose est une fonction de la position
  du moteur (moyenne pondérée des cadrages visés sur ±8 quanta). Pas d'état,
  donc rien à recaler après un saut ni en capture image par image. Un
  échantillonnage par quantum entier faisait sauter le zoom à l'arrivée d'un
  long trajet : un quart de quantum le rend continu.
- **À l'arrêt, seuls les trajets voisins courts** (≤ 2 km) entrent dans le
  cadrage : sinon la caméra dézoomait dès l'arrivée, avant le long trajet.
- **Carte déplacée = caméra suspendue** jusqu'à la lecture suivante, et la
  vue n'est pas rendue à la fin.
- **Compteurs** : rien d'ajouté, les balises existantes (`{etapes}`,
  `{km}`, `{jour}`…) couvrent le besoin.
- **Mode de la tête sur une trace ou en ligne droite** : déduit de la
  vitesse de l'horaire (seuils 7 / 22 / 250 km/h), avion au-delà de 150 km
  en ligne droite.
- **Crédits dans la vidéo** : peints par la couche de la tête pendant un
  enregistrement seulement ; à l'écran, l'attribution d'OpenLayers.
  L'attribution des tuiles, elle, n'est pas dans les vidéos (constat
  général, hors Parcours).
- **Suggestions** : centre habituel = case de 0,5° la plus fréquentée
  (journées, pas trouvailles) ; nom tiré des champs pays / région du GPX,
  donc dans la langue de geocaching.com.

Écarts et constats du lot 6 :
- **Cache partagé par tous les parcours**, par coordonnées : deux parcours
  qui passent au même endroit ne redemandent rien.
- **L'ordre n'est pas recalculé avec les durées réelles** : il reste
  géométrique, seules les heures changent. Pas de boucle, et aucun trajet
  nouveau à demander après coup.
- **Échec = suspension** des tentatives jusqu'à une action de
  l'utilisateur.
- **`saveSettingsPatch` remplace la clé entière** dans
  `window.userSettings` : la page remet la valeur complète après
  l'écriture (itinéraires et réglages de lecture). Sans cela, une
  préférence en sous-clés y était réduite au dernier patch envoyé.
- **Crédits dans la vidéo** : non faits, seule la carte de l'onglet Données
  porte l'attribution. Faits au lot 7.
- **Une tête par mode de déplacement** (piéton, vélo, voiture) : faite au
  lot 7.

Écarts et constats du lot 5 :
- **Fuseau sans `timezonefinder`** (question 2 du § 13) : réglage du
  parcours, sinon décalage EXIF des photos, sinon heures murales situées sur
  la trace (Labs, photos géolocalisées), sinon fuseau de l'ordinateur. Pas
  de dépendance ajoutée. Un voyage qui change de fuseau en cours de route
  garde un seul décalage : à revoir si le besoin se présente.
- **Simplification en distance synchronisée** : un Douglas-Peucker spatial
  effaçait les pauses (points alignés), donc faussait les heures. Constaté
  sur la fixture e2e (461 points ramenés à 9) ; corrigé et testé.
- **Distance au tronçon, pas aux points**, pour la même raison : une ligne
  droite simplifiée ne garde que ses bouts.
- **Passage retenu = le plus long** à moins de 100 m (aller-retour sur un
  même sentier). L'arrivée est le premier instant à moins de max(30 m,
  2 × distance minimale), donc parfois une minute avant la pause.
- **Pas de recalage automatique des appareils sans GPS** par la trace :
  sans position, une photo d'appareil ne se situe pas sur la trace. Le
  recalage reste manuel, ou se cale sur une étape à heure sûre, désormais
  aussi celle d'une trace. FIT et chronologie Google : non faits
  (question 6).
- **Rythme proportionnel** : durée des trajets tirée de l'horaire.

Écarts et constats du lot 4 :
- **Heure de confiance** : photo géolocalisée (un téléphone, horloge
  réseau) ou appareil recalé, même à 0. Une photo d'appareil sans GPS
  jamais recalé ne cale rien : son heure n'est qu'affichée.
- **Le rattachement par l'heure ne fait pas d'ancre** : il découle de
  l'horaire, le laisser le caler tournerait en rond. D'où deux passes de
  reconstruction (`reconstructWithPhotos`).
- **Le recalage automatique depuis une trace** est reporté au lot 5. Pour
  l'instant : à la main, ou « Caler l'horloge sur l'étape » quand la photo
  est rattachée à une étape à heure sûre (épinglée, Lab).
- **Fuseaux** : les heures murales (EXIF, Labs) sont prises telles
  quelles ; `OffsetTimeOriginal` est stocké mais pas encore utilisé. Il
  servira au lot 5, où les traces sont en UTC.
- **Carte postale dessinée dans le canevas de la couche de la tête**, pas
  dans un panneau Images : position liée à l'étape, fondu, inclinaison. Un
  export images du spec e2e vérifie que le canevas reste exportable.

Écarts et constats du lot 3 :
- **Ordre manuel = un rang pour chaque étape de la journée**, écrit à
  chaque déplacement : plus robuste qu'un rang isolé si la reconstruction
  change ensuite. Les étapes sans rang (nouvelles après un réimport) s'y
  insèrent au moindre détour. Il prime sur l'heure des ancres.
- **Pas d'onglet « Étapes » séparé** : le panneau d'ajustement s'ouvre sous
  l'étape, dans l'onglet Données, à côté de la liste qu'il modifie.
- **Mode du tronçon suivant** (à pied, vélo, voiture) : reporté au lot 6,
  où il sert enfin (itinéraires).
- **Clé d'une base propre à la journée** (`place:<id>:<date>:start`) : une
  même base sert plusieurs jours, et deux panneaux s'ouvraient à la fois.
- **Lieux et bases sans point WebGL** : dessinés par la couche de la tête
  pendant la lecture, par le plan au repos ; jamais comptés parmi les
  étapes.

Écarts et constats du lot 2 :
- **La piste « horloge à quanta » est validée** : le Parcours passe par le
  contrat `lifecycle_engine.mjs` (`isLifecyclePage()` vrai sur
  `/parcours`), un « jour » du moteur = 100 ms de temps écran à la vitesse
  naturelle. Aucune modification des pipelines d'enregistrement. Deux
  crochets optionnels ajoutés au contrat : `infosValues` (date réelle,
  heure, km, qui priment sur la date fictive du moteur) et `frameActive`
  (rendu continu entre deux quanta).
- **Le mode principal n'a pas servi** : le trait et la caméra de mapgl.js
  restent ceux de « Mes Géocaches ». La page dessine sa propre tête et son
  propre trait (deux couches en `postrender`, filmées par la capture),
  plus simples que le stylo de travel_trail.mjs. Le style reprend la
  couleur et l'épaisseur du trait du thème.
- **Deux préférences de la page principale étaient écrasées** via le repli
  de `perPage` : `animation` (suivi de caméra remis à false) et
  `last_profile_uid`. Clés propres : `parcours_animation`,
  `parcours_last_profile_uid`, plus `parcours_infos_template` et
  `parcours_playback`.
- **Affichage des heures** dans les réglages de lecture de l'onglet
  Données (pas dans l'onglet Animation) : il ne touche que la balise
  `{heure}`. La liste des étapes garde toujours le détail « ≈ ».
- **Reportés** :
  - la barre de chronologie (masquée : ses libellés seraient des dates
    fictives) ;
  - les onglets Stats et Images ;
  - le carton et l'assombrissement de nuit, et la tête par mode de
    déplacement (faits au lot 7) ;
  - l'apparence propre des DNF (affichés comme une cache de leur type).

Écarts et constats du lot 1 :
- **Les identifiants de logs ne donnent pas l'heure** (ils datent l'envoi,
  et les envois sont groupés). L'ordre de saisie reste un indice d'ordre,
  jugé géométriquement comme prévu (§ 4). Seuil `trustRatio` gardé à 1,3,
  faute de vérité terrain pour le valider.
- **Insertion « au moindre détour en minutes de trajet »** (modèle à pied /
  en voiture de l'horaire), pas en km. Une insertion qui pénalisait en plus
  le dépassement du temps entre deux ancres a été mesurée moins bonne et
  retirée.
- **Plafond de la validation par les Labs** : 36 % des étapes masquées sont
  à moins de 30 m d'une ancre voisine, la géographie ne peut pas les
  départager. 46,7 % replacées entre leurs vraies ancres.
- **Visite d'une étape Lab : 1 min** (étapes validées en rafales).
- **Journées « power trail »** : au-delà de 300 étapes
  (`FULL_ANALYSIS_MAX_STOPS`), pas de recherche d'intrus ni de matrice de
  distances précalculée. Le banc passe à 6 ms au plus pour 818 étapes.
- **Les ajustements manuels** (`overrides`) sont déjà acceptés par
  `reconstructDay` (heure épinglée = ancre). Le rang forcé et le reste
  viendront au lot 3.

Écarts avec le plan ci-dessous, constatés en codant :
- **Migration v10 réduite à la table `parcours`.** `parcours_override`,
  `parcours_place`, `parcours_photo`, `parcours_track` et `route_leg_cache`
  viendront avec leurs lots (une migration chacun), une fois leur forme
  éprouvée par l'interface qui les utilise.
- **Le contrat `parcours_engine.mjs` n'est pas encore écrit** : l'essai
  (ci-dessous) montre qu'il dépend du choix d'horloge, à trancher au début
  du lot 2. Le lot 0 livre un affichage statique, sans moteur.
- **Listes par page déjà créées** : `stats.parcours_panels` et
  `images.parcours_items` (client, serveur, vecteurs partagés). Sans elles,
  `statsPanelsKey('parcours')` et `imagesItemsKey('parcours')` valaient
  `undefined` et les onglets Stats et Images cassaient. Les configurations
  de Stats d'un parcours sont celles du mode principal
  (`statsConfigModeFor('parcours') === 'finds'`).
- **Onglets Animation, Stats et Images masqués** au lot 0 (volets gardés
  dans la page), lecture rapide et chronologie masquées par CSS.
- **Bug évité** : `perPage` retombe sur la clé de la page principale. La
  page Parcours réécrivait donc `animation` au chargement, suivi de caméra
  remis à `false` (`camera_follow && isMainPage()`).
  `saveAnimationSettings` ne fait rien sur `/parcours` tant que le rythme du
  parcours n'a pas sa clé (lot 2) ; le spec e2e le vérifie.
- **DNF écarté si la cache est trouvée le même jour** : la trouvaille
  représente déjà le passage.
- **Plage limitée à 92 jours** (`MAX_DAYS`) ; dates saisies par des
  `<input type="date">` natifs.

### Conclusions de l'essai (ce qui suppose un pas de durée constante)

| Pièce | Constat | Conséquence |
|---|---|---|
| Trait (`scheduleTravelTrail`, mapgl.js) | Arrivée du stylo = `(pas d'arrivée − pas courant) × msPerDay` | Les fonctions pures (`buildTrailRoute` avec une étape par « jour », `scheduleStroke`, `pointAtLength`) se réutilisent ; l'ordonnanceur de mapgl, non : l'arrivée doit venir des instants du parcours |
| Caméra (`simulateCameraJourneys`) | Raisonne sur une suite de groupes, rend la durée de chaque trajet ; mapgl suspend l'horloge des jours pendant les trajets | Réutilisable telle quelle sur la suite des étapes ; la durée des trajets s'intègre au temps écran à la construction, sans suspension |
| Enregistrement (`recordingDayCount`, `framesForDay`) | Nombre d'images = pas × images par pas | Fonctionne sans changement si le parcours est découpé en pas réguliers |

**Piste retenue pour le lot 2 : une horloge à quanta.** Le temps écran du
parcours (§ 5) est découpé en quanta d'une image vidéo (1000 / fps ms).
Le moteur tourne comme un moteur à jours dont le « jour » est le quantum :
`dayCount = ⌈totalMs / quantum⌉`, `msPerDay = quantum`, plusieurs pas par
image autorisés. Enregistrement, pause, reprise, saut de la chronologie et
calage sur la musique fonctionnent alors comme aujourd'hui. Le moteur du
parcours décide de ce qui apparaît à chaque quantum, pilote le stylo avec
les vrais instants d'arrivée, et rejoue une piste caméra précalculée.

À vérifier au début du lot 2 :
- passer par le contrat `lifecycle_engine.mjs` (`begin`, `step`,
  `frameVars`, `restState`), qui exclut aujourd'hui caméra et trajet, ou
  par un crochet propre ;
- tout ce qui affiche une **date** (sélecteurs de l'onglet Animation,
  balise `{date}`, libellés de la chronologie, Stats par jour) doit lire
  l'horloge du parcours et non le quantum.

## 1. Vocabulaire

| Terme | Sens |
|---|---|
| **Parcours** | Une sélection enregistrée : nom, plage de dates, sources retenues, réglages, ajustements |
| **Étape** (*stop*) | Un lieu où l'on s'arrête : une cache trouvée, une étape Lab, un DNF, un **lieu** (point de vue, hôtel, resto) |
| **Clé d'étape** | Identité stable : `GC12345`, `lab:<local_uid>`, `dnf:<log_id>`, `place:<id>` |
| **Ancre** | Une heure sûre pour une étape (Lab, trace, photo recalée, heure épinglée) |
| **Tronçon** (*leg*) | Le trajet entre deux étapes consécutives : mode (à pied, vélo, voiture, avion/ferry), géométrie, durée |
| **Base** | Point de départ et d'arrivée d'une journée (hôtel, domicile) |
| **Confiance** | `anchored`, `pinned`, `logged` (ordre des logs), `geo` (géographie seule) |

## 2. Les indices et leur fiabilité

| Indice | Source dans l'app | Apport | Fiabilité |
|---|---|---|---|
| Heure épinglée | Ajustement manuel (lot 3) | Heure + ordre | Absolue |
| Trace GPS | Import GPX (lot 5) | Heure de passage + vraie géométrie | Forte, partielle |
| Heure Lab | `lab_discovery` → `found_local_time` (`lab_geojson.py`) | Heure locale réelle | Forte |
| Photo EXIF | Import (lot 4) | Heure (+ position) | Forte si l'horloge de l'appareil est recalée |
| Ordre des logs | `log_event.log_id` (alimenté par l'import My Finds) | Ordre de saisie | Variable : bon sur le terrain, faux en saisie groupée |
| Géographie | Coordonnées | Plus court chemin, continuité d'un jour à l'autre | Toujours disponible |
| Type de cache | `cache_type` | Durée de visite ; « logable plus tard » (virtuelle, earthcache, webcam) | Statistique |
| Texte des logs | GPX, **pas stocké** | « vers 10h », « pour finir la journée » | Bruité : hors périmètre |

Le texte des logs n'est pas retenu au premier jet. Il faudrait le stocker à
l'import, et l'extraction d'heures dans un texte libre multilingue est
fragile. Le sujet est à réévaluer après le lot 7.

### Heures locales et fuseaux

Tout l'horaire est en **heure locale du lieu** (heure murale) :
- `found_local_time` des Labs est déjà une heure locale ;
- l'EXIF `DateTimeOriginal` est une heure murale de l'appareil, avec
  `OffsetTimeOriginal` parfois présent (téléphones récents) ;
- les traces GPX sont en **UTC** : il faut un fuseau pour les convertir.

Le parcours porte donc un **fuseau par jour**. Par défaut, il est déduit de
la première source qui en donne un (`OffsetTimeOriginal`, ou le fuseau du
navigateur pour un parcours local), et il reste modifiable. La déduction
depuis les coordonnées (paquet `timezonefinder`) est à évaluer au lot 5 : il
faut mesurer son poids dans l'exécutable (question ouverte, § 13).

## 3. Données et stockage

### Entrées (lecture seule)

- `geocache` : trouvailles de la plage, avec `gc_code`, coordonnées,
  `cache_type`, D/T, `date_find` (date seule).
- `log_event` : `log_id` des trouvailles, pour l'ordre de saisie. Les DNF du
  compte (catégorie `dnf`), en option comme étapes : par défaut **oui**, comme
  `dnf_in_trail` (« il s'est tout de même déplacé »).
- `lab_discovery` : étapes Lab datées et placées, avec leur heure locale.

Une route serveur `GET /api/parcours/<id>/inputs` sert ces entrées en
colonnes, avec une ETag faible comme `/api/poses/data`.

### Tables propres (migration v10 pour `parcours`, les autres avec leur lot)

Principe : **on stocke les entrées et les ajustements, jamais le résultat**.
La reconstruction est pure et déterministe, recalculée côté client. Un
réimport du GPX ne perd donc aucun ajustement, et une amélioration de
l'algorithme profite aux anciens parcours.

| Table | Contenu |
|---|---|
| `parcours` | id, nom, `date_start`, `date_end`, sources (`dnf`, `labs`), réglages JSON (fenêtre de journée, durées, fuseaux par jour, modes par défaut), dates de création et de modification |
| `parcours_override` | (parcours, clé d'étape) → rang forcé dans la journée, heure épinglée, exclusion, mode du tronçon suivant, jour forcé |
| `parcours_place` | Lieux et bases : nom, coordonnées, type (`base` / `lieu`), jours concernés |
| `parcours_photo` | Fichier, heure EXIF brute, décalage, position EXIF, clé d'appareil, étape rattachée, origine du rattachement (`auto` / `manual`) |
| `parcours_track` | Trace importée : nom, points simplifiés (lon, lat, t UTC), bornes |
| `route_leg_cache` | Itinéraires calculés : fournisseur, profil, empreinte des coordonnées, géométrie, distance, durée, date de calcul |

Les photos vivent dans un dossier propre du répertoire de données,
`parcours_photos/<parcours>/`, et pas dans `images/`. La bibliothèque Images
est limitée à 4 éléments et **retire l'EXIF** à la normalisation
(`image_library.normalize_image`) : il faut lire l'EXIF **avant** de
normaliser. La normalisation est réutilisée (2048 px, HEIC via `pillow-heif`,
déjà en dépendance), avec une vignette de 256 px en plus.

## 4. Reconstruction (lot 1)

Module pur `static/js/parcours_reconstruct.mjs`, sans DOM ni OpenLayers,
testé sous Node (`tests/js/parcours_reconstruct.test.mjs`).

### Contrat

```
reconstructParcours({ days, overrides, places, anchors, legHints, options })
  days      : [{ date, tz, stops: [{ key, kind, lon, lat, type, logId?, localTime?, … }] }]
  overrides : Map clé → { rank?, pinnedTime?, excluded?, legMode?, day? }
  places    : bases et lieux
  anchors   : heures issues des traces et des photos recalées (lots 4-5)
  legHints  : durées d'itinéraires connues (lot 6), sinon vitesses forfaitaires
→ { days: [{ date, start, stops: [{ key, order, arrival, departure, confidence, reasons }],
             legs: [{ from, to, mode, km, minutes, source }] }],
    diagnostics: { logOrderTrusted, outliers, … } }
```

`reasons` explique chaque décision (« ordre des logs », « inséré au plus
court », « intrus : logué après coup »). La liste des étapes (lot 3) l'affiche
au survol.

### Étape 1 : ordre de passage, journée par journée

1. **Départ** : la base du jour, sinon la dernière étape de la veille, sinon
   la première ancre.
2. **Ancres et heures épinglées** : elles forment l'ossature, triées par
   heure.
3. **Ordre des logs.**
   - Mettre de côté les types « logables plus tard » : virtuelle, earthcache,
     webcam. La liste est une constante, à calibrer.
   - Sur les autres étapes, comparer la longueur du chemin dans l'ordre des
     `log_id` (L_logs) à celle du meilleur chemin géographique (L_geo :
     plus proche voisin + 2-opt, `orderStops` de `travel_trail.mjs`).
   - Si L_logs ≤ 1,3 × L_geo (seuil à calibrer, au moins 4 étapes), l'ordre
     des logs est **digne de confiance** et sert d'ossature (`logged`).
     Sinon, la géographie décide (`geo`).
4. **Intrus.** Dans une ossature `logged`, retirer itérativement l'étape dont
   le retrait raccourcit le plus le chemin, tant que le gain dépasse un seuil
   (max(0,5 km, 20 % du chemin), à calibrer). C'est le log tardif de n'importe
   quel type.
5. **Réinsertion** des étapes mises de côté et des intrus, à l'endroit où
   elles allongent le moins le chemin, sans violer les ancres. C'est
   l'insertion la moins coûteuse d'`orderTimedStops`, à généraliser à une
   ossature quelconque.
6. **Rangs forcés** de l'ajustement manuel appliqués en dernier : ils
   l'emportent sur tout.

### Étape 2 : horaire

- **Fenêtre de journée** : début par défaut 9:00, modifiable par jour.
- **Durée de visite par type** (constantes réglables) :
  - traditionnelle 10 min, multi 40, mystery 15, letterbox 20 ;
  - earthcache 20, virtuelle 10, Wherigo 45, webcam 5, étape Lab 5 ;
  - event 90, CITO 120, Mega 180.
- **Durée des tronçons** :
  - durée de l'itinéraire si elle est connue (lot 6) ;
  - sinon à pied à 4,5 km/h jusqu'à 1,5 km ;
  - sinon en voiture à 50 km/h × 1,3 (détour), plus 5 min de stationnement.
- **Entre deux ancres**, les durées estimées sont étirées ou comprimées pour
  tomber juste. Avant la première et après la dernière ancre, elles
  s'appliquent telles quelles.
- **Journée trop longue** (fin après 22:00 sans ancre qui le justifie) :
  compression uniforme, et un drapeau dans `diagnostics`.

### Étape 3 : confiance

Chaque heure hérite de la confiance de son étape : `anchored` et `pinned`
sont exactes, `logged` et `geo` sont estimées (« ≈ »). L'option d'affichage
des heures (§ 6) s'en sert.

### Validation sur données réelles

La base de l'utilisateur a des journées mêlant Labs datées et géocaches. Le
banc `tools/parcours_bench.mjs` (Node, lit un export de `/api/parcours/inputs`
sur une plage) fait deux mesures :
- **heures Lab cachées** : masquer la moitié des heures Lab d'une journée,
  reconstruire, mesurer l'écart en minutes et les inversions d'ordre par
  rapport aux heures masquées ;
- **répartition des diagnostics** : part des journées où l'ordre des logs
  est jugé fiable, nombre d'intrus détectés par type.

Ce banc sert à calibrer les seuils de l'étape 1 avant de les figer. Les
mesures vont dans la doc, comme celles du trajet.

## 5. Moteur de lecture (lots 0 et 2)

### Le mode `parcours`

- `app_mode.mjs` : `MODE_PARCOURS = 'parcours'` et un prédicat
  `isParcoursPage()`.
  **Piège** : `isLifecyclePage()` vaut aujourd'hui `appMode() !== MODE_MAIN`
  et engloberait le nouveau mode. Il faut une liste explicite
  (`evolution`, `poses`).
- `blueprints/parcours.py` : `render_app_page('parcours')` et l'API.
- Sélecteur de l'en-tête (`_app_header.html`) et phrase de
  `_mode_switch.html`.
- Clés par page : `statsPanelsKey` / `imagesItemsKey` / `perPage(...)`
  reçoivent `parcours`. Ce sont de nouvelles listes, vides par défaut.

### Contrat du moteur

Sur le modèle de `lifecycle_engine.mjs` (module feuille, le module de page
s'enregistre, `mapgl.js` pilote) : `parcours_engine.mjs`.

```
hasData()                   un parcours reconstruit à jouer
timeline()                  { totalMs, ticks: [{ key, at, kind, day }] } en temps écran
begin(atMs)                 début de lecture ou reprise après un saut
frame(nowMs)                → { appeared: [clés], head: { lon, lat, mode, heading },
                                legProgress, values: { heure, jour, km, caches, … },
                                dayTransition?: { day, progress } }
seek(ms)                    saut (barre de chronologie)
restState()                 état final (carte au repos)
```

L'horloge reste celle de `sampleAppearClock()`. C'est le temps vidéo en
capture image par image, et le temps actif hors pauses en MediaRecorder : les
deux pipelines d'enregistrement fonctionnent sans changement de principe.

### Temps écran

Le temps réel d'un parcours (des heures, des jours) est **compressé** :

| Rythme | Durée d'une étape | Durée d'un tronçon |
|---|---|---|
| **Régulier** (défaut) | Constante (1,2 s) | a·√km, borné [0,4 s ; 3 s] |
| **Proportionnel** | Proportionnelle à la visite | Proportionnelle au trajet, nuits retirées |
| **Durée totale** / **sur la musique** | L'un des deux rythmes, mis à l'échelle | Idem |

Les nuits sont remplacées par une **transition de jour** (§ 7), de durée fixe.

### Réutilisation des modules purs

- **Trait** (`travel_trail.mjs`) : en lui donnant **une étape par « jour »**
  (routage `day`), `buildTrailRoute` / `buildTrailPath` produisent la
  polyligne dans l'ordre reconstruit, avec arcs de grands sauts, lissage et
  dépliage de l'antiméridien. `lengthAtDay(i)` devient la longueur à
  l'étape i.
  À adapter :
  - l'arrivée du stylo est calculée aujourd'hui comme `écart en jours ×
    durée d'un jour` ; ici elle vient directement de `timeline().ticks` ;
  - la géométrie d'un tronçon peut venir d'une trace ou d'un itinéraire, pas
    seulement d'un segment droit.
- **Caméra** (`camera_follow.mjs`) : `simulateCameraJourneys(days, …)`
  raisonne déjà sur des groupes de points successifs. Il faut vérifier au
  lot 0 ce qui suppose une durée constante par groupe. Une caméra « tête »
  serrée (zoom rue) est ajoutée, avec dézoom sur les tronçons longs.
- **Flashs, style des points, habillage, panneaux, images** : partagés tels
  quels. Les balises d'infos propres au mode sont `{heure}`, `{jour}`,
  `{jours}`, `{km}`, `{caches}`, `{labs}`.

## 6. Interface de la page

Onglets (les onglets partagés gardent leur gabarit) :

| Onglet | Contenu |
|---|---|
| **Données** | Liste des parcours enregistrés ; créer un parcours (plage de dates, sources : trouvailles, Labs, DNF) ; traces et photos du parcours |
| **Étapes** | Journées repliables, étapes dans l'ordre reconstruit, heure (« ≈ » si estimée), pastille de confiance, raison au survol ; glisser pour réordonner, épingler une heure, exclure, changer le mode du tronçon ; poser une base ou un lieu d'un clic sur la carte |
| **Style**, **Images**, **Stats** | Partagés |
| **Trajet** | Style du trait (partagé), tête par mode de déplacement, itinéraires (§ 9) |
| **Animation** | Rythme, transitions de jours, affichage des heures, caméra |
| **Vidéo** | Partagé |

**Affichage des heures** :
- *aucune* : l'ordre seul ;
- *tranches* : matin, midi, après-midi, soir ;
- *approximatives* : « ≈ 10:40 » pour les estimées, exactes pour les ancres
  (défaut) ;
- *exactes* : sans « ≈ ».

L'onglet Étapes est le seul outil « de gestion » de la page, et il est voulu
minimal : il sert à corriger ce que la reconstruction ne peut pas deviner
(cf. mémoire « pistes visuelles d'abord »).

## 7. Rendu de l'animation

- **Tête** : le géocacheur, pictogramme selon le mode du tronçon (piéton,
  vélo, voiture, avion/bateau sur les arcs). Les icônes `ti-*` doivent
  entrer dans le sous-ensemble (`generate_icons_subset.py`).
- **Arrivée** : la cache apparaît et flashe à l'arrivée de la tête. Les
  flashs existants sont repris.
- **Transition de jour** : assombrissement « nuit », carton « Jour 3 ·
  samedi 12 juillet », retour à la base si elle est posée.
- **Photos** : affichées à l'arrivée sur leur étape, en vignette « carte
  postale » ancrée près du point ou dans un emplacement de panneau. Le
  dessin vidéo réutilise `images_render.mjs` (`drawImagePanel`,
  `fitRect`).
- **Compteurs** : km parcourus, caches du jour, total.
- **Tracé estimé / réel** : le style peut distinguer un tronçon issu d'une
  trace ou d'un itinéraire (plein) d'un tronçon estimé (pointillé). C'est une
  option, désactivée par défaut.

## 8. Photos (lot 4)

Envoi `POST /api/parcours/<id>/photos` (plusieurs fichiers ; plafond à fixer,
§ 13). Pour chaque fichier, dans l'ordre :

1. **Lire l'EXIF** : `DateTimeOriginal`, `OffsetTimeOriginal`, GPS, `Make` et
   `Model` (clé d'appareil).
2. Normaliser (réutilisation d'`image_library`) et créer la vignette.
3. **Rattacher**, avec un résultat qui dépend des données présentes :

| La photo a… | Rattachement |
|---|---|
| Heure + GPS | Étape la plus proche à moins de 150 m le même jour ; sinon, proposition de **lieu** |
| GPS seul | Étape la plus proche, sans heure (photo d'affichage) |
| Heure seule | Proposition par l'heure, une fois l'appareil recalé ; sinon rattachement manuel |
| Rien | Rattachement manuel, affichage seulement |

**Horloge de l'appareil** : décalage par clé d'appareil. Il est déduit
automatiquement quand une photo à GPS tombe sur une ancre sûre (Lab, point
de trace), et il est modifiable. Une photo recalée et rattachée devient une
**ancre**.

Pièges :
- l'EXIF est perdu à la normalisation, d'où l'ordre ci-dessus ;
- les HEIC sont décodés côté serveur (`pillow-heif`) : il faut vérifier que
  l'EXIF des HEIC est bien lu par Pillow ;
- vie privée : les positions EXIF restent en base locale, rien n'est envoyé
  ailleurs.

## 9. Traces GPS (lot 5)

- Import **GPX** (`trk/trkseg/trkpt` avec `time`), plusieurs fichiers par
  parcours, partiels acceptés.
- FIT (Garmin) et chronologie Google sont hors premier jet, à voir selon la
  demande.
- Simplification à l'import (Douglas-Peucker, environ 10 m), en conservant
  les horodatages.
- **Rattachement** d'une étape : passage le plus proche à moins de 100 m
  (réglable). Si la trace passe plusieurs fois, on retient l'affectation
  **croissante** dans le temps qui minimise les distances (programmation
  dynamique sur les étapes du jour). L'heure d'arrivée est le début de
  l'**arrêt** (vitesse < 1 km/h pendant plus de 2 min) le plus proche, sinon
  l'instant du passage le plus proche.
- **Géométrie** : entre deux étapes consécutives rattachées à la même trace,
  le tronçon prend la géométrie de la trace. Les trous restent estimés ou
  routés.

## 10. Itinéraires réels (lot 6)

Option globale, désactivée par défaut. Appels faits **côté serveur**
(`blueprints/parcours.py`), jamais depuis le navigateur.

| Fournisseur | Profils | Conditions |
|---|---|---|
| FOSSGIS (`routing.openstreetmap.de`, OSRM) | voiture, vélo, à pied | Sans clé, au plus 1 requête/s, sans garantie de disponibilité ; ils déconseillent de figer l'URL : elle est modifiable dans les réglages |
| openrouteservice | voiture, vélo, marche, randonnée | Clé gratuite créée par l'utilisateur, 2 000 itinéraires/jour, 40/min |

Fonctionnement :
- **Une requête par suite de tronçons de même mode** : tous les points de
  passage en une fois, donc une poignée de requêtes par journée.
- Limitation du débit côté serveur (file, 1 requête/s pour FOSSGIS).
- **Cache local** (`route_leg_cache`) : la vidéo reste reproductible et
  fonctionne hors ligne une fois l'itinéraire calculé. Un « recalculer »
  manuel vide le cache du parcours.
- **Mode par tronçon** déduit de la distance (à pied jusqu'à 1,5 km, voiture
  au-delà, arc avion/ferry au-delà de 300 km ou en l'absence de route),
  modifiable dans l'onglet Étapes.
- Les **durées** renvoyées alimentent l'horaire (`legHints`) : la
  reconstruction est relancée quand elles arrivent.
- **Repli** sans réseau, en cas de refus ou de quota épuisé : segments droits
  ou arcs, avec un message.
- **Attribution** : « © contributeurs OpenStreetMap » et le fournisseur, dans
  l'onglet et dans les crédits de la vidéo.

## 11. Découpage en lots

Chaque lot : tests unitaires Node pour le pur, pytest pour le serveur, spec
e2e ciblé (`parcours-*.spec.mjs`), doc `docs/parcours.md` tenue à jour.
Suite e2e complète en fin de lot seulement.

### Lot 0 : fondations

- Mode `parcours` : `app_mode.mjs`, avec la correction d'`isLifecyclePage`
  et la vérification de toutes ses branches ; route, en-tête, phrase de mode ;
  clés par page.
- Migration v10 (tables du § 3), `blueprints/parcours.py` : CRUD des
  parcours et `GET /api/parcours/<id>/inputs`.
- `parcours_engine.mjs` (contrat § 5) et `parcours_data.js` (module de page,
  noms exportés uniques `parcoursXxx` : `export *` d'`index.js` écarte en
  silence un nom en double).
- **Essai** : mesurer ce qui, dans `mapgl.js`, suppose un pas de durée
  constante :
  - trait : arrivée du stylo, `nextDayIndex` ;
  - caméra : `simulateCameraJourneys`, `cameraPacingState` ;
  - barre de chronologie, panneaux Stats (`accumulateStatsForDates`), balise
    `{date}`.
  L'essai donne une note de décision dans ce plan (§ 0) et une page qui
  affiche les étapes d'un parcours, dans l'ordre des logs, sans animation.

### Lot 1 : reconstruction

`parcours_reconstruct.mjs` (§ 4), tests unitaires, banc de validation
`tools/parcours_bench.mjs`, calibration des seuils sur la base réelle, et
mesures dans la doc.

### Lot 2 : lecture

Création d'un parcours par plage de dates ; temps écran (§ 5) ; tête, trait
et arrivée des caches ; transitions de jour ; balises d'infos ; affichage des
heures ; enregistrement vidéo (les deux pipelines) ; barre de chronologie en
temps écran.

### Lot 3 : étapes et ajustements

Onglet Étapes, overrides, bases et lieux posés sur la carte. Relance de la
reconstruction à chaque ajustement : elle est pure, il suffit de la
recalculer.

### Lot 4 : photos

§ 8 : import, EXIF, rattachement, recalage d'appareil, affichage dans
l'aperçu et la vidéo.

### Lot 5 : traces GPS

§ 9 : import GPX, rattachement, géométrie réelle, fuseaux (décision sur
`timezonefinder`).

### Lot 6 : itinéraires

§ 10 : fournisseurs, cache, modes par tronçon, durées réinjectées, repli,
attribution.

### Lot 7 : finitions

Caméra serrée et dézooms, cartons de jours soignés, compteurs, tracé estimé
ou réel distingué.

**Parcours suggérés** : détection de séjours (jours consécutifs à plus de
100 km du centre habituel) proposés à la création, par exemple « Croatie,
12-20 juillet 2025 ».

Les lots 4, 5 et 6 sont indépendants : leur ordre peut changer.

## 12. Pièges connus à respecter

- `isLifecyclePage()` englobe tout mode non principal : à corriger au lot 0.
- Ordre d'évaluation des modules : `parcours_engine.mjs` est un module
  feuille, et `parcours_data.js` s'initialise en fin de fichier
  (AGENTS.md › Ordre d'évaluation).
- Traductions : `pkg.t('…')` hors template literal, sans chaînage optionnel ;
  pas de guillemet double ni de `/` non échappé dans une regex (lexer
  pybabel).
- `hidden` + classes `d-*` de Bootstrap : l'élément reste visible.
- Expressions WebGL d'OpenLayers : ni `max` ni `min`.
- E2E : Node 22 ; tout réglage global posé par un spec est remis en sortie ;
  les parcours créés sont supprimés en sortie (`DELETE /api/parcours/<id>`).
- Images : la normalisation retire l'EXIF (§ 8).

## 13. Questions ouvertes

1. **Nom du mode** dans l'en-tête : « Parcours » ? « Mes sorties » ?
   « Voyages » ?
2. **Fuseaux** : `timezonefinder` (automatique, poids à mesurer) ou fuseau
   saisi par jour avec une valeur par défaut ?
3. **Plafond de photos** par parcours, et poids disque acceptable.
4. **Fournisseur d'itinéraires par défaut** à l'activation : FOSSGIS (sans
   clé) ou openrouteservice (clé obligatoire, conditions plus claires pour
   une app distribuée) ?
5. **DNF comme étapes** : activés par défaut ?
6. **FIT et chronologie Google** : à prévoir après le lot 5 ?

## 14. Améliorations : photos dans la lecture (lots 8 à 10)

Ajouté le 2026-11-17. Aujourd'hui (lot 4), une seule mise en page codée en
dur : carte postale de 220 px au-dessus à droite de l'étape, 1,5 s par
photo, fondu. Les photos géolocalisées hors de toute étape ne sont jamais
montrées. But : un affichage **modulable**.

Choix de l'utilisateur (2026-11-17) :
- trois **placements** : près de l'étape, emplacement fixe de l'écran,
  bande de vignettes (pas de plein écran) ;
- photo géolocalisée **hors étape** : l'app **propose d'en faire un lieu**
  (elle n'est pas montrée tant qu'elle n'est rattachée à rien) ;
- **aucune trace** laissée sur la carte après le passage d'une photo ;
- **réglages par photo** : masquer de la vidéo, légende, cadrage.

### 14.1 Réglages d'affichage (préférence globale `parcours_photo_display`)

Préférence globale comme `parcours_playback` (le style des photos se garde
d'un parcours à l'autre), clé séparée : elle a beaucoup de sous-clés, et un
patch partiel de `parcours_playback` fuit déjà d'un spec à l'autre
(AGENTS.md). À ajouter à `resetParcoursSettings` des specs.

| Clé | Valeurs | Défaut |
|---|---|---|
| `layout` | `stop` (près de l'étape), `fixed` (emplacement fixe), `strip` (bande), `none` (pas de photos dans la vidéo) | `stop` |
| `side` | près de l'étape : `auto`, `top-right`, `top-left`, `bottom-right`, `bottom-left` | `auto` (côté le plus dégagé de l'écran) |
| `anchor` | emplacement fixe : les 8 ancres des images (`IMAGE_ANCHORS`) | `top-right` |
| `leader` | trait fin de la photo vers son étape (près de l'étape, emplacement fixe) | `false` |
| `strip_edge` | bande : `bottom`, `top` | `bottom` |
| `strip_reset` | bande : vidée à chaque journée | `false` |
| `size` | grand côté en px CSS, [120, 600] (bande : hauteur de la photo agrandie) | 220 |
| `frame` | `postcard` (bordure blanche, ombre), `polaroid` (marge basse épaisse, la légende s'y écrit), `rounded` (coins arrondis, ombre), `plain` (sans cadre) | `postcard` |
| `tilt` | inclinaison alternée (± 2,5°) | `true` |
| `effect` | `fade`, `slide`, `zoom` (`IMAGE_EFFECTS`, courbes d'`images_render.mjs`) | `fade` |
| `ken_burns` | zoom lent pendant l'affichage | `false` |
| `duration` | secondes par photo, [0,5 ; 6] | 1,5 |
| `max_per_stop` | photos au plus en temps cumulé par étape, au-delà partagé | 4 |
| `caption` | gabarit de légende : `{legende}`, `{etape}`, `{heure}`, `{jour}`, `{date}` ; vide = pas de légende | `{legende}` |

Les trois placements :
- **près de l'étape** : la carte postale actuelle, sur le côté choisi
  (`auto` : celui où l'étape laisse le plus de place), gardée dans l'écran ;
- **emplacement fixe** : un coin ou un bord, à 16 px du cadre (au-dessus de
  l'habillage ? à vérifier avec les zones de titre et de légende) ;
- **bande** : un ruban de vignettes le long d'un bord. La photo courante
  entre en grand juste au-dessus du ruban, puis rejoint sa case en
  vignette à la fin de son temps ; le ruban défile vers la gauche quand il
  est plein. Il reste affiché jusqu'à la fin (ou jusqu'à la journée
  suivante avec `strip_reset`).

### 14.2 Réglages par photo (migration v15)

Colonnes de `parcours_photo` : `hidden` (booléen), `caption` (≤ 200
caractères), `aspect` (`original`, `1:1`, `4:3`, `3:4`, `16:9`),
`focus_x` / `focus_y` (0-100, point focal), `zoom` (100-300 %). `PATCH
/api/parcours/<id>/photos/<ph>` les accepte en plus de `stopKey`.

- **Masquée** : reste un indice (rattachement, ancre d'heure), mais n'est
  ni dessinée ni comptée dans le temps d'écran de l'étape.
- **Cadrage** : rectangle source pur (`photoCropRect(natural, réglages)`),
  fenêtre de 1/zoom de l'image aux proportions demandées, centrée sur le
  point focal et bornée à l'image. Sélecteur de point focal sur l'aperçu,
  comme l'onglet Images.

### 14.3 Photos hors étapes : lieux proposés

Une photo géolocalisée sans étape à moins de 150 m n'est rattachée à rien.
`suggestPhotoPlaces` (pur) regroupe ces photos par journée et par proximité
(150 m) : position moyenne, date, heure la plus tôt si elle est de
confiance, photos concernées. La carte Photos affiche « N photos hors des
étapes » avec, pour chaque groupe, « Créer un lieu ici » : le formulaire de
lieu s'ouvre prérempli (coordonnées, journée, heure). Une fois le lieu
créé, les photos s'y rattachent seules (150 m). Rien n'est stocké pour une
proposition ignorée.

### 14.4 Onglet « Photos » de la page

L'onglet Données est déjà long. Les photos prennent un onglet principal à
elles, à la place de l'onglet Images masqué sur `/parcours` : bibliothèque
(déplacée depuis Données), appareils, détail d'une photo (étape, légende,
masquer, cadrage), lieux proposés, réglages d'affichage.

### 14.5 Code

- `parcours_photo_layout.mjs` (pur, testé sous Node) :
  `normalizePhotoDisplay`, `photoCropRect`, `photoFrameAt(timeline, qf,
  réglages, { width, height, stopPixel })` → liste de dessins (photo,
  rectangle, rotation, alpha, transformée d'effet, légende, trait vers
  l'étape, vignettes de la bande).
- `parcours_photo_draw.mjs` : dessin des cadres sur un contexte 2D (sans
  DOM), appelé par le `postrender` de la couche de la tête comme
  aujourd'hui : la vidéo n'a rien à changer.
- `parcours_photos.mjs` : `photosByStop` écarte les photos masquées ;
  `suggestPhotoPlaces`.
- `parcours_timeline.mjs` : `photoQ` et `maxPhotosPerStop` viennent des
  réglages (`duration`, `max_per_stop`).
- Relevé e2e : `getParcoursSnapshot().photoFrame` (dessins du quantum
  courant).

### 14.6 Lots

- **Lot 8** : réglages par photo (migration v15, API, pytest), onglet
  Photos, détail d'une photo (masquer, légende, cadrage), `photosByStop`
  sans les masquées. Unitaires + `parcours-photos.spec.mjs` adapté.
- **Lot 9** : `parcours_photo_layout.mjs` + `parcours_photo_draw.mjs`,
  préférence `parcours_photo_display` (serveur + client), les trois
  placements, cadres, effets, légendes, durée. Unitaires (mise en page,
  recadrage) + spec `parcours-photo-display.spec.mjs` (un relevé par
  placement, export image du canevas).
- **Lot 10** : lieux proposés (`suggestPhotoPlaces`, carte, formulaire
  prérempli). Unitaires + spec.

## 15. Compléter un parcours depuis geocaching.com (lots 11 à 15)

Ajouté le 2026-11-21. **Rien n'est codé.**

Aujourd'hui, les étapes viennent du My Finds (position, type, D/T, date),
des Labs et des DNF de la carte « Mes logs ». Les manques qui pèsent sur
le Parcours :
- le **PF donné** n'est dans aucun GPX ;
- le **parking** n'est connu que si l'utilisateur pose un lieu à la main ;
- un **DNF de mystery** est placé à ses coordonnées publiées, jusqu'à 3 km
  du vrai lieu, tant que la fiche lue par le favori n'a pas ses corrigées.
  Or la reconstruction est géométrique (ordre des logs jugé sur la longueur
  du chemin, intrus, insertion au moindre détour), comme les itinéraires et
  la caméra : une seule étape mal placée peut fausser l'ordre de toute la
  journée.

Les **trouvailles**, elles, sont déjà bien placées quand les coordonnées
ont été corrigées sur le site : le My Finds porte les corrigées
(constaté par l'utilisateur le 2026-11-21, question 1 du § 15.8). Une
mystery jamais corrigée sur le site reste à sa position publiée dans le
GPX comme sur la fiche : la collecte n'y peut rien, seul le déplacement à
la main (lot 15) la corrige.

Choix de l'utilisateur (2026-11-21) : passer par le favori « Mes logs »
existant, et **ne collecter que les caches du parcours en cours**. Jamais
toute la base : à deux requêtes par cache et 800 ms entre deux requêtes
(`LOGS_DELAY_MS`), soit ~1,6 s par cache, relire 19 591 trouvailles
prendrait ~9 h. Un week-end de 100 caches prend ~3 min, une journée power
trail de 300 caches ~8 min.

### 15.1 Ce qui existe déjà

- `parseCachePage` (logs_collect_core.js) lit sur la fiche les coordonnées
  corrigées (`mapLatLng.isUserDefined`, les publiées dans
  `oldLatLngDisplay`), le total de PF et l'état ; `normalizeLogbookEntry`
  lit le PF donné par log (`FavoritePointUsed`).
- Le contrat `mygcflow-logs` v1 porte `caches[].corrected`,
  `favorite_points`, `status` et `logs[].favorite` ; `cache_ref` les stocke
  (`corrected_latitude/longitude`, `favorite_points`, `status`) et
  `log_event.favorite` aussi.
- Mais :
  - le favori ne lit que les caches de « Vos journaux » (DNF) et de « Vos
    caches » ;
  - `parcours_dataset._dnf_stops` et `dnf_geojson.py` prennent
    `cache_ref.latitude`, jamais `corrected_latitude` ;
  - `_find_stops` ne lit que `geocache`.
- Base réelle (2026-11-21) : 515 fiches `cache_ref`, dont 59 mystery, et
  **0** coordonnée corrigée. **Cause trouvée** sur une fiche réelle
  (GCABGFQ) : la page ne fusionne plus les corrigées dans `mapLatLng` côté
  serveur. `mapLatLng` porte déjà les corrigées, sans `isUserDefined` ni
  `oldLatLngDisplay`, et l'information vit dans `window.userDefinedCoords`
  (`newLatLng`, `oldLatLng` en décimal, `oldLatLngDisplay`). Le favori
  rangeait donc les corrigées comme publiées. **Corrigé le 2026-11-21**
  (`userDefinedCoords` dans logs_collect_core.js, l'ancienne forme reste
  lue ; tests `tests/js/logs_collect_core.test.mjs`). Les fiches déjà
  importées gardent l'erreur jusqu'à leur prochaine relecture : une
  collecte complète (« Forcer une collecte complète ») les remet d'aplomb,
  la fusion mettant à jour `latitude` et `corrected` champ par champ.

### 15.2 Données retenues

| Donnée | Source | Usage dans le Parcours | Lot |
|---|---|---|---|
| Coordonnées corrigées | fiche (`window.userDefinedCoords`) | position des étapes DNF (reconstruction, itinéraires, caméra, rattachement des photos) ; pastille « corrigées » des trouvailles | 11, 12 |
| PF donné | carnet, mes logs (`FavoritePointUsed`) | marque et effet à l'arrivée, balise `{pf}` | 13 |
| Total de PF | fiche (`.favorite-value`) | bulle de l'étape, carte d'arrivée | 13 |
| Nombre de trouvailles | fiche (compteurs de logs, sélecteur à relever) | idem | 13 |
| Waypoint parking | fiche (tableau des waypoints) | lieu `parking` proposé, trajet voiture puis marche | 14 |

Écartés :
- l'**heure des logs** : le carnet ne donne que la date (`Visited`). À
  reconfirmer sur la ligne « Champs d'un log du carnet » de la console ;
- le **texte des logs** : le contrat ne le lit jamais (et il est déjà dans
  le My Finds) ;
- les **photos des logs** : téléchargement lourd, EXIF probablement retiré
  par le site. À revoir à la demande.

Le total de PF et le nombre de trouvailles valent **à la date de la
collecte**, pas à celle du passage : à dire dans la bulle (« 87 PF
aujourd'hui »), jamais à présenter comme l'état d'alors.

Le rang « ma Nᵉ trouvaille » ne demande aucune collecte : il se calcule
sur le My Finds.

### 15.3 Demande de collecte liée au parcours

Le favori reste unique (un seul lien, un seul jeton). Ce qui change, c'est
ce que lui répond `GET /api/logs/receive/state`.

**Côté page Parcours** (onglet Données, nouvelle carte « Compléter depuis
geocaching.com ») :
- elle affiche le nombre de caches concernées et l'estimation de durée
  (2 × 800 ms par cache) ;
- le choix par défaut est « caches jamais lues » (pas de fiche `cache_ref`
  issue du favori) ; « Tout relire » sert après une correction de
  coordonnées faite sur le site ;
- bouton « Préparer la collecte » → `POST
  /api/parcours/<id>/collect-request`.

**Côté serveur** :
- la demande est enregistrée dans un fichier `logs_collect_request.json`
  du répertoire de données : `{id, parcours_id, label, codes,
  created_at}`. C'est un état d'exécution, pas une préférence : rien dans
  `settings.json`. Une seule demande à la fois (la suivante remplace la
  précédente), durée de vie de 24 h ;
- les codes retenus sont ceux des étapes `find` et `dnf` de la plage du
  parcours, exclues comprises (elles peuvent être réintégrées). Les Labs
  et les lieux n'ont pas de fiche sur le site ;
- plafond `MAX_COLLECT_CODES` = 1 000 (~27 min). Au-delà, refus avec un
  message, pas de troncature silencieuse ;
- `/receive/state` renvoie `request: {id, label, codes}` en plus de ses
  champs actuels.

**Côté favori** (logs_bookmarklet.src.js, logs_collect_core.js) :
- avec une `request`, le favori l'annonce dans son bandeau (« Parcours
  « Croatie 2025 » : 143 caches, ≈ 4 min ») et ne lit **que** ces codes,
  en ignorant `scope` et `since` : ni « Vos journaux », ni « Vos caches » ;
- file : `/geocache/<code>`, carnet filtré sur mes logs (`ownOnly`, une
  page de carnet) ;
- **aucune couverture déclarée** : l'import ajoute et met à jour sans
  jamais rien retirer, et l'horizon DNF (`dnf_covered_at`) ne bouge pas ;
- reprise : le plan dans `localStorage` porte l'id de la demande. Un plan
  d'une autre demande, ou d'une collecte ordinaire, n'est pas repris ;
- l'envoi final (`/receive/fragment`, `X-MyGCFlow-Final: 1`) porte
  `X-MyGCFlow-Request: <id>`. Le serveur range l'id dans le manifest de
  l'aperçu (`request_id`, `parcours_id`) et efface la demande. L'id passe
  par un en-tête et pas par le document : le contrat ne doit rien dire de
  l'outil qui l'a produit.

**Retour dans la page Parcours** :
- la carte suit `/api/logs/status` (relevé de 4 s, comme « Mes logs »,
  seulement quand l'onglet Données est actif) : `collection_in_progress`
  pendant la collecte, puis `pending_import` ;
- l'aperçu s'ouvre **sur la page Parcours**, dans la même fenêtre que celle
  de « Mes logs ». À extraire : le balisage de `#gcLogsPreviewModal` passe
  dans un gabarit partagé (`_logs_preview_modal.html`) et le code
  d'aperçu et de validation de gc_logs.js dans `logs_preview.js`, sans
  dépendance à la carte de l'onglet Données. Dépendances de gc_logs.js à
  vérifier au début du lot ;
- le bilan de l'aperçu gagne des compteurs propres à cet usage (`_plan`
  de log_store) : fiches ajoutées ou mises à jour, **coordonnées corrigées
  nouvelles ou changées**, PF donnés ;
- après validation, la page recharge les entrées du parcours ; la
  reconstruction, pure, est relancée.

**Ce que la demande ne fait pas** :
- elle ne déclenche rien sur geocaching.com : l'utilisateur ouvre le site
  et clique le favori, comme aujourd'hui ;
- si le favori n'est pas installé, la carte propose le lien à glisser
  (`GET /api/logs/bookmarklet`), sans renvoyer vers la page principale.

### 15.4 Positions dans le Parcours

`parcours_dataset` lit `cache_ref` pour **toutes** les étapes à code GC :

| Étape | Ordre de priorité de la position |
|---|---|
| `find` | My Finds (`geocache`), qui porte déjà les corrigées ; `cache_ref` ne sert qu'à savoir qu'elles le sont (`posSource`) |
| `dnf` | corrigées → correction manuelle ou fiche (`cache_ref.latitude`) → My Finds |

- Chaque étape porte `posSource` (`corrected`, `published`, `manual`) et,
  quand elle est déplacée, `published: {lon, lat}`. La liste des étapes
  affiche une pastille « coordonnées corrigées ».
- Les clés d'étape ne changent pas : rangs forcés, heures épinglées et
  exclusions survivent. Le cache d'itinéraires étant indexé par
  coordonnées, les trajets touchés sont redemandés d'eux-mêmes. Les photos
  rattachées automatiquement (150 m) peuvent changer d'étape ; les
  rattachements manuels restent.
- Des fiches `cache_ref` de **trouvailles** apparaissent dans la base.
  Lecteurs actuels : `dnf_geojson.py` (codes DNF seulement),
  `poses_dataset._owned_refs` (propriétaire = moi, ou pseudo du compte),
  `log_store`, l'export. Aucun ne doit changer de comportement : un test
  par lecteur le vérifie.
- Hors périmètre : les coordonnées corrigées sur la **carte principale**
  (trouvailles, zones, Stats). C'est une décision à part (question 2,
  § 15.8).

### 15.5 Exploitation visuelle (lot 13)

- **PF donné** : marque discrète sur la pastille de l'étape (cœur), effet
  propre à l'arrivée pendant la lecture et dans la vidéo (réglage du style
  du parcours, désactivable), balise `{pf}` (cumul des PF donnés depuis
  le début du parcours). Source : `log_event.favorite` du log de
  trouvaille de l'étape.
- **Total de PF et nombre de trouvailles** dans la bulle de l'étape, avec
  la date de collecte. Nouvelles balises seulement si un usage dans la
  vidéo se dessine.
- **Contrat** : `caches[].found_count` (entier, total des logs de
  trouvaille à la date d'export), champ facultatif. Les champs inconnus
  étant ignorés, on reste en v1. Colonne `cache_ref.found_count`
  (migration).

### 15.6 Parkings (lot 14)

- **Contrat** : `caches[].waypoints`, liste facultative de `{kind, name,
  latitude, longitude}`. Seul `kind: "parking"` est retenu au premier jet.
  Les étapes de multi ne disent pas l'ordre de passage, et les waypoints
  cachés n'ont pas de coordonnées.
- **Stockage** : table `cache_waypoint` (`collection_id`, `gc_code`,
  `kind`, `name`, coordonnées), remplacée en bloc pour une cache à chaque
  import de sa fiche.
- **Parcours** : proposition de lieux comme pour les photos (§ 14.3) :
  « 3 parkings connus pour cette journée », « Créer le lieu » avec la
  catégorie `parking` déjà prérempli. Rien n'est créé sans action de
  l'utilisateur, et rien n'est stocké pour une proposition ignorée.
- Le trajet voiture jusqu'au parking puis à pied vient de ce qui existe :
  le lieu est une étape, son mode de tronçon se règle (`legMode`).

### 15.7 Déplacer une étape à la main (lot 15, facultatif)

Beaucoup de mystery et de multis résolues n'ont jamais eu leurs
coordonnées corrigées sur le site. Glisser une étape sur la carte (comme
un lieu, `parcours-map-actions`) pose une position dans
`parcours_override` (`lon`, `lat` : migration). Elle prime sur tout le
reste (`posSource: 'manual'`) et passe par l'historique Annuler /
Rétablir des ajustements.

### 15.8 Questions ouvertes

1. ~~**Le My Finds contient-il déjà les coordonnées corrigées ?**~~
   **Oui** (constaté par l'utilisateur le 2026-11-21) : corrigées sur le
   site, corrigées dans le GPX ; pas corrigées sur le site, pas corrigées
   dans le GPX. Le lot 12 n'apporte donc rien aux positions des
   trouvailles : son intérêt tient aux PF, aux compteurs, aux parkings et
   aux DNF.
2. **Carte principale** : utiliser aussi les coordonnées corrigées pour les
   trouvailles (points, zones, Stats) ? Elles n'existeraient que pour les
   caches d'un parcours complété, d'où un rendu inégal.
3. **Durée de vie de la demande** : 24 h suffit-il ? Une collecte
   interrompue se reprend par le plan du favori, mais la demande doit
   encore exister au scellement.

### 15.9 Lots

- **Lot 11 : positions déjà connues.** Détection des coordonnées
  corrigées : faite le 2026-11-21 (voir § 15.1). Reste : `corrected_latitude` lu par `_dnf_stops` et `_find_stops`, `posSource`
  et `published` servis, pastille dans la liste. Même correction dans
  `dnf_geojson.py` (position d'un DNF de mystery sur la carte
  principale). pytest + unitaires.
- **Lot 12 : collecte du parcours.** Demande (route, fichier, plafond),
  `request` dans `/receive/state`, mode « demande » du favori (file,
  bandeau, reprise, en-tête final), `request_id` dans le manifest. Aperçu
  partagé (`_logs_preview_modal.html`, `logs_preview.js`), carte « Compléter
  depuis geocaching.com », compteurs du bilan, rechargement des entrées.
  pytest (demande, état, scellement, absence de couverture, horizon DNF
  inchangé, lecteurs de `cache_ref`) + test de la chaîne monoligne du
  favori + `parcours-gc-collect.spec.mjs` (export simulé envoyé à
  `/receive/fragment` avec l'en-tête, aperçu, validation, étape déplacée).
  Logs vidés en entrée et en sortie (`POST /api/logs/clear`).
- **Lot 13 : PF et compteurs.** `found_count` (contrat, log_formats,
  migration, favori), marque et effet PF, balise `{pf}`, bulle. Unitaires
  + spec (relevé `stopStyles` étendu).
- **Lot 14 : parkings.** `waypoints` (contrat, favori, table), proposition
  de lieux. pytest + spec.
- **Lot 15 : déplacer une étape** (facultatif) : seul recours pour une
  mystery résolue mais jamais corrigée sur le site (question 1).

Les lots 13 et 14 dépendent du 12 ; le 11 et le 15 sont indépendants.
Doc : docs/parcours.md (section « Compléter depuis geocaching.com ») et
docs/logs-geocaching.md (demande de collecte, champs `found_count` et
`waypoints` du contrat).
