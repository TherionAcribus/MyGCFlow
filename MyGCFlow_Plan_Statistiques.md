# Page « Statistiques » : graphiques configurables et comparaison de périodes

Ajouter une quatrième page, **« Statistiques » (`/stats`)**, à côté de « Mes
Géocaches », « Évolution » et « Mes poses ». Elle n'affiche pas de carte : des
**tableaux de bord** de **graphiques** que l'utilisateur choisit (quoi compter,
réparti comment, sur quelle période, avec quels filtres, sous quelle forme) et
qui savent **comparer plusieurs périodes**, superposées dans un même graphique
ou côte à côte. Très configurable, mais abordable par trois niveaux : questions
toutes faites, phrase à compléter, réglages avancés repliés.

À distinguer des **panneaux Stats** existants (onglet Stats des pages carte,
`docs/panneaux-stats.md`) : eux sont incrustés sur la carte et dans la vidéo,
dessinés en Canvas maison et animés jour par jour. La page Statistiques est
un outil de lecture interactif. Les deux partagent des fonctions pures de
`stats_model.mjs` (clés par métrique, dates), pas le rendu.

## 0. État d'avancement

2026-11-08 : plan rédigé ; **lot 0 fait** le même jour (doc technique :
`docs/page-statistiques.md`) — ECharts 6.1.0 vendoré (+ `langFR.js`,
LICENSE/NOTICE, notices tierces), en-tête extrait dans
`_app_header.html` avec le lien « Statistiques », route `/stats`
(`blueprints/statistics.py`, helper `render_page` partagé avec `/` et
`/guide`), page vide en clair/sombre, « Quitter » sorti de `ui.js` dans
`app_quit.js`, `chart_spec.mjs` v1 + 22 tests unitaires, test Python de la
route, spec E2E `stats-page.spec.mjs` (5 tests). Écarts au plan : le
`<body>` porte `data-page="stats"` et non `data-mode` (les prédicats
d'`app_mode.mjs` restent réservés aux pages carte) ; l'alignement par
défaut est `elapsed` (celui de l'axe par défaut, l'année).

**Lot 1 fait** le 2026-11-08 : `GET /api/stats/finds` (`stats_finds.py`,
colonnes + dictionnaires, ETag), `dashboards.json` (`dashboards_store.py`,
`GET/PUT/DELETE /api/dashboards`), modules `chart_sources` / `chart_periods`
/ `chart_query` / `chart_labels` / `chart_echarts` / `dashboard_model`,
page complète (barre, période globale, grille S/M/L/XL, galerie de 15
questions + « Graphique personnalisé », éditeur en phrase avec aperçu,
dupliquer / déplacer / supprimer / exporter PNG / renommer). Tests :
unitaires (chart_spec, chart_query, chart_echarts, dashboard_model), Python
(test_statistics_page.py), E2E (stats-page.spec.mjs, 15 tests). Écarts :
pas de dimension « heure » (heure de trouvaille factice à l'import GPX) ;
plafond de séries 8 au lieu de 12 (taille de la palette validée) ; route
`DELETE /api/dashboards` en plus (réinitialisation, tests) ; le moteur sait
déjà superposer plusieurs périodes et découper par 2ᵉ dimension (sans
alignement ni interface : lot 2 / lot 3) ; couleurs des types = valeurs par
défaut de la carte, pas celles du thème actif ; `generate_icons_subset.py`
lit aussi les `.mjs`.

**Lot 2 fait** le 2026-11-08 (détail : `docs/page-statistiques.md` › Comparer
des périodes) : périodes relatives `current` / `previous` / `dashboard`,
coupe « à date », alignements, pourcentage / par jour, superposé / côte à
côte / écart, case en cours repérée, 7 questions de comparaison (dont
« Suis-je en avance sur l'an dernier ? », ajoutée au tableau par défaut),
galerie par sections, éditeur « comparé à ». Écarts : périodes relatives
ajoutées au format v1 (rien n'était publié) ; le menu global propose
« Cette année » / « Ce mois-ci » (relatifs) au lieu de l'année en cours
figée ; « par jour » réservé aux graphiques sans axe de temps ; écart
réservé à deux périodes sans 2ᵉ dimension.

**Lot 3 fait** le 2026-11-08 (détail : `docs/page-statistiques.md` ›
Graphisme et filtres) : filtres du tableau de bord (fenêtre, pastilles) et
propres à un graphique (éditeur, Tom Select), « découpé par » + empilement,
grille D/T ou deux dimensions, calendrier de l'année, radar, palettes
(automatique, une couleur, une par valeur, dégradé). Écarts : grille et
calendrier ne dessinent que la première période ; calendrier limité aux 3
dernières années ; la palette `gc` reste au format mais n'est pas proposée
(« automatique » fait de même) ; pas encore d'échelle de couleur réglable.

**Lot 4 fait** le 2026-11-08 (détail : `docs/page-statistiques.md` ›
Sources) : DNF, caches posées, Mes poses (reçues, DNF reçus, favoris),
jeux Évolution. **Décision utilisateur (2026-11-08)** : Mes poses et les
trouvailles se mêlent librement, Évolution est à part — deux familles de
tableaux de bord, jamais mélangées (barrière dans le format, le modèle,
l'éditeur et la galerie). Plusieurs sources dans un graphique (même
famille), mesure « caches actives », dimensions propres (cache, visiteur,
département). Écarts : le choix entre tableaux de bord (prévu au lot 5)
est fait ici, nécessaire à la barrière ; les données passent par les
routes existantes (pas de route `/api/stats/*` en plus) ; une cache
Évolution archivée sans date n'est jamais active ; pas de dimension « durée
de vie » ni « statut » pour l'instant.

**Lot 5 fait** le 2026-11-08 (détail : `docs/page-statistiques.md` ›
Organisation) : glisser par la poignée, coin de redimensionnement (largeur
S→XL, hauteur normale / grande — tranche la question ouverte « hauteur
fixe ou réglable »), export SVG, export / import JSON d'un tableau (jeu
Évolution retrouvé par son nom), duplication, impression toujours en
clair. Écarts : pas de mode « présentation » plein écran (question
ouverte, non tranchée) ; l'impression garde la largeur des graphiques à
l'écran (ECharts n'est pas redessiné à la largeur du papier).

**Lot 6 fait** le 2026-11-08 (détail : `docs/page-statistiques.md` › Retour
à la carte) : clic sur une barre, un point, une part ou une case d'un
graphique de trouvailles → confirmation → carte « Mes Géocaches » filtrée
(sélection `filtersSelection`, préférence géocaches / Labs ajustée si
besoin) ; « Envoyer en panneau vidéo » (panneau Stats de la page de la
source, période / filtres / découpage non repris et signalés) ; « Créer une
vidéo animée » (révélation le long de l'axe, MP4 par le traitement serveur
des vidéos de la carte, repli WebM). Écarts : pas de lien carte pour DNF,
caches posées, Mes poses et Évolution (leurs pages n'ont pas de sélection
persistée) ; la vidéo s'enregistre en temps réel (une vidéo de 30 s prend
30 s) et sans musique. Le plan initial est entièrement livré.

**Après le plan — analyse du 2026-11-08** : premier lot d'améliorations fait
(fiabilité) — date du jour relue sans rechargement, calendrier redessiné
quand la largeur change sa taille de case, sauvegarde de secours au-delà de
64 Kio (`PUT /api/dashboards/<id>`), contrôle de révision et écriture sous
verrou côté serveur, 304 des trouvailles sans construire les colonnes.
Pistes restantes : charger seulement les sources du tableau ouvert et
dessiner dès que les trouvailles sont là, ETag des routes DNF / caches
posées, aperçus dans la galerie, « Annuler » après un ajout depuis la
galerie, bouton « Actualiser », « Reprendre les filtres de la carte » ;
fonctions : vidéo d'un tableau entier avec musique, grilles de défis (D/T
81, 366 jours, Jasmer), séries et records, objectif et projection, mode
présentation, lien carte pour les autres sources.

Décisions prises avec l'utilisateur :

1. **Une seule page `/stats`**, multi-sources (chaque graphique choisit sa
   source), plutôt qu'une page de stats par mode.
2. **Apache ECharts** pour le rendu (version 6.1.0 au 2026-11-08), vendoré
   dans `static/vendor/echarts/`. Raisons : tous les types de graphiques
   voulus sans greffon (barres groupées/empilées, courbes, aires, anneaux,
   heatmap, repère calendrier, radar, petits multiples), infobulles, légende
   cliquable, zoom d'axe, transitions animées, thèmes, export PNG/SVG,
   accessibilité. Alternatives écartées : fait maison (des mois pour axes,
   infobulles, légendes avant d'atteindre la comparaison), Chart.js
   (calendrier/matrice par greffons inégaux), Plotly (~3,5 Mo, style
   « labo »), Observable Plot et Vega-Lite (interactions moins abouties).
   Le moteur de calcul ne connaît pas ECharts : seul l'adaptateur en dépend.
3. **Filtres propres à la page**, indépendants de ceux de la carte (un
   bouton « Reprendre les filtres de la carte » pourra venir plus tard).
4. **Commencer par « Mes Géocaches »** (trouvailles) ; DNF, caches posées,
   Mes poses et Évolution au lot 4.

## 1. Contexte constaté dans le code

- **Pages** : `render_app_page(mode)` (`blueprints/core.py`) rend `app.html`
  pour les trois modes ; `app_mode.mjs` lit `data-mode` du `<body>`. La page
  Statistiques n'a **pas de carte** : gabarit propre (`stats_page.html`), pas
  `app.html`. L'en-tête `#appHeader` (logo, sélecteur de mode, guide, thème)
  est écrit en dur dans `app.html` → l'extraire dans un partiel
  `_app_header.html` partagé, et y ajouter le 4ᵉ lien (`#linkStatsMode`,
  icône `ti-chart-bar` — à ajouter au sous-ensemble via
  `generate_icons_subset.py`).
- **Point d'entrée JS séparé** : ne pas importer `index.js` (graphe complet
  avec carte, DOM, zone morte des modules — cf. AGENTS.md). Les modules purs
  réutilisables : `stats_model.mjs` (`parseYmd`, `dayNumber`, `ymdOfDay`,
  `statsKeyOf`, `ageBucket`, `CONTAINER_ORDER`, `OTHERS_KEY`, `dtIndex`…),
  `filter_model.mjs`, `settings_api.mjs`, `saved_indicator.mjs`. Vérifier
  que leurs imports restent sans DOM (`stats_model.mjs` n'importe que
  `app_mode.mjs`).
- **Données « Mes Géocaches »** : `bdd.py › create_geojson` (l. ~792) produit
  par trouvaille `date_find` (`YYYY-MM-DD`), `time_find`, `published_date`,
  `cache_type`, `gc_code`, `name`, `difficulty`, `terrain`, `container`,
  `owner`, `placed_by`, `country`, `state`, `attributes` (liste `{id, name,
  inc}`), coordonnées. Les Labs (`lab_geojson.py`) : `cache_type =
  "Adventure Lab"`, D/T/contenant `null`. Route existante :
  `POST /get_geojson_points` (avec sélection de filtres et cache disque). À
  vérifier au lot 1 : appel sans sélection = base complète ; sinon, petite
  route `GET /api/stats/finds` en colonnes.
- **Couleurs par type** : `static/json/defaultGcColors.json` (clé
  `"Adventure Lab"` comprise) — mêmes couleurs que les points de la carte.
- **Thème clair/sombre** : `theme.js` émet `theme:applied` ; palette de
  l'identité dans `tabler_theme.css` (accent `#0072c6`).
- **Préférences globales** : `settings.json` via `PUT /api/settings` (patch
  de premier niveau). Les tableaux de bord n'y vont pas (§ 4.5).
- **Licences** : `/license/third-party` sert
  `licenses/THIRD_PARTY_NOTICES.txt` → y ajouter ECharts (Apache-2.0, avec
  son fichier NOTICE). `static/vendor/README.md` : ligne du tableau.
  `tests/test_offline_assets.py` refuse toute URL CDN dans un gabarit.

## 2. Le modèle : description d'un graphique

Toute l'interface (questions, phrase, avancé) édite un seul objet JSON
versionné. Le moteur le transforme en un **jeu de séries** neutre, que
l'adaptateur traduit en options ECharts.

```json
{
  "v": 1,
  "id": "a3f09c12",
  "title": "",
  "source": "finds",
  "measure": { "op": "count" },
  "groupBy": "month_of_year",
  "splitBy": null,
  "filters": { "cache_type": ["Traditional Cache"], "country": ["France"] },
  "periods": [
    { "kind": "year", "year": 2025 },
    { "kind": "year", "year": 2024 }
  ],
  "compare": { "layout": "overlay", "align": "calendar", "normalize": "none", "toDate": true },
  "view": { "chart": "bar", "stack": false, "palette": "auto", "labels": false, "top": 12 }
}
```

### 2.1 Sources

| `source` | Lot | Événement compté |
|---|---|---|
| `finds` | 1 | une trouvaille (`date_find`) |
| `dnf`, `owned` | 4 | un DNF / une pose (données de `dnf_data.js` / `owner_data.js`) |
| `poses.received`, `poses.dnf`, `poses.favorites` | 4 | log reçu sur une cache posée (`/api/poses/data`) |
| `evolution:<id>` | 4 | pose / archivage d'un jeu CSV, plus l'état « actives » |

Toutes les sources sont ramenées à une **table d'événements commune** :
`day` (numéro de jour, pas d'objet `Date` — pas de fuseau), `kind`,
propriétés de la cache, `actor` (joueur, pour Mes poses).

### 2.2 Mesures (`measure.op`)

- **Flux** (comptés dans chaque intervalle) : `count`, `distinct` (sur
  `caches`, `country`, `state`, `owner`, `cache_type`, `days` = jours avec
  trouvaille), `mean` (sur `difficulty`, `terrain`, `age`), `max_per_day`.
- **Stock** (valeur lue en fin d'intervalle) : `cumulative` (cumul depuis le
  début de la période, ou depuis toujours avec `measure.from: "all"`), et au
  lot 4 `active` (caches vivantes, Évolution / caches posées).

### 2.3 Dimensions (`groupBy`, `splitBy`)

- **Temps** : `year`, `quarter`, `month` (axe continu), `week`, `day` ;
  **cycliques** (indépendantes de l'année, faites pour comparer) :
  `month_of_year`, `week_of_year`, `day_of_year` (366 cases, 29 février
  compris), `weekday` (lundi → dimanche ISO). Pas d'heure : `time_find` des
  géocaches est factice (19 h / 20 h UTC posés à l'import).
- **Catégories** : `cache_type`, `container`, `difficulty`, `terrain`, `dt`
  (paire D/T), `country`, `state`, `owner`, `attribute` (multi-valuée : une
  trouvaille compte dans chaque attribut porté), `age` (tranches de
  `ageBucket`), `published_year`.
- `none` : une seule valeur (graphique « chiffre clé »).

Catégories à forte cardinalité (propriétaires, pays, attributs) : `view.top`
garde les N premières, le reste est regroupé en « Autres » (`OTHERS_KEY`).

### 2.4 Périodes

- `{kind: "all"}` : toutes les données ;
- `{kind: "year", year}`, `{kind: "month", year, month}` ;
- `{kind: "range", from, to}` (dates `YYYY-MM-DD`) ;
- `{kind: "rolling", unit: "month"|"day", count}` : les N derniers ;
- `{kind: "each", unit: "year"|"month", from?, to?}` : **récurrente**, se
  déploie en une période par année (ou mois) présente dans les données.

Une période sans `label` reçoit un libellé calculé (« 2025 », « mars 2024 »,
« 12 derniers mois »).

### 2.5 Comparaison (`compare`)

- `layout` : `overlay` (séries superposées / barres groupées dans le même
  repère), `side` (petits graphiques côte à côte, **même échelle**), `delta`
  (écart entre deux périodes, en valeur ou en %).
- `align` : `calendar` (janvier contre janvier — impose une dimension
  cyclique), `elapsed` (jours écoulés depuis le début de chaque période :
  « jour 1, 2, 3… »), `absolute` (vraie date, périodes placées dans le temps).
- `normalize` : `none`, `percent` (part du total de la période), `per_day`
  (divisé par le nombre de jours de la période — périodes de longueurs
  différentes).
- `toDate` : si une période est en cours, couper les autres au **même
  décalage** (« au 8 novembre ») — sinon l'année en cours perd toujours.
  La période en cours est marquée visuellement (barres hachurées, courbe en
  pointillés après aujourd'hui).

Plafond : **8 séries** par graphique (taille de la palette catégorielle
validée pour les daltoniens ; 12 dans la première version du plan) (périodes × valeurs de `splitBy`) ;
au-delà, message clair et proposition de passer en `side` ou de réduire `top`.

### 2.6 Vue (`view`)

Lot 1 : `bar` (vertical / horizontal), `line`, `donut`, `number` (chiffre
clé avec rappel de la période comparée : « 412 · +18 % sur 2024 »).
Lot 3 : `area`, `stacked`, `calendar` (repère calendrier ECharts), `heatmap`
(D/T, Jasmer, année × mois), `radar`. Réglages : palette (`auto` = couleurs
des types quand la dimension est `cache_type`, sinon palette de l'identité),
étiquettes de valeur, échelle log, tri, épaisseur, lissage.

## 3. Interface

### 3.1 Mise en page

- En-tête d'application commun + **barre du tableau de bord** : nom du
  tableau (menu : nouveau, renommer, dupliquer, supprimer, exporter,
  importer), **période globale** et **filtres globaux**, bouton « Ajouter un
  graphique ».
- Grille de cartes (12 colonnes, tailles S/M/L/XL au lot 1 ; glisser et
  redimensionner au lot 5). Chaque carte : titre, graphique, menu (modifier,
  dupliquer, « dupliquer pour chaque période », exporter PNG/SVG, supprimer).
- Chaque graphique **hérite** de la période et des filtres globaux, sauf s'il
  en fixe des propres (badge « période propre » sur la carte). Changer
  d'année en haut met tout à jour : c'est ce qui garde l'usage simple.
- Base vide : état vide avec lien vers l'import de la page « Mes Géocaches ».

### 3.2 Trois niveaux d'édition

1. **Questions toutes faites** — galerie (patron de `#statsGalleryModal`,
   vignettes dessinées sur les vraies données) : « Ma meilleure année »,
   « Cette année contre l'an dernier, mois par mois », « Suis-je en avance
   sur l'an dernier ? » (cumul à date, courbes superposées), « Mes mois les
   plus actifs », « Mes jours de la semaine », « Mes types de caches »,
   « Mes pays », « Ma grille D/T », « Avant / après » (deux périodes libres,
   en %), « Mes propriétaires favoris ». Un premier tableau de bord est
   rempli à la première visite.
2. **Phrase à compléter** — l'éditeur principal, en panneau latéral avec
   aperçu en direct :

   ```
   Compter  [mes trouvailles ▾]  par  [mois de l'année ▾]
   sur      [2025 ▾]   comparé à  [2024 ▾]  [+ période]
   afficher en  [barres côte à côte ▾]
   ```

   Les listes ne proposent que les choix compatibles (une comparaison
   `calendar` n'offre que les dimensions cycliques, `donut` refuse le temps
   continu…). Les règles de compatibilité vivent dans le module pur.
3. **Avancé** (`<details>` repliés) : filtres, 2ᵉ dimension, mesure,
   normalisation, alignement, « à date », top N, axes, palette, étiquettes,
   tri.

## 4. Architecture

### 4.1 Fichiers

Préfixe `chart_` pour ne pas confondre avec les panneaux (`stats_*`).

| Fichier | Rôle |
|---|---|
| `blueprints/statistics.py` | Route `/stats`, API `/api/dashboards` |
| `dashboards_store.py` | Lecture/écriture de `dashboards.json` (répertoire de config) |
| `templates/stats_page.html` + `_app_header.html` | Gabarit sans carte, en-tête partagé |
| `static/js/chart_spec.mjs` | Pur : normalisation de la description, défauts, compatibilités, migrations de version |
| `static/js/chart_periods.mjs` | Pur : déploiement des périodes, alignement, « à date », libellés |
| `static/js/chart_query.mjs` | Pur : table d'événements → filtres → périodes → regroupement → mesure → jeu de séries |
| `static/js/chart_sources.mjs` | Pur : conversion des données de chaque source en table d'événements |
| `static/js/chart_echarts.mjs` | Pur : jeu de séries + vue + thème → options ECharts |
| `static/js/dashboard_model.mjs` | Pur : tableaux de bord, héritage période/filtres, questions toutes faites |
| `static/js/stats_page.js` | Point d'entrée : chargement, rendu des cartes, éditeur, sauvegarde |
| `static/css/stats_page.css` | Mise en page |
| `static/vendor/echarts/echarts.min.js` | ECharts 6.1.0 (+ locale FR si elle n'est pas incluse) |
| `docs/page-statistiques.md` | Doc technique |

### 4.2 Calcul

Côté navigateur, dans les modules purs, testés sous Node (`npm run
test:unit`). Le serveur ne calcule rien. Volumes visés : 20 000 trouvailles
→ quelques ms par graphique. Mémoïsation par (révision des données,
empreinte de la description effective, après héritage). Édition debouncée
(~150 ms) pour l'aperçu.

### 4.3 Rendu ECharts

- Un thème `mygcflow-light` / `mygcflow-dark` construit depuis les
  variables CSS de l'identité, rebasculé sur `theme:applied` (vérifier si
  ECharts 6 change de thème à chaud, sinon `dispose` + `init`).
- Locale FR/EN selon la langue de l'app (`lang` du gabarit).
- `aria.enabled` + un résumé textuel calculé par nous (comme l'équivalent
  accessible des panneaux).
- `ResizeObserver` par carte → `chart.resize()`.
- Rendu Canvas par défaut ; SVG pour l'export vectoriel.

### 4.4 Filtres

Dimensions : type, contenant, D, T, pays, région, propriétaire, attributs,
année de publication, Labs inclus ou non. Sémantique reprise de la page
carte (`filter_model.mjs` : exclusives / inclusives), mais état propre à la
page, porté par le tableau de bord (global) ou le graphique (propre).

### 4.5 Sauvegarde

Préférence **globale**, mais **hors `settings.json`** (les tableaux de bord
grossissent) : fichier `dashboards.json` dans le répertoire de config,
`GET/PUT /api/dashboards`, écriture atomique, sauvegarde automatique
debouncée avec `flush()` sur les actions discrètes (patron
`makeDebouncedSettingsSaver`) et retour par `reportSave`. Le serveur ne
vérifie que la forme (liste, `v` connu, taille ≤ 1 Mo, nombre de tableaux et
de graphiques plafonné) ; la **normalisation complète est côté JS seulement**
(`chart_spec.mjs`) — le serveur n'en a pas besoin, contrairement aux panneaux
Stats qui sont relus par la vidéo. Export / import d'un tableau de bord en
JSON pour le partager.

## 5. Lots

| Lot | Contenu | Livrable visible |
|---|---|---|
| **0. Fondations** | Vendorer ECharts (+ README vendor, notices), partiel `_app_header.html` + 4ᵉ lien, route `/stats` et gabarit vide, `chart_spec.mjs` v1 figé avec ses tests | La page existe, vide, dans l'en-tête |
| **1. Premiers graphiques** | Source `finds`, `chart_query.mjs`, mesures `count`/`distinct`/`cumulative`, dimensions temps + catégories, vues `bar`/`line`/`donut`/`number`, un tableau de bord sauvegardé, éditeur « phrase », 6 questions toutes faites, export PNG | On compose et garde ses graphiques sur ses trouvailles |
| **2. Comparer** | Périodes multiples et récurrentes, `overlay`/`side`/`delta`, alignements, « à date », normalisation, période en cours marquée, plafond de séries, questions de comparaison | 2025 contre 2024, cumul à date de toutes les années |
| **3. Graphisme et filtres** | Filtres globaux et propres, 2ᵉ dimension, `stacked`/`area`/`calendar`/`heatmap`/`radar`, palettes, étiquettes, échelle log, niveau « Avancé » complet | Ultra configurable |
| **4. Toutes les sources** | DNF, caches posées, Mes poses (reçues, DNF reçus, favoris), Évolution (stock/flux, choix du jeu), comparaison entre sources | Mes trouvailles contre les trouvailles reçues |
| **5. Organisation** | Plusieurs tableaux de bord, glisser/redimensionner, export SVG, export/import JSON, impression | |
| **6. Retour à la carte** | Clic sur une barre → page carte filtrée sur ces caches ; « Envoyer en panneau vidéo » (quand une métrique de panneau existe) ; comparaison animée exportée en vidéo | Lien avec l'animation, cœur de l'app |

Chaque lot : doc, guide (`/guide`), traductions (`t()` hors template
literal, pas de `t?.()`, cf. AGENTS.md), tests unitaires, un spec E2E ciblé ;
suite E2E complète en fin de lot seulement.

## 6. Tests

- **Unitaires (Node)** : `chart_spec` (normalisation, compatibilités,
  migrations), `chart_periods` (déploiement, 29 février, « à date », périodes
  vides), `chart_query` (sur une petite table d'événements écrite à la main :
  valeurs attendues par série), `chart_echarts` (forme des options : nombre de
  séries, type, axes — pas les pixels).
- **Python** : `dashboards_store` (aller-retour, fichier absent ou corrompu,
  refus des formes invalides et des tailles excessives), route `/stats` dans
  `test_offline_assets.py`.
- **E2E** : `stats-page.spec.mjs` lit un relevé `window.getChartsSnapshot()`
  (séries calculées et résumé des options par carte), jamais le canvas.
  `dashboards.json` étant global au runtime E2E, un spec qui pose des
  graphiques remet `PUT /api/dashboards` à l'état initial en sortant (à
  ajouter dans AGENTS.md avec le reste de la famille).

## 7. Pièges identifiés d'avance

- **29 février** : `day_of_year` sur 366 cases ; en cumul, une année non
  bissextile reporte la valeur du 28 sur le 29.
- **Dates** : travailler en numéros de jour (`dayNumber`), jamais en `Date`
  locales (décalages de fuseau au passage à l'heure d'été).
- **Labs** : D/T/contenant `null` → valeur « Inconnu » (`UNKNOWN_KEY`), ou
  exclus quand la mesure porte dessus (`mean` sur D).
- **Attributs multi-valués** : une trouvaille compte dans plusieurs barres ;
  le total d'un graphique par attribut n'est pas le nombre de trouvailles
  (le dire dans l'infobulle).
- **Périodes de longueurs différentes** : proposer `per_day`/`percent` dès que
  les durées diffèrent de plus de 10 %.
- **Modules** : le point d'entrée ne doit tirer ni `index.js` ni la carte.
- **Icônes** : chaque nouvelle `ti-*` passe par `generate_icons_subset.py`.

## 8. Questions ouvertes

- Hauteur des cartes : fixe par taille, ou réglable ?
- Faut-il un mode « présentation » plein écran d'un graphique ?
- Le tableau de bord par défaut : liste exacte à valider au lot 1.
