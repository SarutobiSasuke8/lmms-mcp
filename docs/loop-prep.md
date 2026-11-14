# Loop preparation for any audio file

`tools/loop-prep.mjs` turns a finished piece of music into files a game engine can loop. It works on any audio file in the workspace, not only LMMS renders: a song from Suno, a bounce from another DAW, or a render from this server. Songs from outside usually arrive with no loop points, uneven loudness and no manifest. These two tools add all three.

## Tools

### find_loop_points (read-only)

Input: `audio` (a workspace file, optionally one folder down), and optionally `bpm`, `beatsPerBar` (default 4), `minBars`, `maxBars` (default 1 to 64) and `count` (default 5).

It returns the tempo (bpm, a confidence from 0 to 1, where it came from, and any plausible half or double tempo in `alternatives`), the first beat, and up to `count` loop candidates. Each candidate gives:

- `startSeconds`, `endSeconds`, `startFrame`, `endFrame`, `lengthSeconds`, `lengthFrames`
- `bars` (the loop length in whole bars at `barsAtBpm`), `startBar` and `endBar` (counted from the first detected beat, which may not be a downbeat), and `tempoReading` (`half` or `double`) when the candidate comes from the other tempo reading
- `bpmFromLength`, the tempo implied by the exact loop length, which is usually more precise than the detected tempo
- `lengthFrom`: `repeat match` when the length was matched sample by sample, or `beat grid` when the repeats were too loose to match and the length is whole bars of the detected tempo
- `repeatCorrelation`, how closely the matched audio lines up (0 to 1)
- `seamScore` from 0 to 1, with its parts: `continuation`, `spectrum` and `waveform`, and `judgedFrom` (after the seam, or before it for a loop that ends at the end of the file)
- `intro` (whether audio comes before the loop) and `introSeconds`, and `afterLoopSeconds`

It also returns `needsHumanChoice` and `advice`. When the beat is unclear (tempo confidence below 0.3) or the best seam score is below 0.7, `needsHumanChoice` is true and the advice says a person should listen to the candidates and pick one. The advice also says when the tempo may be half or double, when the best length came from the beat grid, and when the music repeats at a shorter length too. The tool does not hide any of this behind a confident-looking answer.

Ranks are the same whatever `count` you ask for, and the same in `prepare_loop` for the same search options.

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

The manifest has the same shape as the one `export_game_audio` writes: a `loop` entry with start and end frames, an `intro` entry that names the file to play next, and a `files` list with role, frames, loop start and end frames, duration, integrated loudness, true peak, peak, clipped samples and SHA-256. It adds the `source` file, `bpm` (from the loop length), `detectedBpm`, `bpmConfidence`, `bpmSource`, `tempoAlternatives` when half or double tempo is plausible, the `seam` method, fade shape and score, and the loop's position in the source (`sourceStartFrame`, `sourceEndFrame`).

`loop.seamless` is only true when it is: a seam was actually built (not a plain cut, and not a fold with nothing to fold), the seam score is at least 0.7, the first and last samples are within -30 dBFS of each other, and `acceptLowConfidence` did not override a doubt. Otherwise it is false and `loop.seamIssues` lists why. `loop.seamScore` is always there.

The tool result also carries a `measured` block from `analyze`: loudness, true peak and the boundary jump between the last and first samples of the loop, plus the same plain-language warnings `analyze_audio` gives.

## Method

1. Decode. WAV is read directly at any common sample rate. MP3, OGG and FLAC, and WAV formats the built-in reader cannot handle, are decoded with ffmpeg (found on the path or through `LMMS_FFMPEG`) into a dot folder in the workspace, which is removed afterwards. Without ffmpeg, those formats fail with a message that says so. A missing file says it is missing.
2. Short-time analysis. One pass of 21 ms Hann windows centred every 10 ms gives an onset envelope (spectral flux below 8 kHz) and, on 20 ms frames, the level of 16 bands from 40 Hz to 16 kHz.
3. Tempo. The onset envelope, less its local average, is autocorrelated. The strongest peak between 60 and 200 bpm, gently weighted towards 120 bpm, gives the beat period. The period is then refined against its later multiples, up to 30 seconds out, which pins it far more precisely than a single peak. The beat phase is the offset whose grid collects the most onset energy. Confidence is how far the chosen peak stands above the median of the range. A `bpm` hint is a starting point: if there is a clear autocorrelation peak within 4% of it, the period is refined from that peak (`bpmSource: "hint, refined"`), otherwise the hint is used as given.
4. Half and double tempo. Autocorrelation cannot tell a beat from a half-time feel. When the reading is under 105 bpm and there are strong onsets halfway between beats, double tempo is flagged; when it is over 130 bpm and every other beat is as strong as the beat, half tempo is flagged. Flagged readings are searched too, so candidates are offered with bar counts at both. Loop lengths in seconds do not depend on which reading is right.
5. Candidate lengths. Every whole number of bars up to 16, then multiples of four up to `maxBars`. For each length, the search tries small tempo deviations and every start on the beat grid, and scores how closely one bar of band levels after the loop start matches one bar after the loop end. If the loop ends at the end of the file, the bar before each point is used instead. Silence counts as no evidence, so a loop over silence never scores well. Among starts that are as good as the best, the earliest wins, so a repeated section begins where the repetition does and the audio before it becomes the intro.
6. Exact length. For the best twelve, starting from the lag the search measured (not from the tempo, so an inexact hint does not carry through), the audio after the loop start is correlated with the audio after the loop end, first on a 6 kHz copy over plus or minus 45 ms, then sample by sample. The match uses the first difference of the signal, which favours drum hits and other transients over the phase of a low tone. If the best correlation is under 0.5, the repeats are too loose to trust a sample match and the length falls back to whole bars of the beat grid (`lengthFrom: "beat grid"`).
7. Seam score. 50% bar-long continuation (step 5), 30% spectrum and 20% waveform similarity of the 50 ms after the loop start against the 50 ms after the loop end. Playing the loop, the listener hears the loop end followed by the loop start; in the original, the loop end ran on into what follows it, so these two windows should match. Candidates are ranked by seam score. Within 0.02 of each other the longer loop wins, because a longer loop repeats less often in game. The advice then says if the music also repeats at a shorter length.

### Seams

- Crossfade: the region is first moved by up to 4 ms, keeping its length, to a point where the signal is near zero and flat at both ends. There are two ways to fade, and the tool measures both and uses the one where the two signals are more alike. Fading into the audio before the start: the last part of the loop fades into the audio that led up to the loop start in the original, so the loop ends on the exact sample that preceded its start and its first sample is untouched; this is preferred on a near tie. Fading from the audio after the end: the first part of the loop fades in from what followed the loop end in the original, which is the right choice when an intro precedes the loop, because the intro is different music from the end of the loop while the next pass matches the loop start. The fade shape follows the correlation of the two signals: linear when it is 0.5 or more, so nearly identical audio keeps its level, and equal-power (sine in, cosine out) when it is lower, so unrelated audio keeps its power. Equal power on identical audio would add about 3 dB in the middle of the fade; the tests check both cases.
- Fold: everything after the loop end is added back onto the loop start, as `export_game_audio` does with LMMS tails. This suits a file that ends with a ring-out after the last bar. If more than a few seconds of music follow the loop end, the tool warns, because folding music on top of music doubles it.

## Limits

- Free tempo: rubato, ambient or beatless music has no reliable grid. Confidence will be low and the tool will ask a person to pick, or take explicit `startSeconds` and `endSeconds`.
- Tempo changes: the beat grid assumes one tempo for the whole file. A loop inside a section with a different tempo may be found poorly or not at all; pass `bpm` for that section and narrow `minBars` and `maxBars`, or give explicit times.
- Long fade-outs: a song that fades out has no clean ending to fold. Pick a loop that ends before the fade and use the crossfade seam.
- Music that never repeats exactly: generated songs often vary each pass of a chorus. Scores will be lower than for a rendered loop, and the waveform part in particular will be low. When the sample match falls under 0.5 the length comes from the beat grid, which is only as exact as the tempo. The crossfade still makes a smooth seam, but listen to it. The thresholds (0.5 for the match, 0.7 for the seam score, 0.3 for tempo confidence) are set on synthetic audio and LMMS renders, including repeats with level changes and different reverb tails, but not yet on generated songs.
- Half and double tempo are flagged by a rule of thumb, not settled. Bar counts can be off by a factor of two; loop lengths in seconds are not.
- Metre: `beatsPerBar` is not detected. Bar numbers count from the first detected beat, which may fall on any beat of the bar.
- MP3 files carry encoder delay. ffmpeg removes it when the file says how much there is, but some encoders do not, which can shift positions by a few milliseconds. Loop lengths are unaffected.
- Very long files take a few seconds per minute of audio to search. Files are decoded fully into memory.

All checks are measurements. Nothing here listens to the result, so a person should hear the seam before the files ship.

## Rights

Checking that you have the right to use, edit and ship any audio you did not make yourself (including music from generators such as Suno, whose terms differ by plan) is your job, not the tool's. The tool result repeats this.

## Tests

- `tools/loop-prep.test.mjs` (run by `npm test`): tempo detection from 64 to 200 bpm with half and double tempo flagged (clicks at 160, 174, 180 and 200 bpm, eighth notes at 70 bpm), a hint 0.33% off the real tempo, loop finding on synthetic songs with a non-repeating intro, a repeated phrase and a ring-out ending at 48 kHz and 44.1 kHz (length to within one frame, start to within 12 ms), a loop that runs to the end of the file, slightly different repeats (matched to the sample) and loose repeats (beat grid, and a person is asked), the longest-equal-loop rule, ranks that do not depend on `count`, refusal on beatless noise, length refinement and its correlation floor, linear and equal-power fade maths and the level through each fade, both crossfade directions, the quiet-point shift, and the decoding errors and temporary folder.
- `verify-loop-prep.mjs` (needs LMMS): builds a project with a two-bar intro, a four-bar section played twice and an ending, renders it with its tail, and checks over stdio that the loop length matches four bars to within 3 ms, that the prepared loop has a boundary jump below -40 dBFS, meets a -16 LUFS target and is marked seamless, that checksums match and the intro joins the loop cleanly. It repeats the search on a version whose second pass is quieter and whose lead has reverb, so the two passes differ. It also checks fold with explicit times, a plain cut reported as not seamless, a 44.1 kHz copy and an MP3 copy (when ffmpeg is installed) with no temporary folder left behind, that low confidence refuses to guess, and that forcing it marks the loop as not seamless.
