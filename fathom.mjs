import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const sampleRate = 48000;
const blockSize = 128;

export async function renderFathom({ worklet, patch, notes, cutoff, secondsPerTick, durationTicks }) {
  let Processor;
  const context = vm.createContext({
    AudioWorkletProcessor: class {},
    currentTime: 0,
    sampleRate,
    registerProcessor(name, implementation) {
      if (name === 'fathom-synth') Processor = implementation;
    },
  });
  vm.runInContext(await readFile(worklet, 'utf8'), context, { filename: worklet, timeout: 1000 });
  if (!Processor) throw new Error('Configured worklet does not register fathom-synth');
  const synth = new Processor();
  const events = notes.flatMap(({ tick, length, midi, velocity }, id) => [
    { tick, type: 'noteOn', id: id + 1, midi, velocity, source: 'key' },
    { tick: tick + length, type: 'noteOff', id: id + 1, source: 'key' },
  ]).map(({ tick, ...event }) => ({ ...event, frame: Math.round(tick * secondsPerTick * sampleRate) }))
    .sort((a, b) => a.frame - b.frame);

  const frames = Math.round(durationTicks * secondsPerTick * sampleRate);
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(frames * 2, 40);

  const samples = new Float32Array(blockSize);
  let eventIndex = 0;
  let pointIndex = 0;
  let peak = 0;
  for (let frame = 0; frame < frames; frame += blockSize) {
    context.currentTime = frame / sampleRate;
    const tick = frame / (secondsPerTick * sampleRate);
    while (pointIndex + 1 < cutoff.length && cutoff[pointIndex + 1].tick <= tick) pointIndex++;
    const point = cutoff[pointIndex];
    const next = cutoff[pointIndex + 1];
    // Interpolate by frequency ratio for a musically even sweep.
    const hz = next ? point.hz * (next.hz / point.hz) ** ((tick - point.tick) / (next.tick - point.tick)) : point.hz;
    patch.filter.cutoff = hz;
    synth.onMessage({ type: 'patch', patch });

    while (eventIndex < events.length && events[eventIndex].frame < frame + blockSize) {
      const event = events[eventIndex++];
      // The worklet floors the offset. Schedule inside the intended sample.
      synth.onMessage({ ...event, when: (event.frame + 0.25) / sampleRate });
    }
    const block = samples.subarray(0, Math.min(blockSize, frames - frame));
    synth.process([], [[block]]);
    for (let i = 0; i < block.length; i++) {
      // Fade only the last 5 ms to keep the exported loop boundary clean.
      const fade = Math.min(1, (frames - 1 - frame - i) / 240);
      const value = block[i] * patch.volume * fade;
      peak = Math.max(peak, Math.abs(value));
      wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + (frame + i) * 2);
    }
  }
  if (!Number.isFinite(peak) || peak < 1 / 32767) throw new Error('Fathom produced no audible output. Check the patch and note range.');
  return wav;
}
