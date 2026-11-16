# Page Parcours

La page `/parcours` rejoue une journée ou des vacances **cache par cache**,
dans l'ordre de passage, avec la progression des heures et des jours. C'est
le quatrième mode de l'application, à côté de « Mes Géocaches » (`/`),
« Évolution » (`/evolution`) et « Mes poses » (`/poses`), atteint par le
lien `#linkParcoursMode` de l'en-tête.

Plan, choix produit et découpage : `MyGCFlow_Plan_Parcours.md`. État au
2026-11-16 : **lots 0 et 1** — parcours enregistrés, ordre de passage et
heures reconstruits, affichés dans l'onglet Données et sur la carte. Pas
encore d'animation (lot 2).

## Parcours enregistrés

Un parcours est une **sélection** : nom (80 caractères au plus), plage de
dates (92 jours au plus, `parcours_store.MAX_DAYS`), sources retenues en
plus des trouvailles (étapes Lab, DNF). Table `parcours` (migration v10).

Principe : on stocke la sélection et, plus tard, les ajustements de
l'utilisateur, **jamais l'ordre ni les heures reconstruits**. Ils sont
recalculés à chaque ouverture : un réimport du GPX ne perd rien, une
amélioration de la reconstruction profite aux anciens parcours.

Les parcours vivent hors de `/clear_database` : vider la base des
trouvailles laisse les parcours, qui se retrouvent simplement vides.

## API (`blueprints/parcours.py`)

| Route | Rôle |
|---|---|
| `GET /parcours` | La page (`render_app_page('parcours')`) |
| `GET /api/parcours` | `{parcours, finds: {first, last}, maxDays}` — `finds` borne le formulaire de création |
| `POST /api/parcours` | Création `{name, date_start, date_end?, include_labs?, include_dnf?}` ; `date_end` absente = une journée |
| `GET` / `PATCH` / `DELETE /api/parcours/<id>` | Lecture, patch (clé absente = inchangée), suppression |
| `GET /api/parcours/<id>/inputs` | Entrées de la reconstruction (ci-dessous) |

Erreurs : `{success: false, error, message}` avec les codes `not-found`,
`name-empty`, `name-too-long`, `date-invalid`, `range-reversed`,
`range-too-long`.

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
| `static/js/parcours_model.mjs` | Pur : utilitaires (étapes du parcours, emprise, jours d'une plage). Tests : `tests/js/parcours_model.test.mjs` |
| `static/js/parcours_data.js` | Module de page : liste, création, suppression, étapes, couche carte |
| `templates/menu_data_parcours.html` | Onglet Données |

Dans l'onglet Données, chaque étape porte son heure d'arrivée (exacte pour
une ancre, « ≈ » sinon) et la raison de sa place ; chaque journée, sa
distance et le verdict sur l'ordre des logs.

**Carte** : couche vectorielle propre (`parcoursLayer`, zIndex 1000), points
numérotés colorés par nature (trouvaille, Lab, DNF) et une ligne pointillée
par jour (la nuit n'est pas un trajet). Rien n'entre dans `pointsByDate`.
Le dernier parcours ouvert est retenu (`localStorage['parcours.lastId']`).

**Onglets** : Données, Style, Préférences. Animation, Stats et Images sont
masqués au lot 0 : leurs volets restent dans la page (ui.js les attend),
sans onglet. Lecture rapide, export et barre de chronologie sont masqués par
CSS (`body[data-mode="parcours"]`).

**Réglages** : `stats.parcours_panels` et `images.parcours_items` existent
déjà (listes par page, vides). La page **n'enregistre pas** les réglages
d'animation (`saveAnimationSettings` sort tout de suite) : le repli de
`perPage` sur la clé `animation` faisait réécrire le rythme de la page
principale au chargement, suivi de caméra remis à `false`.

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
  Labs, migration).
- JS : `tests/js/parcours_reconstruct.test.mjs`,
  `tests/js/parcours_model.test.mjs`, `tests/js/app_mode.test.mjs`.
- E2E : `tests/e2e/parcours-page.spec.mjs`, fixture
  `tests/e2e/fixtures/my-finds-parcours.gpx` (deux journées, compte 4242 :
  ordre des logs retenu le premier jour, earthcache loguée après coup le
  second). Le spec vide logs et parcours en entrée et en
  sortie. Relevé : `window.getParcoursSnapshot()` ; signal
  `window.mygcflowParcoursLoaded` / événement `mygcflow:parcours-loaded`.
