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
- [ ] A mastering chain: EQ toward a reference with `compare_to_reference`, light glue compression, tape-style saturation, oversampled true-peak limiting and dither
- [ ] Close and room mic perspectives blended, where a library has both
- [ ] Pedal noise for libraries that trigger it from CC64

## Next: arrangements of public-domain pieces

- [ ] A classical pipeline: search Mutopia per composer, keep public-domain and CC0 files, import, check bars and repeats, tag with source and licence
- [ ] Composer works libraries: each composer profile lists its imported pieces and themes, and `create_composer_sketch` can quote and develop them
- [ ] In the Hall of the Mountain King, orchestrated from the public-domain piano score with VSCO 2 CE: bassoon and pizzicato cellos and basses first, then strings, winds, brass and percussion in the build
- [ ] Chiptune arrangements: square-wave melody, fast chord arpeggios, triangle bass (an `arpeggiate` step)
- [ ] Dance arrangements: tempo up, house kit and bass from the phrase library, sidechain, DJ effects; a re-metering step for pieces in 3/4
- [ ] Game-sized exports per piece: loop points, OGG or Opus at 1 to 2.5 MB for a 3 to 4 minute piece

## Games that will use the music

- [ ] Rokumon Sudoku: a choice of calm classical tracks
- [ ] Rokumon Cat Café: café-style arrangements

## Ideas

- [ ] A browser sampler pad that works on an iPad
- [ ] Sitar, shamisen and mandolin libraries with clean licences
