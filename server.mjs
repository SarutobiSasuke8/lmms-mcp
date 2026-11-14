#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(process.env.LMMS_WORKSPACE ?? process.cwd());
const lmms = process.env.LMMS_EXECUTABLE ??
  (process.platform === 'win32' ? 'C:/Program Files/LMMS/lmms.exe' : 'lmms');
const server = new McpServer({ name: 'lmms-project-tools', version: '0.1.0' });
const projectName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.mmp$/i);
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
const children = (node, tag) => Array.from(node.childNodes).filter(child => child.nodeName === tag);
const xml = new XMLSerializer();
function parse(source) {
  const doc = new DOMParser().parseFromString(source, 'application/xml');
  if (doc.documentElement.tagName !== 'lmms-project') throw new Error('Expected an LMMS project');
  return doc;
}
async function load(project) {
  return parse(await readFile(path.join(root, project), 'utf8'));
}
async function save(doc, output) {
  await writeFile(path.join(root, output), xml.serializeToString(doc), { flag: 'wx' });
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
function measureWav(wav) {
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
  let peak = 0;
  let fullScaleSamples = 0;
  for (let offset = 0; offset < samples.length; offset += 2) {
    const value = samples.readInt16LE(offset);
    peak = Math.max(peak, Math.abs(value));
    if (value === 32767 || value === -32768) fullScaleSamples++;
  }
  let boundaryJump = 0;
  for (let ch = 0; ch < frameBytes; ch += 2) {
    const last = samples.length - frameBytes + ch;
    boundaryJump = Math.max(boundaryJump, Math.abs(samples.readInt16LE(ch) - samples.readInt16LE(last)));
  }
  const db = value => value === 0 ? null : Number((20 * Math.log10(value / 32768)).toFixed(2));
  return { channels, sampleRate, durationSeconds: samples.length / frameBytes / sampleRate,
    peakDbfs: db(peak), fullScaleSamples, boundaryJumpDbfs: db(boundaryJump) };
}
tool('render_mix', 'Render a 48 kHz loop WAV and report its duration, peak, full-scale samples and loop boundary jump.', {
  project: projectName, output: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.wav$/i),
}, async ({ project, output }) => {
  if (existsSync(path.join(root, output))) throw new Error('Output already exists');
  const temp = await mkdtemp(path.join(root, '.render-'));
  try {
    const rendered = path.join(temp, 'mix.wav');
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
