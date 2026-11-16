"""Small pure helpers for vst3-render.py. Standard library only, so they run in any test environment.

Bundle lookup (Linux and macOS load the .vst3 folder, not the binary inside it), the per-track note map and
transpose, note range warnings, stem normalisation and cleanup of Decent Sampler's per-instance logs.
"""
import os
import re
import time

INITIALIZATION_TIMEOUT = 3.0  # seconds pedalboard waits for a plugin to start; checked on Linux with Decent Sampler and Surge XT


def initialization_timeout(env=None):
    """The plugin start-up timeout in seconds. LMMS_VST3_INIT_TIMEOUT overrides the default of 3."""
    value = (env if env is not None else os.environ).get("LMMS_VST3_INIT_TIMEOUT")
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return INITIALIZATION_TIMEOUT
    return parsed if parsed > 0 else INITIALIZATION_TIMEOUT


def resolve_vst3_bundle(path, platform=None):
    """Return the .vst3 bundle folder for a path that points inside it.

    On Linux a path such as Foo.vst3/Contents/x86_64-linux/Foo.so fails to load with "scan failure": pedalboard needs the
    Foo.vst3 folder. Walk up from a path inside Contents/ to the bundle. Windows keeps working with either the inner
    binary or the bundle, so it is left alone. A path that is already a bundle, or is not inside one, is returned as it was.
    """
    import sys
    if (platform or sys.platform) == "win32":
        return path
    separator = "\\" if "\\" in path and "/" not in path else "/"
    parts = path.split(separator)
    # The outermost *.vst3 folder that has Contents below it.
    for index, part in enumerate(parts[:-1]):
        if part.lower().endswith(".vst3") and parts[index + 1] == "Contents":
            return separator.join(parts[: index + 1])
    return path


def map_note(note, note_map=None, transpose=0):
    """Apply the note map, then the transpose. Returns the new note, or None when it falls outside 0 to 127.

    note_map keys are source notes as numbers or strings, or "*" for every other note.
    """
    mapped = note
    if note_map:
        lookup = {str(key): value for key, value in note_map.items()}
        if str(note) in lookup:
            mapped = lookup[str(note)]
        elif "*" in lookup:
            mapped = lookup["*"]
    mapped += transpose
    return mapped if 0 <= mapped <= 127 else None


def remap_events(events, note_map=None, transpose=0):
    """Remap note_on, note_off and polytouch events in a list of (bytes, seconds).

    A note_on that falls outside the keyboard is dropped together with its note_off. Returns (events, notes_used, dropped).
    notes_used lists the sounding notes (after mapping) that were played; dropped counts notes lost to the keyboard range.
    """
    if not note_map and not transpose:
        used = sorted({data[1] for data, _ in events if data and data[0] & 0xF0 == 0x90 and len(data) > 2 and data[2]})
        return events, used, 0
    out, used, dropped = [], set(), 0
    sounding = {}  # (source note) -> target note, so a note_off follows its note_on even if rules overlap
    for data, at in events:
        kind = data[0] & 0xF0 if data else 0
        if kind in (0x80, 0x90, 0xA0) and len(data) > 2:
            source = data[1]
            if kind == 0x90 and data[2]:
                target = map_note(source, note_map, transpose)
                sounding[source] = target
                if target is None:
                    dropped += 1
                    continue
                used.add(target)
            else:
                target = sounding.get(source, map_note(source, note_map, transpose))
                if target is None:
                    continue
            out.append((bytes([data[0], target]) + bytes(data[2:]), at))
        else:
            out.append((data, at))
    return out, sorted(used), dropped


def preset_note_range(dspreset_path):
    """The lowest and highest key that a .dspreset's samples cover, as (low, high), or None if it cannot be read."""
    try:
        with open(dspreset_path, encoding="utf-8") as handle:
            text = handle.read()
    except OSError:
        return None
    lows = [int(v) for v in re.findall(r'<sample\b[^>]*?\bloNote="(\d+)"', text)]
    highs = [int(v) for v in re.findall(r'<sample\b[^>]*?\bhiNote="(\d+)"', text)]
    if not lows or not highs:
        return None
    return min(lows), max(highs)


def range_warning(track, notes_used, key_range, dropped=0, transpose=0):
    """A sentence for notes that the instrument will not play, or None."""
    parts = []
    if key_range and notes_used:
        low, high = key_range
        outside = [n for n in notes_used if n < low or n > high]
        if outside:
            parts.append(f"{track}: {len(outside)} of {len(notes_used)} distinct notes fall outside the preset's range "
                         f"{low} to {high} (for example {outside[0]}), so they will be silent. Use transpose or noteMap"
                         + (f" (transpose is {transpose})" if transpose else "") + ".")
    if dropped:
        parts.append(f"{track}: {dropped} notes left the 0 to 127 keyboard after the note map and transpose and were dropped.")
    return " ".join(parts) or None


def normalise_gain_db(peak, target_db):
    """Gain in dB that brings a stem with this linear peak to target_db (dBFS). 0 for silence."""
    import math
    if peak <= 1e-9:
        return 0.0
    return target_db - 20 * math.log10(peak)


def decent_sampler_log_directory(platform=None, home=None):
    """Where Decent Sampler writes its per-instance logs on Linux, or None elsewhere."""
    import sys
    if (platform or sys.platform) != "linux":
        return None
    return os.path.join(home or os.path.expanduser("~"), ".config", "DecentSampler")


def clean_decent_sampler_logs(directory, since, remove=os.remove):
    """Delete *.log files directly inside directory that were modified at or after `since` (epoch seconds).

    Only files from this render are touched, so older logs, presets and settings stay. Returns the number removed.
    """
    if not directory or not os.path.isdir(directory):
        return 0
    removed = 0
    for name in os.listdir(directory):
        full = os.path.join(directory, name)
        if name.lower().endswith(".log") and os.path.isfile(full) and not os.path.islink(full) and os.path.getmtime(full) >= since - 1:
            try:
                remove(full)
                removed += 1
            except OSError:
                pass
    return removed


def now():
    return time.time()
