# Timeline page

`build_timeline_page` writes one HTML page that shows a song the way a DAW would, for a person to listen to and comment on. It is a viewer: nothing in the project is changed from it.

## What it shows

- **Lanes.** Every WAV in a `render_stems` folder is a lane with its waveform. Lanes are ordered by the number at the start of the stem's file name and coloured by family: drums, bass, harmony, lead and texture. The family comes from the track's role when you pass `project`, otherwise from the lane name.
- **Bar ruler** across the top, from the `bpm` you give.
- **Sections** as blocks. Click one to jump to it, double-click to loop it.
- **DJ effects** as blocks, when you pass the same `effects` list that went to `dj_effects`.
- **The finished mix** as the top lane, when you pass `mix`.

## What the listener can do

- Play, pause and click anywhere to move the playhead. The left and right arrow keys move one bar.
- Mute, solo and set the volume of each lane.
- Switch between the stems and the finished mix with one button.
- Loop a section.
- Pin a note to the bar under the playhead with "Add note here" (or `n`), then "Copy notes". The copied JSON gives the bar, the section, the text and which lanes were soloed or muted, so feedback such as "the solo rings on too long" arrives with a location.

## Example

```json
{
  "stems": "song-stems", "mix": "song-club.wav", "bpm": 126, "project": "song-bal.mmp",
  "title": "Song", "output": "song-timeline.html",
  "sections": [{ "name": "intro", "startBar": 0, "bars": 4 }, { "name": "drop", "startBar": 4, "bars": 8 }],
  "effects": [{ "type": "filter_sweep", "startBar": 0, "bars": 4, "filter": "lowpass" }]
}
```

The library page links each of the listener's tracks to its timeline when a file named `<track>-timeline.html` exists in the workspace.

## Limits

- Stems are the tracks before mastering and before any DJ effects, so their sum does not sound the same as the finished mix.
- Each lane is its own audio player. The page pulls any lane that drifts more than 45 ms back into step every second and a half, so lanes can be a few hundredths of a second apart for a moment.
- Up to 64 lanes, and each file up to 256 MiB.
- Open the page through `library-server.mjs` or straight from disk. Audio is referenced by relative path and nothing is fetched from the network.
