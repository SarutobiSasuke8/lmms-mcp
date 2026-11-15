// Publish approved generations to a Cloudflare R2 bucket through its S3-compatible API.
// Requests are signed with AWS Signature Version 4 using node:crypto and the built-in fetch,
// so this module adds no dependency. See docs/r2.md.
import { createHash, createHmac } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const rfc3986 = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encodePath = value => value.split('/').map(rfc3986).join('/');

const MAX_BYTES = 256 * 1024 * 1024;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const audioTypes = { wav: 'audio/wav', ogg: 'audio/ogg', mp3: 'audio/mpeg', flac: 'audio/flac' };
const attribution = new Set(['CC-BY-3.0', 'CC-BY-4.0', 'MIT']);

// ---------- SigV4 ----------

// Returns the headers to send, including Authorization. `headers` are the headers the caller
// will send, which are all signed. `query` is an object of already-decoded values.
export function signRequest({ method, host, pathname, query = {}, headers = {}, payloadHash, accessKeyId, secretAccessKey, region = 'auto', service = 's3', now = new Date() }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const all = { ...headers, host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(all).map(name => name.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([name, value]) => [name.toLowerCase(), String(value).trim().replace(/\s+/g, ' ')]));
  const canonicalQuery = Object.entries(query)
    .map(([name, value]) => [rfc3986(name), rfc3986(String(value))])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(pair => pair.join('=')).join('&');
  const signedHeaders = names.join(';');
  const canonical = [method, pathname, canonicalQuery, names.map(name => `${name}:${lower[name]}\n`).join(''), signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, day), region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return {
    ...lower,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// ---------- configuration ----------

export const configVariables = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];

// Reads only the four R2_* variables. Returns { missing } when any is unset or empty.
// Error messages name variables, never values.
export function loadConfig(env = process.env) {
  const missing = configVariables.filter(name => !env[name]?.trim());
  if (missing.length) return { missing };
  const config = { accountId: env.R2_ACCOUNT_ID.trim(), accessKeyId: env.R2_ACCESS_KEY_ID.trim(), secretAccessKey: env.R2_SECRET_ACCESS_KEY.trim(), bucket: env.R2_BUCKET.trim() };
  if (!/^[a-f0-9]{32}$/i.test(config.accountId)) throw new Error('R2_ACCOUNT_ID must be the 32 character hexadecimal account ID');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)) throw new Error('R2_BUCKET is not a valid bucket name');
  return { config };
}

// ---------- minimal S3 client ----------

const unescapeXml = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const xmlTag = (text, tag) => { const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? unescapeXml(m[1]) : null; };

export function r2Client(config, { fetch: fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  async function send(method, key, { query = {}, body, headers = {} } = {}) {
    const pathname = '/' + encodePath(config.bucket + (key ? '/' + key : ''));
    const payload = body === undefined ? Buffer.alloc(0) : body;
    const signed = signRequest({
      method, host, pathname, query, headers, payloadHash: sha256(payload),
      accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, now: now(),
    });
    const { host: _host, ...sendHeaders } = signed;
    const search = Object.keys(query).length ? '?' + Object.entries(query).map(([k, v]) => `${rfc3986(k)}=${rfc3986(String(v))}`).join('&') : '';
    let response;
    try {
      response = await fetchImpl(`https://${host}${pathname}${search}`, { method, headers: sendHeaders, body: body === undefined || method === 'GET' ? undefined : body, redirect: 'error' });
    } catch {
      throw new Error(`R2 ${method} request failed before a response arrived`);
    }
    return response;
  }
  async function fail(response, action) {
    const text = await response.text().catch(() => '');
    const code = xmlTag(text, 'Code');
    throw Object.assign(new Error(`R2 ${action} failed with HTTP ${response.status}${code ? ` (${code})` : ''}`), { status: response.status, code });
  }
  return {
    async list(prefix) {
      const items = [];
      let token;
      do {
        const query = { 'list-type': 2, prefix, ...(token ? { 'continuation-token': token } : {}) };
        const response = await send('GET', '', { query });
        if (!response.ok) await fail(response, 'list');
        const xml = await response.text();
        for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
          items.push({ key: xmlTag(block, 'Key'), size: Number(xmlTag(block, 'Size')), lastModified: xmlTag(block, 'LastModified') });
        }
        token = xmlTag(xml, 'IsTruncated') === 'true' ? xmlTag(xml, 'NextContinuationToken') : null;
      } while (token);
      return items;
    },
    // Returns null for a missing object.
    async getJson(key) {
      const response = await send('GET', key);
      if (response.status === 404) return null;
      if (!response.ok) await fail(response, 'read');
      return { value: JSON.parse(await response.text()), etag: response.headers.get('etag') };
    },
    // Create-only: never replaces an existing object.
    async putNew(key, body, contentType, metadata = {}) {
      const headers = { 'content-type': contentType, 'if-none-match': '*' };
      for (const [name, value] of Object.entries(metadata)) headers[`x-amz-meta-${name}`] = value;
      const response = await send('PUT', key, { body, headers });
      if (!response.ok) await fail(response, 'upload');
    },
    // Replaces a pointer document only if it is still the version we read.
    async putPointer(key, value, etag) {
      const headers = { 'content-type': 'application/json', ...(etag ? { 'if-match': etag } : { 'if-none-match': '*' }) };
      const response = await send('PUT', key, { body: Buffer.from(JSON.stringify(value, null, 2) + '\n'), headers });
      if (!response.ok) await fail(response, 'pointer update');
    },
  };
}

// ---------- licence gate ----------

// Returns a list of reasons the generation may not be published. Empty means cleared.
export function licenceProblems(manifest) {
  const libraries = manifest.sampleLibraries ?? [];
  if (!libraries.length) return ['no sample library or licence information is recorded for this generation'];
  const problems = [];
  for (const library of libraries) {
    const licence = library.licence;
    if (!licence || licence === 'unknown') problems.push(`${library.id}: licence is unknown`);
    else if (attribution.has(licence) && !library.credit?.trim()) problems.push(`${library.id}: ${licence} requires a credit and none is recorded`);
  }
  if (!problems.length && manifest.publishable !== true) problems.push('the catalogue does not mark this generation as publishable');
  return problems;
}

// ---------- planning and publishing ----------

const versionOf = (prefix, key) => key.startsWith(prefix) ? Number(key.slice(prefix.length).match(/^v(\d+)\./)?.[1] ?? 0) : 0;

async function inWorkspace(root, relative) {
  const full = await realpath(path.resolve(root, relative));
  const check = path.relative(root, full);
  if (!check || path.isAbsolute(check) || check === '..' || check.startsWith('..' + path.sep)) throw new Error('Generation file is outside the workspace');
  if (!(await stat(full)).isFile()) throw new Error('Generation file is not a regular file');
  return full;
}

export function createPublisher({ root, generations, env = process.env, fetch: fetchImpl, now = () => new Date() }) {
  const clientFor = config => r2Client(config, { fetch: fetchImpl, now });

  async function plan({ id, game, kind, slug, files }) {
    const manifest = await generations.show(id);
    const problems = licenceProblems(manifest);
    if (problems.length) throw new Error('Refusing to publish: ' + problems.join('; '));
    for (const [label, value] of [['game', game], ['kind', kind]]) if (!NAME.test(value)) throw new Error(`${label} must be lower case letters, digits and hyphens`);
    const wanted = files ?? manifest.files.filter(file => audioTypes[path.extname(file.path).slice(1).toLowerCase()]).map(file => file.path);
    const chosen = wanted.map(name => {
      const file = manifest.files.find(entry => entry.path === name);
      if (!file) throw new Error(`File is not part of this generation: ${name}`);
      return file;
    });
    if (!chosen.length) throw new Error('This generation has no audio file (wav, ogg, mp3 or flac) to publish');
    const extensions = chosen.map(file => path.extname(file.path).slice(1).toLowerCase());
    if (extensions.some(ext => !audioTypes[ext])) throw new Error('Only wav, ogg, mp3 and flac files can be published');
    if (new Set(extensions).size !== extensions.length) {
      throw new Error('This generation has more than one audio file with the same extension. Pass files with the one you want.');
    }
    const finalSlug = slug ?? path.basename(chosen[0].path, path.extname(chosen[0].path)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
    if (!NAME.test(finalSlug)) throw new Error('slug must be lower case letters, digits and hyphens');
    const payloads = [];
    for (const [index, file] of chosen.entries()) {
      const full = await inWorkspace(root, file.path);
      const info = await stat(full);
      if (info.size > MAX_BYTES) throw new Error(`File is larger than ${MAX_BYTES / 1024 / 1024} MiB: ${file.path}`);
      const data = await readFile(full);
      const actual = sha256(data);
      if (actual !== file.sha256) throw new Error(`File changed since it was catalogued (hash mismatch): ${file.path}`);
      payloads.push({ source: file.path, ext: extensions[index], data, bytes: data.length, sha256: actual, contentType: audioTypes[extensions[index]] });
    }
    const loaded = loadConfig(env);
    const base = `games/${game}/${kind}/${finalSlug}/`;
    let client = null;
    let existing = null;
    let gameIndex = null;
    let version = 1;
    let versionSource = 'assumed';
    if (loaded.config) {
      client = clientFor(loaded.config);
      const keys = await client.list(base);
      version = Math.max(0, ...keys.map(item => versionOf(base, item.key))) + 1;
      versionSource = 'r2';
      existing = await client.getJson(base + 'manifest.json');
      gameIndex = await client.getJson(`games/${game}/index.json`);
      const duplicate = existing?.value.versions?.find(entry => payloads.every(p => entry.files?.some(f => f.sha256 === p.sha256)));
      if (duplicate) throw new Error(`Already published as v${duplicate.version} (${base}v${duplicate.version}). Identical content is not uploaded again.`);
    }
    return { manifest, base, game, kind, slug: finalSlug, version, versionSource, payloads, config: loaded.config, missing: loaded.missing, client, existing, gameIndex };
  }

  function documents(p) {
    const { manifest, base, version } = p;
    const credits = manifest.sampleLibraries.map(({ id, licence, credit, source }) => ({ library: id, licence, credit, source }));
    const files = p.payloads.map(file => ({ key: `${base}v${version}.${file.ext}`, bytes: file.bytes, sha256: file.sha256, contentType: file.contentType }));
    const published = now().toISOString();
    const versionManifest = {
      schemaVersion: 1, generationId: manifest.id, game: p.game, kind: p.kind, slug: p.slug, version, published, files,
      source: {
        tool: manifest.tool, seed: manifest.seed, style: manifest.style, key: manifest.key, bpm: manifest.bpm,
        durationSeconds: manifest.durationSeconds, integratedLufs: manifest.integratedLufs, truePeakDbfs: manifest.truePeakDbfs,
        instruments: manifest.instruments, plugins: manifest.plugins,
      },
      credits,
      attribution: credits.filter(c => c.credit).map(c => `${c.credit} (${c.licence})`),
    };
    const versions = [...(p.existing?.value.versions ?? []), { version, generationId: manifest.id, published, files, credits }];
    const slugManifest = { schemaVersion: 1, game: p.game, kind: p.kind, slug: p.slug, latest: version, versions };
    const entry = { kind: p.kind, slug: p.slug, latest: version, manifest: base + 'manifest.json', files, credits };
    const assets = [...(p.gameIndex?.value.assets ?? []).filter(a => !(a.kind === p.kind && a.slug === p.slug)), entry]
      .sort((a, b) => (a.kind + '/' + a.slug).localeCompare(b.kind + '/' + b.slug));
    const index = { schemaVersion: 1, game: p.game, updated: published, assets };
    return { versionManifest, slugManifest, index, files };
  }

  return {
    async publish({ id, game, kind, slug, files, confirm = false }) {
      const p = await plan({ id, game, kind, slug, files });
      const docs = documents(p);
      const versionManifestBody = Buffer.from(JSON.stringify(docs.versionManifest, null, 2) + '\n');
      const uploads = [
        ...p.payloads.map((file, i) => ({ key: docs.files[i].key, bytes: file.bytes, sha256: file.sha256, contentType: file.contentType, immutable: true })),
        { key: `${p.base}v${p.version}.manifest.json`, bytes: versionManifestBody.length, sha256: sha256(versionManifestBody), contentType: 'application/json', immutable: true },
      ];
      const pointers = [
        { key: p.base + 'manifest.json', action: p.existing ? 'update' : 'create' },
        { key: `games/${p.game}/index.json`, action: p.gameIndex ? 'update' : 'create' },
      ];
      const summary = { generationId: id, game: p.game, kind: p.kind, slug: p.slug, version: p.version, versionSource: p.versionSource, uploads, pointers, credits: docs.versionManifest.credits };
      if (!confirm) {
        return {
          dryRun: true, ...summary,
          r2Configured: !p.missing,
          ...(p.missing ? { missingConfig: p.missing, note: `Version is assumed to be v1 because R2 is not configured. Set ${p.missing.join(', ')} to check the bucket.` } : {}),
          message: 'Nothing was uploaded. Pass confirm: true to upload exactly these objects.',
        };
      }
      if (p.missing) throw new Error(`R2 is not configured. Set ${p.missing.join(', ')}.`);
      // Immutable objects first. Each is create-only, so an existing key is an error, never an overwrite.
      for (const [i, file] of p.payloads.entries()) {
        await p.client.putNew(docs.files[i].key, file.data, file.contentType, { sha256: file.sha256, 'generation-id': id });
      }
      await p.client.putNew(uploads[uploads.length - 1].key, versionManifestBody, 'application/json', { sha256: uploads[uploads.length - 1].sha256, 'generation-id': id });
      // Pointer documents are the only objects that change. Each write is conditional on what was read.
      await p.client.putPointer(pointers[0].key, docs.slugManifest, p.existing?.etag);
      await p.client.putPointer(pointers[1].key, docs.index, p.gameIndex?.etag);
      const location = `r2://${p.config.bucket}/${docs.files[0].key}`;
      await generations.setLocation(id, 'r2', location);
      return { dryRun: false, ...summary, location, message: 'Uploaded. The R2 location is saved in the catalogue.' };
    },
    async list({ game, kind, limit = 200 }) {
      const loaded = loadConfig(env);
      if (loaded.missing) throw new Error(`R2 is not configured. Set ${loaded.missing.join(', ')}.`);
      if (kind && !game) throw new Error('kind needs a game');
      const prefix = ['games', game, kind].filter(Boolean).join('/') + '/';
      const objects = await clientFor(loaded.config).list(prefix);
      return { prefix, total: objects.length, objects: objects.slice(0, limit), truncated: objects.length > limit };
    },
  };
}

export function register({ tool, z, root, generations, moduleGuidance }) {
  moduleGuidance?.push('Publishing to Cloudflare R2: publish_to_r2 is a dry run until confirm is true, so show Alexei the keys, sizes and hashes and wait for a yes before confirming. It refuses unknown licences and missing credits. list_r2_assets only reads.');
  const publisher = createPublisher({ root, generations });
  const name = z.string().regex(NAME).describe('Lower case letters, digits and hyphens.');
  tool('publish_to_r2', 'Publish one approved catalogue generation to Cloudflare R2 as immutable versioned keys games/<game>/<kind>/<slug>/v<N>.<ext>, with a per-version manifest, a slug manifest.json and games/<game>/index.json. Dry run by default: it prints keys, sizes and SHA-256 hashes and uploads nothing until confirm is true. Never overwrites an object. Refuses an unknown licence or missing credits. Credentials come from R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET.', {
    id: z.string().regex(/^[a-f0-9]{64}$/).describe('Generation ID from the catalogue.'),
    game: name, kind: name.describe('For example cue, loop, stem or sfx.'),
    slug: name.optional().describe('Defaults to the audio file name.'),
    files: z.array(z.string().max(500)).min(1).max(8).optional().describe('Catalogue file paths to publish. Needed when a generation has several audio files with the same extension.'),
    confirm: z.boolean().default(false).describe('Upload for real. Leave false for a dry run.'),
  }, args => publisher.publish(args));
  tool('list_r2_assets', 'List objects in the R2 bucket under games/, optionally for one game and kind. Read only.', {
    game: name.optional(), kind: name.optional(), limit: z.number().int().min(1).max(1000).default(200),
  }, args => publisher.list(args));
}
