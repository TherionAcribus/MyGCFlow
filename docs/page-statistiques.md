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
- Lot 3 (2026-11-08) : filtres du tableau de bord et propres à un
  graphique, 2ᵉ dimension (« découpé par ») et empilement, grille (D/T ou
  deux dimensions), calendrier de l'année, radar, palettes.
- Lot 4 (2026-11-08) : toutes les sources — DNF, caches posées, Mes poses
  (trouvailles, DNF, favoris reçus), jeux Évolution — en deux familles
  étanches ; plusieurs tableaux de bord (changer, créer, supprimer) ; un
  graphique sur plusieurs sources ; mesure « caches actives ».
- Lot 5 (2026-11-08) : organisation — déplacer (glisser par la poignée),
  redimensionner (coin : largeur S→XL, hauteur normale / grande), export
  SVG, export / import d'un tableau de bord en fichier, duplication,
  impression.
- Lot 6 (2026-11-08) : retour à la carte — clic sur une valeur → carte
  filtrée, « Envoyer en panneau vidéo », vidéo animée d'un graphique.

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
| `blueprints/statistics.py` | `/stats`, `GET /api/stats/finds`, `GET /api/stats/dnf`, `GET /api/stats/owned`, `GET/PUT/DELETE /api/dashboards` |
| `stats_finds.py` | Trouvailles en colonnes (chaînes codées par dictionnaire, ETag) |
| `dashboards_store.py` | `dashboards.json` dans le répertoire de config : forme, version, taille ≤ 1 Mo |
| `templates/stats_page.html` | Gabarit : barre, grille, galerie, éditeur, renommage |
| `templates/_app_header.html` | En-tête commun aux quatre pages (lien actif selon `mode`) |
| `static/js/stats_page.js` | Point d'entrée et câblage DOM |
| `static/js/stats_filters_ui.js` | Formulaire de filtres (Tom Select) : tableau de bord et éditeur |
| `static/js/chart_filters.mjs` | Pur : valeurs proposées par champ (avec comptes), résumé, nettoyage |
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

## Sources (lot 4)

**Deux familles étanches** (choix de l'utilisateur : Mes poses se mêle à
ses trouvailles, Évolution jamais) :

| Famille | Sources | Route |
|---|---|---|
| `personal` | `finds` | `GET /api/stats/finds` |
| | `dnf` (un enregistrement par DNF) | `GET /api/stats/dnf` |
| | `owned` (une par cache posée, au jour de sa pose ; fin = dernier archivage) | `GET /api/stats/owned` |
| | `poses.received`, `poses.dnf`, `poses.favorites` (un par log reçu, avec `cache` et `finder`) | `GET /api/poses/data` |
| `evolution` | `evolution:<id>` (publiées, fin = archivage), `evolution:<id>:archived` (archivages datés) | `GET /api/evolution/datasets/<id>/data` |

`chart_sources.mjs` convertit chaque réponse (`dnfTable`, `ownedTable`,
`posesTables`, `evolutionTables`) en enregistrements, puis en table commune
(`tableFromRecords`, mêmes colonnes que les trouvailles + `endDay`, +
champs `cache`, `finder`, `county`). DNF et caches posées ont des routes
dédiées (`dnf_geojson.build_dnf_stats`, `owner_geojson.build_owner_stats`)
qui comptent toutes les données : aucune position requise et les règles
d'affichage de la carte ne s'appliquent pas — un DNF postérieur à la
trouvaille compte, une cache trouvée avant son premier DNF garde ses DNF,
une cache posée sans date est servie « sans date ». Les routes de la carte
(`/api/logs/dnf_features`, `/api/logs/owner_features`) écartent au
contraire les caches sans coordonnées, les DNF résolus et les caches posées
sans date. Une source absente (pas de logs) donne une table vide ; seules
les trouvailles sont indispensables au chargement. Les jeux Évolution se chargent à la
demande (`ensureEvolution`), un jeu supprimé donne des tables vides et une
note. Archivée sans date (Évolution) : comptée parmi les publiées, jamais
active ni archivée.

**Barrière** :
- `chart_spec.mjs` : `sourceFamily`, `sameSourceGroup` (même famille et,
  pour Évolution, même jeu) — `extraSources` n'admet que des sources du
  même groupe que `source`.
- `dashboard_model.mjs` : un tableau a un `kind` (`personal` /
  `evolution` + `dataset`) ; à la normalisation, un graphique d'une autre
  famille est écarté, un graphique Évolution d'un autre jeu rattaché au jeu
  du tableau (`rebindEvolution`). `dashboardSources` donne les sources
  proposées par l'éditeur ; la galerie filtre ses questions par famille
  (`questionFamily`) ; les questions Évolution sont écrites sur
  `evolution:1` et rattachées au jeu à la création (`itemFromQuestion` ›
  `dataset`).

**Dimensions et mesures par source** (`sourceDimensions`,
`sourceDistinctFields`, `sourceMeanFields`) : chaque source n'offre que ce
que ses données portent (attributs et année de publication : trouvailles ;
propriétaire : trouvailles et DNF ; cache et visiteur : Mes poses ;
département : Évolution). Plusieurs sources : l'intersection. L'éditeur
masque les dimensions absentes, grise celles que la mesure exclut.

**« Caches actives »** (`measure.op: 'active'`, caches posées et publiées
Évolution) : un stock lu à la fin de chaque case de temps, ou de la période
pour un total ou des catégories (`activeGroups` + `activeAt` : jours de
début et de fin triés, recherche dichotomique — rapide sur un gros jeu).
L'étendue d'une table court jusqu'à son dernier archivage.

**Plusieurs sources dans un graphique** (`runChartQueries`) : chaque
source est calculée à part sur les mêmes périodes et la même étendue
(réunion des étendues), puis les séries sont réunies sur un axe commun.
Les plafonds sont choisis sur les comptages **réunis** des sources
(`sharedAxisCaps` : top N de l'axe et de la 2ᵉ dimension, étendue des
années de publication) — un plafond par source mettrait une valeur
« Autres » ici et principale là, affichée à zéro pour la première alors
qu'elle compte ; chaque source émet alors une série à zéro explicite pour
les valeurs de découpage qu'elle n'a pas. Séries nommées par source
(« Trouvailles / Trouvailles reçues »), couleur par position ; l'écart
d'un chiffre clé dit « par rapport aux trouvailles reçues ». Écart
possible entre deux sources sur une période.

**Plusieurs tableaux de bord** (avancé du lot 5) : menu à côté du nom
(changer, « Nouveau tableau de bord… », supprimer — pas le dernier),
pastille « Évolution · <jeu> », fenêtre de création (famille, jeu, nom
proposé, « Commencer avec des graphiques prêts »).

## Retour à la carte (lot 6)

### Clic sur une valeur → carte filtrée

- `clickTarget(result, spec, params)` (chart_echarts.mjs) : l'événement
  `click` d'ECharts → `{ seriesIndex, keyIndex }` (barre / point :
  `dataIndex` ; part d'anneau : `keyIndex` posé sur la donnée ; case du
  calendrier : sa date). Écart, chaleur, radar : rien.
- `mapSelectionFor(...)` (chart_map_link.mjs, pur) : la sélection
  `filtersSelection` de la page carte (même forme que
  `collectSelectedValues`, ui.js) ; une clé absente garde le défaut « tout
  coché ». Dates : la période de la série ∩ la clé (temps absolu :
  `timeKeyBounds` ; « depuis le début » : `series.dates` ; cases d'une année
  : `cyclicBounds`, seulement dans une période d'une année civile) ;
  « Toute la période » n'écrit pas de dates. Catégories : type, taille, D,
  T, D/T, pays (`countries` + `countries_excluded`, « Non renseigné »
  compris), propriétaire, attribut, année de publication ; la série
  découpée et les filtres du graphique s'ajoutent (intersection).
- Pas de lien (null) : autre source que les trouvailles, « Autres » /
  « Inconnu », dimension ou filtre sans équivalent carte (jour de la
  semaine, âge, région, cache, visiteur, années de publication non
  contiguës). `chartLinksToMap(spec)` décide du curseur.
- Géocaches / Labs ne sont pas dans la sélection mais dans la préférence
  globale `main_discovery_sources` : `discoveryModeFor` donne le mode à poser
  (un type de cache ou une taille désigne les géocaches, « Adventure Lab »
  les Labs ; sans contrainte, tous les types présents). La page la change
  par `PUT /api/settings` seulement si nécessaire.
- Confirmation (« ses filtres actuels seront remplacés ») puis
  `localStorage.filtersSelection` et navigation vers `/`.

### Envoyer en panneau vidéo

- `panelFromSpec(spec, { title, periods, filters })` (chart_panel_link.mjs,
  pur) → `{ list, page, panel, dropped }` ou `{ error }`. Source → liste :
  trouvailles / DNF / caches posées → `stats.panels` (`options.source`),
  Mes poses → `stats.poses_panels`, Évolution → `stats.evolution_panels`
  (`options.counted` : `placed`, `archived` pour la source « archivées »,
  `active` pour la mesure « caches actives »).
- Forme : barres / anneau / radar → panneau `bar` / `donut` de la même
  dimension (mois de l'année → `month`) ; mois (axe de temps) → grille
  `finds_ym` ; D/T → grille `dt` ; calendrier → grille `activity` ; courbe
  ou aire sur le temps → `line` (`cumulative`, ou `actives` / `placees` /
  `archivees`) ; chiffre clé → `counter`. Orientation, nombre d'éléments,
  tri, palette repris. Refus : plusieurs sources, mesure autre qu'un
  comptage, dimension sans panneau (trimestre, année de publication…).
- Un panneau compte au fil de l'animation, avec les filtres de la carte :
  période, filtres et découpage du graphique ne suivent pas (`dropped`, dit
  dans la confirmation). Ajout par `GET` puis `PUT /api/settings {stats:
  {<liste>: [...]}}`, refusé au-delà de `STATS_MAX_PANELS`.

### Vidéo animée

- `chart_video.mjs` (pur) : `chartAnimates` (barres / courbes / aires sur
  un axe de temps ou les cases d'une année, sans écart), `revealProgress`
  (linéaire puis `VIDEO_HOLD` = 15 % de pause sur le graphique complet),
  `revealResult` (clés atteintes pleines, la clé en cours grandit — barre —
  ou glisse depuis la précédente — courbe), `valueMax` / `niceCeil` /
  `lockOption` (échelle figée, plus de glissière ni d'animation ECharts).
- stats_page.js › `videoPainter` : une instance ECharts hors écran, mise en
  page comme une fenêtre de 540 px de haut puis dessinée en pleine
  définition (`devicePixelRatio`), recopiée dans un canevas avec le titre et
  la clé atteinte (« juin »). `captureStream(30)` + `MediaRecorder` (WebM
  VP9/VP8) en temps réel ; `fixWebmDuration` ; `POST
  /process_recorded_video` (`slowdown` 1) puis `/tasks/<id>` → MP4 dans le
  dossier des vidéos, aperçu `/download_video/<f>?inline=1`, « Afficher
  dans le dossier » (`POST /reveal_video`). Échec serveur : le WebM brut,
  téléchargeable.
- Formats `VIDEO_SIZES` (1280×720, 1920×1080, 1080×1080), durées 6 à 30 s.

## Organisation (lot 5)

- **Déplacer** : glisser-déposer HTML5 ; la carte ne devient `draggable`
  que saisie par sa poignée (`.stats-card-grip`, `pointerdown`), repère
  d'insertion `drop-before` / `drop-after` (moitié gauche / droite, haut /
  bas pour une carte pleine largeur). Le menu garde « Déplacer avant /
  après » pour le clavier.
- **Redimensionner** : coin `.stats-card-resize` (pointeur) ; la largeur
  suit la souris par colonnes de la grille et se cale sur S / M / L / XL
  (`nearestSize`), 60 px vers le bas donnent la grande hauteur, vers le
  haut la normale ; appliqué en direct, enregistré au relâcher. Hauteur
  aussi dans l'éditeur (`item.height` : `M` 300 px / `L` 460 px,
  `HEIGHT_PIXELS`, variable CSS `--stats-chart-height` ; le calendrier
  garde sa hauteur calculée).
- **SVG** : `chartSvg(spec)` redessine le graphique hors écran avec le
  moteur SVG d'ECharts (`renderer: 'svg'`, `renderToSVGString`), à la
  taille de la carte, fond de la carte compris.
- **Partager un tableau** (`exportDashboard` / `importDashboard`,
  dashboard_model.mjs) : fichier `{ format: 'mygcflow-dashboard', v: 1,
  dashboard }` sans identifiants ; un tableau Évolution emporte le **nom**
  de son jeu (l'identifiant ne veut rien dire ailleurs) — à l'import,
  rattaché au jeu de même nom, sinon au premier (avertissement), refusé
  sans aucun jeu. Barrière appliquée comme à la lecture du document.
  « Dupliquer » : `duplicateDashboard` (identifiants neufs, « (copie) »).
- **Imprimer** : `window.print()` ; `@media print` masque en-tête,
  commandes, menus, poignées ; `beforeprint` repasse un thème sombre en
  clair le temps de l'impression (`afterprint` le rétablit).

## Graphisme et filtres (lot 3)

**Filtres** : `dashboard.filters` (fenêtre « Filtres », pastilles
retirables sous la barre, badge du nombre de champs) et `spec.filters`
(section « Filtres » de l'éditeur : `null` = ceux du tableau de bord ; un
objet = propres, partant d'une copie de ceux du tableau ; icône d'entonnoir
sur la carte). Formulaire : `renderFilterForm` (stats_filters_ui.js), un
`<select multiple class="form-select">` + Tom Select par champ, garni par
`filterChoices` (valeurs présentes et leur nombre ; un champ à une seule
valeur est masqué), menus rattachés à `<body>` (`dropdownParent`, z-index
au-dessus des modales). Dans l'éditeur, le formulaire n'est reconstruit
qu'à l'ouverture ou au changement de mode : le reconstruire à chaque
changement couperait la saisie dans Tom Select.

**2ᵉ dimension** : « découpé par » dans la phrase (`allowedSplitBy`),
« Empiler les séries » dans les options dès plusieurs séries
(barres / courbe / aire, hors écart).

**Nouvelles formes** (`chart_echarts.mjs`) :
- `heatmap` : difficulté × terrain (regroupement `dt` : 9 × 9 cases, sans
  « Autres » — `fullGrid` dans chart_query) ou regroupement × 2ᵉ dimension ;
  cases vides au fond (`'-'`), dégradé `--chart-heat-*`, échelle sous la
  grille.
- `calendar` : regroupement par jour, un bandeau par année de la première
  période (3 au plus, `calendarYears`), cases carrées calculées sur la
  largeur (`calendarCell`, 8–18 px) ; `chartHeight(result, spec, width)`
  allonge la carte. Noms de jours rangés du dimanche au samedi (convention
  ECharts) ; petites cases : lun. / mer. / ven. seulement.
- `radar` : une forme par série, même maximum pour tous les axes.
- Grille et calendrier ne dessinent que la première période (note sous la
  carte) ; `allowedLayouts` = `overlay` pour les trois.

**Palettes** (`view.palette`, barres d'une série ou anneau) : `auto` (types
aux couleurs de la carte, autres catégories d'une seule teinte), `accent`,
`multi` (une teinte par valeur, types compris), `heat` (dégradé selon la
valeur, à partir du 2ᵉ pas de la rampe : contraste ≥ 2:1 sur le fond).
Rampe `--chart-heat-1…5` vérifiée au validateur dans les deux modes (le
pas 1 se fond volontairement dans le fond : case proche de zéro).

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
- Unitaires du lot 3 : `chart_filters.test.mjs` ; grille, calendrier, radar,
  palettes dans `chart_echarts.test.mjs`.
- Unitaires du lot 4 : `chart_sources.test.mjs` (tables, actives, plusieurs
  sources) ; familles dans `chart_spec`, `dashboard_model`, `chart_echarts`.
- Unitaires du lot 5 : hauteur, export / import, duplication dans
  `dashboard_model.test.mjs`.
- Unitaires du lot 6 : `chart_map_link.test.mjs`, `chart_panel_link.test.mjs`,
  `chart_video.test.mjs`, `clickTarget` dans `chart_echarts.test.mjs`.
- E2E : `tests/e2e/stats-page.spec.mjs` (38 tests, fixtures `my-finds.gpx`,
  `gc_logs/logs-poses.json`, `evolution-a.csv` ;
  `openWithChart` pose un tableau d'un seul graphique par `PUT`).
  Relevé `window.getStatsPageSnapshot()` : `rows`, `dashboard`, `cards`
  (`keys`, `series`, `periods`, `align`, `toDate`, `delta`, `partial`,
  `layout`, `grids`, `chart`, `rendered`, `size`, `heightKey`, `height` en
  px…, `linksToMap`), `editor`, `dashboards`, `sources`, `video` (`phase`
  setup / recording / done, `file`, `folder`).
