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
- Pour compter les toasts visibles dans un test, observer
  `.gcm-toast.show` (MutationObserver) plutôt que `.gcm-toast` : les nœuds
  survivent ~300 ms après fermeture, sans la classe `show`. `.show` est
  ajoutée par `setTimeout(10)` — un toast masqué dans cette fenêtre ne doit
  pas « revivre » (garde `_gcmHiding` dans `notifications.js`).
- Base vide → l'app force le retour sur l'onglet Données à chaque résolution
  du statut ; `updateDataAvailabilityUI` saute ce bascule quand l'URL porte
  un hash — les specs qui ont besoin de l'onglet Style doivent ouvrir `/#style`.
- Le mode de rythme (`animation.rhythm_mode`) et la durée totale sont des
  préférences globales persistées, partagées par tous les specs d'un run :
  un spec qui quitte le mode jours/seconde (choisir une musique suffit, elle
  cale la vidéo dessus) doit y revenir, sinon `#inputDaysPerSecond` reste en
  lecture seule pour les specs suivants — exemple dans `music-options.spec.mjs`
  (`afterEach`).
- Même famille : `animation.camera_follow_mode` (cible « tête du trait ») est
  une préférence globale. La sauvegarde étant debouncée (500 ms), remettre la
  valeur par l'UI ne suffit pas : la navigation du spec suivant peut précéder
  le PUT, qui part alors sur une machine plus lente (échec CI de
  `travel-trail.spec.mjs` › « glisser la caméra », 2026-10-17). Après la
  restauration, attendre la persistance via `GET /api/settings`.
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
- Tester qu'une courbe Stats avance pendant les jours sans trouvaille exige
  un rythme **lent** (`inputDaysPerSecond` = 1) : à ~2 j/s et plus, les lots
  arrivent dans la fenêtre des tweens (~600 ms) et le mécanisme de
  surbrillance redessine assez souvent pour masquer l'absence de `touch()`
  dans `accumulateStatsForDates` (le bug ne se voit que quand
  `msPerDay > duration`). `getStatsSnapshot().drawnHeads` expose le dernier
  jour peint par la tête de chaque courbe — exemple dans
  `stats-panels.spec.mjs` (fixture `my-finds-gap.gpx`).
- `makeDebouncedSettingsSaver` expose `flush()` : il envoie tout de suite le
  patch en attente. Les actions discrètes (suppression, réordonnancement…)
  doivent l'appeler — sinon leur écriture peut mourir dans le minuteur si la
  page est rechargée juste après (`commit(..., { immediate: true })` dans
  stats_ui.js). Le retour visuel global des actions Stats vit dans
  `#statsSaveStatus` (titre « Panneaux »).
- Même famille : `stats` (panneaux de l'onglet Stats) est une préférence
  globale. Un spec qui pose des panneaux doit remettre
  `PUT /api/settings {stats: {enabled: true, panels: []}}` en sortant, sinon
  les suivants démarrent avec des canvas `.stats-panel` sur la carte —
  exemple dans `stats-panels.spec.mjs` (`afterEach`). Pour lire les comptes :
  `app.getStatsSnapshot()` (mode, total, comptes par métrique,
  `videoDrawCount`). Un `id` de panneau posé dans un spec doit être
  hexadécimal (`/^[0-9a-f]{6,32}$/`, `ID_RE` de stats_model.mjs) : un id
  invalide (`sel00001`, `a11y0001`…) est silencieusement régénéré et le
  `data-panel-id` cherché n'existe jamais.
- Après un clic sur un bouton de `#layoutPresets` (préréglages, plein écran,
  `#btnTimelineBar`), sa bulle d'aide réapparaît tant qu'il garde le focus et
  intercepte les clics sur ses voisins : `document.activeElement.blur()`
  avant de cliquer le suivant — exemple dans `timeline-bar.spec.mjs`
  (`hideToolbarTooltip`). Pour lancer l'aperçu depuis un spec, passer par
  `#btnQuickPreview` / `#btnQuickPause` / `#btnQuickStop` (barre d'outils,
  toujours visibles) plutôt que les boutons de l'onglet Animation.
- Barre de chronologie (`timeline_bar.js`) : un saut n'est accepté que sur un
  aperçu en pause (`seekAnimationToDate`, mapgl.js) ; la barre ouvre l'aperçu
  en pause depuis le repos (`startPausedPreview`, ui.js). L'état s'observe par
  `getTimelineBarSnapshot()` (`valueNow` = jour depuis la date de début) et
  `previewPlaybackState()` (`idle`/`playing`/`paused`/`recording`).
- Vider les processus orphelins si un run est tué : `taskkill /F /T /PID <id>`
  sur les `node.exe`/`python.exe` dont la ligne de commande contient
  `cli.js`/`run_server.py`. Sous Linux : `pkill -f cli.js` /
  `pkill -f run_server.py`.
- Sous Linux, config et données suivent la spec XDG : préférences et thèmes
  dans `$XDG_CONFIG_HOME/MyGCFlow` (`~/.config`), données dans
  `$XDG_DATA_HOME/MyGCFlow` (`~/.local/share`).

## Ordre d'évaluation des modules

`ui.js` appelle ses fonctions d'init (`initUIElements`) **pendant sa propre
évaluation**, et `index.js` évalue les modules dans l'ordre de ses `export *`.
Un appel depuis `initUIElements` vers un module listé plus loin dans
`index.js` (ex. `stats_ui.js`) tombe dans la zone morte de ses `let` :
`ReferenceError`, tout le graphe échoue, et la page n'atteint jamais
`mygcflowReady` (symptôme E2E : tous les specs expirent sur
`waitForFunction(() => window.mygcflowReady === true)`, avec en cascade des
« Cannot access 'defaultGcColors' / 'lastDbHasData' before initialization »).
Un tel module s'initialise lui-même en fin de fichier (cf. `stats_ui.js`).

## Traductions

Source en français (`msgid`), anglais en `msgstr` — et dans le catalogue FR,
`msgstr` doit reprendre le `msgid` (exceptions : msgids anglais historiques
comme `Cancel`→`Annuler`). Commandes dans README.md
(pybabel extract/update/compile + `check_missing_translations.py`).
Côté JS, seul helper : `t()` via `pkg.t(...)` ; l'appeler **hors** d'un
template literal, sinon pybabel ne l'extrait pas — et sans chaînage
optionnel : `pkg.t?.('…')` n'est pas extrait non plus (chaîne absente du
`.pot`, jamais traduite).

**Piège fuzzy :** `pybabel update` apparie les msgids nouveaux/renommés aux
msgstr les plus proches et marque `#, fuzzy`. Si le drapeau est retiré sans
corriger le msgstr, des textes sans rapport s'affichent (ex. le bouton
« Télécharger la mise à jour » est devenu « Vérifier les mises à jour »).
Après un `update`, `grep fuzzy translations/*/LC_MESSAGES/messages.po` et
corriger avant `compile` — ou lancer `pybabel update` avec
`--no-fuzzy-matching` et traduire les chaînes vides ensuite.

**Piège `nul` (Windows) :** un fichier littéralement nommé `nul` à la racine
(créé par un redirect `> nul` sous Git Bash — nom réservé Win32) fait
**avorter `pybabel extract` en silence** : `messages.pot` ressort vide et
l'`update` suivant obsolète tout le catalogue (`#~` partout). Vérifier
`grep -c "^msgid" messages.pot` après l'extract (~1500+ attendu). Suppression
du fichier : `cmd //c "del nul"` échoue, utiliser
`python -c "import os; os.remove(r'\\?\C:\chemin\nul')"`.

## Benchmark aperçu → commit Labs (lot 5.4)

`tools/bench_lab_import.py [tailles]` mesure le parcours réel (test client
Flask) en enveloppant les vraies fonctions : parsing, simulation SQL de
l'aperçu (`_APPLY_BY_FORMAT` + rollback), écriture temporaire
(`_store_pending`), reparse + `commit_import_batch` du commit.

Mesures de référence (2026-10, Windows, SQLite local) — lot combiné
historique JSON + GPX lab2gpx à UUID joints :

| étapes | aperçu e2e | (parse + simul) | commit e2e | (parse + apply) |
|--------|-----------|-----------------|-----------|-----------------|
| 1 000  | 0,20 s | 31 ms + 126 ms | 0,22 s | 31 ms + 107 ms |
| 5 000  | 0,72 s | 162 ms + 499 ms | 0,77 s | 147 ms + 520 ms |
| 10 000 | 2,11 s | 397 ms + 1 616 ms | 2,40 s | 642 ms + 1 576 ms |

Objectif retenu : **aperçu < 2 s pour 5 000 étapes** → 0,72 s, respecté avec
~2,8× de marge → pas d'optimisation entreprise. Le coût dominant est la
simulation SQL (60-77 % de l'aperçu) ; l'écriture temporaire est négligeable
(quelques ms). Si une optimisation devient nécessaire (représentation
normalisée temporaire), le commit doit continuer à recalculer les conflits
sur l'état courant — `_load_pending` vérifie déjà `collection_revision`.
