// Unit tests for the composer, progression, bass and drum generators. Run: npm test (no LMMS needed).
import assert from 'node:assert/strict';
import test from 'node:test';
import { composePiece, planForm, structureCheck, writeProgression, writeBass, writeDrums, romanToChord, tuneScore, styleNames, styles, bassStyles, drumStyles } from './compose.mjs';
import { chordPlan, writeMelody } from './melody.mjs';
import { parseKey } from './motif.mjs';
import { parseChord } from '../music.mjs';

const mod = (a, n) => ((a % n) + n) % n;

test('Roman numerals become chords in the key', () => {
  const c = parseKey('C major'), a = parseKey('A minor'), bb = parseKey('Bb major');
  assert.deepEqual(['I', 'ii', 'iii', 'IV', 'V', 'vi', 'V7', 'Imaj7', 'ii7'].map(r => romanToChord(r, c)), ['C', 'Dm', 'Em', 'F', 'G', 'Am', 'G7', 'Cmaj7', 'Dm7']);
  assert.deepEqual(['i', 'iv', 'V', 'VI', 'VII', 'III'].map(r => romanToChord(r, a)), ['Am', 'Dm', 'E', 'F', 'G', 'C']);
  assert.equal(romanToChord('IV', bb), 'Eb');
  assert.throws(() => romanToChord('X', c), /Unknown Roman/);
});

test('progressions fill the bars, parse, lead on with the dominant and end on the tonic', () => {
  for (const key of ['C major', 'A minor', 'F# minor', 'Eb major']) for (const bars of [4, 8, 16, 20, 32]) for (let seed = 1; seed <= 8; seed++) {
    const { chords, numerals, sections } = writeProgression({ key, bars, seed });
    assert.equal(chords.length, bars);
    for (const chord of chords) parseChord(chord);
    assert.equal(sections.reduce((sum, s) => sum + s.bars, 0), bars);
    assert.equal(parseChord(chords.at(-1)).root, parseKey(key).tonic, `${key} ${bars} ${seed}`);
    assert.equal(numerals.at(-2), 'V');
  }
  assert.deepEqual(writeProgression({ key: 'C', bars: 32, seed: 1 }).sections.map(s => s.name), ['A', 'A', 'B', 'A']);
});

test('bass plays the root on every chord change and stays low', () => {
  const chords = ['Dm', 'Bb', 'F C', 'A7', 'Dm', 'Gm', 'A7', 'Dm'], plan = chordPlan(chords, 8);
  for (const style of bassStyles) {
    const { notes } = writeBass({ chords, bars: 8, style, seed: 3 });
    assert.ok(notes.length >= 8, style);
    for (const note of notes) assert.ok(note.midi >= 27 && note.midi <= 62 && note.tick >= 0 && note.tick + note.length <= 8 * 192 && note.velocity >= 1 && note.velocity <= 127, `${style}: ${JSON.stringify(note)}`);
    for (let bar = 0; bar < 8; bar++) plan[bar].forEach((chord, part) => {
      const at = bar * 192 + part * 192 / plan[bar].length;
      const first = notes.find(note => note.tick === at);
      assert.ok(first, `${style}: nothing at the chord change in bar ${bar}`);
      assert.equal(mod(first.midi, 12), chord.root, `${style}: bar ${bar} does not start on the root`);
    });
  }
  assert.throws(() => writeBass({ chords, bars: 8, style: 'slap' }), /Unknown style/);
});

test('drums keep time, fill at phrase ends and stay quiet in the intro', () => {
  for (const style of drumStyles.filter(s => s !== 'none')) {
    const { parts } = writeDrums({ bars: 10, style, seed: 2, quietBars: 2 });
    for (const [name, notes] of Object.entries(parts)) for (const note of notes) assert.ok(note.midi === 69 && note.tick >= 0 && note.tick < 10 * 192 && note.velocity >= 1 && note.velocity <= 127, `${style} ${name}`);
    assert.ok(parts.hat.length >= 20, `${style}: no timekeeping`);
    assert.equal(parts.kick.filter(note => note.tick < 2 * 192).length, 0, `${style}: kick in the quiet bars`);
    assert.equal(parts.snare.filter(note => note.tick < 2 * 192).length, 0);
    const inBar = (part, bar) => parts[part].filter(note => Math.floor(note.tick / 192) === bar).length;
    assert.ok(inBar('snare', 5) > inBar('snare', 4), `${style}: no fill at the end of the phrase`);
    assert.ok(parts.crash.some(note => note.tick === 6 * 192), `${style}: no crash after the fill`);
    assert.equal(parts.crash.at(-1).tick, 9 * 192);
  }
  assert.deepEqual(writeDrums({ bars: 4, style: 'none' }).parts, { kick: [], snare: [], hat: [], crash: [] });
});

test('every style composes a valid piece of the asked length for many seeds', () => {
  for (const style of styleNames) for (let seed = 1; seed <= 12; seed++) {
    const piece = composePiece({ style, seconds: 60, seed });
    assert.ok(Math.abs(piece.lengthSeconds - 60) <= 240 / piece.bpm, `${style} ${seed}: ${piece.lengthSeconds} s`);
    assert.equal(piece.chords.length, piece.lengthBars);
    assert.equal(piece.sections.reduce((sum, s) => sum + s.bars, 0), piece.lengthBars);
    assert.ok(piece.tracks.find(t => t.role === 'lead') && piece.tracks.find(t => t.role === 'bass') && piece.tracks.find(t => t.role === 'harmony'));
    assert.equal(new Set(piece.tracks.map(t => t.name)).size, piece.tracks.length);
    for (const track of piece.tracks) for (const note of track.patterns[0].notes) {
      assert.ok(Number.isInteger(note.tick) && note.tick >= 0 && note.tick + note.length <= piece.lengthBars * 192, `${style} ${seed} ${track.name}: note outside the piece`);
      assert.ok(note.midi >= 12 && note.midi <= 119 && note.length >= 1 && note.velocity >= 1 && note.velocity <= 127);
    }
    const tonic = parseKey(piece.key).tonic, lead = piece.tracks.find(t => t.role === 'lead').patterns[0].notes;
    assert.equal(mod(lead.at(-1).midi, 12), tonic, `${style} ${seed}: lead does not end on the tonic`);
    assert.equal(parseChord(piece.chords.at(-1)).root, tonic);
    assert.ok(piece.tune.score >= 0 && piece.tune.score <= 100);
  }
});

test('the harmony stays under the melody register in every style', () => {
  for (const [name, style] of Object.entries(styles)) assert.ok(style.harmony.high <= style.melody.low + 1, `${name}: harmony reaches ${style.harmony.high}, melody starts at ${style.melody.low}`);
});

test('pieces are repeatable, seeds differ and keys vary', () => {
  assert.deepEqual(composePiece({ style: 'adventure', seed: 4 }), composePiece({ style: 'adventure', seed: 4 }));
  assert.notDeepEqual(composePiece({ style: 'adventure', seed: 4 }).tracks[0], composePiece({ style: 'adventure', seed: 5 }).tracks[0]);
  assert.ok(new Set(Array.from({ length: 12 }, (_, i) => composePiece({ style: 'chiptune', seed: i + 1 }).key)).size >= 3);
  assert.equal(composePiece({ style: 'ballad', key: 'E minor', bpm: 90, bars: 16, seed: 2 }).key, 'E minor');
  assert.equal(composePiece({ style: 'ballad', bars: 16 }).lengthBars, 16);
  assert.throws(() => composePiece({ style: 'polka' }), /Unknown style/);
  assert.throws(() => composePiece({ bars: 16, seconds: 30 }), /not both/);
  assert.equal(composePiece({ style: 'chiptune', voices: { lead: { voice: 'pluck', volume: 50 } } }).tracks[0].voice, 'pluck');
});

test('the tune score rewards a shaped melody over a flat or jumpy one', () => {
  const chords = ['C', 'G', 'Am', 'F'];
  const shaped = writeMelody({ key: 'C major', chords, bars: 16, seed: 3 });
  const flat = Array.from({ length: 64 }, (_, i) => ({ tick: i * 48, length: 44, midi: 72, velocity: 80 }));
  const jumpy = Array.from({ length: 64 }, (_, i) => ({ tick: i * 48, length: 44, midi: i % 2 ? 60 : 84, velocity: 80 }));
  const good = tuneScore(shaped.notes, shaped.plan).score;
  assert.ok(good > tuneScore(flat).score + 25, `shaped ${good}, flat ${tuneScore(flat).score}`);
  assert.ok(good > tuneScore(jumpy).score + 25, `shaped ${good}, jumpy ${tuneScore(jumpy).score}`);
  assert.equal(tuneScore([]).score, 0);
});

test('the form grows with the length and always fills the bars', () => {
  for (let bars = 8; bars <= 120; bars++) {
    const form = planForm(bars);
    assert.equal(form.reduce((sum, s) => sum + s.bars, 0), bars, `${bars} bars`);
    assert.equal(form.at(-1).kind, 'ending');
    assert.ok(form.at(-1).bars >= 1 && form.at(-1).bars <= 4);
    form.reduce((at, s) => { assert.equal(s.startBar, at); return at + s.bars; }, 0);
    for (const s of form.filter(s => !['intro', 'ending'].includes(s.kind))) assert.equal(s.bars % 4, 0, `${bars}: ${s.kind} is ${s.bars} bars`);
  }
  const kinds = bars => planForm(bars).map(s => s.kind);
  assert.deepEqual(kinds(12), ['theme', 'ending']);
  assert.deepEqual(kinds(16), ['intro', 'theme', 'return', 'ending']);
  assert.deepEqual(kinds(20), ['intro', 'theme', 'solo', 'return', 'ending']);
  assert.deepEqual(kinds(28), ['intro', 'theme', 'contrast', 'solo', 'return', 'ending']);
  assert.ok(kinds(44).includes('theme again'));
  assert.ok(kinds(60).includes('bridge'));
  assert.throws(() => planForm(6), /at least 8/);
});

test('the solo quotes the theme, then gets busier, and the return brings the theme back', () => {
  for (const style of styleNames) for (let seed = 1; seed <= 6; seed++) {
    const piece = composePiece({ style, seconds: 90, seed });
    const lead = piece.tracks.find(t => t.role === 'lead').patterns[0].notes;
    const of = kind => piece.sections.find(s => s.kind === kind);
    const inBars = (from, count) => lead.filter(n => n.tick >= from * 192 && n.tick < (from + count) * 192);
    // The line on a 32nd-note grid, top note at each onset, so timing feel and a second voice do not hide a restatement.
    const shape = (from, count) => { const at = new Map(); for (const n of inBars(from, count).filter(n => n.length > 12)) { const t = Math.round((n.tick - from * 192) / 6) * 6; at.set(t, Math.max(at.get(t) ?? 0, n.midi)); }
      return [...at].sort((p, q) => p[0] - q[0]).map(([t, m]) => `${t}:${m}`).join(' '); };
    const theme = of('theme'), solo = of('solo'), back = of('return');
    assert.ok(theme && solo && back, `${style} ${seed}: ${piece.form}`);
    assert.equal(shape(solo.startBar, 1), shape(theme.startBar, 1), `${style} ${seed}: the solo does not open with the theme`);
    const free = inBars(solo.startBar + 2, solo.bars - 2).length / (solo.bars - 2), told = inBars(theme.startBar, theme.bars).length / theme.bars;
    const top = notes => Math.max(...notes.map(n => n.midi));
    assert.ok(free > told || top(inBars(solo.startBar + 2, solo.bars - 2)) > top(inBars(theme.startBar, theme.bars)), `${style} ${seed}: the solo is neither busier (${free.toFixed(2)} against ${told.toFixed(2)} notes a bar) nor higher than the theme`);
    // The return restates the idea: the same rhythm and the same opening notes. Its continuation may differ, because it now cadences home.
    const rhythm = text => text.split(' ').map(item => item.split(':')[0]).join(' '), opening = text => text.split(' ').slice(0, 2).map(item => item.split(':')[1]).join(' ');
    const onsets = text => rhythm(text).split(' ').map(Number), again = onsets(shape(back.startBar, 1)), first = onsets(shape(theme.startBar, 1));
    assert.ok(again.length === first.length && again.every((t, i) => Math.abs(t - first[i]) <= 8), `${style} ${seed}: the return has another rhythm (${again} against ${first})`);
    assert.equal(opening(shape(back.startBar, 1)), opening(shape(theme.startBar, 1)), `${style} ${seed}: the return does not open like the theme`);
    const lastSoloNote = inBars(solo.startBar, solo.bars).at(-1);
    assert.ok((solo.startBar + solo.bars) * 192 - (lastSoloNote.tick + lastSoloNote.length) >= 30, `${style} ${seed}: no breath before the return`);
    assert.deepEqual(piece.structure.warnings, [], `${style} ${seed}`);
    const velocities = inBars(solo.startBar + 2, solo.bars - 2).map(n => n.velocity);
    assert.ok(Math.max(...velocities) <= 127 && velocities.reduce((a, b) => a + b, 0) / velocities.length < 105, `${style} ${seed}: the solo is too loud`);
  }
});

test('the band changes with the form', () => {
  const piece = composePiece({ style: 'adventure', seconds: 90, seed: 2 });
  const notesIn = (name, section) => (piece.tracks.find(t => t.name === name)?.patterns[0].notes ?? []).filter(n => n.tick >= section.startBar * 192 && n.tick < (section.startBar + section.bars) * 192);
  const of = kind => piece.sections.find(s => s.kind === kind);
  assert.equal(notesIn('Pad', of('theme')).length, 0, 'the pad waits for the contrast');
  assert.ok(notesIn('Pad', of('contrast')).length > 0 && notesIn('Pad', of('return')).length > 0);
  assert.equal(notesIn('Bass', of('intro')).length, 0);
  assert.equal(notesIn('Kick', of('intro')).length, 0);
  const build = of('solo').startBar + of('solo').bars - 1;
  const snareIn = bar => piece.tracks.find(t => t.name === 'Snare').patterns[0].notes.filter(n => Math.floor(n.tick / 192) === bar).length;
  assert.equal(snareIn(build), 16, 'a snare build leads into the return');
  assert.ok(piece.tracks.find(t => t.name === 'Crash').patterns[0].notes.some(n => n.tick === of('return').startBar * 192));
  const perBar = (name, section) => notesIn(name, section).length / section.bars;
  assert.ok(perBar('Harmony', of('return')) > perBar('Harmony', of('theme')), 'the return is fuller than the theme');
  assert.ok(perBar('Harmony', of('solo')) < perBar('Harmony', of('theme')), 'the band thins under the solo');
});

test('the structure check flags a piece whose sections do not differ', () => {
  const piece = composePiece({ style: 'ballad', seconds: 90, seed: 3 });
  const lead = piece.tracks[0].patterns[0].notes, theme = piece.sections.find(s => s.kind === 'theme'), solo = piece.sections.find(s => s.kind === 'solo');
  const copy = lead.filter(n => n.tick >= theme.startBar * 192 && n.tick < (theme.startBar + theme.bars) * 192).map(n => ({ ...n, tick: n.tick + (solo.startBar - theme.startBar) * 192 }));
  const flat = { ...piece, chords: piece.chords.map((c, i) => i >= solo.startBar && i < solo.startBar + solo.bars ? piece.chords[theme.startBar + i - solo.startBar] : c), sections: piece.sections.filter(s => s.kind !== 'contrast'),
    tracks: [{ ...piece.tracks[0], patterns: [{ ...piece.tracks[0].patterns[0], notes: [...lead.filter(n => n.tick < solo.startBar * 192 || n.tick >= (solo.startBar + solo.bars) * 192), ...copy] }] }] };
  assert.ok(structureCheck(flat).warnings.some(w => /sounds like/.test(w)));
  assert.ok(structureCheck({ ...piece, sections: piece.sections.filter(s => s.kind !== 'solo') }).warnings.some(w => /no solo/.test(w)));
});
