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

## Instrument selection

MIDI program-change events in the file are honoured by FluidSynth. The optional `bank` and `preset` arguments are reserved for a future release and currently have no effect. Put the program change in the MIDI for reliable instrument selection.


## Native LMMS sf2player tracks

`set_native_instrument` can switch a track to the stock `sf2player` and store a SoundFont file plus bank and patch:

```
set_native_instrument({ trackName: "Lead", instrument: "sf2player", soundfont: "pianos/Salamander.sf2", bank: 0, patch: 0 })
```

The instrument lives in the `.mmp` / `.mmpz` and remains editable. `render_soundfont` (FluidSynth) remains available as a non-destructive render fallback.
