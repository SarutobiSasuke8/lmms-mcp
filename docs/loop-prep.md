# Loop preparation for any audio file

`tools/loop-prep.mjs` turns a finished piece of music into files a game engine can loop. It works on any audio file in the workspace, not only LMMS renders: a song from Suno, a bounce from another DAW, or a render from this server. Songs from outside usually arrive with no loop points, uneven loudness and no manifest. These two tools add all three.

## Tools

### find_loop_points (read-only)

Input: `audio` (a workspace file, optionally one folder down), and optionally `bpm`, `beatsPerBar` (default 4), `minBars`, `maxBars` (default 1 to 64) and `count` (default 5).

It returns the tempo (bpm, a confidence from 0 to 1 and where it came from), the first beat, and up to `count` loop candidates. Each candidate gives:

- `startSeconds`, `endSeconds`, `startFrame`, `endFrame`, `lengthSeconds`, `lengthFrames`
- `bars` (the loop length in whole bars), `startBar` and `endBar` (counted from the first detected beat, which may not be a downbeat)
- `bpmFromLength`, the tempo implied by the exact loop length, which is usually more precise than the detected tempo
- `seamScore` from 0 to 1, with its parts: `continuation`, `spectrum` and `waveform`
- `intro` (whether audio comes before the loop) and `introSeconds`, and `afterLoopSeconds`

It also returns `needsHumanChoice` and `advice`. When the beat is unclear (tempo confidence below 0.3) or the best seam score is below 0.7, `needsHumanChoice` is true and the advice says a person should listen to the candidates and pick one. The tool does not hide this behind a confident-looking answer.

### prepare_loop

Input: the same `audio` and search options, an `outputDirectory` (it must not exist yet) and optionally a `name`. Choose the loop in one of three ways:

- `candidate`: a rank from `find_loop_points`, run with the same `bpm`, `beatsPerBar`, `minBars` and `maxBars`. The search is deterministic, so the ranks match.
- `startSeconds` and `endSeconds`: an exact region.
- Neither: the best candidate. If `find_loop_points` would say a person should pick, `prepare_loop` refuses, lists the candidates and writes nothing, unless `acceptLowConfidence` is true.

Options:

- `seam`: `crossfade` (default) or `fold`.
- `crossfadeMs` (default 50).
- `intro` (default true): write the audio before the loop as a separate one-shot.
- `targetLufs` and `ceilingDb`: one gain, worked out on the loop, is applied to the loop and the intro, with a look-ahead limiter under the ceiling. The loop is limited as a loop, so the gain is continuous across the seam.
- `ogg`: also write OGG Vorbis (needs ffmpeg).

It writes `<name>-loop.wav`, `<name>-intro.wav` when there is an intro, optional OGG copies, and `<name>.manifest.json`. Files keep the source sample rate and channel count and are written as 16-bit PCM WAV.

The manifest has the same shape as the one `export_game_audio` writes: a `loop` entry with start and end frames, an `intro` entry that names the file to play next, and a `files` list with role, frames, loop start and end frames, duration, integrated loudness, true peak, peak, clipped samples and SHA-256. It adds the `source` file, `bpm` (from the loop length), `detectedBpm`, `bpmConfidence`, `bpmSource`, the `seam` method and score, and the loop's position in the source (`sourceStartFrame`, `sourceEndFrame`).

The tool result also carries a `measured` block from `analyze`: loudness, true peak and the boundary jump between the last and first samples of the loop, plus the same plain-language warnings `analyze_audio` gives.

## Method

1. Decode. WAV is read directly at any common sample rate. MP3, OGG and FLAC, and WAV formats the built-in reader cannot handle, are decoded with ffmpeg (found on the path or through `LMMS_FFMPEG`). Without ffmpeg, those formats fail with a message that says so.
2. Short-time analysis. One pass of 21 ms Hann windows every 10 ms gives an onset envelope (spectral flux below 8 kHz) and, on 20 ms frames, the level of 16 bands from 40 Hz to 16 kHz.
3. Tempo. The onset envelope, less its local average, is autocorrelated. The strongest peak between 60 and 200 bpm, gently weighted towards 120 bpm to settle double and half tempo, gives the beat period. The period is then refined against its later multiples, up to 30 seconds out, which pins it far more precisely than a single peak. The beat phase is the offset whose grid collects the most onset energy. Confidence is how far the chosen peak stands above the median of the range. A `bpm` hint replaces detection.
4. Candidate lengths. Every whole number of bars up to 16, then multiples of four up to `maxBars`. For each length, the search tries small tempo deviations and every start on the beat grid, and scores how closely one bar of band levels after the loop start matches one bar after the loop end. If the loop ends at the end of the file, the bar before each point is used instead. Silence counts as no evidence, so a loop over silence never scores well. Among starts that are as good as the best, the earliest wins, so a repeated section begins where the repetition does and the audio before it becomes the intro.
5. Exact length. For the best few lengths, the audio after the loop start is correlated with the audio after the loop end, first on a 6 kHz copy over plus or minus 45 ms, then sample by sample. This gives the loop length to the sample when the music truly repeats.
6. Seam score. 50% bar-long continuation (step 4), 30% spectrum and 20% waveform similarity of the 50 ms after the loop start against the 50 ms after the loop end. Playing the loop, the listener hears the loop end followed by the loop start; in the original, the loop end ran on into what follows it, so these two windows should match. Candidates are ranked by seam score. Within 0.02 of each other the longer loop wins, because a longer loop repeats less often in game. The advice then says if the music also repeats at a shorter length.

### Seams

- Crossfade: the region is first moved by up to 4 ms, keeping its length, to a point where the signal is near zero and flat at both ends. If there is audio before the loop start, the last part of the loop fades, with equal-power gains (sine in, cosine out), into the audio that led up to the loop start in the original. The loop then ends on the exact sample that preceded its start, so the wrap is continuous, and the loop's first sample is untouched, so the intro-to-loop join is the original audio. If the loop starts at the top of the file, the first part of the loop instead fades in from the audio that follows the loop end. Equal-power fades keep the level steady when the two signals differ; when they are nearly identical the middle of the fade can be up to 3 dB louder for a few milliseconds.
- Fold: everything after the loop end is added back onto the loop start, as `export_game_audio` does with LMMS tails. This suits a file that ends with a ring-out after the last bar. If more than a few seconds of music follow the loop end, the tool warns, because folding music on top of music doubles it.

## Limits

- Free tempo: rubato, ambient or beatless music has no reliable grid. Confidence will be low and the tool will ask a person to pick, or take explicit `startSeconds` and `endSeconds`.
- Tempo changes: the beat grid assumes one tempo for the whole file. A loop inside a section with a different tempo may be found poorly or not at all; pass `bpm` for that section and narrow `minBars` and `maxBars`, or give explicit times.
- Long fade-outs: a song that fades out has no clean ending to fold. Pick a loop that ends before the fade and use the crossfade seam.
- Music that never repeats exactly: generated songs often vary each pass of a chorus. Scores will be lower than for a rendered loop, and the waveform part in particular will be low. The crossfade still makes a smooth seam, but listen to it.
- Metre: `beatsPerBar` is not detected. Bar numbers count from the first detected beat, which may fall on any beat of the bar.
- MP3 files carry encoder delay. ffmpeg removes it when the file says how much there is, but some encoders do not, which can shift positions by a few milliseconds. Loop lengths are unaffected.
- Very long files take a few seconds per minute of audio to search. Files are decoded fully into memory.

All checks are measurements. Nothing here listens to the result, so a person should hear the seam before the files ship.

## Rights

Checking that you have the right to use, edit and ship any audio you did not make yourself (including music from generators such as Suno, whose terms differ by plan) is your job, not the tool's. The tool result repeats this.

## Tests

- `tools/loop-prep.test.mjs` (run by `npm test`): tempo detection at three tempos, loop finding on synthetic songs with a non-repeating intro, a repeated phrase and a ring-out ending at 48 kHz and 44.1 kHz, the longest-equal-loop rule, refusal on beatless noise, exact length refinement, the equal-power crossfade maths and both crossfade directions, the quiet-point shift, and the ffmpeg error.
- `verify-loop-prep.mjs` (needs LMMS): builds a project with a two-bar intro, a four-bar section played twice and an ending, renders it with its tail, and checks over stdio that the loop length matches four bars to within 3 ms, that the prepared loop has a boundary jump below -40 dBFS and meets a -16 LUFS target, that checksums match and the intro joins the loop cleanly. It also checks fold with explicit times, a 44.1 kHz copy and an MP3 copy (when ffmpeg is installed), and that low confidence refuses to guess.
