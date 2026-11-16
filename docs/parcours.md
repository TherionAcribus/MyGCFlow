# Page Parcours

La page `/parcours` rejoue une journée ou des vacances **cache par cache**,
dans l'ordre de passage, avec la progression des heures et des jours. C'est
le quatrième mode de l'application, à côté de « Mes Géocaches » (`/`),
« Évolution » (`/evolution`) et « Mes poses » (`/poses`), atteint par le
lien `#linkParcoursMode` de l'en-tête.

Plan, choix produit et découpage : `MyGCFlow_Plan_Parcours.md`. État au
2026-11-16 : **lots 0 à 5** — parcours enregistrés, ordre de passage et
heures reconstruits, lecture et vidéo (géocacheur, trait, heure, distance),
ajustements manuels (ordre, heure épinglée, journée, exclusion, lieux et
bases), photos (rattachement, heure comme ancre, carte postale), traces GPS
(heures de passage, vrai chemin, fuseau).

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
| `POST /api/parcours` | Création `{name, date_start, date_end?, include_labs?, include_dnf?}` ; `date_end` absente = une journée |
| `GET` / `PATCH` / `DELETE /api/parcours/<id>` | Lecture, patch (clé absente = inchangée), suppression |
| `GET /api/parcours/<id>/inputs` | Entrées de la reconstruction (ci-dessous), avec `overrides` et `places` |
| `PATCH /api/parcours/<id>/overrides` | `{overrides: [{key, rank?, pinnedTime?, day?, excluded?}]}` : un champ présent remplace (null efface), un absent est gardé ; tout ou rien ; une étape sans plus d'ajustement perd sa ligne. Renvoie `{overrides, places}` |
| `DELETE /api/parcours/<id>/overrides` | Annule tous les ajustements (les lieux restent) |
| `POST /api/parcours/<id>/places` | Lieu `{kind: place, name, lat, lon, date, time?}` ou base `{kind: base, name, lat, lon, date?}` (base sans date : toutes les journées) |
| `PATCH` / `DELETE /api/parcours/<id>/places/<pid>` | Modification (patch), suppression |
| `POST /api/parcours/<id>/photos` | Envoi d'une photo (multipart, champ `photo`, 15 Mo au plus) ; la même photo deux fois n'est gardée qu'une fois |
| `GET /api/parcours/<id>/photos/<ph>/file` / `thumb` | Photo normalisée / vignette 320 px (cache long, nom = empreinte) |
| `PATCH` / `DELETE /api/parcours/<id>/photos/<ph>` | Rattachement manuel `{stopKey}` (null : automatique) ; suppression (fichiers compris) |
| `PUT /api/parcours/<id>/cameras` | Décalage d'horloge d'un appareil `{camera, offsetMinutes}` (null : l'oublie ; ±2 jours au plus) |
| `POST /api/parcours/<id>/tracks` | Envoi d'une trace GPX (multipart, champ `track`, 30 Mo au plus), simplifiée à l'import |
| `DELETE /api/parcours/<id>/tracks/<tid>` | Suppression d'une trace |
| `PATCH /api/parcours/<id>` `{utc_offset_minutes}` | Heure locale des traces (minutes, −12 h à +14 h ; null : automatique) |

Erreurs : `{success: false, error, message}` avec les codes `not-found`,
`name-empty`, `name-too-long`, `date-invalid`, `range-reversed`,
`range-too-long`, `time-invalid` (« HH:MM » attendu), `day-out-of-range`,
`override-invalid`, `place-invalid`, `place-not-found`, `photo-not-found`,
`photo-invalid`, `photos-full` (300 photos par parcours), `camera-invalid`,
`photo-refused` (fichier refusé : `reason` comme l'onglet Images),
`track-refused` (`reason` : `too_large`, `not_gpx`, `no_time`),
`tracks-full` (50 traces par parcours), `track-not-found`,
`utc-offset-invalid`.

## Entrées (`parcours_dataset.py`)

Un jour par date de la plage, **même vide** (un jour sans cache compte dans
un voyage), chacun avec ses étapes :

| `kind` | Source | Clé | Indices |
|---|---|---|---|
| `find` | `geocache` (My Finds) | code GC | `logId` : plus petit identifiant de log de trouvaille du même jour (`log_event`, compte du joueur) |
| `lab` | `lab_discovery` résolue et datée | `lab:<uuid d'étape>` (sinon `local_uid`) | `localTime` : heure locale réelle (`lab_geojson.found_local_time`) |
| `dnf` | `log_event` (DNF du joueur) | `dnf:<log_id>` | `logId` ; position de la fiche `cache_ref`, sinon du My Finds |

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
| `static/js/parcours_timeline.mjs` | Pur : temps écran (quanta), position du géocacheur, heure et distance affichées. Tests : `tests/js/parcours_timeline.test.mjs` |
| `static/js/parcours_model.mjs` | Pur : utilitaires (étapes du parcours, emprise, jours d'une plage). Tests : `tests/js/parcours_model.test.mjs` |
| `static/js/parcours_data.js` | Module de page : liste, création, suppression, étapes, plan, moteur de lecture, tête et trait |
| `templates/menu_data_parcours.html` | Onglet Données |

Dans l'onglet Données, chaque étape porte son heure d'arrivée (exacte pour
une ancre, « ≈ » sinon) et la raison de sa place ; chaque journée, sa
distance et le verdict sur l'ordre des logs.

**Plan au repos** : couche vectorielle propre (`parcoursLayer`, zIndex 1060,
au-dessus des points WebGL pour garder les numéros lisibles), points
numérotés colorés par nature (trouvaille, Lab, DNF) et une ligne pointillée
par jour (la nuit n'est pas un trajet). Masqué pendant la lecture. Rien
n'entre dans `pointsByDate`. Le dernier parcours ouvert est retenu
(`localStorage['parcours.lastId']`) et cadré (zoom 16 au plus).

**Onglets** : Données, Style, Animation & vidéo, Préférences. Stats et
Images ne sont pas encore branchés : leurs volets restent dans la page
(ui.js les attend), sans onglet. La barre de chronologie, la plage de dates
et le champ « jours par seconde » de l'onglet Animation sont masqués par CSS
(`body[data-mode="parcours"]`).

## Lecture et vidéo (`parcours_timeline.mjs`, `parcours_data.js`)

La page passe par le moteur « cycle de vie » d'Évolution et de Mes poses
(`isLifecyclePage()` est vrai sur `/parcours`, `lifecycle_engine.mjs`).
Un « jour » du moteur y est un **quantum de temps écran** : 100 ms à la
vitesse naturelle, 10 quanta par seconde.
- Chaque étape est une feature WebGL dont `placedDay` est le quantum de son
  arrivée : le shader la fait apparaître, `mapgl.js` joue le flash.
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
compose tous les canevas de la carte, les filme. Leur couleur et leur
épaisseur sont celles du thème (`trail.color`, `trail.width`).

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
- compteurs animés `{etapes}`, `{caches}`, `{labs}`, et `{total}`.

Deux crochets optionnels ont été ajoutés au contrat du moteur :
- `infosValues(now)` : valeurs texte qui priment sur les compteurs et sur la
  date du moteur ;
- `frameActive(now)` : entretient le rendu entre deux quanta.

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
| `parcours_playback` | `{pace: regular / proportional, hours: approx / exact / slots / none}` |
| `parcours_last_profile_uid` | Dernier thème de la page (thèmes du mode principal ; première visite : celui de la page principale) |
| `stats.parcours_panels`, `images.parcours_items` | Listes par page, vides tant que les onglets ne sont pas branchés |

Limites actuelles :
- pas de caméra qui suit (lot 7), pas de carton ni d'assombrissement de
  nuit ;
- trajets en lignes droites (itinéraires : lot 6) ;
- un DNF apparaît comme une cache de son type.

## Ajustements manuels (lot 3)

Dans l'onglet Données :
- **les flèches** d'une étape et **le glisser-déposer** dans sa journée
  fixent l'ordre de la journée : un rang pour chacune de ses étapes ;
- **un clic sur une étape** ouvre son panneau : heure épinglée (« Épingler »
  / « Retirer »), journée (logs datés du mauvais jour), « Exclure du
  parcours » ;
- **« Poser un lieu ou une base sur la carte »** attend un clic sur la carte
  (Échap annule), puis un petit formulaire : type, nom, journée, heure
  facultative.

Ce que la reconstruction en fait (`applyAdjustments`, puis
`reconstructDay`) :

| Ajustement | Effet |
|---|---|
| `rank` | Les étapes classées gardent l'ordre choisi, les autres s'y insèrent au moindre détour ; il prime sur tout, y compris sur l'heure des ancres. Raison `manual`, confiance `manual` (ordre sûr, heure estimée). La journée porte `manual` : badge « ordre manuel » et « Ordre automatique », qui efface les rangs de la journée |
| `pinnedTime` | Ancre exacte, raison `pinned` |
| `day` | L'étape passe à une autre journée de la plage (`movedFrom` garde la date d'origine, « déplacée du… ») ; son rang est effacé |
| `excluded` | L'étape sort du parcours, de la chronologie et des comptes ; listée barrée en fin de journée, « Réintégrer » |
| lieu (`place`) | Une étape de plus dans sa journée, à son heure si elle en a une (raison `pinned`), sinon au moindre détour ; visite de 30 min ; jamais comptée (`index` null, `{etapes}`, résumé) |
| base (`base`) | Départ et retour de chaque journée qui a des étapes (clés `place:<id>:<date>:start` / `:end`, visite 0) ; une base datée prime sur une base « toutes les journées » ; elle oriente l'ordre géographique de la journée |

Pendant la lecture, lieux et bases n'ont pas de point WebGL. Ils sont
dessinés par la couche de la tête : les bases toujours, les lieux une fois
atteints. Au repos, le plan les montre (carré sombre, étoile violette). Une
base dure 4 quanta à l'écran. Les ajustements sont refusés pendant une
lecture (« Arrêtez la lecture… »).

## Photos (lot 4 : `parcours_photos.py`, `parcours_photos.mjs`)

**À l'envoi**, dans cet ordre :
1. l'EXIF est lu : heure murale de l'appareil (`DateTimeOriginal`),
   `OffsetTimeOriginal`, GPS, marque et modèle ;
2. l'image est normalisée comme dans l'onglet Images (redressée, 2048 px,
   HEIC décodé — **l'EXIF disparaît du fichier gardé**, position comprise) ;
3. une vignette de 320 px est tirée ;
4. le tout est rangé dans `parcours_photos/<parcours>/` du dossier de
   données. Supprimer le parcours supprime le dossier.

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
- les photos sont préchargées à l'ouverture : une photo encore en
  chargement n'est simplement pas dessinée.

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
  qui garde une pause, envoi, refus, décalage UTC) ; préférences de la page
  dans `tests/test_global_preferences.py`
  (`test_parcours_preferences_have_their_own_keys`).
- JS : `tests/js/parcours_reconstruct.test.mjs`,
  `tests/js/parcours_timeline.test.mjs`, `tests/js/parcours_photos.test.mjs`,
  `tests/js/parcours_tracks.test.mjs`, `tests/js/parcours_model.test.mjs`,
  `tests/js/app_mode.test.mjs`.
- E2E : `tests/e2e/parcours-page.spec.mjs` (lots 0 à 2),
  `tests/e2e/parcours-adjust.spec.mjs` (lot 3),
  `tests/e2e/parcours-photos.spec.mjs` (lot 4, photos de
  `tests/e2e/fixtures/parcours-photos/`, générées par `photo_bytes` de
  test_parcours_photos.py) et `tests/e2e/parcours-tracks.spec.mjs` (lot 5,
  trace `tests/e2e/fixtures/parcours-trace.gpx` — `*.gpx` est ignoré :
  `git add -f`), aides communes dans
  `tests/e2e/parcours-helpers.mjs`. Fixture
  `tests/e2e/fixtures/my-finds-parcours.gpx` (deux journées, compte 4242 :
  ordre des logs retenu le premier jour, earthcache loguée après coup le
  second).
  - Nettoyage (`cleanUp`) : logs, parcours (et donc leurs ajustements et
    lieux), `parcours_animation` (10 quanta/s) et `parcours_playback`.
  - Lecture complète, et export vidéo dans les deux pipelines (durée
    contrôlée par `video_validator.py`, MP4 supprimé ensuite).
  - Ajustements : flèches, glisser-déposer (`dragTo`), persistance,
    heure, journée, exclusion, annulation, base posée d'un clic sur la carte.
  - Relevé : `window.getParcoursSnapshot()` (`timeline`, `running`,
    `currentQ`, `head`, `infos`, `playLayers`, `overrides`, `places`,
    `days[].manual` / `excluded`, `adjustmentRevision` — à attendre après
    un ajustement) ; signal `window.mygcflowParcoursLoaded` / événement
    `mygcflow:parcours-loaded`.
