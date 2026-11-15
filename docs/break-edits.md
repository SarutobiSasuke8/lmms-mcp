# Stretch and chop breaks

`time_stretch` takes a workspace WAV, its source BPM and the target BPM.
It changes the tempo via FFmpeg's pitch-preserving
[`atempo` filter](https://ffmpeg.org/ffmpeg-filters.html#atempo), then fits
the result to the exact frame count. It accepts tempo ratios from 0.25 to 4.
Set `LMMS_FFMPEG` if FFmpeg is outside PATH.

`chop_break` stretches the break and then cuts it at the target-tempo
sixteenth grid or its detected transients. The grid starts at frame 0, so
trim leading silence before using grid mode. Patterns accept 1-based slice
numbers separated by commas or spaces. `"1 3 2 2"` plays slice 1, slice 3 and
slice 2 twice in succession. The lengths can differ in transient mode.
Short edge fades reduce clicks. Inputs and outputs are WAV.

```json
{
  "audio": "break.wav",
  "sourceBpm": 126,
  "targetBpm": 174,
  "mode": "sixteenth",
  "pattern": "1 2 3 4 2 2 4 3",
  "outputDirectory": "remix"
}
```

The new output directory contains the individual slices, `sequence.wav`
and `manifest.json` with offsets and playback order.
