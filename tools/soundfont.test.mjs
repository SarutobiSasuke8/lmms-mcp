import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fluidsynthArgs } from './soundfont.mjs';

test('fluidsynthArgs builds a non-interactive file render command', () => {
  const args = fluidsynthArgs({
    midi: '/tmp/song.mid',
    soundfont: '/sounds/piano.sf2',
    output: '/out/song.wav',
    gain: 0.7,
    sampleRate: 44100,
    reverb: true,
    chorus: false,
  });
  assert.ok(args.includes('-ni'));
  assert.ok(args.includes('-F'));
  assert.equal(args.at(-2), '/sounds/piano.sf2');
  assert.equal(args.at(-1), '/tmp/song.mid');
  assert.ok(args.includes('44100'));
  assert.ok(args.includes('synth.reverb.active=1'));
  assert.ok(args.includes('synth.chorus.active=0'));
});

test('fluidsynthArgs defaults to 48 kHz and no effects', () => {
  const args = fluidsynthArgs({
    midi: 'a.mid',
    soundfont: 'b.sf2',
    output: 'c.wav',
  });
  assert.ok(args.includes('48000'));
  assert.ok(args.includes('synth.reverb.active=0'));
  assert.ok(args.includes('0.8'));
});
