// Phrase library: reusable chord progressions, piano figures, bass lines, hooks and percussion grooves.
// Pitched phrases are stored against the chord (root, third, fifth, seventh) or the scale degree, never as fixed
// pitches, so one phrase fits any key and any progression. Shipped phrases live in phrases.json; a listener's own
// phrases, ratings and a record of where each phrase was used live in .lmms-phrases.json in the workspace.
import { readFileSync } from 'node:fs';
import { lstat, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { parseChord, voiceChord } from '../music.mjs';
import { parseKey } from './motif.mjs';
import { parseProgression, chordSpans } from './blueprints.mjs';

const library = JSON.parse(readFileSync(new URL('./phrases.json', import.meta.url), 'utf8'));
export const shippedPhrases = library.phrases;
export const soundDefaults = library.sounds;
export const storeFile = '.lmms-phrases.json';
export const phraseKinds = ['progression', 'harmonic', 'rhythm'];
const phraseRoles = ['drums', 'bass', 'harmony', 'lead', 'counter', 'texture', 'fx'];
const idPattern = /^[a-z0-9][a-z0-9-]{1,59}$/;
const barTicks = 192;
const mod = (a, n) => ((a % n) + n) % n;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
function random(seed) {
  let state = seed >>> 0 || 1;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

// ---------- tones ----------
// r (or 1), 3, 5, 7, 9: tones of the chord sounding at that moment. On a triad the 7 becomes the octave.
// s1 to s7: degrees of the key's scale, for tunes that follow the key rather than the chords.
// ~n: n semitones above the chord root, for notes outside the chord. v: the whole chord, voice-led from the last one.
// Each ' raises a tone an octave and each , lowers it.
const tonePattern = /^(v|r|1|3|5|7|9|s[1-7]|~\d{1,2})([',]*)$/;
export function parseTone(token) {
  const match = tonePattern.exec(token);
  if (!match) throw new Error(`Cannot read tone "${token}". Use r, 3, 5, 7, 9, s1 to s7, ~semitones or v, with ' or , for octaves.`);
  let octave = 0;
  for (const mark of match[2]) octave += mark === "'" ? 1 : -1;
  const name = match[1] === '1' ? 'r' : match[1];
  return { name, octave };
}
const within = (intervals, low, high, fallback) => intervals.find(i => i >= low && i <= high) ?? fallback;
export function chordInterval(chord, name) {
  if (name === 'r') return 0;
  if (name === '3') return within(chord.intervals, 2, 5, 7);
  if (name === '5') return within(chord.intervals, 6, 8, 7);
  if (name === '7') return within(chord.intervals, 9, 11, 12);
  if (name === '9') return 14;
  if (name[0] === '~') return Number(name.slice(1));
  throw new Error(`"${name}" is not a chord tone`);
}

// ---------- reading a phrase ----------
// line: "step=tone+tone:length[:velocity][>]; ..." with step and length in grid steps. A trailing > takes the tones
// from the chord one beat later, which is how a montuno or a tumbao bass arrives early on the next chord.
// seq: tones one after another, `rate` steps each, "-" for a rest, repeated to fill the phrase.
export function phraseEvents(phrase) {
  const stepsPerBar = phrase.stepsPerBar ?? 16, total = (phrase.bars ?? 1) * stepsPerBar;
  const events = [];
  if (phrase.line) {
    for (const part of phrase.line.split(';').map(s => s.trim()).filter(Boolean)) {
      const match = /^(\d+)=([^:]+):(\d+(?:\.\d+)?)(?::(\d+))?(>)?$/.exec(part);
      if (!match) throw new Error(`Cannot read phrase event "${part}". Use step=tones:length, step=tones:length:velocity or add > to play the next chord early.`);
      const step = Number(match[1]);
      if (step >= total) throw new Error(`Event "${part}" starts at step ${step}, but the phrase has ${total} steps`);
      events.push({ step, tones: match[2].split('+').map(parseTone), length: Number(match[3]), velocity: Number(match[4] ?? 90), ahead: Boolean(match[5]) });
    }
  } else if (phrase.seq) {
    const tokens = phrase.seq.trim().split(/\s+/), rate = phrase.rate ?? 1, accents = phrase.accents?.length ? phrase.accents : [90];
    if (!Number.isInteger(total / rate)) throw new Error('The phrase length must be a whole number of seq steps');
    for (let i = 0; i * rate < total; i++) {
      const token = tokens[i % tokens.length];
      if (token === '-') continue;
      events.push({ step: i * rate, tones: token.split('+').map(parseTone), length: rate, velocity: accents[i % accents.length], ahead: false });
    }
  } else throw new Error('A pitched phrase needs a line or a seq');
  if (!events.length) throw new Error('The phrase has no notes');
  return events.sort((a, b) => a.step - b.step);
}
const gridChars = /^[Xxog.\-_]+$/;
export function phraseVoices(phrase) {
  const stepsPerBar = phrase.stepsPerBar ?? 16, total = (phrase.bars ?? 1) * stepsPerBar;
  const voices = Object.entries(phrase.voices ?? {}).map(([sound, grid]) => ({ sound, grid: String(grid).replace(/[\s|]/g, '') }));
  if (!voices.length) throw new Error('A rhythm phrase needs voices');
  for (const v of voices) {
    if (!gridChars.test(v.grid)) throw new Error(`Voice "${v.sound}": grids use X (accent), x (hit), o (soft), g (ghost) and - (rest)`);
    if (v.grid.length !== total) throw new Error(`Voice "${v.sound}" has ${v.grid.length} steps; the phrase needs ${total}`);
    if (!/[Xxog]/.test(v.grid)) throw new Error(`Voice "${v.sound}" never plays`);
  }
  return voices;
}
export function validatePhrase(phrase) {
  if (!phrase || typeof phrase !== 'object') throw new Error('A phrase is an object');
  if (!idPattern.test(phrase.id ?? '')) throw new Error(`Phrase id "${phrase.id}" must be lower-case letters, digits and hyphens, 2 to 60 characters`);
  if (!phraseKinds.includes(phrase.kind)) throw new Error(`Phrase "${phrase.id}": kind must be one of ${phraseKinds.join(', ')}`);
  if (typeof phrase.name !== 'string' || !phrase.name.trim()) throw new Error(`Phrase "${phrase.id}" needs a name`);
  if (phrase.kind === 'progression') {
    parseProgression(phrase.roman, parseKey(`C ${phrase.mode ?? 'major'}`));
    return phrase;
  }
  if (!phraseRoles.includes(phrase.role)) throw new Error(`Phrase "${phrase.id}": role must be one of ${phraseRoles.join(', ')}`);
  const bars = phrase.bars ?? 1, stepsPerBar = phrase.stepsPerBar ?? 16;
  if (!Number.isInteger(bars) || bars < 1 || bars > 8) throw new Error(`Phrase "${phrase.id}": bars must be 1 to 8`);
  if (barTicks % stepsPerBar) throw new Error(`Phrase "${phrase.id}": stepsPerBar must divide 192`);
  if (phrase.kind === 'rhythm') phraseVoices(phrase); else phraseEvents(phrase);
  return phrase;
}

// ---------- rendering ----------
const nearest = (pc, centre) => { const base = centre + mod(pc - centre, 12); return base - centre > 6 ? base - 12 : base; };
// Chord spans: [{ symbol, tick, ticks }] covering the pattern. Returns notes in ticks from the pattern start.
export function renderPitched(phrase, { spans, bars, key, octave = 4, stretch = 1, velocity = 1, variation = 0, seed = 1, bassRoot = false }) {
  const events = phraseEvents(phrase), stepTicks = barTicks / (phrase.stepsPerBar ?? 16) * stretch;
  if (!Number.isInteger(stepTicks)) throw new Error('That stretch does not fit the phrase grid');
  const phraseTicks = (phrase.bars ?? 1) * barTicks * stretch, total = bars * barTicks;
  const chords = spans.map(span => ({ ...span, chord: parseChord(span.symbol) }));
  if (!chords.length) throw new Error('No chords to play the phrase over');
  const rootOf = c => (bassRoot ? c.chord.bass ?? c.chord.root : c.chord.root);
  const centre = (octave + 1) * 12 + rootOf(chords[0]);
  let previous;
  for (const c of chords) {
    c.base = nearest(rootOf(c), centre);
    c.voiced = previous = voiceChord(c.chord, { octave, previous });
  }
  const tonic = key ? nearest(key.tonic, centre) : null;
  const chordAt = tick => chords.find(c => mod(tick, total) >= c.tick && mod(tick, total) < c.tick + c.ticks) ?? chords.at(-1);
  const next = random(seed), notes = [], seen = new Set();
  for (let start = 0; start < total; start += phraseTicks) {
    for (const event of events) {
      const tick = start + event.step * stepTicks;
      if (tick >= total) continue;
      const c = chordAt(event.ahead ? tick + 48 * stretch : tick);
      const length = Math.max(1, Math.min(Math.round(event.length * stepTicks * 0.96), total - tick));
      const loud = clamp(Math.round(event.velocity * velocity + (variation ? (next() - 0.5) * 28 * variation : 0)), 1, 200);
      for (const tone of event.tones) {
        let pitches;
        if (tone.name === 'v') pitches = c.voiced;
        else if (tone.name[0] === 's') {
          if (!key) throw new Error(`Phrase "${phrase.id}" uses scale degrees, so it needs a key`);
          pitches = [tonic + key.scale[Number(tone.name[1]) - 1]];
        } else pitches = [c.base + chordInterval(c.chord, tone.name)];
        for (let midi of pitches) {
          midi += tone.octave * 12;
          while (midi < 24) midi += 12;
          while (midi > 108) midi -= 12;
          if (seen.has(`${tick}:${midi}`)) continue;
          seen.add(`${tick}:${midi}`);
          notes.push({ tick, length, midi, velocity: loud });
        }
      }
    }
  }
  return notes.sort((a, b) => a.tick - b.tick || a.midi - b.midi);
}
// Roman numerals of a progression phrase as chord symbols in a key.
export function progressionIn(phrase, keyInput) {
  const key = parseKey(keyInput);
  return parseProgression(phrase.roman, key).map(p => p.symbol + (p.bars ? ':' + p.bars : '')).join(' ');
}

// ---------- capture ----------
// Turn notes played over known chords into a line, so a figure written for one song can be reused in any key.
export function capturePhrase(notes, { spans, bars, stepsPerBar = 16 }) {
  if (!notes.length) throw new Error('There are no notes to capture');
  const stepTicks = barTicks / stepsPerBar, total = bars * barTicks;
  const off = notes.find(n => mod(n.tick, stepTicks) > 2 && mod(n.tick, stepTicks) < stepTicks - 2);
  if (off) throw new Error(`A note at tick ${off.tick} is not on a ${stepsPerBar}-per-bar grid. Try stepsPerBar 12, 24, 32 or 48.`);
  const chords = spans.map(span => ({ ...span, chord: parseChord(span.symbol) }));
  const sorted = notes.map(n => n.midi).sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)];
  let octave = Math.floor((median - chords[0].chord.root) / 12) - 1;
  octave = clamp(octave, 0, 7);
  const centre = (octave + 1) * 12 + chords[0].chord.root;
  const chordAt = tick => chords.find(c => tick >= c.tick && tick < c.tick + c.ticks) ?? chords.at(-1);
  const groups = new Map();
  for (const n of notes) {
    if (n.tick >= total) continue;
    const step = Math.round(n.tick / stepTicks), c = chordAt(n.tick), offset = n.midi - nearest(c.chord.root, centre);
    const up = Math.floor(offset / 12), inside = offset - up * 12;
    const name = ['r', '3', '5', '7'].find(t => chordInterval(c.chord, t) === inside) ?? `~${inside}`;
    const token = name + (up > 0 ? "'".repeat(up) : ','.repeat(-up));
    const length = Math.max(1, Math.round(n.length / stepTicks * 4) / 4);
    const id = `${step}:${length}:${n.velocity}`;
    if (!groups.has(id)) groups.set(id, { step, length, velocity: n.velocity, tones: [] });
    groups.get(id).tones.push(token);
  }
  const line = [...groups.values()].sort((a, b) => a.step - b.step).map(g => `${g.step}=${g.tones.join('+')}:${g.length}:${g.velocity}`).join('; ');
  return { line, octave, stepsPerBar, bars };
}

// ---------- the listener's store ----------
const emptyStore = () => ({ version: 1, phrases: [], ratings: {}, uses: {} });
export function readStore(text) {
  if (text === null || text === undefined) return emptyStore();
  let data;
  try { data = JSON.parse(text); } catch (error) { throw new Error(`${storeFile} is not valid JSON (${error.message}). Fix or rename the file; nothing was changed.`); }
  if (!data || data.version !== 1 || !Array.isArray(data.phrases) || typeof data.ratings !== 'object' || typeof data.uses !== 'object') {
    throw new Error(`${storeFile} is not a version 1 phrase file. Fix or rename the file; nothing was changed.`);
  }
  return data;
}
export function allPhrases(store) {
  const shippedIds = new Set(shippedPhrases.map(p => p.id));
  return [...shippedPhrases.map(p => ({ ...p, source: 'shipped' })), ...store.phrases.filter(p => !shippedIds.has(p.id)).map(p => ({ ...p, source: 'yours' }))];
}
export function findPhrase(store, id) {
  const found = allPhrases(store).find(p => p.id === id);
  if (!found) throw new Error(`Unknown phrase "${id}". Call list_phrases to see the ids.`);
  return found;
}
export function summarise(phrase, store, key) {
  const uses = store.uses[phrase.id] ?? [], rating = store.ratings[phrase.id];
  return {
    id: phrase.id, name: phrase.name, kind: phrase.kind, ...(phrase.role ? { role: phrase.role } : {}), ...(phrase.instrument ? { instrument: phrase.instrument } : {}),
    styles: phrase.styles ?? [], ...(phrase.kind === 'progression' ? { roman: phrase.roman, mode: phrase.mode ?? 'major', ...(key ? { chords: progressionIn(phrase, key) } : {}) }
      : { bars: phrase.bars ?? 1, stepsPerBar: phrase.stepsPerBar ?? 16 }),
    ...(phrase.kind === 'rhythm' ? { sounds: Object.keys(phrase.voices) } : {}),
    rating: rating?.rating ?? null, ...(rating?.note ? { ratingNote: rating.note } : {}), uses: uses.length, ...(uses.length ? { lastUsed: uses.at(-1).at } : {}),
    source: phrase.source, description: phrase.description ?? '',
  };
}
// Best rated first, then the ones used least, so a library does not keep handing back the same figure.
export function rankPhrases(rows) {
  const score = r => (r.rating === null ? 3 : r.rating);
  return [...rows].sort((a, b) => score(b) - score(a) || a.uses - b.uses || a.id.localeCompare(b.id));
}

// ---------- arranging ----------
const roleDefaults = {
  bass: { voice: 'bass', volume: 70, octave: 2 }, harmony: { voice: 'pluck', volume: 50, octave: 4 }, lead: { voice: 'pluck', volume: 60, octave: 5 },
  counter: { voice: 'pluck', volume: 42, octave: 4 }, texture: { voice: 'pluck', volume: 34, octave: 5 }, fx: { voice: 'pluck', volume: 30, octave: 5 }, drums: { voice: 'pluck', volume: 50, octave: 4 },
};
const title = text => text.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
// sections: [{ name, startBar, bars, spans }]. sounds: resolved map from sound name to { sample | factorySample, midi, volume, length }.
// Returns track objects ready for the server's track schema.
export function buildTracks({ parts, sections, key, sounds, lookup }) {
  const tracks = new Map(), used = [];
  const claim = (name, base) => {
    if (!tracks.has(name)) tracks.set(name, { ...base, name, patterns: [] });
    return tracks.get(name);
  };
  const place = (target, section, pattern) => {
    if (target.patterns.some(p => p.bar === section.startBar)) throw new Error(`Two parts write to track "${target.name}" in section "${section.name}". Give one of them another name or another section.`);
    target.patterns.push({ name: section.name, bar: section.startBar, bars: section.bars, ...pattern });
  };
  parts.forEach((part, index) => {
    const phrase = lookup(part.phrase);
    if (phrase.kind === 'progression') throw new Error(`"${phrase.id}" is a progression. Pass it as progression, not as a part.`);
    const wanted = part.sections ? sections.filter(s => part.sections.includes(s.name)) : sections;
    const missing = (part.sections ?? []).filter(name => !sections.some(s => s.name === name));
    if (missing.length) throw new Error(`Part ${index + 1} names unknown section ${missing.join(', ')}`);
    const stretch = part.stretch ?? 1;
    used.push(phrase.id);
    if (phrase.kind === 'rhythm') {
      const stepsPerBar = (phrase.stepsPerBar ?? 16) / stretch;
      if (!Number.isInteger(stepsPerBar) || barTicks % stepsPerBar) throw new Error(`Stretch ${stretch} does not fit the grid of "${phrase.id}"`);
      for (const voice of phraseVoices(phrase)) {
        const sound = sounds[voice.sound];
        if (!sound) throw new Error(`Phrase "${phrase.id}" uses the sound "${voice.sound}". Pass sounds: { "${voice.sound}": { sample or factorySample } }.`);
        const target = claim(title(voice.sound), { voice: 'sample', ...(sound.sample ? { sample: sound.sample } : { factorySample: sound.factorySample }), rootMidi: 69, role: 'drums',
          volume: clamp(Math.round(sound.volume * (part.gain ?? 1)), 0, 200), pan: sound.pan ?? 0 });
        for (const section of wanted) {
          place(target, section, { steps: { grid: voice.grid, stepsPerBar, length: sound.length, ...(sound.midi !== 69 ? { midi: sound.midi } : {}),
            ...(part.variation ? { humanize: Math.round(part.variation * 16), seed: (part.seed ?? 1) + section.startBar } : {}) } });
        }
      }
      return;
    }
    const role = part.role ?? phrase.role, defaults = roleDefaults[role];
    const voice = part.voice ?? (part.preset ? 'preset' : part.sample || part.factorySample ? 'sample' : defaults.voice);
    const target = claim(part.name ?? phrase.name, { voice, ...(part.preset ? { preset: part.preset } : {}), ...(part.sample ? { sample: part.sample } : {}),
      ...(part.factorySample ? { factorySample: part.factorySample } : {}), rootMidi: part.rootMidi ?? 69, role, volume: part.volume ?? defaults.volume, pan: part.pan ?? 0 });
    for (const section of wanted) {
      place(target, section, { notes: renderPitched(phrase, { spans: section.spans, bars: section.bars, key, octave: part.octave ?? phrase.octave ?? defaults.octave, stretch,
        velocity: part.velocity ?? 1, variation: part.variation ?? 0, seed: (part.seed ?? 1) + section.startBar, bassRoot: role === 'bass' }) });
    }
  });
  const list = [...tracks.values()];
  for (const t of list) t.patterns.sort((a, b) => a.bar - b.bar);
  return { tracks: list, used: [...new Set(used)] };
}
export function layoutSections(sections, { key, progression, barsPerChord = 1, lookup }) {
  let at = 0;
  const resolve = text => {
    let source = text;
    if (idPattern.test(text) && !/^[a-g]$/i.test(text)) {
      let phrase = null;
      try { phrase = lookup(text); } catch { phrase = null; }
      if (phrase?.kind === 'progression') source = phrase.roman;
    }
    return parseProgression(source, key);
  };
  return sections.map(section => {
    const parsed = resolve(section.progression ?? progression);
    const spans = chordSpans(parsed, section.bars, barsPerChord).map(s => ({ symbol: s.symbol, tick: s.tick, ticks: s.ticks }));
    const out = { name: section.name, startBar: at, bars: section.bars, spans, chords: spans.map(s => s.symbol).join(' ') };
    at += section.bars;
    return out;
  });
}

export function register({ tool, edit, z, root, schemas, project, moduleGuidance }) {
  moduleGuidance.push('Before writing a piano figure, bass line or percussion groove by hand, call list_phrases: it holds tested progressions, montunos, stabs, arpeggios, tumbaos and conga, clave and house kit grooves that fit any key. Build with create_from_phrases or add_phrase, prefer phrases the listener rated highly, and rate_phrase after feedback. Save a figure that worked with save_phrase.');
  const file = path.join(root, storeFile);
  let queue = Promise.resolve(), temporaryCount = 0;
  const load = async () => readStore(await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; }));
  // One writer at a time, through a temporary name, so parallel calls keep every change and a reader never sees half a file.
  const change = fn => {
    const run = queue.then(async () => {
      const store = await load(), result = await fn(store);
      const temporary = `${file}.tmp-${process.pid}-${++temporaryCount}`;
      try { await writeFile(temporary, JSON.stringify(store, null, 1), { flag: 'wx' }); await rename(temporary, file); }
      catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
      return result;
    });
    queue = run.catch(() => {});
    return run;
  };
  const recordUses = (ids, projectName) => change(store => {
    for (const id of ids) store.uses[id] = [...(store.uses[id] ?? []), { project: projectName, at: new Date().toISOString().slice(0, 10) }].slice(-50);
  }).catch(() => {});

  const soundOverride = z.object({ sample: schemas.workspaceWav.optional(), factorySample: schemas.factorySample.optional(), midi: z.number().int().min(12).max(119).optional(),
    volume: schemas.volume.optional(), pan: z.number().int().min(-100).max(100).optional(), length: z.number().int().min(1).max(768).optional() });
  const soundArgs = {
    sounds: z.record(z.string(), soundOverride).optional().describe('Which sample plays each percussion sound, for example { "conga-open": { "sample": "latin-perc/Conga_HitN_v2_rr1_Sum.wav" } }. Unlisted sounds use the stock LMMS sample.'),
    soundFolder: schemas.folderName.optional().describe('Workspace folder holding the percussion library files named in get_phrase (the CC0 VCSL set). Sounds found there are used instead of the stock stand-ins.'),
  };
  const resolveSounds = async ({ sounds: overrides = {}, soundFolder }) => {
    const out = {};
    for (const name of new Set([...Object.keys(soundDefaults), ...Object.keys(overrides)])) {
      const base = soundDefaults[name] ?? {}, over = overrides[name] ?? {};
      if (over.sample && over.factorySample) throw new Error(`Sound "${name}": give sample or factorySample, not both`);
      let source = over.sample ? { sample: over.sample } : over.factorySample ? { factorySample: over.factorySample } : null, midi = over.midi ?? 69;
      if (!source && soundFolder && base.library && (await lstat(path.join(root, soundFolder, base.library)).catch(() => null))?.isFile()) source = { sample: `${soundFolder}/${base.library}` };
      if (!source && base.stock) { source = { factorySample: base.stock }; midi = over.midi ?? base.stockMidi ?? 69; }
      if (!source) continue;
      out[name] = { ...source, midi, volume: over.volume ?? base.volume ?? 50, pan: over.pan, length: over.length ?? base.length ?? 48 };
    }
    return out;
  };
  const partShape = {
    phrase: z.string().regex(idPattern).describe('Phrase id from list_phrases.'),
    name: z.string().min(1).max(100).optional().describe('Track name for a pitched part. Parts with the same name share one track, so a piano can play a montuno in one section and stabs in another.'),
    voice: z.enum(['pluck', 'bass', 'pad', 'sample', 'preset']).optional(), preset: schemas.presetFile.optional(), sample: schemas.workspaceWav.optional(),
    factorySample: schemas.factorySample.optional(), rootMidi: z.number().int().min(12).max(119).optional(),
    role: z.enum(phraseRoles).optional(), volume: schemas.volume.optional(), pan: z.number().int().min(-100).max(100).optional(),
    octave: z.number().int().min(0).max(7).optional().describe('Octave of the first chord root. Default 2 for bass, 4 for harmony, 5 for lead.'),
    stretch: z.union([z.literal(0.5), z.literal(1), z.literal(2), z.literal(4)]).optional().describe('2 plays the phrase at half speed (a one-bar sixteenth figure becomes two bars of eighths, as salsa is written).'),
    velocity: z.number().min(0.3).max(1.6).optional().describe('Scales every note velocity.'),
    gain: z.number().min(0.1).max(3).optional().describe('Scales the volume of every drum in a rhythm phrase.'),
    variation: z.number().min(0).max(1).optional().describe('Random velocity movement so repeats are not identical.'), seed: z.number().int().optional(),
  };
  const part = z.object({ ...partShape, sections: z.array(z.string().min(1).max(60)).min(1).max(64).optional().describe('Section names this part plays in. Default: all.') });
  const describeTracks = tracks => tracks.map(t => ({ name: t.name, role: t.role, voice: t.voice, ...(t.preset ? { preset: t.preset } : {}), ...(t.sample ? { sample: t.sample } : {}),
    ...(t.factorySample ? { factorySample: t.factorySample } : {}), volume: t.volume, patterns: t.patterns.map(p => ({ name: p.name, bar: p.bar, bars: p.bars, ...(p.notes ? { notes: p.notes.length } : { grid: p.steps.grid }) })) }));

  tool('list_phrases', 'List reusable phrases: chord progressions, piano montunos, stabs and arpeggios, bass lines, short hooks, and conga, clave, cowbell and house kit grooves. Pitched phrases follow whatever chords they are placed over, so each fits any key. Best rated first, then least used. Shows the listener\'s rating and how often each has been used.', {
    kind: z.enum(phraseKinds).optional(), role: z.enum(phraseRoles).optional(), instrument: z.string().max(40).optional().describe('Such as piano, bass, congas, kit, clave.'),
    style: z.string().max(40).optional().describe('Such as latin, house, salsa, spanish, ballad.'), query: z.string().max(80).optional().describe('Words to find in the id, name or description.'),
    minRating: z.number().min(1).max(5).optional(), key: z.string().max(30).optional().describe('Show each progression as chords in this key.'),
    limit: z.number().int().min(1).max(200).default(60),
  }, async ({ kind, role, instrument, style, query, minRating, key, limit }) => {
    const store = await load(), words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const rows = rankPhrases(allPhrases(store).filter(p => (!kind || p.kind === kind) && (!role || p.role === role) && (!instrument || p.instrument === instrument.toLowerCase())
      && (!style || (p.styles ?? []).includes(style.toLowerCase())) && words.every(w => `${p.id} ${p.name} ${p.description ?? ''}`.toLowerCase().includes(w)))
      .map(p => summarise(p, store, key)).filter(r => !minRating || (r.rating ?? 0) >= minRating));
    return { count: rows.length, phrases: rows.slice(0, limit), next: 'create_from_phrases builds a song from these; add_phrase adds one to an existing project; rate_phrase records what the listener thought.' };
  });

  tool('get_phrase', 'Show one phrase in full: its notation, rating, where it has been used, and for percussion the sample each sound uses.', {
    id: z.string().regex(idPattern), key: z.string().max(30).optional(),
  }, async ({ id, key }) => {
    const store = await load(), phrase = findPhrase(store, id);
    return { ...summarise(phrase, store, key), ...(phrase.line ? { line: phrase.line } : {}), ...(phrase.seq ? { seq: phrase.seq, rate: phrase.rate ?? 1, accents: phrase.accents } : {}),
      ...(phrase.voices ? { voices: phrase.voices, soundFiles: Object.fromEntries(Object.keys(phrase.voices).map(s => [s, soundDefaults[s] ?? null])) } : {}),
      usedIn: store.uses[id] ?? [],
      notation: 'line: step=tones:length:velocity, > plays the next chord early. Tones: r 3 5 7 9 of the chord, s1-s7 of the key, ~n semitones above the root, v the voiced chord; \' up an octave, , down.' };
  });

  tool('create_from_phrases', 'Build a whole editable project from library phrases. Give a key, a progression (chord symbols, Roman numerals or a progression phrase id) and sections; each part places one phrase in the sections you name, fitted to the chords. Percussion phrases become one sample track per drum sound. Records each phrase as used.', {
    output: schemas.projectName, bpm: z.number().min(45).max(240), key: z.string().min(1).max(30).describe('Such as "A minor" or "E phrygian".'),
    progression: z.string().min(1).max(400).describe('Chord symbols ("Am G F E"), Roman numerals ("i bVII bVI V") or a progression phrase id ("prog-andalusian").'),
    barsPerChord: z.number().min(0.25).max(16).default(1),
    sections: z.array(z.object({ name: z.string().min(1).max(60), bars: z.number().int().min(1).max(64), progression: z.string().min(1).max(400).optional() })).min(1).max(64)
      .describe('Sections in order. Each restarts the progression; give a section its own progression for contrast.'),
    parts: z.array(part).min(1).max(48), ...soundArgs, masterVolume: z.number().min(0).max(200).default(86),
  }, async ({ output, bpm, key: keyInput, progression, barsPerChord, sections: wanted, parts, sounds, soundFolder, masterVolume }) => {
    if (new Set(wanted.map(s => s.name)).size !== wanted.length) throw new Error('Section names must be unique');
    const store = await load(), key = parseKey(keyInput), lookup = id => findPhrase(store, id);
    const sections = layoutSections(wanted, { key, progression, barsPerChord, lookup });
    const built = buildTracks({ parts, sections, key, sounds: await resolveSounds({ sounds, soundFolder }), lookup });
    const items = built.tracks.map(t => schemas.track.parse(t));
    for (const item of items) await project.checkTrack(item);
    const doc = project.createSong(bpm, items, masterVolume);
    for (const item of items.filter(i => i.preset)) await project.loadPreset(doc, project.instrumentOf(doc, item.name), item.preset, { tuning: 'concert' });
    const lengthBars = sections.reduce((sum, s) => sum + s.bars, 0);
    project.setAnchor(doc, lengthBars);
    const saved = await project.save(doc, output);
    await recordUses(built.used, output);
    return { ...saved, key: key.name, bpm, lengthBars, lengthSeconds: Number((lengthBars * 240 / bpm).toFixed(3)),
      sections: sections.map(s => ({ name: s.name, startBar: s.startBar, bars: s.bars, chords: s.chords })), tracks: describeTracks(built.tracks), phrasesUsed: built.used,
      next: ['lint_arrangement, then auto_balance and render_mix.', 'After the listener has heard it, rate_phrase each phrase so the good ones are chosen first next time.'] };
  });

  edit('add_phrase', 'Add one library phrase to an existing project as a new track (or one track per drum sound), fitted to the key and progression you give.', {
    ...partShape, key: z.string().min(1).max(30), progression: z.string().min(1).max(400).optional().describe('Needed for pitched phrases.'),
    barsPerChord: z.number().min(0.25).max(16).default(1), startBar: z.number().int().min(0).max(999), bars: z.number().int().min(1).max(64), ...soundArgs,
  }, async (doc, { key: keyInput, progression, barsPerChord, startBar, bars, sounds, soundFolder, ...partArgs }) => {
    const store = await load(), key = parseKey(keyInput), lookup = id => findPhrase(store, id), phrase = lookup(partArgs.phrase);
    if (phrase.kind === 'harmonic' && !progression) throw new Error('A pitched phrase needs a progression');
    const [section] = layoutSections([{ name: partArgs.name ?? phrase.name, bars }], { key, progression: progression ?? 'I', barsPerChord, lookup });
    section.startBar = startBar;
    const built = buildTracks({ parts: [partArgs], sections: [section], key, sounds: await resolveSounds({ sounds, soundFolder }), lookup });
    const existing = new Set(project.tracks(doc).map(t => t.getAttribute('name')));
    const anchor = project.tracks(doc).find(project.isAnchor);
    for (const raw of built.tracks) {
      if (existing.has(raw.name)) throw new Error(`Track name "${raw.name}" is already in use. Pass another name${phrase.kind === 'rhythm' ? ', or add the notes to that track with add_pattern' : ''}.`);
      const item = schemas.track.parse(raw);
      await project.checkTrack(item);
      const instrument = project.addTrack(project.container(doc), item);
      if (item.preset) await project.loadPreset(doc, instrument, item.preset, { tuning: 'concert' });
    }
    if (anchor) project.container(doc).appendChild(anchor);
    await recordUses(built.used, null);
    return { added: describeTracks(built.tracks), chords: section.chords };
  }, { checked: true });

  tool('save_phrase', 'Save a phrase to the listener\'s own library so it can be reused in any key. Either capture it from a project track (give the bars and the chords they were written over) or write it in phrase notation.', {
    id: z.string().regex(idPattern), name: z.string().min(1).max(80), kind: z.enum(phraseKinds), role: z.enum(phraseRoles).optional(), instrument: z.string().max(40).optional(),
    styles: z.array(z.string().min(1).max(40)).max(12).default([]), description: z.string().max(400).default(''),
    from: z.object({ project: schemas.projectName, trackName: z.string(), startBar: z.number().int().min(0), bars: z.number().int().min(1).max(8), key: z.string().min(1).max(30),
      progression: z.string().min(1).max(400), barsPerChord: z.number().min(0.25).max(16).default(1), stepsPerBar: z.number().int().min(1).max(48).default(16) }).optional()
      .describe('Capture a pitched figure from a project. The chords must be the ones sounding in those bars.'),
    line: z.string().max(6000).optional(), seq: z.string().max(2000).optional(), rate: z.number().int().min(1).max(16).optional(), accents: z.array(z.number().int().min(1).max(200)).max(32).optional(),
    voices: z.record(z.string().regex(idPattern), z.string().max(512)).optional().describe('Rhythm phrase: sound name to step grid.'),
    roman: z.string().max(400).optional(), mode: z.string().max(20).optional(), bars: z.number().int().min(1).max(8).optional(), stepsPerBar: z.number().int().min(1).max(48).optional(),
    octave: z.number().int().min(0).max(7).optional(), overwrite: z.boolean().default(false),
  }, async ({ from, overwrite, ...fields }) => {
    if (shippedPhrases.some(p => p.id === fields.id)) throw new Error(`"${fields.id}" is a shipped phrase. Choose another id.`);
    const phrase = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
    if (from) {
      if (phrase.kind !== 'harmonic') throw new Error('Capture works for pitched (harmonic) phrases');
      const doc = await project.load(from.project), track = project.instrumentOf(doc, from.trackName).parentNode;
      const low = from.startBar * barTicks, high = low + from.bars * barTicks, notes = [];
      for (const clip of project.children(track, 'pattern')) {
        const at = Number(clip.getAttribute('pos'));
        for (const n of project.children(clip, 'note')) {
          const tick = at + Number(n.getAttribute('pos'));
          if (tick >= low && tick < high) notes.push({ tick: tick - low, length: Number(n.getAttribute('len')), midi: Number(n.getAttribute('key')) + 12, velocity: Number(n.getAttribute('vol')) });
        }
      }
      const key = parseKey(from.key), spans = chordSpans(parseProgression(from.progression, key), from.bars, from.barsPerChord);
      Object.assign(phrase, capturePhrase(notes, { spans, bars: from.bars, stepsPerBar: from.stepsPerBar }));
      phrase.role ??= project.trackRole(track) ?? 'harmony';
    }
    validatePhrase(phrase);
    await change(store => {
      const at = store.phrases.findIndex(p => p.id === phrase.id);
      if (at >= 0 && !overwrite) throw new Error(`You already have a phrase "${phrase.id}". Pass overwrite: true to replace it.`);
      if (at >= 0) store.phrases[at] = phrase; else store.phrases.push(phrase);
      if (store.phrases.length > 2000) throw new Error('The phrase library is full (2000 phrases)');
    });
    return { saved: phrase.id, file: storeFile, phrase };
  });

  tool('rate_phrase', 'Record what the listener thought of a phrase, 1 (never again) to 5 (keep using it). list_phrases puts the best rated first. Pass rating null to clear it.', {
    id: z.string().regex(idPattern), rating: z.number().int().min(1).max(5).nullable(), note: z.string().max(300).optional(),
  }, async ({ id, rating, note }) => {
    await change(store => {
      findPhrase(store, id);
      if (rating === null) delete store.ratings[id];
      else store.ratings[id] = { rating, ...(note ? { note } : {}), at: new Date().toISOString().slice(0, 10) };
    });
    return { id, rating, ...(note ? { note } : {}) };
  });
}
