"""Lance toute la suite automatisée consacrée à la génération vidéo GCMap."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def _run_stage(title: str, command: list[str]) -> bool:
    print(f"\n=== {title} ===", flush=True)
    completed = subprocess.run(
        command,
        cwd=ROOT,
        env={**os.environ, "PYTHONUTF8": "1", "PYTHONUNBUFFERED": "1"},
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if completed.stdout:
        print(completed.stdout.rstrip(), flush=True)
    if completed.returncode == 0:
        print(f"[OK] {title}", flush=True)
        return True
    print(f"[ÉCHEC] {title} (code {completed.returncode})", flush=True)
    return False


def _preflight() -> list[str]:
    errors = []
    if not shutil.which("node"):
        errors.append("Node.js est introuvable dans le PATH")
    if not shutil.which("ffprobe"):
        errors.append("ffprobe est introuvable dans le PATH")
    try:
        import moviepy  # noqa: F401
        import PIL  # noqa: F401
    except ImportError as exc:
        errors.append(f"dépendance Python manquante : {exc.name}")
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Exécute les tests vidéo automatisés de GCMap.")
    parser.add_argument(
        "--quick",
        action="store_true",
        help="Teste seulement les calculs et le validateur, sans produire les six vidéos.",
    )
    parser.add_argument(
        "--e2e",
        action="store_true",
        help="Ajoute les tests Playwright (import, filtres, options UI et export navigateur).",
    )
    args = parser.parse_args(argv)

    preflight_errors = _preflight()
    if preflight_errors:
        for error in preflight_errors:
            print(f"ERREUR: {error}", file=sys.stderr)
        return 2

    started = time.perf_counter()
    stages = [
        (
            "Calculs de timing JavaScript",
            ["node", "--test", "test_video_timing.mjs"],
        ),
    ]
    if args.quick:
        stages.append((
            "Lecture des métadonnées ffprobe",
            [sys.executable, "-m", "unittest", "-v", "test_video_processing.VideoProcessingTests.test_rate_parser"],
        ))
    else:
        stages.append((
            "Matrice d'encodage et validation ffprobe",
            [
                sys.executable,
                "-W", "error::ResourceWarning",
                "-m", "unittest", "-v", "test_video_processing.py",
            ],
        ))
    if args.e2e:
        npm = shutil.which("npm")
        if not npm:
            print("ERREUR: npm est introuvable dans le PATH", file=sys.stderr)
            return 2
        if not (ROOT / "node_modules" / "@playwright" / "test").exists():
            print(
                "ERREUR: Playwright n'est pas installé. Lancez d'abord `npm install` "
                "puis `npx playwright install chromium`.",
                file=sys.stderr,
            )
            return 2
        os.environ["GCMAP_E2E_PYTHON"] = sys.executable
        stages.append((
            "Parcours navigateur et export réel",
            [npm, "run", "test:e2e"],
        ))

    results = [_run_stage(title, command) for title, command in stages]
    duration = time.perf_counter() - started
    passed = sum(results)
    print(f"\nRésultat : {passed}/{len(results)} étapes réussies en {duration:.2f}s")
    return 0 if all(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
