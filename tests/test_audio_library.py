import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import audio_library
from capture import _get_ffmpeg_exe


class AudioLibraryTests(unittest.TestCase):
    """Copies des musiques : inventaire, balayage, retrait, version lisible."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.folder = Path(tmp.name) / "audio"
        self.folder.mkdir()
        patcher = mock.patch.object(audio_library.paths, "audio_dir", return_value=self.folder)
        patcher.start()
        self.addCleanup(patcher.stop)

    def put(self, name, content=b"son", age_s=0):
        path = self.folder / name
        path.write_bytes(content)
        if age_s:
            past = time.time() - age_s
            os.utime(path, (past, past))
        return path

    def test_the_current_and_recent_tracks_are_referenced(self):
        recording = SimpleNamespace(
            audio_file="courante.mp3",
            audio_recent=[{"file": "courante.mp3"}, {"file": "ancienne.wav"}, {"name": "sans fichier"}],
        )
        self.assertEqual(audio_library.referenced_audio_files(recording), {"courante.mp3", "ancienne.wav"})
        self.assertEqual(audio_library.referenced_audio_files(SimpleNamespace(audio_file="", audio_recent=[])), set())

    def test_the_sweep_removes_only_forgotten_copies(self):
        old = 2 * audio_library.AUDIO_SWEEP_GRACE_S
        self.put("gardee.mp3", age_s=old)
        self.put("gardee.mp3" + audio_library.PLAYABLE_SUFFIX, age_s=old)
        self.put("oubliee.wma", age_s=old)
        self.put("oubliee.wma" + audio_library.PLAYABLE_SUFFIX, age_s=old)
        # Tout juste envoyée, pas encore dans les préférences : épargnée.
        self.put("nouvelle.mp3")
        # Envoi interrompu, ancien : balayé ; récent : peut-être en cours.
        self.put(".upload-abc.part", age_s=old)
        self.put(".upload-def.part")

        removed = audio_library.sweep_audio_dir({"gardee.mp3"})

        self.assertCountEqual(removed, [
            "oubliee.wma", "oubliee.wma" + audio_library.PLAYABLE_SUFFIX, ".upload-abc.part",
        ])
        self.assertCountEqual(os.listdir(self.folder), [
            "gardee.mp3", "gardee.mp3" + audio_library.PLAYABLE_SUFFIX, "nouvelle.mp3", ".upload-def.part",
        ])

    def test_the_listing_counts_a_playable_version_with_its_track(self):
        self.put("a.wma", b"x" * 100)
        self.put("a.wma" + audio_library.PLAYABLE_SUFFIX, b"x" * 50)
        self.put("b.mp3", b"x" * 10)
        self.put(".upload-zzz.part", b"x" * 1000)

        listing = audio_library.list_audio_files({"b.mp3"})

        self.assertEqual(listing["files"], [
            {"file": "a.wma", "size_bytes": 150, "referenced": False},
            {"file": "b.mp3", "size_bytes": 10, "referenced": True},
        ])
        self.assertEqual(listing["total_bytes"], 160)

    def test_deleting_a_track_removes_its_playable_version_and_nothing_else(self):
        self.put("a.wma")
        self.put("a.wma" + audio_library.PLAYABLE_SUFFIX)
        self.put("b.mp3")

        self.assertTrue(audio_library.delete_audio_file("a.wma"))
        self.assertFalse(audio_library.delete_audio_file("a.wma"))
        # Un chemin n'est jamais suivi hors du dossier.
        self.assertFalse(audio_library.delete_audio_file("../b.mp3/../../x"))
        self.assertEqual(os.listdir(self.folder), ["b.mp3"])

    def test_an_undecodable_format_gets_a_playable_version_once(self):
        source = self.folder / "morceau.wma"
        subprocess.run(
            [_get_ffmpeg_exe(), "-y", "-v", "error", "-f", "lavfi", "-t", "2",
             "-i", "sine=frequency=440:sample_rate=44100", "-c:a", "wmav2", str(source)],
            check=True,
        )

        name = audio_library.playable_audio("morceau.wma")

        self.assertEqual(name, "morceau.wma" + audio_library.PLAYABLE_SUFFIX)
        target = self.folder / name
        probe = subprocess.run(
            [_get_ffmpeg_exe(), "-v", "error", "-i", str(target), "-f", "null", "-"],
            capture_output=True, text=True,
        )
        self.assertEqual(probe.returncode, 0, probe.stderr)
        # Déjà convertie : réutilisée telle quelle.
        mtime = target.stat().st_mtime_ns
        self.assertEqual(audio_library.playable_audio("morceau.wma"), name)
        self.assertEqual(target.stat().st_mtime_ns, mtime)

    def test_an_unreadable_file_is_reported_and_leaves_nothing_behind(self):
        self.put("illisible.wma", b"pas de la musique")
        with self.assertRaises(audio_library.UnreadableAudio):
            audio_library.playable_audio("illisible.wma")
        self.assertEqual(os.listdir(self.folder), ["illisible.wma"])
        with self.assertRaises(FileNotFoundError):
            audio_library.playable_audio("absente.mp3")


class PlaylistMixTests(unittest.TestCase):
    """Enchaînement : morceaux assemblés en un fichier, équilibrés et raccordés."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.folder = Path(tmp.name) / "audio"
        self.folder.mkdir()
        patcher = mock.patch.object(audio_library.paths, "audio_dir", return_value=self.folder)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.ffmpeg = _get_ffmpeg_exe()

    def tone(self, name, seconds, volume=0.5, silence_after=0.0):
        """Sinus de `seconds` (−18 dBFS au volume 1), suivi d'un blanc éventuel."""
        audio_filter = f"volume={volume}"
        if silence_after:
            audio_filter += f",apad=pad_dur={silence_after}"
        subprocess.run(
            [self.ffmpeg, "-y", "-v", "error", "-f", "lavfi", "-t", str(seconds),
             "-i", "sine=frequency=440:sample_rate=44100", "-af", audio_filter, str(self.folder / name)],
            check=True,
        )
        return name

    def duration(self, name):
        return audio_library._probe_duration_seconds(str(self.folder / name))

    def mean_volume_db(self, name, start, length):
        proc = subprocess.run(
            [self.ffmpeg, "-v", "info", "-nostats", "-ss", str(start), "-t", str(length),
             "-i", str(self.folder / name), "-af", "volumedetect", "-f", "null", "-"],
            capture_output=True, text=True,
        )
        return float(audio_library._MEAN_VOLUME_RE.search(proc.stderr).group(1))

    def test_tracks_follow_each_other_without_the_silence_between_them(self):
        first = self.tone("a.wav", 3, silence_after=2)
        second = self.tone("b.wav", 4)

        result = audio_library.build_playlist_mix([first, second], 0)

        self.assertTrue(result["file"].startswith(audio_library.MIX_PREFIX))
        self.assertEqual([t["file"] for t in result["tracks"]], ["a.wav", "b.wav"])
        self.assertAlmostEqual(result["tracks"][0]["duration_seconds"], 5, delta=0.1)
        # 3 s de son + la traîne gardée + 4 s : le blanc de 2 s a disparu.
        self.assertAlmostEqual(self.duration(result["file"]), 3 + audio_library.SILENCE_TAIL_KEPT_S + 4, delta=0.15)
        # Pas de trou au raccord.
        self.assertGreater(self.mean_volume_db(result["file"], 3.0, 0.6), -30)

    def test_a_crossfade_overlaps_the_tracks(self):
        first = self.tone("a.wav", 3)
        second = self.tone("b.wav", 4)

        result = audio_library.build_playlist_mix([first, second], 1.0)

        self.assertAlmostEqual(self.duration(result["file"]), 3 + 4 - 1, delta=0.15)

    def test_a_crossfade_longer_than_the_tracks_allow_is_shortened(self):
        first = self.tone("a.wav", 2)
        second = self.tone("b.wav", 2)

        result = audio_library.build_playlist_mix([first, second], 10)

        # Borné à 40 % du plus court morceau : 0,8 s.
        self.assertAlmostEqual(self.duration(result["file"]), 4 - 0.8, delta=0.15)

    def test_a_quiet_track_is_brought_to_the_level_of_a_loud_one(self):
        quiet = self.tone("calme.wav", 3, volume=0.25)
        loud = self.tone("fort.wav", 3, volume=4.0)
        self.assertGreater(self.mean_volume_db(loud, 0.5, 1) - self.mean_volume_db(quiet, 0.5, 1), 20)

        result = audio_library.build_playlist_mix([quiet, loud], 0)

        first = self.mean_volume_db(result["file"], 0.5, 1)
        last = self.mean_volume_db(result["file"], 4.5, 1)
        self.assertLess(abs(first - last), 2)

    def test_the_same_playlist_is_not_assembled_twice(self):
        tracks = [self.tone("a.wav", 2), self.tone("b.wav", 2)]
        first = audio_library.build_playlist_mix(tracks, 0.5)
        built = (self.folder / first["file"]).stat().st_size

        with mock.patch.object(audio_library, "_run", side_effect=AssertionError("refait")):
            again = audio_library.build_playlist_mix(tracks, 0.5)

        self.assertEqual(again["file"], first["file"])
        self.assertEqual((self.folder / again["file"]).stat().st_size, built)
        # Un autre ordre, ou un autre fondu, est un autre enchaînement.
        self.assertNotEqual(audio_library.mix_name(list(reversed(tracks)), 0.5), first["file"])
        self.assertNotEqual(audio_library.mix_name(tracks, 1.0), first["file"])

    def test_a_missing_or_unreadable_track_is_reported(self):
        present = self.tone("a.wav", 2)
        with self.assertRaises(FileNotFoundError):
            audio_library.build_playlist_mix([present, "absent.mp3"], 0)
        (self.folder / "casse.wma").write_bytes(b"pas de la musique")
        with self.assertRaises(audio_library.MixError):
            audio_library.build_playlist_mix([present, "casse.wma"], 0)
        with self.assertRaises(ValueError):
            audio_library.build_playlist_mix([present], 0)

    def test_playlist_tracks_are_kept_by_the_sweep(self):
        recording = SimpleNamespace(
            audio_file="enchainement-x.flac",
            audio_playlist=[{"file": "a.wav"}, {"file": "b.wav"}],
            audio_recent=[{"file": "ancien.flac", "playlist": [{"file": "c.wav"}, {"file": "d.wav"}]}],
        )
        self.assertEqual(
            audio_library.referenced_audio_files(recording),
            {"enchainement-x.flac", "a.wav", "b.wav", "ancien.flac", "c.wav", "d.wav"},
        )
