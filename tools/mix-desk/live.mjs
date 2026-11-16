const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const hzToMidi = hz => 69 + 12 * Math.log2(hz / 440);
const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
export function detectPitch(samples, rate) {
  const n = samples.length;
  if (n < 256 || Math.max(...samples.map(Math.abs)) < .006) return null;
  const min = Math.max(2, Math.floor(rate / 1600)), max = Math.min(Math.floor(n / 2), Math.floor(rate / 55));
  const differences = new Float64Array(max + 1);
  let total = 0;
  const length = n - max;
  for (let lag = 1; lag <= max; lag++) {
    let diff = 0;
    for (let i = 0; i < length; i++) diff += (samples[i] - samples[i + lag]) ** 2;
    total += diff;
    differences[lag] = total > 0 ? diff * lag / total : 1;
  }
  let at = 0;
  for (let lag = min; lag < max; lag++) {
    if (differences[lag] < .17) {
      while (lag + 1 <= max && differences[lag + 1] < differences[lag]) lag++;
      at = lag; break;
    }
  }
  if (!at) return null;
  const middle = differences[at], before = differences[at - 1], after = differences[at + 1] ?? middle;
  const shift = (after - before) / (2 * (2 * middle - after - before) || 1);
  const hz = rate / (at + clamp(shift, -.5, .5)), exact = hzToMidi(hz), midi = Math.round(exact);
  return { hz, cents: Math.round((exact - midi) * 100), note: names[midi % 12] + (Math.floor(midi / 12) - 1) };
}

export function ampCurve(mode, amount, count = 2048) {
  const drive = { 'amp-clean':1.15, 'amp-crunch':3.8, 'amp-lead':8.3 }[mode] * (0.5 + clamp(amount,0,1) * 1.25);
  return Float32Array.from({ length:count }, (_,i) => {
    const x = i * 2 / (count - 1) - 1;
    return clamp(Math.tanh(drive * x) / Math.tanh(drive), -1, 1);
  });
}

export function shiftRecorded(samples, offsetFrames) {
  if (!Number.isInteger(offsetFrames)) throw new TypeError('Expected an integral compensation offset.');
  const out = new Float32Array(samples.length);
  for (let i = 0; i < out.length; i++) out[i] = samples[i + offsetFrames] ?? 0;
  return out;
}

export function latencyProbe(rate) {
  let random = 27377;
  return Float32Array.from({ length: Math.round(rate * .045) }, (_, i) => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    return (random / 2147483648 - 1) * .18 * Math.min(1, i / 30);
  });
}

export function measureProbeOffset(probe, recording) {
  if (recording.length < probe.length || !probe.length) return null;
  let top = 0, offset = null;
  const energy = probe.reduce((sum,x) => sum + x*x,0);
  for (let lag = 0; lag <= recording.length - probe.length; lag++) {
    let sum = 0, power = 0;
    for (let i = 0; i < probe.length; i += 4) {
      const x = recording[lag + i]; sum += x * probe[i]; power += x*x;
    }
    const score = Math.abs(sum) / Math.sqrt((energy/4)*power || 1);
    if (score > top) { top = score; offset = lag; }
  }
  return top >= .19 ? offset : null;
}

export function decodeMidi(bytes) {
  const [header, number, value] = bytes;
  const mode = header & 0xf0, channel = header & 0xf;
  if (![0,1,2].every(i => Number.isInteger(bytes[i])) || number < 0 || number > 127 || value < 0 || value > 127) return null;
  if (mode === 0xb0) return { type:'cc', channel, number, value:value/127 };
  if (mode === 0x80 || mode === 0x90) return { type:'note', channel, number, value:mode === 0x80 ? 0 : value/127 };
  return null;
}
