# Ajouter un pays aux cartes par zones

Les cartes par zones colorent des **pays**, des **régions** et des
**sous-régions** (départements, Landkreise, counties…). Pays et régions
couvrent déjà le monde entier. Les sous-régions s'ajoutent pays par pays (France, Allemagne, Royaume-Uni,
Irlande, États-Unis à ce jour),
avec **une recette, une commande, et des tests qui passent tout seuls**. Il
n'y a pas de code à écrire.

Fonctionnement d'ensemble : [carte-zones.md](carte-zones.md).

## En bref

1. Trouver une source de contours à licence acceptée (§ Sources et licences).
2. Écrire `geo/recipes/<CC>.json`, où `<CC>` est le code ISO 3166-1 du pays,
   par exemple `BE`. Partir d'une recette existante : `DE.json` pour un
   niveau 2 seul, `FR.json` si le pays remplace aussi son niveau 1.
3. Lancer `python tools/build_geo_zones.py`.
4. Lancer les tests :
   `python -m unittest tests.test_geo_zones tests.test_zones`.
5. Committer la recette **et** les fichiers produits : `static/geo/`,
   `geo/match/` et la section régénérée de
   `installer/licenses/THIRD_PARTY_NOTICES.txt`.

Le nouveau pays arrive chez les joueurs avec la mise à jour suivante de l'app.

## Prérequis

- Node et `npm install` à la racine du dépôt, qui installe **mapshaper**
  (dépendance de développement, jamais embarquée dans l'app).
- Le `.venv` de l'app (`requests` sert aux téléchargements).

Les sources téléchargées sont gardées dans `geo/.cache/` (non versionné).
`--offline` reconstruit sans réseau à partir de ce cache.

## La recette

```json
{
  "kind": "country",
  "country": "DE",
  "comment": "Une phrase : quoi, d'où, quelle date.",
  "sources": {
    "bkg-vg1000": {
      "url": "https://…/vg1000_12-31.utm32s.shape.ebenen.zip",
      "sha256": "7e23…",
      "member": "vg1000_ebenen_1231/VG1000_KRS.shp",
      "title": "BKG — Verwaltungsgebiete 1:1 000 000 (VG1000), Stand 31.12.2025",
      "licence": "dl-de-by-2.0",
      "attribution": "© GeoBasis-DE / BKG (2025)",
      "homepage": "https://gdz.bkg.bund.de/…"
    }
  },
  "levels": {
    "subregion": {
      "source": "bkg-vg1000",
      "filter": "GF == 4",
      "label": { "fr": "arrondissements (Kreise)", "en": "districts (Kreise)", "local": "Landkreise" },
      "id": ["DE-{AGS}"],
      "name": "{GEN}",
      "name_unique": "{GEN} ({BEZ})",
      "aliases": ["GEN", "{BEZ} {GEN}"],
      "simplify": { "display": 1500, "match": 100 }
    }
  },
  "aliases": { "country": ["Deutschland", "Allemagne"] },
  "insets": [],
  "samples": [
    { "label": "Köln", "lat": 50.9375, "lon": 6.9603, "region": "DE-NW", "subregion": "DE-05315" }
  ]
}
```

### `sources`

| Champ | Rôle |
|---|---|
| `url` | Adresse **figée** : un millésime, un commit, jamais « latest » ou « aktuell » s'il existe mieux. |
| `sha256` | Empreinte du fichier. Si la source change, la construction s'arrête et affiche la nouvelle empreinte : vérifier ce qui a changé avant de la recopier. |
| `member` | Pour une archive ZIP : le fichier à lire dedans (`.shp`, `.geojson`). |
| `file` | Nom du fichier en cache, quand l'adresse n'en donne pas (requête d'API : `…/query?…&f=geojson`). L'extension dit le format à mapshaper. |
| `title`, `attribution`, `homepage` | Recopiés dans les notices de licence et dans `index.json`. `attribution` est le texte exact que demande la licence. |
| `licence` | Une des clés du tableau ci-dessous. |

Un identifiant de source est unique dans tout le dépôt. Le préfixer par
l'organisme : `ign-`, `bkg-`, `census-`.

Formats lus : tout ce que lit mapshaper (Shapefile, GeoJSON, TopoJSON…), dans
n'importe quelle projection pourvu qu'elle soit déclarée (`.prj`). La sortie
est toujours en WGS84.

### `levels`

Une recette fournit `subregion` (niveau 2), et `region` (niveau 1) seulement
si le découpage de Natural Earth ne correspond pas aux régions de
Geocaching.com. C'est le cas de la France, découpée en départements chez
Natural Earth alors que GC utilise les régions.

| Champ | Rôle |
|---|---|
| `source` | Identifiant d'une source de la recette. |
| `filter` | Expression mapshaper (JavaScript sur les champs) qui garde certaines formes : `GF == 4` (terres seules), `!["72"].includes(STATEFP)`. |
| `label` | Nom du niveau affiché : `fr`, `en`, et `local` (« Landkreise »). |
| `id` | Liste de modèles. Le premier qui donne une valeur non vide l'emporte ; en cas de doublon, les zones concernées passent au suivant. |
| `id_map` | Table de correction après le modèle (`"FR-11": "FR-IDF"`). |
| `parent` | Modèle de l'id du parent (`"US-{STUSPS}"`). Absent : le parent est la région qui contient le **point intérieur** de la zone. C'est automatique, et la construction échoue si une zone n'a pas de parent. |
| `name`, `name_fr`, `name_en` | Modèles des noms affichés. `name_fr` et `name_en` valent `name` par défaut. |
| `name_unique` | Nom utilisé quand deux zones du pays portent le même `name` (München ville / München Landkreis). |
| `aliases` | Champs, ou modèles `"{BEZ} {GEN}"`, dont les valeurs servent à reconnaître les noms donnés par Geocaching.com et par les CSV d'Évolution. Les valeurs `a\|b` sont dépliées. |
| `simplify` | Tolérance en mètres : `display` pour les cartes (1 500 à 2 500), `match` pour le rattachement (100). |
| `group_by`, `groups`, `groups_of` | Zones faites de plusieurs unités de la source (§ Regrouper des unités). |
| `inputs` | Plusieurs sources pour un même niveau, à la place de `source` (§ Plusieurs sources). |

**Identifiants** : ISO 3166-2 quand il existe (`DE-BY`, `US-TX`, `FR-44`).
Sinon un code officiel préfixé par le pays (`DE-09162`, `US-48201`). Un id ne
doit jamais changer : il est stocké dans les tableaux de bord des joueurs.
Unique par niveau ; une région et une sous-région peuvent le partager quand
c'est la même entité (La Réunion : `FR-974` aux deux niveaux).

### Regrouper des unités

Quand les zones voulues n'existent pas telles quelles dans une source ouverte,
la recette les compose à partir d'unités plus petites. Exemple, `GB.json` :
les comtés cérémoniaux anglais sont faits d'autorités unitaires (Kent = Kent
+ Medway), et les régions de Geocaching.com sont faites de comtés.

```json
"subregion": {
  "group_by": "CTYUA24CD",
  "groups": { "Kent": ["E10000016", "E06000035"], "Fife": ["S12000047"] },
  "id": ["GB-{group_key}"],
  "name": "{group}"
},
"region": {
  "group_by": "CTYUA24CD",
  "groups_of": "subregion",
  "groups": { "South East England": ["East Sussex", "Kent", "Surrey", "West Sussex"] },
  "id": ["GB-{group_key}"],
  "name": "{group}"
}
```

- `group_by` : champ de la source qui identifie une unité.
- `groups` : nom du groupe → valeurs de `group_by`. Avec `groups_of`, les
  membres sont des groupes de cet autre niveau de la recette.
- Les modèles disposent de `{group}` (le nom) et `{group_key}` (le nom
  normalisé, comme les ids de `dissolve`).
- La construction s'arrête si une unité de la source n'est dans aucun
  groupe, si elle est dans deux groupes, ou si un groupe cite une unité
  absente de la source. Une liste complète est donc vérifiée à chaque
  construction.
- Le parent d'une sous-région est toujours trouvé par son point intérieur :
  des régions faites des mêmes unités le contiennent forcément.

### Plusieurs sources

Quand aucune source ne couvre tout le découpage de Geocaching.com, un niveau
en réunit plusieurs. Exemple, `IE.json` : GC traite l'île d'Irlande comme un
seul pays, avec l'Irlande du Nord dans « Ulster ». Les comtés de la
République viennent de Tailte Éireann, les districts d'Irlande du Nord de
l'ONS (source déjà déclarée par `GB.json`).

```json
"inputs": [
  { "source": "tailte-counties-2019", "unit": "COUNTY" },
  { "source": "ons-ctyua-2024", "unit": "CTYUA24CD", "filter": "CTYUA24CD.startsWith('N')" }
],
"groups": { "Cork": ["CORK"], "Belfast": ["N09000003"] }
```

- `unit` : le champ qui identifie une unité dans cette source. Les membres
  des `groups` sont ces valeurs ; elles ne doivent pas se recouper d'une
  source à l'autre.
- `inputs` va toujours avec `groups`, et remplace `source`, `filter` et
  `group_by` du niveau.
- Les sources sont réunies puis réparées par `mapshaper -clean` : deux
  sources ne se rejoignent jamais au mètre près, les interstices (jusqu'à
  `gap_fill_km2`, 1 km² par défaut) sont comblés et les chevauchements
  partagés. Sans cela, l'Ulster avait 35 trous le long de la frontière.
- Le résultat est gardé dans `geo/.cache/merge-*.geojson`.
- Un pays d'une source peut ainsi être ailleurs dans une autre : l'Irlande
  du Nord est retirée de `GB.json` par un `filter`.

### `aliases` (de la recette)

```json
"aliases": {
  "country": ["Frankreich"],
  "as_region": { "FR-974": ["Réunion", "La Réunion"] },
  "zones": { "FR-PAC": ["PACA"] }
}
```

- `country` : autres noms du pays dans Geocaching.com ou les CSV.
- `as_region` : « pays » de Geocaching.com qui sont une région chez nous.
  Exemples : Réunion, Mayotte, Guadeloupe.
- `zones` : noms en plus pour une région ou une sous-région, par id.

La comparaison ignore la casse, les accents, les tirets (demi-cadratin
compris), les espaces et la ponctuation. « Grand-Est » reconnaît donc
« Grand Est » sans alias. Il n'en faut un que pour un nom vraiment différent
(« Catalunya » / « Cataluña », « Sicilia » / « Sicily »). Un alias vers un id
inconnu arrête la construction.

Un nom ambigu dans sa portée n'est pas utilisé : la position prend le
relais. La portée est le pays pour une région, la région pour une
sous-région (« Washington County » existe dans une trentaine d'États).

### `insets`

Encarts des mini-cartes pour les territoires lointains : Alaska, Hawaï,
outre-mer. On ne donne que les zones concernées, la mise en place se fait
au rendu. La géométrie reste à sa vraie place : la couche de la carte
principale et le rattachement l'utilisent telle quelle.

### `samples`

**5 points au moins** dont on connaît la zone. Prévoir :
- une grande ville ;
- un point à moins de 2 km d'une frontière intérieure ;
- un point sur la côte ou sur une île, si le pays en a ;
- un territoire en encart, s'il y en a.

`tests/test_geo_zones.py` les rattache **par la seule position**. C'est le
seul contrôle propre au pays : tout le reste est générique.

## Ce que vérifient les tests

`tests/test_geo_zones.py` parcourt tous les pays :
- `index.json` décrit exactement les fichiers présents (révision, taille) ;
- ids uniques, parents existants, noms et surfaces présents ;
- fichiers de rattachement identiques aux fichiers d'affichage (mêmes ids) ;
- budgets de taille (§ Poids) ;
- licence acceptée, `sha256` bien formé, chaque source créditée dans les
  notices ;
- points témoins, et noms de régions relevés dans de vraies trouvailles.

`tests/test_zones.py` teste le moteur de rattachement sur des données
synthétiques.

## Sources et licences

| Clé `licence` | Licence | Exemples |
|---|---|---|
| `public-domain` | Domaine public | Natural Earth, US Census (cartographic boundary files) |
| `cc0` | CC0 1.0 | |
| `cc-by-4.0` | CC BY 4.0 | geoBoundaries (repli générique, un fichier par pays) |
| `etalab-2.0` | Licence Ouverte 2.0 | IGN Admin Express |
| `dl-de-by-2.0` | Datenlizenz Deutschland – Namensnennung 2.0 | BKG VG250 / VG1000 |
| `ogl-uk-3.0` | Open Government Licence v3.0 | ONS (Royaume-Uni) |

**Refusées** : ODbL (OpenStreetMap : partage à l'identique de la base), et
toute licence non commerciale (GADM, CC BY-NC). Une nouvelle licence
s'ajoute dans `LICENCES` de `tools/build_geo_zones.py` et
`ACCEPTED_LICENCES` de `tests/test_geo_zones.py`, après lecture de ses
conditions de redistribution.

Ordre de préférence : la source officielle du pays (licence acceptée et
découpage à jour), sinon geoBoundaries (`ADM2` du pays, page
« gbOpen »).

Échelle : chercher une source au 1:500 000 à 1:1 000 000. Plus fin ne sert à
rien après simplification et alourdit les téléchargements. Plus grossier,
et les îles et les frontières deviennent imprécises.

## Poids

Budgets par fichier, vérifiés par les tests :
- affichage (`static/geo/…json`) : 1,6 Mo ;
- rattachement (`geo/match/…json.gz`) : 2 Mo.

Mesures du 2026-11-09 :

| | Affichage | Rattachement |
|---|---|---|
| Pays du monde | 1 004 Ko | 464 Ko |
| Régions du monde (242 fichiers) | ~3,3 Mo | ~2,4 Mo |
| FR (101 départements) | 127 Ko | 403 Ko |
| DE (400 Kreise) | 256 Ko | 344 Ko |
| GB (101 comtés) | 102 Ko | 351 Ko |
| IE (37 comtés et districts) | 35 Ko | 121 Ko |
| US (3 144 counties) | 1 515 Ko | 1 766 Ko |

Si un pays dépasse : augmenter `simplify.display` (2 500 → 3 500), puis
`simplify.match` (100 → 200). Tout est chargé à la demande, pays par pays.

## Niveau 1 : quand Natural Earth ne colle pas

Le niveau 1 par défaut vient de Natural Earth (admin-1), qui ne découpe pas
toujours comme Geocaching.com :

- **Regroupement simple** : quand Natural Earth donne, pour chaque unité, la
  région de Geocaching.com dans un champ, ajouter le pays à `dissolve` dans
  `world.json` (`"ITA": "region"`). Les unités sont fusionnées par ce champ.
  L'id devient `<CC>-<nom normalisé>` (`IT-sicily`).
  C'est déjà fait pour l'Italie, l'Espagne et la Slovénie.
- **Sinon** : une recette de pays avec son propre niveau `region`, comme
  `FR.json`, ou composé de sous-régions comme `GB.json` (§ Regrouper des
  unités), quand les régions de Geocaching.com ne sont pas officielles.

Pour repérer ces pays : le rapport de rattachement de l'app (onglet Zones,
carte « Noms reconnus » : noms de régions non reconnus et zones où la position
les a placés), ou un joueur qui le signale avec le formulaire d'issue « Zones »
(`.github/ISSUE_TEMPLATE/zones.yml`), rapport collé.

## Rattachement : règles à connaître

Détail dans [carte-zones.md](carte-zones.md). En résumé :
- le pays et la région viennent **d'abord du nom** donné par
  Geocaching.com, comme les filtres de la carte ;
- la sous-région vient de la position, **seulement parmi les enfants** de la
  région retenue. Une trouvaille dont la position contredit la région de GC
  de plus de 5 km reste hors carte au niveau 2. C'est en général un mystère
  aux coordonnées corrigées ;
- un point hors de tout polygone prend la zone la plus proche à moins de
  5 km (côtes, îlots) ;
- une cache locationless n'est jamais rattachée (position et pays fictifs) ;
- un îlot absent du contour simplifié des pays est retrouvé dans les niveaux
  fins des pays voisins (Helgoland, île de Sein).
