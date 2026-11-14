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
