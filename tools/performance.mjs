// Performance shaping: turn exact, machine-played notes into something closer to a human performance.
// Phrase dynamics, melody voicing, metric accents, a ritardando at phrase ends, sustain pedal and a small seeded variation.

// A small deterministic random source, so the same seed gives the same performance.
export function seeded(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Phrase spans in ticks from bar counts, or every phraseBars bars. The last phrase ends at the song end.
export function phraseSpans({ phrases, phraseBars = 4, ticksPerBar, lengthTicks }) {
  const spans = [];
  let start = 0;
  if (phrases?.length) {
    for (const bars of phrases) {
      if (start >= lengthTicks) break;
      spans.push([start, start + bars * ticksPerBar]);
      start += bars * ticksPerBar;
    }
  }
  while (start < lengthTicks) {
    spans.push([start, start + phraseBars * ticksPerBar]);
    start += phraseBars * ticksPerBar;
  }
  if (spans.length) spans[spans.length - 1][1] = lengthTicks; // the last phrase ends with the piece
  return spans;
}

// The loudness shape of a phrase: grows to a peak at 60% of the way through, then falls away.
const PEAK = 0.6, EXPONENT = Math.log(0.5) / Math.log(PEAK);
export const phraseArc = x => Math.sin(Math.PI * Math.min(1, Math.max(0, x)) ** EXPONENT);

// A time warp: score tick -> performed tick. Each tick is stretched by rate(t) >= 1.
// Stretch ramps up over the last ritBeats beats of each phrase and over the last finalBars bars.
export function buildWarp({ spans, beatTicks, ticksPerBar, lengthTicks, rubato, ritBeats, finalRitardando, finalBars }) {
  const size = Math.ceil(lengthTicks) + 1;
  const rate = new Float64Array(size).fill(1);
  const ramp = (from, to, amount) => {
    const width = Math.max(1, to - from);
    for (let t = Math.max(0, Math.floor(from)); t < Math.min(size, to); t++) rate[t] = Math.max(rate[t], 1 + amount * (t - from + 1) / width);
  };
  if (rubato > 0) for (const [, end] of spans) ramp(end - ritBeats * beatTicks, Math.min(end, lengthTicks), rubato);
  if (finalRitardando > 0) ramp(lengthTicks - finalBars * ticksPerBar, lengthTicks, finalRitardando);
  const cumulative = new Float64Array(size + 1);
  for (let t = 0; t < size; t++) cumulative[t + 1] = cumulative[t] + rate[t];
  const warp = tick => {
    if (tick <= 0) return tick;
    if (tick >= size) return cumulative[size] + (tick - size);
    const whole = Math.floor(tick);
    return cumulative[whole] + (tick - whole) * rate[whole];
  };
  return warp;
}

// Shape every note. tracks: [{ name, notes: [{ tick, length, midi, velocity }] }] with absolute ticks.
// Returns new tracks in the same order plus a report and the warp used, so callers can move clips too.
export function shapePerformance(tracks, {
  ticksPerBar, beatTicks, phrases, phraseBars = 4, dynamics = 0.25, voicing = 0.15, accent = 0.06, humanize = 0.04,
  rubato = 0.12, ritBeats = 2, finalRitardando = 0.4, finalBars = 2, melodyLead = 1, pedal = 'none', seed = 1, velocityCeiling = 100, velocityScale = 1,
} = {}) {
  if (!(ticksPerBar > 0) || !(beatTicks > 0)) throw new Error('ticksPerBar and beatTicks are required');
  const random = seeded(seed);
  const all = tracks.flatMap((track, t) => track.notes.map((note, i) => ({ ...note, t, i, end: note.tick + note.length })));
  if (!all.length) throw new Error('There are no notes to shape');
  const lengthTicks = Math.max(...all.map(n => n.end));

  // Pedal: hold each note until the next pedal change, unless the same pitch is struck again first.
  const step = { bar: ticksPerBar, halfbar: ticksPerBar / 2, beat: beatTicks }[pedal];
  let pedalled = 0;
  if (step) {
    const strikes = new Map();
    for (const n of all) {
      if (!strikes.has(n.midi)) strikes.set(n.midi, []);
      strikes.get(n.midi).push(n.tick);
    }
    for (const list of strikes.values()) list.sort((a, b) => a - b);
    for (const n of all) {
      const change = (Math.floor(n.tick / step) + 1) * step;
      if (n.end >= change) continue;
      const next = strikes.get(n.midi).find(tick => tick > n.tick);
      const end = next === undefined ? change : Math.min(change, next);
      if (end > n.end) { n.end = end; pedalled++; }
    }
  }

  // Onset groups: notes struck together, within a sixteenth of a beat.
  const sorted = [...all].sort((a, b) => a.tick - b.tick || b.midi - a.midi);
  const groups = [];
  for (const n of sorted) {
    const group = groups.at(-1);
    if (group && n.tick - group[0].tick <= Math.max(1, beatTicks / 16)) group.push(n);
    else groups.push([n]);
  }
  for (const group of groups) {
    const top = Math.max(...group.map(n => n.midi)), bottom = Math.min(...group.map(n => n.midi));
    for (const n of group) n.voice = group.length < 2 || top === bottom ? 'single' : n.midi === top ? 'top' : n.midi === bottom ? 'bottom' : 'inner';
  }

  const spans = phraseSpans({ phrases, phraseBars, ticksPerBar, lengthTicks });
  const spanOf = tick => spans.find(([start, end]) => tick >= start && tick < end) ?? spans.at(-1);
  const voiceGain = { single: 1, top: 1 + voicing, bottom: 1 + voicing * 0.4, inner: 1 - voicing * 0.6 };
  let low = Infinity, high = -Infinity;
  for (const n of all) {
    const [start, end] = spanOf(n.tick);
    const arc = 1 + dynamics * (phraseArc((n.tick - start) / Math.max(1, end - start)) - 0.5);
    const inBar = n.tick % ticksPerBar;
    const metric = inBar === 0 ? 1 + accent : inBar % beatTicks === 0 ? 1 - accent * 0.3 : 1 - accent * 0.5;
    const human = 1 + humanize * (random() * 2 - 1);
    n.velocity = Math.max(1, Math.min(velocityCeiling, Math.round(n.velocity * velocityScale * arc * voiceGain[n.voice] * metric * human)));
    low = Math.min(low, n.velocity);
    high = Math.max(high, n.velocity);
  }

  const warp = buildWarp({ spans, beatTicks, ticksPerBar, lengthTicks, rubato, ritBeats, finalRitardando, finalBars });
  for (const n of all) {
    const start = Math.round(warp(n.tick)), end = Math.round(warp(n.end));
    // Melody lead: the rest of a chord sounds a moment after its top note, as a pianist voices it.
    const lag = melodyLead > 0 && (n.voice === 'inner' || n.voice === 'bottom') ? melodyLead : 0;
    n.tick = start + lag;
    n.length = Math.max(1, end - n.tick);
  }

  const out = tracks.map(track => ({ ...track, notes: track.notes.map(() => null) }));
  for (const n of all) out[n.t].notes[n.i] = { tick: n.tick, length: n.length, midi: n.midi, velocity: n.velocity };
  const newLength = Math.max(...all.map(n => n.tick + n.length));
  return {
    tracks: out, warp,
    report: {
      phrases: spans.map(([start, end]) => ({ bar: Math.round(start / ticksPerBar) + 1, bars: Number(((Math.min(end, lengthTicks) - start) / ticksPerBar).toFixed(2)) })),
      velocity: [low, high], pedalledNotes: pedalled,
      lengthTicks: { before: lengthTicks, after: newLength }, stretch: Number((newLength / lengthTicks).toFixed(3)),
    },
  };
}

export function register({ edit, z, project, moduleGuidance }) {
  moduleGuidance.push('After import_midi or for any piano or solo part played straight, run shape_performance once: phrase dynamics, a voiced melody, small accents, a ritardando at phrase ends and sustain pedal. Give the score\'s phrase lengths in bars when you know them. Running it twice compounds the effect.');
  edit('shape_performance', 'Make machine-exact notes sound played: velocity rises and falls across each phrase, the top note of each chord is voiced above the rest, downbeats lean slightly, phrase ends slow down (ritardando) and the last bars slow more, notes can be held by a simulated sustain pedal, and velocities vary slightly with a fixed seed. Moves notes and clips in time, so the song gets a little longer. Works on every instrument track, or the tracks named. Keeps velocities at or under 100 (MIDI 127) by default.', {
    tracks: z.array(z.string().min(1).max(100)).max(48).optional().describe('Tracks to shape. Default: every instrument track with notes. Tracks left out keep their notes but still move in time with the rest.'),
    phrases: z.array(z.number().min(0.25).max(64)).max(256).optional().describe('Phrase lengths in bars, in order, from the score. Bars after the listed phrases use phraseBars.'),
    phraseBars: z.number().min(0.5).max(32).default(4),
    dynamics: z.number().min(0).max(1).default(0.25).describe('How much velocity rises to each phrase peak and falls after it.'),
    voicing: z.number().min(0).max(0.5).default(0.15).describe('Extra weight on the top note of each chord, less on inner notes.'),
    accent: z.number().min(0).max(0.3).default(0.06).describe('Lean on the first beat of each bar.'),
    humanize: z.number().min(0).max(0.2).default(0.04).describe('Random velocity variation, as a fraction.'),
    rubato: z.number().min(0).max(1).default(0.12).describe('How much the last beats of each phrase slow down. 0.12 is 12% slower at the phrase end.'),
    ritBeats: z.number().min(0.5).max(16).default(2),
    finalRitardando: z.number().min(0).max(2).default(0.4).describe('How much the last bars of the piece slow down.'),
    finalBars: z.number().min(0.5).max(16).default(2),
    melodyLead: z.number().int().min(0).max(6).default(1).describe('Ticks the rest of a chord sounds after its top note. One tick is 1/48 of a beat.'),
    pedal: z.enum(['none', 'bar', 'halfbar', 'beat']).default('none').describe('Simulated sustain pedal: hold notes until the next bar, half bar or beat, but stop at the next strike of the same pitch.'),
    seed: z.number().int().min(1).max(2147483647).default(1),
    velocityCeiling: z.number().int().min(1).max(200).default(100),
    velocityScale: z.number().min(0.1).max(2).default(1).describe('Overall touch. 0.8 plays every note 20% softer, which on a sampled piano also picks a softer, darker layer.'),
  }, (doc, { tracks: names, ...options }) => {
    const info = project.songInfo(doc);
    if (!info.staticTempo) throw new Error('shape_performance needs a static tempo');
    const instrumentTracks = project.tracks(doc).filter(t => t.getAttribute('type') === '0' && project.children(t, 'pattern').length);
    if (names?.length) {
      const missing = names.filter(name => !instrumentTracks.some(t => t.getAttribute('name') === name));
      if (missing.length) throw new Error('No instrument track with notes named ' + missing.join(', '));
    }
    const chosen = instrumentTracks.filter(t => !names?.length || names.includes(t.getAttribute('name')));
    // Read absolute notes, remembering which pattern each came from.
    const sources = [];
    const input = chosen.map(track => {
      const notes = [];
      for (const clip of project.children(track, 'pattern')) {
        const pos = Number(clip.getAttribute('pos'));
        for (const element of project.children(clip, 'note')) {
          const length = Number(element.getAttribute('len'));
          if (!(length > 0)) continue; // step-sequencer triggers have no length to shape
          notes.push({ tick: pos + Number(element.getAttribute('pos')), length, midi: Number(element.getAttribute('key')) + 12, velocity: Number(element.getAttribute('vol') || 100) });
          sources.push({ element, clip });
        }
      }
      return { name: track.getAttribute('name'), notes };
    });
    const beatTicks = 192 / info.meter[1];
    const shaped = shapePerformance(input, { ticksPerBar: info.ticksPerBar, beatTicks, ...options });
    // Move every pattern by the warp, then place each note relative to its pattern's new start.
    const clipStarts = new Map();
    for (const track of instrumentTracks) {
      for (const clip of project.children(track, 'pattern')) {
        const pos = Number(clip.getAttribute('pos')), len = Number(clip.getAttribute('len'));
        const start = Math.round(shaped.warp(pos));
        clipStarts.set(clip, start);
        clip.setAttribute('pos', String(start));
        clip.setAttribute('len', String(Math.max(1, Math.round(shaped.warp(pos + len)) - start)));
      }
    }
    let k = 0;
    for (const track of shaped.tracks) {
      for (const n of track.notes) {
        const { element, clip } = sources[k++];
        const start = clipStarts.get(clip);
        element.setAttribute('pos', String(Math.max(0, n.tick - start)));
        element.setAttribute('len', String(n.length));
        element.setAttribute('vol', String(n.velocity));
        const needed = Math.ceil((n.tick - start + n.length) / info.ticksPerBar) * info.ticksPerBar;
        if (needed > Number(clip.getAttribute('len'))) clip.setAttribute('len', String(needed));
      }
    }
    const warnings = [];
    const others = project.tracks(doc).filter(t => !project.isAnchor(t) && (project.children(t, 'sampletco').length || project.children(t, 'bbtco').length || project.children(t, 'automationpattern').length));
    if (others.length) warnings.push('Sample, Beat/Bassline and automation clips were not moved: ' + others.map(t => t.getAttribute('name')).join(', '));
    if (project.tracks(doc).some(project.isAnchor)) project.setAnchor(doc, Math.ceil(project.songInfo(doc).lengthTicks / info.ticksPerBar));
    const after = project.songInfo(doc);
    return { performance: { ...shaped.report, lengthSeconds: { before: Number(info.lengthSeconds.toFixed(2)), after: Number(after.lengthSeconds.toFixed(2)) } },
      ...(warnings.length ? { warnings } : {}) };
  }, { checked: true });
}
