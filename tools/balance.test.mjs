// Unit tests for tools/balance.mjs. Run: node --test tools/balance.test.mjs  (no LMMS needed)
import assert from 'node:assert/strict';
import test from 'node:test';
import * as dsp from '../audio.mjs';
import {
  blockStats, compareMeasurements, correlation, drumKind, gainFor, guessRole, loudestWindow, maskingReport, masterFor,
  relativeBands, scaleAutomation, sumStems, targetFor, windowLevels,
} from './balance.mjs';

const sampleRate = 48000;
const near = (actual, expected, tolerance, label = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} is not within ${tolerance} of ${expected}`);
function tone(hz, seconds, level = 0.5, { channels = 2, from = 0, to = seconds } = {}) {
  const frames = Math.round(seconds * sampleRate);
  const data = Float32Array.from({ length: frames }, (_, i) => i >= from * sampleRate && i < to * sampleRate ? level * Math.sin(2 * Math.PI * hz * i / sampleRate) : 0);
  return { sampleRate, frames, channels: Array.from({ length: channels }, () => data.slice()) };
}

test('gain maths: volume moves by the dB difference, linear in LMMS volume', () => {
  const down = gainFor(-1, -7, 100);
  assert.equal(down.newVolume, 50.12);
  near(down.gainDb, -6, 0.01);
  assert.equal(down.clamped, false);
  const up = gainFor(-30, -18, 50);
  assert.equal(up.newVolume, 199.05);
  // More than +6 dB from 100 hits the 200 ceiling and says so.
  const capped = gainFor(-40, -18, 100);
  assert.equal(capped.newVolume, 200);
  assert.equal(capped.clamped, true);
  near(capped.gainDb, 6.02, 0.01);
});

test('automation points scale by the same factor and stay in range', () => {
  assert.deepEqual(scaleAutomation([0, 50, 100, 180], 0.5), [0, 25, 50, 90]);
  assert.deepEqual(scaleAutomation([150], 2), [200]);
});

test('master: protect only lowers, fit lands on the headroom, keep leaves it', () => {
  const hot = 10 ** (-0.5 / 20), quiet = 10 ** (-12 / 20);
  const lowered = masterFor(hot, 100, 2, 'protect');
  near(lowered.changeDb, -1.5, 0.01);
  assert.deepEqual(masterFor(quiet, 100, 2, 'protect'), { volume: 100, changeDb: 0 });
  near(masterFor(quiet, 100, 2, 'fit').changeDb, 6, 0.05); // capped at 200
  near(masterFor(10 ** (-5 / 20), 100, 2, 'fit').changeDb, 3, 0.01);
  assert.deepEqual(masterFor(hot, 80, 2, 'keep'), { volume: 80, changeDb: 0 });
});

test('role fallback: declared, then name, then instrument, then spectrum, and guesses say so', () => {
  assert.deepEqual(guessRole({ name: 'Thing', declared: 'lead' }), { role: 'lead', kind: null, source: 'declared' });
  assert.deepEqual(guessRole({ name: 'Kit Kick', declared: 'drums' }), { role: 'drums', kind: 'kick', source: 'declared' });
  assert.equal(guessRole({ name: 'Warm Pad' }).role, 'texture');
  assert.equal(guessRole({ name: 'Counter Line' }).role, 'counter');
  assert.equal(guessRole({ name: 'Main Melody' }).role, 'lead');
  assert.equal(guessRole({ name: 'Sub Bass' }).role, 'bass');
  assert.deepEqual(guessRole({ name: 'Closed HH' }), { role: 'drums', kind: 'hat', source: 'guess from name' });
  assert.deepEqual(guessRole({ name: 'Track 3', plugin: 'audiofileprocessor', sample: 'drums/snare01.ogg' }), { role: 'drums', kind: 'snare', source: 'guess from instrument' });
  assert.deepEqual(guessRole({ name: 'Track 4', plugin: 'kicker' }), { role: 'drums', kind: 'kick', source: 'guess from instrument' });
  assert.equal(guessRole({ name: 'Track 5', sample: 'basses/fat.ogg' }).role, 'bass');
  assert.deepEqual(guessRole({ name: 'Track 6', centroidHz: 120, lowShare: 0.8, crestDb: 8 }), { role: 'bass', kind: null, source: 'guess from spectrum' });
  assert.equal(guessRole({ name: 'Track 7', centroidHz: 9000, crestDb: 24 }).kind, 'hat');
  assert.equal(guessRole({ name: 'Track 8', centroidHz: 1500, crestDb: 7, activeShare: 0.9 }).role, 'harmony');
  assert.equal(drumKind('Atmosphere'), null, 'no tom in atmos');
  assert.equal(drumKind('Bottom'), null);
});

test('targets: drums by peak, pitched parts by RMS, with role, kind and track overrides', () => {
  assert.deepEqual(targetFor({ role: 'drums', kind: 'kick' }, 'Kick'), { measure: 'peak', db: -7, from: 'default kick' });
  assert.deepEqual(targetFor({ role: 'bass', kind: null }, 'Bass'), { measure: 'rms', db: -18, from: 'default bass' });
  assert.equal(targetFor({ role: 'drums', kind: null }, 'Kit').db, -8);
  assert.deepEqual(targetFor({ role: 'lead' }, 'Lead', { roles: { lead: -15 } }), { measure: 'rms', db: -15, from: 'role override' });
  assert.deepEqual(targetFor({ role: 'drums', kind: 'hat' }, 'Hats', { roles: { hat: -21 } }), { measure: 'peak', db: -21, from: 'role override' });
  assert.deepEqual(targetFor({ role: 'lead' }, 'Lead', { tracks: { Lead: { measure: 'peak', db: -6 } } }), { measure: 'peak', db: -6, from: 'track override' });
});

test('block levels and the loudest window', () => {
  // 4 one-second blocks; loud only in seconds 2 and 3.
  const audio = tone(440, 4, 0.5, { from: 2 });
  const blocks = blockStats(audio, sampleRate, { bands: false });
  assert.equal(blocks.length, 4);
  assert.deepEqual(loudestWindow(blocks, 2), { start: 2, length: 2 });
  const level = windowLevels(blocks, 2, 4);
  near(level.peakDbfs, -6.02, 0.02);
  near(level.rmsDbfs, -9.03, 0.02);
  assert.equal(windowLevels(blocks, 0, 2).rmsDbfs, null);
});

test('peak prediction: summed gain-scaled stems match the sum of the scaled signals', () => {
  const a = tone(100, 1, 0.4), b = tone(100, 1, 0.2, { channels: 1 });
  const mix = sumStems([a, b], [0.5, 2], 0.8);
  // In phase: 0.8 * (0.4*0.5 + 0.2*2) = 0.48
  near(dsp.samplePeak(mix), 0.48, 1e-4);
  assert.equal(mix.channels.length, 2, 'mono stems spread to both sides');
  near(dsp.samplePeak(sumStems([a, b], [1, 1])), 0.6, 1e-4);
});

test('correlation flags wide stems', () => {
  assert.equal(correlation(tone(300, 0.5)), 1);
  const wide = tone(300, 0.5);
  wide.channels[1] = wide.channels[1].map(v => -v);
  assert.equal(correlation(wide), -1);
});

test('masking: two parts in the same band at the same time are flagged, different bands are not', () => {
  const blockFrames = sampleRate;
  const pad = blockStats(tone(1000, 4, 0.2), blockFrames);
  const lead = blockStats(tone(1200, 4, 0.3), blockFrames);
  const bass = blockStats(tone(80, 4, 0.4), blockFrames);
  const found = maskingReport([
    { track: 'Pad', role: 'texture', gainDb: 0, blocks: pad },
    { track: 'Lead', role: 'lead', gainDb: 0, blocks: lead },
    { track: 'Bass', role: 'bass', gainDb: 0, blocks: bass },
  ], { secondsPerBlock: 1 });
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].tracks, ['Pad', 'Lead']);
  assert.equal(found[0].band, 'mid');
  assert.equal(found[0].sharedBars, 4);
  assert.match(found[0].suggestion, /lower Pad by 2 to 3 dB/);
  assert.match(found[0].suggestion, /shorten its notes/);
  // Parts that never play together do not mask each other.
  const early = blockStats(tone(1000, 4, 0.2, { to: 2 }), blockFrames), late = blockStats(tone(1000, 4, 0.2, { from: 2 }), blockFrames);
  assert.equal(maskingReport([{ track: 'A', role: 'harmony', blocks: early }, { track: 'B', role: 'lead', blocks: late }]).length, 0);
});

test('reference comparison: band balance is relative, so a quieter copy reads the same balance', () => {
  const bands = { sub: -40, bass: -20, lowMid: -20, mid: -30, highMid: -40, air: -50 };
  const quieter = Object.fromEntries(Object.entries(bands).map(([k, v]) => [k, v - 10]));
  assert.deepEqual(relativeBands(bands), relativeBands(quieter));
});

test('reference comparison on synthetic audio: a dark mix is told to brighten 2 to 6 kHz', () => {
  const mixOf = (highLevel, level = 1) => {
    const low = tone(200, 3, 0.3 * level), high = tone(3500, 3, highLevel * level);
    return sumStems([low, high], [1, 1]);
  };
  const keep = m => ({ integratedLufs: m.integratedLufs, peakDbfs: m.peakDbfs, rmsDbfs: m.rmsDbfs, crestDb: m.crestDb,
    stereoCorrelation: m.stereoCorrelation, centroidHz: m.centroidHz, bandsDbfs: m.bandsDbfs });
  const dark = keep(dsp.analyze(mixOf(0.03, 0.5))), reference = keep(dsp.analyze(mixOf(0.15)));
  const result = compareMeasurements(dark, reference);
  near(result.differences.bandsDb.highMid, -14, 1, 'high-mid difference');
  assert.ok(result.differences.loudnessLu < -4);
  assert.ok(result.differences.centroidRatio < 1);
  assert.match(result.suggestions[0], /dB less energy in 2 to 6 kHz than the reference: brighten the lead or raise the hats/);
  assert.ok(result.suggestions.some(s => /LU quieter/.test(s)));
  assert.equal(compareMeasurements(reference, reference).suggestions.length, 0);
});
