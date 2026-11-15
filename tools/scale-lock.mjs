// Scale lock, arpeggiator and note probability: three small note transforms for a track.
// scale_lock snaps notes to a key, arpeggiate spreads chords into arpeggios, note_probability drops or softens notes
// at random (with a seed) so repeated parts do not sound machine-identical.

import { seeded } from './performance.mjs';

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  'natural-minor': [0, 2, 3, 5, 7, 8, 10],
  'harmonic-minor': [0, 2, 3, 5, 7, 8, 11],
  'melodic-minor': [0, 2, 3, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  'major-pentatonic': [0, 2, 4, 7, 9],
  'minor-pentatonic': [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  'whole-tone': [0, 2, 4, 6, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
export const SCALE_ALIASES = { minor: 'natural-minor', ionian: 'major', aeolian: 'natural-minor', 'pentatonic-major': 'major-pentatonic', 'pentatonic-minor': 'minor-pentatonic' };

const NOTE_NAMES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// "D", "F#", "Bb", "c" or a pitch class number 0 to 11 -> 0 to 11.
export function parseRoot(root) {
  if (typeof root === 'number') {
    if (!Number.isInteger(root) || root < 0 || root > 11) throw new Error('root must be 0 to 11 or a note name such as D or F#');
    return root;
  }
  const match = /^([A-Ga-g])([#b♯♭]?)$/.exec(String(root).trim());
  if (!match) throw new Error(`Unknown root "${root}". Use a note name such as D, F# or Bb.`);
  let pc = NOTE_NAMES[match[1].toUpperCase()];
  if (match[2] === '#' || match[2] === '♯') pc += 1;
  if (match[2] === 'b' || match[2] === '♭') pc -= 1;
  return (pc + 12) % 12;
}

// The set of pitch classes (0 to 11) in a scale on a root.
export function scalePitchClasses(root, scale) {
  const name = SCALE_ALIASES[scale] || scale;
  const steps = SCALES[name];
  if (!steps) throw new Error(`Unknown scale "${scale}". Choose from: ${Object.keys(SCALES).join(', ')}.`);
  const r = parseRoot(root);
  return new Set(steps.map(s => (r + s) % 12));
}

// Move one MIDI note into the scale. 'nearest' goes to the closest scale note (a tie goes down), 'down' and 'up' always
// move in that direction. Notes already in the scale never move.
export function snapNote(midi, pcs, policy = 'nearest') {
  if (pcs.has(((midi % 12) + 12) % 12)) return midi;
  for (let d = 1; d <= 12; d++) {
    const below = pcs.has((((midi - d) % 12) + 12) % 12), above = pcs.has((((midi + d) % 12) + 12) % 12);
    if (policy === 'down') { if (below) return midi - d; }
    else if (policy === 'up') { if (above) return midi + d; }
    else if (below) return midi - d;
    else if (above) return midi + d;
  }
  return midi;
}

// notes: [{ tick, midi }] with absolute ticks. Returns the new pitch for every note, in order, and a report.
export function lockScale(notes, { root, scale, policy = 'nearest', strong = 'all', beatTicks = 48, ticksPerBar = 192 } = {}) {
  const pcs = scalePitchClasses(root, scale);
  const isStrong = tick => strong === 'all' || (strong === 'beat' && tick % beatTicks === 0) || (strong === 'bar' && tick % ticksPerBar === 0);
  let outside = 0, moved = 0, skipped = 0;
  const byDistance = {};
  const midis = notes.map(n => {
    const inScale = pcs.has(((n.midi % 12) + 12) % 12);
    if (!inScale) outside++;
    if (inScale) return n.midi;
    if (!isStrong(n.tick)) { skipped++; return n.midi; }
    const next = snapNote(n.midi, pcs, policy);
    if (next !== n.midi) { moved++; const key = String(next - n.midi); byDistance[key] = (byDistance[key] || 0) + 1; }
    return next;
  });
  return { midis, report: { notes: notes.length, outsideScale: outside, moved, leftOnWeakBeats: skipped, byDistance } };
}

// A cycle of indices into the sorted chord pitches (0 = lowest).
export function arpeggioOrder(pattern, count) {
  if (count <= 1) return [0];
  const up = Array.from({ length: count }, (_, i) => i);
  if (pattern === 'up') return up;
  if (pattern === 'down') return up.slice().reverse();
  if (pattern === 'updown') return count === 2 ? [0, 1] : [...up, ...up.slice(1, -1).reverse()];
  if (pattern === 'broken') { // low, top, next, top, next, top ...: the Alberti figure for a triad
    const order = [];
    for (let i = 0; i < count - 1; i++) order.push(i, count - 1);
    return order.length ? order : up;
  }
  throw new Error(`Unknown arpeggio pattern "${pattern}"`);
}

// Group notes that start on the same tick. Returns groups of indices into `notes`, in time order.
export function findChords(notes, minNotes = 3) {
  const byTick = new Map();
  notes.forEach((n, i) => { if (n.length > 0) { if (!byTick.has(n.tick)) byTick.set(n.tick, []); byTick.get(n.tick).push(i); } });
  return [...byTick.entries()].sort((a, b) => a[0] - b[0]).map(([, indices]) => indices).filter(g => g.length >= minNotes);
}

// Spread chords into arpeggios. notes: [{ tick, length, midi, velocity }]. Returns the chords replaced, each with its
// source indices and new notes, so a caller can rewrite a project. Every pitch of a chord is played at least once when the
// chord is long enough for that many steps (report.shortChords counts the ones that are not).
export function arpeggiate(notes, { pattern = 'up', rate = 12, gate = 0.9, octaves = 1, seed = 1, minNotes = 3 } = {}) {
  if (!(rate > 0)) throw new Error('rate must be above 0');
  const random = seeded(seed);
  const replaced = [];
  let shortChords = 0;
  for (const indices of findChords(notes, minNotes)) {
    const chord = indices.map(i => notes[i]).sort((a, b) => a.midi - b.midi || b.velocity - a.velocity);
    const pitches = [];
    for (let o = 0; o < octaves; o++) for (const n of chord) pitches.push({ midi: n.midi + 12 * o, velocity: n.velocity });
    const start = chord[0].tick, span = Math.max(...chord.map(n => n.length));
    const steps = Math.max(1, Math.ceil(span / rate - 1e-9));
    if (steps < pitches.length) shortChords++;
    const order = pattern === 'random' ? null : arpeggioOrder(pattern, pitches.length);
    const out = [];
    let previous = -1;
    for (let s = 0; s < steps; s++) {
      let index;
      if (order) index = order[s % order.length];
      else if (s < pitches.length) { // random, but visit every pitch once before repeating
        index = -1;
      } else { index = Math.floor(random() * pitches.length); if (index === previous && pitches.length > 1) index = (index + 1) % pitches.length; }
      out.push(index);
      previous = index;
    }
    if (!order) { // fill the first pitches.length steps with a shuffle so none is missed
      const deck = pitches.map((_, i) => i);
      for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
      let d = 0;
      for (let s = 0; s < out.length; s++) if (out[s] === -1) out[s] = deck[d++];
    }
    const made = out.map((index, s) => {
      const tick = start + Math.round(s * rate);
      const full = Math.min(Math.round(rate), start + span - tick);
      return { tick, length: Math.max(1, Math.round(full * Math.min(1, gate))), midi: pitches[index].midi, velocity: pitches[index].velocity };
    });
    replaced.push({ indices, notes: made });
  }
  return { replaced, report: { chords: replaced.length, notesBefore: replaced.reduce((a, r) => a + r.indices.length, 0), notesAfter: replaced.reduce((a, r) => a + r.notes.length, 0), shortChords } };
}

// Per-note chance of being dropped and a small velocity change. Deterministic for a seed. Notes on the first beat of a bar
// are kept when protectDownbeats is set, and at least one note always survives.
export function noteProbability(notes, { dropChance = 0.1, velocityVariation = 0.1, protectDownbeats = true, seed = 1, ticksPerBar = 192, velocityCeiling = 127 } = {}) {
  const random = seeded(seed);
  const result = notes.map(n => {
    const dropRoll = random(), velocityRoll = random();
    const protectedNote = protectDownbeats && n.tick % ticksPerBar === 0;
    const keep = protectedNote || dropRoll >= dropChance;
    const velocity = Math.min(velocityCeiling, Math.max(1, Math.round(n.velocity * (1 + (velocityRoll * 2 - 1) * velocityVariation))));
    return { keep, velocity };
  });
  if (notes.length && !result.some(r => r.keep)) result[0].keep = true;
  const dropped = result.filter(r => !r.keep).length;
  return { notes: result, report: { notes: notes.length, dropped, kept: notes.length - dropped } };
}

export function register({ edit, z, project, moduleGuidance }) {
  moduleGuidance.push('Use scale_lock on a melody or solo that sounds wrong or "off key": give the key and scale. Use arpeggiate to turn block chords into arpeggios, and note_probability for small seeded variation on looping parts. All three skip drum tracks unless you name them.');

  // The instrument tracks to work on: named tracks, or every pitched track with notes.
  function chooseTracks(doc, names) {
    const withNotes = project.tracks(doc).filter(t => t.getAttribute('type') === '0' && project.children(t, 'pattern').length);
    if (names?.length) {
      const missing = names.filter(name => !withNotes.some(t => t.getAttribute('name') === name));
      if (missing.length) throw new Error('No instrument track with notes named ' + missing.join(', '));
      return withNotes.filter(t => names.includes(t.getAttribute('name')));
    }
    const chosen = withNotes.filter(t => project.trackRole(t) !== 'drums');
    if (!chosen.length) throw new Error('There are no pitched instrument tracks with notes. Name the tracks to change.');
    return chosen;
  }
  // Notes of one clip, with absolute ticks and the element they came from. Step-sequencer triggers (length 0) are left alone.
  function clipNotes(clip) {
    const base = Number(clip.getAttribute('pos'));
    const list = [];
    for (const element of project.children(clip, 'note')) {
      const length = Number(element.getAttribute('len'));
      if (!(length > 0)) continue;
      list.push({ element, tick: base + Number(element.getAttribute('pos')), length, midi: Number(element.getAttribute('key')) + 12, velocity: Number(element.getAttribute('vol') || 100) });
    }
    return { base, list };
  }
  const trackSchema = z.array(z.string().min(1).max(100)).max(48).optional().describe('Tracks to change. Default: every pitched instrument track with notes (drum tracks are skipped).');

  edit('scale_lock', 'Snap the notes of a track to a key and scale so nothing sounds out of key. Notes already in the scale never move. Choose nearest (closest scale note, ties go down), down or up, and whether to touch every note or only those on a beat or bar start. Returns how many notes moved.', {
    tracks: trackSchema,
    root: z.string().min(1).max(3).describe('Key note, such as D, F# or Bb.'),
    scale: z.string().min(2).max(30).describe('Scale: ' + Object.keys(SCALES).join(', ') + ', or minor/ionian/aeolian.'),
    policy: z.enum(['nearest', 'down', 'up']).default('nearest'),
    strong: z.enum(['all', 'beat', 'bar']).default('all').describe('all: every note. beat: only notes that start on a beat. bar: only notes that start a bar. Others are left alone.'),
  }, (doc, { tracks: names, root, scale, policy, strong }) => {
    const info = project.songInfo(doc);
    const beatTicks = 192 / info.meter[1];
    const total = { notes: 0, outsideScale: 0, moved: 0, leftOnWeakBeats: 0, byDistance: {} };
    for (const track of chooseTracks(doc, names)) {
      for (const clip of project.children(track, 'pattern')) {
        const { list } = clipNotes(clip);
        const { midis, report } = lockScale(list, { root, scale, policy, strong, beatTicks, ticksPerBar: info.ticksPerBar });
        list.forEach((n, i) => { if (midis[i] !== n.midi) n.element.setAttribute('key', String(midis[i] - 12)); });
        for (const k of ['notes', 'outsideScale', 'moved', 'leftOnWeakBeats']) total[k] += report[k];
        for (const [d, c] of Object.entries(report.byDistance)) total.byDistance[d] = (total.byDistance[d] || 0) + c;
      }
    }
    return { scaleLock: { root, scale, policy, strong, ...total } };
  }, { checked: true });

  edit('arpeggiate', 'Turn chords (three or more notes starting together) on a track into arpeggios. Patterns: up, down, updown, broken (low, top, next, top), random (seeded, every note once before repeats). Rate is in ticks (192 per whole note, 48 per quarter, 12 per sixteenth). Each chord keeps its start and length; every pitch plays at least once when the chord is long enough.', {
    tracks: trackSchema,
    pattern: z.enum(['up', 'down', 'updown', 'broken', 'random']).default('up'),
    rate: z.number().min(3).max(192).default(12).describe('Ticks between arpeggio notes. 12 is a sixteenth note, 24 an eighth.'),
    gate: z.number().min(0.1).max(1).default(0.9).describe('Fraction of each step that a note sounds.'),
    octaves: z.number().int().min(1).max(3).default(1).describe('Octaves the arpeggio climbs through.'),
    minNotes: z.number().int().min(2).max(8).default(3).describe('Smallest group of simultaneous notes treated as a chord.'),
    seed: z.number().int().min(1).max(2147483647).default(1),
  }, (doc, { tracks: names, pattern, rate, gate, octaves, minNotes, seed }) => {
    const info = project.songInfo(doc);
    const total = { chords: 0, notesBefore: 0, notesAfter: 0, shortChords: 0 };
    for (const track of chooseTracks(doc, names)) {
      for (const clip of project.children(track, 'pattern')) {
        const { base, list } = clipNotes(clip);
        const { replaced, report } = arpeggiate(list, { pattern, rate, gate, octaves, minNotes, seed });
        for (const { indices, notes } of replaced) {
          const template = list[indices[0]].element;
          const parent = template.parentNode;
          const anchor = list[indices[indices.length - 1]].element.nextSibling;
          for (const i of indices) parent.removeChild(list[i].element);
          for (const n of notes) {
            const element = template.cloneNode(true);
            element.setAttribute('pos', String(n.tick - base));
            element.setAttribute('len', String(n.length));
            element.setAttribute('key', String(n.midi - 12));
            element.setAttribute('vol', String(Math.min(200, n.velocity)));
            parent.insertBefore(element, anchor);
          }
          const end = Math.max(...notes.map(n => n.tick + n.length)) - base;
          const needed = Math.ceil(end / info.ticksPerBar) * info.ticksPerBar;
          if (needed > Number(clip.getAttribute('len'))) clip.setAttribute('len', String(needed));
        }
        for (const k of Object.keys(total)) total[k] += report[k];
      }
    }
    if (!total.chords) throw new Error(`No chords found: arpeggiate needs ${minNotes} or more notes starting on the same tick. Try minNotes 2.`);
    return { arpeggio: { pattern, rate, ...total } };
  }, { checked: true });

  edit('note_probability', 'Give a part small random variation with a fixed seed: each note has a chance of being dropped and its velocity moves a little. Notes on the first beat of a bar are kept by default and at least one note always survives. Useful on loops that repeat many times.', {
    tracks: trackSchema,
    dropChance: z.number().min(0).max(0.9).default(0.1).describe('Chance that each note is dropped, 0 to 0.9.'),
    velocityVariation: z.number().min(0).max(0.5).default(0.1).describe('Velocity moves up or down by up to this fraction.'),
    protectDownbeats: z.boolean().default(true).describe('Never drop a note that starts a bar.'),
    seed: z.number().int().min(1).max(2147483647).default(1),
    velocityCeiling: z.number().int().min(1).max(200).default(127),
  }, (doc, { tracks: names, dropChance, velocityVariation, protectDownbeats, seed, velocityCeiling }) => {
    const info = project.songInfo(doc);
    const total = { notes: 0, dropped: 0, kept: 0 };
    let n = 0;
    for (const track of chooseTracks(doc, names)) {
      for (const clip of project.children(track, 'pattern')) {
        const { list } = clipNotes(clip);
        if (!list.length) continue;
        const { notes, report } = noteProbability(list, { dropChance, velocityVariation, protectDownbeats, seed: seed + n++, ticksPerBar: info.ticksPerBar, velocityCeiling });
        list.forEach((note, i) => {
          if (!notes[i].keep) note.element.parentNode.removeChild(note.element);
          else note.element.setAttribute('vol', String(notes[i].velocity));
        });
        for (const k of Object.keys(total)) total[k] += report[k];
      }
    }
    return { noteProbability: { dropChance, velocityVariation, seed, ...total } };
  }, { checked: true });
}
