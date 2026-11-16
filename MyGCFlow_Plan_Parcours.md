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
l'onglet Données. Prochaine étape : lot 6 (itinéraires).

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
    déplacement (lot 7) ;
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
