# Balancing a mix by measurement

The agent cannot hear the mix, so it balances by measurement. `auto_balance` does the whole pass in one call, and `compare_to_reference` says how a render differs from a track you want to sound like.

Run `auto_balance` after the parts are written and before mastering. Set track roles with `set_track_role` (or `role` in `create_project`) first, so the tool does not have to guess.

## auto_balance

Inputs:

- `project`: the project to balance.
- `output`: where to write the balanced copy. Not needed with `dryRun`.
- `dryRun`: measure and plan, write nothing.
- `measureBars`: `{ startBar, bars }`, zero-based. By default the tool picks the loudest 8 bars of the mix.
- `targets`: overrides. `roles` takes a role or drum kind, `tracks` takes a track name. A number uses that role's own measure (peak or RMS); `{ measure, db }` sets both. Unknown roles and track names are refused, so a typo cannot be silently ignored.
- `headroomDb`: how far under full scale the predicted mix peak must stay. Default 2.
- `master`: `protect` (default) lowers the master only when the predicted peak breaks the headroom. `fit` sets the master so the peak lands exactly on the headroom. `keep` never touches it.
- `overwrite`: allow replacing an existing output. Without it, an existing output is refused before anything renders.

What it does:

1. Refuses if any track is soloed. Solo changes what the mix is, and `render_mix` honours it, so balancing a partial mix and setting the master from it would be wrong. Clear solo and mute what should stay out.
2. Renders one stem per unmuted audio track, in parallel, with every other track muted.
3. Splits each stem into one-bar blocks and records peak, energy and band power per bar.
4. Sums the stems to find the loudest stretch of the mix, unless `measureBars` is given. A track that is silent in that stretch is measured over its own loudest bars instead, and the row says so.
5. Decides each track's role (see below) and its target.
6. Works out the gain that puts the track on target. LMMS track volume is linear (100 is unity, 200 is +6 dB), so the change in dB is the target minus the measurement.
7. If a track cannot reach its target at volume 200, it lowers every target by the same amount (at most 12 dB) so the balance between tracks holds. The result gives `targetShiftDb`, marks the track that caused it and says so in the notes. Raise that instrument's or preset's own level and run again to get the level back.
8. Sums the gain-scaled stems in memory to predict the new mix, and sets the master so the predicted peak keeps the headroom.
9. Writes every change in one save.

The result has one row per track: role, where the role came from, measure, measured level, target, gain, volume before and after, and the level the stem is predicted to render at. It also returns the predicted mix peak, true peak, integrated loudness and window RMS before and after, a masking report, mono warnings and notes.

### Measuring pitched parts

Pitched parts are measured over the time they sound, not over the whole window. Each bar is cut into 400 ms pieces, and pieces more than 30 dB under the part's loudest piece count as silence. A counter-melody that plays one bar in eight is measured on that bar, so it is not boosted to make up for the seven silent ones. The row's `soundingShare` says how much of the window the part filled. Drums use the sample peak, which silence does not affect.

### Automated volume

When a track's volume is automated, the tool scales every automation point and the control's base value by the same factor, so the shape of the automation is kept. The row reports `volumeBefore` and `volumeAfter` as the mean automated level over the measured bars, and `highestPoint`. The gain is limited so that no point goes past 200, because a cut-off point would deliver less gain than planned. A fade-in that starts at 0 is balanced like any other part. An automated master volume is handled the same way.

## Targets

These are starting points. They come from a 15-track, 90-second game theme measured over its loudest 8 bars, and they will not suit every arrangement. Override them when a part should sit higher or lower.

Drums are transients, so they use peak targets:

| Drum | Peak (dBFS) |
| --- | --- |
| kick | -7 |
| snare | -8.5 |
| tom | -9 |
| crash and cymbals | -13 |
| clap | -15 |
| other percussion | -15 |
| hats | -19 |
| a whole kit on one track | -8 |

Pitched parts are sustained, so they use RMS targets over the time they sound:

| Role | RMS (dBFS) |
| --- | --- |
| lead | -17 |
| bass | -18 |
| counter | -22 |
| harmony | -22.5 |
| fx | -24 |
| texture (pads) | -26 |

Targets are stem levels at master volume 100. That keeps the track balance independent of the master: a second pass over a balanced project asks for almost nothing. When the master is not at 100, every stem renders the same number of dB away from its target (`master.stemOffsetDb`), and `predictedDb` shows where each one lands. A very low master therefore pushes track volumes up; leave the master near 100 while balancing.

The master is then set from the predicted peak. With the default `protect` it only comes down, and only when the summed mix would break the headroom.

## Roles and the fallback

A declared role (`mcp-role`) always wins. For drums, the kind (kick, snare and so on) comes from the track or sample name, or from the spectrum when the name says nothing.

Without a declared role the tool guesses, and reports `roleSource` so you can check it:

1. `guess from name`: whole words only, so "Heartbeat Pad" is a pad and "Neptune Pad" is not a lead. Drum words come first (kick, snare, clap, hat, crash, tom, perc), then role words (bass, lead, counter, pad, chord, strings, fx and similar). A drum name on a part that is sustained or plays chords is overruled, and the source says so.
2. `guess from instrument`: the Kicker plugin is a kick; a stock sample under `drums/` is a drum, with its kind from the file name; a sample under `basses/` is bass.
3. `guess from notes`: a low line with at most two notes at once is bass; three or more notes at once is harmony, or texture when the notes last a bar or more; a single line is lead.
4. `guess from spectrum`: mostly sub and bass energy with a low centre is bass (or a kick if it is very spiky); a crest factor over 18 dB is a drum; steady, low-crest sound is harmony or texture; the rest is lead or harmony by brightness.

The notes list every guessed track. Set the right role with `set_track_role` and run again.

## Masking report

For each pair of pitched stems (bass, harmony, lead, counter, texture), the tool looks at the bars where both are playing and finds the band each puts most of its energy in. A bar counts when both centre on the same band within 10 dB of each other, after the new gains; a part far below another is not competing for that space. When at least half the shared bars count, it reports the pair, the band, the bars and the level difference. At most 8 findings are returned, the most widespread first.

The suggestion keeps the more important part clear (lead, then bass, counter, harmony, texture) and offers fixes for the other: lower it by 2 to 3 dB, move it an octave, cut its low end, darken it, or shorten its notes.

It also lists stems whose left and right channels are weakly correlated (below 0.2), because they thin out or vanish in mono.

## compare_to_reference

Inputs: `audio` and `reference`, both workspace WAVs, and optional `sections` with `startSeconds` and `endSeconds` (and `referenceStartSeconds` and `referenceEndSeconds` when the matching passage sits elsewhere in the reference). A section that runs past the end of either file is refused, and so is a silent file or section: silence is not a match.

It reports the difference, audio minus reference, in:

- integrated loudness (LU),
- band balance: each of the six bands relative to the file's own total, so a level difference does not swamp the comparison,
- crest factor (peak minus RMS),
- stereo correlation,
- spectral centroid (in Hz and as a ratio).

The largest differences become plain suggestions, for example "3 dB less energy in 2 to 6 kHz than the reference: brighten the lead or raise the hats". Band differences under 2 dB, loudness under 1 LU, crest under 3 dB and correlation under 0.2 are left out.

## Limits

- The prediction assumes the tracks add up linearly. Level-dependent effects (compressor, limiter, distortion, bass booster, any LADSPA plugin) on Master, on a track's own chain or on its mixer bus break both the gain maths and the prediction, and the result notes each one. EQ, delay, reverb and stereo width are linear and need no note. Render the mix and check it with `analyze_audio`.
- Track volume tops out at 200 (+6 dB). Beyond the 12 dB target shift, a part that still cannot reach its target is left at 200 with a warning.
- Beat/Bassline tracks have no volume control of their own. They are measured and included in the prediction, but not changed.
- Measurements are per bar and assume a static tempo for bar boundaries.
- Every stem is rendered and held in memory, about 23 MB per minute of stereo audio per track.
- Targets describe one game theme. Use them to get close, then adjust by role or by track.
- All of this is measurement. Nobody has listened to the result.
