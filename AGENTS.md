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
  `stats-panels-counting.spec.mjs` (fixture `my-finds-gap.gpx`).
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
  exemple dans les specs `stats-panels-*.spec.mjs` (`resetStats`, helpers dans
  `stats-panels-helpers.mjs`). Pour lire les comptes :
  `app.getStatsSnapshot()` (mode, total, comptes par métrique,
  `videoDrawCount`). Un `id` de panneau posé dans un spec doit être
  hexadécimal (`/^[0-9a-f]{6,32}$/`, `ID_RE` de stats_model.mjs) : un id
  invalide (`sel00001`, `a11y0001`…) est silencieusement régénéré et le
  `data-panel-id` cherché n'existe jamais.
- Même famille : `images` (images de l'onglet Images) est une préférence
  globale ; un spec qui en pose doit remettre
  `PUT /api/settings {images: {enabled: true, items: []}}` en sortant —
  exemple dans `images.spec.mjs` (`afterEach`). Les fichiers envoyés
  (`POST /api/images`) restent dans `images/` du runtime E2E jusqu'au retrait
  manuel dans la bibliothèque ; seuls les envois interrompus sont balayés.
- Les logs Geocaching (carte « Mes logs », docs/logs-geocaching.md) vivent
  dans la base du runtime, hors de `/clear_database` : un spec qui en importe
  doit appeler `POST /api/logs/clear` en sortant, sinon le compte reste
  posé et les specs suivants voient leurs imports refusés (« autre compte »)
  — exemple dans `gc-logs.spec.mjs`. Les logs des fixtures My Finds e2e
  n'ont pas d'attribut `id` : rejetés, ils ne créent aucune collection.
  Même famille : `dnf_display` / `dnf_in_trail` (points DNF) sont des
  préférences globales à remettre (`false` / `true`) en sortant. Les points
  DNF ont leur propre couche, sous les trouvailles : source
  `window.dnfVectorSource` (pas `window.vectorSource`), jamais dans
  `pointsByDate` — exemple dans `dnf-display.spec.mjs` ; effacements et
  flashs DNF relevés par `getDnfDebugState()`. La case « Mes DNF » et les
  réglages `flash.dnf` n'existent qu'avec des DNF importés (`#dnfDisplayField`
  / `#flashDnf` masqués sinon, `OFFER_IDS` de dnf_data.js) : un spec qui les
  manipule doit d'abord importer des logs portant un DNF. Les jetons d'aperçu
  (fichier ou export du favori) vivent sous `pending_log_imports/` du
  répertoire de **données** — pas dans `%TEMP%`, partagé entre l'app,
  pytest et le harnais e2e : un export reçu d'un run y ressortait au
  suivant et gardait le bandeau « export en attente » affiché après
  l'import. `blueprints/labs.py` a le même motif `%TEMP%` pour ses jetons
  (non remontés dans un statut, donc sans symptôme e2e).
- Même famille que les DNF : `owner_display` / `owner_in_trail` (caches
  posées sur la carte principale) sont des préférences globales à remettre
  (`false` / `true`) en sortant, et les logs à vider. Couche propre, source
  `window.ownerVectorSource` (jamais dans `pointsByDate`) ; relevé
  `getOwnerDebugState()` (états `pstate`, flashs, anneau des icônes). La case
  de l'onglet Données n'existe qu'avec des caches posées : importer les logs
  puis `page.reload()` (ou `reloadOwnerData()`) — exemple dans
  `owner-display.spec.mjs`, dont la fixture `my-finds-poses.gpx` cale la plage
  d'animation sur la vie des caches de `logs-poses.json`.
- Panneaux Stats par source (`options.source` : `dnf` / `owned`) : les
  données DNF et caches posées sont chargées au démarrage même si leur
  affichage carte est coupé — un spec qui importe des logs recharge la page
  puis attend `hasDnfData()` / `hasOwnedCaches()`. Comptes par source dans
  `getStatsSnapshot().sources` (seulement pour une source qui a des
  panneaux) ; tuiles d'état lues dans `.stats-panel-alt` — exemple dans
  `stats-sources.spec.mjs`.
- `page.goto('/')` puis `page.goto('/#images')` (ou tout autre `#onglet`)
  n'est qu'un changement d'ancre : la page n'est PAS rechargée, les
  préférences posées entre les deux par `PUT /api/settings` ne sont pas
  relues (symptôme : réglages présents côté serveur, absents de
  `getImagesSnapshot()`). Envoyer les fichiers par `page.request` sans
  ouvrir de page avant, ou recharger (`page.reload()`).
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
  L'axe de la piste déborde la plage d'une marge grisée de chaque côté
  (`timelineAxis`, ¼ de la plage dans la limite des données) : calculer
  les positions sur `getTimelineBarSnapshot()` (`axisStart`, `axisSpan`,
  `rangeOffset`) — helpers `axisX`/`clickDay` de `timeline-bar.spec.mjs`.
  Au repos, la molette n'agit que si la piste a le focus. Le suivi de
  caméra survit à un saut (piste recalée) : `getCameraFollowSnapshot()`
  compare la vue à la pose attendue — il faut des caches éloignées (GPX
  généré), sinon la piste n'a aucun trajet et `pose` vaut null.
- Page Mes poses (`/poses`, docs/mode-poses.md) : ses données sont les logs
  importés — un spec appelle `POST /api/logs/clear` en entrée ET en sortie
  (les specs `gc-logs`, `dnf-display` partagent la collection). Préférences à
  remettre : `poses_archived_display`, `poses_infos_template`,
  `poses_animation`, `stats.poses_panels`, `images.poses_items`. Relevés :
  `getPosesDebugState()` (états `pstate`, segments, journal des flashs,
  compteurs) ; signal `window.mygcflowPosesLoaded`. Pour tester les flashs
  sans dépendre du rythme, piloter le moteur jour par jour
  (`lifecycleEngine().begin/step/end`, exemple dans `poses.spec.mjs`).
- Trois pages, trois prédicats (`app_mode.mjs`) : `isLifecyclePage()` pour le
  moteur partagé Évolution / Mes poses, `isEvolutionPage()` pour ce qui tient
  aux bases CSV, `isMainPage()` pour GPX, DNF, sources. Les clés de stockage
  par page passent par `statsPanelsKey(mode)` / `imagesItemsKey(mode)` /
  `perPage(...)`. Un module de page exporte des noms uniques (`posesXxx`) :
  `export *` d'index.js écarte EN SILENCE un nom exporté par deux modules.
- Vider les processus orphelins si un run est tué : `taskkill /F /T /PID <id>`
  sur les `node.exe`/`python.exe` dont la ligne de commande contient
  `cli.js`/`run_server.py`. Sous Linux : `pkill -f cli.js` /
  `pkill -f run_server.py`.
- Sous Linux, config et données suivent la spec XDG : préférences et thèmes
  dans `$XDG_CONFIG_HOME/MyGCFlow` (`~/.config`), données dans
  `$XDG_DATA_HOME/MyGCFlow` (`~/.local/share`).

## Piège `.gitignore` et dossiers nommés `logs/`

`logs/` dans `.gitignore` (journaux runtime) est un motif nu : il ignore
**tout** dossier `logs/`, où qu'il soit — `static/logs/` (sources du favori
« Mes logs ») ne ressortait pas de `git status`. Exception posée :
`!static/logs/`. Si un nouveau dossier `logs/` doit être versionné,
ajouter sa propre exception.

Autre contrainte de ces sources : elles finissent sur **une seule ligne**
dans le lien `javascript:` (commentaires en lignes entières, instructions
terminées par `;`, pas de chaîne multi-ligne) — vérifié par
`test_bookmarklet_is_a_single_comment_free_line` dans
`tests/test_logs_api.py`.

## Piège `hidden` + classes d'affichage Bootstrap

Un élément qui porte `hidden` ET une classe `d-block`/`d-flex`/`d-grid`…
reste **toujours visible** : ces classes posent `display: … !important`, qui
l'emporte sur l'attribut. Pour un élément masqué par `hidden`, ne pas mettre
de classe `d-*` (`.form-hint` est déjà en bloc), ou ajouter une règle
`#id[hidden] { display: none !important; }` (cf. `#audioEndRow`). Côté tests,
vérifier aussi le cas MASQUÉ (`toBeHidden`) — c'est lui qui aurait révélé
« Image manquante » affichée sous une image bien chargée (2026-10-19).

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

**Piège regex (JS) :** un guillemet double littéral dans une expression
régulière (`/[;"
]/`, `replace(/"/g, …)`) fait croire au lexer JS de
pybabel qu'une chaîne s'ouvre : tous les `t()` qui suivent dans le fichier
disparaissent de `messages.pot`, sans erreur, jusqu'à ce qu'un autre
guillemet le resynchronise (cas de l'export CSV de `stats_panels.js`,
corrigé le 2026-10-19). Écrire `"` dans la regex. Contrôle : une ligne
`t('…')` sans référence `#: fichier:ligne` dans la pot.

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

## Tests unitaires JS

`npm run test:unit` (`node --test "tests/js/*.test.mjs"`, aucune dépendance,
Node 22 comme 24) : modules purs de `static/js/*.mjs` sans DOM — pour
l'instant `timeline_model.mjs`. Un module importable ainsi ne doit tirer
ni `index.js` ni le DOM dans sa chaîne d'imports.

## Benchmark saut de la barre de chronologie

`MYGCFLOW_BENCH=1 [BENCH_N=20000] npm run test:e2e -- bench-timeline-seek`
(ignoré sans la variable) : génère un GPX « My Finds » de N trouvailles sur
10 ans, ouvre l'aperçu en pause et chronomètre `seekAnimationToDate` sur un
glissement simulé (aller-retour, 120 positions), des pas d'un jour, et
`seekStatsToDate` seul.

Mesures (2026-10-21, Windows, Chromium Playwright/SwiftShader, 20 000
trouvailles, 2 panneaux Stats) :

| | glissement moy. / p50 / max | pas d'un jour p50 | Stats seules |
|---|---|---|---|
| avant | 74 / 69 / 170 ms | 69 ms | 3 ms |
| saut incrémental | 6,6 / 5,3 / 28 ms | 3,4 ms | 3 ms |

Avant, chaque saut reconvertissait en objets carte (`readFeatures`) toutes
les trouvailles jusqu'à la date, vidait puis remplissait la source
(10 000 points : conversion ~25 ms, `clear()` ~25 ms, `addFeatures` ~20 ms).
Désormais (`seekPointsToDay`, mapgl.js) les objets sont créés une fois par
jour et par `pointsByDateRevision`, et seule la différence de jours est
ajoutée/retirée — tant que la source n'a pas été touchée par autre chose
depuis le dernier saut (même objet, même `getRevision()`) ; sinon,
reconstruction complète depuis le cache (le max de 28 ms).

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
