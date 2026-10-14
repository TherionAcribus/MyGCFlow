import json
import os
import re
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

    def _mean_volume_db(self, video_path, start, duration):
        """Niveau moyen (dB) de la piste audio sur une fenêtre de la vidéo."""
        log = subprocess.run(
            [self.ffmpeg, '-hide_banner', '-ss', str(start), '-t', str(duration), '-i', str(video_path),
             '-vn', '-af', 'volumedetect', '-f', 'null', '-'],
            check=True, capture_output=True, text=True, errors='replace',
        ).stderr
        match = re.search(r'mean_volume:\s*(-?[\d.]+) dB', log)
        self.assertIsNotNone(match, log)
        return float(match.group(1))

    def test_music_longer_than_the_video_can_fade_out(self):
        """Musique de 10 s sur une vidéo de 6 s : fondu sur les 3 dernières secondes.

        Sans l'option, la musique est coupée net (niveau constant jusqu'au
        bout) ; avec, la dernière demi-seconde est nettement plus faible que
        le début, dans les deux pipelines.
        """
        for pipeline in ("images", "mediarecorder"):
            for fade_out, quieter in ((0.0, False), (3.0, True)):
                with self.subTest(pipeline=pipeline, fade_out=fade_out), tempfile.TemporaryDirectory() as tmp:
                    tmp_path = Path(tmp)
                    (tmp_path / "audio").mkdir()
                    self._create_audio(tmp_path / "audio" / "tone.wav", 10)
                    output = tmp_path / "out.mp4"
                    with mock.patch.dict(os.environ, {"MYGCFLOW_DATA_DIR": tmp}):
                        if pipeline == "images":
                            self._create_image_sequence(tmp_path / "captured", 6, 10)
                            result = _assemble_pictures(
                                str(tmp_path / "captured"), str(output), fps=10,
                                audio_path="tone.wav", status=_SilentStatus(), audio_fade_out=fade_out,
                            )
                        else:
                            self._create_raw_video(tmp_path / "raw.webm", 6, 10)
                            result = _process_recorded_video(
                                str(tmp_path / "raw.webm"), str(output), fps=10,
                                audio_path="tone.wav", audio_fade_out=fade_out,
                            )
                    self.assertTrue(result["success"], result)
                    drop = self._mean_volume_db(output, 1, 1) - self._mean_volume_db(output, 5.5, 0.5)
                    if quieter:
                        self.assertGreater(drop, 12)
                    else:
                        self.assertLess(abs(drop), 3)

    def _process_with_music(self, tmp_path, pipeline, **audio_options):
        """Vidéo de 6 s avec la piste audio/tone.wav, par le pipeline demandé."""
        output = tmp_path / "out.mp4"
        with mock.patch.dict(os.environ, {"MYGCFLOW_DATA_DIR": str(tmp_path)}):
            if pipeline == "images":
                self._create_image_sequence(tmp_path / "captured", 6, 10)
                result = _assemble_pictures(
                    str(tmp_path / "captured"), str(output), fps=10,
                    audio_path="tone.wav", status=_SilentStatus(), **audio_options,
                )
            else:
                self._create_raw_video(tmp_path / "raw.webm", 6, 10)
                result = _process_recorded_video(
                    str(tmp_path / "raw.webm"), str(output), fps=10,
                    audio_path="tone.wav", **audio_options,
                )
        self.assertTrue(result["success"], result)
        validation = validate_video(str(output), {"duration_seconds": 6, "has_audio": True})
        self.assertTrue(validation.success, "; ".join(validation.errors))
        return output

    def test_music_shorter_than_the_video_can_loop(self):
        """Musique de 2 s sur une vidéo de 6 s : muette après 2 s, sauf en boucle."""
        for pipeline in ("images", "mediarecorder"):
            for loop in (False, True):
                with self.subTest(pipeline=pipeline, loop=loop), tempfile.TemporaryDirectory() as tmp:
                    tmp_path = Path(tmp)
                    (tmp_path / "audio").mkdir()
                    self._create_audio(tmp_path / "audio" / "tone.wav", 2)
                    output = self._process_with_music(tmp_path, pipeline, audio_loop=loop)
                    drop = self._mean_volume_db(output, 0.5, 1) - self._mean_volume_db(output, 4.5, 1)
                    if loop:
                        self.assertLess(abs(drop), 3)
                    else:
                        self.assertGreater(drop, 30)

    def test_the_loop_skips_an_ignored_trailing_silence(self):
        """Piste de 2 s de son + 2 s de blanc, bouclée à 2 s : plus aucun blanc.

        Sans point de bouclage, le blanc est rejoué à chaque tour (entre 2 et
        4 s) ; avec, la musique reprend dès la fin du son.
        """
        for pipeline in ("images", "mediarecorder"):
            for loop_end, silent_gap in ((0.0, True), (2.0, False)):
                with self.subTest(pipeline=pipeline, loop_end=loop_end), tempfile.TemporaryDirectory() as tmp:
                    tmp_path = Path(tmp)
                    (tmp_path / "audio").mkdir()
                    self._run_quiet([
                        self.ffmpeg, "-y", "-f", "lavfi", "-t", "2",
                        "-i", "sine=frequency=440:sample_rate=44100",
                        "-af", "apad=whole_dur=4", str(tmp_path / "audio" / "tone.wav"),
                    ])
                    output = self._process_with_music(
                        tmp_path, pipeline, audio_loop=True, audio_loop_end=loop_end,
                    )
                    drop = self._mean_volume_db(output, 0.5, 1) - self._mean_volume_db(output, 2.5, 1)
                    if silent_gap:
                        self.assertGreater(drop, 30)
                    else:
                        self.assertLess(abs(drop), 3)

    def test_a_skipped_intro_is_not_heard(self):
        """Piste de 3 s de blanc puis 6 s de son : la vidéo commence par le blanc,
        sauf si la musique démarre à 3 s — elle sonne alors dès le début, et la
        boucle reprend au point de départ, pas sur le blanc d'intro."""
        for pipeline in ("images", "mediarecorder"):
            for start, loop, silent_intro in ((0.0, False, True), (3.0, False, False), (3.0, True, False)):
                with self.subTest(pipeline=pipeline, start=start, loop=loop), \
                        tempfile.TemporaryDirectory() as tmp:
                    tmp_path = Path(tmp)
                    (tmp_path / "audio").mkdir()
                    # Bouclée, la musique ne garde que 2 s de son (fin à 5 s) :
                    # un tour reprenant au début du fichier rejouerait le blanc.
                    self._run_quiet([
                        self.ffmpeg, "-y", "-f", "lavfi", "-t", "6",
                        "-i", "sine=frequency=440:sample_rate=44100",
                        "-af", "adelay=3000:all=1", str(tmp_path / "audio" / "tone.wav"),
                    ])
                    options = {"audio_start": start}
                    if loop:
                        options.update(audio_loop=True, audio_loop_end=5.0)
                    output = self._process_with_music(tmp_path, pipeline, **options)
                    intro = self._mean_volume_db(output, 0.5, 1)
                    later = self._mean_volume_db(output, 4.5, 1)
                    if silent_intro:
                        self.assertGreater(later - intro, 30)
                    else:
                        self.assertLess(abs(later - intro), 3)

    def test_the_music_can_fade_in_once_even_when_looped(self):
        """Musique de 2 s bouclée sur 6 s, fondu d'entrée de 1,5 s : le début
        est plus faible que le premier tour plein, mais pas les reprises."""
        for pipeline in ("images", "mediarecorder"):
            for fade_in in (0.0, 1.5):
                with self.subTest(pipeline=pipeline, fade_in=fade_in), tempfile.TemporaryDirectory() as tmp:
                    tmp_path = Path(tmp)
                    (tmp_path / "audio").mkdir()
                    self._create_audio(tmp_path / "audio" / "tone.wav", 2)
                    output = self._process_with_music(tmp_path, pipeline, audio_loop=True, audio_fade_in=fade_in)
                    opening = self._mean_volume_db(output, 0, 0.5)
                    second_loop = self._mean_volume_db(output, 2.1, 0.5)
                    third_loop = self._mean_volume_db(output, 4.1, 0.5)
                    self.assertLess(abs(second_loop - third_loop), 3)
                    if fade_in:
                        self.assertGreater(second_loop - opening, 6)
                    else:
                        self.assertLess(abs(second_loop - opening), 3)

    def test_rate_parser(self):
        self.assertEqual(_parse_rate("30000/1001"), 30000 / 1001)
        self.assertEqual(_parse_rate("24/1"), 24)
        self.assertIsNone(_parse_rate("0/0"))


if __name__ == "__main__":
    unittest.main()
