# SoundFont rendering

Render a MIDI file through a SoundFont (`.sf2` or `.sf3`) using [FluidSynth](https://www.fluidsynth.org/). This gives agents access to the large free SoundFont libraries (pianos, strings, brass, drums, etc.) without requiring Decent Sampler or VST3.

## Setup

Install FluidSynth and ensure `fluidsynth` is on PATH, or set `LMMS_FLUIDSYNTH` to the full path of the executable.

Optional: set `LMMS_SOUNDFONTS` to a folder that holds your `.sf2` / `.sf3` files. The tool will look there when the path is not absolute and not in the workspace.

## Tool

`list_soundfonts` and `render_soundfont`

| Argument | Required | Default | Notes |
| --- | --- | --- | --- |
| `midi` | yes | | Workspace MIDI file (`*.mid`) |
| `soundfont` | yes | | Absolute path, workspace-relative, or `LMMS_SOUNDFONTS`-relative `.sf2`/`.sf3` |
| `output` | yes | | Output WAV name in the workspace |
| `gain` | | 0.8 | FluidSynth gain (0.1–2) |
| `sampleRate` | | 48000 | 22050–96000 |
| `reverb` | | false | |
| `chorus` | | false | |
| `timeoutSeconds` | | 180 | |

Example:

```json
{
  "midi": "theme.mid",
  "soundfont": "SalamanderGrandPiano.sf2",
  "output": "theme-piano.wav",
  "reverb": true
}
```

The resulting WAV can be analysed with `analyze_audio` or loaded as a sample track.

## Notes

- This is a headless render path. It does not embed the SoundFont into the LMMS project; the editable source remains the MIDI.
- FluidSynth must be installed separately. The server does not bundle it.
- For SFZ libraries that already work with the Decent Sampler path, prefer `convert_sfz` + `render_vst3_stems` when you want the result inside an LMMS project.


## list_soundfonts

Returns `.sf2` and `.sf3` files found in the workspace and in `LMMS_SOUNDFONTS` (if set).

## Bank and preset

`render_soundfont` accepts optional `bank` and `preset` numbers. MIDI program-change events in the file are always honoured. Use `bank`/`preset` as a hint when the MIDI does not select an instrument.
