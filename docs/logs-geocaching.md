# Logs Geocaching — contrat d'import, stockage et plan

> **Statut : spécification, rien n'est codé** (2026-10-24, rédigée sur `main`
> à `bb69772`). Ce document fixe le contrat avant le code ; les noms de
> modules, tables et routes sont des propositions à ajuster aux conventions
> du moment.

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

MyGCFlow n'accède pas à geocaching.com pour ces données : ni scraper, ni
cookies, ni identifiants. Elle importe des **fichiers** :

- le contrat neutre **`mygcflow-logs` v1** (ci-dessous), que n'importe quel
  outil peut produire ;
- les **logs Groundspeak d'un GPX** (`<groundspeak:log>`) : My Finds, Pocket
  Query, export GSAK.

Le contrat ne suppose rien de l'outil qui l'a produit : aucun champ
spécifique à une méthode de collecte. Les conditions d'utilisation de
geocaching.com interdisent la collecte automatisée sans autorisation écrite ;
un outil tiers qui produirait ce fichier n'est ni livré dans l'installeur, ni
présenté comme la voie d'import de l'app.

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
- plafonds : taille alignée sur `GPX_MAX_SIZE_BYTES` (200 Mo décompressés) ;
  nombre de logs à fixer après mesure (§ Plan, lot A).

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
initialise le compte (`account.user_id`) s'il n'est pas encore connu.

Les deux écritures restent distinctes : le remplacement de la table
`geocache` est commité d'abord, comme aujourd'hui ; la fusion des logs suit
dans sa propre transaction. Son échec est signalé dans le bilan sans annuler
l'import des trouvailles.

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
| `gc_code` | **unique** |
| `name`, `cache_type`, `container`, `difficulty`, `terrain`, `country`, `state` | |
| `latitude`, `longitude`, `coordinate_source` | `file` / `user_correction` |
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

Même parcours que « Mes Lab Caches » (`blueprints/labs.py`) :

1. **Aperçu** : parsing et fusion simulée dans une transaction annulée,
   fichiers conservés en attente (`_store_pending`). Bilan par fichier et
   projeté : ajoutés, mis à jour, inchangés, **retirés** (couverture
   complète), rejetés avec motif, types inconnus, logs en attente de
   coordonnées, répartition par catégorie et « moi / les autres ».
2. **Validation** : tâche de fond exclusive (`task_manager`), qui reparse et
   recalcule sur l'état courant — l'aperçu est refusé si `revision` a bougé
   entre-temps (`_load_pending`).
3. Invalidation de `geojson_cache` et du cache de statut.

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

Le rendu (feature DNF par cache avec `dnf_dates` et date de résolution,
masqué par défaut, noir en vectoriel / icône DNF), les animations dédiées et
l'intégration aux Stats sont décrits séparément, au moment de leur lot.

## Plan

| Lot | Contenu | Livrable vérifiable |
|---|---|---|
| **A — données** | migration v8 ; `log_formats.py` (contrat + logs GPX, sans Flask) ; `log_store.py` (fusion, couverture, aperçu) ; My Finds alimente `log_event` | tests unitaires sur fixtures **fictives** ; banc d'import (100 000 logs) pour fixer les plafonds |
| **B — interface** | carte « Mes logs » de l'onglet Données : import avec aperçu, statut (par catégorie, en attente), export `mygcflow-logs`, suppression | e2e : aperçu, validation, réimport idempotent, refus d'un autre compte |
| **C — DNF sur la carte** | réglage d'affichage (masqué par défaut), apparition / résolution dans l'animation, saut de la barre de chronologie | e2e : DNF masqué, DNF affiché puis remplacé par la trouvaille |
| **D — poseur** | affichage de l'activité de poseur | |
| **E — mode « Mes caches »** | page dédiée, comme le mode Évolution | |
| **F — Stats** | métriques DNF / poseur optionnelles dans les panneaux | |

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
