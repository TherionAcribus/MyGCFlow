# Cartes par zones

Colorer des pays, des régions et des sous-régions selon une valeur calculée
sur les caches. Les zones s'affichent en couche animée sur la carte (lot 4)
et en mini-cartes dans la page Statistiques (lot 3).
Plan : `MyGCFlow_Plan_Carte_Zones.md`. Ajouter un pays :
[zones-ajouter-un-pays.md](zones-ajouter-un-pays.md).

État au 2026-11-09 : **lots 1 à 4 livrés**.
- Lot 1 : données, rattachement et colonnes de `/api/stats/finds`.
- Lot 2 : calcul partagé (`zone_model.mjs`).
- Lot 3 : mini-cartes de la page Statistiques. Elles portent sur les
  trouvailles seulement ; Évolution viendra au lot 5.
- Lot 4 : couche animée de la carte « Mes Géocaches » (onglet Zones).
- Lot 5 (première partie, 2026-11-10) : jeux Évolution. Zones stockées dans
  `evolution.db`, mini-cartes des jeux dans Statistiques, couche animée de
  la page Évolution en caches actives.
- Lot 5 (seconde partie, 2026-11-10) : niveau « grille », des cases
  hexagonales calculées partout (Statistiques et couche de la carte). Mes
  poses reste sans couche de zones.

## Niveaux

| Niveau | Clé | Couverture | Source |
|---|---|---|---|
| 0 | `country` | monde (242 pays) | Natural Earth admin-0, 1:50m |
| 1 | `region` | monde | Natural Earth admin-1, 1:10m, sauf pays à recette (FR : IGN ; GB, IE : régions de Geocaching.com) |
| 2 | `subregion` | FR, DE, GB, IE, US | recettes de pays |

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

**Locationless** (`Locationless (Reverse) Cache`) : jamais rattachées.
Geocaching.com leur donne la position ET le pays de son siège (Seattle,
« United States › Washington ») : elles mettaient les États-Unis sur la
carte d'un joueur qui n'y est jamais allé. Hors carte partout
(`zones.is_locationless` dans `annotate_features`, le repli de
`stats_finds.py` et `_ensure_zones` d'Évolution), comme pour l'import GPX
(`bdd._has_usable_coords`) ; écartées du rapport de rattachement (rien à
signaler). `zones.RULES_VERSION` entre dans `data_signature()` : un
changement de règle fait recalculer le cache GeoJSON et les jeux Évolution.

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
| `dt_missing` | combinaisons D/T restant à trouver (81 − couvertes) |
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

## Mini-cartes de la page Statistiques

### Dans la description d'un graphique (`chart_spec.mjs`)

- **Dimensions** `zone_country`, `zone_region`, `zone_subregion`
  (`ZONE_DIMENSIONS`, `dimensionKind` = `zone`), proposées pour la source
  `finds` seulement. Elles ne servent jamais de 2ᵉ dimension.
- **Graphique** `map`, le seul permis avec une zone, et permis seulement
  avec une zone (`allowedCharts`). La présentation est toujours `side` : une
  vignette par période.
- **`view.map`**, présent seulement sur une carte (les autres graphiques
  gardent leur forme) : `scale` (`quantile` / `linear` / `log`), `classes`
  (3 à 7, défaut 5), `frame` (`auto` / `world`), `highlight` (contour des
  zones changées).
- **Mesures** : `count`, `cumulative`, `active`, `distinct` (caches, jours,
  types, propriétaires), `mean` (D ou T), plus deux mesures propres aux
  cartes, `dt_coverage` et `first_day` (`ZONE_ONLY_OPS`). Les records
  datés n'ont pas d'équivalent par zone.
- **`compare.normalize: 'per_km2'`** : densité, affichée par 1 000 km².
- **Période `{ kind: 'moments', rule }`** (`year_end`, `quarter_end`,
  `milestones`, `new_zone`) : carte seulement, et seule dans la liste. La
  normalisation retire une période « moments » d'un autre graphique.

### Calcul (`chart_zones.mjs` › `runZoneQuery`)

`computeResult` (stats_page_cards.js) l'appelle à la place de
`runChartQueries` pour une carte. Le résultat a la forme habituelle :
- `keys` : ids de zones, les plus fortes de la dernière vignette d'abord ;
- une série par vignette, avec `day` (jour lu), `outside` et `changed`
  (zones nouvelles ou modifiées depuis la vignette précédente) ;
- en plus, `zones` : `{ level, countries, scale }`.

« Voir les valeurs », l'export CSV et la présentation marchent donc sans
changement.

Correspondance des mesures (`zoneMeasureOf`) :
- **Portée `all`** (tout jusqu'à la fin de la vignette) : `cumulative` avec
  `from: 'all'`, `active` et `first_day`. Un seul état `zone_model`, déplacé
  d'une vignette à l'autre.
- **Portée `period`** : le reste, sur les lignes de la période (un état par
  vignette).

Vignettes : `expandPeriods` (8 au plus, `MAX_SERIES`), ou `keyMoments` pour
une période « moments ». Une échelle commune est calculée sur toutes les
valeurs de toutes les vignettes. Au niveau 2, un pays sans découpage plus
fin (`fallbackCountries`) montre ses régions : la colonne lue mélange
sous-régions et régions de ces pays.

### Contours (`stats_page_geo.js`)

- **Chargement à la demande** : `index.json`, puis les fichiers des pays
  présents (`result.zones.countries`). Tant qu'il manque quelque chose,
  `zoneMapFor` répond `{ loading: true }` et la carte affiche « Chargement de
  la carte… ».
- **À l'arrivée**, `setGeoListener` incrémente `state.geoRev`. Celui-ci
  entre dans la clé du cache de résultats des cartes et dans le test
  « déjà dessiné ». Cartes, aperçu de l'éditeur et aperçus de la galerie
  (événement `mygcflow:stats-geo`) sont alors redessinés.
- **Composition** (`echarts.registerMap`, nom `mgz-<hash>`, cache de 40
  cartes) :
  - les zones dont le rectangle touche le cadre, plus une marge de 4 %. Les
    autres déborderaient sur les vignettes voisines : ECharts ne découpe pas
    une `geo` ;
  - les encarts (Outre-mer, Alaska, Hawaï), déplacés sous le cadre
    seulement quand le même pays a aussi des données hors encarts. Leur
    taille vaut 18 % du plus petit côté du pays, agrandis 2,5 fois au plus.
- **`aspectScale`** = cos(latitude du milieu du cadre) : la France n'est pas
  écrasée.
- **Place de chaque vignette en pixels** (`mapCellBoxes`, chart_echarts.mjs) :
  une `geo` à qui l'on donne une boîte complète (gauche, haut, largeur,
  hauteur) s'étire pour la remplir, quelles que soient ses proportions —
  pays aplati dans une tuile large, allongé dans une tuile haute. La
  vignette prend donc la plus grande taille qui tient dans sa case aux
  proportions du cadre (`mapAspect` : largeur × `aspectScale` / hauteur),
  centrée. Il faut la hauteur réelle du graphique (`ctx.height`, passée
  par les tuiles, l'aperçu, la présentation, l'export, la galerie et la
  vidéo) ; une tuile redimensionnée est redessinée (`data-map-size`,
  `onHostsResized`). Sans hauteur connue, repli sur la boîte en %. Le
  monde vide a aussi un cadre (`composeEmpty`), sans quoi ses proportions
  seraient inconnues. Test E2E : `stats-zones.spec.mjs` › bonnes
  proportions (vue ECharts comparée au cadre, deux largeurs de fenêtre).
- **Noms** (`zoneName`, langue de la page) et **surfaces** (`zoneAreas`)
  viennent des fichiers chargés.

### Rendu (`chart_echarts.mjs` › `mapOption`)

- Une `geo` et une série `map` par vignette, dans une seule instance
  ECharts.
- `visualMap` `piecewise` commun, légende de `zoneLegend` (classes entières
  « 4–7 », années, ou intervalles avec l'unité sur la dernière classe).
- Contour des zones changées par `geo.regions`.
- Titre de vignette : « départements : 41 · Trouvailles : 312 ».
- Infobulle : nom, valeur, rang, écart avec la vignette précédente.
- `mapHeight` : la carte du tableau s'allonge avec le nombre de rangées de
  vignettes.

### Lien vers la carte

Un clic sur une zone (`clickTarget`, puis `confirmZoneLink` dans
stats_page_links.js) ouvre `/?at=AAAA-MM-JJ&bbox=o,s,e,n`, ou
`/evolution?…` pour une source Évolution. Côté carte, `init.js` ›
`applyEntryLink` tente `startPausedPreview` toutes les 250 ms (les données
arrivent après `mygcflowReady`, 20 s au plus), puis `seekAnimationToDate`
et `fitMapView`. Les paramètres quittent l'adresse aussitôt. Relevé :
`window.mygcflowEntryLink`.

### Questions toutes faites (groupe « Mes cartes »)

Ma conquête (`first_day`), Mes zones année par année (moments `year_end`),
Mes zones à chaque palier (`milestones`), Ma carte du monde, Types de
caches par région, Grille D/T par région.

### Tests

- `tests/js/chart_zones.test.mjs` : règles de la description, calcul,
  options ECharts, libellés.
- `tests/e2e/stats-zones.spec.mjs` : contours chargés et vignettes, encart
  de La Réunion, éditeur, lien vers la carte en pause. Les trouvailles y
  sont servies par `page.route` (jeu synthétique sur trois pays). Relevé :
  `getStatsPageSnapshot().cards[].zones`.

## Couche de la carte (« Mes Géocaches », onglet Zones)

**Ids de zones dans les points** : `bdd.create_geojson` appelle
`zones.annotate_features`, qui pose `zone_country`, `zone_region` et
`zone_subregion` dans les propriétés de chaque point (trouvailles et
étapes Lab). Le cache GeoJSON persisté est passé en version 3
(`geojson_cache.PERSIST_VERSION`) : une ancienne base est reconstruite
une fois. `stats_finds` réutilise ces propriétés au lieu de refaire le
rattachement.

**Réglages** :
- `zones_display` : préférence globale (AppSettings, `GET/PUT
  /api/settings`), coupée par défaut. Interrupteur de l'onglet, enregistré
  tout de suite.
- Bloc `zones` du thème (`ZoneLayerOptions` ↔ `pkg.options.zones`,
  `zone_layer_model.mjs`) : `level`, `measure` (`count`,
  `distinct_types`, `dt_coverage`, `dt_missing`, `first_day`, `found_share`), `per_km2`,
  `compare_date`, `scale`, `classes` (3 à 7), `color`, `opacity` (20 à 85 %), `outline`,
  `glow`, `legend`, `legend_position`. Défauts identiques dans
  `settings_manager.py`, `defaultValues.json` et le module (vérifié par
  les tests). Le suivi « thème modifié » écoute aussi l'onglet `#zones`
  (profiles.js).
- `per_km2` (« Par km² », case sous la mesure) : densité — la valeur
  divisée par la surface de la zone (`areas` : `zoneProps(id).area_km2`,
  relue à chaque valeur car les contours arrivent après le modèle ; en
  grille, `cellArea`). Appliquée seulement aux mesures qui se comptent
  (`count`, `distinct_types`) ; pour les autres, l'option reste cochée
  mais sans effet — l'utilisateur la retrouve en revenant à un décompte
  (`densityOf` de `zone_layer.js`).
  Valeurs et libellés affichés **pour 1 000 km²**, même convention que la
  normalisation `per_km2` des mini-cartes Statistiques — la case de
  l'onglet réutilise le libellé « Par km² (densité) » des panneaux.
- `compare_date` (« Comparer à une date », champ `AAAA-MM-JJ` vide = off) :
  la valeur montrée devient l'écart `valeur(jour) − valeur(référence)` —
  la palette est **divergente** (`compareClassColors` : rouge sous zéro,
  teinte choisie au-dessus, clair vers zéro), les zones inchangées ne sont
  pas colorées ni dans l'échelle ni dans la légende (libellés signés
  « +3 », « −2 »). La référence est un instantané `state.seek(compare)`
  (`compareMap`), recalculé avec l'échelle ; une zone vidée depuis la
  référence garde un écart négatif (union des deux états dans `showDay`).
  Sans effet pour `first_day` (champ masqué, un écart de dates ne veut
  rien dire) ni `dt_missing` (masqué aussi : une progression serait un
  écart négatif, rouge — contre-sens) ; marche pour les comptes, la
  couverture D/T, la densité et la part trouvée (écart en points).
- `dt_missing` (« Les combinaisons D/T manquantes », préréglage «
  Objectif : D/T à compléter ») : lecture « ce qui reste à faire » —
  81 − combinaisons couvertes, zones jamais visitées non colorées (pas de
  ligne). La fiche de `dt_coverage` rappelle le complément (« Il en
  manque ${n} »).
- `solo` (« Zones seules », carte Apparence) : les autres couches de la
  carte — trouvailles, caches posées, DNF, trajet et sa tête, flashs —
  sont masquées pour lire la carte colorée seule. `zonesOnly()` de
  `zone_layer.js` (option + couche de zones effectivement visible) est
  le prédicat ; `syncSoloLayers()` de `mapgl.js` applique la visibilité,
  rappelé à chaque état de la couche (`prepare`, repeinture d'apparence)
  et respecté par `setTrailLayersVisible` : l'aperçu du trajet repart
  masqué sous le mode solo. Rien n'est détruit — décocher réaffiche.
- Réduction des mouvements : quand le système demande
  `prefers-reduced-motion`, `advanceTo` ne crée ni fondu ni éclat — les
  zones changent de classe d'un coup (`reducedMotion()` de
  `zone_layer.js`, qui lit `pkg.prefersReducedMotion` de `mapgl.js`).
  Comme le dynamisme caméra, les enregistrements sont exemptés
  (`pkg.isRecordingActive`) : la vidéo produite est identique quel que
  soit le poste.
- `Exporter la carte en image` (bouton de la carte Apparence) :
  `exportMapImage()` de `mapgl.js` télécharge un PNG de la carte telle
  qu'affichée — canevas des couches visibles, légende des zones, panneaux
  et habillage composés comme pour la vidéo (`addZoneLegendToCanvas`,
  `addStatsPanelsToCanvas`, `addImagePanelsToCanvas`,
  `addOverlaysToCanvas`). `beginHighResCapture`/`endHighResCapture`
  encadrent la composition : le fichier est plus net que l'écran et l'état
  de la carte est restauré même en cas d'échec ; le jour capturé est celui
  affiché (en pause, le jour de pause — pas la fin). En « Zones seules »,
  l'image est épurée puisque les autres couches sont déjà masquées.

**Fichiers** :
- `zone_layer_model.mjs` (pur) : options, conversions thème ↔ options,
  couleurs (rampe du blanc mêlé à la teinte choisie), fondus, légende.
- `zone_layer.js` : couche OpenLayers et cycle de vie. Un changement de
  réglage conserve le jour affiché (en pause ou en lecture, la couche ne
  saute pas au jour de fin) ; `refreshZoneLayerAppearance` repeint seul
  pour les réglages qui ne changent ni données ni échelle (couleur,
  opacité, contours, lueur, légende).
- `zone_layer_ui.js` : onglet (réglages structurels → `refreshZoneLayer`,
  apparence → `refreshZoneLayerAppearance`). L'onglet est en deux cartes :
  « Données et mesure » (découpage, mesure, jeu Évolution, préréglages —
  lots `ZONE_PRESETS` posés d'un coup —, échelle et nuances repliées dans
  `#zonesAdvanced`) et « Apparence » (couleur, opacité, contours, lueur,
  légende, bouton « Sauvegarder le thème » qui appelle
  `profileManager.saveCurrentAsProfile`, comme dans l'onglet Style). Le
  périmètre des données de la mesure choisie est rappelé sous « Couleur
  selon » (`#zonesScopeHint` : trouvailles filtrées vs jeu Évolution
  entier), la case « Par km² » (`#zonesPerKm2Row`) n'apparaît que pour les
  mesures qui se comptent. Le bouton « Réessayer » (`#btnZonesRetry`) apparaît sur les
  erreurs de chargement : `retryZoneLayer` relance les contours en échec
  (`retryZoneGeo` : l'échec du catalogue ou d'un fichier était mémorisé
  pour la page) et les entrées `found_share`/`finds` en erreur. La liste
  des jeux est relue à la réouverture de l'onglet ; son échec
  (`datasetsError`) est distingué de « aucun jeu ».
- `zone_geo.js` : contours, partagés avec la page Statistiques.
- `templates/menu_zones.html` : onglet des deux pages (variantes via
  `mode == 'evolution'` : pas de choix de jeu, mesures en « caches »).

**Calcul** : la couche relit l'index des points (`pointsByDate` et
`hiddenPointsByDate`), en fait une table (`tableFromRecords`) puis un
état `zone_model`. Au niveau 2, la colonne est mêlée aux régions des pays
sans découpage fin (`chart_zones.mixedZoneTable`, comme les mini-cartes).
L'état est recalculé quand `pointsByDateRevision`, le niveau ou la mesure
change. Hors animation, `updateZoneLayer` (appelé à chaque rendu) voit une
révision nouvelle et relance le calcul 300 ms plus tard : l'index bouge
plusieurs fois par rechargement. L'échelle est calculée sur le jour de fin
(`options.animation.dateEnd`, sinon la dernière trouvaille).

**Branchements dans mapgl.js**, aux mêmes endroits que les panneaux Stats :

| Moment | Fonction | Effet |
|---|---|---|
| Départ (aperçu, deux pipelines vidéo) | `resetZonesForAnimation({ startDate })` | état de la veille du départ, sans fondu |
| Lot de jours affichés | `accumulateZonesForDates(dates, now)` | les zones qui changent de classe passent en fondu (600 ms, horloge des points) |
| Saut de la barre de chronologie | `seekZonesToDate(day)` | état du jour, sans fondu |
| Arrêt (`showRestInfos`) | `showZonesRest()` | état final |
| Chaque rendu (`updatePointAppearClock`) | `updateZoneLayer(now)` | fondus en cours : la frame suivante est demandée, et `mapDirtyTracker` empêche MediaRecorder d'en sauter une ; fin naturelle de l'aperçu détectée par `isAnimationInProgress` |
| Signature de contenu MediaRecorder | `getZoneLayerRevision()` | une légende ou un fondu sur carte immobile produit des frames |
| Peinture vidéo (deux pipelines) | `addZoneLegendToCanvas(ctx, w, h, échelle)` | légende, sous les panneaux Stats |

**Rendu** :
- `ol.layer.Vector`, `zIndex` 500 (sous le trait, les points et les
  flashs), features du niveau pour les pays présents, en EPSG:3857.
- Style par classe, mis en cache. Pendant un fondu, couleur mêlée ; une
  zone qui monte de classe voit son contour s'allumer puis s'éteindre
  (`glow`).
- Une zone sans valeur n'a que sa frontière (si `outline`).
- **Légende** : canvas `#zoneLegend` dans `#mapWithFrames` (z-index 89).
  Le même dessin est repeint dans chaque image de la vidéo, au même coin et
  aux mêmes marges, multipliés par l'échelle. L'échelle étant celle de
  l'état final, les classes extrêmes affichent des bornes ouvertes
  (« ≤ 2 », « ≥ 3 », « < 12 % », « ≥ 55 % ») : des valeurs plus basses
  (cumul qui démarre) ou plus fortes (caches actives qui redescendent) y
  tombent pendant l'animation.

**Fiche de zone au clic** : `zonePopupAt(pixel)` décrit la zone sous le
clic — nom (`zoneName`, ou libellé de case pour la grille), date du jour
montré (`shownDay` : jour courant en pause, jour de fin au repos), valeur
de la mesure active et détail (comptes `[trouvées, base]` de la part
trouvée). `inspectZoneAt` (mapgl.js) la montre dans la popup `#gcPopup`,
après les points et l'étape de trajet qui gardent la priorité. Au repos
comme en pause — la boucle rAF étant arrêtée dans les deux cas,
`isIdleState` laisse passer les clics. Une zone sans valeur affiche
« Aucune trouvaille à ce jour ».

**Relevé E2E** : `getZoneLayerDebugState()` donne `status` (`off`,
`loading`, `ready`, `error`, `empty`), `visible`, `features`, `values`,
`classes`, `day`, `animating`, `fading`, `scale`, `legend` et `revision`.

**Tests** :
- `tests/js/zone_layer_model.test.mjs` ;
- `tests/test_zone_layer_settings.py` ;
- `tests/test_zones.py` (`annotate_features`) ;
- `tests/e2e/zone-layer.spec.mjs` : fixture `my-finds-zones.gpx`, 8
  trouvailles sur 4 départements.

## Grille de cases

`static/js/zone_grid.mjs` (pur) : hexagones « pointe en haut » dans une
projection locale équirectangulaire autour de `lat0` (médiane des latitudes
des données, arrondie à 5°, bornée à ±70° — `gridReference`). Sur la page
principale, `zone_layer.js` impose la médiane du jeu **complet**
(`stableGridLat0`, lue sur `pkg.baseGeojson`, mémoïsée tant que l'objet
n'est pas remplacé) : un filtre ne décale pas les cases — sans cela la
médiane de la sélection du moment ferait bouger toute la grille, l'id de
chaque case portant `lat0`. La page Évolution et les tables Statistiques
gardent la médiane de leur propre univers (déjà stable).
- **Tailles** : 5, 10, 25 (défaut), 50 ou 100 km entre deux centres
  (`GRID_SIZES`).
- **Id d'une case** : `h<taille>/<lat0>/<q>/<r>`. Deux grilles ne mélangent
  jamais leurs cases.
- **Fonctions** :
  - `cellOf(lon, lat, taille, lat0)` ;
  - `cellRing` (contour lon/lat) et `cellCenter` ;
  - `cellArea` (km² réels, corrigés par cos(lat)/cos(lat0)) ;
  - `cellLabel` (« 47,2° N · 1,5° O ») ;
  - `withGridColumn(table, taille, { lat0 })`, qui ajoute la colonne
    `zone_grid` à une table qui porte `lat` et `lon` (`lat0` nul =
    référence calculée sur la table).

**Coordonnées dans les tables** :
- `/api/stats/finds` v3 envoie `lat` et `lon` (5 décimales, null sans
  position) ;
- `findsTable`, `tableFromRecords` et `evolutionTable` remplissent
  `table.lat` et `table.lon` (NaN sans position).

**Statistiques** :
- dimension `zone_grid` (« sur une grille de cases »), taille dans
  `view.map.gridSize` ;
- l'éditeur affiche la taille dans la phrase quand le regroupement est la
  grille, et l'échelle et les nuances de toute carte dans « Options
  d'affichage » ;
- densité : surface calculée de chaque case ;
- `stats_page_geo.js` › `composeGrid` dessine les cases avec, dessous et
  sans couleur, les régions des pays présents (repères).

**Couche de la carte** :
- niveau `grid` et `grid_size` dans le thème (`ZoneLayerOptions`,
  `pkg.options.zones.gridSize`) ;
- les cases ayant des données deviennent des features OpenLayers
  (`ensureGridFeatures`) ;
- coordonnées lues dans les points (« Mes Géocaches ») ou la base
  (Évolution, `evolutionZoneTable` › `lat`/`lon`).

**Tests** :
- `tests/js/zone_grid.test.mjs` ;
- `tests/e2e/stats-zones.spec.mjs` › grille ;
- `tests/e2e/zone-layer.spec.mjs` (passage au niveau grille, changement de
  taille).

## Jeux Évolution

**Stockage** (`evolution_store.py`, schéma v2) :
- colonnes `zone_country`, `zone_region` et `zone_subregion` par cache :
  `''` = hors carte, `NULL` = à calculer ;
- `datasets.zones_signature` = empreinte des données de zones ayant servi
  (`zones.data_signature()`, sha1 de `geo/match/*.json.gz`).

`_ensure_zones`, appelé par `load_payload`, rattache les caches à `NULL`, ou
tout le jeu si l'empreinte a changé (nouvelles données de zones). Les noms du
CSV (pays, région, département) passent d'abord, la position ensuite. Un
import qui met une cache à jour remet ses zones à `NULL` (`_UPSERT`). Une
v1 est migrée par `ALTER TABLE` à l'ouverture.

Mesuré sur un jeu de 464 475 caches (France) :
- premier affichage : 9,9 s au lieu de 3,9, une seule fois ;
- affichages suivants : 3,9 s ;
- résultat : 97 départements, 20 caches hors carte au niveau 2.

**Format des données** (`PAYLOAD_VERSION` 3) :
- `zone_country`, `zone_region`, `zone_subregion` (index) et
  `zone_countries`, `zone_regions`, `zone_subregions` (libellés, `''` =
  hors carte) ;
- l'ETag de `/api/evolution/datasets/<id>/data` porte aussi l'empreinte des
  zones.

**Statistiques** :
- les dimensions `zone_*` sont proposées pour les jeux Évolution ;
- `evolutionTables` lit les colonnes (`EVO_DICTS`) ;
- une carte des caches actives (`measure.op: 'active'`) passe par le mode
  `active` de `zone_model`, et une zone pâlit après des archivages ;
- questions du groupe « Cartes de la zone » : Caches actives année par
  année, Densité des caches actives.

**Couche de la page Évolution** :
- **Données** : `zone_layer.js` lit `evolutionZoneTable()`
  (evolution_data.js), la sélection filtrée du jeu ouvert au format des
  tables de chart_sources (jours absolus, `endDay` = archivage). Elle est
  mémorisée par révision de la sélection.
- **Mesures** : toutes en mode `active`, sauf « première cache posée »
  (cumul).
- **Préférence d'affichage** : `evolution_zones_display` (globale). Le
  thème Évolution a son propre bloc `zones`.
- **Branchements** (moteur de cycle de vie, mapgl.js) :
  - départ dans `beginLifecycleTimeline` (les trois démarrages et le saut) ;
  - lot de jours dans `displayLifecycleDates` ;
  - repos dans `showLifecycleRestState` ;
  - saut (`seekZonesToDate`) commun aux deux pages.
- **Jour de référence de l'échelle** : `restDay` du jeu (fin de
  l'animation).

**Tests** :
- `tests/test_evolution_store.py` › `ZonesTests` (colonnes, recalcul après
  import, nouvelle empreinte, migration v1) ;
- `tests/js/chart_zones.test.mjs` (carte des caches actives qui
  redescend) ;
- `tests/e2e/zone-layer.spec.mjs` › Évolution (fixture `evolution-a.csv` :
  le Finistère pâlit le 6 janvier 2020).

## Part trouvée (croisement Évolution × mes trouvailles)

Mesure `found_share` : la part des caches d'un jeu Évolution que j'ai
trouvées, zone par zone. Jointure par code GC (les étapes Lab n'en ont pas).

**Règles** (`zone_model.mjs` › `shareEventsOfTable`, `zone_share.py`,
identiques et testées des deux côtés) :
- une cache trouvée compte au numérateur à partir de ma **première**
  trouvaille, ou de son apparition dans le jeu si l'export la date après ;
- **base `active`** (défaut, tranché au lot 6) : caches actives à la date.
  Une cache trouvée puis archivée sort des deux comptes : la part ne dépasse
  jamais 100 %. Trouvée après son archivage (dates d'export décalées) : jamais
  comptée au numérateur ;
- **base `all`** : toutes les caches apparues jusqu'à la date, archivées
  comprises ;
- valeur en pourcentage ; une zone sans cache dans la base n'a pas de
  valeur, une zone sans trouvaille vaut 0 % ;
- **échelle fixe 0–100 %** (`zone_model.mjs` › `shareScaleThresholds`,
  mode `fixed`) : seuils ronds et symétriques autour de 50 selon le nombre
  de nuances (`[20, 40, 60, 80]` pour 5), partagés par la carte et les
  mini-cartes — une même part donne la même teinte, quelles que soient les
  valeurs du moment. Le réglage « Échelle des couleurs » est sans effet et
  grisé, comme pour une date.

**Format des événements** (agrégés par jour et par zone, triés par jour) :
`day`, `zone` (indice dans `ids`, -1 = hors carte), `placed`, `archived`,
`found`, `lost`. `createShareState({ ids, events, base })` a la même
interface que `createZoneState`, plus `parts(id)` → `[trouvées, base]` et
`totals()`.

**Statistiques** :
- `measure: { op: 'found_share', base?: 'all' }`, seulement pour les caches
  publiées d'un jeu Évolution, seulement en carte (`ZONE_ONLY_OPS`) ;
- `computeResult` passe `found` = `foundDaysOf(tableOf('finds'))` (code →
  jour de la première trouvaille) ;
- les moments clés viennent de mes trouvailles dans le jeu
  (`foundRowsTable`) : pas de vignettes à 0 % avant ma première. La dernière
  vignette reste la fin du jeu (les archivages suivants changent encore la
  part) ;
- infobulle « N sur M caches », sous-titre des vignettes = part sur tout le
  jeu, légende en % ;
- questions « Ma couverture » et « Ma couverture, année par année » (groupe
  « Cartes de la zone »).

**Carte « Mes Géocaches »** : le jeu se choisit dans l'onglet Zones
(`zones.share_dataset`, thème ; `share_base`). La page ne charge pas les
caches du jeu : `GET /api/stats/found_share?dataset=&level=&grid=` renvoie
les événements agrégés, avec un ETag (jeu, révision, trouvailles, niveau,
taille de case, empreinte des zones) et un cache en mémoire de 6 charges.
Les filtres de la carte ne s'appliquent pas : la part compare toutes mes
trouvailles au jeu entier. Au niveau 2, un pays sans niveau 2 passe à ses
régions (comme `mixedZoneTable`). Grille : cases calculées par le serveur
(`zone_share.grid_cell`, même calcul que `cellOf`, latitude de référence
tirée du jeu) ; le client ne fait que dessiner les ids reçus.

Mesuré sur 464 475 caches (France), 20 000 trouvailles : lecture de la base
1,1 s, puis départements 1,9 s / 316 Ko compressés, grille 25 km 3 s /
665 Ko. Une fois par version des données.

**Carte « Évolution »** : la sélection filtrée du jeu ouvert est croisée dans
la page avec mes trouvailles (`GET /api/stats/finds`, chargé une fois).

**États de la couche** (`getZoneLayerDebugState().status`) : `no-dataset`
(aucun jeu choisi), `missing` (jeu supprimé), `loading`, `error`. Le relevé
donne aussi `parts`.

**Tests** : `tests/js/zone_share.test.mjs`, `tests/test_zone_share.py`
(mêmes cas, cases de grille identiques au navigateur, route),
`tests/e2e/zone-layer.spec.mjs` › part trouvée (fixture
`evolution-share.csv`, dont les codes croisent `my-finds-zones.gpx`).

## Rapport de rattachement (onglet Zones)

Carte « Noms reconnus » de l'onglet Zones : les noms de Geocaching.com que les
données de zones ne reconnaissent pas, pour mes trouvailles (« Mes
Géocaches ») ou pour le jeu ouvert (« Évolution »).

- **Calcul** (`zone_report.py`, `GET /api/zones/report?source=finds` ou
  `?source=evolution&dataset=<id>`) : lignes regroupées par noms bruts et zones
  retenues (un `GROUP BY` pour un jeu Évolution, ~1 s pour 464 000 caches,
  rattachement compris). Chaque nom distinct passe par `ZoneIndex.assign`
  **sans position** : seuls les noms parlent. Un niveau est « non reconnu »
  quand son nom est donné, que le niveau existe dans le pays, et que le nom
  ne donne pas la zone (une région déduite du département ne compte pas
  comme reconnue). Le pays de contexte : celui du nom, sinon celui de la
  position.
- **Réponse** : `unrecognized` (`level`, `country`, `country_name`, `name`,
  `count`, `zones` = les 3 zones où la position les a placés, `null` = hors
  carte), `outside` (lignes hors carte par niveau, seulement là où le niveau
  existe), `total`, `signature` des données de zones, `app_version`.
- **Onglet** (`zone_report_ui.js`) : rechargé à chaque ouverture de l'onglet
  et quand un autre jeu Évolution s'ouvre. « Copier le rapport » copie un
  texte à coller dans le formulaire d'issue `.github/ISSUE_TEMPLATE/zones.yml`
  (lien « Demander un pays ou un nom »). Relevé E2E :
  `getZoneReportSnapshot()`.
- Sur les 24 365 trouvailles de développement : tout est reconnu depuis la
  recette du Royaume-Uni (« London », 53, était le seul nom inconnu) ; 9
  trouvailles hors carte au niveau 2 (mystères).

**Tests** : `tests/test_zone_report.py` (vraies données de zones, route),
`tests/e2e/zone-layer.spec.mjs` › rapport de rattachement.

## Limites connues

- **Résumé textuel accessible** propre aux cartes pas encore fait :
  `aria` d'ECharts seulement.
- **Vidéo animée d'un graphique et panneau vidéo** : sans objet pour une
  carte de Statistiques. La couche de la carte principale joue ce rôle.
- **Couche de la carte** :
  - pages « Mes Géocaches » et « Évolution » ; Mes poses n'en a pas ;
  - simplification d'affichage de 1,5 à 2,5 km, visible en zoomant fort sur
    une frontière ;
  - pendant les fondus, tout le calque est redessiné à chaque image, ce
    qui reste à mesurer avec les 3 144 comtés américains ;
  - les petits départements (Paris) sont couverts par leurs points aux
    échelles nationales.

- **Irlande du Nord** : Geocaching.com la range dans « Ireland › Ulster »,
  et la recette `IE.json` fait de même (province d'Ulster, districts
  `IE-belfast`…). Le niveau 0 reste celui de Natural Earth : sur une carte
  des pays, l'Irlande du Nord est dessinée dans le Royaume-Uni, et un point
  d'Irlande du Nord rattaché par la seule position (sans nom de GC) tombe au
  Royaume-Uni, sans région.
- **Royaume-Uni, Stockton-on-Tees** : l'autorité unitaire est entière dans
  County Durham, alors que sa partie sud (Thornaby, Yarm) est dans le comté
  de North Yorkshire. Une trouvaille « Yorkshire » y est placée dans le
  comté de North Yorkshire le plus proche (règle des 5 km).
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
