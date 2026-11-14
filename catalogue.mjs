const envelope = (attack, decay, sustain, release) => ({ attack, decay, sustain, release });
const oscillator = (wave, range, level, detune = 0) => ({
  wave, range, level, detune, fine: 0, pulseWidth: .4, kbTrack: true,
});
const base = {
  model: 'fathom',
  mode: 'poly',
  osc: [oscillator('saw', '8', .7), oscillator('pulse', '8', .3, .06), oscillator('sine', '16', .15)],
  osc2Sync: false, noise: 0, noiseColor: 'white', drive: 1.15, drift: 0, tune: 0, volume: .7,
  glide: 0, unisonVoices: 2, unisonSpread: .18, bendRange: 2,
  filter: { mode: 'lp', cutoff: 640, resonance: .28, contour: .32, tracking: .2, env: envelope(.002, .2, .18, .12) },
  loudness: envelope(.004, .24, .32, .12),
  lfo1: { wave: 'sine', rate: .3, depth: 0, dest: 'filter' },
  lfo2: { wave: 'triangle', rate: .4, depth: 0, dest: 'pwm' },
  fm: { algo: 0, feedback: 0, ops: [{ ratio: 1, level: .8 }, { ratio: 2, level: .34 },
    { ratio: 3, level: .22 }, { ratio: 1.5, level: .1 }] },
  halo: { partials: [1, .44, .26, .12, .18, .08, .03, .02], brightness: .65 },
  arp: { on: false, division: '16', octaves: 1, mode: 'up', gate: .5 },
  seq: { on: false, root: 48, velocity: .8, steps: Array.from({ length: 16 }, () => ({ on: false, semi: 0 })) },
  tempo: 120, swing: 0, delay: { time: .25, feedback: 0, mix: 0 },
  chorus: { rate: .4, depth: 0, mix: 0 }, reverb: { size: .5, mix: 0 },
};
const arp = [[0, 0, 15, .91], [35, 7, 9, .68], [71, 3, 13, .83], [95, 12, 8, .62], [131, 7, 15, .88], [166, 1, 8, .68]];
const entries = [
  ['fuse-pluck', 'Fuse Pluck', ['dark', 'syncopated', 'arp', 'pluck', 'game'], 50, arp,
    { filter: { cutoff: 340, resonance: .47, contour: .5 }, loudness: envelope(.003, .18, .26, .085) }],
  ['sub-pressure', 'Sub Pressure', ['sub', 'bass', 'mono', 'edm'], 38,
    [[0, 0, 39, .92], [49, 0, 23, .8], [84, 7, 24, .84], [122, 0, 35, .92]],
    { mode: 'mono', drive: 1.45, glide: .025, filter: { cutoff: 520 }, osc: [
      oscillator('triangle', '8', .84), oscillator('saw', '8', .27), oscillator('sine', '16', .12),
    ] }],
  ['relay-bell', 'Relay Bell', ['bright', 'metallic', 'fm', 'bell', 'lead'], 60, arp,
    { model: 'vesper', filter: { cutoff: 6700, resonance: .16 }, loudness: envelope(.003, .28, .18, .16) }],
  ['ember-organ', 'Ember Organ', ['warm', 'additive', 'organ', 'pad', 'chord'], 53,
    [[0, 0, 129, .82], [12, 3, 117, .72], [24, 7, 105, .72], [43, 14, 86, .63]],
    { model: 'halo', filter: { cutoff: 3100, resonance: .12 }, loudness: envelope(.07, .3, .76, .18) }],
];
export const fathomPatches = Object.fromEntries(entries.map(([id, name, tags, root, phrase, overrides]) => [
  id, { name, tags, root, phrase, patch: { ...base, ...overrides, filter: { ...base.filter, ...overrides.filter } } },
]));

export function searchSounds({ query, engine, limit }, native) {
  const tokens = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const sounds = [];
  if (engine !== 'lmms') {
    for (const [patchId, { name, tags, patch }] of Object.entries(fathomPatches)) {
      sounds.push({ name, tags, engine: 'fathom', model: patch.model, patchId, preview: 'preview_sound' });
    }
  }
  if (engine !== 'fathom') {
    for (const preset of native) {
      const [group, file] = preset.split('/');
      sounds.push({ name: file.replace(/\.xpf$/i, ''), tags: [group], engine: 'lmms', preset, preview: 'preview_sound' });
    }
  }
  const ranked = sounds.map(sound => {
    const name = sound.name.toLowerCase();
    const searchable = [name, sound.engine, sound.model, ...sound.tags].join(' ').toLowerCase();
    const score = tokens.every(token => searchable.includes(token))
      ? tokens.reduce((sum, token) => sum + (name.includes(token) ? 2 : 1), 0) : -1;
    return { sound, score };
  }).filter(({ score }) => score >= 0).sort((a, b) => b.score - a.score);
  return { total: ranked.length, sounds: ranked.slice(0, limit).map(({ sound }) => sound) };
}
