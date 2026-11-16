"""Optional check that a real Decent Sampler plug-in renders sound through the worker's own path. Skips cleanly without one.

Needs LMMS_VST3_PYTHON's packages (pedalboard, numpy) and LMMS_DECENT_SAMPLER_VST3. It writes a one-second sine sample and a tiny
.dspreset to a temporary folder, loads the preset the way vst3-render.py does, plays a note and checks that sound comes back.
This is the L1 case: before the state wait, the render could be silent on Linux.

Run: python sampler/check_real_plugin.py
Exit code 0 means it passed or was skipped; 1 means the plug-in loaded but the render failed.
"""
import math
import os
import struct
import sys
import tempfile
import wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ds_state
import vst3_support as support


def skip(reason):
    print("SKIP: " + reason)
    sys.exit(0)


def main():
    path = os.environ.get("LMMS_DECENT_SAMPLER_VST3")
    if not path or not os.path.exists(path):
        skip("LMMS_DECENT_SAMPLER_VST3 is not set to an existing plug-in")
    try:
        import numpy as np
        from pedalboard import load_plugin
    except ImportError as error:
        skip("pedalboard or numpy is missing: " + str(error))
    bundle = support.resolve_vst3_bundle(path)
    with tempfile.TemporaryDirectory() as folder:
        sample = os.path.join(folder, "tone.wav")
        with wave.open(sample, "wb") as handle:
            handle.setparams((1, 2, 48000, 48000, "NONE", "not compressed"))
            handle.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / 48000))) for i in range(48000)))
        preset = os.path.join(folder, "tone.dspreset")
        with open(preset, "w", encoding="utf-8") as handle:
            handle.write('<?xml version="1.0"?><DecentSampler><groups><group>'
                         f'<sample path="{sample.replace(os.sep, "/")}" rootNote="69" loNote="0" hiNote="127"/></group></groups></DecentSampler>')
        started = support.now()
        plugin = load_plugin(bundle, initialization_timeout=support.initialization_timeout())
        ds_state.load_dspreset(plugin, preset, "", "check")
        audio = plugin([(bytes([0x90, 69, 100]), 0.0), (bytes([0x80, 69, 0]), 0.5)], duration=1.0, sample_rate=48000, num_channels=2, buffer_size=512)
        peak = float(np.max(np.abs(audio)))
        removed = support.clean_decent_sampler_logs(support.decent_sampler_log_directory(), started)
    print(f"bundle {bundle}\npeak {peak:.4f}\nlogs removed {removed}")
    if peak < 1e-3:
        print("FAIL: the render was silent")
        sys.exit(1)
    print("PASS")


if __name__ == "__main__":
    main()
