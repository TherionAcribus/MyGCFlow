# Page « Mes poses »

La page `/poses` anime la **vie des caches posées** par le joueur : leur
apparition, les trouvailles, favoris et DNF des autres joueurs, les
signalements, la maintenance, les désactivations et l'archivage. C'est la
troisième page de l'application, à côté de « Mes Géocaches » (`/`) et
« Évolution » (`/evolution`), atteinte par le sélecteur de l'en-tête
(`#linkPosesMode`).

Rien ne s'importe sur cette page : les données sont celles de la carte
« Mes logs » de la page principale (docs/logs-geocaching.md, lots D et E).
Le favori de collecte relit chaque cache posée en entier (tous les logs, tous
les auteurs, point favori par log, couverture `caches` complète).

## Règles de données (`poses_dataset.py`)

**Caches posées** : fiches `cache_ref` dont `owner_id` vaut le compte de la
collection (`log_collection.account_user_id`) ; à défaut d'identifiant, le
pseudo du compte (compté dans `meta.ownerMatchedByName`).

**Types d'événements** (`classify_log`, ordre = code servi au client) :

| Type | Logs |
|---|---|
| `publish` | Publish Listing (24) |
| `find` | Found it / Attended / Webcam (2, 10, 11) d'un **autre** joueur |
| `dnf` | Didn't find it (3) d'un autre joueur |
| `note` | Write note (4) d'un autre joueur |
| `owner_note` | note, trouvaille ou DNF du poseur sur sa propre cache (présence à son event…) — jamais « reçus » |
| `alert` | Needs Maintenance (45), Needs Archived (7) |
| `maintenance` | Owner Maintenance (46), Update Coordinates (47) |
| `disable` / `enable` | 22 / 23 |
| `unarchive` / `archive` | 12 / 5 et Retract (25) |
| `reviewer` | notes du relecteur (18, 68, 76) |
| `other` | le reste (Will Attend, Announcement, types inconnus) |

**Apparition** (choix de l'utilisateur, 2026-10-25) : publication (premier
log 24), sinon date de pose déclarée ; une trouvaille antérieure (bêta-test)
avance l'apparition. Sans publication, pose ni trouvaille : premier log ;
sans rien, la cache n'est pas datable (`meta.undatable`). Sur le compte réel
de l'utilisateur, 13 caches sur 41 apparaissent ainsi par une bêta-trouvaille
(série publiée le 2020-08-29, testée 5 à 8 jours avant).

**Logs antérieurs à l'apparition** (notes avant publication) : ramenés au jour
de l'apparition (`folded`). Ils comptent partout mais ne sont jamais dessinés
et n'agrandissent pas le flash de publication.

**États** : active → désactivée (22) → réactivée (23) ; archivée (5, 25) →
désarchivée (12). Dans une journée, ordre `log_id`, seul le dernier état
compte. Un état final qui contredit le statut de la fiche à l'export
(`cache_ref.status`) ajoute un changement **déduit** à la date de l'export
(`status_at`), sans flash (`meta.inferredStates`).

**Position** : fiche (correction manuelle comprise), sinon ligne du My Finds ;
sans position, la cache est en attente (`meta.pending`), jamais placée.
Quand **aucune** cache posée n'est plaçable (sans position ou sans date), la
charge utile est vide avec `meta.reason = "no-placed-caches"` — les compteurs
`ownedTotal` / `pending` / `undatable` restent servis, à la différence de
`"no-owned-caches"` (aucune cache possédée).
**Pays et région** manquants (le favori ne les collecte pas) : ceux du My
Finds, sinon empruntés à la trouvaille la plus proche à 10 km
(`lab_geojson.compute_borrowed_geo`, drapeau `geoBorrowed`).

**Date de fin** : export le plus récent qui atteste un statut, jamais avant le
dernier événement.

## Affichage

Même moteur que le mode Évolution (« cycle de vie », `lifecycle_engine.mjs`) :
les caches sont ajoutées une fois à la couche de points et le shader décide de
leur visibilité ; plusieurs jours par image ; ni caméra, ni trajet, ni DNF.
Le module de la page (`poses_data.js`) enregistre son moteur ; les règles
pures vivent dans `poses_timeline.mjs` (tests `tests/js/poses_timeline.test.mjs`).

- **États** : attribut `pstate` (0 active, 1 désactivée, 2 archivée), réécrit
  seulement les jours où l'état d'une cache change (`setFeatureState`).
  Vectoriel : la couleur du thème vire au gris (désactivée gris franc,
  archivée gris clair à 55 % d'opacité) ; icônes : la rangée grisée de
  `geocaching-sprite*.png` (y = 152, 304 en @2x ; absente pour Lab et DNF →
  opacité seule) — `applyPosesColors` / `applyPosesOpacity` de
  `point_webgl_style.js`.
- **Archivées** (préférence `poses_archived_display`, onglet Données) :
  `grey` (défaut) — elles restent grisées ; `hide` — elles disparaissent comme
  en Évolution, et réapparaissent à un désarchivage (segments de présence,
  `visibleSegment`).
- **Filtres propres** (onglet Données, après Pays / Région) : « État actuel »,
  la colonne `status` de la charge utile (état à l'export : 0 active,
  1 archivée, 3 désactivée), et « Trouvailles reçues » (au moins une / jamais
  trouvée, comptées sur `ev` dans `findTotals` — les logs « folded » compris).
  Appliqués côté client par `filterPosesRows` après `filterRows` ; non
  persistés, comme les autres filtres des pages « cycle de vie ».
- **Flashs par événement** : un flash par cache et par lot de jours affichés,
  le type le plus marquant l'emporte — archive > désactivation > réactivation
  > publication > signalement > maintenance > première trouvaille > favori >
  trouvaille > DNF > note > relecteur ; seuls les types dont le flash n'est
  pas « aucun » concourent. « Première trouvaille » (`ftf`) est le premier
  log « find » reçu de la cache (drapeau `evFtf` de `buildPosesBase`) ; une
  première trouvaille ramenée au jour d'apparition (« folded ») ne flashe
  pas — la publication joue ce jour-là.
  Sa taille grandit avec le nombre de logs de la cache dans le lot :
  `min(1 + log2(n)/3, 2,5)`, quantifiée au 1/8 (`flashScale`). L'apparition
  joue le flash `publish` (« Comme le flash principal » par défaut). Quand les
  archivées disparaissent, une cache archivée ne flashe plus.
- **Ligne d'infos** (`poses_infos_template`, défaut
  `{date} · {actives} · {trouvailles}`) : `{actives}` (non archivées),
  `{posees}`, `{archivees}` et `{desactivees}` **à la date** (une cache
  désarchivée sort de `{archivees}` : `actives + archivees = posees`, à la
  différence du cumul d'Évolution), `{trouvailles}`, `{favoris}`, `{dnf}`,
  `{logs}` (cumuls reçus), `{trouveurs}` (joueurs distincts), `{total}`.
- **Barre de chronologie** : histogramme des trouvailles reçues par jour, les
  autres logs empilés dessus ; courbe du cumul des trouvailles reçues ;
  jalons « Nᵉ trouvaille reçue » (losange plein), première trouvaille reçue
  de chaque cache (rond bleu) et paliers ronds par cache « Nᵉ trouvaille :
  GCxxxx » (losange creux — pas adaptatif, comme les jalons globaux).
- **Popup** : type, taille, D/T, état au jour affiché, premier trouveur —
  tout est lu côté client dans la charge utile (`base`), sans fetch, pour que
  les comptes trouvailles / favoris / DNF s'arrêtent au jour affiché pendant
  l'animation. Le libellé d'apparition suit `appearSource` : « Publiée le »,
  « Posée le », « Trouvée avant sa publication le », « Premier log le ».

## Thèmes

La page liste les thèmes du **mode principal** (choix de l'utilisateur :
styles très proches de « Mes Géocaches ») et retient son propre dernier thème
(`poses_last_profile_uid` ; à la première visite, celui de Mes Géocaches). Le
thème par défaut est partagé. Les flashs par événement sont un bloc du thème,
`flash.events.<type>` (forme, taille, couleur, contour), sans effet sur les
autres pages : une table unique, `event_flash.py` (types, libellés, défauts,
priorité), copiée dans `static/js/event_flash.mjs` — le test
`tests/js/event_flash.test.mjs` compare les deux via
`tests/fixtures/flash/event_flash_kinds.json`, écrit par
`tests/test_event_flash.py`. Interface : `menu_flash_events.html` (une ligne
par type, générée par boucle), liaison générique `initEventFlashControls`
(ui.js). La durée reste celle du flash principal.

## Stats et Images

**Stats** : liste propre `stats.poses_panels`. Chaque panneau compte une
**source** (`options.source`) : les **trouvailles reçues** par défaut
(`finds`), les **DNF reçus** (`dnf` — même valeur que la page principale,
autre sens : échecs des visiteurs, pas ceux du joueur) ou les **favoris
reçus** (`favorites` — trouvailles reçues portant un point favori ; la
« trouvaille » du poseur sur sa propre cache est une note du poseur, jamais
reçue). Chaque source est servie par `posesStatsFinds(source)` avec les
propriétés des trouvailles du mode principal (date du log en `date_find`,
attributs de la cache, plus `finder` et `favorite`) : le chemin de comptage
du mode principal s'applique tel quel (`findIndexes` de stats_panels.js).
Registre `POSES_METRICS_BY_KIND`, commun aux trois sources : grilles D/T,
mois × année, calendrier, année d'activité ; histogrammes et anneaux par
cache (`cache`, course « caches les plus trouvées »), par trouveur
(`finder`), année, mois, jour de semaine, âge de la cache à la trouvaille,
type, taille, D, T, pays, région ; courbe cumulée ; tuiles
`POSES_COUNTER_ITEMS` pour les trouvailles reçues (trouveurs, favoris,
caches trouvées, jours, record, série, trouvées le jour de publication,
catégories, points extrêmes), `POSES_ALT_COUNTER_ITEMS` pour les DNF reçus
et les favoris reçus — accumulateur seul, aucune tuile « au jour ». Quatre
tuiles « poseur » en plus :
« Part de favoris » (favoris / trouvailles), « Trouveurs fidèles » (au moins
3 trouvailles reçues, détail = trouveur le plus assidu), « Délai moyen avant
la première trouvaille » et « Cache la plus délaissée » — ces deux-là sont lues dans la
chronologie au jour affiché (`posesCounterAtDay`/`posesCounterStats`), pas
dans l'accumulateur : la délaissée est la jamais trouvée la plus anciennement
apparue, sinon la dernière trouvaille la plus ancienne. Configurations
nommées de mode `poses`.

**Images** : liste propre `images.poses_items`. La planification « par
trouvailles » compte les trouvailles reçues (`findDayCounts` du moteur).

## Réglages

| Réglage | Portée | Stockage |
|---|---|---|
| Rythme (défaut : 1 min pour toute la période) | Globale | `poses_animation` |
| Ligne d'informations | Globale | `poses_infos_template` |
| Sort des archivées (`grey` / `hide`) | Globale | `poses_archived_display` |
| Dernier thème | Globale | `poses_last_profile_uid` |
| Panneaux Stats / images | Globale | `stats.poses_panels`, `images.poses_items` |
| Flashs par événement | Thème | `flash.events` |

## API

| Route | Rôle |
|---|---|
| `GET /poses` | page (`app.html`, `data-mode="poses"`) |
| `GET /api/poses/data` | données en colonnes (format de `/api/evolution/.../data` + `st`, `ev`, `authors`, `logKinds`, `meta`), ETag par collection, révision et contenu de `geocache` |
| `GET /api/poses/caches/<code>` | détails d'une cache posée, 404 sinon (totaux à l'export ; la popup ne s'en sert plus — tests et réserve d'enrichissements) |
| `GET /api/poses/export.csv` | téléchargement CSV (`poses_dataset.export_csv`, lien « Exporter en CSV » de l'onglet Données) : **toutes** les caches posées de la collection, en attente et non datables comprises — pas la sélection filtrée. BOM UTF-8, séparateur « ; », une ligne par cache (ordre du code GC) ; colonnes : code, nom, type, taille, D/T, position, pays/région, apparition et sa source, statut, comptes (trouvailles, favoris, DNF, logs), première trouvaille et son auteur, dernier log |

## Tests

- Python : `tests/test_poses_dataset.py` (une règle par test, sur la fixture
  `tests/fixtures/gc_logs/logs-poses.json`, API comprise),
  `tests/test_event_flash.py`, cas `poses_*` de `test_global_preferences.py`
  et `flash.events` de `test_profile_validation.py`.
- Node : `tests/js/poses_timeline.test.mjs`, `tests/js/event_flash.test.mjs`,
  `tests/js/app_mode.test.mjs`.
- Playwright : `tests/e2e/poses.spec.mjs` (état vide, états au repos, mode
  masqué, flashs du moteur jour par jour, aperçu complet),
  `tests/e2e/stats-poses.spec.mjs`. Les logs vivent hors de
  `/clear_database` : chaque spec appelle `POST /api/logs/clear` en entrée et
  en sortie. `getPosesDebugState()` expose états, segments, journal des
  flashs et compteurs.

## Mesures

Export réel (41 caches, 4 755 logs) : charge utile construite en 23 ms
(124 Ko).
