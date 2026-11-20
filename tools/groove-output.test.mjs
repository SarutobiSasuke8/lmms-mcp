import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import midiPackage from '@tonejs/midi';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { humanize, applyGroove, extractGroove, applyExtracted } from './groove.mjs';

test('humanize converts milliseconds at the declared BPM and stays seed stable', () => {
  const notes = Array.from({ length: 64 }, (_, i) => ({ tick: 100 + i * 12, midi: 42, velocity: 80, length: 6 }));
  const options = { timingMs: 40, bpm: 60, seed: 17 };
  assert.deepEqual(humanize(notes, options), humanize(notes, options));
  const slow = humanize(notes, options), fast = humanize(notes, { ...options, bpm: 240 });
  slow.forEach((n, i) => {
    assert.ok(Math.abs(n.tick - notes[i].tick) <= 2);
    assert.ok(Math.abs(fast[i].tick - notes[i].tick) <= 8);
  });
  assert.notDeepEqual(slow, fast);
});

test('reference extraction normalises PPQ and named clave/half-time fixes remain', () => {
  const midi = new midiPackage.Midi();
  const track = midi.addTrack();
  for (const tick of [0, 14, 24, 38]) track.addNote({ midi: 42, ticks: tick * midi.header.ppq / 48, durationTicks: 10 });
  const offsets = extractGroove(midi);
  assert.equal(offsets[1], 2);
  assert.equal(applyExtracted([{ tick: 12, midi: 42 }], offsets, 1)[0].tick, 14);
  assert.equal(applyGroove([{ tick: 48, midi: 38 }], 'half-time')[0].tick, 96);
  assert.ok(applyGroove([{ tick: 0, midi: 42, velocity: 80 }], 'afro-clave')[0].velocity > 80);
});

test('all five tools write seed-stable MIDI and editable project notes through MCP', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'lmms-groove-'));
  const client = new Client({ name: 'groove-regression', version: '0.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../server.mjs', import.meta.url))], env: { ...process.env, LMMS_WORKSPACE: workspace } }));
    const call = async (name, args) => {
      const response = await client.callTool({ name, arguments: args });
      assert.ok(!response.isError, response.content[0].text);
      return JSON.parse(response.content[0].text);
    };
    const names = ['apply_groove', 'humanize', 'add_ghost_notes', 'add_fills', 'layer_drums'];
    const notes = [0, 12, 24, 36].map(tick => ({ tick, midi: 42, velocity: 80, length: 6 }));
    const listed = (await client.listTools()).tools;
    for (const name of names) {
      const schema = listed.find(t => t.name === name).inputSchema;
      assert.equal(schema.properties.notes.items.type, 'object');
      assert.equal(schema.properties.bpm.minimum, 45);
      const args = { notes, bpm: 174, output: `${name}.mmp` };
      const result = await call(name, args);
      const repeat = await call(name, { ...args, output: `${name}-repeat.mmp` });
      assert.deepEqual(result.notes, repeat.notes);
      const midi = new midiPackage.Midi(await readFile(path.join(workspace, result.midi)));
      assert.equal(midi.tracks[0].channel, 9);
      assert.equal(midi.tracks[0].notes.length, result.notes.length);
      assert.ok(Math.abs(midi.header.tempos[0].bpm - 174) < 0.001);
      assert.deepEqual(midi.tracks[0].notes.map(n => Math.round(n.ticks * 48 / midi.header.ppq)), result.notes.map(n => n.tick).sort((a,b) => a-b));
      const xml = await readFile(path.join(workspace, result.project), 'utf8');
      assert.match(xml, /bpm="174"/);
      assert.equal((xml.match(/<note /g) ?? []).length, result.notes.length);
      assert.equal(await readFile(path.join(workspace, result.project), 'utf8'), await readFile(path.join(workspace, repeat.project), 'utf8'));
    }
    const ref = new midiPackage.Midi();
    ref.addTrack().addNote({ midi: 42, ticks: 140, durationTicks: 10 });
    await writeFile(path.join(workspace, 'reference.mid'), ref.toArray());
    const extracted = await call('apply_groove', { notes, template: 'midi', referenceMidi: 'reference.mid', output: 'extracted.mmp' });
    assert.equal(extracted.notes[1].tick, 14);
    const invalid = await client.callTool({ name: 'humanize', arguments: { notes: [{ tick: -1, midi: 42 }] } });
    assert.ok(invalid.isError);
    await writeFile(path.join(workspace, 'protected.mid'), 'preserve');
    const refused = await client.callTool({ name: 'humanize', arguments: { notes, output: 'protected.mmp' } });
    assert.ok(refused.isError);
    assert.equal(await readFile(path.join(workspace, 'protected.mid'), 'utf8'), 'preserve');
  } finally {
    await client.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
