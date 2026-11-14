import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import midiPackage from '@tonejs/midi';

const workspace = await mkdtemp(path.join(tmpdir(), 'lmms-export-check-'));
console.log(workspace);
const fixture = process.argv[2];
if (fixture) await copyFile(fixture, path.join(workspace, 'source.mmp'));
const client = new Client({ name: 'lmms-export-check', version: '1' });
await client.connect(new StdioClientTransport({
  command: process.execPath, args: [fileURLToPath(new URL('./server.mjs', import.meta.url))],
  env: { ...process.env, LMMS_WORKSPACE: workspace },
}));
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 200000 });
  assert.ok(!result.isError, result.content[0].text);
  return JSON.parse(result.content[0].text);
}
try {
  if (!fixture) {
    const notes = [0, 48, 96, 144].map((tick, i) => ({ tick, length: 24, midi: 60 + i, velocity: 75 }));
    await call('create_project', { output: 'source.mmp', bpm: 120, tracks: [
      { name: 'Lead', voice: 'pluck', volume: 45, patterns: [{ name: 'Hook', bar: 0, bars: 1, notes }] },
      { name: 'Bass', voice: 'bass', volume: 45, patterns: [{ name: 'Root', bar: 0, bars: 1, notes: notes.map(n => ({ ...n, midi: 36 })) }] },
    ] });
  }
  const source = await call('inspect_arrangement', { project: 'source.mmp' });
  const trackName = source.tracks[0].name;
  const clip = { trackName, tick: 0 };
  await call('edit_clip', { project: 'source.mmp', output: 'duplicate.mmp', ...clip, operation: 'duplicate', destinationTick: 3072 });
  await call('edit_clip', { project: 'duplicate.mmp', output: 'moved.mmp', trackName, tick: 3072, operation: 'move', destinationTick: 3264 });
  await call('edit_clip', { project: 'moved.mmp', output: 'renamed.mmp', trackName, tick: 3264, operation: 'rename', name: 'Renamed' });
  const edited = await call('inspect_arrangement', { project: 'renamed.mmp' });
  assert.ok(edited.tracks[0].clips.some(c => c.name === 'Renamed' && c.tick === 3264));
  await call('edit_clip', { project: 'renamed.mmp', output: 'trimmed.mmp', trackName, tick: 3264, operation: 'remove' });
  assert.deepEqual(await call('inspect_arrangement', { project: 'trimmed.mmp' }), source);
  await call('edit_effect', { project: 'trimmed.mmp', output: 'effect.mmp', trackName, operation: 'add', plugin: 'delay', wet: .25 });
  await call('edit_effect', { project: 'effect.mmp', output: 'bypass.mmp', trackName, operation: 'update', index: 0, enabled: false });
  assert.deepEqual(await call('inspect_effects', { project: 'bypass.mmp', trackName }), [{ plugin: 'delay', enabled: false, wet: .25 }]);
  await call('edit_effect', { project: 'bypass.mmp', output: 'no-effect.mmp', trackName, operation: 'remove', index: 0 });
  assert.deepEqual(await call('inspect_effects', { project: 'no-effect.mmp', trackName }), []);
  const result = await call('export_midi', { project: 'source.mmp', output: 'song.mid' });
  const midi = new midiPackage.Midi(await readFile(path.join(workspace, result.file)));
  assert.equal(midi.header.tempos[0].bpm, source.tempo);
  assert.deepEqual(midi.tracks.map(t => ({ name: t.name, notes: t.notes.length })), result.tracks);
  const notes = (await call('read_pattern', { project: 'source.mmp', trackName, bar: 0 })).notes;
  assert.deepEqual(midi.tracks[0].notes.slice(0, notes.length).map(n => ({ midi: n.midi, tick: n.ticks / (midi.header.ppq / 48) })), notes.map(n => ({ midi: n.midi, tick: n.tick })));
  const wet = await call('render_mix', { project: 'effect.mmp', output: 'effect.wav' });
  const dry = await call('render_mix', { project: 'bypass.mmp', output: 'dry.wav' });
  assert.equal(wet.durationSeconds, dry.durationSeconds);
  assert.notDeepEqual(await readFile(path.join(workspace, 'effect.wav')), await readFile(path.join(workspace, 'dry.wav')));
  const stems = await call('render_stems', { project: 'source.mmp', outputDirectory: 'stems' });
  assert.equal(stems.stems.length, result.tracks.length);
  assert.ok(stems.stems.every(stem => stem.durationSeconds === dry.durationSeconds && stem.peakDbfs !== null));
  console.log(JSON.stringify({ midi: result, wet, dry, stems }, null, 2));
} finally {
  await client.close();
}
