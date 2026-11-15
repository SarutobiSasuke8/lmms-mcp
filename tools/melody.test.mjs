// Unit tests for the phrase-based melody and accompaniment writers. Run: npm test (no LMMS needed).
import assert from 'node:assert/strict';
import test from 'node:test';
import { writeMelody, writeAccompaniment, chordPlan, melodyStyles, accompanimentStyles } from './melody.mjs';
import { parseKey } from './motif.mjs';

const chords = ['Dm', 'Bb', 'F', 'C', 'Dm', 'Gm', 'A7', 'Dm'];
const base = { key: 'D minor', chords, bars: 16 };
const mod = (a, n) => ((a % n) + n) % n;
const deviation = values => { const mean = values.reduce((a, b) => a + b, 0) / values.length; return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length); };
const main = notes => notes.filter(note => note.length > 12); // without grace notes

test('the same seed gives the same melody and another seed gives another', () => {
  assert.deepEqual(writeMelody({ ...base, seed: 5 }), writeMelody({ ...base, seed: 5 }));
  assert.notDeepEqual(writeMelody({ ...base, seed: 5 }).notes, writeMelody({ ...base, seed: 6 }).notes);
});

test('notes stay in range, in time and valid for every style and many seeds', () => {
  for (const style of melodyStyles) for (let seed = 1; seed <= 40; seed++) {
    const { notes } = writeMelody({ ...base, style, seed, low: 60, high: 84 });
    assert.ok(notes.length >= 16, `${style} ${seed}: too few notes`);
    for (const note of notes) {
      assert.ok(note.midi >= 60 && note.midi <= 84, `${style} ${seed}: ${note.midi} out of range`);
      assert.ok(note.tick >= 0 && note.tick + note.length <= 16 * 192, `${style} ${seed}: note outside the piece`);
      assert.ok(note.length >= 6 && note.velocity >= 1 && note.velocity <= 127 && Number.isInteger(note.tick));
    }
  }
});

test('every phrase ends with a breath and the piece ends on the tonic', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const { notes, plan } = writeMelody({ ...base, seed, ornament: false });
    for (const phrase of plan) {
      const end = (phrase.bar + phrase.bars) * 192;
      const inside = notes.filter(note => note.tick >= phrase.bar * 192 && note.tick < end);
      const last = inside.at(-1);
      assert.ok(end - (last.tick + last.length) >= 40, `seed ${seed}: phrase ${phrase.phrase} has no rest before the next one`);
    }
    assert.equal(mod(notes.at(-1).midi, 12), parseKey('D minor').tonic, `seed ${seed}: does not end on the tonic`);
  }
});

test('the idea returns: the opening rhythm is heard again later', () => {
  const { notes, motif } = writeMelody({ ...base, seed: 3, ornament: false, feel: { humanize: 0, layBack: 0 } });
  const onsets = bar => notes.filter(note => Math.floor(note.tick / 192) === bar).map(note => note.tick - bar * 192);
  assert.deepEqual(onsets(0), motif.rhythm.map(([onset]) => onset));
  assert.deepEqual(onsets(4), onsets(0));
  assert.deepEqual(onsets(12), onsets(0));
  assert.notDeepEqual(onsets(1), onsets(0), 'the reply bar has its own rhythm');
});

test('dynamics follow the phrase, and flat dynamics stay flat', () => {
  const shaped = main(writeMelody({ ...base, seed: 9 }).notes).map(note => note.velocity);
  const flat = main(writeMelody({ ...base, seed: 9, dynamics: 0 }).notes).map(note => note.velocity);
  assert.ok(deviation(shaped) > 5, `velocities barely move: ${deviation(shaped).toFixed(2)}`);
  assert.ok(deviation(flat) < 2.5);
});

test('one phrase is the climax and reaches the highest note', () => {
  let hits = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const { notes, plan } = writeMelody({ ...base, bars: 32, seed, low: 55, high: 88 });
    assert.equal(plan.filter(phrase => phrase.climax).length, 1);
    const top = Math.max(...notes.map(note => note.midi));
    const climax = plan.find(phrase => phrase.climax);
    const quiet = plan[0];
    const highest = phrase => Math.max(...notes.filter(note => note.tick >= phrase.bar * 192 && note.tick < (phrase.bar + phrase.bars) * 192).map(note => note.midi));
    if (highest(climax) === top) hits++;
    assert.ok(highest(climax) >= highest(quiet), `seed ${seed}: the climax sits below the opening`);
  }
  assert.ok(hits >= 20, `the climax phrase held the top note in only ${hits} of 30 seeds`);
});

test('strong beats land on chord tones', () => {
  const plan = chordPlan(chords, 16);
  let strong = 0, fitting = 0;
  for (let seed = 1; seed <= 20; seed++) for (const note of main(writeMelody({ ...base, seed, ornament: false, feel: { humanize: 0, layBack: 0 } }).notes)) {
    if (note.tick % 192 !== 0) continue;
    strong++;
    if (plan[Math.floor(note.tick / 192)][0].pcs.includes(mod(note.midi, 12))) fitting++;
  }
  assert.ok(fitting / strong > 0.9, `${fitting} of ${strong} downbeats are chord tones`);
});

test('a motif can be reused and split bars are read', () => {
  const first = writeMelody({ ...base, seed: 4 });
  const second = writeMelody({ ...base, seed: 99, motif: first.motif });
  assert.deepEqual(second.motif, first.motif);
  assert.equal(chordPlan('Dm | F C | A7', 4)[1].length, 2);
  assert.equal(chordPlan('Dm | F C | A7', 4)[3][0].symbol, 'Dm');
  assert.throws(() => chordPlan('Dm | H', 2), /Unknown chord/);
  assert.throws(() => writeMelody({ ...base, style: 'polka' }), /Unknown style/);
  assert.throws(() => writeMelody({ ...base, low: 60, high: 66 }), /octave/);
});

test('accompaniment follows the chords, stays low and holds the pedal', () => {
  const plan = chordPlan(chords, 16);
  for (const style of accompanimentStyles) {
    const { notes } = writeAccompaniment({ chords, bars: 16, style, low: 36, high: 67 });
    assert.ok(notes.length > 16, style);
    for (const note of notes) {
      assert.ok(note.midi >= 36 && note.midi <= 67 + 12, `${style}: ${note.midi}`);
      assert.ok(note.tick + note.length <= 16 * 192 && note.length >= 6);
    }
    if (['skank', 'bubble'].includes(style)) { // off-beat styles leave the beat to the bass and drums
      const chords = notes.filter(note => note.length >= 14 && note.tick < 15 * 192); // the last bar is a held chord
      assert.ok(chords.length >= 15 * 4 * 2 && chords.every(note => note.tick % 48 === 24), `${style}: chords must sit on the off-beats`);
      continue;
    }
    const downbeats = notes.filter(note => note.tick % 192 === 0);
    const lowest = bar => Math.min(...downbeats.filter(note => note.tick === bar * 192).map(note => note.midi));
    for (let bar = 0; bar < 16; bar++) assert.equal(mod(lowest(bar), 12), plan[bar][0].root, `${style}: bar ${bar} bass is not the root`);
  }
  const held = writeAccompaniment({ chords, bars: 4, pedal: true }).notes, dry = writeAccompaniment({ chords, bars: 4, pedal: false }).notes;
  assert.ok(held[0].length > dry[0].length * 3);
  const swell = writeAccompaniment({ chords, bars: 8, plan: [{ bar: 4, bars: 4, liftDegrees: 4 }] }).notes;
  const average = (from, to) => { const v = swell.filter(note => note.tick >= from * 192 && note.tick < to * 192).map(note => note.velocity); return v.reduce((a, b) => a + b, 0) / v.length; };
  assert.ok(average(4, 7) > average(0, 4) + 4);
});
