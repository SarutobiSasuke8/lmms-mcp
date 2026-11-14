// Unit tests for blueprints. Run: npm test (no LMMS needed).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  blueprints, blueprintIds, getBlueprint, buildArrangement, checkArrangement, registerReport, parseProgression, romanToChord, chordSpans,
  voiceInLane, lengthCandidates, chooseLength, suggestPresets, volumeFor, leadOpNames, counterOps, bassFigures, harmonyStyles, textureStyles, scalePlan,
} from './blueprints.mjs';
import { parseKey, readMotif, totalSteps, inKey } from './motif.mjs';
import { expandPattern, parseChord } from '../music.mjs';

const catalogue = JSON.parse(readFileSync(new URL('../sound-catalogue.json', import.meta.url), 'utf8')).sounds;
const pitchedRoles = ['bass', 'harmony', 'counter', 'texture', 'lead'];

test('nine blueprints ship, including a victory stinger', () => {
  assert.deepEqual(blueprintIds, ['overworld', 'battle', 'boss', 'town', 'dungeon', 'title', 'puzzle', 'chiptune', 'victory']);
  assert.equal(getBlueprint('victory').kind, 'stinger');
  assert.throws(() => getBlueprint('jazz'), /Unknown blueprint/);
});

test('every blueprint is well formed', () => {
  for (const b of blueprints) {
    const key = parseKey(b.key);
    const names = b.tracks.map(t => t.name);
    assert.equal(new Set(names).size, names.length, `${b.id}: unique track names`);
    assert.ok(b.tracks.filter(t => t.role === 'lead').length === 1, `${b.id}: exactly one lead track`);
    assert.ok(b.tracks.filter(t => t.role === 'counter').length <= 1, `${b.id}: at most one counter track`);
    for (const role of ['harmony', 'counter', 'texture', 'bass']) {
      const [low, high] = b.lanes[role];
      assert.ok(high - low >= 12, `${b.id}: ${role} lane spans an octave`);
      if (role !== 'bass' || true) assert.ok(high < b.lanes.lead[0], `${b.id}: ${role} lane is under the lead lane`);
    }
    assert.ok(totalSteps(readMotif(b.motif, key)) <= b.phraseBars * 16, `${b.id}: motif fits a phrase`);
    for (const [name, text] of Object.entries(b.progressions)) {
      for (const { symbol } of parseProgression(text, key)) {
        const chord = parseChord(symbol);
        for (const i of chord.intervals) assert.ok(key.scale.includes((chord.root + i - key.tonic + 120) % 12), `${b.id} ${name}: ${symbol} is diatonic to ${b.key}`);
      }
    }
    for (const s of [...b.intro, ...b.body]) {
      assert.equal(s.bars % b.phraseBars, 0, `${b.id} ${s.name}: whole phrases`);
      for (const part of ['lead', 'counter']) {
        if (!Array.isArray(s[part])) continue;
        assert.equal(s[part].length, s.bars / b.phraseBars, `${b.id} ${s.name}: one ${part} op per phrase`);
        for (const op of s[part]) assert.ok((part === 'lead' ? leadOpNames : counterOps).includes(op), `${b.id} ${s.name}: ${op}`);
      }
      if (s.lead !== undefined && !Array.isArray(s.lead)) assert.equal(s.lead, 'rest');
      if (s.drums) assert.ok(b.drums[s.drums], `${b.id} ${s.name}: drum set ${s.drums}`);
      if (s.bass) assert.ok(bassFigures[s.bass], s.bass);
      if (s.harmony) assert.ok(harmonyStyles[s.harmony], s.harmony);
      if (s.texture) assert.ok(textureStyles[s.texture], s.texture);
      if (s.chords) assert.ok(b.progressions[s.chords], `${b.id} ${s.name}: progression ${s.chords}`);
    }
    for (const t of b.tracks.filter(t => t.role === 'drums')) assert.ok(Object.values(b.drums).some(set => set[t.drum]), `${b.id}: ${t.name} plays somewhere`);
  }
});

test('Roman numerals and chord symbols resolve in the key', () => {
  const eMinor = parseKey('E minor');
  assert.deepEqual(parseProgression('i VI III VII', eMinor).map(c => c.symbol), ['Em', 'C', 'G', 'D']);
  assert.deepEqual(parseProgression('Imaj7 vi7 ii7 V7', parseKey('C major')).map(c => c.symbol), ['Cmaj7', 'Am7', 'Dm7', 'G7']);
  assert.equal(romanToChord('vo', parseKey('C phrygian')), 'Gdim');
  assert.equal(romanToChord('II', parseKey('A phrygian')), 'Bb');
  assert.equal(romanToChord('bVII', parseKey('D major')), 'C');
  assert.equal(romanToChord('iv', parseKey('F# dorian'), { diatonic: true }), 'B', 'iv written for minor becomes IV in dorian');
  assert.equal(romanToChord('V7', parseKey('A minor'), { diatonic: true }), 'Em7');
  assert.equal(romanToChord('vii', parseKey('C major'), { diatonic: true }), 'Bdim');
  assert.deepEqual(parseProgression('Em:2 C D', eMinor), [{ symbol: 'Em', bars: 2 }, { symbol: 'C', bars: null }, { symbol: 'D', bars: null }]);
  assert.throws(() => parseProgression('i Q', eMinor), /Cannot read chord "Q"/);
  const spans = chordSpans(parseProgression('Em:2 C', eMinor), 5, 1);
  assert.deepEqual(spans.map(s => [s.symbol, s.tick, s.ticks]), [['Em', 0, 384], ['C', 384, 192], ['Em', 576, 384]]);
});

test('chords are voiced inside their lane with smooth movement', () => {
  const voiced = voiceInLane([7, 11, 2], [48, 64], 56);
  assert.ok(voiced.every(m => m >= 48 && m <= 64));
  assert.deepEqual(voiced.map(m => m % 12).sort(), [11, 2, 7].sort());
});

test('length: the nearest whole form is chosen and stingers do not repeat', () => {
  const overworld = getBlueprint('overworld');
  assert.equal(chooseLength(overworld).bars, 28);
  assert.equal(chooseLength(overworld, 52).bars, 52, 'intro plus two passes of the body');
  assert.equal(chooseLength(overworld, 14).bars, 14, 'sections halved');
  assert.deepEqual([chooseLength(getBlueprint('dungeon'), 14).bars, chooseLength(getBlueprint('dungeon'), 14).bodyCount], [12, 1], 'intro and the first body section');
  const victory = getBlueprint('victory');
  assert.ok(lengthCandidates(victory).every(c => c.passes === 1));
  assert.equal(chooseLength(victory, 100).bars, 8);
  assert.deepEqual(scalePlan(['state', 'repeat', 'sequence_up', 'cadence'], 0.5), ['state', 'cadence']);
  assert.deepEqual(scalePlan(['state', 'repeat'], 1, 1), ['state', 'rhythm']);
});

const motifs = [undefined, 'E5:2 G5:1 F#5:1 E5:2 B4:2 C5:4 r:4', '1:3 5:1 4:2 3:2 2:4 r:4', 'C#4:2 F4:2 G#4:4'];
const keys = [undefined, 'G', 'F# dorian', 'Bb major'];
const lengths = [{}, { lengthSeconds: 30 }, { lengthSeconds: 150 }, { lengthBars: 16 }];

test('every blueprint keeps one lead, at most one counter and support parts under the lead, in every bar', () => {
  let built = 0;
  for (const id of blueprintIds) {
    for (const [i, motif] of motifs.entries()) {
      for (const [j, key] of keys.entries()) {
        const length = lengths[(i + j) % lengths.length];
        const a = buildArrangement(id, { motif, key, bpm: [undefined, 90, 150, 200][j], ...length, catalogue, sounds: i % 2 ? 'suggested' : 'default' });
        const label = `${id} motif ${i} key ${key} ${JSON.stringify(length)}`;
        assert.deepEqual(checkArrangement(a), [], label);
        const report = registerReport(a.tracks, a.lengthBars);
        assert.ok(report.every(s => s.leads <= 1 && s.counters <= 1), label);
        assert.ok(report.every(s => s.leadLow === null || s.supportHigh === null || s.supportHigh < s.leadLow), label);
        const leadLow = a.lanes.lead[0];
        for (const t of a.tracks) {
          assert.ok(t.role, `${label}: ${t.name} has a role`);
          for (const p of t.patterns) {
            const notes = expandPattern(p);
            assert.equal(notes.length, p.notes.length, `${label}: ${t.name} ${p.name}`);
            if (supportRole(t.role)) assert.ok(notes.every(n => n.midi < leadLow), `${label}: ${t.name} stays under the lead lane`);
            if (t.role === 'lead') assert.ok(notes.every(n => n.midi >= leadLow), `${label}: lead stays in its lane`);
            if (t.role === 'lead' || t.role === 'counter') assert.ok(notes.every(n => inKey(n.midi, parseKey(a.key))), `${label}: ${t.name} stays in the key`);
          }
        }
        built++;
      }
    }
  }
  assert.equal(built, blueprintIds.length * motifs.length * keys.length);
});
const supportRole = role => ['bass', 'harmony', 'counter', 'texture'].includes(role);

test('the section map is contiguous, the length is exact and every section is audible', () => {
  for (const id of blueprintIds) {
    for (const bpm of [80, 133]) {
      const a = buildArrangement(id, { bpm, lengthSeconds: 60 });
      let at = 0;
      for (const s of a.sections) {
        assert.equal(s.startBar, at, `${id} ${s.name}`);
        assert.ok(s.roles.length > 0, `${id} ${s.name} plays something`);
        at += s.bars;
      }
      assert.equal(at, a.lengthBars);
      assert.equal(a.lengthSeconds, Number((a.lengthBars * 240 / bpm).toFixed(4)));
      const lastNoteEnd = Math.max(...a.tracks.flatMap(t => t.patterns.flatMap(p => p.notes.map(n => p.bar * 192 + n.tick + n.length))));
      assert.ok(lastNoteEnd <= a.lengthBars * 192, `${id}: nothing runs past the pinned length`);
      assert.equal(new Set(a.sections.map(s => s.name)).size, a.sections.length, `${id}: section names are unique`);
    }
  }
});

test('the lead states the motif, repeats it, varies it and rests', () => {
  for (const id of blueprintIds) {
    const a = buildArrangement(id, {});
    const played = a.leadPlan.filter(p => p.line);
    assert.equal(played[0].op, 'state', id);
    assert.ok(played[0].line.startsWith(a.motif.line.replace(/ r:[\d.]+$/, '')), `${id}: the first phrase is the motif`);
    if (a.blueprint.kind === 'loop') assert.ok(a.leadPlan.filter(p => p.op === 'state' || p.op === 'repeat').length >= 2, `${id}: stated more than once`);
    assert.ok(played.some(p => !['state', 'repeat'].includes(p.op)), `${id}: varied`);
    const leadBars = new Set(registerReport(a.tracks, a.lengthBars).filter(s => s.leads).map(s => s.bar));
    if (a.blueprint.kind === 'loop') assert.ok(leadBars.size < a.lengthBars, `${id}: the lead rests somewhere`);
  }
  const mine = buildArrangement('battle', { motif: 'A4:2 C5:2 E5:4 D5:4 r:4', key: 'A minor', progression: 'Am F C G' });
  assert.equal(mine.motif.source, 'yours');
  assert.equal(mine.progressions.main, 'Am F C G');
  assert.equal(mine.sections.find(s => s.name === 'A').chords[0], 'Am');
  assert.equal(buildArrangement('battle', { key: 'G' }).key, 'G minor', 'a bare tonic keeps the blueprint mode');
  assert.equal(buildArrangement('overworld', { motif: 'C#5:2 D5:2' , key: 'D major' }).motif.snappedToKey, undefined);
  assert.equal(buildArrangement('overworld', { motif: 'C5:2 D5:2', key: 'D major' }).motif.snappedToKey, 1);
});

test('sound suggestions come from the measured catalogue by role and level', () => {
  for (const role of pitchedRoles) {
    const picks = suggestPresets(catalogue, role);
    assert.ok(picks.length > 0 && picks.length <= 3, role);
    for (const p of picks) {
      const facts = catalogue[p.preset];
      assert.ok(facts.pitched && facts.peakDbfs >= -24 && facts.peakDbfs <= -3, p.preset);
      assert.ok(p.volume >= 3 && p.volume <= 150);
    }
  }
  assert.equal(volumeFor(-10, -10), 60);
  assert.equal(volumeFor(-4, -10), 30);
  const lead = suggestPresets(catalogue, 'lead')[0].preset;
  assert.ok(!suggestPresets(catalogue, 'lead', { exclude: [lead] }).some(p => p.preset === lead));
  const a = buildArrangement('overworld', { catalogue, sounds: 'suggested' });
  const presets = a.tracks.filter(t => t.voice === 'preset').map(t => t.preset);
  assert.equal(new Set(presets).size, presets.length, 'each track gets a different preset');
  assert.ok(a.tracks.filter(t => t.role === 'drums').every(t => t.voice === 'sample'));
});
