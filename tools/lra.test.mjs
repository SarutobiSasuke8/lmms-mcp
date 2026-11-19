import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loudnessRange } from '../lra.mjs';

const FS = 48000;
const FREQ = 1000;

function sineSegments(parts, { stereo = true } = {}) {
  const total = parts.reduce((n, p) => n + Math.round(p.duration * FS), 0);
  const left = new Float32Array(total);
  let offset = 0;
  let phase = 0;
  const dphi = (2 * Math.PI * FREQ) / FS;
  for (const { dbfs, duration } of parts) {
    const n = Math.round(duration * FS);
    const amp = 10 ** (dbfs / 20);
    for (let i = 0; i < n; i++) {
      left[offset++] = amp * Math.sin(phase);
      phase += dphi;
    }
  }
  if (!stereo) return [left];
  return [left, new Float32Array(left)];
}

function measure(parts, opts) {
  return loudnessRange({ sampleRate: FS, channels: sineSegments(parts, opts) });
}

test('EBU 3342 case 1: âˆ’20 then âˆ’30 dBFS yields LRA 10 Â± 1', () => {
  const r = measure([
    { dbfs: -20, duration: 20 },
    { dbfs: -30, duration: 20 },
  ]);
  assert.equal(typeof r.lraLu, 'number');
  assert.ok(Math.abs(r.lraLu - 10) <= 1, `lraLu=${r.lraLu}`);
});

test('EBU 3342 case 2: âˆ’20 then âˆ’15 dBFS yields LRA 5 Â± 1', () => {
  const r = measure([
    { dbfs: -20, duration: 20 },
    { dbfs: -15, duration: 20 },
  ]);
  assert.equal(typeof r.lraLu, 'number');
  assert.ok(Math.abs(r.lraLu - 5) <= 1, `lraLu=${r.lraLu}`);
});

test('EBU 3342 case 3: âˆ’40 then âˆ’20 dBFS yields LRA 20 Â± 1', () => {
  const r = measure([
    { dbfs: -40, duration: 20 },
    { dbfs: -20, duration: 20 },
  ]);
  assert.equal(typeof r.lraLu, 'number');
  assert.ok(Math.abs(r.lraLu - 20) <= 1, `lraLu=${r.lraLu}`);
});

test('steady 10 s sine has LRA below 0.5', () => {
  const r = measure([{ dbfs: -20, duration: 10 }]);
  assert.equal(typeof r.lraLu, 'number');
  assert.ok(r.lraLu < 0.5, `lraLu=${r.lraLu}`);
});

test('all-zero input returns null fields and does not throw', () => {
  const n = FS * 5;
  const r = loudnessRange({
    sampleRate: FS,
    channels: [new Float32Array(n), new Float32Array(n)],
  });
  assert.equal(r.lraLu, null);
  assert.equal(r.shortTermMaxLufs, null);
  assert.equal(r.momentaryMaxLufs, null);
  assert.equal(r.shortTermCount, null);
  for (const v of Object.values(r)) {
    assert.equal(Number.isNaN(v), false);
  }
});

test('input shorter than 3 s has null LRA and a numeric momentary max', () => {
  const r = measure([{ dbfs: -20, duration: 1 }]);
  assert.equal(r.lraLu, null);
  assert.equal(typeof r.momentaryMaxLufs, 'number');
  assert.equal(Number.isFinite(r.momentaryMaxLufs), true);
});

test('stereo short-term max is about 3.01 LU above the same mono signal', () => {
  const parts = [{ dbfs: -20, duration: 5 }];
  const mono = measure(parts, { stereo: false });
  const stereo = measure(parts, { stereo: true });
  assert.equal(typeof mono.shortTermMaxLufs, 'number');
  assert.equal(typeof stereo.shortTermMaxLufs, 'number');
  const delta = stereo.shortTermMaxLufs - mono.shortTermMaxLufs;
  assert.ok(Math.abs(delta - 3.01) <= 0.1, `delta=${delta}`);
});
