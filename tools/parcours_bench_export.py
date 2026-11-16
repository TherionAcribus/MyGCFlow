#!/usr/bin/env python3
"""Export des journées réelles pour le banc de la reconstruction des parcours.

Produit un JSON {days: [{date, stops}]} au format de /api/parcours/<id>/inputs
(parcours_dataset.build_days), pour toutes les journées qui ont au moins deux
étapes, que tools/parcours_bench.mjs rejoue avec la reconstruction
(static/js/parcours_reconstruct.mjs).

La base est COPIÉE dans un dossier temporaire avant ouverture : la
migration de schéma et la fusion des logs ne touchent jamais la vraie base.
`--myfinds` fusionne dans la copie les logs (avec leur identifiant) d'un GPX
« My Finds » : ce sont eux qui donnent l'ordre de saisie des trouvailles,
souvent absent de la base (la carte « Mes logs » ne collecte que DNF et
caches posées).

Usage :
    python tools/parcours_bench_export.py --out jours.json \\
        [--db instance/geocaching.db] [--myfinds chemin/vers/MyFinds.gpx]

Le JSON contient des positions et des noms de caches : à garder hors du
dépôt (dossier temporaire).
"""

import argparse
import json
import os
import shutil
import sys
import tempfile
import xml.etree.ElementTree as ET
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
# Préférences et thèmes : jamais ceux de l'utilisateur.
os.environ.setdefault("MYGCFLOW_CONFIG_DIR", tempfile.mkdtemp(prefix="mygcflow-bench-config-"))

import log_formats  # noqa: E402
import log_store  # noqa: E402
import parcours_dataset  # noqa: E402
from app import create_app  # noqa: E402
from extensions import db  # noqa: E402
from models import Geocache, LabDiscovery  # noqa: E402
from sqlalchemy import func  # noqa: E402


def merge_myfinds(path: Path) -> dict:
    logs, rejected = [], []
    for _, element in ET.iterparse(path, events=("end",)):
        if element.tag.rsplit("}", 1)[-1] != "wpt":
            continue
        code = next((child.text for child in element if child.tag.rsplit("}", 1)[-1] == "name"), None)
        cache = next((child for child in element if child.tag.rsplit("}", 1)[-1] == "cache"), None)
        if cache is not None and code:
            found, refused = log_formats.logs_from_cache_element(cache, code)
            logs.extend(found)
            rejected.extend(refused)
        element.clear()
    return log_store.merge_myfinds_logs(db.session, log_formats.myfinds_parse_result(logs, rejected))


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--db", default=str(ROOT / "instance" / "geocaching.db"))
    parser.add_argument("--myfinds", default=None)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    workdir = Path(tempfile.mkdtemp(prefix="mygcflow-bench-db-"))
    copy = workdir / "geocaching.db"
    shutil.copy2(args.db, copy)
    app = create_app({"SQLALCHEMY_DATABASE_URI": f"sqlite:///{copy.as_posix()}"})
    with app.app_context():
        if args.myfinds:
            print("Fusion des logs du My Finds :", merge_myfinds(Path(args.myfinds)))
        first, last = db.session.query(func.min(Geocache.date_find), func.max(Geocache.date_find)).filter(
            Geocache.found.is_(True)).one()
        lab_first, lab_last = db.session.query(
            func.min(LabDiscovery.found_date), func.max(LabDiscovery.found_date)).one()
        bounds = [d.date() if hasattr(d, "date") else d for d in (first, last, lab_first, lab_last) if d]
        start, end = min(bounds), max(bounds)
        payload = parcours_dataset.build_days(db.session, start, end, keep_empty=False)
        payload["days"] = [day for day in payload["days"] if len(day["stops"]) >= 2]
        payload["exportedAt"] = date.today().isoformat()
        Path(args.out).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        print(f"{len(payload['days'])} journées (>= 2 étapes) du {start} au {end} -> {args.out}")
        print("Comptes :", payload["counts"], "— logs :", payload["logsAvailable"])
        db.session.remove()
        db.engine.dispose()
    shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()
