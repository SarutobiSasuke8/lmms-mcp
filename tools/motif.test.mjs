// Unit tests for the motif operations. Run: npm test (no LMMS needed).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseKey, parseLine, parseDegrees, fromNotes, formatLine, readMotif, totalSteps, pitches, contour, inKey, degreeOf, fromDegree,
  fitKey, shift, repeat, sequence, fitToChord, chordTones, invert, retrograde, augment, diminish, varyRhythm, fragment,
  callAndResponse, cadence, fitRegister, fitLength, toNotes, developMotif, operationNames, rhythmStyleNames,
} from './motif.mjs';
import { expandPattern } from '../music.mjs';

const dMinor = parseKey('D minor');
const motif = parseLine('D5:2 F5:2 A5:4 G5:2 F5:2 E5:4');
const names = events => formatLine(events, dMinor);
const keys = ['C major', 'D minor', 'F# dorian', 'Bb major', 'Eb mixolydian', 'A phrygian', 'E lydian', 'C harmonic minor', 'G#m'];

test('keys parse with modes and choose sharp or flat spelling', () => {
  assert.deepEqual([dMinor.tonic, dMinor.mode, dMinor.flats], [2, 'minor', true]);
  assert.equal(parseKey('Dm').name, 'D minor');
  assert.equal(parseKey('A').mode, 'major');
  assert.equal(parseKey('F# dorian').flats, false);
  assert.equal(parseKey('C harmonic minor').scale[6], 11);
  assert.equal(parseKey('Bb').flats, true);
  assert.equal(parseKey('E').flats, false);
  assert.throws(() => parseKey('H minor'), /Unknown key/);
  assert.throws(() => parseKey('C blues'), /Unknown mode/);
});

test('degrees round trip and snap chromatic notes into the key', () => {
  for (const name of keys) {
    const key = parseKey(name);
    for (let index = 20; index < 50; index++) assert.equal(degreeOf(fromDegree(index, key), key), index, `${name} ${index}`);
  }
  assert.equal(inKey(73, dMinor), false); // C#5
  const { events, snapped } = fitKey(parseLine('D5:1 C#5:1 E5:1'), dMinor);
  assert.equal(snapped, 1);
  assert.ok(pitches(events).every(m => inKey(m, dMinor)));
});

test('motifs read from lines, raw notes and scale degrees', () => {
  assert.equal(names(motif), 'D5:2 F5:2 A5:4 G5:2 F5:2 E5:4');
  assert.equal(totalSteps(motif), 16);
  const fromRaw = fromNotes([{ tick: 0, length: 24, midi: 74 }, { tick: 48, length: 48, midi: 77 }]);
  assert.equal(names(fromRaw), 'D5:2 r:2 F5:4');
  assert.throws(() => fromNotes([{ tick: 0, length: 48, midi: 60 }, { tick: 24, length: 24, midi: 62 }]), /overlap/);
  assert.equal(names(parseDegrees("1:2 3:2 5:4 1':4 5,:4", dMinor)), 'D4:2 F4:2 A4:4 D5:4 A3:4');
  assert.equal(names(readMotif('1:2 r:2 2:4', dMinor)), 'D4:2 r:2 E4:4');
  assert.throws(() => parseLine('[D5,F5]:4'), /single notes/);
  assert.equal(names(parseLine('D5:2:100 r:2')), 'D5:2:100 r:2');
});

test('repeat, sequence and diatonic transposition stay in the key', () => {
  assert.equal(totalSteps(repeat(motif, 3)), 48);
  assert.equal(names(shift(motif, dMinor, 1)), 'E5:2 G5:2 Bb5:4 A5:2 G5:2 F5:4');
  const up = sequence(motif, dMinor, { step: 1, count: 3 });
  assert.equal(totalSteps(up), 48);
  assert.deepEqual(contour(up.slice(6, 12)), contour(motif));
  const down = sequence(motif, dMinor, { step: -1 });
  assert.equal(names(down.slice(6)), 'C5:2 E5:2 G5:4 F5:2 E5:2 D5:4');
  for (const name of keys) {
    const key = parseKey(name);
    const m = fitKey(motif, key).events;
    for (const s of [-3, -1, 1, 2, 4]) assert.ok(pitches(shift(m, key, s)).every(p => inKey(p, key)), `${name} shift ${s}`);
  }
});

test('fit to chord puts long and outer notes on chord tones', () => {
  const { events, steps } = fitToChord(motif, dMinor, 'Bb');
  const tones = chordTones('Bb');
  const notes = events.filter(e => e.midi !== null);
  const onChord = list => list.filter(e => e.midi !== null && tones.has(e.midi % 12)).reduce((sum, e) => sum + e.steps, 0);
  assert.ok(tones.has(notes[0].midi % 12), names(events));
  assert.ok(onChord(events) > onChord(motif), 'more of the line sits on chord tones than before');
  assert.ok(Math.abs(steps) <= 3);
  assert.equal(fitToChord(motif, dMinor, 'Dm').steps, 0, 'the motif already outlines Dm');
  assert.ok(pitches(events).every(m => inKey(m, dMinor)));
});

test('inversion mirrors intervals, retrograde reverses, augmentation and diminution scale time', () => {
  const inverted = invert(motif, dMinor);
  assert.equal(names(inverted), 'D5:2 Bb4:2 G4:4 A4:2 Bb4:2 C5:4');
  assert.deepEqual(contour(inverted), contour(motif).map(c => -c));
  assert.equal(names(retrograde(motif)), 'E5:4 F5:2 G5:2 A5:4 F5:2 D5:2');
  assert.equal(totalSteps(augment(motif)), 32);
  assert.equal(totalSteps(diminish(motif)), 8);
  assert.deepEqual(pitches(augment(motif)), pitches(motif));
});

test('rhythm variation keeps contour, pitches, rests and total length', () => {
  const withRest = parseLine('D5:2 F5:2 r:2 A5:4 G5:2 F5:2 E5:2');
  for (const style of [undefined, ...rhythmStyleNames]) {
    const varied = varyRhythm(withRest, style);
    assert.deepEqual(pitches(varied), pitches(withRest), String(style));
    assert.equal(totalSteps(varied), totalSteps(withRest), String(style));
    assert.equal(varied[2].midi, null, 'the rest stays in place');
    assert.ok(varied.every(e => e.steps >= 1 && Number.isInteger(e.steps)), String(style));
  }
  assert.notDeepEqual(varyRhythm(motif).map(e => e.steps), motif.map(e => e.steps), 'the default changes the rhythm');
});

test('fragments take the first or last cell', () => {
  assert.equal(names(fragment(motif, 'first')), 'D5:2 F5:2 A5:4');
  assert.equal(names(fragment(motif, 'last')), 'G5:2 F5:2 E5:4');
  assert.equal(names(fragment(parseLine('D5:4 r:4 A5:4 r:4'), 'first')), 'D5:4');
});

test('call and response: the call ends open, the answer ends on the tonic', () => {
  for (const name of keys) {
    const key = parseKey(name);
    const m = fitKey(parseLine('C5:2 E5:2 G5:4 F5:2 E5:2 C5:4'), key).events;
    const { call, answer, events } = callAndResponse(m, key);
    const lastOf = list => pitches(list).at(-1);
    assert.equal((lastOf(answer) - key.tonic + 120) % 12, 0, `${name} answer ends on the tonic`);
    assert.notEqual((lastOf(call) - key.tonic + 120) % 12, 0, `${name} call ends open`);
    assert.equal(totalSteps(events), 2 * totalSteps(m));
    assert.ok(pitches(events).every(p => inKey(p, key)));
  }
});

test('cadences land on the tonic or the fifth by step and hold the final note', () => {
  const motifWithRest = parseLine('D5:2 F5:2 A5:4 G5:2 F5:2 r:4');
  const ending = cadence(motifWithRest, dMinor);
  assert.equal(totalSteps(ending), totalSteps(motifWithRest));
  assert.notEqual(ending.at(-1).midi, null, 'trailing rest folded into the last note');
  assert.equal(ending.at(-1).midi % 12, dMinor.tonic);
  const p = pitches(ending);
  assert.equal(Math.abs(degreeOf(p.at(-1), dMinor) - degreeOf(p.at(-2), dMinor)), 1, 'approached by step');
  const half = cadence(motif, dMinor, 'half');
  assert.equal(pitches(half).at(-1) % 12, 9, 'A is the fifth of D minor');
});

test('register and length fitting', () => {
  const placed = fitRegister(motif, 60, 76);
  assert.ok(Math.min(...pitches(placed)) >= 60 && Math.max(...pitches(placed)) <= 76, names(placed));
  assert.ok(Math.min(...pitches(fitRegister(motif, 79, 90))) >= 79);
  assert.equal(totalSteps(fitLength(motif, 32)), 32);
  assert.equal(fitLength(motif, 32).at(-1).midi, null);
  assert.equal(names(fitLength(motif, 6)), 'D5:2 F5:2 A5:2');
  const notes = toNotes(motif, { offset: 192 });
  assert.equal(notes[0].tick, 192);
  assert.equal(notes[2].tick, 192 + 48);
});

test('develop_motif returns pasteable lines for every operation in every key', () => {
  for (const name of keys) {
    const key = parseKey(name);
    const result = developMotif('C5:2 E5:2 G5:4 F5:2 E5:2 D5:4', name);
    assert.equal(result.variations.length, operationNames.length);
    for (const v of result.variations) {
      const notes = expandPattern({ name: v.operation, bar: 0, bars: Math.max(1, Math.ceil(v.bars)), melody: { line: v.line, repeat: false } });
      assert.ok(notes.length > 0, v.operation);
      assert.ok(notes.every(n => inKey(n.midi, key)), `${name} ${v.operation}: ${v.line}`);
    }
  }
  const one = developMotif([{ tick: 0, length: 48, midi: 62 }, { tick: 48, length: 48, midi: 65 }], 'D minor', { operations: ['sequence_up'], count: 3 });
  assert.equal(one.variations[0].line, 'D4:4 F4:4 E4:4 G4:4 F4:4 A4:4');
  assert.equal(developMotif('D5:1 C#5:1', 'D minor').snappedToKey, 1);
  assert.throws(() => developMotif('r:4', 'D minor'), /at least one note/);
});

test('review extras: one-note fragments, even rhythm on fractional lengths, degree velocities, low MIDI numbers', () => {
  const one = parseLine('D5:4');
  assert.equal(names(fragment(one, 'last')), 'D5:4');
  assert.equal(developMotif('D5:4', 'D minor', { operations: ['fragment_last'] }).variations[0].line, 'D5:4');
  const fractional = parseLine('D5:1.5 F5:1.5 A5:1.5');
  const even = varyRhythm(fractional, 'even');
  assert.equal(totalSteps(even), 4.5);
  assert.deepEqual(pitches(even), pitches(fractional));
  assert.equal(names(readMotif('1:2:100 3:2', dMinor)), 'D4:2:100 F4:2');
  assert.throws(() => readMotif('1:2 C5:2', dMinor), /outside MIDI 12-119/);
  const over = cadence(parseLine('D5:2 F5:2 A5:4 G5:2 F5:2 E5:4'), dMinor, 'authentic', { chord: 'A' });
  assert.ok([9, 1, 4].includes(pitches(over).at(-1) % 12), 'over A major the ending lands on a tone of A');
});
