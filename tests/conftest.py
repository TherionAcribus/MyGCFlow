"""Isole la configuration (préférences + thèmes) de toute la suite pytest.

`blueprints.profiles` crée le SettingsManager partagé dès son import, sur le
dossier de configuration résolu à l'import de `settings_manager` : sans cette
redirection, lancer les tests exécute la migration des thèmes d'exemple dans
le vrai %APPDATA%\\MyGCFlow. Un lot déclaré avant que ses thèmes ne soient
définis y a ainsi été marqué « installé » sans rien installer.

Posée ici, avant tout import de test : CONFIG_DIR est figé à l'import.
"""
import atexit
import os
import shutil
import tempfile

_config_dir = tempfile.mkdtemp(prefix="mygcflow-pytest-config-")
os.environ["MYGCFLOW_CONFIG_DIR"] = _config_dir
os.environ.pop("GCMAP_CONFIG_DIR", None)
atexit.register(shutil.rmtree, _config_dir, True)
