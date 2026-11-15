"""Offline VST3 instrument worker for LMMS MCP."""
import importlib.util
import json
from pathlib import Path
import sys
import wave

sys.path.insert(0, str(Path(__file__).resolve().parent / "sampler"))


def apply_eq(audio, bands, rate):
    import numpy as np
    from pedalboard import HighpassFilter, HighShelfFilter, LowShelfFilter, Pedalboard, PeakFilter
    make = {"highpass": lambda b: HighpassFilter(cutoff_frequency_hz=b["hz"]),
            "lowshelf": lambda b: LowShelfFilter(cutoff_frequency_hz=b["hz"], gain_db=b.get("db", 0), q=b.get("q", 0.7)),
            "highshelf": lambda b: HighShelfFilter(cutoff_frequency_hz=b["hz"], gain_db=b.get("db", 0), q=b.get("q", 0.7)),
            "peak": lambda b: PeakFilter(cutoff_frequency_hz=b["hz"], gain_db=b.get("db", 0), q=b.get("q", 0.7))}
    return Pedalboard([make[b["type"]](b) for b in bands])(audio.astype(np.float32), rate)


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
        plugin = load_plugin(assignment["plugin"])
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
        if audio.shape != (2, frames) or not np.isfinite(audio).all() or np.max(np.abs(audio)) < 0.0001:
            raise ValueError(f'{assignment["track"]} produced invalid or silent audio')
        if assignment.get("width", 1) != 1:
            mid, side = (audio[0] + audio[1]) / 2, (audio[0] - audio[1]) / 2 * assignment["width"]
            audio = np.stack([mid + side, mid - side]).astype(np.float32)
        if assignment.get("eq"):
            audio = apply_eq(audio, assignment["eq"], rate)
        if assignment.get("reverb"):
            audio = add_reverb(audio, assignment["reverb"], rate)
        audio *= 10 ** (assignment["gainDb"] / 20)
        mix += audio
        stems.append((assignment["name"] + ".wav", audio))
    peak = max(np.max(np.abs(mix)), *(np.max(np.abs(audio)) for _, audio in stems))
    gain = min(1, 0.95 / peak)
    for name, audio in stems:
        save(name, audio * gain)
    save("mix.wav", mix * gain)
    print(json.dumps({"sharedGain": float(gain)}))


if __name__ == "__main__":
    main()
