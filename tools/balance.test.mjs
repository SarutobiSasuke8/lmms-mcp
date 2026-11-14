// Unit tests for tools/balance.mjs. Run: node --test tools/balance.test.mjs  (no LMMS needed)
import assert from 'node:assert/strict';
import test from 'node:test';
import * as dsp from '../audio.mjs';
import {
  automationLevel, blockStats, checkSpan, compareMeasurements, correlation, drumKind, effectNote, guessRole, loudestWindow,
  maskingReport, masterFor, noteFacts, planBalance, relativeBands, scaleAutomation, selectTracks, sumStems, targetFor,
  validateTargets, windowLevels, words,
} from './balance.mjs';

const sampleRate = 48000;
const near = (actual, expected, tolerance, label = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} is not within ${tolerance} of ${expected}`);
function tone(hz, seconds, level = 0.5, { channels = 2, from = 0, to = seconds } = {}) {
  const frames = Math.round(seconds * sampleRate);
  const data = Float32Array.from({ length: frames }, (_, i) => i >= from * sampleRate && i < to * sampleRate ? level * Math.sin(2 * Math.PI * hz * i / sampleRate) : 0);
  return { sampleRate, frames, channels: Array.from({ length: channels }, () => data.slice()) };
}
const sine = level => 20 * Math.log10(level / Math.SQRT2); // RMS of a sine in dBFS

test('gain plan: a static volume moves by the dB difference, linear in LMMS volume', () => {
  const { rows, targetShiftDb } = planBalance([
    { measuredDb: -1, targetDb: -7, control: { kind: 'static', volume: 100 } },
    { measuredDb: -30, targetDb: -18, control: { kind: 'static', volume: 50 } },
  ]);
  assert.equal(targetShiftDb, 0);
  assert.equal(rows[0].volumeAfter, 50.119);
  near(rows[0].gainDb, -6, 0.01);
  assert.equal(rows[1].volumeAfter, 199.054);
  assert.ok(!rows[0].limited && !rows[1].limited);
});

test('gain plan: targets are levels at master 100, so the master offset is taken out', () => {
  // Measured -13 with the master at 50 (-6 dB) is -7 at master 100: already on target.
  const { rows } = planBalance([{ measuredDb: -13.02, targetDb: -7, control: { kind: 'static', volume: 80 } }], { masterOffsetDb: 20 * Math.log10(0.5) });
  near(rows[0].gainDb, 0, 0.01);
});

test('gain plan: when one track clamps at 200, every target comes down together so the balance holds (regression)', () => {
  const { rows, targetShiftDb } = planBalance([
    { measuredDb: -30, targetDb: -20, control: { kind: 'static', volume: 100 } }, // wants +10, can give +6.02
    { measuredDb: -10, targetDb: -10, control: { kind: 'static', volume: 100 } }, // on target
  ]);
  near(targetShiftDb, -3.98, 0.01);
  near(rows[0].gainDb, 6.02, 0.01);
  near(rows[1].gainDb, -3.98, 0.01);
  // The 10 dB gap between the two targets survives.
  near((-30 + rows[0].gainDb) - (-10 + rows[1].gainDb), -10, 0.02);
  assert.ok(!rows[0].limited, 'after the shift nothing is short');
  assert.equal(rows[0].setsShift, true);
});

test('gain plan: the shift is capped, and a track still short says so', () => {
  const { rows, targetShiftDb } = planBalance([{ measuredDb: -50, targetDb: -20, control: { kind: 'static', volume: 100 } }], { maxShiftDb: 12 });
  assert.equal(targetShiftDb, -12);
  assert.equal(rows[0].limited, true);
  assert.match(rows[0].warning, /Needs 18 dB .*12 dB short/);
});

test('gain plan: no false clamp warning for tiny volumes (regression)', () => {
  const { rows } = planBalance([{ measuredDb: -10, targetDb: -50, control: { kind: 'static', volume: 1 } }]);
  assert.equal(rows[0].volumeAfter, 0.01);
  assert.ok(!rows[0].limited);
});

test('automation: level is the mean over the window, holding between clips and before the first', () => {
  const clips = [
    { pos: 0, len: 192, prog: 1, points: [{ pos: 0, value: 0 }, { pos: 192, value: 100 }] }, // a one-bar fade-in, held after
    { pos: 384, len: 192, prog: 0, points: [{ pos: 0, value: 40 }, { pos: 96, value: 80 }] },
  ];
  near(automationLevel(clips, 70, 0, 192).mean, 48.4, 1, 'fade-in mean');
  near(automationLevel(clips, 70, 192, 384).mean, 100, 0.01, 'after a clip it holds its last point');
  near(automationLevel(clips, 70, 384, 576).mean, 60, 0.01, 'step clip');
  assert.equal(automationLevel(clips, 70, 0, 576).max, 100);
  assert.equal(automationLevel([], 70, 0, 192).mean, 70);
});

test('automation: a fade-in from 0 is planned, not skipped, and the gain stays under the highest point (regression)', () => {
  // Window mean 20, points up to 180: +3 dB would push 180 past 200, so the plan stops at 200/180.
  const { rows, targetShiftDb } = planBalance([
    { measuredDb: -23, targetDb: -20, control: { kind: 'automated', level: 20, max: 180 } },
    { measuredDb: -20, targetDb: -20, control: { kind: 'static', volume: 100 } },
  ]);
  near(rows[0].gainDb, 20 * Math.log10(200 / 180), 0.01);
  near(targetShiftDb, -(3 - 20 * Math.log10(200 / 180)), 0.01, 'the rest of the mix comes down to match');
  assert.equal(rows[0].automated, true);
  assert.deepEqual(scaleAutomation([0, 90, 180], rows[0].factor), [0, 100, 200], 'no point is cut off');
  const fade = planBalance([{ measuredDb: -30, targetDb: -24, control: { kind: 'automated', level: 50, max: 100 } }]);
  assert.ok(!fade.rows[0].skipped);
  near(fade.rows[0].gainDb, 6, 0.01);
  assert.match(planBalance([{ measuredDb: -30, targetDb: -24, control: { kind: 'automated', level: 0, max: 0 } }]).rows[0].skipped, /volume is 0/);
});

test('automation points scale by the same factor and stay in range', () => {
  assert.deepEqual(scaleAutomation([0, 50, 100, 180], 0.5), [0, 25, 50, 90]);
  assert.deepEqual(scaleAutomation([150], 2), [200]);
});

test('master: protect only lowers, fit lands on the headroom, keep leaves it, and the cap holds', () => {
  const hot = 10 ** (-0.5 / 20), quiet = 10 ** (-12 / 20);
  near(masterFor(hot, 2, 'protect').changeDb, -1.5, 0.01);
  assert.deepEqual(masterFor(quiet, 2, 'protect'), { factor: 1, changeDb: 0 });
  near(masterFor(quiet, 2, 'fit', 2).changeDb, 6.02, 0.01);
  near(masterFor(10 ** (-5 / 20), 2, 'fit').changeDb, 3, 0.01);
  assert.deepEqual(masterFor(hot, 2, 'keep'), { factor: 1, changeDb: 0 });
});

test('solo is refused rather than balancing a partial mix (regression)', () => {
  const list = [{ name: 'A' }, { name: 'B', solo: true }, { name: 'Auto', control: true, solo: true }, { name: 'M', muted: true }];
  assert.throws(() => selectTracks(list), /Solo is on for B/);
  assert.deepEqual(selectTracks(list.map(t => ({ ...t, solo: false }))), [0, 1]);
  assert.throws(() => selectTracks([{ name: 'M', muted: true }]), /No unmuted/);
});

test('effects: level-dependent effects are flagged, linear ones are not (regression)', () => {
  assert.match(effectNote('Master', ['ladspa:sc4', 'eq']), /Master has level-dependent effects \(ladspa:sc4\)/);
  assert.match(effectNote('Lead', ['ladspa:fastLookaheadLimiter']), /prediction is approximate/);
  assert.equal(effectNote('Pad', ['eq', 'reverbsc', 'delay', 'stereoenhancer']), null);
  assert.equal(effectNote('Pad', []), null);
});

test('names match whole words only (regression)', () => {
  assert.deepEqual(words('LeadSynth_2'), ['lead', 'synth', '2']);
  assert.equal(guessRole({ name: 'Offbeat Chords' }).role, 'harmony');
  assert.equal(guessRole({ name: 'Heartbeat Pad' }).role, 'texture');
  assert.equal(guessRole({ name: 'Neptune Pad' }).role, 'texture');
  assert.equal(guessRole({ name: 'Theme Strings' }).role, 'harmony');
  assert.equal(guessRole({ name: 'Harp' }).role, 'harmony');
  assert.equal(guessRole({ name: 'Second Lead' }).role, 'counter');
  assert.equal(drumKind('Atmosphere'), null);
  assert.equal(drumKind('Bottom'), null);
  assert.equal(drumKind('Bass Drum'), 'kick');
  assert.equal(drumKind('Hi Hat'), 'hat');
  assert.equal(drumKind('Override'), null, 'no ride inside override');
});

test('role fallback: declared, name checked against the sound, instrument, notes, spectrum; guesses say so', () => {
  assert.deepEqual(guessRole({ name: 'Thing', declared: 'lead' }), { role: 'lead', kind: null, source: 'declared' });
  assert.deepEqual(guessRole({ name: 'Kit Kick', declared: 'drums' }), { role: 'drums', kind: 'kick', source: 'declared' });
  assert.deepEqual(guessRole({ name: 'Closed HH' }), { role: 'drums', kind: 'hat', source: 'guess from name' });
  // A "drum" name on a sustained chordal part is overruled by what the part does.
  const chordal = noteFacts([{ tick: 0, length: 96, midi: 60 }, { tick: 0, length: 96, midi: 64 }, { tick: 0, length: 96, midi: 67 }]);
  const overruled = guessRole({ name: 'Drum Pad Thing', notes: chordal, crestDb: 6 });
  assert.equal(overruled.role, 'harmony');
  assert.match(overruled.source, /guess from notes \(the name suggests drums, the sound does not\)/);
  assert.deepEqual(guessRole({ name: 'Track 3', plugin: 'audiofileprocessor', sample: 'drums/snare01.ogg' }), { role: 'drums', kind: 'snare', source: 'guess from instrument' });
  assert.deepEqual(guessRole({ name: 'Track 4', plugin: 'kicker' }), { role: 'drums', kind: 'kick', source: 'guess from instrument' });
  assert.equal(guessRole({ name: 'Track 5', sample: 'basses/fat.ogg' }).role, 'bass');
  const low = noteFacts([{ tick: 0, length: 48, midi: 36 }, { tick: 48, length: 48, midi: 38 }]);
  assert.deepEqual(guessRole({ name: 'Track 6', notes: low }), { role: 'bass', kind: null, source: 'guess from notes' });
  const line = noteFacts([{ tick: 0, length: 48, midi: 72 }, { tick: 48, length: 48, midi: 74 }]);
  assert.equal(guessRole({ name: 'Track 7', notes: line }).role, 'lead');
  const long = noteFacts([0, 4, 7].map(d => ({ tick: 0, length: 384, midi: 60 + d })));
  assert.equal(guessRole({ name: 'Track 8', notes: long }).role, 'texture');
  assert.deepEqual(guessRole({ name: 'Track 9', centroidHz: 120, lowShare: 0.8, crestDb: 8 }), { role: 'bass', kind: null, source: 'guess from spectrum' });
  assert.equal(guessRole({ name: 'Track 10', centroidHz: 9000, crestDb: 24 }).kind, 'hat');
});

test('targets: defaults, overrides, and no prototype keys (regression)', () => {
  assert.deepEqual(targetFor({ role: 'drums', kind: 'kick' }, 'Kick'), { measure: 'peak', db: -7, from: 'default kick' });
  assert.deepEqual(targetFor({ role: 'bass', kind: null }, 'Bass'), { measure: 'rms', db: -18, from: 'default bass' });
  assert.equal(targetFor({ role: 'drums', kind: null }, 'Kit').db, -8);
  assert.deepEqual(targetFor({ role: 'lead' }, 'Lead', { roles: { lead: -15 } }), { measure: 'rms', db: -15, from: 'role override' });
  assert.deepEqual(targetFor({ role: 'drums', kind: 'hat' }, 'Hats', { roles: { hat: -21 } }), { measure: 'peak', db: -21, from: 'role override' });
  assert.deepEqual(targetFor({ role: 'lead' }, 'Lead', { tracks: { Lead: { measure: 'peak', db: -6 } } }), { measure: 'peak', db: -6, from: 'track override' });
  assert.deepEqual(targetFor({ role: 'lead' }, 'constructor', { tracks: {} }), { measure: 'rms', db: -17, from: 'default lead' });
  assert.deepEqual(targetFor({ role: 'lead' }, 'toString', { tracks: { toString: -20 } }), { measure: 'rms', db: -20, from: 'track override' });
  assert.throws(() => validateTargets({ roles: { constructor: -10 } }, []), /Unknown target roles: constructor/);
  assert.throws(() => validateTargets({ roles: { leed: -10 } }, []), /Unknown target roles: leed/);
  assert.throws(() => validateTargets({ tracks: { Ghost: -10 } }, ['Lead']), /not found.*Ghost/);
  validateTargets({ roles: { hat: -20, lead: -16 }, tracks: { constructor: -20 } }, ['constructor']);
});

test('sparse parts are measured over the time they sound (regression)', () => {
  // 8 one-second "bars"; the part plays only in bar 5.
  const audio = tone(440, 8, 0.25, { from: 5, to: 6 });
  const blocks = blockStats(audio, sampleRate, { bands: false });
  const level = windowLevels(blocks, 0, 8);
  near(level.activeRmsDbfs, sine(0.25), 0.05, 'sounding RMS');
  near(level.rmsDbfs, sine(0.25) - 9.03, 0.05, 'whole-window RMS reads 9 dB low');
  near(level.soundingShare, 0.125, 0.01);
  // A steady part reads the same both ways.
  const steady = windowLevels(blockStats(tone(440, 4, 0.25), sampleRate, { bands: false }), 0, 4);
  near(steady.activeRmsDbfs, steady.rmsDbfs, 0.01);
});

test('block levels and the loudest window', () => {
  const blocks = blockStats(tone(440, 4, 0.5, { from: 2 }), sampleRate, { bands: false });
  assert.equal(blocks.length, 4);
  assert.deepEqual(loudestWindow(blocks, 2), { start: 2, length: 2 });
  const level = windowLevels(blocks, 2, 4);
  near(level.peakDbfs, -6.02, 0.02);
  near(level.rmsDbfs, -9.03, 0.02);
  assert.equal(windowLevels(blocks, 0, 2).rmsDbfs, null);
});

test('peak prediction: summed gain-scaled stems match the sum of the scaled signals', () => {
  const a = tone(100, 1, 0.4), b = tone(100, 1, 0.2, { channels: 1 });
  near(dsp.samplePeak(sumStems([a, b], [0.5, 2], 0.8)), 0.48, 1e-4);
  assert.equal(sumStems([a, b], [1, 1]).channels.length, 2, 'mono stems spread to both sides');
  near(dsp.samplePeak(sumStems([a, b], [1, 1])), 0.6, 1e-4);
});

test('correlation flags wide stems', () => {
  assert.equal(correlation(tone(300, 0.5)), 1);
  const wide = tone(300, 0.5);
  wide.channels[1] = wide.channels[1].map(v => -v);
  assert.equal(correlation(wide), -1);
});

test('masking: same band, same time and similar level is flagged; far apart in level or time is not', () => {
  const blockFrames = sampleRate;
  const stem = (track, role, hz, level, options) => ({ track, role, gainDb: 0, blocks: blockStats(tone(hz, 4, level, options), blockFrames) });
  const found = maskingReport([stem('Pad', 'texture', 1000, 0.2), stem('Lead', 'lead', 1200, 0.3), stem('Bass', 'bass', 80, 0.4)], { secondsPerBlock: 1 });
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].tracks, ['Pad', 'Lead']);
  assert.equal(found[0].band, 'mid');
  assert.equal(found[0].sharedBars, 4);
  assert.match(found[0].suggestion, /lower Pad by 2 to 3 dB/);
  assert.match(found[0].suggestion, /shorten its notes/);
  // 26 dB apart: not competing (regression for a noisy report).
  assert.equal(maskingReport([stem('Pad', 'texture', 1000, 0.01), stem('Lead', 'lead', 1200, 0.2)]).length, 0);
  // Never together.
  assert.equal(maskingReport([stem('A', 'harmony', 1000, 0.2, { to: 2 }), stem('B', 'lead', 1000, 0.2, { from: 2 })]).length, 0);
  // Capped.
  const many = Array.from({ length: 6 }, (_, k) => stem('H' + k, 'harmony', 1000 + k * 50, 0.2));
  assert.equal(maskingReport(many, { limit: 4 }).length, 4);
});

test('reference comparison: band balance is relative, so a quieter copy reads the same balance', () => {
  const bands = { sub: -40, bass: -20, lowMid: -20, mid: -30, highMid: -40, air: -50 };
  const quieter = Object.fromEntries(Object.entries(bands).map(([k, v]) => [k, v - 10]));
  assert.deepEqual(relativeBands(bands), relativeBands(quieter));
});

const keep = m => ({ integratedLufs: m.integratedLufs, peakDbfs: m.peakDbfs, rmsDbfs: m.rmsDbfs, crestDb: m.crestDb,
  stereoCorrelation: m.stereoCorrelation, centroidHz: m.centroidHz, bandsDbfs: m.bandsDbfs });
test('reference comparison on synthetic audio: a dark mix is told to brighten 2 to 6 kHz', () => {
  const mixOf = (highLevel, level = 1) => sumStems([tone(200, 3, 0.3 * level), tone(3500, 3, highLevel * level)], [1, 1]);
  const dark = keep(dsp.analyze(mixOf(0.03, 0.5))), reference = keep(dsp.analyze(mixOf(0.15)));
  const result = compareMeasurements(dark, reference);
  near(result.differences.bandsDb.highMid, -14, 1, 'high-mid difference');
  assert.ok(result.differences.loudnessLu < -4);
  assert.ok(result.differences.centroidRatio < 1);
  assert.match(result.suggestions[0], /dB less energy in 2 to 6 kHz than the reference: brighten the lead or raise the hats/);
  assert.ok(result.suggestions.some(s => /LU quieter/.test(s)));
  assert.equal(compareMeasurements(reference, reference).suggestions.length, 0);
});

test('reference comparison: silence is an error, not a match, and sections must fit the file (regression)', () => {
  const silent = keep(dsp.analyze({ sampleRate, frames: sampleRate, channels: [new Float32Array(sampleRate), new Float32Array(sampleRate)] }));
  const loud = keep(dsp.analyze(tone(440, 1, 0.5)));
  assert.throws(() => compareMeasurements(silent, loud), /audio is silent/);
  assert.throws(() => compareMeasurements(loud, silent, { label: 'Intro' }), /Intro: the reference is silent/);
  assert.throws(() => checkSpan('Outro', 8, 12, 10, 'reference'), /ends at 12 s but the reference is 10 s long/);
  assert.throws(() => checkSpan('Bad', 5, 5, 10, 'audio'), /must end after it starts/);
  checkSpan('Fine', 0, 10, 10, 'audio');
});
