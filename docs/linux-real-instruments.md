# Real instruments on Linux

The real-instrument route (Decent Sampler and Surge XT as VST3, hosted by pedalboard) runs on Linux x86_64 as well as Windows. This page covers setup, the Linux differences, and the render options added with it. For converting SFZ libraries see [sampler.md](sampler.md).

## Setup

Run `setup-vst3-linux.sh` from the package or checkout. It needs `python3` with the `venv` module (on Debian and Ubuntu, `python3-venv`). There is no Python version pin: use one that pedalboard 0.9.26 publishes wheels for.

```bash
# from downloads (take the address and the SHA-256 from each publisher's release page)
DECENT_SAMPLER_URL=... DECENT_SAMPLER_SHA256=... SURGE_XT_URL=... SURGE_XT_SHA256=... ./setup-vst3-linux.sh
# or from .vst3 folders you already have
./setup-vst3-linux.sh --decent-sampler-bundle /opt/ds/DecentSampler.vst3 --surge-xt-bundle "/opt/surge/Surge XT.vst3"
```

No download address is built in, and a download without a SHA-256 is refused. The script unpacks into `${XDG_DATA_HOME:-~/.local/share}/lmms-mcp/vst3-v1` (change it with `--install-directory`), leaves system plug-in folders alone and writes `mcp-env.json` with `LMMS_VST3_PYTHON`, `LMMS_DECENT_SAMPLER_VST3` and `LMMS_SURGE_XT_VST3`. Copy those into your MCP client's environment and restart it.

Point the plug-in settings at the `.vst3` folder. If a setting points at a file inside it (for example `Contents/x86_64-linux/DecentSampler.so`), the worker walks up to the folder itself, because pedalboard fails to scan the inner `.so` on Linux with "scan failure". Windows is left as it was.

## Where LMMS keeps its data

The server looks for LMMS presets and samples in `<folder of lmms>/data`, then `<folder of lmms>/../share/lmms`, then `/usr/share/lmms` and `/usr/local/share/lmms`, and uses the first that exists. A bare `lmms` command is found through `PATH` first. `LMMS_PRESETS` and `LMMS_SAMPLES` still override.

## Decent Sampler loading

Decent Sampler applies a newly set state on a background thread, which takes about 0.2 to 0.7 s, and pedalboard rebuilds the plug-in from its saved state on every call. A render that begins first plays the old empty preset and is silent. `sampler/ds_state.py` now polls the plug-in's state until the preset XML holds a `<sample` element, and only then plays the sound check that waits for audio (the check added earlier for large libraries). A preset that never applies fails with a clear error after 10 seconds.

## Timeouts

- Plug-ins start with `initialization_timeout=3` (seconds). Set `LMMS_VST3_INIT_TIMEOUT` to change it.
- The render allowance is 60 s plus, for each track, 60 s and half a second per second of audio, never below 590 s and never above one hour: eight tracks of ten minutes get about 49 minutes. Set `LMMS_VST3_TIMEOUT_SECONDS` to choose it yourself. Your MCP client has its own tool timeout, which must be at least as long.

## Render options

All are per track on `render_vst3_stems`.

| Option | What it does |
| --- | --- |
| `noteMap` | Moves notes before the instrument hears them. Keys are source MIDI notes or `*` for any other note. LMMS exports drum tracks at note 69, so a kick track uses `{"*": 36}`, snare `{"*": 38}`, ride `{"*": 51}`, crash `{"*": 49}`. |
| `transpose` | Shifts every note by semitones, after `noteMap`. |
| `noteRange` | The `[lowest, highest]` key the instrument plays, for the warning below. A `dspreset` supplies it from its samples. |
| `normalise` | Brings the stem to this peak level in dBFS before `gainDb` is added. |
| `gainDb` | The cap is now +36 dB (was +12). The shared gain still stops the mix clipping. |

When notes fall outside the range (from the preset, or `noteRange`), or leave the 0 to 127 keyboard after the map and transpose, the result carries a `warnings` list. Out-of-range notes are still sent (they are silent); notes off the keyboard are dropped.

## Mastering ceiling

`ceilingDb` on `render_mix`, `export_game_audio` and the DJ tools is now a true-peak ceiling. The limiter measures the 4x oversampled peak and lowers its sample ceiling until the true peak is under the ceiling, so a -1 dB ceiling gives about -1 dBTP rather than -0.3 dBTP. The mastering report adds `truePeakDbfs`. Expect slightly more gain reduction than before on bright material.

## Decent Sampler log files

On Linux each Decent Sampler instance writes a log file into `~/.config/DecentSampler/`, and a long session of renders leaves many of them. The exact file names depend on the Decent Sampler version. They are harmless. To remove the ones a render wrote, pass `cleanupLogs: true` to `render_vst3_stems`: it deletes only `*.log` files directly in that folder that were modified after the render began, and leaves everything else (presets, settings, older logs). It does nothing on Windows.

## Checks

- `python -m unittest discover -s sampler` and `npm test` run on any machine without a plug-in. They cover the state wait with a fake plug-in, bundle lookup, note map, transpose, range warnings, log cleanup, data directory lookup, timeouts, the true-peak limiter and the setup script.
- `python sampler/check_real_plugin.py` is an optional check that loads a real Decent Sampler, applies a one-note preset and requires sound. It prints `SKIP` and exits 0 when `LMMS_DECENT_SAMPLER_VST3` is not set to an existing plug-in or pedalboard is missing. Run it with the Python from `LMMS_VST3_PYTHON`.
