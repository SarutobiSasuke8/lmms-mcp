# Composing without a model

`compose_piece` writes a whole arranged piece from a style and a seed. `compose_batch` writes several seeds, renders each one and ranks them by measured checks. Both are plain seeded code. An agent can call them once, and `lmms-compose` runs them from the command line with no agent at all.

## What a piece contains

- **Chords.** Eight-bar sections in an A A B A order, chosen from progression templates for the key's mode. Sections lead on with the dominant and the piece ends on the tonic.
- **Melody.** `write_melody` over the chords: one idea, a reply, a climax and a breath after every phrase. See [melody.md](melody.md).
- **Harmony.** `write_accompaniment` under the melody's register, plus a held pad in some styles.
- **Bass.** Roots, a pulse, octaves, a walking line or a syncopated figure, starting on the root at every chord change.
- **Drums.** A groove, a fill at the end of each phrase, a crash after it, and a quiet intro.
- **Form.** Chosen to fit the length. A short piece states its theme and restates it. From about a minute it adds a solo, and longer pieces add a contrasting section, a second statement of the theme and a bridge. See the table below.

Every part follows the melody's phrase plan, so the band swells where the tune does.

## Form

| Bars | Form |
| --- | --- |
| 8 to 13 | theme, ending |
| 14 to 18 | intro, theme, return, ending |
| 19 to 22 | intro, theme, solo, return, ending |
| 23 to 26 | intro, theme, solo (8 bars), return, ending |
| 27 to 38 | intro, theme, contrast, solo, return, ending |
| 39 and up | the theme is stated twice, the solo stretches to 16 bars, and a bridge comes before the return |

- **Theme.** The melody writer's tune. When it is stated twice, a quiet second voice sits under the long notes the second time.
- **Contrast and bridge.** Another chord progression and new material from the same idea: the reply rhythm leads and the contour turns over.
- **Solo.** Over the theme's chords. It opens by quoting the first two bars of the theme, then `write_solo` takes over: busier, wider, rising to its own peak, with a breath before the return.
- **Return.** The theme again, now cadencing home, with a second voice under its last phrase.
- **The band follows.** The accompaniment changes pattern in the contrast, drops to one held chord a bar under the solo and is fuller in the return. The pad waits for the contrast. The bass gets busier under the solo. A snare build leads into the return and a crash marks each new section.

`compose_piece` returns the form, the sections and a structure check. The check warns when a section has the same chords and nearly the same rhythm and density as the one before it, or when a long piece has no solo or no contrast. `compose_batch` takes six points off for each warning.

## Styles

| Style | Tempo | Character |
| --- | --- | --- |
| `chiptune` | 140 | Square lead, fast arpeggios, tight beat |
| `adventure` | 118 | Singing lead over rolling chords |
| `battle` | 152 | Minor key, busy lead, octave bass |
| `ballad` | 76 | Simple tune over held arpeggios |
| `swing` | 126 | Laid-back tune, walking bass, ride pattern |
| `reggae` | 78 | Horn tune, off-beat guitar skank, bubbling organ, heavy melodic bass, one-drop beat |
| `dub` | 72 | Steppers drums, sub bass, skank with fading echoes, chords dropping out under the solo, a siren |
| `dubstep` | 140 | Half-time drums, retriggered wobble bass, held chords, a siren into each drop |

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

`writeProgression`, `writeBass` and `writeDrums` are exported from `tools/compose.mjs` for scripts. Bass styles: `roots`, `pulse`, `octaves`, `walking`, `syncopated`, `reggae`, `sub`, `wobble`. Drum styles: `rock`, `four`, `halftime`, `ballad`, `chip`, `onedrop`, `rockers`, `steppers`, `dubstep`, `swing`, `none`.

## Reggae, dub and dubstep

- **Skank and bubble.** `write_accompaniment` has two off-beat styles. `skank` plays a short chord on every off-beat, as a reggae guitar or piano does. `bubble` adds quiet low notes either side, as a reggae organ does. Neither plays on the beat: that belongs to the bass and drums.
- **Dub echo.** `echo` repeats the last off-beat chord of each bar on dotted eighths, fading each time. It is written as notes, so it works with any sound and survives a render through sampled instruments.
- **Drums.** `onedrop` puts the kick and the rim together on beat three and leaves beat one empty. `rockers` adds a kick on one, `steppers` plays four to the bar. `dubstep` is half-time at 140: kick on one, snare on three.
- **Bass.** `reggae` plays the root, leaves space, then answers with a short figure. `sub` holds one long low note. `wobble` retriggers the root at a rate that changes every half bar. It stands in for a filter wobble; for the real thing, automate the filter cutoff of the bass track with `automate_track`.
- **Drop-out and siren.** In `dub` the chords fall away under the solo, leaving one echoing chord, the bass and the drums. `dub` and `dubstep` add a siren track that rises in the bar before the solo and the return.
- The stock sounds are a synth trumpet, a plucked synth for the skank and a synth organ. For real instruments, render through a sampled trumpet, clean guitar, drawbar organ and electric bass.

## Limits

- 4/4 only. Chords change once or twice a bar.
- The stock sounds are simple synths. For better sound, render the project's MIDI through sampled instruments (see [sampler.md](sampler.md)).
- Rules give competent music. Taste still comes from a listener.
