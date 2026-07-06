# Rapport d'analyse — Animation & Enregistrement (GCMap)

> Rapport destiné à un LLM chargé d'implémenter les corrections.
> Date d'analyse : 2026-07-06. Les numéros de lignes se réfèrent à l'état actuel du dépôt (commit `47f09f1`).

---

## 1. Architecture actuelle (résumé pour contexte)

Deux pipelines d'enregistrement coexistent, sélectionnés par `pkg.options.record.mode` :

### Pipeline A — « images » (capture frame par frame + assemblage serveur)
1. `recordAnimation()` (`static/js/mapgl.js:1393`) → nettoyage du dossier `captured/` via `POST /clear_pictures_directory`, puis `startRecordingProcess()` (`mapgl.js:1441`).
2. Boucle `captureNextFrame()` (`mapgl.js:1581`) : pilotée par `requestAnimationFrame`, elle capture `framesPerDay` frames par jour d'animation, avance la date, et déclenche les flashs via `flashRecord()` (`mapgl.js:2963`) dont la progression est indexée sur `globalRecordFrame` (1 incrément par capture — animation déterministe, indépendante du temps réel).
3. `captureElement()` (`mapgl.js:2540`) : `map.renderSync()` + attente `rendercomplete` (timeout 5 s) → composition des canvas OL dans un canvas de sortie → overlays dessinés au ctx (`addOverlaysToCanvas`, `mapgl.js:2765`) → `toBlob('image/webp', 0.9)` → `sendImageToServer()` (`static/js/record.js:28`) en `FormData` vers `POST /upload_image`.
4. Fin : chaîne automatique `GET /start_create_video` (assemblage MoviePy, `capture.py:114`) puis `POST /clear_pictures_directory`.

### Pipeline B — « mediarecorder » (capture temps réel .webm)
1. `recordAnimationMediaRecorder()` (`mapgl.js:1881`) : applique un `slowdownFactor` sur `timePerDay` et `flash.duration`, lance l'animation temps réel `startAnimation(true)` (`mapgl.js:1206`), puis `startMediaRecorderPipeline(totalMs * slowdown)` (`mapgl.js:2016`).
2. Un `setInterval` à `1000/fps` fait `map.renderSync()` + composite les canvas OL dans `mrOutCanvas` + overlays ; `mrOutCanvas.captureStream(fps)` alimente un `MediaRecorder` (webm/vp9).
3. Arrêt programmé par `setTimeout(totalDurationMs)` (`mapgl.js:2091`).
4. `finalizeMediaRecorderVideo()` (`mapgl.js:2122`) : optionnellement **normalisation de vitesse** (`normalizeRecordedVideoSpeed`, `mapgl.js:2245` — relecture du webm à `playbackRate=slowdown` re-capturée par un second MediaRecorder), puis **mux audio** (`muxRecordedVideoWithAudio`, `mapgl.js:2324` — troisième passe temps réel via `captureStream` + WebAudio), puis correction de l'en-tête WebM (`fixWebmFinalDuration` + `fix-webm-duration.js`), puis download local et/ou `POST /upload_video`.

### Backend (`blueprints/media.py`, `capture.py`)
Routes synchrones Flask : `/upload_image`, `/start_create_video` (MoviePy + ffmpeg, fps **codé en dur à 24**), `/clear_pictures_directory`, `/upload_video`, `/upload_audio`. Un `TaskManager` thread-pool existe déjà (`task_manager.py`, cf. `docs/async-tasks.md`) mais **n'est pas utilisé** pour l'assemblage vidéo.

---

## 2. Problèmes CRITIQUES de fiabilité (à corriger en priorité)

### C1. Rejet de promesse non géré : un seul échec tue silencieusement tout l'enregistrement (mode images)
**Où** : `mapgl.js:1560-1563`, `1849-1852`, `1856`, `1866` (appels à `captureNextFrame`) et `mapgl.js:1636`, `1849` (`await captureElement()`).

`captureNextFrame` est `async` et est relancée via `requestAnimationFrame(() => captureNextFrame(...))` **sans aucun `.catch()`**. Or `captureElement()` rejette dans plusieurs cas réalistes :
- timeout `rendercomplete` de 5 s (`mapgl.js:2561`) ;
- échec `toBlob` (`mapgl.js:2605`) ;
- **échec d'upload** (`mapgl.js:2632`) — un seul HTTP 500 ou une erreur réseau transitoire suffit.

Conséquence : la boucle s'arrête net, **sans message**, `isRecording` reste `true`, la modale « Capture en cours » reste ouverte indéfiniment, aucun assemblage ne se lance. C'est très probablement la cause principale des « enregistrements qui plantent au hasard ».

**Correction attendue** :
- Encapsuler chaque `await captureElement()` dans un `try/catch`.
- En cas d'échec : **retenter la frame 2-3 fois** (petit backoff 250/500/1000 ms). Si échec persistant : arrêter proprement (fermer modale, toast d'erreur explicite avec le nombre de frames capturées, `isRecording = false`, restauration UI via le même code que l'arrêt utilisateur), et proposer d'assembler quand même les frames déjà capturées.
- Ajouter aussi un `window.addEventListener('unhandledrejection', ...)` de garde pendant l'enregistrement (log + arrêt propre) — ceinture et bretelles.

### C2. Aucun retry d'upload + `imageCounter` incrémenté même en cas d'échec
**Où** : `record.js:28-72` et `mapgl.js:2615` (`pkg.sendImageToServer(blob, imageCounter++)`).

`sendImageToServer` ne retente jamais. De plus `imageCounter++` est évalué avant l'upload : en cas d'échec (si C1 était « rattrapé » naïvement en ignorant l'erreur), le numéro est consommé → trou dans la numérotation → frame manquante dans le film (saccade visible).

**Correction attendue** : retry avec backoff dans `sendImageToServer` (3 tentatives) ; n'incrémenter le compteur qu'après décision définitive (succès ou abandon assumé) ; comptabiliser les frames perdues dans `perfMetrics.uploadFail` et l'afficher dans le bilan de fin.

### C3. Mode MediaRecorder : deux horloges indépendantes → fin de vidéo tronquée
**Où** : `mapgl.js:2091-2094` (arrêt par `setTimeout(totalDurationMs)`) vs `mapgl.js:1251-1267` (avancement des jours par `setInterval(dayDuration)`).

L'animation avance via `setInterval` : sous charge (rendu lent, GC, throttling), les ticks prennent du retard et l'animation réelle dure **plus longtemps** que `totalDurationMs` calculé théoriquement (`computeTotalAnimationMs`, `mapgl.js:1987`). Le recorder s'arrête alors **avant la fin de l'animation** → derniers jours/flashs absents de la vidéo. C'est une cause directe de « vidéos coupées à la fin ».

**Correction attendue** : piloter l'arrêt par l'état réel de l'animation, pas par une durée théorique :
- dans la branche de fin de l'interval (`mapgl.js:1254-1265`), quand `isMediaRecording` est vrai, appeler `stopMediaRecorderPipeline(true)` après le délai de queue (`extraMs` + ~3 s de marge pour les derniers flashs) ;
- garder le `setTimeout` actuel uniquement comme garde-fou (p.ex. `totalDurationMs * 1.5 + 10000`).

### C4. FPS d'assemblage serveur codé en dur à 24 → vitesse de lecture fausse
**Où** : `blueprints/media.py:25` et `:40` (`assemble_pictures_directory("captured", ..., 24, ...)`), alors que le client calcule `framesPerDay` à partir de `pkg.options.record.fps` configurable 1-60 (`ui.js:1612-1615`, `mapgl.js:1477-1487`).

Si l'utilisateur règle 30 fps, les images sont produites pour 30 fps mais assemblées à 24 → vidéo 25 % trop lente (et durée ≠ musique). 

**Correction attendue** : le client passe `fps` en paramètre de `GET /start_create_video` (comme il le fait déjà pour `audio`/`audio_volume`) ; le serveur le valide (int, 1-60, défaut 24) et le transmet à `assemble_pictures_directory`.

### C5. Assemblage synchrone dans la requête HTTP → timeouts et UI bloquée à 70 %
**Où** : `blueprints/media.py:15-28` ; côté client `mapgl.js:1730-1743`.

`write_videofile` (MoviePy) peut durer plusieurs minutes pour de longues animations. La requête `fetch` peut expirer (~300 s selon navigateur), le client affiche alors une erreur **alors que l'assemblage continue côté serveur**, et le nettoyage automatique n'est jamais déclenché (ou pire, l'utilisateur relance et deux assemblages tournent en parallèle sur le même dossier). La progression affichée est factice (70 % fixe).

**Correction attendue** : utiliser le `TaskManager` existant (`task_manager.py`, modèle décrit dans `docs/async-tasks.md`) :
- `POST /start_create_video` → soumet la tâche, renvoie `task_id` immédiatement ; refuser (409) si une tâche d'assemblage est déjà `running` ;
- MoviePy expose un logger de progression (`logger` param / proglog) → alimenter `status.set_progress()` ;
- le client poll `GET /task_status/<id>` toutes les ~500 ms et met à jour la vraie barre de progression ; nettoyage des images déclenché serveur-side en fin de tâche (plus fiable que le chaînage client actuel).

### C6. Chaîne post-traitement MediaRecorder : jusqu'à 3 ré-encodages **temps réel** fragiles
**Où** : `finalizeMediaRecorderVideo` (`mapgl.js:2122`) → `normalizeRecordedVideoSpeed` (`mapgl.js:2245`) → `muxRecordedVideoWithAudio` (`mapgl.js:2324`).

Chaque étape rejoue la vidéo dans un `<video>` caché re-capturé par `captureStream()` + `MediaRecorder` :
- **coût temps réel** : une animation de 2 min avec slowdown x4 = 8 min de capture + ~2 min de normalisation + ~2 min de mux ≈ 12 min pendant lesquelles l'onglet doit rester **visible et actif** (sinon `<video>.captureStream` gèle et les timeouts de garde de 30 min finissent par rejeter) ;
- **double perte de qualité** (2 ré-encodages VP9 successifs à débit fixe) ;
- fragilité : dépend de `playbackRate` (drop de frames au-delà de x2-x4 selon machine), de l'autoplay policy (`mrMuxAudioCtx` pré-déverrouillé au clic — correct mais fragile), de `video.duration === Infinity` (contourné, mais chaque contournement est un point de casse).

**Correction recommandée (structurante)** : déporter normalisation + mux **côté serveur avec ffmpeg** (déjà disponible via `imageio-ffmpeg`, présent dans le venv) :
1. le client uploade le `.webm` brut (+ le fichier audio déjà uploadé via `/upload_audio`) dès `onstop` ;
2. le serveur exécute une tâche `TaskManager` : `ffmpeg -i in.webm -filter:v "setpts=PTS/{slowdown}" -i audio.mp3 -map 0:v -map 1:a -shortest out.mp4` (un seul ré-encodage, plus rapide que temps réel, fiable, onglet libre) ;
3. garder la chaîne client actuelle uniquement en fallback « download local sans serveur ».

C'est la correction qui améliorera le plus la fiabilité perçue du mode MediaRecorder.

### C7. Compteur de caches faux en mode MediaRecorder après une lecture préalable
**Où** : `mapgl.js:1937` (`let infosLocal = createObjectInfos();` — **variable jamais utilisée**) et `mapgl.js:1206-1232` (`startAnimation(restart=true)` conserve le module-level `infos` existant).

`recordAnimationMediaRecorder` appelle `startAnimation(true)` (restart) : le `infos` global de la lecture précédente est réutilisé avec son `cacheNumber` accumulé → l'overlay « nombre de caches » de la vidéo démarre au total de la session précédente au lieu de 0.

**Correction attendue** : dans `recordAnimationMediaRecorder`, réinitialiser le module-level `infos = createObjectInfos()` (et supprimer `infosLocal`), ou appeler `startAnimation(false)` en neutralisant les effets redondants.

### C8. Onglet/fenêtre en arrière-plan = enregistrement corrompu, sans détection
- Mode images : `requestAnimationFrame` est gelé quand l'onglet est masqué → capture en pause silencieuse (pas dramatique mais l'utilisateur croit à un plantage).
- Mode MediaRecorder : `setInterval` clampé à 1000 ms + `captureStream` d'un canvas non visible ne pousse plus de frames → vidéo saccadée/figée, alors que l'audio et la durée continuent.

**Correction attendue** : écouter `document.visibilitychange` pendant un enregistrement : afficher un avertissement bloquant, et en mode MediaRecorder soit mettre en pause proprement (`mrRecorder.pause()/resume()` + suspendre l'interval d'animation), soit arrêter avec message clair. Mentionner la contrainte dans la modale (déjà partiellement fait via le titre).

### C9. `MediaRecorder.onerror` et fin de flux non gérés
**Où** : `mapgl.js:2035-2042` (recorder principal), `2288` (normalisation), `2426` (mux).

Aucun `onerror` : si l'encodeur échoue (mémoire, GPU reset), rien ne l'attrape ; `finalize` ne sera jamais appelé et la modale reste ouverte. Ajouter `mrRecorder.onerror = (e) => { log; stopMediaRecorderPipeline(true); toast erreur; }` sur les trois recorders.

---

## 3. Problèmes de PERFORMANCE

### P1. `willReadFrequently: true` sur des canvas jamais relus → rendu logiciel forcé
**Où** : `mapgl.js:2027` (canvas composite MediaRecorder), `mapgl.js:2590` (canvas de capture images), `record.js:12`.

Ce flag bascule le canvas 2D en rendu **CPU**. Il n'est justifié que pour des `getImageData()` répétés — or aucun n'est fait. En mode MediaRecorder avec `scaleFactor` 2-3, composer ~30 fois/s un canvas 4-6 mégapixels en logiciel est une cause directe de frames lentes (le monitor de saccades se déclenche). **Supprimer ce flag partout** ; le composite et `captureStream` resteront sur GPU.

### P2. Double rendu complet de la carte à chaque frame (mode MediaRecorder)
**Où** : `mapgl.js:2054-2078` (`mrDrawIntervalId` appelle `map.renderSync()` à chaque tick) alors que la carte rend déjà en continu via son propre cycle (les flashs appellent `map.render()` à chaque `postrender`, `mapgl.js:3131`).

Chaque tick paie donc un rendu synchrone complet en plus du rendu naturel. **Correction** : composer depuis l'événement `rendercomplete`/`postrender` de la carte (throttlé à l'intervalle cible) au lieu de forcer `renderSync()` ; ne forcer un rendu que si aucun rendu naturel n'a eu lieu depuis > `intervalMs`.

### P3. Upload séquentiel bloquant la capture (mode images)
**Où** : `captureElement` (`mapgl.js:2615`) — la Promise ne se résout qu'après l'upload, et `captureNextFrame` attend cette résolution avant la frame suivante.

Le temps d'upload (`up:` dans les métriques) s'additionne au temps de capture. **Correction** : découpler — pousser le blob dans une file d'upload à concurrence limitée (2-3 requêtes en vol), la capture continue immédiatement. À la fin, `await` le drain de la file avant de lancer l'assemblage. Gain de fps de capture direct, sans risque de désordre (les noms de fichiers sont numérotés).

### P4. Canvas de sortie recréé à chaque frame (mode images)
**Où** : `mapgl.js:2587-2590`. Un `document.createElement('canvas')` + contexte par frame = pression GC inutile. Réutiliser un canvas module-level redimensionné une fois par session (comme `mrOutCanvas`).

### P5. Résolution : devicePixelRatio ignoré → vidéo floue sur écran HiDPI
**Où** : `mapgl.js:2024-2026` et `2582-2589` — les canvas de sortie sont dimensionnés en **pixels CSS** (`getBoundingClientRect`), alors que les canvas OL sources sont en pixels physiques (× DPR). Sur un écran 150 %/200 %, on sous-échantillonne. Par ailleurs `scaleFactor` > 1 agrandit un rendu déjà produit → aucun détail gagné, juste du coût.

**Correction** : dimensionner le canvas de sortie sur la taille **pixel réelle** du canvas OL principal (`srcCanvas.width/height`), et appliquer `scaleFactor` seulement au-delà. Adapter `buildOverlayCache` (le `scaleFactor` effectif devient `srcCanvas.width / rect.width * scaleFactor`).

### P6. Étirement systématique des canvas composés
**Où** : `mapgl.js:2065` et `2593-2597` — `drawImage(c, 0, 0, w, h)` étire chaque canvas source vers la taille de sortie. Si un jour deux canvas de tailles différentes coexistent (OL en crée selon les couches), les proportions seront faussées. Dessiner à l'échelle calculée depuis chaque source plutôt qu'en force.

---

## 4. Bugs secondaires / incohérences

### B1. `updateAnimationStyles()` est du code mort qui masque un vrai manque
**Où** : `mapgl.js:3009-3055` — itère `animationSource.getFeatures()`, or **aucun `addFeature` n'existe** dans le code : la boucle ne fait jamais rien (sauf `map.render()`).
Elle est appelée dans la boucle `extraFrames` de fin (`mapgl.js:1633-1642`) où, de plus, **`globalRecordFrame` n'est pas incrémenté** : les flashs encore actifs (listeners `flashRecord`) restent **figés** sur les frames de fin au lieu de terminer leur fondu.
**Correction** : supprimer `updateAnimationStyles()` et incrémenter `globalRecordFrame++` dans la boucle `extraFrames` (les listeners `postrender` de `flashRecord` feront le reste).

### B2. Doublons de points au jour 1 de l'enregistrement
**Où** : `getFilteredPointsAtStart` (`mapgl.js:1161-1177`) inclut les points dont `date <= dateStart`, puis `displayFeaturesForDate(currentDate, ...)` (`mapgl.js:1556`) ré-ajoute les points du jour de départ → features en double dans `vectorSource` au premier jour (rendu superposé + `cacheNumber` compte le jour 1 alors qu'il est déjà affiché). Utiliser `date < animationStartDate` (strict) dans `getFilteredPointsAtStart` (vérifier le même schéma dans `recordAnimationMediaRecorder` et `startAnimation`).

### B3. Signature incohérente de `flashRecord`
**Où** : déclaration `flashRecord(features)` (`mapgl.js:2963`) mais appel `flashRecord(featuresForDate, flashOptions)` (`mapgl.js:2939`). Fonctionne par accident (relit `pkg.options.flash`), à harmoniser.

### B4. Monitoring de performance appelé pour un mode où il s'auto-désactive
**Où** : `mapgl.js:2620-2623` — `checkPerformance(..., 'images')` alors que la fonction fait `if (recordingMode === 'images') return;` (`mapgl.js:191`). Supprimer l'appel ou réactiver un vrai suivi images (frames perdues, upload lents).

### B5. Fermeture des toasts par sélecteurs DOM larges
**Où** : `stopAnimation` (`mapgl.js:1295-1315`) et `captureNextFrame` (`mapgl.js:1589-1605`) ferment les toasts via `querySelectorAll('.toast, [class*="toast"]')` etc. Fragile (un commentaire du code mentionne déjà un bug causé par ça). **Correction** : conserver la référence du toast de progression dans une variable module et ne fermer que celle-ci.

### B6. Duplication massive du code de réactivation des boutons
**Où** : `mapgl.js:1760-1840` — la même séquence enable/disable de `assembleBtn`/`cleanBtn`/`recordBtn` est copiée 4 fois. Factoriser `setAssembleUiBusy(busy)`. (Deviendra en grande partie obsolète avec C5.)

### B7. `computeTotalAnimationMs` appelé avant application du slowdown
**Où** : `mapgl.js:1942` vs `1949-1961` — `totalMs` est calculé avec `timePerDay` original puis multiplié par `appliedSlowdown` : la « queue » fixe de 3000 ms se retrouve elle aussi multipliée (queue de 12 s à x4). Sans gravité (rallonge), mais à corriger avec C3 : calculer la durée après application du slowdown et n'appliquer le facteur qu'à la partie animation.

### B8. `upload_image` n'applique pas `secure_filename`
**Où** : `capture.py:20-27` — le nom de fichier client est utilisé tel quel dans `os.path.join('captured', image_filename)`. Application locale, mais la correction coûte une ligne (`secure_filename(image_file.filename)`), comme déjà fait dans `upload_video`/`upload_audio`.

### B9. `mrMuxAudioCtx` : variable module déclarée mais code utilisant `window.mrMuxAudioCtx`
**Où** : `mapgl.js:359` (déclaration module inutilisée) vs `mapgl.js:1904-1909`, `2336`, `ui.js:640-644` (`window.mrMuxAudioCtx`). Choisir une seule voie (le module-level, exporté au besoin) pour éviter les divergences.

---

## 5. Plan de correction proposé (ordre recommandé)

| Étape | Items | Effort | Impact fiabilité |
|---|---|---|---|
| 1 | C1 + C2 (retry & arrêt propre mode images) | Faible | Très fort |
| 2 | C3 + B7 (arrêt MR piloté par la fin réelle d'animation) | Faible | Très fort |
| 3 | C4 (fps paramétrable à l'assemblage) | Très faible | Fort |
| 4 | C7, C9, B1, B2, B3, B5, B8 (petits correctifs) | Faible | Moyen |
| 5 | P1 + P4 (supprimer `willReadFrequently`, réutiliser le canvas) | Très faible | Fort (perfs) |
| 6 | C5 (assemblage asynchrone via TaskManager + polling) | Moyen | Fort |
| 7 | P3 (file d'upload concurrente) | Moyen | Fort (perfs) |
| 8 | C6 (normalisation + mux audio côté serveur ffmpeg) | Moyen/élevé | Très fort |
| 9 | P2, P5, P6, C8, B4, B6 | Moyen | Moyen |

## 6. Tests de validation à effectuer après corrections

1. **Mode images** : enregistrement court (10 jours), moyen (1 an), avec/sans audio, avec fps 24 et 30 → vérifier durée vidéo = `nbOfImages / fps`, aucune frame manquante (compter les fichiers dans `captured/` avant nettoyage), musique synchronisée.
2. **Résilience upload** : couper le serveur Flask pendant 2 s en pleine capture → l'enregistrement doit retenter et survivre, ou s'arrêter avec un message clair (jamais de modale zombie).
3. **Mode MediaRecorder** : slowdown x1 et x4, avec normalisation + audio → vérifier que la fin de l'animation (derniers flashs + extra time) figure bien dans la vidéo ; vérifier la durée affichée par les lecteurs (fix WebM duration).
4. **Onglet masqué** : passer sur un autre onglet pendant chaque mode → comportement défini (avertissement/pause), pas de vidéo corrompue silencieuse.
5. **Assemblage long** : animation > 5 min de traitement → progression réelle affichée, pas de timeout, nettoyage effectué.
6. **HiDPI** : enregistrer sur un écran à 150 %/200 % de zoom → netteté identique à l'affichage écran.
