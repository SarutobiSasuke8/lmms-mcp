// Groove engine for dance styles: swing templates, humanise, ghost notes, fills, drum layering.
// Deterministic for a seed. Operates on note arrays (tick, midi, velocity, length).
const BAR = 192; // ticks per bar at 48 ppq * 4
const STEP = 12; // 16th note
const clave = new Set([0, 6 * STEP, 12 * STEP, BAR + 4 * STEP, BAR + 8 * STEP]);

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

const grooves = {
  'mpc-swing-60': (tick) => tick + (tick % (STEP * 2) === STEP ? STEP * 0.15 : 0),
  'mpc-swing-70': (tick) => tick + (tick % (STEP * 2) === STEP ? STEP * 0.25 : 0),
  'ukg-shuffle': (tick) => tick + (tick % (STEP * 2) === STEP ? STEP * 0.2 : 0),
  'house-shuffle': (tick) => tick + (tick % (STEP * 2) === STEP ? STEP * 0.12 : 0),
  'amapiano-332': (tick) => {
    const pos = tick % BAR;
    if (pos > STEP * 5 && pos < STEP * 8) return tick + STEP * 0.1;
    return tick;
  },
  'afro-clave': (tick) => tick,
  'half-time': (tick) => tick,
  'straight-techno': (tick) => tick,
};

export function applyGroove(notes, template = 'mpc-swing-60', strength = 1) {
  if (strength === 0) return notes.map(note => ({ ...note }));
  if (template === 'afro-clave') {
    return notes.map(note => {
      const accent = clave.has(note.tick % (2 * BAR)) ? 14 : -4;
      const velocity = Math.round((note.velocity ?? 80) + accent * strength);
      return { ...note, velocity: Math.max(1, Math.min(127, velocity)) };
    });
  }
  if (template === 'half-time') {
    // Shift a beat-two backbeat toward beat three, retaining the bar and other voices.
    const snares = new Set(notes.filter(note => note.midi === 38 || note.midi === 40)
      .map(note => `${note.midi}:${note.tick}`));
    return notes.map(note => {
      const shift = Math.round(4 * STEP * strength);
      const backbeat = (note.midi === 38 || note.midi === 40) && note.tick % BAR === 4 * STEP;
      const tick = backbeat && !snares.has(`${note.midi}:${note.tick + shift}`) ? note.tick + shift : note.tick;
      return { ...note, tick };
    }).sort((left, right) => left.tick - right.tick);
  }
  const fn = grooves[template] ?? grooves['mpc-swing-60'];
  return notes.map(n => ({ ...n, tick: Math.round(n.tick + (fn(n.tick) - n.tick) * strength) }));
}

export function humanize(notes, { timingMs = 8, velocityVar = 12, seed = 1, role = 'hat' } = {}) {
  const random = rng(seed);
  const tight = role === 'kick' || role === 'snare';
  const tScale = tight ? 0.3 : 1;
  const vScale = tight ? 0.5 : 1;
  return notes.map(n => {
    const jitter = (random() - 0.5) * 2 * timingMs * tScale * 48 / 1000 * 60; // rough ticks
    const vel = Math.max(1, Math.min(127, (n.velocity ?? 80) + (random() - 0.5) * 2 * velocityVar * vScale));
    return { ...n, tick: Math.max(0, Math.round(n.tick + jitter)), velocity: Math.round(vel) };
  });
}

export function addGhostNotes(notes, { density = 0.3, seed = 1, role = 'snare' } = {}) {
  const random = rng(seed + 7);
  const ghosts = [];
  for (const n of notes) {
    if (n.midi > 50 && random() < density) { // hats/snares
      ghosts.push({ ...n, tick: n.tick + STEP, velocity: Math.round((n.velocity ?? 60) * 0.35), length: STEP * 0.5 });
    }
  }
  return [...notes, ...ghosts].sort((a, b) => a.tick - b.tick);
}

export function addFills(notes, { every = 8, seed = 1, bars = 32 } = {}) {
  const random = rng(seed + 13);
  const fills = [];
  for (let bar = every - 1; bar < bars; bar += every) {
    const base = bar * BAR;
    for (let s = 0; s < 4; s++) {
      fills.push({ tick: base + (12 + s) * STEP, midi: 38, velocity: 70 + random() * 30, length: STEP });
    }
  }
  return [...notes, ...fills].sort((a, b) => a.tick - b.tick);
}

export function layerDrums(notes, { layers = 2, offsetTicks = 2, velScale = 0.8 } = {}) {
  const out = [...notes];
  for (let l = 1; l < layers; l++) {
    out.push(...notes.map(n => ({ ...n, tick: n.tick + offsetTicks * l, velocity: Math.round((n.velocity ?? 80) * velScale) })));
  }
  return out.sort((a, b) => a.tick - b.tick);
}

export function register({ tool, z, moduleGuidance }) {
  moduleGuidance.push('Groove tools: apply_groove, humanize, add_ghost_notes, add_fills, layer_drums. Deterministic with a seed. Operate on note arrays.');

  tool('apply_groove', 'Apply a named groove template (MPC swing, UKG, house, amapiano 3-3-2, half-time, straight) to notes. Deterministic.', {
    notes: z.array(z.object({ tick: z.number(), midi: z.number(), velocity: z.number().optional(), length: z.number().optional() })),
    template: z.enum(Object.keys(grooves)).default('mpc-swing-60'),
    strength: z.number().min(0).max(1).default(1),
  }, async ({ notes, template, strength }) => ({ notes: applyGroove(notes, template, strength) }));

  tool('humanize', 'Add timing jitter and velocity variation. Kick/snare stay tighter than hats. Seeded.', {
    notes: z.array(z.any()),
    timingMs: z.number().min(0).max(40).default(8),
    velocityVar: z.number().min(0).max(40).default(12),
    seed: z.number().int().default(1),
    role: z.enum(['kick', 'snare', 'hat', 'other']).default('hat'),
  }, async (args) => ({ notes: humanize(args.notes, args) }));

  tool('add_ghost_notes', 'Add low-velocity ghost notes on snares/hats. Seeded density.', {
    notes: z.array(z.any()),
    density: z.number().min(0).max(1).default(0.3),
    seed: z.number().int().default(1),
  }, async (args) => ({ notes: addGhostNotes(args.notes, args) }));

  tool('add_fills', 'Add genre-style fills every N bars. Seeded.', {
    notes: z.array(z.any()),
    every: z.number().int().min(4).max(16).default(8),
    bars: z.number().int().min(4).max(128).default(32),
    seed: z.number().int().default(1),
  }, async (args) => ({ notes: addFills(args.notes, args) }));

  tool('layer_drums', 'Duplicate a drum role onto layered instruments with offset and velocity scaling.', {
    notes: z.array(z.any()),
    layers: z.number().int().min(1).max(4).default(2),
    offsetTicks: z.number().min(0).max(24).default(2),
    velScale: z.number().min(0.1).max(1).default(0.8),
  }, async (args) => ({ notes: layerDrums(args.notes, args) }));
}
