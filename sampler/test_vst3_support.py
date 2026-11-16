"""Tests for the Linux and real-instrument helpers. Standard library only; no plugin is loaded.

Run: python -m unittest discover -s sampler
"""
import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ds_state
import vst3_support as support

NOTE_ON, NOTE_OFF = 0x90, 0x80


def state_with(groups_xml):
    inner_xml = f'<?xml version="1.0"?> <DecentSampler _presetName="x" _samplePath=""><ui/>{groups_xml}<tags/></DecentSampler>\x00'.encode()
    inner = ds_state.pack(inner_xml, b"TAIL")
    outer = ('<?xml version="1.0"?> <VST3PluginState><IComponent>' + ds_state.b64_encode(inner) + "</IComponent></VST3PluginState>\x00").encode()
    return ds_state.pack(outer, b"OUTERTAIL")


class FakePlugin:
    """Applies a newly set state only after `delay` reads, like Decent Sampler's background thread."""

    def __init__(self, delay):
        self.delay = delay
        self._state = state_with("<groups/>")
        self._pending = None
        self.reads_since_set = 0

    @property
    def raw_state(self):
        if self._pending is not None:
            self.reads_since_set += 1
            if self.reads_since_set > self.delay:
                self._state, self._pending = self._pending, None
        return self._state

    @raw_state.setter
    def raw_state(self, value):
        self._pending = value
        self.reads_since_set = 0


class WaitForState(unittest.TestCase):
    PRESET = '<DecentSampler><groups><group><sample path="/x/a.wav" rootNote="60"/></group></groups></DecentSampler>'

    def apply(self, plugin):
        plugin.raw_state = ds_state.make_state(plugin._state, self.PRESET, "C:/lib", "bass")

    def test_inner_xml_reads_the_preset(self):
        self.assertIn("<groups/>", ds_state.inner_xml(state_with("<groups/>")))

    def test_waits_until_samples_appear(self):
        plugin = FakePlugin(delay=5)
        self.apply(plugin)
        clock = {"now": 0.0}
        waited = ds_state.wait_for_state(plugin, timeout=10, interval=0.05, sleep=lambda s: clock.__setitem__("now", clock["now"] + s), clock=lambda: clock["now"])
        self.assertIsNotNone(waited)
        self.assertGreater(waited, 0)
        self.assertIn("<sample", ds_state.inner_xml(plugin.raw_state))

    def test_returns_none_when_the_state_never_applies(self):
        plugin = FakePlugin(delay=10 ** 9)
        self.apply(plugin)
        clock = {"now": 0.0}
        self.assertIsNone(ds_state.wait_for_state(plugin, timeout=1, interval=0.1, sleep=lambda s: clock.__setitem__("now", clock["now"] + s), clock=lambda: clock["now"]))

    def test_load_dspreset_waits_for_state_before_probing(self):
        plugin = FakePlugin(delay=3)
        order = []
        original = ds_state.wait_until_loaded
        ds_state.wait_until_loaded = lambda p, **kw: order.append("sample" if "<sample" in ds_state.inner_xml(p.raw_state) else "empty") or 0.1
        try:
            with tempfile.TemporaryDirectory() as folder:
                path = os.path.join(folder, "a.dspreset")
                with open(path, "w", encoding="utf-8") as handle:
                    handle.write(self.PRESET)
                ds_state.load_dspreset(plugin, path, "")
        finally:
            ds_state.wait_until_loaded = original
        self.assertEqual(order, ["sample"])  # the sound check only ran once the state held samples


class BundlePath(unittest.TestCase):
    def test_walks_up_from_the_binary_on_linux(self):
        inner = "/opt/ds/DecentSampler.vst3/Contents/x86_64-linux/DecentSampler.so"
        self.assertEqual(support.resolve_vst3_bundle(inner, "linux"), "/opt/ds/DecentSampler.vst3")
        self.assertEqual(support.resolve_vst3_bundle("/opt/Surge XT.vst3/Contents/x86_64-linux/Surge XT.so", "linux"), "/opt/Surge XT.vst3")

    def test_leaves_a_bundle_or_other_path_alone(self):
        self.assertEqual(support.resolve_vst3_bundle("/opt/ds/DecentSampler.vst3", "linux"), "/opt/ds/DecentSampler.vst3")
        self.assertEqual(support.resolve_vst3_bundle("/opt/ds/plain.so", "linux"), "/opt/ds/plain.so")

    def test_windows_keeps_the_inner_binary(self):
        inner = "C:/p/DecentSampler.vst3/Contents/x86_64-win/DecentSampler.vst3"
        self.assertEqual(support.resolve_vst3_bundle(inner, "win32"), inner)

    def test_a_windows_style_path_is_still_walked_elsewhere(self):
        self.assertEqual(support.resolve_vst3_bundle("C:\\p\\A.vst3\\Contents\\x\\A.so", "linux"), "C:\\p\\A.vst3")


class Timeout(unittest.TestCase):
    def test_default_and_override(self):
        self.assertEqual(support.initialization_timeout({}), 3.0)
        self.assertEqual(support.initialization_timeout({"LMMS_VST3_INIT_TIMEOUT": "7.5"}), 7.5)
        self.assertEqual(support.initialization_timeout({"LMMS_VST3_INIT_TIMEOUT": "-1"}), 3.0)
        self.assertEqual(support.initialization_timeout({"LMMS_VST3_INIT_TIMEOUT": "soon"}), 3.0)


def on(note, at=0.0):
    return bytes([NOTE_ON, note, 100]), at


def off(note, at=1.0):
    return bytes([NOTE_OFF, note, 0]), at


class NoteMap(unittest.TestCase):
    def test_map_note(self):
        self.assertEqual(support.map_note(69, {"69": 36}), 36)
        self.assertEqual(support.map_note(69, {69: 36}), 36)
        self.assertEqual(support.map_note(70, {"69": 36, "*": 38}), 38)
        self.assertEqual(support.map_note(70, {"69": 36}), 70)
        self.assertEqual(support.map_note(60, None, 12), 72)
        self.assertEqual(support.map_note(60, {"*": 36}, 12), 48)  # transpose comes after the map
        self.assertIsNone(support.map_note(120, None, 12))
        self.assertIsNone(support.map_note(3, None, -12))

    def test_drum_track_all_at_69_becomes_a_kick(self):
        events = [on(69), off(69), on(69, 2), off(69, 3)]
        out, used, dropped = support.remap_events(events, {"*": 36})
        self.assertEqual([e[0][1] for e in out], [36, 36, 36, 36])
        self.assertEqual(used, [36])
        self.assertEqual(dropped, 0)
        self.assertEqual([e[1] for e in out], [0.0, 1.0, 2, 3])  # times are untouched

    def test_other_messages_pass_through(self):
        cc = (bytes([0xB0, 64, 127]), 0.5)
        out, _, _ = support.remap_events([cc, on(69)], {"*": 36})
        self.assertEqual(out[0], cc)

    def test_note_on_with_velocity_zero_counts_as_off(self):
        events = [on(60), (bytes([NOTE_ON, 60, 0]), 1.0)]
        out, used, _ = support.remap_events(events, None, 2)
        self.assertEqual(out[1][0], bytes([NOTE_ON, 62, 0]))
        self.assertEqual(used, [62])

    def test_transpose_out_of_the_keyboard_drops_the_pair(self):
        events = [on(120), off(120), on(60, 2), off(60, 3)]
        out, used, dropped = support.remap_events(events, None, 12)
        self.assertEqual([e[0][1] for e in out], [72, 72])
        self.assertEqual(dropped, 1)
        self.assertEqual(used, [72])

    def test_no_rules_returns_the_events_untouched(self):
        events = [on(60), off(60)]
        out, used, dropped = support.remap_events(events)
        self.assertIs(out, events)
        self.assertEqual((used, dropped), ([60], 0))


class RangeWarnings(unittest.TestCase):
    def test_preset_note_range(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "a.dspreset")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write('<DecentSampler><groups><group><sample path="a.wav" rootNote="40" loNote="36" hiNote="47"/>'
                             '<sample path="b.wav" rootNote="60" loNote="48" hiNote="72"/></group></groups></DecentSampler>')
            self.assertEqual(support.preset_note_range(path), (36, 72))
            self.assertIsNone(support.preset_note_range(os.path.join(folder, "missing.dspreset")))

    def test_warns_when_notes_fall_outside(self):
        text = support.range_warning("bass", [30, 40, 50], (36, 72))
        self.assertIn("bass", text)
        self.assertIn("1 of 3", text)
        self.assertIsNone(support.range_warning("bass", [40, 50], (36, 72)))
        self.assertIsNone(support.range_warning("bass", [30], None))
        self.assertIn("dropped", support.range_warning("lead", [], None, dropped=2))


class Normalise(unittest.TestCase):
    def test_gain_to_reach_a_peak(self):
        self.assertAlmostEqual(support.normalise_gain_db(0.5, -6.0206), 0.0, places=3)
        self.assertAlmostEqual(support.normalise_gain_db(0.1, -6.0), 14.0, places=3)  # more than the old +12 dB cap
        self.assertEqual(support.normalise_gain_db(0.0, -6), 0.0)


class LogCleanup(unittest.TestCase):
    def test_removes_only_new_log_files(self):
        with tempfile.TemporaryDirectory() as folder:
            old = os.path.join(folder, "old.log")
            new = os.path.join(folder, "instance-1234.log")
            keep = os.path.join(folder, "settings.xml")
            for path in (old, new, keep):
                with open(path, "w") as handle:
                    handle.write("x")
            past = time.time() - 3600
            os.utime(old, (past, past))
            os.utime(keep, (past, past))
            os.makedirs(os.path.join(folder, "nested.log"))
            self.assertEqual(support.clean_decent_sampler_logs(folder, time.time() - 60), 1)
            self.assertTrue(os.path.exists(old))
            self.assertTrue(os.path.exists(keep))
            self.assertTrue(os.path.isdir(os.path.join(folder, "nested.log")))
            self.assertFalse(os.path.exists(new))

    def test_missing_directory_and_platform(self):
        self.assertEqual(support.clean_decent_sampler_logs("/definitely/not/here", 0), 0)
        self.assertIsNone(support.decent_sampler_log_directory("win32"))
        self.assertEqual(support.decent_sampler_log_directory("linux", "/home/x"), os.path.join("/home/x", ".config", "DecentSampler"))


if __name__ == "__main__":
    unittest.main()
