# Changelog

Tool changes that can affect an agent's saved workflow are listed here. The layout follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). See [docs/releasing.md](docs/releasing.md) for the rules.

## Unreleased

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
