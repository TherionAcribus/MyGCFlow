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
| `grid` | `dt` (matrice D/T 9×9), `jasmer` (année × mois de publication, depuis mai 2000), `finds_ym` (année × mois de trouvaille), `calendar` (mois × jour de trouvaille, 366 cases), `activity` (une année, semaines × jours, façon contributions GitHub) |
| `bar` | `cache_type`, `container`, `difficulty`, `terrain`, `year`, `month`, `weekday`, `age` (âge de la cache à la trouvaille, 10 tranches), `country`, `state`, `attribute`, `owner` |
| `donut` | `cache_type`, `container`, `country`, `state`, `attribute`, `owner` — anneau, camembert si `hole` vaut 0 |
| `line` | `cumulative` — trouvailles cumulées, en escalier |
| `counter` | `summary` — tuiles choisies dans `options.items` : `total` (nombre de trouvailles), `days` (jours avec trouvaille), `best_day` (record sur une journée), `streak` (plus longue série de jours consécutifs), `types`, `countries`, `states`, `attributes`, `owners` (valeurs distinctes connues), `oldest` (plus ancienne cache trouvée : année + date de publication), `same_day` (trouvées le jour de leur publication), `north`, `south`, `east`, `west` (trouvaille la plus au nord… en coordonnées géocaching) |

Mode Évolution (`stats.evolution_panels`) :

| Type (`kind`) | Métriques (`metric`) |
|---|---|
| `bar` | `cache_type`, `container`, `difficulty`, `terrain`, `country`, `state`, `county`, `status` (actives vs archivées), `lifetime` (durée de vie : archivage − pose, six tranches) |
| `donut` | `cache_type`, `container`, `country`, `state`, `county`, `status` |
| `line` | `actives` (présentes à la date), `placees`, `archivees` (cumuls) |
| `counter` | `summary` — tuiles : `actives`, `placees`, `archivees`, `peak` (pic d'actives), `age_moyen` (âge moyen des actives), `types`, `countries`, `states` |

Les barres et anneaux Évolution acceptent `options.counted` :
`active` (ensemble vivant à la date affichée, défaut), `placed` ou
`archived` (cumuls des événements). `status` l'ignore ; `lifetime` vise
`archived` par défaut (`countedUniverse`, stats_model.mjs) — le seul
ensemble dont les six tranches se remplissent en animant : les caches
encore actives tombent parmi les exclues (« Jamais archivées »). Les
comptes rejouent la chronologie (`placedOrder`/`archivedOrder` de
`evolution_timeline.mjs`) au jour affiché ou au jour de fin de plage.
La tuile `age_moyen` lit la même chronologie : deux sommes préfixes de
jours de pose (mémoïsées par timeline) donnent Σ(jour − pose) sur
l'ensemble vivant en deux lectures — `evolutionMeanActiveAge`, valeur
`null` (« — ») quand aucune cache n'est active.

**Galerie « Ajouter »** (2026-10-22, remplace un menu déroulant d'une
trentaine d'entrées) : le bouton ouvre `#statsGalleryModal`
(menu_stats.html), des cartes rangées en six sections — ensembles de deux
panneaux, grilles, chiffres et courbes, caractéristiques des caches, lieux et
propriétaires, dates de trouvaille. Le catalogue vit dans le gabarit (liste
Jinja : type, valeur, titre, description, description Évolution facultative,
modes, nombre de panneaux) ; chaque carte garde `data-stats-preset` (clé de
`PRESETS`, stats_ui.js) ou `data-stats-add` (« type:métrique »), et le
conteneur l'id `statsAddMenu`. À chaque ouverture, chaque carte du mode
dessine ses panneaux tels qu'ils apparaîtraient au repos, avec les données de
la sélection (`drawStatsGalleryPreviews`, stats_panels.js) : un comptage
unique de TOUTES les métriques des vignettes (`gallerySource`, mémoïsé par
révision de l'index ou, en Évolution, par révision + `restDay`), des vues
construites avec `buildView(panel, source)` — repos forcé, valeurs immédiates,
magasin de tweens jetable : rien ne touche l'état des panneaux posés. La
recherche (focus à l'ouverture) ignore accents et casse, porte sur le titre,
la description du mode et le nom des formes (« anneau », « courbe »…). Un clic
pose le panneau ou le modèle, le sélectionne et referme la galerie ; une carte
qui demande plus de places qu'il n'en reste est désactivée (« 2 places
requises »), l'en-tête dit les places libres. Retirés car doublons d'une
entrée simple : les modèles « Types en anneau » et « Actives et archivées ».
Les vignettes sont réduites par `object-fit: contain` dans une boîte flex de
hauteur fixe — en grille CSS à rangée automatique, `height: 100%` ne tenait
pas et un panneau haut (matrice, Jasmer) débordait sur le texte de la carte.

**« Appliquer cette apparence à tous les panneaux »** (section Apparence,
2026-10-22) : `applyStyleToAll` (stats_ui.js) recopie le style du panneau
sélectionné sur les autres panneaux de la liste du mode, masqués compris —
`SHARED_STYLE_KEYS` : fond, opacité, texte, couleur principale, taille du
texte, arrondi, police héritée. **Pas la palette** : elle dépend de la
métrique (« couleurs des types » n'a de sens que pour les types, « dégradé »
est le défaut de la difficulté). Toast « Annuler » qui ne remet que ces
champs, par id (un réglage fait entre-temps sur un autre aspect survit) ;
toast simple si tous ont déjà ce style ; bouton désactivé quand le panneau
est seul.

**Préréglages d'apparence** (section Apparence, 2026-10-24) : quatre cartes
`STATS_STYLE_PRESETS` (stats_model.mjs) — « Sombre » (le défaut), « Clair »,
« Verre », « Sans fond » — qui fixent chacune complètement
`STATS_PRESET_STYLE_KEYS` : fond, opacité, texte, couleur principale et
arrondi. Taille et famille du texte restent un choix de lisibilité, la
palette reste liée à la métrique. Chaque carte montre le panneau lui-même
dessiné dans ce style (`drawStatsStylePresetPreview`, stats_panels.js : vrai
pipeline, réduit proportionnellement dans la vignette) ; celle qu'il porte
exactement est enfoncée (`matchingStatsStylePreset`, couleurs comparées sans
la casse — une taille de texte ou une palette personnelle ne « dématche »
pas). Toast « Annuler » qui ne remet que les champs du préréglage, comme
« Appliquer à tous ».

Le select « Forme » du formulaire (section Contenu) propose les types qui
savent dessiner la métrique courante — il n'apparaît que quand il y en a
plusieurs, donc pour les métriques catégorielles partagées entre barres et
anneau. Changer un histogramme en anneau garde titre, position et apparence ;
les options reprennent les défauts du type choisi. Un aperçu du panneau
sélectionné est dessiné en tête du formulaire avec le même pipeline que la
carte (`drawStatsPanelPreview`), à la largeur réelle du panneau — utile sur
écran étroit, quand la carte est hors vue pendant le réglage ; un panneau
à métrique étrangère au mode n'y est pas dessiné, comme sur la carte. Il
suit aussi les données : redessiné à la fin d'un `flush` dont la révision a
changé, tant que l'onglet Stats est ouvert (pas de dessin d'un canvas
invisible à chaque frame d'animation), et à l'ouverture de l'onglet.

## Modules

| Fichier | Rôle |
|---|---|
| `stats_settings.py` | Schéma, défauts par métrique, coercition serveur (`coerce_stats_settings`) |
| `static/js/stats_model.mjs` | Pur : normalisation miroir, accumulateur, clés par métrique, grilles, histogrammes, mise en page |
| `static/js/stats_render.mjs` | Pur : dessin Canvas 2D (`measure` + `draw` par type, registre `STATS_RENDERERS`) |
| `static/js/stats_panels.js` | Cycle de vie : canvas d'aperçu, accumulation, totaux, rendu vidéo |
| `static/js/stats_ui.js` | Onglet Stats : liste, modèles, formulaire, sauvegarde débouncée |
| `static/js/panel_interactions.js` | Glisser-déposer, aimantation, poignées — partagé avec les images (onglet Images) et repris par le titre/les infos |
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
record, le nombre de jours et la plus longue série (`counterValues`). La
tuile `total` lit `acc.total`, incrémenté à chaque cache sans condition ;
sa dépendance est une pseudo-métrique constante (`KEY_OF.total` rend 1) —
sans elle, un panneau réduit à cette tuile n'aurait aucune métrique à
demander et l'ensemble vide court-circuiterait `accumulateStatsForDates`.

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

Les nombres des cases de grille (`cell_mode: count`) ont une taille et un
format communs à toute la grille (`gridValueFit`, stats_render.mjs), calés
sur le maximum de la référence — donc fixes pendant l'animation : format
complet rétréci d'un quart au plus, sinon format court (`notation:
'compact'` : « 12,3 k », « 1.2K »), sinon le premier des deux qui tient
au-dessus de 7 px, sinon pas de nombres (la case se lit à son intensité).
Le texte tient dans 86 % de la case. Avant (2026-10-22), « 1 234 » touchait
les cases voisines d'une matrice D/T de 280 px et « 12 345 » débordait.

**Échelle de couleur logarithmique** (`heatLevel`, stats_render.mjs,
2026-10-22) : l'opacité d'une case (modes « Nombre » et « Intensité ») vaut
`0,3 + 0,7 × log(1 + n) / log(1 + max)`, et celle d'une barre ou d'une part en
palette « Dégradé » `0,35 + 0,65 × …` sur le même modèle. Le maximum vient de
la référence. En linéaire, une case à 2 000 trouvailles rendait 1, 10 et 100
quasi identiques (30 %, 30 %, 33 %) ; en log : 36 %, 52 %, 72 %. Choix de
l'utilisateur : automatique, sans réglage (ni linéaire ni paliers par rang).

Une cache sans valeur pour une métrique (Lab sans D/T ni taille, GPX sans date
de publication) est **exclue** de cette métrique mais comptée dans le total ;
le pied du panneau l'annonce (« Sans D/T : 12 ») pour que la somme ne
surprenne pas. La présence de cette ligne est décidée sur la référence : la
hauteur du panneau ne change pas au premier Lab rencontré.

Les grilles affichent aussi une ligne de **couverture** en pied
(`options.show_coverage`, activée par défaut) : « Combinaisons : 45/81
(56 %) » pour la matrice D/T, « Mois : n/N (p %) » pour Jasmer et les
trouvailles mois × année, « Jours : n/N (p %) » pour le calendrier — le
pourcentage suit le format de la langue.
Chaque grille peut en plus afficher son nombre de **tours complets**
(`options.show_loops`, désactivée par défaut) : n est le nombre minimal de
trouvailles sur les cases disponibles — « Tours de matrice » (81
combinaisons D/T), « Tours de Jasmer » (chaque mois de publication depuis
mai 2000 jusqu'au mois de fin, cases désactivées exclues), « Tours année ×
mois » (chaque mois de la première à la dernière année de trouvaille),
« Tours de calendrier » (366 jours, 29 février compris).

**Trouvailles mois × année** (`grid/finds_ym`) : la « grille Jasmer des
trouvailles » — mêmes clés (année × 100 + mois) mais sur `date_find` au
lieu de `published_date`, et une ligne par année **de la première à la
dernière trouvaille** au lieu du plafond fixe de mai 2000. Les bornes se
lisent sur les comptes de la référence (`ymYearBounds`), comme les
échelles : la géométrie ne change pas pendant l'animation. Aucune case
désactivée : un mois sans trouvaille est une information, pas une
combinaison impossible. Cases en intensité par défaut (`cell_mode: heat`,
comptage dense comme l'année d'activité), le pied d'exclusion est « Sans
date de trouvaille ».

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

Le **saut** de la barre de chronologie (aperçu en pause) est incrémental,
comme `seekPointsToDay` pour les points de la carte : les features sont
indexées une fois par révision (`statsDayIndex`, jours triés → visibles puis
masquées), et seuls les jours entre l'ancienne et la nouvelle position sont
ajoutés (`add`, sans horloge) ou retirés (`remove` — la clé retombée à 0 est
gardée). Un record d'extrêmes né dans un jour retiré est replié sur les jours
restants, premier gagnant à égalité (`extremesOfFeatures` + `foldExtreme`).
Un saut ne redescend jamais sous les jours d'avant la date de début (`basePos`),
déjà comptés au lancement. En Évolution, les événements de l'intervalle
(`evolutionEventsBetween`) sont appliqués en avant ou défaits en arrière
(`rewind` — archivages avant poses, ordre chronologique inverse) au lieu de
rejouer toute la chronologie.

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
  Redessin seulement quand la **clé de dessin du panneau** change (voir
  ci-dessous) ; les lectures de géométrie DOM n'ont lieu que sur invalidation
  (resize, `ResizeObserver`, réglages), jamais par frame.
- **Vidéo** : `addStatsPanelsToCanvas(ctx, w, h, scaleFactor)` est appelé dans
  les deux pipelines **avant** `addOverlaysToCanvas`, pour le même empilement
  que l'aperçu. Géométrie = mise en page de l'aperçu × `scaleFactor`, ancrée
  depuis le même coin (`left`/`right`, `top`/`bottom`). Chaque panneau est rendu
  dans un canvas hors écran gardé tant que sa clé de dessin et l'échelle ne
  changent pas : un panneau immobile coûte un `drawImage`.
- **Signature MediaRecorder** : `overlayContentSignature()` inclut
  `getStatsRevision()`.

**Clé de dessin par panneau** (`panelDrawKey`, 2026-10-22). Deux révisions :
`revision` (globale, avance à toute frame où un panneau peut changer — elle
sert la signature MediaRecorder) et `contentRevision` (contenu commun :
comptes, réglages, mode, cadre). La clé d'un panneau = `contentRevision` +
jour de tête (courbe) + année (activité) + **horloge seulement tant que ce
panneau anime** (`panelAnimating` : une de ses valeurs glisse, ou une de ses
surbrillances s'estompe) + taille. Les valeurs animées ont un magasin par
panneau (`tweensOf(id)`), pour savoir lequel anime encore. Conséquences :
pendant qu'un histogramme glisse, une matrice sans surbrillance garde son
bitmap (aperçu et vidéo) ; un jour sans trouvaille (`touchFrame`) ne
redessine que la courbe et l'année d'activité ; glisser un panneau déplace
son canvas sans redessiner personne, le redimensionner ne redessine que lui.
À la fin d'une animation, la clé perd l'horloge : une dernière frame nette,
puis plus rien. `getStatsSnapshot().draws` compte les dessins par panneau
(`preview`, `video`) — spec « seul le panneau qui anime est redessiné ».
Effet de bord voulu : un panneau ajouté en pleine animation affiche d'emblée
son état (son magasin neuf démarre « immédiat »), au lieu de pousser depuis 0.

**Équivalent textuel** : chaque canvas (`aria-hidden`) a un frère
`.stats-panel-alt.visually-hidden` — titre, comptes réels (jamais les valeurs
animées), lignes de pied, en `<ul>` ; pas de région `aria-live`. Il n'est
reconstruit que quand sa clé change (mode, réglages, révision de l'index et de
l'accumulateur, jour de tête, année). **En animation, au plus une
reconstruction par seconde** (`A11Y_ANIMATION_INTERVAL_MS`, 2026-10-22) : une
grille porte des centaines de `<li>` (calendrier : jusqu'à 366), refaits sinon
à chaque jour avec trouvaille alors que personne ne les lit en pleine lecture.
Le premier changement après un calme passe aussitôt ; un minuteur rattrape le
dernier, donc en pause ou en fin de lecture le texte colle aux comptes
affichés en moins d'une seconde. Au repos, rien n'est différé.
`getStatsSnapshot().a11yRebuilds` compte les reconstructions.

**Infobulle de survol** (2026-10-24). En mode édition (les canvas reprennent
`pointer-events`), `pointermove` délégué sur `#mapWithFrames` affiche ce
qu'il y a sous le pointeur — le même texte que la ligne de l'équivalent
textuel (« D2/T3 : 4 », « Multi-cache : 2 », « 12/03/2026 : 8 »). Le
hit-testing vit dans le renderer (`hitStatsPanel`, `stats_render.mjs`) :
chaque type déclare `hit()` qui réutilise son layout, donc les zones
collent aux pixels dessinés — case désactivée, trou de l'anneau, interstice
entre tuiles ou pied de page ne répondent pas. `statsPanelHoverText`
(stats_panels.js) convertit le résultat en ligne traduite depuis la vue de
la dernière passe (`node.view`) : la bulle suit l'animation comme le
canvas. Un bouton enfoncé (glisser, redimensionner) la masque, comme le
départ du pointeur ou le changement d'onglet ; la bulle elle-même est
`pointer-events: none` pour ne jamais se mettre sous elle-même.

### Mise en page

`layoutPanels` (pur) : les panneaux d'une même ancre forment une pile, du coin
vers l'intérieur, séparés d'un **écart fixe de 8 px**. Les marges de la pile
(distance aux bords) sont les `dx`/`dy` de son premier panneau. Colonne
centrale : centré horizontalement (`dx` ignoré) ; ligne médiane : la pile
entière est centrée (`dy` ignoré, champ grisé).

**Marges de coin.** `dx`/`dy` restent stockés dans chaque panneau (une
configuration nommée ou un export JSON reste autonome), mais la normalisation
— `shareCornerMargins` (JS) / `_share_corner_margins` (Python), vecteur
partagé « marges communes… » — les rend communes à tous les panneaux ancrés au
même coin : celles du premier de la liste, désactivé ou non, gagnent. Avant,
`dy` servait de marge au premier panneau et d'écart aux suivants : réordonner
une pile la déplaçait. L'onglet maintient l'invariant de lui-même : modifier
une marge l'écrit sur toute la pile (`cornerMates`), et un panneau qui rejoint
un coin (choix d'ancre, « retour au coin ») en prend d'abord les marges
(`adoptCornerMargins`) — sans quoi, placé avant les autres dans la liste, il
imposerait les siennes. Les panneaux libres gardent leurs `dx`/`dy`, reprises
s'ils reviennent à un coin vide.

Une pile de coin **contourne** `#titleFrame` et `#infosFrame` (rects mesurés à
l'invalidation, passés en obstacles) : si elle recouvrait l'une de ces boîtes
— sur toute sa hauteur, pas seulement par son premier panneau — elle démarre
entière juste après (8 px d'écart) ; une pile ne passe pas « par-dessus » une
boîte. Les piles de la ligne médiane ne contournent rien (le titre et les
infos ne s'ancrent qu'en haut ou en bas) ; un chevauchement y est signalé.

**Titre et infos : même placement que les panneaux.** Style › Titres, mode
simple : même grille d'emplacements (lignes haute et basse seulement) et mêmes
marges que les panneaux, et même glisser-déposer aimanté (48 px, Alt pour
désactiver) tant que ce sous-onglet est ouvert (classe `overlay-editing` sur
`#mapWithFrames`). Le modèle reste le CSS du thème : `overlay_anchor.mjs` (pur)
traduit emplacement + marges en déclarations et les relit,
`infos_editor.js` les écrit par le pipeline de l'assistant
(`change*CssValues`) puis émet `change` sur le textarea pour que le suivi
« modifications non enregistrées » du thème voie un dépôt sur la carte.
Centré : `left: 0; right: 0; margin: 0 auto; width: fit-content` (pas
`left: 50%` + `transform`, qui limiterait un long titre à la mi-largeur) ;
overlay_canvas.js reprend le rect du DOM. Position libre : `left`/`top` en %
du cadre — en px, elle serait indiscernable d'un ancrage en haut à gauche.
Deux pièges : `titre.css` et `infos.css` sont chargées comme feuilles et
fixent top/left (top/right) — un côté retiré du CSS en ligne y resterait
effectif, d'où les côtés inutilisés posés à `auto` ; et Chromium sérialise
alors les quatre côtés en `inset`, que `parseDeclarations` (ui.js) déplie pour
les champs Haut/Droite/Bas/Gauche du mode avancé. Chaque déplacement d'un
cartouche invalide la mise en page des panneaux (`invalidateStatsLayout`) :
les piles le contournent aussitôt.

**Position libre** (`position.mode: "free"`) : `x`/`y` sont des fractions
[0, 1] de l'espace restant du cadre (`(W − w) · x`), donc le panneau reste
dans le cadre à toute taille d'aperçu ou de vidéo. Un panneau libre sort de sa
pile. Il s'obtient en glissant le panneau sur la carte tant que l'onglet Stats
est ouvert et qu'aucune animation ne tourne (classe `stats-editing` sur
`#mapWithFrames`, qui rend les canvas saisissables) ; choisir un coin dans le
formulaire le remet en mode `anchor`.

**Aimantation.** Au début du glisser, `getStatsSnapTargets(id)`
(stats_panels.js) calcule pour chaque coin — sauf `middle-center`, comme
« Réorganiser » — le rect que prendrait le panneau s'il y était ancré :
`layoutPanels` rejoué avec le panneau déplacé dans ce coin, marges de la pile
reprises, titre et infos contournés, place dans la pile fixée par l'ordre de la
liste ; les coins où il déborderait ne sont pas proposés. Pendant le geste, le
panneau suit le pointeur et un repère (`.panel-snap-ghost`, contour en
pointillés au-dessus des panneaux, sous le titre et les infos) montre
l'emplacement le plus proche à moins de 48 px (coin haut-gauche contre coin
haut-gauche). Lâché là, le panneau rejoint la pile (`withSnappedAnchor` :
mode `anchor`, marges adoptées) ; ailleurs, il passe en position libre. Alt
maintenue désactive l'aimantation. Un petit glisser involontaire d'un panneau
ancré le ramène donc dans sa pile au lieu de le détacher. Pendant le glisser, chaque `pointermove`
applique la position en place via `previewStatsPanelPosition` — sans
renormaliser le bloc ni toucher `settingsRev`, ce qui éviterait de reconstruire
les textes alternatifs à chaque mouvement ; le `commit` au dépôt renormalise
et persiste comme d'habitude. En mode édition, un bord vertical du canvas est
une poignée de largeur (curseur `ew-resize`) : glissé, il change
`position.width` en aperçu via `previewStatsPanelWidth` (même mutation en
place, la hauteur se réadapte au prochain flush puisque `measure` dépend de la
largeur) puis en commit au dépôt. Un bord horizontal est de même une poignée de
hauteur (`ns-resize`), et le coin qu'elles partagent règle les deux axes
(`nwse-resize` ou `nesw-resize`) — hors grilles, dont les cases carrées ne
laissent rien à régler.

**Dupliquer** (bouton de la ligne) : la copie suit l'original dans la liste.
Ancrée, elle s'empile dans le même coin ; libre, sa position passe par
`offsetFreeCopy` (stats_model.mjs, partagé avec les images) — décalée de
24 px vers le bas et la droite, vers le haut ou la gauche sur un axe sans
place, de 4 % de l'espace restant si l'original n'est pas affiché. Avant le
2026-10-22, la copie d'un panneau libre recouvrait exactement l'original.

**Clavier.** En mode édition, les flèches déplacent le panneau sélectionné
de 1 px (10 px avec Maj) ; un panneau ancré passe alors en position libre à
sa place affichée (`nudge`, panel_interactions.js — partagé avec les
Images). Hors champs de formulaire, où les flèches gardent leur rôle natif.

Les poignées sont posées sur les bords **qui bougent** quand la taille change
(`resizeEdges`, panel_interactions.js), pour rester sous le pointeur : droit et bas en
général, gauche pour un panneau ancré à droite, haut pour un panneau ancré en
bas (delta du pointeur inversé). Un panneau centré sur un axe (colonne
centrale, ligne médiane) grandit des deux côtés : poignée à droite (en bas),
delta doublé. Un panneau libre garde son coin haut-gauche : `x`/`y` étant des
fractions de l'espace restant, qui change avec la taille,
`pinStatsPanelCorner` épingle ce coin au début du geste et chaque flush
recalcule `x`/`y` en place après la mesure ; `unpinStatsPanelCorner` (au
dépôt, avant le commit) applique le dernier aperçu en attente puis retire
l'épingle, et le commit reprend ces `x`/`y`. `touch-action: none` sur les
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

**Unités et taille de fenêtre (limite assumée).** Largeurs, hauteurs, marges
et corps de texte sont en px CSS de l'aperçu, comme le titre et les infos. La
vidéo étant l'aperçu agrandi (`captureRatioFor`, capture_resolution.mjs : une
sortie 1080p depuis une carte de 540 px est rendue ×2), un panneau occupe dans
la vidéo exactement la part de l'image qu'il occupe à l'écran. Il n'y a en
revanche pas de format vidéo fixe : cadrage, rapport largeur/hauteur et taille
relative de tout ce qui est affiché par-dessus la carte suivent la fenêtre.
Une mise en page conçue sur un grand écran paraît donc plus chargée sur un
portable (avertissements de débordement à l'appui). Écarté le 2026-10-19 :
rendre les seuls panneaux proportionnels (incohérent avec le titre et les
infos, qui restent en px). Le remède complet serait un « format vidéo »
(rapport fixe, aperçu encadré, résolution de référence), à planifier à part si
le besoin se confirme.

**« Réorganiser »** (bouton de l'alerte) : `arrangePanels` (stats_model.mjs,
pur), alimenté par `arrangeStatsPanels` (stats_panels.js : tailles mesurées,
cadre, titre et infos, marges de coin lues sur la liste entière). Les panneaux
affichés sont parcourus dans l'ordre de la liste ; chacun garde sa place
(ancrée ou libre) s'il ne gêne aucun panneau déjà placé, sinon il prend le
premier emplacement qui minimise la gêne — surface des chevauchements avec les
panneaux et les obstacles, plus une pénalité par débordement, toujours pire
qu'un chevauchement. Ordre de préférence : les quatre coins, les bords
latéraux, puis les centres haut et bas ; jamais le centre de la carte. L'ordre
de la liste rend l'essai exact (un panneau ajouté en bout de pile ne déplace
pas les précédents). Un panneau qui rejoint un coin prend les marges de sa
pile, un coin vide reçoit 16/16. Les panneaux masqués ne bougent pas. Si un
conflit subsiste (`conflict > 0`), le toast dit que la place manque au lieu
d'annoncer un succès ; « Annuler » restaure la liste d'avant.

## Tests

- `node --test test_stats_model.mjs test_stats_render.mjs` — vecteurs
  partagés, clés, accumulateur, surlignage, grilles (Jasmer, 29 février…),
  ordre figé, top-N, empilement, jalons d'années, mesure mémoïsée des
  étiquettes de course, hauteur imposée (étirement, planchers, grille
  épargnée).
- `python -m unittest tests.test_stats_settings` — vecteurs partagés, ids,
  patch, fichier sans bloc `stats`, API GET/PUT/reset.
- `tests/e2e/stats-panels-*.spec.mjs` (quatre specs thématiques : cycle de
  vie, comptage, mise en page, formulaire ; helpers partagés dans
  `stats-panels-helpers.mjs`) — modèle posé et ancré, empilement,
  persistance, remplissage pendant la lecture, totaux après un nouveau filtre,
  export qui repart de zéro et dessine les panneaux, interrupteur général, mode
  Évolution ; anneau, courbe, compteurs et course pendant une lecture (sans
  erreur de page), glisser-déposer puis retour au coin, réordonnancement de
  la liste à la souris, pile qui démarre sous le titre, redessin limité au
  panneau qui anime (horloge pilotée à la main, compte des dessins). `stats` est une préférence globale partagée par tous les specs :
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

Le panneau sélectionné s'exporte en **PNG** et en **CSV** (ses valeurs)
depuis le formulaire. Le nom du fichier est le titre du panneau — ou son
titre par défaut — en slug ASCII (« Ma D/T ! » → `stats-ma-dt.png`) ; un
titre dont le slug serait vide (écriture non latine) retombe sur
`stats-{kind}-{metric}`.

**PNG à l'échelle** (2026-10-22) : le panneau tel qu'il est affiché (mêmes
comptes, même instant d'animation) est **redessiné** à 1×, 2× (défaut) ou 4×
de sa taille CSS sur la carte (`statsPanelPngBlob(id, scale)`,
`STATS_PNG_SCALES`) — pas un agrandissement du bitmap d'écran, donc net à
toute échelle ; 2× ≈ vidéo 1080p depuis une carte de 540 px, 4× ≈ 4K.
Suffixe `@2x` / `@4x` au-delà de 1×. Le select affiche les pixels de chaque
échelle (« 2× — 560 × 620 px », `statsPanelExportSize`), rafraîchis avec
l'aperçu du formulaire (événement `mygcflow:stats-preview`) : calculés
avant le chargement des données, ils restaient sinon ceux d'un panneau vide.
Choix retenu dans `localStorage` (`statsPngScale`). Un panneau masqué
s'exporte aussi, à sa largeur réglée ; un panneau à métrique étrangère au
mode, non (bouton grisé).

**PNG groupé** (2026-10-24) : « Exporter tous les panneaux (PNG) » dans le
menu « Configurations » produit **une** image de la taille du cadre de la
carte, tous les panneaux visibles à leur place — le tableau de bord tel
qu'affiché, sur fond transparent (`statsPanelsPngBlob`, même pipeline que
la vidéo : `addStatsPanelsToCanvas`). L'échelle est celle du sélecteur du
formulaire (`statsPngScale`) ; l'indice « 2× — 1588 × 1712 px » est relu à
chaque ouverture du menu (`statsPanelsExportSize`). Fichier
`stats-panneaux-{mode}[@Nx].png`. Grisé sans panneau visible.

La liste du mode courant s'exporte en JSON et se ré-importe depuis le menu
« Configurations » (`stats-panneaux-{mode}.json` : `{mode, panels}` ; à
l'import, la liste est lue dans un tableau, `panels`, `evolution_panels` ou
un bloc `stats` complet, puis normalisée comme une configuration appliquée).
Un fichier lisible mais sans panneau exploitable (liste vide, panneaux tous
invalides) est refusé **avant** le commit — la liste courante n'est jamais
vidée par un import raté.
Non couvert : l'inclusion du bloc `stats` dans un thème.
