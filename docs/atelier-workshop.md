# Atelier workshop instruments

The `atelier_*` tools bring the atelier-instruments engines into an LMMS session: sound design that stock LMMS lacks, effects for stems, and note generators whose output stays editable in LMMS.

## Setup

1. Check out atelier-instruments with the agent API (`agent/index.js`, version 0.2.0 or later).
2. Set `LMMS_ATELIER_INSTRUMENTS` to its absolute path in the server's environment, for example in `mcp-env.json` or the MCP client config.
3. Call `atelier_list_instruments`. If the path is wrong, the tool says what it looked for.

The engines run in Node inside the MCP process. Nothing is downloaded and LMMS is not needed to render them.

## Instruments

| id | Tool | Gives you |
| --- | --- | --- |
| `trailer-riser` | `atelier_render` | Risers, whooshes, brass hits, sub drops, reverse swells, impacts. `lengthMode: "bars"` with the project tempo lands the peak on a bar line. |
| `game-sfx` | `atelier_render` | Mono game one-shots. |
| `creature-sound-generator` | `atelier_render` | Mono creature calls. |
| `ambience` | `atelier_render` | Seamless loop bed up to 180 seconds. |
| `vowel-choir-pad` | `atelier_render` | Formant choir, up to 30 seconds a render. |
| `chord-pads` | `atelier_render`, `atelier_notes` | Voiced progressions. |
| `arp-lab` | `atelier_render`, `atelier_notes` | Arpeggios over a chord timeline. |
| `acid-bass` | `atelier_render`, `atelier_notes` | 303-style bassline. |
| `pump-sweep` | `atelier_process` | Sidechain pump plus filter build, drop and cut on a stem. |
| `tape-glitch` | `atelier_process` | Tape stop, start, stutter, reverse, crush, dropout and scratch. |
| `robot-voice-vocoder` | `atelier_process` | Vocodes a voice WAV with carrier notes. |

## Workflow

1. `atelier_describe_instrument` with the id. Read `schema`, `example` and `presets`. Pass `preset` to see that preset's full params.
2. Render or process. Params are strict: an unknown field, a wrong type or an out-of-range value is an error that names the field, and a silent render is an error. The result reports `peakDb` and `rmsDb` because the agent cannot hear it.
3. Place it. Add `place: { project, output, bar }` to put the WAV on a new sample track in a copy of the project, sized to the project tempo. Or use `atelier_notes` and pass the returned `pattern` to `add_track` with any LMMS voice or preset.
4. Measure the mix with `render_mix` and `analyze_audio` as usual.

```json
{ "instrument": "trailer-riser",
  "params": { "kind": "riser", "lengthMode": "bars", "bars": 4, "tempo": 128 },
  "output": "riser.wav",
  "place": { "project": "song.mmp", "output": "song-2.mmp", "bar": 12, "role": "fx", "volume": 70 } }
```

To end a riser on bar 16, start it at bar 12 with `bars: 4`. The tail rings past the bar line.

## Units

- Render output is 48 kHz WAV, mono or stereo as the instrument makes it. Engines that run at 44.1 kHz are converted with a band-limited resampler; `sourceSampleRate` in the result says which ran natively, and `conversionTrimDb` appears if conversion revealed peaks above -1 dBFS and they were trimmed.
- Processor times (`gestures`, `performance`) are seconds from the start of the input file.
- `atelier_notes` patterns use 48 ticks a beat and LMMS velocity (100 is a full MIDI velocity). Notes outside MIDI 12 to 119 are left out with a warning; use `transpose`.
