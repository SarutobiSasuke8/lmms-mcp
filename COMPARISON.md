# LMMS MCP comparison

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
