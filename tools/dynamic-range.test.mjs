import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dynamicRange } from "../audio.mjs";

const SR = 48000;
const A = 10 ** (-20 / 20);

function sine(n, sr = SR, amp = A, freq = 1000) {
  const x = new Float32Array(n);
  const w = (2 * Math.PI * freq) / sr;
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(w * i);
  return x;
}

function square(n, amp = A) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (i % 480) < 240 ? amp : -amp;
  return x;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noise(n, amp = A) {
  const r = mulberry32(1);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * (2 * r() - 1);
  return x;
}

describe("dynamicRange", () => {
  it("stereo 1 kHz sine, 30 s", () => {
    const n = SR * 30;
    const s = sine(n);
    const out = dynamicRange({ sampleRate: SR, channels: [s, s.slice()] });
    assert.deepEqual(out.drPerChannel, [0, 0]);
    assert.equal(out.drMean, 0);
    assert.equal(out.dr, 0);
    assert.equal(out.blockCount, 10);
  });

  it("mono square wave, 30 s", () => {
    const out = dynamicRange({
      sampleRate: SR,
      channels: [square(SR * 30)],
    });
    assert.ok(Math.abs(out.drMean - -3.01) <= 0.01);
    assert.equal(out.dr, -3);
  });

  it("mono sine with two spikes, 30 s", () => {
    const s = sine(SR * 30);
    s[48000] = 0.9;
    s[480000] = 0.8;
    const out = dynamicRange({ sampleRate: SR, channels: [s] });
    assert.ok(Math.abs(out.drMean - 18.06) <= 0.01);
    assert.equal(out.dr, 18);
  });

  it("mono uniform noise seed 1, 30 s", () => {
    const out = dynamicRange({
      sampleRate: SR,
      channels: [noise(SR * 30)],
    });
    assert.ok(Math.abs(out.drMean - 1.75) <= 0.05);
  });

  it("stereo plain sine and spiked sine, 30 s", () => {
    const n = SR * 30;
    const left = sine(n);
    const right = sine(n);
    right[48000] = 0.9;
    right[480000] = 0.8;
    const out = dynamicRange({ sampleRate: SR, channels: [left, right] });
    assert.equal(out.drPerChannel.length, 2);
    assert.ok(Math.abs(out.drPerChannel[0] - 0) <= 0.01);
    assert.ok(Math.abs(out.drPerChannel[1] - 18.06) <= 0.01);
    assert.ok(Math.abs(out.drMean - 9.03) <= 0.01);
    assert.equal(out.dr, 9);
  });

  it("all-zero stereo, 6 s", () => {
    const n = SR * 6;
    const z = new Float32Array(n);
    const out = dynamicRange({ sampleRate: SR, channels: [z, z.slice()] });
    assert.deepEqual(out.drPerChannel, [null, null]);
    assert.equal(out.drMean, null);
    assert.equal(out.dr, null);
    assert.equal(out.blockCount, 2);
  });

  it("mono sine at 44.1 kHz, 10 s with partial last block", () => {
    const sr = 44100;
    const out = dynamicRange({
      sampleRate: sr,
      channels: [sine(sr * 10, sr)],
    });
    assert.equal(out.blockCount, 4);
    assert.equal(out.drMean, 0);
    assert.equal(out.dr, 0);
  });
});

import { analyze, advise } from '../audio.mjs';
it('analyze exposes DR and advise flags a heavily limited master', () => {
  const sampleRate = 48000;
  const samples = square(sampleRate * 6, 0.5);
  const report = analyze({ sampleRate, frames: samples.length, channels: [samples] });
  assert.deepEqual(report.dynamicRange, dynamicRange({ sampleRate, channels: [samples] }));
  const note = 'Dynamic range is under DR6: the master is likely over-compressed or over-limited; ease the limiter or bus compression.';
  assert.ok(advise(report).includes(note));
  assert.ok(!advise({ ...report, dynamicRange: { dr: null } }).includes(note));
  assert.ok(!advise({ ...report, dynamicRange: { dr: 6 } }).includes(note));
});
