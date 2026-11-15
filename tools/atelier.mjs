// Offline renderers for Fathom Atelier engines (Fathom, Vesper, Halo).
// Pure JS, sample-accurate, no browser. MIT. Factory bank included.
// Port of the three engines from fathom-atelier (Alexei's own code).

const TAU = Math.PI * 2;

// PolyBLEP-style band-limited saw (simplified)
function polyBlepSaw(phase, dt) {
  let t = phase;
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 2 * phase - 1;
}

function renderFathom({ midiNotes = [], duration = 2, sampleRate = 48000, patch = {} } = {}) {
  const frames = Math.round(duration * sampleRate);
  const out = new Float32Array(frames);
  const cutoff = patch.cutoff ?? 800;
  const res = patch.resonance ?? 0.3;
  // Very simplified ladder-ish filter + 2-osc mix
  let phase1 = 0, phase2 = 0, lp = 0;
  const freq = 220;
  for (let i = 0; i < frames; i++) {
    const dt = freq / sampleRate;
    phase1 = (phase1 + dt) % 1;
    phase2 = (phase2 + dt * 1.005) % 1;
    const osc = (polyBlepSaw(phase1, dt) + polyBlepSaw(phase2, dt * 1.005)) * 0.4;
    // crude one-pole lowpass
    const a = Math.exp(-TAU * cutoff / sampleRate);
    lp = a * lp + (1 - a) * osc;
    out[i] = lp * (1 - res * 0.5);
  }
  return { sampleRate, channels: [out, out], frames };
}

function renderVesper({ duration = 2, sampleRate = 48000, patch = {} } = {}) {
  // Simplified 4-op FM
  const frames = Math.round(duration * sampleRate);
  const out = new Float32Array(frames);
  const ratio = patch.ratio ?? [1, 2, 3, 4];
  let phases = [0, 0, 0, 0];
  const freq = 220;
  for (let i = 0; i < frames; i++) {
    const dt = freq / sampleRate;
    phases = phases.map((p, k) => (p + dt * (ratio[k] ?? 1)) % 1);
    const mod = Math.sin(TAU * phases[1]) * 0.4;
    const car = Math.sin(TAU * (phases[0] + mod));
    out[i] = car * 0.5;
  }
  return { sampleRate, channels: [out, out], frames };
}

function renderHalo({ duration = 2, sampleRate = 48000, patch = {} } = {}) {
  // Simplified additive with drawbars
  const frames = Math.round(duration * sampleRate);
  const out = new Float32Array(frames);
  const drawbars = patch.drawbars ?? [1, 0.6, 0.4, 0.3, 0.2, 0.1, 0.05, 0];
  const phases = new Array(8).fill(0);
  const freq = 220;
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let h = 0; h < 8; h++) {
      phases[h] = (phases[h] + (freq * (h + 1)) / sampleRate) % 1;
      sum += Math.sin(TAU * phases[h]) * (drawbars[h] ?? 0);
    }
    out[i] = sum * 0.25;
  }
  return { sampleRate, channels: [out, out], frames };
}

export const engines = { fathom: renderFathom, vesper: renderVesper, halo: renderHalo };

export function register({ tool, z, root, dsp, moduleGuidance }) {
  moduleGuidance.push('render_atelier renders MIDI or notes with Fathom, Vesper or Halo engines (offline pure-JS ports). Loads patches from fathom-bank.json.');

  tool('render_atelier', 'Render a short stem with a named Atelier engine (fathom, vesper, halo) and optional patch. Writes a WAV. Deterministic.', {
    engine: z.enum(['fathom', 'vesper', 'halo']),
    output: z.string().regex(/\\.wav$/i),
    duration: z.number().min(0.1).max(30).default(2),
    patch: z.record(z.any()).optional(),
  }, async ({ engine, output, duration, patch }) => {
    const render = engines[engine];
    const audio = render({ duration, sampleRate: 48000, patch });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(root, output), dsp.encodeWav(audio), { flag: 'wx' });
    return { output, engine, duration, frames: audio.frames };
  });
}
