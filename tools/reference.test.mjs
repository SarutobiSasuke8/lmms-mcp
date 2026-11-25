import test from 'node:test';
import assert from 'node:assert/strict';
import { bandProfile, compareToReference } from '../audio.mjs';
function noise(seed, n, amp = 0.25) { const x = new Float32Array(n); let s = seed >>> 0;
  for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; x[i] = amp * (2 * (s / 4294967296) - 1); } return x; }
const SR = 48000, N = SR * 4;
test('white noise: slope about +3 dB/oct, mono width 0', () => {
  const p = bandProfile({ sampleRate: SR, channels: [noise(1, N)] });
  assert.ok(p.frames > 0); assert.ok(Math.abs(p.slope - 3) <= 0.75, String(p.slope));
  assert.equal(p.width, 0); assert.ok(p.bands.air > p.bands.sub);
});
test('independent stereo noise: width about 0.5', () => {
  const p = bandProfile({ sampleRate: SR, channels: [noise(1, N), noise(2, N)] });
  assert.ok(Math.abs(p.width - 0.5) <= 0.05, String(p.width));
});
test('identical mix and reference: zero deltas, no worst band', () => {
  const p = bandProfile({ sampleRate: SR, channels: [noise(3, N), noise(4, N)] }), c = compareToReference(p, p);
  assert.equal(c.gainDb, 0); assert.equal(c.worst, null); assert.equal(c.slopeDelta, 0); assert.equal(c.widthDelta, 0);
  for (const v of Object.values(c.bandDeltas)) assert.equal(v, 0);
});
test('6 dB quieter mix: gainDb about 6.02, band deltas zero', () => {
  const ref = noise(5, N), mix = ref.map(v => v * 0.5);
  const c = compareToReference(bandProfile({ sampleRate: SR, channels: [mix] }), bandProfile({ sampleRate: SR, channels: [ref] }));
  assert.ok(Math.abs(c.gainDb - 6.02) <= 0.05, String(c.gainDb)); assert.equal(c.worst, null);
  for (const v of Object.values(c.bandDeltas)) assert.ok(Math.abs(v) <= 0.1);
});
test('bass-heavy mix: worst band is bass', () => {
  const ref = noise(6, N), mix = ref.map((v, i) => v + 0.5 * Math.sin(2 * Math.PI * 90 * i / SR));
  const c = compareToReference(bandProfile({ sampleRate: SR, channels: [mix] }), bandProfile({ sampleRate: SR, channels: [ref] }));
  assert.equal(c.worst, 'bass'); assert.ok(c.bandDeltas.bass > 6, String(c.bandDeltas.bass)); assert.ok(c.slopeDelta < 0);
});
test('silence and short input return nulls without throwing', () => {
  const s = bandProfile({ sampleRate: SR, channels: [new Float32Array(SR)] });
  assert.equal(s.rmsDb, null); assert.equal(s.slope, null); assert.equal(s.width, null); assert.equal(s.bands.mid, null);
  const t = bandProfile({ sampleRate: SR, channels: [noise(7, 100)] }); assert.equal(t.frames, 0); assert.equal(t.slope, null);
  const c = compareToReference(s, bandProfile({ sampleRate: SR, channels: [noise(8, N)] }));
  assert.equal(c.gainDb, null); assert.equal(c.worst, null); assert.equal(c.bandDeltas.mid, null); assert.equal(c.slopeDelta, null);
});
test('frame must be a power of two', () => {
  assert.throws(() => bandProfile({ sampleRate: SR, channels: [noise(9, N)] }, { frame: 1000 }), RangeError);
});

import { analyze, advise } from '../audio.mjs';
const audioOf = samples => ({ sampleRate: SR, frames: samples.length, channels: [samples] });
test('analyze: optional reference preserves existing fields and identical audio has no deltas', () => {
  const a = audioOf(noise(10, SR));
  const plain = analyze(a), compared = analyze(a, { reference: a });
  assert.equal(Object.hasOwn(plain, 'referenceMatch'), false);
  const { referenceMatch, ...rest } = compared;
  assert.deepEqual(rest, plain);
  assert.equal(referenceMatch.worst, null); assert.equal(referenceMatch.gainDb, 0);
});
test('analyze: quieter and louder mixes give exactly the level-match note', () => {
  const ref = audioOf(noise(11, SR)), quiet = audioOf(ref.channels[0].map(v => v * 0.5));
  assert.ok(advise(analyze(quiet, { reference: ref })).includes('The mix is 6.0 dB quieter than the reference: match levels before comparing tone.'));
  assert.ok(advise(analyze(ref, { reference: quiet })).includes('The mix is 6.0 dB louder than the reference: match levels before comparing tone.'));
});
test('analyze: silent reference yields null deltas and no reference advice', () => {
  const report = analyze(audioOf(noise(12, SR)), { reference: audioOf(new Float32Array(SR)) });
  assert.equal(report.referenceMatch.gainDb, null);
  assert.equal(report.referenceMatch.worst, null);
  for (const v of Object.values(report.referenceMatch.bandDeltas)) assert.equal(v, null);
  assert.equal(advise(report).some(x => x.includes('reference:')), false);
});
test('advise: worst band threshold and directions, at most two reference notes', () => {
  const base = analyze(audioOf(noise(13, SR)));
  for (const delta of [3, -3]) {
    const report = { ...base, referenceMatch: { gainDb: 3, worst: 'bass', bandDeltas: { bass: delta } } };
    const notes = advise(report).filter(x => x.includes('reference:'));
    assert.equal(notes.length, 2);
    assert.ok(notes.includes(`The bass band is 3.0 dB ${delta > 0 ? 'above' : 'below'} the reference: adjust EQ or the instrument level in that range.`));
  }
  assert.equal(advise({ ...base, referenceMatch: { gainDb: 2.99, worst: 'bass', bandDeltas: { bass: 2.99 } } }).some(x => x.includes('reference:')), false);
});
test('profile rejects non-progressing hop', () => {
  for (const hop of [0, -1, NaN, 0.5]) assert.throws(() => bandProfile({}, { hop }), RangeError);
});

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { encodeWav } from '../audio.mjs';
test('MCP referencePath: comparison, missing/corrupt WAV and traversal errors; server survives', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'lmms-reference-'));
  const client = new Client({ name: 'reference-test', version: '1' });
  try {
    const a = audioOf(noise(14, SR));
    await writeFile(path.join(workspace, 'mix.wav'), encodeWav(a));
    await writeFile(path.join(workspace, 'broken.wav'), 'not a WAV');
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../server.mjs', import.meta.url))], env: { ...process.env, LMMS_WORKSPACE: workspace }, stderr: 'pipe' }));
    const call = referencePath => client.callTool({ name: 'analyze_audio', arguments: { audio: 'mix.wav', ...(referencePath === undefined ? {} : { referencePath }) } });
    const ok = await call('mix.wav');
    assert.ok(!ok.isError, JSON.stringify(ok));
    assert.equal(JSON.parse(ok.content[0].text).referenceMatch.gainDb, 0);
    for (const file of ['missing.wav', 'broken.wav']) {
      const result = await call(file); assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Cannot read reference WAV/);
    }
    assert.equal((await call('../mix.wav')).isError, true);
    const plain = await call(); assert.ok(!plain.isError);
    assert.equal(Object.hasOwn(JSON.parse(plain.content[0].text), 'referenceMatch'), false);
  } finally {
    await client.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
