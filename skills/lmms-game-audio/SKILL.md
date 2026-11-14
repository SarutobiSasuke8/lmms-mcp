---
name: lmms-game-audio
description: Compose, mix, check and export game music and audio with LMMS MCP. Use for loops, adaptive layers, intros, stingers, synth and drum parts, stems, MIDI and one-shot packs.
---

# LMMS game audio

Call `get_started` to check the workspace and see which optional engines are configured. Inspect the tool schemas before the first edit or export.

- For a style brief, search `list_composer_profiles` by technique or game use. Create an editable seed with `create_composer_sketch`, then revise its motifs, harmony and arrangement for the scene.

Work in this order. Measure the result and audition it when playback is available.

1. **Plan the form.** Pick tempo, key and a bar count that gives the length you need (bars x 240 / BPM seconds). Name the sections and their bars.
2. **Choose sounds.** `search_sounds` with a `role` (bass, lead, pad, pluck, bell, drum) and words such as `bright` or `warm`. `list_samples` for stock drums and instruments. Audition with `preview_sound` and read the reported level and pitch.
3. **Write parts.** `create_project` with one lane each for drums, bass, harmony and melody. Use `steps` grids for drums, `chords` for harmony and bass, `melody` lines for tunes, and raw `notes` only where you need exact control. Give one-shot samples a note `length` that covers the sample (a crash needs about 150 ticks at 120 BPM). Presets are concert-tuned by default, so write the pitch you want to hear. Set `lengthBars` for an exact loop.
4. **Arrange.** `copy_bars` to repeat sections, `add_pattern` and `add_track` to extend, `replace_pattern` to vary. Thin the first and last bars so the loop point breathes.
5. **Mix in passes with `apply_edits`.** One call per pass: volumes and pans, then effects (`delay` with a note-value `time`, `reverb`, a `limiter` on `Master`), then automation. Keep effects on tracks, not Master, if you will export layers.
6. **Measure.** `render_stems`, then `analyze_audio` on stems and the mix with `sections` in bars. Balance from the numbers: kick and bass carry the low bands, the lead should sit a few dB above the pads, and no section should be silent or clipped. Act on the warnings. Ask for a `spectrogram` when you need to see the arrangement.
7. **Master and deliver.** `render_mix` with `tail: "wrap"` and `targetLufs: -16` for a single loop. `export_game_audio` for intro, loop, layers, stingers, OGG and the manifest. `export_one_shots` for sound effects. Hand over the MMP or MMPZ as the editable master, plus `export_midi` if the notes are wanted elsewhere.

Rules of thumb:

- A beat is 48 ticks and a 4/4 bar is 192. Bars start at zero. Stock drums play at original pitch on MIDI 69.
- Leave headroom before mastering: lower `set_master` until the raw mix peaks below -1 dBFS with no clipped samples.
- Stereo correlation under 0.2 in a section means it will thin out in mono. Narrow or lower the widest part.
- Report loudness, true peak, clipped samples and the loop seam with every delivery, and state that the result was checked by measurement.
- Fathom patches need `LMMS_FATHOM_WORKLET`. If `search_sounds` shows none, use native sounds.
