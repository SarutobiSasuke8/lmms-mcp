import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChord } from '../music.mjs';
import { parseKey } from './motif.mjs';
import { parseProgression, chordSpans } from './blueprints.mjs';
import { chordScale, phraseRhythm, writeSolo, describeSolo, cells } from './solo.mjs';

const spansFor = (text, key, bars) => chordSpans(parseProgression(text, parseKey(key)), bars, 1).map(s => ({ symbol: s.symbol, tick: s.tick, ticks: s.ticks }));
const solo = (options = {}) => writeSolo({ key: 'D minor', spans: spansFor('Dm Gm A7 Dm', 'D minor', options.bars ?? 8), bars: 8, low: 62, high: 84, ...options });
const seeds = Array.from({ length: 40 }, (_, i) => i + 1);

test('the scale follows the chord: the V7 of a minor key raises the seventh', () => {
  const key = parseKey('D minor');
  assert.deepEqual(chordScale(parseChord('Dm'), key), [0, 2, 4, 5, 7, 9, 10]);          // D natural minor
  assert.deepEqual(chordScale(parseChord('A7'), key), [1, 2, 4, 5, 7, 9, 10]);           // C becomes C#: D harmonic minor
  assert.deepEqual(chordScale(parseChord('Gm'), key), [0, 2, 4, 5, 7, 9, 10]);
  assert.deepEqual(chordScale(parseChord('E7'), parseKey('A minor')), [2, 4, 5, 8, 9, 11, 0].sort((a, b) => a - b)); // G becomes G#
  assert.deepEqual(chordScale(parseChord('D7'), parseKey('G dorian')).includes(6), true);  // F# over the IV7
  for (const s of [chordScale(parseChord('Bb'), key), chordScale(parseChord('C7'), parseKey('C major'))]) assert.equal(s.length, 7);
});

test('every note is in the chord scale, in range, in order and inside the solo', () => {
  const key = parseKey('D minor');
  for (const seed of seeds) {
    const { notes } = solo({ seed });
    const spans = spansFor('Dm Gm A7 Dm', 'D minor', 8);
    let previousEnd = 0;
    for (const n of notes) {
      assert.ok(n.midi >= 62 && n.midi <= 84, `seed ${seed} range ${n.midi}`);
      assert.ok(n.tick >= previousEnd - 0 && n.tick + n.length <= 8 * 192, `seed ${seed} timing`);
      previousEnd = n.tick + n.length;
      // A pushed note may already belong to the next chord, so accept either scale.
      const here = spans.find(s => n.tick >= s.tick && n.tick < s.tick + s.ticks), after = spans.find(s => n.tick + 24 >= s.tick && n.tick + 24 < s.tick + s.ticks) ?? here;
      const ok = [here, after].some(s => chordScale(parseChord(s.symbol), key).includes(n.midi % 12));
      assert.ok(ok, `seed ${seed}: ${n.midi} at tick ${n.tick} is outside the scale of ${here.symbol}`);
      assert.ok(n.velocity >= 35 && n.velocity <= 127);
    }
  }
});

test('a C natural is never held over A7: the leading tone is used there', () => {
  for (const seed of seeds) {
    const { notes } = solo({ seed });
    for (const n of notes) {
      const bar = Math.floor(n.tick / 192) % 4;
      if (bar === 2 && n.tick % 192 < 150) assert.notEqual(n.midi % 12, 0, `seed ${seed}: C natural over A7 at tick ${n.tick}`);
    }
  }
});

test('the pace changes: mixed note lengths, held notes after runs, and no long stretch at one speed', () => {
  for (const seed of seeds) {
    const { notes } = solo({ seed, energy: 0.7 });
    const d = describeSolo(notes, 8);
    assert.ok(d.differentLengths >= 3, `seed ${seed}: only ${d.differentLengths} note lengths`);
    assert.ok(d.longestRunAtOnePace <= 9, `seed ${seed}: ${d.longestRunAtOnePace} notes at one pace`);
    assert.ok(d.heldNotes >= 1 && d.shortNotes >= 2, `seed ${seed}: ${JSON.stringify(d)}`);
  }
});

test('every phrase ends with room to breathe', () => {
  for (const seed of seeds) {
    const { notes } = solo({ seed });
    for (let phrase = 0; phrase < 4; phrase++) {
      const end = (phrase + 1) * 384, inPhrase = notes.filter(n => n.tick >= phrase * 384 && n.tick < end);
      if (!inPhrase.length) continue;
      const last = inPhrase.at(-1);
      if (phrase < 3) assert.ok(end - (last.tick + last.length) >= 36, `seed ${seed} phrase ${phrase + 1}: no breath`);
    }
    assert.ok(describeSolo(notes, 8).silentShare >= 0.15, `seed ${seed}`);
  }
});

test('notes mostly land on chord tones when they are held or on the beat', () => {
  let landed = 0, counted = 0;
  const spans = spansFor('Dm Gm A7 Dm', 'D minor', 8);
  for (const seed of seeds) {
    for (const n of solo({ seed }).notes) {
      if (n.length < 30) continue;
      const tones = s => parseChord(s.symbol).intervals.map(i => (parseChord(s.symbol).root + i) % 12);
      const here = spans.find(s => n.tick >= s.tick && n.tick < s.tick + s.ticks), after = spans.find(s => n.tick + 24 >= s.tick && n.tick + 24 < s.tick + s.ticks) ?? here;
      counted++;
      if (tones(here).includes(n.midi % 12) || tones(after).includes(n.midi % 12)) landed++;
    }
  }
  assert.ok(landed / counted > 0.9, `${landed}/${counted}`);
});

test('there is one high point, energy changes density, and the solo ends on the root', () => {
  for (const seed of seeds) {
    const { notes, phrases } = solo({ seed });
    const top = Math.max(...notes.map(n => n.midi));
    assert.equal(notes.filter(n => n.midi === top).length, 1, `seed ${seed}`);
    assert.ok(top >= 79, `seed ${seed}: peak only ${top}`);
    assert.equal(notes.at(-1).midi % 12, 2, `seed ${seed}: ends on ${notes.at(-1).midi}`);
    assert.ok(notes.at(-1).length >= 60);
    assert.equal(phrases.length, 4);
  }
  const count = energy => seeds.reduce((sum, seed) => sum + solo({ seed, energy, arc: 'flat', climax: false }).notes.length, 0);
  assert.ok(count(0.9) > count(0.3) * 1.25, `${count(0.3)} ${count(0.9)}`);
});

test('dynamics move, leaps are bounded, and the same seed gives the same solo', () => {
  for (const seed of seeds) {
    const { notes } = solo({ seed });
    const d = describeSolo(notes, 8);
    assert.ok(d.loudest - d.quietest >= 12, `seed ${seed}: flat dynamics`);
    for (let i = 1; i < notes.length; i++) {
      if (notes[i].tick - (notes[i - 1].tick + notes[i - 1].length) <= 48) assert.ok(Math.abs(notes[i].midi - notes[i - 1].midi) <= 14, `seed ${seed}: leap`);
    }
  }
  assert.deepEqual(solo({ seed: 5 }), solo({ seed: 5 }));
  assert.notDeepEqual(solo({ seed: 5 }).notes, solo({ seed: 6 }).notes);
});

test('rhythm cells fill two beats and phrases fill their bars exactly', () => {
  for (const group of Object.values(cells)) for (const cell of group) assert.equal(cell.reduce((sum, x) => sum + (x === 'T' ? 4 : Math.abs(x)), 0), 8, JSON.stringify(cell));
  let state = 3;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  for (const steps of [16, 32, 64]) for (const energy of [0.2, 0.6, 1]) {
    const rhythm = phraseRhythm(steps, energy, next);
    assert.equal(rhythm.reduce((sum, x) => sum + (x === 'T' ? 4 : Math.abs(x)), 0), steps);
    assert.ok(rhythm.at(-1) < 0, 'ends with a rest');
  }
  assert.throws(() => writeSolo({ key: 'D minor', spans: [], bars: 4 }), /chords/);
  assert.throws(() => solo({ low: 70, high: 75 }), /octave/);
});
