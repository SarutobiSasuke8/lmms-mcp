# Mix Desk

1. Set `LMMS_WORKSPACE` to your audio workspace and start `node library-server.mjs`.
2. Open `http://127.0.0.1:18290/mix-desk/` in Chrome or Edge. Rebuild your library page with `build_library_page` to add **Mix Desk** and per-sample **Add to desk** links.
3. Load audio with **Samples**, or add a sample from the library page. The desk opens it on the first free channel. File formats must be decodable by your browser. The picker uses the existing library metadata and facet names.

Adjust the 8 channel faders, pans, mute and solo from the mixer. Choose a channel to trim or reverse its buffer, switch between loop and one-shot, and apply half or double speed. Insert effects support bypass, wet/dry, and mouse or keyboard reordering. Reverb and delay sends feed independent buses. The master has EQ, glue compression, output width and a sample-peak ceiling. Its momentary LUFS display estimates K-weighted loudness over roughly 400 ms. Use `analyze_audio` after exporting for integrated LUFS and true-peak measurements.

For recording, choose **Mic / line** or capture an existing channel or the master output. Connect your USB interface before opening **Devices & MIDI**. Choose the browser's input and output devices. Output selection depends on `AudioContext.setSinkId` support. Assign an interface input number and gain per channel. The meter shows clipping near full scale. **Monitor** routes the selected live input through the channel rack at interactive latency. Start with low output gain and use headphones to avoid feedback.

For round-trip latency, turn monitors off and connect the selected interface output to its input. **Measure loopback** plays a short low-level probe, measures the return and fills the recording compensation offset. Enter a manual offset if the device cannot be looped back. Compensation affects interface input recordings.

The chromatic tuner reads the selected interface channel. The guitar inserts are gate, clean/crunch/lead amps and a synthetic cabinet. The mic insert combines high-pass filtering, de-essing and compression.

Select **Use MIDI synth** on a channel and **Connect MIDI** under **Devices & MIDI** to play it. In **MIDI learn**, select a control and move a controller or press a key. Mappings persist in the session. MIDI clock is outside this build. Press **Record** to capture the configured bar count. If playback is running, capture starts at the next bar. Enable **Overdub** to mix into the current loop, or **Undo** to restore the previous take. Capture stays in memory until saved. The desk requests microphone access only when you choose to record from the interface.

**Save take** and **Save mix to library** create a WAV and a `lmms-mcp-meta/1` sidecar with the corresponding kind and the supplied tags. The sidecar uses the desk's own-recording label. You are responsible for sampling permission and attribution on any source you imported. **Export WAV** downloads a master render of the configured loop length with a 2-second effects tail. The workspace session file stores controls and source URLs. Save captured takes first so the session can reopen them. Session and recording names are exclusive so an existing file is preserved.

The desk's native Web Audio effects and local worklets run without external packages. An instrument source can carry `{ "type": "instrument", "id": "example" }` in a session. Future integrations can attach the corresponding async AudioBuffer renderer with `attachInstrument(id, renderer)`; the desk reports missing adapters. The server binds to loopback and serves files within its configured mount roots.
