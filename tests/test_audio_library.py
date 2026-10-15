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
