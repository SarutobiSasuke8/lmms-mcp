import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWarp, phraseArc, phraseSpans, seeded, shapePerformance } from './performance.mjs';

const bar = 144, beat = 48; // 3/4
const flat = { dynamics: 0, voicing: 0, accent: 0, humanize: 0, rubato: 0, finalRitardando: 0, melodyLead: 0 };
// Bass on 1, a chord on 2 and 3, a melody note above it on 2: four bars.
function piece(bars = 4) {
  const notes = [];
  for (let b = 0; b < bars; b++) {
    notes.push({ tick: b * bar, length: bar, midi: 43, velocity: 70 });
    for (const midi of [59, 62, 66]) notes.push({ tick: b * bar + beat, length: 2 * beat, midi, velocity: 70 });
    notes.push({ tick: b * bar + beat, length: beat, midi: 78, velocity: 70 });
  }
  return [{ name: 'Piano', notes }];
}

test('with every effect off, notes are unchanged', () => {
  const input = piece();
  const { tracks, report } = shapePerformance(input, { ticksPerBar: bar, beatTicks: beat, ...flat });
  assert.deepEqual(tracks, input);
  assert.equal(report.stretch, 1);
});

test('the phrase arc rises to a peak at 60% and falls', () => {
  assert.equal(phraseArc(0), 0);
  assert.ok(Math.abs(phraseArc(0.6) - 1) < 1e-9);
  assert.ok(phraseArc(0.3) < phraseArc(0.6) && phraseArc(0.9) < phraseArc(0.6));
});

test('phrase spans follow the score, then phraseBars', () => {
  assert.deepEqual(phraseSpans({ phrases: [1, 2], phraseBars: 4, ticksPerBar: bar, lengthTicks: 5 * bar }),
    [[0, bar], [bar, 3 * bar], [3 * bar, 5 * bar]]);
});

test('voicing lifts the melody above the chord and softens inner notes', () => {
  const { tracks } = shapePerformance(piece(), { ticksPerBar: bar, beatTicks: beat, ...flat, voicing: 0.2 });
  const chord = tracks[0].notes.filter(n => n.tick === beat);
  const velocity = midi => chord.find(n => n.midi === midi).velocity;
  assert.ok(velocity(78) > 70 && velocity(62) < 70 && velocity(66) < 70);
});

test('dynamics peak inside the phrase and stay under the ceiling', () => {
  const { tracks, report } = shapePerformance(piece(5), { ticksPerBar: bar, beatTicks: beat, ...flat, dynamics: 0.5, phrases: [5], velocityCeiling: 80 });
  const bass = tracks[0].notes.filter(n => n.midi === 43).map(n => n.velocity);
  assert.ok(bass[3] > bass[0] && bass[3] > bass[4]);
  assert.ok(report.velocity[1] <= 80);
});

test('ritardando stretches phrase ends and the final bars, and nothing goes backwards', () => {
  const { tracks, report } = shapePerformance(piece(8), { ticksPerBar: bar, beatTicks: beat, ...flat, rubato: 0.2, finalRitardando: 0.5 });
  assert.ok(report.stretch > 1.05);
  const starts = tracks[0].notes.filter(n => n.midi === 43).map(n => n.tick);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] > starts[i - 1]);
  const gaps = starts.slice(1).map((s, i) => s - starts[i]);
  assert.ok(gaps.at(-1) > gaps[0]);
});

test('the warp is monotonic and continues past the end', () => {
  const warp = buildWarp({ spans: [[0, 2 * bar]], beatTicks: beat, ticksPerBar: bar, lengthTicks: 2 * bar, rubato: 0.3, ritBeats: 2, finalRitardando: 0, finalBars: 1 });
  let previous = -1;
  for (let t = 0; t <= 2 * bar + 10; t += 0.5) {
    assert.ok(warp(t) >= previous);
    previous = warp(t);
  }
  assert.equal(warp(10), 10);
});

test('melody lead delays the rest of the chord by a tick', () => {
  const { tracks } = shapePerformance(piece(), { ticksPerBar: bar, beatTicks: beat, ...flat, melodyLead: 1 });
  const atBeat = tracks[0].notes.filter(n => n.tick === beat || n.tick === beat + 1);
  assert.equal(atBeat.find(n => n.midi === 78).tick, beat);
  assert.equal(atBeat.find(n => n.midi === 62).tick, beat + 1);
});

test('pedal holds notes to the bar line but stops at a re-strike', () => {
  const notes = [
    { tick: 0, length: 10, midi: 60, velocity: 70 }, { tick: 48, length: 10, midi: 60, velocity: 70 },
    { tick: 96, length: 10, midi: 64, velocity: 70 }, { tick: 144, length: 10, midi: 67, velocity: 70 },
  ];
  const { tracks, report } = shapePerformance([{ name: 'p', notes }], { ticksPerBar: bar, beatTicks: beat, ...flat, pedal: 'bar' });
  assert.deepEqual(tracks[0].notes.map(n => n.tick + n.length), [48, 144, 144, 288]);
  assert.equal(report.pedalledNotes, 4);
});

test('the same seed gives the same performance', () => {
  const a = shapePerformance(piece(), { ticksPerBar: bar, beatTicks: beat, seed: 7 }).tracks;
  const b = shapePerformance(piece(), { ticksPerBar: bar, beatTicks: beat, seed: 7 }).tracks;
  const c = shapePerformance(piece(), { ticksPerBar: bar, beatTicks: beat, seed: 8 }).tracks;
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.notEqual(seeded(1)(), seeded(2)());
});

test('velocityScale softens every note before the ceiling', () => {
  const { tracks } = shapePerformance(piece(), { ticksPerBar: bar, beatTicks: beat, ...flat, velocityScale: 0.5 });
  assert.ok(tracks[0].notes.every(n => n.velocity === 35));
});
