# Audition pages, feedback and taste

The agent cannot hear. These tools give the listener a fast way to hear the music, judge it and send the judgement back, and give the agent a durable memory of what the listener likes.

| Tool | What it does |
| --- | --- |
| `build_audition_page` | Writes one self-contained HTML page for an `export_game_audio` folder or for one to four renders. |
| `read_feedback` | Reads the feedback JSON the page saves or copies, grouped by section and bar. |
| `remember_taste` | Stores a lasting listener preference in `.lmms-taste.json` in the workspace, or forgets one. |
| `get_taste` | Returns the stored preferences, grouped by area. |

`get_started` tells agents to call `get_taste` before composing or mixing, and to build an audition page before asking for a listen.

## The loop

1. `get_taste`, then compose and mix with the preferences in mind.
2. `export_game_audio` with an intro, layers and stingers, or `render_mix` two versions.
3. `build_audition_page` and give the listener the page path.
4. The listener plays, rates sections, pins notes, then presses Save feedback or Copy feedback.
5. `read_feedback` with the saved file (moved into the workspace) or the pasted text.
6. Turn each note into an edit at its bar. When a note states a lasting preference ("leads always too busy"), `remember_taste`.

## build_audition_page

Give either `folder` or `files`.

- `folder`: a folder made by `export_game_audio`. The page is written into that folder as `<name>-audition.html`, beside the audio. If the folder holds more than one manifest, name it with `manifest`.
- `files`: one to four workspace WAV or OGG files, optionally one folder down. The page is written to the workspace root. All files play in sync and the A, B, C and D buttons switch between them without losing the position. Loudness is measured from each WAV (an OGG is measured through a WAV of the same name beside it) and the louder files are turned down to the quietest, so the comparison is about the music, not the level.
- `sections`: named sections in song bars counted from zero, the same numbering as the project. The intro starts at bar 0 and the loop starts at bar `introBars`. A section without `bars` runs to the next section or the end. Without `sections`, a game page gets "Intro" and "Loop". When comparing files, sections need `bpm`.
- `spectrogram`: a workspace PNG, for example one written by `analyze_audio`, shown under the player.
- `title`, `output` (page file name), `overwrite` (default true; the page is a derived file).

The tool checks that every file the page loads exists and returns the page path, a `file:///` URL, the loop and intro frames, the layers, stingers, sections, and the loudness matching for A/B.

### What the page does

- Plays the intro once, then the loop forever, gaplessly (see below).
- Shows time, bar and beat, and the current section. Click the timeline to seek.
- Layers: a "Full mix" and "Layers" switch, and a fader with mute and solo for each layer. Layers stay sample-aligned with each other and with the mix while faders move.
- Stingers: one button each, played over the music. With "Wait for the next bar" on, a stinger starts on the next bar line.
- Sections: a button to jump to each section and a 1 to 5 rating.
- Notes: type a note and press "Add note here" (or Ctrl+Enter). The note is pinned to the current time, bar, beat and section, the layer settings (or full mix), and the A/B file. Click a note's time to jump back to it. Notes and ratings survive a page reload in the same browser.
- Keys: Space plays or pauses, N starts a new note.
- Save feedback downloads `<name>-feedback.json`. Copy feedback puts the same JSON on the clipboard to paste into the chat.

### Opening the page

The page has no network access and no external scripts, styles or fonts. Audio is referenced by relative path.

Browsers do not let a page opened from disk (`file://`) read the files beside it. Opened that way, the page asks once for its folder ("Choose folder") or the audio files, then plays from those. Served over HTTP, it loads the audio directly. Any static server in the workspace works, for example `npx http-server` or `python -m http.server`, run in the export folder or the workspace.

The page plays the WAV files. OGG files can carry encoder padding that breaks a gapless join, and Safari cannot decode Ogg Vorbis, so game folders are auditioned from their WAVs.

## Why intro into loop has no gap

`export_game_audio` cuts the intro and the loop from one render: the intro is frames 0 to `introFrames`, and the loop starts at frame `introFrames` with the tail folded back into its start. Played end to end they are the original render, sample for sample.

The page keeps that join exact by construction:

1. It creates its `AudioContext` at the manifest's sample rate (48000 Hz), so decoded buffers have exactly the exported frame counts. The page reports the decoded rate and says so if the browser had to resample.
2. All audio is decoded into memory before Play is enabled. Nothing streams.
3. On Play, it picks one start time on a whole-frame boundary of the context clock. The intro starts at that time. The loop and every layer start `introFrames - offset` frames later, computed in integer frames by `startPlan`, which is exactly when the intro's last frame has played. The Web Audio API schedules both sources on the same sample clock, so the loop's first frame is the frame after the intro's last.
4. The loop and layers are `AudioBufferSourceNode`s with `loop` on, `loopStart` 0 and `loopEnd` the buffer's full length, so the seam is the seam `export_game_audio` measured.
5. Layers start on the same frame as the mix with the same offset and loop length, so they cannot drift. Faders, mute and solo change gain nodes only, never the sources.
6. Seeking stops every source and starts them again with the same plan from the new position.

The page proves this on itself: opened with `#selftest` after the address, it renders its own schedule offline with an `OfflineAudioContext` across the intro to loop join and across the loop seam, compares each with the files joined end to end, and sums the layers against the mix. `verify-audition.mjs` runs this in headless Chrome. On a real LMMS export the join and the seam match with a maximum difference of 0, and the layers match the mix at about -75 dB.

The timing maths (`barSeconds`, `barBeatAt`, `wrapSongTime`, `startPlan`, `sectionAt`, `secondsToNextBar`) is written once in `tools/audition.mjs`, unit tested there, and copied into the page with `Function.prototype.toString`, so the page runs the tested code.

## Feedback JSON (version 1)

```json
{
  "schema": "lmms-mcp/audition-feedback",
  "version": 1,
  "title": "forest",
  "source": "forest.manifest.json",
  "page": "forest-audition.html",
  "files": ["forest-intro.wav", "forest-loop.wav", "forest-layer-rhythm.wav"],
  "bpm": 120,
  "timeSignature": [4, 4],
  "introBars": 2,
  "savedAt": "2026-11-14T10:00:00.000Z",
  "sections": [
    { "name": "Intro", "startBar": 0, "bars": 2, "rating": 4 },
    { "name": "Loop", "startBar": 2, "bars": 6, "rating": 2 }
  ],
  "notes": [
    {
      "seconds": 9.01, "bar": 4, "beat": 1, "section": "Loop",
      "text": "Lead too busy here", "rating": 2,
      "mode": "layers",
      "layers": { "rhythm": { "db": 0, "muted": true, "solo": false }, "tonal": { "db": -3, "muted": false, "solo": false } }
    },
    { "seconds": 30.5, "bar": 15, "beat": 1, "section": null, "text": "A/B: B is warmer", "rating": null, "compare": "B" }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `schema`, `version` | Always `lmms-mcp/audition-feedback` and `1`. `read_feedback` refuses anything else. |
| `source` | The manifest the page was built from, or null for an A/B page. |
| `files` | The audio files the page played, relative to the page. |
| `sections[].rating` | 1 to 5, or null when not rated. |
| `notes[].seconds` | Song time: the intro starts at 0 and the first loop pass follows it. Repeats of the loop are folded back onto the first pass. |
| `notes[].bar`, `beat` | Bar counted from zero (as in the project), beat counted from one. Null when there is no tempo. |
| `notes[].section` | The section playing when the note was made, or null. |
| `notes[].rating` | Optional 1 to 5 for that moment. |
| `notes[].mode` | `mix` or `layers` on a layered page. |
| `notes[].layers` | Each layer's fader in dB, mute and solo, recorded when the listener was in layers mode. |
| `notes[].compare` | The A/B file label that was playing. |

`read_feedback` takes `file` (a workspace JSON, optionally one folder down) or `text` (the pasted JSON; Markdown code fences are fine). It returns the average rating, the weakest section, each section with its notes in time order, notes outside any section, notes indexed by bar, and a `summary` list of plain lines such as `Loop (bars 2 to 7): rated 2/5, 1 note` and `bar 4 beat 1: Lead too busy here [2/5] (heard: muted rhythm; tonal -3 dB)`. A note without a section name is placed in the section that holds its bar.

## Taste memory

`.lmms-taste.json` sits in the workspace root:

```json
{
  "version": 1,
  "entries": [
    { "id": "t1", "area": "lead", "text": "Leads too busy; keep melodies sparse", "source": "forest-feedback.json", "addedAt": "2026-11-14T10:05:00.000Z" },
    { "id": "t2", "area": "drums", "text": "Less reverb on drums", "addedAt": "2026-11-14T10:06:00.000Z" }
  ]
}
```

- `remember_taste` takes `text`, `area` (general, arrangement, mix, sound, or a track role: drums, bass, harmony, lead, counter, texture, fx), and an optional `source`. The same words in the same area are stored once. Pass `forget` with ids to remove entries that no longer hold.
- `get_taste` returns every entry grouped by area, or with `area` that area plus the general entries.

Store preferences that should outlast one piece. Feedback about one bar of one song belongs in an edit, not in taste.

## Checks

- `npm test` runs `tools/audition.test.mjs`: bar and beat maths, the intro to loop start plan, sections, loudness matching, the manifest to page model, strict HTML parsing of the page, a run of the page script against a stub DOM, feedback parsing and grouping, and taste memory.
- `node verify-audition.mjs` makes a short layered song in LMMS, exports it with an intro, two layers and a stinger, builds a game page and an A/B page, checks every referenced file exists and the embedded loop and intro frames match the WAVs, parses the HTML strictly, round-trips feedback through a file and pasted text, and round-trips taste entries. If Chrome or Edge starts headless, it also loads both pages over a local HTTP server through the DevTools protocol, requires no console output, presses Play, adds a note, opens the page from disk, and runs the `#selftest` described above. Set `LMMS_AUDITION_BROWSER` to a browser path, or to `none` to skip that part.

These checks measure the audio. Nobody listened to it as part of them.
