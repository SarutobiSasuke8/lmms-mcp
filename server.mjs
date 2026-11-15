#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deflateSync, gunzipSync, inflateSync } from 'node:zlib';
import midiPackage from '@tonejs/midi';
import { createConnection } from 'node:net';
import { renderFathom } from './fathom.mjs';
import { composerProfiles, composeProfile, describeProfile } from './composers.mjs';
import { fathomPatches, searchSounds, measureInstrument } from './catalogue.mjs';
import * as dsp from './audio.mjs';
import { expandPattern, parseChord, voiceChord, bassNote, chordQualities } from './music.mjs';
import { effectTypes, resolveParams, describeEffects } from './effects.mjs';

const run = promisify(execFile);
const root = path.resolve(process.env.LMMS_WORKSPACE ?? process.cwd());
const lmms = process.env.LMMS_EXECUTABLE ??
  (process.platform === 'win32' ? 'C:/Program Files/LMMS/lmms.exe' : 'lmms');
const dataDirectory = path.join(path.dirname(lmms), 'data');
const presets = path.resolve(process.env.LMMS_PRESETS ?? path.join(dataDirectory, 'presets'));
const samplesDirectory = path.resolve(process.env.LMMS_SAMPLES ?? path.join(dataDirectory, 'samples'));
const pluginDirectory = path.resolve(process.env.LMMS_PLUGINS ?? path.join(path.dirname(lmms), 'plugins'));
const ffmpeg = process.env.LMMS_FFMPEG ?? 'ffmpeg';
const instructions = [
  'LMMS MCP composes, edits, analyses and exports editable game audio using saved LMMS projects.',
  'Start with get_started for workflow and local capabilities, then use tools/list for exact schemas.',
  'For a musical brief, list_composer_profiles and create_composer_sketch or create_project. Search and audition sounds with search_sounds and preview_sound.',
  'Edit and mix with apply_edits. Render before delivery, inspect levels and the loop seam with analyze_audio, then use export_game_audio for loops, layers and stingers.',
  'Preserve the editable MMP or MMPZ and its referenced samples. A beat is 48 ticks and a 4/4 bar is 192 ticks. Project bars start at zero.',
  'Stock LMMS handles saved projects. Fathom rendering and Windows live control require optional local components.',
  'Use list_external_tools to discover optional VST3 instruments and related setup instructions.',
  'Arrangement rules: give every track a role (drums, bass, harmony, lead, counter, texture or fx). One lead melody at a time, with at most one counter-melody under it. Bass and harmony support the lead and stay out of its register. Build sections by repeating and varying one motif, and leave space.',
].join(' ');
// Feature modules in tools/ add their own guidance here; get_started returns it.
const moduleGuidance = [];
// Arrangement checks that modules register: async (doc, { project }) => null or { summary, blocking, warnings }.
// Their output is attached as an `arrangement` field. With strict, a blocking result stops the call before anything is written.
const postSave = [], exportChecks = [];
async function runChecks(list, doc, project, strict) {
  const reports = [];
  for (const check of list) {
    try { const report = await check(doc, { project }); if (report) reports.push(report); }
    catch (error) { reports.push({ summary: 'An arrangement check failed: ' + error.message, blocking: false, warnings: [] }); }
  }
  if (!reports.length) return {};
  const arrangement = { summary: reports.map(r => r.summary).join(' '), blocking: reports.some(r => r.blocking), warnings: reports.flatMap(r => r.warnings ?? []) };
  if (strict && arrangement.blocking) throw new Error(`${arrangement.summary} Nothing was written (strict). ${arrangement.warnings.join(' ')}`);
  return { arrangement };
}
const strictChecks = z.boolean().default(false).describe('Stop with an error, writing nothing, when an arrangement check reports an error.');
const server = new McpServer({ name: 'lmms-project-tools', version: '0.9.1' }, { instructions });
const projectName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.mmpz?$/i);
const compressed = name => name.toLowerCase().endsWith('.mmpz');
const maxProjectBytes = 32 * 1024 * 1024;
const wavName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.wav$/i);
const timelineTick = z.number().int().min(0).max(2147483647);
const audioOut = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.(wav|ogg)$/i);
// A workspace WAV, optionally one folder down (for example a kit made by export_one_shots).
const workspaceWav = z.string().regex(/^(?:[a-z0-9][a-z0-9 _-]{0,79}\/)?[a-z0-9][a-z0-9 _-]{0,99}\.wav$/i);
const factorySample = z.string().regex(/^[a-z0-9][\w -]{0,60}(?:\/[a-z0-9!][\w .()!-]{0,80}){1,2}\.(ogg|wav|flac)$/i);
const folderName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/i);
const patchId = z.enum(Object.keys(fathomPatches));
const anchorName = 'Song length';
const note = z.object({
  tick: z.number().int().min(0), length: z.number().int().min(1),
  midi: z.number().int().min(12).max(119), velocity: z.number().int().min(1).max(200),
});
const grid = { stepsPerBar: z.number().int().min(1).max(192).optional(), swing: z.number().min(0).max(0.75).optional(),
  humanize: z.number().min(0).max(30).optional(), seed: z.number().int().optional() };
const pitchToken = z.union([z.number().int().min(12).max(119), z.string().max(6)]);
const pattern = z.object({
  name: z.string().min(1).max(100), bar: z.number().int().min(0).max(999),
  bars: z.number().int().min(1).max(64),
  notes: z.array(note).min(1).max(4096).optional()
    .describe('Raw notes. tick and length are in ticks from the pattern start (48 per beat).'),
  steps: z.object({ grid: z.string().min(1).max(1024), midi: pitchToken.optional(), length: z.number().int().min(1).max(768).optional(), ...grid }).optional()
    .describe('Drum grid, tiled to fill the pattern: X accent, x hit, o soft, g ghost, - rest. Example "x---o---x-x-o---". Default 16 steps per bar, 48-tick notes at MIDI 69.'),
  melody: z.object({ line: z.string().min(1).max(8000), velocity: z.number().int().min(1).max(200).optional(),
    gate: z.number().min(0.05).max(1).optional(), repeat: z.boolean().optional(), ...grid }).optional()
    .describe('Melody line of NOTE:steps[:velocity] tokens, r:steps for rests, [D4,F4,A4]:8 for chords, | ignored. Example "D5:3 F5:3 A5:6 G5:2 F5:2". Repeats to fill the pattern.'),
  chords: z.object({ progression: z.union([z.string().min(1).max(2000), z.array(z.string()).min(1).max(256)]),
    style: z.enum(['block', 'pulse', 'arp', 'bass']).optional(), figure: z.enum(['whole', 'eighths', 'octaves', 'syncopated']).optional(),
    order: z.enum(['up', 'down', 'updown', 'alberti', 'broken']).optional(), octave: z.number().int().min(0).max(7).optional(),
    octaves: z.union([z.literal(1), z.literal(2)]).optional(), voicing: z.enum(['close', 'open', 'spread']).optional(),
    voiceLead: z.boolean().optional(), rate: z.number().min(0.25).max(64).optional(), barsPerChord: z.number().min(0.25).max(16).optional(),
    gate: z.number().min(0.05).max(1).optional(), velocity: z.number().int().min(1).max(200).optional(), ...grid }).optional()
    .describe('Chord progression such as "Dm Bb F C" (one bar each; "Dm:2" lasts two bars), looped to fill the pattern. style: block, pulse, arp (order, rate in steps) or bass (figure).'),
  transpose: z.number().int().min(-48).max(48).optional(),
});
const presetFile = z.string().regex(/^(?:[\w -]+\/[\w .()!-]+\.xpf|ZynAddSubFX\/[\w -]+\/[\w .()!',&+-]+\.xiz)$/i);
const volume = z.number().min(0).max(200);
const track = z.object({
  name: z.string().min(1).max(100),
  voice: z.enum(['pluck', 'bass', 'pad', 'kick', 'clap', 'hat', 'sample', 'preset'])
    .describe('pluck, bass and pad are built-in synths; kick, clap and hat are stock one-shots; sample plays a workspace WAV or a stock LMMS sample; preset loads a factory preset.'),
  sample: workspaceWav.optional(), factorySample: factorySample.optional().describe('Stock LMMS sample such as "drums/snare01.ogg". See list_samples.'),
  preset: presetFile.optional(),
  rootMidi: z.number().int().min(12).max(119).default(69),
  role: z.enum(['drums', 'bass', 'harmony', 'lead', 'counter', 'texture', 'fx']).optional()
    .describe('What the track is for. Use one lead at a time and at most one counter-melody.'),
  volume, pan: z.number().int().min(-100).max(100).default(0),
  patterns: z.array(pattern).min(1).max(64),
});
// What a track is for in the arrangement. Stored on the track so lint, balance and export tools can read it.
const roleNames = ['drums', 'bass', 'harmony', 'lead', 'counter', 'texture', 'fx'];
const trackRole = t => roleNames.includes(t.getAttribute('mcp-role')) ? t.getAttribute('mcp-role') : null;
const kits = {
  soft: { kick: 'kick_soft01', snare: 'snare01', hat: 'hihat_closed01', clap: 'clap01' },
  tight: { kick: 'kick01', snare: 'snare02', hat: 'hihat_closed02', clap: 'clap02' },
  electronic: { kick: 'kick_electronic01', snare: 'snare_electronic01', hat: 'hihat_closed01', clap: 'clap01' },
  acoustic: { kick: 'kick_acoustic01', snare: 'snare_acoustic01', hat: 'hihat_open01', clap: 'clap01' },
  // Dance-oriented kits using common LMMS factory samples
  house: { kick: 'kick01', snare: 'snare01', hat: 'hihat_closed01', openhat: 'hihat_open01', clap: 'clap01' },
  techno: { kick: 'kick_hard01', snare: 'snare_harsh01', hat: 'hihat_closed03', openhat: 'hihat_open01', clap: 'clap02' },
  trance: { kick: 'kick02', snare: 'snare02', hat: 'hihat_closed02', openhat: 'hihat_open01', clap: 'clap01' },
  breaks: { kick: 'kick_soft01', snare: 'snare01', hat: 'hihat_closed01', openhat: 'hihat_open01', clap: 'clap01' },
};
const kit = kits.soft; // default for the existing kick/clap/hat voices

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
const elements = node => Array.from(node?.childNodes ?? []).filter(child => child.nodeType === 1);
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
async function save(doc, output, overwrite = false) {
  const source = Buffer.from(xml.serializeToString(doc), 'utf8');
  if (source.length > maxProjectBytes) throw new Error('Project exceeds 32 MiB');
  let file = source;
  if (compressed(output)) {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(source.length);
    file = Buffer.concat([prefix, deflateSync(source)]);
  }
  await writeFile(path.join(root, output), file, { flag: overwrite ? 'w' : 'wx' });
  return { project: output };
}
function tracks(doc) {
  const song = children(doc.documentElement, 'song')[0];
  return children(children(song, 'trackcontainer')[0], 'track');
}
const container = doc => children(children(doc.documentElement, 'song')[0], 'trackcontainer')[0];
const isAnchor = t => t.getAttribute('type') === '2' && t.getAttribute('name') === anchorName;
// Automation tracks and the length anchor carry no audio of their own; they stay active in every isolated render.
const isControl = t => t.getAttribute('type') === '5' || isAnchor(t);

function songInfo(doc) {
  const [head] = children(doc.documentElement, 'head');
  const bpm = Number(head?.getAttribute('bpm') || 140);
  const meter = [Number(head?.getAttribute('timesig_numerator') || 4), Number(head?.getAttribute('timesig_denominator') || 4)];
  const ticksPerBar = 192 * meter[0] / meter[1];
  let end = 0;
  for (const t of tracks(doc)) {
    if (t.getAttribute('muted') === '1') continue;
    for (const clip of children(t, 'pattern')) {
      let last = 0;
      for (const n of children(clip, 'note')) last = Math.max(last, Number(n.getAttribute('pos')) + Math.max(0, Number(n.getAttribute('len'))));
      end = Math.max(end, Number(clip.getAttribute('pos')) + Math.max(1, Math.ceil(last / ticksPerBar)) * ticksPerBar);
    }
    for (const tag of ['sampletco', 'bbtco']) {
      for (const clip of children(t, tag)) end = Math.max(end, Number(clip.getAttribute('pos')) + Number(clip.getAttribute('len')));
    }
    for (const clip of children(t, 'automationpattern')) {
      const last = Math.max(0, ...children(clip, 'time').map(point => Number(point.getAttribute('pos'))));
      end = Math.max(end, Number(clip.getAttribute('pos')) + (Math.floor(last / ticksPerBar) + 1) * ticksPerBar);
    }
  }
  const staticTempo = Boolean(head) && !children(head, 'bpm').length && Number.isFinite(bpm) && bpm > 0;
  return { head, bpm, meter, ticksPerBar, staticTempo, lengthTicks: end, lengthBars: end / ticksPerBar,
    lengthSeconds: end * 60 / (bpm * 48), secondsPerBar: ticksPerBar * 60 / (bpm * 48) };
}
// LMMS sizes a piano-roll clip from its last note, so empty bars at the end of a song vanish.
// An empty sample clip pins the song to the intended length.
function setAnchor(doc, bars) {
  for (const t of tracks(doc).filter(isAnchor)) t.parentNode.removeChild(t);
  if (bars === null) return;
  const { ticksPerBar } = songInfo(doc);
  const target = add(container(doc), 'track', { type: 2, name: anchorName, muted: 0, solo: 0 });
  add(target, 'sampletrack', { vol: 0, pan: 0 });
  add(target, 'sampletco', { pos: 0, len: Math.round(bars * ticksPerBar), muted: 0, src: '' });
}
function addPattern(target, part) {
  const ticks = part.bars * 192;
  const notes = expandPattern(part);
  if (notes.some(n => n.tick + n.length > ticks)) throw new Error('Note extends beyond pattern');
  const clip = add(target, 'pattern', { name: part.name, pos: part.bar * 192, len: ticks, type: 1, steps: 16, muted: 0 });
  for (const n of notes) add(clip, 'note', { key: n.midi - 12, pos: n.tick, len: n.length, vol: n.velocity, pan: 0 });
  return clip;
}
async function checkTrack(item) {
  if (item.voice === 'sample') {
    if (Boolean(item.sample) === Boolean(item.factorySample)) throw new Error(`Track "${item.name}": sample tracks need exactly one of sample or factorySample`);
    const file = item.sample ? path.join(root, item.sample) : path.join(samplesDirectory, item.factorySample);
    if (!(await lstat(file).catch(() => null))?.isFile()) {
      throw new Error(`Track "${item.name}": ${item.sample ? 'workspace WAV' : 'stock sample'} "${item.sample ?? item.factorySample}" was not found`);
    }
  } else if (item.sample || item.factorySample) throw new Error(`Track "${item.name}": sample and factorySample need voice "sample"`);
  if ((item.voice === 'preset') !== Boolean(item.preset)) throw new Error(`Track "${item.name}": voice "preset" and the preset field go together`);
}
function addTrack(parent, item) {
  const target = add(parent, 'track', { muted: 0, solo: 0, type: 0, name: item.name });
  if (item.role) target.setAttribute('mcp-role', item.role);
  const instrumentTrack = add(target, 'instrumenttrack', { vol: item.volume, pan: item.pan, basenote: 57, fxch: 0 });
  if (item.voice === 'sample') {
    instrumentTrack.setAttribute('basenote', String(item.rootMidi - 12));
    add(add(instrumentTrack, 'instrument', { name: 'audiofileprocessor' }), 'audiofileprocessor',
      { src: item.sample ? path.join(root, item.sample).replaceAll('\\', '/') : item.factorySample, amp: 100, sframe: 0, eframe: 1, interp: 1 });
  } else if (item.voice in kit) {
    add(add(instrumentTrack, 'instrument', { name: 'audiofileprocessor' }), 'audiofileprocessor',
      { src: 'drums/' + kit[item.voice] + '.ogg', amp: 100, sframe: 0, eframe: 1, interp: 1 });
  } else {
    const tone = tones[item.voice] ?? tones.pluck;
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
  return instrumentTrack;
}
const imagesKey = Symbol('images');
const explain = error => error?.issues ? error.issues.map(issue => [issue.path.join('.'), issue.message].filter(Boolean).join(': ')).join('; ') : error.message;
function tool(name, description, inputSchema, handler) {
  server.registerTool(name, { description, inputSchema }, async args => {
    try {
      const result = await handler(args);
      const content = [{ type: 'text', text: JSON.stringify(result) }];
      for (const png of result?.[imagesKey] ?? []) content.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
      return { content };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: explain(error) }] };
    }
  });
}
// An edit is a change to a loaded project. Each one is a tool of its own and a step for apply_edits.
const edits = {};
function edit(name, description, schema, apply, { checked = false } = {}) {
  edits[name] = { schema: z.object(schema), apply, description };
  tool(name, description + ' Writes a new project copy.', { project: projectName, output: projectName, ...schema, ...(checked ? { strict: strictChecks } : {}) },
    async ({ project, output, strict, ...args }) => {
      const doc = await load(project);
      const extra = await apply(doc, args);
      const checks = checked ? await runChecks(postSave, doc, output, strict) : {};
      return { ...(await save(doc, output)), ...extra, ...checks };
    });
}
function createSong(bpm, items, mastervol = 86) {
  const doc = parse('<?xml version="1.0"?><!DOCTYPE lmms-project><lmms-project version="1.0" creator="LMMS" creatorversion="1.2.2" type="song"/>');
  add(doc.documentElement, 'head', { bpm, mastervol, timesig_numerator: 4, timesig_denominator: 4 });
  const parent = add(add(doc.documentElement, 'song'), 'trackcontainer', { type: 'song' });
  for (const item of items) addTrack(parent, item);
  return doc;
}
const profileId = z.enum(Object.keys(composerProfiles));
const externalInstruments = {
  'decent-sampler': { env: 'LMMS_DECENT_SAMPLER_VST3', url: 'https://store.decentsamples.com/downloads/decent-sampler/versions', use: 'Sample libraries. Convert an SFZ library with convert_sfz and pass the .dspreset, or save a VST3 preset from a host.' },
  'surge-xt': { env: 'LMMS_SURGE_XT_VST3', url: 'https://surge-synthesizer.github.io/downloads/', use: 'Synth patches for pads, leads and bass.' },
};
const vstWorker = new URL('./vst3-render.py', import.meta.url);
function externalSetup() {
  return Object.entries(externalInstruments).map(([id, item]) => ({
    id, ...item, configured: Boolean(process.env[item.env]), fileFound: Boolean(process.env[item.env] && existsSync(process.env[item.env])),
  }));
}
tool('list_external_tools', 'Discover optional renderer dependencies, VST3 instruments and upstream setup links.', {}, async () => {
  let dependencies;
  let workerError;
  if (process.env.LMMS_VST3_PYTHON) {
    try {
      const { stdout } = await run(process.env.LMMS_VST3_PYTHON, [fileURLToPath(vstWorker), 'probe'], { timeout: 5000, windowsHide: true });
      dependencies = JSON.parse(stdout);
    } catch (error) {
      workerError = error.code ?? 'probe failed';
    }
  }
  return { pythonConfigured: Boolean(process.env.LMMS_VST3_PYTHON), dependencies, workerError, instruments: externalSetup(),
    host: 'https://spotify.github.io/pedalboard/',
    otherTools: [
      { name: 'FFmpeg', use: 'OGG export', env: 'LMMS_FFMPEG', url: 'https://ffmpeg.org/download.html' },
      { name: 'Fathom Synth', use: 'Optional synth worklet', env: 'LMMS_FATHOM_WORKLET' },
      { name: 'LMMS Agent Bridge', use: 'Optional live editing on Windows', env: 'LMMS_LIVE_PIPE', url: 'https://github.com/Jx9x/lmms-mcp-bridge' },
      { name: 'FluidSynth', use: 'Standalone SF2/SF3 MIDI render; manual companion workflow', url: 'https://github.com/FluidSynth/fluidsynth/releases' },
    ],
    setup: 'On Windows x64 with Python 3.12, run setup-vst3-windows.ps1 from the package. See the README for manual setup.' };
});
tool('render_vst3_stems', 'Render named tracks from an editable format 1 MIDI export with configured VST3 instruments, up to 10 minutes, with an optional reverb per track. Return aligned stereo WAVs, a mix and a reproducible assignment manifest. Leave a few seconds after the last note for the release and reverb tail.', {
  midi: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.mid$/i),
  outputDirectory: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/i),
  durationSeconds: z.number().min(0.1).max(600),
  tracks: z.array(z.object({
    track: z.string().min(1).max(100),
    name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i),
    instrument: z.enum(Object.keys(externalInstruments)),
    preset: z.string().regex(/^[a-z0-9][a-z0-9 _-]{0,99}\.vstpreset$/i).optional(),
    dspreset: z.string().regex(/^[a-z0-9][a-z0-9 _-]{0,99}\.dspreset$/i).optional()
      .describe('A Decent Sampler preset in the workspace, for example from convert_sfz. Use instead of preset; instrument must be decent-sampler.'),
    parameters: z.record(z.string().max(120), z.number().min(0).max(1)).default({}),
    gainDb: z.number().min(-60).max(12).default(0),
    width: z.number().min(0).max(1.5).default(1).describe("Stereo width of the instrument before the reverb: 0 is mono, 1 unchanged. Wide sampled pianos often need 0.5 to 0.7 to hold together in mono."),
    eq: z.array(z.object({
      type: z.enum(["highpass", "lowshelf", "highshelf", "peak"]), hz: z.number().min(20).max(20000),
      db: z.number().min(-18).max(18).default(0), q: z.number().min(0.1).max(10).default(0.7),
    })).max(6).default([]).describe("EQ after the instrument, before the reverb. For example a highshelf at 3500 Hz +3 dB to brighten a soft piano."),
    reverb: z.object({
      wet: z.number().min(0).max(1).default(0.22), roomSize: z.number().min(0).max(1).default(0.7),
      damping: z.number().min(0).max(1).default(0.5), width: z.number().min(0).max(1).default(1),
      preDelayMs: z.number().min(0).max(200).default(20),
    }).optional().describe("Add a room to this track after the instrument, for example { wet: 0.22, roomSize: 0.75 } for a piano in a hall. The stem keeps its reverb, so the stems still sum to the mix."),
  })).min(1).max(8),
}, async ({ midi, outputDirectory, durationSeconds, tracks }) => {
  const python = process.env.LMMS_VST3_PYTHON;
  if (!python) throw new Error('Set LMMS_VST3_PYTHON. See list_external_tools and the README.');
  const names = tracks.map(track => track.name.toLowerCase());
  if (new Set(names).size !== names.length || names.includes('mix')) throw new Error('Use unique stem names other than mix');
  const midiPath = path.join(root, midi);
  const midiInfo = await lstat(midiPath);
  if (!midiInfo.isFile() || midiInfo.size > 4 * 1024 * 1024) throw new Error('Expected a workspace MIDI file up to 4 MiB');
  const assignments = [];
  for (const track of tracks) {
    const plugin = process.env[externalInstruments[track.instrument].env];
    if (!plugin || !existsSync(plugin)) throw new Error('Configure ' + externalInstruments[track.instrument].env);
    if (track.preset && track.dspreset) throw new Error("Use preset or dspreset, not both");
    if (track.dspreset && track.instrument !== "decent-sampler") throw new Error("dspreset needs the decent-sampler instrument");
    const preset = track.preset && path.join(root, track.preset);
    const dspreset = track.dspreset && path.join(root, track.dspreset);
    if (dspreset) {
      const info = await lstat(dspreset);
      if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error("Expected a workspace .dspreset up to 8 MiB");
    }
    if (preset) {
      const info = await lstat(preset);
      if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('Expected a workspace VST3 preset up to 16 MiB');
    }
    assignments.push({ ...track, plugin, preset, dspreset });
  }
  const directory = path.join(root, outputDirectory);
  const frames = Math.round(durationSeconds * 48000);
  await mkdir(directory);
  const request = path.join(directory, '.render.json');
  try {
    await writeFile(request, JSON.stringify({ midi: midiPath, directory, frames, tracks: assignments }), { flag: 'wx' });
    const { stdout } = await run(python, [fileURLToPath(vstWorker), request], { timeout: 590000, windowsHide: true });
    const { sharedGain } = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
    const stems = [];
    for (const filename of [...tracks.map(track => track.name + '.wav'), 'mix.wav']) {
      const wav = await readFile(path.join(directory, filename));
      const stats = measureWav(wav);
      if (stats.channels !== 2 || stats.sampleRate !== 48000 || Math.round(stats.durationSeconds * 48000) !== frames) {
        throw new Error('Unexpected VST3 render format or length');
      }
      stems.push({ file: filename, ...stats });
    }
    await rm(request);
    const manifest = { midi, sampleRate: 48000, frames, sharedGain, tracks, stems };
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    return { directory: outputDirectory, ...manifest };
  } catch (error) {
    for (const filename of ['.render.json', 'manifest.json', 'mix.wav', ...tracks.map(track => track.name + '.wav')]) {
      await rm(path.join(directory, filename), { force: true });
    }
    await rmdir(directory);
    throw error;
  }
});
tool('get_started', 'Read the LMMS MCP workflow and discover the local setup before composing, editing or exporting.', {}, async () => ({
  instructions,
  moduleGuidance,
  workspace: root,
  setup: {
    lmmsExecutable: lmms,
    fathomConfigured: Boolean(process.env.LMMS_FATHOM_WORKLET && existsSync(process.env.LMMS_FATHOM_WORKLET)),
    liveToolsEnabled: process.platform === 'win32' && /^[a-zA-Z0-9_-]+$/.test(process.env.LMMS_LIVE_PIPE ?? ''),
    vst3PythonConfigured: Boolean(process.env.LMMS_VST3_PYTHON),
  },
  workflows: {
    plan: ['list_composer_profiles', 'resolve_chords', 'search_sounds', 'list_samples', 'preview_sound'],
    compose: ['create_composer_sketch', 'create_project', 'inspect_arrangement', 'apply_edits'],
    mix: ['inspect_effects', 'list_effects', 'automate_track', 'render_mix', 'analyze_audio'],
    deliver: ['export_game_audio', 'render_stems', 'export_midi', 'export_one_shots'],
    external: ['list_external_tools', 'render_vst3_stems'],
  },
}));
tool('list_composer_profiles', 'Find composer studies by name, musical technique or game use.', {
  query: z.string().max(120).default(''),
}, async ({ query }) => {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return Object.values(composerProfiles).map(describeProfile).filter(profile => {
    const text = Object.values(profile).flat().join(' ').toLowerCase();
    return words.every(word => text.includes(word));
  });
});
tool('create_composer_sketch', 'Write an original editable LMMS sketch based on a composer profile. Uses stock instruments and suggests a Fathom patch for the motif.', {
  output: projectName, profileId, root: z.number().int().min(48).max(67).default(60),
  bpm: z.number().int().min(45).max(240).default(120), bars: z.number().int().min(4).max(16).default(4),
}, async ({ output, profileId: id, root, bpm, bars }) => {
  const profile = composerProfiles[id];
  const items = composeProfile(profile, { root, bars });
  for (const item of items) track.parse(item);
  return { ...await save(createSong(bpm, items), output), profile: describeProfile(profile), root, bpm, bars,
    suggestedFathom: { trackName: 'Motif', patchId: profile.patchId } };
});
const declaredBars = items => Math.max(...items.flatMap(item => item.patterns.map(part => part.bar + part.bars)));
tool('create_project', 'Create an editable 4/4 LMMS project. One bar is 192 ticks, one beat is 48. Each pattern takes raw notes, a drum step grid, a melody line or a chord progression. Stock drum notes play at original pitch on MIDI 69; give one-shots a note length that covers the sample. The song is pinned to lengthBars (default: the last declared pattern bar) even when its final bars are empty.', {
  output: projectName, bpm: z.number().min(45).max(240), tracks: z.array(track).min(1).max(48),
  lengthBars: z.number().int().min(1).max(1000).optional(), masterVolume: volume.default(86),
  tuning: z.enum(['concert', 'preset']).default('concert').describe('How preset voices are tuned; see apply_preset.'),
  strict: strictChecks,
}, async ({ output, bpm, tracks: items, lengthBars, masterVolume, tuning, strict }) => {
  if (new Set(items.map(t => t.name)).size !== items.length) throw new Error('Track names must be unique');
  if (items.some(item => item.name === anchorName)) throw new Error(`"${anchorName}" is a reserved track name`);
  for (const item of items) await checkTrack(item);
  const doc = createSong(bpm, items, masterVolume);
  const loaded = {};
  for (const item of items.filter(item => item.preset)) {
    loaded[item.name] = await loadPreset(doc, instrumentOf(doc, item.name), item.preset, { tuning });
  }
  const natural = songInfo(doc).lengthBars, wanted = lengthBars ?? declaredBars(items);
  if (wanted < natural) throw new Error(`lengthBars is ${wanted} but the notes run for ${natural} bars`);
  if (wanted > natural) setAnchor(doc, wanted);
  const info = songInfo(doc);
  const checks = await runChecks(postSave, doc, output, strict);
  return { ...(await save(doc, output)), lengthBars: info.lengthBars, lengthSeconds: Number(info.lengthSeconds.toFixed(4)),
    lengthPinned: wanted > natural, ...(Object.keys(loaded).length ? { presets: loaded } : {}), ...checks };
});
tool('inspect_project', 'Read saved instrument tracks, pattern locations and note counts.', { project: projectName },
  async ({ project }) => tracks(await load(project)).filter(t => !isAnchor(t)).map(t => ({
    name: t.getAttribute('name'), patterns: children(t, 'pattern').map(p => ({
      name: p.getAttribute('name'), tick: Number(p.getAttribute('pos')),
      length: Number(p.getAttribute('len')), notes: children(p, 'note').length,
    })),
  })));
tool('read_pattern', 'Read the notes in a saved instrument pattern. Bar numbers start at zero.', {
  project: projectName, trackName: z.string(), bar: z.number().int().min(0).max(999),
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
function instrumentOf(doc, name) {
  const matching = tracks(doc).filter(t => t.getAttribute('name') === name && t.getAttribute('type') === '0');
  const instrument = matching.length === 1 && children(matching[0], 'instrumenttrack')[0];
  if (!instrument) {
    const names = tracks(doc).filter(t => t.getAttribute('type') === '0').map(t => t.getAttribute('name'));
    throw new Error(`Expected one instrument track named "${name}". Instrument tracks: ${names.join(', ')}`);
  }
  return instrument;
}
edit('replace_pattern', 'Replace one arrangement pattern, identified by track and bar.', {
  trackName: z.string(), pattern,
}, (doc, { trackName, pattern: part }) => {
  const [target, clip] = findPattern(doc, trackName, part.bar);
  target.replaceChild(addPattern(target, part), clip);
});
edit('add_pattern', 'Add a pattern to an existing instrument track at an unused bar.', {
  trackName: z.string(), pattern,
}, (doc, { trackName, pattern: part }) => {
  const target = instrumentOf(doc, trackName).parentNode;
  if (children(target, 'pattern').some(p => Number(p.getAttribute('pos')) === part.bar * 192)) {
    throw new Error('A pattern already starts at that bar. Use replace_pattern.');
  }
  addPattern(target, part);
});
edit('add_track', 'Add an instrument track with its patterns to an existing project.', {
  track, tuning: z.enum(['concert', 'preset']).default('concert'),
}, async (doc, { track: item, tuning }) => {
  if (item.name === anchorName || tracks(doc).some(t => t.getAttribute('name') === item.name)) throw new Error('Track name is already in use');
  await checkTrack(item);
  const anchor = tracks(doc).find(isAnchor);
  const instrument = addTrack(container(doc), item);
  if (anchor) container(doc).appendChild(anchor); // keep the anchor last
  return item.preset ? { preset: await loadPreset(doc, instrument, item.preset, { tuning }) } : undefined;
}, { checked: true });
edit('remove_track', 'Remove an instrument track and any automation clips linked to it.', {
  trackName: z.string(),
}, (doc, { trackName }) => {
  const target = instrumentOf(doc, trackName).parentNode;
  const ids = new Set(Array.from(target.getElementsByTagName('*')).map(node => node.getAttribute('id')).filter(Boolean));
  for (const t of tracks(doc).filter(t => t.getAttribute('type') === '5')) {
    for (const clip of children(t, 'automationpattern')) {
      if (children(clip, 'object').some(object => ids.has(object.getAttribute('id')))) t.removeChild(clip);
    }
    if (!children(t, 'automationpattern').length) t.parentNode.removeChild(t);
  }
  target.parentNode.removeChild(target);
});
edit('copy_bars', 'Repeat a section: copy every pattern that lies inside a bar range to a new position, on all instrument tracks or the named ones.', {
  fromBar: z.number().int().min(0).max(999), bars: z.number().int().min(1).max(256), toBar: z.number().int().min(0).max(999),
  tracks: z.array(z.string()).min(1).optional(),
}, (doc, { fromBar, bars, toBar, tracks: names }) => {
  const start = fromBar * 192, end = start + bars * 192, shift = (toBar - fromBar) * 192;
  const targets = names ? names.map(name => instrumentOf(doc, name).parentNode) : tracks(doc).filter(t => t.getAttribute('type') === '0');
  let copied = 0;
  for (const target of targets) {
    const clips = children(target, 'pattern');
    for (const clip of clips) {
      const pos = Number(clip.getAttribute('pos'));
      if (pos < start || pos + Number(clip.getAttribute('len')) > end) continue;
      if (clips.some(other => Number(other.getAttribute('pos')) === pos + shift)) {
        throw new Error(`Track "${target.getAttribute('name')}" already has a pattern at bar ${(pos + shift) / 192}`);
      }
      target.appendChild(clip.cloneNode(true)).setAttribute('pos', String(pos + shift));
      copied++;
    }
  }
  if (!copied) throw new Error('No pattern lies fully inside that bar range');
  return { copiedPatterns: copied };
});
edit('set_song_length', 'Pin the song to an exact number of bars so loops keep empty closing bars, or pass null to remove the pin.', {
  bars: z.number().int().min(1).max(1000).nullable(),
}, (doc, { bars }) => {
  setAnchor(doc, null);
  const natural = songInfo(doc).lengthBars;
  if (bars !== null && bars < natural) throw new Error(`The notes already run for ${natural} bars`);
  if (bars !== null && bars > natural) setAnchor(doc, bars);
  const info = songInfo(doc);
  return { lengthBars: info.lengthBars, lengthSeconds: Number(info.lengthSeconds.toFixed(4)) };
});
tool('save_project_copy', 'Copy a native saved project between .mmp and .mmpz, preserving its XML content.', {
  project: projectName, output: projectName,
}, async ({ project, output }) => save(await load(project), output));
edit('set_track_mix', 'Change volume (0-200, fractions allowed), pan, mute or solo on one instrument track. Solo is honoured by render_mix.', {
  trackName: z.string(), volume: volume.optional(),
  pan: z.number().min(-100).max(100).optional(),
  mute: z.boolean().optional(), solo: z.boolean().optional(),
}, (doc, { trackName, volume: level, pan, mute, solo }) => {
  if ([level, pan, mute, solo].every(value => value === undefined)) throw new Error('Provide at least one mix control');
  const instrument = instrumentOf(doc, trackName), target = instrument.parentNode;
  for (const [node, key, value] of [[instrument, 'vol', level], [instrument, 'pan', pan],
    [target, 'muted', mute], [target, 'solo', solo]]) {
    if (value === undefined) continue;
    if (children(node, key).length) throw new Error(`"${trackName}" ${key} is automated. Remove or edit its automation instead.`);
    node.setAttribute(key, String(typeof value === 'boolean' ? Number(value) : value));
  }
});
edit('set_master', 'Set master volume (0-200) and master pitch in semitones.', {
  volume: volume.optional(), pitch: z.number().int().min(-12).max(12).optional(),
}, (doc, { volume: level, pitch }) => {
  const { head } = songInfo(doc);
  if (level === undefined && pitch === undefined) throw new Error('Provide volume or pitch');
  for (const [key, value] of [['mastervol', level], ['masterpitch', pitch]]) {
    if (value === undefined) continue;
    if (children(head, key).length) throw new Error('That master control is automated. Edit it in LMMS.');
    head.setAttribute(key, String(value));
  }
});

async function listPresets() {
  const groups = await readdir(presets, { withFileTypes: true });
  const files = await Promise.all(groups.filter(group => group.isDirectory()).map(async group => {
    const entries = await readdir(path.join(presets, group.name), { withFileTypes: true });
    return entries.filter(entry => entry.isFile()).map(entry => group.name + '/' + entry.name);
  }));
  return files.flat().filter(name => name.endsWith('.xpf') && presetFile.safeParse(name).success).sort();
}
async function listZynPresets() {
  const bank = path.join(presets, 'ZynAddSubFX');
  const groups = await readdir(bank, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(groups.filter(group => group.isDirectory()).map(async group => {
    const entries = await readdir(path.join(bank, group.name), { withFileTypes: true });
    return entries.filter(entry => entry.isFile()).map(entry => `ZynAddSubFX/${group.name}/${entry.name}`);
  }));
  return files.flat().filter(name => name.endsWith('.xiz') && presetFile.safeParse(name).success).sort();
}
tool('list_presets', 'List installed factory presets: native .xpf paths, plus ZynAddSubFX bank folders with counts (pass a bank to list its .xiz patches).', {
  zynBank: z.string().regex(/^[\w -]+$/).optional(),
}, async ({ zynBank }) => {
  const zyn = await listZynPresets();
  if (zynBank) return zyn.filter(name => name.split('/')[1].toLowerCase() === zynBank.toLowerCase());
  const banks = {};
  for (const name of zyn) banks[name.split('/')[1]] = (banks[name.split('/')[1]] ?? 0) + 1;
  return { presets: await listPresets(), zynBanks: banks };
});

// ---------- rendering ----------
const renderLimit = Number(process.env.LMMS_RENDER_TIMEOUT_SECONDS) || null;
function forRender(doc) {
  const copy = parse(xml.serializeToString(doc));
  const list = tracks(copy);
  // LMMS applies solo in its window, not in the file, so a headless render needs the mutes written out.
  if (list.some(t => t.getAttribute('solo') === '1')) {
    for (const t of list) if (!isControl(t) && t.getAttribute('solo') !== '1') t.setAttribute('muted', '1');
  }
  return copy;
}
function isolate(doc, keep) {
  const copy = parse(xml.serializeToString(doc));
  tracks(copy).forEach((t, index) => {
    if (isControl(t)) return;
    t.setAttribute('solo', '0');
    if (!keep.has(index)) t.setAttribute('muted', '1');
  });
  return copy;
}
async function renderDoc(doc, { loop = true, prepared = false } = {}) {
  const copy = prepared ? doc : forRender(doc);
  const seconds = renderLimit ?? Math.min(3600, Math.max(180, Math.round(songInfo(doc).lengthSeconds * 10 + 120)));
  const temp = await mkdtemp(path.join(root, '.render-'));
  try {
    const project = path.join(temp, 'render.mmp'), rendered = path.join(temp, 'render.wav');
    await writeFile(project, xml.serializeToString(copy));
    try {
      await run(lmms, ['render', project, '-s', '48000', '-f', 'wav', ...(loop ? ['-l'] : []), '-o', rendered],
        { cwd: root, timeout: seconds * 1000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      if (error.killed) throw new Error(`LMMS did not finish rendering within ${seconds} seconds. Set LMMS_RENDER_TIMEOUT_SECONDS to allow longer.`);
      throw new Error(error.code === 'ENOENT' ? `LMMS was not found at ${lmms}. Set LMMS_EXECUTABLE.` : 'LMMS render failed: ' + String(error.message).split('\n')[0]);
    }
    return await readFile(rendered);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
async function pool(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index], index); }
  }));
  return results;
}
const parallelRenders = Math.max(1, Math.min(4, Number(process.env.LMMS_PARALLEL_RENDERS) || 3));
let ffmpegFound;
async function hasFfmpeg() {
  ffmpegFound ??= run(ffmpeg, ['-version'], { windowsHide: true }).then(() => true, () => false);
  return ffmpegFound;
}
async function writeAudio(file, wav, overwrite = false) {
  if (!file.toLowerCase().endsWith('.ogg')) return writeFile(file, wav, { flag: overwrite ? 'w' : 'wx' });
  if (!(await hasFfmpeg())) throw new Error('OGG output needs ffmpeg. Install it or set LMMS_FFMPEG to its path.');
  if (existsSync(file)) throw new Error('Output already exists');
  const temp = await mkdtemp(path.join(root, '.encode-'));
  try {
    await writeFile(path.join(temp, 'in.wav'), wav);
    await run(ffmpeg, ['-v', 'error', '-n', '-i', path.join(temp, 'in.wav'), '-c:a', 'libvorbis', '-q:a', '6', file], { windowsHide: true, timeout: 120000 });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
// Bring audio to a loudness target under a peak ceiling. Returns what was done.
function masterAudio(audio, { targetLufs, ceilingDb, wrap = false }) {
  if (targetLufs === undefined && ceilingDb === undefined) return null;
  const report = { gainDb: 0 };
  const ceiling = ceilingDb ?? -1;
  for (let pass = 0; pass < (targetLufs === undefined ? 1 : 2); pass++) {
    if (targetLufs !== undefined) {
      const measured = dsp.loudness(audio).integratedLufs;
      if (measured === null) throw new Error('Cannot set the loudness of silence');
      const gain = targetLufs - measured;
      if (pass && gain < 0.2) break;
      dsp.applyGain(audio, 10 ** (gain / 20));
      report.gainDb = Number((report.gainDb + gain).toFixed(2));
    }
    const limited = dsp.limit(audio, ceiling, { wrap });
    report.limiter = { ceilingDb: ceiling, limitedSamples: (report.limiter?.limitedSamples ?? 0) + limited.limitedSamples,
      maxReductionDb: Math.min(report.limiter?.maxReductionDb ?? 0, limited.maxReductionDb) };
    if (!limited.limitedSamples) break;
  }
  if (report.limiter.maxReductionDb < -6) report.warning = 'The limiter is working hard (more than 6 dB). Lower the loudness target or rebalance the mix.';
  return report;
}
function barFrames(info, sampleRate) {
  if (!info.staticTempo) throw new Error('Loop-safe rendering needs a static tempo');
  return Math.round(info.secondsPerBar * sampleRate);
}
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
  const level = value => value === 0 ? null : Number((20 * Math.log10(value / 32768)).toFixed(2));
  return { channels, sampleRate, durationSeconds: samples.length / frameBytes / sampleRate,
    peakDbfs: level(peak), rmsDbfs: level(Math.sqrt(sumSquares / (samples.length / 2))),
    fullScaleSamples, boundaryJumpDbfs: level(boundaryJump) };
}
const tailMode = z.enum(['cut', 'wrap', 'keep']).default('cut')
  .describe('cut: stop at the last bar (default). wrap: fold the reverb and delay tail back onto the start for a seamless loop. keep: let the tail ring out (one extra bar).');
const loudnessTarget = z.number().min(-36).max(-6).optional().describe('Integrated loudness target in LUFS, for example -16 for game music.');
const ceilingTarget = z.number().min(-12).max(0).optional().describe('Peak ceiling in dBFS for the built-in limiter (default -1 when a loudness target is set).');
async function renderMix(doc, { tail = 'cut', targetLufs, ceilingDb } = {}) {
  const info = songInfo(doc);
  const raw = await renderDoc(doc, { loop: tail === 'cut' });
  if (tail === 'cut' && targetLufs === undefined && ceilingDb === undefined) return { wav: raw, audio: null, info };
  let audio = dsp.decodeWav(raw);
  if (tail === 'wrap') audio = dsp.foldTail(audio, Math.max(1, audio.frames - barFrames(info, audio.sampleRate)));
  const mastering = masterAudio(audio, { targetLufs, ceilingDb, wrap: tail === 'wrap' });
  return { wav: dsp.encodeWav(audio), audio, info, mastering };
}
tool('render_mix', 'Render the song to a 48 kHz WAV or OGG and report duration, peak, RMS, loudness, clipped samples and the loop boundary jump. Honours solo. Optional loop-safe tail and loudness mastering.', {
  project: projectName, output: audioOut, tail: tailMode, targetLufs: loudnessTarget, ceilingDb: ceilingTarget,
}, async ({ project, output, tail, targetLufs, ceilingDb }) => {
  if (existsSync(path.join(root, output))) throw new Error('Output already exists');
  const doc = await load(project);
  const { wav, audio, info, mastering } = await renderMix(doc, { tail, targetLufs, ceilingDb });
  await writeAudio(path.join(root, output), wav);
  const decoded = audio ?? dsp.decodeWav(wav);
  const stats = measureWav(wav);
  const expected = info.lengthSeconds + (tail === 'keep' ? info.secondsPerBar : 0);
  const warnings = [];
  if (stats.fullScaleSamples) warnings.push(`${stats.fullScaleSamples} samples clip. Lower track or master volume, or pass targetLufs or ceilingDb.`);
  if (Math.abs(stats.durationSeconds - expected) > 0.05) warnings.push(`Rendered ${stats.durationSeconds.toFixed(3)} s but the arrangement reads as ${expected.toFixed(3)} s.`);
  return { audio: output, bytes: wav.length, ...stats, bars: info.lengthBars, tail,
    integratedLufs: dsp.loudness(decoded).integratedLufs, truePeakDbfs: dsp.db(dsp.truePeak(decoded)),
    ...(mastering ? { mastering } : {}), ...(warnings.length ? { warnings } : {}) };
});
const safeFile = name => name.replace(/[^a-z0-9 _-]+/gi, '_').trim() || 'track';
tool('render_stems', 'Render one WAV per instrument, sample or Beat/Bassline track, all aligned to the mix length. Works for full-length songs; renders run in parallel.', {
  project: projectName, outputDirectory: folderName,
  tracks: z.array(z.string()).min(1).optional().describe('Only these track names (default: every unmuted audio track).'),
  tail: z.enum(['cut', 'wrap']).default('cut'),
}, async ({ project, outputDirectory, tracks: names, tail }) => {
  const doc = await load(project);
  const info = songInfo(doc);
  const all = tracks(doc);
  const wanted = all.map((t, index) => ({ t, index })).filter(({ t }) => !isControl(t) && t.getAttribute('muted') !== '1' &&
    (!names || names.includes(t.getAttribute('name'))));
  if (names && wanted.length !== names.length) throw new Error('Some named tracks were not found or are muted');
  if (!wanted.length) throw new Error('No audio tracks to render');
  const output = path.join(root, outputDirectory);
  await mkdir(output);
  try {
    const frames = Math.round(info.lengthSeconds * 48000);
    const stems = await pool(wanted, parallelRenders, async ({ t, index }) => {
      let audio = dsp.decodeWav(await renderDoc(isolate(doc, new Set([index])), { loop: tail === 'cut', prepared: true }));
      audio = tail === 'wrap' ? dsp.foldTail(dsp.fitLength(audio, frames + barFrames(info, audio.sampleRate)), frames) : dsp.fitLength(audio, frames);
      const file = `${index + 1}_${safeFile(t.getAttribute('name'))}.wav`;
      const wav = dsp.encodeWav(audio);
      await writeFile(path.join(output, file), wav, { flag: 'wx' });
      return { file, track: t.getAttribute('name'), ...measureWav(wav) };
    });
    return { directory: outputDirectory, bars: info.lengthBars, stems };
  } catch (error) {
    await rm(output, { recursive: true, force: true }); // created by this call
    throw new Error('Stem render failed and its folder was removed: ' + error.message);
  }
});

// ---------- listening ----------
const section = z.object({ name: z.string().min(1).max(60), startBar: z.number().min(0).optional(), bars: z.number().min(0.25).optional(),
  startSeconds: z.number().min(0).optional(), endSeconds: z.number().min(0).optional() });
const pngName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.png$/i);
tool('analyze_audio', 'Measure a workspace WAV so you can judge a mix without hearing it: integrated loudness (LUFS), true peak, RMS, crest, clipping, DC, stereo correlation, energy in six frequency bands, spectral centroid, loop seam, optional per-section levels and pitch, plus plain-language warnings. Can return a spectrogram image.', {
  audio: workspaceWav, bpm: z.number().min(20).max(400).optional().describe('Needed when sections are given in bars.'),
  sections: z.array(section).max(64).default([]), pitch: z.boolean().default(false),
  loop: z.boolean().default(false).describe('Check the file as a loop.'), targetLufs: loudnessTarget,
  spectrogram: pngName.optional().describe('Also write this PNG to the workspace and return it as an image.'),
}, async ({ audio: file, bpm, sections, pitch, loop, targetLufs, spectrogram }) => {
  if (spectrogram && existsSync(path.join(root, spectrogram))) throw new Error('Spectrogram output already exists');
  const audio = dsp.decodeWav(await readFile(path.join(root, file)));
  const spans = sections.map(({ name, startBar, bars, startSeconds, endSeconds }) => {
    if (startBar !== undefined) {
      if (!bpm) throw new Error('Pass bpm to describe sections in bars');
      return { name, startSeconds: startBar * 240 / bpm, endSeconds: (startBar + (bars ?? 1)) * 240 / bpm };
    }
    if (startSeconds === undefined || endSeconds === undefined || endSeconds <= startSeconds) throw new Error(`Section "${name}" needs startBar, or startSeconds and endSeconds`);
    return { name, startSeconds, endSeconds };
  });
  const report = dsp.analyze(audio, { sections: spans, pitch });
  const result = { audio: file, ...report, warnings: dsp.advise(report, { loop, targetLufs }) };
  if (spectrogram) {
    const png = dsp.spectrogramPng(audio);
    await writeFile(path.join(root, spectrogram), png, { flag: 'wx' });
    result.spectrogram = { file: spectrogram, axes: 'time left to right, 40 Hz (bottom) to 16 kHz (top), log scale, brighter is louder' };
    result[imagesKey] = [png];
  }
  return result;
});

// ---------- sounds ----------
tool('list_samples', 'Browse the stock LMMS sample library (drums, basses, instruments, strings, effects and more). Returns factorySample paths for sample tracks.', {
  group: z.string().regex(/^[\w -]+$/).optional(), query: z.string().max(60).default(''),
  limit: z.number().int().min(1).max(300).default(60),
}, async ({ group, query, limit }) => {
  const found = [];
  const groups = {};
  for (const folder of await readdir(samplesDirectory, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    const walk = async relative => {
      for (const entry of await readdir(path.join(samplesDirectory, relative), { withFileTypes: true })) {
        const name = relative + '/' + entry.name;
        if (entry.isDirectory() && name.split('/').length < 3) await walk(name);
        else if (entry.isFile() && factorySample.safeParse(name).success) {
          groups[folder.name] = (groups[folder.name] ?? 0) + 1;
          found.push(name);
        }
      }
    };
    await walk(folder.name);
  }
  const tokens = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const matches = found.filter(name => (!group || name.split('/')[0].toLowerCase() === group.toLowerCase()) &&
    tokens.every(token => name.toLowerCase().includes(token))).sort();
  return { groups, total: matches.length, samples: matches.slice(0, limit) };
});
tool('list_drum_kits', 'List available stock drum kits built from LMMS factory samples. Each kit provides kick, snare, hat and clap paths.', {}, async () => {
  const available = {};
  for (const [name, pieces] of Object.entries(kits)) {
    available[name] = {};
    for (const [piece, file] of Object.entries(pieces)) {
      const full = path.join(samplesDirectory, 'drums', file + '.ogg');
      available[name][piece] = existsSync(full) ? `drums/${file}.ogg` : null;
    }
  }
  return { kits: available, note: 'Use create_drum_kit to turn one of these into tracks, or pass the factorySample paths to create_project with voice "sample".' };
});

tool('create_drum_kit', 'Create a new LMMS project containing a ready-to-use drum kit (separate tracks for kick, snare, hat, clap). Patterns are empty so the agent can fill them with step grids or notes.', {
  output: projectName,
  kit: z.enum(Object.keys(kits)).default('soft'),
  bpm: z.number().min(45).max(240).default(120),
  lengthBars: z.number().int().min(1).max(64).default(8),
  masterVolume: volume.default(86),
}, async ({ output, kit: kitName, bpm, lengthBars, masterVolume }) => {
  const chosen = kits[kitName];
  const tracks = [];
  const volumes = { kick: 92, snare: 78, hat: 62, openhat: 58, clap: 70 };
  const pans = { hat: 22, openhat: -18, clap: 8 };
  for (const [piece, file] of Object.entries(chosen)) {
    const full = path.join(samplesDirectory, 'drums', file + '.ogg');
    if (!existsSync(full)) continue;
    tracks.push({
      name: piece,
      voice: 'sample',
      factorySample: `drums/${file}.ogg`,
      role: 'drums',
      volume: volumes[piece] ?? 70,
      pan: pans[piece] ?? 0,
      patterns: [{ name: piece, bar: 0, bars: lengthBars, steps: { grid: '-'.repeat(16) } }],
    });
  }
  if (!tracks.length) throw new Error(`No samples found for kit "${kitName}". Run list_drum_kits to see what is available.`);
  for (const item of tracks) await checkTrack(item);
  const doc = createSong(bpm, tracks, masterVolume);
  const natural = songInfo(doc).lengthBars;
  if (lengthBars < natural) throw new Error(`lengthBars is ${lengthBars} but the notes run for ${natural} bars`);
  if (lengthBars > natural) pinLength(doc, lengthBars);
  return { ...(await save(doc, output)), kit: kitName, tracks: tracks.map(t => t.name), lengthBars };
});


// Measured facts about factory sounds: level, tuning, envelope and brightness. A copy for stock LMMS 1.2.2 ships
// with the server; build_sound_catalogue adds or refreshes entries in the workspace.
const shippedCatalogue = fileURLToPath(new URL('./sound-catalogue.json', import.meta.url));
const workspaceCatalogue = path.join(root, '.lmms-sound-catalogue.json');
let measuredSounds;
async function soundFacts() {
  if (!measuredSounds) {
    measuredSounds = {};
    for (const file of [shippedCatalogue, workspaceCatalogue]) {
      try { Object.assign(measuredSounds, JSON.parse(await readFile(file, 'utf8')).sounds); } catch { /* optional */ }
    }
  }
  return measuredSounds;
}
const zynShell = inner => '<ZynAddSubFX-data version-major="2" version-minor="4" version-revision="1" ZynAddSubFX-author="Nasca Octavian Paul">' +
  '<MASTER><par name="volume" value="80"/><par name="key_shift" value="64"/><PART id="0"><par_bool name="enabled" value="yes"/>' +
  '<par name="volume" value="96"/><par name="panning" value="64"/><par name="min_key" value="0"/><par name="max_key" value="127"/>' +
  '<par name="key_shift" value="64"/><par name="rcv_chn" value="0"/><par name="velocity_sensing" value="64"/><par name="velocity_offset" value="64"/>' +
  '<par_bool name="note_on" value="yes"/><par_bool name="poly_mode" value="yes"/><par name="legato_mode" value="0"/><par name="key_limit" value="15"/>' +
  inner + '</PART></MASTER></ZynAddSubFX-data>';
const linked = node => node && Array.from(node.getElementsByTagName('*')).some(child => child.hasAttribute('id'));
const settingsTags = new Set(['eldata', 'chordcreator', 'arpeggiator', 'midiport', 'fxchain', 'midi', 'surpos']);
async function loadPresetRaw(doc, target, preset) {
  const file = await readFile(path.join(presets, preset));
  const [previousInstrument] = children(target, 'instrument');
  const [previousEnvelope] = children(target, 'eldata');
  if (linked(previousInstrument) || linked(previousEnvelope)) throw new Error('Existing instrument has linked controls');
  if (preset.toLowerCase().endsWith('.xiz')) {
    const source = (file[0] === 0x1f && file[1] === 0x8b ? gunzipSync(file, { maxOutputLength: 8 * 1024 * 1024 }) : file).toString('utf8');
    const match = /<INSTRUMENT>[\s\S]*<\/INSTRUMENT>/.exec(source);
    if (!match) throw new Error('Expected a ZynAddSubFX instrument file');
    const data = new DOMParser().parseFromString(zynShell(match[0]), 'application/xml').documentElement;
    if (previousInstrument) target.removeChild(previousInstrument);
    if (previousEnvelope) target.removeChild(previousEnvelope);
    const holder = add(add(target, 'instrument', { name: 'zynaddsubfx' }), 'zynaddsubfx', { modifiedcontrollers: '', portamento: 0,
      filterfreq: 64, filterq: 64, bandwidth: 64, fmgain: 127, rescenterfreq: 64, resbandwidth: 64, forwardmidicc: 1 });
    holder.appendChild(doc.importNode(data, true));
    target.setAttribute('basenote', '57');
    return;
  }
  const source = new DOMParser().parseFromString(file.toString('utf8'), 'application/xml');
  // Three generations of preset file exist: <instrumenttrack><instrument>, a bare plugin element, and 0.x <channeltrack>.
  const settings = source.getElementsByTagName('instrumenttrack')[0] ?? source.getElementsByTagName('channeltrack')[0];
  if (!settings) throw new Error('Expected a native instrument preset');
  let [instrument] = children(settings, 'instrument');
  if (!instrument) {
    const plugin = elements(settings).find(node => !settingsTags.has(node.nodeName));
    if (!plugin) throw new Error('Preset has no instrument settings');
    instrument = source.createElement('instrument');
    instrument.setAttribute('name', plugin.nodeName);
    instrument.appendChild(plugin.cloneNode(true));
  }
  const [envelope] = children(settings, 'eldata');
  if (linked(instrument) || linked(envelope)) throw new Error('Preset contains model IDs that require remapping');
  if (previousInstrument) target.removeChild(previousInstrument);
  target.appendChild(doc.importNode(instrument, true));
  if (envelope) {
    if (previousEnvelope) target.removeChild(previousEnvelope);
    const imported = target.appendChild(doc.importNode(envelope, true));
    for (const node of elements(imported)) { // pre-1.0 files call the sustain level "sus"
      if (node.hasAttribute('sus') && !node.hasAttribute('sustain')) node.setAttribute('sustain', node.getAttribute('sus'));
    }
  }
  const baseNote = settings.getAttribute('basenote') ??
    (settings.hasAttribute('baseoct') ? String(Number(settings.getAttribute('baseoct')) * 12 + Number(settings.getAttribute('basetone') || 9)) : null);
  target.setAttribute('basenote', baseNote ?? '57');
}
const measuring = new Map();
const probeVolume = 15;
// A measured pitch offset is trusted when it agrees with the preset's stored base note, give or take whole octaves.
// (MIDI-driven instruments such as ZynAddSubFX sound an octave below native synths in LMMS 1.2.)
const trustedOffset = (offset, baseNote) => Math.abs(offset) <= 24 && ((offset - (57 - baseNote)) % 12 + 12) % 12 === 0;
function measurePreset(preset) {
  if (!measuring.has(preset)) {
    measuring.set(preset, (async () => {
      const doc = createSong(120, [{ name: 'Probe', voice: 'pluck', volume: probeVolume, pan: 0,
        patterns: [{ name: 'Probe', bar: 0, bars: 2, notes: [{ tick: 0, midi: 60, length: 96, velocity: 100 }] }] }], 100);
      await loadPresetRaw(doc, instrumentOf(doc, 'Probe'), preset);
      setAnchor(doc, 2);
      const audio = dsp.decodeWav(await renderDoc(doc, { prepared: true }));
      const facts = measureInstrument(audio, { writtenMidi: 60, holdSeconds: 1 }, dsp);
      if (facts.peakDbfs !== null) facts.peakDbfs = Number((facts.peakDbfs + 20 * Math.log10(60 / probeVolume)).toFixed(2));
      return facts;
    })());
    measuring.get(preset).catch(() => measuring.delete(preset));
  }
  return measuring.get(preset);
}
async function factsFor(preset) {
  return (await soundFacts())[preset] ?? measurePreset(preset);
}
// Load a preset. With concert tuning the track's base note is corrected so written pitch equals sounding pitch.
async function loadPreset(doc, target, preset, { tuning = 'concert' } = {}) {
  await loadPresetRaw(doc, target, preset);
  const report = { preset, tuning, baseNote: Number(target.getAttribute('basenote')) };
  let facts;
  try { facts = await factsFor(preset); } catch (error) { report.measureError = error.message; }
  if (facts) {
    report.pitched = facts.pitched;
    report.presetPitchOffsetSemitones = facts.pitchOffset;
    report.peakDbfsAtVolume60 = facts.peakDbfs;
    if (facts.peakDbfs !== null && facts.peakDbfs < -30) report.level = 'very quiet: raise the track volume';
    if (facts.peakDbfs !== null && facts.peakDbfs > -3) report.level = 'very loud: start with a low track volume';
    const trusted = facts.pitched && trustedOffset(facts.pitchOffset, report.baseNote);
    if (facts.pitched && facts.pitchOffset && !trusted) {
      report.note = 'The pitch reading for this preset is uncertain, so its tuning was left as saved. Check it with preview_sound.';
    } else if (tuning === 'concert' && facts.pitched && facts.pitchOffset) {
      report.baseNote += facts.pitchOffset;
      target.setAttribute('basenote', String(report.baseNote));
      report.corrected = true;
    } else if (facts.pitched && facts.pitchOffset) {
      report.note = `Written notes sound ${Math.abs(facts.pitchOffset)} semitones ${facts.pitchOffset < 0 ? 'lower' : 'higher'} with this preset.`;
    }
  }
  return report;
}
edit('apply_preset', 'Load a factory preset (.xpf or ZynAddSubFX .xiz) onto a track. With the default concert tuning, presets saved at another base note are corrected so written notes sound at pitch; the result reports the measured offset and level.', {
  trackName: z.string(), preset: presetFile, tuning: z.enum(['concert', 'preset']).default('concert'),
}, async (doc, { trackName, preset, tuning }) => ({ preset: await loadPreset(doc, instrumentOf(doc, trackName), preset, { tuning }) }));

tool('search_sounds', 'Find sounds by name, role and character across factory presets, ZynAddSubFX patches and Fathom patches. Measured entries carry level, tuning, envelope and brightness tags.', {
  query: z.string().max(120).default(''), engine: z.enum(['fathom', 'lmms', 'zyn']).optional(),
  role: z.enum(['bass', 'lead', 'pad', 'pluck', 'bell', 'keys', 'strings', 'brass', 'organ', 'drum', 'fx']).optional(),
  limit: z.number().int().min(1).max(100).default(20),
}, async args => {
  let native = [], zyn = [], nativePresetError;
  try {
    if (args.engine !== 'fathom' && args.engine !== 'zyn') native = await listPresets();
    if (args.engine !== 'fathom' && args.engine !== 'lmms') zyn = await listZynPresets();
  } catch (error) { nativePresetError = error.code ?? error.message; }
  const worklet = process.env.LMMS_FATHOM_WORKLET;
  const fathomAvailable = Boolean(worklet && existsSync(worklet));
  const facts = await soundFacts();
  return { ...searchSounds({ ...args, fathomAvailable }, native, zyn, facts), fathomAvailable,
    measuredSounds: Object.keys(facts).length, nativePresetError };
});
tool('build_sound_catalogue', 'Measure factory presets by rendering a test note, so search_sounds can filter by role, loudness, tuning and brightness. Processes up to `limit` unmeasured presets per call; call again until remaining is 0.', {
  engine: z.enum(['lmms', 'zyn']).default('lmms'), zynBank: z.string().regex(/^[\w -]+$/).optional(),
  limit: z.number().int().min(1).max(120).default(40), refresh: z.boolean().default(false),
}, async ({ engine, zynBank, limit, refresh }) => {
  const facts = await soundFacts();
  let all = engine === 'lmms' ? await listPresets() : await listZynPresets();
  if (zynBank) all = all.filter(name => name.split('/')[1]?.toLowerCase() === zynBank.toLowerCase());
  const todo = all.filter(name => refresh || !facts[name]).slice(0, limit);
  const failed = [];
  await pool(todo, parallelRenders, async preset => {
    measuring.delete(preset);
    try { facts[preset] = await measurePreset(preset); } catch (error) { failed.push({ preset, error: error.message }); }
  });
  let own = {};
  try { own = JSON.parse(await readFile(workspaceCatalogue, 'utf8')).sounds; } catch { /* first run */ }
  for (const preset of todo) if (facts[preset]) own[preset] = facts[preset];
  await writeFile(workspaceCatalogue, JSON.stringify({ lmms: '1.2', sounds: own }));
  return { measured: todo.length - failed.length, failed, remaining: all.filter(name => !facts[name]).length, total: all.length };
});

tool('preview_sound', 'Render a short audition of a factory preset, stock sample or Fathom patch to a workspace WAV and report its level and detected pitch.', {
  patchId: patchId.optional(), preset: presetFile.optional(), factorySample: factorySample.optional(), output: wavName,
  midi: z.number().int().min(24).max(96).optional(),
}, async ({ patchId: id, preset, factorySample: sample, output, midi }) => {
  if ([id, preset, sample].filter(Boolean).length !== 1) throw new Error('Supply exactly one of patchId, preset or factorySample');
  if (existsSync(path.join(root, output))) throw new Error('Output already exists');
  if (preset || sample) {
    const base = sample ? 69 : midi ?? 57;
    const item = { name: 'Preview', voice: sample ? 'sample' : 'pluck', factorySample: sample, rootMidi: 69, volume: 45, pan: 0,
      patterns: [{ name: 'Preview', bar: 0, bars: 1,
        notes: (sample ? [0] : [0, 7, 12, 3]).map((offset, i) => ({ tick: i * 36, midi: base + offset, length: sample ? 180 : 29, velocity: 76 })) }] };
    if (sample) await checkTrack(item);
    const doc = createSong(120, [item], 65);
    const loaded = preset ? await loadPreset(doc, instrumentOf(doc, 'Preview'), preset) : undefined;
    const wav = await renderDoc(doc, { prepared: true });
    const stats = measureWav(wav);
    if (stats.peakDbfs === null) throw new Error('Preview is silent. Try a different MIDI root or sound.');
    await writeFile(path.join(root, output), wav, { flag: 'wx' });
    const audio = dsp.decodeWav(wav);
    const pitch = sample ? undefined : dsp.detectPitch(audio.channels[0], audio.sampleRate, Math.round(audio.sampleRate * 0.1), Math.round(audio.sampleRate * 0.2));
    return { ...(preset ? { preset, tuning: loaded } : { factorySample: sample }), audio: output, ...stats,
      ...(sample ? {} : { writtenFirstNote: base, detectedFirstNote: pitch ? { midi: pitch.midi, note: dsp.midiName(pitch.midi) } : null }) };
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
tool('list_instruments', 'Discover what this installation can play: built-in voices, stock instrument plugins, preset and sample counts, effects, OGG support and Fathom bridge configuration.', {}, async () => {
  const [plugins, factoryPresets, zyn] = await Promise.allSettled([installedInstrumentIds(), listPresets(), listZynPresets()]);
  const worklet = process.env.LMMS_FATHOM_WORKLET;
  return {
    builtInVoices: [...Object.keys(tones), ...Object.keys(kit), 'sample', 'preset'],
    nativePlugins: (plugins.value ?? []).map(id => ({ id, family: instruments[id] })),
    pluginScan: plugins.status === 'fulfilled' ? pluginDirectory : { directory: pluginDirectory, error: plugins.reason.code },
    factoryPresets: factoryPresets.value ?? [],
    zynPresets: (zyn.value ?? []).length,
    presetScan: factoryPresets.status === 'fulfilled' ? presets : { directory: presets, error: factoryPresets.reason.code },
    samples: existsSync(samplesDirectory) ? { directory: samplesDirectory, tool: 'list_samples' } : { error: 'Sample directory not found. Set LMMS_SAMPLES.' },
    effects: Object.keys(effectTypes), oggOutput: await hasFfmpeg(),
    fathom: { configured: Boolean(worklet), workletFound: Boolean(worklet && existsSync(worklet)),
      models: ['fathom', 'vesper', 'halo'], tool: 'render_fathom_track' },
  };
});
edit('set_native_instrument', 'Load an installed stock LMMS instrument at its default settings. Keeps existing notes, mixer routing and track controls.', {
  trackName: z.string(), instrument: z.enum(Object.keys(instruments)),
}, async (doc, { trackName, instrument }) => {
  if (!(await installedInstrumentIds()).includes(instrument)) throw new Error('Instrument plugin was not found in LMMS_PLUGINS');
  const target = instrumentOf(doc, trackName);
  const [previous] = children(target, 'instrument');
  if (linked(previous)) throw new Error('Existing instrument has linked controls');
  if (previous) target.removeChild(previous);
  add(add(target, 'instrument', { name: instrument }), instrument);
});

// ---------- mixer, effects, automation ----------
function mixerOf(doc) {
  const [song] = children(doc.documentElement, 'song');
  const mixer = children(song, 'fxmixer')[0] ?? add(song, 'fxmixer');
  if (!children(mixer, 'fxchannel').length) add(mixer, 'fxchannel', { num: 0, name: 'Master', volume: 1, muted: 0, soloed: 0 });
  return mixer;
}
function busOf(doc, name) {
  const channels = children(mixerOf(doc), 'fxchannel');
  const found = channels.filter(channel => channel.getAttribute('name').toLowerCase() === name.toLowerCase());
  if (found.length !== 1) throw new Error(`Expected one mixer channel named "${name}". Channels: ${channels.map(channel => channel.getAttribute('name')).join(', ')}`);
  return found[0];
}
edit('route_mixer_bus', 'Create a mixer bus sending to Master and route named instrument tracks to it, for shared effects or group level.', {
  bus: z.string().min(1).max(80),
  tracks: z.array(z.string()).min(1), gain: z.number().min(0).max(2).default(1),
}, (doc, { bus, tracks: names, gain }) => {
  const targets = names.map(name => instrumentOf(doc, name));
  const mixer = mixerOf(doc);
  const channels = children(mixer, 'fxchannel');
  if (channels.some(channel => channel.getAttribute('name') === bus)) throw new Error('Mixer bus already exists');
  const number = Math.max(...channels.map(channel => Number(channel.getAttribute('num')))) + 1;
  const channel = add(mixer, 'fxchannel', { num: number, name: bus, volume: gain, muted: 0, soloed: 0 });
  add(channel, 'fxchain', { numofeffects: 0, enabled: 0 });
  add(channel, 'send', { channel: 0, amount: 1 });
  for (const target of targets) target.setAttribute('fxch', String(number));
});
edit('set_bus', 'Set the gain (0-2, 1 is unity) or mute of a mixer channel, including Master.', {
  bus: z.string().min(1).max(80), gain: z.number().min(0).max(2).optional(), mute: z.boolean().optional(),
}, (doc, { bus, gain, mute }) => {
  const channel = busOf(doc, bus);
  if (gain === undefined && mute === undefined) throw new Error('Provide gain or mute');
  if (gain !== undefined) channel.setAttribute('volume', String(gain));
  if (mute !== undefined) channel.setAttribute('muted', mute ? '1' : '0');
});
const effectTarget = { trackName: z.string().optional(), bus: z.string().min(1).max(80).optional().describe('Mixer channel name, for example "Master".') };
function chainOf(doc, { trackName, bus }, create) {
  if (Boolean(trackName) === Boolean(bus)) throw new Error('Name exactly one of trackName or bus');
  const owner = trackName ? instrumentOf(doc, trackName) : busOf(doc, bus);
  return children(owner, 'fxchain')[0] ?? (create ? add(owner, 'fxchain', { numofeffects: 0, enabled: 0 }) : null);
}
const pluginOf = effect => {
  const name = effect.getAttribute('name');
  if (name !== 'ladspaeffect') return Object.keys(effectTypes).find(key => effectTypes[key].native === name) ?? name;
  const plugin = children(children(effect, 'key')[0], 'attribute').find(attribute => attribute.getAttribute('name') === 'plugin')?.getAttribute('value');
  return Object.keys(effectTypes).find(key => effectTypes[key].ladspa?.[1] === plugin) ?? 'ladspa:' + plugin;
};
tool('list_effects', 'List the effects edit_effect can add, with every parameter, its range and default.', {}, async () => describeEffects());
tool('inspect_effects', 'Read the effect chain of an instrument track or mixer channel, including stored parameters.', { project: projectName, ...effectTarget },
  async ({ project, ...target }) => {
    const chain = chainOf(await load(project), target, false);
    return chain ? children(chain, 'effect').map((effect, index) => {
      const stored = effect.getAttribute('mcp-params');
      return { index, plugin: pluginOf(effect), enabled: effect.getAttribute('on') !== '0', wet: Number(effect.getAttribute('wet')),
        ...(stored ? { params: JSON.parse(stored) } : {}) };
    }) : [];
  });
function writeEffect(doc, effect, plugin, params, bpm) {
  const type = effectTypes[plugin];
  for (const node of elements(effect)) effect.removeChild(node);
  if (type.ladspa) {
    if (!existsSync(path.join(pluginDirectory, 'ladspa', type.ladspa[0] + '.dll')) && !existsSync(path.join(pluginDirectory, 'ladspa', type.ladspa[0] + '.so'))) {
      throw new Error(`${plugin} needs the LADSPA plugin ${type.ladspa[0]}, which this LMMS installation lacks`);
    }
    const ports = type.ports(params);
    const controls = add(effect, 'ladspacontrols', { ports: ports.length });
    ports.forEach((value, index) => add(controls, 'port0' + index, { data: value }));
    const key = add(effect, 'key');
    add(key, 'attribute', { name: 'file', value: type.ladspa[0] });
    add(key, 'attribute', { name: 'plugin', value: type.ladspa[1] });
  } else {
    if (type.control) add(effect, type.control, type.attributes(params, bpm));
    add(effect, 'key');
  }
  // LMMS stops an effect this many milliseconds after its input falls silent; echoes and reverbs need room to ring.
  effect.setAttribute('autoquit', String(type.tail));
  if (Object.keys(params).length) effect.setAttribute('mcp-params', JSON.stringify(params));
}
edit('edit_effect', 'Add, update or remove an effect on an instrument track or a mixer channel such as Master. Plugins: delay (tempo-synced, with feedback), reverb, compressor, limiter, amplifier, bassbooster, stereo, eq, crossovereq. See list_effects for parameters.', {
  ...effectTarget, operation: z.enum(['add', 'update', 'remove']),
  plugin: z.enum(Object.keys(effectTypes)).optional(), index: z.number().int().nonnegative().optional(),
  params: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
  enabled: z.boolean().optional(), wet: z.number().min(0).max(1).optional(),
}, (doc, { operation, plugin, index, params, enabled, wet, ...target }) => {
  const chain = chainOf(doc, target, true);
  const { bpm } = songInfo(doc);
  let effect;
  if (operation === 'add') {
    if (!plugin) throw new Error('Choose a plugin to add');
    effect = add(chain, 'effect', { name: effectTypes[plugin].ladspa ? 'ladspaeffect' : effectTypes[plugin].native, on: 1, wet: 1, autoquit: 1, gate: 0 });
    try { writeEffect(doc, effect, plugin, resolveParams(plugin, params), bpm); } catch (error) { chain.removeChild(effect); throw error; }
  } else {
    effect = children(chain, 'effect')[index];
    if (!effect) throw new Error('Provide an existing effect index');
    if (operation === 'update' && params) {
      const current = pluginOf(effect);
      if (!(current in effectTypes)) throw new Error('This effect was not created by edit_effect; only wet and enabled can change');
      const stored = effect.getAttribute('mcp-params');
      writeEffect(doc, effect, current, resolveParams(current, params, stored ? JSON.parse(stored) : {}), bpm);
    }
  }
  if (operation === 'remove') chain.removeChild(effect);
  else {
    if (enabled !== undefined) effect.setAttribute('on', enabled ? '1' : '0');
    if (wet !== undefined) effect.setAttribute('wet', String(wet));
  }
  const count = children(chain, 'effect').length;
  chain.setAttribute('numofeffects', String(count));
  if (operation === 'add' || !count) chain.setAttribute('enabled', count ? '1' : '0');
  return { effects: count };
});
const automatable = {
  volume: { key: 'vol', range: [0, 200] }, pan: { key: 'pan', range: [-100, 100] }, pitch: { key: 'pitch', range: [-2400, 2400] },
  cutoff: { key: 'fcut', range: [5, 14000], envelope: true }, resonance: { key: 'fres', range: [0.01, 10], envelope: true },
};
edit('automate_track', 'Write an editable automation clip for an instrument track control: volume, pan, pitch (cents), filter cutoff (Hz) or resonance. A control can carry several clips at different positions.', {
  trackName: z.string(), name: z.string().min(1),
  control: z.enum(Object.keys(automatable)), startTick: z.number().int().min(0),
  length: z.number().int().min(1), curve: z.enum(['step', 'linear', 'smooth']).default('linear'),
  points: z.array(z.object({ tick: z.number().int().min(0), value: z.number() })).min(2).max(4096),
}, (doc, { trackName, name, control, startTick, length, curve, points }) => {
  const instrument = instrumentOf(doc, trackName);
  const { key, range: [min, max], envelope } = automatable[control];
  const parent = envelope ? children(instrument, 'eldata')[0] : instrument;
  if (!parent) throw new Error('Track has no filter controls');
  if (points[0].tick !== 0 || points.some(({ tick, value }, index) =>
    tick >= length || value < min || value > max || (index > 0 && tick <= points[index - 1].tick))) {
    throw new Error(`Use ascending unique ticks starting at zero, below the clip length, with values from ${min} to ${max}`);
  }
  let [model] = children(parent, key);
  if (!model) {
    const used = new Set(Array.from(doc.getElementsByTagName('*')).map(node => Number(node.getAttribute('id'))));
    let id = 10000;
    while (used.has(id)) id++;
    parent.removeAttribute(key);
    model = add(parent, key, { id, value: points[0].value, scale_type: 'linear' });
  } else if (tracks(doc).some(t => children(t, 'automationpattern').some(clip =>
    children(clip, 'object').some(object => object.getAttribute('id') === model.getAttribute('id')) &&
    Number(clip.getAttribute('pos')) < startTick + length && startTick < Number(clip.getAttribute('pos')) + Number(clip.getAttribute('len'))))) {
    throw new Error('Another automation clip for this control overlaps that range');
  }
  if (control === 'cutoff' || control === 'resonance') {
    parent.setAttribute('fwet', '1');
    if (!parent.hasAttribute('ftype')) parent.setAttribute('ftype', '0');
  }
  const anchor = tracks(doc).find(isAnchor);
  const automation = add(container(doc), 'track', { type: 5, name, muted: 0, solo: 0 });
  const clip = add(automation, 'automationpattern', { name, pos: startTick, len: length, prog: { step: 0, linear: 1, smooth: 2 }[curve], tens: 1, mute: 0 });
  for (const point of points) add(clip, 'time', { pos: point.tick, value: point.value });
  add(clip, 'object', { id: model.getAttribute('id') });
  if (anchor) container(doc).appendChild(anchor);
});
tool('inspect_arrangement', 'Read tempo, metre, song length, master volume, mixer routes, track levels, instrument types and timeline clips.', {
  project: projectName,
}, async ({ project }) => {
  const doc = await load(project);
  const info = songInfo(doc);
  const [song] = children(doc.documentElement, 'song');
  const [mixer] = children(song, 'fxmixer');
  return {
    tempo: info.bpm, meter: info.meter, lengthBars: info.lengthBars, lengthSeconds: Number(info.lengthSeconds.toFixed(4)),
    masterVolume: Number(info.head?.getAttribute('mastervol') || 100),
    mixer: mixer ? children(mixer, 'fxchannel').map(bus => ({
      id: Number(bus.getAttribute('num')), name: bus.getAttribute('name'), gain: Number(bus.getAttribute('volume') || 1),
      effects: children(children(bus, 'fxchain')[0], 'effect').length,
      sends: children(bus, 'send').map(send => ({
        channel: Number(send.getAttribute('channel')), amount: Number(send.getAttribute('amount')),
      })),
    })) : [],
    tracks: tracks(doc).map(t => {
      const [instrument] = children(t, 'instrumenttrack');
      const number = key => instrument?.hasAttribute(key) ? Number(instrument.getAttribute(key)) : children(instrument, key).length ? 'automated' : undefined;
      return {
        name: t.getAttribute('name'), type: Number(t.getAttribute('type')),
        ...(trackRole(t) ? { role: trackRole(t) } : {}),
        ...(isAnchor(t) ? { role: 'length pin' } : {}),
        instrument: instrument ? children(instrument, 'instrument')[0]?.getAttribute('name') ?? null : null,
        mixerChannel: instrument ? Number(instrument.getAttribute('fxch')) : null,
        ...(instrument ? { volume: number('vol'), pan: number('pan'), muted: t.getAttribute('muted') === '1', solo: t.getAttribute('solo') === '1',
          effects: children(children(instrument, 'fxchain')[0], 'effect').length } : {}),
        clips: ['pattern', 'automationpattern', 'sampletco', 'bbtco'].flatMap(tag =>
          children(t, tag).map(clip => ({
            type: tag, name: clip.getAttribute('name'), tick: Number(clip.getAttribute('pos')),
            length: Number(clip.getAttribute('len')),
            ...(tag === 'sampletco' ? { source: clip.getAttribute('src'), muted: clip.getAttribute('muted') === '1' } : {}),
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
edit('set_project_tempo', 'Set a static tempo. Existing note and clip ticks stay fixed. Tempo-synced delays keep their old time until updated.', {
  bpm: z.number().min(45).max(240),
}, (doc, { bpm }) => {
  const [head] = children(doc.documentElement, 'head');
  if (!head || children(head, 'bpm').length) throw new Error('Expected a project with a static tempo');
  head.setAttribute('bpm', String(bpm));
});

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
edit('edit_clip', 'Move, duplicate, rename or remove an instrument pattern. Positions are absolute LMMS ticks.', {
  trackName: z.string(),
  tick: z.number().int().nonnegative(),
  operation: z.enum(['move', 'duplicate', 'rename', 'remove']),
  destinationTick: z.number().int().nonnegative().optional(), name: z.string().min(1).max(100).optional(),
}, (doc, { trackName, tick, operation, destinationTick, name }) => {
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
});
edit('edit_sample_clip', 'Place, move, duplicate, resize, mute, relink or remove a native sample clip. Positions and lengths use LMMS ticks.', {
  trackName: z.string().min(1).max(100),
  operation: z.enum(['place', 'move', 'duplicate', 'resize', 'mute', 'relink', 'remove']),
  tick: timelineTick, destinationTick: timelineTick.optional(), length: timelineTick.min(1).optional(),
  file: z.string().regex(/^[a-z0-9][a-z0-9 _-]{0,99}\.(wav|ogg|flac)$/i).optional(),
  muted: z.boolean().optional(),
}, async (doc, { trackName, operation, tick, destinationTick, length, file, muted }) => {
  if (trackName === anchorName) throw new Error(`"${anchorName}" is reserved for the song length pin`);
  if ((operation === 'move' || operation === 'duplicate') !== (destinationTick !== undefined) ||
      (operation === 'place' || operation === 'resize') !== (length !== undefined) ||
      (operation === 'place' || operation === 'relink') !== (file !== undefined) ||
      (operation === 'mute') !== (muted !== undefined)) {
    throw new Error('Supply destinationTick for move/duplicate, length for place/resize, file for place/relink, or muted for mute');
  }
  const matches = tracks(doc).filter(t => t.getAttribute('type') === '2' && t.getAttribute('name') === trackName);
  if (matches.length > 1 || (!matches.length && operation !== 'place')) throw new Error('Expected one matching sample track');
  let [target] = matches;
  const clips = children(target, 'sampletco');
  const at = position => clips.filter(clip => Number(clip.getAttribute('pos')) === position);
  const originals = at(tick);
  if (operation === 'place' ? originals.length : originals.length !== 1) {
    throw new Error(operation === 'place' ? 'Sample clip position is occupied' : 'Expected one sample clip at that tick');
  }
  if (destinationTick !== undefined && at(destinationTick).length) throw new Error('Destination tick is occupied');
  const [original] = originals;
  const start = destinationTick ?? tick;
  const span = length ?? Number(original?.getAttribute('len'));
  if (operation !== 'remove' && (!Number.isSafeInteger(span) || span < 1 || start + span > 2147483647)) {
    throw new Error('Sample clip exceeds the LMMS timeline or has an invalid length');
  }
  let source;
  if (file) {
    const filename = path.join(root, file);
    if (!(await lstat(filename)).isFile()) throw new Error('Expected a regular workspace audio file');
    source = filename.replaceAll('\\', '/');
  }
  if (!target) {
    target = add(container(doc), 'track', { type: 2, name: trackName, muted: 0, solo: 0 });
  }
  if (operation === 'remove') target.removeChild(original);
  if (operation === 'place') add(target, 'sampletco', { pos: tick, len: length, muted: 0, src: source });
  if (operation === 'move') original.setAttribute('pos', String(destinationTick));
  if (operation === 'duplicate') target.appendChild(original.cloneNode(true)).setAttribute('pos', String(destinationTick));
  if (operation === 'resize') original.setAttribute('len', String(length));
  if (operation === 'mute') original.setAttribute('muted', muted ? '1' : '0');
  if (operation === 'relink') {
    original.setAttribute('src', source);
    original.removeAttribute('data');
    original.removeAttribute('sample_rate');
  }
});
edit('set_track_role', 'Declare what an instrument track is for: drums, bass, harmony, lead, counter, texture or fx. Pass null to clear it.', {
  trackName: z.string(), role: z.enum(roleNames).nullable(),
}, (doc, { trackName, role }) => {
  const target = instrumentOf(doc, trackName).parentNode;
  if (role === null) target.removeAttribute('mcp-role');
  else target.setAttribute('mcp-role', role);
});

// ---------- feature modules ----------
// Every .mjs file in tools/ exports register(context) and adds its own tools and edits. See tools/README.md.
const toolContext = {
  tool, edit, edits, z, dsp, root, imagesKey, explain, moduleGuidance, postSave, exportChecks,
  schemas: { projectName, wavName, audioOut, workspaceWav, factorySample, folderName, pattern, track, note, volume, presetFile,
    loudnessTarget, ceilingTarget, tailMode, section, pngName },
  project: { load, save, parse, tracks, container, children, elements, add, songInfo, setAnchor, isAnchor, isControl, instrumentOf,
    findPattern, createSong, addTrack, addPattern, checkTrack, mixerOf, busOf, chainOf, writeEffect, loadPreset, roleNames, trackRole },
  render: { renderDoc, renderMix, forRender, isolate, pool, parallelRenders, writeAudio, hasFfmpeg, masterAudio, barFrames, measureWav },
  music: { expandPattern, parseChord, voiceChord, bassNote, chordQualities },
  sounds: { soundFacts, listPresets, listZynPresets, effectTypes },
  paths: { samples: samplesDirectory },
};
const toolModules = (await readdir(new URL('./tools/', import.meta.url)).catch(() => [])).filter(name => name.endsWith('.mjs') && !name.endsWith('.test.mjs')).sort();
for (const file of toolModules) await (await import(new URL('./tools/' + file, import.meta.url))).register(toolContext);
tool('apply_edits', 'Apply many edits to one project and save once. Use this for mixing passes and arrangement changes instead of one file per change. If any edit fails, nothing is written. Ops: ' + Object.keys(edits).join(', ') + '. Each edit takes the same arguments as the tool of that name, without project and output.', {
  project: projectName, output: projectName,
  overwrite: z.boolean().default(false).describe('Allow replacing an existing output, including the source project itself.'),
  edits: z.array(z.object({ op: z.enum(Object.keys(edits)), args: z.record(z.string(), z.any()).default({}) })).min(1).max(400),
  strict: strictChecks,
}, async ({ project, output, overwrite, edits: steps, strict }) => {
  const doc = await load(project);
  const results = [];
  for (const [index, { op, args }] of steps.entries()) {
    try {
      results.push({ op, ...((await edits[op].apply(doc, edits[op].schema.parse(args))) ?? {}) });
    } catch (error) {
      throw new Error(`Edit ${index + 1} of ${steps.length} (${op}) failed: ${explain(error)}. Nothing was written.`);
    }
  }
  const checks = await runChecks(postSave, doc, output, strict);
  return { ...(await save(doc, output, overwrite)), applied: results.length, results, ...checks };
});
tool('resolve_chords', 'Turn chord symbols into MIDI notes with smooth voice leading, to check harmony before writing patterns.', {
  progression: z.string().min(1).max(2000), octave: z.number().int().min(0).max(7).default(4),
  voicing: z.enum(['close', 'open', 'spread']).default('close'),
}, async ({ progression, octave, voicing }) => {
  let previous;
  return { qualities: chordQualities, chords: progression.trim().split(/[\s|]+/).filter(Boolean).map(token => {
    const chord = parseChord(token.split(':')[0]);
    previous = voiceChord(chord, { octave, voicing, previous });
    return { chord: chord.symbol, notes: previous, names: previous.map(dsp.midiName), bass: bassNote(chord), bassName: dsp.midiName(bassNote(chord)) };
  }) };
});

// ---------- game export ----------
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
tool('export_game_audio', 'Export a song for a game engine in one call: a seamless loop with the tail folded in, an optional separate intro, aligned intensity layers that sum to the mix, stingers cut from bar ranges, WAV and optionally OGG files, and a manifest with loop points, loudness and checksums.', {
  project: projectName, outputDirectory: folderName, name: folderName.describe('Base file name, for example "forest-theme".'),
  introBars: z.number().int().min(1).max(64).optional().describe('Split this many opening bars into a one-shot intro; the loop is the rest.'),
  layers: z.array(z.object({ name: folderName, tracks: z.array(z.string()).min(1) })).max(12).default([])
    .describe('Adaptive music layers, each a set of track names, for example rhythm, harmony and melody.'),
  stingers: z.array(z.object({ name: folderName, startBar: z.number().int().min(0), bars: z.number().min(0.25).max(16) })).max(16).default([]),
  targetLufs: loudnessTarget, ceilingDb: ceilingTarget,
  ogg: z.boolean().default(false).describe('Also write OGG Vorbis files (needs ffmpeg).'),
  strict: strictChecks,
}, async ({ project, outputDirectory, name, introBars, layers, stingers, targetLufs, ceilingDb, ogg, strict }) => {
  const doc = await load(project);
  const checks = await runChecks(exportChecks, doc, project, strict);
  const info = songInfo(doc);
  if (!info.staticTempo) throw new Error('Game export needs a static tempo');
  if (introBars !== undefined && introBars >= info.lengthBars) throw new Error('introBars must be shorter than the song');
  if (ogg && !(await hasFfmpeg())) throw new Error('OGG output needs ffmpeg. Install it or set LMMS_FFMPEG.');
  const all = tracks(doc);
  const audible = all.map((t, index) => ({ t, index })).filter(({ t }) => !isControl(t) && t.getAttribute('muted') !== '1');
  const layerSets = layers.map(layer => new Set(layer.tracks.map(trackName => {
    const found = audible.filter(({ t }) => t.getAttribute('name') === trackName);
    if (found.length !== 1) throw new Error(`Layer "${layer.name}": expected one unmuted track named "${trackName}"`);
    return found[0].index;
  })));
  for (const stinger of stingers) if (stinger.startBar + stinger.bars > info.lengthBars) throw new Error(`Stinger "${stinger.name}" runs past the end of the song`);
  const destination = path.join(root, outputDirectory);
  await mkdir(destination);
  try {
    const sampleRate = 48000, bar = barFrames(info, sampleRate);
    const songFrames = Math.round(info.lengthSeconds * sampleRate), introFrames = Math.round((introBars ?? 0) * info.secondsPerBar * sampleRate);
    const renders = await pool([null, ...layerSets], parallelRenders, set =>
      renderDoc(set ? isolate(doc, set) : forRender(doc), { loop: false, prepared: true }).then(wav => dsp.fitLength(dsp.decodeWav(wav), songFrames + bar)));
    const [full, ...layerAudio] = renders;
    const loopOf = audio => dsp.foldTail(dsp.slice(audio, introFrames, audio.frames), songFrames - introFrames);
    const loop = loopOf(full);
    const intro = introBars ? dsp.slice(full, 0, introFrames) : null;
    // One linear gain for every file keeps the intro, loop and layers consistent with each other.
    let gainDb = 0;
    const measured = dsp.loudness(loop).integratedLufs;
    if (targetLufs !== undefined) {
      if (measured === null) throw new Error('The loop is silent');
      gainDb = targetLufs - measured;
    }
    const ceiling = ceilingDb ?? (targetLufs !== undefined ? -1 : undefined);
    const parts = [loop, ...(intro ? [intro] : []), ...layerAudio.map(loopOf)];
    const notes = [];
    if (layers.length && ceiling !== undefined) {
      // Layers must sum to the mix, so nothing is limited: hold the gain back until every file fits under the ceiling.
      const headroom = ceiling - Math.max(...parts.map(part => dsp.db(dsp.samplePeak(part)) ?? -120));
      if (gainDb > headroom) { notes.push(`Loudness target not reached: gain held to ${headroom.toFixed(2)} dB so the layers stay unlimited and sum to the mix.`); gainDb = headroom; }
      if (targetLufs === undefined && headroom < 0) gainDb = headroom;
    }
    const gain = 10 ** (gainDb / 20);
    const files = [];
    const emit = async (file, audio, role, extra = {}, { limiter = false, wrap = false } = {}) => {
      dsp.applyGain(audio, gain);
      const limited = limiter && ceiling !== undefined ? dsp.limit(audio, ceiling, { wrap }) : null;
      const wav = dsp.encodeWav(audio);
      await writeFile(path.join(destination, file + '.wav'), wav, { flag: 'wx' });
      if (ogg) await writeAudio(path.join(destination, file + '.ogg'), wav);
      const report = dsp.analyze(audio);
      files.push({ file: file + '.wav', ...(ogg ? { ogg: file + '.ogg' } : {}), role, ...extra, frames: audio.frames,
        durationSeconds: report.durationSeconds, integratedLufs: report.integratedLufs, truePeakDbfs: report.truePeakDbfs,
        peakDbfs: report.peakDbfs, clippedSamples: report.clippedSamples,
        ...(limited?.limitedSamples ? { limiterMaxReductionDb: limited.maxReductionDb } : {}), sha256: sha256(wav) });
      return audio;
    };
    const solo = !layers.length;
    const finalLoop = await emit(`${name}-loop`, loop, 'loop', { loopStartFrame: 0, loopEndFrame: loop.frames, bars: info.lengthBars - (introBars ?? 0) }, { limiter: solo, wrap: true });
    if (intro) await emit(`${name}-intro`, intro, 'intro', { bars: introBars, next: `${name}-loop.wav` }, { limiter: solo });
    let residualDb;
    if (layers.length) {
      const sum = new Float32Array(loop.frames * 2);
      for (const [index, layer] of layers.entries()) {
        const audio = await emit(`${name}-layer-${layer.name}`, loopOf(layerAudio[index]), 'layer',
          { layer: layer.name, tracks: layer.tracks, loopStartFrame: 0, loopEndFrame: loop.frames });
        audio.channels.forEach((ch, c) => { for (let i = 0; i < ch.length; i++) sum[i * 2 + c] += ch[i]; });
      }
      const covered = new Set(layerSets.flatMap(set => [...set]));
      if (audible.every(({ index }) => covered.has(index))) {
        let error = 0, reference = 0;
        finalLoop.channels.forEach((ch, c) => { for (let i = 0; i < ch.length; i++) { error += (sum[i * 2 + c] - ch[i]) ** 2; reference += ch[i] ** 2; } });
        residualDb = reference > 0 && error > 0 ? Number((10 * Math.log10(error / reference)).toFixed(1)) : -120;
        if (residualDb > -30) notes.push('The layers do not sum closely to the mix. Effects on Master or shared buses react to the combined signal; keep such effects on individual tracks for layered music.');
      } else notes.push('Some unmuted tracks are in no layer, so the layers do not add up to the full mix.');
    }
    for (const stinger of stingers) {
      const start = Math.round(stinger.startBar * info.secondsPerBar * sampleRate);
      const end = Math.min(full.frames, start + Math.round((stinger.bars + 1) * info.secondsPerBar * sampleRate));
      const audio = dsp.fade(dsp.slice(full, start, end), 48, Math.min(end - start, Math.round(info.secondsPerBar * sampleRate)));
      await emit(`${name}-stinger-${stinger.name}`, audio, 'stinger', { startBar: stinger.startBar, bars: stinger.bars }, { limiter: true });
    }
    const manifest = { name, source: project, bpm: info.bpm, timeSignature: info.meter, bars: info.lengthBars, sampleRate, channels: 2,
      gainDb: Number(gainDb.toFixed(2)), ...(targetLufs !== undefined ? { targetLufs } : {}), ...(ceiling !== undefined ? { ceilingDb: ceiling } : {}),
      loop: { file: `${name}-loop.wav`, startFrame: 0, endFrame: loop.frames, seamless: true, tail: 'folded into the loop start' },
      ...(intro ? { intro: { file: `${name}-intro.wav`, frames: intro.frames, then: `${name}-loop.wav` } } : {}),
      ...(residualDb !== undefined ? { layersSumResidualDb: residualDb } : {}), files, ...(notes.length ? { notes } : {}) };
    await writeFile(path.join(destination, `${name}.manifest.json`), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    return { directory: outputDirectory, manifest: `${name}.manifest.json`, ...manifest, ...checks };
  } catch (error) {
    await rm(destination, { recursive: true, force: true }); // created by this call
    throw error;
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
  tool('live_parameters', 'Read native LMMS parameter names, model IDs, values and ranges from the open song. Refresh after replacing a project or plugin.', {
    ...token, target_type: z.enum(['song', 'track', 'instrument', 'mixer', 'effect']),
    target_index: index.optional(), container: z.enum(['song', 'bb']).optional(),
    effect_index: index.optional(), effect_target_type: z.enum(['track', 'mixer']).optional(),
  }, async args => {
    const { target_type: type, target_index: targetIndex,
      effect_index: effectIndex, effect_target_type: effectType, container } = args;
    if ((type === 'effect') !== (effectIndex !== undefined && effectType !== undefined) ||
        (type !== 'effect' && (effectIndex !== undefined || effectType !== undefined))) {
      throw new Error('Provide effect_index and effect_target_type only for an effect target');
    }
    const usesTrack = type === 'track' || type === 'instrument';
    if ((type !== 'song') !== (targetIndex !== undefined) ||
        (container && !usesTrack && effectType !== 'track')) {
      throw new Error('Provide target_index for a track, instrument, mixer or effect');
    }
    return bridgeCall('get_parameters', args);
  });
  tool('live_set_parameters', 'Set exposed native controls in the open LMMS project by model ID, in native units. Discover the controls with live_parameters first. The bridge validates the batch before applying it and returns the resulting values. Changes are unsaved.', {
    ...token,
    values: z.array(z.object({
      model_id: z.number().int().min(1).max(4294967295),
      value: z.union([z.number().min(-1e9).max(1e9), z.boolean()]),
    })).min(1).max(512),
  }, async args => {
    if (new Set(args.values.map(edit => edit.model_id)).size !== args.values.length) {
      throw new Error('Use each model ID only once in a parameter batch');
    }
    return bridgeCall('set_parameters', args);
  });
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
await server.connect(new StdioServerTransport());
