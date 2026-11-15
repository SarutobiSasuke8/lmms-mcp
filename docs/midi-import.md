# MIDI import and performance shaping

These tools take an existing score or a performance, make it an editable LMMS project, make it sound played rather than typed in, and finish the render.

| Tool | Use |
| --- | --- |
| `import_midi` | Turn a `.mid` file in the workspace into an LMMS project. |
| `shape_performance` | Add phrase dynamics, a voiced melody, small accents, ritardando and sustain pedal. Also a step for `apply_edits`. |
| `master_audio` | Trim the silence at the end of any WAV, fade it, and bring it to a loudness target. |

`render_vst3_stems` now renders up to 10 minutes and takes an optional `width`, `eq` and `reverb` for each track, so a sampled piano can play a whole piece in a room.

## What the import keeps

- **Notes**, at LMMS resolution: 48 ticks per beat. A note shorter than a tick becomes one tick.
- **Time signature and tempo.** The project uses the first time signature and, by default, the first tempo. The tool warns when the file changes either.
- **Sustain pedal.** LMMS patterns do not store controllers, so with `pedal: "bake"` (the default) each note is held while the pedal is down, and stops when the same pitch is struck again.
- **Volume changes.** With `volumeChanges: "fold"` (the default), channel volume (CC7) and expression (CC11) scale the note velocities, relative to the loudest setting in each track. Score exports often write hairpins this way.

Velocities use the LMMS scale, where 100 is MIDI velocity 127.

Each MIDI track with notes becomes one track with a single pattern for the whole piece. Use `merge` to put several tracks on one instrument, for example both hands of a piano.

### Timing

- `timing: "score"` (the default) keeps the written rhythm at a steady tempo. Use it for files exported from notation.
- `timing: "seconds"` keeps the real timing of a recorded performance, including tempo changes, at the tempo you choose. It cannot be combined with `form`.

### Repeats

Notation programs often export a repeat with two endings without playing it twice. `form` lays bars out in a new order. Bars are numbered from 1, ranges are inclusive, and a note belongs to the bar it starts in.

```json
{ "midi": "classics/satie-gymnopedie-1.mid", "output": "gymnopedie-1.mmp", "bpm": 66, "merge": "Piano",
  "form": [{"from": 1, "to": 31}, {"from": 32, "to": 39}, {"from": 1, "to": 31}, {"from": 40, "to": 47}] }
```

## Performance shaping

A score played exactly sounds mechanical. `shape_performance` changes velocities and timing the way a player would. Every effect has a strength, and 0 turns it off.

| Setting | Default | What it does |
| --- | --- | --- |
| `phrases` | none | Phrase lengths in bars, from the score. After them, `phraseBars` (default 4) is used. |
| `dynamics` | 0.25 | Velocity rises to a peak 60% of the way through each phrase, then falls. |
| `voicing` | 0.15 | The top note of each chord is played louder, inner notes softer, the bass a little louder. |
| `accent` | 0.06 | A small lean on the first beat of each bar. |
| `humanize` | 0.04 | Random velocity variation, the same for the same `seed`. |
| `rubato` | 0.12 | The last `ritBeats` beats of each phrase slow down, up to 12% at the phrase end. |
| `finalRitardando` | 0.4 | The last `finalBars` bars slow down more, up to 40%. |
| `melodyLead` | 1 tick | The rest of a chord sounds just after its top note. |
| `pedal` | none | A simulated sustain pedal: `bar`, `halfbar` or `beat`. |
| `velocityScale` | 1 | Overall touch. 0.8 plays 20% softer, which on a sampled piano also chooses a softer layer. |
| `velocityCeiling` | 100 | No note goes above this (100 is MIDI 127). |

Rubato moves notes and clips later, so the song gets a little longer. The tool reports the length before and after. Running it twice compounds the effect, so shape the imported project once and keep the original.

Phrase lengths matter most. Read them from the score where you can: a phrase usually ends on a long note or a cadence.

## A piano piece, end to end

1. `import_midi` with `merge: "Piano"` and any `form` for repeats.
2. `shape_performance` with the score's phrases, `pedal: "bar"` for most slow piano music, and `velocityScale` below 1 for quiet pieces.
3. `export_midi`.
4. `render_vst3_stems` with the `decent-sampler` instrument, a piano `.dspreset` from `convert_sfz`, a `reverb`, and `durationSeconds` a few seconds longer than the song for the reverb tail.
5. `master_audio` on the mix, for example to -18 LUFS for solo piano.

```json
{ "midi": "gymnopedie-1-performed.mid", "outputDirectory": "gymnopedie-1-render", "durationSeconds": 224,
  "tracks": [{ "track": "Piano", "name": "piano", "instrument": "decent-sampler", "dspreset": "splendid-piano.dspreset",
    "width": 0.55,
    "eq": [{ "type": "highpass", "hz": 35 }, { "type": "peak", "hz": 300, "db": -2, "q": 0.8 }, { "type": "highshelf", "hz": 3500, "db": 3 }],
    "reverb": { "wet": 0.14, "roomSize": 0.65, "damping": 0.5, "width": 0.8, "preDelayMs": 20 } }] }
```

Each track also takes `width` (0 is mono, 1 unchanged) and up to six `eq` bands, applied after the instrument and before the reverb. The Splendid Grand's samples are wide: at full width the mix measured a stereo correlation of 0.13 and thinned out in mono, and at 0.55 it measured 0.58. Pedalboard's reverb has a strong wet output, so keep `wet` around 0.1 to 0.2.

## Sources and rights

Only import music you are allowed to use. For older music, the composition and the edition are separate: a public-domain piece can be in a copyrighted modern edition or MIDI file. The [Mutopia Project](https://www.mutopiaproject.org/) lists the licence of each file. Keep the source and licence next to the file you import. This is not legal advice.

## Limits

- One time signature and one tempo per project.
- Controllers other than the sustain pedal, channel volume and expression are not kept.
- Notes outside MIDI 12 to 119 are dropped and counted.
- Timing has 48 ticks per beat, about 19 ms at 66 BPM, so very fine rubato is rounded.
