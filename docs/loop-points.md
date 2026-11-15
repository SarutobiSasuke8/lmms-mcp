# Loop points (`write_loop_points`)

Puts the loop start and end inside the audio file, so a game engine that reads loop metadata loops it without a separate manifest. The audio data is never changed.

## What is written

| File | Where | Fields |
| --- | --- | --- |
| WAV | `smpl` chunk, one forward loop, play count 0 (forever) | start frame, last frame (inclusive) |
| OGG Vorbis | comment header | `LOOPSTART`, `LOOPEND`, `LOOPLENGTH` (decimal sample frames) |
| Both | `<name>.loop.json` next to the file | frames, seconds, sample rate, channels, embedded fields, SHA-256 |

**End is exclusive.** `loopEnd` is the first frame after the loop, the same as `endFrame` in the manifests of `prepare_loop` and `export_game_audio`. `LOOPLENGTH = LOOPEND - LOOPSTART`. The WAV `smpl` chunk stores the inclusive last frame, so it holds `loopEnd - 1`. The sidecar spells out both.

Other WAV chunks and other Vorbis comments are kept. The OGG audio pages are copied unchanged (only their sequence numbers and CRCs are rewritten, because the comment header changes size). No ffmpeg is needed.

## Use

- One file, new copy: `audio: "loops/forest-loop.wav", output: "loops/forest-tagged.wav"`, optionally with `startFrame`/`endFrame` or `startSeconds`/`endSeconds`. With no loop given, the whole file loops, which is right for a loop made by `prepare_loop`.
- One file, in place: `inPlace: true`. Written through a temp file and renamed. Without `output` or `inPlace` the tool refuses, so a file is never overwritten by accident.
- A manifest: `manifest: "forest/forest.manifest.json"` tags the loop WAV and its OGG twin in place, using the manifest's loop region, then updates the manifest's checksum and adds a `loopPoints` block. An OGG that is a few frames shorter than its WAV (an encoder effect) has its loop end clamped, with a note.

## Checked, and not checked

Every write is read back from the bytes (the `smpl` chunk and the Vorbis comments) before the tool returns, and the tests parse real ffmpeg output and have ffmpeg decode the re-paged stream. Nothing here is played. Engines differ in which fields they read: Unity and FMOD read `smpl`; some players read `LOOPSTART` and `LOOPLENGTH`. Test in yours.

## Loop-join click check

`analyze_audio` and `prepare_loop` used to warn whenever the first and last samples differed by more than -30 dBFS. A loop that starts on a drum hit differs by a lot on purpose. The check now also compares the jump with how far the waveform itself moves between neighbouring samples in the first and last millisecond (`loop.boundaryStepDbfs`), and warns only when the jump is more than 6 dB above that. Reports without `boundaryStepDbfs` use the old rule.
