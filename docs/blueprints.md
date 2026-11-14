# Blueprints and motif development

Agents given a blank page tend to write too many competing melodies and a new tune for every section. This module gives them a plan to fill in instead, and tools to develop one idea.

- `list_blueprints` lists tested plans for kinds of game music.
- `create_from_blueprint` writes a full editable project from one plan, with the lead built from a single motif.
- `develop_motif` returns variations of a motif as melody lines ready to paste into a pattern.

Code: `tools/motif.mjs` (motif operations and `develop_motif`), `tools/blueprints.mjs` (the arrangement engine and the two blueprint tools) and `tools/blueprints.json` (the plans, as data). Unit tests are in `tools/motif.test.mjs` and `tools/blueprints.test.mjs`; `verify-blueprints.mjs` checks every blueprint against the installed LMMS.

## A typical session

1. `list_blueprints` and pick the plan nearest the brief.
2. Write a one or two bar motif and a chord progression of your own.
3. `create_from_blueprint` with the blueprint, key, bpm, a length in seconds or bars, your motif and your progression.
4. `render_mix`, then `analyze_audio` with the returned `bpm` and `sections` (each has `startBar` and `bars`).
5. Change one section on one track with `replace_pattern` (bar = the section's `startBar`), or many with `apply_edits`. Use `develop_motif` to write new lead phrases from the same motif.

## develop_motif

Input: `motif` as a melody line (`D5:2 F5:2 A5:4 r:4`, the same `NOTE:steps` notation as a pattern `melody`), scale degrees (`1:2 3:2 5:4 r:4`, where `'` raises an octave and `,` lowers one), or raw notes in ticks; and a `key` such as `D minor`, `F# dorian`, `Bb major` or `C harmonic minor`. Supported modes: major, minor, dorian, phrygian, lydian, mixolydian and harmonic minor.

Notes outside the key are moved to the nearest scale tone first, and the result says how many were moved. Every operation then works in scale steps, so every result stays in the key.

| Operation | What it returns |
| --- | --- |
| `repeat` | The motif twice. |
| `sequence_up`, `sequence_down` | The statement, then the same shape a scale step higher or lower (`step` and `count` change this). |
| `fit_chord` | The motif moved by up to a fourth so its long, strong, first and last notes are tones of `chord`. |
| `invert` | Every interval mirrored around the first note. |
| `retrograde` | Notes and rhythm backwards. |
| `augment`, `diminish` | Lengths doubled or halved. |
| `rhythm` | The same notes in the same order, so the same contour, with a new rhythm in the same total length (`dotted`, `swap` or `even`). Rests stay where they are. |
| `fragment_first`, `fragment_last` | The first or last cell: the notes before or after the note boundary nearest the middle. |
| `call_response` | The statement, ending open on the 2nd or 5th, then an answer that keeps the opening, mirrors the second half and ends on the tonic. |
| `cadence`, `half_cadence` | The ending rewritten to land on the tonic or the 5th by step, with any trailing rest folded into the held last note. Pass `chord` (the chord under the last note) and the ending lands on a tone of that chord instead: the tonic or 5th when the chord has it, otherwise its most stable scale degree. |

Each variation comes back with its `line`, length in `steps` and `bars`, and lowest and highest note. Paste a line into a pattern as `melody: { line, repeat: false }`.

## What create_from_blueprint guarantees

- Every track gets a `role`, stored on the track as `mcp-role`.
- At most one lead and one counter-melody sound in any bar.
- Bass, harmony, texture and counter parts stay below the lead lane, so they never share the lead's register.
- No two pitched parts sound a semitone apart. Parts are settled in order (bass, harmony, texture, counter): a note that would clash moves an octave, or to the nearest chord tone in its lane, or is left out.
- Cadences and held endings land on a tone of the chord sounding under them.
- The counter-melody plays its own lines (answer, fragment) only where the lead rests; `guide` tones may sit under the lead.
- The lead is the motif: stated first, stated again, then varied by the plan (sequence, inversion, fragment, rhythm change, cadence and so on), with rests between phrases.
- The song length is pinned to the section total, and the result reports the exact duration in seconds.
- With no motif or progression given, the blueprint's own are used, written in scale degrees and Roman numerals so they work in any key.

These rules are asserted in `tools/blueprints.test.mjs` for every blueprint, across several keys, tempos, motifs and lengths. The tool also checks them before it writes the project.

### Inputs

| Field | Meaning |
| --- | --- |
| `blueprint` | One of the ids below. |
| `output` | Project file name. |
| `key` | Such as `E minor`. A bare tonic such as `G` keeps the blueprint's mode. |
| `bpm` | Tempo. Default: the blueprint's. |
| `lengthSeconds` or `lengthBars` | Target length. The nearest whole form is chosen: sections at half, normal or double length, the body repeated, or for short loops the intro and only the first body sections. Stingers only change section length. |
| `motif` | Your motif, in any octave; it is moved into the lead lane. One or two bars works best, within two octaves. A longer motif makes longer phrases, so a section has room for fewer of them: the plan keeps its first ops and its last op (so cadences and the stinger ending survive), and `planAdjustments` in the result says what changed. |
| `progression` | Main progression as chord symbols (`Em C G D`) or Roman numerals (`i VI III VII`). `:2` holds a chord for two bars; lengths must be whole sixteenth-note steps (`:0.5`, `:0.25`, at least `:0.0625`). |
| `contrastProgression` | Progression for the contrasting sections. Default: the blueprint's, in your key. |
| `sounds` | `default` uses the blueprint voices. `suggested` swaps pitched tracks for the best measured factory preset for their role. |

### Result

The save result plus: `key`, `bpm`, `lengthBars`, `lengthSeconds`, the requested length, the `form` used, the `motif` as placed in the lead lane, the `progressions`, the register `lanes`, the `sections` map (name, `startBar`, `bars`, start and end seconds, energy, roles playing and chords), the `leadPlan` (the operation and line for each lead phrase), the `tracks` (role, voice, volume, pan, lane and patterns), sound `suggestions` from the catalogue for each pitched track, the `phrases` (where each lead and counter op starts and ends, in ticks), `planAdjustments` when a long motif changed a plan, a `lengthWarning` when no form is near the requested length, and next steps.

## The blueprints

| id | Kind | Default key and tempo | Form (bars) |
| --- | --- | --- | --- |
| `overworld` | loop | D major, 128 | Intro 4, A 8, B 8, A2 8 |
| `battle` | loop | E minor, 160 | Intro 2, A 8, B 8, Breather 4, A2 8 |
| `boss` | loop | C phrygian, 150 | Intro 4, A 8, B 8, A2 8 |
| `town` | loop | F major, 96 | Intro 4, A 8, B 8, A2 8 |
| `dungeon` | loop | A phrygian, 84 | Intro 4, A 8, B 8, A2 8 (4-bar phrases) |
| `title` | loop | Eb major, 100 | Intro 4, A 8, B 8, A2 8 |
| `puzzle` | loop | C major, 92 | Intro 4, A 8, B 8, A2 8 |
| `chiptune` | loop | C major, 140 | Intro 2, A 8, B 8, A2 8 |
| `victory` | stinger | Bb major, 132 | Fanfare 2, Cadence 2 |

Loops play the intro once and then the body; when a longer length is asked for, the body is repeated and each repeat varies the lead plan (a `repeat` becomes a `rhythm` change, a sequence goes the other way, an inversion becomes a retrograde). A stinger is never repeated.

## The blueprint format

Blueprints are data in `tools/blueprints.json`. Add one by adding an object to `blueprints`; `npm test` then checks it against every rule above. Values in `defaults` apply when a blueprint leaves them out.

```json
{
  "id": "overworld",
  "name": "Overworld adventure",
  "kind": "loop",
  "use": "One sentence on when to use it.",
  "key": "D major", "bpm": 128,
  "phraseBars": 2, "harmonicRhythm": 1,
  "lanes": { "lead": [67, 88] },
  "motif": "1:2 3:2 5:4 6:2 5:2 3:4 2:2 3:2 1:4 r:8",
  "progressions": { "main": "I V vi IV", "contrast": "IV I ii V" },
  "tracks": [
    { "name": "Kick", "role": "drums", "drum": "kick", "voice": "sample", "factorySample": "drums/kick01.ogg", "volume": 52, "length": 96 },
    { "name": "Lead", "role": "lead", "voice": "pluck", "volume": 52, "prefer": ["bright"] },
    { "name": "Melody", "role": "lead", "voice": "preset", "preset": "Organic/puresine.xpf", "level": -15 }
  ],
  "drums": {
    "groove": { "kick": "X-----x-X-------", "snare": "----X-------X---", "crash": "start", "fills": { "snare": "----X---X-X-XxXX" } }
  },
  "intro": [ { "name": "Intro", "bars": 4, "energy": 1, "drums": "light", "bass": "whole", "harmony": "block", "texture": "arp", "lead": "rest" } ],
  "body": [ { "name": "A", "bars": 8, "energy": 2, "drums": "groove", "bass": "eighths", "harmony": "pulse", "lead": ["state", "repeat", "sequence_up", "half_cadence"] } ]
}
```

- `kind`: `loop` or `stinger`.
- `phraseBars`: the length of one lead phrase. Section lengths must be whole phrases. A motif longer than a phrase stretches the phrase; the last phrase in a section takes any bars left over.
- `harmonicRhythm`: bars per chord unless a chord says otherwise (`I:2`).
- `lanes`: MIDI note ranges per role. Bass, harmony, counter and texture lanes must span at least an octave and sit below the lead lane's lowest note. Defaults: bass 33-55, harmony 48-64, counter 53-65, texture 52-64, lead 67-88.
- `masterVolume`: the LMMS master volume. Default 66, which leaves headroom; the battle blueprint uses 58.
- `motif`: scale degrees 1 to 7 with `:steps`, `'` for an octave up, `,` for an octave down and `r` for a rest. It must fit in one phrase.
- `progressions`: named progressions in Roman numerals. Numerals count degrees of the key's own mode; upper case is major, lower case minor, `o` diminished, then optional `7`, `maj7`, `sus4` and so on; `b` or `#` is read against the major scale, as usual (in E minor `bVII` is D and `bIII` is G), and spells the chord with flats or sharps. `main` is used unless a section names another with `chords`. Default progressions must be diatonic to the blueprint key (the tests check this). If someone picks a key in another mode, the blueprint's numerals take that mode's chord qualities so the chords stay in the key; numerals passed in by the caller are read as written.
- `tracks`: `name`, `role` (drums, bass, harmony, lead, counter, texture), and a voice as in `create_project` (`pluck`, `bass`, `pad`, `sample` with `factorySample`, or `preset` with `preset`). Give `volume`, or for a preset a `level`: the target peak in dBFS for one note, turned into a volume from the measured catalogue. Drum tracks name their `drum` part and a note `length` in ticks. `prefer` lists catalogue tags that rank sound suggestions. A blueprint has exactly one lead track and at most one counter track.
- `drums`: named sets mapping a drum part to a 16-step grid for one bar (`X` accent, `x` hit, `o` soft, `g` ghost, `-` rest), or `"start"` for a single hit at the section start. `fills` replace a part's grid in the last bar of a section; a part with only a fill (no grid) plays just that bar.
- `intro`, `body` and an optional `outro`: lists of sections. Only the body repeats.

Each section has `name`, `bars`, `energy` (1 calm, 2 normal, 3 busy; it scales velocities and should match how much is playing) and the parts that play. A part plays only when its field is set:

| Field | Values |
| --- | --- |
| `drums` | A drum set name. |
| `bass` | `whole`, `half`, `quarters`, `eighths`, `octaves`, `syncopated`, `pedal` (tonic under every chord). |
| `harmony` | `block`, `pulse` (quarter-note chords), `stabs` (off-beat chords), `arp` (eighth-note broken chords), `hits` (one short chord per change). |
| `texture` | `arp` (sixteenth-note chord tones), `shimmer` (eighth-note chord tones), `drone` (tonic and fifth). |
| `lead` | `"rest"` or one op per phrase: `state`, `repeat`, `sequence_up`, `sequence_down`, `fit` (fit to the chord at the phrase start), `invert`, `retrograde`, `rhythm`, `augment`, `diminish`, `fragment`, `answer`, `cadence`, `half_cadence`, `hold` (one held note per chord: the tonic where the chord has it, so V then I plays the 5th then the tonic), `rest`. |
| `counter` | One op per phrase: `answer` (the motif's answer, best where the lead rests), `guide` (held chord thirds under the lead), `fragment` (the last cell, augmented), `rest`. |
| `chords` | Which named progression the section uses. Default `main`. |

## Sound suggestions

For each pitched track the tool ranks native factory presets from the measured catalogue (`sound-catalogue.json` plus anything `build_sound_catalogue` has measured) by role, measured level and the track's `prefer` tags. It keeps only pitched presets that are reliably tuned, neither very quiet nor very loud, skips slow-attack sounds for parts that play short notes, and prefers sustained sounds for parts that hold notes. Each suggestion carries a starting volume worked out from its measured level. With `sounds: "suggested"` the top pick replaces the track's voice; no two tracks share a preset.

## Verification

`node verify-blueprints.mjs` runs over stdio against the installed LMMS. It creates every blueprint at two tempos (one with the default sounds, one with suggested sounds and, for loops, an outside motif and key), renders each with `render_mix`, and checks:

- `lint_arrangement` finds no errors in the project (warnings are counted and printed);
- the rendered duration matches the reported length (LMMS renders whole frames per tick, so at some tempos the file is up to one tick, under a millisecond, short);
- no clipped samples;
- `analyze_audio` with the returned section map finds no silent section (every section above -45 dBFS RMS);
- the loudness range between sections is at most 14 LU, overall loudness is between -30 and -8 LUFS, and the busiest sections are not quieter than the calmest.
- the 2-6 kHz band is within 16 dB of the 500 Hz-2 kHz band, so the default sounds are not dull (the dungeon blueprint is the darkest by design and sits near this limit).

These are measurements. Nobody has listened to the results, so musical quality beyond these checks is not verified. Set `BLUEPRINTS=town,boss` to check only some blueprints.
