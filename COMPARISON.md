# LMMS MCP comparison

## Live parameter writes on Ninja Bomber

On Windows with LMMS 1.2.2 and Jx9x `5e6f57b`, both MCPs wrote the same two native controls on a disposable copy of the Ninja Bomber arp arrangement. The LMMS filter cutoff went from 3400 to 1350 Hz and Delay feedback went from 35% to 65%. Each path started from the same values, returned identical readback and produced identical saved MMP content. Independently rendered WAVs differed at the PCM level. Our adapter rejected a stale project token and the bridge rejected an out-of-range batch without applying the valid entry. This verifies the shared bridge's native write path for these controls.

14 November 2026. Windows x64, Node.js 22, Python 3.12 and stock LMMS 1.2.2. The project was a disposable copy of Fuse Run Club with 6 instrument tracks, 2 mixer buses and 2 automation lanes.

| Check | This server 0.3.0 | ZipseLu e57d9fe | Jx9x 5e6f57b |
| --- | --- | --- | --- |
| Move an instrument clip and render through LMMS | Passed through stdio. Edits write a new project copy. | Passed through stdio. The render tool saved changes to the loaded copy before rendering. | Live clip editing is documented. This comparison tested transport. |
| Export MIDI and track audio | Reopened the exported MIDI and checked pitch and timing against the source. Exported 6 stereo WAV stems at 48 kHz, each aligned to the 30-second mix. | No MIDI or stem tool appeared in the 52-tool catalogue returned by the tested checkout. | MIDI and solo-based track export are documented. Export comparison remains open. |
| Seek to tick 96, play, pause and stop | Passed using the opt-in adapter to the Jx9x plugin. | Saved-project editing and headless rendering are the documented workflow. | Passed through its own MCP on the same LMMS session. |
| Track Delay | Added Delay, changed its wet mix, bypassed and removed it. Active and bypassed renders differed. | Offers a broader documented effect catalogue. Effects were outside this test. | Documents live effect editing. Effects were outside this test. |

The live session used LMMS's dummy audio device. Transport state was verified, and the upstream playback cap marked the session modified when it reduced the master level. The upstream build's pinned libsamplerate archive was recovered from a mirror and matched the original SHA-256.

Run `node verify-exports.mjs` on Windows with LMMS installed to reproduce the saved-project checks. A source MMP path can be supplied. The comparison covers the cases above. Broader mixer and effect coverage, Beat/Bassline and sample clip editing, live editing and comparable export tests against Jx9x remain open.

[ZipseLu source](https://github.com/ZipseLu/lmms-mcp/tree/e57d9fe) · [Jx9x source](https://github.com/Jx9x/lmms-mcp-bridge/tree/5e6f57b)

## Follow-up on exports and live edits

Both servers exported 404 MIDI notes on 6 tracks from Fuse Run Club. Jx9x uses the instrument base-note offset, which moved the AnalogBell part down an octave relative to the written part. Our new playback-pitch option matched all 404 Jx9x pitches. The written-pitch mode remains available. Our 480 PPQ export represents LMMS's 48 ticks per beat exactly. Compared with Jx9x's 128 PPQ export, the largest measured event or duration difference was 0.00521 beats. The Jx9x file omitted the metre event. This comparison did not treat either tool's velocity scaling as a reference.

Both produced 6 non-silent 30-second stereo WAV stems at 48 kHz. Our saved-project export did so in one call. With Jx9x we soloed, rendered, polled and restored each track in a disposable live session. This verifies alignment and duration. The renders use different settings and can differ in level and waveform.

Our adapter changed a live track name and clip name, replaced a clip's notes and bypassed a Delay at 35% wet. Arrangement and note readback confirmed the changes, and a stale project token was rejected.

For Beat/Bassline parity, both servers exported the same pitches and onsets for 16 kick and 16 clap steps in Jx9x's crunk-demo fixture, plus 56 melodic notes. Ours emitted quarter-beat gates for the drum steps. Jx9x's native export produced longer gates on that fixture. Saved-project MIDI currently requires non-overlapping Beat/Bassline clips within each arrangement track.

Both servers created a native automation track, linked a clip to Bass volume and read back linear points at tick 0 / 40% and tick 48 / 72% after an upsert. Our adapter also loaded an AnalogBell preset and a one-shot Ogg into newly created live tracks. Jx9x retains broader native parameter discovery, automation binding and live arrangement controls.

## v0.5.0 and sound catalogue

v0.5.0 adds stock instrument discovery and swapping, batch game one-shot processing, and a Fathom Synth offline render with editable LMMS source notes. The catalogue branch adds searchable patch selection and audition WAVs for supported factory presets and Fathom patches.

We have verified the stock LMMS workflow, including the Fathom ladder sweep and aligned stems, on Windows. Jx9x documents broader live parameter editing and additional audio formats. ZipseLu documents broader saved-project editing for sample clips, effects and newer LMMS instruments. Those workflows need equivalent fixtures and current-version tests before making an overall ranking.

## v0.6.0 sample clips and live discovery

Tested on Windows with stock LMMS 1.2.2, Jx9x `5e6f57b` and ZipseLu `e57d9fe`. Each MCP received the same saved project and source WAV for each fixture. The fixtures were a two-track 120 BPM project and the eight-bar Ninja Bomber source arrangement.

- All three placed the sample at tick 192, moved it to tick 384, saved it at 192 ticks long, then removed it. Our saved output and Jx9x's native save used `sampletco`. ZipseLu used `sampleclip`. Stock LMMS 1.2.2 rendered all three. The minimal project's audio at the moved position peaked at −15.2 dBFS in each render.
- Our live adapter and Jx9x returned identical parameter records for song, track, instrument and mixer targets. The queried targets returned 303 records on the first fixture and 606 on Ninja Bomber, with possible overlap between target scopes. Our adapter rejected a stale project token. ZipseLu's tool list had no live parameter discovery command.
- Our saved-project tests additionally covered duplication, mute, resize, source relinking and MMPZ round-trip. Jx9x still offers live writes by native model ID and broader live effect and track editing.

## v0.7.0 game-audio suite and a survey of other servers

14 November 2026. v0.7.0 adds composing input (step grids, melody lines, chord progressions), stock samples and ZynAddSubFX patches, concert-tuned presets, effects with parameters on tracks and mixer channels, batch edits, audio analysis with a spectrogram, loop-safe and loudness-mastered renders, parallel stems, and a game export with intro, loop, layers, stingers and a manifest. `verify-game-audio.mjs` checks each of these through stdio against stock LMMS 1.2.2 on Windows.

The table below comes from reading the other servers' READMEs and source listings on the same day. We did not install or run them for this survey, so treat each cell as what the project documents, not as a test result. The earlier sections of this file record what we did run against ZipseLu and Jx9x.

| Capability | This server 0.7.0 | [ZipseLu](https://github.com/ZipseLu/lmms-mcp) | [Jx9x](https://github.com/Jx9x/lmms-mcp-bridge) | [struktured-labs](https://github.com/struktured-labs/lmms-mcp-server) |
| --- | --- | --- | --- | --- |
| Analysis the agent can read | LUFS, true peak, bands, pitch, stereo, seam, spectrogram image | None listed | Peak and RMS on render status | Spectrum bands and centroid, voice pitch; no LUFS or spectrogram listed |
| Loop-safe render, intro and loop split, layers, manifest | Yes | OGG render only | Tail seconds and OGG; no loop fold, stems or manifest listed | OGG and bar-range render |
| Effects with parameters, master chain | Nine effect types with ranges, on tracks and mixer channels | 18 effect types, wet and enabled only | Live effect and mixer updates; depth not confirmed | Free-form effect parameters on tracks; no mixer or master listed |
| Batch edits | Any edits, all-or-nothing, one save | Notes only | Notes and pattern placement | Notes list only |
| Composing input above raw notes | Step grids, melody lines, chord progressions with voice leading | Scale generator | None listed | Chord by root and type, drum step strings |
| Sound browsing | Stock samples, native and ZynAddSubFX presets, measured role and level tags, audition | ZynAddSubFX preset list | Preset and sample lists with search | General MIDI patch table, SoundFont tools |
| Live session control | Through the Jx9x bridge | No | Yes, its core strength | No |
| MIDI export, stems | Both | Neither listed | MIDI export | Neither listed |
| Automated tests | 13 unit tests and two LMMS scripts; no CI yet | One test file | Offline and live suites | 12 test files and GitHub Actions |

Two more public repositories exist and were set aside: one is a self-described stub that returns fixed values, and one offers six read-only tools.

Where others are ahead, as documented: struktured-labs has SoundFont tools, sung or hummed audio to notes, project versioning, automation helpers and CI. ZipseLu covers more LMMS instruments and effect types, including VST through VeSTige and LMMS 1.3 instruments. Jx9x controls a running session natively. This server has no SoundFont tracks, no CI and no macOS or Linux test pass yet.

Not confirmed by reading: Jx9x's full tool count and effect parameter depth, struktured-labs' reverb and delay parameter names, and whether any project's tests pass.

## Refresh, 15 November 2026: main after the composing, solo, DJ and library work

Source: `main` at `67994ac` (npm 0.8.1 plus the unreleased changes in the changelog). Our column comes from running the code: `npm test` passed 188 of 188 and the server started over stdio and listed **76 tools**. CI runs on Windows and Linux with a separate LMMS render job, so the "no CI yet" line in the v0.7.0 table is out of date. The competitor columns are still reading, not running. We re-checked the three repositories on this date: ZipseLu's last commit is `e57d9fe` (21 August), Jx9x's is `5e6f57b` (23 October) and struktured-labs' is from 18 January. None has moved since the v0.7.0 survey, so those cells stand. A fourth repository, hamilto8/lmms_mcp, is empty.

What was added since v0.7.0, and what none of the three others documents:

| Capability | This server (main) | Others, as documented |
| --- | --- | --- |
| Whole pieces from a seed | `compose_piece` and `compose_batch` write chords, melody, harmony, bass, drums, intro and ending in five styles, render, and rank by measured checks. `lmms-compose` does the same with no agent | None listed |
| Melody and solo writing | `write_melody` (one recurring idea, breaths, one climax), `write_accompaniment`, `write_solo`, `develop_motif` | ZipseLu has a scale generator. struktured-labs has chord and drum-string input. No phrase-level writer listed |
| Composer profiles | `list_composer_profiles` and `create_composer_sketch` start a piece from a named technique (Grieg, Satie, Debussy, Bach and others) | None listed |
| Phrase library | 68 key-agnostic phrases, with listener ratings and a use history | None listed |
| Checks that gate a result | `lint_arrangement`, `quality_report`, `auto_balance` and `compare_to_reference` set and judge levels by measurement | struktured-labs has spectrum and pitch readback only |
| Game delivery | `export_game_audio` (intro, loop, layers, stingers, manifest), `find_loop_points`, `prepare_loop` | OGG or bar-range render at best |
| DJ processing | `dj_effects` and `rearrange_audio` on a rendered WAV | None listed |
| Listener loop | `build_audition_page`, `read_feedback`, `remember_taste`, `get_taste` | None listed |
| Sound browsing | `build_library_page` and `build_library_previews`: one page of every preset, sample and phrase with audio previews | List and search tools only |
| Sampled instruments | `convert_sfz` and `render_vst3_stems` through Decent Sampler and Surge XT (Windows x64 only) | ZipseLu documents VeSTige and VST. struktured-labs has SoundFont tools |

### Where the claim is weaker than the table

- **No musical-quality evidence yet.** We measure loudness, balance, loop seams and structure. We have not run a blind comparison of composer-profile output against a plain prompt, so "better music" is not claimed. The audition page exists to collect that evidence.
- **Notation is phrase and line notation only.** The server reads its own `NOTE:steps` lines and phrase notation. It does not read or write MusicXML, ABC or LilyPond.
- **Narrow platform.** Stock LMMS 1.2.2 and Node.js 22. Windows is the tested target, Linux renders in CI, and the sampler route is Windows only. There is no macOS pass.
- **Others still lead in places.** Jx9x controls a running LMMS session natively and we depend on its bridge for that. ZipseLu covers more instruments and 18 effect types against our nine. struktured-labs has SoundFont tracks, sung or hummed audio to notes and project versioning.
- **No public traction.** On 15 November the repositories show 5 stars (ZipseLu), 2 (struktured-labs) and 0 each for Jx9x and this one. The strongest claim the evidence supports is about documented scope and tested behaviour, not adoption.

Reproduce the counts with `npm test`, and with a stdio client calling `tools/list` against `server.mjs`.
