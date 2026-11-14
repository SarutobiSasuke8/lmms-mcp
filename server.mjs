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
import { renderFathom } from './fathom.mjs';
import { fathomPatches, searchSounds } from './catalogue.mjs';

const run = promisify(execFile);
const root = path.resolve(process.env.LMMS_WORKSPACE ?? process.cwd());
const lmms = process.env.LMMS_EXECUTABLE ??
  (process.platform === 'win32' ? 'C:/Program Files/LMMS/lmms.exe' : 'lmms');
const presets = path.resolve(process.env.LMMS_PRESETS ?? path.join(path.dirname(lmms), 'data', 'presets'));
const pluginDirectory = path.resolve(process.env.LMMS_PLUGINS ?? path.join(path.dirname(lmms), 'plugins'));
const server = new McpServer({ name: 'lmms-project-tools', version: '0.5.0' });
const projectName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.mmpz?$/i);
const compressed = name => name.toLowerCase().endsWith('.mmpz');
const maxProjectBytes = 32 * 1024 * 1024;
const wavName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.wav$/i);
const patchId = z.enum(Object.keys(fathomPatches));
const note = z.object({
  tick: z.number().int().min(0), length: z.number().int().min(1),
  midi: z.number().int().min(12).max(119), velocity: z.number().int().min(1).max(100),
});
const pattern = z.object({
  name: z.string().min(1).max(100), bar: z.number().int().min(0).max(255),
  bars: z.number().int().min(1).max(64), notes: z.array(note).min(1).max(4096),
});
const track = z.object({
  name: z.string().min(1).max(100), voice: z.enum(['pluck', 'bass', 'pad', 'kick', 'clap', 'hat', 'sample']),
  sample: z.string().regex(/^[a-z0-9][a-z0-9 _-]{0,99}\.wav$/i).optional(),
  rootMidi: z.number().int().min(12).max(119).default(69),
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
  if (item.voice === 'sample') {
    instrumentTrack.setAttribute('basenote', String(item.rootMidi - 12));
    add(add(instrumentTrack, 'instrument', { name: 'audiofileprocessor' }), 'audiofileprocessor',
      { src: path.join(root, item.sample).replaceAll('\\', '/'), amp: 100, sframe: 0, eframe: 1, interp: 1 });
  } else if (item.voice in kit) {
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
function createSong(bpm, items, mastervol = 86) {
  const doc = parse('<?xml version="1.0"?><!DOCTYPE lmms-project><lmms-project version="1.0" creator="LMMS" creatorversion="1.2.2" type="song"/>');
  add(doc.documentElement, 'head', { bpm, mastervol, timesig_numerator: 4, timesig_denominator: 4 });
  const container = add(add(doc.documentElement, 'song'), 'trackcontainer', { type: 'song' });
  for (const item of items) addTrack(container, item);
  return doc;
}
tool('create_project', 'Create an editable 4/4 LMMS project. One bar is 192 ticks, one beat is 48. Drum notes use MIDI 69 at original pitch.', {
  output: projectName, bpm: z.number().int().min(45).max(240), tracks: z.array(track).min(1).max(24),
}, async ({ output, bpm, tracks: items }) => {
  if (new Set(items.map(t => t.name)).size !== items.length) throw new Error('Track names must be unique');
  for (const item of items) {
    if (item.voice === 'sample' && (!item.sample || !(await lstat(path.join(root, item.sample))).isFile())) {
      throw new Error('Sample tracks require a regular workspace WAV');
    }
  }
  return save(createSong(bpm, items), output);
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

tool('render_fathom_track', 'Render LMMS piano-roll notes through Fathom Atelier’s synth worklet with cutoff automation. Save a WAV and an LMMS copy with the rendered audio and editable source notes.', {
  project: projectName, output: projectName, audio: wavName, trackName: z.string().min(1).max(100),
  patchFile: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.json$/i).optional(),
  patchId: patchId.optional(),
  bars: z.number().int().min(1).max(64),
  cutoff: z.array(z.object({ tick: z.number().int().min(0), hz: z.number().min(28).max(20000) })).min(1).max(256),
}, async ({ project, output, audio, trackName, patchFile, patchId: id, bars, cutoff }) => {
  const worklet = process.env.LMMS_FATHOM_WORKLET;
  if (!worklet) throw new Error('Set LMMS_FATHOM_WORKLET to a trusted local Fathom Atelier synth-processor.js');
  if (Boolean(id) === Boolean(patchFile)) throw new Error('Supply exactly one of patchId or patchFile');
  if (existsSync(path.join(root, output)) || existsSync(path.join(root, audio))) throw new Error('Output already exists');
  const doc = await load(project);
  const [head] = children(doc.documentElement, 'head');
  const bpm = Number(head?.getAttribute('bpm') || 140);
  if (children(head, 'bpm').length || !Number.isFinite(bpm) || bpm < 45 || bpm > 240 ||
      Number(head?.getAttribute('timesig_numerator') || 4) !== 4 || Number(head?.getAttribute('timesig_denominator') || 4) !== 4) {
    throw new Error('Fathom rendering requires static tempo (45–240 BPM) and 4/4 metre');
  }
  const durationTicks = bars * 192;
  if (cutoff[0].tick !== 0 || cutoff.some(({ tick }, index) =>
    tick > durationTicks || (index > 0 && tick <= cutoff[index - 1].tick))) {
    throw new Error('Cutoff must start at tick 0 and increase in tick order within the render length');
  }
  const secondsPerTick = 60 / bpm / 48;
  if (durationTicks * secondsPerTick > 120) throw new Error('Fathom rendering supports at most 120 seconds');
  const songTracks = tracks(doc);
  const sources = songTracks.filter(t => t.getAttribute('type') === '0' && t.getAttribute('name') === trackName);
  if (sources.length !== 1) throw new Error('Expected one matching piano-roll track');
  const [source] = sources;
  const notes = [];
  for (const clip of children(source, 'pattern')) {
    if (clip.getAttribute('muted') === '1') continue;
    const position = Number(clip.getAttribute('pos'));
    for (const event of children(clip, 'note')) {
      const length = Number(event.getAttribute('len'));
      const velocity = Number(event.getAttribute('vol') || 100);
      if (length <= 0 || velocity === 0) continue;
      const data = note.parse({ tick: position + Number(event.getAttribute('pos')), length,
        midi: Number(event.getAttribute('key')) + 12, velocity });
      if (data.tick >= durationTicks) continue;
      notes.push({ ...data, length: Math.min(data.length, durationTicks - data.tick), velocity: data.velocity / 100 });
    }
  }
  if (!notes.length || notes.length > 8192) throw new Error('Expected 1 to 8192 active notes in the render range');
  let patch;
  if (id) {
    patch = structuredClone(fathomPatches[id].patch);
  } else {
    const patchPath = path.join(root, patchFile);
    const info = await lstat(patchPath);
    if (!info.isFile() || info.size > 65536) throw new Error('Expected a regular Fathom patch JSON file up to 64 KiB');
    patch = JSON.parse(await readFile(patchPath, 'utf8'));
  }
  if (!patch?.filter || typeof patch.filter !== 'object' || !Number.isFinite(patch.volume) ||
      patch.volume <= 0 || patch.volume > 1 || !['fathom', 'vesper', 'halo'].includes(patch.model)) {
    throw new Error('Expected a complete Fathom Atelier patch with a nonzero volume up to 1');
  }

  const name = trackName + ' [Fathom audio]';
  const previous = songTracks.filter(t => t.getAttribute('name') === name);
  if (previous.length && (previous.length !== 1 || previous[0].getAttribute('type') !== '2')) {
    throw new Error('An unrelated track already uses the Fathom audio track name');
  }
  const wav = await renderFathom({ worklet, patch, notes, cutoff, secondsPerTick, durationTicks });
  source.setAttribute('muted', '1');
  source.setAttribute('solo', '0');
  previous[0]?.parentNode.removeChild(previous[0]);
  const target = add(source.parentNode, 'track', { type: 2, name, muted: 0, solo: 0 });
  add(target, 'sampletco', { pos: 0, len: durationTicks, muted: 0,
    src: path.join(root, audio).replaceAll('\\', '/') });
  const filename = path.join(root, audio);
  await writeFile(filename, wav, { flag: 'wx' });
  try {
    await save(doc, output);
  } catch (error) {
    await rm(filename);
    throw error;
  }
  return { project: output, audio, track: name, notes: notes.length, cutoff, ...measureWav(wav) };
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
async function listPresets() {
  const groups = await readdir(presets, { withFileTypes: true });
  const files = await Promise.all(groups.filter(group => group.isDirectory()).map(async group => {
    const entries = await readdir(path.join(presets, group.name), { withFileTypes: true });
    return entries.filter(entry => entry.isFile()).map(entry => group.name + '/' + entry.name);
  }));
  return files.flat().filter(name => presetFile.safeParse(name).success).sort();
}
tool('list_presets', 'List installed XML factory preset paths.', {}, listPresets);

tool('search_sounds', 'Find Fathom patches and installed LMMS factory presets by name, engine and sound tags.', {
  query: z.string().max(120).default(''), engine: z.enum(['fathom', 'lmms']).optional(),
  limit: z.number().int().min(1).max(100).default(20),
}, async args => {
  let native = [];
  let nativePresetError;
  if (args.engine !== 'fathom') {
    try { native = await listPresets(); } catch (error) { nativePresetError = error.code ?? error.message; }
  }
  const worklet = process.env.LMMS_FATHOM_WORKLET;
  return { ...searchSounds(args, native), fathomAvailable: Boolean(worklet && existsSync(worklet)), nativePresetError };
});

tool('preview_sound', 'Render a short audition of a Fathom patch or stock LMMS preset to a workspace WAV.', {
  patchId: patchId.optional(), preset: presetFile.optional(), output: wavName,
  midi: z.number().int().min(24).max(84).optional(),
}, async ({ patchId: id, preset, output, midi }) => {
  if (Boolean(id) === Boolean(preset)) throw new Error('Supply exactly one of patchId or preset');
  if (existsSync(path.join(root, output))) throw new Error('Output already exists');
  if (preset) {
    const temp = await mkdtemp(path.join(root, '.preview-'));
    try {
      const doc = createSong(120, [{ name: 'Preview', voice: 'pluck', volume: 45, pan: 0,
        patterns: [{ name: 'Preview', bar: 0, bars: 1,
          notes: [0, 7, 12, 3].map((offset, i) => ({ tick: i * 36, midi: (midi ?? 57) + offset, length: 29, velocity: 76 })) }] }], 65);
      await loadPreset(doc, instrumentOf(doc, 'Preview'), preset);
      const project = path.join(temp, 'preview.mmp');
      const rendered = path.join(temp, 'preview.wav');
      await writeFile(project, xml.serializeToString(doc));
      await run(lmms, ['render', project, '-s', '48000', '-f', 'wav', '-l', '-o', rendered],
        { cwd: root, timeout: 30000, windowsHide: true });
      const wav = await readFile(rendered);
      const stats = measureWav(wav);
      if (stats.peakDbfs === null) throw new Error('Native preset preview is silent. Try a different MIDI root or preset.');
      await writeFile(path.join(root, output), wav, { flag: 'wx' });
      return { preset, audio: output, ...stats };
    } finally {
      await rm(temp, { recursive: true });
    }
  }
  const worklet = process.env.LMMS_FATHOM_WORKLET;
  if (!worklet) throw new Error('Set LMMS_FATHOM_WORKLET to preview Fathom patches');
  const sound = fathomPatches[id];
  const patch = structuredClone(sound.patch);
  const notes = sound.phrase.map(([tick, interval, length, velocity]) => ({
    tick, midi: (midi ?? sound.root) + interval, length, velocity,
  }));
  const wav = await renderFathom({ worklet, patch, notes, cutoff: [{ tick: 0, hz: patch.filter.cutoff }],
    secondsPerTick: 1 / 96, durationTicks: 192 });
  await writeFile(path.join(root, output), wav, { flag: 'wx' });
  return { patchId: id, audio: output, ...measureWav(wav) };
});

// Instrument plugin IDs used by the stock LMMS 1.2 series.
const instruments = {
  audiofileprocessor: 'Sample playback', bitinvader: 'Wavetable synthesis', carlarack: 'External plugin host',
  carlapatchbay: 'External plugin host', gigplayer: 'GIG sampler', kicker: 'Kick drum synthesis',
  lb302: 'Acid bass synthesis', malletsstk: 'Physical modelling', monstro: 'Subtractive and modulation synthesis',
  nes: 'NES-style synthesis', opl2: 'FM synthesis', organic: 'Additive synthesis', papu: 'Game Boy-style synthesis',
  patman: 'GUS patch sampler', sf2player: 'SoundFont player', sfxr: 'Retro game sound effects',
  sid: 'SID-style synthesis', tripleoscillator: 'Three-oscillator subtractive synthesis', vestige: 'VST instrument host',
  vibedstrings: 'Plucked string modelling', watsyn: 'Wavetable synthesis', zynaddsubfx: 'Additive and subtractive synthesis',
};
async function installedInstrumentIds() {
  const entries = await readdir(pluginDirectory, { withFileTypes: true });
  const modules = new Set(entries.filter(entry => /\.(dll|so|dylib)$/i.test(entry.name))
    .map(entry => entry.name.toLowerCase().replace(/\.(dll|so|dylib)$/, '')));
  return Object.keys(instruments).filter(id => modules.has(id) || modules.has('lib' + id));
}
tool('list_instruments', 'Discover known stock instrument plugins found on disk, factory presets and Fathom bridge configuration.', {}, async () => {
  const [plugins, factoryPresets] = await Promise.allSettled([installedInstrumentIds(), listPresets()]);
  const worklet = process.env.LMMS_FATHOM_WORKLET;
  return {
    builtInVoices: [...Object.keys(tones), ...Object.keys(kit), 'sample'],
    nativePlugins: (plugins.value ?? []).map(id => ({ id, family: instruments[id] })),
    pluginScan: plugins.status === 'fulfilled' ? pluginDirectory : { directory: pluginDirectory, error: plugins.reason.code },
    factoryPresets: factoryPresets.value ?? [],
    presetScan: factoryPresets.status === 'fulfilled' ? presets : { directory: presets, error: factoryPresets.reason.code },
    fathom: { configured: Boolean(worklet), workletFound: Boolean(worklet && existsSync(worklet)),
      models: ['fathom', 'vesper', 'halo'], tool: 'render_fathom_track' },
  };
});
function instrumentOf(doc, name) {
  const matching = tracks(doc).filter(track => track.getAttribute('name') === name && track.getAttribute('type') === '0');
  const instrument = matching.length === 1 && children(matching[0], 'instrumenttrack')[0];
  if (!instrument) throw new Error('Expected one instrument track named ' + name);
  return instrument;
}
tool('set_native_instrument', 'Load an installed stock LMMS instrument at its default settings. Keep existing notes, mixer routing and track controls.', {
  project: projectName, output: projectName, trackName: z.string(), instrument: z.enum(Object.keys(instruments)),
}, async ({ project, output, trackName, instrument }) => {
  if (!(await installedInstrumentIds()).includes(instrument)) throw new Error('Instrument plugin was not found in LMMS_PLUGINS');
  const doc = await load(project);
  const target = instrumentOf(doc, trackName);
  const [previous] = children(target, 'instrument');
  if (previous && Array.from(previous.getElementsByTagName('*')).some(node => node.hasAttribute('id'))) {
    throw new Error('Existing instrument has linked controls');
  }
  if (previous) target.removeChild(previous);
  add(add(target, 'instrument', { name: instrument }), instrument);
  return save(doc, output);
});
async function loadPreset(doc, target, preset) {
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
}
tool('apply_preset', 'Load an installed XML preset sound into a track in a new project copy.', {
  project: projectName, output: projectName, trackName: z.string(), preset: presetFile,
}, async ({ project, output, trackName, preset }) => {
  const doc = await load(project);
  await loadPreset(doc, instrumentOf(doc, trackName), preset);
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
const soundName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/i);
tool('export_one_shots', 'Trim edge silence, fade and peak-match source WAVs as mono 48 kHz game sound effects.', {
  outputDirectory: soundName,
  sounds: z.array(z.object({
    input: z.string().regex(/^[a-z0-9][a-z0-9 _-]{0,99}\.wav$/i), name: soundName,
  })).min(1).max(32),
  thresholdDb: z.number().min(-75).max(-20).default(-48),
  peakDb: z.number().min(-18).max(-1).default(-3),
}, async ({ outputDirectory, sounds, thresholdDb, peakDb }) => {
  if (new Set(sounds.map(s => s.name.toLowerCase())).size !== sounds.length) throw new Error('Sound names must be unique');
  const destination = path.join(root, outputDirectory);
  await mkdir(destination);
  try {
    const files = [];
    for (const { input, name } of sounds) {
      const source = path.join(root, input);
      const info = await lstat(source);
      if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('Expected a regular workspace WAV up to 32 MiB');
      const { samples, channels, sampleRate, frameBytes } = readPcm(await readFile(source));
      if (sampleRate !== 48000 || channels > 2) throw new Error('Source WAVs must be 48 kHz mono or stereo 16-bit PCM');
      const frames = samples.length / frameBytes;
      if (frames > sampleRate * 30) throw new Error('Source one-shots must be 30 seconds or shorter');
      const mono = new Float64Array(frames);
      const cutoff = 32768 * 10 ** (thresholdDb / 20);
      let start = frames;
      let end = 0;
      for (let i = 0; i < frames; i++) {
        mono[i] = samples.readInt16LE(i * frameBytes);
        if (channels === 2) mono[i] = (mono[i] + samples.readInt16LE(i * frameBytes + 2)) / 2;
        if (Math.abs(mono[i]) >= cutoff) {
          start = Math.min(start, i);
          end = i + 1;
        }
      }
      if (!end) throw new Error(input + ' is silent at the trim threshold');
      start = Math.max(0, start - 240);
      end = Math.min(frames, end + 480);
      const take = mono.subarray(start, end);
      const fade = Math.max(1, Math.min(240, Math.floor(take.length / 4)));
      let peak = 0;
      for (let i = 0; i < take.length; i++) {
        take[i] *= Math.min(1, i / fade, (take.length - 1 - i) / fade);
        peak = Math.max(peak, Math.abs(take[i]));
      }
      if (!peak) throw new Error(input + ' has no signal after fades');
      const gain = 32767 * 10 ** (peakDb / 20) / peak;
      const wav = Buffer.alloc(44 + take.length * 2);
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
      wav.writeUInt32LE(take.length * 2, 40);
      for (let i = 0; i < take.length; i++) wav.writeInt16LE(Math.round(take[i] * gain), 44 + i * 2);
      const file = name + '.wav';
      await writeFile(path.join(destination, file), wav, { flag: 'wx' });
      files.push({ file, source: input, trimStartSeconds: start / sampleRate, ...measureWav(wav) });
    }
    const manifest = { sampleRate: 48000, channels: 1, peakTargetDbfs: peakDb, files };
    await writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    return manifest;
  } catch (error) {
    // The directory was created exclusively by this call.
    await rm(destination, { recursive: true });
    throw error;
  }
});
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
tool('export_midi', 'Export instrument patterns and arranged Beat/Bassline clips as multitrack MIDI at a static tempo.', {
  project: projectName, output: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.mid$/i),
  pitchMode: z.enum(['written', 'playback']).default('written'),
}, async ({ project, output, pitchMode }) => {
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
  const songTracks = tracks(doc);
  const sources = songTracks.filter(track => track.getAttribute('type') === '0' && children(track, 'pattern').length);
  const beatTracks = songTracks.filter(track => track.getAttribute('type') === '1');
  const beat = beatTracks.flatMap(track => children(track, 'bbtrack'))[0];
  const beatLanes = children(children(beat, 'trackcontainer')[0], 'track');
  const playingBeatLanes = beatLanes.filter(track => track.getAttribute('type') === '0' && track.getAttribute('muted') !== '1');
  const ticksPerBar = 192 * meter[0] / meter[1];
  const beatPlacements = beatTracks.map((track, slot) => {
    const cycle = Math.max(ticksPerBar, ...beatLanes.map(lane =>
      Number(children(lane, 'pattern')[slot]?.getAttribute('len') || 0)));
    const clips = track.getAttribute('muted') === '1' ? [] : children(track, 'bbtco')
      .filter(clip => clip.getAttribute('muted') !== '1')
      .map(clip => ({ start: Number(clip.getAttribute('pos')), length: Number(clip.getAttribute('len')) }))
      .filter(({ start, length }) => Number.isSafeInteger(start) && start >= 0 && Number.isSafeInteger(length) && length > 0)
      .sort((a, b) => a.start - b.start);
    if (clips.some((clip, i) => i > 0 && clip.start < clips[i - 1].start + clips[i - 1].length)) {
      throw new Error('MIDI export requires non-overlapping clips within each Beat/Bassline arrangement track');
    }
    return { cycle, clips };
  });
  if (beatPlacements.some(({ clips }) => clips.length)) sources.push(...playingBeatLanes);
  if (!sources.length || sources.length > 15) throw new Error('MIDI export supports 1 to 15 instrument tracks');
  for (const [index, source] of sources.entries()) {
    const track = midi.addTrack();
    track.name = source.getAttribute('name');
    track.channel = index < 9 ? index : index + 1;
    const [instrument] = children(source, 'instrumenttrack');
    const baseNote = Number(instrument?.getAttribute('basenote') || 57);
    const masterPitch = instrument?.getAttribute('usemasterpitch') === '0' ? 0 : Number(head?.getAttribute('masterpitch') || 0);
    const transpose = pitchMode === 'playback' ? 57 - baseNote + masterPitch : 0;
    const isBeat = playingBeatLanes.includes(source);
    for (const [slot, pattern] of children(source, 'pattern').entries()) {
      if (pattern.getAttribute('muted') === '1') continue;
      const placement = isBeat ? beatPlacements[slot] :
        { cycle: null, clips: [{ start: Number(pattern.getAttribute('pos')), length: Infinity }] };
      if (!placement) continue;
      const { cycle, clips } = placement;
      if (cycle !== null && (!Number.isSafeInteger(cycle) || cycle <= 0)) throw new Error('Invalid Beat/Bassline cycle');
      for (const note of children(pattern, 'note')) {
        const rawLength = Number(note.getAttribute('len'));
        // LMMS stores enabled step triggers with negative length. Give them one step in MIDI.
        const duration = isBeat && rawLength < 0 ? 12 : rawLength;
        const pitch = Number(note.getAttribute('key')) + 12 + transpose;
        const position = Number(note.getAttribute('pos'));
        if (!Number.isSafeInteger(duration) || duration <= 0 || !Number.isSafeInteger(position) || position < 0 ||
            !Number.isInteger(pitch) || pitch < 0 || pitch > 127) continue;
        const velocity = Number(note.getAttribute('vol') || 100);
        if (!Number.isFinite(velocity) || velocity <= 0) continue;
        for (const { start, length } of clips) {
          const repeats = cycle === null ? 1 : Math.max(0, Math.ceil((length - position) / cycle));
          if (track.notes.length + repeats > 100000) throw new Error('MIDI track exceeds 100,000 notes');
          for (let repeat = 0; repeat < repeats; repeat++) {
            const relative = position + repeat * (cycle ?? 0);
            track.addNote({ midi: pitch, ticks: (start + relative) * ratio,
              durationTicks: Math.min(duration, length - relative) * ratio, velocity: Math.min(1, velocity / 100) });
          }
        }
      }
    }
  }
  if (!midi.tracks.some(track => track.notes.length)) throw new Error('No exportable instrument notes');
  await writeFile(path.join(root, output), midi.toArray(), { flag: 'wx' });
  return { file: output, pitchMode, tracks: midi.tracks.map(track => ({ name: track.name, notes: track.notes.length })) };
});
const livePipe = process.env.LMMS_LIVE_PIPE;
if (process.platform === 'win32' && livePipe && /^[a-zA-Z0-9_-]+$/.test(livePipe)) {
  function bridgeCall(command, args = {}) {
    const request = JSON.stringify({ cmd: command, args }) + '\n';
    if (Buffer.byteLength(request) > 65536) throw new Error('Live command exceeds the bridge request limit');
    return new Promise((resolve, reject) => {
      const socket = createConnection('\\\\.\\pipe\\' + livePipe);
      let response = '';
      socket.setEncoding('utf8');
      socket.setTimeout(5000, () => socket.destroy(new Error('LMMS live bridge timed out')));
      socket.on('error', reject);
      socket.on('end', () => reject(new Error('LMMS live bridge disconnected before it replied')));
      socket.on('connect', () => socket.write(request));
      socket.on('data', chunk => {
        response += chunk;
        if (response.length > 16 * 1024 * 1024) return socket.destroy(new Error('LMMS live response is too large'));
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
  }
  tool('live_transport', 'Control playback in the open LMMS session using a separately installed LMMS Agent Bridge.', {
    action: z.enum(['play', 'pause', 'stop', 'seek']), position: z.number().int().nonnegative().optional(),
  }, async args => {
    if ((args.action === 'seek') !== (args.position !== undefined)) throw new Error('Provide position only for seek');
    return bridgeCall('transport', args);
  });
  const index = z.number().int().min(0).max(2147483647);
  const token = { project_token: z.string().min(1).max(64) };
  const track = { ...token, track_index: index };
  const clip = { ...track, clip_index: index };
  const patternSelector = { ...track, pattern_index: index };
  tool('live_inspect', 'Inspect the open song, arrangement, or notes. Read the project token and current indices before editing.', {
    view: z.enum(['project', 'arrangement', 'notes']), track_index: index.optional(), pattern_index: index.optional(),
  }, async ({ view, ...args }) => {
    if (view === 'notes' && (args.track_index === undefined || args.pattern_index === undefined)) {
      throw new Error('Provide track_index and pattern_index to read notes');
    }
    if (view !== 'notes' && Object.keys(args).length) throw new Error('Indices only apply to the notes view');
    return bridgeCall({ project: 'get_project_info', arrangement: 'get_arrangement', notes: 'get_notes' }[view], args);
  });
  tool('live_update_track', 'Edit a track in the open song. Changes are unsaved; use the current project token.', {
    ...track, name: z.string().min(1).max(256).optional(), volume: z.number().min(0).max(200).optional(),
    panning: z.number().min(-100).max(100).optional(), muted: z.boolean().optional(),
    solo: z.boolean().optional(), fx_channel: index.optional(),
  }, async args => bridgeCall('update_track', args));
  tool('live_update_clip', 'Rename, move or resize a clip in the open song. Changes are unsaved.', {
    ...clip, name: z.string().min(1).max(256).optional(), new_pos_ticks: index.optional(), length_ticks: index.optional(),
  }, async args => bridgeCall('update_clip', args));
  tool('live_replace_notes', 'Replace the notes in an open clip. An empty list clears the clip. Changes are unsaved.', {
    ...patternSelector, notes: z.array(z.object({
      key: z.number().int().min(12).max(119), pos: index,
      length: index.min(1), volume: z.number().int().min(0).max(200).optional(),
    })).max(512),
  }, async args => bridgeCall('replace_notes', args));
  tool('live_update_effect', 'Set the wet mix or bypass state of an existing track or mixer effect in the open song.', {
    ...token, target_type: z.enum(['track', 'mixer']), target_index: index, effect_index: index,
    enabled: z.boolean().optional(), wet: z.number().min(-1).max(1).optional(),
  }, async args => bridgeCall('update_effect', args));
  tool('live_create_track', 'Create a native song track or an instrument lane in the Beat/Bassline editor.', {
    ...token, type: z.enum(['instrument', 'sample', 'automation', 'bb']), container: z.enum(['song', 'bb']).optional(),
    name: z.string().min(1).max(256).optional(), instrument: z.string().min(1).max(120).optional(),
    volume: z.number().min(0).max(200).optional(),
  }, async args => bridgeCall('create_track', args));
  tool('live_load_instrument_file', 'Load a workspace preset or sample into an existing live instrument track.', {
    ...track, file: z.string().regex(/^[a-z0-9][a-z0-9 _-]{0,99}\.(xpf|wav|ogg|flac|sf2|gig|xiz)$/i),
    container: z.enum(['song', 'bb']).optional(),
  }, async ({ file, ...args }) => {
    const filename = path.join(root, file);
    if (!(await lstat(filename)).isFile()) throw new Error('Expected a regular workspace instrument file');
    return bridgeCall('load_instrument_file', { ...args, path: filename, preserve_name: true });
  });
  const points = z.array(z.object({ pos: index, value: z.number().min(-1e9).max(1e9) })).min(1).max(512);
  const progression = z.enum(['discrete', 'linear', 'cubic']).optional();
  tool('live_add_automation', 'Create a linked automation clip on an existing automation track.', {
    ...track, name: z.string().max(256).optional(), pos_ticks: index, length_ticks: index.min(1), points, progression,
    target_track_index: index, target_parameter: z.enum(['volume', 'panning', 'pitch']),
  }, async args => bridgeCall('add_automation', args));
  tool('live_read_automation', 'Read native automation points and linked controls.', clip,
    async args => bridgeCall('get_automation', args));
  tool('live_edit_automation', 'Replace or upsert points in an existing native automation clip.', {
    ...clip, points, mode: z.enum(['replace', 'upsert']).optional(), progression,
  }, async args => bridgeCall('set_automation_points', args));
}
tool('render_mix', 'Render a 48 kHz loop WAV and report its duration, peak, full-scale samples and loop boundary jump.', {
  project: projectName, output: wavName,
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
