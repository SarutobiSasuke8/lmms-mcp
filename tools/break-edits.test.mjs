import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readPattern, slicePoints, stretch } from './break-edits.mjs';
import { ffmpegWorks } from './loop-prep.mjs';

test('sixteenth grid uses tempo and a final partial slice', () => {
  assert.deepEqual(slicePoints({ frames: 15500, sampleRate: 48000 }, 120, 'sixteenth'), [0, 6000, 12000, 15500]);
  assert.deepEqual(readPattern('3, 1 2 2', 3), [2, 0, 1, 1]);
  assert.throws(() => readPattern('3 0', 3), /slice numbers/);
});

test('transient slicing finds separated hits without slicing silence', () => {
  const audio = { frames: 48000, sampleRate: 48000, channels: [new Float32Array(48000)] };
  assert.deepEqual(slicePoints(audio, 120, 'transient'), [0, 48000]);
  for (const where of [12000, 30000]) audio.channels[0].fill(0.65, where, where + 180);
  const points = slicePoints(audio, 120, 'transient');
  assert.equal(points.length, 4);
  assert.ok(Math.abs(points[1] - 12000) <= 480);
  assert.ok(Math.abs(points[2] - 30000) <= 480);
});

test('ffmpeg stretch changes length and preserves pitch', async t => {
  if (!(await ffmpegWorks())) return t.skip('ffmpeg not installed');
  const root = await mkdtemp(path.join(os.tmpdir(), 'lmms-stretch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oneKHz = Float32Array.from({ length: 48000 }, (_, i) => 0.4 * Math.sin(2 * Math.PI * i / 48));
  const out = await stretch({ sampleRate: 48000, channels: [oneKHz], frames: 48000 }, 1.25, root);
  assert.equal(out.frames, 38400);
  const channel = out.channels[0];
  let crossings = 0;
  for (let i = 4801; i <= 14400; i++) if (channel[i - 1] < 0 && channel[i] >= 0) crossings++;
  assert.ok(Math.abs(crossings - 200) <= 1);
});
