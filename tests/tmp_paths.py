"""Dossier temporaire au chemin canonique, pour les tests qui comparent des chemins.

Sous Windows, %TEMP% peut être exprimé en nom court 8.3 — par exemple
``C:\\Users\\RUNNER~1\\AppData\\Local\\Temp`` sur les runners GitHub, dont
l'utilisateur s'appelle « runneradmin ». `tempfile` hérite alors de cette
forme courte, tandis que l'application résout ses chemins (`Path.resolve()`
dans paths.py) et renvoie la forme longue. Les deux désignent le même
dossier, mais la comparaison de chaînes échoue.

Invisible sur une machine dont le nom d'utilisateur tient déjà en 8.3 : d'où
six tests verts en local et rouges en intégration continue (v0.0.4).
"""

import tempfile
from pathlib import Path


def canonical_temporary_directory() -> tempfile.TemporaryDirectory:
    """TemporaryDirectory dont `.name` est le chemin sous sa forme longue."""
    tmpdir = tempfile.TemporaryDirectory()
    # Même dossier, écrit comme l'application l'écrira : le nettoyage reste
    # valable (il porte sur le même répertoire).
    tmpdir.name = str(Path(tmpdir.name).resolve())
    return tmpdir
