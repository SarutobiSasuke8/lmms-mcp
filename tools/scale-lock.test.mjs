import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import { z } from 'zod';
import { register, arpeggiate, arpeggioOrder, findChords, lockScale, noteProbability, parseRoot, scalePitchClasses, snapNote } from './scale-lock.mjs';

test('roots parse from names and numbers', () => {
  assert.equal(parseRoot('D'), 2);
  assert.equal(parseRoot('F#'), 6);
  assert.equal(parseRoot('Bb'), 10);
  assert.equal(parseRoot('c'), 0);
  assert.equal(parseRoot(7), 7);
  assert.throws(() => parseRoot('H'), /Unknown root/);
  assert.throws(() => scalePitchClasses('C', 'nope'), /Unknown scale/);
});

test('scale pitch classes are right for major, minor and dorian', () => {
  assert.deepEqual([...scalePitchClasses('C', 'major')].sort((a, b) => a - b), [0, 2, 4, 5, 7, 9, 11]);
  assert.deepEqual([...scalePitchClasses('A', 'minor')].sort((a, b) => a - b), [0, 2, 4, 5, 7, 9, 11]);
  assert.deepEqual([...scalePitchClasses('D', 'dorian')].sort((a, b) => a - b), [0, 2, 4, 5, 7, 9, 11]);
});

test('snapNote: nearest, down and up', () => {
  const cMajor = scalePitchClasses('C', 'major');
  assert.equal(snapNote(60, cMajor), 60);          // C stays
  assert.equal(snapNote(61, cMajor), 60);          // C#: tie between C and D goes down
  assert.equal(snapNote(63, cMajor), 62);          // Eb: tie between D and E goes down
  assert.equal(snapNote(66, cMajor, 'up'), 67);    // F# up to G
  assert.equal(snapNote(66, cMajor, 'down'), 65);  // F# down to F
  assert.equal(snapNote(70, cMajor, 'nearest'), 69); // Bb: A and B are equally close, down
});

test('lockScale puts every note in the scale', () => {
  const notes = Array.from({ length: 24 }, (_, i) => ({ tick: i * 48, midi: 48 + i }));
  for (const scale of ['major', 'natural-minor', 'minor-pentatonic', 'blues', 'dorian']) {
    for (const policy of ['nearest', 'down', 'up']) {
      const pcs = scalePitchClasses('E', scale);
      const { midis, report } = lockScale(notes, { root: 'E', scale, policy });
      assert.ok(midis.every(m => pcs.has(m % 12)), `${scale} ${policy}`);
      assert.equal(report.moved, report.outsideScale);
    }
  }
});

test('lockScale leaves notes in the scale alone and counts moves', () => {
  const notes = [{ tick: 0, midi: 60 }, { tick: 48, midi: 61 }, { tick: 96, midi: 64 }];
  const { midis, report } = lockScale(notes, { root: 'C', scale: 'major' });
  assert.deepEqual(midis, [60, 60, 64]);
  assert.equal(report.moved, 1);
  assert.deepEqual(report.byDistance, { '-1': 1 });
});

test('strong: only notes on beats or bars are snapped', () => {
  const notes = [{ tick: 0, midi: 61 }, { tick: 12, midi: 61 }, { tick: 48, midi: 61 }, { tick: 60, midi: 61 }];
  const beats = lockScale(notes, { root: 'C', scale: 'major', strong: 'beat', beatTicks: 48 });
  assert.deepEqual(beats.midis, [60, 61, 60, 61]);
  assert.equal(beats.report.leftOnWeakBeats, 2);
  const bars = lockScale(notes, { root: 'C', scale: 'major', strong: 'bar', ticksPerBar: 192 });
  assert.deepEqual(bars.midis, [60, 61, 61, 61]);
});

test('lockScale is deterministic', () => {
  const notes = Array.from({ length: 12 }, (_, i) => ({ tick: i * 12, midi: 55 + i }));
  assert.deepEqual(lockScale(notes, { root: 'G', scale: 'blues' }), lockScale(notes, { root: 'G', scale: 'blues' }));
});

test('arpeggio orders', () => {
  assert.deepEqual(arpeggioOrder('up', 3), [0, 1, 2]);
  assert.deepEqual(arpeggioOrder('down', 3), [2, 1, 0]);
  assert.deepEqual(arpeggioOrder('updown', 3), [0, 1, 2, 1]);
  assert.deepEqual(arpeggioOrder('updown', 2), [0, 1]);
  assert.deepEqual(arpeggioOrder('broken', 3), [0, 2, 1, 2]);
  assert.deepEqual(arpeggioOrder('broken', 4), [0, 3, 1, 3, 2, 3]);
  assert.deepEqual(arpeggioOrder('up', 1), [0]);
  assert.throws(() => arpeggioOrder('sideways', 3), /Unknown arpeggio/);
});

const chordNotes = () => [
  { tick: 0, length: 96, midi: 60, velocity: 80 }, { tick: 0, length: 96, midi: 64, velocity: 70 }, { tick: 0, length: 96, midi: 67, velocity: 75 },
  { tick: 96, length: 96, midi: 62, velocity: 80 }, // a lone melody note
  { tick: 192, length: 96, midi: 65, velocity: 80 }, { tick: 192, length: 96, midi: 69, velocity: 80 },
];

test('findChords needs minNotes notes on one tick', () => {
  assert.deepEqual(findChords(chordNotes()), [[0, 1, 2]]);
  assert.deepEqual(findChords(chordNotes(), 2), [[0, 1, 2], [4, 5]]);
});

test('arpeggiate up: steps follow the rate, notes stay inside the chord span and every pitch plays', () => {
  const { replaced, report } = arpeggiate(chordNotes(), { pattern: 'up', rate: 24, gate: 0.5 });
  assert.equal(report.chords, 1);
  const out = replaced[0].notes;
  assert.equal(out.length, 4); // 96 / 24
  assert.deepEqual(out.map(n => n.tick), [0, 24, 48, 72]);
  assert.deepEqual(out.map(n => n.midi), [60, 64, 67, 60]);
  assert.ok(out.every(n => n.length === 12));
  assert.ok(out.every(n => n.tick + n.length <= 96));
  assert.deepEqual(new Set(out.map(n => n.midi)), new Set([60, 64, 67]));
  assert.equal(out[1].velocity, 70); // each pitch keeps its own velocity
});

test('arpeggiate keeps the chord count and last step is trimmed to the span', () => {
  const { replaced } = arpeggiate([
    { tick: 0, length: 30, midi: 60, velocity: 90 }, { tick: 0, length: 30, midi: 64, velocity: 90 }, { tick: 0, length: 30, midi: 67, velocity: 90 },
  ], { pattern: 'down', rate: 12, gate: 1 });
  const out = replaced[0].notes;
  assert.deepEqual(out.map(n => n.midi), [67, 64, 60]);
  assert.equal(out[2].length, 6); // 24 + 6 = 30
});

test('arpeggiate random is seeded and plays every pitch when there is room', () => {
  const input = [
    ...[60, 64, 67, 71].map(midi => ({ tick: 0, length: 192, midi, velocity: 80 })),
  ];
  const a = arpeggiate(input, { pattern: 'random', rate: 12, seed: 7 }).replaced[0].notes.map(n => n.midi);
  const b = arpeggiate(input, { pattern: 'random', rate: 12, seed: 7 }).replaced[0].notes.map(n => n.midi);
  const c = arpeggiate(input, { pattern: 'random', rate: 12, seed: 8 }).replaced[0].notes.map(n => n.midi);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(a.length, 16);
  assert.deepEqual(new Set(a), new Set([60, 64, 67, 71]));
  for (let i = 4; i < a.length; i++) assert.notEqual(a[i], a[i - 1]);
});

test('arpeggiate octaves widen the climb, and a short chord is reported', () => {
  const input = [60, 64, 67].map(midi => ({ tick: 0, length: 192, midi, velocity: 80 }));
  const wide = arpeggiate(input, { pattern: 'up', rate: 12, octaves: 2 }).replaced[0].notes.map(n => n.midi);
  assert.deepEqual(wide.slice(0, 6), [60, 64, 67, 72, 76, 79]);
  const short = arpeggiate(input.map(n => ({ ...n, length: 12 })), { pattern: 'up', rate: 12 });
  assert.equal(short.report.shortChords, 1);
  assert.equal(short.replaced[0].notes.length, 1);
});

test('arpeggiate rejects a zero rate', () => {
  assert.throws(() => arpeggiate(chordNotes(), { rate: 0 }), /rate/);
});

test('noteProbability is deterministic and respects its limits', () => {
  const notes = Array.from({ length: 64 }, (_, i) => ({ tick: i * 48, length: 24, midi: 60, velocity: 80 }));
  const a = noteProbability(notes, { dropChance: 0.3, velocityVariation: 0.2, seed: 5 });
  const b = noteProbability(notes, { dropChance: 0.3, velocityVariation: 0.2, seed: 5 });
  const c = noteProbability(notes, { dropChance: 0.3, velocityVariation: 0.2, seed: 6 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.notes, c.notes);
  assert.ok(a.report.dropped > 5 && a.report.dropped < 40);
  assert.ok(a.notes.every(r => r.velocity >= 64 && r.velocity <= 96));
  // notes that start a bar (every 4th here) are protected by default
  assert.ok(notes.every((n, i) => n.tick % 192 !== 0 || a.notes[i].keep));
});

test('noteProbability with no drops and no variation changes nothing, and one note always survives', () => {
  const notes = [{ tick: 48, length: 24, midi: 60, velocity: 80 }, { tick: 96, length: 24, midi: 62, velocity: 80 }];
  const none = noteProbability(notes, { dropChance: 0, velocityVariation: 0 });
  assert.ok(none.notes.every(r => r.keep && r.velocity === 80));
  const all = noteProbability(notes, { dropChance: 0.9, velocityVariation: 0, seed: 3, protectDownbeats: false });
  assert.ok(all.report.kept >= 1);
});

test('noteProbability clamps velocity to the ceiling', () => {
  const notes = Array.from({ length: 20 }, (_, i) => ({ tick: i * 48 + 12, length: 24, midi: 60, velocity: 120 }));
  const { notes: r } = noteProbability(notes, { dropChance: 0, velocityVariation: 0.5, seed: 2, velocityCeiling: 127 });
  assert.ok(r.every(x => x.velocity <= 127 && x.velocity >= 1));
});

// The three edits, run against a small project document.
function harness() {
  const xml = '<p><track type="0" name="Piano"><pattern pos="0" len="384"><note pos="0" len="96" key="48" vol="80"/><note pos="0" len="96" key="52" vol="80"/><note pos="0" len="96" key="55" vol="80"/><note pos="96" len="48" key="49" vol="90"/></pattern></track>'
    + '<track type="0" name="Drums"><pattern pos="0" len="192"><note pos="0" len="48" key="49" vol="90"/></pattern></track></p>';
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const project = {
    tracks: d => [...d.getElementsByTagName('track')],
    children: (e, tag) => [...e.childNodes].filter(n => n.nodeName === tag),
    songInfo: () => ({ meter: [4, 4], ticksPerBar: 192 }),
    trackRole: t => (t.getAttribute('name') === 'Drums' ? 'drums' : 'harmony'),
  };
  const edits = {};
  register({ edit: (name, description, schema, apply) => { edits[name] = apply; }, z, project, moduleGuidance: [] });
  const notes = name => [...doc.getElementsByTagName('track')].find(t => t.getAttribute('name') === name).getElementsByTagName('note');
  return { doc, edits, notes };
}

test('scale_lock edit moves out-of-key notes and skips drum tracks', () => {
  const { doc, edits, notes } = harness();
  const result = edits.scale_lock(doc, { root: 'C', scale: 'major', policy: 'nearest', strong: 'all' });
  assert.equal(result.scaleLock.moved, 1);
  assert.equal(notes('Piano')[3].getAttribute('key'), '48');
  assert.equal(notes('Drums')[0].getAttribute('key'), '49'); // drums untouched
});

test('arpeggiate edit rewrites a chord and leaves the lone note and drums', () => {
  const { doc, edits, notes } = harness();
  const result = edits.arpeggiate(doc, { pattern: 'up', rate: 24, gate: 1, octaves: 1, minNotes: 3, seed: 1 });
  assert.equal(result.arpeggio.chords, 1);
  const piano = [...notes('Piano')];
  assert.equal(piano.length, 5); // 4 arpeggio steps + the lone note
  assert.deepEqual(piano.slice(0, 4).map(n => n.getAttribute('pos')), ['0', '24', '48', '72']);
  assert.deepEqual(piano.slice(0, 4).map(n => n.getAttribute('key')), ['48', '52', '55', '48']);
  assert.equal(notes('Drums').length, 1);
  assert.throws(() => edits.arpeggiate(harness().doc, { pattern: 'up', rate: 24, gate: 1, octaves: 1, minNotes: 5, seed: 1 }), /No chords/);
});

test('note_probability edit is repeatable for a seed', () => {
  const run = () => { const h = harness(); h.edits.note_probability(h.doc, { dropChance: 0.5, velocityVariation: 0.2, protectDownbeats: true, seed: 4, velocityCeiling: 127 }); return [...h.notes('Piano')].map(n => n.getAttribute('vol')).join(','); };
  assert.equal(run(), run());
});
