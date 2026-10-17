# Panneaux de statistiques

Préférence globale (onglet **Stats**, bloc `stats` de `settings.json`) : des
panneaux posés sur la carte — grilles et histogrammes — qui se remplissent au
fil de l'animation et sont dessinés à l'identique dans la vidéo. Mode
principal seulement : sur `/evolution`, l'onglet n'existe pas et aucun panneau
n'est dessiné.

| Type (`kind`) | Métriques (`metric`) |
|---|---|
| `grid` | `dt` (matrice D/T 9×9), `jasmer` (année × mois de publication, depuis mai 2000), `calendar` (mois × jour de trouvaille, 366 cases) |
| `bar` | `cache_type`, `container`, `difficulty`, `terrain`, `year` |

Six panneaux au maximum, dans l'ordre de la liste (ordre de dessin et
d'empilement).

## Modules

| Fichier | Rôle |
|---|---|
| `stats_settings.py` | Schéma, défauts par métrique, coercition serveur (`coerce_stats_settings`) |
| `static/js/stats_model.mjs` | Pur : normalisation miroir, accumulateur, clés par métrique, grilles, histogrammes, mise en page |
| `static/js/stats_render.mjs` | Pur : dessin Canvas 2D (`measure` + `draw` par type, registre `STATS_RENDERERS`) |
| `static/js/stats_panels.js` | Cycle de vie : canvas d'aperçu, accumulation, totaux, rendu vidéo |
| `static/js/stats_ui.js` | Onglet Stats : liste, modèles, formulaire, sauvegarde débouncée |
| `templates/menu_stats.html` | Le `tab-pane` `#stats` |

**Réglages miroirs.** Le client normalise ce qu'il lit et ce qu'il envoie, le
serveur ce qu'il reçoit et relit. Les deux passent les mêmes vecteurs de test
(`tests/fixtures/stats/settings_cases.json`, lus par `test_stats_model.mjs` et
`tests/test_stats_settings.py`) : une règle modifiée d'un côté sans l'autre
casse les deux suites. Les entrées sont écrites à la main ; les sorties ont été
générées puis relues — à régénérer (et relire) après un changement voulu de
schéma ou de défaut.

Pièges de parité traités : arrondi au demi supérieur (`Math.round`, reproduit
par `floor(x + 0.5)` côté Python), regex appliquées en `fullmatch` avec des
classes ASCII (`$` et `\d` diffèrent entre Python et JS), titre tronqué en
points de code (`Array.from` côté JS).

`PUT /api/settings` accepte `{ stats: {...} }` en patch de premier niveau :
`enabled` seul garde les panneaux ; `panels`, s'il est envoyé, remplace la
liste. L'onglet envoie toujours le bloc complet.

## Comptage

Un seul accumulateur pour tous les panneaux, qui ne compte que les métriques
des panneaux actifs. Chaque jour affiché ajoute ses caches : coût
proportionnel aux nouvelles caches, pas au nombre de panneaux ni à la taille de
la sélection. Les locationless masquées (`hiddenPointsByDate`) comptent comme
pour le compteur de caches.

Une cache sans valeur pour une métrique (Lab sans D/T ni taille, GPX sans date
de publication) est **exclue** de cette métrique mais comptée dans le total ;
le pied du panneau l'annonce (« Sans D/T : 12 ») pour que la somme ne
surprenne pas. La présence de cette ligne est décidée sur la référence : la
hauteur du panneau ne change pas au premier Lab rencontré.

### Deux références

- **Totaux de la sélection** — clé `pointsByDateRevision` : ce qu'affichent
  les panneaux au repos.
- **Référence d'animation** — comptes à `animationEndDate()` (caches
  antérieures au début comprises) : échelle, ordre des lignes, top-N et
  bornes pendant l'animation. Égale aux totaux quand aucune date de fin n'est
  imposée.

Tout ce qui structure un graphe vient de la référence, jamais de l'état
courant : sinon les barres se redimensionneraient et changeraient de rang à
chaque jour. Les catégories (`cache_type`, `container`) passent au-delà de
`max_items` dans une ligne « Autres » ; les grandeurs ordonnées (D/T, années)
s'affichent en entier.

### Cycle de vie (branchements dans `mapgl.js`)

| Moment | Appel |
|---|---|
| Les **trois** démarrages (aperçu, capture image par image, MediaRecorder) | `resetStatsPanelsForAnimation()` → `resetStatsForAnimation({ startDate, endDate, highlightMs })` |
| Chaque lot de jours (`displayFeaturesForDates`) | `accumulateStatsForDates(dates, now)` — les caches sont relues dans l'index |
| Avant chaque rendu (`updatePointAppearClock`) | `updateStatsPanels(now)` → `tickStatsPanels(now)` |
| Retour au repos (`showRestInfos` : arrêt, abandon d'enregistrement) | `showStatsTotals()` |
| Reconstruction de l'index (`bdd.js`) | `refreshStatsPanels()` |

Un démarrage oublié ne se voit qu'en vidéo : l'export partirait des comptes
laissés par l'aperçu (spec E2E « un export repart de zéro »). La reprise de
pause ne réinitialise rien. La **fin naturelle** garde l'état final, comme le
compteur ; une reconstruction de l'index hors animation (nouveau filtre)
ramène alors aux totaux.

Un panneau ajouté en pleine animation reconstruit l'accumulateur jusqu'au
dernier jour affiché, sans relancer l'animation.

### Surlignage

`highlight: "new"` surligne les **déblocages** (case ou catégorie qui passe de
0 à 1 — l'événement fort pour un géocacheur), `"every"` chaque incrément. La
surbrillance s'estompe sur `min(600 ms, durée d'un jour)`, à l'horloge des
points (`sampleAppearClock`) : temps vidéo en capture image par image, donc
reproductible. Tant qu'elle est visible, `updateStatsPanels` tient le
`mapDirtyTracker` en animation (`beginAnimation`/`endAnimation`) : sinon le
compositing MediaRecorder sauterait les frames d'une carte immobile et la
surbrillance resterait figée.

## Rendu

Les renderers ne lisent jamais le DOM. `stats_panels.js` prépare une **vue**
(modèle + libellés traduits + couleurs + formats de nombres) ; la géométrie se
calcule en px CSS depuis la seule largeur, ce qui donne la hauteur
(`measure`) avant de dessiner, puis le dessin à n'importe quelle échelle.

- **Aperçu** : un `<canvas class="stats-panel">` par panneau dans
  `#mapWithFrames`, bitmap = taille CSS × `devicePixelRatio`, `z-index: 90`
  (sous le titre et les infos), `pointer-events: none`. Redessin seulement
  quand la révision change ; les lectures de géométrie DOM n'ont lieu que sur
  invalidation (resize, `ResizeObserver`, réglages), jamais par frame.
- **Vidéo** : `addStatsPanelsToCanvas(ctx, w, h, scaleFactor)` est appelé dans
  les deux pipelines **avant** `addOverlaysToCanvas`, pour le même empilement
  que l'aperçu. Géométrie = mise en page de l'aperçu × `scaleFactor`, ancrée
  depuis le même coin (`left`/`right`, `top`/`bottom`). Chaque panneau est rendu
  dans un canvas hors écran gardé tant que la révision et l'échelle ne
  changent pas : un panneau immobile coûte un `drawImage`.
- **Signature MediaRecorder** : `overlayContentSignature()` inclut
  `getStatsRevision()`.

### Mise en page

`layoutPanels` (pur) : les panneaux d'une même ancre forment une pile, du coin
vers l'intérieur ; le premier est placé par `dx`/`dy`, les suivants à la suite,
leur `dy` servant d'espacement. Colonne centrale : centré horizontalement
(`dx` ignoré) ; ligne médiane : la pile entière est centrée. Un panneau ramené
dans le cadre (pile trop haute, largeur supérieure à la carte) ou qui chevauche
`#titleFrame`/`#infosFrame` déclenche un avertissement dans l'onglet
(événement `mygcflow:stats-layout`) — pas de déplacement automatique.

## Tests

- `node --test test_stats_model.mjs` — vecteurs partagés, clés, accumulateur,
  surlignage, grilles (Jasmer, 29 février…), ordre figé, top-N, empilement.
- `python -m unittest tests.test_stats_settings` — vecteurs partagés, ids,
  patch, fichier sans bloc `stats`, API GET/PUT/reset.
- `tests/e2e/stats-panels.spec.mjs` — modèle posé et ancré, empilement,
  persistance, remplissage pendant la lecture, totaux après un nouveau filtre,
  export qui repart de zéro et dessine les panneaux, interrupteur général, mode
  Évolution. `stats` est une préférence globale partagée par tous les specs :
  chaque test remet la liste vide en sortant.

## Évolutions prévues

- Anneaux (`donut`), courbe cumulée (`line`), compteurs (`counter`) : une
  entrée dans `STATS_RENDERERS`, un schéma d'options (`stats_settings.py` et
  `stats_model.mjs`), un formulaire.
- Nouvelle grille : une entrée dans `gridSpec`, sans nouveau renderer.
- Position libre par glisser-déposer : `position.mode: "anchor" | "free"` avec
  `x`/`y` normalisés [0, 1] ; un panneau libre sort de sa pile d'ancre.
