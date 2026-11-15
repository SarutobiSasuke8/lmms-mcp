import importlib.util
from pathlib import Path
import unittest

try:
    import numpy as np
except ImportError:
    np = None

spec = importlib.util.spec_from_file_location(
    "vst3_render", Path(__file__).resolve().parents[1] / "vst3-render.py"
)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


@unittest.skipIf(np is None, "NumPy is optional")
class PluginFramesTest(unittest.TestCase):
    def test_fits_one_frame_either_way(self):
        for frames in (7, 8, 9):
            with self.subTest(frames=frames):
                audio = np.full((2, frames), 0.25, dtype=np.float32)
                fitted = worker.fit_plugin_audio(audio, 8, "Lead")
                self.assertEqual(fitted.shape, (2, 8))
                self.assertEqual(fitted.dtype, np.float32)
                np.testing.assert_array_equal(fitted[:, :min(8, frames)], audio[:, :8])
                if frames < 8:
                    np.testing.assert_array_equal(fitted[:, -1], 0)

    def test_differentiates_invalid_and_silent_renders(self):
        for audio, message in (
            (np.ones((1, 8)), "invalid stereo shape"),
            (np.ones((2, 6)), "returned 6 frames; expected 8"),
            (np.full((2, 8), np.nan), "non-finite samples"),
            (np.zeros((2, 7)), "silent audio"),
        ):
            with self.subTest(message=message):
                with self.assertRaisesRegex(ValueError, f"Lead .*{message}"):
                    worker.fit_plugin_audio(audio, 8, "Lead")
