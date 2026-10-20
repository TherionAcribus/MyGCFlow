# Images sur la carte (avatar, logo d'association…)

Ajouter un onglet principal « Images », distinct de « Stats », qui permet de poser sur la carte une ou plusieurs images de l'utilisateur — avatar, logo d'association, signature… — placées comme les panneaux de stats (emplacements, marges, piles, glisser-déposer aimanté, redimensionnement), identiques dans l'aperçu et dans la vidéo, persistées en préférence globale, les fichiers copiés et normalisés dans les données de l'application.

## 0. État d'avancement (2026-10-19)

Décisions du §2 validées par l'utilisateur telles que recommandées (liste commune aux deux modes, priorité Titre/Infos > Images > Stats, 4 images, PNG/JPEG/WebP/GIF, 8 emplacements).

Lot 1 fait : `paths.images_dir()`, `image_library.py` (normalisation Pillow, empreinte, inventaire, balayage, retrait), blueprint `blueprints/images.py` (`POST/GET /api/images`, `GET /api/images/<nom>` en cache immuable, `POST /api/images/delete` refusé si l'image est référencée), `tests/test_image_library.py`.

Lot 2 fait : `image_settings.py` ↔ `static/js/images_model.mjs` (coercitions et marges de coin des stats réutilisées : `statsCoercers`, `shareCornerMargins` exportés de stats_model.mjs ; helpers privés de stats_settings.py importés), bloc `images` dans `settings_manager.py` et `/api/settings`, vecteurs partagés `tests/fixtures/images/settings_cases.json`, `tests/test_image_settings.py`, `test_images_model.mjs`. Pas de `configs` dans le schéma v1 (`referenced_image_files` les lit déjà, pour plus tard).

Lot 3 fait : `images_render.mjs` (pur : `imagePanelHeight` — imposée, sinon proportions, rond = carré —, `fitRect`, `drawImagePanel` : forme, fond, marge, opacité ; ombre hors dessin : CSS `drop-shadow` dans l'aperçu, `shadowBlur` dans la vidéo, mêmes valeurs `IMAGE_SHADOW`) ; `images_panels.js` (décodage par nom, `layoutPanels` avec titre/infos en obstacles, canvas `.image-panel` z-index 95, `addImagePanelsToCanvas` entre stats et cartouches dans les deux pipelines, `getImagePanelRects` ajoutés aux obstacles des stats via `overlayRects`, invalidation des stats quand la mise en page des images change, `imagesReady`, `getImagesSnapshot`) ; chargement dans init.js ; visibilité avec les cartouches (base chargée). Écart : **pas d'attente des images en mode MediaRecorder** — `recordAnimation()` est synchrone et l'animation démarre avant le pipeline ; l'attente (3 s max) ne vaut que pour le mode image par image. Les images étant décodées dès le chargement des préférences, le cas est marginal. Fichier absent ou illisible : non dessiné, non placé (état `failed`).

Lot 4 fait : onglet « Images » (`templates/menu_images.html`, inclus après Stats dans app.html, sur les deux pages) et `images_ui.js` (auto-initialisé en fin de module, exporté après stats_ui.js). Interrupteur général ; liste (vignette sur damier, nom ou « Image n », interrupteur, monter/descendre, suppression avec « Annuler », « (manquante) » sur fichier absent — événement `mygcflow:image-source` émis par images_panels.js) ; ajout par fichier, par dépôt sur l'onglet (contour de dépôt) et par la bibliothèque (menu : grille des images envoyées, retrait des non utilisées, place occupée) ; « Remplacer l'image… » garde les réglages ; formulaire : nom, grille de 8 emplacements, marges (communes au coin, propagées), largeur, hauteur auto, forme, rayon (arrondi seulement), ajustement, opacité, fond + opacité, marge intérieure, ombre. Écart : réordonnancement par flèches seulement (4 images au plus, le glisser dans la liste n'apportait rien).

Lot 5 fait : `static/js/panel_interactions.js` (`resizeEdges`, `nearestSnapTarget`, `createSnapGhost`, `bindPanelDrag` paramétré par rappels : rect, emplacements, aperçus, épingle, commits). `stats_ui.js` réduit à ses rappels (−230 lignes, 48 specs Stats/titre inchangés et verts) ; `infos_editor.js` reprend `nearestSnapTarget` et `createSnapGhost`. Images : `previewImagePosition/Width/Height`, `pinImageCorner`/`unpinImageCorner`, `getImageSnapTargets`, `setImagePanelSelection` dans images_panels.js ; mode `images-editing` (onglet Images ouvert, au repos). Repère commun `.panel-snap-ghost` (+ `.stats-snap-ghost`, `.image-snap-ghost` z-index 96, `.overlay-snap-ghost` z-index 101). Les piles de stats suivent l'image en direct pendant le glisser (invalidation par la mise en page des images).

Lot 6 fait : export/import JSON dans le menu Bibliothèque (`{ format: 'mygcflow-images', version: 1, items, files }`, **fichiers embarqués en data URL** — avancé depuis le §8 : sans eux, un export n'avait pas d'intérêt sur un autre ordinateur ; à l'import, chaque image repasse par le serveur, son nom peut changer, les entrées suivent ; « Annuler »). Guide : section « 5. Images », Préférences devient 6 ; astuce d'introduction corrigée (elle ne citait ni Stats ni Images). Doc technique `docs/images.md`. **Fonctionnalité complète** ; restent au §8 : configurations nommées d'images, SVG, GIF animés.

Corrections d'audit du 2026-10-19 : le balayage automatique des images non référencées est abandonné — la bibliothèque est persistante, retrait manuel uniquement (`POST /api/images/delete`) ; seuls les envois interrompus `.upload-*.part` sont balayés (`sweep_partial_uploads`). La signature des frames MediaRecorder (`overlayContentSignature`) inclut désormais `getImagesRevision` : une image qui finit de se décoder pendant l'enregistrement apparaît même sur carte immobile. `imagesReady` n'attend que les images réellement affichées (`visibleItems`) : interrupteur général éteint, base vide ou fichier déjà en échec ne font plus patienter l'enregistrement. Le retour « Enregistré ✓ » des interrupteurs de liste (images et stats) visait la case à cocher, détruite par `renderList()` avant la résolution de `reportSave` : il vise désormais le titre (`*_SAVE_STATUS`). L'ombre portée de la vidéo est cuite dans le canvas en cache (plus de `shadowBlur` par frame). Les dessins sont invalidés par des clés par image (fichier, état, taille, style) au lieu de la révision globale : un changement de nom ne re-dessine plus les quatre images. Une image en chargement n'est plus posée en carré provisoire : `visibleItems` ne retient que les sources prêtes (`drawableItems`, chargement compris, pour `imagesReady`) — elle apparaît à sa place définitive, sans saut de la pile de stats. La bibliothèque retient le nom d'origine (`images/names.json`) : une image reprise n'est plus « Image n ». Ajout multi-fichiers (sélecteur et dépôt), dans la limite des quatre places. « Rétablir les proportions » sous le champ Hauteur quand une hauteur est imposée (champ ou poignée verticale) : retour à `height: null`. Déplacement clavier du panneau sélectionné (flèches 1 px, Maj 10 px, ancré → libre) — partagé stats/images (`nudge` de `bindPanelDrag`, sauvegarde débouncée). « Dupliquer » dans les actions de ligne (mêmes réglages, nouvel id, empilée dans le coin) et « Revenir à l'emplacement » quand l'image est en position libre (retour à `position.anchor` avec les marges de la pile). Bordure (`border_color`, `border_width` — liseré intérieur dans `drawImagePanel`, trait doublé rogné par le clip de la forme) et collage depuis le presse-papiers (onglet ouvert, `addFromFiles`).

Apparition planifiée (2026-10-19, du §8) : bloc `schedule {start, end, fade}` par image — dates « AAAA-MM-JJ » strictes (coercition miroir, « 2026-02-30 » → null, `new Date` reporte au mois suivant : le jour relu doit être le jour donné), fondu borné 0–5000 ms, défauts `{null, null, 600}`. Visible au jour `d` ssi `d ≥ start` et `d < end` (« Disparaît le » = début du fondu sortant ce jour) ; `end ≤ start` jamais visible (garde `end ≥ start` côté onglet, le modèle ne force pas). `images_panels.js` : transitions par image interpolées à l'horloge des points (`syncImagesToDate` — instantané au saut, `resetImagesForAnimation` état à la veille du départ pour les trois démarrages, `syncImagesToRest` planing ignoré au repos) ; aperçu par `transition`/`opacity` CSS (plancher 30 % en mode édition, image repérable et déplaçable), vidéo par `globalAlpha` dans `addImagePanelsToCanvas(…, now)` ; `getImagesAlphaSignature` joint les alphas quantifiés à la signature des frames MediaRecorder (un fondu dessine des frames sur carte immobile). Place toujours réservée dans la pile (`visibleItems` inchangé) : rien ne saute à l'apparition. Onglet : section « Apparition pendant l'animation » (champs date + fondu, badge `ti-calendar-time` sur la ligne), duplication et export reprenant le bloc.

## 1. Contexte constaté dans le code (à ne pas redécouvrir)

- **Titre et Infos** sont des cartouches CSS du **thème** (`title_css`/`infos_css`, profiles.js), recopiés dans la vidéo par `overlay_canvas.js` qui relit leur CSS et leur rect. `sanitizeOverlayCss` interdit `url()` (pas de requête externe depuis un thème importé) : une image n'a rien à faire dans ce circuit.
- **Panneaux de stats** : préférence **globale** (`stats` dans settings.json, `stats_settings.py` miroir de `stats_model.mjs`, vecteurs partagés `tests/fixtures/stats/settings_cases.json`). Mise en page pure `layoutPanels(items, container, obstacles)` : ancres, piles à écart fixe de 8 px, marges de coin communes (`shareCornerMargins`), contournement d'obstacles sur toute la hauteur de la pile, position libre en fractions de l'espace restant. Interactions dans `stats_ui.js` : glisser-déposer, aimantation (`getStatsSnapTargets`, 48 px, Alt), poignées sur les bords mobiles (`resizeEdges`), « Réorganiser » (`arrangePanels`).
- **Ordre de dessin vidéo** : carte → panneaux de stats (`addStatsPanelsToCanvas`) → titre/infos (`addOverlaysToCanvas`). Aperçu : stats `z-index: 90`, cartouches 100. La vidéo est l'aperçu agrandi (`captureRatioFor`) : géométrie de l'aperçu × ratio.
- **Précédent de fichiers utilisateur** : `audio_library.py` + `paths.audio_dir()` — copie de l'envoi, inventaire, balayage des copies non référencées avec délai de grâce (`AUDIO_SWEEP_GRACE_S`), jamais pendant un export ; routes dans `blueprints/media.py`.
- **Pillow 11.3** est déjà une dépendance (requirements.txt).
- **Canvas contaminé** : dessiner dans un canvas une image d'une autre origine le rend inexportable (`toBlob`/`captureStream` en échec). Les images doivent être servies par le serveur Flask local (même origine).
- **Barre d'onglets** : 5 onglets (Données, Style, Animation, Stats, Préférences) ; `splitter-responsive.spec.mjs` vérifie qu'ils tiennent tous à 760 px (sans compte en dur depuis le 2026-10-19).
- **Ordre d'évaluation des modules** (AGENTS.md) : un nouveau module d'UI s'initialise en fin de fichier, pas depuis `initUIElements`.

## 2. Décisions

Actées avec l'utilisateur :
- **Onglet propre « Images »**, à côté de « Stats » et non dedans : « Stats » reste réservé aux statistiques.
- **Préférence globale**, pas réglage de thème : l'identité de l'utilisateur ne change pas avec le thème.
- **Même manière de placer que les panneaux de stats** (emplacements, marges, glisser aimanté, poignées), par réutilisation du code, pas par copie.

À confirmer (recommandation en premier) :
1. **Une seule liste pour les deux modes** (Mes géocaches et Évolution) — un logo est le même partout. Alternative : listes séparées comme les stats.
2. **Priorité de placement : Titre/Infos > Images > Stats.** Les images contournent les cartouches ; les piles de stats contournent les cartouches ET les images. Alternative : images et stats dans les mêmes piles (ordre entre deux listes ambigu, déconseillé).
3. **Jusqu'à 4 images**, limite propre (indépendante des 6 panneaux de stats).
4. **Formats acceptés** : PNG, JPEG, WebP (GIF : première image seulement). SVG et animations exclus de la v1.
5. **Emplacements** : les 8 de la grille des stats (tous sauf le centre de la carte).

## 3. Architecture cible

### 3.1 Stockage des fichiers (`image_library.py`, `paths.images_dir()`)

- Dossier `images/` des données de l'app, à côté de `audio/`.
- Envoi `POST /api/images` (multipart, 15 Mo max) → Pillow : `Image.open` + `verify`, `ImageOps.exif_transpose`, première image d'un GIF, réduction à **1024 px** sur le grand côté, PNG si transparence (canal alpha réellement utilisé), sinon JPEG qualité 90. Nom = empreinte SHA-256 tronquée du contenu normalisé + extension : un même fichier envoyé deux fois n'est stocké qu'une fois.
- `GET /api/images/<nom>` : nom validé (`secure_filename` + motif empreinte), `Cache-Control` long (contenu immuable par nom). Même origine → canvas non contaminé.
- `GET /api/images` (bibliothèque : nom, dimensions, poids, référencée ou non) ; `POST /api/images/delete`.
- Balayage des fichiers non référencés (liste courante + configurations nommées), délai de grâce et jamais pendant un export, comme `audio_library.sweep_audio_dir`.

### 3.2 Modèle de réglages (`images`, préférence globale)

`image_settings.py` ↔ `images_model.mjs`, miroirs exacts, vecteurs partagés `tests/fixtures/images/settings_cases.json` :

```
images: {
  enabled: true,
  items: [{
    id, enabled, file,            // nom dans images/ ; '' = à choisir
    name,                         // libellé dans la liste (nom d'origine aplati)
    position: { mode: 'anchor'|'free', anchor, dx, dy, x, y,
                width,            // px CSS, 40–1200
                height },         // null = d'après le ratio de l'image
    style: { shape: 'rect'|'rounded'|'circle', radius,
             fit: 'contain'|'cover', opacity,
             background, background_opacity, padding,
             shadow: bool }
  }],
  configs: []                     // plus tard (§7)
}
```

Normalisation : mêmes coercitions que `stats` (bornes, couleurs, fractions arrondies à 1e-4, ids hexadécimaux régénérés), marges de coin communes (`shareCornerMargins` réutilisé), `file` validé par le même motif que le serveur.

### 3.3 Mise en page commune

- Les images passent par `layoutPanels` avec les cartouches titre/infos comme obstacles.
- La mise en page des stats reçoit en obstacles **titre, infos et rects des images** (une seule source : `overlayRects` étendu, invalidé quand une image bouge ou change de taille).
- Snap et « Réorganiser » des stats en profitent sans changement (ils lisent déjà les obstacles).

### 3.4 Rendu (`images_panels.js`)

- Aperçu : un `<canvas class="image-panel">` par image dans `#mapWithFrames`, `z-index: 95` (au-dessus des stats, sous les cartouches) ; même dessin que la vidéo.
- `drawImagePanel(ctx, rect, item, bitmap)` pur (forme : rectangle, arrondi, cercle par `clip`, `contain`/`cover`, opacité, fond, ombre) — testable hors DOM.
- Vidéo : `addImagePanelsToCanvas(ctx, w, h, scale)` appelé entre `addStatsPanelsToCanvas` et `addOverlaysToCanvas`, dans les deux pipelines (`mapgl.js`), canvas hors écran mis en cache par (révision, taille).
- **Préchargement** : `imagesReady()` (promesse sur `img.decode()` de chaque image activée), attendue au démarrage d'un enregistrement — sinon les premières images de la vidéo sortent sans le logo.
- Fichier manquant (configuration importée d'une autre machine, fichier supprimé) : cadre « Image manquante » dans l'aperçu, rien dans la vidéo, signalé dans la liste.

### 3.5 Interactions partagées (`panel_interactions.js`)

Extraire de `stats_ui.js` ce qui ne dépend pas des stats : machine d'état du glisser (seuil, capture du pointeur, Alt), `resizeEdges`/poignées et curseurs, aimantation (`nearestSnapTarget`, repère `.stats-snap-ghost` renommé `.panel-snap-ghost`), épingle du coin haut-gauche en mode libre. Paramétré par des rappels : `getRect(id)`, `getSnapTargets(id)`, `previewPosition/Size`, `commit…`. `stats_ui.js` et `images_ui.js` l'utilisent ; les specs Stats existants servent de filet pour l'extraction.

Mode édition : onglet Images ouvert, au repos → classe `images-editing` sur `#mapWithFrames` (comme `stats-editing`, `overlay-editing`).

### 3.6 Onglet « Images » (`templates/menu_images.html`, `images_ui.js`)

- Liste : vignette, nom, interrupteur, réordonnancement, suppression avec « Annuler » (mêmes motifs que la liste des stats).
- Ajout : bouton « Ajouter une image » (sélecteur de fichier) et dépôt d'un fichier sur l'onglet ; choix dans la bibliothèque des images déjà envoyées (réutilisation sans nouvel envoi).
- Formulaire : Position (grille, marges, largeur, hauteur auto/imposée), Apparence (forme, rayon, ajustement, opacité, fond, ombre).
- Retour de sauvegarde et `flush()` sur les actions discrètes (`makeDebouncedSettingsSaver`, cf. AGENTS.md).
- Libellé court pour tenir à 760 px avec 6 onglets.

## 4. Lots d'implémentation

1. **Stockage et API** : `paths.images_dir()`, `image_library.py` (normalisation Pillow, empreinte, inventaire, balayage), routes. Tests Python (formats, EXIF, transparence, réduction, doublon, nom invalide, fichier non-image, balayage).
2. **Modèle** : `image_settings.py` + `images_model.mjs`, bloc dans `settings_manager.py`, vecteurs partagés.
3. **Rendu et mise en page** : `images_panels.js`, `drawImagePanel`, intégration vidéo (deux pipelines) et préchargement, images en obstacles des stats.
4. **Onglet Images** : liste, ajout, bibliothèque, formulaire (sans glisser).
5. **Interactions partagées** : extraction de `panel_interactions.js`, branchement Stats (non-régression) puis Images.
6. **Finitions** : image manquante, export/import JSON de la liste, guide, traductions, doc `docs/images.md`.

## 5. Fichiers

Créés : `image_library.py`, `image_settings.py`, `static/js/images_model.mjs`, `static/js/images_render.mjs`, `static/js/images_panels.js`, `static/js/images_ui.js`, `static/js/panel_interactions.js`, `templates/menu_images.html`, `tests/test_image_library.py`, `tests/test_image_settings.py`, `test_images_model.mjs`, `tests/fixtures/images/settings_cases.json`, `tests/e2e/images.spec.mjs`, `docs/images.md`.

Modifiés : `paths.py`, `settings_manager.py`, `blueprints/media.py` (ou blueprint dédié), `templates/app.html` (onglet), `static/js/index.js` (ordre des exports), `static/js/stats_panels.js` (obstacles), `static/js/stats_ui.js` (extraction), `static/js/mapgl.js` (dessin + préchargement), CSS, traductions, guide.

## 6. Tests et vérification

- Python : normalisation Pillow et API (lot 1), vecteurs partagés (lot 2).
- Unitaires JS : modèle, `drawImagePanel` (forme, ajustement), mise en page avec obstacles images.
- E2E : ajout d'une image (fixture PNG avec transparence), placement par la grille, glisser aimanté, redimensionnement ; une pile de stats contourne l'image ; **comparaison aperçu/vidéo** de la boîte dessinée (comme `overlay-position.spec.mjs`) ; export vidéo avec image (canvas non contaminé, image présente dès la première frame) ; image manquante.
- `images` est une préférence globale partagée par les specs : chaque spec la remet à vide en sortant (cf. AGENTS.md, famille `stats`).

## 7. Risques / points de vigilance

- Canvas contaminé si une image ne vient pas du serveur local : ne jamais accepter d'URL externe.
- Images lourdes : réduction à l'envoi, et coût de dessin négligeable grâce au cache par (révision, taille) — à mesurer comme pour les stats.
- Extraction des interactions (lot 5) : risque de régression sur les Stats, couvert par leurs specs.
- Disque : les images retirées de la liste restent dans la bibliothèque (retrait manuel seulement ; seuls les envois interrompus sont balayés) ; afficher la place occupée dans la bibliothèque.
- Configurations et exports partagés : référence à un fichier absent → « Image manquante », jamais d'erreur.

## 8. Évolutivité (sans l'implémenter maintenant)

- Configurations nommées d'images, comme `stats.configs`.
- Export JSON avec images embarquées (data URL) pour partager une mise en page complète.
- SVG (rastérisé à l'envoi), GIF animés.
