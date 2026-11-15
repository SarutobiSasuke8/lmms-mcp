# Scale lock, arpeggios and note probability

Three small edits that change the notes of a track. Each works as a tool and as a step in `apply_edits`. They skip drum tracks unless you name the track.

## scale_lock

Snaps notes to a key and scale so nothing sounds out of key. Notes already in the scale never move.

- `root`: the key note, such as `D`, `F#` or `Bb`.
- `scale`: `major`, `natural-minor`, `harmonic-minor`, `melodic-minor`, `dorian`, `phrygian`, `lydian`, `mixolydian`, `locrian`, `major-pentatonic`, `minor-pentatonic`, `blues`, `whole-tone` or `chromatic`. `minor`, `ionian` and `aeolian` also work.
- `policy`: `nearest` (closest scale note, a tie goes down), `down` or `up`.
- `strong`: `all` snaps every note, `beat` only notes that start on a beat, `bar` only notes that start a bar. Other notes are left as they are, which keeps passing notes and blue notes between the strong beats.

The result counts the notes examined, how many were outside the scale, how many moved, and by how many semitones.

```json
{"tool": "scale_lock", "project": "level-1", "root": "D", "scale": "dorian", "strong": "beat"}
```

## arpeggiate

Turns chords (by default three or more notes starting on the same tick) into arpeggios.

- `pattern`: `up`, `down`, `updown`, `broken` (low, top, next, top, as in an Alberti bass) or `random` (seeded, and every note plays once before any repeats).
- `rate`: ticks between notes. 192 is a whole note, 48 a quarter, 24 an eighth, 12 a sixteenth.
- `gate`: the fraction of each step the note sounds.
- `octaves`: how many octaves the arpeggio climbs through, 1 to 3.
- `minNotes`: the smallest group treated as a chord. Use 2 to arpeggiate dyads.

Each chord keeps its start and its length, and each pitch keeps its own velocity. Every pitch plays at least once when the chord is long enough for that many steps. The result reports `shortChords` when it is not. A clip is lengthened if the arpeggio needs more room. Lone notes are left alone.

## note_probability

Gives a part small, repeatable variation. Each note has a chance of being dropped and its velocity moves a little.

- `dropChance`: 0 to 0.9.
- `velocityVariation`: up or down by up to this fraction.
- `protectDownbeats`: when set (the default), notes that start a bar are never dropped.
- `seed`: the same seed gives the same result. Each clip uses the seed plus its order in the project, so two clips of the same loop differ.

At least one note in each clip always survives.

## Checks

None of these can be judged by ear here. The tests prove that notes land in the scale, that seeded results repeat, that arpeggios keep every chord pitch and stay inside the chord, and that drums are untouched. Whether the result sounds good needs a listen, for example through the audition page.

Pure logic is in `tools/scale-lock.mjs` (`lockScale`, `snapNote`, `arpeggiate`, `noteProbability`), tested by `tools/scale-lock.test.mjs`.
