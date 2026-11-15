import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generationStore } from './generations.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lmms-generations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'mix.wav'), 'stub');
  return { root, store: generationStore(root) };
}

test('render metadata is hashed, written next to the output and deduplicated', async t => {
  const { root, store } = await fixture(t);
  const args = { project: 'theme.mmp', output: 'mix.wav' };
  const result = { audio: args.output, durationSeconds: 9, integratedLufs: -16, truePeakDbfs: -2 };
  const [[first], [second]] = await Promise.all([store.record('render_mix', args, result), store.record('render_mix', args, result)]);
  assert.equal(first, second);
  const manifest = await store.show(first);
  assert.deepEqual(manifest.files, [{ path: 'mix.wav', sha256: createHash('sha256').update('stub').digest('hex') }]);
  assert.equal(manifest.publishable, false);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, manifest.locations.local), 'utf8')), manifest);
  assert.deepEqual(await store.backfill('.'), []);
});

test('catalogue ratings are append-only and filters combine with explicit licence provenance', async t => {
  const { root, store } = await fixture(t);
  await mkdir(path.join(root, 'game'));
  await writeFile(path.join(root, 'game', 'cue.ogg'), 'music');
  const [id] = await store.backfill('game', ['salamander-grand-piano'], 'forest');
  await store.rate(id, 4, 'Audition feedback saved');
  assert.equal((await store.show(id)).publishable, true);
  const [record] = await store.list({ game: 'forest', rating: 4, licence: 'CC-BY-3.0' });
  assert.equal(record.feedback, 'Audition feedback saved');
  assert.deepEqual(await store.list({ rating: 5 }), []);
  assert.equal((await readFile(path.join(root, 'catalog', 'catalog.jsonl'), 'utf8')).trim().split('\n').length, 2);
  assert.equal(JSON.parse(await readFile(path.join(root, record.locations.local), 'utf8')).rating, null);
});

test('one-shot export records WAV and manifest together from its output argument', async t => {
  const { root, store } = await fixture(t);
  await mkdir(path.join(root, 'kit'));
  await writeFile(path.join(root, 'kit', 'kick.wav'), 'kick');
  await writeFile(path.join(root, 'kit', 'manifest.json'), '{}');
  const [id] = await store.record('export_one_shots', { outputDirectory: 'kit' }, { files: [{ file: 'kick.wav' }] });
  assert.deepEqual((await store.show(id)).files.map(file => file.path), ['kit/kick.wav', 'kit/manifest.json']);
});

test('catalogue rejects inputs outside the workspace', async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.backfill('..'), /outside the workspace/);
});
