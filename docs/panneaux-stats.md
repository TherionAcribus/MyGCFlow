# Panneaux de statistiques

Préférence globale (onglet **Stats**, bloc `stats` de `settings.json`) : des
panneaux posés sur la carte — grilles et histogrammes — qui se remplissent au
fil de l'animation et sont dessinés à l'identique dans la vidéo. L'onglet
existe aussi sur `/evolution`, avec des métriques propres (caches posées et
archivées, pas des trouvailles).

Deux listes de panneaux indépendantes : `stats.panels` pour le mode
principal, `stats.evolution_panels` pour `/evolution`. Chaque liste compte
au plus six panneaux, dans l'ordre de dessin et d'empilement. L'ordre se
règle dans l'onglet par glisser-déposer à la souris ou par les boutons
Monter/Descendre de chaque ligne — les flèches restent la voie du clavier
et du tactile, que le glisser-déposer HTML5 ne couvre pas. Les
configurations nommées (`stats.configs`) s'appliquent à la liste du mode
courant. Chaque configuration retient le mode où elle a été enregistrée
(`mode` : `finds` / `evolution`, `finds` pour les enregistrements
antérieurs) : dans le menu, une configuration de l'autre mode est marquée
« (Trouvailles) » / « (Évolution) » et non applicable — sa suppression reste
possible. La normalisation accepte l'union des deux registres de métriques :
un panneau à métrique étrangère peut figurer dans une liste — il est marqué
« (Trouvailles) » / « (Évolution) » dans l'onglet et n'est pas dessiné.

Mode principal (`stats.panels`) :

| Type (`kind`) | Métriques (`metric`) |
|---|---|
| `grid` | `dt` (matrice D/T 9×9), `jasmer` (année × mois de publication, depuis mai 2000), `calendar` (mois × jour de trouvaille, 366 cases), `activity` (une année, semaines × jours, façon contributions GitHub) |
| `bar` | `cache_type`, `container`, `difficulty`, `terrain`, `year`, `month`, `weekday`, `age` (âge de la cache à la trouvaille, 10 tranches), `country`, `state`, `attribute`, `owner` |
| `donut` | `cache_type`, `container`, `country`, `state`, `attribute`, `owner` — anneau, camembert si `hole` vaut 0 |
| `line` | `cumulative` — trouvailles cumulées, en escalier |
| `counter` | `summary` — tuiles choisies dans `options.items` : `days` (jours avec trouvaille), `best_day` (record sur une journée), `streak` (plus longue série de jours consécutifs), `types`, `countries`, `states`, `attributes`, `owners` (valeurs distinctes connues), `oldest` (plus ancienne cache trouvée : année + date de publication), `same_day` (trouvées le jour de leur publication), `north`, `south`, `east`, `west` (trouvaille la plus au nord… en coordonnées géocaching) |

Mode Évolution (`stats.evolution_panels`) :

| Type (`kind`) | Métriques (`metric`) |
|---|---|
| `bar` | `cache_type`, `container`, `difficulty`, `terrain`, `country`, `state`, `county`, `status` (actives vs archivées) |
| `donut` | `cache_type`, `container`, `country`, `state`, `county`, `status` |
| `line` | `actives` (présentes à la date), `placees`, `archivees` (cumuls) |
| `counter` | `summary` — tuiles : `actives`, `placees`, `archivees`, `peak` (pic d'actives), `types`, `countries`, `states` |

Les barres et anneaux Évolution acceptent `options.counted` :
`active` (ensemble vivant à la date affichée, défaut), `placed` ou
`archived` (cumuls des événements). `status` l'ignore. Les comptes
rejouent la chronologie (`placedOrder`/`archivedOrder` de
`evolution_timeline.mjs`) au jour affiché ou au jour de fin de plage.

Le select « Forme » du formulaire (section Contenu) propose les types qui
savent dessiner la métrique courante — il n'apparaît que quand il y en a
plusieurs, donc pour les métriques catégorielles partagées entre barres et
anneau. Changer un histogramme en anneau garde titre, position et apparence ;
les options reprennent les défauts du type choisi. Un aperçu du panneau
sélectionné est dessiné en tête du formulaire avec le même pipeline que la
carte (`drawStatsPanelPreview`), à la largeur réelle du panneau — utile sur
écran étroit, quand la carte est hors vue pendant le réglage ; un panneau
à métrique étrangère au mode n'y est pas dessiné, comme sur la carte.

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
classes ASCII (`$` et `\d` diffèrent entre Python et JS), titre aplati,
blancs de bord retirés puis tronqué en points de code (`Array.from` côté
JS — un titre réduit à des espaces est vide et retombe sur le titre par
défaut).

`PUT /api/settings` accepte `{ stats: {...} }` en patch de premier niveau :
`enabled` seul garde les panneaux ; `panels` ou `evolution_panels`, s'ils
sont envoyés, remplacent la liste correspondante. L'onglet envoie toujours
le bloc complet.

## Comptage

Un seul accumulateur pour tous les panneaux, qui ne compte que les métriques
des panneaux actifs. Chaque jour affiché ajoute ses caches : coût
proportionnel aux nouvelles caches, pas au nombre de panneaux ni à la taille de
la sélection. Les locationless masquées (`hiddenPointsByDate`) comptent comme
pour le compteur de caches.

Les métriques de l'accumulateur ne sont pas toujours celles des panneaux :
`accumulatorMetricsFor` traduit la courbe en `day` (jour de trouvaille, en
numéro de jour entier) et les compteurs en `day`, `cache_type`, `country`,
`state` selon les tuiles choisies. Les comptes par jour suffisent pour le
record, le nombre de jours et la plus longue série (`counterValues`).

**Âge à la trouvaille** (`age`) : écart entre `published_date` et
`date_find`, en dix tranches fixes (`ageBucket`) — le jour même, 1 à 7
jours, 8 jours à 1 mois, puis en mois calendaires révolus : 1-6 mois,
6-12 mois, 1-2 ans, 2-5 ans, 5-10 ans, 10-15 ans, 15 ans et plus. Une cache
sans date de publication (Labs, certains GPX), publiée avant mai 2000 ou
« trouvée avant d'être publiée » est exclue (pied « Sans date de
publication »). La tuile `same_day` lit la tranche 0 ; `oldest` le plus petit
jour de la clé interne `published` (mémoïsé par révision) — affichée comme
une année, sans animation de valeur. Les dates de publication des GPX sont
souvent à minuit UTC : « le jour même » peut glisser d'un jour selon le
fuseau de l'export.

**Points extrêmes** (tuiles `north`/`south`/`east`/`west`) : pas une
métrique à clés — avec la métrique interne `extremes` (`EXTREMES_METRIC`),
l'accumulateur retient la trouvaille record de chaque direction
(`acc.extremes`, `{ lat, lon, day, gc_code, name }`). Position lue dans la
géométrie GeoJSON (lon/lat) ; ignorées : locationless (position fictive du
GPX, affichées ou non), coordonnées nulles (0, 0) ou hors bornes. À
égalité, la première trouvaille rencontrée garde le record. La tuile affiche
la coordonnée au format des géocacheurs (`formatDdm` : « N 48° 51.396 »,
« W 004° 29.166 ») et, en détail, code GC · nom. L'antiméridien n'est pas
traité (est/ouest = longitude max/min).

Une valeur de tuile trop large (coordonnée, grand nombre sur tuile étroite)
réduit sa police jusqu'à ×1,1 avant d'être tronquée.

Une cache sans valeur pour une métrique (Lab sans D/T ni taille, GPX sans date
de publication) est **exclue** de cette métrique mais comptée dans le total ;
le pied du panneau l'annonce (« Sans D/T : 12 ») pour que la somme ne
surprenne pas. La présence de cette ligne est décidée sur la référence : la
hauteur du panneau ne change pas au premier Lab rencontré.

Les grilles affichent aussi une ligne de **couverture** en pied
(`options.show_coverage`, activée par défaut) : « Combinaisons : 45/81
(56 %) » pour la matrice D/T, « Mois : n/N (p %) » pour Jasmer, « Jours :
n/N (p %) » pour le calendrier — le pourcentage suit le format de la langue.
Chaque grille peut en plus afficher son nombre de **tours complets**
(`options.show_loops`, désactivée par défaut) : n est le nombre minimal de
trouvailles sur les cases disponibles — « Tours de matrice » (81
combinaisons D/T), « Tours de Jasmer » (chaque mois de publication depuis
mai 2000 jusqu'au mois de fin, cases désactivées exclues), « Tours de
calendrier » (366 jours, 29 février compris).

**Année d'activité** (`grid/activity`) : une colonne par semaine (lundi
en tête, 53 ou 54 colonnes), une case par jour de l'année ; les jours hors
de l'année sont désactivés. Elle compte des jours de trouvaille : ses
comptes, surbrillances et exclus vivent dans la métrique `day`
(`countMetricOf`), partagée avec la courbe et les compteurs. L'année
affichée est celle du jour en cours d'animation — la grille passe à
l'année suivante au 1ᵉʳ janvier, jours vides compris (`touch`) — et, au
repos, celle de la dernière trouvaille de la sélection ; le titre par défaut
la porte (« Activité 2025 »). Cases en intensité par défaut (max de la
référence), 520 px de large, mois en en-tête sur la semaine qui voit leur
1ᵉʳ (`sparseColLabels`). Pas d'option « tours ».

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

Exception voulue : **`sort: "race"`** (course de barres). L'ordre et le top-N
suivent alors l'état courant et l'échelle le meneur du moment ; pas de ligne
« Autres ». Le nombre de places reste fixe (`model.slots`), pour que la hauteur
du panneau ne change pas quand des catégories entrent dans le classement. De
même, la largeur de la colonne d'étiquettes est mesurée sur **toutes** les
catégories classées (`model.allLabels`, mémoïsé par révision), pas seulement
le top-N affiché : un nom long qui entre dans le classement ne décale plus
les barres en pleine animation.

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
surbrillance resterait figée. Le test « encore une surbrillance ? », relu à
chaque frame, ne scanne pas les clés de la métrique : `latestHit` garde les
max `at`/`newAt` par métrique, et `at` étant monotone et ≤ `now` pendant
l'animation, le plus récent décide pour toutes les clés — lecture O(1) par
panneau, quel que soit leur nombre (owner, attribute…).

L'option « nouveautés » n'est proposée qu'aux types où un déblocage diffère
d'un incrément (grille, barres, anneau) : courbe et compteurs la traitent
comme « chaque trouvaille », le choix n'apparaît donc pas. En Évolution, la
métrique « statut » et les courbes n'ont aucun surlignage : le champ entier
est masqué dans le formulaire.

### Valeurs animées

Longueurs de barres, parts d'anneau, tête de la courbe et compteurs glissent
vers leur nouvelle valeur au lieu de sauter (`createTweenStore`, même durée
que la surbrillance, à l'horloge des points). La première passe après un
démarrage est immédiate (l'état initial ne « pousse » pas) ; ensuite, une
catégorie qui apparaît part de 0. Au repos, tout est immédiat. Tant qu'une
valeur glisse, `tickStatsPanels` renvoie vrai, comme pour la surbrillance.
En course de barres, la place de chaque ligne est elle aussi animée.

Couleurs `multi` (anneaux hors types) : dix teintes, indexées sur le rang de
la catégorie dans la référence — une catégorie garde sa couleur quand elle
change de place. La palette `gc` n'est proposée qu'à la métrique « type de
cache », les autres métriques n'ayant pas de couleur Groundspeak dédiée.

## Rendu

Les renderers ne lisent jamais le DOM. `stats_panels.js` prépare une **vue**
(modèle + libellés traduits + couleurs + formats de nombres) ; la géométrie se
calcule en px CSS depuis la largeur — et une hauteur totale optionnelle
(`position.height`, ignorée des grilles) — ce qui donne la hauteur
(`measure`) avant de dessiner, puis le dessin à n'importe quelle échelle.
`drawStatsPanel` déduit la hauteur logique de `rect` au même rapport :
re-résolue comme une hauteur imposée, idempotente, le dessin remplit le rect.

La vue est reconstruite à chaque frame d'un tween : les calculs qui ne
dépendent que des comptes — jours triés, points cumulés de la courbe, record
du jour et plus longue série des compteurs — sont mémoïsés par révision
d'accumulateur (`dayIndex` dans `stats_model.mjs`), donc recalculés à
l'ajout d'un lot, pas à chaque frame. De même le tri des clés des
histogrammes (`barModel`, indexé sur les révisions de l'état courant et de
la référence + la signature d'options) et le rang des couleurs `multi`
(`colorIndexer`, par révision de la référence). `barModel` renvoie des
**copies** de ses lignes : l'animation y écrit `shown`/`slot` et le modèle
en cache ne doit jamais être pollué.

La courbe (`line`) porte sous son axe des **jalons annuels** : un trait au
1ᵉʳ janvier de chaque année strictement entre les bornes (`yearTicks`), les
extrémités gardant leurs libellés. Le libellé d'un jalon est masqué quand il
chevaucherait les libellés de bord ou le jalon précédent — axe court, ou
dates complètes quand la période tient dans une année.

En mode principal, elle marque aussi les **paliers** franchis
(`options.show_milestones`, activée par défaut) : multiples d'un pas choisi
sur le total de la référence (`milestoneStep` : 100, 200, 500, 1000,
2000… — le plus fin qui donne au plus cinq paliers ; aucun sous 100
trouvailles), datés par `lineMilestones` (recherche dichotomique dans les
points cumulés). Un palier n'est dessiné qu'une fois atteint par la valeur
animée : pointillé depuis le bord gauche, nombre au bord (masqué s'il
chevauche le maximum ou le palier précédent), repère sur la contremarche
du jour. Son franchissement fait éclore un halo, porté par un tween 0 → 1
(`tweens.level`), donc reproductible en capture image par image ; le texte
alternatif liste « Paliers : 100 (date), … ».

- **Aperçu** : un `<canvas class="stats-panel">` par panneau dans
  `#mapWithFrames`, bitmap = taille CSS × `devicePixelRatio`, `z-index: 90`
  (sous le titre et les infos), `pointer-events: none`. Chaque canvas
  apparaît en fondu (~0,3 s, désactivé si `prefers-reduced-motion`).
  Redessin seulement quand la révision change ; les lectures de géométrie DOM
  n'ont lieu que sur invalidation (resize, `ResizeObserver`, réglages),
  jamais par frame.
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
(`dx` ignoré) ; ligne médiane : la pile entière est centrée.

Une pile de coin **contourne** `#titleFrame` et `#infosFrame` (rects mesurés à
l'invalidation, passés en obstacles) : si son premier panneau tomberait sur
l'une de ces boîtes, elle démarre juste après (8 px d'écart).

**Position libre** (`position.mode: "free"`) : `x`/`y` sont des fractions
[0, 1] de l'espace restant du cadre (`(W − w) · x`), donc le panneau reste
dans le cadre à toute taille d'aperçu ou de vidéo. Un panneau libre sort de sa
pile. Il s'obtient en glissant le panneau sur la carte tant que l'onglet Stats
est ouvert et qu'aucune animation ne tourne (classe `stats-editing` sur
`#mapWithFrames`, qui rend les canvas saisissables) ; choisir un coin dans le
formulaire le remet en mode `anchor`. Pendant le glisser, chaque `pointermove`
applique la position en place via `previewStatsPanelPosition` — sans
renormaliser le bloc ni toucher `settingsRev`, ce qui éviterait de reconstruire
les textes alternatifs à chaque mouvement ; le `commit` au dépôt renormalise
et persiste comme d'habitude. En mode édition, le bord droit du canvas est une
poignée de largeur (curseur `ew-resize`) : glissé, il change `position.width`
en aperçu via `previewStatsPanelWidth` (même mutation en place, la hauteur se
réadapte au prochain flush puisque `measure` dépend de la largeur) puis en
commit au dépôt. Le bord bas est de même une poignée de hauteur (`ns-resize`),
et le coin bas-droit règle les deux axes (`nwse-resize`) — hors grilles, dont
les cases carrées ne laissent rien à régler. `touch-action: none` sur les
panneaux éditables empêche le navigateur d'interpréter le geste tactile comme
un défilement.

**Hauteur optionnelle** (`position.height`, `null` par défaut, bornée à
60-1200 px CSS comme la largeur) : à `null`, la hauteur est déduite de la
largeur et du contenu (`measureStatsPanel`) ; renseignée — champ « Hauteur »
de la section Position, ou glisser du bord bas — elle est transmise aux
layouts, qui étirent ou compressent leur zone graphique jusqu'à un plancher
de lisibilité propre à chaque type (barres : une ligne lisible par rang ;
courbe : ~3,5 corps de texte ; compteurs : tuiles réparties ; anneau : son
diamètre grandit au-delà de son plafond quand la largeur l'offre, sans jamais
se compresser). Une hauteur stockée sur une grille reste ignorée : le champ
est masqué et `measure` n'en tient pas compte (cases carrées). Vider le champ
rend la hauteur à l'automatique.

Avertissements dans l'onglet (événement `mygcflow:stats-layout`) : panneau
ramené dans le cadre (pile trop haute, largeur supérieure à la carte), panneau
qui chevauche le titre ou les infos (panneau libre), deux panneaux de piles
différentes qui se recouvrent.

## Tests

- `node --test test_stats_model.mjs test_stats_render.mjs` — vecteurs
  partagés, clés, accumulateur, surlignage, grilles (Jasmer, 29 février…),
  ordre figé, top-N, empilement, jalons d'années, mesure mémoïsée des
  étiquettes de course, hauteur imposée (étirement, planchers, grille
  épargnée).
- `python -m unittest tests.test_stats_settings` — vecteurs partagés, ids,
  patch, fichier sans bloc `stats`, API GET/PUT/reset.
- `tests/e2e/stats-panels.spec.mjs` — modèle posé et ancré, empilement,
  persistance, remplissage pendant la lecture, totaux après un nouveau filtre,
  export qui repart de zéro et dessine les panneaux, interrupteur général, mode
  Évolution ; anneau, courbe, compteurs et course pendant une lecture (sans
  erreur de page), glisser-déposer puis retour au coin, réordonnancement de
  la liste à la souris, pile qui démarre sous le titre. `stats` est une préférence globale partagée par tous les specs :
  chaque test remet la liste vide en sortant.

## Mesures (2026-10-17)

Enregistrement MediaRecorder réel, échelle 2 (canvas 1984×1912), 30 i/s,
Chromium de Playwright sous Windows (rendu logiciel : temps absolus élevés,
seule la comparaison compte), fixture de 6 caches, alternance A/B/A/B :

| | frames composées | moyenne | médiane | p95 |
|---|---|---|---|---|
| sans panneau | 231 | 51,0 ms | 53,2 ms | 57,9 ms |
| 3 panneaux (matrice D/T, course des types, courbe) | 229 | 50,5 ms | 53,3 ms | 55,9 ms |

Aucun écart mesurable : la différence est sous le bruit entre deux passes
d'une même configuration (~5 %). Le nombre de frames composées ne bouge pas
non plus.

Coût isolé d'`addStatsPanelsToCanvas` pour ces 3 panneaux à l'échelle 2 :
~0,01 ms quand le cache hors écran sert (révision inchangée) ; 1,9 ms en
moyenne (médiane 1,4 ms, p95 5 ms) quand tout est redessiné — aperçu DOM et
canvas vidéo —, ce qui n'arrive que les frames où un jour s'ajoute ou
pendant une surbrillance ou une valeur qui glisse. Non mesurés : les grandes
grilles (Jasmer, calendrier 366, ~300-370 cases) et une base réelle de
plusieurs milliers de caches.

## Ajouter un type de panneau

Une entrée dans `STATS_RENDERERS` (`measure` + `draw`), la liste de ses
métriques et le schéma de ses options des deux côtés (`stats_settings.py`,
`stats_model.mjs`, avec des vecteurs dans `settings_cases.json`), sa vue dans
`stats_panels.js › buildView`, ses champs dans `menu_stats.html`
(`data-stats-kind`) et `stats_ui.js › FIELDS`. Une nouvelle grille, elle, n'est
qu'une entrée dans `gridSpec`.

Le panneau sélectionné s'exporte en **PNG** (instantané du canvas) et en
**CSV** (ses valeurs) depuis le formulaire. Le nom du fichier est le titre
du panneau — ou son titre par défaut — en slug ASCII (« Ma D/T ! » →
`stats-ma-dt.png`) ; un titre dont le slug serait vide (écriture non latine)
retombe sur `stats-{kind}-{metric}`.

La liste du mode courant s'exporte en JSON et se ré-importe depuis le menu
« Configurations » (`stats-panneaux-{mode}.json` : `{mode, panels}` ; à
l'import, la liste est lue dans un tableau, `panels`, `evolution_panels` ou
un bloc `stats` complet, puis normalisée comme une configuration appliquée).
Un fichier lisible mais sans panneau exploitable (liste vide, panneaux tous
invalides) est refusé **avant** le commit — la liste courante n'est jamais
vidée par un import raté.
Non couvert : l'inclusion du bloc `stats` dans un thème.
