// Unit tests for the arrangement lint rules. Run: node --test tools/arranger-lint.test.mjs  (no LMMS needed)
import assert from 'node:assert/strict';
import test from 'node:test';
import { expandPattern } from '../music.mjs';
import {
  lintModel, qualityScore, hookReport, parseKey, detectKey, isFigure, barRanges, barSimilarity, inferRole, buildContext, melodicVoices,
} from './arranger-lint.mjs';

// Build a plain model from create_project style track specs, the same way the saved project would read back.
export function modelOf(specs, bars) {
  const tracks = specs.map(({ name, role, kind = 'synth', patterns }) => ({
    name, role: role ?? null, kind,
    notes: patterns.flatMap(p => expandPattern(p).map(n => ({ ...n, tick: n.tick + p.bar * 192 }))),
  }));
  const end = Math.max(...specs.flatMap(s => s.patterns.map(p => p.bar + p.bars)));
  return { ticksPerBar: 192, meter: [4, 4], bars: bars ?? end, tracks };
}
const notes = list => list.map(([tick, midi, length = 12]) => ({ tick, midi, length, velocity: 100 }));
const rules = result => result.findings.map(f => f.rule);
const only = (result, rule) => result.findings.filter(f => f.rule === rule);

// A sensible game loop in D minor: drums, a walking bass in the tenor register, an arpeggiated seventh-chord harmony
// (a six-note cycle), a held pad, one lead with a varied motif that rests in the last bar, and a real counter line that
// answers the lead and takes over while it rests.
const leadA = 'D5:4 F5:2 A5:2 G5:4 F5:4 | D5:4 F5:2 Bb5:2 F5:4 D5:4 | C5:4 F5:2 A5:2 G5:4 F5:4 | ';
export const cleanSpecs = [
  { name: 'Kick', role: 'drums', kind: 'sample', patterns: [{ name: 'Beat', bar: 0, bars: 8, steps: { grid: 'X-------x-------' } }] },
  { name: 'Hat', role: 'drums', kind: 'sample', patterns: [{ name: 'Beat', bar: 0, bars: 8, steps: { grid: '--x---x---x---x-' } }] },
  { name: 'Bass', role: 'bass', patterns: [{ name: 'Walk', bar: 0, bars: 4, melody: { line: 'D3:4 E3:4 F3:4 A3:4 | Bb2:4 C3:4 D3:4 F3:4 | F2:4 G2:4 A2:4 C3:4 | C3:4 D3:4 E3:4 G3:4', repeat: true } }] },
  { name: 'Arp', role: 'harmony', patterns: [{ name: 'Broken', bar: 0, bars: 8, chords: { progression: 'Dm7 Bbmaj7 Fmaj7 C7', style: 'arp', order: 'updown', rate: 1, octave: 3, voiceLead: false } }] },
  { name: 'Pad', role: 'harmony', patterns: [{ name: 'Held', bar: 0, bars: 8, chords: { progression: 'Dm Bb F C', octave: 4 } }] },
  { name: 'Lead', role: 'lead', patterns: [
    { name: 'A', bar: 0, bars: 4, melody: { line: leadA + 'E5:4 G5:2 C6:2 G5:4 E5:4' } },
    { name: 'A2', bar: 4, bars: 4, melody: { line: leadA + 'r:16' } },
  ] },
  { name: 'Counter', role: 'counter', patterns: [{ name: 'Answer', bar: 0, bars: 8, melody: {
    line: 'r:16 | r:8 F4:2 G4:2 A4:2 F4:2 | r:16 | r:8 G4:2 A4:2 G4:2 E4:2 | r:16 | r:8 F4:2 G4:2 A4:2 F4:2 | r:16 | C5:4 Bb4:4 G4:4 E4:4' } }] },
];
// The failure agents produce: four tracks, each with its own busy melody.
export const busySpecs = [
  { name: 'Lead A', role: 'lead', patterns: [{ name: 'A', bar: 0, bars: 4, melody: { line: 'D5:1 E5:1 F5:1 A5:1 G5:1 Bb5:1 A5:1 F5:1 E5:1 G5:1 F5:1 D5:1 C5:1 E5:1 G5:1 A5:1 | F5:1 D5:1 Bb4:1 C5:1 A5:1 G5:1 E5:1 C6:1 Bb5:1 G5:1 D5:1 F5:1 E5:1 A5:1 C5:1 D5:1 | A5:1 F5:1 G5:1 E5:1 D5:1 C6:1 Bb5:1 A5:1 G5:1 F5:1 E5:1 G5:1 Bb5:1 D5:1 F5:1 C5:1 | E5:1 C5:1 D5:1 G5:1 A5:1 F5:1 Bb5:1 E5:1 D6:1 C6:1 A5:1 G5:1 F5:1 D5:1 E5:1 A5:1' } }] },
  { name: 'Lead B', role: 'lead', patterns: [{ name: 'B', bar: 0, bars: 4, melody: { line: 'A4:2 C5:2 Bb4:2 G4:2 F4:2 E4:2 D5:2 C5:2 | E4:2 G4:2 D5:2 A4:2 Bb4:2 F4:2 C5:2 E4:2 | G4:2 Bb4:2 E4:2 D5:2 A4:2 C5:2 F4:2 G4:2 | D5:2 F4:2 A4:2 E4:2 C5:2 G4:2 Bb4:2 D4:2' } }] },
  { name: 'Melody C', role: 'counter', patterns: [{ name: 'C', bar: 0, bars: 4, melody: { line: 'F5:2 Eb5:2 G5:2 D5:2 C#5:2 A5:2 E5:2 F5:2 | B4:2 D5:2 G5:2 F#5:2 A5:2 E5:2 C5:2 Bb4:2 | C#5:2 E5:2 F5:2 A5:2 Ab4:2 G5:2 D5:2 B4:2 | G5:2 E5:2 C#5:2 F5:2 D5:2 A5:2 Eb5:2 F#5:2' } }] },
  { name: 'Melody D', patterns: [{ name: 'D', bar: 0, bars: 4, melody: { line: 'C6:2 A5:2 F#5:2 B5:2 D6:2 G5:2 E6:2 C6:2 | A5:2 F5:2 D6:2 Bb5:2 G#5:2 E6:2 C6:2 A5:2 | B5:2 G5:2 E6:2 C#6:2 A5:2 F6:2 D6:2 Bb5:2 | G5:2 D6:2 B5:2 F6:2 E6:2 C6:2 A5:2 C#6:2' } }] },
];

test('a clean drums, bass, pad, lead and sparse counter arrangement passes with no errors or warnings', () => {
  const result = lintModel(modelOf(cleanSpecs));
  assert.equal(result.counts.error, 0, JSON.stringify(result.findings, null, 1));
  assert.equal(result.counts.warning, 0, JSON.stringify(result.findings, null, 1));
  assert.equal(result.pass, true);
  assert.ok(['D minor', 'F major'].includes(result.key.name), result.key.name);
  assert.ok(result.melodicVoicesPerBar.every(n => n <= 2));
  assert.equal(qualityScore(result).pass, true);
  assert.equal(hookReport(result), null);
});

test('four busy melodies fail with a clear competing-melodies error', () => {
  const result = lintModel(modelOf(busySpecs));
  assert.equal(result.pass, false);
  const [competing] = only(result, 'melody.competing');
  assert.ok(competing, rules(result).join(', '));
  assert.equal(competing.severity, 'error');
  assert.deepEqual(competing.bars, [0, 1, 2, 3]);
  assert.match(competing.message, /4 independent melodies/);
  assert.match(competing.fix, /one lead/);
  assert.ok(only(result, 'role.multiple-leads').some(f => f.severity === 'error'));
  assert.ok(result.findings.some(f => f.rule === 'role.missing' && f.tracks[0] === 'Melody D'));
  const quality = qualityScore(result);
  assert.equal(quality.pass, false);
  assert.match(quality.verdict, /^Fail/);
  const hook = hookReport(result);
  assert.equal(hook.blocking, true);
  assert.match(hook.warnings[0], /^ERROR/);
});

test('role limits: two leads, two counters and a counter far from any lead', () => {
  const model = { ticksPerBar: 192, meter: [4, 4], bars: 10, tracks: [
    { name: 'L1', role: 'lead', kind: 'synth', notes: notes([[0, 74, 96], [96, 77, 96]]) },
    { name: 'L2', role: 'lead', kind: 'synth', notes: notes([[0, 81, 48], [48, 79, 48], [96, 79, 96]]) },
    { name: 'C1', role: 'counter', kind: 'synth', notes: notes([[0, 65, 96], [192, 65, 96], [1728, 65, 96]]) },
    { name: 'C2', role: 'counter', kind: 'synth', notes: notes([[0, 62, 48], [48, 64, 48], [240, 62, 96]]) },
  ] };
  const result = lintModel(model);
  assert.deepEqual(only(result, 'role.multiple-leads')[0].bars, [0]);
  assert.deepEqual(only(result, 'role.multiple-counters')[0].bars, [0, 1]);
  assert.deepEqual(only(result, 'role.counter-without-lead').map(f => f.bars), [[9]]);
});

test('inferred roles: one-shots are drums, low lines are bass, chords are harmony, high moving lines are melodic', () => {
  const model = modelOf([
    { name: 'Hits', kind: 'sample', patterns: [{ name: 'p', bar: 0, bars: 2, steps: { grid: 'x-x-x-x-' } }] },
    { name: 'Low', patterns: [{ name: 'p', bar: 0, bars: 2, melody: { line: 'D2:4 F2:4 A2:4 C3:4' } }] },
    { name: 'Chords', patterns: [{ name: 'p', bar: 0, bars: 2, chords: { progression: 'Dm Bb' } }] },
    { name: 'Tune', patterns: [{ name: 'p', bar: 0, bars: 2, melody: { line: 'D5:2 F5:2 A5:4 G5:4 E5:4' } }] },
  ]);
  const roles = Object.fromEntries(lintModel(model).roles.map(r => [r.track, r.role]));
  assert.deepEqual(roles, { Hits: 'drums', Low: 'bass', Chords: 'harmony', Tune: 'lead' });
  assert.equal(inferRole({ drums: false, notes: [], polyShare: 0 }), 'texture');
});

test('arpeggios and doubled lines are not counted as extra melodies', () => {
  assert.equal(isFigure([62, 65, 69, 65, 62, 65, 69, 65].map((top, i) => ({ tick: i * 24, top }))), true);
  assert.equal(isFigure([62, 65, 69, 67, 64, 72, 71, 60].map((top, i) => ({ tick: i * 24, top }))), false);
  const model = modelOf([
    { name: 'Arp', role: 'harmony', patterns: [{ name: 'p', bar: 0, bars: 1, chords: { progression: 'Dm', style: 'arp', order: 'updown', rate: 2 } }] },
    { name: 'Lead', role: 'lead', patterns: [{ name: 'p', bar: 0, bars: 1, melody: { line: 'D5:2 F5:2 A5:4 G5:4 E5:4' } }] },
    { name: 'Double', role: 'counter', patterns: [{ name: 'p', bar: 0, bars: 1, melody: { line: 'F5:2 A5:2 C6:4 B5:4 G5:4' } }] },
    { name: 'Third', role: 'texture', patterns: [{ name: 'p', bar: 0, bars: 1, melody: { line: 'A4:4 B4:4 G4:4 A4:4' } }] },
  ]);
  const ctx = buildContext(model);
  assert.equal(ctx.infos[0].perBar[0].figure, true);
  assert.deepEqual(melodicVoices(ctx, 0), [['Lead', 'Double']], 'a texture line is never a competing melody');
});

test('register: harmony inside the lead range, a buried lead and a high bass', () => {
  const model = { ticksPerBar: 192, meter: [4, 4], bars: 1, tracks: [
    { name: 'Lead', role: 'lead', kind: 'synth', notes: notes([[0, 67, 48], [48, 69, 48], [96, 72, 48], [144, 71, 48]]) },
    { name: 'Pad', role: 'harmony', kind: 'synth', notes: notes([[0, 69, 192], [0, 72, 192], [0, 76, 192]]) },
    { name: 'Bass', role: 'bass', kind: 'synth', notes: notes([[0, 62, 96], [96, 69, 96]]) },
  ] };
  const result = lintModel(model);
  assert.equal(only(result, 'register.overlap')[0].tracks[0], 'Pad');
  assert.ok(only(result, 'register.lead-buried').length);
  assert.deepEqual(only(result, 'register.bass-high')[0].bars, [0]);
});

test('clashes: minor seconds on strong beats warn, and become an error when they are common', () => {
  const pad = { name: 'Pad', role: 'harmony', kind: 'synth', notes: notes([[0, 62, 768], [0, 65, 768], [0, 69, 768]]) };
  const once = lintModel({ ticksPerBar: 192, meter: [4, 4], bars: 4, tracks: [pad,
    { name: 'Lead', role: 'lead', kind: 'synth', notes: notes([[0, 74, 96], [96, 76, 96], [192, 77, 192], [384, 74, 192], [576, 70, 96], [672, 74, 96]]) }] }, { key: 'D minor' });
  const [clash] = only(once, 'clash.harsh-interval');
  assert.equal(clash.severity, 'warning');
  assert.deepEqual(clash.bars, [3]);
  const often = lintModel({ ticksPerBar: 192, meter: [4, 4], bars: 4, tracks: [pad,
    { name: 'Lead', role: 'lead', kind: 'synth', notes: notes([[0, 70, 192], [192, 70, 192], [384, 63, 192], [576, 74, 192]]) }] }, { key: 'D minor' });
  assert.equal(only(often, 'clash.harsh-interval')[0].severity, 'error');
});

test('key: parsing, detection and out-of-key notes', () => {
  assert.deepEqual(parseKey('D minor'), { tonic: 2, mode: 'minor', name: 'D minor' });
  assert.equal(parseKey('Bbm').name, 'Bb minor');
  assert.equal(parseKey('F#').name, 'F# major');
  assert.equal(parseKey('a dorian').name, 'A dorian');
  assert.throws(() => parseKey('H minor'), /Unknown key/);
  const cMajor = [60, 62, 64, 65, 67, 69, 71, 72, 64, 67, 60, 60].map((midi, i) => ({ tick: i * 48, midi, length: 48 }));
  assert.equal(detectKey(cMajor).name, 'C major');
  assert.equal(detectKey([]), null);
  const stray = { ticksPerBar: 192, meter: [4, 4], bars: 2, tracks: [
    { name: 'Lead', role: 'lead', kind: 'synth', notes: notes([[0, 60, 96], [96, 61, 96], [192, 63, 96], [288, 66, 96]]) }] };
  const result = lintModel(stray, { key: 'C major' });
  const [found] = only(result, 'key.out-of-key');
  assert.equal(found.severity, 'error');
  assert.match(found.message, /75% .* C major \(C#, Eb, F#\)/);
  assert.equal(result.key.source, 'given');
  const wholeTone = { ticksPerBar: 192, meter: [4, 4], bars: 2, tracks: [
    { name: 'Lead', role: 'lead', kind: 'synth', notes: notes([60, 62, 64, 66, 68, 70, 72, 70].map((midi, i) => [i * 48, midi, 48])) }] };
  const unclear = lintModel(wholeTone);
  assert.deepEqual(rules(unclear), ['key.unclear']);
  assert.equal(only(lintModel(wholeTone, { key: 'C major' }), 'key.out-of-key')[0].severity, 'error');
});

test('density: crowded bars, empty bars inside the song, static runs and no development', () => {
  const crowd = { ticksPerBar: 192, meter: [4, 4], bars: 1, tracks: Array.from({ length: 7 }, (_, k) => ({
    name: 'T' + k, role: 'harmony', kind: 'synth', notes: notes(Array.from({ length: 8 }, (_, i) => [i * 24, 50 + k * 3, 24])) })) };
  const crowded = lintModel(crowd);
  assert.ok(only(crowded, 'density.crowded').length);
  assert.ok(only(crowded, 'density.too-many-parts').length);
  const gap = { ticksPerBar: 192, meter: [4, 4], bars: 5, tracks: [
    { name: 'Pad', role: 'harmony', kind: 'synth', notes: notes([[0, 62, 192], [576, 62, 192]]) }] };
  const gapped = lintModel(gap);
  assert.deepEqual(only(gapped, 'density.empty')[0].bars, [1, 2]);
  assert.deepEqual(only(gapped, 'density.empty-edge')[0].bars, [4]);
  const loop = { ticksPerBar: 192, meter: [4, 4], bars: 16, tracks: [
    { name: 'Pad', role: 'harmony', kind: 'synth', notes: notes(Array.from({ length: 16 }, (_, b) => [b * 192, 62, 192])) }] };
  const flat = lintModel(loop);
  assert.deepEqual(only(flat, 'density.static')[0].bars.length, 16);
  assert.ok(only(flat, 'density.no-development').length);
});

test('motif: a lead that never repeats and one that only repeats', () => {
  const random = lintModel(modelOf([busySpecs[0]]));
  assert.ok(only(random, 'motif.no-repetition').length, rules(random).join(', '));
  const riff = lintModel(modelOf([{ name: 'Riff', role: 'lead', patterns: [{ name: 'p', bar: 0, bars: 8, melody: { line: 'D5:4 F5:4 A5:4 G5:4' } }] }]));
  assert.ok(only(riff, 'motif.only-repeats').length);
  assert.equal(only(riff, 'motif.no-repetition').length, 0);
  const clean = lintModel(modelOf(cleanSpecs));
  assert.ok(clean.motif[0].relatedShare >= 0.75 && clean.motif[0].uniqueShare > 0.5, JSON.stringify(clean.motif));
  assert.equal(barSimilarity({ rhythm: [0, 48], intervals: [2] }, { rhythm: [0, 48], intervals: [2] }), 1);
  assert.equal(barSimilarity({ rhythm: [0, 48], intervals: [2] }, { rhythm: [0, 96], intervals: [5] }), 1 / 6);
});

test('lead playability: leaps over an octave and a range over two octaves', () => {
  const result = lintModel({ ticksPerBar: 192, meter: [4, 4], bars: 2, tracks: [
    { name: 'Lead', role: 'lead', kind: 'synth', notes: notes([[0, 60, 48], [48, 62, 48], [96, 79, 48], [192, 88, 48], [240, 86, 48]]) }] });
  assert.deepEqual(only(result, 'lead.leap')[0].bars, [0]);
  assert.match(only(result, 'lead.range')[0].message, /28 semitones/);
});

test('quality score subtracts by severity with a cap per rule, and counts audio warnings', () => {
  const lint = { counts: { error: 0, warning: 2, note: 1 }, findings: [
    { rule: 'a', severity: 'warning', message: 'A.' }, { rule: 'a', severity: 'warning', message: 'B.' }, { rule: 'b', severity: 'note', message: 'C.' }] };
  const result = qualityScore(lint, { audioWarnings: ['Clipping.'] });
  assert.equal(result.score, 100 - 10 - 1 - 4);
  assert.equal(result.pass, true);
  assert.equal(result.reasons[0].rule, 'a');
  const many = { counts: { error: 5, warning: 0, note: 0 }, findings: Array.from({ length: 5 }, () => ({ rule: 'x', severity: 'error', message: 'X.' })) };
  assert.equal(qualityScore(many).score, 70);
  assert.equal(qualityScore(many).pass, false);
  assert.equal(qualityScore({ counts: { error: 0 }, findings: [] }, { silent: true }).score, 60);
  assert.equal(barRanges([5, 1, 2, 3, 7, 8]), '1-3, 5, 7-8');
});

// ---------- regressions from the PR 11 review ----------

test('review 1: declared bass, harmony and texture lines never count as competing melodies', () => {
  const ctx = buildContext(modelOf(cleanSpecs));
  const bass = ctx.infos.find(i => i.name === 'Bass'), counter = ctx.infos.find(i => i.name === 'Counter');
  assert.ok(bass.perBar.some(bar => bar.melodic), 'the walking bass moves like a melody');
  assert.ok(counter.perBar.some(bar => bar.melodic), 'the counter is a real line, not two notes');
  const walk = lintModel(modelOf([
    { name: 'Lead', role: 'lead', patterns: [{ name: 'p', bar: 0, bars: 4, melody: { line: 'D5:4 F5:2 A5:2 G5:4 F5:4', repeat: true } }] },
    { name: 'Counter', role: 'counter', patterns: [{ name: 'p', bar: 0, bars: 4, melody: { line: 'A4:4 G4:4 F4:4 E4:4', repeat: true } }] },
    { name: 'Walk', role: 'bass', patterns: [{ name: 'p', bar: 0, bars: 4, melody: { line: 'D3:4 E3:4 F3:4 A3:4', repeat: true } }] },
    { name: 'Arp6', role: 'harmony', patterns: [{ name: 'p', bar: 0, bars: 4, chords: { progression: 'Dm7', style: 'arp', order: 'updown', rate: 1 } }] },
  ]));
  assert.equal(only(walk, 'melody.competing').length, 0, JSON.stringify(walk.findings));
  assert.ok(walk.melodicVoicesPerBar.every(n => n === 2));
});

test('review 1: figures with a six or eight note cycle are figures', () => {
  assert.equal(isFigure([62, 65, 69, 72, 69, 65, 62, 65, 69, 72, 69, 65].map((top, i) => ({ tick: i * 12, top }))), true);
  assert.equal(isFigure([50, 57, 62, 65, 69, 65, 62, 57, 50, 57, 62, 65, 69, 65, 62, 57].map((top, i) => ({ tick: i * 12, top }))), true);
  assert.equal(isFigure([62, 65, 62, 69, 62, 65, 62, 69].map((top, i) => ({ tick: i * 24, top }))), true, 'broken chord on three pitches');
  const unroled = buildContext(modelOf([{ name: 'Arp', patterns: [{ name: 'p', bar: 0, bars: 1, chords: { progression: 'Dm7', style: 'arp', order: 'updown', rate: 1, octave: 5 } }] }]));
  assert.equal(unroled.infos[0].perBar[0].melodic, false, 'an unroled period-6 arpeggio is not a melody');
});

test('review 2: one clashing note is a warning, and chord tones doubled across tracks are not clashes', () => {
  const pad = { name: 'Pad', role: 'harmony', kind: 'synth', notes: notes([[0, 62, 768], [0, 65, 768], [0, 69, 768]]) };
  const bell = lintModel({ ticksPerBar: 192, meter: [4, 4], bars: 4, tracks: [pad, { name: 'Bell', role: 'texture', kind: 'synth', notes: notes([[0, 70, 96]]) }] }, { key: 'D minor' });
  const [clash] = only(bell, 'clash.harsh-interval');
  assert.equal(clash.severity, 'warning', 'one hit out of one eligible beat must not block');
  const fmaj7 = modelOf([
    { name: 'Pad', role: 'harmony', patterns: [{ name: 'p', bar: 0, bars: 2, chords: { progression: 'Fmaj7' } }] },
    { name: 'Arp', role: 'harmony', patterns: [{ name: 'p', bar: 0, bars: 2, chords: { progression: 'Fmaj7', style: 'arp', order: 'down', rate: 2, octave: 5 } }] },
    { name: 'Bass', role: 'bass', patterns: [{ name: 'p', bar: 0, bars: 2, melody: { line: 'F2:8 E2:8' } }] },
  ]);
  assert.equal(only(lintModel(fmaj7), 'clash.harsh-interval').length, 0, JSON.stringify(lintModel(fmaj7).findings));
  const stray = lintModel({ ticksPerBar: 192, meter: [4, 4], bars: 4, tracks: [pad,
    { name: 'Lead', role: 'lead', kind: 'synth', notes: notes([[0, 75, 96], [96, 74, 96], [192, 75, 192], [384, 75, 192], [576, 75, 192]]) }] });
  assert.equal(only(stray, 'clash.harsh-interval')[0].severity, 'error', 'a lead on Eb against D on four downbeats still blocks');
});

test('review 3: a short overhang and an octave doubling are not two leads', () => {
  const overhang = lintModel({ ticksPerBar: 192, meter: [4, 4], bars: 2, tracks: [
    { name: 'Verse', role: 'lead', kind: 'synth', notes: notes([[0, 74, 96], [96, 77, 104]]) },
    { name: 'Chorus', role: 'lead', kind: 'synth', notes: notes([[192, 81, 96], [288, 79, 96]]) },
  ] });
  assert.equal(only(overhang, 'role.multiple-leads').length, 0);
  const line = 'D5:4 F5:2 A5:2 G5:4 F5:4';
  const doubled = lintModel(modelOf([
    { name: 'Lead', role: 'lead', patterns: [{ name: 'p', bar: 0, bars: 2, melody: { line } }] },
    { name: 'Lead octave', role: 'lead', patterns: [{ name: 'p', bar: 0, bars: 2, melody: { line }, transpose: 12 }] },
  ]));
  assert.equal(only(doubled, 'role.multiple-leads').length, 0);
  const held = lintModel({ ticksPerBar: 192, meter: [4, 4], bars: 2, tracks: [
    { name: 'A', role: 'lead', kind: 'synth', notes: notes([[0, 74, 384]]) },
    { name: 'B', role: 'lead', kind: 'synth', notes: notes([[192, 81, 96], [288, 79, 96]]) },
  ] });
  assert.deepEqual(only(held, 'role.multiple-leads')[0].bars, [1], 'a note held through the bar still counts');
});

test('review 4: a detected key can warn but never block; a given key can block', () => {
  const vamp = modelOf([
    { name: 'Pad', role: 'harmony', patterns: [{ name: 'p', bar: 0, bars: 8, chords: { progression: 'Dm G' } }] },
    { name: 'Lead', role: 'lead', patterns: [{ name: 'p', bar: 0, bars: 8, melody: { line: 'D5:4 E5:4 F5:4 A5:4 | B5:4 A5:4 G5:4 F5:4', repeat: true } }] },
    { name: 'Bass', role: 'bass', patterns: [{ name: 'p', bar: 0, bars: 8, chords: { progression: 'Dm G', style: 'bass' } }] },
  ]);
  const detected = lintModel(vamp);
  assert.equal(detected.counts.error, 0, JSON.stringify(detected.findings));
  assert.equal(lintModel(vamp, { key: 'D dorian' }).findings.filter(f => f.rule.startsWith('key.')).length, 0);
  assert.equal(only(lintModel(vamp, { key: 'Eb major' }), 'key.out-of-key')[0].severity, 'error');
});

test('review 5: call and response is fine; a counter alone for a long stretch is not', () => {
  const answer = lintModel(modelOf([
    { name: 'Lead', role: 'lead', patterns: [{ name: 'p', bar: 0, bars: 4, melody: { line: 'D5:4 F5:4 A5:8 | r:16', repeat: true } }] },
    { name: 'Counter', role: 'counter', patterns: [{ name: 'p', bar: 0, bars: 4, melody: { line: 'r:16 | A4:4 G4:4 F4:4 E4:4', repeat: true } }] },
  ]));
  assert.equal(only(answer, 'role.counter-without-lead').length, 0);
  const alone = lintModel(modelOf([
    { name: 'Lead', role: 'lead', patterns: [{ name: 'p', bar: 0, bars: 1, melody: { line: 'D5:4 F5:4 A5:8' } }] },
    { name: 'Counter', role: 'counter', patterns: [{ name: 'p', bar: 0, bars: 12, melody: { line: 'A4:4 G4:4 F4:4 E4:4' } }] },
  ]));
  assert.deepEqual(only(alone, 'role.counter-without-lead')[0].bars, [5, 6, 7, 8, 9, 10, 11]);
});

test('review: an empty unroled track is not drums, and missing roles alone add nothing to a save', () => {
  const ctx = buildContext({ ticksPerBar: 192, meter: [4, 4], bars: 1, tracks: [{ name: 'Empty', role: null, kind: 'synth', notes: [] }] });
  assert.equal(ctx.infos[0].drums, false);
  assert.equal(ctx.infos[0].role, 'texture');
  const unroled = lintModel(modelOf(cleanSpecs.map(({ role, ...rest }) => rest)));
  assert.ok(unroled.findings.some(f => f.rule === 'role.missing'));
  assert.equal(unroled.roles.find(r => r.track === 'Bass').role, 'bass', 'a walking bass in the tenor register is inferred as bass');
  assert.equal(unroled.counts.error + unroled.counts.warning, 0, JSON.stringify(unroled.findings.filter(f => f.severity !== 'note')));
  assert.equal(hookReport(unroled), null);
});
