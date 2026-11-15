import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { planNightly, runNightly } from '../nightly.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lmms-nightly-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'list.json');
  await writeFile(input, JSON.stringify(['forest.json']));
  await writeFile(path.join(root, 'forest.json'), JSON.stringify({
    game: 'forest', cues: [{ id: 'menu', style: 'ballad', count: 3, keep: 1 }],
  }));
  return { root, input, out: path.join(root, 'output') };
}

test('planner resolves relative recipes and rejects duplicate cues', async t => {
  const { root, input } = await fixture(t);
  assert.equal((await planNightly(input))[0].cues[0].id, 'menu');
  await writeFile(path.join(root, 'forest.json'), JSON.stringify({
    game: 'forest', cues: [{ id: 'menu' }, { id: 'menu' }],
  }));
  await assert.rejects(planNightly(input), /duplicate cue ID/);
});

test('runner keeps winners, builds indices and retains only owned dates', async t => {
  const { input, out } = await fixture(t);
  await mkdir(path.join(out, '2026-01-01'), { recursive: true });
  await mkdir(path.join(out, '2026-01-02'));
  await writeFile(path.join(out, '2026-01-02', '.lmms-nightly'), 'lmms-compose nightly\n');
  const result = await runNightly(input, {
    out, now: new Date('2026-11-15T02:15:00Z'), keepDays: 7, minFreeMib: 1,
    connect: async folder => ({
      close: async () => {},
      async call(tool, args) {
        if (tool === 'build_audition_page') {
          assert.deepEqual(args.files, ['menu-1.wav']);
          await writeFile(path.join(folder, 'index.html'), 'audition');
          return {};
        }
        assert.equal(tool, 'compose_batch');
        assert.equal(args.targetLufs, -16);
        const ranking = [];
        for (const i of [1, 2, 3]) {
          const entry = { audio: `menu-${i}.wav`, project: `menu-${i}.mmp` };
          for (const name of Object.values(entry)) await writeFile(path.join(folder, name), '');
          ranking.push(entry);
        }
        return { ranking };
      },
    }),
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual((await readdir(path.join(result.folder, 'forest', 'menu'))).sort(),
    ['index.html', 'menu-1.mmp', 'menu-1.wav']);
  assert.deepEqual((await readdir(out)).sort(), ['2026-01-01', '2026-11-15', 'index.html']);
  assert.match(await readFile(path.join(out, 'index.html'), 'utf8'), /2026-11-15\/index.html/);
});

test('lock prevents overlap and a render failure is recorded and releases the lock', async t => {
  const { input, out } = await fixture(t);
  await mkdir(out);
  const lock = path.join(out, '.nightly.lock');
  await writeFile(lock, '');
  let connections = 0;
  const opts = { out, minFreeMib: 1, budgetSeconds: 3, connect: async (folder, deadline) => {
    assert.ok(deadline > Date.now());
    connections++;
    return { close: async () => {}, call: async () => { throw new Error('stub render failed'); } };
  } };
  await assert.rejects(runNightly(input, opts), /Nightly lock exists/);
  assert.equal(connections, 0);
  await rm(lock);
  const result = await runNightly(input, opts);
  const summary = JSON.parse(await readFile(path.join(result.folder, 'run.json'), 'utf8'));
  assert.equal(summary.status, 'failed');
  assert.match(summary.recipes[0].error, /stub render failed/);
  assert.equal((await readdir(out)).includes('.nightly.lock'), false);
});
