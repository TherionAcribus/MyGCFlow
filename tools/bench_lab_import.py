#!/usr/bin/env python3
"""Benchmark du parcours aperçu → commit Labs (lot 5.4).

L'aperçu applique chaque fichier dans UNE transaction puis rollback, et le
commit reparse puis ré-applique : coûteux, mais aperçu et commit partagent
exactement les mêmes règles. Ce script mesure chaque phase — parsing,
simulation SQL, écriture temporaire, commit — sur des lots synthétiques de
1 000 / 5 000 / 10 000 étapes, via les vrais endpoints (test client Flask).

Usage : python tools/bench_lab_import.py [tailles...]   (défaut 1000 5000 10000)

Les timers enveloppent les vraies fonctions appelées par les endpoints
(`_PARSE_BY_FORMAT`, `_APPLY_BY_FORMAT`, `_store_pending`,
`lab_store.commit_import_batch`) : la mesure reflète le code en production,
sans le modifier. Objectif de référence discuté : aperçu < 2 s pour 5 000
étapes. Une optimisation éventuelle (représentation normalisée temporaire)
devra laisser le commit recalculer les conflits sur l'état courant.
"""

import io
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import lab_coords_provider as lcp
import lab_store
from app import create_app
from extensions import db
from task_manager import task_manager

import blueprints.labs as labs_mod

STAGES_PER_ADVENTURE = 5


class PhaseTimer:
    """Enveloppe un appelable : cumule le temps passé dedans."""

    def __init__(self):
        self.elapsed = 0.0
        self.calls = 0

    def wrap(self, fn):
        def inner(*args, **kwargs):
            t0 = time.perf_counter()
            try:
                return fn(*args, **kwargs)
            finally:
                self.elapsed += time.perf_counter() - t0
                self.calls += 1
        return inner

    @property
    def ms(self):
        return self.elapsed * 1000


def _uuid(i: int) -> str:
    return f"{i & 0xffffffff:08x}-0000-4000-8000-{(i & 0xffffffffffff) + 1:012x}"


def make_history(n: int) -> bytes:
    """Export `mygcflow-lab-finds` v1 synthétique : N étapes regroupées par
    Adventures de 5 (comme les vraies)."""
    discoveries = []
    for i in range(n):
        adv = i // STAGES_PER_ADVENTURE
        discoveries.append({
            "adventure_id": _uuid(0x100000 + adv),
            "stage_id": _uuid(i),
            "adventure_title": f"Adventure bench {adv}",
            "stage_title": f"Étape {i}",
            "found_date": "2024-05-14",
            "found_at": "2024-05-14T09:12:33.451-07:00",
            "date_precision": "instant",
            "latitude": None, "longitude": None,
            "log_id": 900000 + i,
            "is_archived": False, "adventure_is_archived": False,
        })
    return json.dumps({
        "format": "mygcflow-lab-finds", "schema_version": 1,
        "exported_at": "2026-01-15T10:00:00Z", "account": {"username": None},
        "source": "labs.geocaching.com/logs", "coverage": "complete",
        "discoveries": discoveries,
    }, ensure_ascii=False).encode("utf-8")


def make_gpx(n: int) -> bytes:
    """GPX lab2gpx synthétique : N waypoints joints aux étapes de
    `make_history` (mêmes UUID) — l'enrichissement est exercé pour de vrai."""
    wpts = []
    for i in range(n):
        adv = i // STAGES_PER_ADVENTURE
        wpts.append(f'''    <wpt lat="{47.2 + (i % 100) * 0.0001:.5f}" lon="{-1.55 + (i % 100) * 0.0001:.5f}">
        <time>2020-03-10T08:00:00.000</time>
        <name>LCBNCH-{i}</name>
        <desc>Étape {i}</desc>
        <url>https://labs.geocaching.com/goto/{_uuid(0x100000 + adv)}</url>
        <urlname>S{(i % STAGES_PER_ADVENTURE) + 1} Adventure bench {adv}</urlname>
        <sym>Geocache Found</sym>
        <type>Geocache|Lab Cache</type>
        <gsak:wptExtension xmlns:gsak="http://www.gsak.net/xmlv1/6">
            <gsak:Guid>{_uuid(i)}</gsak:Guid>
        </gsak:wptExtension>
        <lab2gpx:adventureLab xmlns:lab2gpx="https://lab2gpx.gcutils.de/ns/lab2gpx/1">
            <lab2gpx:uuid>{_uuid(0x100000 + adv)}</lab2gpx:uuid>
            <lab2gpx:stagesTotal>{STAGES_PER_ADVENTURE}</lab2gpx:stagesTotal>
            <lab2gpx:stagesCompleted>{STAGES_PER_ADVENTURE}</lab2gpx:stagesCompleted>
        </lab2gpx:adventureLab>
    </wpt>''')
    return ('<?xml version="1.0" encoding="utf-8"?>\n'
            '<gpx version="1.0" creator="Lab2Gpx" '
            'xmlns="http://www.topografix.com/GPX/1/0">\n'
            '    <name>Adventure Labs</name>\n'
            + "\n".join(wpts) + '\n</gpx>').encode("utf-8")


def _wrap_phase(mapping, timer):
    """Remplace chaque fonction d'un mapping par sa version chronométrée ;
    renvoie un restaurateur."""
    original = dict(mapping)
    mapping.update({k: timer.wrap(v) for k, v in original.items()})
    return lambda: mapping.update(original)


def _wait_task(task_id, timeout=600):
    deadline = time.time() + timeout
    while time.time() < deadline:
        st = task_manager.get(task_id)
        if st is not None and st.state in ("finished", "failed"):
            return st
        time.sleep(0.05)
    raise RuntimeError(f"tâche {task_id} toujours en cours")


def bench_size(client, n: int) -> dict:
    raw_h, raw_g = make_history(n), make_gpx(n)

    # Timers sur les dicts réellement consultés par l'endpoint.
    parse_t = PhaseTimer()
    restore_parse = _wrap_phase(labs_mod._PARSE_BY_FORMAT, parse_t)
    apply_t = PhaseTimer()
    restore_apply = _wrap_phase(labs_mod._APPLY_BY_FORMAT, apply_t)
    store_t = PhaseTimer()
    real_store = labs_mod._store_pending
    labs_mod._store_pending = store_t.wrap(real_store)

    t0 = time.perf_counter()
    rv = client.post("/api/labs/import/preview",
                     data={"files": [(io.BytesIO(raw_h), "bench-history.json"),
                                     (io.BytesIO(raw_g), "bench-coords.gpx")]},
                     content_type="multipart/form-data")
    preview_s = time.perf_counter() - t0

    labs_mod._store_pending = real_store
    restore_apply()
    restore_parse()

    if rv.status_code != 200:
        raise RuntimeError(f"preview {rv.status_code}: {rv.get_json()}")
    token = rv.get_json()["import_token"]

    # Commit : parsing intra-tâche + commit_import_batch chronométrés.
    cparse_t, capply_t = PhaseTimer(), PhaseTimer()
    restore_cparse = _wrap_phase(labs_mod._PARSE_BY_FORMAT, cparse_t)
    real_commit_batch = lab_store.commit_import_batch
    lab_store.commit_import_batch = capply_t.wrap(real_commit_batch)

    t0 = time.perf_counter()
    rv2 = client.post("/api/labs/import/commit", json={"import_token": token})
    if rv2.status_code != 202:
        raise RuntimeError(f"commit {rv2.status_code}: {rv2.get_json()}")
    st = _wait_task(rv2.get_json()["task_id"])
    commit_s = time.perf_counter() - t0

    lab_store.commit_import_batch = real_commit_batch
    restore_cparse()
    if st.state != "finished":
        raise RuntimeError(f"tâche échouée: {st.error}")

    return {
        "n": n,
        "history_kb": len(raw_h) / 1024,
        "gpx_kb": len(raw_g) / 1024,
        "preview_s": preview_s,
        "pv_parse_ms": parse_t.ms,
        "pv_apply_ms": apply_t.ms,
        "pv_store_ms": store_t.ms,
        "pv_other_ms": max(0.0, preview_s * 1000
                           - parse_t.ms - apply_t.ms - store_t.ms),
        "commit_s": commit_s,
        "co_parse_ms": cparse_t.ms,
        "co_apply_ms": capply_t.ms,
        "co_other_ms": max(0.0, commit_s * 1000
                           - cparse_t.ms - capply_t.ms),
        "result": st.result,
    }


def main():
    sizes = [int(a) for a in sys.argv[1:]] or [1000, 5000, 10000]
    tmpdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
    db_path = Path(tmpdir.name) / "bench.db"
    app = create_app({"SQLALCHEMY_DATABASE_URI": f"sqlite:///{db_path}"})
    ctx = app.app_context()
    ctx.push()
    client = app.test_client()

    # Comme la suite de tests : pas de réseau ni de récupération automatique.
    quiet = SimpleNamespace(get_app_settings=lambda: SimpleNamespace(
        labs_auto_fetch_coords=False, labs_receive_token=""))
    patchers = [
        mock.patch.object(labs_mod, "get_settings_manager", lambda: quiet),
        mock.patch.object(lcp, "post_download",
                          mock.Mock(side_effect=AssertionError("réseau interdit"))),
    ]
    for p in patchers:
        p.start()

    print(f"{'étapes':>7} | {'JSON':>7} {'GPX':>7} | "
          f"{'aperçu':>8} {'(parse':>8} {'simul':>8} {'store':>7} {'autre)':>8} | "
          f"{'commit':>8} {'(parse':>8} {'apply':>8} {'autre)':>8}")
    print("-" * 110)
    try:
        for n in sizes:
            r = bench_size(client, n)
            print(f"{r['n']:>7} | {r['history_kb']:>6.0f}k {r['gpx_kb']:>6.0f}k | "
                  f"{r['preview_s']:>7.2f}s {r['pv_parse_ms']:>6.0f}m "
                  f"{r['pv_apply_ms']:>6.0f}m {r['pv_store_ms']:>5.0f}m "
                  f"{r['pv_other_ms']:>6.0f}m | "
                  f"{r['commit_s']:>7.2f}s {r['co_parse_ms']:>6.0f}m "
                  f"{r['co_apply_ms']:>6.0f}m {r['co_other_ms']:>6.0f}m")
    finally:
        for p in reversed(patchers):
            p.stop()
        db.session.remove()
        db.engine.dispose()
        ctx.pop()
        tmpdir.cleanup()


if __name__ == "__main__":
    main()
