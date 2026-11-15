# Phrase library

A phrase is a short, tested musical figure that can be reused in any song: a chord progression, a piano montuno, a set of house stabs, an arpeggio, a bass line, a short hook, or a percussion groove.

The library grows in value as it is used. Each phrase keeps the listener's rating and a record of the songs it was used in, and `list_phrases` puts the best rated and least used phrases first. An agent that starts from the library writes fewer parts from scratch and repeats fewer mistakes.

## Tools

| Tool | Use |
| --- | --- |
| `list_phrases` | Browse by kind, role, instrument, style or words. Best rated first, then least used. |
| `get_phrase` | One phrase in full: notation, rating, where it was used, percussion sample files. |
| `create_from_phrases` | Build a whole project from a key, a progression, sections and parts. |
| `add_phrase` | Add one phrase to an existing project as a new track. Also a step for `apply_edits`. |
| `save_phrase` | Save a phrase to your own library: captured from a project track, or written in notation. |
| `rate_phrase` | Record a rating from 1 to 5 after someone has listened. |

## Three kinds

- **progression**: Roman numerals and a mode, for example `i bVII bVI V` in minor. Pass the id as `progression` to `create_from_phrases` and it is written out in your key.
- **harmonic**: any pitched figure. It is stored against the chord or the scale, never as fixed pitches, so it follows whatever chords it is placed over.
- **rhythm**: one step grid for each drum sound. Each sound becomes its own sample track.

## A song from phrases

```json
{
  "output": "andaluz.mmp", "bpm": 124, "key": "A minor", "progression": "prog-andalusian",
  "sections": [{ "name": "intro", "bars": 4 }, { "name": "main", "bars": 8 }, { "name": "break", "bars": 4 }],
  "soundFolder": "latin-perc",
  "parts": [
    { "phrase": "kit-kick-only", "sections": ["intro"] },
    { "phrase": "kit-house-sixteenths", "sections": ["main"] },
    { "phrase": "conga-tumbao" },
    { "phrase": "bass-tumbao-anchored", "name": "Bass", "sections": ["main"] },
    { "phrase": "piano-stabs-33322", "name": "Piano", "sections": ["main"] },
    { "phrase": "piano-montuno-fifth", "name": "Piano", "sections": ["break"] }
  ]
}
```

- Each section restarts the progression. Give a section its own `progression` for contrast.
- Pitched parts with the same `name` share one track, so the piano can play stabs in one section and a montuno in another.
- Percussion tracks are named after the sound (`Kick`, `Conga Open`). Two rhythm phrases can use the same drum in different sections, but not in the same one.
- `stretch: 2` plays a phrase at half speed. The montunos are written as one bar of sixteenths for house tempos. At salsa tempos, where the same figure is written as two bars of eighths, use `stretch: 2`.
- `variation` moves velocities a little, from a seed, so repeats are not identical.

## Phrase notation

A `line` is a list of events separated by `;`:

```text
step=tone+tone:length:velocity
0=5,+5:2:104; 2=r+3:1:82; 15=5,+5:1:100>
```

Step and length count grid steps (16 to a bar unless `stepsPerBar` says otherwise). A trailing `>` takes the tones from the chord one beat later. That is how a montuno or a tumbao bass arrives early on the next chord.

A `seq` is a run of tones, each `rate` steps long, with `-` for a rest. It repeats to fill the phrase. `accents` gives the velocities in turn.

| Tone | Meaning |
| --- | --- |
| `r` `3` `5` `7` `9` | Root, third, fifth, seventh and ninth of the chord sounding at that moment. The third follows the chord quality. On a plain triad the seventh becomes the octave. |
| `s1` to `s7` | Degrees of the key's scale, for tunes that follow the key and not the chords. |
| `~n` | n semitones above the chord root, for a note outside the chord. |
| `v` | The whole chord, voice-led from the previous chord. Use it for stabs. |
| `'` and `,` | Up and down an octave. |

The root of each chord is placed as near as possible to the root of the first chord, so a figure does not jump an octave when the chord changes.

## Percussion sounds

Every sound a shipped rhythm phrase uses has a stock LMMS sample as a stand-in, so the phrases work on a plain install. The stand-ins for congas, bongos, cowbell and guiro are toms, a woodblock and shakers, which are rough.

For real hand percussion, the shipped phrases name files from the [Versilian Community Sample Library](https://github.com/sgossner/VCSL) (CC0). Copy the files `get_phrase` lists for a conga phrase into one workspace folder and pass that folder as `soundFolder`. Two things matter when you copy them:

- The recordings are quiet, between -37 and -5 dBFS at the peak. Normalise each one, or the tracks cannot be made loud enough.
- Several start with about 8 ms of silence. Trim it, or the hits land late.

VCSL has no conga slap. The shipped phrases use a hard open quinto hit in its place.

To use any other sample, pass `sounds`, for example `{ "conga-open": { "sample": "kit/my-conga.wav" } }`.

## Your own phrases

`save_phrase` writes to `.lmms-phrases.json` in the workspace, next to ratings and the record of uses. Shipped phrases are never changed.

To capture a figure that worked, give the project, the track, the bars and the chords those bars were written over:

```json
{
  "id": "my-latin-riff", "name": "Latin riff from Andaluz", "kind": "harmonic", "styles": ["latin", "house"],
  "from": { "project": "andaluz.mmp", "trackName": "Piano", "startBar": 12, "bars": 2, "key": "A minor", "progression": "Am G" }
}
```

Chord tones are stored as `r`, `3`, `5` and `7`, and every other note as semitones above the root. The phrase then plays back exactly in the original key and follows the chords in any other.

## Limits

- 4/4 only, as in the rest of the server.
- The shipped phrases were written from knowledge of the styles and checked by test for rhythm, range and chord fit. Nobody had listened to them when they were added. Ratings are how the library learns which ones are good.
- Chord voicings are simple: root position near a fixed centre, or the server's voice-led chord for `v`. A pianist would vary them more.
- A phrase holds notes and velocities only. Timing feel beyond the grid, such as playing behind the beat, is not stored.
