# Film and game score personas

Four archetypes described by sound, tempo, instruments, harmony and arrangement habits. None is named after, or imitates, a real composer, film or label.

| id | Tempo | Harmony | Signature |
| --- | --- | --- | --- |
| `action-score` | 90 to 140, default 132 | phrygian, natural minor | Low-string ostinato in short, short, long cells, hand drums with a tight kit, brass punches, a sustain-then-spiccato string contrast, a cutoff ending |
| `horror-suspense` | 40 to 80, default 60 | phrygian, locrian, chromatic clusters | Semitone clusters, silence the cue refuses to fill, a heart-beat drum that speeds up under a riser, scattered high tremolo and plucked ticks, no pay-off |
| `epic-fantasy` | 80 to 130, default 108 | dorian, mixolydian | A horn call, a harp figure, string pads, an ostinato bass, legato lines against staccato answers, a mixolydian lift, an open fifth to finish |
| `dark-synth-scifi` | 70 to 110, default 92 | phrygian, harmonic minor | A drone under a ladder-style filter sweep, a sequenced arpeggio, pulse bass, industrial hits, additive air |

Read one with `describe_persona`, filter with `list_personas { kind: "film" }`, or pass the id as `persona` to `compose_piece`. The persona fills tempo, key, progressions, voices and mix targets. Voices use the native fallbacks; the `signatureSounds` and `articulations` entries name the sampled or Atelier sounds a richer engine should use.

## Instruments and licences

The three orchestral personas name the open VSCO 2 CE library (CC0) by id, `vsco-2-ce`. Nothing from it is copied into this repository. `licences.json` records its source, author, licence, the licence file hash and the hash of every SFZ file the reference cues use. Install it by sparse checkout of the `SFZ` branch of `sgossner/VSCO-2-CE` into `LMMS_SAMPLE_LIBRARIES/VSCO-2-CE`. Please credit Versilian Studios and Sam Gossner when you release music made with it.

`dark-synth-scifi` names three Atelier engines (drone, arpeggio, air). They are not in this repository and no synth binary or factory preset is bundled; when Atelier is absent the native voices play.

The library has no choir, no sul ponticello and no col legno. The personas keep those colours in their briefs and the cues stand in with sustained strings (choir pads), tremolo strings (bridge-edge bowing) and pizzicato ticks (wood taps). That is a limit of the library, not a claim that it plays them.

## Articulations and keyswitches

Each `articulations` entry maps an articulation name to the keyswitch note in the library's own `*-KS.sfz` file: the string sections at C2 to D#2 (36 to 39), the cello section and contrabass at C6 upwards (84 and up), tuba at C6 and C#6, flute at C2 to D#2 and clarinet at C2 and C#2. The library has no marcato layer, so `marcato` points at the tuba staccato switch and is played as an accented staccato.

Live keyswitching depends on `lingxi-gw-20261115-21`: until `convert_sfz` writes the Decent Sampler `<midi>` block, the keyswitch files do not switch. The reference cues therefore load one library file per articulation (sustain, spiccato, staccato, tremolo, pizzicato) on separate tracks, with the same notes the keyswitched version would play.

## Reference cues and demos

`scripts/personas/persona-cues.mjs` builds a 30 to 60 second cue for each persona from its data and a seed, as plain notes with no LMMS needed. `scripts/personas/persona-demo.mjs` renders it:

```
node scripts/personas/persona-demo.mjs --persona action-score --workspace <folder>
node scripts/personas/persona-demo.mjs --persona all --mode native --workspace <folder>
```

- `native` uses stock LMMS voices, and filter automation for the synth persona. It needs only LMMS.
- `sampled` plays the same notes through Decent Sampler with VSCO 2 CE, then masters in LMMS. It needs `LMMS_VST3_PYTHON`, `LMMS_DECENT_SAMPLER_VST3` and `LMMS_SAMPLE_LIBRARIES`, and takes about four minutes a cue. Without them it reports a skip and carries on.

The report is measurement only. It lists integrated loudness, true peak, section levels and centroid, silences of a second or more, and checks for each signature: an ostinato that repeats at a beat or bar lag, a strip bar and a build in level, short notes that decay between onsets while sustained notes do not, silence and chroma clusters for horror, third colour for modal fantasy, spectral centroid movement and arpeggio onsets for sci-fi. A check says what the numbers show. It does not say the cue sounds good, and nobody has listened to these renders.

Audio is not committed. The demos are written to the folder you pass.
