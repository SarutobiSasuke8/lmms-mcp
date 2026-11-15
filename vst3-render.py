"""Offline VST3 instrument worker for LMMS MCP."""
import importlib.util
import json
from pathlib import Path
import sys
import wave

sys.path.insert(0, str(Path(__file__).resolve().parent / "sampler"))
import vst3_support as support


def apply_eq(audio, bands, rate):
    import numpy as np
    from pedalboard import HighpassFilter, HighShelfFilter, LowShelfFilter, Pedalboard, PeakFilter
    make = {"highpass": lambda b: HighpassFilter(cutoff_frequency_hz=b["hz"]),
            "lowshelf": lambda b: LowShelfFilter(cutoff_frequency_hz=b["hz"], gain_db=b.get("db", 0), q=b.get("q", 0.7)),
            "highshelf": lambda b: HighShelfFilter(cutoff_frequency_hz=b["hz"], gain_db=b.get("db", 0), q=b.get("q", 0.7)),
            "peak": lambda b: PeakFilter(cutoff_frequency_hz=b["hz"], gain_db=b.get("db", 0), q=b.get("q", 0.7))}
    return Pedalboard([make[b["type"]](b) for b in bands])(audio.astype(np.float32), rate)


SPACES = {
    # seconds of decay, pre-delay, how long the highs last, early reflection spread in seconds
    "room": {"seconds": 0.9, "predelayMs": 6, "brightness": 0.6, "early": 0.025},
    "hall": {"seconds": 2.4, "predelayMs": 22, "brightness": 0.5, "early": 0.075},
    "church": {"seconds": 4.2, "predelayMs": 30, "brightness": 0.35, "early": 0.11},
    "cathedral": {"seconds": 7.0, "predelayMs": 45, "brightness": 0.3, "early": 0.16},
}


def make_space(rate, seconds, predelay_ms, brightness, early_spread, seed=7):
    """A synthetic stereo impulse response: sparse early reflections, then a dense tail whose highs die faster than its lows."""
    import numpy as np
    rng = np.random.default_rng(seed)
    n = int(seconds * rate)
    t = np.arange(n) / rate
    freqs = np.fft.rfftfreq(n, 1 / rate)
    norm = lambda x: x / (np.sqrt(np.mean(x ** 2)) + 1e-12)
    channels = []
    for _ in range(2):
        spectrum = np.fft.rfft(rng.standard_normal(n))
        dark = np.fft.irfft(spectrum / (1 + (freqs / 900) ** 2), n)
        mid = np.fft.irfft(spectrum / (1 + (freqs / 4500) ** 2), n)
        air = np.fft.irfft(spectrum * (freqs > 4500) / (1 + (freqs / 12000) ** 4), n)
        tail = (norm(dark) * np.exp(-t / (seconds / 4.2)) + 0.8 * norm(mid) * np.exp(-t / (seconds / 6.2))
                + brightness * 0.5 * norm(air) * np.exp(-t / (seconds / 11)))
        tail *= np.minimum(1, t / 0.06) ** 1.5  # the tail builds over the first 60 ms
        early = np.zeros(n)
        for k in range(9):
            at = min(n - 1, int((0.006 + early_spread * rng.random()) * rate))
            early[at] += (0.9 - 0.07 * k) * (1 if rng.random() > 0.4 else -1)
        ir = np.concatenate([np.zeros(int(predelay_ms / 1000 * rate)), 0.35 * early + 0.16 * tail])[:n]
        channels.append(ir)
    ir = np.stack(channels)
    return ir / np.sqrt(np.sum(ir ** 2, axis=1, keepdims=True))


def add_space(audio, settings, rate):
    """Dry signal plus the signal convolved with a synthetic space, at the same length."""
    import numpy as np
    preset = SPACES[settings["type"]]
    ir = make_space(rate, settings.get("seconds") or preset["seconds"], settings.get("predelayMs", preset["predelayMs"]),
                    settings.get("brightness", preset["brightness"]), preset["early"])
    size = audio.shape[1] + ir.shape[1] - 1
    fft = 1 << (size - 1).bit_length()
    wet = np.fft.irfft(np.fft.rfft(audio, fft) * np.fft.rfft(ir, fft), fft)[:, : audio.shape[1]]
    # Width of the space: 0 is a mono tail, 1 two independent channels.
    width = settings.get("width", 0.6)
    mid, side = (wet[0] + wet[1]) / 2, (wet[0] - wet[1]) / 2 * width
    wet = np.stack([mid + side, mid - side])
    # wetDb is the level of the space against the dry sound, so it means the same in every space.
    dry_rms, wet_rms = np.sqrt(np.mean(audio ** 2)), np.sqrt(np.mean(wet ** 2))
    if wet_rms > 0:
        wet *= dry_rms / wet_rms * 10 ** (settings.get("wetDb", -10) / 20)
    return (audio + wet).astype(np.float32)


def add_reverb(audio, settings, rate):
    """Return the dry signal plus a pre-delayed room, at the same length."""
    import numpy as np
    from pedalboard import Reverb
    delay = int(round(settings.get("preDelayMs", 20) / 1000 * rate))
    source = np.zeros_like(audio)
    source[:, delay:] = audio[:, :audio.shape[1] - delay] if delay else audio
    room = Reverb(room_size=settings.get("roomSize", 0.7), damping=settings.get("damping", 0.5),
                  wet_level=1.0, dry_level=0.0, width=settings.get("width", 1.0))
    wet = room(source.astype(np.float32), rate)
    return (audio + wet * settings.get("wet", 0.22)).astype(np.float32)


def fit_plugin_audio(audio, frames, track):
    import numpy as np

    if audio.ndim != 2 or audio.shape[0] != 2:
        raise ValueError(f"{track} returned an invalid stereo shape: {audio.shape}")
    actual = audio.shape[1]
    if abs(actual - frames) > 1 or actual == 0:
        raise ValueError(f"{track} returned {actual} frames; expected {frames}")
    if not np.isfinite(audio).all():
        raise ValueError(f"{track} returned non-finite samples")
    # A plugin host may round the seconds argument one sample either way.
    if actual < frames:
        audio = np.pad(audio, ((0, 0), (0, 1)))
    elif actual > frames:
        audio = audio[:, :frames]
    if np.max(np.abs(audio)) < 0.0001:
        raise ValueError(f"{track} produced silent audio")
    return audio


def main():
    if sys.argv[1] == "probe":
        print(json.dumps({name: importlib.util.find_spec(name) is not None
                          for name in ("pedalboard", "numpy", "mido")}))
        return
    import mido
    import numpy as np
    from pedalboard import load_plugin

    request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    midi = mido.MidiFile(request["midi"])
    if midi.type != 1 or midi.ticks_per_beat <= 0:
        raise ValueError("Expected a format 1 MIDI file with PPQ timing")
    tracks = [track for track in midi.tracks if any(msg.type == "note_on" and msg.velocity for msg in track)]
    tempo = mido.MidiTrack()
    pending = 0
    for msg in midi.tracks[0]:
        pending += msg.time
        if msg.type == "set_tempo":
            tempo.append(msg.copy(time=pending))
            pending = 0
    rate = 48000
    frames = request["frames"]
    warnings = []
    started = support.now()
    mix = np.zeros((2, frames), dtype=np.float32)

    def save(name, audio):
        pcm = np.rint(audio.T * 32767).astype("<i2")
        with wave.open(str(Path(request["directory"]) / name), "wb") as handle:
            handle.setparams((2, 2, rate, frames, "NONE", "not compressed"))
            handle.writeframes(pcm.tobytes())

    stems = []
    for assignment in request["tracks"]:
        matches = [track for track in tracks if track.name == assignment["track"]]
        if len(matches) != 1:
            raise ValueError(f'Expected exactly one MIDI track named {assignment["track"]}')
        microseconds = 500000
        now = 0
        events = []
        for msg in mido.merge_tracks([tempo, matches[0]]):
            now += mido.tick2second(msg.time, midi.ticks_per_beat, microseconds)
            if msg.type == "set_tempo":
                microseconds = msg.tempo
            elif msg.type in ("note_on", "note_off", "control_change", "pitchwheel", "aftertouch", "polytouch"):
                events.append((msg.copy(channel=0).bytes(), now))
        if now > (frames + 1) / rate:
            raise ValueError("Render duration must cover the MIDI track")
        events, used, dropped = support.remap_events(events, assignment.get("noteMap"), assignment.get("transpose", 0))
        key_range = assignment.get("noteRange") or (support.preset_note_range(assignment["dspreset"]) if assignment.get("dspreset") else None)
        warning = support.range_warning(assignment["name"], used, key_range, dropped, assignment.get("transpose", 0))
        if warning:
            warnings.append(warning)
        plugin = load_plugin(support.resolve_vst3_bundle(assignment["plugin"]), initialization_timeout=support.initialization_timeout())
        if not plugin.is_instrument:
            raise ValueError(f'{assignment["instrument"]} is not a VST3 instrument')
        if assignment.get("dspreset"):
            from ds_state import load_dspreset
            load_dspreset(plugin, assignment["dspreset"], "", Path(assignment["dspreset"]).stem)
        elif assignment.get("preset"):
            plugin.load_preset(assignment["preset"])
        for name, value in assignment["parameters"].items():
            if name not in plugin.parameters:
                raise ValueError(f"Unknown plugin parameter: {name}")
            plugin.parameters[name].raw_value = value
        audio = plugin(events, duration=frames / rate, sample_rate=rate, num_channels=2, buffer_size=512)
        audio = fit_plugin_audio(audio, frames, assignment["track"])
        if assignment.get("width", 1) != 1:
            mid, side = (audio[0] + audio[1]) / 2, (audio[0] - audio[1]) / 2 * assignment["width"]
            audio = np.stack([mid + side, mid - side]).astype(np.float32)
        if assignment.get("eq"):
            audio = apply_eq(audio, assignment["eq"], rate)
        if assignment.get("space"):
            audio = add_space(audio, assignment["space"], rate)
        if assignment.get("reverb"):
            audio = add_reverb(audio, assignment["reverb"], rate)
        if assignment.get("normalise") is not None:
            audio *= 10 ** (support.normalise_gain_db(float(np.max(np.abs(audio))), assignment["normalise"]) / 20)
        audio *= 10 ** (assignment["gainDb"] / 20)
        mix += audio
        stems.append((assignment["name"] + ".wav", audio))
    peak = max(np.max(np.abs(mix)), *(np.max(np.abs(audio)) for _, audio in stems))
    gain = min(1, 0.95 / peak)
    for name, audio in stems:
        save(name, audio * gain)
    save("mix.wav", mix * gain)
    if request.get("cleanupLogs"):
        removed = support.clean_decent_sampler_logs(support.decent_sampler_log_directory(), started)
        if removed:
            warnings.append(f"Removed {removed} Decent Sampler log files written during this render.")
    print(json.dumps({"sharedGain": float(gain), "warnings": warnings}))


if __name__ == "__main__":
    main()
