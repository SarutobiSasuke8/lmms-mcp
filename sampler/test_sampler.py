"""Unit tests for the SFZ converter and the Decent Sampler state helpers. Standard library only.

Run: python -m unittest discover -s sampler
"""
import os
import re
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ds_state
import sfz2dspreset as conv


def write(path, text=""):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)


class KeyNames(unittest.TestCase):
    def test_numbers_and_names(self):
        self.assertEqual(conv.key("60"), 60)
        self.assertEqual(conv.key("c4"), 60)
        self.assertEqual(conv.key("a#3"), 58)
        self.assertEqual(conv.key("Bb3"), 58)
        self.assertEqual(conv.key("c-1"), 0)


class Library(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        for name in ("a.wav", "b.wav", "rel.wav"):
            write(os.path.join(self.dir, "Samples", name))
        write(os.path.join(self.dir, "Data", "ext.txt"), "#define $EXT wav\n")
        write(os.path.join(self.dir, "inst.sfz"), """
// comment
#define $DIR Samples
#include "Data/ext.txt"
<control>
default_path=$DIR/
set_cc64=0
<global>
ampeg_release=0.4
<group>
lovel=1 hivel=63
<region> sample=a.$EXT key=c4
<group>
lovel=64 hivel=127
<region> sample=b.$EXT lokey=c4 hikey=e4 pitch_keycenter=62 tune=-50 volume=-3
<region> sample=rel.$EXT key=c4 trigger=release
<region> sample=a.$EXT key=d4 locc64=64
<region> sample=a.$EXT key=e4 sw_last=c1
<region> sample=missing.$EXT key=f4
""")

    def tearDown(self):
        self.tmp.cleanup()

    def test_convert(self):
        body, count, skipped, missing = conv.convert(os.path.join(self.dir, "inst.sfz"), self.dir, False, False, "")
        self.assertEqual(count, 2)
        self.assertEqual(skipped, 3)  # release trigger, cc gate, keyswitch
        self.assertEqual(missing, ["Samples/missing.wav"])
        self.assertIn('path="Samples/a.wav"', body)
        self.assertIn('rootNote="60" loNote="60" hiNote="60" loVel="1" hiVel="63"', body)
        self.assertIn('rootNote="62" loNote="60" hiNote="64" loVel="64" hiVel="127"', body)
        self.assertIn('tuning="-0.5"', body)
        self.assertIn('volume="-3.0dB"', body)
        self.assertIn('release="0.4"', body)

    def test_absolute_paths(self):
        body, *_ = conv.convert(os.path.join(self.dir, "inst.sfz"), self.dir, True, False, "")
        self.assertIsNotNone(re.search(r'path="[^"]*/Samples/a\.wav"', body))
        self.assertTrue(os.path.isabs(re.search(r'path="([^"]+)"', body).group(1)))

    def test_round_robin(self):
        write(os.path.join(self.dir, "rr.sfz"), """
<control> default_path=Samples/
<region> sample=a.wav key=c4 seq_length=2 seq_position=1
<region> sample=b.wav key=c4 seq_length=2 seq_position=2
""")
        body, count, *_ = conv.convert(os.path.join(self.dir, "rr.sfz"), self.dir, False, False, "")
        self.assertEqual(count, 2)
        self.assertEqual(body.count('seqMode="round_robin" seqLength="2"'), 2)

    def test_within_blocks_escapes(self):
        outside = tempfile.mkdtemp()
        try:
            write(os.path.join(outside, "secret.wav"))
            write(os.path.join(self.dir, "evil.sfz"), f'<region> sample={outside.replace(os.sep, "/")}/secret.wav key=c4\n')
            conv.WITHIN = self.dir
            _, count, skipped, _ = conv.convert(os.path.join(self.dir, "evil.sfz"), self.dir, False, False, "")
            self.assertEqual((count, skipped), (0, 1))
            write(os.path.join(self.dir, "inc.sfz"), f'#include "{outside.replace(os.sep, "/")}/x.sfz"\n')
            write(os.path.join(outside, "x.sfz"), "<region> sample=a.wav key=c4\n")
            with self.assertRaises(ValueError):
                conv.parse(os.path.join(self.dir, "inc.sfz"))
        finally:
            conv.WITHIN = None


class PluginState(unittest.TestCase):
    def test_base64_round_trip(self):
        for data in (b"", b"a", b"VC2!\x01\x00\x00\x00x", bytes(range(256))):
            self.assertEqual(ds_state.b64_decode(ds_state.b64_encode(data)), data)

    def test_make_state_swaps_groups(self):
        inner_xml = b'<?xml version="1.0"?> <DecentSampler _presetName="x" _samplePath="" _userVolume="1.0"><ui/><groups/><tags/></DecentSampler>\x00'
        inner = ds_state.pack(inner_xml, b"TAIL")
        outer_xml = ('<?xml version="1.0"?> <VST3PluginState><IComponent>' + ds_state.b64_encode(inner) + "</IComponent></VST3PluginState>\x00").encode()
        template = ds_state.pack(outer_xml, b"OUTERTAIL")
        preset = '<DecentSampler><groups><group><sample path="/x/a.wav" rootNote="60"/></group></groups></DecentSampler>'
        state = ds_state.make_state(template, preset, "C:/lib", "bass")
        xml, tail = ds_state.unpack(state)
        self.assertEqual(tail, b"OUTERTAIL")
        encoded = re.search(r"<IComponent>(.*?)</IComponent>", xml.decode()).group(1)
        new_inner, new_tail = ds_state.unpack(ds_state.b64_decode(encoded))
        self.assertEqual(new_tail, b"TAIL")
        text = new_inner.decode()
        self.assertIn('<sample path="/x/a.wav" rootNote="60"/>', text)
        self.assertIn('_samplePath="C:/lib"', text)
        self.assertIn('_presetName="bass"', text)
        self.assertNotIn("<groups/>", text)


if __name__ == "__main__":
    unittest.main()
