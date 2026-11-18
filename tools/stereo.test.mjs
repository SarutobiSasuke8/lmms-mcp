import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stereoImage } from '../stereo.mjs';

const SAMPLE_RATE = 48000;
const SINE_FREQ = 1000;
const SINE_DBFS = -20;
const SINE_PEAK = 10 ** (SINE_DBFS / 20);

function sine(durationSec, phase = 0) {
  const n = Math.round(durationSec * SAMPLE_RATE);
  const out = new Float32Array(n);
  const omega = (2 * Math.PI * SINE_FREQ) / SAMPLE_RATE;
  for (let i = 0; i < n; i++) {
    out[i] = SINE_PEAK * Math.sin(omega * i + phase);
  }
  return out;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noise(durationSec, seed) {
  const n = Math.round(durationSec * SAMPLE_RATE);
  const rng = mulberry32(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = (rng() * 2 - 1) * SINE_PEAK;
  }
  return out;
}

function measure(channels, durationHint) {
  return stereoImage({ sampleRate: SAMPLE_RATE, channels });
}

test('identical L/R sine, 2 s', () => {
  const L = sine(2);
  const R = new Float32Array(L);
  const r = measure([L, R]);
  assert.ok(Math.abs(r.correlation - 1) <= 0.001);
  assert.equal(r.widthPct, 0);
  assert.ok(Math.abs(r.monoFoldDropDb - 0) <= 0.01);
  assert.equal(r.sideToMidDb, null);
});

test('R = âˆ’L, 2 s', () => {
  const L = sine(2);
  const R = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) R[i] = -L[i];
  const r = measure([L, R]);
  assert.ok(Math.abs(r.correlation - -1) <= 0.001);
  assert.equal(r.widthPct, 100);
  assert.equal(r.monoCancels, true);
  assert.equal(r.monoFoldDropDb, null);
});

test('L sine with R shifted +Ï€/2, 2 s', () => {
  const L = sine(2, 0);
  const R = sine(2, Math.PI / 2);
  const r = measure([L, R]);
  assert.ok(Math.abs(r.correlation) < 0.01);
  assert.ok(Math.abs(r.widthPct - 50) <= 0.5);
  assert.ok(Math.abs(r.monoFoldDropDb - 3.01) <= 0.05);
});

test('uncorrelated noise (seed 1 / seed 2), 5 s', () => {
  const L = noise(5, 1);
  const R = noise(5, 2);
  const r = measure([L, R]);
  assert.ok(Math.abs(r.correlation) < 0.03);
  assert.ok(Math.abs(r.monoFoldDropDb - 3.01) <= 0.1);
});

test('10 s identical sine with R inverted from 4 s to 5 s', () => {
  const L = sine(10);
  const R = new Float32Array(L);
  const start = 4 * SAMPLE_RATE;
  const end = 5 * SAMPLE_RATE;
  for (let i = start; i < end; i++) R[i] = -L[i];
  const r = measure([L, R]);
  assert.ok(Math.abs(r.correlation - 0.8) <= 0.02);
  assert.ok(Math.abs(r.minWindowCorrelation - -1) <= 0.01);
});

test('R = L Ã— 0.5', () => {
  const L = sine(2);
  const R = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) R[i] = L[i] * 0.5;
  const r = measure([L, R]);
  assert.ok(Math.abs(r.correlation - 1) <= 0.001);
  assert.ok(Math.abs(r.widthPct - 10) <= 0.2);
  assert.ok(Math.abs(r.sideToMidDb - -9.54) <= 0.05);
});

test('all-zero stereo input, 1 s', () => {
  const n = SAMPLE_RATE;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const r = measure([L, R]);
  assert.equal(r.correlation, null);
  assert.equal(r.minWindowCorrelation, null);
  assert.equal(r.sideToMidDb, null);
  assert.equal(r.widthPct, null);
  assert.equal(r.monoFoldDropDb, null);
  assert.equal(r.monoCancels, false);
  assert.equal(r.windowCount, 0);
});

test('mono input (one channel) of the 2 s sine', () => {
  const L = sine(2);
  const r = measure([L]);
  assert.equal(r.correlation, 1);
  assert.equal(r.widthPct, 0);
  assert.equal(r.monoFoldDropDb, 0);
});
