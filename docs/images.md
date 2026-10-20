# Images sur la carte (onglet Images)

Avatar, logo d'association… posés sur la carte et repris dans la vidéo. Plan et
décisions : `MyGCFlow_Plan_Images.md`. Placement commun avec les panneaux de
stats : `docs/panneaux-stats.md` › Mise en page.

## Décisions

- **Onglet propre « Images »**, distinct de « Stats » (réservé aux statistiques).
- **Préférence globale** `images` (settings.json), pas un réglage de thème :
  l'identité de l'utilisateur ne change pas avec le thème. **Une seule liste**
  pour le mode principal et le mode Évolution.
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
**1024 px** sur le grand côté, puis **PNG** si une transparence est réellement
utilisée (un PNG RGBA entièrement opaque devient JPEG), **JPEG** qualité 90
sinon. Le réencodage retire au passage toutes les métadonnées (EXIF, position).

Un **SVG** est rastérisé dans le navigateur avant envoi (`rasterizeSvg` de
`images_ui.js`, point unique par lequel passent l'ajout, le remplacement, le
collage et l'import JSON) : dessiné via `<img>` — ni script ni ressource
externe n'est chargé — à **1024 px** sur le grand côté (taille intrinsèque,
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
encore référencée (liste courante ou configurations, lues par
`referenced_image_files`). Seuls les envois interrompus (`.upload-*.part`)
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
    schedule: { start: 'YYYY-MM-DD'|null, end: 'YYYY-MM-DD'|null,
                fade: 0–5000 }
  }]
}
```

Miroir exact `image_settings.py` ↔ `images_model.mjs`, vecteurs partagés
`tests/fixtures/images/settings_cases.json`. Les coercitions élémentaires sont
celles des stats (`statsCoercers` exporté par stats_model.mjs ; helpers
privés de stats_settings.py côté serveur), comme les **marges de coin
communes** (`shareCornerMargins`). Un fichier invalide devient `''` sans
perdre l'entrée. Patch de premier niveau : `{ images: { enabled } }` garde la
liste.

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
CSS sur le canvas — plancher **30 % en mode édition** pour garder l'image
repérable et déplaçable. Vidéo : `globalAlpha` dans
`addImagePanelsToCanvas(ctx, w, h, scale, now)` ;
`getImagesAlphaSignature()` joint les alphas quantifiés à la signature des
frames MediaRecorder (un fondu dessine des frames même sur carte immobile).
La place de l'image dans la pile est toujours réservée
(`visibleItems`/`imagesReady` inchangés) : rien ne saute à l'apparition, les
piles de stats gardent le contournement.

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
aussitôt pour les actions discrètes.

**Glisser-déposer** (onglet ouvert, au repos : classe `images-editing`) :
`panel_interactions.js › bindPanelDrag`, la même mécanique que les panneaux —
position libre, aimantation à 48 px (repère `.image-snap-ghost`, Alt pour s'en
passer), poignées sur les bords qui bougent, coin haut-gauche épinglé pendant
le redimensionnement d'une image libre (`pinImageCorner`). Au clavier, les
flèches déplacent l'image sélectionnée de 1 px (10 px avec Maj ; une image
ancrée devient libre à sa place affichée) — mécanique partagée avec les
Stats, hors champs de formulaire.

**Export/import JSON** (menu Bibliothèque) : `{ format: 'mygcflow-images',
version: 1, items, files }`, les fichiers **embarqués** en data URL. À
l'import, chaque image embarquée est renvoyée au serveur (normalisée de
nouveau, son nom peut changer : les entrées suivent), puis la liste est
remplacée avec « Annuler ». Accepte aussi un tableau d'images ou un bloc
`{ images: { items } }`.

## Tests

- Python : `tests/test_image_library.py` (normalisation, stockage, API),
  `tests/test_image_settings.py` (vecteurs partagés, API des préférences).
- Unitaires JS : `test_images_model.mjs`, `test_images_render.mjs`.
- E2E : `tests/e2e/images.spec.mjs` — envoi, affichage, contournement par les
  stats, **comparaison aperçu/vidéo au pixel près**, onglet, bibliothèque et
  limite, image manquante, glisser aimanté et poignées, export/import.
- `images` est une préférence globale partagée par les specs : chaque spec la
  remet à vide en sortant (AGENTS.md).
