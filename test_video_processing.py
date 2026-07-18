import json
import os
import shutil
import subprocess
import tempfile
import unittest

from capture import _get_ffmpeg_exe, _process_recorded_video, _probe_duration_seconds


class VideoProcessingTests(unittest.TestCase):
    def test_slowdown_is_normalized_and_audio_is_kept(self):
        ffmpeg = _get_ffmpeg_exe()
        ffprobe = shutil.which("ffprobe")
        if not ffprobe:
            self.skipTest("ffprobe indisponible")

        with tempfile.TemporaryDirectory() as tmp:
            previous_cwd = os.getcwd()
            try:
                os.chdir(tmp)
                os.makedirs("audio", exist_ok=True)
                raw_video = os.path.join(tmp, "raw.mp4")
                audio_file = os.path.join(tmp, "audio", "tone.wav")
                output_video = os.path.join(tmp, "normalized.mp4")

                subprocess.run([
                    ffmpeg, "-y", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=24",
                    "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", raw_video,
                ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                subprocess.run([
                    ffmpeg, "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
                    "-t", "0.4", audio_file,
                ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

                result = _process_recorded_video(
                    raw_video,
                    output_video,
                    slowdown=2,
                    audio_path="tone.wav",
                    audio_volume=0.5,
                    fps=24,
                )

                self.assertTrue(result["success"], result)
                self.assertTrue(os.path.exists(output_video))
                duration = _probe_duration_seconds(output_video)
                self.assertIsNotNone(duration)
                self.assertAlmostEqual(duration, 1.0, delta=0.15)

                probe = subprocess.run([
                    ffprobe, "-v", "error", "-show_streams", "-of", "json", output_video,
                ], check=True, capture_output=True, text=True)
                stream_types = {stream["codec_type"] for stream in json.loads(probe.stdout)["streams"]}
                self.assertEqual(stream_types, {"video", "audio"})
            finally:
                os.chdir(previous_cwd)


if __name__ == "__main__":
    unittest.main()
