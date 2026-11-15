import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { composePiece, register } from './compose.mjs';
import { composerProfiles } from '../composers.mjs';
import { getPersona, loadPersonas, personaSchema, register as registerPersonas, validatePersona } from './personas.mjs';

const directory = fileURLToPath(new URL('../test/fixtures/personas/', import.meta.url));
const fixture = getPersona('persona-fixture', directory);
const readJson = url => JSON.parse(readFileSync(new URL(url, import.meta.url), 'utf8'));

test('persona schema is shipped and agrees with runtime validation', () => {
  assert.deepEqual(readJson('../personas/persona.schema.json'), z.toJSONSchema(personaSchema));
  assert.ok(!loadPersonas().some(persona => persona.id === fixture.id));
  assert.deepEqual(loadPersonas(directory), [fixture]);
  assert.throws(() => validatePersona({ ...fixture, id: '../fixture' }), /id/);
  assert.throws(() => validatePersona({ ...fixture, tempo: { ...fixture.tempo, default: 120 } }), /tempo/);
  assert.throws(() => validatePersona({ ...fixture, signatureSounds: [fixture.signatureSounds[0], fixture.signatureSounds[0]] }), /Duplicate/);
  assert.throws(() => validatePersona({ ...fixture, testRender: { ...fixture.testRender, seconds: 29 } }), /seconds/);
});

test('artist references are rejected in identity, brief and nested text', () => {
  const [{ reference }] = Object.values(composerProfiles);
  const slug = reference.normalize('NFKD').replace(/[^a-z ]/gi, '').toLowerCase().replaceAll(' ', '-');
  assert.throws(() => validatePersona({ ...fixture, id: slug }), /Artist reference in persona.id/);
  assert.throws(() => validatePersona({ ...fixture, name: reference }), /Artist reference in persona.name/);
  assert.throws(() => validatePersona({ ...fixture, brief: reference.toUpperCase() }), /Artist reference in persona.brief/);
  assert.throws(() => validatePersona({ ...fixture, neverDo: [reference] }), /Artist reference in persona.neverDo/);
  assert.throws(() => validatePersona({ ...fixture, testRender: { ...fixture.testRender, listeningNotes: [reference] } }), /Artist reference in persona.testRender/);
});

test('loader reports the offending file and rejects filename and id drift', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'lmms-persona-'));
  try {
    await writeFile(path.join(scratch, 'other.json'), JSON.stringify(fixture));
    assert.throws(() => loadPersonas(scratch), /Invalid persona other.json: Filename must match/);
    await writeFile(path.join(scratch, 'other.json'), '{');
    assert.throws(() => loadPersonas(scratch), /Invalid persona other.json/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('persona composition uses native voices and is seed-stable without LMMS', () => {
  const settings = { personasDirectory: directory };
  const options = { persona: fixture.id, seed: 17, bars: 16 };
  const piece = composePiece(options, settings);
  assert.deepEqual(composePiece(options, settings), piece);
  assert.equal(createHash('sha256').update(JSON.stringify(piece)).digest('hex'), '16ae670adf4fab65f00ea75cb996a0530d98935809130c41faf87828dbfe7cf0');
  assert.equal(piece.bpm, 102);
  assert.equal(piece.key, 'D dorian');
  assert.equal(piece.style, 'chiptune');
  assert.deepEqual(piece.mix, { targetLufs: -18, ceilingDb: -2 });
  assert.equal(piece.tracks[0].voice, 'pluck');
  assert.equal(piece.tracks[0].volume, 39);
  const override = composePiece({ ...options, style: 'battle', key: 'E minor', bpm: 110, voices: { lead: { voice: 'pad' } } }, settings);
  assert.deepEqual([override.style, override.key, override.bpm, override.tracks[0].voice], ['battle', 'E minor', 110, 'pad']);
  assert.throws(() => composePiece({ persona: 'missing' }, settings), /Unknown persona "missing"/);
});

test('MCP persona tools validate input and compose_piece saves the fixture project', async () => {
  const handlers = new Map();
  const project = {
    checkTrack: async () => {},
    createSong: (bpm, tracks, master) => ({ bpm, tracks, master }),
    setAnchor: (doc, bars) => { doc.bars = bars; },
    save: async (doc, output) => { saved = { doc, output }; },
  };
  let saved;
  const context = {
    z, project, personasDirectory: directory, moduleGuidance: [],
    schemas: { track: z.any(), projectName: z.string(), folderName: z.string(), loudnessTarget: z.number().optional(),
      ceilingTarget: z.number().optional(), presetFile: z.string(), factorySample: z.string(), workspaceWav: z.string(), volume: z.number() },
    tool: (name, _description, input, handler) => handlers.set(name, args => handler(z.object(input).parse(args))),
  };
  registerPersonas(context);
  register(context);
  const list = handlers.get('list_personas');
  assert.deepEqual(list({ kind: 'film', tags: ['MINIMAL', 'percussive'], minBpm: 115, maxBpm: 130, query: 'dry pulse' }).personas.map(persona => persona.id), [fixture.id]);
  assert.deepEqual(list({ kind: 'dj' }).personas, []);
  assert.deepEqual(list({ minBpm: 116 }).personas, []);
  assert.deepEqual(list({ tags: ['percussive', 'unknown'] }).personas, []);
  assert.throws(() => list({ minBpm: 120, maxBpm: 100 }), /minBpm/);
  const describe = handlers.get('describe_persona');
  assert.deepEqual(describe({ id: fixture.id }), fixture);
  assert.throws(() => describe({ id: 'missing' }), /Unknown persona/);
  const compose = handlers.get('compose_piece');
  const result = await compose({ persona: fixture.id, output: 'fixture.mmp', seed: 17, bars: 16 });
  assert.equal(result.persona, fixture.id);
  assert.equal(result.style, 'chiptune');
  assert.equal(saved.output, 'fixture.mmp');
  assert.equal(saved.doc.bars, 16);
  assert.equal(saved.doc.bpm, 102);
  assert.ok(saved.doc.tracks[0].patterns[0].notes.length > 0);
  await assert.rejects(compose({ persona: 'missing', output: 'missing.mmp' }), /Unknown persona/);
});
