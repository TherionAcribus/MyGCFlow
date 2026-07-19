"""Validation automatique des fichiers vidéo produits par GCMap.

Le module est utilisable depuis les tests et en ligne de commande :
    python video_validator.py video/fichier.mp4 --expect attente.json
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from typing import Any


class VideoProbeError(RuntimeError):
    """Le média n'a pas pu être analysé par ffprobe."""


def _parse_rate(value: str | None) -> float | None:
    if not value or value in {"0/0", "N/A"}:
        return None
    try:
        numerator, denominator = value.split("/", 1)
        denominator_value = float(denominator)
        return float(numerator) / denominator_value if denominator_value else None
    except (TypeError, ValueError):
        try:
            return float(value)
        except (TypeError, ValueError):
            return None


def _float_or_none(value: Any) -> float | None:
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def find_ffprobe() -> str:
    executable = shutil.which("ffprobe")
    if not executable:
        raise VideoProbeError(
            "ffprobe est introuvable. Installez ffmpeg/ffprobe et ajoutez-le au PATH."
        )
    return executable


def probe_video(path: str, ffprobe: str | None = None) -> dict[str, Any]:
    if not os.path.isfile(path):
        raise VideoProbeError(f"Fichier vidéo introuvable : {path}")

    command = [
        ffprobe or find_ffprobe(),
        "-v", "error",
        "-show_format",
        "-show_streams",
        "-of", "json",
        path,
    ]
    try:
        completed = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        raw = json.loads(completed.stdout)
    except (subprocess.CalledProcessError, json.JSONDecodeError) as exc:
        details = getattr(exc, "stderr", "") or str(exc)
        raise VideoProbeError(f"ffprobe n'a pas pu analyser {path}: {details}") from exc

    streams = raw.get("streams") or []
    video_streams = [stream for stream in streams if stream.get("codec_type") == "video"]
    audio_streams = [stream for stream in streams if stream.get("codec_type") == "audio"]
    primary_video = video_streams[0] if video_streams else {}
    media_format = raw.get("format") or {}

    duration = _float_or_none(media_format.get("duration"))
    if duration is None:
        duration = _float_or_none(primary_video.get("duration"))

    return {
        "path": os.path.abspath(path),
        "size_bytes": os.path.getsize(path),
        "duration_seconds": duration,
        "fps": _parse_rate(primary_video.get("avg_frame_rate") or primary_video.get("r_frame_rate")),
        "width": primary_video.get("width"),
        "height": primary_video.get("height"),
        "video_codec": primary_video.get("codec_name"),
        "audio_codec": audio_streams[0].get("codec_name") if audio_streams else None,
        "has_video": bool(video_streams),
        "has_audio": bool(audio_streams),
        "video_stream_count": len(video_streams),
        "audio_stream_count": len(audio_streams),
        "raw": raw,
    }


@dataclass
class ValidationResult:
    probe: dict[str, Any]
    errors: list[str]

    @property
    def success(self) -> bool:
        return not self.errors


def validate_video(path: str, expected: dict[str, Any]) -> ValidationResult:
    probe = probe_video(path)
    errors: list[str] = []

    if not probe["has_video"]:
        errors.append("aucune piste vidéo")

    expected_duration = _float_or_none(expected.get("duration_seconds"))
    actual_duration = probe.get("duration_seconds")
    duration_tolerance = _float_or_none(expected.get("duration_tolerance_seconds")) or 0.15
    if expected_duration is not None:
        if actual_duration is None:
            errors.append("durée non mesurable")
        elif abs(actual_duration - expected_duration) > duration_tolerance:
            errors.append(
                f"durée {actual_duration:.3f}s, attendue {expected_duration:.3f}s "
                f"(tolérance ±{duration_tolerance:.3f}s)"
            )

    expected_fps = _float_or_none(expected.get("fps"))
    actual_fps = probe.get("fps")
    fps_tolerance = _float_or_none(expected.get("fps_tolerance")) or 0.05
    if expected_fps is not None:
        if actual_fps is None:
            errors.append("FPS non mesurable")
        elif abs(actual_fps - expected_fps) > fps_tolerance:
            errors.append(
                f"FPS {actual_fps:.3f}, attendu {expected_fps:.3f} "
                f"(tolérance ±{fps_tolerance:.3f})"
            )

    for dimension in ("width", "height"):
        expected_value = expected.get(dimension)
        if expected_value is not None and probe.get(dimension) != int(expected_value):
            errors.append(f"{dimension}={probe.get(dimension)}, attendu {int(expected_value)}")

    if "has_audio" in expected and probe["has_audio"] != bool(expected["has_audio"]):
        errors.append(
            f"piste audio={'présente' if probe['has_audio'] else 'absente'}, "
            f"attendue={'présente' if expected['has_audio'] else 'absente'}"
        )

    expected_codec = expected.get("video_codec")
    if expected_codec and probe.get("video_codec") != expected_codec:
        errors.append(f"codec vidéo={probe.get('video_codec')}, attendu {expected_codec}")

    expected_audio_codec = expected.get("audio_codec")
    if expected_audio_codec and probe.get("audio_codec") != expected_audio_codec:
        errors.append(f"codec audio={probe.get('audio_codec')}, attendu {expected_audio_codec}")

    minimum_size = int(expected.get("min_size_bytes") or 1)
    if probe["size_bytes"] < minimum_size:
        errors.append(f"taille={probe['size_bytes']} octets, minimum attendu={minimum_size}")

    return ValidationResult(probe=probe, errors=errors)


def _format_summary(result: ValidationResult) -> str:
    probe = result.probe
    duration = probe.get("duration_seconds")
    fps = probe.get("fps")
    duration_text = f"{duration:.3f}s" if duration is not None else "?"
    fps_text = f"{fps:.3f}" if fps is not None else "?"
    return (
        f"{os.path.basename(probe['path'])}: durée={duration_text} fps={fps_text} "
        f"{probe.get('width')}x{probe.get('height')} "
        f"vidéo={probe.get('video_codec')} audio={probe.get('audio_codec') or 'non'}"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Valide un export vidéo GCMap avec ffprobe.")
    parser.add_argument("video", help="Fichier vidéo à analyser")
    parser.add_argument("--expect", required=True, help="Fichier JSON contenant les attentes")
    parser.add_argument("--json", action="store_true", help="Affiche le rapport au format JSON")
    args = parser.parse_args(argv)

    try:
        with open(args.expect, "r", encoding="utf-8") as handle:
            expected = json.load(handle)
        result = validate_video(args.video, expected)
    except (OSError, json.JSONDecodeError, VideoProbeError) as exc:
        print(f"ERREUR: {exc}", file=sys.stderr)
        return 2

    if args.json:
        report = {key: value for key, value in result.probe.items() if key != "raw"}
        report.update({"success": result.success, "errors": result.errors})
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(_format_summary(result))
        for error in result.errors:
            print(f"  - {error}")
        print("OK" if result.success else "ÉCHEC")
    return 0 if result.success else 1


if __name__ == "__main__":
    raise SystemExit(main())
