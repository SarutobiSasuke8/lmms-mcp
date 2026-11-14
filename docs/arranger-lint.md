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

The field appears only when the lint finds an error or a warning. Missing roles on their own are reported by `lint_arrangement`, not on every save; when the field does appear it also lists tracks without a role. At most eight findings are listed, then a pointer to `lint_arrangement`. These checks never block on their own. Pass `strict: true` to any of those four tools to stop with an error, writing nothing, when the arrangement has errors.

The server keeps two hook lists for this, `postSave` and `exportChecks`, in the module context. See `tools/README.md` for the contract. A check that throws is reported as a non-blocking warning and the save goes ahead, even with `strict`.

## Roles

Every track should declare a role: drums, bass, harmony, lead, counter, texture or fx (`role` in `create_project` and `add_track`, or `set_track_role`). A track without a role gets one inferred from its notes, and a note asks for `set_track_role`:

| Behaviour | Inferred role |
| --- | --- |
| A sample track (or one with only notes of a sixteenth or shorter) using three or fewer pitches | drums |
| Half or more of its onsets are chords | harmony |
| Median pitch below MIDI 48 (C3) | bass |
| A melodic line (see below) in at least 30% of the bars where it plays, when it is the lowest pitched track, its median is below MIDI 55 (G3) and no bass is declared or inferred | bass (a walking bass in the tenor register) |
| Any other melodic line | lead, or counter when a lead is declared or a higher melodic track exists |
| Average note length of half a bar or more | harmony |
| Anything else | texture |

Role limits use declared roles only. The other rules use the declared role, or the inferred one.

A track plays in a bar for the role limits when a note starts in the bar, or a held note covers more than 48 ticks (one beat) of it. A short overhang from the previous bar does not count.

## Rules and thresholds

Bars count from zero. A bar is 192 ticks in 4/4. "Sounding in a bar" means a note overlaps the bar; "starting in a bar" means its onset is in the bar.

### Melodic voice

A track carries a melodic voice in a bar when, in that bar, it has at least 3 onsets, at least 3 different top pitches, at least 75% of its onsets are single notes, its median pitch is MIDI 48 or higher, it is not drums, and it is not a figure. A figure is an arpeggio or ostinato with evenly spaced onsets, either cycling with a period of up to 8 notes (at least two full cycles in the bar), or 6 or more onsets on 4 or fewer pitches (a broken chord). Two tracks with the same rhythm and the same melodic contour (a doubling in octaves, thirds or sixths) count as one voice.

Tracks declared drums, bass, harmony or texture, and tracks inferred as bass, never count as melodic voices, however they move: a walking bass or a busy arpeggio supports the melody. Tracks declared lead, counter or fx, and other unroled tracks, are judged by behaviour.

Because of the broken-chord test, an unroled motif that only spells a chord (for example C, Eb and G in even eighths) is inferred as texture. Declare it as lead to have the lead rules check it.

### Role limits

| Rule | Severity | Fires when |
| --- | --- | --- |
| `role.multiple-leads` | error | More than one declared lead plays in the same bar. Leads that double each other (same rhythm and contour, for example in octaves) count as one. |
| `role.multiple-counters` | warning | More than one declared counter plays in the same bar, with the same doubling rule. |
| `role.counter-without-lead` | warning | A declared counter plays in a bar with no declared lead playing within 4 bars either side. Call and response, where the counter answers while the lead rests, is fine. |
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
| `clash.harsh-interval` | warning; error only when a pair clashes on at least 4 strong beats and on more than 25% of the strong beats it shares | Two different pitched tracks sound a minor second or minor ninth (1 or 13 semitones apart) on a strong beat. Strong beats are the first and middle beat of the bar (the first only in odd metres). Drums and fx tracks are skipped. Intervals inside one track are allowed. A pitch class that one track already owns is not a clash: for a harmony track that is every pitch class it plays in the bar (so a pad and an arpeggio both spelling Fmaj7 do not clash), for other tracks it is the notes sounding on the beat. |
| `key.out-of-key` | warning above 10% of pitched note time; error above 25%, only when `key` was given | Notes fall outside the key. Note time is each note's length, capped at one bar. Minor keys allow the raised seventh. Supported modes: major, minor, dorian, phrygian, lydian, mixolydian and harmonic minor. Detection only tries major and minor, so a detected key never blocks: a D dorian vamp reads as D major, and the out-of-key B is a warning. Pass `key` to check a mode properly. |
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

The thresholds live in `thresholds` and `scoring` at the top of `tools/arranger-lint.mjs`. They were set so that a realistic arrangement (drums, a walking bass in the tenor register, an arpeggiated seventh-chord harmony, a held pad, one lead built from a repeated and varied motif, and a counter line that answers the lead and takes over while it rests) produces no errors and no warnings, with or without declared roles, and so that none of the built-in `create_composer_sketch` profiles produces an error. Those sketches do get `register.overlap` warnings, because their harmony pad sits inside the range of the motif.

## Limits

- Beat/Bassline tracks are not read; they are listed under `skipped`.
- Automation is ignored, so a part faded out by volume automation still counts.
- The lint judges bars on their own. A melody whose phrases cross bar lines is still judged bar by bar.
