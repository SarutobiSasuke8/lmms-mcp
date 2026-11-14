// Effect definitions for stock LMMS 1.2: element names and attributes were taken from LMMS's own demo projects
// and confirmed by rendering. LADSPA entries use plugins shipped in the stock Windows build.
const range = (min, max, fallback) => ({ min, max, fallback });
export const effectTypes = {
  delay: {
    summary: 'Echo. time is a note value ("1/4", "1/8", "1/8d" dotted, "1/8t" triplet) or seconds; feedback 0-0.95.',
    native: 'delay', control: 'Delay', tail: 6000,
    params: { time: { fallback: '1/8d' }, feedback: range(0, 0.95, 0.35), outputGainDb: range(-60, 20, 0) },
    attributes: (p, bpm) => ({ DelayTimeSamples: delaySeconds(p.time, bpm), FeebackAmount: p.feedback, LfoFrequency: 2, LfoAmount: 0, OutGain: p.outputGainDb }),
  },
  reverb: {
    summary: 'ReverbSC. size 0-1 sets the tail length, dampingHz darkens it.',
    native: 'reverbsc', control: 'ReverbSCControls', tail: 8000,
    params: { size: range(0, 0.99, 0.85), dampingHz: range(100, 15000, 9000), inputGainDb: range(-60, 15, 0), outputGainDb: range(-60, 15, 0) },
    attributes: p => ({ input_gain: p.inputGainDb, size: p.size, color: p.dampingHz, output_gain: p.outputGainDb }),
  },
  compressor: {
    summary: 'SC4 stereo compressor.',
    ladspa: ['sc4_1882', 'sc4'], tail: 1,
    params: { thresholdDb: range(-30, 0, -18), ratio: range(1, 20, 3), attackMs: range(1.5, 400, 10), releaseMs: range(2, 800, 120),
      kneeDb: range(1, 10, 4), makeupDb: range(0, 24, 0) },
    ports: p => [0, p.attackMs, p.releaseMs, p.thresholdDb, p.ratio, p.kneeDb, p.makeupDb],
  },
  limiter: {
    summary: 'Look-ahead brick-wall limiter, usually last on Master.',
    ladspa: ['fast_lookahead_limiter_1913', 'fastLookaheadLimiter'], tail: 1,
    params: { ceilingDb: range(-20, 0, -1), inputGainDb: range(-20, 20, 0), releaseSeconds: range(0.01, 2, 0.1) },
    ports: p => [p.inputGainDb, p.ceilingDb, p.releaseSeconds],
  },
  amplifier: {
    summary: 'Gain and pan trim. volume is a percentage (100 is unity).',
    native: 'amplifier', control: 'AmplifierControls', tail: 1,
    params: { volume: range(0, 200, 100), pan: range(-100, 100, 0) },
    attributes: p => ({ volume: p.volume, pan: p.pan, left: 100, right: 100 }),
  },
  bassbooster: {
    summary: 'Low-shelf style bass boost.',
    native: 'bassbooster', control: 'bassboostercontrols', tail: 1,
    params: { frequencyHz: range(50, 200, 100), gain: range(0.1, 5, 1.5), ratio: range(0.1, 10, 2) },
    attributes: p => ({ freq: p.frequencyHz, gain: p.gain, ratio: p.ratio }),
  },
  stereo: {
    summary: 'Stereo enhancer. width 0-180.',
    native: 'stereoenhancer', control: 'stereoenhancercontrols', tail: 1,
    params: { width: range(0, 180, 60) },
    attributes: p => ({ width: p.width }),
  },
  eq: { summary: 'Native parametric EQ at flat defaults; shape it in LMMS.', native: 'eq', tail: 1, params: {} },
  crossovereq: { summary: 'Native crossover EQ at defaults; shape it in LMMS.', native: 'crossovereq', tail: 1, params: {} },
};
const divisions = /^1\/(1|2|4|8|16|32)([dt]?)$/;
export function delaySeconds(time, bpm) {
  if (typeof time === 'number') {
    if (!(time >= 0.01 && time <= 5)) throw new Error('Delay time in seconds must be between 0.01 and 5');
    return time;
  }
  const match = divisions.exec(String(time));
  if (!match) throw new Error('Delay time must be seconds or a note value such as "1/4", "1/8d" or "1/8t"');
  const seconds = 240 / bpm / Number(match[1]) * (match[2] === 'd' ? 1.5 : match[2] === 't' ? 2 / 3 : 1);
  return Number(Math.min(5, Math.max(0.01, seconds)).toFixed(5));
}
export function resolveParams(plugin, given = {}, previous = {}) {
  const type = effectTypes[plugin];
  const unknown = Object.keys(given).filter(key => !(key in type.params));
  if (unknown.length) {
    throw new Error(`${plugin} has no parameter "${unknown[0]}". Available: ${Object.keys(type.params).join(', ') || 'none'}`);
  }
  const resolved = {};
  for (const [key, spec] of Object.entries(type.params)) {
    const value = given[key] ?? previous[key] ?? spec.fallback;
    if (spec.min !== undefined && (typeof value !== 'number' || value < spec.min || value > spec.max)) {
      throw new Error(`${plugin}.${key} must be a number between ${spec.min} and ${spec.max}`);
    }
    resolved[key] = value;
  }
  return resolved;
}
export const describeEffects = () => Object.fromEntries(Object.entries(effectTypes).map(([name, type]) => [name, {
  summary: type.summary, engine: type.ladspa ? 'ladspa:' + type.ladspa[0] : type.native,
  params: Object.fromEntries(Object.entries(type.params).map(([key, spec]) => [key,
    spec.min === undefined ? { default: spec.fallback } : { min: spec.min, max: spec.max, default: spec.fallback }])),
}]));
