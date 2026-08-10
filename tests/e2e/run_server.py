"""Lance GCMap avec une base et des répertoires média isolés pour Playwright."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
RUNTIME = Path(os.environ["GCMAP_E2E_RUNTIME"]).resolve()
INSTANCE = RUNTIME / "instance"
INSTANCE.mkdir(parents=True, exist_ok=True)
(RUNTIME / ".gcmap-e2e-runtime").write_text("isolated test runtime\n", encoding="utf-8")

# capture.py utilise volontairement des chemins relatifs (video/, audio/,
# captured/). Le cwd temporaire isole donc aussi tous les exports navigateur.
os.chdir(RUNTIME)
os.environ["GCMAP_RUNTIME_DIR"] = str(RUNTIME)
# Préférences et profils dans le runtime jetable : sans cette redirection, un
# test qui change le thème, un réglage vidéo ou le profil par défaut écrirait
# dans %APPDATA%\GCMap, c'est-à-dire dans la configuration réelle.
CONFIG_DIR = RUNTIME / "config"
os.environ["GCMAP_CONFIG_DIR"] = str(CONFIG_DIR)

# Préférences de départ du runtime. `check_updates` est désactivé : la
# vérification de version interroge le réseau au démarrage et ouvre une modale
# de changelog par-dessus l'interface, qui intercepte les clics des tests.
CONFIG_DIR.mkdir(parents=True, exist_ok=True)
(CONFIG_DIR / "settings.json").write_text(
    json.dumps({"version": 2, "language": "fr", "check_updates": False}, ensure_ascii=False),
    encoding="utf-8",
)

database_path = (INSTANCE / "geocaching.db").as_posix()
os.environ["DATABASE_URI"] = f"sqlite:///{database_path}"

sys.path.insert(0, str(ROOT))

from app import app  # noqa: E402  (l'environnement doit précéder l'import)


if __name__ == "__main__":
    app.run(
        host="127.0.0.1",
        port=int(os.environ.get("GCMAP_E2E_PORT", "5011")),
        debug=False,
        threaded=True,
        use_reloader=False,
    )
