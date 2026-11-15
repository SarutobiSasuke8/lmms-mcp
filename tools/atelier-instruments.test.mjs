import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import midiPackage from '@tonejs/midi';
import { z } from 'zod';
import * as dsp from '../audio.mjs';
import { loadInstrument, register } from './atelier-instruments.mjs';

let linked = true;
try { await loadInstrument('theremin'); }
catch (error) {
  if (!error.message.startsWith('Install or link atelier-dsp locally')) throw error;
  linked = false;
}

test('linked Atelier tools read MIDI, render presets and curves, and pad aligned WAV stems', { skip: !linked }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'atelier-instruments-'));
  const tools = new Map();
  register({ root, z, dsp, schemas: { projectName: z.string(), wavName: z.string() },
    tool: (name, _description, schema, fn) => tools.set(name, args => fn(z.object(schema).parse(args))) });
  try {
    const midi = new midiPackage.Midi();
    midi.addTrack().addNote({ midi: 64, time: 0, duration: 0.12, velocity: 0.83 });
    await writeFile(path.join(root, 'part.mid'), midi.toArray());
    const a = await tools.get('render_atelier')({ midiFile: 'part.mid', preset: 'fm-bell', output: 'atelier.wav', durationSeconds: 2 });
    assert.equal(a.frames, 96000);
    assert.equal(a.channels, 2);
    const b = await tools.get('render_theremin')({ curve: [{ time: 0, midi: 60.1 }, { time: 0.25, hz: 440 }], mode: 'scale', output: 'glide.wav', durationSeconds: 2 });
    assert.equal(b.frames, a.frames);
    const media = dsp.decodeWav(await readFile(path.join(root, b.file)));
    assert.equal(media.sampleRate, 48000);
    assert.ok(media.channels[0].some(v => Math.abs(v) > 0.01));
    assert.equal(media.channels[0].at(-1), 0);
    await assert.rejects(tools.get('render_atelier')({ output: 'invalid.wav' }), /exactly one/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
