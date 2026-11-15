import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKey } from './motif.mjs';
import { parseProgression, chordSpans } from './blueprints.mjs';
import {
  shippedPhrases, soundDefaults, parseTone, chordInterval, phraseEvents, phraseVoices, validatePhrase, renderPitched, progressionIn,
  capturePhrase, readStore, allPhrases, findPhrase, summarise, rankPhrases, buildTracks, layoutSections,
} from './phrases.mjs';
import { parseChord } from '../music.mjs';

const spansFor = (text, key, bars) => chordSpans(parseProgression(text, parseKey(key)), bars, 1);
const byId = id => shippedPhrases.find(p => p.id === id);
const lookup = id => findPhrase(readStore(null), id);

test('every shipped phrase is valid and has a unique id', () => {
  const ids = new Set();
  for (const phrase of shippedPhrases) {
    validatePhrase(phrase);
    assert.ok(!ids.has(phrase.id), `duplicate id ${phrase.id}`);
    ids.add(phrase.id);
    assert.ok(phrase.description, `${phrase.id} needs a description`);
  }
  assert.ok(ids.size >= 50);
});

test('every percussion sound a shipped phrase uses has a stock stand-in', () => {
  for (const phrase of shippedPhrases.filter(p => p.kind === 'rhythm')) {
    for (const voice of phraseVoices(phrase)) assert.ok(soundDefaults[voice.sound]?.stock, `${phrase.id}: ${voice.sound}`);
  }
});

test('progressions resolve in major and minor keys', () => {
  assert.equal(progressionIn(byId('prog-andalusian'), 'A minor'), 'Am G F E');
  assert.equal(progressionIn(byId('prog-phrygian-vamp'), 'E phrygian'), 'E F G F');
  assert.equal(progressionIn(byId('prog-dorian-vamp'), 'A dorian'), 'Am7 D7');
  for (const phrase of shippedPhrases.filter(p => p.kind === 'progression')) {
    for (const key of ['C major', 'F# minor', 'Bb dorian']) for (const symbol of progressionIn(phrase, key).split(' ')) parseChord(symbol.split(':')[0]);
  }
});

test('every pitched phrase renders in range in three keys, on the grid and inside the pattern', () => {
  for (const phrase of shippedPhrases.filter(p => p.kind === 'harmonic')) {
    for (const [key, text] of [['A minor', 'Am G F E7'], ['Eb major', 'Eb Cm7 Ab Bb7'], ['F# minor', 'F#m Bm C#7 F#m']]) {
      const notes = renderPitched(phrase, { spans: spansFor(text, key, 4), bars: 4, key: parseKey(key), octave: phrase.role === 'bass' ? 2 : 4 });
      assert.ok(notes.length >= 4, `${phrase.id} in ${key}`);
      for (const n of notes) {
        assert.ok(n.midi >= 24 && n.midi <= 108 && n.tick >= 0 && n.tick + n.length <= 768 && n.velocity >= 1 && n.velocity <= 200, `${phrase.id} ${JSON.stringify(n)}`);
      }
    }
  }
});

test('tones follow the chord: thirds change with the quality and a triad seventh becomes the octave', () => {
  assert.deepEqual(parseTone("5,,"), { name: '5', octave: -2 });
  assert.equal(chordInterval(parseChord('Am'), '3'), 3);
  assert.equal(chordInterval(parseChord('A'), '3'), 4);
  assert.equal(chordInterval(parseChord('A7'), '7'), 10);
  assert.equal(chordInterval(parseChord('A'), '7'), 12);
  assert.equal(chordInterval(parseChord('Asus4'), '3'), 5);
  assert.throws(() => parseTone('x'));
});

test('a montuno keeps its rhythm and arrives early on the next chord', () => {
  const notes = renderPitched(byId('piano-montuno-fifth'), { spans: spansFor('Am E7', 'A minor', 2), bars: 2, key: parseKey('A minor'), octave: 4 });
  assert.deepEqual([...new Set(notes.filter(n => n.tick < 192).map(n => n.tick / 12))], [0, 2, 3, 5, 7, 9, 11, 13, 15]);
  // Step 0 is the fifth of Am in octaves: E.
  assert.deepEqual(notes.filter(n => n.tick === 0).map(n => n.midi % 12), [4, 4]);
  // Step 15 of bar 1 already plays the fifth of E7: B.
  assert.deepEqual(notes.filter(n => n.tick === 180).map(n => n.midi % 12), [11, 11]);
  // The last hit of the loop anticipates the first chord again.
  assert.deepEqual(notes.filter(n => n.tick === 372).map(n => n.midi % 12), [4, 4]);
});

test('the tumbao bass rests on beat 1 and plays the next root on beat 4', () => {
  const notes = renderPitched(byId('bass-tumbao'), { spans: spansFor('Am Dm', 'A minor', 2), bars: 2, key: parseKey('A minor'), octave: 2, bassRoot: true });
  assert.deepEqual(notes.map(n => [n.tick, n.midi % 12]), [[72, 4], [144, 2], [264, 9], [336, 9]]);
  assert.ok(notes.every(n => n.midi >= 33 && n.midi <= 57));
});

test('roots stay within an octave of each other between chords', () => {
  const notes = renderPitched(byId('piano-chords-held'), { spans: spansFor('C G Am F', 'C major', 4), bars: 4, key: parseKey('C major'), octave: 4 });
  const lows = [0, 192, 384, 576].map(tick => Math.min(...notes.filter(n => n.tick === tick).map(n => n.midi)));
  for (let i = 1; i < lows.length; i++) assert.ok(Math.abs(lows[i] - lows[i - 1]) < 12, `leap ${lows}`);
});

test('scale-degree hooks follow the key', () => {
  const minor = renderPitched(byId('hook-chant'), { spans: spansFor('Am', 'A minor', 1), bars: 1, key: parseKey('A minor'), octave: 5 });
  const major = renderPitched(byId('hook-chant'), { spans: spansFor('A', 'A major', 1), bars: 1, key: parseKey('A major'), octave: 5 });
  assert.deepEqual(minor.map(n => n.midi % 12), [4, 4, 4, 0, 0, 9]);
  assert.deepEqual(major.map(n => n.midi % 12), [4, 4, 4, 1, 1, 9]);
});

test('stretch 2 halves the speed, and variation is seeded', () => {
  const args = { spans: spansFor('Am G', 'A minor', 2), bars: 2, key: parseKey('A minor'), octave: 4 };
  const slow = renderPitched(byId('piano-stabs-offbeat'), { ...args, stretch: 2 });
  assert.deepEqual([...new Set(slow.map(n => n.tick))], [48, 144, 240, 336]);
  const a = renderPitched(byId('piano-stabs-offbeat'), { ...args, variation: 1, seed: 7 }), b = renderPitched(byId('piano-stabs-offbeat'), { ...args, variation: 1, seed: 7 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.map(n => n.velocity), renderPitched(byId('piano-stabs-offbeat'), args).map(n => n.velocity));
});

test('a captured figure plays back the same and transposes with the chords', () => {
  const spans = spansFor('Dm Bb', 'D minor', 2);
  const written = [{ tick: 0, length: 24, midi: 62, velocity: 100 }, { tick: 36, length: 12, midi: 65, velocity: 80 }, { tick: 36, length: 12, midi: 69, velocity: 80 },
    { tick: 96, length: 48, midi: 64, velocity: 90 }, { tick: 192, length: 24, midi: 58, velocity: 100 }, { tick: 228, length: 12, midi: 74, velocity: 84 }];
  const captured = capturePhrase(written, { spans, bars: 2 });
  const phrase = validatePhrase({ id: 'my-figure', kind: 'harmonic', role: 'harmony', name: 'Mine', ...captured });
  assert.match(captured.line, /~2/); // E over Dm is not a chord tone
  const again = renderPitched(phrase, { spans, bars: 2, key: parseKey('D minor'), octave: captured.octave });
  assert.deepEqual(again.map(n => [n.tick, n.midi, n.velocity]), written.map(n => [n.tick, n.midi, n.velocity]));
  const moved = renderPitched(phrase, { spans: spansFor('Em C', 'E minor', 2), bars: 2, key: parseKey('E minor'), octave: captured.octave });
  assert.deepEqual(moved.map(n => n.midi), written.map(n => n.midi + 2));
  assert.throws(() => capturePhrase([{ tick: 7, length: 12, midi: 60, velocity: 90 }], { spans, bars: 2 }), /grid/);
});

test('bad phrases are refused with a reason', () => {
  assert.throws(() => validatePhrase({ id: 'X', kind: 'harmonic', name: 'x', role: 'bass', line: '0=r:1' }), /id/);
  assert.throws(() => validatePhrase({ id: 'ok-id', kind: 'harmonic', name: 'x', role: 'bass', line: '99=r:1' }), /step 99/);
  assert.throws(() => validatePhrase({ id: 'ok-id', kind: 'harmonic', name: 'x', role: 'bass', line: '0=q:1' }), /tone/);
  assert.throws(() => validatePhrase({ id: 'ok-id', kind: 'rhythm', name: 'x', role: 'drums', voices: { kick: 'x---' } }), /16/);
  assert.throws(() => validatePhrase({ id: 'ok-id', kind: 'rhythm', name: 'x', role: 'drums', voices: { kick: '----------------' } }), /never plays/);
  assert.throws(() => validatePhrase({ id: 'ok-id', kind: 'progression', name: 'x', roman: 'i Zz' }), /chord/);
  assert.equal(phraseEvents({ seq: 'r - 5 -', rate: 2, bars: 1 }).length, 4);
});

test('the store keeps user phrases apart from shipped ones and ranks by rating then freshness', () => {
  const store = readStore(JSON.stringify({ version: 1, phrases: [{ id: 'mine', kind: 'harmonic', role: 'bass', name: 'Mine', line: '0=r:4' }, { id: 'bass-tumbao', kind: 'harmonic', name: 'Clash' }],
    ratings: { 'bass-tumbao': { rating: 5 }, 'bass-house-offbeat': { rating: 1 } }, uses: { 'bass-octave-bounce': [{ project: 'a.mmp', at: '2026-11-14' }] } }));
  const all = allPhrases(store);
  assert.equal(all.filter(p => p.id === 'bass-tumbao').length, 1);
  assert.equal(findPhrase(store, 'mine').source, 'yours');
  const ranked = rankPhrases(all.filter(p => p.role === 'bass').map(p => summarise(p, store)));
  assert.equal(ranked[0].id, 'bass-tumbao');
  assert.equal(ranked.at(-1).id, 'bass-house-offbeat');
  assert.ok(ranked.findIndex(r => r.id === 'bass-octave-bounce') > ranked.findIndex(r => r.id === 'bass-latin-house'));
  assert.throws(() => readStore('{bad'), /not valid JSON/);
  assert.throws(() => readStore('{"version":2}'), /version 1/);
  assert.throws(() => findPhrase(store, 'nope'), /Unknown phrase/);
});

test('buildTracks lays parts into sections, one track per drum sound, sharing tracks by name', () => {
  const key = parseKey('A minor');
  const sections = layoutSections([{ name: 'intro', bars: 4 }, { name: 'main', bars: 8, progression: 'prog-andalusian' }], { key, progression: 'Am Dm', lookup });
  assert.deepEqual(sections.map(s => [s.startBar, s.bars]), [[0, 4], [4, 8]]);
  assert.equal(sections[1].chords, 'Am G F E Am G F E');
  const sounds = { kick: { factorySample: 'drums/kick01.ogg', midi: 69, volume: 78, length: 48 }, clap: { factorySample: 'drums/clap01.ogg', midi: 69, volume: 52, length: 48 },
    'hat-open': { factorySample: 'drums/hihat_opened01.ogg', midi: 69, volume: 34, length: 36 } };
  const { tracks, used } = buildTracks({ key, sounds, lookup, sections, parts: [
    { phrase: 'kit-kick-only', sections: ['intro'] }, { phrase: 'kit-house-basic', sections: ['main'], gain: 0.5 },
    { phrase: 'piano-chords-held', name: 'Piano', sections: ['intro'] }, { phrase: 'piano-montuno-fifth', name: 'Piano', sections: ['main'] }, { phrase: 'bass-tumbao' }] });
  assert.deepEqual(tracks.map(t => t.name), ['Kick', 'Clap', 'Hat Open', 'Piano', 'Tumbao bass']);
  const kick = tracks[0], piano = tracks[3];
  assert.deepEqual(kick.patterns.map(p => [p.name, p.bar, p.bars]), [['intro', 0, 4], ['main', 4, 8]]);
  assert.equal(kick.volume, 78);
  assert.equal(tracks[1].volume, 26);
  assert.equal(piano.patterns.length, 2);
  assert.ok(piano.patterns[1].notes.length > piano.patterns[0].notes.length);
  assert.equal(tracks[4].role, 'bass');
  assert.deepEqual(used, ['kit-kick-only', 'kit-house-basic', 'piano-chords-held', 'piano-montuno-fifth', 'bass-tumbao']);
  assert.throws(() => buildTracks({ key, sounds, lookup, sections, parts: [{ phrase: 'kit-kick-only' }, { phrase: 'kit-house-basic' }] }), /Two parts write to track "Kick"/);
  assert.throws(() => buildTracks({ key, sounds, lookup, sections, parts: [{ phrase: 'conga-tumbao' }] }), /conga-mute/);
  assert.throws(() => buildTracks({ key, sounds, lookup, sections, parts: [{ phrase: 'prog-andalusian' }] }), /progression/);
  assert.throws(() => buildTracks({ key, sounds, lookup, sections, parts: [{ phrase: 'bass-tumbao', sections: ['outro'] }] }), /unknown section/);
});
