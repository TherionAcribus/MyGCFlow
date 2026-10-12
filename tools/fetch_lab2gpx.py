#!/usr/bin/env python3
"""Récupère les coordonnées des étapes Adventure Lab via l'API lab2gpx.

L'API publique `POST https://api.lab2gpx.gcutils.de/download` accepte un mode
« liste d'UUID » (`uuidsToFetch`) que l'interface carte n'expose pas — cf.
api/src/request/download-by-uuid.http dans https://github.com/mirsch/lab2gpx.

Entrée : fichier texte d'UUID d'Adventures séparés par virgules ou retours
ligne (produit par tools/export_lab_logs.js). Sortie : un GPX par lot dans le
dossier cible. Les UUID qui font échouer le serveur (500 — typiquement des
Adventures archivées/cassées) sont isolés par bissection et listés dans
fetch-failed-uuids.txt. Relançable : les lots déjà écrits sont sautés.

Aucun compte requis ; --user-guid (GUID *public* du joueur) ne sert qu'à
obtenir les marqueurs « found » personnalisés.
"""

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API_URL = "https://api.lab2gpx.gcutils.de/download"


def build_payload(uuids, user_guid):
    return {
        "locale": "en",
        # requis par la validation mais ignorés en mode uuidsToFetch
        "coordinates": {"lat": 0, "lon": 0},
        "radius": 1,
        "limit": 0,
        "cacheType": "Lab Cache",
        "prefix": "LC",
        "linear": "default",
        "userGuid": user_guid,
        "completionStatuses": ["0", "1", "2"],
        # descriptions inutiles pour la jointure — allège beaucoup le GPX
        "includeQuestion": False,
        "includeWaypointDescription": False,
        "includeCacheDescription": False,
        "outputFormat": "gpx",
        "uuidsToFetch": ",".join(uuids),
    }


def post_download(payload, retries=4, delay=5):
    body = json.dumps(payload).encode("utf-8")
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(
                API_URL, data=body,
                headers={"Content-Type": "application/json", "Accept": "*/*"},
            )
            with urllib.request.urlopen(req, timeout=300) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read()[:300].decode("utf-8", "replace")
            print(f"    tentative {attempt}/{retries} : HTTP {exc.code} {detail}",
                  file=sys.stderr, flush=True)
            if attempt == retries:
                raise
            time.sleep(delay * attempt)
        except (urllib.error.URLError, TimeoutError) as exc:
            print(f"    tentative {attempt}/{retries} : {exc}",
                  file=sys.stderr, flush=True)
            if attempt == retries:
                raise
            time.sleep(delay * attempt)


def gpx_stats(data):
    return {
        "wpt": len(re.findall(rb"<wpt ", data)),
        "adv": len(set(re.findall(rb"lab2gpx:uuid>([0-9a-f-]+)", data))),
        "found": len(re.findall(rb"<sym>Geocache Found</sym>", data)),
    }


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("uuids_file", type=Path, help="fichier d'UUID (virgules ou lignes)")
    p.add_argument("--user-guid", default=None, help="GUID public du joueur (marqueurs found)")
    p.add_argument("--out-dir", type=Path, required=True)
    p.add_argument("--batch-size", type=int, default=50)
    p.add_argument("--delay", type=float, default=2.0, help="pause entre lots (s)")
    p.add_argument("--prefix", default="lab2gpx-uuid", help="préfixe des fichiers GPX")
    args = p.parse_args()

    raw = args.uuids_file.read_text(encoding="utf-8")
    uuids = [u.strip() for u in raw.replace("\n", ",").replace(";", ",").split(",") if u.strip()]
    print(f"{len(uuids)} UUID d'Adventures, lots de {args.batch_size}", flush=True)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    failed = []
    totals = {"wpt": 0, "adv": 0, "found": 0}

    def fetch_batch(batch, tag):
        out = args.out_dir / f"{args.prefix}-{tag}.gpx"
        if out.exists() and out.stat().st_size > 0:
            s = gpx_stats(out.read_bytes())
            for k in totals:
                totals[k] += s[k]
            print(f"lot {tag} : déjà présent ({s['adv']} Adventures, {s['wpt']} wpt)", flush=True)
            return
        try:
            data = post_download(build_payload(batch, args.user_guid))
        except Exception:
            if len(batch) == 1:
                failed.append(batch[0])
                print(f"lot {tag} : UUID en échec définitif -> {batch[0]}", flush=True)
                return
            # bissection pour isoler le ou les UUID problématiques
            print(f"lot {tag} : échec, bissection ({len(batch)} UUID)", flush=True)
            mid = len(batch) // 2
            fetch_batch(batch[:mid], f"{tag}a")
            fetch_batch(batch[mid:], f"{tag}b")
            return
        out.write_bytes(data)
        s = gpx_stats(data)
        for k in totals:
            totals[k] += s[k]
        print(f"lot {tag} : {len(batch)} UUID -> {s['adv']} Adventures, "
              f"{s['wpt']} wpt, {s['found']} found -> {out.name}", flush=True)
        time.sleep(args.delay)

    for i in range(0, len(uuids), args.batch_size):
        fetch_batch(uuids[i:i + args.batch_size], f"{i // args.batch_size + 1:03d}")

    failed_file = args.out_dir / "fetch-failed-uuids.txt"
    failed_file.write_text("\n".join(failed) + ("\n" if failed else ""), encoding="utf-8")
    print(f"TOTAL : {totals['adv']} Adventures, {totals['wpt']} étapes, "
          f"{totals['found']} trouvées, {len(failed)} UUID en échec", flush=True)


if __name__ == "__main__":
    main()
