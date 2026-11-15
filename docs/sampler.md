# Sampled instruments with Decent Sampler

Stock LMMS has synths and a few drum samples. This route plays open SFZ sample libraries through the free Decent Sampler VST3, so a piece can use a real piano, upright bass, saxophone and drum kit. It needs no editor and no saved plugin state.

## Setup

1. Run `setup-vst3-windows.ps1` (see the README) for the Decent Sampler plug-in and the isolated Python host. Set `LMMS_VST3_PYTHON` and `LMMS_DECENT_SAMPLER_VST3` from the `mcp-env.json` it writes.
2. Run `setup-libraries-windows.ps1`. It fetches four open libraries with git sparse checkout, about 1.1 GB, most of it the piano. Use `-Only` to take some of them and `-Destination` to choose the folder.
3. Set `LMMS_SAMPLE_LIBRARIES` to that folder and restart the MCP client.

| Role | Library | Licence | Notes |
| --- | --- | --- | --- |
| Piano | [SalamanderGrandPiano](https://github.com/sfzinstruments/SalamanderGrandPiano) | CC BY 3.0 | Yamaha C5, 16 velocity layers, string resonance and hammer release samples. Credit Alexander Holm |
| Piano, smaller (`-Only splendid`) | [SplendidGrandPiano](https://github.com/sfzinstruments/SplendidGrandPiano) | Public domain | Steinway, four velocity layers, no credit needed |
| Upright bass | [dsmolken.double-bass](https://github.com/sfzinstruments/dsmolken.double-bass) | CC0 | 1958 Rubner, pizzicato samples only |
| Saxophone | [MTG.SoloSax](https://github.com/sfzinstruments/MTG.SoloSax) | CC BY 4.0 | Alto and tenor. Credit MTG (freesound) and kinwie |
| Drums | [virtuosity_drums](https://github.com/sfzinstruments/virtuosity_drums) | CC0 | Jazz kit, "mid" mic position only |

Check each library's own licence before you release anything. Any open SFZ library under `LMMS_SAMPLE_LIBRARIES` works.

## Use

```json
{"tool": "convert_sfz", "sfz": "dsmolken.double-bass/d_smolken_rubner_bass_pizz.sfz", "output": "bass.dspreset"}
```

`convert_sfz` writes a `.dspreset` into the workspace with absolute sample paths. It handles `#define`, `#include`, scope inheritance, key names, velocity layers, loops, offsets, tuning, volume, pan, envelopes and round robin. It keeps the regions that are active at the SFZ's default controller values and default keyswitch (`sw_default`), applies controller modulation of envelopes, volume, tuning and velocity tracking at those defaults (with the standard SFZ curves), and reads `#include` written inside a header line. With `keepReleases`, release samples become Decent Sampler release groups that play when a note ends. It skips other keyswitched articulations, cc-gated layers, regions triggered by a controller (such as pedal noise), LFOs and filters. Missing sample files are skipped and counted. Use `only` to keep part of a library, for example `"only": "/mid/"` or `"only": "alt_"`. The SFZ file, its includes and its samples must sit inside `LMMS_SAMPLE_LIBRARIES`.

Then export the arrangement and render it:

```json
{"tool": "export_midi", "project": "song.mmp", "output": "song.mid"}
{"tool": "render_vst3_stems", "midi": "song.mid", "outputDirectory": "stems", "durationSeconds": 90,
 "tracks": [{"track": "Bass", "name": "bass", "instrument": "decent-sampler", "dspreset": "bass.dspreset", "gainDb": 0}]}
```

Give each track its own `dspreset`. A render loads every instrument in turn and can take several minutes, so use a tool timeout of at least ten minutes.

## Tips

- **Pitch.** Written notes sound at pitch for these libraries. Check a stem with `analyze_audio` and `pitch: true`.
- **Drums.** The Virtuosity key map is kick 36, snare 38, pedal hat 44, closed hat 42, ride 51, crash 49. Drum samples ring on, so give ride and crash notes a long length.
- **Level.** Sampled instruments are much louder than the synth presets and differ from each other by 10 dB or more. Balance by measuring each stem, then master with `render_mix` and `targetLufs`.
- **Mixing.** `render_vst3_stems` returns stems and a mix. For reverb and mastering, place the mix on a sample track and use the LMMS effects and `render_mix`.

## How it works

Decent Sampler's VST3 state is JUCE's: a `VC2!` header and an XML wrapper whose `IComponent` holds JUCE-base64 of a second `VC2!` block with the preset XML. `sampler/ds_state.py` replaces that preset's `<groups>` with the converted ones and sets the plug-in state, so the library loads without opening a window. `sampler/sfz2dspreset.py` is the converter and runs on its own:

```powershell
python sampler/sfz2dspreset.py "MTG Alto Sax.sfz" alto.dspreset --abs --within C:\libraries
python -m unittest discover -s sampler
```

The state layout comes from Decent Sampler 1.42.1. A different version may change it.

## Limits

- Windows x64 is the tested platform.
- No keyswitches, legato, vibrato, filters or effects from the SFZ. The sax plays its sustain articulation.
- Release samples are skipped, so a piano has no key-off noise or pedal sounds.
- A `.dspreset` points at the library's files. Move the library and convert again.
