// Unit tests for tools/loop-prep.mjs on synthetic audio with known answers. Run: node --test tools/loop-prep.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as dsp from '../audio.mjs';
import { analyseFrames, barCounts, crossfadeLoop, decodeAudioFile, detectTempo, equalPowerGains, findLoops, quietestShift, refineLength } from './loop-prep.mjs';

// Deterministic noise so every run is identical.
function noise(seed) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 31 - 1; };
}
// Intro (non-repeating), then a phrase of `phraseBars` bars repeated `repeats` times, then an ending that rings out.
// Clicks on every beat, accented on the downbeat; each bar of the phrase holds a different tone.
export function synthSong({ sampleRate = 48000, bpm = 120, introBars = 2, phraseBars = 4, repeats = 2, endingBars = 2, channels = 2 } = {}) {
  const beat = 60 / bpm, bar = beat * 4;
  const totalBars = introBars + phraseBars * repeats + endingBars;
  const frames = Math.round(totalBars * bar * sampleRate);
  const left = new Float32Array(frames);
  const random = noise(7), hiss = noise(99);
  const tone = (startSec, seconds, hz, level) => {
    const s = Math.round(startSec * sampleRate), n = Math.round(seconds * sampleRate);
    for (let i = 0; i < n && s + i < frames; i++) {
      const t = i / sampleRate;
      left[s + i] += level * Math.exp(-3 * t / seconds) * Math.sin(2 * Math.PI * hz * t);
    }
  };
  // A click is the same short noise burst every time, like a drum sample.
  const burstNoise = noise(42), burst = Float32Array.from({ length: Math.round(0.012 * sampleRate) }, () => burstNoise());
  const click = (startSec, level) => {
    const s = Math.round(startSec * sampleRate), n = burst.length;
    for (let i = 0; i < n && s + i < frames; i++) left[s + i] += level * burst[i] * (1 - i / n);
  };
  for (let b = 0; b < introBars; b++) {
    for (let k = 0; k < 4; k++) {
      const t = (b * 4 + k) * beat;
      click(t, k === 0 ? 0.5 : 0.3);
      tone(t, beat, 300 + 400 * Math.abs(random()), 0.2);
    }
  }
  const phraseStart = introBars * bar;
  for (let r = 0; r < repeats; r++) {
    for (let b = 0; b < phraseBars; b++) {
      const barStart = phraseStart + (r * phraseBars + b) * bar;
      tone(barStart, bar, 110 * 2 ** ((b * 5) / 12), 0.25);
      for (let k = 0; k < 4; k++) {
        click(barStart + k * beat, k === 0 ? 0.6 : 0.3);
        tone(barStart + k * beat, beat / 2, 440 * 2 ** (((b * 3 + k * 2) % 12) / 12), 0.12);
      }
    }
  }
  const endStart = phraseStart + repeats * phraseBars * bar;
  click(endStart, 0.6);
  tone(endStart, bar * 1.5, 110, 0.3);
  tone(endStart, bar * 1.5, 165, 0.2);
  for (let i = 0; i < frames; i++) left[i] += 0.002 * hiss();
  const data = [left, ...(channels === 2 ? [Float32Array.from(left, v => v * 0.9)] : [])];
  return { audio: { sampleRate, frames, channels: data }, loopStartSeconds: phraseStart, loopSeconds: phraseBars * bar, bar };
}

test('barCounts tries every length to 16 bars, then multiples of four', () => {
  assert.deepEqual(barCounts(1, 20), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 20]);
  assert.deepEqual(barCounts(14, 24), [14, 15, 16, 20, 24]);
});

test('tempo detection finds the bpm and a beat on the clicks', () => {
  for (const bpm of [96, 120, 137]) {
    const { audio } = synthSong({ bpm, phraseBars: 2, repeats: 3 });
    const features = analyseFrames(audio);
    const tempo = detectTempo(features.onset, features.frameRate);
    assert.ok(Math.abs(tempo.bpm - bpm) < 0.5, `${bpm}: got ${tempo.bpm}`);
    assert.ok(tempo.confidence > 0.3, `${bpm}: confidence ${tempo.confidence}`);
    const beat = 60 / bpm, first = tempo.firstBeatFrame / features.frameRate;
    const offset = ((first % beat) + beat) % beat;
    assert.ok(Math.min(offset, beat - offset) < 0.03, `${bpm}: first beat ${first}`);
  }
  const hinted = detectTempo(analyseFrames(synthSong({ bpm: 120 }).audio).onset, 100, { bpm: 121 });
  assert.equal(hinted.bpm, 121);
  assert.equal(hinted.source, 'hint');
});

test('tempo detection reports no beat for silence', () => {
  const silent = { sampleRate: 48000, frames: 48000 * 4, channels: [new Float32Array(48000 * 4)] };
  const features = analyseFrames(silent);
  assert.equal(detectTempo(features.onset, features.frameRate).bpm, null);
  const result = findLoops(silent);
  assert.equal(result.needsHumanChoice, true);
  assert.equal(result.candidates.length, 0);
});

for (const sampleRate of [48000, 44100]) {
  test(`loop finding recovers a 4-bar phrase after an intro at ${sampleRate} Hz`, () => {
    const { audio, loopStartSeconds, loopSeconds } = synthSong({ sampleRate, bpm: 112, phraseBars: 4, repeats: 2 });
    const result = findLoops(audio, { count: 5 });
    const best = result.candidates[0];
    assert.equal(best.bars, 4, JSON.stringify(result.candidates.map(c => [c.bars, c.seamScore])));
    assert.ok(Math.abs(best.lengthSeconds - loopSeconds) < 0.002, `length ${best.lengthSeconds} against ${loopSeconds}`);
    assert.ok(Math.abs(best.startSeconds - loopStartSeconds) < 0.06, `start ${best.startSeconds} against ${loopStartSeconds}`);
    assert.equal(best.intro, true);
    assert.ok(best.seamScore > 0.8, String(best.seamScore));
    assert.ok(Math.abs(best.bpmFromLength - 112) < 0.05, String(best.bpmFromLength));
    assert.equal(result.needsHumanChoice, false);
    assert.equal(result.sampleRate, sampleRate);
  });
}

test('with three repeats the longest equally good loop wins and the phrase length is offered too', () => {
  const { audio, loopSeconds } = synthSong({ bpm: 128, phraseBars: 2, repeats: 3, channels: 1 });
  const { candidates } = findLoops(audio, { count: 6 });
  assert.equal(candidates[0].bars % 2, 0);
  const phrase = candidates.find(c => c.bars === 2);
  assert.ok(phrase, JSON.stringify(candidates.map(c => c.bars)));
  assert.ok(Math.abs(phrase.lengthSeconds - loopSeconds) < 0.002);
});

test('noise with no beat asks a person to pick', () => {
  const random = noise(3), frames = 48000 * 12;
  const data = Float32Array.from({ length: frames }, () => 0.2 * random());
  const result = findLoops({ sampleRate: 48000, frames, channels: [data] });
  assert.equal(result.needsHumanChoice, true);
  assert.match(result.advice, /person should listen and pick/);
});

test('refineLength recovers an exact repeat length from a rough guess', () => {
  const { audio, loopStartSeconds, loopSeconds } = synthSong({ bpm: 100, phraseBars: 2, repeats: 2, channels: 1 });
  const start = Math.round(loopStartSeconds * 48000), exact = Math.round(loopSeconds * 48000);
  const fit = refineLength(audio.channels[0], 48000, start, exact + 700);
  assert.ok(Math.abs(fit.length - exact) <= 2, `${fit.length} against ${exact}`);
  assert.ok(fit.correlation > 0.9);
});

test('equal-power gains keep constant power and hit their end points', () => {
  for (let i = 0; i <= 64; i++) {
    const [fadeIn, fadeOut] = equalPowerGains(i, 64);
    assert.ok(Math.abs(fadeIn ** 2 + fadeOut ** 2 - 1) < 1e-12);
  }
  assert.deepEqual(equalPowerGains(0, 64), [0, 1]);
  const [fadeIn, fadeOut] = equalPowerGains(64, 64);
  assert.equal(fadeIn, 1);
  assert.ok(Math.abs(fadeOut) < 1e-12);
  assert.ok(Math.abs(equalPowerGains(32, 64)[0] - Math.SQRT1_2) < 1e-12);
});

test('crossfadeLoop fades the loop end into the audio before the start, so both joins are continuous', () => {
  const sampleRate = 48000, frames = sampleRate * 2, hz = 233; // the loop is not a whole number of cycles
  const data = Float32Array.from({ length: frames }, (_, i) => 0.5 * Math.sin(2 * Math.PI * hz * i / sampleRate));
  const audio = { sampleRate, frames, channels: [data] };
  const start = 10000, end = 60000, fade = 2400;
  const { audio: loop, mode, fadeFrames } = crossfadeLoop(audio, start, end, fade);
  assert.equal(mode, 'before');
  assert.equal(fadeFrames, fade);
  assert.equal(loop.frames, end - start);
  const step = 0.5 * 2 * Math.PI * hz / sampleRate; // largest natural sample-to-sample change
  const out = loop.channels[0];
  assert.equal(out[0], data[start]); // the intro-to-loop join is untouched
  assert.equal(out[out.length - 1], data[start - 1]); // the loop ends on the sample that precedes its start
  assert.ok(Math.abs(out[0] - out[out.length - 1]) <= step + 1e-6);
  for (let i = 1; i < out.length; i++) assert.ok(Math.abs(out[i] - out[i - 1]) <= step * 1.6, `jump at ${i}`);
  // A plain cut of the same region jumps.
  assert.ok(Math.abs(data[start] - data[end - 1]) > step * 2);
});

test('crossfadeLoop uses the audio after the end when the loop starts at the top of the file', () => {
  const sampleRate = 48000, frames = sampleRate;
  const data = Float32Array.from({ length: frames }, (_, i) => Math.sin(2 * Math.PI * 97 * i / sampleRate));
  const { audio: loop, mode } = crossfadeLoop({ sampleRate, frames, channels: [data] }, 0, 30000, 1000);
  assert.equal(mode, 'after');
  assert.equal(loop.channels[0][0], data[30000]);
  assert.equal(loop.channels[0][29999], data[29999]);
  assert.equal(loop.channels[0][1000], data[1000]);
  const none = crossfadeLoop({ sampleRate, frames, channels: [data] }, 0, frames, 1000);
  assert.equal(none.mode, 'cut');
});

test('quietestShift moves a region to a quiet, flat point without changing its length', () => {
  const sampleRate = 48000, frames = sampleRate;
  const data = Float32Array.from({ length: frames }, (_, i) => Math.sin(2 * Math.PI * 50 * i / sampleRate));
  const audio = { sampleRate, frames, channels: [data] };
  const shift = quietestShift(audio, 1000, 1000 + 4800, 300);
  const at = 1000 + shift;
  // 50 Hz has a zero crossing every 480 samples; the flattest-quiet point is a crest or a crossing nearby.
  assert.ok(Math.abs(shift) <= 300);
  const cost = s => Math.abs(data[s] - data[s - 1]) + 0.5 * Math.abs(data[s]);
  assert.ok(cost(at) <= cost(1000));
});

test('decodeAudioFile reads WAV at any rate and gives a clear error for MP3 without ffmpeg', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'loop-prep-test-'));
  try {
    const wav = path.join(folder, 'a.wav');
    await writeFile(wav, dsp.encodeWav({ sampleRate: 44100, channels: [new Float32Array(4410).fill(0.25)] }));
    const { audio, decoder } = await decodeAudioFile(wav, { available: false });
    assert.equal(decoder, 'wav');
    assert.equal(audio.sampleRate, 44100);
    await writeFile(path.join(folder, 'b.mp3'), Buffer.from('not really'));
    await assert.rejects(decodeAudioFile(path.join(folder, 'b.mp3'), { ffmpeg: path.join(folder, 'no-ffmpeg-here') }),
      /needs ffmpeg\. Install it or set LMMS_FFMPEG/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
