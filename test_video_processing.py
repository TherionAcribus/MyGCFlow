import json
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock
from pathlib import Path

from PIL import Image, ImageDraw

from capture import _assemble_pictures, _get_ffmpeg_exe, _process_recorded_video
from video_validator import _parse_rate, validate_video


ROOT = Path(__file__).resolve().parent
SCENARIOS_PATH = ROOT / "video_test_scenarios.json"


class _SilentStatus:
    def set_progress(self, _progress, _message):
        pass


class VideoProcessingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("ffprobe"):
            raise unittest.SkipTest("ffprobe indisponible")
        with SCENARIOS_PATH.open("r", encoding="utf-8") as handle:
            cls.scenarios = json.load(handle)["scenarios"]
        cls.ffmpeg = _get_ffmpeg_exe()

    def _run_quiet(self, command):
        subprocess.run(
            command,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def _create_audio(self, path, duration_seconds):
        self._run_quiet([
            self.ffmpeg,
            "-y",
            "-f", "lavfi",
            "-i", "sine=frequency=440:sample_rate=44100",
            "-t", str(duration_seconds),
            str(path),
        ])

    def _create_raw_video(self, path, duration_seconds, fps, width=160, height=90):
        frame_count = max(1, round(duration_seconds * fps))
        self._run_quiet([
            self.ffmpeg,
            "-y",
            "-f", "lavfi",
            "-i", f"color=c=blue:s={width}x{height}:r={fps}",
            "-frames:v", str(frame_count),
            "-c:v", "libvpx-vp9",
            "-b:v", "500k",
            str(path),
        ])

    def _create_image_sequence(self, folder, duration_seconds, fps, width=160, height=90):
        folder.mkdir(parents=True, exist_ok=True)
        frame_count = max(1, round(duration_seconds * fps))
        digits = len(str(frame_count))
        for index in range(frame_count):
            ratio = index / max(1, frame_count - 1)
            image = Image.new("RGB", (width, height), (round(255 * ratio), 40, round(255 * (1 - ratio))))
            draw = ImageDraw.Draw(image)
            draw.text((8, 8), f"frame {index + 1}/{frame_count}", fill=(255, 255, 255))
            image.save(folder / f"image_{index + 1:0{digits}d}.png")

    def _create_solid_image_sequence(self, folder, count, width=64, height=36):
        """Frames de couleur unie identifiables après encodage.

        Les couleurs sont espacées d'au moins 32 niveaux par canal : la
        classification par couleur la plus proche reste fiable malgré le bruit
        de quantification et le sous-échantillonnage 4:2:0.
        """
        folder.mkdir(parents=True, exist_ok=True)
        colors = [((index % 8) * 32, ((index // 8) % 8) * 32, 64) for index in range(count)]
        digits = len(str(count))
        for index, color in enumerate(colors):
            Image.new("RGB", (width, height), color).save(folder / f"image_{index + 1:0{digits}d}.png")
        return colors, width * height * 3

    def _decode_frame_color_ids(self, video_path, colors, frame_size):
        """Indice de la couleur source la plus proche pour chaque frame décodée."""
        raw = subprocess.run(
            [self.ffmpeg, '-v', 'error', '-i', str(video_path),
             '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
            check=True, capture_output=True,
        ).stdout
        sequence = []
        for offset in range(0, len(raw), frame_size):
            frame = raw[offset:offset + frame_size]
            pixels = len(frame) // 3
            mean = (
                sum(frame[0::3]) / pixels,
                sum(frame[1::3]) / pixels,
                sum(frame[2::3]) / pixels,
            )
            sequence.append(min(
                range(len(colors)),
                key=lambda i: sum((mean[c] - colors[i][c]) ** 2 for c in range(3)),
            ))
        return sequence

    def _run_scenario(self, scenario, tmp_path):
        fps = int(scenario["fps"])
        # Dimensions de la source : un scénario peut les rendre impaires pour
        # vérifier le rognage automatique (libx264 en yuv420p exige des dimensions
        # paires) ; par défaut on garde la taille standard de la matrice.
        source_width = int(scenario.get("source_width", 160))
        source_height = int(scenario.get("source_height", 90))
        audio_duration = scenario.get("audio_duration_seconds")
        audio_name = None
        if audio_duration is not None:
            audio_dir = tmp_path / "audio"
            audio_dir.mkdir(parents=True, exist_ok=True)
            audio_name = "tone.wav"
            self._create_audio(audio_dir / audio_name, audio_duration)

        output_video = tmp_path / f"{scenario['id']}.mp4"
        if scenario["pipeline"] == "images":
            images_dir = tmp_path / "captured"
            self._create_image_sequence(
                images_dir,
                scenario["source_duration_seconds"],
                fps,
                source_width,
                source_height,
            )
            result = _assemble_pictures(
                str(images_dir),
                str(output_video),
                fps=fps,
                audio_path=audio_name,
                audio_volume=scenario.get("audio_volume", 1.0),
                status=_SilentStatus(),
            )
        elif scenario["pipeline"] == "mediarecorder":
            # MediaRecorder fournit réellement un WebM au serveur.
            raw_video = tmp_path / "raw.webm"
            self._create_raw_video(
                raw_video,
                scenario["source_duration_seconds"],
                fps,
                source_width,
                source_height,
            )
            result = _process_recorded_video(
                str(raw_video),
                str(output_video),
                slowdown=scenario.get("slowdown", 1),
                audio_path=audio_name,
                audio_volume=scenario.get("audio_volume", 1.0),
                fps=fps,
            )
        else:
            self.fail(f"Pipeline inconnu : {scenario['pipeline']}")

        self.assertTrue(result["success"], result)
        validation = validate_video(str(output_video), scenario["expected"])
        self.assertTrue(
            validation.success,
            f"{scenario['id']}: " + "; ".join(validation.errors),
        )
        if scenario["id"] == "images_24_sans_audio":
            wrong_expectation = dict(scenario["expected"])
            wrong_expectation["duration_seconds"] = 10
            rejected = validate_video(str(output_video), wrong_expectation)
            self.assertFalse(rejected.success)
            self.assertTrue(any("durée" in error for error in rejected.errors))

    def test_video_option_matrix(self):
        for scenario in self.scenarios:
            with self.subTest(scenario=scenario["id"]), tempfile.TemporaryDirectory() as tmp:
                previous_cwd = os.getcwd()
                try:
                    os.chdir(tmp)
                    # Les pistes audio sont cherchées dans paths.audio_dir().
                    with mock.patch.dict(os.environ, {"MYGCFLOW_DATA_DIR": tmp}):
                        self._run_scenario(scenario, Path(tmp))
                finally:
                    os.chdir(previous_cwd)

    def test_assembly_keeps_each_image_once_and_in_order(self):
        """Une image source doit produire exactement une frame, dans l'ordre.

        Le démuxeur concat travaillait par défaut sur une base de 25 fps : sans
        cadence d'entrée explicite, une sortie à 30 ou 60 fps dupliquait une
        image et en omettait une autre, alors que le fps et la durée du fichier
        étaient corrects (reproduit en décodant les frames). Ce test couvre un
        fps inférieur, égal et supérieur à cette base historique.
        """
        for fps in (24, 25, 30, 60):
            with self.subTest(fps=fps), tempfile.TemporaryDirectory() as tmp:
                folder = Path(tmp) / "captured"
                colors, frame_size = self._create_solid_image_sequence(folder, fps)
                output = Path(tmp) / "sequence.mp4"

                result = _assemble_pictures(str(folder), str(output), fps=fps)

                self.assertTrue(result["success"], result)
                sequence = self._decode_frame_color_ids(output, colors, frame_size)
                self.assertEqual(sequence, list(range(fps)))

    def test_rate_parser(self):
        self.assertEqual(_parse_rate("30000/1001"), 30000 / 1001)
        self.assertEqual(_parse_rate("24/1"), 24)
        self.assertIsNone(_parse_rate("0/0"))


if __name__ == "__main__":
    unittest.main()
