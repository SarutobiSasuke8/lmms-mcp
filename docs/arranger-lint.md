# Arrangement lint

Agents often write arrangements where every track plays its own busy melody. Nothing stopped that, because every track accepts a melody and nothing checked whether the parts make musical sense together. The arrangement lint reads the notes of a saved project and judges the arrangement before anything is rendered.

Module: `tools/arranger-lint.mjs`. Tests: `tools/arranger-lint.test.mjs` (`npm test`) and `verify-arranger-lint.mjs` (real LMMS over stdio).

## Tools

### lint_arrangement

Arguments: `project`, optional `key` (for example "D minor", "Dm", "F# major", "A dorian"; detected from the notes when omitted), optional `strict` (also fail on warnings).

Returns:

- `pass`: no errors (and, with `strict`, no warnings).
- `counts` of errors, warnings and notes.
- `key`: the key used, whether it was given or detected, and the detection confidence.
- `roles`: every track's role. Roles the track did not declare are marked `inferred`.
- `melodicVoicesPerBar`: how many independent melodies play in each bar.
- `motif`: for each lead, how many of its bars echo another bar (`relatedShare`) and how many bars are distinct (`uniqueShare`).
- `findings`: each with `rule`, `severity` (error, warning or note), `message`, `bars` (from zero), `tracks` and a one-sentence `fix`. Errors come first.
- `skipped`: Beat/Bassline tracks, which the lint does not read yet.

Muted tracks and muted patterns are ignored.

### quality_report

Arguments: `project`, optional `audio` (a workspace WAV rendered from the project, for example by `render_mix`), optional `key`, `loop` (check the audio as a loop), `targetLufs` and `threshold` (default 70).

The score starts at 100. Each finding costs 15 points for an error, 5 for a warning and 1 for a note, with at most 30 points lost to any one rule. Each audio warning from `analyze_audio` (clipping, true peak, mono compatibility, DC offset, muddy or thin balance, loop clicks, loudness off target) costs 4 points, at most 20 in total. Silent audio costs 40. The report passes when the score is at or above the threshold and there are no arrangement errors. `reasons` lists what cost points, largest first, and `verdict` says pass or fail in one sentence.

### Checks on save and export

`create_project`, `add_track`, `apply_edits` and `export_game_audio` run the lint on the document they are about to write or export. When it finds errors, warnings or tracks without a role, the result gains an `arrangement` field:

```json
{ "summary": "Arrangement: 3 errors, 7 warnings. Fix errors before export.", "blocking": true,
  "warnings": ["ERROR melody.competing: Up to 4 independent melodies play at once in bars 0-3 (...). Fix: Pick one lead ..."] }
```

At most eight findings are listed, then a pointer to `lint_arrangement`. These checks never block on their own. Pass `strict: true` to any of those four tools to stop with an error, writing nothing, when the arrangement has errors. A clean arrangement adds no field at all.

The server keeps two hook lists for this, `postSave` and `exportChecks`, in the module context. A check is `async (doc, { project }) => null | { summary, blocking, warnings }`; a check that throws is reported as a warning and never breaks the tool.

## Roles

Every track should declare a role: drums, bass, harmony, lead, counter, texture or fx (`role` in `create_project` and `add_track`, or `set_track_role`). A track without a role gets one inferred from its notes, and a note asks for `set_track_role`:

| Behaviour | Inferred role |
| --- | --- |
| A sample track (or one with only notes of a sixteenth or shorter) using three or fewer pitches | drums |
| Half or more of its onsets are chords | harmony |
| Median pitch below MIDI 48 (C3) | bass |
| A melodic line (see below) in at least 30% of the bars where it plays | lead, or counter when a lead is declared or a higher melodic track exists |
| Average note length of half a bar or more | harmony |
| Anything else | texture |

Role limits use declared roles only. The other rules use the declared role, or the inferred one.

## Rules and thresholds

Bars count from zero. A bar is 192 ticks in 4/4. "Sounding in a bar" means a note overlaps the bar; "starting in a bar" means its onset is in the bar.

### Melodic voice

A track carries a melodic voice in a bar when, in that bar, it has at least 3 onsets, at least 3 different top pitches, at least 75% of its onsets are single notes, its median pitch is MIDI 48 or higher, it is not drums, and it is not a figure. A figure is an arpeggio or ostinato: evenly spaced onsets cycling through four or fewer pitches. Two tracks with the same rhythm and the same melodic contour (a doubling in octaves, thirds or sixths) count as one voice.

### Role limits

| Rule | Severity | Fires when |
| --- | --- | --- |
| `role.multiple-leads` | error | More than one declared lead sounds in the same bar. |
| `role.multiple-counters` | warning | More than one declared counter sounds in the same bar. |
| `role.counter-without-lead` | warning | A declared counter sounds in a bar where no declared lead sounds. |
| `role.missing` | note | A track with notes has no role. The note names the inferred role. |

### Competing melodies

| Rule | Severity | Fires when |
| --- | --- | --- |
| `melody.competing` | error | More than 2 independent melodic voices play in the same bar, whatever roles the tracks declare. |

### Register

| Rule | Severity | Fires when |
| --- | --- | --- |
| `register.overlap` | warning | More than 60% of a harmony or counter track's sounding time in a bar lies inside the lead's pitch span (lowest to highest lead note) in that bar. |
| `register.lead-buried` | warning | The lead's median pitch in a bar is below the median pitch of the harmony tracks. |
| `register.bass-high` | warning | A bass track's median onset pitch in a bar is above MIDI 55 (G3), or any of its notes is above MIDI 67 (G4). |

### Clashes and key

| Rule | Severity | Fires when |
| --- | --- | --- |
| `clash.harsh-interval` | warning, or error when it happens on more than 25% of the strong beats the pair shares | Two different pitched tracks sound a minor second or minor ninth (1 or 13 semitones apart) on a strong beat. Strong beats are the first and middle beat of the bar (the first only in odd metres). Drums and fx tracks are skipped. Intervals inside one track are allowed. |
| `key.out-of-key` | warning above 10% of pitched note time, error above 25% | Notes fall outside the key. Note time is each note's length, capped at one bar. Minor keys allow the raised seventh. Supported modes: major, minor, dorian, phrygian, lydian, mixolydian and harmonic minor. |
| `key.unclear` | note | No key was given and the best detected key scores under 0.5 (Krumhansl-Kessler correlation). The out-of-key check is skipped; pass `key` to run it. |

### Density

| Rule | Severity | Fires when |
| --- | --- | --- |
| `density.crowded` | warning | More than 40 pitched notes start in one bar. |
| `density.too-many-parts` | warning | More than 6 pitched tracks sound in one bar. |
| `density.empty` | warning | Nothing sounds in a bar between the first and last bars that have sound. |
| `density.empty-edge` | note | Nothing sounds in bars at the start or end of the song. |
| `density.static` | warning | The same bar (every track's notes) repeats unchanged 8 or more times in a row. |
| `density.no-development` | note | The song is 16 bars or longer and is one block of 4 bars or fewer repeated throughout. |

### Motif

Each lead's bars with at least 2 onsets are compared. Two bars are alike by half rhythm (shared onset positions over all onset positions) and half intervals (matching steps between successive top notes over the longer list). A bar echoes another when they score 0.75 or more, so a transposed repeat or a repeat with a new ending counts.

| Rule | Severity | Fires when |
| --- | --- | --- |
| `motif.no-repetition` | warning | The lead has 4 or more such bars and fewer than 25% of them echo another bar. |
| `motif.only-repeats` | warning | The lead has 8 or more such bars and fewer than 20% of them are distinct. |

### Lead playability

| Rule | Severity | Fires when |
| --- | --- | --- |
| `lead.leap` | warning | The lead's top line jumps more than 12 semitones between successive onsets. |
| `lead.range` | warning | The lead spans more than 24 semitones over the song. |

## Tuning

The thresholds live in `thresholds` and `scoring` at the top of `tools/arranger-lint.mjs`. They were set so that a simple arrangement (drums, a bass line, pad chords, one lead built from a repeated and varied motif, and a sparse counter) produces no errors and no warnings, and so that none of the built-in `create_composer_sketch` profiles produces an error. Those sketches do get `register.overlap` warnings, because their harmony pad sits inside the range of the motif.

## Limits

- Beat/Bassline tracks are not read; they are listed under `skipped`.
- Automation is ignored, so a part faded out by volume automation still counts.
- The lint judges bars on their own. A melody whose phrases cross bar lines is still judged bar by bar.
