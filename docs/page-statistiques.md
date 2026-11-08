# Page Statistiques

Quatrième page de l'application (`/stats`), à côté de « Mes Géocaches »,
« Évolution » et « Mes poses » : des tableaux de bord de graphiques, sans
carte. Plan, décisions et lots : `MyGCFlow_Plan_Statistiques.md` (section 0
= état d'avancement).

À ne pas confondre avec les **panneaux Stats** (`docs/panneaux-stats.md`),
incrustés sur la carte et dans la vidéo.

## État

- Lot 0 (2026-11-08) : page servie, lien dans l'en-tête des quatre pages,
  ECharts vendoré, format d'un graphique (`chart_spec.mjs`) figé en v1.
- Lot 1 (2026-11-08) : trouvailles de « Mes Géocaches », moteur de calcul,
  barres / courbe / aire / anneau / chiffre clé, un tableau de bord
  enregistré, période globale, galerie de 15 questions, éditeur en phrase,
  export PNG.
- Lot 2 (2026-11-08) : comparer — périodes relatives (en cours,
  précédente, celle du tableau de bord), plusieurs périodes par graphique,
  superposées / côte à côte / en écart, alignement, « à date »,
  pourcentage ou par jour, case en cours repérée, 7 questions de
  comparaison, galerie par sections.

## Parcours des données

```
GET /api/stats/finds      stats_finds.py : jeu de base du cache GeoJSON → colonnes
        │
findsTable()              chart_sources.mjs : table d'événements (numéros de jour…)
        │
runChartQuery()           chart_query.mjs : filtres → périodes → regroupement → mesure
        │                   (périodes déployées par chart_periods.mjs)
buildChartOption()        chart_echarts.mjs : options ECharts (null pour le chiffre clé)
        │
stats_page.js             câblage DOM : cartes, éditeur, galerie, sauvegarde
```

Tout le calcul est côté navigateur, dans des modules purs testés sous Node.
Le serveur ne fait que servir les colonnes et le fichier des tableaux de bord.

## Fichiers

| Fichier | Rôle |
|---|---|
| `blueprints/statistics.py` | `/stats`, `GET /api/stats/finds`, `GET/PUT/DELETE /api/dashboards` |
| `stats_finds.py` | Trouvailles en colonnes (chaînes codées par dictionnaire, ETag) |
| `dashboards_store.py` | `dashboards.json` dans le répertoire de config : forme, version, taille ≤ 1 Mo |
| `templates/stats_page.html` | Gabarit : barre, grille, galerie, éditeur, renommage |
| `templates/_app_header.html` | En-tête commun aux quatre pages (lien actif selon `mode`) |
| `static/js/stats_page.js` | Point d'entrée et câblage DOM |
| `static/js/app_quit.js` | « Quitter » (sorti de ui.js, partagé avec les pages carte) |
| `static/js/chart_spec.mjs` | Format versionné d'un graphique, normalisation, compatibilités |
| `static/js/chart_sources.mjs` | Colonnes du serveur → table d'événements |
| `static/js/chart_periods.mjs` | Périodes → intervalles de jours (« aujourd'hui » passé par l'appelant) |
| `static/js/chart_query.mjs` | Moteur : jeu de séries |
| `static/js/chart_labels.mjs` | Libellés (traduction et locale injectées) |
| `static/js/chart_echarts.mjs` | Adaptateur ECharts |
| `static/js/dashboard_model.mjs` | Document des tableaux de bord, héritage, questions |
| `static/css/stats_page.css` | Mise en page et palette des graphiques |
| `static/vendor/echarts/` | ECharts 6.1.0 + `langFR.js` (+ LICENSE, NOTICE) |

## Page sans carte

`stats_page.html` ne charge ni OpenLayers ni `index.js` : le graphe de la
page carte évalue `ui.js`, qui initialise toute l'interface carte pendant
son évaluation. Le point d'entrée n'importe que des modules autonomes
(`theme.js`, `app_quit.js`, `notifications.js`, `ui_bootstrap.js`,
`saved_indicator.mjs`) et des modules purs. Feuilles chargées : Tabler,
icônes, `ui_improvements.css` (en-tête, indicateur « Enregistré »),
`theme.css`, `tabler_theme.css`, `stats_page.css`.

Le `<body>` porte `data-page="stats"` et **pas** `data-mode` : les
prédicats d'`app_mode.mjs` ne concernent que les trois pages carte.

## Format d'un graphique (`chart_spec.mjs`)

Objet JSON versionné (`v: 1`) que toute l'interface édite ; exemple et
vocabulaire en tête du module, détail dans le plan (§ 2).

- `normalizeChartSpec(raw)` rend **toujours** une description utilisable
  (valeur inconnue → défaut, combinaison impossible → réparée), sauf pour une
  version future : `null`.
- `filters: null` / `periods: null` = hérités du tableau de bord
  (`effectiveQueryOptions`, dashboard_model.mjs) ; un objet ou une liste =
  propres au graphique.
- Compatibilités : `allowedGroupBy(measure)` (un cumul suit le temps),
  `allowedSplitBy`, `allowedAligns`, `allowedCharts` (le premier sert de
  repli). L'éditeur n'offre que les graphiques du lot 1 (`LOT1_CHARTS`).
- Pas de dimension « heure » : l'import GPX pose une heure factice
  (19 h / 20 h UTC).
- **8 séries au plus** (`MAX_SERIES`) : la taille de la palette
  catégorielle. Au-delà, « Autres ». Un anneau a au plus 7 parts nommées
  + « Autres ».

## Moteur (`chart_query.mjs`)

- Dates en **numéros de jour** (jours depuis 1970, UTC) : pas de fuseau.
  « Aujourd'hui » vient de `todayDay()` (jour local).
- Clés : nombres pour le temps (`year` 2024, `quarter` 20242, `month`
  202403, `week` = lundi, `day`), les dimensions cycliques
  (`day_of_year` sur 366 cases, 29 février = 60), l'âge et l'année de
  publication ; chaînes pour les catégories ; tableau pour les attributs
  (une trouvaille compte dans chaque attribut porté). Valeur manquante →
  `UNKNOWN_KEY`, toujours en fin d'axe ; regroupement → `OTHERS_KEY`.
- Axe : continu pour le temps (trous à zéro, jours futurs et hors période à
  `null`), domaine complet pour les cycliques, D/T et âge ; catégories triées
  par nombre, `view.top` premières + « Autres » (sauf D/T, âge, année de
  publication : domaine fixe).
- Filtres : valeurs d'un champ en « ou », champs en « et », attributs tous
  requis (comme la carte, `matchesAttributes`).
- Cumul : depuis le début de la période, ou depuis toujours
  (`measure.from: 'all'`, lignes filtrées antérieures ajoutées au départ).

## Comparer des périodes (lot 2)

**Périodes relatives** (`chart_spec.mjs`, résolues par `chart_periods.mjs`) :
`current` (année ou mois en cours, suit le calendrier), `previous` (la
période juste avant l'entrée qui la précède : 2025 avant 2026, les 12 mois
avant les 12 derniers — nommée « Les 12 mois précédents »), `dashboard`
(la période du tableau de bord quand le graphique la compare :
`[dashboard, previous]` suit le menu global ; `[dashboard]` seul se
normalise en `null`). Chaque entrée déployée porte `as` (ce qu'elle est,
pour la nommer), `step` (pas d'un décalage), `ongoing`, `fullTo`.

**Moteur** (`runChartQuery`) :
- `toDate` : avec plusieurs périodes dont une en cours, les autres sont
  coupées au même point (`toDateCut` : même jour du calendrier pour des
  années ou des mois, sinon même nombre de jours ; 29 février → 28).
  `result.toDate`, `entry.cut` ; note sous la carte.
- `align` : `calendar` (clés communes : catégories, mois de l'année…),
  `absolute` (vraies dates), `elapsed` (rang depuis le début de chaque
  période : `ELAPSED_UNITS`, clés 0…n-1, `series.dates` = vrai premier jour
  de chaque case pour l'infobulle). Une seule période : toujours dates
  réelles. Le jour de la semaine n'a que `calendar`.
- Cases sans valeur : hors période, au-delà de la coupe, à venir ; sur une
  dimension cyclique, seulement si la période tient dans une année civile
  (sinon pas de dates). 29 février d'une année ordinaire : `null`, sauf
  pour un cumul (valeur de la veille).
- `series.partial` : case incomplète (période en cours ou coupée).
- `normalize` (`allowedNormalize`) : `percent` (total de la série ; d'un
  cumul : sa valeur finale) pour les comptes, valeurs distinctes et
  cumuls ; `per_day` (jours écoulés de la période) pour les comptes et
  caches distinctes sans axe de temps.
- `layout: 'delta'` (`allowedLayouts` : deux périodes fixes, pas de
  2ᵉ dimension, ni anneau) : `delta.values` = première − seconde,
  `delta.ratios` en proportion de la seconde.

**Rendu** : `side` = un repère ECharts par période (au plus 4 par ligne),
même maximum d'axe, titre par repère ; anneaux côte à côte (un anneau ne
se superpose pas : `side` imposé) avec une teinte par catégorie stable
d'un anneau à l'autre (`keyColors`) ; écart = barres `--chart-up` (bleu)
au-dessus de zéro, `--chart-down` (rouge) en dessous, signe toujours
écrit, infobulle avec les deux valeurs. Case incomplète : barre atténuée à
bord en tirets. Séries nommées « 2026 (en cours) », « 2025 (au 8 nov.) ».
Chiffre clé : une valeur par période, la première avec l'écart
(« +60 (+25 %) par rapport aux 12 mois précédents », flèche colorée,
texte neutre).

**Éditeur** : « sur [période] comparé à [la période précédente] [×] /
+ Comparer à une autre période » (lignes en `display: contents` dans la
grille de la phrase) ; bloc « Périodes / Alignement / à date » visible
dès plusieurs périodes ; « Valeurs » dans les options. Menus : global =
tout, 12 derniers mois, cette année, ce mois-ci, années passées ;
graphique = + chaque année / chaque mois ; « comparé à » = + la période
précédente.

## Rendu (`chart_echarts.mjs`)

Règles : barres de 24 px au plus, bout arrondi 4 px et base carrée ;
courbes 2 px ; aire à 10 % ; quadrillage 1 px plein ; légende dès deux
séries ; texte toujours aux couleurs de texte. Zoom à la molette au-delà de
60 clés de temps, glissière au-delà de 400.

**Couleurs** (`stats_page.css`, lues par `readTokens`) : palette
catégorielle de 8 teintes dans un ordre fixe, réglée pour le clair et le
sombre et vérifiée sur les fonds de l'app (#ffffff, #1b2635) — séparation
pour les daltoniens, écart en vision normale. En clair, trois teintes (aqua,
jaune, rose) sont sous 3:1 de contraste : infobulles et « Afficher les
valeurs » compensent. Les **types de caches** gardent les couleurs de la
carte (`static/json/defaultGcColors.json`, valeurs par défaut — pas celles
d'un thème personnalisé) ; une couleur illisible sur le fond (le blanc des
Locationless) passe au gris des notes. Plusieurs types partagent le bleu par
défaut (Mystery, Wherigo, Letterbox) : la légende et l'infobulle les
distinguent.

Le thème change (attribut `data-bs-theme` de `<html>`) → couleurs relues,
graphiques redessinés.

## Tableaux de bord (`dashboard_model.mjs`)

`{ v: 1, active, dashboards: [{ id, name, period, filters, items: [{ size, spec }] }] }`
— 20 tableaux, 24 graphiques au plus. Tailles S / M / L / XL = 4 / 6 / 8 /
12 colonnes sur 12. Première visite (fichier absent) : `defaultDocument`,
enregistré aussitôt. Sauvegarde : PUT du document entier, débouncée (500 ms)
pour la période, immédiate pour les actions discrètes, `keepalive` à la
fermeture de la page.

Éditeur : le formulaire est relu en description, normalisé, puis recalé
dessus (une combinaison impossible est réparée sous les yeux de
l'utilisateur). Titre et taille restent automatiques tant que l'utilisateur
n'y a pas touché : le titre d'une question s'efface quand la mesure ou le
regroupement change, un chiffre clé devenu graphique passe de S à M.

## Tests

- Unitaires : `chart_spec`, `chart_query` (sources, périodes, moteur),
  `chart_echarts`, `dashboard_model` (et libellés) — `npm run test:unit`.
- Python : `tests/test_statistics_page.py` — route, en-tête, « Quitter »,
  colonnes des trouvailles, aller-retour et refus des tableaux de bord.
- E2E : `tests/e2e/stats-page.spec.mjs` (20 tests, fixture `my-finds.gpx` ;
  `openWithChart` pose un tableau d'un seul graphique par `PUT`).
  Relevé `window.getStatsPageSnapshot()` : `rows`, `dashboard`, `cards`
  (`keys`, `series`, `periods`, `align`, `toDate`, `delta`, `partial`,
  `layout`, `grids`, `chart`, `rendered`…), `editor`.
