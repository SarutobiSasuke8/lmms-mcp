import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEffects, rearrange, divisionBeats, effectNames, describeEffects, regionOf } from './dj-effects.mjs';

const sr = 48000, bpm = 120, bar = sr * 2; // one bar is 2 s at 120 bpm
// A steady test track: a low tone, a high tone and a click on every beat.
function track(bars = 8) {
  const n = bars * bar, make = phase => {
    const ch = new Float32Array(n);
    for (let i = 0; i < n; i++) ch[i] = 0.25 * Math.sin(2 * Math.PI * 110 * i / sr + phase) + 0.12 * Math.sin(2 * Math.PI * 5000 * i / sr) + (i % (sr / 2) < 200 ? 0.4 : 0);
    return ch;
  };
  return { sampleRate: sr, channels: [make(0), make(0.3)], frames: n };
}
const rms = (ch, from, to) => { let s = 0; for (let i = from; i < to; i++) s += ch[i] * ch[i]; return Math.sqrt(s / (to - from)); };
// Energy of one frequency in a window.
function tone(ch, hz, from, to) {
  let re = 0, im = 0;
  for (let i = from; i < to; i++) { re += ch[i] * Math.cos(2 * Math.PI * hz * i / sr); im += ch[i] * Math.sin(2 * Math.PI * hz * i / sr); }
  return 2 * Math.hypot(re, im) / (to - from);
}
const maxJump = (ch, from, to) => { let m = 0; for (let i = from + 1; i < to; i++) m = Math.max(m, Math.abs(ch[i] - ch[i - 1])); return m; };
const run = (effect, bars) => { const a = track(bars); const applied = applyEffects(a, bpm, [effect]); return { a, applied }; };

test('divisions, regions and the catalogue', () => {
  assert.equal(divisionBeats('1/4'), 1);
  assert.equal(divisionBeats('1/8d'), 0.75);
  assert.ok(Math.abs(divisionBeats('1/8t') - 1 / 3) < 1e-9);
  assert.equal(divisionBeats('1'), 4);
  assert.throws(() => divisionBeats('fast'), /division/);
  assert.deepEqual(regionOf(track(), bpm, { type: 'cut', startBar: 2, bars: 0.25 }), { start: 2 * bar, end: 2 * bar + bar / 4, length: bar / 4 });
  assert.throws(() => regionOf(track(), bpm, { type: 'cut', startBar: 40, bars: 1 }), /outside/);
  assert.equal(describeEffects().length, effectNames.length);
  assert.ok(effectNames.length >= 13);
  for (const d of describeEffects()) assert.ok(d.summary && d.params, d.type);
});

test('every effect runs, stays finite, leaves the rest of the track alone and does not click at its edges', () => {
  const before = track();
  for (const type of effectNames) {
    const { a, applied } = run({ type, startBar: 2, bars: 2 });
    assert.equal(applied[0].startSeconds, 4);
    assert.equal(applied[0].seconds, 4);
    for (let c = 0; c < 2; c++) {
      assert.deepEqual(a.channels[c].subarray(0, 2 * bar), before.channels[c].subarray(0, 2 * bar), `${type} changed audio before its region`);
      assert.deepEqual(a.channels[c].subarray(4 * bar), before.channels[c].subarray(4 * bar), `${type} changed audio after its region`);
      assert.ok(a.channels[c].every(Number.isFinite), type);
      // The test track has its own beat click at each edge, so compare with the untouched track.
      for (const edge of [2 * bar, 4 * bar]) assert.ok(maxJump(a.channels[c], edge - 8, edge + 8) < maxJump(before.channels[c], edge - 8, edge + 8) + 0.08, `${type} clicks at an edge`);
    }
  }
});

test('a low-pass sweep removes the highs at the closed end and returns them at the open end', () => {
  const { a } = run({ type: 'filter_sweep', startBar: 2, bars: 2, filter: 'lowpass', fromHz: 200, toHz: 18000 });
  const early = tone(a.channels[0], 5000, 2 * bar + 2000, 2 * bar + 12000), late = tone(a.channels[0], 5000, 4 * bar - 12000, 4 * bar - 2000);
  assert.ok(early < 0.01 && late > 0.09, `${early} ${late}`);
  const hp = run({ type: 'filter_sweep', startBar: 2, bars: 2, filter: 'highpass', fromHz: 40, toHz: 2000 }).a;
  assert.ok(tone(hp.channels[0], 110, 4 * bar - 12000, 4 * bar - 2000) < 0.02);
  assert.ok(tone(hp.channels[0], 110, 2 * bar + 2000, 2 * bar + 12000) > 0.15);
});

test('beat repeat loops the first slice, and accelerate shortens it', () => {
  const { a } = run({ type: 'beat_repeat', startBar: 2, bars: 1, division: '1/8' });
  const slice = sr / 4, ch = a.channels[0];
  for (const offset of [500, 3000, 9000]) assert.ok(Math.abs(ch[2 * bar + offset] - ch[2 * bar + slice * 3 + offset]) < 1e-6);
  const fast = run({ type: 'beat_repeat', startBar: 2, bars: 1, division: '1/4', accelerate: true }).a.channels[0];
  // In the last quarter the slice is an eighth of the first, so the beat click comes round eight times as often.
  const clicks = (from, to) => { let n = 0; for (let i = from + 1; i < to; i++) if (fast[i] > 0.45 && fast[i - 1] <= 0.45) n++; return n; };
  assert.ok(clicks(2 * bar + bar * 3 / 4, 3 * bar) > clicks(2 * bar, 2 * bar + bar / 4) * 3);
});

test('gate, pump and cut shape the level in time', () => {
  const gated = run({ type: 'gate', startBar: 2, bars: 1, division: '1/8', duty: 0.5 }).a.channels[0], step = sr / 4;
  assert.ok(rms(gated, 2 * bar + step * 0.6, 2 * bar + step * 0.95) < 0.01);
  assert.ok(rms(gated, 2 * bar + step * 0.1, 2 * bar + step * 0.4) > 0.15);
  const pattern = run({ type: 'gate', startBar: 2, bars: 1, division: '1/8', pattern: 'x-', duty: 1 }).a.channels[0];
  assert.ok(rms(pattern, 2 * bar + step * 1.2, 2 * bar + step * 1.9) < 0.01);
  assert.throws(() => run({ type: 'gate', startBar: 2, bars: 1, pattern: 'abc' }), /Gate patterns/);
  const pumped = run({ type: 'pump', startBar: 2, bars: 1, depth: 0.8 }).a.channels[0];
  assert.ok(rms(pumped, 2 * bar + 1500, 2 * bar + 4000) < rms(pumped, 2 * bar + sr / 2 - 4000, 2 * bar + sr / 2 - 500) * 0.6);
  const silent = run({ type: 'cut', startBar: 2, bars: 0.25 }).a.channels[0];
  assert.ok(rms(silent, 2 * bar + 1000, 2 * bar + bar / 4 - 1000) === 0);
});

test('tape stop falls in pitch to silence, spinback and reverse play backwards, echo out decays', () => {
  const stopped = run({ type: 'tape_stop', startBar: 2, bars: 1, stopBeats: 2 }).a.channels[0];
  assert.ok(tone(stopped, 110, 2 * bar + sr * 0.6, 2 * bar + sr * 0.9) < 0.05, 'pitch should have dropped away from 110 Hz');
  assert.ok(rms(stopped, 2 * bar + sr * 1.1, 3 * bar - 500) === 0);
  const ramp = { sampleRate: sr, frames: bar * 4, channels: [Float32Array.from({ length: bar * 4 }, (_, i) => i / (bar * 4))] };
  applyEffects(ramp, bpm, [{ type: 'reverse', startBar: 1, bars: 1 }]);
  assert.ok(ramp.channels[0][bar + 1000] > ramp.channels[0][bar + 5000]);
  const spun = { sampleRate: sr, frames: bar * 4, channels: [Float32Array.from({ length: bar * 4 }, (_, i) => i / (bar * 4))] };
  applyEffects(spun, bpm, [{ type: 'spinback', startBar: 2, bars: 1 }]);
  assert.ok(spun.channels[0][2 * bar + 20000] < spun.channels[0][2 * bar + 4000]);
  const echo = run({ type: 'echo_out', startBar: 2, bars: 2, division: '1/4', feedback: 0.6 }).a.channels[0];
  const first = rms(echo, 2 * bar + sr / 2, 2 * bar + sr), third = rms(echo, 2 * bar + sr * 1.5, 2 * bar + sr * 2), last = rms(echo, 2 * bar + sr * 3.5, 4 * bar - 500);
  assert.ok(first > third && third > last && last > 0, `${first} ${third} ${last}`);
});

test('scratch drags a slice back and forth, the riser grows, phaser and flanger change the tone', () => {
  for (const pattern of ['baby', 'chirp', 'transform']) {
    const { a } = run({ type: 'scratch', startBar: 2, bars: 1, pattern });
    assert.ok(rms(a.channels[0], 2 * bar, 3 * bar) > 0.02, pattern);
  }
  assert.throws(() => run({ type: 'scratch', startBar: 2, bars: 1, pattern: 'crab' }), /baby, chirp or transform/);
  const over = run({ type: 'scratch', startBar: 2, bars: 1, over: true }).a.channels[0];
  assert.ok(tone(over, 5000, 2 * bar + 4000, 3 * bar - 4000) > 0.05, 'the music stays underneath');
  const silence = { sampleRate: sr, frames: bar * 4, channels: [new Float32Array(bar * 4), new Float32Array(bar * 4)] };
  applyEffects(silence, bpm, [{ type: 'noise_riser', startBar: 0, bars: 4, levelDb: -12 }]);
  assert.ok(rms(silence.channels[0], bar * 3.5, bar * 4 - 2000) > rms(silence.channels[0], bar * 0.5, bar) * 4);
  assert.notDeepEqual(silence.channels[0].subarray(bar, bar + 64), silence.channels[1].subarray(bar, bar + 64));
  const original = track().channels[0];
  for (const type of ['phaser', 'flanger']) {
    const ch = run({ type, startBar: 2, bars: 2, mix: 0.5 }).a.channels[0];
    let difference = 0;
    for (let i = 2 * bar; i < 4 * bar; i++) difference += Math.abs(ch[i] - original[i]);
    assert.ok(difference / (2 * bar) > 0.005, type);
  }
});

test('effects chain in order and bad input is refused with the effect number', () => {
  const a = track();
  const applied = applyEffects(a, bpm, [{ type: 'filter_sweep', startBar: 0, bars: 2, filter: 'highpass', fromHz: 40, toHz: 800 }, { type: 'beat_repeat', startBar: 1, bars: 1 }, { type: 'cut', startBar: 1.75, bars: 0.25 }]);
  assert.deepEqual(applied.map(e => e.type), ['filter_sweep', 'beat_repeat', 'cut']);
  assert.throws(() => applyEffects(track(), bpm, [{ type: 'cut', startBar: 0, bars: 1 }, { type: 'wobble', startBar: 0, bars: 1 }]), /Effect 2: unknown type/);
  assert.throws(() => applyEffects(track(), 0, [{ type: 'cut', startBar: 0, bars: 1 }]), /bpm/);
  assert.throws(() => applyEffects(track(), bpm, [{ type: 'beat_repeat', startBar: 0, bars: 1, division: 'x' }]), /Effect 1 \(beat_repeat\)/);
});

test('rearrange builds a new order from bar ranges', () => {
  const a = track(8);
  for (let i = 0; i < a.frames; i++) a.channels[0][i] = Math.floor(i / bar); // each bar holds its own number
  const out = rearrange(a, bpm, [{ fromBar: 4, bars: 1 }, { fromBar: 0, bars: 2, repeat: 2 }, { fromBar: 7, bars: 0.5, gainDb: -6 }]);
  assert.equal(out.frames, bar * 5.5);
  assert.equal(out.pieces, 4);
  const at = b => out.channels[0][Math.round(b * bar) + 5000];
  assert.deepEqual([at(0), at(1), at(2), at(3), at(4)], [4, 0, 1, 0, 1]);
  assert.ok(Math.abs(at(5) - 7 * 10 ** (-6 / 20)) < 1e-4);
  assert.equal(out.channels[0][0] < 0.1, true, 'pieces fade in');
  assert.throws(() => rearrange(a, bpm, [{ fromBar: 7, bars: 4 }]), /outside the audio/);
});
