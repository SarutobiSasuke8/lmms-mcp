import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';

const slug = /^[a-z0-9][a-z0-9_-]{0,59}$/;
const day = /^\d{4}-\d{2}-\d{2}$/;
const marker = '.lmms-nightly';
const mib = 1024 ** 2;

async function json(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function planNightly(input) {
  const listing = (await stat(input)).isDirectory();
  const files = listing
    ? (await readdir(input)).filter(name => name.endsWith('.json')).sort().map(name => path.join(input, name))
    : (await json(input)).map(name => path.resolve(path.dirname(input), name));
  if (!files.length) throw new Error('No soundtrack recipes found');
  const names = new Set();
  return Promise.all(files.map(async file => {
    const { game, cues } = await json(file);
    if (!slug.test(game) || typeof game !== 'string' || names.has(game) || !Array.isArray(cues) || !cues.length) {
      throw new Error('Each recipe needs a unique game slug and a nonempty cues array');
    }
    names.add(game);
    const ids = new Set();
    for (const { id, count = 6, keep = 2 } of cues) {
      if (typeof id !== 'string' || !slug.test(id) || ids.has(id)) throw new Error(`Invalid or duplicate cue ID in ${game}`);
      if (!Number.isInteger(count) || count < 2 || count > 24 || !Number.isInteger(keep) || keep < 1 || keep > Math.min(count, 4)) {
        throw new Error(`Invalid count or keep for ${game}/${id}`);
      }
      ids.add(id);
    }
    return { game, cues };
  }));
}

async function ownedDays(root) {
  const days = await readdir(root, { withFileTypes: true });
  const owned = [];
  for (const entry of days) {
    if (!entry.isDirectory() || !day.test(entry.name)) continue;
    const value = await readFile(path.join(root, entry.name, marker), 'utf8').catch(() => '');
    if (value === 'lmms-compose nightly\n') owned.push(entry.name);
  }
  return owned.sort().reverse();
}

export async function retainNights(root, now, keepDays) {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - keepDays + 1);
  for (const name of await ownedDays(root)) {
    if (name < cutoff.toISOString().slice(0, 10)) await rm(path.join(root, name), { recursive: true });
  }
}

async function writeIndex(dir, links) {
  const html = links.map(({ href, label }) => `<li><a href="${href}">${label}</a></li>`).join('\n');
  const tmp = await mkdtemp(path.join(dir, '.index-'));
  try {
    await writeFile(path.join(tmp, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Soundtrack auditions</title><h1>Soundtrack auditions</h1><ul>${html}</ul>\n`);
    await rename(path.join(tmp, 'index.html'), path.join(dir, 'index.html'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function runNightly(input, {
  out, budgetSeconds = 1800, minFreeMib = 1024, keepDays, now = new Date(), connect,
}) {
  for (const [label, value] of Object.entries({ budgetSeconds, minFreeMib, keepDays: keepDays ?? 1 })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  }
  await mkdir(out, { recursive: true });
  const lockPath = path.join(out, '.nightly.lock');
  const lock = await open(lockPath, 'wx').catch(error => {
    if (error.code === 'EEXIST') throw new Error('Nightly lock exists. Check the previous run before removing it.');
    throw error;
  });
  const date = now.toISOString().slice(0, 10);
  const dateDir = path.join(out, date);
  const summary = { startedAt: now.toISOString(), status: 'ok', recipes: [] };
  try {
    const existing = await ownedDays(out);
    if (!existing.includes(date)) {
      await mkdir(dateDir);
      await writeFile(path.join(dateDir, marker), 'lmms-compose nightly\n', { flag: 'wx' });
    }
    const runDir = await mkdtemp(path.join(dateDir, 'run-'));
    const links = [];
    try {
      const plan = await planNightly(input);
      for (const { game, cues } of plan) {
        const result = { game, status: 'ok', cues: [] };
        summary.recipes.push(result);
        const deadline = Date.now() + budgetSeconds * 1000;
        try {
          for (const { id, count = 6, keep = 2, seed = 1, ...recipe } of cues) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error('Recipe time budget exceeded');
            const { bavail, bsize } = await statfs(out);
            if (bavail * bsize < minFreeMib * mib) throw new Error('Insufficient free disk space');
            const folder = path.join(runDir, game, id);
            await mkdir(folder, { recursive: true });
            const client = await connect(folder, deadline);
            try {
              const { ranking } = await client.call('compose_batch', {
                ...recipe, name: id, count, seedStart: seed, targetLufs: -16,
              });
              const kept = ranking.slice(0, keep);
              await client.call('build_audition_page', {
                files: kept.map(candidate => candidate.audio), title: `${game} / ${id}`, output: 'index.html',
              });
              for (const candidate of ranking.slice(keep)) {
                await rm(path.join(folder, candidate.audio));
                await rm(path.join(folder, candidate.project));
              }
              result.cues.push({ id, candidates: kept });
              links.push({ href: `${game}/${id}/index.html`, label: `${game} / ${id}` });
            } finally {
              await client.close();
            }
          }
        } catch (error) {
          result.status = summary.status = 'failed';
          result.error = error.message;
        }
      }
      await writeIndex(runDir, links);
      const runs = (await readdir(dateDir, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && /^run-[a-z0-9]+$/i.test(entry.name))
        .map(entry => ({ href: `${entry.name}/index.html`, label: entry.name }));
      await writeIndex(dateDir, runs);
      if (keepDays !== undefined && summary.status === 'ok') await retainNights(out, now, keepDays);
      await writeIndex(out, (await ownedDays(out)).map(name => ({ href: `${name}/index.html`, label: name })));
    } catch (error) {
      summary.status = 'failed';
      summary.error = error.message;
    } finally {
      summary.finishedAt = new Date().toISOString();
      await writeFile(path.join(runDir, 'run.json'), JSON.stringify(summary, null, 2) + '\n');
    }
    return { ...summary, folder: runDir };
  } finally {
    await lock.close();
    await rm(lockPath);
  }
}
