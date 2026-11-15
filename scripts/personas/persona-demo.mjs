// Render a measured demo of a film persona through the LMMS MCP server.
//   node scripts/personas/persona-demo.mjs --persona action-score [--mode native|sampled|both] [--workspace <dir>] [--seed <n>] [--seconds <n>]
// Native uses stock LMMS voices and needs only LMMS. Sampled plays the same notes through Decent Sampler with the CC0 VSCO 2 CE
// library, one library file per articulation (live keyswitching waits for the SFZ keyswitch fix). Both skip cleanly when
// their requirements are missing, and say so. The report is measurement only: nothing here hears the audio.
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildCue, cuePersonas, cueProject } from './persona-cues.mjs';
import { articulationContrast, measureWav } from './persona-measure.mjs';
import { getPersona } from '../../tools/personas.mjs';

export function lmmsAvailable(env = process.env) {
  const executable = env.LMMS_EXECUTABLE ?? (process.platform === 'win32' ? 'C:/Program Files/LMMS/lmms.exe' : 'lmms');
  return path.isAbsolute(executable) ? existsSync(executable) : true; // a bare command is resolved by the server, which reports it if it is missing
}
export function sampledRequirements(env = process.env) {
  const missing = [];
  if (!env.LMMS_VST3_PYTHON || !existsSync(env.LMMS_VST3_PYTHON)) missing.push('LMMS_VST3_PYTHON');
  if (!env.LMMS_DECENT_SAMPLER_VST3 || !existsSync(env.LMMS_DECENT_SAMPLER_VST3)) missing.push('LMMS_DECENT_SAMPLER_VST3');
  if (!env.LMMS_SAMPLE_LIBRARIES || !existsSync(path.join(env.LMMS_SAMPLE_LIBRARIES, 'VSCO-2-CE'))) missing.push('LMMS_SAMPLE_LIBRARIES with VSCO-2-CE');
  return missing;
}

async function connect(workspace, env) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'lmms-mcp-persona-demo', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../../server.mjs', import.meta.url))], env: { ...env, LMMS_WORKSPACE: workspace } }));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 590000 });
    if (result.isError) throw new Error(`${name}: ${result.content[0].text}`);
    return JSON.parse(result.content[0].text);
  };
  return { client, call };
}

function attachContrast(measured, contrast) {
  if (!contrast) return;
  measured.articulationContrast = contrast.pairs;
  measured.checks.push(...contrast.checks);
}
const contrastIds = cue => [...new Set((cue.contrast ?? []).flatMap(pair => [pair.legato, pair.short]))];

async function renderNative({ call, workspace, cue, persona }) {
  const project = cueProject(cue), name = `${cue.persona}-s${cue.seed}-native`;
  await call('create_project', { output: `${name}-base.mmp`, bpm: project.bpm, lengthBars: project.lengthBars, masterVolume: project.masterVolume, tracks: project.tracks });
  let source = `${name}-base.mmp`;
  if (project.edits.length) {
    await call('apply_edits', { project: source, output: `${name}.mmp`, edits: project.edits });
    source = `${name}.mmp`;
  }
  const render = await call('render_mix', { project: source, output: `${name}.wav`, tail: 'cut', targetLufs: persona.mix.targets.lufs, ceilingDb: persona.mix.targets.truePeakDb - 0.6 });
  const measured = measureWav(await readFile(path.join(workspace, `${name}.wav`)), cue);
  if (cue.contrast) {
    const pair = contrastIds(cue);
    await call('render_stems', { project: source, outputDirectory: `${name}-stems`, tracks: pair });
    const files = await readdir(path.join(workspace, `${name}-stems`)); // render_stems numbers each file by track position
    const stems = Object.fromEntries(await Promise.all(pair.map(async id => [id, await readFile(path.join(workspace, `${name}-stems`, files.find(file => file.endsWith(`_${id}.wav`))))])));
    attachContrast(measured, articulationContrast(cue, stems));
  }
  return { route: 'native', audio: path.join(workspace, `${name}.wav`), project: path.join(workspace, source), render: { mastering: render.mastering }, measured };
}

async function renderSampled({ call, workspace, cue, persona }) {
  const project = cueProject(cue), name = `${cue.persona}-s${cue.seed}-sampled`;
  const tailBars = cue.persona === 'horror-suspense' ? 1 : 2, totalBars = cue.bars + tailBars, seconds = totalBars * 240 / cue.bpm;
  await call('create_project', { output: `${name}-base.mmp`, bpm: project.bpm, lengthBars: totalBars, masterVolume: project.masterVolume, tracks: project.tracks });
  await call('export_midi', { project: `${name}-base.mmp`, output: `${name}.mid` });
  const sampled = cue.parts.filter(part => part.sampled), presets = new Map();
  if (sampled.length > 8) throw new Error('render_vst3_stems takes up to 8 tracks');
  for (const part of sampled) {
    if (presets.has(part.sampled.sfz)) continue;
    const output = `${cue.persona}-${part.sampled.sfz.split('/').pop().replace(/\.sfz$/, '').toLowerCase()}.dspreset`;
    await call('convert_sfz', { sfz: part.sampled.sfz, output });
    presets.set(part.sampled.sfz, output);
  }
  const hall = cue.persona === 'horror-suspense' ? { type: 'cathedral', wetDb: -9, width: 0.7 } : { type: 'hall', wetDb: -13, width: 0.6 };
  const stems = await call('render_vst3_stems', {
    midi: `${name}.mid`, outputDirectory: `${name}-stems`, durationSeconds: seconds,
    tracks: sampled.map(part => ({ track: part.id, name: part.id, instrument: 'decent-sampler', dspreset: presets.get(part.sampled.sfz), gainDb: part.sampled.gainDb ?? 0,
      eq: [{ type: 'highpass', hz: part.role === 'bass' || part.role === 'drums' ? 30 : 70 }], space: hall })),
  });
  // Master through LMMS, as the sampled-music skill does, so loudness and ceiling come from the same renderer.
  await call('create_project', { output: `${name}-master.mmp`, bpm: cue.bpm, lengthBars: totalBars, masterVolume: 100, tracks: [{ name: 'Mix', voice: 'sample', sample: `${name}-stems/mix.wav`, volume: 100,
    patterns: [{ name: 'Mix', bar: 0, bars: totalBars, notes: [{ tick: 0, length: totalBars * 192, midi: 69, velocity: 100 }] }] }] });
  const render = await call('render_mix', { project: `${name}-master.mmp`, output: `${name}.wav`, tail: 'cut', targetLufs: persona.mix.targets.lufs, ceilingDb: persona.mix.targets.truePeakDb - 0.6 });
  const measured = measureWav(await readFile(path.join(workspace, `${name}.wav`)), cue);
  if (cue.contrast) {
    const stems = Object.fromEntries(await Promise.all(contrastIds(cue).map(async id => [id, await readFile(path.join(workspace, `${name}-stems`, `${id}.wav`))])));
    attachContrast(measured, articulationContrast(cue, stems));
  }
  return { route: 'sampled', audio: path.join(workspace, `${name}.wav`), stems: stems.directory, tailBars, sharedGain: stems.sharedGain,
    library: 'VSCO 2 CE (CC0), one SFZ file per articulation', render: { mastering: render.mastering }, measured };
}

export async function runDemo(id, { workspace, mode = 'both', seed, seconds, env = process.env } = {}) {
  const persona = getPersona(id), cue = buildCue(persona, { seed, seconds });
  const result = { persona: id, seed: cue.seed, bpm: cue.bpm, key: cue.key, bars: cue.bars, cueSeconds: cue.seconds, routes: [], skipped: [] };
  if (!lmmsAvailable(env)) { result.skipped.push({ route: 'all', reason: 'LMMS was not found. Set LMMS_EXECUTABLE.' }); return result; }
  await mkdir(workspace, { recursive: true });
  const missing = sampledRequirements(env), wantSampled = mode !== 'native', wantNative = mode !== 'sampled';
  const hasSampled = cue.parts.some(part => part.sampled);
  if (wantSampled && !hasSampled) result.skipped.push({ route: 'sampled', reason: 'This persona uses synth voices only' });
  else if (wantSampled && missing.length) result.skipped.push({ route: 'sampled', reason: `Missing ${missing.join(', ')}` });
  const { client, call } = await connect(workspace, env);
  try {
    if (wantNative) result.routes.push(await renderNative({ call, workspace, cue, persona }));
    if (wantSampled && hasSampled && !missing.length) result.routes.push(await renderSampled({ call, workspace, cue, persona }));
  } finally {
    await client.close();
  }
  await writeFile(path.join(workspace, `${id}-s${cue.seed}-report.json`), JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), flag = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const requested = flag('persona') ?? 'all', ids = requested === 'all' ? cuePersonas : [requested];
  const workspace = path.resolve(flag('workspace') ?? 'assets/persona-demos');
  const options = { workspace, mode: flag('mode') ?? 'both', seed: flag('seed') ? Number(flag('seed')) : undefined, seconds: flag('seconds') ? Number(flag('seconds')) : undefined };
  for (const id of ids) console.log(JSON.stringify(await runDemo(id, options), null, 2));
}
