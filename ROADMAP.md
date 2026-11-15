# Roadmap

What is done, what is next and what is only an idea. Tool changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## 0.10.0, scores and real instruments

- [x] `import_midi`: MIDI scores into editable projects, with pedal, volume changes and `form` for repeats
- [x] `shape_performance`: phrase dynamics, voicing, accents, ritardando, pedal, melody lead, touch
- [x] `master_audio` for any workspace WAV
- [x] `render_vst3_stems`: 10 minute renders, per-track width, EQ, reverb and convolution `space` (room, hall, church, cathedral)
- [x] `convert_sfz` reads Salamander-style libraries; the Salamander Grand is the default piano, with string resonance and hammer release samples
- [ ] Sound library tags and filters: composer, era, genre, mood, game use, arrangement, licence (PR 34)
- [ ] Release 0.10.0 to npm and post the release note on mcprack.dev

## Next: sound polish

- [ ] Smooth tempo curves for rubato at finer than 48 ticks per beat, and longer important notes
- [ ] Recorded impulse responses of real churches and halls (for example OpenAIR, mostly CC BY), as `space` options with credits
- [ ] A mastering chain: EQ toward a reference with `compare_to_reference`, light glue compression, tape-style saturation, oversampled true-peak limiting and dither, fed by VST3 effect plugins (compressors, saturation, reverbs) hosted in `render_vst3_stems`, not only instrument plugins
- [ ] Close and room mic perspectives blended, where a library has both
- [ ] Pedal noise for libraries that trigger it from CC64
- [ ] Articulations from SFZ libraries: keyswitches, legato and vibrato in `convert_sfz` and render, so the sax is not limited to sustained notes

## Next: honest loops and clean renders

- [ ] `export_game_audio` must not report `seamless: true` when `analyze_audio` warns of a loop click (the battle loop got worse after export)
- [ ] Remove the DC offset from renders (about 0.027 to 0.029 on every render, which costs about 4 quality points)
- [ ] `sounds: "suggested"` must not pick a bass preset (for example TripleOscillator/PMFMFTWbass.xpf) for a lead
- [ ] A motif containing `8` should not give the misleading error `Motif note "1" is outside MIDI 12-119` (`1'` already works)
- [ ] `npx` should work when run inside the source checkout (it currently fails with `lmms-mcp: not found`)

## Next: real instruments on Linux and more libraries

- [ ] A Linux setup script for Decent Sampler, the pedalboard host and the open libraries, and the sampler and VST3 path run in CI on Linux, so this box and the VPS can render real instruments
- [ ] SoundFont (`.sf2`) support with no conversion step

## Next: arrangements of public-domain pieces

- [ ] A classical pipeline: search Mutopia per composer, keep public-domain and CC0 files, import, check bars and repeats, tag with source and licence
- [ ] Composer works libraries: each composer profile lists its imported pieces and themes, and `create_composer_sketch` can quote and develop them
- [ ] In the Hall of the Mountain King, orchestrated from the public-domain piano score with VSCO 2 CE: bassoon and pizzicato cellos and basses first, then strings, winds, brass and percussion in the build
- [ ] Chiptune arrangements: square-wave melody, fast chord arpeggios, triangle bass (an `arpeggiate` step)
- [ ] Dance arrangements: tempo up, house kit and bass from the phrase library, sidechain, DJ effects; a re-metering step for pieces in 3/4
- [ ] Game-sized exports per piece: loop points, OGG or Opus at 1 to 2.5 MB for a 3 to 4 minute piece

## Next: programmatic soundtrack flows

- [ ] A soundtrack recipe: one JSON file per game listing cues (menu, overworld, battle, victory stinger, game over, and the like). `lmms-compose soundtrack recipe.json` composes a batch per cue, keeps the best by score, and exports loops, stingers and intros plus one manifest the game loads
- [ ] One theme across moods: calm, explore and combat versions from the same motif and chords, usable as adaptive layers that line up bar-for-bar
- [ ] Real instruments in the batch: recipe voices can name a Decent Sampler `dspreset` or a SoundFont and program, so `lmms-compose` renders sampled versions directly, building on `render_vst3_stems` and `render_soundfont` (PR 38)
- [ ] Styles as data: move the styles in `compose.mjs` into JSON style files with a schema and validation, so a new genre is a data file. The existing five styles, and the reggae, dub and dubstep styles in PR 36, must keep identical output for the same seed
- [ ] A taste loop: audition-page ratings from `read_feedback` and `remember_taste` feed `compose_batch` ranking weights
- [ ] Learning from scores: extract progressions and phrases from imported public-domain MIDI into the phrase library, with source and licence tags
- [ ] Nightly VPS runs: a headless command that runs a list of soundtrack recipes and writes a dated listening page. Scheduling on the VPS is a host change and needs Alexei; the repo side is the command and its docs only

## Games that will use the music

- [ ] Rokumon Sudoku: a choice of calm classical tracks
- [ ] Rokumon Cat Café: café-style arrangements
- [ ] Direct game-engine delivery: `export_game_audio` writes adaptive layers with a manifest that Phaser and Godot can load, so intensity can switch without hand-wiring
- [ ] Headless batch scoring on the VPS: `lmms-compose` drafts candidate tracks per Rokumon game overnight, then favourites are picked on the audition page

## Ideas

- [ ] A browser sampler pad that works on an iPad
- [ ] Sitar, shamisen and mandolin libraries with clean licences
