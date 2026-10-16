# Notes agent — GCMap / MyGCFlow

## Tests E2E (Playwright)

`npm run test:e2e` (ou `node node_modules/@playwright/test/cli.js test <filtre>`).

**Piège Node 24 :** avec Node 24.21.0, Playwright 1.52 se fige avant même
`--list` — aucun output, aucun serveur. Cause : `module.register(esmLoader)`
s'exécute dans le thread de chargement ESM de Node 24, et le `require()` du
`package.json` du projet depuis `playwright/lib/util.js:fileIsModule` y
interbloque (diagnostiqué via `--inspect` : pile coincée dans
`#loadAndMaybeBlockOnLoaderThread`).

→ Utiliser Node 22 (`C:\Users\fabie\AppData\Local\nvm\v22.22.2\node.exe` via
nvm) ou mettre à jour Playwright si une version corrige ce deadlock.

Autres repères :
- Le runtime E2E est isolé via `MYGCFLOW_E2E_RUNTIME` (config + données en
  `%TEMP%`), voir `playwright.config.mjs` et `tests/e2e/run-tests.mjs`.
- `saveMapCenterSettings` (ui.js) n'envoie rien quand les valeurs n'ont pas
  changé, ce qui convient aux sorties de champ mais pas à un clic explicite :
  « Utiliser le cadrage actuel » passe donc `{ force: true }`. Sans cela, une
  vue déjà au centre/zoom par défaut n'était jamais enregistrée (le serveur
  gardait `map_default_center: null`), sans aucun retour visuel — c'était
  l'échec de longue date de `global-preferences.spec.mjs` › « Enregistrer le
  cadrage », corrigé le 2026-10-11.
- Muter `feature.geometry.coordinates` en place dans un `page.evaluate`
  n'incrémente pas `pointsByDateRevision` : les mémoïsations indexées dessus
  (résumés de la simulation caméra, trajet du trail) restent figées. Appeler
  `app.bumpPointsByDateRevision()` après la mutation — exemple dans
  `video-export.spec.mjs`.
- `pointsByDateRevision` n'est pas un compteur de rechargements : il bump à
  chaque reconstruction de l'index (`clearLocalData`, `buildPointsByDateIndex`,
  `changeSelect`…), donc plusieurs fois par rechargement. Pour compter les
  rechargements du jeu de données, intercepter `POST /get_geojson_points`
  (un par rechargement) — exemple dans `labs-sources.spec.mjs`.
- Le relevé périodique du statut Labs (`refreshLabsStatus`, toutes les 4 s)
  ne tourne que quand l'onglet Données porte la classe `active`. Un test qui
  veut une fenêtre de mesure déterministe peut geler ce relevé via
  `document.getElementById('data').classList.remove('active')` ; les modales
  affichées restent utilisables car `getBsModal` les rattache à `<body>`.
- Base vide → l'app force le retour sur l'onglet Données à chaque résolution
  du statut ; `updateDataAvailabilityUI` saute ce bascule quand l'URL porte
  un hash — les specs qui ont besoin de l'onglet Style doivent ouvrir `/#style`.
- Le mode de rythme (`animation.rhythm_mode`) et la durée totale sont des
  préférences globales persistées, partagées par tous les specs d'un run :
  un spec qui quitte le mode jours/seconde (choisir une musique suffit, elle
  cale la vidéo dessus) doit y revenir, sinon `#inputDaysPerSecond` reste en
  lecture seule pour les specs suivants — exemple dans `music-options.spec.mjs`
  (`afterEach`).
- Même piège pour la musique : la dernière choisie est retenue
  (`recording.audio_file`) et rechargée à chaque démarrage. Un spec qui en
  choisit une doit la retirer (`#btnAudioFileRemove`) et attendre
  `audio_file === ''`, sinon tous les specs suivants démarrent avec elle.
  La liste des musiques récentes (`recording.audio_recent`) survit au retrait :
  la vider par `PUT /api/settings` `{recording: {audio_recent: []}}`.
- Le Chromium de Playwright (comme Chromium sous Linux) n'a pas les codecs
  propriétaires : il ne décode ni AAC ni H.264 (`decodeAudioData` →
  `EncodingError`). Tout audio destiné au navigateur (version lisible d'un
  .wma, cf. `audio_library.py`) est donc produit en FLAC, pas en AAC/M4A.
- L'onglet Animation & vidéo a quatre sous-onglets (`#animationConfigTab`
  « Dates & rythme », `#cameraConfigTab`, `#musicConfigTab`,
  `#recordingConfigTab`). Un contrôle d'un sous-onglet fermé n'est pas
  visible : l'ouvrir avant tout `fill`/`check`/`toBeVisible` — et un
  `toBeHidden` y passerait à tort. Recliquer `a[href="#animation"]` ne
  ramène pas au premier sous-onglet : celui qui était ouvert le reste.
  `#timingSummary`, `#timingErrors` et `#timingWarnings` vivent au-dessus des
  sous-onglets, visibles depuis les quatre.
- Vider les processus orphelins si un run est tué : `taskkill /F /T /PID <id>`
  sur les `node.exe`/`python.exe` dont la ligne de commande contient
  `cli.js`/`run_server.py`. Sous Linux : `pkill -f cli.js` /
  `pkill -f run_server.py`.
- Sous Linux, config et données suivent la spec XDG : préférences et thèmes
  dans `$XDG_CONFIG_HOME/MyGCFlow` (`~/.config`), données dans
  `$XDG_DATA_HOME/MyGCFlow` (`~/.local/share`).

## Traductions

Source en français (`msgid`), anglais en `msgstr` — et dans le catalogue FR,
`msgstr` doit reprendre le `msgid` (exceptions : msgids anglais historiques
comme `Cancel`→`Annuler`). Commandes dans README.md
(pybabel extract/update/compile + `check_missing_translations.py`).
Côté JS, seul helper : `t()` via `pkg.t(...)` ; l'appeler **hors** d'un
template literal, sinon pybabel ne l'extrait pas.

**Piège fuzzy :** `pybabel update` apparie les msgids nouveaux/renommés aux
msgstr les plus proches et marque `#, fuzzy`. Si le drapeau est retiré sans
corriger le msgstr, des textes sans rapport s'affichent (ex. le bouton
« Télécharger la mise à jour » est devenu « Vérifier les mises à jour »).
Après un `update`, `grep fuzzy translations/*/LC_MESSAGES/messages.po` et
corriger avant `compile` — ou lancer `pybabel update` avec
`--no-fuzzy-matching` et traduire les chaînes vides ensuite.
