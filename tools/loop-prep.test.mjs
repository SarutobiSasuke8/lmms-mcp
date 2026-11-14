// Unit tests for tools/loop-prep.mjs on synthetic audio with known answers. Run: node --test tools/loop-prep.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as dsp from '../audio.mjs';
import { analyseFrames, barCounts, crossfadeLoop, decodeAudioFile, detectTempo, equalPowerGains, ffmpegWorks, findLoops, highPass,
  linearGains, mixMono, quietestShift, refineLength, scoreSeam } from './loop-prep.mjs';

// Deterministic noise so every run is identical.
function noise(seed) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 31 - 1; };
}
// Intro (non-repeating), then a phrase of `phraseBars` bars repeated `repeats` times, then an ending that rings out.
// Clicks on every beat (or every eighth note with `eighths`), accented on the downbeat; each bar of the phrase holds a
// different tone. `variation` makes the repeats inexact: 'slight' is a level change of -1 dB plus a different noise
// tail on each pass, as two renders of a section with different effect tails would be; 'loose' also changes every
// tone's phase and the click sound, so the waveforms no longer line up although the music is the same.
export function synthSong({ sampleRate = 48000, bpm = 120, introBars = 2, phraseBars = 4, repeats = 2, endingBars = 2, channels = 2,
  variation = 'none', eighths = false } = {}) {
  const beat = 60 / bpm, bar = beat * 4;
  const totalBars = introBars + phraseBars * repeats + endingBars;
  const frames = Math.round(totalBars * bar * sampleRate);
  const left = new Float32Array(frames);
  const random = noise(7), hiss = noise(99), phases = noise(5);
  const tone = (startSec, seconds, hz, level, phase = 0) => {
    const s = Math.round(startSec * sampleRate), n = Math.round(seconds * sampleRate);
    for (let i = 0; i < n && s + i < frames; i++) {
      const t = i / sampleRate;
      left[s + i] += level * Math.exp(-3 * t / seconds) * Math.sin(2 * Math.PI * hz * t + phase);
    }
  };
  // A click is the same short noise burst every time, like a drum sample.
  const makeBurst = seed => { const r = noise(seed); return Float32Array.from({ length: Math.round(0.012 * sampleRate) }, () => r()); };
  const bursts = [makeBurst(42), makeBurst(43)];
  const click = (startSec, level, which = 0) => {
    const burst = bursts[which], s = Math.round(startSec * sampleRate), n = burst.length;
    for (let i = 0; i < n && s + i < frames; i++) left[s + i] += level * burst[i] * (1 - i / n);
  };
  const tail = (startSec, seconds, level, seed) => {
    const r = noise(seed), s = Math.round(startSec * sampleRate), n = Math.round(seconds * sampleRate);
    for (let i = 0; i < n && s + i < frames; i++) left[s + i] += level * r() * Math.exp(-4 * i / n);
  };
  const clicks = (barStart, level, which) => {
    for (let k = 0; k < (eighths ? 8 : 4); k++) {
      const onBeat = !eighths || k % 2 === 0;
      click(barStart + k * beat / (eighths ? 2 : 1), k === 0 ? 0.6 * level : onBeat ? 0.3 * level : 0.15 * level, which);
    }
  };
  for (let b = 0; b < introBars; b++) {
    clicks(b * bar, 0.85, 0);
    for (let k = 0; k < 4; k++) tone((b * 4 + k) * beat, beat, 300 + 400 * Math.abs(random()), 0.2);
  }
  const phraseStart = introBars * bar;
  for (let r = 0; r < repeats; r++) {
    const later = r > 0 && variation !== 'none', loose = r > 0 && variation === 'loose';
    const gain = later ? 0.89 : 1, phase = () => loose ? 2 * Math.PI * phases() : 0;
    for (let b = 0; b < phraseBars; b++) {
      const barStart = phraseStart + (r * phraseBars + b) * bar;
      tone(barStart, bar, 110 * 2 ** ((b * 5) / 12), 0.25 * gain, phase());
      clicks(barStart, gain, loose ? 1 : 0);
      for (let k = 0; k < 4; k++) tone(barStart + k * beat, beat / 2, 440 * 2 ** (((b * 3 + k * 2) % 12) / 12), 0.12 * gain, phase());
      if (variation !== 'none') tail(barStart, bar, 0.01, 1000 + r * 100 + b);
    }
  }
  const endStart = phraseStart + repeats * phraseBars * bar;
  if (endingBars) {
    click(endStart, 0.6);
    tone(endStart, bar * 1.5, 110, 0.3);
    tone(endStart, bar * 1.5, 165, 0.2);
  }
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
});

test('a near-miss bpm hint is a starting point, not the answer', () => {
  const song = synthSong({ bpm: 119.6, phraseBars: 8, repeats: 2 });
  const features = analyseFrames(song.audio);
  const hinted = detectTempo(features.onset, features.frameRate, { bpm: 120 });
  assert.equal(hinted.source, 'hint, refined');
  assert.equal(hinted.hintBpm, 120);
  assert.ok(Math.abs(hinted.bpm - 119.6) < 0.05, String(hinted.bpm));
  // A hint with no beat near it is kept as given.
  const noise1 = noise(11), frames = 48000 * 6, hiss = Float32Array.from({ length: frames }, () => 0.1 * noise1());
  const flat = analyseFrames({ sampleRate: 48000, frames, channels: [hiss] });
  assert.equal(detectTempo(flat.onset, flat.frameRate, { bpm: 121 }).bpm, 121);
  // The loop length comes from the audio, exact to the sample, although the hint is 0.33% off.
  const { candidates, needsHumanChoice } = findLoops(song.audio, { bpm: 120 });
  assert.equal(candidates[0].bars, 8);
  assert.ok(Math.abs(candidates[0].lengthFrames - song.loopSeconds * 48000) <= 1, `${candidates[0].lengthFrames} against ${song.loopSeconds * 48000}`);
  assert.equal(needsHumanChoice, false);
});

test('slow and fast tempos are found, and half or double tempo is flagged', () => {
  // 64 bpm is read as is. 160 bpm is read as 80 with 160 flagged: the prior leans towards 120 and plain clicks cannot
  // tell the two apart, which is exactly why the other reading is reported.
  for (const bpm of [64, 160]) {
    const features = analyseFrames(synthSong({ bpm, phraseBars: 2, repeats: 2 }).audio);
    const tempo = detectTempo(features.onset, features.frameRate);
    const readings = [tempo.bpm, ...tempo.alternatives.map(a => a.bpm)];
    assert.ok(readings.some(b => Math.abs(b - bpm) < 0.5), `${bpm}: readings ${readings}`);
    assert.ok(tempo.confidence > 0.3, `${bpm}: confidence ${tempo.confidence}`);
  }
  // Clicks on every beat at 174, 180 and 200 bpm read at half tempo, so double tempo is flagged and searched.
  for (const bpm of [174, 180, 200]) {
    const song = synthSong({ bpm, phraseBars: 4, repeats: 2 });
    const result = findLoops(song.audio, { count: 10 });
    const near = (a, b) => Math.abs(a - b) < 0.5;
    const readings = [result.tempo.bpm, ...result.tempo.alternatives.map(a => a.bpm)];
    assert.ok(readings.some(b => near(b, bpm)), `${bpm}: readings ${readings}`);
    if (!near(result.tempo.bpm, bpm)) {
      assert.equal(result.tempo.alternatives[0].relation, 'double');
      assert.match(result.advice, /tempo may be/);
      assert.ok(result.candidates.some(c => c.tempoReading === 'double' && near(c.barsAtBpm, bpm)), `${bpm}: no candidate at the double reading`);
    }
    const loop = result.candidates.find(c => Math.abs(c.lengthFrames - song.loopSeconds * 48000) <= 1);
    assert.ok(loop, `${bpm}: the 4-bar loop is a candidate`);
  }
  // Eighth notes at 70 bpm read as 140: half tempo is flagged.
  const eighths = findLoops(synthSong({ bpm: 70, phraseBars: 2, eighths: true }).audio);
  const readings = [eighths.tempo.bpm, ...eighths.tempo.alternatives.map(a => a.bpm)];
  assert.ok(readings.some(b => Math.abs(b - 70) < 0.5), `70: readings ${readings}`);
  // A clear mid tempo carries no octave flag.
  assert.deepEqual(findLoops(synthSong({ bpm: 112 }).audio).tempo.alternatives, []);
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
    // Notes sit on rounded frames, so the true repeat is within one frame of the exact bar length.
    assert.ok(Math.abs(best.lengthFrames - loopSeconds * sampleRate) <= 1, `length ${best.lengthFrames} against ${loopSeconds * sampleRate}`);
    assert.equal(best.lengthFrom, 'repeat match');
    assert.ok(Math.abs(best.startSeconds - loopStartSeconds) < 0.012, `start ${best.startSeconds} against ${loopStartSeconds}`);
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
  assert.ok(Math.abs(phrase.lengthFrames - loopSeconds * 48000) <= 1);
});

test('ranks do not depend on how many candidates are asked for', () => {
  const { audio } = synthSong({ bpm: 128, phraseBars: 2, repeats: 3 });
  const few = findLoops(audio, { count: 3 }).candidates, many = findLoops(audio, { count: 10 }).candidates;
  assert.deepEqual(few.map(c => [c.startFrame, c.endFrame]), many.slice(0, 3).map(c => [c.startFrame, c.endFrame]));
});

test('a loop that runs to the end of the file is judged from before the seam', () => {
  const { audio, loopStartSeconds, loopSeconds } = synthSong({ bpm: 120, phraseBars: 4, repeats: 2, endingBars: 0 });
  const { candidates } = findLoops(audio);
  const best = candidates[0];
  assert.equal(best.bars, 4);
  assert.ok(Math.abs(best.lengthFrames - loopSeconds * 48000) <= 1, String(best.lengthFrames));
  assert.ok(Math.abs(best.startSeconds - loopStartSeconds) < 0.012, String(best.startSeconds));
  // The second pass, which ends exactly at the end of the file, has nothing after it to compare with.
  const features = analyseFrames(audio);
  features.barFeatureFrames = Math.round(features.featureRate * 2);
  const secondPass = Math.round((loopStartSeconds + loopSeconds) * 48000);
  const seam = scoreSeam(audio, features, mixMono(audio), secondPass, audio.frames);
  assert.equal(seam.judgedFrom, 'before the seam');
  assert.ok(seam.seamScore > 0.8, String(seam.seamScore));
});

test('slightly different repeats still match to the sample', () => {
  const { audio, loopSeconds } = synthSong({ bpm: 112, phraseBars: 4, repeats: 2, variation: 'slight' });
  const result = findLoops(audio);
  const best = result.candidates[0];
  assert.equal(best.bars, 4);
  assert.equal(best.lengthFrom, 'repeat match');
  assert.ok(best.repeatCorrelation >= 0.5, String(best.repeatCorrelation));
  assert.ok(Math.abs(best.lengthFrames - loopSeconds * 48000) <= 1, String(best.lengthFrames));
  assert.ok(best.seamScore > 0.75, String(best.seamScore));
});

test('loose repeats keep the beat-grid length and ask a person to listen', () => {
  const { audio, loopSeconds } = synthSong({ bpm: 112, phraseBars: 4, repeats: 2, variation: 'loose' });
  const result = findLoops(audio);
  const best = result.candidates[0];
  assert.equal(best.bars, 4);
  assert.equal(best.lengthFrom, 'beat grid');
  assert.ok(best.repeatCorrelation < 0.5, String(best.repeatCorrelation));
  assert.ok(Math.abs(best.lengthSeconds - loopSeconds) < 0.002, `${best.lengthSeconds} against ${loopSeconds}`);
  assert.match(result.advice, /beat grid/);
  assert.equal(result.needsHumanChoice, true);
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
  const fit = refineLength(highPass(audio.channels[0]), 48000, start, exact + 700);
  assert.ok(Math.abs(fit.length - exact) <= 1, `${fit.length} against ${exact}`);
  assert.ok(fit.correlation > 0.9);
  assert.equal(fit.refined, true);
  // Unrelated audio either side: the guess is kept and marked as not refined.
  const random = noise(8), hiss = Float32Array.from({ length: 48000 * 8 }, () => random());
  const loose = refineLength(hiss, 48000, 48000, 96000 + 300);
  assert.equal(loose.refined, false);
  assert.equal(loose.length, 96300);
});

test('linear gains sum to one and hit their end points', () => {
  for (let i = 0; i <= 64; i++) assert.ok(Math.abs(linearGains(i, 64)[0] + linearGains(i, 64)[1] - 1) < 1e-12);
  assert.deepEqual(linearGains(0, 64), [0, 1]);
  assert.deepEqual(linearGains(64, 64), [1, 0]);
});

// RMS in dB of one channel over [from, to).
const rmsDb = (data, from, to) => { let s = 0; for (let i = from; i < to; i++) s += data[i] * data[i]; return 10 * Math.log10(s / (to - from)); };
test('crossfades keep the level: linear for alike audio, equal-power for unrelated audio', () => {
  const sampleRate = 48000, frames = sampleRate * 2, fade = 4800;
  // A loop whose seam joins identical audio: a steady 200 Hz tone with whole cycles in the loop.
  const same = Float32Array.from({ length: frames }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 200 * i / sampleRate));
  const alike = crossfadeLoop({ sampleRate, frames, channels: [same] }, 24000, 72000, fade);
  assert.equal(alike.shape, 'linear');
  assert.ok(alike.correlation > 0.99);
  const steady = rmsDb(alike.audio.channels[0], 0, 4800);
  for (let at = 48000 - fade; at < 48000; at += 480) {
    const level = rmsDb(alike.audio.channels[0], at, at + 480);
    assert.ok(Math.abs(level - steady) < 0.1, `linear fade level ${level.toFixed(2)} against ${steady.toFixed(2)} dB`);
  }
  // Equal power on the same audio would bump the middle of the fade by about 3 dB.
  const bumped = crossfadeLoop({ sampleRate, frames, channels: [same] }, 24000, 72000, fade, { shape: 'equal-power' });
  const middle = rmsDb(bumped.audio.channels[0], 48000 - fade / 2 - 240, 48000 - fade / 2 + 240);
  assert.ok(middle - steady > 2.5, `equal-power bump ${(middle - steady).toFixed(2)} dB`);
  // Unrelated noise either side of the seam: equal power keeps the level within about 1 dB.
  const random = noise(21), hiss = Float32Array.from({ length: frames }, () => 0.3 * random());
  const unrelated = crossfadeLoop({ sampleRate, frames, channels: [hiss] }, 24000, 72000, fade);
  assert.equal(unrelated.shape, 'equal-power');
  const noiseLevel = rmsDb(unrelated.audio.channels[0], 0, 24000);
  const fadeLevel = rmsDb(unrelated.audio.channels[0], 48000 - fade, 48000);
  assert.ok(Math.abs(fadeLevel - noiseLevel) < 1, `equal-power fade ${fadeLevel.toFixed(2)} against ${noiseLevel.toFixed(2)} dB`);
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
  // A region that starts on silence at frame 0 stays there.
  const quiet = Float32Array.from({ length: frames }, (_, i) => i < 2000 ? 0 : Math.sin(i / 7));
  assert.equal(quietestShift({ sampleRate, frames, channels: [quiet] }, 0, 1000, 100), 0);
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
    await assert.rejects(decodeAudioFile(path.join(folder, 'missing.wav')), /File not found: missing\.wav/);
    // With ffmpeg, decoding goes through a dot folder in the given root, which is removed afterwards.
    if (await ffmpegWorks()) {
      await writeFile(path.join(folder, 'c.wav'), Buffer.from('RIFF....WAVEjunk'));
      await assert.rejects(decodeAudioFile(path.join(folder, 'c.wav'), { tempRoot: folder }), /ffmpeg could not decode/);
      assert.deepEqual((await readdir(folder)).filter(name => name.startsWith('.')), []);
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
