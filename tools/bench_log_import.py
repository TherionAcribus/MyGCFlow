#!/usr/bin/env python3
"""Benchmark de l'import de logs (contrat mygcflow-logs v1, lot A).

Génère un fichier synthétique de N logs (un compte, ~50 logs par cache, des
DNF à soi et des trouvailles d'autres joueurs, une couverture complète par
cache) et mesure, sur une base SQLite temporaire, les phases réelles :
parsing, aperçu (`log_store.preview_logs`), premier commit, réimport à
l'identique, puis réimport d'un export plus récent où 1 % des logs ont
changé et 1 % ont disparu (suppressions sous couverture).

Usage : python tools/bench_log_import.py [tailles...]   (défaut 10000 100000)
"""

import json
import os
import random
import shutil
import sys
import tempfile
import time
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("MYGCFLOW_CONFIG_DIR", tempfile.mkdtemp(prefix="mygcflow-bench-config-"))

import log_formats as lf  # noqa: E402
import log_store  # noqa: E402
from app import create_app  # noqa: E402
from extensions import db  # noqa: E402

ME = 1234567
LOGS_PER_CACHE = 50


def synthetic(n_logs, exported_at="2026-10-24T09:00:00Z", seed=1):
    rng = random.Random(seed)
    n_caches = max(1, n_logs // LOGS_PER_CACHE)
    codes = [lf.id_to_code(5_000_000 + i, "GC") for i in range(n_caches)]
    start = date(2012, 1, 1)
    caches = [{
        "gc_code": code, "name": f"Cache {i}", "type": "Traditional Cache",
        "latitude": 48 + rng.random(), "longitude": 2 + rng.random(),
        "difficulty": 2.0, "terrain": 1.5, "container": "Small",
        "owner": {"id": ME, "name": "Moi"}, "placed_date": "2011-06-01",
        "status": "active", "favorite_points": rng.randrange(50),
    } for i, code in enumerate(codes)]
    logs = []
    for i in range(n_logs):
        mine = i % 25 == 0
        logs.append({
            "log_id": 100_000_000 + i, "gc_code": codes[i % n_caches],
            "type_id": 3 if mine else 2,
            "date": (start + timedelta(days=rng.randrange(5000))).isoformat(),
            "author": {"id": ME if mine else 2_000_000 + rng.randrange(20_000),
                       "name": "Moi" if mine else "Joueur"},
            "favorite": (not mine) and rng.random() < 0.2,
        })
    return {
        "format": "mygcflow-logs", "schema_version": 1, "exported_at": exported_at,
        "account": {"user_id": ME, "username": "Moi"},
        "coverage": [{"kind": "caches", "gc_codes": codes, "complete": True}],
        "caches": caches, "logs": logs,
    }


def timed(fn):
    t = time.perf_counter()
    result = fn()
    return result, time.perf_counter() - t


def run(n_logs):
    tmp = tempfile.mkdtemp(prefix="mygcflow-bench-")
    app = create_app({"SQLALCHEMY_DATABASE_URI": f"sqlite:///{os.path.join(tmp, 'g.db')}"})
    doc = synthetic(n_logs)
    data = json.dumps(doc).encode("utf-8")
    row = {"logs": n_logs, "Mo": len(data) / 1e6}
    with app.app_context():
        parsed, row["parse"] = timed(lambda: lf.parse_logs_file(data))
        _, row["aperçu"] = timed(lambda: log_store.preview_logs(db.session, parsed))
        _, row["commit"] = timed(lambda: log_store.commit_logs(db.session, parsed))
        again = lf.parse_logs_file(data)
        _, row["réimport"] = timed(lambda: log_store.commit_logs(db.session, again))

        later = synthetic(n_logs, exported_at="2026-10-25T09:00:00Z")
        later["logs"] = [rec for i, rec in enumerate(later["logs"]) if i % 100 != 1]
        for rec in later["logs"][::100]:
            rec["favorite"] = not rec["favorite"]
        delta = lf.parse_logs_file(json.dumps(later).encode("utf-8"))
        summary, row["incrément"] = timed(lambda: log_store.commit_logs(db.session, delta))
        row["maj/retraits"] = f"{summary['updated']}/{summary['removed']}"
        db.session.remove()
        db.engine.dispose()
    shutil.rmtree(tmp, ignore_errors=True)
    return row


def main():
    sizes = [int(a) for a in sys.argv[1:]] or [10_000, 100_000]
    columns = ("logs", "Mo", "parse", "aperçu", "commit", "réimport", "incrément", "maj/retraits")
    print(" | ".join(columns))
    for n in sizes:
        row = run(n)
        print(" | ".join(f"{row[c]:.2f}" if isinstance(row[c], float) else str(row[c])
                         for c in columns))


if __name__ == "__main__":
    main()
