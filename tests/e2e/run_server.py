"""Lance GCMap avec une base et des répertoires média isolés pour Playwright."""

from __future__ import annotations

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
