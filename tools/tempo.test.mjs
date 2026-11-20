import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTempo } from '../audio.mjs';

function clicks(bpm, sr, sec) {
  const buf = new Float32Array(sr * sec);
  const p = 60 / bpm;
  const len = Math.round(0.005 * sr);
  for (let j = 0; ; j++) {
    const s = Math.round(j * p * sr);
    if (s >= buf.length) break;
    const end = Math.min(s + len, buf.length);
    for (let i = s; i < end; i++) buf[i] = 0.5;
  }
  return buf;
}

function mulberry32(seed) {
  let a = seed | 0;
  return function r() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function house() {
  const sr = 48000;
  const buf = new Float32Array(sr * 20);
  const p = 60 / 128;
  const r = mulberry32(1);
  const kickLen = Math.round(0.12 * sr);
  const hatLen = Math.round(0.03 * sr);
  for (let j = 0; ; j++) {
    const s = Math.round(j * p * sr);
    if (s >= buf.length) break;
    for (let i = 0; i < kickLen; i++) {
      const idx = s + i;
      if (idx >= buf.length) break;
      buf[idx] +=
        0.8 *
        Math.exp(-i / (0.03 * sr)) *
        Math.sin((2 * Math.PI * 55 * i) / sr);
    }
    const h = Math.round((j * p + p / 2) * sr);
    for (let i = 0; i < hatLen; i++) {
      const idx = h + i;
      if (idx >= buf.length) break;
      buf[idx] += 0.2 * (2 * r() - 1) * Math.exp(-i / (0.008 * sr));
    }
  }
  return buf;
}

test('mono clicks 128 BPM at 48 kHz', () => {
  const buf = clicks(128, 48000, 20);
  const out = estimateTempo({ sampleRate: 48000, channels: [buf] });
  assert.ok(Math.abs(out.bpm - 128) <= 0.5, `bpm=${out.bpm}`);
  assert.ok(out.confidence >= 0.5, `confidence=${out.confidence}`);
});

test('mono clicks 174 BPM at 48 kHz (octave guard)', () => {
  const buf = clicks(174, 48000, 20);
  const out = estimateTempo({ sampleRate: 48000, channels: [buf] });
  assert.ok(Math.abs(out.bpm - 174) <= 0.5, `bpm=${out.bpm}`);
});

test('mono clicks 140 BPM at 48 kHz', () => {
  const buf = clicks(140, 48000, 20);
  const out = estimateTempo({ sampleRate: 48000, channels: [buf] });
  assert.ok(Math.abs(out.bpm - 140) <= 0.5, `bpm=${out.bpm}`);
});

test('mono clicks 90 BPM at 44.1 kHz', () => {
  const buf = clicks(90, 44100, 20);
  const out = estimateTempo({ sampleRate: 44100, channels: [buf] });
  assert.ok(Math.abs(out.bpm - 90) <= 0.5, `bpm=${out.bpm}`);
});

test('stereo house() 128 BPM', () => {
  const buf = house();
  const out = estimateTempo({ sampleRate: 48000, channels: [buf, buf] });
  assert.ok(Math.abs(out.bpm - 128) <= 0.5, `bpm=${out.bpm}`);
  assert.ok(out.confidence >= 0.5, `confidence=${out.confidence}`);
});

test('all-zero mono returns null bpm', () => {
  const buf = new Float32Array(48000 * 5);
  const out = estimateTempo({ sampleRate: 48000, channels: [buf] });
  assert.equal(out.bpm, null);
  assert.equal(out.confidence, 0);
});

test('steady 1 kHz sine returns null bpm', () => {
  const sr = 48000;
  const buf = new Float32Array(sr * 10);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = 0.1 * Math.sin((2 * Math.PI * 1000 * i) / sr);
  }
  const out = estimateTempo({ sampleRate: sr, channels: [buf] });
  assert.equal(out.bpm, null);
});

test('100-sample buffer returns null bpm and 0 onset frames', () => {
  const buf = new Float32Array(100);
  const out = estimateTempo({ sampleRate: 48000, channels: [buf] });
  assert.equal(out.bpm, null);
  assert.equal(out.onsetFrames, 0);
});

import { analyze, advise } from '../audio.mjs';

test('analyze adds tempo while keeping expected-BPM checks opt-in', () => {
  const samples = clicks(128, 48000, 20);
  const report = analyze({ sampleRate: 48000, frames: samples.length, channels: [samples] });
  assert.ok(Math.abs(report.tempo.bpm - 128) <= 0.5);
  assert.ok(report.tempo.confidence >= 0.5);
  assert.deepEqual(Object.keys(report.tempo).sort(), ['bpm', 'confidence']);
  assert.ok(!advise(report).some(note => note.startsWith('Detected tempo')));
});

test('analyze and advise detect wrong BPM and accept octave tolerance', () => {
  const samples = clicks(128, 48000, 20);
  const audio = { sampleRate: 48000, frames: samples.length, channels: [samples] };
  const wrong = analyze(audio, { expectedBpm: 100 });
  assert.equal(wrong.tempo.expectedBpm, 100);
  assert.equal(wrong.tempo.match, false);
  assert.ok(advise(wrong).includes(`Detected tempo (${wrong.tempo.bpm} BPM) does not match the requested 100 BPM: check the project tempo and the drum pattern grid.`));
  for (const expectedBpm of [64, 128, 256]) {
    const right = analyze(audio, { expectedBpm });
    assert.equal(right.tempo.match, true);
    assert.ok(!advise(right).some(note => note.startsWith('Detected tempo')));
  }
  const silent = analyze({ sampleRate: 48000, frames: 48000, channels: [new Float32Array(48000)] }, { expectedBpm: 128 });
  assert.equal(silent.tempo.match, null);
  assert.ok(!advise(silent).some(note => note.startsWith('Detected tempo')));
});
