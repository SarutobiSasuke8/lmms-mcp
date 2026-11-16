// Helpers that let the real-instrument route (Decent Sampler and Surge XT as VST3) run on Linux as well as Windows.
// server.mjs imports the pure functions; register() only adds guidance. See docs/linux-real-instruments.md.
import { existsSync } from 'node:fs';
import path from 'node:path';

// Where LMMS keeps its presets and samples. A Windows install has them beside the executable,
// a Linux install keeps them in a share/lmms folder next to the prefix that holds bin/.
export function lmmsDataCandidates(lmmsPath, { platform = process.platform, pathEnv = process.env.PATH ?? '', exists = existsSync } = {}) {
  const pathModule = platform === 'win32' ? path.win32 : path.posix;
  const dirs = [];
  const add = dir => { if (dir && !dirs.includes(dir)) dirs.push(dir); };
  const hasDirectory = /[\\/]/.test(lmmsPath);
  const folders = [];
  if (hasDirectory) folders.push(pathModule.dirname(lmmsPath));
  else for (const entry of pathEnv.split(platform === 'win32' ? ';' : ':')) {
    if (!entry) continue;
    for (const name of platform === 'win32' ? [lmmsPath + '.exe', lmmsPath] : [lmmsPath]) {
      if (exists(pathModule.join(entry, name))) { folders.push(entry); break; }
    }
  }
  if (!folders.length) folders.push(pathModule.dirname(lmmsPath)); // keeps the old behaviour when nothing is found
  for (const folder of folders) {
    add(pathModule.join(folder, 'data'));
    if (folder !== '.') add(pathModule.resolve(folder, '..', 'share', 'lmms'));
  }
  if (platform !== 'win32') {
    add('/usr/share/lmms');
    add('/usr/local/share/lmms');
  }
  return dirs;
}

// The first candidate that exists, or the first candidate, so a missing install fails with the familiar path.
export function lmmsDataDirectory(lmmsPath, options = {}) {
  const exists = options.exists ?? existsSync;
  const candidates = lmmsDataCandidates(lmmsPath, options);
  return candidates.find(candidate => exists(candidate)) ?? candidates[0];
}

// Milliseconds to allow the VST3 worker. Each track loads its instrument and renders the whole length,
// so the allowance grows with both. Never less than the old fixed 590 s. LMMS_VST3_TIMEOUT_SECONDS overrides it.
export function renderTimeoutMs(trackCount, durationSeconds, env = process.env) {
  const override = Number(env.LMMS_VST3_TIMEOUT_SECONDS);
  if (Number.isFinite(override) && override > 0) return Math.round(Math.min(override, 6 * 3600) * 1000);
  const seconds = 60 + trackCount * (60 + 0.5 * durationSeconds);
  return Math.round(Math.min(Math.max(590, seconds), 3600) * 1000);
}

// Text for list_external_tools: what to run on this platform.
export function vst3SetupText(platform = process.platform) {
  if (platform === 'win32') {
    return 'On Windows x64 with Python 3.9 or newer, run setup-vst3-windows.ps1 from the package. See the README for manual setup.';
  }
  if (platform === 'linux') {
    return 'On Linux x86_64, run setup-vst3-linux.sh from the package (needs python3 with venv, curl or your own downloads, and sha256sum). '
      + 'Point LMMS_DECENT_SAMPLER_VST3 and LMMS_SURGE_XT_VST3 at the .vst3 bundle folders. See docs/linux-real-instruments.md.';
  }
  return 'Install pedalboard and mido in a Python virtual environment, set LMMS_VST3_PYTHON and point LMMS_DECENT_SAMPLER_VST3 and LMMS_SURGE_XT_VST3 at the plug-ins. See the README. Windows and Linux are the tested platforms.';
}

// A note map is { "69": 36, "*": 38 }: source MIDI note to the note the instrument should hear, with "*" for any other note.
export const noteMapKey = /^(?:\d{1,3}|\*)$/;
export function checkNoteMap(map) {
  for (const [from, to] of Object.entries(map ?? {})) {
    if (!noteMapKey.test(from) || (from !== '*' && Number(from) > 127)) throw new Error(`Note map key ${from} must be a MIDI note from 0 to 127 or *`);
    if (!Number.isInteger(to) || to < 0 || to > 127) throw new Error(`Note map value for ${from} must be a MIDI note from 0 to 127`);
  }
  return map ?? {};
}

export function register({ moduleGuidance }) {
  moduleGuidance?.push('Real instruments on Linux: run setup-vst3-linux.sh, then render_vst3_stems. For drums and sampled instruments use noteMap to move notes to the keys the kit uses, transpose to fit a range, and normalise to level a quiet stem. See docs/linux-real-instruments.md.');
}
