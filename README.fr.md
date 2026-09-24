<div align="center">
  <img src="static/img/mygcflow-icon.png" alt="MyGCFlow" width="96">
  <h1>MyGCFlow</h1>
  <p>Transformez vos trouvailles de géocaching en carte animée — et enregistrez-la en vidéo.</p>
  <p><a href="README.md">🇬🇧 English version</a></p>
</div>

---

MyGCFlow est une **application de bureau pour Windows** : elle lance un serveur
Flask local et s'ouvre dans votre navigateur par défaut. Rien n'est envoyé sur
Internet — votre fichier GPX, votre base et vos vidéos restent sur votre machine.

Chargez la Pocket Query « My Finds » exportée depuis geocaching.com, composez le
style de carte qui vous plaît, puis rejouez vos caches jour après jour et
exportez le résultat en vidéo (avec une musique si vous le souhaitez).

## Fonctionnalités

- **Import GPX** — fichier `.gpx` ou `.zip` téléchargé depuis geocaching.com,
  importé en tâche de fond avec barre de progression.
- **Filtres** — par type de cache, par période, par pays ou région.
- **Fonds de carte** — OpenStreetMap, Toner (clair/sombre), Watercolor, ou une
  carte vectorielle dont vous réglez contour, remplissage, fond et épaisseur des
  traits.
- **Style des points** — mode vectoriel (forme, taille, couleur du centre et de
  la bordure) ou jeux d'icônes (Geocaching, Smiley) ; les couleurs peuvent
  suivre celles des types de cache.
- **Effet « flash »** — animation jouée à l'apparition de chaque cache, dont un
  mode impulsion (halo + onde expansive, avec décalage géographique).
- **Overlay** — titre et cartouche d'informations (nombre de caches, date en
  cours), stylés via les onglets texte / boîte / ombre / position ou en CSS.
- **Animation** — dates de début et de fin, durée par jour ou durée totale
  visée, pause finale, suivi de caméra et apparition animée des points.
- **Audio** — ajout d'une musique, réglage du volume, ou calage de la durée de
  l'animation sur celle du morceau.
- **Enregistrement vidéo** — deux pipelines : **MediaRecorder** (rapide, `.webm`
  directement dans le navigateur) ou **images + ffmpeg** (plus lent, sans perte,
  assemblage côté serveur), avec FPS, débit, résolution de sortie,
  ralentissement et échelle de qualité.
- **Profils** — toute la configuration de style enregistrée sous un nom, avec
  duplication / renommage / réinitialisation / import-export JSON, et des
  profils d'exemple fournis.
- **Interface bilingue** — français et anglais, changement à chaud.
- **Hors ligne** — toutes les bibliothèques tierces sont hébergées localement :
  aucun CDN, aucun accès réseau nécessaire hors tuiles de carte.

## Installation (utilisateurs)

Récupérez la dernière version sur la
[page des Releases](https://github.com/TherionAcribus/MyGCFlow/releases) :

- `MyGCFlow-Setup-<version>.exe` — installeur ;
- l'archive portable — à décompresser, puis lancer `MyGCFlow.exe`.

Les deux embarquent Python, les dépendances et ffmpeg : il n'y a rien d'autre à
installer.

Au lancement, MyGCFlow démarre un serveur sur `127.0.0.1:51730`, ouvre votre
navigateur et affiche une icône dans la zone de notification. Cette icône
(*Ouvrir MyGCFlow*, *Dossier des vidéos*, *Journaux*, *Quitter*) est le seul
moyen de fermer l'application : il n'y a ni fenêtre ni console. Relancer
MyGCFlow rouvre simplement un onglet.

Options de dépannage : `MyGCFlow.exe --no-browser`, `--no-tray` (arrêt par
Ctrl+C), `--port N`.

## Utilisation

1. **Données** — sur geocaching.com, allez dans *Profil › Pocket Query › My
   Finds*, cliquez sur « Add to Queue » et téléchargez le fichier une fois prêt
   (générable une fois tous les 3 jours). Chargez-le dans l'onglet **Données**,
   puis filtrez.
2. **Style** — choisissez un fond de carte, réglez les points et le flash,
   ajoutez un titre et un cartouche d'infos, puis sauvegardez le tout dans un
   profil.
3. **Animation & vidéo** — définissez la période et la vitesse, ajoutez
   éventuellement une musique, cliquez sur **Démarrer** pour prévisualiser, puis
   sur **Enregistrer** pour la version finale.
4. **Préférences** — langue, vérification des mises à jour, profil par défaut au
   démarrage, vue de carte par défaut.

Un mode d'emploi complet est intégré à l'application, à l'adresse `/guide`.

## Où sont vos fichiers

| Contenu | Application installée | Développement |
| --- | --- | --- |
| Programme et ressources | `%LOCALAPPDATA%\Programs\MyGCFlow` (lecture seule) | dossier du projet |
| Base SQLite, caches GeoJSON | `%LOCALAPPDATA%\MyGCFlow\instance` | `instance/` |
| Images de capture, pistes audio | `%LOCALAPPDATA%\MyGCFlow\` | dossier du projet |
| Vidéos produites | `Vidéos\MyGCFlow` | `video/` |
| Journaux | `%LOCALAPPDATA%\MyGCFlow\logs\mygcflow.log` | `logs/` |
| Préférences et profils | `%APPDATA%\MyGCFlow` | `%APPDATA%\MyGCFlow` |

La désinstallation supprime le programme mais **conserve** les données et les
vidéos. `MYGCFLOW_DATA_DIR` redirige toutes les données et `MYGCFLOW_CONFIG_DIR`
les préférences — c'est ce qu'utilisent les tests.

## Développement

Prérequis : Python 3.12, et Node.js uniquement pour les tests de bout en bout.

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe app.py      # serveur de développement (Werkzeug, débogueur)
```

`python app.py` est le serveur de **développement** ; `launcher.py` est le point
d'entrée de la version empaquetée (waitress + icône de notification).

### Organisation

```
app.py              fabrique de l'application Flask
launcher.py         point d'entrée empaqueté (waitress, zone de notification, instance unique)
paths.py            tous les emplacements de fichiers, ressources vs données utilisateur
config.py           configuration Flask
blueprints/         routes : core, filters, gpx, media, profiles, tasks
bdd.py              lecture du GPX et accès à la base
geojson_cache.py    génération et mise en cache du GeoJSON
capture.py          pipelines vidéo (images + ffmpeg, post-traitement MediaRecorder)
settings_manager.py préférences et profils de style (JSON, sous %APPDATA%)
task_manager.py     pool de tâches de fond (import, GeoJSON)
static/js/          carte OpenLayers, animation, enregistrement, interface
templates/          gabarits Jinja, dont le mode d'emploi intégré
translations/       catalogues gettext (fr, en)
installer/          spec PyInstaller, script Inno Setup, build.ps1
docs/               documentation interne
```

Pile technique : Flask + Flask-Babel + SQLAlchemy (SQLite), OpenLayers (points
WebGL), Tabler/Bootstrap, HTMX, ffmpeg via `imageio-ffmpeg`.

### Tests

```powershell
# tests unitaires Python
.\.venv\Scripts\python.exe -m unittest discover -s tests -t .

# pipelines vidéo (produit de vrais fichiers, contrôlés avec ffprobe)
.\.venv\Scripts\python.exe run_video_tests.py            # --quick pour éviter le réencodage

# bout en bout dans le navigateur (Playwright)
npm install && npx playwright install chromium
npm run test:e2e
```

### Traductions

Le français est la langue source (`msgid`), l'anglais vit dans le `msgstr`.

```bash
pybabel extract -F babel.cfg -k _ -k _l -k t -o messages.pot .
pybabel update -i messages.pot -d translations
pybabel compile -d translations
python check_missing_translations.py
```

Les règles qui s'appliquent aux chaînes JavaScript sont dans
[docs/translations.md](docs/translations.md).

### Construire la version Windows

Prérequis : Python 3.12 (ou `uv`) et [Inno Setup 6](https://jrsoftware.org/isinfo.php).

```powershell
powershell -ExecutionPolicy Bypass -File installer\build.ps1
```

Produit `dist\MyGCFlow\MyGCFlow.exe` (version portable) et
`dist\MyGCFlow-Setup-<version>.exe`. `-SkipInstaller` s'arrête après
l'exécutable.

Publier une version : mettre à jour `__version__` dans `version.py`, committer,
puis `git tag v1.2.0 && git push origin v1.2.0` — le
[workflow de release](.github/workflows/release.yml) construit et publie la
Release GitHub.

## Documentation

- [docs/distribution.md](docs/distribution.md) — empaquetage, emplacements, mises à jour
- [docs/preferences-et-profils.md](docs/preferences-et-profils.md) — réglages globaux vs profils
- [docs/async-tasks.md](docs/async-tasks.md) — API des tâches de fond
- [docs/translations.md](docs/translations.md) — règles d'internationalisation
- [README_TESTS_VIDEO.md](README_TESTS_VIDEO.md) — matrice des tests vidéo

## Crédits

MyGCFlow n'est pas affilié à Groundspeak / Geocaching.com. Les licences des
dépendances embarquées sont listées dans
[installer/licenses/THIRD_PARTY_NOTICES.txt](installer/licenses/THIRD_PARTY_NOTICES.txt).
