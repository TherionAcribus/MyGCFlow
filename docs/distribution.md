# Distribution Windows

MyGCFlow est livré sous forme d'un installeur Windows (`MyGCFlow-Setup-<version>.exe`)
et d'une version portable (dossier zippé). Les deux contiennent Python, les
dépendances, ffmpeg et les ressources : l'utilisateur n'installe rien d'autre.

## Ce que fait l'application installée

`MyGCFlow.exe` (point d'entrée : `launcher.py`) :

- démarre le serveur **waitress** sur `127.0.0.1` uniquement, port **51730**
  (fixe : le `localStorage` du navigateur est rangé par port ; les ports
  51731–51739 ne servent que si 51730 est occupé par un autre programme) ;
- ouvre MyGCFlow dans le navigateur par défaut ;
- affiche une icône dans la zone de notification : *Ouvrir MyGCFlow*, *Dossier des
  vidéos*, *Journaux*, *Quitter*. C'est le seul moyen de fermer l'application
  (pas de fenêtre ni de console). Quitter pendant un import ou un encodage
  demande confirmation, puis arrête ffmpeg ;
- instance unique : relancer MyGCFlow rouvre simplement un onglet.

Options utiles au dépannage : `MyGCFlow.exe --no-browser`, `--no-tray` (arrêt par
Ctrl+C), `--port N`.

`python app.py` reste le serveur de **développement** (Werkzeug, débogueur).

## Où sont les fichiers

Tous les chemins sont centralisés dans `paths.py`.

| Contenu | Application installée | Développement |
| --- | --- | --- |
| Programme et ressources (templates, static, translations) | `%LOCALAPPDATA%\Programs\MyGCFlow` (lecture seule) | dossier du projet |
| Base SQLite, caches GeoJSON, arbre pays/régions | `%LOCALAPPDATA%\MyGCFlow\instance` | `instance/` |
| Captures en cours (`captured/`), pistes audio (`audio/`) | `%LOCALAPPDATA%\MyGCFlow\` | dossier du projet |
| Vidéos produites | `Vidéos\MyGCFlow` (dossier Vidéos de Windows) | `video/` |
| Journaux | `%LOCALAPPDATA%\MyGCFlow\logs\mygcflow.log` | `logs/` |
| Préférences et profils | `%APPDATA%\MyGCFlow` | `%APPDATA%\MyGCFlow` |

`MYGCFLOW_DATA_DIR` redirige toutes les données (base, caches, médias, journaux)
et `MYGCFLOW_CONFIG_DIR` les préférences : c'est ce qu'utilisent les tests.

La désinstallation supprime le programme mais **conserve** les données et les
vidéos ; une mise à jour les reprend telles quelles.

### Reprise des dossiers de l'ancien nom (GCMap)

L'application s'est appelée GCMap jusqu'à la version 1.0.0. Au premier
démarrage sous le nouveau nom, `%APPDATA%\GCMap` et `%LOCALAPPDATA%\GCMap`
sont renommés vers `MyGCFlow` s'ils existent et que le dossier du nouveau nom
n'existe pas encore (`settings_manager.adopt_legacy_dir()` et
`paths._adopt_legacy_data_dir()`). Un échec n'est pas bloquant : l'application
repart alors sur une configuration vierge, l'ancien dossier restant intact.

Ne sont **pas** repris : les vidéos déjà produites, qui restent dans
`Vidéos\GCMap` (déplacer des fichiers de l'utilisateur serait plus surprenant
qu'utile). Les variables `GCMAP_DATA_DIR`, `GCMAP_RUNTIME_DIR` et
`GCMAP_CONFIG_DIR` restent acceptées comme anciens noms.

## Construire

Prérequis : Python 3.12 (ou `uv`), et [Inno Setup 6](https://jrsoftware.org/isinfo.php)
pour l'installeur (`winget install JRSoftware.InnoSetup`).

```powershell
powershell -ExecutionPolicy Bypass -File installer\build.ps1
```

Le script crée l'environnement `.venv-build` (dépendances de
`requirements-build.txt` uniquement : rien de l'environnement de
développement n'est embarqué), lance PyInstaller (`installer/mygcflow.spec`),
copie les licences des paquets Python, puis compile `installer/mygcflow.iss`.

Résultats :

- `dist\MyGCFlow\MyGCFlow.exe` : version portable, à lancer directement ;
- `dist\MyGCFlow-Setup-<version>.exe` : installeur (~50 Mo).

`-SkipInstaller` s'arrête après l'exécutable.

Tester la version construite sans toucher à ses propres données :

```powershell
$env:MYGCFLOW_DATA_DIR = "$env:TEMP\mygcflow-test"; $env:MYGCFLOW_CONFIG_DIR = "$env:TEMP\mygcflow-test-config"
dist\MyGCFlow\MyGCFlow.exe
```

## Publier une version

1. Mettre à jour `__version__` dans `version.py` (source unique : application,
   propriétés de l'exécutable, installeur).
2. Committer, puis `git tag v<version>` et `git push origin v<version>`.
3. Le workflow `.github/workflows/release.yml` lance les tests unitaires,
   construit l'installeur et la version portable, vérifie que l'exécutable
   démarre, puis crée la Release GitHub avec les deux fichiers.
   La Release créée est **la** source de la vérification des mises à jour
   (`options.py` lit `api.github.com/repos/<owner>/<repo>/releases`) : rien
   d'autre à publier, et rien qui puisse diverger de ce qu'a construit la CI.
   Les notes de Release deviennent la liste des nouveautés affichée dans
   l'application ; `--generate-notes` les produit à partir des commits, il est
   donc utile de les relire dans l'onglet *Releases* avant de les laisser en
   l'état.

> **Le dépôt doit être public.** L'API Releases d'un dépôt privé répond 404 aux
> utilisateurs, et ses assets ne sont pas téléchargeables : ni la vérification
> ni le lien de téléchargement ne fonctionneraient.

Le workflow peut aussi être lancé à la main (onglet *Actions*) : il construit
sans publier, les fichiers sont dans les artefacts du run.

## Faire évoluer la base

`db.create_all()` ne modifie jamais une table existante. Toute évolution du
modèle (`models.py`) s'accompagne d'une migration dans `migrations.py` :

```python
def _v2_ajout_colonne_note(db):
    with db.engine.begin() as conn:
        conn.exec_driver_sql("ALTER TABLE geocache ADD COLUMN note TEXT")

MIGRATIONS = [
    (1, _v1_colonnes_et_index),
    (2, _v2_ajout_colonne_note),
]
```

La version du schéma est stockée dans la base (`PRAGMA user_version`). Au
démarrage, les migrations manquantes sont appliquées dans l'ordre, après une
copie de sauvegarde `geocaching.db.v<ancienne version>.bak`. Ne jamais modifier
une migration déjà publiée.

## Sécurité du serveur local

`security.py` refuse :

- les requêtes dont l'en-tête `Host` n'est pas `127.0.0.1` / `localhost`
  (protection contre le *DNS rebinding*) ;
- les requêtes modifiantes (POST…) venant d'une autre origine : n'importe
  quelle page web ouverte dans le navigateur pourrait sinon appeler
  `/clear_database`.

Aucune en-tête CORS n'est émise : le front est servi par le même serveur.

## Licences

Le ffmpeg embarqué (build gyan.dev, via imageio-ffmpeg) est sous **GPL v3**.
Sa licence et les liens vers ses sources sont livrés dans
`_internal\licenses\` avec l'inventaire des autres composants
(`installer/licenses/THIRD_PARTY_NOTICES.txt`, complété à la construction par
`installer/collect_licenses.py`).

## Icône

`installer/mygcflow.ico` et `static/img/mygcflow-icon.png` sont provisoires, générés
par `installer/make_icon.py`. Pour un vrai logo : remplacer ces deux fichiers.

## Reste à faire

- **Signature de code** : sans certificat, Windows SmartScreen affiche
  « Windows a protégé votre ordinateur » au premier lancement de l'installeur
  (*Informations complémentaires* → *Exécuter quand même*). Options :
  Azure Trusted Signing, ou un certificat OV/EV.
- **Dépôt public** : la vérification des mises à jour interroge les Releases
  GitHub, invisibles tant que le dépôt est privé (voir *Publier une version*).
- **Somme de contrôle** : la Release ne publie pas encore de SHA-256 des
  fichiers. Le lien de téléchargement est en HTTPS et restreint aux domaines
  GitHub (`ALLOWED_DOWNLOAD_HOSTS` dans `options.py`), mais rien ne permet à
  l'utilisateur de vérifier le binaire qu'il a récupéré.
- **Préversions** : une Release marquée *pre-release* est annoncée comme les
  autres. Pour ne pas pousser une RC à tout le monde, filtrer sur le champ
  `prerelease` que `_release_entry()` renvoie déjà.
