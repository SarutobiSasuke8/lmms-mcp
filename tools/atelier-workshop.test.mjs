import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { loadWorkshop, notesToPattern, register, sampleTrack } from './atelier-workshop.mjs';

test('notes in beats become an LMMS pattern at 48 ticks a beat', () => {
  const { pattern, dropped } = notesToPattern([
    { midi: 48, start: 0, duration: 0.5, velocity: 1 },
    { midi: 55, start: 4.25, duration: 0.25, velocity: 0.5 },
    { midi: 130, start: 1, duration: 1, velocity: 1 },
  ], { name: 'Bass', bar: 8, lengthBeats: 8 });
  assert.equal(dropped, 1);
  assert.deepEqual(pattern, {
    name: 'Bass', bar: 8, bars: 2,
    notes: [{ tick: 0, length: 24, midi: 48, velocity: 100 }, { tick: 204, length: 12, midi: 55, velocity: 50 }],
  });
  assert.equal(notesToPattern([{ midi: 60, start: 0, duration: 1, velocity: 1 }], { name: 'x', transpose: 12 }).pattern.notes[0].midi, 72);
});

test('a sample track covers the audio from the chosen bar', () => {
  const track = sampleTrack({ name: 'Riser', sample: 'riser.wav', bar: 12, seconds: 7.5, bpm: 128, role: 'fx' });
  assert.equal(track.voice, 'sample');
  assert.equal(track.role, 'fx');
  assert.deepEqual(track.patterns[0], { name: 'Riser', bar: 12, bars: 4, notes: [{ tick: 0, length: 768, midi: 69, velocity: 100 }] });
});

test('a missing checkout gives an actionable message', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'atelier-missing-'));
  try {
    await assert.rejects(loadWorkshop(root), /LMMS_ATELIER_INSTRUMENTS/);
    await assert.rejects(loadWorkshop('relative/path'), /absolute directory path/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const checkout = process.env.LMMS_ATELIER_INSTRUMENTS;

test('tools render, process and return notes through a real checkout', { skip: !checkout && 'set LMMS_ATELIER_INSTRUMENTS to run' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'atelier-workshop-'));
  const tools = new Map();
  const wav = z.string().regex(/^[a-z0-9_-]+\.wav$/i);
  register({
    root, z,
    schemas: { wavName: wav, workspaceWav: wav, projectName: z.string().regex(/\.mmpz?$/), volume: z.number().min(0).max(200) },
    project: {},
    tool: (name, _description, input, handler) => { tools.set(name, args => handler(z.object(input).parse(args))); },
  });
  try {
    const list = (await tools.get('atelier_list_instruments')({})).instruments;
    assert.ok(list.some(i => i.id === 'trailer-riser' && i.role === 'generator'));
    const described = await tools.get('atelier_describe_instrument')({ instrument: 'trailer-riser', preset: 'Hard Cut' });
    assert.equal(described.schema.additionalProperties, false);
    assert.equal(described.presetParams.kind, 'impact');

    const hit = await tools.get('atelier_render')({ instrument: 'trailer-riser', preset: 'Hard Cut', output: 'hit.wav' });
    assert.equal(hit.sampleRate, 48000);
    assert.ok(hit.peakDb < 0 && hit.peakDb > -20);
    assert.equal((await readFile(path.join(root, 'hit.wav'))).subarray(0, 4).toString(), 'RIFF');
    await assert.rejects(tools.get('atelier_render')({ instrument: 'trailer-riser', output: 'hit.wav' }), /EEXIST/);
    await assert.rejects(tools.get('atelier_render')({ instrument: 'game-sfx', params: { pich: 1 }, output: 'x.wav' }), /pich is not a known field/);

    const glitched = await tools.get('atelier_process')({ instrument: 'tape-glitch', input: 'hit.wav', params: { scripted: true }, output: 'hit-glitch.wav' });
    assert.equal(glitched.channels, 2);

    const notes = await tools.get('atelier_notes')({ instrument: 'acid-bass', preset: 'Neon Alley', bar: 4 });
    assert.equal(notes.pattern.bar, 4);
    assert.ok(notes.pattern.notes.every(n => Number.isInteger(n.tick) && n.velocity >= 1 && n.velocity <= 200));
    await writeFile(path.join(root, 'outside.txt'), 'x');
    await assert.rejects(async () => tools.get('atelier_process')({ instrument: 'tape-glitch', input: '../escape.wav', output: 'y.wav' }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
