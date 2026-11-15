# Phrase-based melodies

`write_melody` writes a tune the way a player would shape one. A melody made by walking a scale has correct notes and no idea behind it. This tool starts from one short idea and builds the piece from it.

## What it does

- **One idea.** A one-bar rhythm and contour (the motif) and a contrasting reply bar. Both come back through the piece, so the tune can be remembered.
- **Phrases.** Every phrase (four bars by default) is idea, reply, idea again a step away, then an ending. Each ending is followed by a rest, so the line breathes.
- **Roles.** Phrases state, answer, develop and close. Statements end open, on a chord tone that is not the root. Answers end settled. The last phrase ends on the tonic.
- **One climax.** The register rises phrase by phrase to a single climax about two thirds of the way through. That phrase develops the idea: it breaks it into fragments, climbs with them to the highest note and comes back down.
- **Harmony.** Notes on strong beats and long notes take chord tones. The notes between keep the contour inside the key. Leaps wider than a sixth are folded back.
- **Dynamics.** Velocity swells to the peak of each phrase and tapers at its end, leans on the beat, and is higher in the climax phrase. Set `dynamics` to 0 for flat velocities.
- **Touch.** Notes inside a phrase are joined, the note before a rest is shorter, and `swing` sits slightly behind the beat. `ornament` adds a grace note on the peak and on a few long notes.

Everything is seeded. The same seed gives the same tune, and a new seed gives a new one.

## Use

```json
{"tool": "write_melody", "key": "F major", "bars": 16, "style": "lyrical", "seed": 7,
 "chords": ["Fmaj7", "C", "Dm7", "Bbmaj7", "F", "Am7", "Gm7 C7", "F"]}
```

The result has a `pattern` of raw notes for `create_project` or `add_pattern`, the `motif`, and the `plan`: one entry per phrase with its role, its lift in scale steps and which one is the climax.

Chords are one entry per bar and loop to fill the piece. `"Gm7 C7"` splits a bar in two. Styles are `lyrical` (singing lines), `driving` (busier, shorter notes) and `swing` (triplet feel).

`write_accompaniment` writes a backing part over the same chords: `arpeggio` (eighths), `flowing` (sixteenths), `broken` (quarters) or `block` (held chords). The bass note of every bar is the chord root, and with `pedal` each note rings until the chord changes. Pass the melody's `plan` and it swells where the melody does.

To give two instruments the same idea, pass the `motif` from the first call to the second with another seed and range.

## Limits

- 4/4 only, and chord symbols are the ones `resolve_chords` knows.
- It writes notes and velocities. Slides, vibrato and breath noise depend on the instrument that plays them.
- A good plan is not a good tune by itself. Listen, keep the seeds that work and use `develop_motif` to vary them by hand.
