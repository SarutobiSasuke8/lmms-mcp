# Groove tools

`apply_groove`, `humanize`, `add_ghost_notes`, `add_fills` and `layer_drums` accept note arrays with `tick`, `length` (48 ticks per beat), `midi` and `velocity` (1 to 127). Seeded operations repeat exactly. `humanize` converts milliseconds using `bpm`, with kick and snare kept tighter.

Pass `output: "groove.mmp"` and `bpm` to save an editable LMMS project plus `groove.mid`. Existing files are refused. Without output, calls retain the existing note-array response for further editing. MIDI uses channel 10 for percussion. Every pitch gets its own LMMS track. Unmapped voices use stock drum previews. To use custom kits, pass `kitSamples: [{midi: 36, file: "drums/kick.wav"}]` from a kit prepared by `build_kit`; this mapping does not copy or fetch assets.

`apply_groove` supports named templates, `swingPercent` from 50 (straight) to 75, and `template: "midi"` with a workspace `referenceMidi`. Extraction measures the mean deviation from each sixteenth in a repeating bar, normalising source PPQ to 48. It measures timing only, not velocities. `strength` from 0 to 1 scales the deviation. Tempo changes in reference MIDI are not interpreted as a tempo map; the groove is in score ticks.

Example: `humanize({notes: [{tick: 12, midi: 42, velocity: 80, length: 6}], bpm: 174, timingMs: 8, seed: 17, output: "hats.mmp"})`.
