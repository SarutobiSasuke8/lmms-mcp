export const format = 'lmms-mcp-desk/1';
export const insertTypes = ['eq', 'compressor', 'filter', 'saturation', 'delay', 'reverb', 'chorus', 'bitcrush', 'gate', 'amp-clean', 'amp-crunch', 'amp-lead', 'cabinet', 'mic-chain'];
export const idPattern = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
export const voices = 8;
export const defaultChannel = () => ({
  source: null, gain: 0.8, pan: 0, mute: false, solo: false, reverb: 0, delay: 0,
  start: 0, end: 1, loop: true, rate: 1, reverse: false, inserts: [], input: 1, inputGain: 1, monitor: false,
});
export const defaultMaster = () => ({ gain: 0.82, low: 0, mid: 0, high: 0, glue: true, ceiling: -1, width: 1 });
export const createSession = () => ({
  format, bpm: 120, bars: 2, channels: Array.from({ length: voices }, defaultChannel), master: defaultMaster(), io: { latencyMs: 0 }, midi: [],
});
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const number = (value, fallback, min, max) => Number.isFinite(value) ? clamp(value, min, max) : fallback;
const bool = (value, fallback = false) => typeof value === 'boolean' ? value : fallback;
const media = /\.(?:wav|ogg|flac|mp3)$/i;
export function samplePath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.length > 1000) return null;
  let url;
  try { url = decodeURIComponent(path); } catch { return null; }
  if (!media.test(url) || /[?#:\\\u0000-\u001f]/.test(url) || url.slice(1).split('/').some(part => !part || part.startsWith('.'))) return null;
  return path;
}
function normalizeSource(source) {
  if (source == null) return null;
  if (source.type === 'instrument' && idPattern.test(source.id)) return { type: 'instrument', id: source.id };
  if (source.type !== 'sample' || !samplePath(source.url)) throw new Error('Invalid library audio source.');
  return { type: 'sample', url: source.url, name: typeof source.name === 'string' ? source.name.slice(0, 160) : 'Audio' };
}
function normalizeInsert(effect) {
  if (!effect || !insertTypes.includes(effect.type)) throw new Error('Unknown insert effect.');
  const normal = { type: effect.type, amount: number(effect.amount, 0.5, 0, 1), wet: number(effect.wet, 1, 0, 1), bypass: bool(effect.bypass) };
  if (effect.type === 'eq') {
    const defaults = [[20, 20, 1500], [0, -18, 18], [0, -18, 18], [0, -18, 18], [20000, 900, 20000]];
    normal.eq = defaults.map(([fallback, min, max], i) => number(effect.eq?.[i], fallback, min, max));
  }
  return normal;
}
export function normalizeSession(input) {
  if (!input || input.format !== format || !Array.isArray(input.channels) || input.channels.length !== voices) {
    throw new Error('Expected an eight-channel Mix Desk session.');
  }
  const channels = input.channels.map(channel => {
    if (!channel || !Array.isArray(channel.inserts) || channel.inserts.length > 14) throw new Error('Each channel supports up to fourteen inserts.');
    const start = number(channel.start, 0, 0, 0.999), end = number(channel.end, 1, 0.001, 1);
    if (end <= start) throw new Error('Trim end must be later than trim start.');
    return { source: normalizeSource(channel.source), gain: number(channel.gain, 0.8, 0, 2), pan: number(channel.pan, 0, -1, 1),
      mute: bool(channel.mute), solo: bool(channel.solo), reverb: number(channel.reverb, 0, 0, 1), delay: number(channel.delay, 0, 0, 1),
      start, end, loop: bool(channel.loop, true), rate: [0.5, 1, 2].includes(channel.rate) ? channel.rate : 1, reverse: bool(channel.reverse),
      inserts: channel.inserts.map(normalizeInsert), input: Math.round(number(channel.input, 1, 1, 8)), inputGain: number(channel.inputGain, 1, 0, 4), monitor: bool(channel.monitor) };
  });
  const master = input.master ?? {};
  const io = { latencyMs: number(input.io?.latencyMs, 0, -500, 500) };
  const midi = (Array.isArray(input.midi) ? input.midi : []).slice(0, 192).filter(mapping => mapping &&
    ['cc','note'].includes(mapping.type) && Number.isInteger(mapping.channel) && mapping.channel >= 0 && mapping.channel <= 15 &&
    Number.isInteger(mapping.number) && mapping.number >= 0 && mapping.number <= 127 &&
    typeof mapping.control === 'string' && /^[a-z0-9:/_-]{1,130}$/i.test(mapping.control)
  ).map(({ type, channel, number, control }) => ({ type, channel, number, control }));
  return { format, channels, io, midi, bpm: number(input.bpm, 120, 40, 240), bars: Math.round(number(input.bars, 2, 1, 16)),
    master: { gain: number(master.gain, 0.82, 0, 2), low: number(master.low, 0, -18, 18), mid: number(master.mid, 0, -18, 18),
      high: number(master.high, 0, -18, 18), ceiling: number(master.ceiling, -1, -12, 0), width: number(master.width, 1, 0, 2), glue: bool(master.glue, true) } };
}
export const loopSeconds = (bpm, bars) => bars * 240 / bpm;
export function nextBar(now, origin, bpm) {
  const length = loopSeconds(bpm, 1);
  return origin + Math.max(0, Math.ceil((now - origin) / length)) * length;
}
