"""Build a Decent Sampler VST3 state from a .dspreset and render with it.

Library use:
    from ds_state import load_dspreset
    plugin = load_plugin(path); load_dspreset(plugin, "bass.dspreset", sample_path="C:/lib/bass")
The plugin's state is JUCE's: 'VC2!' + size + XML, wrapped in a VST3PluginState whose IComponent holds JUCE-base64
of another 'VC2!' + size + <DecentSampler> preset XML. We swap the <groups> in that preset XML.
"""
import re

TABLE = ".ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+"


def b64_decode(s):
    size, data = s.split(".", 1)
    size = int(size)
    out = bytearray(size)
    for i, ch in enumerate(data):
        v = TABLE.index(ch)
        for b in range(6):
            bit = i * 6 + b
            if bit < size * 8 and v >> b & 1:
                out[bit // 8] |= 1 << (bit % 8)
    return bytes(out)


def b64_encode(data):
    out = []
    for i in range(0, len(data) * 8, 6):
        v = 0
        for b in range(6):
            bit = i + b
            if bit < len(data) * 8 and data[bit // 8] >> (bit % 8) & 1:
                v |= 1 << b
        out.append(TABLE[v])
    return f"{len(data)}." + "".join(out)


def unpack(blob):
    assert blob[:4] == b"VC2!", blob[:8]
    size = int.from_bytes(blob[4:8], "little")
    return blob[8:8 + size], blob[8 + size:]


def pack(xml, tail):
    return b"VC2!" + len(xml).to_bytes(4, "little") + xml + tail


def make_state(template_state, dspreset_text, sample_path, name="preset"):
    outer_xml, outer_tail = unpack(template_state)
    outer = outer_xml.decode("utf-8")
    m = re.search(r"<IComponent>(.*?)</IComponent>", outer, re.S)
    inner_xml, inner_tail = unpack(b64_decode(m.group(1).strip()))
    inner = inner_xml.decode("utf-8")
    groups = re.search(r"<groups>.*</groups>", dspreset_text, re.S).group(0)
    inner = re.sub(r"<groups\s*/>|<groups>.*?</groups>", lambda _: groups, inner, count=1, flags=re.S)
    inner = re.sub(r'_samplePath="[^"]*"', f'_samplePath="{sample_path}"', inner)
    inner = re.sub(r'_presetName="[^"]*"', f'_presetName="{name}"', inner)
    new_inner = pack(inner.encode("utf-8"), inner_tail)
    outer = outer[:m.start(1)] + b64_encode(new_inner) + outer[m.end(1):]
    return pack(outer.encode("utf-8"), outer_tail)


def load_dspreset(plugin, dspreset_path, sample_path, name="preset"):
    with open(dspreset_path, encoding="utf-8") as handle:
        text = handle.read()
    plugin.raw_state = make_state(plugin.raw_state, text, sample_path.replace("\\", "/"), name)
    return plugin
