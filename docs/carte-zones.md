# Cartes par zones

Colorer des pays, des régions et des sous-régions selon une valeur calculée
sur les caches. Les zones s'affichent en couche animée sur la carte (lot 4)
et en mini-cartes dans la page Statistiques (lot 3).
Plan : `MyGCFlow_Plan_Carte_Zones.md`. Ajouter un pays :
[zones-ajouter-un-pays.md](zones-ajouter-un-pays.md).

État au 2026-11-09 : **lots 1 et 2 livrés**. Le lot 1 couvre les données,
le rattachement et les colonnes de `/api/stats/finds`. Le lot 2 est le
calcul partagé (`zone_model.mjs`). Rien n'est encore affiché.

## Niveaux

| Niveau | Clé | Couverture | Source |
|---|---|---|---|
| 0 | `country` | monde (242 pays) | Natural Earth admin-0, 1:50m |
| 1 | `region` | monde | Natural Earth admin-1, 1:10m, sauf pays à recette (FR : IGN) |
| 2 | `subregion` | FR, DE, US | recettes de pays |

Le code ne connaît que ces trois clés. Le nom affiché d'un niveau
(« départements », « Landkreise ») vient de `index.json`.

## Fichiers

| Chemin | Rôle | Lu par |
|---|---|---|
| `geo/recipes/*.json` | Recettes (sources, champs, alias, encarts, points témoins) | `tools/build_geo_zones.py` |
| `geo/.cache/` | Sources téléchargées (non versionné) | le script |
| `static/geo/index.json` | Catalogue : fichiers, révisions, tailles, nom des niveaux, encarts, sources | le navigateur |
| `static/geo/countries.json` | Niveau 0, GeoJSON d'affichage | le navigateur |
| `static/geo/regions/<CC>.json` | Niveau 1 d'un pays | le navigateur |
| `static/geo/subregions/<CC>.json` | Niveau 2 d'un pays | le navigateur |
| `geo/match/countries.json.gz` | Niveau 0 pour le rattachement, noms des pays, `as_region`, pays ayant un fichier | `zones.py` |
| `geo/match/<CC>.json.gz` | Niveaux 1 et 2 pour le rattachement, noms par niveau | `zones.py` |

`geo/match/` est embarqué par `installer/mygcflow.spec`. `static/` l'est déjà.

**Affichage** : propriétés `id`, `name`, `name_fr`, `name_en`, `parent`
(sauf pays), `area_km2` (surface avant simplification), `ix` / `iy` (point
intérieur, pour une étiquette). Coordonnées à 0,001°. Les géométries sont à
leur vraie place, encarts compris : les encarts (`insets` de `index.json`)
s'appliquent au rendu des mini-cartes.

**Rattachement** : anneaux en entiers (1e-4°, ≈ 11 m), codés en
différences, compressés. Simplification à 100 m (500 m pour le monde). Les
noms sont normalisés (`zones.normalize_name`) et rangés par niveau :
`{nom: [ids]}`. Plusieurs ids signalent une ambiguïté.

La construction est **reproductible** : deux passes donnent des fichiers
identiques à l'octet près. Une reconstruction sans changement de recette ne
modifie donc rien dans git.

## Rattachement (`zones.py`)

`zones.get_index().assign(country=, state=, county=, lat=, lon=)` renvoie
`Assignment(country, region, subregion, via)`. `via` dit comment chaque
niveau a été trouvé : `name`, `position`, `nearest`, `parent` ou `None`.

1. **Pays** : nom GC, avec les alias. Un « pays » GC qui est une région chez
   nous (`as_region` : Réunion, Mayotte…) donne pays et région. Sinon la
   position, sinon la zone la plus proche à moins de 5 km. Sinon, les niveaux
   fins des pays voisins, à moins de 0,5° : îlots effacés du contour
   simplifié (Helgoland, île de Sein).
2. **Région** : nom GC dans le pays, sinon la position.
3. **Sous-région** : nom (champ `county` d'Évolution), sinon la position.
   Dans les deux cas, **seulement parmi les enfants de la région
   retenue** : la somme des sous-régions fait toujours la région. Une
   position qui contredit la région de GC de plus de 5 km donne `None`.
   C'est en général un mystère aux coordonnées corrigées : 8 trouvailles sur
   24 000 dans la base de dev.
4. Rien trouvé : `None`, « hors carte ». Jamais d'exception pour une
   donnée : position (0, 0) ou hors bornes ignorée, fichiers absents →
   `available()` faux, tout à `None`.

**Performances** (base de dev, 24 365 trouvailles) : 1,1 s au premier appel
(chargement de FR, DE, US et index des bandes), puis ~80 ms de plus que sans
zones grâce à la mémoïsation par (noms, position). Évolution : ~0,75 s pour
100 000 caches, surtout par les noms.

Test d'appartenance pair-impair. Les arêtes de chaque zone sont rangées en
bandes horizontales à la première interrogation. Une grille de 1° préfiltre
les rectangles englobants.

## Colonnes de `/api/stats/finds` (format v2)

`zone_country`, `zone_region`, `zone_subregion` : index dans
`dicts.zone_country` (etc.), `-1` = hors carte. Elles sont calculées par
`stats_finds.build_finds_payload`. Si les fichiers de rattachement sont
illisibles, elles sortent toutes à `-1` avec une trace dans le journal, sans
casser la page. `chart_sources.mjs` ne les lit pas encore (lot 3).

Évolution : les colonnes viendront avec la source Évolution des mini-cartes
(lot 3/5). Le rattachement est à faire à l'import, ~3,5 s pour 464 000
caches.

## Calcul partagé (`static/js/zone_model.mjs`)

Module pur (ni DOM, ni OpenLayers, ni ECharts), testé sous Node. La page
Statistiques et la carte l'utilisent toutes les deux : les chiffres sont les
mêmes partout.

**Entrée** : une table de `chart_sources.mjs` (`day`, `endDay`, colonnes
codées par dictionnaire). Les trois colonnes de zones font partie de
`DICT_FIELDS` (`ZONE_FIELDS`) : `findsTable` les lit, et une table qui ne
les a pas (ancien format, autre source) met tout hors carte, sans erreur.
Elles ne sont pas encore des dimensions de graphique (`chart_spec.mjs`), ce
sera le lot 3.

**Mesures** (`normalizeZoneMeasure`) :

| `op` | Valeur d'une zone |
|---|---|
| `count` | nombre de lignes |
| `distinct` + `field` (`cache_type`, `container`, `owner`) | valeurs différentes |
| `dt_coverage` | combinaisons D/T différentes, sur 81 (Labs écartés) |
| `mean` + `field` (`difficulty`, `terrain`) | moyenne, `null` si aucune valeur |
| `first_day` | jour de la première ligne (la « conquête ») |

`mode` : `cumulative` (tout jusqu'au jour) ou `active` (lignes vivantes ce
jour-là, de `day` inclus à `endDay` exclu : la valeur redescend). `active`
ne s'applique pas à `first_day`. `per: 'km2'` (`count`, `distinct`) divise
par la surface : `areas`, prise dans `area_km2` des fichiers d'affichage.

**État** : `createZoneState({ table, level, measure, rows, areas })`.
- `seek(jour)` : état à la fin du jour. En avant, il applique les
  événements suivants ; en arrière, il défait les derniers, ou repart de
  zéro si c'est plus court.
- `values()` : Map id → valeur. Une zone sans ligne est absente (et non à 0).
- `valueOf(id)`, `outside` (lignes hors carte prises en compte),
  `drainChanged()` (zones modifiées depuis l'appel précédent),
  `snapshots(jours)` (mini-cartes), `extent`.
- `rows` : lignes retenues par les filtres de la page.

Les événements sont triés par comptage de jours. Mesures sur 464 000 caches
(mode `active`, 101 zones) : construction ~10 ms, saut de bout en bout
6-16 ms, animation de 9 000 jours ~15 ms en tout. Pas besoin de points de
reprise.

**Échelle** : `zoneScale(valeurs, { mode, classes, thresholds })`, de 2 à 9
classes discrètes. Modes : `quantile` (défaut), `linear`, `log`, `fixed`,
`year` (pour `first_day`). Retour : `breaks`, `classes` effectives,
`classOf(v)`, `ranges()` pour la légende. Des valeurs égales donnent une
seule classe, et aucune classe n'est vide au début. **À calculer sur l'état
final**, pour qu'une teinte garde son sens pendant toute l'animation.

**Moments clés** : `keyMoments(table, { rules, custom, level, rows, max,
milestones, minGapDays })`.
- Règles : `year_end`, `quarter_end`, `milestones`, `new_zone`, `custom`.
  Le dernier jour est toujours présent.
- Priorité : dernier jour, dates libres, paliers, nouvelles zones, fins de
  période.
- Deux moments à moins de `minGapDays` (21) n'en font qu'un : le plus
  prioritaire garde la vignette, l'autre passe dans `also`. Dans une même
  règle, c'est le plus récent qui la garde.
- Au-delà de `max` (12), les moments sont répartis régulièrement.
- Le retour est de la donnée (`kind`, `year`, `value`, `zones`), sans
  libellé : la traduction est faite par l'appelant.

## Limites connues

- **Royaume-Uni** : niveau 1 provisoire en nations (Angleterre, Écosse…). Les
  régions anglaises de Geocaching.com (« London ») ne sont pas reconnues par
  leur nom, et passent par la position.
- **Simplification** : le niveau 2 d'affichage est à ~1,5-2,5 km. Assez pour
  des cartes de synthèse, visible si l'on zoome fort sur une frontière dans
  la carte principale.
- **Natural Earth** : ids parfois étranges pour de très petits pays
  (`VA-X01~`), mais stables.

## Tests

- `tests/test_zones.py` : moteur sur données synthétiques (noms, position,
  plus proche, îlot, hiérarchie, ambiguïtés).
- `tests/test_geo_zones.py` : contrôles génériques de toutes les données,
  points témoins, noms GC réels.
- `tests/test_statistics_page.py` › `FindsPayloadTests` : colonnes de zones.
- `tests/js/zone_model.test.mjs` : mesures, mode `active`, densité, sauts
  aléatoires comparés à un calcul naïf, échelles, moments clés.
