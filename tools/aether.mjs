// Aether theremin voice: expressive continuous-pitch instrument with
// vibrato, portamento and antenna-style control mapping. Pure JS, deterministic.
// Intended as an offline renderer or note generator for ethereal / sci-fi cues.

const TAU = Math.PI * 2;

function thereminVoice({ notes = [], duration = 4, sampleRate = 48000, vibratoHz = 5.5, vibratoDepth = 0.08, portamento = 0.15 } = {}) {
  const frames = Math.round(duration * sampleRate);
  const out = new Float32Array(frames);
  let phase = 0, currentFreq = 440, targetFreq = 440;
  const portamentoRate = Math.exp(-1 / (portamento * sampleRate));
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    // Simple note following (nearest note by time)
    for (const n of notes) {
      const start = (n.tick ?? 0) / 48 * 60 / 120; // rough seconds
      if (t >= start && t < start + (n.length ?? 48) / 48) {
        targetFreq = 440 * 2 ** (((n.midi ?? 69) - 69) / 12);
        break;
      }
    }
    currentFreq = currentFreq * portamentoRate + targetFreq * (1 - portamentoRate);
    const vib = 1 + Math.sin(TAU * vibratoHz * t) * vibratoDepth;
    phase += TAU * currentFreq * vib / sampleRate;
    // Soft sine + a bit of air
    out[i] = Math.sin(phase) * 0.6 + Math.sin(phase * 2.01) * 0.08;
  }
  return { sampleRate, channels: [out, out], frames };
}

export function register({ tool, z, root, dsp, moduleGuidance }) {
  moduleGuidance.push('render_aether renders an expressive theremin-style voice with vibrato and portamento. Deterministic pure-JS.');

  tool('render_aether', 'Render a theremin-style continuous-pitch voice from notes or a simple melody. Vibrato and portamento. Writes a WAV.', {
    output: z.string().regex(/\\.wav$/i),
    duration: z.number().min(0.5).max(30).default(4),
    notes: z.array(z.object({ tick: z.number().optional(), midi: z.number(), length: z.number().optional() })).optional(),
    vibratoHz: z.number().min(0).max(12).default(5.5),
    vibratoDepth: z.number().min(0).max(0.3).default(0.08),
    portamento: z.number().min(0).max(1).default(0.15),
  }, async ({ output, duration, notes, vibratoHz, vibratoDepth, portamento }) => {
    const audio = thereminVoice({ notes: notes ?? [{ midi: 69, tick: 0, length: 96 }], duration, sampleRate: 48000, vibratoHz, vibratoDepth, portamento });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(root, output), dsp.encodeWav(audio), { flag: 'wx' });
    return { output, duration, frames: audio.frames, engine: 'aether-theremin' };
  });
}
