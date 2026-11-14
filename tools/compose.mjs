// Whole pieces from a short recipe, with no model in the loop: a chord progression, a phrase-based melody, accompaniment,
// bass and drums, arranged with an intro and an ending. Everything is seeded code, so a batch of seeds can be rendered and ranked.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseKey, pitchClassName } from './motif.mjs';
import { writeMelody, writeAccompaniment, chordPlan, rng } from './melody.mjs';
import { lintModel, modelFromDoc, qualityScore } from './arranger-lint.mjs';

const BAR = 192, STEP = 12;
const mod = (a, n) => ((a % n) + n) % n;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------- chord progressions ----------
const numerals = { i: 0, ii: 1, iii: 2, iv: 3, v: 4, vi: 5, vii: 6 };
const templates = {
  major: {
    A: [['I', 'V', 'vi', 'IV'], ['I', 'vi', 'IV', 'V'], ['I', 'IV', 'vi', 'V'], ['I', 'iii', 'IV', 'V'], ['Imaj7', 'vi7', 'ii7', 'V7']],
    B: [['vi', 'IV', 'I', 'V'], ['IV', 'V', 'iii', 'vi'], ['ii', 'V', 'I', 'vi'], ['IV', 'I', 'V', 'vi']],
  },
  minor: {
    A: [['i', 'VI', 'III', 'VII'], ['i', 'iv', 'VI', 'V'], ['i', 'VII', 'VI', 'VII'], ['i', 'VI', 'iv', 'V']],
    B: [['VI', 'VII', 'i', 'i'], ['iv', 'VII', 'III', 'VI'], ['III', 'VII', 'i', 'V'], ['VI', 'iv', 'i', 'V']],
  },
};
export function romanToChord(roman, key) {
  const match = /^([ivIV]+)(.*)$/.exec(roman);
  if (!match || !(match[1].toLowerCase() in numerals)) throw new Error(`Unknown Roman numeral "${roman}"`);
  const root = mod(key.tonic + key.scale[numerals[match[1].toLowerCase()]], 12);
  const minor = match[1] === match[1].toLowerCase();
  const suffix = match[2] === '7' && minor ? 'm7' : match[2] === 'maj7' ? 'maj7' : match[2] === '7' ? '7' : minor ? 'm' : '';
  return pitchClassName(root, key) + suffix;
}
// Eight-bar sections in an A A B A order. Sections lead on with the dominant; the last one comes home to the tonic.
export function writeProgression({ key: keyInput, bars, seed = 1 } = {}) {
  const key = parseKey(keyInput), random = rng(seed + 101);
  const family = templates[key.scale[2] === 3 ? 'minor' : 'major'];
  const tonic = key.scale[2] === 3 ? 'i' : 'I';
  const chosen = { A: random.pick(family.A), B: random.pick(family.B) };
  const chords = [], sections = [];
  const order = ['A', 'A', 'B', 'A'];
  for (let bar = 0, s = 0; bar < bars; s++) {
    const name = order[s % order.length], length = Math.min(8, bars - bar);
    sections.push({ name, bar, bars: length });
    for (let i = 0; i < length; i++) chords.push(chosen[name][i % 4]);
    if (length >= 4) chords[bar + length - 1] = 'V';
    bar += length;
  }
  if (bars >= 2) chords[bars - 2] = 'V';
  chords[bars - 1] = tonic;
  return { key: key.name, numerals: chords, chords: chords.map(roman => romanToChord(roman, key)), sections };
}

// ---------- bass ----------
export const bassStyles = ['roots', 'pulse', 'octaves', 'walking', 'syncopated'];
export function writeBass({ chords, bars, style = 'pulse', seed = 1, low = 28, high = 50, baseVelocity = 92, plan: phrasePlan = [] } = {}) {
  if (!bassStyles.includes(style)) throw new Error(`Unknown style "${style}". Use one of: ${bassStyles.join(', ')}`);
  const plan = chordPlan(chords, bars), random = rng(seed + 211), notes = [];
  const liftAt = bar => phrasePlan.find(p => bar >= p.bar && bar < p.bar + p.bars)?.liftDegrees ?? 0;
  const rootOf = (chord, near) => { let best = low; for (let m = low; m <= high; m++) if (mod(m, 12) === chord.root && Math.abs(m - near) < Math.abs(best - near)) best = m; return mod(best, 12) === chord.root ? best : low + mod(chord.root - low, 12); };
  const tone = (chord, root, which) => { const pc = chord.pcs[which % chord.pcs.length]; let m = root + mod(pc - chord.root, 12); return m > high ? m - 12 : m; };
  const push = (tick, length, midi, velocity) => notes.push({ tick: Math.round(tick), length: Math.max(6, Math.round(length)), midi: clamp(midi, low, high + 12), velocity: Math.round(clamp(velocity, 1, 127)) });
  let last = low + 7;
  for (let bar = 0; bar < bars; bar++) {
    const span = BAR / plan[bar].length, gain = baseVelocity + liftAt(bar) * 2;
    plan[bar].forEach((chord, part) => {
      const from = bar * BAR + part * span, root = rootOf(chord, last), next = (plan[bar][part + 1] ?? plan[Math.min(bar + 1, bars - 1)][0]);
      last = root;
      if (bar === bars - 1) return push(from, span - 6, root, gain - 4);
      if (style === 'roots') return push(from, span - 8, root, gain);
      if (style === 'pulse' || style === 'octaves') {
        for (let t = 0, i = 0; t < span; t += 24, i++) {
          const up = style === 'octaves' ? i % 2 === 1 : t + 24 >= span && random.chance(0.35);
          push(from + t, 20, up && root + 12 <= high + 12 ? root + 12 : root, gain + (t % 48 === 0 ? 3 : -5) + random.spread(2));
        }
        return;
      }
      if (style === 'walking') {
        const beats = Math.round(span / 48);
        for (let i = 0; i < beats; i++) {
          let midi = i === 0 ? root : tone(chord, root, 1 + Math.floor(random() * (chord.pcs.length - 1)));
          if (i === beats - 1 && beats > 1) { const target = rootOf(next, root); midi = target + (root > target ? 1 : -1); }
          push(from + i * 48, 44, midi, gain + (i % 2 === 0 ? 2 : -4) + random.spread(3));
        }
        return;
      }
      for (const [t, len, which, accent] of [[0, 34, 0, 4], [72, 20, 0, -4], [96, 44, 2, 0], [144, 20, 0, -3]]) if (t < span) push(from + t, len, which ? tone(chord, root, which) : root, gain + accent + random.spread(2));
      if (span >= BAR && random.chance(0.5)) push(from + 168, 20, rootOf(next, root) - 1, gain - 8);
    });
  }
  return { style, bars, notes: notes.sort((a, b) => a.tick - b.tick) };
}

// ---------- drums ----------
const grooves = { // 16 steps per bar: [step, velocity]
  rock: { kick: [[0, 100], [8, 92], [10, 70]], snare: [[4, 96], [12, 98]], hat: [0, 2, 4, 6, 8, 10, 12, 14].map(s => [s, s % 4 === 0 ? 78 : 58]) },
  four: { kick: [[0, 100], [4, 94], [8, 98], [12, 94]], snare: [[4, 88], [12, 90]], hat: [[2, 70], [6, 66], [10, 70], [14, 66]] },
  halftime: { kick: [[0, 100], [10, 78]], snare: [[8, 100]], hat: [0, 2, 4, 6, 8, 10, 12, 14].map(s => [s, s % 4 === 0 ? 72 : 52]) },
  ballad: { kick: [[0, 84], [10, 60]], snare: [[8, 74]], hat: [[0, 56], [4, 46], [8, 54], [12, 46]] },
  chip: { kick: [[0, 100], [6, 76], [8, 94]], snare: [[4, 94], [12, 96]], hat: Array.from({ length: 16 }, (_, s) => [s, s % 4 === 0 ? 74 : s % 2 === 0 ? 58 : 40]) },
};
export const drumStyles = [...Object.keys(grooves), 'swing', 'none'];
export function writeDrums({ bars, style = 'rock', seed = 1, phraseBars = 4, plan: phrasePlan = [], quietBars = 0 } = {}) {
  if (!drumStyles.includes(style)) throw new Error(`Unknown style "${style}". Use one of: ${drumStyles.join(', ')}`);
  const random = rng(seed + 307), parts = { kick: [], snare: [], hat: [], crash: [] };
  if (style === 'none') return { style, bars, parts };
  const liftAt = bar => phrasePlan.find(p => bar >= p.bar && bar < p.bar + p.bars)?.liftDegrees ?? 0;
  const hit = (part, bar, tick, velocity, length = 40) => parts[part].push({ tick: bar * BAR + Math.round(tick), length: Math.min(length, bars * BAR - bar * BAR - Math.round(tick)), midi: 69, velocity: Math.round(clamp(velocity, 1, 127)) });
  for (let bar = 0; bar < bars; bar++) {
    const gain = 0.86 + liftAt(bar) * 0.035, last = bar === bars - 1;
    const fill = !last && bar >= quietBars && (bar - quietBars) % phraseBars === phraseBars - 1;
    if (last) { hit('kick', bar, 0, 100 * gain); hit('crash', bar, 0, 92, 380); continue; }
    if (bar > quietBars && (bar - quietBars) % phraseBars === 0) hit('crash', bar, 0, 78 * gain, 380);
    if (style === 'swing') {
      for (const [t, v] of [[0, 76], [48, 70], [80, 48], [96, 74], [144, 70], [176, 48]]) if (!(v < 60 && random.chance(0.1))) hit('hat', bar, t + 2, v * gain + random.spread(4), 110);
      if (bar < quietBars) continue;
      for (const t of [0, 48, 96, 144]) hit('kick', bar, t, 34 * gain + random.spread(3));
      if (fill) [96, 112, 128, 144, 160, 176].forEach((t, i) => hit('snare', bar, t, (50 + i * 8) * gain));
      else for (const t of [32, 80, 128, 176].filter(() => random.chance(0.3))) hit('snare', bar, t, (random.chance(0.25) ? 78 : 40) * gain);
      continue;
    }
    const groove = grooves[style];
    for (const [s, v] of groove.hat) if (!(fill && s >= 12)) hit('hat', bar, s * STEP + (s % 2 ? random.spread(1) : 0), v * gain + random.spread(3), 24);
    if (bar < quietBars) continue;
    for (const [s, v] of groove.kick) hit('kick', bar, s * STEP, v * gain + random.spread(2));
    if (random.chance(0.22) && style !== 'ballad') hit('kick', bar, 14 * STEP, 66 * gain);
    for (const [s, v] of groove.snare) if (!(fill && s >= 12)) hit('snare', bar, s * STEP, v * gain + random.spread(2));
    if (fill) (style === 'ballad' ? [12, 14] : [12, 13, 14, 15]).forEach((s, i) => hit('snare', bar, s * STEP, (62 + i * 11) * gain));
  }
  return { style, bars, parts };
}

// ---------- styles ----------
const kit = { kick: { voice: 'kick', volume: 62 }, snare: { voice: 'clap', volume: 44 }, hat: { voice: 'hat', volume: 26 }, crash: { voice: 'sample', factorySample: 'drums/crash01.ogg', volume: 24 } };
const acoustic = { kick: { voice: 'sample', factorySample: 'drums/bassdrum_acoustic01.ogg', volume: 58 }, snare: { voice: 'sample', factorySample: 'drums/snare_acoustic01.ogg', volume: 44 },
  hat: { voice: 'sample', factorySample: 'drums/hihat_closed01.ogg', volume: 24 }, crash: { voice: 'sample', factorySample: 'drums/crash01.ogg', volume: 22 } };
export const styles = {
  chiptune: { about: 'Bright 8-bit style tune with a square lead, fast arpeggios and a tight beat.', bpm: 140, keys: ['C major', 'G major', 'A minor', 'E minor', 'D major'],
    melody: { style: 'driving', low: 69, high: 91, baseVelocity: 84, ornament: false }, harmony: { style: 'flowing', low: 48, high: 67, pedal: false, baseVelocity: 62 }, bass: 'octaves', drums: 'chip',
    voices: { lead: { voice: 'preset', preset: 'TripleOscillator/Square.xpf', volume: 13 }, harmony: { voice: 'preset', preset: 'ZynAddSubFX/Laba170bank/0131-chip-SIDarpSharp.xiz', volume: 60, pan: -18 }, bass: { voice: 'bass', volume: 74 }, ...kit } },
  adventure: { about: 'Open, hopeful overworld theme with a singing lead over rolling chords.', bpm: 118, keys: ['D major', 'G major', 'F major', 'A major'],
    melody: { style: 'lyrical', low: 66, high: 88, baseVelocity: 82 }, harmony: { style: 'arpeggio', low: 45, high: 64, baseVelocity: 60 }, pad: true, bass: 'pulse', drums: 'rock',
    voices: { lead: { voice: 'pluck', volume: 78 }, harmony: { voice: 'pluck', volume: 46, pan: -20 }, pad: { voice: 'pad', volume: 40, pan: 14 }, bass: { voice: 'bass', volume: 78 }, ...acoustic } },
  battle: { about: 'Driving minor-key action cue with a busy lead and octave bass.', bpm: 152, keys: ['E minor', 'D minor', 'A minor', 'G minor'],
    melody: { style: 'driving', low: 67, high: 89, baseVelocity: 88, ornament: false }, harmony: { style: 'flowing', low: 46, high: 65, pedal: false, baseVelocity: 60 }, pad: true, bass: 'octaves', drums: 'rock',
    voices: { lead: { voice: 'pluck', volume: 82 }, harmony: { voice: 'pluck', volume: 40, pan: 22 }, pad: { voice: 'pad', volume: 42, pan: -12 }, bass: { voice: 'bass', volume: 80 }, ...kit } },
  ballad: { about: 'Slow, gentle piece: a simple tune over held arpeggios with a light beat.', bpm: 76, keys: ['F major', 'C major', 'A minor', 'D minor', 'G major'],
    melody: { style: 'lyrical', low: 65, high: 87, baseVelocity: 76, dynamics: 1.1 }, harmony: { style: 'arpeggio', low: 43, high: 63, baseVelocity: 54 }, pad: true, bass: 'roots', drums: 'ballad',
    voices: { lead: { voice: 'pluck', volume: 80 }, harmony: { voice: 'pluck', volume: 50, pan: -16 }, pad: { voice: 'pad', volume: 34, pan: 12 }, bass: { voice: 'bass', volume: 70 }, ...acoustic } },
  swing: { about: 'Easy swing: a laid-back tune, walking bass and a ride pattern.', bpm: 126, keys: ['F major', 'Bb major', 'C major', 'D minor'],
    melody: { style: 'swing', low: 64, high: 86, baseVelocity: 82 }, harmony: { style: 'block', low: 45, high: 62, baseVelocity: 56 }, bass: 'walking', drums: 'swing',
    voices: { lead: { voice: 'pluck', volume: 80 }, harmony: { voice: 'pad', volume: 44, pan: -16 }, bass: { voice: 'bass', volume: 82 },
      kick: acoustic.kick, snare: { voice: 'sample', factorySample: 'drums/snare_muffled01.ogg', volume: 34 }, hat: { voice: 'sample', factorySample: 'drums/ride01.ogg', volume: 20, pan: 20 }, crash: acoustic.crash } },
};
export const styleNames = Object.keys(styles);

// ---------- the piece ----------
export function composePiece({ style: styleName = 'adventure', key, bpm, bars, seconds, seed = 1, voices = {} } = {}) {
  const style = styles[styleName];
  if (!style) throw new Error(`Unknown style "${styleName}". Use one of: ${styleNames.join(', ')}`);
  const random = rng(seed + 11), tempo = bpm ?? style.bpm, keyName = key ?? random.pick(style.keys);
  if (bars !== undefined && seconds !== undefined) throw new Error('Give bars or seconds, not both');
  const total = bars ?? Math.max(8, Math.round((seconds ?? 60) * tempo / 240));
  if (total < 8 || total > 200) throw new Error('A piece needs between 8 and 200 bars');
  const intro = total >= 14 ? 2 : 0;
  const body = Math.floor((total - intro - 1) / 4) * 4, outro = total - intro - body;
  const progression = writeProgression({ key: keyName, bars: body, seed });
  const tonic = progression.chords.at(-1);
  const parsedKey = parseKey(keyName), sub = romanToChord(parsedKey.scale[2] === 3 ? 'iv' : 'IV', parsedKey);
  // The ending rests on the subdominant, then settles on the tonic.
  const chords = [...progression.chords.slice(0, intro), ...progression.chords, ...Array.from({ length: outro }, (_, i) => outro > 1 && i === 0 ? sub : tonic)];
  const shift = (notes, by) => notes.map(note => ({ ...note, tick: note.tick + by * BAR }));
  const melody = writeMelody({ key: keyName, chords: progression.chords, bars: body, seed, ...style.melody });
  const plan = melody.plan.map(p => ({ ...p, bar: p.bar + intro }));
  const lead = shift(melody.notes, intro);
  const finalChord = chordPlan([tonic], 1)[0][0];
  const home = lead.length ? lead.at(-1).midi : 72;
  let ending = home; for (let m = style.melody.low; m <= style.melody.high; m++) if (mod(m, 12) === finalChord.root && Math.abs(m - home) < Math.abs(ending - home) + (mod(ending, 12) === finalChord.root ? 0 : 99)) ending = m;
  lead.push({ tick: (total - 1) * BAR, length: BAR - 12, midi: ending, velocity: Math.max(40, style.melody.baseVelocity - 8) });
  const harmony = writeAccompaniment({ chords, bars: total, seed, plan, ...style.harmony }).notes;
  const pad = style.pad ? writeAccompaniment({ chords, bars: total, seed: seed + 1, plan, style: 'block', low: 45, high: 62, baseVelocity: 50 }).notes : null;
  const bass = writeBass({ chords, bars: total, seed, style: style.bass, plan }).notes.filter(note => note.tick >= intro * BAR || intro === 0);
  const drums = writeDrums({ bars: total, seed, style: style.drums, plan, quietBars: intro }).parts;
  const sound = { ...style.voices, ...voices };
  const track = (name, role, slot, notes) => notes?.length ? { name, role, pan: 0, ...sound[slot], patterns: [{ name, bar: 0, bars: total, notes: [...notes].sort((a, b) => a.tick - b.tick) }] } : null;
  const tracks = [track('Lead', 'lead', 'lead', lead), track('Harmony', 'harmony', 'harmony', harmony), track('Pad', 'texture', 'pad', pad), track('Bass', 'bass', 'bass', bass),
    track('Kick', 'drums', 'kick', drums.kick), track('Snare', 'drums', 'snare', drums.snare), track('Hat', 'drums', 'hat', drums.hat), track('Crash', 'drums', 'crash', drums.crash)].filter(Boolean);
  const sections = [...(intro ? [{ name: 'intro', startBar: 0, bars: intro }] : []), ...progression.sections.map(s => ({ name: s.name, startBar: s.bar + intro, bars: s.bars })), { name: 'ending', startBar: intro + body, bars: outro }];
  return { style: styleName, key: progression.key, bpm: tempo, seed, lengthBars: total, lengthSeconds: Number((total * 240 / tempo).toFixed(3)), masterVolume: 80,
    chords, sections, plan, motif: melody.motif, tune: tuneScore(melody.notes, melody.plan), tracks };
}

// A transparent score for the tune alone, from its notes. It rewards the habits of singable melodies; it cannot tell whether a tune is good.
export function tuneScore(notes, plan = []) {
  const main = notes.filter(note => note.length > 12);
  if (main.length < 4) return { score: 0, reasons: ['Too few notes to judge'] };
  const moves = main.slice(1).map((note, i) => Math.abs(note.midi - main[i].midi));
  const steps = moves.filter(m => m > 0 && m <= 2).length / moves.length, repeats = moves.filter(m => m === 0).length / moves.length;
  const range = Math.max(...main.map(n => n.midi)) - Math.min(...main.map(n => n.midi));
  const bars = Math.ceil((main.at(-1).tick + main.at(-1).length) / BAR);
  const sounding = main.reduce((sum, note) => sum + note.length, 0) / (bars * BAR);
  const rhythms = new Set(Array.from({ length: bars }, (_, b) => main.filter(n => Math.floor(n.tick / BAR) === b).map(n => Math.round((n.tick - b * BAR) / STEP)).join(','))).size / bars;
  const top = Math.max(...main.map(n => n.midi)), tops = main.filter(n => n.midi === top);
  const climax = plan.find(p => p.climax);
  const topInClimax = climax ? tops.some(n => n.tick >= climax.bar * BAR && n.tick < (climax.bar + climax.bars) * BAR) : true;
  const near = (value, lo, hi, slope) => value < lo ? Math.max(0, 1 - (lo - value) * slope) : value > hi ? Math.max(0, 1 - (value - hi) * slope) : 1;
  const parts = [
    ['Stepwise motion', 25 * near(steps, 0.45, 0.8, 3), `${Math.round(steps * 100)}% of moves are steps`],
    ['Range', 15 * near(range, 10, 21, 0.12), `${range} semitones`],
    ['Breathing room', 15 * near(sounding, 0.55, 0.88, 4), `sounding ${Math.round(sounding * 100)}% of the time`],
    ['Rhythmic variety', 15 * near(rhythms, 0.2, 0.6, 3), `${Math.round(rhythms * 100)}% of bars have their own rhythm`],
    ['One clear peak', 20 * (topInClimax ? near(tops.length, 1, 3, 0.25) : 0.3), `top note heard ${tops.length} time${tops.length === 1 ? '' : 's'}${topInClimax ? ' in the climax phrase' : ', outside the climax phrase'}`],
    ['Few repeated notes', 10 * near(repeats, 0, 0.18, 4), `${Math.round(repeats * 100)}% of moves repeat a note`],
  ];
  return { score: Math.round(parts.reduce((sum, [, points]) => sum + points, 0)), parts: parts.map(([name, points, detail]) => ({ name, points: Number(points.toFixed(1)), detail })) };
}

export function register({ tool, z, dsp, root, schemas, project, render, moduleGuidance }) {
  moduleGuidance.push('compose_piece writes a whole arranged piece from a style and a seed with no further composing calls, and compose_batch renders several seeds and ranks them by measured checks so a listener only needs to hear the best few. Both are plain code: use them for drafts and bulk work, then edit the winner.');
  const voice = z.object({ voice: z.enum(['pluck', 'bass', 'pad', 'kick', 'clap', 'hat', 'sample', 'preset']), preset: schemas.presetFile.optional(), factorySample: schemas.factorySample.optional(),
    sample: schemas.workspaceWav.optional(), volume: schemas.volume.optional(), pan: z.number().int().min(-100).max(100).optional() });
  const recipe = {
    style: z.enum(styleNames).default('adventure').describe(styleNames.map(name => `${name}: ${styles[name].about}`).join(' ')),
    key: z.string().min(1).max(30).optional().describe('Such as "D minor". Default: chosen from the style by the seed.'),
    bpm: z.number().min(45).max(240).optional(), seconds: z.number().min(10).max(600).optional(), bars: z.number().int().min(8).max(200).optional(),
    voices: z.record(z.enum(['lead', 'harmony', 'pad', 'bass', 'kick', 'snare', 'hat', 'crash']), voice).default({}).describe('Replace the sound of any part, for example {"lead": {"voice": "preset", "preset": "TripleOscillator/Square.xpf", "volume": 14}}.'),
  };
  async function build(options, output) {
    const piece = composePiece(options);
    const items = piece.tracks.map(item => schemas.track.parse(item));
    for (const item of items) await project.checkTrack(item);
    const doc = project.createSong(piece.bpm, items, piece.masterVolume);
    for (const item of items.filter(i => i.preset)) await project.loadPreset(doc, project.instrumentOf(doc, item.name), item.preset, { tuning: 'concert' });
    project.setAnchor(doc, piece.lengthBars);
    await project.save(doc, output);
    return { piece, doc };
  }
  const summary = piece => ({ style: piece.style, key: piece.key, bpm: piece.bpm, seed: piece.seed, lengthBars: piece.lengthBars, lengthSeconds: piece.lengthSeconds, chords: piece.chords.join(' '),
    sections: piece.sections, phrases: piece.plan.map(p => ({ bar: p.bar, bars: p.bars, role: p.role, climax: p.climax })), tune: piece.tune,
    tracks: piece.tracks.map(t => ({ name: t.name, role: t.role, notes: t.patterns[0].notes.length })) });

  tool('compose_piece', 'Write a complete arranged piece from a style and a seed in one call: chord progression, phrase-based melody, accompaniment, bass and drums, with an intro and an ending, saved as an editable project. Plain seeded code, so the same seed gives the same piece. Render it with render_mix, or use compose_batch to try many seeds.', {
    output: schemas.projectName, seed: z.number().int().min(1).max(2147483647).default(1), ...recipe,
  }, async ({ output, ...options }) => {
    const { piece } = await build(options, output);
    return { project: output, ...summary(piece), next: 'render_mix the project, analyze_audio with the sections, then edit any part with replace_pattern or change sounds with apply_preset.' };
  });

  tool('compose_batch', 'Compose several seeds of the same recipe, render each one, and rank them by measured checks: the arrangement lint, mix warnings from the render, and a tune score (stepwise motion, range, breathing room, rhythmic variety, one clear peak). Returns the ranking with reasons so a listener only needs to hear the top few. The scores catch faults; they cannot tell whether a tune is good.', {
    name: schemas.folderName.describe('Prefix for the files: <name>-s<seed>.mmp and .wav.'), count: z.number().int().min(2).max(24).default(6),
    seedStart: z.number().int().min(1).max(2147483000).default(1), targetLufs: schemas.loudnessTarget, ...recipe,
  }, async ({ name, count, seedStart, targetLufs, ...options }) => {
    const results = [];
    for (let seed = seedStart; seed < seedStart + count; seed++) {
      const file = `${name}-s${seed}`;
      const { piece, doc } = await build({ ...options, seed }, file + '.mmp');
      const lint = lintModel(modelFromDoc(await project.load(file + '.mmp'), project), { key: piece.key });
      const { wav } = await render.renderMix(doc, { tail: 'keep', targetLufs: targetLufs ?? -16, ceilingDb: -1.5 });
      await render.writeAudio(path.join(root, file + '.wav'), wav);
      const report = dsp.analyze(dsp.decodeWav(await readFile(path.join(root, file + '.wav'))));
      const warnings = dsp.advise(report, { targetLufs: targetLufs ?? -16 });
      const quality = qualityScore(lint, { audioWarnings: warnings, silent: report.integratedLufs === null });
      results.push({ seed, project: file + '.mmp', audio: file + '.wav', key: piece.key, score: Math.round(quality.score * 0.5 + piece.tune.score * 0.5),
        arrangementAndMix: quality.score, tune: piece.tune.score, integratedLufs: report.integratedLufs, truePeakDbfs: report.truePeakDbfs,
        findings: lint.findings.slice(0, 4).map(f => f.message ?? f), mixWarnings: warnings, tuneParts: piece.tune.parts });
    }
    results.sort((a, b) => b.score - a.score);
    return { recipe: { ...options, count, seedStart }, ranking: results.map((r, i) => ({ rank: i + 1, ...r })), next: `Listen to ${results[0].audio} first. Build an audition page with build_audition_page to collect notes, then edit the winner.` };
  });
}
