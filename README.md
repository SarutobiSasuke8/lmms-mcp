# LMMS MCP

![LMMS MCP above a graphite step sequencer with amber and teal pads](art/lmms-mcp.webp)

Create editable music projects, revise a pattern, route tracks, add automation and render a local WAV loop. The MIT-licensed server works with saved `.mmp` and `.mmpz` files and calls the installed LMMS renderer without opening the editor.

## Windows setup

Install Node.js 22 or newer. From a checkout run `./setup-windows.ps1`. It installs the Node dependencies and uses WinGet to install stock LMMS 1.2.2 if needed. For manual setup, run `npm ci` and install [LMMS](https://lmms.io/download). The package contains our server and demo, and setup obtains LMMS from its official distribution.

Configure a stdio MCP client with command `node` and the absolute path to `server.mjs` as its argument. Set `LMMS_WORKSPACE` to an existing directory for trusted sessions and renders. Set `LMMS_EXECUTABLE` for a custom executable path and `LMMS_PRESETS` for a custom preset directory. The tested combination is Node.js 22 and LMMS 1.2.2 on Windows x64.

For an install that follows a fixed GitHub release, run `npx -y https://github.com/SarutobiSasuke8/lmms-mcp/archive/refs/tags/v0.5.0.tar.gz`. Configure your client to launch that command over stdio with `LMMS_WORKSPACE` set. LMMS still needs to be installed separately.

| Tool | Purpose |
| --- | --- |
| `create_project` | Create a 4/4 session from named synth and drum tracks and note patterns |
| `inspect_project` | List tracks, clip positions and note counts |
| `inspect_arrangement` | Read tempo, metre, mixer sends, instruments, clips and automation points |
| `read_pattern` | Read the pitches, timing and velocities of an existing clip |
| `replace_pattern` | Save a revised clip in a new project copy |
| `edit_clip` | Move, duplicate, rename or remove an instrument pattern |
| `inspect_effects` / `edit_effect` | Inspect a track effects chain, add Delay or EQ, and set wet mix, bypass or remove effects |
| `save_project_copy` | Copy a saved project between MMP and MMPZ |
| `set_project_tempo` | Set static BPM in a new project copy |
| `set_track_mix` | Edit instrument volume, pan, mute or solo |
| `list_presets` / `apply_preset` | Browse installed XML presets and apply compatible instruments and envelopes |
| `list_instruments` | Discover known stock instrument plugins on disk, usable preset paths and Fathom bridge setup |
| `search_sounds` / `preview_sound` | Find stock presets and Fathom patches, then audition them as short WAVs |
| `set_native_instrument` | Swap in a discovered stock instrument while keeping the notes and track controls |
| `render_fathom_track` | Render editable piano-roll notes through Fathom Atelier with a programmable filter sweep |
| `route_mixer_bus` | Add a named bus routed to master and assign instrument tracks |
| `automate_track` | Write a track volume or low-pass cutoff envelope |
| `render_mix` | Render a 48 kHz stereo loop and report duration, peak, RMS, full-scale samples and boundary jump |
| `render_stems` | Export individual track WAVs aligned to the mix length |
| `export_midi` | Export named instrument tracks with pitches, timing and velocity |

## Export and playback

Use `export_one_shots` to process up to 32 mono or stereo 48 kHz, 16-bit PCM WAVs in one call. Give each source a unique output name and choose a new output directory. The tool trims quiet edges, adds short fades, matches sample peaks and writes mono WAVs and a JSON manifest. The manifest reports duration, trim offset and measured levels. Peak matching leaves each take's dynamics intact.

```json
{
  "outputDirectory": "rts-pack",
  "sounds": [
    {"input": "ack-source.wav", "name": "unit-acknowledged"},
    {"input": "shutdown-source.wav", "name": "robot-shutdown"}
  ],
  "thresholdDb": -48,
  "peakDb": -3
}
```

For a saved sampler track, use `create_project` with `voice: "sample"`, a workspace WAV as `sample` and the recorded pitch as `rootMidi`. Trigger the sample at the root for unchanged pitch or use other notes to transpose it. The saved project references that WAV by its absolute path. Use LMMS to relink the source if you move the project to a different machine.

## Fathom Atelier

Set `LMMS_FATHOM_WORKLET` to the absolute path of a trusted Fathom Atelier checkout's `public/worklets/synth-processor.js` before launching the MCP. The LMMS MCP package ships the adapter. The synth engine is supplied locally. Use `list_instruments` to check configuration and discover the stock plugin and preset inventory. Set `LMMS_PLUGINS` if your installation stores plugins outside the executable's adjacent `plugins` directory. The inventory checks files on disk. Third-party plugins loaded inside hosts such as Carla or VeSTige need their own inventory.

Save a full Fathom patch object as JSON in the workspace. Supported model IDs are `fathom`, `vesper` and `halo`. Call `render_fathom_track` with a saved 4/4 project at a static tempo.

```json
{
  "project": "ninja-bomber-source.mmp",
  "output": "ninja-bomber-fathom.mmp",
  "audio": "fathom-arp-stem.wav",
  "trackName": "Fathom Spark Arp",
  "patchFile": "spark-dark.json",
  "bars": 8,
  "cutoff": [
    {"tick": 0, "hz": 220},
    {"tick": 576, "hz": 375},
    {"tick": 1152, "hz": 1300},
    {"tick": 1470, "hz": 4850}
  ]
}
```

The bridge uses the written pitches, note lengths and velocities. It interpolates cutoff by frequency ratio and updates the worklet every 128 samples. The project copy keeps the muted source piano-roll track for editing and MIDI export and plays the rendered audio from a sample track. Rerun after editing notes, tempo, patch or cutoff, with fresh output filenames. The current bridge renders the dry worklet. Apply delay, chorus and reverb in LMMS as needed. The audio clip references an absolute WAV path, so relink it when moving the project.

Search for `dark arp`, `sub bass`, `metallic bell` or `warm organ` with `search_sounds`. Audition a result by passing its `patchId` or `preset` and a fresh WAV filename to `preview_sound`. Reuse the same patch ID in `render_fathom_track` or the same preset path in `apply_preset`. Stock search covers preset names and families. Some presets need a MIDI root suited to their range.

## Codex and Claude Code skill

Copy [the LMMS game audio skill](skills/lmms-game-audio/SKILL.md) with its directory into `.agents/skills/` for Codex or `.claude/skills/` for Claude Code in your project. Configure the MCP separately using the setup above.

## Roadmap

- Expand the sound catalogue with richer native preset tags for timbre, role and genre.
- Expose bounded, instrument-specific parameters and expand automation beyond cutoff. Save render settings alongside arrangements so edits can be rebounced without reconstructing the render call.
- Add adaptive game exports with aligned intensity layers, intros, stingers and one-shot manifests.
- Expand the sound palette with instrument packs first, including sampled guitars, designed drums and voice one-shots. Consider new engines for playing behaviours the packs cannot capture, such as expressive sustained strings.

Keep the native project as the editable master. MIDI exports instrument patterns and non-overlapping Beat/Bassline clips at a static tempo. Drum steps export as sixteenth-note triggers. Synth patches, effects, audio clips and automation stay in the native project. The default `pitchMode: "written"` preserves the piano-roll notes. Select `"playback"` to apply the instrument base note and master pitch offsets. Plugin transposition and pitch modulation remain in the native project.

Stem export uses LMMS track rendering. It trims or pads each take to the mix length, including tracks with shorter patterns. Effects that depend on several tracks playing together can sound different in solo renders.

The optional Windows transport adapter uses a separately built [LMMS Agent Bridge](https://github.com/Jx9x/lmms-mcp-bridge). Launch LMMS with its bridge, then set `LMMS_LIVE_PIPE=lmms-agent-bridge` when starting this server. Where enabled, `live_transport` accepts play, pause, stop and seek. The tool returns the bridge's playback state. The upstream playback-volume cap can lower the master fader and mark your open project as modified when you press play. Saved-project edits and exports work with stock LMMS.

With the same bridge enabled, use `live_inspect` to read project state, arrangement and notes. Pass the returned project token to `live_update_track`, `live_update_clip`, `live_replace_notes` or `live_update_effect`. Take track and clip indices from a fresh arrangement read, particularly after adding or removing tracks in LMMS. Changes appear in the open project and can be saved in LMMS.

Use `live_create_track` for instrument, sample, automation or Beat/Bassline tracks. Create a linked curve with `live_add_automation`, inspect it with `live_read_automation` and replace or upsert points with `live_edit_automation`. The helper links to track volume, panning or pitch.

For your own synth patches, place a compatible LMMS `.xpf` in the workspace and call `live_load_instrument_file` on an instrument track. For voice clips, guitar chops and game sound effects, create an AudioFileProcessor track and load a WAV, Ogg or FLAC file from the workspace. Use a note pattern to sequence the sample. SoundFonts and other native preset formats require a compatible destination instrument.

## Verification

Run `npm ci` and `node verify-exports.mjs` from source on Windows with LMMS 1.2.2 installed. Pass a native MMP path to exercise a different project with instrument patterns at the start of the arrangement. The script checks clip edits, MIDI readback, effect bypass and stem duration through a real stdio connection.

Set `LMMS_FATHOM_WORKLET` and `LMMS_FATHOM_TEST_PATCH` to the local worklet and a full patch JSON to also verify Fathom cutoff rendering and rebouncing.

See [the comparison notes](COMPARISON.md) for tested workflows and gaps.

A beat has 48 ticks and a bar has 192 ticks. Bars start at zero. MIDI note 69 triggers a drum sample at its original pitch. Files use simple names in the workspace. Existing output files are protected from overwrites. Open the resulting MMP in LMMS to edit notes, choose other instruments or mix before exporting.

Run `npm run demo -- output/demo` to create and render two variants via the MCP. Use a fresh output folder on each run. The demo uses stock LMMS drums and built-in synthesis.

Run `node demo.mjs output/japanese --japanese` for a Japanese-inspired take with a D, E-flat, G, A and B-flat pitch palette, more space between plucked notes and sparser kick accents. The demo uses electronic synths and drums. To get closer to acoustic koto or taiko, choose suitable patches or cleared samples in LMMS.

This alpha targets saved-session editing, compatible factory XML presets and local rendering. The project builder creates 4/4 sessions. Use LMMS for live editing, third-party instruments, detailed effect parameters and linked controls.

## Licence

The bridge is MIT licensed. LMMS is separately distributed under its upstream licence.
