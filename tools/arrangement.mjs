// Dance arrangement engine: section maps, energy curves, drop/breakdown patterns,
// filter automation hints, and bar-aligned structures for house, techno, DnB, UKG.
// Deterministic. Outputs arrangement plans that compose tools can consume.

const sections = {
  house: [
    { name: 'intro', bars: 16, energy: 0.3, drums: 'hats', bass: false },
    { name: 'build', bars: 8, energy: 0.5, drums: 'full', bass: true },
    { name: 'drop', bars: 16, energy: 0.9, drums: 'full', bass: true },
    { name: 'breakdown', bars: 8, energy: 0.2, drums: 'none', bass: false },
    { name: 'drop2', bars: 16, energy: 1.0, drums: 'full', bass: true },
    { name: 'outro', bars: 8, energy: 0.4, drums: 'hats', bass: false },
  ],
  techno: [
    { name: 'intro', bars: 32, energy: 0.4, drums: 'kick-hat', bass: true },
    { name: 'groove', bars: 32, energy: 0.7, drums: 'full', bass: true },
    { name: 'peak', bars: 16, energy: 0.95, drums: 'full', bass: true },
    { name: 'breakdown', bars: 16, energy: 0.3, drums: 'perc', bass: false },
    { name: 'peak2', bars: 16, energy: 1.0, drums: 'full', bass: true },
    { name: 'outro', bars: 16, energy: 0.5, drums: 'kick', bass: true },
  ],
  dnb: [
    { name: 'intro', bars: 16, energy: 0.4, drums: 'break', bass: false },
    { name: 'build', bars: 8, energy: 0.6, drums: 'break', bass: true },
    { name: 'drop', bars: 16, energy: 0.95, drums: 'full', bass: true },
    { name: 'switch', bars: 8, energy: 0.5, drums: 'half', bass: true },
    { name: 'drop2', bars: 16, energy: 1.0, drums: 'full', bass: true },
    { name: 'outro', bars: 8, energy: 0.3, drums: 'break', bass: false },
  ],
  ukg: [
    { name: 'intro', bars: 8, energy: 0.35, drums: 'shuffle', bass: false },
    { name: 'verse', bars: 16, energy: 0.6, drums: 'shuffle', bass: true },
    { name: 'chorus', bars: 16, energy: 0.85, drums: 'full', bass: true },
    { name: 'breakdown', bars: 8, energy: 0.25, drums: 'none', bass: false },
    { name: 'chorus2', bars: 16, energy: 0.95, drums: 'full', bass: true },
    { name: 'outro', bars: 8, energy: 0.4, drums: 'shuffle', bass: false },
  ],
};

export function arrangementPlan(genre = 'house', totalBars = 64) {
  const template = sections[genre] ?? sections.house;
  const extraBars = Math.max(0, totalBars - template.reduce((sum, section) => sum + section.bars, 0));
  const sectionsToPlace = template.slice(0, -1);
  const body = template.slice(1, -1);
  let remaining = extraBars;
  for (let index = 0; remaining > 0; index++) {
    const section = body[index % body.length];
    const bars = Math.min(remaining, section.bars);
    sectionsToPlace.push({ ...section, bars });
    remaining -= bars;
  }
  sectionsToPlace.push(template.at(-1));
  let bar = 0;
  const plan = [];
  for (const s of sectionsToPlace) {
    if (bar >= totalBars) break;
    const bars = Math.min(s.bars, totalBars - bar);
    plan.push({ ...s, startBar: bar, bars });
    bar += bars;
  }
  return { genre, totalBars: bar, sections: plan };
}

export function energyCurve(plan) {
  return plan.sections.map(s => ({ bar: s.startBar, energy: s.energy, name: s.name }));
}

export function register({ tool, z, moduleGuidance }) {
  moduleGuidance.push('arrangementPlan returns a bar-aligned section map for house, techno, DnB or UKG. energyCurve gives the energy envelope. Deterministic.');

  tool('arrangement_plan', 'Generate a dance arrangement plan (sections, energy, drum/bass roles) for a genre. Bar-aligned.', {
    genre: z.enum(['house', 'techno', 'dnb', 'ukg']).default('house'),
    totalBars: z.number().int().min(16).max(256).default(64),
  }, async ({ genre, totalBars }) => arrangementPlan(genre, totalBars));

  tool('energy_curve', 'Return the energy envelope from an arrangement plan.', {
    plan: z.object({ sections: z.array(z.any()) }),
  }, async ({ plan }) => ({ curve: energyCurve(plan) }));
}
