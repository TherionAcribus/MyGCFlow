# Page Statistiques

Quatrième page de l'application (`/stats`), à côté de « Mes Géocaches »,
« Évolution » et « Mes poses » : des tableaux de bord de graphiques, sans
carte. Plan, décisions et lots : `MyGCFlow_Plan_Statistiques.md` (section 0
= état d'avancement).

À ne pas confondre avec les **panneaux Stats** (`docs/panneaux-stats.md`),
incrustés sur la carte et dans la vidéo.

## État

Lot 0 (2026-11-08) : page vide servie, lien dans l'en-tête des quatre pages,
ECharts vendoré, format d'un graphique (`chart_spec.mjs`) figé en v1.

## Fichiers

| Fichier | Rôle |
|---|---|
| `blueprints/statistics.py` | Route `/stats` (`render_page`, blueprints/core.py) |
| `templates/stats_page.html` | Gabarit : en-tête partagé, ECharts, point d'entrée |
| `templates/_app_header.html` | En-tête commun aux quatre pages (lien actif selon `mode`) |
| `static/js/stats_page.js` | Point d'entrée : thème, « Quitter », signal `mygcflowStatsReady` |
| `static/js/app_quit.js` | « Quitter » (sorti de ui.js, partagé avec les pages carte) |
| `static/js/chart_spec.mjs` | Pur : format versionné d'un graphique, normalisation, compatibilités |
| `static/css/stats_page.css` | Mise en page |
| `static/vendor/echarts/` | ECharts 6.1.0 + `langFR.js` (+ LICENSE, NOTICE) |

## Page sans carte

`stats_page.html` ne charge ni OpenLayers ni `index.js` : le graphe de la
page carte évalue `ui.js`, qui initialise toute l'interface carte pendant
son évaluation. Le point d'entrée n'importe que des modules autonomes
(`theme.js`, `app_quit.js` → `notifications.js` → `ui_bootstrap.js`) et des
modules purs. Feuilles chargées : Tabler, icônes, `ui_improvements.css`
(en-tête, indicateur « Enregistré »), `theme.css`, `tabler_theme.css` —
aucune n'a de règle globale sur `body`/`main` propre à la carte.

Le `<body>` porte `data-page="stats"` et **pas** `data-mode` : les
prédicats d'`app_mode.mjs` ne concernent que les trois pages carte.

## Format d'un graphique (`chart_spec.mjs`)

Objet JSON versionné (`v: 1`) que toute l'interface édite ; exemple et
vocabulaire en tête du module, détail dans le plan (§ 2). Règles :

- `normalizeChartSpec(raw)` rend **toujours** une description utilisable
  (valeur inconnue → défaut, combinaison impossible → réparée), sauf pour une
  version future (`v` > `CHART_SPEC_VERSION`) : `null`, l'appelant garde
  l'original.
- `filters: null` / `periods: null` = hérités du tableau de bord ; un objet
  ou une liste = propres au graphique (`filters: {}` : propres et vides).
- Compatibilités exposées pour l'interface : `allowedGroupBy(measure)`
  (un cumul suit le temps), `allowedSplitBy(groupBy)`,
  `allowedAligns(groupBy)`, `allowedCharts(spec)` (le premier sert de
  repli). L'écart (`compare.layout: 'delta'`) exige deux périodes fixes —
  contrôlé seulement quand les périodes sont propres.
- Toutes les sources (`finds`, `dnf`, `owned`, `poses.*`, `evolution:<id>`)
  sont acceptées dès la v1, même non branchées : pas de migration au lot 4.

## Tests

- `tests/js/chart_spec.test.mjs` (`npm run test:unit`).
- `tests/test_statistics_page.py` : route, lien actif, en-tête, « Quitter ».
- `tests/e2e/stats-page.spec.mjs` : navigation, ECharts et locale, thème,
  « Quitter » (`/api/quit` intercepté), accessibilité du lien. Relevé :
  `window.getStatsPageSnapshot()`.
