// End-to-end check of auto_balance and compare_to_reference through a real stdio connection and the installed LMMS.
// Run: node verify-balance.mjs
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const workspace = await mkdtemp(path.join(tmpdir(), 'lmms-balance-check-'));
console.log(workspace);
const client = new Client({ name: 'lmms-balance-check', version: '1' });
await client.connect(new StdioClientTransport({
  command: process.execPath, args: [fileURLToPath(new URL('./server.mjs', import.meta.url))],
  env: { ...process.env, LMMS_WORKSPACE: workspace },
}));
async function raw(name, args) {
  return client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
}
async function call(name, args = {}) {
  const result = await raw(name, args);
  assert.ok(!result.isError, `${name}: ${result.content[0].text}`);
  return JSON.parse(result.content[0].text);
}
async function fails(name, args, pattern) {
  const result = await raw(name, args);
  assert.ok(result.isError, `${name} should have failed`);
  assert.match(result.content[0].text, pattern);
}
const step = label => console.log('ok', label);
const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} is not within ${tolerance} of ${expected}`);
try {
  const tools = (await client.listTools()).tools.map(t => t.name);
  for (const name of ['auto_balance', 'compare_to_reference']) assert.ok(tools.includes(name), name);
  assert.ok((await call('get_started')).moduleGuidance.some(line => /auto_balance/.test(line)));
  step('tools listed and guidance published');

  // 12 bars at 120 BPM. The lead only enters at bar 4, so the loudest 8 bars are 4 to 12.
  // The hats are far too loud and carry no role, the pad is far too quiet (volume 4). The lead target is overridden.
  await call('create_project', { output: 'song.mmp', bpm: 120, lengthBars: 12, tracks: [
    { name: 'Kick', role: 'drums', voice: 'sample', factorySample: 'drums/kick01.ogg', volume: 100, patterns: [{ name: 'Beat', bar: 0, bars: 12, steps: { grid: 'X---x---X-x-x---' } }] },
    { name: 'Hats', voice: 'sample', factorySample: 'drums/hihat_closed01.ogg', volume: 100, patterns: [{ name: 'Beat', bar: 0, bars: 12, steps: { grid: 'x-x-x-x-x-x-x-x-' } }] },
    { name: 'Bass', role: 'bass', voice: 'bass', volume: 60, patterns: [{ name: 'Line', bar: 0, bars: 12, chords: { progression: 'Dm Bb F C', style: 'bass', figure: 'octaves' } }] },
    { name: 'Pad', role: 'texture', voice: 'pad', volume: 4, patterns: [{ name: 'Chords', bar: 0, bars: 12, chords: { progression: 'Dm Bb F C' } }] },
    { name: 'Lead', role: 'lead', voice: 'pluck', volume: 150, patterns: [{ name: 'Tune', bar: 4, bars: 8, melody: { line: 'D5:3 F5:3 A5:6 G5:2 F5:2 | G5:3 F5:3 D5:6 r:4' } }] },
  ] });
  // Volume automation on the bass: auto_balance must scale its points rather than refuse.
  await call('automate_track', { project: 'song.mmp', output: 'song-auto.mmp', trackName: 'Bass', name: 'Bass swell', control: 'volume',
    startTick: 0, length: 12 * 192, curve: 'linear', points: [{ tick: 0, value: 40 }, { tick: 6 * 192, value: 80 }, { tick: 12 * 192 - 1, value: 80 }] });
  await fails('auto_balance', { project: 'song-auto.mmp' }, /output/);

  const targets = { roles: { lead: -20 } };
  const dry = await call('auto_balance', { project: 'song-auto.mmp', dryRun: true, targets });
  assert.equal(dry.dryRun, true);
  assert.ok(!existsSync(path.join(workspace, 'balanced.mmp')));
  const balance = await call('auto_balance', { project: 'song-auto.mmp', output: 'balanced.mmp', targets });
  console.log(JSON.stringify({ window: balance.window, master: balance.master, predictedMix: balance.predictedMix, masking: balance.masking, mono: balance.mono, notes: balance.notes }, null, 1));
  console.table(balance.tracks.map(({ track, role, kind, roleSource, measure, measuredDb, targetDb, gainDb, volumeBefore, volumeAfter, predictedDb }) =>
    ({ track, role, kind, roleSource, measure, measuredDb, targetDb, gainDb, volumeBefore, volumeAfter, predictedDb })));
  assert.deepEqual(dry.tracks.map(t => t.volumeAfter), balance.tracks.map(t => t.volumeAfter), 'dry run plans the same change');
  assert.equal(balance.window.startBar, 4, 'the loudest stretch starts where the lead enters');
  assert.equal(balance.window.bars, 8);
  const row = name => balance.tracks.find(t => t.track === name);
  assert.ok(row('Hats').gainDb < -10, 'hats come down a lot');
  assert.equal(row('Lead').targetDb, -20);
  assert.equal(row('Lead').targetFrom, 'role override');
  assert.ok(row('Pad').gainDb > 6, 'pad comes up a lot');
  assert.equal(row('Hats').role, 'drums');
  assert.equal(row('Hats').kind, 'hat');
  assert.match(row('Hats').roleSource, /guess/);
  assert.equal(row('Kick').kind, 'kick');
  assert.equal(row('Kick').measure, 'peak');
  assert.equal(row('Pad').measure, 'rms');
  assert.equal(row('Bass').automated, true);
  assert.ok(balance.automation.some(line => /^Bass: scaled 3 automation points/.test(line)), 'bass automation scaled');
  assert.ok(balance.notes.some(line => /Hats/.test(line)), 'guessed roles are reported');
  for (const t of balance.tracks) assert.ok(!t.warning, `${t.track}: ${t.warning}`);
  step('auto_balance planned and wrote one project: hats down, pad up, guessed hats, scaled automation');

  // Render the balanced stems and measure them over the same window.
  const { stems } = await call('render_stems', { project: 'balanced.mmp', outputDirectory: 'stems' });
  const [from, to] = balance.window.seconds;
  for (const stem of stems) {
    const planned = row(stem.track);
    const report = await call('analyze_audio', { audio: `stems/${stem.file}`, sections: [{ name: 'window', startSeconds: from, endSeconds: to }] });
    const measured = report.sections[0][planned.measure === 'peak' ? 'peakDbfs' : 'rmsDbfs'];
    console.log(`${stem.track}: ${planned.measure} ${measured} dBFS, predicted ${planned.predictedDb}, target ${planned.targetDb}`);
    near(measured, planned.predictedDb, 1, `${stem.track} lands on its prediction`);
    near(measured, planned.targetDb + balance.master.stemOffsetDb, 1, `${stem.track} lands on its target (at master ${balance.master.after})`);
  }
  step('every stem lands within 1 dB of its target');

  const mix = await call('render_mix', { project: 'balanced.mmp', output: 'balanced.wav' });
  assert.equal(mix.fullScaleSamples, 0, 'mix does not clip');
  assert.ok(mix.peakDbfs <= -balance.headroomDb + 1, `mix peak ${mix.peakDbfs} keeps roughly the headroom`);
  near(mix.peakDbfs, balance.predictedMix.after.peakDbfs, 1, 'real mix peak against the prediction');
  near(mix.integratedLufs, balance.predictedMix.after.integratedLufs, 1, 'real mix loudness against the prediction');
  step(`mix peak ${mix.peakDbfs} dBFS against a predicted ${balance.predictedMix.after.peakDbfs}, no clipping`);

  // A second pass over the balanced project should want almost nothing.
  const again = await call('auto_balance', { project: 'balanced.mmp', dryRun: true, targets });
  for (const t of again.tracks) assert.ok(Math.abs(t.gainDb) <= 1, `${t.track} second pass wants ${t.gainDb} dB`);
  step('a second pass is stable');

  // Fit mode raises a quiet mix so its predicted peak lands on the headroom.
  await call('set_master', { project: 'balanced.mmp', output: 'quiet.mmp', volume: Number((balance.master.after / 4).toFixed(2)) });
  const fit = await call('auto_balance', { project: 'quiet.mmp', output: 'fit.mmp', master: 'fit', headroomDb: 3, targets });
  near(fit.predictedMix.after.peakDbfs, -3, 0.1, 'fit mode predicted peak');
  const fitMix = await call('render_mix', { project: 'fit.mmp', output: 'fit.wav' });
  near(fitMix.peakDbfs, -3, 1, 'fit mode real peak');
  step('master fit mode lands the peak on the headroom');

  // compare_to_reference on renders that differ in known ways.
  await call('render_mix', { project: 'quiet.mmp', output: 'quiet.wav' });
  const level = await call('compare_to_reference', { audio: 'quiet.wav', reference: 'balanced.wav' });
  near(level.differences.loudnessLu, -12.04, 0.5, 'a quarter of the master volume reads 12 LU quieter');
  for (const [band, d] of Object.entries(level.differences.bandsDb)) if (d !== null) near(d, 0, 0.5, `${band} balance is unchanged by level`);
  assert.ok(level.suggestions[0].includes('LU quieter'), level.suggestions[0]);
  await call('set_track_mix', { project: 'balanced.mmp', output: 'no-hats.mmp', trackName: 'Hats', mute: true });
  await call('render_mix', { project: 'no-hats.mmp', output: 'no-hats.wav' });
  const dark = await call('compare_to_reference', { audio: 'no-hats.wav', reference: 'balanced.wav',
    sections: [{ name: 'with lead', startSeconds: 8, endSeconds: 24 }] });
  console.log(dark.suggestions);
  assert.ok(dark.differences.bandsDb.air < -3, `air band ${dark.differences.bandsDb.air}`);
  assert.ok(dark.differences.centroidRatio < 1);
  assert.ok(dark.suggestions.some(s => /less energy in 6 to 20 kHz than the reference: raise the hats/.test(s)));
  assert.ok(dark.sections[0].differences.bandsDb.air < -3);
  step('compare_to_reference reports a pure level change as level and missing hats as missing air');
  console.log('All balance checks passed.');
} finally {
  await client.close();
}
