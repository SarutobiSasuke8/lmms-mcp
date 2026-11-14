#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { deflateSync, inflateSync } from 'node:zlib';
import midiPackage from '@tonejs/midi';
import { createConnection } from 'node:net';

const run = promisify(execFile);
const root = path.resolve(process.env.LMMS_WORKSPACE ?? process.cwd());
const lmms = process.env.LMMS_EXECUTABLE ??
  (process.platform === 'win32' ? 'C:/Program Files/LMMS/lmms.exe' : 'lmms');
const presets = path.resolve(process.env.LMMS_PRESETS ?? path.join(path.dirname(lmms), 'data', 'presets'));
const server = new McpServer({ name: 'lmms-project-tools', version: '0.3.0' });
const projectName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.mmpz?$/i);
const compressed = name => name.toLowerCase().endsWith('.mmpz');
const maxProjectBytes = 32 * 1024 * 1024;
const note = z.object({
  tick: z.number().int().min(0), length: z.number().int().min(1),
  midi: z.number().int().min(12).max(119), velocity: z.number().int().min(1).max(100),
});
const pattern = z.object({
  name: z.string().min(1).max(100), bar: z.number().int().min(0).max(255),
  bars: z.number().int().min(1).max(64), notes: z.array(note).min(1).max(4096),
});
const track = z.object({
  name: z.string().min(1).max(100), voice: z.enum(['pluck', 'bass', 'pad', 'kick', 'clap', 'hat']),
  volume: z.number().int().min(0).max(100), pan: z.number().int().min(-100).max(100).default(0),
  patterns: z.array(pattern).min(1).max(64),
});
const kit = { kick: 'kick_soft01', clap: 'clap01', hat: 'hihat_closed01' };
const tones = {
  pluck: { waves: [1, 2, 0], gains: [33, 14, 18], cutoff: 3400, sustain: .24, decay: .22, release: .075 },
  bass: { waves: [2, 0, 1], gains: [30, 44, 0], cutoff: 820, sustain: .72, decay: .24, release: .05 },
  pad: { waves: [1, 1, 0], gains: [29, 24, 14], cutoff: 1800, sustain: .67, decay: .48, release: .19 },
};

function add(parent, tag, attrs = {}) {
  const node = (parent.ownerDocument ?? parent).createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  parent.appendChild(node);
  return node;
}
const children = (node, tag) => Array.from(node?.childNodes ?? []).filter(child => child.nodeName === tag);
const xml = new XMLSerializer();
function parse(source) {
  const doc = new DOMParser().parseFromString(source, 'application/xml');
  if (doc.documentElement.tagName !== 'lmms-project') throw new Error('Expected an LMMS project');
  return doc;
}
async function load(project) {
  const filePath = path.join(root, project);
  const info = await lstat(filePath);
  if (!info.isFile() || info.size > maxProjectBytes) throw new Error('Expected a regular project file up to 32 MiB');
  const file = await readFile(filePath);
  if (file.length > maxProjectBytes) throw new Error('Project exceeds 32 MiB');
  if (!compressed(project)) return parse(file.toString('utf8'));
  if (file.length < 5 || file.readUInt32BE(0) > maxProjectBytes) throw new Error('Invalid compressed project size');
  const source = inflateSync(file.subarray(4), { maxOutputLength: maxProjectBytes });
  if (source.length !== file.readUInt32BE(0)) throw new Error('Compressed project size mismatch');
  return parse(source.toString('utf8'));
}
async function save(doc, output) {
  const source = Buffer.from(xml.serializeToString(doc), 'utf8');
  if (source.length > maxProjectBytes) throw new Error('Project exceeds 32 MiB');
  let file = source;
  if (compressed(output)) {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(source.length);
    file = Buffer.concat([prefix, deflateSync(source)]);
  }
  await writeFile(path.join(root, output), file, { flag: 'wx' });
  return { project: output };
}
function tracks(doc) {
  const song = children(doc.documentElement, 'song')[0];
  return children(children(song, 'trackcontainer')[0], 'track');
}
function addPattern(target, part) {
  const ticks = part.bars * 192;
  if (part.notes.some(n => n.tick + n.length > ticks)) throw new Error('Note extends beyond pattern');
  const clip = add(target, 'pattern', { name: part.name, pos: part.bar * 192, len: ticks, type: 1, steps: 16, muted: 0 });
  for (const n of part.notes) add(clip, 'note', { key: n.midi - 12, pos: n.tick, len: n.length, vol: n.velocity, pan: 0 });
  return clip;
}
function addTrack(container, item) {
  const target = add(container, 'track', { muted: 0, solo: 0, type: 0, name: item.name });
  const instrumentTrack = add(target, 'instrumenttrack', { vol: item.volume, pan: item.pan, basenote: 57, fxch: 0 });
  if (item.voice in kit) {
    add(add(instrumentTrack, 'instrument', { name: 'audiofileprocessor' }), 'audiofileprocessor',
      { src: 'drums/' + kit[item.voice] + '.ogg', amp: 100, sframe: 0, eframe: 1, interp: 1 });
  } else {
    const tone = tones[item.voice];
    const oscillator = { modalgo1: 2, modalgo2: 2 };
    for (let i = 0; i < 3; i++) {
      oscillator['wavetype' + i] = tone.waves[i];
      oscillator['vol' + i] = tone.gains[i];
      oscillator['coarse' + i] = 0;
      oscillator['finel' + i] = i * -3;
      oscillator['finer' + i] = i * 3;
    }
    add(add(instrumentTrack, 'instrument', { name: 'tripleoscillator' }), 'tripleoscillator', oscillator);
    const envelope = add(instrumentTrack, 'eldata', { fwet: 1, ftype: 0, fcut: tone.cutoff, fres: .7 });
    add(envelope, 'elvol', { amt: 1, att: item.voice === 'pad' ? .14 : .02, hold: 0,
      dec: tone.decay, sustain: tone.sustain, rel: tone.release });
  }
  for (const part of item.patterns) addPattern(target, part);
}
function tool(name, description, inputSchema, handler) {
  server.registerTool(name, { description, inputSchema }, async args => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await handler(args)) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });
}
tool('create_project', 'Create an editable 4/4 LMMS project. One bar is 192 ticks, one beat is 48. Drum notes use MIDI 69 at original pitch.', {
  output: projectName, bpm: z.number().int().min(45).max(240), tracks: z.array(track).min(1).max(24),
}, async ({ output, bpm, tracks: items }) => {
  if (new Set(items.map(t => t.name)).size !== items.length) throw new Error('Track names must be unique');
  const doc = parse('<?xml version="1.0"?><!DOCTYPE lmms-project><lmms-project version="1.0" creator="LMMS" creatorversion="1.2.2" type="song"/>');
  add(doc.documentElement, 'head', { bpm, mastervol: 86, timesig_numerator: 4, timesig_denominator: 4 });
  const container = add(add(doc.documentElement, 'song'), 'trackcontainer', { type: 'song' });
  for (const item of items) addTrack(container, item);
  return save(doc, output);
});
tool('inspect_project', 'Read saved instrument tracks, pattern locations and note counts.', { project: projectName },
  async ({ project }) => tracks(await load(project)).map(t => ({
    name: t.getAttribute('name'), patterns: children(t, 'pattern').map(p => ({
      name: p.getAttribute('name'), tick: Number(p.getAttribute('pos')),
      length: Number(p.getAttribute('len')), notes: children(p, 'note').length,
    })),
  })));
tool('read_pattern', 'Read the notes in a saved instrument pattern. Bar numbers start at zero.', {
  project: projectName, trackName: z.string(), bar: z.number().int().min(0).max(255),
}, async ({ project, trackName, bar }) => {
  const [, clip] = findPattern(await load(project), trackName, bar);
  return {
    name: clip.getAttribute('name'), bar, ticks: Number(clip.getAttribute('len')),
    notes: children(clip, 'note').map(n => ({
      midi: Number(n.getAttribute('key')) + 12, tick: Number(n.getAttribute('pos')),
      length: Number(n.getAttribute('len')), velocity: Number(n.getAttribute('vol')),
    })),
  };
});
function findPattern(doc, trackName, bar) {
  const matching = tracks(doc).filter(t => t.getAttribute('name') === trackName && t.getAttribute('type') === '0');
  if (matching.length !== 1) throw new Error('Expected one matching instrument track');
  const [target] = matching;
  const clips = children(target, 'pattern').filter(p => Number(p.getAttribute('pos')) === bar * 192);
  if (clips.length !== 1) throw new Error('Expected one pattern at the specified bar');
  return [target, clips[0]];
}
tool('replace_pattern', 'Write an independent project copy with one arrangement pattern replaced. Identify the existing pattern by track and bar.', {
  project: projectName, output: projectName, trackName: z.string(), pattern,
}, async ({ project, output, trackName, pattern: part }) => {
  const doc = await load(project);
  const [target, clip] = findPattern(doc, trackName, part.bar);
  target.replaceChild(addPattern(target, part), clip);
  return save(doc, output);
});
tool('save_project_copy', 'Copy a native saved project between .mmp and .mmpz, preserving its XML content.', {
  project: projectName, output: projectName,
}, async ({ project, output }) => save(await load(project), output));
tool('set_track_mix', 'Save a project copy with volume, pan, mute or solo changed on one instrument track.', {
  project: projectName, output: projectName, trackName: z.string(),
  volume: z.number().int().min(0).max(200).optional(),
  pan: z.number().int().min(-100).max(100).optional(),
  mute: z.boolean().optional(), solo: z.boolean().optional(),
}, async ({ project, output, trackName, volume, pan, mute, solo }) => {
  if ([volume, pan, mute, solo].every(value => value === undefined)) throw new Error('Provide at least one mix control');
  const doc = await load(project);
  const matching = tracks(doc).filter(t => t.getAttribute('name') === trackName && t.getAttribute('type') === '0');
  if (matching.length !== 1) throw new Error('Expected one matching instrument track');
  const [target] = matching;
  const [instrument] = children(target, 'instrumenttrack');
  for (const [node, key, value] of [[instrument, 'vol', volume], [instrument, 'pan', pan],
    [target, 'muted', mute], [target, 'solo', solo]]) {
    if (value === undefined) continue;
    if (children(node, key).length) throw new Error('Control uses an LMMS model. Edit its automation in LMMS.');
    node.setAttribute(key, String(typeof value === 'boolean' ? Number(value) : value));
  }
  return save(doc, output);
});
const presetFile = z.string().regex(/^[\w -]+\/[\w .()-]+\.xpf$/i);
tool('list_presets', 'List installed XML factory preset paths.', {}, async () => {
  const groups = await readdir(presets, { withFileTypes: true });
  const files = await Promise.all(groups.filter(group => group.isDirectory()).map(async group => {
    const entries = await readdir(path.join(presets, group.name), { withFileTypes: true });
    return entries.filter(entry => entry.isFile()).map(entry => group.name + '/' + entry.name);
  }));
  return files.flat().filter(name => presetFile.safeParse(name).success).sort();
});
function instrumentOf(doc, name) {
  const matching = tracks(doc).filter(track => track.getAttribute('name') === name && track.getAttribute('type') === '0');
  const instrument = matching.length === 1 && children(matching[0], 'instrumenttrack')[0];
  if (!instrument) throw new Error('Expected one instrument track named ' + name);
  return instrument;
}
tool('apply_preset', 'Load an installed XML preset sound into a track in a new project copy.', {
  project: projectName, output: projectName, trackName: z.string(), preset: presetFile,
}, async ({ project, output, trackName, preset }) => {
  const doc = await load(project);
  const target = instrumentOf(doc, trackName);
  const source = new DOMParser().parseFromString(await readFile(path.join(presets, preset), 'utf8'), 'application/xml');
  const settings = Array.from(source.getElementsByTagName('instrumenttrack'))[0];
  if (!settings || !children(settings, 'instrument').length) throw new Error('Expected a native instrument preset with an instrument element');
  for (const tag of ['instrument', 'eldata']) {
    const [next] = children(settings, tag);
    const [previous] = children(target, tag);
    if (previous && Array.from(previous.getElementsByTagName('*')).some(node => node.hasAttribute('id'))) {
      throw new Error('Existing instrument has linked controls');
    }
    if (next && Array.from(next.getElementsByTagName('*')).some(node => node.hasAttribute('id'))) {
      throw new Error('Preset contains model IDs that require remapping');
    }
    if (previous) target.removeChild(previous);
    if (next) target.appendChild(doc.importNode(next, true));
  }
  const baseNote = settings.getAttribute('basenote');
  if (baseNote) target.setAttribute('basenote', baseNote);
  return save(doc, output);
});
tool('route_mixer_bus', 'Create a mixer bus sending to Master and route named instrument tracks to it.', {
  project: projectName, output: projectName, bus: z.string().min(1).max(80),
  tracks: z.array(z.string()).min(1), gain: z.number().min(0).max(2).default(1),
}, async ({ project, output, bus, tracks: names, gain }) => {
  const doc = await load(project);
  const targets = names.map(name => instrumentOf(doc, name));
  const [song] = children(doc.documentElement, 'song');
  const mixer = children(song, 'fxmixer')[0] ?? add(song, 'fxmixer');
  if (!children(mixer, 'fxchannel').length) add(mixer, 'fxchannel', { num: 0, name: 'Master', volume: 1 });
  const channels = children(mixer, 'fxchannel');
  if (channels.some(channel => channel.getAttribute('name') === bus)) throw new Error('Mixer bus already exists');
  const number = Math.max(...channels.map(channel => Number(channel.getAttribute('num')))) + 1;
  const channel = add(mixer, 'fxchannel', { num: number, name: bus, volume: gain, muted: 0, soloed: 0 });
  add(channel, 'fxchain', { numofeffects: 0, enabled: 0 });
  add(channel, 'send', { channel: 0, amount: 1 });
  for (const target of targets) target.setAttribute('fxch', String(number));
  return save(doc, output);
});
tool('automate_track', 'Write an editable automation clip for instrument track volume or low-pass cutoff.', {
  project: projectName, output: projectName, trackName: z.string(), name: z.string().min(1),
  control: z.enum(['volume', 'cutoff']), startTick: z.number().int().min(0),
  length: z.number().int().min(1), points: z.array(z.object({
    tick: z.number().int().min(0), value: z.number(),
  })).min(2).max(4096),
}, async ({ project, output, trackName, name, control, startTick, length, points }) => {
  const doc = await load(project);
  const instrument = instrumentOf(doc, trackName);
  const parent = control === 'volume' ? instrument : children(instrument, 'eldata')[0];
  const key = control === 'volume' ? 'vol' : 'fcut';
  const [min, max] = control === 'volume' ? [0, 200] : [5, 14000];
  if (!parent) throw new Error('Track has no filter controls');
  if (children(parent, key).length) throw new Error('Control already has a model or automation');
  if (points[0].tick !== 0 || points.some(({ tick, value }, index) =>
    tick >= length || value < min || value > max || (index > 0 && tick <= points[index - 1].tick))) {
    throw new Error('Use ascending unique ticks starting at zero and values within the control range');
  }
  const used = new Set(Array.from(doc.getElementsByTagName('*')).map(node => Number(node.getAttribute('id'))));
  let id = 10000;
  while (used.has(id)) id++;
  parent.removeAttribute(key);
  if (control === 'cutoff') {
    parent.setAttribute('fwet', '1');
    parent.setAttribute('ftype', '0');
  }
  add(parent, key, { id, value: points[0].value, scale_type: 'linear' });
  const automation = add(instrument.parentNode.parentNode, 'track', { type: 5, name, muted: 0, solo: 0 });
  const clip = add(automation, 'automationpattern', { name, pos: startTick, len: length, prog: 1, tens: 1, mute: 0 });
  for (const point of points) add(clip, 'time', { pos: point.tick, value: point.value });
  add(clip, 'object', { id });
  return save(doc, output);
});
tool('inspect_arrangement', 'Read tempo, meter, mixer routes, instrument types and timeline clips.', {
  project: projectName,
}, async ({ project }) => {
  const doc = await load(project);
  const [head] = children(doc.documentElement, 'head');
  const [song] = children(doc.documentElement, 'song');
  const [mixer] = children(song, 'fxmixer');
  return {
    tempo: Number(head?.getAttribute('bpm') || 140),
    meter: [Number(head?.getAttribute('timesig_numerator') || 4), Number(head?.getAttribute('timesig_denominator') || 4)],
    mixer: mixer ? children(mixer, 'fxchannel').map(bus => ({
      id: Number(bus.getAttribute('num')), name: bus.getAttribute('name'),
      sends: children(bus, 'send').map(send => ({
        channel: Number(send.getAttribute('channel')), amount: Number(send.getAttribute('amount')),
      })),
    })) : [],
    tracks: tracks(doc).map(track => {
      const [instrument] = children(track, 'instrumenttrack');
      return {
        name: track.getAttribute('name'), type: Number(track.getAttribute('type')),
        instrument: instrument ? children(instrument, 'instrument')[0]?.getAttribute('name') ?? null : null,
        mixerChannel: instrument ? Number(instrument.getAttribute('fxch')) : null,
        clips: ['pattern', 'automationpattern', 'sampletco', 'bbtco'].flatMap(tag =>
          children(track, tag).map(clip => ({
            type: tag, name: clip.getAttribute('name'), tick: Number(clip.getAttribute('pos')),
            length: Number(clip.getAttribute('len')),
            ...(tag === 'automationpattern' ? {
              points: children(clip, 'time').map(point => ({
                tick: Number(point.getAttribute('pos')), value: Number(point.getAttribute('value')),
              })),
            } : {}),
          }))),
      };
    }),
  };
});
tool('set_project_tempo', 'Save a new project copy with a static tempo. Existing note and clip ticks stay fixed.', {
  project: projectName, output: projectName, bpm: z.number().int().min(45).max(240),
}, async ({ project, output, bpm }) => {
  const doc = await load(project);
  const [head] = children(doc.documentElement, 'head');
  if (!head || children(head, 'bpm').length) throw new Error('Expected a project with a static tempo');
  head.setAttribute('bpm', String(bpm));
  return save(doc, output);
});
function readPcm(wav) {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('LMMS did not produce a RIFF WAV');
  }
  const chunks = new Map();
  for (let start = 12; start + 8 <= wav.length;) {
    const bytes = wav.readUInt32LE(start + 4);
    const end = start + 8 + bytes;
    if (end > wav.length) throw new Error('Incomplete WAV chunk');
    chunks.set(wav.toString('ascii', start, start + 4), wav.subarray(start + 8, end));
    start = end + (bytes % 2);
  }
  const format = chunks.get('fmt ');
  const samples = chunks.get('data');
  if (!format || format.length < 16 || format.readUInt16LE(0) !== 1 || format.readUInt16LE(14) !== 16) {
    throw new Error('Expected 16-bit PCM WAV');
  }
  const channels = format.readUInt16LE(2);
  const sampleRate = format.readUInt32LE(4);
  const frameBytes = channels * 2;
  if (!sampleRate || !frameBytes || !samples?.length || samples.length % frameBytes !== 0) {
    throw new Error('Invalid PCM frame data');
  }
  return { channels, sampleRate, frameBytes, samples };
}
function measureWav(wav) {
  const { channels, sampleRate, frameBytes, samples } = readPcm(wav);
  let peak = 0;
  let sumSquares = 0;
  let fullScaleSamples = 0;
  for (let offset = 0; offset < samples.length; offset += 2) {
    const value = samples.readInt16LE(offset);
    peak = Math.max(peak, Math.abs(value));
    sumSquares += value * value;
    if (value === 32767 || value === -32768) fullScaleSamples++;
  }
  let boundaryJump = 0;
  for (let ch = 0; ch < frameBytes; ch += 2) {
    const last = samples.length - frameBytes + ch;
    boundaryJump = Math.max(boundaryJump, Math.abs(samples.readInt16LE(ch) - samples.readInt16LE(last)));
  }
  const db = value => value === 0 ? null : Number((20 * Math.log10(value / 32768)).toFixed(2));
  return { channels, sampleRate, durationSeconds: samples.length / frameBytes / sampleRate,
    peakDbfs: db(peak), rmsDbfs: db(Math.sqrt(sumSquares / (samples.length / 2))),
    fullScaleSamples, boundaryJumpDbfs: db(boundaryJump) };
}
tool('edit_clip', 'Move, duplicate, rename or remove an instrument pattern in a project copy. Positions are absolute LMMS ticks.', {
  project: projectName, output: projectName, trackName: z.string(),
  tick: z.number().int().nonnegative(),
  operation: z.enum(['move', 'duplicate', 'rename', 'remove']),
  destinationTick: z.number().int().nonnegative().optional(), name: z.string().min(1).max(100).optional(),
}, async ({ project, output, trackName, tick, operation, destinationTick, name }) => {
  const doc = await load(project);
  const target = instrumentOf(doc, trackName).parentNode;
  const patterns = children(target, 'pattern');
  const matches = patterns.filter(clip => Number(clip.getAttribute('pos')) === tick);
  if (matches.length !== 1) throw new Error('Expected one pattern at that tick');
  const [original] = matches;
  if (operation === 'remove') target.removeChild(original);
  if (operation === 'rename') {
    if (!name) throw new Error('Provide a name');
    original.setAttribute('name', name);
  }
  if (operation === 'move' || operation === 'duplicate') {
    if (destinationTick === undefined || patterns.some(clip => Number(clip.getAttribute('pos')) === destinationTick)) {
      throw new Error('Provide an unused destination tick');
    }
    const clip = operation === 'duplicate' ? target.appendChild(original.cloneNode(true)) : original;
    clip.setAttribute('pos', String(destinationTick));
    if (name) clip.setAttribute('name', name);
  }
  return save(doc, output);
});
const effectTarget = { project: projectName, trackName: z.string() };
tool('inspect_effects', 'Read the effect chain of one instrument track.', effectTarget,
  async ({ project, trackName }) => {
    const [chain] = children(instrumentOf(await load(project), trackName), 'fxchain');
    return chain ? children(chain, 'effect').map(effect => ({
      plugin: effect.getAttribute('name'), enabled: effect.getAttribute('on') !== '0', wet: Number(effect.getAttribute('wet')),
    })) : [];
  });
tool('edit_effect', 'Add a native Delay, EQ or Crossover EQ, or edit and remove existing track effects in a project copy.', {
  ...effectTarget, output: projectName, operation: z.enum(['add', 'update', 'remove']),
  plugin: z.enum(['delay', 'eq', 'crossovereq']).optional(), index: z.number().int().nonnegative().optional(),
  enabled: z.boolean().optional(), wet: z.number().min(0).max(1).optional(),
}, async ({ project, output, trackName, operation, plugin, index, enabled, wet }) => {
  const doc = await load(project);
  const instrument = instrumentOf(doc, trackName);
  const chain = children(instrument, 'fxchain')[0] ?? add(instrument, 'fxchain', { enabled: 0 });
  if (operation === 'add' && !plugin) throw new Error('Choose a supported native plugin');
  const effect = operation === 'add' ? add(chain, 'effect', { name: plugin, on: 1, wet: 1, autoquit: 1, gate: 0 }) :
    children(chain, 'effect')[index];
  if (!effect) throw new Error('Provide an existing effect index');
  if (operation === 'remove') chain.removeChild(effect);
  else {
    if (enabled !== undefined) effect.setAttribute('on', enabled ? '1' : '0');
    if (wet !== undefined) effect.setAttribute('wet', String(wet));
  }
  const count = children(chain, 'effect').length;
  chain.setAttribute('numofeffects', String(count));
  if (operation === 'add' || !count) chain.setAttribute('enabled', count ? '1' : '0');
  return save(doc, output);
});
tool('render_stems', 'Render track WAVs with the installed LMMS rendertracks command into a new directory.', {
  project: projectName, outputDirectory: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/i),
}, async ({ project, outputDirectory }) => {
  await load(project);
  const output = path.join(root, outputDirectory);
  await mkdir(output);
  const temp = await mkdtemp(path.join(root, '.stem-mix-'));
  try {
    const mix = path.join(temp, 'mix.wav');
    const options = { cwd: root, timeout: 180000, windowsHide: true };
    const args = [path.join(root, project), '-s', '48000', '-f', 'wav', '-l', '-o'];
    await run(lmms, ['render', ...args, mix], options);
    const reference = readPcm(await readFile(mix));
    await run(lmms, ['rendertracks', ...args, output], options);
    const names = (await readdir(output)).filter(name => name.toLowerCase().endsWith('.wav')).sort();
    if (!names.length) throw new Error('LMMS returned no stem WAVs');
    const stems = [];
    for (const name of names) {
      const file = path.join(output, name);
      const original = readPcm(await readFile(file));
      if (original.channels !== reference.channels || original.sampleRate !== reference.sampleRate) {
        throw new Error('Stem PCM format differs from the mix');
      }
      const dataSize = reference.samples.length;
      const wav = Buffer.alloc(44 + dataSize);
      wav.write('RIFF', 0);
      wav.writeUInt32LE(wav.length - 8, 4);
      wav.write('WAVEfmt ', 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(reference.channels, 22);
      wav.writeUInt32LE(reference.sampleRate, 24);
      wav.writeUInt32LE(reference.sampleRate * reference.frameBytes, 28);
      wav.writeUInt16LE(reference.frameBytes, 32);
      wav.writeUInt16LE(16, 34);
      wav.write('data', 36);
      wav.writeUInt32LE(dataSize, 40);
      original.samples.copy(wav, 44, 0, Math.min(dataSize, original.samples.length));
      await writeFile(file, wav);
      stems.push({ file: name, ...measureWav(wav) });
    }
    return { directory: outputDirectory, stems };
  } catch (error) {
    throw new Error('Stem render failed. Inspect the output directory before retrying: ' + error.message);
  } finally {
    await rm(temp, { recursive: true });
  }
});
tool('export_midi', 'Export instrument-pattern notes from a static-tempo project as a multitrack MIDI file.', {
  project: projectName, output: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.mid$/i),
}, async ({ project, output }) => {
  const doc = await load(project);
  const [head] = children(doc.documentElement, 'head');
  const bpm = Number(head?.getAttribute('bpm') || 140);
  const meter = [Number(head?.getAttribute('timesig_numerator') || 4), Number(head?.getAttribute('timesig_denominator') || 4)];
  if (children(head, 'bpm').length || !Number.isFinite(bpm) || bpm <= 0 ||
      !Number.isInteger(meter[0]) || meter[0] < 1 || ![1, 2, 4, 8, 16, 32].includes(meter[1])) {
    throw new Error('MIDI export requires a valid static tempo and metre');
  }
  const midi = new midiPackage.Midi();
  midi.header.setTempo(bpm);
  midi.header.timeSignatures.push({ ticks: 0, timeSignature: meter });
  midi.header.update();
  const ratio = midi.header.ppq / 48;
  const sources = tracks(doc).filter(track => track.getAttribute('type') === '0' && children(track, 'pattern').length);
  if (!sources.length || sources.length > 15) throw new Error('MIDI export supports 1 to 15 instrument tracks');
  for (const [index, source] of sources.entries()) {
    const track = midi.addTrack();
    track.name = source.getAttribute('name');
    track.channel = index < 9 ? index : index + 1;
    for (const clip of children(source, 'pattern')) {
      if (clip.getAttribute('muted') === '1') continue;
      const offset = Number(clip.getAttribute('pos'));
      for (const note of children(clip, 'note')) {
        const duration = Number(note.getAttribute('len'));
        const pitch = Number(note.getAttribute('key')) + 12;
        const position = offset + Number(note.getAttribute('pos'));
        if (!Number.isSafeInteger(duration) || duration <= 0 || !Number.isSafeInteger(position) ||
            position < 0 || !Number.isInteger(pitch) || pitch < 0 || pitch > 127) continue;
        const velocity = Number(note.getAttribute('vol') || 100);
        if (!Number.isFinite(velocity) || velocity <= 0) continue;
        track.addNote({ midi: pitch, ticks: position * ratio, durationTicks: duration * ratio, velocity: Math.min(1, velocity / 100) });
      }
    }
  }
  if (!midi.tracks.some(track => track.notes.length)) throw new Error('No exportable instrument notes');
  await writeFile(path.join(root, output), midi.toArray(), { flag: 'wx' });
  return { file: output, tracks: midi.tracks.map(track => ({ name: track.name, notes: track.notes.length })) };
});
const livePipe = process.env.LMMS_LIVE_PIPE;
if (process.platform === 'win32' && livePipe && /^[a-zA-Z0-9_-]+$/.test(livePipe)) {
  tool('live_transport', 'Control playback in the open LMMS session using a separately installed LMMS Agent Bridge.', {
    action: z.enum(['play', 'pause', 'stop', 'seek']), position: z.number().int().nonnegative().optional(),
  }, async args => {
    if ((args.action === 'seek') !== (args.position !== undefined)) throw new Error('Provide position only for seek');
    return new Promise((resolve, reject) => {
      const socket = createConnection('\\\\.\\pipe\\' + livePipe);
      let response = '';
      socket.setEncoding('utf8');
      socket.setTimeout(5000, () => socket.destroy(new Error('LMMS live bridge timed out')));
      socket.on('error', reject);
      socket.on('end', () => reject(new Error('LMMS live bridge disconnected before it replied')));
      socket.on('connect', () => socket.write(JSON.stringify({ cmd: 'transport', args }) + '\n'));
      socket.on('data', chunk => {
        response += chunk;
        if (response.length > 65536) return socket.destroy(new Error('LMMS live response is too large'));
        const end = response.indexOf('\n');
        if (end < 0) return;
        socket.destroy();
        try {
          const result = JSON.parse(response.slice(0, end));
          if (result.ok !== true) throw new Error(result.error ?? result.message ?? 'LMMS rejected transport');
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
    });
  });
}
tool('render_mix', 'Render a 48 kHz loop WAV and report its duration, peak, full-scale samples and loop boundary jump.', {
  project: projectName, output: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.wav$/i),
}, async ({ project, output }) => {
  if (existsSync(path.join(root, output))) throw new Error('Output already exists');
  const temp = await mkdtemp(path.join(root, '.render-'));
  try {
    const rendered = path.join(temp, 'mix.wav');
    await load(project);
    await run(lmms, ['render', path.join(root, project), '-s', '48000', '-f', 'wav', '-l', '-o', rendered],
      { cwd: root, timeout: 180000, windowsHide: true });
    const data = await readFile(rendered);
    const audioStats = measureWav(data);
    await writeFile(path.join(root, output), data, { flag: 'wx' });
    return { audio: output, bytes: data.length, ...audioStats };
  } finally {
    await rm(temp, { recursive: true });
  }
});
await server.connect(new StdioServerTransport());
