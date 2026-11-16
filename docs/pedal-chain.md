# Atelier pedal chains

Set `LMMS_ATELIER_DSP` to an absolute checkout of Atelier DSP containing the pedalboard export, or link the private package locally. The tool loads the DSP on demand. The public package contains only the adapter.

Render a track with `render_stems` or export a dry WAV. Save an Atelier board preset as JSON and put it at the workspace root. For example:

```json
{
  "audio": "stems/lead.wav",
  "preset": "lead-board.json",
  "output": "lead-wet.wav",
  "wah": [{"seconds": 0, "value": 0.15}, {"seconds": 1.25, "value": 0.9}],
  "tailSeconds": 2,
  "outputGainDb": -6
}
```

Wah values run from heel (0) to toe (1). Points must be strictly increasing, and the preset must enable the wah. Automation interpolates between the points and holds the last value. The output keeps the input sample rate, is stereo and never overwrites an existing file. The report includes peak and clipped sample counts measured before 16-bit WAV encoding. Lower output gain if clips are reported. Browser tuner display and live looper transport are outside this tool.
