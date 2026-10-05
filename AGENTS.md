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
- Échec connu (préexistant) : `global-preferences.spec.mjs` › « Enregistrer
  le cadrage ». Quand la vue est déjà au centre/zoom par défaut,
  `saveMapCenterSettings` (ui.js) ne voit aucun changement et n'envoie pas le
  PUT — le serveur garde `map_default_center: null`.
- Base vide → l'app force le retour sur l'onglet Données à chaque résolution
  du statut ; `updateDataAvailabilityUI` saute ce bascule quand l'URL porte
  un hash — les specs qui ont besoin de l'onglet Style doivent ouvrir `/#style`.
- Vider les processus orphelins si un run est tué : `taskkill /F /T /PID <id>`
  sur les `node.exe`/`python.exe` dont la ligne de commande contient
  `cli.js`/`run_server.py`.

## Traductions

Source en français (`msgid`), anglais en `msgstr`. Commandes dans README.md
(pybabel extract/update/compile + `check_missing_translations.py`).
Côté JS, seul helper : `t()` via `pkg.t(...)` ; l'appeler **hors** d'un
template literal, sinon pybabel ne l'extrait pas.
