# Images sur la carte (onglet Images)

Avatar, logo d'association… posés sur la carte et repris dans la vidéo. Plan et
décisions : `MyGCFlow_Plan_Images.md`. Placement commun avec les panneaux de
stats : `docs/panneaux-stats.md` › Mise en page.

## Décisions

- **Onglet propre « Images »**, distinct de « Stats » (réservé aux statistiques).
- **Préférence globale** `images` (settings.json), pas un réglage de thème :
  l'identité de l'utilisateur ne change pas avec le thème. **Une liste par
  page**, comme `stats` : `items` (« Mes Geocaches », `/`) et
  `evolution_items` (`/evolution`), indépendantes — la page se choisit par
  `isEvolutionPage()` (app_mode.mjs) — ; `enabled` reste commun aux deux.
- **Priorité de placement : Titre/Infos > Images > Stats.** Les images
  contournent les cartouches ; les piles de stats contournent les cartouches
  et les images.
- **4 images** au plus ; **PNG, JPEG, WebP, GIF** (première image), **SVG**
  rastérisé dans le navigateur avant envoi ; **8 emplacements** (tous sauf
  le centre de la carte).

## Modules

| Fichier | Rôle |
|---|---|
| `image_library.py` | Dossier `images/` : normalisation Pillow, empreinte, inventaire, balayage, retrait |
| `blueprints/images.py` | API `/api/images` : envoi, bibliothèque, lecture, retrait |
| `image_settings.py` | Schéma et coercition serveur du bloc `images` (miroir) |
| `static/js/images_model.mjs` | Pur : normalisation miroir, `createImageItem` |
| `static/js/images_render.mjs` | Pur : `imagePanelHeight`, `fitRect`, `drawImagePanel`, `IMAGE_SHADOW` |
| `static/js/images_panels.js` | Chargement, mise en page, canvas d'aperçu, vidéo, aperçus en direct, aimantation |
| `static/js/images_ui.js` | Onglet : liste, ajout, bibliothèque, formulaire, glisser, export/import |
| `static/js/panel_interactions.js` | Glisser-déposer, aimantation, poignées — partagé avec les Stats |
| `templates/menu_images.html` | Le `tab-pane` `#images` |

## Fichiers : `images/` (image_library.py)

À l'envoi (`POST /api/images`, champ `image`, 15 Mo max), chaque image est
**normalisée** : `Image.verify()`, refus au-delà de 50 Mpx déclarés (bombe de
décompression), `ImageOps.exif_transpose`, première image d'un GIF, réduction à
**2048 px** sur le grand côté (en 2160p la vidéo agrandit l'aperçu d'environ
×3 : 1024 px rendaient flou un logo de plus de ~330 px), puis **PNG** si une transparence est réellement
utilisée (un PNG RGBA entièrement opaque devient JPEG), **JPEG** qualité 90
sinon. Le réencodage retire au passage toutes les métadonnées (EXIF, position).

Un **SVG** est rastérisé dans le navigateur avant envoi (`rasterizeSvg` de
`images_ui.js`, point unique par lequel passent l'ajout, le remplacement, le
collage et l'import JSON) : dessiné via `<img>` — ni script ni ressource
externe n'est chargé — à **2048 px** sur le grand côté (taille intrinsèque,
sinon `viewBox`, sinon carré), envoyé en PNG. Le serveur ne voit donc jamais
de SVG et Pillow n'a pas à le supporter.

Le nom est l'empreinte SHA-256 tronquée du contenu normalisé
(`0123456789abcdef.png`) : la même image n'est stockée qu'une fois, et un nom
ne désigne jamais deux contenus — `GET /api/images/<nom>` est servi avec un
cache d'un an `immutable`. Seuls les noms de ce motif sont acceptés
(`safe_image_name`), à la lecture comme dans les réglages.

Le nom d'origine lisible vit aussi dans `images/names.json` (`{<fichier>:
<nom>}`, retenu à l'envoi, oublié au retrait) : la bibliothèque affiche
« logo-club » plutôt que « Image n », indépendamment des préférences. Ce
fichier est étranger au motif : jamais balayé, jamais servi.

**Même origine obligatoire** : dessiner dans un canvas une image d'une autre
origine le contamine et rend l'export vidéo impossible. Les images viennent
toujours du serveur local, jamais d'une URL externe.

Une image n'est jamais balayée : elle reste dans la bibliothèque jusqu'au
retrait manuel via `POST /api/images/delete` — refusé (409) si elle est
encore référencée (l'une des deux listes ou les configurations, lues par
`referenced_image_files`). Côté onglet, le retrait est **confirmé**
(`showConfirmation`, définitif) et le × est masqué pour les fichiers qu'un
toast « Annuler » encore affiché (suppression d'une ligne, import)
remettrait sur la carte (`undoProtected`, tant que le toast est dans la
page) — sinon « Annuler » ramènerait une image manquante. Seuls les envois interrompus (`.upload-*.part`)
sont balayés par `sweep_partial_uploads` après chaque envoi, passé un délai
de grâce d'une heure — un envoi encore en cours est épargné.

## Réglages (`images`)

```
images: {
  enabled: true,
  items: [{
    id, enabled, file, name,
    position: { mode: 'anchor'|'free', anchor, dx, dy, width, height, x, y },
    style: { shape: 'rect'|'rounded'|'circle', radius, fit: 'contain'|'cover',
             opacity, background, background_opacity, padding, shadow,
             border_color, border_width },
    schedule: { by: 'date'|'find',
                start: 'YYYY-MM-DD'|null, end: 'YYYY-MM-DD'|null,
                start_find: 1–10 000 000|null, end_find: …|null,
                fade: 0–5000, effect: 'fade'|'slide'|'zoom' }
  }],
  evolution_items: […],  // même schéma, page /evolution (clé absente → [])
  configs: [{ name, items: […] }]  // 12 au plus, applicables sur les deux pages
}
```

Miroir exact `image_settings.py` ↔ `images_model.mjs`, vecteurs partagés
`tests/fixtures/images/settings_cases.json`. Les coercitions élémentaires sont
celles des stats (`statsCoercers` exporté par stats_model.mjs ; helpers
privés de stats_settings.py côté serveur), comme les **marges de coin
communes** (`shareCornerMargins`). Un fichier invalide devient `''` sans
perdre l'entrée. Patch de premier niveau des deux côtés : `{ images: { enabled } }`
garde les deux listes (serveur : `coerce_images_settings(raw, current)` ;
client : `commit` n'envoie que les clés de premier niveau changées —
`enabled`, `items`, `evolution_items`, `configs` — accumulées jusqu'à
l'écriture confirmée, sinon deux onglets ouverts sur des pages différentes
écraseraient à tour de rôle la liste de l'autre avec leur copie locale).
`items` et `evolution_items` sont indépendantes (miroir de
`stats.panels` / `stats.evolution_panels`, clé choisie par `imagesItemsKey`).

## Mise en page et rendu

- Les images passent par `layoutPanels` (stats_model.mjs) avec le titre et les
  infos en obstacles. Hauteur : imposée, sinon d'après les proportions de
  l'image (marge intérieure comprise) ; ronde : carrée ; pas encore décodée :
  ni posée ni dessinée (elle apparaît à sa place définitive quand ses
  proportions sont connues — pas de carré provisoire ni de saut de la pile
  de stats au chargement).
- `getImagePanelRects()` alimente les obstacles des piles de stats
  (`stats_panels.js › overlayRects`, ids `image:<id>`). Quand la mise en page
  des images change, celle des stats est invalidée : elles suivent en direct,
  y compris pendant un glisser.
- Aperçu : un `<canvas class="image-panel">` par image, `z-index: 95`
  (au-dessus des stats à 90, sous les cartouches à 100). Vidéo :
  `addImagePanelsToCanvas` dans les deux pipelines, **entre** les stats et les
  cartouches, canvas hors écran mis en cache par (révision, taille).
- L'ombre déborde de la boîte : CSS `drop-shadow` dans l'aperçu ; dans la
  vidéo, elle est cuite dans le canvas mis en cache — le panneau est dessiné
  dans un second canvas élargi dont le contexte porte les `shadow*` (ombre du
  composite, pas de chaque opération), puis copié par un `drawImage` nu à
  chaque frame, mêmes valeurs (`IMAGE_SHADOW`, même échelle de flou).
- La bordure (`border_color`, `border_width`) est un liseré à l'intérieur de
  la boîte, dessiné en dernier dans `drawImagePanel` : le trait, doublé, est
  rogné à moitié par le clip de la forme (le clip « cover » de la zone
  intérieure est isolé dans un `save`/`restore` pour ne pas écorner le
  liseré).
- Fichier absent ou illisible : ni dessiné ni placé (état `failed`), signalé
  « (manquante) » dans la liste (événement `mygcflow:image-source`). Un
  chargement raté est d'abord **réessayé** deux fois (0,5 s puis 2 s, avec un
  paramètre `?retry=n`) : un incident passager — serveur de développement qui
  redémarre — ne déclare pas manquante une image présente. Un échec retenu
  s'oublie (`forgetFailedImageSources`) après un envoi réussi du même fichier
  (même contenu, même nom) et à l'ouverture de l'onglet Images.
- Visibles avec la base chargée, comme le titre et les infos
  (`syncImagePanelsVisibility`, appelé par `frames.js › syncOverlayVisibility`).

**Apparition planifiée** (`schedule`) : l'image est visible au jour `d` ssi
`d ≥ start` (borne incluse) et `d < end` (borne exclue — le fondu sortant
commence ce jour-là), chaque borne nullable ; `end ≤ start` : jamais visible
(l'onglet borne `end ≥ start`, le modèle ne force rien). Pendant
l'animation, `mapgl.js` appelle `resetImagesForAnimation` (état instantané à
la veille du départ) puis `syncImagesToDate` à chaque lot de jours : un
changement de cible lance un fondu linéaire de `fade` ms sur l'horloge des
points ; au saut (aperçu en pause) il est instantané, au repos
(`syncImagesToRest`) le planing est ignoré. Aperçu : `transition`/`opacity`
CSS sur le canvas — plancher **30 % en mode édition au repos seulement**
(`images-editing` ET lecture arrêtée : la classe survit au départ de
l'animation le temps du MutationObserver, la garde sur
`isAnimationInProgress` évite une image figée à 30 % ; les opacités sont
reposées à chaque bascule du mode). Vidéo : `globalAlpha` dans
`addImagePanelsToCanvas(ctx, w, h, scale, now)` ;
`getImagesAlphaSignature()` joint les alphas quantifiés à la signature des
frames MediaRecorder (un fondu dessine des frames même sur carte immobile).
La place de l'image dans la pile est toujours réservée
(`visibleItems`/`imagesReady` inchangés) : rien ne saute à l'apparition, les
piles de stats gardent le contournement.

**Planing par jalons** (`by: 'find'`) : « apparaît à la trouvaille n° N ».
Converti en date au moment de l'évaluation (`scheduleBounds(schedule,
imageFindDate)`, images_model.mjs) : `imageFindDate(n)` (images_panels.js)
cherche le jour où le cumul des trouvailles atteint N (`dayOfNthFind`) dans
`pointsByDate` + `hiddenPointsByDate` — le compteur de la carte,
trouvailles antérieures au début de l'animation et locationless masquées
comprises —, mis en cache par `pointsByDateRevision`. Tout le reste (cibles,
fondus, sauts) est la mécanique des dates. Jalon d'apparition jamais atteint
→ `SCHEDULE_UNREACHED` (jamais visible, signalé dans l'onglet) ; jalon de
disparition jamais atteint → pas de fin. Les deux paires de bornes sont
gardées : un aller-retour dates ↔ jalons ne perd rien, seul le mode `by`
compte (`hasSchedule`). Page Évolution : pas de trouvailles, un planing par
jalons (venu d'une configuration) y est ignoré — l'image reste visible.

**Effets d'entrée/sortie** (`effect`) : le fondu accompagne toujours l'effet.
`slide` : l'image cachée attend juste hors du cadre, par le bord le plus
proche (à égalité : gauche, droite, haut, bas) ; `zoom` : depuis la moitié de
sa taille (`IMAGE_ZOOM_FROM`), avec un léger rebond. `effectTransform(effect,
avancement, rect, conteneur)` (images_render.mjs) donne décalage et échelle,
en px CSS. Aperçu : `transform` CSS sur le canvas, transition à la courbe
`IMAGE_EFFECT_EASINGS` (`cubic-bezier`) — pas en mode édition (l'image reste
saisissable). Vidéo : la MÊME courbe évaluée en JS (`cubicBezier`, Newton +
dichotomie comme les navigateurs) sur l'horloge des points
(`scheduleMotion`), appliquée par `translate`/`scale` autour du centre dans
`addImagePanelsToCanvas` ; l'opacité reste linéaire. La signature des frames
MediaRecorder joint l'avancement quantifié en 64es pour un effet (16es pour
le seul fondu).

**Préchargement.** Les images sont décodées dès le chargement des préférences
(init.js) et à chaque envoi. Le mode image par image attend `imagesReady()`
(3 s au plus) avant sa première frame. Le mode MediaRecorder **n'attend pas** :
`recordAnimation()` est synchrone et l'animation démarre avant le pipeline —
attendre perdrait le début de la vidéo ; une image encore en cours apparaît
dès qu'elle est prête : la signature des frames (`overlayContentSignature`)
inclut `getImagesRevision`, donc son décodage produit une frame même sur
carte immobile.

## Onglet Images (images_ui.js)

Liste (vignette sur damier, nom ou « Image n », interrupteur, flèches,
suppression avec « Annuler »), ajout par fichiers (multi-sélection), dépôt de
fichiers sur l'onglet ou collage depuis le presse-papiers, ou par la **bibliothèque** (images déjà envoyées, retrait des non utilisées, place
occupée), « Remplacer l'image… » qui garde les réglages, formulaire de
position, d'apparence et d'**apparition** (dates « Apparaît le » /
« Disparaît le », fondu en ms ; badge `ti-calendar-time` sur la ligne d'une
image planifiée). Sauvegarde débouncée de la préférence complète, vidée
aussitôt pour les actions discrètes. **Enregistrement en cours** : l'onglet
est en lecture seule — toute modification serait dessinée au milieu de la
vidéo capturée. La garde `isRecordingBlocked` (toast espacé de 4 s : un
curseur enfoncé tente un commit à chaque `input`) bloque `commit` et
`updateItems` — avant `mutate`, sinon un effet de bord (l'image « supprimée »
du toast « Annuler ») survivrait — plus en amont tout ce qui ferait un envoi
ou afficherait un succès : sélecteur, ajout, remplacement, import,
configurations, préréglages, interrupteur général. Le glisser, les poignées
et les raccourcis clavier sont déjà bloqués (`isBusy` : `isAnimationInProgress`
couvre l'enregistrement). Retrait de bibliothèque (fichiers non référencés,
sans effet sur la vidéo) et export restent permis.

**Ajouts en file d'attente** (`addFromFiles`) : sélecteur, dépôt et collage
passent par une file — un ajout pendant un envoi attend son tour au lieu
d'être ignoré ; la place restante est comptée à son tour, l'excédent signalé
une fois (« Quatre images au maximum. »).

**Dépôt de fichiers** : traité par le gestionnaire de la FENÊTRE de chaque
page (`bdd.js › routeDroppedFiles`, `evolution_data.js › setupCsvDragAndDrop`),
qui aiguille les images (`isImageFile`, images_model.mjs) vers
`dropImageFiles(files, point)` comme les musiques vers `dropMusicFile`.
L'onglet Images s'ouvre ; lâchées sur la carte (`#mapWithFrames`), les images
y sont posées **en position libre, centrées sur le point du dépôt**
(`freePositionAt`, décalées de 24 px les unes des autres) ; ailleurs, à
l'emplacement par défaut. Refusé pendant un enregistrement. L'onglet ne fait
que montrer son contour de dépôt : avant, il traitait aussi le dépôt, et le
gestionnaire de la fenêtre — qui ne connaissait pas les images — le prenait
ensuite pour un GPX (« Fichier invalide ») ou un CSV.

**Bibliothèque** : pastille sur les images déjà utilisées (`libraryUsage`) —
coche d'accent sur cette page, icône du mode (`ti-database` / `ti-stack`,
comme le sélecteur de l'en-tête) pour l'autre page, texte dans le titre et le
nom accessible. Un relevé `GET /api/images` en échec n'affiche pas le message
« aucune image » (mensonger) : un état d'erreur avec bouton **Réessayer**
(`imagesLibraryError`) le remplace.

**Préréglages d'apparence** (`IMAGE_STYLE_PRESETS`, `imageStylePreset`) :
Avatar, Logo sur fond, Filigrane, Photo encadrée. Chacun repart du style par
défaut (le résultat ne dépend pas des réglages précédents) ; position et
largeur gardées ; un préréglage rond rend la hauteur aux proportions.
« Annuler » rend le style et la hauteur d'avant. Le bouton du préréglage que
l'image porte exactement est enfoncé (`matchingStylePreset`, `aria-pressed`).
Chaque carte de préréglage montre **l'image elle-même dans ce style**
(`renderPresetThumbs` → `drawImageFormPreview` avec le résultat de
`imageStylePreset`), redessinée seulement quand le fichier ou la taille
changent (le préréglage fixe tout le reste) ; l'icône du préréglage tient la
place tant que l'image n'est pas décodée, ou si elle manque. Vignettes sur
damier posé sur un gris moyen : un liseré ou un fond blanc reste visible.

**Bloc Apparence** : une ligne par réglage, libellé à gauche
(`.image-style-grid`) ; forme et ajustement en boutons radio
(`name="imageShape"` / `"imageFit"`). `imageStyleFieldStates(item)`
(images_model.mjs, testé par `npm run test:unit`) dit quels réglages ont un
effet : le rayon (masqué hors « Arrondi »), la couleur de bordure (masquée
sans bordure), l'ajustement (grisé avec une explication tant que la boîte suit
les proportions de l'image, c.-à-d. ni rond ni hauteur imposée — `contain` et
`cover` y donnent le même dessin). Choisir une couleur de fond sur un fond
transparent le rend opaque (`withBackgroundColor`) : sans cela, le choix ne se
voyait pas (opacité du fond à 0 par défaut). « Opacité de l'ensemble » est le
`globalAlpha` de `drawImagePanel` : image, fond et bordure.

**Sections repliables** : Position, Apparence et Apparition sont des
`<details>` aux classes de l'onglet Stats (`stats-form-section`), mais
**ouvertes par défaut** — sans « Contenu » toujours visible, un formulaire
tout replié n'afficherait rien. État par section en `localStorage`
(`imagesFormSections`, `bindFormSections`). Repliée, une section montre dans
son titre un résumé des réglages en cours (`renderSectionSummaries`) :
emplacement ou « Position libre » + taille ; préréglage, sinon forme + fond,
bordure, ombre, opacité ; bornes du planing ou « Toujours visible », en
couleur d'alerte quand `#imageScheduleWarning` est affiché (sinon
l'avertissement serait caché avec la section). Le `bindFormSections` de
stats_ui.js est restreint à `#stats` : il refermait aussi ces sections.

**Vignette du formulaire** (`#imageFormPreview`) : un canvas dessiné par
`drawImageFormPreview` (images_panels.js) avec `drawImagePanel`, réduit pour
tenir dans la case (jamais agrandi, rayon/marge/bordure réduits d'autant),
ombre par la classe `has-shadow`. Redessinée à chaque réglage d'apparence ou
de taille, et à l'arrivée de la source (`mygcflow:image-source`).

**Planing et période animée** : `scheduleRangeIssue(schedule, début, fin)`
signale sous les dates (`#imageScheduleWarning`) une image jamais visible —
fenêtre vide, apparition après la fin, disparition avant le début (période :
`getTimelineState()`, recalculée à l'ouverture de l'onglet). « Jour affiché »
(`scheduleFromPreview`) reprend le jour de l'aperçu en lecture ou en pause
(`getTimelineState().position`), en gardant `end ≥ start` ; au repos, un toast
explique la marche à suivre. Aperçu en pause : toute modification du planing
est réappliquée aussitôt au jour affiché (`resyncScheduleWhilePaused` →
`syncImagesToDate(position, null)`, instantané comme un saut).

**Glisser-déposer** (onglet ouvert, au repos : classe `images-editing`) :
`panel_interactions.js › bindPanelDrag`, la même mécanique que les panneaux —
position libre, aimantation à 48 px (repère `.image-snap-ghost`, Alt pour s'en
passer), poignées sur les bords qui bougent, coin haut-gauche épinglé pendant
le redimensionnement d'une image libre (`pinImageCorner`). Au clavier, les
flèches déplacent l'image sélectionnée de 1 px (10 px avec Maj ; une image
ancrée devient libre à sa place affichée) — mécanique partagée avec les
Stats, hors champs de formulaire.

**Dupliquer** : ancrée, la copie s'empile dans le même coin ; libre, elle est
décalée de 24 px (`offsetFreeCopy`, stats_model.mjs, partagé avec les Stats)
au lieu de recouvrir l'original.

**Configurations nommées** (menu Configurations, comme l'onglet Stats) :
`images.configs` = `[{ name, items }]`, instantanés de la liste de la page
(`normalizeImagesConfig` ↔ `coerce_images_config`, premier nom gagnant, 12
au plus, nom aplati à 40 caractères). Contrairement aux configurations de
Stats, elles s'appliquent sur **les deux pages** — une image est la même
partout — : c'est le moyen de reprendre sur Évolution les images de « Mes
Géocaches », et inversement. Appliquer remplace la liste de la page
(« Annuler ») ; un nom déjà pris remplace sa configuration. Les fichiers
qu'elles désignent sont « référencés » (`referenced_image_files` lit
`configs`) : la bibliothèque refuse de les retirer.

**Export/import JSON** (menu Configurations) : `{ format: 'mygcflow-images',
version: 2, items, configs, files }`, les fichiers **embarqués** en data URL
— la liste DE LA PAGE y voyage sous `items` quel que soit le mode ; à
l'import, elle est écrite dans la liste de la page courante. Les
configurations nommées voyagent depuis la version 2, avec les fichiers
qu'elles référencent ; à l'import elles fusionnent avec les existantes
(même nom = remplacée, douze au total au plus, les excédentaires signalées).
La version 1, sans configurations, reste lisible. Chaque image embarquée est
renvoyée au serveur (normalisée de nouveau, son nom peut changer : les
entrées — liste et configurations — suivent), puis liste et configurations
sont remplacées avec « Annuler ». Accepte aussi un tableau d'images ou un
bloc de préférences complet `{ images: { … } }`, lu dans la liste de la
page. « Importer et ajouter à la liste… » (`data-images-import="append"`)
ajoute au lieu de remplacer, dans la limite des places libres ; les images
en trop sont écartées AVANT envoi (aucun fichier envoyé pour rien) et
signalées.

## Tests

- Python : `tests/test_image_library.py` (normalisation, stockage, API),
  `tests/test_image_settings.py` (vecteurs partagés, API des préférences).
- Unitaires JS : `tests/js/images_model.test.mjs` (règles d'apparence),
  `tests/js/images_render.test.mjs` (hauteur, ajustement, effets, tracé).
- E2E : `tests/e2e/images.spec.mjs` — envoi, affichage, contournement par les
  stats, **comparaison aperçu/vidéo au pixel près**, onglet, bibliothèque et
  limite, image manquante, glisser aimanté et poignées, export/import.
- `images` est une préférence globale partagée par les specs : chaque spec la
  remet à vide en sortant (AGENTS.md).
