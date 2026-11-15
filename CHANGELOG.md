# Changelog

Tool changes that can affect an agent's saved workflow are listed here. The layout follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). See [docs/releasing.md](docs/releasing.md) for the rules.

## Unreleased

### Added

- Groove engine tools: `apply_groove` (MPC swing, UKG, house, amapiano, half-time), `humanize` (seeded timing/velocity), `add_ghost_notes`, `add_fills`, `layer_drums`. Deterministic. Operate on note arrays.
- `arrangement_plan` generates bar-aligned section maps (intro/build/drop/breakdown/outro) with energy and role hints for house, techno, DnB and UKG. `energy_curve` extracts the envelope. Deterministic.
- Add optional `render_pedal_chain` for stereo WAV effects, saved Atelier board presets and timed wah sweeps.

- Add a local visual Mix Desk to the library server, with looping, insert effects, sample picker, and session and WAV saves.
- Add optional `render_atelier` and `render_theremin` stereo instrument stem tools.
- Time-stretch WAV loops and chop drum breaks with sixteenth-note or transient slicing, pattern sequencing and a slice manifest.
- `lmms-compose nightly` renders and ranks soundtrack cues unattended and builds dated audition pages.
- `scale_lock`, `arpeggiate` and `note_probability`: edits (and `apply_edits` steps) that snap a track to a named scale, turn chords into arpeggios, and drop or vary notes by seeded chance. Drum tracks are skipped unless named.
- SoundFont rendering: `list_soundfonts` and `render_soundfont` drive FluidSynth to render a workspace MIDI through a `.sf2` or `.sf3` into a WAV. Configurable via `LMMS_FLUIDSYNTH` and optional `LMMS_SOUNDFONTS`. See docs/soundfont.md.
- `write_loop_points`: write loop start and end into a WAV (`smpl` chunk) or OGG (`LOOPSTART`, `LOOPEND`, `LOOPLENGTH`) with a `.loop.json` sidecar, or tag a `prepare_loop` manifest's files in place.
- Add optional `groovebox_pattern`, `render_groovebox` and `load_pad_kit` tools for locally installed Atelier DSP.

- `render_vst3_stems` takes a `space` for each track: a convolution reverb from a synthetic impulse response of a room, hall, church or cathedral, with its level measured against the dry sound and its own stereo width.
- `convert_sfz` applies controller modulation at the default values (`*_onccN` for envelopes, volume, pan, tuning, offset and velocity tracking) with the standard SFZ curves, so the Salamander Grand gets its intended 73% velocity tracking and 1 second release. With `keepReleases`, release samples become Decent Sampler release groups that play when a note ends.
- `render_vst3_stems` takes per track `noteMap` (move notes to the keys a kit uses, for example drums exported at note 69), `transpose`, `noteRange`, and `normalise` (peak target in dBFS). The result gains `warnings` for notes outside the preset's range. New `cleanupLogs` deletes the Decent Sampler log files a render wrote in `~/.config/DecentSampler` on Linux. See [docs/linux-real-instruments.md](docs/linux-real-instruments.md).
- `setup-vst3-linux.sh` sets up the VST3 host on Linux x86_64: an isolated Python environment, plug-ins from a verified download or a local `.vst3` folder, and `mcp-env.json`.
- `sampler/check_real_plugin.py`: an optional check that renders sound through a real Decent Sampler, and skips when none is configured.

### Changed

- `render_vst3_stems` raises the `gainDb` limit from +12 to +36 dB, scales its time allowance with the track count and length (never below the old 590 s, `LMMS_VST3_TIMEOUT_SECONDS` to override) and starts plug-ins with `initialization_timeout=3`.
- `ceilingDb` on `render_mix`, `export_game_audio` and the DJ tools is a true-peak ceiling: the limiter measures 4x oversampled peaks, so -1 gives about -1 dBTP instead of -0.3 dBTP. The mastering report adds `truePeakDbfs`.
- On Linux the VST3 worker loads the `.vst3` bundle folder even when the setting points at the binary inside it, and LMMS presets and samples are also looked up in `../share/lmms` and `/usr/share/lmms`.
- `list_external_tools` gives setup text for the platform it runs on. The Python 3.12 pin is gone from the Windows setup script.
- `setup-libraries-windows.ps1` fetches the Salamander Grand Piano (CC BY 3.0, about 720 MB) as the default piano. The Splendid Grand is still available with `-Only splendid`.

### Fixed

- Decent Sampler no longer renders silence after a preset is set: the worker polls the plug-in's state until the new preset is applied (Decent Sampler applies it on a background thread) before it plays the sound check.
- Loops that start with a drum hit are no longer flagged as clicking at the loop join. `analyze` reports `loop.boundaryStepDbfs`, and the warning fires only when the join jumps more than 6 dB above the step between neighbouring samples.
- VST3 stem rendering aligns one-frame rounding differences to the requested length and reports malformed or silent output separately.

## 0.9.1 - 2026-11-15

No tool changes. Every 0.9.0 tool keeps its name and its required arguments.

### Added

- `build_timeline_page`: one HTML page that shows a song as a DAW would, with each stem as a lane under a bar ruler, sections and DJ effects as blocks, synced playback with mute and solo, section looping, and notes pinned to bars that can be copied back. The library page links each track to its timeline.
- `tag_sound` and `list_tagged`: metadata for workspace sounds and finished pieces (title, composer, era, genre, mood, game use, arrangement, instrumentation, length, loop, source, licence, credits, date) kept in a `<name>.meta.json` sidecar shared by every format of the same name, checked on write and searchable by any field. See [docs/sound-library.md](docs/sound-library.md).

- Reggae, dub and dubstep styles for `compose_piece`: off-beat `skank` and `bubble` accompaniment with an optional dub `echo`, `reggae`, `sub` and `wobble` bass, `onedrop`, `rockers`, `steppers` and `dubstep` drums, a drop-out under the dub solo and a siren track.

### Changed

- `build_library_page` lists tagged renders as finished pieces, adds filters for composer, era, genre, mood, game use, arrangement and licence, shows credits, the source link and the `<name>.source.md` note, and reads the length of OGG renders. Pages with no metadata are unchanged.
- `library-server.mjs` serves `.md` files as text.

### Changed

- `compose_piece` now plans a form to fit the length: theme, contrast, a solo that opens by quoting the theme, a varied return and an ending, with the accompaniment, bass and drums changing from section to section. Its result gains `form` and `structure`, and each section has a `kind`. `compose_batch` ranks with a structure check. New accompaniment style `held`.

### Fixed

- `convert_sfz` now follows `#include` written in the middle of a line, keeps the default keyswitch articulation, and skips controller-triggered and unplayable regions. The Salamander grand piano converts with all 16 velocity layers instead of one sample.
- Decent Sampler renders wait until the samples have loaded, so the start of a render is no longer silent with large libraries.

### Fixed

- `npx -y @sarutobi-sasuke/lmms-mcp` now installs this package on Node.js 20. The `engines` field required Node.js 22 even though the server does not, so npm fell back to the empty `0.0.0` placeholder and failed with "could not determine executable to run".
- The published tarball no longer includes Python `__pycache__` or `.pyc` files generated by the sampler tests during the release job.

### Compatibility

- Requires Node.js 20 or newer (previously documented as 22). Stock LMMS 1.2.2 on Windows x64, with Linux rendering checked in CI. The VST3 and sampler route is tested on Windows x64 only.

## 0.9.0 - 2026-11-15

No breaking changes. Every 0.8.1 tool keeps its name and its required arguments.

### Added

- `import_midi`: a standard MIDI file becomes an editable LMMS project, with its time signature and tempo, sustain pedal baked into note lengths, volume changes folded into velocities, merged tracks and `form` to unfold repeats.
- `shape_performance`: phrase dynamics, melody voicing, metric accents, ritardando at phrase ends and the final bars, a simulated sustain pedal, melody lead and seeded variation. Also a step for `apply_edits`.
- `master_audio`: trim, fade and master any workspace WAV to a loudness target.
- `render_vst3_stems` takes an optional `width`, `eq` and `reverb` for each track.
- `live_set_parameters`: set exposed native controls in an open LMMS project by model ID (live bridge, Windows).
- `build_library_page` and `build_library_previews`: one self-contained HTML page that lists every factory preset, stock sample, workspace sound and library phrase with filters and audio previews, plus `library-server.mjs` to serve it so the browser can play files from disk.
- `write_solo`: a solo line for one instrument over chords, split into short and long notes so a staccato and a sustained sound can play the same part.
- `list_dj_effects`, `dj_effects` and `rearrange_audio`: DJ effects (filter sweep, phaser, flanger, beat repeat, gate, tape stop, spinback, echo out, scratch, reverse and more) applied to a rendered WAV at bar positions, and DJ-style re-ordering of a render by bar ranges.
- `write_melody` and `write_accompaniment`: phrase-based melodies with one recurring idea, a breath after each phrase, a single climax and shaped dynamics, plus a matching backing part.
- `compose_piece` and `compose_batch`: whole arranged pieces from a style and a seed (chords, melody, harmony, bass, drums, intro and ending), rendered and ranked by measured checks. Five starter styles: chiptune, adventure, battle, ballad, swing.
- `lmms-compose`, a command that composes, renders and ranks pieces with no AI agent.
- Phrase library: `list_phrases`, `get_phrase`, `create_from_phrases`, `add_phrase`, `save_phrase` and `rate_phrase`. Ships 68 phrases (progressions, piano montunos, stabs and arpeggios, bass lines, hooks, trumpet section figures, and conga, clave, cowbell, whistle and house kit grooves) that fit any key, with listener ratings and a record of uses kept in `.lmms-phrases.json`.

### Changed

- `render_vst3_stems` renders up to 600 seconds instead of 120.

### Compatibility

- Same as 0.8.1: stock LMMS 1.2.2 and Node.js 22 on Windows x64, with Linux rendering checked in CI. The VST3 and sampler route is tested on Windows x64 only.

## 0.8.1 - 2026-11-14

No tool changes.

### Added

- Added the npm release workflow for `@sarutobi-sasuke/lmms-mcp`. This version was never tagged or published: the package first reached npm as 0.9.0.

### Compatibility

- Same as 0.8.0: stock LMMS 1.2.2 and Node.js 22 on Windows x64, with Linux rendering checked in CI. The VST3 and sampler route is tested on Windows x64 only.
## 0.8.0 - 2026-11-14

No breaking changes. Every 0.7.0 tool keeps its name and its required arguments.

### Added

- External VST3 instruments: `list_external_tools` and `render_vst3_stems` render MIDI exports through Decent Sampler and Surge XT, with `setup-vst3-windows.ps1` for a pinned portable install (#6).
- Sampled instruments: `convert_sfz` turns an open SFZ library into a Decent Sampler preset, `render_vst3_stems` takes a `dspreset` per track with no editor step, and `setup-libraries-windows.ps1` fetches a piano, upright bass, saxophone and jazz drum kit. New optional variable `LMMS_SAMPLE_LIBRARIES` (#16).
- Feature modules load from `tools/`, and tracks can carry a role with `set_track_role` (#8, #10).
- `lint_arrangement` and `quality_report` check an arrangement and a render (#11).
- `build_audition_page`, `read_feedback`, `remember_taste` and `get_taste` collect a listener's notes (#12).
- `find_loop_points` and `prepare_loop` make a seamless loop from any audio file (#13).
- `auto_balance` and `compare_to_reference` set levels by measurement (#14).
- `list_blueprints`, `create_from_blueprint` and `develop_motif` start a piece from a form (#15).
- CI on Windows and Linux: unit tests, a server start-up check, a tool schema diff on pull requests and an LMMS render job (#9).

### Changed

- `create_project`, `add_track`, `apply_edits` and `export_game_audio` take a new optional `strict` argument for the save and export checks. The `tracks`, `track` and `edits` schemas gained optional fields (#8, #11).
- `render_vst3_stems` allows up to 590 seconds, because sample libraries load slowly (#16).

### Compatibility

- Tested with stock LMMS 1.2.2 and Node.js 22 on Windows x64. CI also renders on Linux with the LMMS AppImage.
- The VST3 and sampler route is tested on Windows x64 only, with Decent Sampler 1.42.1 and Python 3.12. The preset loader depends on that version's plug-in state layout.
- The saxophone library fetched by the setup script is CC BY 4.0 and needs attribution. No samples ship in this package.
