# LMMS MCP

Create editable music projects, revise a pattern, route tracks, add automation and render a local WAV loop. The MIT-licensed server works with saved `.mmp` and `.mmpz` files and calls the installed LMMS renderer without opening the editor.

## Windows setup

Install Node.js 22 or newer. From a checkout run `./setup-windows.ps1`. It installs the Node dependencies and uses WinGet to install stock LMMS 1.2.2 if needed. For manual setup, run `npm ci` and install [LMMS](https://lmms.io/download). The package contains our server and demo, and setup obtains LMMS from its official distribution.

Configure a stdio MCP client with command `node` and the absolute path to `server.mjs` as its argument. Set `LMMS_WORKSPACE` to an existing directory for trusted sessions and renders. Set `LMMS_EXECUTABLE` for a custom executable path and `LMMS_PRESETS` for a custom preset directory. The tested combination is Node.js 22 and LMMS 1.2.2 on Windows x64.

For an install that follows a fixed GitHub release, run `npx -y https://github.com/SarutobiSasuke8/lmms-mcp/archive/refs/tags/v0.2.0.tar.gz`. Configure your client to launch that command over stdio with `LMMS_WORKSPACE` set. LMMS still needs to be installed separately.

| Tool | Purpose |
| --- | --- |
| `create_project` | Create a 4/4 session from named synth and drum tracks and note patterns |
| `inspect_project` | List tracks, clip positions and note counts |
| `inspect_arrangement` | Read tempo, metre, mixer sends, instruments, clips and automation points |
| `read_pattern` | Read the pitches, timing and velocities of an existing clip |
| `replace_pattern` | Save a revised clip in a new project copy |
| `save_project_copy` | Copy a saved project between MMP and MMPZ |
| `set_project_tempo` | Set static BPM in a new project copy |
| `set_track_mix` | Edit instrument volume, pan, mute or solo |
| `list_presets` / `apply_preset` | Browse installed XML presets and apply compatible instruments and envelopes |
| `route_mixer_bus` | Add a named bus routed to master and assign instrument tracks |
| `automate_track` | Write a track volume or low-pass cutoff envelope |
| `render_mix` | Render a 48 kHz stereo loop and report duration, peak, RMS, full-scale samples and boundary jump |

A beat has 48 ticks and a bar has 192 ticks. Bars start at zero. MIDI note 69 triggers a drum sample at its original pitch. Files use simple names in the workspace. Existing output files are protected from overwrites. Open the resulting MMP in LMMS to edit notes, choose other instruments or mix before exporting.

Run `npm run demo -- output/demo` to create and render two variants via the MCP. Use a fresh output folder on each run. The demo uses stock LMMS drums and built-in synthesis.

Run `node demo.mjs output/japanese --japanese` for a Japanese-inspired take with a D, E-flat, G, A and B-flat pitch palette, more space between plucked notes and sparser kick accents. The demo uses electronic synths and drums. To get closer to acoustic koto or taiko, choose suitable patches or cleared samples in LMMS.

This alpha targets saved-session editing in 4/4, compatible factory XML presets and local WAV rendering. Use LMMS to edit live sessions and manage third-party instruments or linked controls. Next comparisons cover general clip editing, plugin and effect coverage, tempo and metre automation, MIDI and stem exports, and live control. Run the same arrange, revise and render tasks against the community servers before making a ranking claim.

## Licence

The bridge is MIT licensed. LMMS is separately distributed under its upstream licence.
