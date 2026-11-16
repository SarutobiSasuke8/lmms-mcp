import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkNoteMap, lmmsDataCandidates, lmmsDataDirectory, renderTimeoutMs, vst3SetupText } from './vst3-linux.mjs';
import * as dsp from '../audio.mjs';

test('Linux data directories are looked up beside the prefix and in /usr/share', () => {
  const candidates = lmmsDataCandidates('/opt/lmms/bin/lmms', { platform: 'linux' });
  assert.deepEqual(candidates, ['/opt/lmms/bin/data', '/opt/lmms/share/lmms', '/usr/share/lmms', '/usr/local/share/lmms']);
  assert.equal(lmmsDataDirectory('/opt/lmms/bin/lmms', { platform: 'linux', exists: p => p === '/opt/lmms/share/lmms' }), '/opt/lmms/share/lmms');
  assert.equal(lmmsDataDirectory('/usr/bin/lmms', { platform: 'linux', exists: p => p === '/usr/share/lmms' }), '/usr/share/lmms');
});

test('the data folder beside the executable still wins, and a missing install keeps the old path', () => {
  assert.equal(lmmsDataDirectory('/opt/lmms/bin/lmms', { platform: 'linux', exists: () => true }), '/opt/lmms/bin/data');
  assert.equal(lmmsDataDirectory('/nowhere/bin/lmms', { platform: 'linux', exists: () => false }), '/nowhere/bin/data');
  assert.equal(lmmsDataDirectory('C:/Program Files/LMMS/lmms.exe', { platform: 'win32', exists: () => false }), 'C:\\Program Files\\LMMS\\data');
});

test('a bare lmms command is found through PATH', () => {
  const exists = p => p === '/usr/bin/lmms' || p === '/usr/share/lmms';
  assert.equal(lmmsDataDirectory('lmms', { platform: 'linux', pathEnv: '/bin:/usr/bin', exists }), '/usr/share/lmms');
  assert.equal(lmmsDataDirectory('lmms', { platform: 'linux', pathEnv: '', exists: () => false }), 'data');
});

test('the render timeout grows with tracks and length, never drops below 590 s, and can be overridden', () => {
  assert.equal(renderTimeoutMs(1, 30, {}), 590000);
  const eight = renderTimeoutMs(8, 240, {});
  assert.ok(eight > 590000, String(eight));
  assert.ok(renderTimeoutMs(8, 240, {}) > renderTimeoutMs(4, 240, {}));
  assert.ok(renderTimeoutMs(8, 600, {}) <= 3600000);
  assert.equal(renderTimeoutMs(8, 240, { LMMS_VST3_TIMEOUT_SECONDS: '900' }), 900000);
  assert.equal(renderTimeoutMs(1, 30, { LMMS_VST3_TIMEOUT_SECONDS: 'x' }), 590000);
});

test('setup text names the right script for the platform', () => {
  assert.match(vst3SetupText('linux'), /setup-vst3-linux\.sh/);
  assert.match(vst3SetupText('win32'), /setup-vst3-windows\.ps1/);
  assert.doesNotMatch(vst3SetupText('linux'), /Windows only|Windows x64/);
  assert.doesNotMatch(vst3SetupText('win32'), /Python 3\.12/);
  assert.match(vst3SetupText('darwin'), /LMMS_VST3_PYTHON/);
});

test('note maps accept numbers and *, and reject anything else', () => {
  assert.deepEqual(checkNoteMap({ '69': 36, '*': 38 }), { '69': 36, '*': 38 });
  assert.deepEqual(checkNoteMap(undefined), {});
  assert.throws(() => checkNoteMap({ kick: 36 }), /Note map key/);
  assert.throws(() => checkNoteMap({ '200': 36 }), /Note map key/);
  assert.throws(() => checkNoteMap({ '69': 200 }), /Note map value/);
  assert.throws(() => checkNoteMap({ '69': 36.5 }), /Note map value/);
});

function tone(hz, seconds, level, sampleRate = 48000) {
  const frames = Math.round(seconds * sampleRate);
  const data = Float32Array.from({ length: frames }, (_, i) => level * Math.sin(2 * Math.PI * hz * i / sampleRate));
  return { sampleRate, frames, channels: [data, data.slice()] };
}

test('the true-peak limiter holds inter-sample peaks under the ceiling where a sample-peak limiter does not', () => {
  // A tone at a quarter of the sample rate, offset in phase, has samples at 0.707 of its crest: the true peak is about 3 dB higher.
  const make = () => {
    const audio = tone(12000, 1, 1.4);
    for (const ch of audio.channels) for (let i = 0; i < ch.length; i++) ch[i] = 1.4 * Math.sin(2 * Math.PI * 12000 * i / 48000 + Math.PI / 4);
    return audio;
  };
  const sampleOnly = make();
  dsp.limit(sampleOnly, -1);
  const sampleOnlyTruePeak = dsp.db(dsp.truePeak(sampleOnly));
  assert.ok(sampleOnlyTruePeak > -0.9, `expected the old limiter to overshoot, got ${sampleOnlyTruePeak}`);
  const audio = make();
  const result = dsp.limitTruePeak(audio, -1);
  const truePeak = dsp.db(dsp.truePeak(audio));
  assert.ok(truePeak <= -0.99, `true peak ${truePeak} dBTP`);
  assert.ok(truePeak >= -1.3, `true peak ${truePeak} dBTP is far below the ceiling`);
  assert.equal(result.truePeakDb, truePeak);
  assert.ok(result.sampleCeilingDb < -1);
});

test('the true-peak limiter leaves quiet audio alone', () => {
  const audio = tone(440, 0.5, 0.3);
  const before = Float32Array.from(audio.channels[0]);
  const result = dsp.limitTruePeak(audio, -1);
  assert.equal(result.limitedSamples, 0);
  assert.deepEqual(Array.from(audio.channels[0].slice(0, 50)), Array.from(before.slice(0, 50)));
});

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'setup-vst3-linux.sh');
const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
const hasBash = bash.status === 0;

test('setup-vst3-linux.sh parses', { skip: !hasBash && 'bash is not available' }, () => {
  const result = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('setup-vst3-linux.sh writes mcp-env.json from local bundles, and refuses a download with no hash', { skip: !hasBash && 'bash is not available' }, () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'vst3-setup-'));
  try {
    const toBash = p => p.replace(/\\/g, '/');
    const bundle = path.join(temp, 'bundles', 'Surge XT.vst3');
    mkdirSync(path.join(bundle, 'Contents', 'x86_64-linux'), { recursive: true });
    const target = path.join(temp, 'install');
    const env = { ...process.env, LMMS_SETUP_ALLOW_ANY_OS: '1' };
    const ok = spawnSync('bash', [script, '--install-directory', toBash(target), '--skip-python', '--surge-xt-bundle', toBash(bundle)], { encoding: 'utf8', env });
    assert.equal(ok.status, 0, ok.stderr);
    const written = JSON.parse(readFileSync(path.join(target, 'mcp-env.json'), 'utf8'));
    assert.deepEqual(Object.keys(written), ['LMMS_SURGE_XT_VST3']);
    assert.match(written.LMMS_SURGE_XT_VST3, /Surge XT\.vst3$/);
    assert.match(ok.stdout, /No Decent Sampler yet/);
    const noHash = spawnSync('bash', [script, '--install-directory', toBash(path.join(temp, 'second')), '--skip-python'],
      { encoding: 'utf8', env: { ...env, DECENT_SAMPLER_URL: 'https://example.invalid/x.tar.gz', DECENT_SAMPLER_SHA256: '' } });
    assert.notEqual(noHash.status, 0);
    assert.match(noHash.stderr, /SHA-256/);
    const exists = spawnSync('bash', [script, '--install-directory', toBash(target), '--skip-python'], { encoding: 'utf8', env });
    assert.notEqual(exists.status, 0);
    assert.match(exists.stderr, /already exists/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
