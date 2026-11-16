# Page Parcours

La page `/parcours` rejoue une journée ou des vacances **cache par cache**,
dans l'ordre de passage, avec la progression des heures et des jours. C'est
le quatrième mode de l'application, à côté de « Mes Géocaches » (`/`),
« Évolution » (`/evolution`) et « Mes poses » (`/poses`), atteint par le
lien `#linkParcoursMode` de l'en-tête.

Plan, choix produit et découpage : `MyGCFlow_Plan_Parcours.md`. État au
2026-11-16 : **lot 0** (fondations) — parcours enregistrés et affichage
statique des étapes dans un ordre provisoire. Ni reconstruction ni animation.

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
| `static/js/parcours_model.mjs` | Pur : ordre provisoire (`provisionalDayOrder`), numérotation (`orderParcours`), emprise. Tests : `tests/js/parcours_model.test.mjs` |
| `static/js/parcours_data.js` | Module de page : liste, création, suppression, étapes, couche carte |
| `templates/menu_data_parcours.html` | Onglet Données |

**Ordre provisoire** (lot 0) : étapes à log par `logId`, puis étapes Lab à
leur heure, puis le reste ; la clé départage. La reconstruction du lot 1 le
remplacera sans changer la forme d'`orderParcours`.

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

## Tests

- Python : `tests/test_parcours_api.py` (CRUD, validation, entrées, DNF,
  Labs, migration).
- JS : `tests/js/parcours_model.test.mjs`, `tests/js/app_mode.test.mjs`.
- E2E : `tests/e2e/parcours-page.spec.mjs`, fixture
  `tests/e2e/fixtures/my-finds-parcours.gpx` (deux journées, logs saisis dans
  le désordre, compte 4242). Le spec vide logs et parcours en entrée et en
  sortie. Relevé : `window.getParcoursSnapshot()` ; signal
  `window.mygcflowParcoursLoaded` / événement `mygcflow:parcours-loaded`.
