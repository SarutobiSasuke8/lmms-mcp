#!/usr/bin/env python3
"""Convert an SFZ instrument (v1/v2 subset, ARIA includes and macros) to a Decent Sampler .dspreset.

Usage: sfz2dspreset.py <file.sfz> <out.dspreset> [--root DIR] [--abs] [--only TEXT] [--keep-releases] [--within DIR]
Sample paths are written relative to --root (default: the sfz folder), or absolute with --abs.
Handles #define, #include, <control>/<global>/<master>/<group>/<region> inheritance, default_path,
key names, velocity ranges, loops, offsets, tuning, volume, pan, ampeg, round robin (seq_*), and
keeps only regions whose cc/keyswitch conditions hold at the SFZ's default controller values and the default
keyswitch (sw_default), and applies *_onccN modulation of envelope, volume, pan, tune, offset and velocity tracking
at those default values. With --keep-releases, release samples become Decent Sampler release groups.
Skipped: other keyswitched articulations, cc-gated layers, regions triggered by a controller, LFOs, filters and effects.
"""
import re, sys, os, argparse
from xml.sax.saxutils import quoteattr

WITHIN = None  # when set, includes and samples must resolve inside this folder


def inside(path):
    if WITHIN is None:
        return True
    root = os.path.normcase(os.path.realpath(WITHIN))
    real = os.path.normcase(os.path.realpath(path))
    return real == root or real.startswith(root + os.sep)


NOTE = {"c": 0, "d": 2, "e": 4, "f": 5, "g": 7, "a": 9, "b": 11}


def key(v):
    v = str(v).strip().lower()
    if re.fullmatch(r"-?\d+", v):
        return int(v)
    m = re.fullmatch(r"([a-g])([#b]?)(-?\d+)", v)
    if not m:
        raise ValueError(f"bad key {v}")
    n = NOTE[m.group(1)] + (1 if m.group(2) == "#" else -1 if m.group(2) == "b" else 0)
    return n + (int(m.group(3)) + 1) * 12  # SFZ convention: c4 = 60


def preprocess(path, defines, depth=0, main_dir=None):
    if depth > 12:
        raise RuntimeError("include depth")
    out = []
    base = os.path.dirname(path)
    main_dir = main_dir or base
    with open(path, encoding="utf-8", errors="replace") as handle:
        text = handle.read()
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return preprocess_lines(text.splitlines(), base, defines, depth, main_dir)


def preprocess_lines(lines, base, defines, depth, main_dir):
    out = []
    for line in lines:
        line = re.sub(r"//.*$", "", line).rstrip()
        s = line.strip()
        if not s:
            continue
        if s.startswith("#define"):
            parts = s.split(None, 2)
            defines[parts[1]] = parts[2].strip() if len(parts) > 2 else ""
            continue
        if "#include" in s and not s.startswith("#include"):
            head, tail = s.split("#include", 1)
            for name in sorted(defines, key=len, reverse=True):
                head = head.replace(name, defines[name])
            if head.strip():
                out.append(head.rstrip())
            m = re.match(r'\s*("[^"]+")(.*)', tail)
            if not m:
                raise ValueError(f"bad #include in: {s}")
            rest = m.group(2).strip()
            out.extend(preprocess_lines(["#include " + m.group(1)] + ([rest] if rest else []), base, defines, depth, main_dir))
            continue
        if s.startswith("#include"):
            for name in sorted(defines, key=len, reverse=True):
                s = s.replace(name, defines[name])
            m = re.search(r'"([^"]+)"', s)
            rel = m.group(1).replace("\\", "/")
            inc = os.path.normpath(os.path.join(main_dir, rel))  # SFZ spec: relative to the main file
            if not os.path.exists(inc):
                inc = os.path.normpath(os.path.join(base, rel))
            if not inside(inc):
                raise ValueError(f"#include outside the library folder: {rel}")
            out.extend(preprocess(inc, defines, depth + 1, main_dir))
            continue
        for name in sorted(defines, key=len, reverse=True):
            if name in line:
                line = line.replace(name, defines[name])
        out.append(line)
    return out


OPCODE = re.compile(r"(?:(?<=\s)|^)([A-Za-z_][\w]*)=")


def opcodes(body):
    found = list(OPCODE.finditer(body))
    ops = {}
    for i, m in enumerate(found):
        end = found[i + 1].start() if i + 1 < len(found) else len(body)
        ops[m.group(1)] = body[m.end():end].strip()
    return ops


def parse(path):
    lines = preprocess(path, {})
    text = "\n".join(lines)
    parts = re.split(r"<(\w+)>", text)
    levels = {"control": {}, "global": {}, "master": {}, "group": {}}
    order = ["global", "master", "group"]
    regions = []
    default_cc = {}
    for i in range(1, len(parts), 2):
        header, body = parts[i], opcodes(parts[i + 1])
        if header == "control":
            levels["control"].update(body)
        elif header in order:
            idx = order.index(header)
            for lower in order[idx:]:
                levels[lower] = {}
            levels[header] = body
        elif header == "region":
            merged = {}
            for lvl in order:
                merged.update(levels[lvl])
            merged.update(body)
            regions.append(merged)
    for k, v in levels["control"].items():
        m = re.fullmatch(r"set_(?:hd)?cc(\d+)", k)
        if m:
            val = float(v)
            default_cc[int(m.group(1))] = val * 127 if k.startswith("set_hd") else val
    return levels["control"], regions, default_cc


def active(r, cc, keep_releases):
    if not keep_releases and r.get("trigger", "attack") in ("release", "release_key"):
        return False
    if "sw_previous" in r or "sw_up" in r or "sw_down" in r:
        return False
    if "sw_last" in r:
        default = r.get("sw_default", r.get("sw_lokey"))
        if default is None or key(r["sw_last"]) != key(default):
            return False  # keep only the articulation that plays when no keyswitch is pressed
    if any(re.fullmatch(r"(start|on)_(lo|hi)(hd)?cc\d+", k) for k in r):
        return False  # triggered by a controller, such as pedal noise on CC64
    if "key" not in r and "lokey" in r and key(r["lokey"]) < 0:
        return False
    for k, v in r.items():
        m = re.fullmatch(r"(lo|hi)cc(\d+)", k)
        if m:
            cur = cc.get(int(m.group(2)), 0)
            if m.group(1) == "lo" and cur < float(v):
                return False
            if m.group(1) == "hi" and cur > float(v):
                return False
        m = re.fullmatch(r"(lo|hi)hdcc(\d+)", k)
        if m:
            cur = cc.get(int(m.group(2)), 0) / 127
            if m.group(1) == "lo" and cur < float(v):
                return False
            if m.group(1) == "hi" and cur > float(v):
                return False
    if "lochan" in r and int(r["lochan"]) > 1:
        return False
    if "lorand" in r and float(r["lorand"]) > 0 and "seq_length" not in r:
        return False  # keep only the first random layer
    return True


MODULATED = {"ampeg_attack": 0.0, "ampeg_decay": 0.0, "ampeg_sustain": 100.0, "ampeg_release": 0.05,
             "amp_veltrack": 100.0, "volume": 0.0, "pan": 0.0, "tune": 0.0, "offset": 0.0}


# The standard SFZ controller curves 0 to 6. Custom <curve> headers fall back to linear.
CURVES = {0: lambda x: x, 1: lambda x: 2 * x - 1, 2: lambda x: 1 - x, 3: lambda x: 1 - 2 * x,
          4: lambda x: x * x, 5: lambda x: x ** 0.5, 6: lambda x: (1 - x) ** 0.5}


def apply_cc_defaults(r, cc):
    """Fold *_onccN modulation into the base opcode at the default controller values."""
    out = dict(r)
    for k, v in r.items():
        m = re.fullmatch(r"(\w+?)_on(hd)?cc(\d+)", k)
        if not m or m.group(1) not in MODULATED:
            continue
        base, number = m.group(1), int(m.group(3))
        x = cc.get(number, 0) / 127
        curve = int(float(r.get(f"{base}_curvecc{number}", 0)))
        out[base] = str(float(out.get(base, MODULATED[base])) + float(v) * CURVES.get(curve, CURVES[0])(x))
    return out


def convert(sfz, root, absolute, keep_releases, only):
    control, regions, cc = parse(sfz)
    regions = [apply_cc_defaults(r, cc) for r in regions]
    default_path = control.get("default_path", "").replace("\\", "/")
    sfz_dir = os.path.dirname(sfz)
    groups, skipped, missing = {}, 0, []
    for r in regions:
        if "sample" not in r or r["sample"].startswith("*"):
            skipped += 1  # generators
            continue
        if not active(r, cc, keep_releases):
            skipped += 1
            continue
        rel = (default_path + r["sample"]).replace("\\", "/")
        full = os.path.normpath(os.path.join(sfz_dir, rel))
        if only and only not in rel:
            skipped += 1
            continue
        if not inside(full):
            skipped += 1
            continue
        if not os.path.exists(full):
            missing.append(rel)
            continue
        path = full.replace("\\", "/") if absolute else os.path.relpath(full, root).replace("\\", "/")
        lo, hi = (key(r["key"]),) * 2 if "key" in r else (key(r.get("lokey", 0)), key(r.get("hikey", 127)))
        center = key(r["pitch_keycenter"]) if "pitch_keycenter" in r else (key(r["key"]) if "key" in r else 60)
        attrs = {"path": path, "rootNote": center, "loNote": lo, "hiNote": hi,
                 "loVel": int(float(r.get("lovel", 0))) or 1, "hiVel": int(float(r.get("hivel", 127)))}
        tune = float(r.get("tune", 0)) / 100 + float(r.get("transpose", 0))
        if abs(tune) > 1e-6:
            attrs["tuning"] = round(tune, 4)
        if "volume" in r and abs(float(r["volume"])) > 1e-6:
            attrs["volume"] = f"{float(r['volume'])}dB"
        if "pan" in r and float(r["pan"]) != 0:
            attrs["pan"] = float(r["pan"])
        if "offset" in r and int(float(r["offset"])) > 0:
            attrs["start"] = int(float(r["offset"]))
        if "end" in r and int(float(r["end"])) > 0:
            attrs["end"] = int(float(r["end"]))
        if r.get("loop_mode") in ("loop_continuous", "loop_sustain") or (r.get("loop_start") and r.get("loop_end") and r.get("loop_mode") != "no_loop" and r.get("loop_mode") != "one_shot"):
            if r.get("loop_start") and r.get("loop_end"):
                attrs.update(loopEnabled="true", loopStart=int(float(r["loop_start"])), loopEnd=int(float(r["loop_end"])))
        if "seq_length" in r and int(r["seq_length"]) > 1:
            attrs.update(seqMode="round_robin", seqLength=int(r["seq_length"]), seqPosition=int(r.get("seq_position", 1)))
        g = {"attack": float(r.get("ampeg_attack", 0)), "decay": float(r.get("ampeg_decay", 0.0)),
             "sustain": float(r.get("ampeg_sustain", 100)) / 100, "release": max(float(r.get("ampeg_release", 0.05)), 0.01),
             "ampVelTrack": max(0.0, min(1.0, float(r.get("amp_veltrack", 100)) / 100)),
             "trigger": "release" if r.get("trigger") in ("release", "release_key") else "attack"}
        if g["decay"] > 30:
            g["decay"] = 30.0
        groups.setdefault(tuple(sorted(g.items())), []).append(attrs)
    xml = []
    count = 0
    for gk, samples in groups.items():
        gattrs = " ".join(f"{k}={quoteattr(str(round(v, 4) if isinstance(v, float) else v))}"
                          for k, v in gk if not (k == "trigger" and v == "attack"))
        xml.append(f"    <group {gattrs}>")
        for a in samples:
            xml.append("      <sample " + " ".join(f"{k}={quoteattr(str(v))}" for k, v in a.items()) + "/>")
            count += 1
        xml.append("    </group>")
    return "\n".join(xml), count, skipped, missing


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sfz"); ap.add_argument("out")
    ap.add_argument("--root"); ap.add_argument("--abs", action="store_true")
    ap.add_argument("--keep-releases", action="store_true"); ap.add_argument("--only", default="")
    ap.add_argument("--within", help="refuse includes and samples outside this folder")
    a = ap.parse_args()
    global WITHIN
    WITHIN = os.path.abspath(a.within) if a.within else None
    sfz = os.path.abspath(a.sfz)
    if not inside(sfz):
        raise SystemExit("The SFZ file is outside the library folder")
    root = os.path.abspath(a.root) if a.root else os.path.dirname(sfz)
    body, count, skipped, missing = convert(sfz, root, a.abs, a.keep_releases, a.only)
    doc = f'<?xml version="1.0" encoding="UTF-8"?>\n<DecentSampler minVersion="1.0.0">\n  <groups>\n{body}\n  </groups>\n</DecentSampler>\n'
    with open(a.out, "w", encoding="utf-8") as handle:
        handle.write(doc)
    print(f"{count} samples written, {skipped} regions skipped, {len(missing)} missing files" + (f" e.g. {missing[0]}" if missing else ""))


if __name__ == "__main__":
    main()
