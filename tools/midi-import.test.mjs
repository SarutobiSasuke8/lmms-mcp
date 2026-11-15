import test from 'node:test';
import assert from 'node:assert/strict';
import midiPackage from '@tonejs/midi';
import { applyForm, bakePedal, controllerAt, midiToTracks, pedalSpans } from './midi-import.mjs';

const { Midi } = midiPackage;

// A small two-hand file in 3/4 at 60 BPM, 480 ticks per beat (the @tonejs/midi default).
function waltz() {
  const midi = new Midi();
  midi.header.setTempo(60);
  midi.header.timeSignatures.push({ ticks: 0, timeSignature: [3, 4] });
  midi.header.update();
  const right = midi.addTrack();
  right.name = 'treble:';
  right.addNote({ midi: 78, ticks: 480, durationTicks: 480, velocity: 0.8 });
  right.addNote({ midi: 81, ticks: 960, durationTicks: 480, velocity: 0.8 });
  right.addNote({ midi: 79, ticks: 1440 * 2, durationTicks: 1440, velocity: 0.8 });
  const left = midi.addTrack();
  left.name = 'bass:';
  for (let bar = 0; bar < 3; bar++) left.addNote({ midi: 43, ticks: bar * 1440, durationTicks: 1440, velocity: 0.7 });
  return new Midi(midi.toArray());
}

test('converts ticks to 48 per beat and keeps the metre and tempo', () => {
  const result = midiToTracks(waltz());
  assert.equal(result.bpm, 60);
  assert.deepEqual(result.meter, [3, 4]);
  assert.equal(result.ticksPerBar, 144);
  assert.deepEqual(result.tracks.map(t => t.name), ['treble', 'bass']);
  assert.deepEqual(result.tracks[0].notes[0], { tick: 48, length: 48, midi: 78, velocity: 80 });
  assert.equal(result.tracks[1].notes[2].tick, 288);
  assert.equal(result.lengthBars, 3);
});

test('merges hands into one named track in time order', () => {
  const result = midiToTracks(waltz(), { merge: 'Piano' });
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].name, 'Piano');
  const ticks = result.tracks[0].notes.map(n => n.tick);
  assert.deepEqual(ticks, [...ticks].sort((a, b) => a - b));
  assert.equal(result.tracks[0].notes.length, 6);
});

test('selects tracks by cleaned name or index and explains a miss', () => {
  assert.equal(midiToTracks(waltz(), { tracks: ['bass'] }).tracks[0].notes.length, 3);
  assert.equal(midiToTracks(waltz(), { tracks: [0] }).tracks[0].name, 'treble');
  assert.throws(() => midiToTracks(waltz(), { tracks: ['alto'] }), /No MIDI track with notes matches "alto"/);
});

test('form unfolds bars in a new order', () => {
  const notes = [{ start: 0, end: 10, midi: 60 }, { start: 100, end: 110, midi: 62 }, { start: 200, end: 210, midi: 64 }];
  const out = applyForm(notes, [{ from: 1, to: 2 }, { from: 1, to: 1 }, { from: 3, to: 3 }], 100);
  assert.deepEqual(out.map(n => [n.start, n.midi]), [[0, 60], [100, 62], [200, 60], [300, 64]]);
  assert.throws(() => applyForm(notes, [{ from: 2, to: 1 }], 100), /runs backwards/);
});

test('form through midiToTracks plays bars 1-2 twice', () => {
  const result = midiToTracks(waltz(), { form: [{ from: 1, to: 2 }, { from: 1, to: 2 }] });
  assert.equal(result.tracks[1].notes.length, 4);
  assert.equal(result.tracks[1].notes[2].tick, 288);
  assert.equal(result.lengthBars, 4);
});

test('pedal holds a note to the pedal release but not past a re-strike', () => {
  const spans = pedalSpans([{ ticks: 0, value: 1 }, { ticks: 400, value: 0 }], 1000);
  assert.deepEqual(spans, [[0, 400]]);
  const notes = bakePedal([
    { start: 0, end: 50, midi: 60 }, { start: 100, end: 150, midi: 62 }, { start: 200, end: 260, midi: 60 }, { start: 500, end: 550, midi: 64 },
  ], spans);
  assert.deepEqual(notes.map(n => n.end), [200, 400, 400, 550]);
  assert.deepEqual(pedalSpans([{ ticks: 10, value: 1 }], 90), [[10, 90]]);
});

test('channel volume folds into velocity relative to the loudest setting', () => {
  const midi = waltz();
  midi.tracks[1].addCC({ number: 7, ticks: 0, value: 1 });
  midi.tracks[1].addCC({ number: 7, ticks: 1440, value: 0.5 });
  const folded = midiToTracks(new Midi(midi.toArray()), { tracks: ['bass'] }).tracks[0].notes.map(n => n.velocity);
  // MIDI stores velocity 0.7 as 88/127 and CC 0.5 as 63/127.
  assert.deepEqual(folded, [69, 34, 34]);
  const raw = midiToTracks(new Midi(midi.toArray()), { tracks: ['bass'], volumeChanges: 'ignore' }).tracks[0].notes.map(n => n.velocity);
  assert.deepEqual(raw, [69, 69, 69]);
  assert.equal(controllerAt([{ ticks: 5, value: 0.2 }], 0, 1), 1);
});

test('timing "seconds" keeps the real timing of a tempo change', () => {
  const midi = new Midi();
  midi.header.setTempo(60);
  midi.header.tempos.push({ ticks: 960, bpm: 120 });
  midi.header.update();
  const track = midi.addTrack();
  track.addNote({ midi: 60, ticks: 0, durationTicks: 480 });
  track.addNote({ midi: 62, ticks: 1440, durationTicks: 480 });
  const parsed = new Midi(midi.toArray());
  const seconds = midiToTracks(parsed, { timing: 'seconds', bpm: 60 });
  // Two beats at 60 BPM, then one beat at 120 BPM: 2.5 seconds, 120 ticks at 60 BPM.
  assert.equal(seconds.tracks[0].notes[1].tick, 120);
  const score = midiToTracks(parsed);
  assert.equal(score.tracks[0].notes[1].tick, 144);
  assert.match(score.warnings[0], /2 tempo events/);
  assert.throws(() => midiToTracks(parsed, { timing: 'seconds', form: [{ from: 1, to: 1 }] }), /form needs timing "score"/);
});

test('drops notes outside the LMMS range and reports them', () => {
  const midi = waltz();
  midi.tracks[0].addNote({ midi: 5, ticks: 0, durationTicks: 100 });
  const result = midiToTracks(new Midi(midi.toArray()));
  assert.equal(result.report.droppedNotes, 1);
});
