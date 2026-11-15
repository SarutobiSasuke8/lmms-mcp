#!/usr/bin/env node
// Compose, render and rank pieces from the command line, with no AI agent involved.
//   lmms-compose --style chiptune --seconds 45 --count 6 --name chip
//   lmms-compose recipe.json            (a JSON file with the same fields)
// Needs LMMS installed. Files go to LMMS_WORKSPACE (default: the current folder).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  style: { type: 'string' }, key: { type: 'string' }, bpm: { type: 'string' }, seconds: { type: 'string' }, bars: { type: 'string' },
  count: { type: 'string' }, seed: { type: 'string' }, name: { type: 'string' }, help: { type: 'boolean', short: 'h' },
} });
if (values.help) {
  console.log('Usage: lmms-compose [recipe.json] [--style chiptune|adventure|battle|ballad|swing] [--key "D minor"] [--bpm 120]\n       [--seconds 60 | --bars 32] [--count 6] [--seed 1] [--name piece]\nComposes --count seeds, renders each with LMMS and prints them ranked by measured checks.');
  process.exit(0);
}
const fromFile = positionals[0] ? JSON.parse(await readFile(positionals[0], 'utf8')) : {};
const number = (value, label) => { if (value === undefined) return undefined; const n = Number(value); if (!Number.isFinite(n)) throw new Error(`--${label} must be a number`); return n; };
const recipe = { ...fromFile };
for (const field of ['style', 'key']) if (values[field] !== undefined) recipe[field] = values[field];
for (const field of ['bpm', 'seconds', 'bars']) if (values[field] !== undefined) recipe[field] = number(values[field], field);
const count = number(values.count, 'count') ?? fromFile.count ?? 1;
const seed = number(values.seed, 'seed') ?? fromFile.seed ?? 1;
const name = values.name ?? fromFile.name ?? 'piece';
delete recipe.count; delete recipe.seed; delete recipe.name;

const workspace = path.resolve(process.env.LMMS_WORKSPACE ?? process.cwd());
const client = new Client({ name: 'lmms-compose', version: '1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./server.mjs', import.meta.url))], env: { ...process.env, LMMS_WORKSPACE: workspace } }));
async function call(tool, args) {
  const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 3600000 });
  const text = result.content.find(item => item.type === 'text')?.text ?? '';
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
}
try {
  if (count > 1) {
    const { ranking } = await call('compose_batch', { ...recipe, name, count, seedStart: seed });
    console.log(`Ranked ${ranking.length} pieces in ${workspace}\n`);
    for (const piece of ranking) {
      console.log(`${String(piece.rank).padStart(2)}. ${piece.audio}  score ${piece.score}  (arrangement and mix ${piece.arrangementAndMix}, tune ${piece.tune})  ${piece.key}, ${piece.integratedLufs} LUFS`);
      for (const line of [...piece.findings, ...piece.mixWarnings].slice(0, 3)) console.log(`      - ${line}`);
    }
    console.log('\nThe scores catch faults. Listen to the top few and choose by ear.');
  } else {
    const project = `${name}-s${seed}.mmp`, audio = `${name}-s${seed}.wav`;
    const piece = await call('compose_piece', { ...recipe, output: project, seed });
    const render = await call('render_mix', { project, output: audio, tail: 'keep', targetLufs: -16, ceilingDb: -1.5 });
    console.log(`${audio}: ${piece.style} in ${piece.key}, ${piece.bpm} BPM, ${render.durationSeconds} s, ${render.integratedLufs} LUFS, tune score ${piece.tune.score}\nProject: ${path.join(workspace, project)}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
