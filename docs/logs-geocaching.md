# Logs Geocaching — contrat d'import, stockage et plan

> **Statut : lots A à E codés** (2026-10-25) — D et E réunis dans la page
> « Mes poses » (`/poses`, docs/mode-poses.md) ; caches posées et étapes du
> poseur aussi sur la carte principale (2026-10-26, § Caches posées sur la
> carte principale). A — données :
> `log_formats.py` (lecture), `log_store.py` (fusion, aperçu, statut),
> migration v8, logs du My Finds. B — interface : carte « Mes logs » de
> l'onglet Données (`static/js/gc_logs.js`) et routes `/api/logs/*`
> (`blueprints/gc_logs.py`). C — DNF sur la carte (§ Affichage des DNF).
> Spécification rédigée le 2026-10-24 sur `main` à `bb69772`.

## Pourquoi

Le GPX « My Finds » ne décrit que les caches trouvées, et l'app n'en garde
qu'une date (`geocache.date_find`, dernier « Found it »). Trois usages
demandent davantage :

1. **DNF** — afficher ses échecs, et les compter dans les Stats ;
2. **activité de poseur** — pose, maintenance, désactivation, archivage… ;
3. **mode « Mes caches »** — la pose de ses caches puis le passage des autres
   (trouvailles, DNF, points favoris), à la place de son propre parcours.

Les trois reposent sur le même objet : **un log** (une cache, un auteur, un
type, une date). D'où une table d'événements unique, alimentée par des
fichiers.

## Principe : l'app importe, elle ne collecte pas

MyGCFlow n'accède pas à geocaching.com depuis le serveur : ni scraper, ni
cookies, ni identifiants. Elle importe le contrat neutre
**`mygcflow-logs` v1** (ci-dessous) et les **logs Groundspeak d'un GPX**
(`<groundspeak:log>` : My Finds, Pocket Query, export GSAK).

Deux voies produisent le fichier `mygcflow-logs` :

- le **favori intégré** (carte « Mes logs », même mécanique que celui des
  Lab Caches) : un lien `javascript:` à glisser dans la barre de favoris,
  à cliquer depuis une page de geocaching.com. Il relit dans la session du
  navigateur les mêmes pages qu'une consultation manuelle (listes de DNF,
  caches posées, carnets), avec les mêmes cadences, puis envoie le
  document à l'app — où il arrive comme un **import en attente**, validé
  par l'aperçu avant tout écriture ;
- l'**outil console** `tools/gc_logs_exporter/export_gc_logs.js` (usage
  développeur), dont le moteur a été porté dans le cœur partagé du favori
  (`static/logs/logs_collect_core.js`).

Le contrat ne suppose rien de l'outil qui l'a produit : aucun champ
spécifique à une méthode de collecte. Les conditions d'utilisation de
geocaching.com restreignent la collecte automatisée ; le favori est un
outil à la demande, lancé à la main par l'utilisateur dans son propre
navigateur — la décision d'usage lui appartient.

## Format `mygcflow-logs` v1

Un document JSON (UTF-8, BOM toléré). Exemple complet :

```json
{
  "format": "mygcflow-logs",
  "schema_version": 1,
  "exported_at": "2026-10-24T09:12:00Z",
  "generator": { "name": "mon-outil", "version": "1.2" },
  "account": { "user_id": 1234567, "username": "MonPseudo" },
  "coverage": [
    { "kind": "author", "author_id": 1234567, "type_ids": [3], "complete": true },
    { "kind": "caches", "gc_codes": ["GC1ABCD"], "since": "2026-01-01", "complete": true }
  ],
  "caches": [
    {
      "gc_code": "GC1ABCD",
      "name": "Le vieux lavoir",
      "type": "Traditional Cache",
      "latitude": 49.2672,
      "longitude": 6.259767,
      "difficulty": 2.0,
      "terrain": 1.5,
      "container": "Small",
      "country": "France",
      "state": "Grand-Est",
      "owner": { "id": 1234567, "name": "MonPseudo" },
      "placed_date": "2011-03-05",
      "status": "archived",
      "favorite_points": 42
    }
  ],
  "logs": [
    {
      "log_id": 181176759,
      "gc_code": "GC1ABCD",
      "type_id": 3,
      "type_label": "Didn't find it",
      "date": "2011-08-20",
      "author": { "id": 1234567, "name": "MonPseudo" },
      "favorite": null
    },
    {
      "log_code": "GL803Y79",
      "gc_code": "GC1ABCD",
      "type_id": 2,
      "date": "2012-01-08",
      "author": { "id": 7654321, "name": "UnAutre" },
      "favorite": true
    }
  ]
}
```

### Enveloppe

| Champ | Requis | Règle |
|---|---|---|
| `format` | oui | exactement `"mygcflow-logs"` — c'est le contenu qui identifie le format, pas l'extension |
| `schema_version` | oui | `1` ; toute autre valeur est refusée |
| `exported_at` | conseillé | instant ISO 8601 ; départage les versions d'un même log (§ Fusion) |
| `generator` | non | informatif, affiché dans le bilan, jamais interprété |
| `account` | conseillé | compte du joueur qui exporte : `user_id` (entier) et/ou `username` |
| `coverage` | non | périmètres que le fichier couvre **en entier** (§ Couverture) ; absent = rien de garanti |
| `caches` | non | fiches de caches (§ Caches) ; liste éventuellement vide |
| `logs` | oui | liste éventuellement vide |

Champs inconnus : ignorés à tous les niveaux (compatibilité ascendante). Une
évolution incompatible passe en `schema_version: 2`.

### Logs

| Champ | Requis | Règle |
|---|---|---|
| `log_id` / `log_code` | au moins un | identité du log chez Geocaching : entier (`id` du GPX) ou code `GL…` ; les deux sont convertibles (§ Identités) et doivent concorder s'ils sont fournis ensemble |
| `gc_code` | oui | `GC` + base 16/31, normalisé en majuscules, espaces retirés |
| `type_id` | oui* | identifiant numérique Geocaching (§ Types) ; *à défaut, `type_label` anglais reconnu |
| `type_label` | non | libellé anglais, informatif ; utile seulement si `type_id` manque |
| `date` | oui | **date civile** `AAAA-MM-JJ` du log, jamais convertie de fuseau ; un instant ISO est accepté et seule sa partie date est retenue (comme `time_find`, l'heure des GPX est factice : 19:00/20:00 UTC) |
| `author.id` | conseillé | identifiant numérique du joueur — c'est lui qui dit « moi » ou « un autre » |
| `author.name` | conseillé | pseudo au moment de l'export (un pseudo peut changer, l'`id` non) |
| `favorite` | non | `true` / `false` si l'auteur a donné un point favori avec ce log, `null` ou absent = inconnu |
| `text` | — | **jamais lu ni stocké**, même présent |

### Caches

Fiche facultative : elle donne coordonnées et attributs aux caches absentes
de My Finds (DNF jamais résolus, caches posées, archivées…).

| Champ | Règle |
|---|---|
| `gc_code` | requis, même normalisation |
| `name`, `container`, `country`, `state` | textes ; `None`/`Unknown` traités comme `bdd.clean_geo_text` |
| `type` | libellé Groundspeak anglais, celui de `<groundspeak:type>` (`"Unknown Cache"`, `"Wherigo Cache"`…) : mêmes couleurs, icônes et filtres que les géocaches |
| `latitude`, `longitude` | coordonnées **publiées** ; règles de `lab_formats.validate_coordinates` (finies, dans les bornes, `(0,0)` conservé mais signalé) |
| `corrected` | facultatif : `{latitude, longitude}` corrigées par le joueur (mystery résolue) ; même validation ; usage à décider (la position réelle d'un DNF de mystery) |
| `difficulty`, `terrain` | 1 à 5 par pas de 0,5 |
| `owner.id`, `owner.name` | propriétaire actuel |
| `placed_date` | date civile de pose déclarée (≠ publication, qui est le log `Publish Listing`) ; déclarative, un log peut la précéder (trouvaille de bêta-test, date modifiée après coup — constaté sur données réelles) : ne jamais rejeter ni réordonner un log sur cette base |
| `status` | `active` / `disabled` / `archived` / `unknown` — état **à la date d'export** |
| `favorite_points` | total à la date d'export |

### Couverture

`coverage` dit ce que le fichier contient **intégralement**. Sans lui, un
import ne peut qu'ajouter et mettre à jour ; avec lui, il peut aussi retirer
les logs supprimés sur le site depuis l'import précédent.

| `kind` | Champs | Sens |
|---|---|---|
| `author` | `author_id`, `type_ids` (facultatif : tous types), `since` (facultatif) | tous les logs de cet auteur, de ces types, depuis cette date |
| `caches` | `gc_codes`, `type_ids`, `since` (facultatifs sauf `gc_codes`) | tous les logs, tous auteurs, de ces caches |

`complete: false` (ou absent) rend l'entrée purement informative. `since`
permet des exports incrémentaux sans risquer de « supprimer » l'historique
plus ancien.

### Identités : codes GC et GL

Les codes `GC…` (caches) et `GL…` (logs) suivent le même algorithme : un
identifiant < 65 536 s'écrit en hexadécimal ; au-delà, base 31 (alphabet
`0123456789ABCDEFGHJKMNPQRTVWXYZ`) de l'identifiant + 411 120. Vérifié sur
les caches (`2483974` ↔ `GC345J4`, `2114502` ↔ `GC2PR3N`) ; **à confirmer
pour les GL** sur un log réel (`228739556` donnerait `GL803Y79`). Le stockage
garde l'entier : c'est la forme du GPX, et elle se trie.

### Types de logs

Identifiants Geocaching (ceux des `<option value>` du formulaire de log et
des images `images/logtypes/<id>.png` — relevés dans `pycaching/log.py`),
regroupés par catégorie d'usage :

| Catégorie | Types (id) |
|---|---|
| `find` | Found it (2), Attended (10), Webcam Photo Taken (11) — les mêmes que `bdd.uploadBdd` |
| `dnf` | Didn't find it (3) |
| `note` | Write note (4) |
| `owner` | Owner Maintenance (46), Update Coordinates (47), Temporarily Disable Listing (22), Enable Listing (23), Archive (5), Unarchive (12) |
| `reviewer` | Publish Listing (24), Retract Listing (25), Post Reviewer Note (18, variante 68), Submit for Review (76) |
| `alert` | Needs Maintenance (45), Needs Archived (7) |
| `event` | Will Attend (9), Announcement (74) |
| `other` | tout identifiant inconnu : **conservé** avec son id brut, signalé dans le bilan, jamais rejeté |

La catégorie ne remplace pas l'auteur : un Archive (5) est une action de
poseur s'il vient du propriétaire, une action de relecteur sinon. Les types
des objets voyageurs (Retrieved/Grabbed/Discovered it…) ne concernent pas
les caches : rejetés avec motif.

Les libellés anglais du GPX (`Found it`, `Didn't find it`…) sont mappés vers
ces identifiants ; la table de correspondance se complète sur des fixtures
réelles (orthographe exacte de chaque libellé à confirmer).

### Validation

Mêmes règles que les Labs (`lab_formats.py`) :

- document XML avec `DOCTYPE`/`ENTITY` refusé (XXE) ;
- date ambiguë ou illisible : log **rejeté** avec motif (une date est
  indispensable à l'animation) — jamais devinée ;
- log sans `log_id` ni `log_code` valide : rejeté (sans identité stable, la
  fusion est impossible) ;
- doublon d'identité dans un même fichier : le premier fait foi, les
  suivants sont comptés ;
- fiche de cache aux coordonnées invalides : gardée sans coordonnées ;
- plafonds : 1 000 000 de logs et 500 000 fiches par fichier
  (`log_formats.MAX_LOGS` / `MAX_CACHES`) — environ 150 Mo de JSON, sous la
  taille d'envoi `GPX_MAX_SIZE_BYTES` (200 Mo décompressés). Mesures au
  § Plan.

## Import depuis un GPX

`<groundspeak:log id="…">` porte tout le nécessaire : `id`, `<date>`,
`<type>` (libellé anglais), `<finder id="…">`. La fiche de cache se lit dans
le même `<wpt>` (coordonnées, `<groundspeak:cache>`). Un GPX ne déclare
aucune couverture : import en ajout/mise à jour seulement.

**My Finds alimente aussi les logs.** La passe `iterparse` de
`bdd.uploadBdd` lit déjà les logs pour trouver le « Found it » ; elle
collecte en plus tous les logs du fichier. Les DNF suivis d'une trouvaille
(cas de l'exemple GC2PR3N : DNF le 2011-08-20, trouvée le 2012-01-08)
deviennent visibles **sans aucun autre fichier**. Le `finder id` de ces logs
initialise le compte (`account.user_id`) s'il n'est pas encore connu — à
condition qu'il soit unique dans le fichier. La lecture d'un log est partagée
(`log_formats.logs_from_cache_element`) ; un log sans attribut `id` est
rejeté (cas des fixtures e2e), sans effet sur les trouvailles.

Les deux écritures restent distinctes : le remplacement de la table
`geocache` est commité d'abord, comme aujourd'hui ; la fusion des logs suit
dans sa propre transaction (`log_store.merge_myfinds_logs`). Son échec est
journalisé sans annuler l'import des trouvailles ; un My Finds d'un autre
compte que celui des logs déjà importés laisse ces logs intacts.

## Stockage

Dans `geocaching.db`, à côté de `geocache` et des tables Labs, par une
migration **v8** de `migrations.py`.

### Point clé : jointure par `gc_code`, jamais par `geocache.id`

L'import My Finds supprime puis réinsère toutes les lignes de `geocache` :
leurs `id` changent à chaque import. Les nouvelles tables se rattachent aux
caches par `gc_code`, sans clé étrangère vers `geocache`. Un réimport My
Finds ne touche ni aux logs ni aux fiches ; « Vider la base » (`/clear_database`)
non plus — les logs ont leur propre suppression, comme les Labs.

### Tables

**`log_collection`** — une ligne, comme `lab_collection` :

| Colonne | Rôle |
|---|---|
| `id`, `uid` | identité |
| `account_user_id`, `account_username` | « moi » : comparé à `author_id` / `owner_id` |
| `revision` | +1 à chaque import ou suppression ; invalide caches GeoJSON et aperçus en attente |
| `last_import_at`, `last_import_summary` | dernier bilan (JSON allégé) |
| `created_at` | |

**`log_event`** — un log :

| Colonne | Rôle |
|---|---|
| `id` | clé technique |
| `collection_id` | → `log_collection` |
| `log_id` | entier Geocaching, **unique** |
| `gc_code` | indexé |
| `type_id` | entier ; `category` n'est pas stockée, elle se déduit (table du code) |
| `log_date` | `Date` civile |
| `author_id`, `author_name` | |
| `favorite` | booléen nullable (`NULL` = inconnu) |
| `source_format` | `mygcflow-logs` / `gpx-myfinds` / `gpx` |
| `source_exported_at` | `exported_at` de la version retenue (§ Fusion) |
| `imported_at`, `updated_at` | |

Index : `(gc_code, log_date)` pour l'historique d'une cache,
`(author_id, type_id, log_date)` pour « mes DNF », `(log_date)` pour les
bornes de l'animation.

**`cache_ref`** — fiche d'une cache vue dans les logs :

| Colonne | Rôle |
|---|---|
| `collection_id` | → `log_collection` |
| `gc_code` | **unique** dans la collection |
| `name`, `cache_type`, `container`, `difficulty`, `terrain`, `country`, `state` | |
| `latitude`, `longitude`, `coordinate_source` | publiées ; source = format du fichier, ou `user_correction` (jamais écrasée par un import) |
| `corrected_latitude`, `corrected_longitude` | corrigées par le joueur (champ `corrected`) |
| `owner_id`, `owner_name`, `placed_date` | |
| `status`, `status_at` | état et date d'export qui l'atteste |
| `favorite_points` | |
| `source_format`, `source_exported_at`, `imported_at`, `updated_at` | |

### Résolution des coordonnées

Pour placer un log, dans l'ordre : correction manuelle de `cache_ref` →
coordonnées de `cache_ref` → coordonnées de la ligne `geocache` (My Finds) au
même `gc_code`. À défaut, le log reste **en attente** : compté dans le
statut, jamais affiché à une position inventée — même règle que les étapes
Labs. Pays et région manquants : ceux de `geocache`, sinon l'emprunt au plus
proche de `lab_geojson.borrowed_geo`.

## Fusion

Un import **fusionne**, il ne remplace jamais toute la table :

- **nouveau `log_id`** : ajouté ;
- **`log_id` connu** : mis à jour si la version entrante est au moins aussi
  récente (`exported_at`, à défaut l'ordre d'import) — un log peut avoir été
  modifié sur le site (date, type) ; un champ absent de l'entrée ne vide pas
  la valeur stockée ;
- **`log_id` connu absent du fichier** : supprimé seulement s'il entre dans
  une couverture `complete: true` du fichier (auteur, types, caches,
  `since`) ; sinon conservé ;
- **fiche de cache** : même règle de fraîcheur, champ par champ ; une
  correction manuelle de coordonnées survit aux imports (comme
  `USER_CORRECTION` côté Labs) ;
- **autre compte** : un fichier dont `account.user_id` diffère de celui de
  la collection est refusé en v1 — une collection, un joueur. Vider les logs
  pour changer de compte.

### Aperçu puis validation

Même parcours que « Mes Lab Caches » (`blueprints/labs.py`). Aperçu et
validation partagent un seul calcul (`log_store._plan`), qui ne fait que
lire ; seule la validation écrit (`log_store.commit_logs`, sous verrou).
Un fichier par import (`.json`, `.gpx`, ou `.zip` parcouru en entier :
chaque membre est reconnu par son contenu — un `mygcflow-logs` .json est
préféré à un .gpx, un « `*-wpts.gpx » de Pocket Query, sans logs, n'est
retenu qu'en dernier recours), borné comme l'envoi GPX (200 Mo
décompressés). Un GPX de Pocket Query déposé sur la page est routé vers
cette carte plutôt que vers My Finds (reniflage d'en-tête côté client,
comme les fichiers Labs).

1. **Aperçu** — `POST /api/logs/import/preview` (champ `file`) :
   `log_store.preview_logs`, fichier conservé sous un jeton opaque (TTL
   30 min, dossier `pending_log_imports` sous le répertoire de données —
   pas dans le temp partagé, sinon un export reçu d'un runtime de test
   ressortirait dans l'application et inversement). Bilan : ajoutés, mis
   à jour, inchangés, plus anciens ignorés, **retirés** (couverture complète,
   avec échantillon — code, date, catégorie, auteur), rejetés avec motif,
   avertissements, doublons, caches sans position, nombre de périmètres de
   couverture (0 = le fichier ne retirera rien — dit explicitement),
   répartition par catégorie « à vous / d'autres joueurs »,
   date d'export (`exported_at` ; son absence est annoncée — un fichier
   non daté écrase les versions enregistrées plutôt que d'être ignoré).
   Un fichier d'un autre compte est refusé dès l'aperçu (409).
2. **Validation** — `POST /api/logs/import/commit` (`import_token`) : le
   jeton est consommé par renommage de son dossier, puis la tâche de fond
   exclusive `log_import` reparse et applique sur l'état courant — échec si
   `revision` a bougé depuis l'aperçu (`LogRevisionConflict` : relancer
   l'aperçu). Le bilan de la tâche porte le statut à jour.
3. Statut — `GET /api/logs/status` ; aucun cache GeoJSON à invalider tant
   que les logs ne sont pas dessinés (lot C). Le statut porte aussi
   `pending_import` quand un export du favori attend sa validation
   (bandeau « Voir l'aperçu » de la carte, relevé toutes les 4 s tant que
   l'onglet Données est affiché) et `last_import` — date et compteurs
   allégés (`added`, `updated`, `removed`, `source`, `generator`) issus
   de `last_import_summary`, que la carte affiche en « Dernier import
   le … : … — favori/fichier ».

**Réception du favori** — `POST /api/logs/receive` : corps = document
`mygcflow-logs` (pas de multipart), jeton d'installation en en-tête
`X-MyGCFlow-Token` (comparaison `secrets.compare_digest`), origine
navigateur limitée à `https://www.geocaching.com` (CORS + preflight
`Access-Control-Allow-Private-Network`, aucune tête CORS sinon). L'app
étant en `http://localhost`, Chromium exige aussi `Vary: Origin`. Le
document reçu est déposé comme un aperçu : fichier conservé sous un jeton
d'import ordinaire (même mécanique que l'envoi de fichier) — la route ne
commit jamais. `GET /api/logs/bookmarklet` génère et mémorise le jeton
puis renvoie le lien `javascript:` monoligne (sources
`static/logs/logs_collect_core.js` + `logs_bookmarklet.src.js`,
`__TOKEN__`/`__ORIGIN__`/`__T_*__` substitués) ;
`POST /api/logs/bookmarklet/regenerate` invalide le favori existant
(un seul jeton actif à la fois, comme pour les Labs). Le jeton
(`logs_receive_token` dans les préférences) survit à « Réinitialiser
l'application », sinon le favori installé mourrait sans explication.

**Reprise de collecte** — `POST /api/logs/receive/fragment` (mêmes jeton et
CORS). Une collecte de plusieurs centaines de caches peut s'interrompre
(session expirée, onglet fermé) : le favori poste l'export courant en
**fragments** tous les quinze caches traités, sous un identifiant de
passage `X-MyGCFlow-Run-Id`. Chaque fragment est fusionné dans le document
conservé sous `frag-<run>` (dédupliqué par `log_id`/`gc_code`, périmètres
de couverture unis, compte unique — TTL 7 jours, contre 30 minutes pour un
aperçu). `X-MyGCFlow-Final: 1` scelle : le document fusionné passe l'aperçu
habituel et devient un import en attente — c'est cette route, pas
`/receive`, que le favori appelle en fin de collecte. Côté navigateur, le
*plan* (file de caches, avancement, échecs, `since`, ordre des dates figé
avec le premier fragment) vit dans `localStorage` (~25 Ko) : au clic
suivant, le favori propose de reprendre là où il en était — les données
déjà lues sont côté application. Un plan de plus de 7 jours est écarté :
ses fragments ayant expiré, la couverture du scellement serait mensongère.
Un envoi final qui échoue laisse le plan à `done = file entière` : la
reprise renvoie l'export sans rien relire.

**Collecte incrémentale** — `GET /api/logs/receive/state` (mêmes jeton et
CORS ; une GET, donc hors du garde-fou inter-sites qui ne vise que les
mutations) répond au favori avant qu'il ne parte :

- `since` : date du `exported_at` le plus récent parmi les logs de source
  `mygcflow-logs` (`log_store.collection_since`). Les GPX ne font pas
  avancer l'horizon : ils ne portent pas les DNF hors caches trouvées.
  `null` tant qu'aucun export contrat n'a été importé → collecte complète ;
- `pending` : un export précédent attend sa validation — le favori
  propose alors d'annuler plutôt que de relire pour rien ;
- `logs_collect_full_once` (bouton « Forcer une collecte complète la
  prochaine fois », options avancées ; `POST
  /api/logs/bookmarklet/full-next`) est consommé à la lecture : la
  collecte suivante revoit `since`.

Avec `since`, le favori pagine « Vos journaux » **tous types** (pas
seulement les DNF : une trouvaille récente sur une vieille cache en DNF la
fait relire) et s'arrête dès qu'une page entière sort de la fenêtre — la
date est lue dans chaque ligne, avec repli prudent quand l'ordre des dates
est ambigu. Seules les caches touchées sont relues. La couverture
déclarée devient `{author, type_ids:[3], since}` : la fusion ne retire que
les logs datés dans la fenêtre — un DNF supprimé plus ancien resterait en
place jusqu'à une collecte complète (d'où le bouton). Limite assumée : un
log rétro-daté posté dans la fenêtre et un log supprimé hors fenêtre
échappent à l'incrémental. Les caches posées sont toujours relues en
entier (la liste « Vos caches » ne porte pas de date de dernier log).

Autres routes : `GET /api/logs/export` réexporte tout en `mygcflow-logs` v1
**sans couverture** (réimporté, il ne retire rien) et daté de ses données
les plus récentes (`max(source_exported_at)`), pas de l'heure de l'export —
sinon il passerait pour plus frais qu'un vrai export postérieur à ses
données ; `POST /api/logs/clear` vide logs, fiches et compte (refusé pendant
un import).

**Complétion des positions** — le compteur `pending_coordinates` du statut
(codes GC des logs couverts ni par une fiche `cache_ref` ni par une
trouvaille My Finds) n'est plus un cul-de-sac : `GET
/api/logs/pending_caches` (paginé : code, métadonnées de fiche connues,
volume de logs et DNF du compte) alimente la modale « Caches sans
position », et `POST /api/logs/caches/<code>/resolve` pose la position —
`coordinates` en texte libre (formats du géocacheur, même validation que
les étapes Labs) ou `latitude`/`longitude`. La fiche est créée si la cache
n'a que des logs ; `coordinate_source = user_correction` la protège de
tout import ultérieur, et la révision de collection est incrémentée (les
aperçus en attente deviennent caducs, comme pour tout import).

Un `.json` `mygcflow-logs` glissé sur la page (ou choisi dans « Mes
Géocaches ») est aiguillé vers « Mes logs » par `bdd.js` (`isLogsFile`, testé
avant `isLabFile`, qui prend tout `.json` pour un historique Labs). Un import
My Finds réussi rafraîchit le statut de la carte.

Les suppressions annoncées par l'aperçu sont toujours visibles avant
validation : un fichier mal déclaré « complet » ne doit pas effacer un
historique en silence.

## Ordre dans une même journée

Les logs n'ont pas d'heure fiable. Dans une journée, l'ordre est :
DNF → trouvaille → autres, puis `log_id` croissant (ordre de création des
logs, approximation acceptable). Un DNF et une trouvaille le même jour
s'animent donc dans cet ordre.

## Usages prévus (hors de ce contrat)

Requêtes de base, pour vérifier que le modèle suffit :

| Usage | Sélection |
|---|---|
| Mes DNF | `author_id = moi` et `type_id = 3` |
| DNF résolus | mes DNF dont le `gc_code` a une trouvaille à moi plus tardive (`log_event` ou `geocache`) |
| Activité de poseur | `author_id = moi`, catégorie `owner`, + `placed_date` et `Publish Listing` de mes caches |
| Mode « Mes caches » | `cache_ref.owner_id = moi` et `author_id ≠ moi` |
| Points favoris reçus | idem, `favorite = true` — seulement si la source les fournit |

Les animations dédiées et l'intégration aux Stats sont décrites au moment
de leur lot.

## Affichage des DNF (lot C)

**Un point par cache en DNF** (`dnf_geojson.py`, `GET /api/logs/dnf_features`) :
il apparaît au premier DNF du joueur (`date_find`) et disparaît le jour où une
trouvaille du joueur le résout (`resolved_date` : la plus ancienne trouvaille
postérieure ou égale au premier DNF, lue dans ses logs ou dans le My Finds) —
la trouvaille prend alors sa place. Une cache trouvée avant tout DNF n'a pas
de point ; les DNF postérieurs à la résolution sont ignorés. Position : fiche
`cache_ref`, sinon le My Finds ; sans position, la cache est comptée en
attente (`pending`) et jamais placée.

**Jamais une trouvaille.** Les points DNF sont servis à part du jeu principal
et ne passent pas par `pointsByDate` : ni compteur de sélection, ni compteur
de l'animation, ni panneaux Stats, ni barre de chronologie, ni suivi de
caméra par jour ne les voient. `static/js/dnf_data.js` les charge (seulement
si l'affichage est activé), les filtre comme la sélection courante
(`filterLikeCurrentSelection`, bdd.js) puis `mapgl.js` les ajoute et les
retire dans **leur propre couche, sous celle des trouvailles** (zIndex 1000
contre 1001, source `window.dnfVectorSource`, même style et même horloge) —
une trouvaille qui chevauche un DNF reste visible et prioritaire au clic.
Une seule couche ne convient pas : OpenLayers 10 y dessine les points dans
l'ordre de leurs identifiants internes, et les DNF, créés après les
trouvailles, passaient dessus. Mise à jour selon le jour montré (`syncDnfToDay` à
chaque jour de l'animation, au départ et à chaque saut de la chronologie ;
`syncDnfStatic` au repos, état à la fin de la sélection). Règles pures dans
`static/js/dnf_model.mjs` (testées par `tests/js/dnf_model.test.mjs`).

**Filtres.** Type, taille, D/T, pays et région s'appliquent comme aux
géocaches. Les bornes de dates par défaut valent l'étendue des trouvailles :
un DNF antérieur à la première ou postérieur à la dernière en sortirait sans
que rien n'ait été restreint. Seule une borne déplacée par l'utilisateur
s'applique aux DNF (`dateBoundsAtDefault`, ui.js), sur la date du premier
DNF. En « Lab Caches » seuls, aucun DNF.

**Rendu** (`point_webgl_style.js`, `applyDnfStyle`) : noir en vectoriel —
bordure blanche quand le thème en dessine une — et icône du type de log
« Didn't find it » de geocaching.com en mode icônes (case `dnf` des feuilles
`geocaching-sprite*.png`, x = 1900, aussi dans le jeu « smiley »), refaite
sur le modèle des autres : disque blanc sur toute la case (48 px, 96 en
@2x), icône réduite à 40 px (80) au centre — sans ce contour, elle paraissait
plus grosse que ses voisines. Pas de compteur à l'apparition. Popup : nombre
de DNF, date du premier, date de la trouvaille ou « Pas encore trouvée ».

**DNF trouvé.** Pendant l'animation et la vidéo, quand la trouvaille résout
un DNF, le point DNF ne disparaît pas d'un coup : il fait un léger sursaut,
rétrécit et s'efface (450 ms, la courbe de la disparition du mode
Évolution) pendant que la trouvaille apparaît. Le style lit l'attribut
`vanish` (instant de départ sur l'horloge des points ; `DNF_NOT_VANISHING`
pour tous les autres points, posé par `setAppearAttributes`) ; `syncDnf` le
pose, puis retire le point à la synchronisation suivante, une fois
l'effacement fini (`dnfVanishing`). Lors d'un saut ou au repos, le retrait
reste immédiat. **Célébration** facultative (thème, `flash.dnf_found`,
désactivée par défaut) : un flash joué à ce moment, avec une forme propre,
le **feu d'artifice** (`flash_fireworks.mjs`, testé par
`test_flash_fireworks.mjs` : éclat blanc, douze traînées à la couleur du
flash qui retombent, huit étincelles plus claires), ou l'une des formes du
flash d'apparition.

**Flash** (réglage du thème `flash.dnf`, sous-onglet Flash du mode principal,
`menu_flash_dnf.html`) : à son apparition pendant l'animation ou la vidéo,
un DNF joue par défaut le flash des trouvailles (`mode: "same"`), ou son
flash propre — forme, taille, couleur, contour, comme le flash de
disparition du mode Évolution (mêmes contrôles génériques dans `ui.js`,
`initFlashVariantControls`). Formes : celles du flash d'apparition sauf la
vague « impulse ». Aucun flash au départ de l'animation ni lors d'un saut.
`getDnfDebugState()` (mapgl.js) relève, pour les tests, les flashs d'apparition, les
célébrations et les effacements (en cours et cumulés).

**Trait de déplacement.** Chaque DNF est un déplacement : chaque tentative
(`dnf_dates`) est une étape du trajet, jusqu'à la date de fin de l'animation
(`getTrailGeometry`, clé de mémoïsation `dnfRevision`).

**Préférences globales** (onglet Données, panneau des filtres, « Mes DNF »)
: `dnf_display` (masqués par défaut) et `dnf_in_trail` (inclus par défaut,
sans effet tant que l'affichage est coupé).

## Caches posées sur la carte principale

Le 2026-10-26, la carte « Mes Géocaches » peut montrer les **caches posées par
le joueur** et ses **étapes physiques de poseur** — pose, maintenance,
désactivation, réactivation, archivage — à côté de ses trouvailles. À la
différence de la page « Mes poses » (docs/mode-poses.md), **aucun log des
autres joueurs** n'y apparaît. Choix de l'utilisateur : facultatif, proposé
seulement si la base en contient ; flashs distincts de ceux des trouvailles ;
forme et contour propres.

**Données** (`owner_geojson.py`, `GET /api/logs/owner_features`) : les caches
de `poses_dataset.load_owned_caches`, mêmes règles d'apparition (publication,
sinon pose déclarée, une trouvaille de bêta-test l'avance) et d'état que Mes
poses. Un point par cache placée (fiche, sinon My Finds ; sans position :
`pending` ; sans date : `undatable`). Propriétés des trouvailles (filtres),
`date_find` = jour d'apparition, plus `owner_states` (`[[jour, état]]`,
changements effectifs, **tous** auteurs : une archive du relecteur grise la
cache) et `owner_events` (`[[jour, type]]` : maintenance — 46 et 47 —,
désactivation, réactivation, désarchivage, archivage **du poseur seulement**,
à partir de l'apparition). `ownedTotal` dit s'il faut proposer l'affichage.

**Jamais une trouvaille** : même mécanique que les DNF — `static/js/owner_data.js`
(chargé toujours sur la page principale, car c'est lui qui décide de
proposer l'option ; filtré par `filterLikeCurrentSelection`), règles pures
dans `static/js/owner_model.mjs` (tests `tests/js/owner_model.test.mjs`),
couches propres dans `mapgl.js` (`syncOwnerToDay` / `syncOwnerStatic`,
source `window.ownerVectorSource`), hors de `pointsByDate`.

**Affichage** : une cache posée apparaît à sa publication puis reste ;
désactivée ou archivée, elle est grisée (attribut `pstate`, comme sur Mes
poses, mais plus soutenu : gris `#8a8a8a` à 85 % d'opacité pour les
archivées — quelques caches parmi les trouvailles doivent rester
repérables). Couches entre les DNF et les trouvailles (zIndex 1000,5 et
1000,6). Au repos : toutes les caches de la sélection, dans leur état actuel
(ou à la date de fin si sa borne a été déplacée — la fin par défaut est la
dernière trouvaille). Popup : « Ma cache », apparition, état, dernière
maintenance.

**Forme et contour** (thème, `points.owner_shape` / `owner_border_color` /
`owner_border_width`, sous-onglet Points) : en vectoriel, étoile (défaut),
carré, losange, triangle, cercle ou « comme les trouvailles », centre aux
couleurs du thème, contour propre (doré `#ffc107`, 2 px ; 0 = aucun). En
mode icônes, l'icône du type est entourée d'un **anneau** à la couleur du
contour : une icône WebGL n'a pas de contour, l'anneau est une seconde
couche (`buildOwnerRingStyle`) sur la même source, dessinée dessous.

**Flashs** (thème, `flash.owner`, sous-onglet Flash) : seconde table de
`event_flash.py` / `event_flash.mjs` (`OWNER_FLASH_KINDS`, défauts distincts
du flash des trouvailles : pose = étoile dorée, maintenance =
scintillement vert…). Un flash par cache et par lot de jours, le plus
marquant l'emporte (archivage > désactivation > réactivation > pose >
maintenance) parmi ceux qui flashent ; un désarchivage joue la réactivation.
Lignes de réglage partagées avec Mes poses (`_event_flash_rows.html`,
groupe `data-event-flash-group`).

**Trait de déplacement** : la pose et chaque jour d'étape du poseur sont des
déplacements (`ownerVisitsByDay`, clé de mémoïsation `ownerRevision`).

**Préférences globales** (onglet Données, « Mes caches posées », visible
seulement avec des caches posées) : `owner_display` (masquées par défaut) et
`owner_in_trail` (incluses par défaut).

Tests : `tests/test_owner_geojson.py`, `tests/js/owner_model.test.mjs`,
`tests/e2e/owner-display.spec.mjs` (fixture `my-finds-poses.gpx`, dont les
trouvailles encadrent la vie des caches de `logs-poses.json`).
`getOwnerDebugState()` (mapgl.js) relève caches affichées et états, flashs
joués, changements d'état et présence de l'anneau.

## Plan

| Lot | Contenu | Livrable vérifiable |
|---|---|---|
| **A — données** ✅ | migration v8 ; `log_formats.py` (contrat + logs GPX, sans Flask) ; `log_store.py` (fusion, couverture, aperçu) ; My Finds alimente `log_event` | tests unitaires sur fixtures **fictives** ; banc d'import (100 000 logs) pour fixer les plafonds |
| **B — interface** ✅ | carte « Mes logs » de l'onglet Données : favori de collecte (`javascript:`, jeton régénérable) + réception `/api/logs/receive` en import en attente ; import de fichier avec aperçu, statut (par catégorie, en attente), export `mygcflow-logs`, suppression | e2e : aperçu, validation, réimport idempotent, refus d'un autre compte, export du favori jusqu'à l'aperçu |
| **C — DNF sur la carte** ✅ | réglage d'affichage (masqué par défaut), apparition / résolution dans l'animation, saut de la barre de chronologie | e2e : DNF masqué, DNF affiché puis remplacé par la trouvaille |
| **D — poseur** ✅ | activité de poseur : publication, désactivations, maintenance, archivage (page « Mes poses ») | e2e `poses.spec.mjs` |
| **E — mode « Mes caches »** ✅ | page `/poses` sur le moteur du mode Évolution : logs des autres joueurs, favoris, flashs par événement, rendu grisé (docs/mode-poses.md) | e2e `poses.spec.mjs` |
| **D bis — poseur sur la carte principale** ✅ | caches posées et étapes du poseur (pose, maintenance, désactivation, archivage) parmi les trouvailles, sans les logs des autres ; forme, contour et flashs propres (§ Caches posées sur la carte principale) | e2e `owner-display.spec.mjs` |
| **F — Stats** ✅ | panneaux de Mes poses sur les trouvailles reçues (`stats.poses_panels`) ; sur la page principale, source par panneau : trouvailles, DNF, caches posées (docs/panneaux-stats.md § Sources comptées) | e2e `stats-poses.spec.mjs`, `stats-sources.spec.mjs` |

Mesures du lot A (`tools/bench_log_import.py`, 2026-10-25, Windows, SQLite
local ; ~50 logs par cache, couverture complète par cache ; l'incrément est
un export plus récent où 1 % des logs ont changé et 1 % ont disparu) :

| logs | JSON | lecture | aperçu (base vide) | 1er import | réimport identique | incrément |
|---|---|---|---|---|---|---|
| 10 000 | 1,5 Mo | 0,05 s | 0,03 s | 0,14 s | 0,10 s | 0,19 s |
| 100 000 | 15 Mo | 0,44 s | 0,06 s | 3,1 s | 2,1 s | 3,6 s |
| 500 000 | 76 Mo | 5,8 s | 0,7 s | 24 s | 10 s | 16 s |

Un export réel (5 277 logs, 515 caches) s'importe en 0,1 s. Le coût dominant
est l'écriture (insertions par lots) ; rien à optimiser à ces volumes.

Le lot A suffit à rendre les DNF résolus disponibles à partir du seul
My Finds ; les autres sources n'arrivent qu'avec un fichier `mygcflow-logs`
ou un GPX plus riche.

## Points à vérifier sur données réelles

- Codes `GL` : l'algorithme des codes `GC` s'applique-t-il bien ?
- My Finds contient-il **tous** mes logs sur chaque cache trouvée, ou
  seulement certains ? (l'exemple GC2PR3N montre au moins DNF + Found.)
- Orthographe exacte des libellés de types dans les GPX (My Finds, Pocket
  Query, GSAK).
- Point favori **par log** : absent de tout GPX, mais présent dans le carnet
  JSON du site (`FavoritePointUsed`, relevé le 2026-10-24) — un fichier
  `mygcflow-logs` peut donc le porter.
- L'identifiant d'auteur du carnet (`AccountID`) est bien le `finder id` des
  GPX (vérifié sur un compte réel, 2026-10-24) : les deux sources se
  rapprochent par l'identifiant, sans passer par le pseudo.
- Un export RGPD de geocaching.com contient-il les logs, et sous quelle
  forme ? S'il les contient, un convertisseur vers `mygcflow-logs` serait la
  voie officielle pour les usages 1 et 2.
