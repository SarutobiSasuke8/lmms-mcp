# Composing without a model

`compose_piece` writes a whole arranged piece from a style and a seed. `compose_batch` writes several seeds, renders each one and ranks them by measured checks. Both are plain seeded code. An agent can call them once, and `lmms-compose` runs them from the command line with no agent at all.

## What a piece contains

- **Chords.** Eight-bar sections in an A A B A order, chosen from progression templates for the key's mode. Sections lead on with the dominant and the piece ends on the tonic.
- **Melody.** `write_melody` over the chords: one idea, a reply, a climax and a breath after every phrase. See [melody.md](melody.md).
- **Harmony.** `write_accompaniment` under the melody's register, plus a held pad in some styles.
- **Bass.** Roots, a pulse, octaves, a walking line or a syncopated figure, starting on the root at every chord change.
- **Drums.** A groove, a fill at the end of each phrase, a crash after it, and a quiet intro.
- **Form.** A two-bar intro without the lead, the body, and an ending that rests on the subdominant and settles on the tonic.

Every part follows the melody's phrase plan, so the band swells where the tune does.

## Styles

| Style | Tempo | Character |
| --- | --- | --- |
| `chiptune` | 140 | Square lead, fast arpeggios, tight beat |
| `adventure` | 118 | Singing lead over rolling chords |
| `battle` | 152 | Minor key, busy lead, octave bass |
| `ballad` | 76 | Simple tune over held arpeggios |
| `swing` | 126 | Laid-back tune, walking bass, ride pattern |

All styles use stock LMMS sounds, so they render on any install. Replace any part's sound with `voices`, and set `key`, `bpm` and `seconds` or `bars` yourself.

## Use

```json
{"tool": "compose_piece", "output": "theme.mmp", "style": "adventure", "seconds": 60, "seed": 4}
{"tool": "compose_batch", "name": "theme", "style": "adventure", "seconds": 60, "count": 8}
```

`compose_batch` writes `theme-s1.mmp` and `theme-s1.wav` and so on, mastered to -16 LUFS, and returns the ranking.

From a terminal:

```bash
lmms-compose --style chiptune --seconds 45 --count 6 --name chip
lmms-compose recipe.json
```

Files go to `LMMS_WORKSPACE`, or the current folder when it is not set. A recipe file holds the same fields as the flags.

## How the ranking works

Half of the score is the existing `quality_report` score: the arrangement lint plus mix warnings from the render. The other half is a tune score from the notes alone:

| Check | Points | Rewards |
| --- | --- | --- |
| Stepwise motion | 25 | Between 45% and 80% of moves are steps |
| One clear peak | 20 | The top note is heard once or twice, in the climax phrase |
| Range | 15 | Ten to twenty-one semitones |
| Breathing room | 15 | The tune sounds for 55% to 88% of the time |
| Rhythmic variety | 15 | Some bars repeat a rhythm and some do not |
| Few repeated notes | 10 | Under 18% of moves repeat a pitch |

The scores catch faults: a masked melody, a muddy mix, a tune that never rests. They cannot tell whether a tune is good. Use the ranking to decide what to listen to first, then choose by ear.

## The parts on their own

`writeProgression`, `writeBass` and `writeDrums` are exported from `tools/compose.mjs` for scripts. Bass styles: `roots`, `pulse`, `octaves`, `walking`, `syncopated`. Drum styles: `rock`, `four`, `halftime`, `ballad`, `chip`, `swing`, `none`.

## Limits

- 4/4 only. Chords change once or twice a bar.
- The stock sounds are simple synths. For better sound, render the project's MIDI through sampled instruments (see [sampler.md](sampler.md)).
- Rules give competent music. Taste still comes from a listener.
