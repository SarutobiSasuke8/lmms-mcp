# LMMS MCP

Create editable music projects and render local WAV loops through LMMS. This server works with saved uncompressed `.mmp` files and uses LMMS as a separate executable.

## Windows setup

Install Node.js 22 or newer. From a checkout run `./setup-windows.ps1`. It installs the Node dependencies and uses WinGet to install stock LMMS 1.2.2 if needed. For manual setup, run `npm ci` and install [LMMS](https://lmms.io/download). The package contains our server and demo, and setup obtains LMMS from its official distribution.

Configure a stdio MCP client with command `node` and the absolute path to `server.mjs` as its argument. Set `LMMS_WORKSPACE` to an existing directory for sessions and renders. Set `LMMS_EXECUTABLE` if the renderer lives outside the standard Windows installation path or your PATH on Linux. Windows LMMS 1.2.2 is the tested combination.

| Tool | Purpose |
| --- | --- |
| `create_project` | Create a 4/4 session from named synth and drum tracks and note patterns |
| `inspect_project` | List tracks, clip positions and note counts |
| `read_pattern` | Read the pitches, timing and velocities of an existing clip |
| `replace_pattern` | Save a revised clip in a new project copy |
| `render_mix` | Render a 48 kHz stereo loop and report peak, full-scale samples and boundary jump |

A beat has 48 ticks and a bar has 192 ticks. Bars start at zero. MIDI note 69 triggers a drum sample at its original pitch. Files use simple names in the workspace. Existing output files are protected from overwrites. Open the resulting MMP in LMMS to edit notes, choose other instruments or mix before exporting.

Run `npm run demo -- output/demo` to create and render two variants via the MCP. Use a fresh output folder on each run. The demo uses stock LMMS drums and built-in synthesis.

Run `npm run demo -- output/japanese --japanese` for a Japanese-inspired take with a D, E-flat, G, A and B-flat pitch palette, more space between plucked notes and sparser kick accents. The demo uses electronic synths and drums. To get closer to acoustic koto or taiko, choose suitable patches or cleared samples in LMMS.

## Licence

The bridge is MIT licensed. LMMS is separately distributed under its upstream licence.
