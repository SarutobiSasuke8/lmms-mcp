import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { generationStore } from './generations.mjs';
import { createPublisher, licenceProblems, loadConfig, r2Client, register, signRequest } from './r2.mjs';

// Fake credentials only. Nothing here reaches the network: every request goes to fakeS3 below.
const env = {
  R2_ACCOUNT_ID: 'abcdef0123456789abcdef0123456789', R2_ACCESS_KEY_ID: 'TESTKEYID',
  R2_SECRET_ACCESS_KEY: 'test-secret-value-not-real', R2_BUCKET: 'test-bucket',
};
const sha = data => createHash('sha256').update(data).digest('hex');
const escapeXml = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');

// An in-memory S3 with the behaviours the publisher relies on: ListObjectsV2 paging,
// If-None-Match: * and If-Match on PUT, and ETags. It records every request.
function fakeS3({ pageSize = 1000, failWith } = {}) {
  const objects = new Map();
  const requests = [];
  let counter = 0;
  const fetch = async (url, init = {}) => {
    const target = new URL(url);
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    requests.push({ method, url: String(url), headers, body: init.body });
    assert.equal(target.host, `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
    assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=TESTKEYID\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=.*host.*x-amz-content-sha256.*x-amz-date.*, Signature=[a-f0-9]{64}$/);
    // Recompute the signature from what was sent and check it matches.
    const query = Object.fromEntries(target.searchParams);
    const sent = Object.fromEntries(Object.entries(headers).filter(([name]) => !['authorization', 'host', 'x-amz-content-sha256', 'x-amz-date'].includes(name)));
    const again = signRequest({
      method, host: target.host, pathname: target.pathname, query, headers: sent, payloadHash: headers['x-amz-content-sha256'],
      accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      now: new Date(headers['x-amz-date'].replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')),
    });
    assert.equal(again.authorization, headers.authorization);
    assert.equal(headers['x-amz-content-sha256'], sha(init.body ?? Buffer.alloc(0)));
    if (failWith) return new Response('<Error><Code>InternalError</Code></Error>', { status: failWith });
    const [, bucket, ...rest] = target.pathname.split('/');
    assert.equal(bucket, env.R2_BUCKET);
    const key = decodeURIComponent(rest.join('/'));
    if (method === 'GET' && !key) {
      const prefix = query.prefix ?? '';
      const all = [...objects.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = query['continuation-token'] ? Number(query['continuation-token']) : 0;
      const page = all.slice(start, start + pageSize);
      const more = start + pageSize < all.length;
      return new Response(`<ListBucketResult><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + pageSize}</NextContinuationToken>` : ''}${page.map(k => `<Contents><Key>${escapeXml(k)}</Key><LastModified>2026-11-15T10:00:00.000Z</LastModified><Size>${objects.get(k).body.length}</Size></Contents>`).join('')}</ListBucketResult>`, { status: 200 });
    }
    if (method === 'GET') {
      const found = objects.get(key);
      return found ? new Response(found.body, { status: 200, headers: { etag: found.etag } }) : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    }
    assert.equal(method, 'PUT');
    const found = objects.get(key);
    if (headers['if-none-match'] === '*' && found) return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 });
    if (headers['if-match'] && (!found || found.etag !== headers['if-match'])) return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 });
    assert.ok(headers['if-none-match'] === '*' || headers['if-match'] === undefined || found, 'conditional write expected');
    objects.set(key, { body: Buffer.from(init.body), etag: `"etag-${++counter}"`, contentType: headers['content-type'], meta: headers });
    return new Response('', { status: 200 });
  };
  return { fetch, objects, requests, puts: () => requests.filter(r => r.method === 'PUT') };
}

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lmms-r2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const generations = generationStore(root);
  await mkdir(path.join(root, 'game'));
  const add = async (name, content, libraries = ['salamander-grand-piano']) => {
    await writeFile(path.join(root, 'game', name), content);
    const ids = await generations.backfill('game', libraries, 'forest');
    return ids.at(-1);
  };
  return { root, generations, add };
}

test('the signer reproduces the published AWS Signature Version 4 example', () => {
  const headers = signRequest({
    method: 'GET', host: 'examplebucket.s3.amazonaws.com', pathname: '/test.txt', headers: { range: 'bytes=0-9' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1', now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.match(headers.authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
  assert.match(headers.authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,/);
});

test('configuration comes only from the four variables and errors never contain values', () => {
  assert.deepEqual(loadConfig({}).missing, ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']);
  assert.deepEqual(loadConfig({ ...env, R2_BUCKET: ' ' }).missing, ['R2_BUCKET']);
  assert.equal(loadConfig(env).config.bucket, 'test-bucket');
  assert.throws(() => loadConfig({ ...env, R2_ACCOUNT_ID: 'not-hex-secret-looking' }), error => !error.message.includes('not-hex-secret-looking'));
});

test('licence gate blocks unknown licences, missing credits and unpublishable records', () => {
  const library = extra => ({ sampleLibraries: [{ id: 'x', licence: 'CC-BY-3.0', credit: 'A by B', source: 's', ...extra }], publishable: true });
  assert.deepEqual(licenceProblems(library()), []);
  assert.match(licenceProblems(library({ licence: 'unknown' }))[0], /licence is unknown/);
  assert.match(licenceProblems(library({ credit: null }))[0], /requires a credit/);
  assert.match(licenceProblems({ sampleLibraries: [], publishable: false })[0], /no sample library/);
  assert.match(licenceProblems({ ...library(), publishable: false })[0], /not mark this generation as publishable/);
});

test('dry run is the default: it reads the bucket, prints keys, sizes and hashes, and writes nothing', async t => {
  const { root, generations, add } = await workspace(t);
  const s3 = fakeS3();
  const id = await add('cue.ogg', 'ogg-bytes');
  const publisher = createPublisher({ root, generations, env, fetch: s3.fetch });
  const result = await publisher.publish({ id, game: 'forest', kind: 'cue' });
  assert.equal(result.dryRun, true);
  assert.equal(result.version, 1);
  assert.equal(result.versionSource, 'r2');
  assert.deepEqual(result.uploads[0], { key: 'games/forest/cue/cue/v1.ogg', bytes: 9, sha256: sha('ogg-bytes'), contentType: 'audio/ogg', immutable: true });
  assert.equal(result.uploads[1].key, 'games/forest/cue/cue/v1.manifest.json');
  assert.deepEqual(result.pointers.map(p => p.action), ['create', 'create']);
  assert.equal(s3.puts().length, 0);
  assert.equal(s3.objects.size, 0);
  assert.equal((await generations.show(id)).locations.r2, null);
});

test('dry run accepts a workspace opened through a directory alias', async t => {
  const { root, generations, add } = await workspace(t);
  const aliasParent = await mkdtemp(path.join(os.tmpdir(), 'lmms-r2-alias-'));
  t.after(() => rm(aliasParent, { recursive: true, force: true }));
  const alias = path.join(aliasParent, 'workspace');
  await symlink(path.resolve(root), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const id = await add('cue.ogg', 'ogg-bytes');
  const publisher = createPublisher({ root: alias, generations, env: {} });
  const result = await publisher.publish({ id, game: 'forest', kind: 'cue' });
  assert.equal(result.dryRun, true);
  assert.equal(result.uploads[0].sha256, sha('ogg-bytes'));
});

test('dry run without configuration makes no request and says the version is assumed', async t => {
  const { root, generations, add } = await workspace(t);
  const id = await add('cue.ogg', 'x');
  const calls = [];
  const publisher = createPublisher({ root, generations, env: {}, fetch: async (...args) => { calls.push(args); throw new Error('no network in tests'); } });
  const result = await publisher.publish({ id, game: 'forest', kind: 'cue' });
  assert.equal(result.r2Configured, false);
  assert.equal(result.versionSource, 'assumed');
  assert.equal(result.missingConfig.length, 4);
  assert.deepEqual(calls, []);
  await assert.rejects(publisher.publish({ id, game: 'forest', kind: 'cue', confirm: true }), /R2 is not configured/);
});

test('confirm uploads immutable objects, the manifest with credits, pointers, and writes the location back', async t => {
  const { root, generations, add } = await workspace(t);
  const s3 = fakeS3();
  const id = await add('cue.ogg', 'ogg-bytes');
  const publisher = createPublisher({ root, generations, env, fetch: s3.fetch, now: () => new Date('2026-11-15T12:00:00Z') });
  const result = await publisher.publish({ id, game: 'forest', kind: 'cue', confirm: true });
  assert.equal(result.dryRun, false);
  assert.equal(result.location, 'r2://test-bucket/games/forest/cue/cue/v1.ogg');
  assert.deepEqual([...s3.objects.keys()].sort(), ['games/forest/cue/cue/manifest.json', 'games/forest/cue/cue/v1.manifest.json', 'games/forest/cue/cue/v1.ogg', 'games/forest/index.json']);
  assert.equal(s3.objects.get('games/forest/cue/cue/v1.ogg').body.toString(), 'ogg-bytes');
  assert.equal(s3.objects.get('games/forest/cue/cue/v1.ogg').contentType, 'audio/ogg');
  const manifest = JSON.parse(s3.objects.get('games/forest/cue/cue/v1.manifest.json').body);
  assert.equal(manifest.generationId, id);
  assert.equal(manifest.files[0].sha256, sha('ogg-bytes'));
  assert.equal(manifest.credits[0].credit, 'Salamander Grand Piano V3 by Alexander Holm');
  assert.deepEqual(manifest.attribution, ['Salamander Grand Piano V3 by Alexander Holm (CC-BY-3.0)']);
  assert.ok(!JSON.stringify(manifest).includes(root), 'no local paths in the published manifest');
  const index = JSON.parse(s3.objects.get('games/forest/index.json').body);
  assert.equal(index.assets[0].files[0].key, 'games/forest/cue/cue/v1.ogg');
  assert.equal((await generations.show(id)).locations.r2, result.location);
  assert.equal((await generations.list({ game: 'forest' }))[0].locations.r2, result.location);
  const sidecar = JSON.parse(await readFile(path.join(root, (await generations.show(id)).locations.local), 'utf8'));
  assert.equal(sidecar.locations.r2, null, 'the sidecar keeps the initial record');
});

test('a new generation for the same slug becomes v2 and v1 is never touched', async t => {
  const { root, generations, add } = await workspace(t);
  const s3 = fakeS3();
  const publisher = createPublisher({ root, generations, env, fetch: s3.fetch });
  const first = await add('take1.ogg', 'one');
  await publisher.publish({ id: first, game: 'forest', kind: 'loop', slug: 'theme', confirm: true });
  const v1 = s3.objects.get('games/forest/loop/theme/v1.ogg');
  const second = await add('take2.ogg', 'two');
  const result = await publisher.publish({ id: second, game: 'forest', kind: 'loop', slug: 'theme', confirm: true });
  assert.equal(result.version, 2);
  assert.equal(s3.objects.get('games/forest/loop/theme/v1.ogg'), v1);
  assert.equal(s3.objects.get('games/forest/loop/theme/v2.ogg').body.toString(), 'two');
  const slug = JSON.parse(s3.objects.get('games/forest/loop/theme/manifest.json').body);
  assert.equal(slug.latest, 2);
  assert.deepEqual(slug.versions.map(v => v.version), [1, 2]);
  const index = JSON.parse(s3.objects.get('games/forest/index.json').body);
  assert.equal(index.assets.length, 1);
  assert.equal(index.assets[0].latest, 2);
  const puts = s3.puts().filter(r => !/manifest\.json$|index\.json$/.test(new URL(r.url).pathname));
  assert.ok(puts.every(r => r.headers['if-none-match'] === '*'), 'every immutable object is create-only');
});

test('identical content is not published twice', async t => {
  const { root, generations, add } = await workspace(t);
  const s3 = fakeS3();
  const publisher = createPublisher({ root, generations, env, fetch: s3.fetch });
  const id = await add('cue.ogg', 'same');
  await publisher.publish({ id, game: 'forest', kind: 'cue', confirm: true });
  const before = s3.puts().length;
  await assert.rejects(publisher.publish({ id, game: 'forest', kind: 'cue', confirm: true }), /Already published as v1/);
  assert.equal(s3.puts().length, before);
});

test('create-only uploads fail on an existing key and leave it unchanged', async () => {
  const s3 = fakeS3();
  const client = r2Client(loadConfig(env).config, { fetch: s3.fetch });
  await client.putNew('games/a/b/c/v1.wav', Buffer.from('first'), 'audio/wav');
  await assert.rejects(client.putNew('games/a/b/c/v1.wav', Buffer.from('second'), 'audio/wav'), error => error.status === 412 && /PreconditionFailed/.test(error.message));
  assert.equal(s3.objects.get('games/a/b/c/v1.wav').body.toString(), 'first');
  await assert.rejects(client.putPointer('games/a/index.json', {}, '"stale"'), /412/);
});

test('publishing refuses an unknown licence before touching R2', async t => {
  const { root, generations } = await workspace(t);
  const s3 = fakeS3();
  await mkdir(path.join(root, 'raw'));
  await writeFile(path.join(root, 'raw', 'mystery.wav'), 'mystery');
  const [id] = await generations.backfill('raw');
  const publisher = createPublisher({ root, generations, env, fetch: s3.fetch });
  await assert.rejects(publisher.publish({ id, game: 'forest', kind: 'cue', confirm: true }), /Refusing to publish: .*licence is unknown/);
  assert.deepEqual(s3.requests, []);
});

test('publishing refuses a file that changed since it was catalogued', async t => {
  const { root, generations, add } = await workspace(t);
  const id = await add('cue.ogg', 'original');
  await writeFile(path.join(root, 'game', 'cue.ogg'), 'tampered');
  const publisher = createPublisher({ root, generations, env, fetch: fakeS3().fetch });
  await assert.rejects(publisher.publish({ id, game: 'forest', kind: 'cue' }), /hash mismatch/);
});

test('several audio files with one extension need an explicit choice', async t => {
  const { root, generations } = await workspace(t);
  await mkdir(path.join(root, 'stems'));
  await writeFile(path.join(root, 'stems', 'a.wav'), 'a');
  await writeFile(path.join(root, 'stems', 'b.wav'), 'b');
  const [id] = await generations.record('render_stems', { outputDirectory: 'stems' }, { stems: [{ file: 'a.wav' }, { file: 'b.wav' }] });
  const manifest = await generations.show(id);
  manifest.sampleLibraries = [{ id: 'fluidr3-gm', licence: 'MIT', credit: 'Fluid (R3) SoundFont by Frank Wen', source: 's' }];
  manifest.publishable = true;
  const publisher = createPublisher({ root, generations: { show: async () => manifest, setLocation: async () => manifest }, env: {}, fetch: fakeS3().fetch });
  await assert.rejects(publisher.publish({ id, game: 'forest', kind: 'stem' }), /Pass files/);
  const ok = await publisher.publish({ id, game: 'forest', kind: 'stem', files: ['stems/b.wav'] });
  assert.equal(ok.uploads[0].key, 'games/forest/stem/b/v1.wav');
});

test('list_r2_assets only reads, pages through results and scopes by game and kind', async t => {
  const { root, generations } = await workspace(t);
  const s3 = fakeS3({ pageSize: 2 });
  for (const key of ['games/forest/cue/a/v1.ogg', 'games/forest/cue/b/v1.ogg', 'games/forest/loop/c/v1.ogg', 'games/cave/cue/d/v1.ogg', 'other/x']) {
    s3.objects.set(key, { body: Buffer.from('xx'), etag: '"e"' });
  }
  const publisher = createPublisher({ root, generations, env, fetch: s3.fetch });
  const all = await publisher.list({});
  assert.equal(all.total, 4);
  const forestCues = await publisher.list({ game: 'forest', kind: 'cue' });
  assert.deepEqual(forestCues.objects.map(o => o.key), ['games/forest/cue/a/v1.ogg', 'games/forest/cue/b/v1.ogg']);
  assert.equal(forestCues.objects[0].size, 2);
  assert.ok(s3.requests.every(r => r.method === 'GET'));
  await assert.rejects(createPublisher({ root, generations, env: {}, fetch: s3.fetch }).list({}), /R2 is not configured/);
});

test('failures and requests never expose the secret access key', async t => {
  const { root, generations, add } = await workspace(t);
  const s3 = fakeS3({ failWith: 500 });
  const id = await add('cue.ogg', 'x');
  await assert.rejects(createPublisher({ root, generations, env, fetch: s3.fetch }).publish({ id, game: 'forest', kind: 'cue' }), error => {
    assert.match(error.message, /HTTP 500 \(InternalError\)/);
    assert.ok(!error.message.includes(env.R2_SECRET_ACCESS_KEY));
    return true;
  });
  const ok = fakeS3();
  await createPublisher({ root, generations, env, fetch: ok.fetch }).publish({ id, game: 'forest', kind: 'cue', confirm: true });
  assert.ok(!JSON.stringify(ok.requests.map(r => [r.url, r.headers])).includes(env.R2_SECRET_ACCESS_KEY));
  const network = createPublisher({ root, generations, env, fetch: async () => { throw new Error(`boom ${env.R2_SECRET_ACCESS_KEY}`); } });
  await assert.rejects(network.list({}), error => !error.message.includes(env.R2_SECRET_ACCESS_KEY));
});

test('the module registers publish_to_r2 and list_r2_assets with a dry-run default', async () => {
  const tools = new Map();
  const guidance = [];
  register({ tool: (name, description, schema, handler) => tools.set(name, { description, schema: z.object(schema), handler }), z, root: os.tmpdir(), generations: {}, moduleGuidance: guidance });
  assert.deepEqual([...tools.keys()].sort(), ['list_r2_assets', 'publish_to_r2']);
  const publish = tools.get('publish_to_r2').schema;
  assert.equal(publish.parse({ id: 'a'.repeat(64), game: 'forest', kind: 'cue' }).confirm, false);
  assert.throws(() => publish.parse({ id: 'a'.repeat(64), game: '../escape', kind: 'cue' }));
  assert.equal(guidance.length, 1);
});
