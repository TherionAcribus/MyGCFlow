# Panneaux de statistiques sur la carte (grilles D/T · Jasmer · 366, histogrammes)

Ajouter un onglet principal « Stats » qui permet de poser sur la carte des panneaux statistiques — **grilles** (matrice D/T 9×9, puis Jasmer et calendrier 366 sur le même renderer) et **histogrammes** (types, tailles, difficulté, terrain, années) — qui se remplissent au fil de l'animation, rendus en Canvas 2D à partir d'un moteur de comptage incrémental partagé par l'aperçu et la vidéo, persistés en préférences globales, avec le cadre d'extension pour les anneaux, la courbe cumulée, les compteurs et le glisser-déposer.

## 0. État d'avancement (2026-10-17)

Lots 0, 1, 2 et 2 bis implémentés (grilles D/T, Jasmer, calendrier 366 ; histogrammes ; onglet ; vidéo), commités en « Stats > MVP » — doc technique dans `docs/panneaux-stats.md`.

Lot 3 implémenté (2026-10-17) : anneaux/camemberts (`donut`), courbe cumulée (`line`), compteurs (`counter` : jours, record, plus longue série, types, pays, régions), métriques pays/régions, course de barres (`sort: race`), valeurs animées (`createTweenStore`), glisser-déposer en position libre (`position.mode: free`, x/y normalisés), contournement automatique du titre et des infos, avertissement de chevauchement entre panneaux.
Non faits, volontairement : mode Évolution, export/import du bloc dans un thème. Perf (§6) mesurée le 2026-10-17 : aucun écart mesurable en MediaRecorder 2× avec 3 panneaux (détail dans `docs/panneaux-stats.md` › Mesures). Reste : notes de version 0.0.7.

Écarts par rapport au plan ci-dessous, décidés en cours de route :
- **Pas de bloc `stats` dans `defaultValues.json`** : ce fichier alimente `pkg.options` (réglages de thème), où `stats` n'a rien à faire. Les défauts vivent dans `stats_settings.py` et `stats_model.mjs`, verrouillés par des vecteurs de test partagés (`tests/fixtures/stats/settings_cases.json`).
- **Stats dessinées AVANT `addOverlaysToCanvas`** (et `z-index: 90` dans l'aperçu) : le titre et les infos restent au-dessus, dans l'aperçu comme dans la vidéo.
- **Branchements `mapgl.js` plus minces** : `accumulateStatsForDates(dates, now)` relit lui-même les caches dans l'index (pas de `hiddenPointsBefore`/`hiddenPointsFor` à ajouter) ; le rafraîchissement par frame passe par `updatePointAppearClock` (`updateStatsPanels`), qui tient aussi le `mapDirtyTracker` en animation pendant une surbrillance.
- **Fond par défaut à 85 %** d'opacité (70 % laissait trop transparaître la carte).
- **Reconstruction de l'index hors animation** (nouveau filtre après une fin naturelle) → retour aux totaux.
- **Init de l'onglet en fin de `stats_ui.js`**, pas depuis `initUIElements` (zone morte des modules, cf. AGENTS.md).
- Guide : section « 4. Stats », Préférences devient 5.

## 1. Contexte constaté dans le code (à ne pas redécouvrir)

- **Boucle d'animation** : `mapgl.js › displayFeaturesForDates(dates, …)` (l. ~4740) reçoit les features GeoJSON du ou des jours affichés (`pkg.pointsByDate.get(date.toDateString())`), puis appelle `displayInfosForDate` qui incrémente le compteur `infos.cacheNumber` (+ `countHiddenPointsFor(dates)` pour les locationless masquées, comptées mais jamais dessinées). C'est **le** point d'accroche de l'incrément des stats — il sert aussi aux deux pipelines d'enregistrement (`record=true`).
- **Trois points de démarrage, pas un** : l'état initial (`getFilteredPointsAtStart()` + `countHiddenPointsBefore(...)`, puis `resetTravelTrail()`) est construit séparément dans :
  - `startAnimation(restart=false)` — aperçu (l. ~2466) ;
  - `startRecordingProcess(session)` — capture image par image (l. ~3068) ;
  - `recordAnimationMediaRecorder()` — MediaRecorder (l. ~3826, `resetTravelTrail(true)`).
  
  La réinitialisation des stats doit être branchée **aux trois**, à côté de chaque `resetTravelTrail`, sinon une vidéo lancée après un aperçu démarre avec les compteurs de l'aperçu.
- **Plage d'animation ≠ sélection** : `animationStartDate()` / `animationEndDate()` (l. 2244-2256) appliquent la plage personnalisée de l'onglet Animation (`options.animation.dateStart/dateEnd`), sinon les bornes de la sélection. Les caches antérieures au début sont affichées d'emblée ; celles postérieures à la fin ne sont jamais animées.
- **Retour au repos** : `showRestInfos()` (l. 2144) remet le compteur à `metadata.numberOfCaches` (sélection complète) ; appelée par `stopAnimation()` (l. 2763) et `abortRecordingOnError()` (l. 3283). La **fin naturelle** (`finalizeAnimationEnd`, l. 2406) ne l'appelle **pas** : les infos restent sur la dernière valeur animée jusqu'au prochain arrêt/démarrage. Les panneaux suivent la même règle.
- **Index** : `bdd.js › buildPointsByDateIndex` ; `pointsByDateRevision` bump à chaque reconstruction (filtre, import, vidage, bascule locationless). Les mémoïsations (résumés caméra, trajet) sont indexées dessus → faire pareil pour les totaux de stats. `getPointsUpToDate(date)` (l. 2278) existe déjà pour reconstruire un état à une date.
- **Propriétés d'une feature** (`bdd.py › create_geojson` l. 701, `lab_geojson.py`) : `source_kind` (`geocache`|`lab`), `date_find` (`YYYY-MM-DD`), `published_date` (`YYYY-MM-DD` ou `null` — absent de certains GPX et de tous les Labs), `cache_type` (Labs : **`"Adventure Lab"`**, `LAB_CACHE_TYPE`), `difficulty`/`terrain` (floats 1→5 par 0,5, **`null` pour les Labs**), `container` (`Micro`, `Small`, `Regular`, `Large`, `Other`, `Virtual`, `Not chosen`, `null` pour Labs), `country`, `state`, `owner`, `attributes`.
- **Overlays existants** : `#titleFrame` / `#infosFrame` sont des DIV absolues dans `#mapWithFrames` (aperçu) ; `overlay_canvas.js` les **réimplémente en Canvas 2D** pour la vidéo (`addOverlaysToCanvas(ctx, w, h, scaleFactor)`, appelé par les deux pipelines : MediaRecorder l. 3973 avec `effScale`, images l. 4635 avec `dpr`). La géométrie vidéo = rect DOM mesuré × `scaleFactor` (`cacheElement` dans `buildOverlayCache`), ancrage déduit des `left/right/top/bottom` inline.
- **Économie de frames MediaRecorder** : `mapDirtyTracker.shouldDraw(frameStart, overlayContentSignature())` (l. 3959) saute le compositing si rien n'a changé ; la signature inclut `getOverlayCacheRevision()` + textes. Les panneaux doivent y contribuer (révision), sinon leurs changements ne seraient pas enregistrés quand la carte ne bouge pas.
- **Repli html2canvas** : capture le DOM — un `<canvas>` DOM est capturé nativement.
- **Thèmes vs préférences globales** : thèmes = `MapProfile` (`map/points/flash/infos/trail`, `coerce_profile`, miroir `profiles.js`). Préférences globales = `AppSettings` (`settings_manager.py`), `GET/PUT /api/settings` en patch partiel (`blueprints/profiles.py › api_put_settings`, blocs imbriqués comme `recording` coercés par `coerce_recording_settings`), client `static/js/settings_api.mjs` (file d'écritures, cache `window.userSettings`). **Décision utilisateur : les panneaux sont des préférences globales** (comme `infos_template`), pas une section de thème.
- **Gabarit de livraison** : commit `99acf98` « Traits de déplacement > MVP » (26 fichiers : module `.mjs` pur + tests `node --test`, template `menu_*.html`, section serveur + `tests/test_trail_profile.py`, `ui.js`, `defaultValues.json`, doc `docs/traits-de-deplacement.md`, guide, README, `messages.pot`/`.po`/`.mo`, icônes Tabler subset, spec E2E).
- **Onglets principaux** : `app.html` l. 209-212 (`#data`, `#style`, `#animation`, `#settings`), mémoire d'onglet générique par `href` (`ui.js › activeTabStorageKey`), hash d'URL → ouvrir `/#stats` dans les specs (cf. piège base vide dans AGENTS.md).
- **Couleurs par type** : `gc_colors.js › defaultGcColors` (chargé depuis `static/json/defaultGcColors.json`, clé `"Adventure Lab"` présente) — à réutiliser pour les barres par type (cohérence avec les points).
- **Visibilité** : `pkg.hasDatabase()` (`ui.js` l. 7993), `isEvolutionPage()` (`app_mode.mjs`), `frames.js › syncOverlayVisibility`.
- **Tests** : unitaires JS `test_*.mjs` à la racine, lancés par `run_video_tests.py` (`node --test …`, liste explicite l. 83-89) ; Python `tests/test_*.py` ; E2E `tests/e2e/*.spec.mjs` (Node 22 obligatoire, cf. AGENTS.md ; fixture `tests/e2e/fixtures/my-finds.gpx`, helper `openWithFixture` dans `travel-trail.spec.mjs`).
- Version courante `0.0.6` (`version.py`) → la fonctionnalité va dans les notes `docs/release_notes/0.0.7.md` (à créer au moment du versionnage, pas dans ce lot).

## 2. Décisions actées avec l'utilisateur

| Sujet | Décision |
|---|---|
| Périmètre MVP | Socle + **grille générique** (matrice D/T) + **histogrammes** (types, tailles, difficulté, terrain, années). Jasmer et calendrier 366 juste après (lot 2 bis, quasi gratuits avec la grille générique). Anneaux, courbe cumulée, compteurs : lot 3, prévus dans l'architecture. |
| Rangement UI | **Nouvel onglet principal « Stats »** (5e onglet), masqué sur `/evolution` (MVP mode principal seulement, comme Trajet). |
| Persistance | **Préférences globales** : bloc `stats` dans `settings.json` / `AppSettings`, patch partiel via `PUT /api/settings`. |
| Placement | **Ancrage (9 positions) + décalages + largeur**, avec **empilement automatique** des panneaux partageant une ancre ; modèle de position conçu pour accueillir le glisser-déposer ensuite (voir §9). |
| Rendu | **Canvas 2D maison, sans bibliothèque** (app hors-ligne, `test_offline_assets.py`, cohérent avec `overlay_canvas.js`). Une seule fonction de dessin par type de panneau, utilisée telle quelle par l'aperçu et par la vidéo. |

## 3. Architecture cible (nouveaux modules)

```
static/js/stats_model.mjs      pur, testable node --test : normalisation des réglages (schéma par kind),
                               accumulateur, bucketisation (D/T, Jasmer, calendrier, taille, type, année),
                               GRID_SPECS, ordre stable/top-N, layout (ancre + empilement → rect)
static/js/stats_render.mjs     pur : drawGrid(ctx, rect, model, style, now), drawBarChart(...),
                               registre KIND → { measure, draw }
static/js/stats_panels.js      DOM + cycle de vie : crée/positionne les <canvas> dans #mapWithFrames, dirty/rAF,
                               expose reset/accumulate/showTotals/revision, addStatsPanelsToCanvas (vidéo)
static/js/stats_ui.js          onglet « Stats » : liste des panneaux, modèles, formulaire, sauvegarde debouncée
templates/menu_stats.html      le tab-pane #stats
tests : test_stats_model.mjs, tests/test_stats_settings.py, tests/e2e/stats-panels.spec.mjs
docs/panneaux-stats.md, section guide.html, README(.fr).md
```

Export dans `static/js/index.js` (`export * from './stats_panels.js'`) comme `overlay_canvas.js`.

### 3.1 Modèle de réglages (`stats`, préférence globale)

```jsonc
"stats": {
  "enabled": true,                 // interrupteur général (coupe tout sans perdre la config)
  "panels": [                      // max 6 ; ordre = ordre de dessin (z) et ordre d'empilement
    {
      "id": "a1b2…",               // uuid hex court, généré côté client ; le serveur régénère s'il manque/doublon
      "kind": "grid",              // "grid" | "bar"   (plus tard : "donut", "line", "counter"…)
      "metric": "dt",              // grid : dt | jasmer | calendar
                                   // bar  : cache_type | container | difficulty | terrain | year
      "enabled": true,
      "show_title": true,
      "title": "",                 // vide → titre par défaut traduit du kind/metric
      "position": { "anchor": "top-left", "dx": 16, "dy": 16, "width": 280 },
                                   // anchor ∈ 9 valeurs ; dx/dy px CSS [0, 2000] ; width px [120, 1200]
                                   // empilés : dy = espacement par rapport au panneau précédent (cf. §3.3)
                                   // (le drag ultérieur ajoutera "mode": "anchor" | "free" + x/y normalisés, cf. §9)
      "options": {                 // schéma propre au kind, défauts dépendant de la metric
        // communs
        "show_values": true, "show_percent": false,
        "highlight": "new",        // "new" (case/catégorie qui passe de 0 à 1) | "every" (chaque trouvaille) | "none"
        // grid
        "cell_mode": "count",      // "count" (nombre dans la case) | "filled" (rempli/vide, façon « fill the grid ») | "heat"
        "show_coverage": true,     // pied « 47/81 combinaisons »
        // bar
        "sort": "natural",         // "natural" | "count" | "label" — ordre figé sur les comptes finaux (§3.2)
        "orientation": "horizontal", // "horizontal" | "vertical"
        "max_items": 8, "hide_empty": false
      },
      "style": { "background": "#0b1a2b", "background_opacity": 70, "text_color": "#ffffff",
                 "accent_color": "#29D34E", "palette": "gc", "font_size": 12, "radius": 10,
                 "inherit_font": true }
                                   // palette ∈ "gc" (couleurs par type), "accent" (une couleur), "heat" (dégradé accent)
                                   // inherit_font : famille de police calculée de #infosFrame, sinon police de l'app
    }
  ]
}
```

**Défauts par métrique** (appliqués à la création et par la normalisation quand l'option est absente) :

| kind/metric | sort | orientation | highlight | autres |
|---|---|---|---|---|
| grid/dt | — | — | `new` | `cell_mode: count`, `show_coverage: true` |
| grid/jasmer, grid/calendar | — | — | `new` | `cell_mode: filled`, `show_coverage: true` |
| bar/cache_type | `count` | `horizontal` | `every` | `max_items: 8` |
| bar/container | `natural` (Micro → Large, Other, Virtual, Not chosen, Inconnu) | `horizontal` | `every` | |
| bar/difficulty, bar/terrain | `natural` (1 → 5) | `vertical` | `every` | 9 barres fixes |
| bar/year | `natural` | `vertical` | `every` | bornes = années de la plage |

Règles de coercition (serveur **et** client `normalizeStatsSettings`, même esprit que `TrailOptions`/`normalizeTrailOptions`) : **un schéma de coercition par `kind`** (dict → dict, miroir du registre JS) plutôt qu'une dataclass figée regroupant les options de tous les kinds ; options étrangères au kind supprimées ; kinds/metrics inconnus ou combinaison kind/metric invalide → panneau ignoré (les autres sont conservés) ; bornes clampées ; enums validées ; couleurs via `_coerce_hex_color` ; > 6 panneaux → tronqué ; `id` manquant/doublon → régénéré. Valeurs par défaut aussi dans `static/json/defaultValues.json` (bloc `stats`, `panels: []`).

### 3.2 Moteur de comptage (`stats_model.mjs`) — contrainte perf

- **Un seul accumulateur partagé** par tous les panneaux : `createStatsAccumulator(metrics)` ne calcule que les métriques demandées par les panneaux actifs (ensemble recalculé à chaque changement de réglages). Tranches : `dt: Uint32Array(81)`, `jasmer: Uint32Array(nbAnnées × 12)`, `calendar: Uint32Array(12 × 31)`, `byType: Map`, `byContainer: Map`, `byDifficulty: Uint32Array(9)`, `byTerrain: Uint32Array(9)`, `byYear: Map`, `total`, `excluded: { dt, jasmer }`. Méthodes `add(features, now)`, `reset()`, `snapshot()` (revision++). Chaque panneau lit sa tranche : coût par jour O(nouvelles caches), pas O(panneaux × caches).
- **Grilles génériques** : `GRID_SPECS[metric] = { rows, cols, index(feature) → i | -1, disabled(r, c), rowLabel, colLabel }`.
  - `dt` : 9×9, lignes D 1→5, colonnes T 1→5 (convention project-gc) ; `dtIndex(v)` = `Math.round((v - 1) * 2)` → index 0→8, **seulement** pour les demi-points entre 1 et 5 ; hors bornes (`0`, `7`) ou pas un demi-point (`1.2`, `4.75`) → -1, exclu plutôt que rabattu sur la case la plus proche.
  - `jasmer` : lignes années de publication 2000 → année de `animationEndDate()`, colonnes janvier → décembre ; cases avant mai 2000 et postérieures à la date de fin `disabled` ; `published_date` null → -1.
  - `calendar` : 12 mois × 31 jours sur `date_find` ; cases inexistantes (30-31 février, 31 avril…) `disabled`, 29 février valide.
  - Index -1 → exclu de la grille, mais compté dans `total` et `excluded[metric]` ; le pied l'annonce (« 12 caches sans D/T », « 30 sans date de publication ») pour que la somme ne surprenne pas.
- Hors grilles : D ou T non numérique (Labs, données corrompues) → exclu des barres D/T, compté dans `total` et dans « par type » (type `"Adventure Lab"`) ; `container` null → bucket « Inconnu » (clé interne stable, libellé traduit à l'affichage). Parsing des dates par découpe de la chaîne `YYYY-MM-DD` (pas de `new Date` par feature) **avec validation du calendrier** : « 2021-02-31 » est rejeté — sinon `Date.UTC` le rabattrait sur le 3 mars et la cache serait comptée au mauvais jour.
- **Deux références mémoïsées** :
  - **Totaux au repos** = toute la sélection filtrée (`pointsByDate` + `hiddenPointsByDate`), clé `pointsByDateRevision` — c'est ce qu'affichent `showRestInfos` et la carte au repos.
  - **Référence d'animation** = comptes à `animationEndDate()` inclus (caches antérieures au début comprises), clé `(pointsByDateRevision, animationEndDate)`. Égale aux totaux quand aucune date de fin n'est imposée → un seul calcul.
- **Stabilité visuelle pendant l'animation** — tout ce qui structure le graphe vient de la référence d'animation, pas de l'état courant :
  - **échelle** (longueur de barre, intensité d'une case = count / max de référence) — sinon toutes les barres se redimensionnent à chaque jour ;
  - **ordre des lignes et top-N** (y compris avec `sort: count`) — sinon les lignes changent de rang en cours d'animation ; la ligne « Autres » agrège ce qui sort du top-N de référence ;
  - **bornes** (années de `bar/year`, lignes de `jasmer`).
  
  Un mode « course de barres » (ordre volontairement mobile, avec transition) reste possible plus tard comme valeur de `sort`.
- **Surlignage** (`highlight`) : l'accumulateur retient `lastHit[key] = { at: tAppearClock, isNew }` (`isNew` = la case/catégorie passe de 0 à 1) ; avec `new`, seules les déblocages sont surlignés (l'événement fort pour un géocacheur), avec `every` chaque incrément. Surbrillance décroissante sur ~`min(600 ms, durée d'un jour)`. Le panneau ne se redessine en continu **que** tant qu'une surbrillance est active (`hasActiveHighlights(now)`), puis se rendort. Horloge = `sampleAppearClock()` de mapgl (temps vidéo en capture image par image → export reproductible, temps actif hors pauses en MediaRecorder).
- **Réglages modifiés pendant une animation** (panneau ajouté, métrique changée) : reconstruire l'accumulateur depuis l'index jusqu'à la date affichée (`getPointsUpToDate` + locationless masquées), sans relancer l'animation.

### 3.3 Rendu (`stats_render.mjs` + `stats_panels.js`)

- Renderers purs `draw(ctx, { x, y, w, h }, data, style, now)` + `measure(data, style, width) → hauteur` ; **aucune lecture DOM** dedans. Registre `RENDERERS = { grid, bar }` : ajouter un kind = ajouter une entrée + un schéma de coercition + un formulaire (socle « évolutif »). Une nouvelle grille = une entrée `GRID_SPECS`, sans nouveau renderer.
- **Aperçu** : un `<canvas class="stats-panel" data-panel-id>` par panneau dans `#mapWithFrames`, positionné en CSS (ancre → `left/right/top/bottom` inline, exactement la convention lue par `cacheElement` d'`overlay_canvas.js`), taille bitmap = taille CSS × `devicePixelRatio`, hauteur donnée par `measure` pour que la boîte DOM soit la source de vérité géométrique, `pointer-events: none`, `aria-hidden`. Redessin **coalescé** : `markDirty()` → un seul `requestAnimationFrame` pour tous les panneaux sales ; pendant l'animation, l'incrément du jour ne marque sales que les panneaux concernés.
- **Empilement automatique** (`layoutPanels(panels, heights, container)`, pur) : les panneaux visibles d'une même ancre forment une pile dans l'ordre de la liste ; le premier est placé par ses `dx/dy`, les suivants à la suite (vers le bas pour les ancres `top-*`, vers le haut pour `bottom-*`, pile centrée pour `middle-*`), leur `dy` servant d'espacement. Le résultat est écrit en positions inline : la vidéo le relit via la mesure DOM comme le reste. Si une pile dépasse le conteneur ou chevauche `#titleFrame`/`#infosFrame` (rects déjà mesurés par `overlay_canvas.js`), un avertissement discret s'affiche dans l'onglet — pas de déplacement automatique au MVP.
- **Police** : `inherit_font` → famille calculée de `#infosFrame` (lue au `buildCache`, pas par frame), sinon police de l'app ; taille/couleurs restent celles du panneau. Pas de sélecteur de police au MVP.
- **Vidéo** : `addStatsPanelsToCanvas(ctx, canvasWidth, canvasHeight, scaleFactor)` appelé juste après `addOverlaysToCanvas` dans les deux pipelines (mapgl l. 3973 et l. 4635). Pour chaque panneau visible : rect = géométrie DOM mesurée × `scaleFactor` (réutiliser/exporter la mesure d'`overlay_canvas.js` plutôt que recalculer l'ancrage), dessin via le même renderer dans un **canvas hors écran par panneau mis en cache par (revision, scaleFactor, w, h)**, puis `drawImage`. Un panneau inchangé entre deux frames coûte un `drawImage`, pas un redessin.
- **Signature MediaRecorder** : `overlayContentSignature()` concatène `getStatsRevision()` (incrémenté à chaque `add`/`reset`/changement de réglage/surbrillance active). Sans cela, les frames « carte immobile, matrice qui se remplit » seraient sautées.
- Invalidation : resize fenêtre, `ResizeObserver` du conteneur, changement de réglages → `invalidateStatsLayout()` (repositionne, recalcule DPR, bump revision). Fonts : s'aligner sur `document.fonts` (`ready` + `loadingdone`) comme `overlay_canvas.js`.
- Visibilité : masqués si `!pkg.hasDatabase()`, si `stats.enabled === false`, ou sur `/evolution` (`isEvolutionPage()`), même règle que `syncOverlayVisibility`.
- **Budget** : grille 9×9 ≈ 81 rects + ≤ 81 textes + 18 libellés : < 1 ms en Canvas 2D ; Jasmer (~27×12) et calendrier (12×31) restent sous ~400 cases ; barres : négligeable. Objectif mesurable : ≤ 1 ms par panneau par redessin en 1×, et **zéro redessin** quand rien ne change. Vérifier avec `recordingPerformanceMonitor` (log du temps de frame existant) sur `my-finds.gpx` avec 3 panneaux à 2× : la frame composée ne doit pas croître de plus de ~10 %.

### 3.4 Intégration à l'animation (`mapgl.js`, modifications minimales)

1. **Les trois démarrages** — `startAnimation(!restart)`, `startRecordingProcess`, `recordAnimationMediaRecorder` : à côté de `resetTravelTrail()` → `pkg.resetStatsForAnimation(filteredPointsAtStart, hiddenPointsBefore(startDate))`. Il faut les **features** masquées, pas seulement leur compte : ajouter à côté de `countHiddenPointsBefore` un `hiddenPointsBefore()` retournant les features (le compteur peut alors s'en dériver), et pour `displayFeaturesForDates` un `hiddenPointsFor(dates)`. `restart=true` (reprise de pause) ne réinitialise pas.
2. `displayFeaturesForDates` (mode principal) : après `displayInfosForDate(...)` → `pkg.accumulateStats(newFeatures, hiddenFeaturesForDates, sampleAppearClock())`.
3. **Repos** : dans `showRestInfos()` → `pkg.showStatsTotals()` (totaux mémoïsés). Couvre `stopAnimation` et `abortRecordingOnError` d'un seul branchement. **Fin naturelle** (`finalizeAnimationEnd`) : ne rien faire, les panneaux gardent l'état final comme le compteur. Pause : rien (l'accumulateur garde son état).
4. `clearMap` / vidage de base / rebuild de l'index (`bdd.js`) → `pkg.refreshStatsPanels()` (totaux recalculés via la révision) ; changement de plage d'animation → invalidation de la référence d'animation.
5. Les deux appels `addOverlaysToCanvas` → suivis de `addStatsPanelsToCanvas`.
6. `overlayContentSignature` → + révision stats.

### 3.5 Onglet « Stats » (`templates/menu_stats.html`, `stats_ui.js`)

- `app.html` : 5e `<li>` (`href="#stats"`, libellé « Stats » / court « Stats »), inclus `{% if mode != 'evolution' %}` ; `tab-pane` `#stats`. Icône Tabler `ti-chart-bar` (vérifier la présence dans le subset `static/vendor/tabler-icons/tabler-icons-subset.css`, sinon régénérer comme dans `99acf98`).
- Contenu : interrupteur général ; **liste des panneaux** (cartes compactes : type + métrique, case activer, boutons monter/descendre/dupliquer/supprimer) ; bouton « Ajouter un panneau » (menu : Grille → D/T, Jasmer, Calendrier 366 ; Histogramme → métrique) ; **modèles en un clic** pour ne pas laisser un onglet vide intimidant (« Matrice D/T », « Types + tailles », « Difficulté + terrain », puis « Jasmer », « Calendrier 366 » au lot 2 bis), chacun posant un ou deux panneaux pré-réglés et pré-placés ; **formulaire du panneau sélectionné** en deux blocs : « Contenu » (afficher le titre + titre, métrique, options du kind : mode de case, couverture, tri, orientation, max items, valeurs/%, surlignage) et « Position & style » (ancre en grille 3×3 de boutons radio, dx/dy, largeur, couleurs, opacité, taille de police, police héritée, rayon). Message d'état vide (« Aucun panneau » + modèles) et note « non disponible en mode Évolution ». Avertissement de chevauchement/débordement (§3.3).
- Sauvegarde : `saveStatsSettings()` debouncée 500 ms via `settings_api.mjs` en **bloc complet** `{ stats: {...} }` (comme `recording`, cf. commentaire d'`updateLocalCache`) ; aperçu mis à jour immédiatement (sans attendre le PUT). Chargement : `window.userSettings.stats` au démarrage → `normalizeStatsSettings`.
- Réutiliser les patrons d'UI existants : `form-hint`, `gc-section-title`, pickers couleur de `menu_trail.html`, tooltips `data-bs-toggle="tooltip"` (initBsTooltips), `pkg.t()` hors template literal pour les chaînes JS. Libellés de types traduits comme dans le filtre types ; nombres formatés selon la locale.

### 3.6 Serveur (`settings_manager.py`, `blueprints/profiles.py`)

- `StatsSettings` (dataclass : `enabled`, `panels: list[dict]`) ; constantes `STATS_KINDS`, `STATS_METRICS_BY_KIND`, `STATS_ANCHORS`, `STATS_MAX_PANELS = 6` ; `_STATS_OPTION_SCHEMAS[kind]` + schémas communs `position`/`style` ; `coerce_stats_panel(d)` → dict normalisé ou `None` ; `coerce_stats_settings(d, current)` (patron de `coerce_recording_settings`).
- `AppSettings.stats: StatsSettings` ; `coerce_settings` ; `_settings_to_dict`/GET (`'stats': asdict(s.stats)`) ; `api_put_settings` : `if 'stats' in data: stats = coerce_stats_settings(data['stats'], current.stats)`.
- Reset des préférences (si une route reset existe pour `settings`) : remettre `stats` par défaut.

## 4. Lots d'implémentation (ordre recommandé)

**Lot 0 — Socle (sans graphique visible)**
1. `settings_manager.py` + `blueprints/profiles.py` : bloc `stats`, coercition par kind, GET/PUT. Test `tests/test_stats_settings.py`.
2. `stats_model.mjs` : `STATS_DEFAULTS`, défauts par métrique, `normalizeStatsSettings`, `createStatsAccumulator`, `GRID_SPECS.dt` + `dtIndex`, bucketisation, références mémoïsées (repos / animation), ordre stable + `topN`, `layoutPanels` (ancres + empilement). Test `test_stats_model.mjs` ; ajout dans `run_video_tests.py`.
3. `stats_panels.js` : cycle de vie DOM, dirty/rAF, `addStatsPanelsToCanvas`, révision ; branchements §3.4 (trois démarrages, `showRestInfos`) dans `mapgl.js`/`bdd.js` ; export via `index.js`.
4. Onglet `#stats` + `stats_ui.js` (liste, ajout/suppression, modèles, position, style, avertissements) ; masquage en mode Évolution.

**Lot 1 — Grille générique, métrique D/T** : renderer `drawGrid` (en-têtes de lignes/colonnes, case selon `cell_mode`, intensité ∝ count/max de référence, cases vides discrètes, cases `disabled` hachurées/absentes, surbrillance des déblocages, pied « n/81 combinaisons » et « n caches sans D/T ») ; formulaire spécifique ; modèle « Matrice D/T » ; spec E2E ; doc.

**Lot 2 — Histogrammes** : renderer barres horizontales **et** verticales (libellé, barre, valeur/%, couleur par `palette`) pour `cache_type` (couleurs `defaultGcColors`, libellés traduits comme dans le filtre types), `container`, `difficulty`, `terrain` (9 barres fixes 1→5), `year` (ordonné, bornes = années de la plage) ; tri `natural`/`count`/`label` figé sur la référence, `max_items` + « Autres », `hide_empty` ; modèles « Types + tailles », « Difficulté + terrain ».

**Lot 2 bis — Grilles Jasmer et calendrier 366** : entrées `GRID_SPECS.jasmer` / `GRID_SPECS.calendar` (bornes, cases `disabled`, pied « n sans date de publication ») ; libellés de mois traduits ; modèles correspondants ; tests unitaires des index ; doc.

**Lot 3 (hors MVP, cadré par l'architecture)** :
- **anneau** (`donut`, même `byType`/`byContainer`) : top-N + « Autres » obligatoires (une vingtaine de types illisibles en parts), transition douce des angles puisqu'ils bougent chaque jour ;
- **courbe de progression cumulée** (`line`) : se trace pendant l'animation, échelle connue via la référence ;
- **compteurs** (`counter`) : « types trouvés 14/20 », « jours avec trouvaille », « plus grosse journée », série en cours, pays/régions visités via `country`/`state` ;
- mode « course de barres » (`sort: race`) ;
- position libre par glisser-déposer (§9) ; évitement automatique des cartouches titre/infos ;
- import des panneaux dans un thème si l'utilisateur change d'avis (le bloc est autonome, cf. §9) ;
- mode Évolution (barres placées/archivées par type, sur `evolution_data.js`).

## 5. Fichiers à modifier / créer

- `settings_manager.py` — `StatsSettings` + schémas par kind + `coerce_stats_settings` + `AppSettings.stats` + dict.
- `blueprints/profiles.py` — GET/PUT `stats`.
- `static/json/defaultValues.json` — bloc `stats`.
- `static/js/stats_model.mjs`, `static/js/stats_render.mjs`, `static/js/stats_panels.js`, `static/js/stats_ui.js` — nouveaux.
- `static/js/index.js` — export.
- `static/js/mapgl.js` — points d'accroche §3.4 (trois démarrages, `displayFeaturesForDates`, `showRestInfos`, deux pipelines, signature) ; `static/js/bdd.js` — rafraîchissement sur rebuild/vidage ; `static/js/overlay_canvas.js` — exporter la mesure géométrique DOM→canvas et les rects titre/infos.
- `templates/app.html` (onglet), `templates/menu_stats.html` (nouveau), `static/css/style.css` ou `ui_improvements.css` (`.stats-panel`, formulaire).
- `static/vendor/tabler-icons/*` si icône absente du subset.
- `run_video_tests.py` — `test_stats_model.mjs`.
- `test_stats_model.mjs`, `tests/test_stats_settings.py`, `tests/e2e/stats-panels.spec.mjs` — nouveaux.
- `docs/panneaux-stats.md` (nouveau), `templates/guide.html`, `README.md`, `README.fr.md`, `docs/preferences-et-profils.md` (mention « préférence globale »).
- `messages.pot`, `translations/{fr,en}/LC_MESSAGES/messages.{po,mo}`.
- `AGENTS.md` — nouveau piège : `stats` est une préférence globale partagée par tous les specs → remettre `{ stats: STATS_DEFAULTS }` en `afterEach` et attendre la persistance.

## 6. Tests et vérification

- **Unitaires JS** : `node --test test_stats_model.mjs` —
  - index : `dtIndex` (1→0, 1.5→1, 5→8, 4.75→-1 pas un demi-point, 7→-1, null→-1) ; Jasmer (2000-05 valide, 2000-04 `disabled`, null→-1) ; calendrier (29 février valide, 31 avril `disabled`, 2021-02-31 rejeté) ;
  - accumulateur : `add` de features mixtes geocache/lab/locationless (`total`, `excluded`, `dt[...]`, `byType` avec `"Adventure Lab"`, Lab compté en type mais pas en D/T) ; `reset` ; métriques non demandées non calculées ; `isNew` au passage 0→1 seulement ;
  - références : référence d'animation ≠ totaux quand la date de fin est imposée, identique sinon ;
  - ordre : `sort: count` figé sur la référence (un état intermédiaire où un type dépasse un autre ne change pas l'ordre), `topN` + « Autres », défauts `natural` par métrique ;
  - `normalizeStatsSettings` : clamp, kinds inconnus ignorés, kind/metric incompatibles ignorés, options étrangères au kind supprimées, > 6 tronqué, ids régénérés ;
  - `layoutPanels` : 9 ancres seules, empilement de 2-3 panneaux sur `top-left`/`bottom-right`/`middle-left`, rect jamais hors cadre, détection de débordement.
- **Python** : `python -m pytest tests/test_stats_settings.py` — défauts, coercition par kind (bornes, hex, enum, options étrangères), PUT partiel conservant les autres préférences, GET renvoyant `stats`, panneau invalide ignoré sans rejeter les autres.
- **E2E** (`node node_modules/@playwright/test/cli.js test stats-panels`, Node 22) :
  1. `/#stats` + fixture → modèle « Matrice D/T » → `canvas.stats-panel` visible ; ancre `bottom-right` → style inline `right/bottom` ; deuxième panneau sur la même ancre → empilé sans chevauchement ; `GET /api/settings` contient les panneaux (attendre la persistance debouncée, cf. AGENTS.md).
  2. Lancer l'animation en jours/seconde élevé jusqu'à la fin → `page.evaluate(app.getStatsSnapshot())` : somme de `dt` + `excluded.dt` = `#spanNbCaches` ; comparer aussi au repos avant animation (totaux = mêmes valeurs) ; pause/reprise → pas de remise à zéro.
  3. Plage personnalisée (`dateEnd` avant la dernière trouvaille) : à la fin naturelle, snapshot = référence d'animation (barre max à pleine échelle) ; après Stop → totaux de la sélection.
  4. Masquage : `stats.enabled=false` → panneaux cachés ; `/evolution` → aucun `canvas.stats-panel` et pas d'onglet.
  5. Export vidéo (patron `video-export.spec.mjs`) après un aperçu complet : au premier jour enregistré, le snapshot repart de l'état initial (pas de l'état de fin d'aperçu) ; l'export aboutit ; `addStatsPanelsToCanvas` a été appelé (compteur exposé en test) ou pixel non vide dans la zone du panneau d'une frame image.
  6. `afterEach` : `PUT /api/settings {stats: défauts}` et attendre `panels.length === 0`.
- **Perf manuelle** : 3 panneaux (dont une grille Jasmer), MediaRecorder 2×, fixture — lire les temps de frame du moniteur ; comparer avec panneaux désactivés.
- **Traductions** : `pybabel extract` → vérifier `grep -c "^msgid" messages.pot` (~1500+), `update --no-fuzzy-matching`, traduire FR/EN, `compile`, `python check_missing_translations.py`, `python -m pytest tests/test_translations.py tests/test_ui_localization.py`.
- **Non-régression ciblée** : `overlay.spec.mjs`, `video-export.spec.mjs`, `travel-trail.spec.mjs`, `tab-memory.spec.mjs`, `tests/test_global_preferences.py`, `tests/test_offline_assets.py`.

## 7. Risques / points de vigilance

- **Démarrages oubliés** : trois chemins construisent l'état initial (§1) ; un branchement manquant ne se voit qu'en vidéo (compteurs hérités de l'aperçu). Le test E2E 5 le couvre.
- **Doubles comptes** : les lots de plusieurs jours (`dates.length > 1`) passent une seule fois dans `displayFeaturesForDates` ; `restart=true` (reprise de pause) ne doit **pas** réinitialiser l'accumulateur. Les locationless masquées doivent être comptées (cohérence avec `spanNbCaches`).
- **Échelle/ordre calés sur la mauvaise référence** : avec une date de fin personnalisée, utiliser les totaux de la sélection laisserait les barres loin du bord en fin d'animation. Toujours la référence d'animation pendant l'animation, les totaux au repos.
- **Frames sautées en MediaRecorder** si la révision stats n'entre pas dans `overlayContentSignature` — test E2E 5 le couvre partiellement ; relire `mapDirtyTracker`.
- **Flou HiDPI** : bitmap du canvas aperçu = CSS × DPR ; en vidéo, redessiner au `scaleFactor` (jamais étirer le canvas d'aperçu).
- **Reflows** : ne jamais lire `getBoundingClientRect` ni le style calculé dans la boucle de frame ; mesurer au `buildCache` (invalidation par resize/ResizeObserver/réglages), comme `overlay_canvas.js`.
- **Préférence globale partagée** entre specs E2E (piège documenté dans AGENTS.md pour `audio_file`, `camera_follow_mode`) → restauration explicite + attente de persistance.
- **Chevauchement** avec `#titleFrame`/`#infosFrame` : défauts des modèles sur des ancres libres (matrice `bottom-left`, barres `top-right` sous la zone infos) ; empilement automatique entre panneaux ; avertissement si une pile chevauche un cartouche ou déborde.
- **Polices** : `document.fonts` peut charger après le premier rendu → invalidation `loadingdone` comme les overlays ; la police héritée de `#infosFrame` suit les changements de thème (invalidation `invalidateOverlayCache`).
- **Données manquantes** : Labs sans D/T/taille, GPX sans date de publication → pieds explicites « n sans D/T », « n sans date de publication » (évite l'incompréhension « ma somme ne colle pas »).
- `settings.json` existants sans bloc `stats` → défauts ; les préférences sont rétro-compatibles (clé ajoutée, rien de renommé).

## 8. Critères d'acceptation du MVP (lots 0-2)

- Onglet « Stats » visible en mode principal, absent sur `/evolution` ; ajout (y compris par modèle)/suppression/réordonnancement de panneaux persistés et restaurés au redémarrage.
- Matrice D/T et histogrammes se remplissent jour après jour pendant l'aperçu **et** apparaissent identiquement dans la vidéo exportée (MediaRecorder et images), à toutes les résolutions ; chaque export repart de l'état initial.
- Pendant l'animation, ni l'échelle ni l'ordre des lignes ne bougent ; avec une plage personnalisée, l'état final atteint la pleine échelle.
- À la fin naturelle, les panneaux gardent l'état final ; après Stop, ils montrent les totaux de la sélection filtrée ; ils disparaissent quand la base est vide ou l'interrupteur coupé.
- Panneaux d'une même ancre empilés sans chevauchement.
- Aucune régression mesurable du temps de frame quand aucun panneau n'est configuré ; ≤ ~10 % avec 3 panneaux en 2×.
- Tests unitaires/Python/E2E verts, traductions FR/EN complètes, doc + guide + README à jour.

## 9. Évolutivité prévue (sans l'implémenter maintenant)

- `position.mode: "anchor" | "free"` avec `x`/`y` **normalisés** [0,1] par rapport au conteneur pour le futur glisser-déposer (indépendant de la résolution vidéo) ; le MVP n'écrit que `anchor`. Un panneau en mode libre sort de sa pile d'ancre.
- Registre de renderers + schéma de coercition par `kind` : un anneau = `stats_render.mjs › drawDonut` + entrée `STATS_KINDS` + schéma d'options + formulaire. Une nouvelle grille = une entrée `GRID_SPECS`.
- Le bloc `stats` est autonome (aucune dépendance au thème) : s'il doit un jour devenir une section de thème ou être exportable seul, un `export/import JSON` du bloc suffit.
- L'accumulateur centralisé à métriques à la demande permet d'ajouter des métriques (pays, propriétaires, mois, attributs) sans toucher aux renderers existants.
