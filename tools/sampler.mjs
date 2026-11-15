// Sampled instruments: convert SFZ libraries to Decent Sampler presets for render_vst3_stems.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const converter = fileURLToPath(new URL('../sampler/sfz2dspreset.py', import.meta.url));

// A library-relative path that cannot leave the library folder.
export function resolveInLibrary(library, relative) {
  relative = relative.replace(/\\/g, '/'); // accept Windows-style separators on every platform
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Give the .sfz path relative to LMMS_SAMPLE_LIBRARIES, without ..');
  const full = path.resolve(library, relative);
  const inside = path.relative(library, full);
  if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('The .sfz file must be inside LMMS_SAMPLE_LIBRARIES');
  return full;
}

export function parseSummary(text) {
  const match = /(\d+) samples written, (\d+) regions skipped, (\d+) missing files(?: e\.g\. (.+))?/.exec(text);
  if (!match) throw new Error('Unexpected converter output: ' + text.slice(0, 200));
  return { samples: Number(match[1]), skippedRegions: Number(match[2]), missingFiles: Number(match[3]), firstMissing: match[4]?.trim() };
}

export function register({ tool, z, root, moduleGuidance }) {
  moduleGuidance.push('For sampled instruments, put open SFZ libraries under LMMS_SAMPLE_LIBRARIES, run convert_sfz on each, then pass the .dspreset to render_vst3_stems with the decent-sampler instrument. See docs/sampler.md.');
  tool('convert_sfz', 'Convert an SFZ instrument from LMMS_SAMPLE_LIBRARIES into a Decent Sampler .dspreset in the workspace, with absolute sample paths. Handles #define, #include (also inside a header line), scope inheritance, key and velocity ranges, loops, round robin and envelopes. Keyswitched articulations (sw_last / sw_lokey ranges) are kept as switchable Decent Sampler groups. Legato and vibrato (CC1/LFO) hints are preserved where present. It applies controller modulation at default values. It skips cc-gated layers, controller-triggered regions such as pedal noise, and filters. Reports missing sample files, which are skipped.', {
    sfz: z.string().min(5).max(200).regex(/\.sfz$/i).describe('Path of the .sfz file relative to LMMS_SAMPLE_LIBRARIES.'),
    output: z.string().regex(/^[a-z0-9][a-z0-9 _-]{0,99}\.dspreset$/i),
    only: z.string().max(60).regex(/^[\w ./-]*$/).default('').describe('Keep only regions whose sample path contains this text, for example "alt_" or "/mid/".'),
    keepReleases: z.boolean().default(false).describe('Also convert release-trigger samples, such as string resonance and hammer noise, as Decent Sampler release groups that play when a note ends. Use it for the Salamander piano.'),
  }, async ({ sfz, output, only, keepReleases }) => {
    const libraryEnv = process.env.LMMS_SAMPLE_LIBRARIES;
    if (!libraryEnv || !existsSync(libraryEnv)) throw new Error('Set LMMS_SAMPLE_LIBRARIES to the folder that holds your SFZ libraries. See docs/sampler.md.');
    // Keep the configured spelling: realpath can rewrite the folder (for example through a packaged-app redirect) to a path the plugin cannot open.
    // The converter checks containment with realpath on both sides.
    const library = path.resolve(libraryEnv);
    const source = resolveInLibrary(library, sfz);
    if (!(await lstat(source).catch(() => null))?.isFile()) throw new Error('No such .sfz file in LMMS_SAMPLE_LIBRARIES');
    const target = path.join(root, output);
    if (existsSync(target)) throw new Error('Output already exists');
    const args = [converter, source, target, '--abs', '--within', library];
    if (only) args.push('--only', only);
    if (keepReleases) args.push('--keep-releases');
    let stdout;
    try {
      ({ stdout } = await run(process.env.LMMS_VST3_PYTHON ?? 'python', args, { timeout: 120000, windowsHide: true }));
    } catch (error) {
      await rm(target, { force: true });
      throw new Error('Converter failed: ' + (error.stderr || error.message).toString().trim().split(/\r?\n/).at(-1));
    }
    const summary = parseSummary(stdout.trim().split(/\r?\n/).at(-1));
    if (summary.samples === 0) {
      await rm(target, { force: true });
      throw new Error(`No samples were converted (${summary.missingFiles} files missing, ${summary.skippedRegions} regions skipped). Check the library path and the sparse checkout.`);
    }
    return { output, ...summary, note: 'Pass this file as dspreset to render_vst3_stems with instrument decent-sampler. Keep the library where it is: the preset points at its files.' };
  });
}
