import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import midiPackage from '@tonejs/midi';
import { promisify } from 'node:util';
import { decodeWav, encodeWav, truePeak } from '../audio.mjs';

const run = promisify(execFile);
const rate = 48000;
const ceiling = 10 ** (-1.05 / 20); // PCM quantisation margin.
const maxWav = 8 * 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const frequency = midi => 440 * 2 ** ((midi - 69) / 12);
const gm = { kick:36, snare:38, clap:39, closedHat:42, openHat:46, rim:37,
  tom:45, crash:49, ride:51, sub808:35, hardstyle:36 };
const kitId = 'freepats-synth-percussion-20220718';
const source = 'https://freepats.zenvoid.org/Percussion/electric-percussion.html';
const pack = 'https://freepats.zenvoid.org/Percussion/SynthesizerPercussion/SynthesizerPercussion-H2-20220718.7z';
const sourceDigest = '7f86e2b3834af5695aac8bd83310df2bc9ff1c7fbc231d0320aa5ced97368bf3';
const selected = [
  ['kick','Kick04.wav','fe8bfae55a9838bfd71ab04685c8dcba7fda114bb85087acdb915641c39b390d'],
  ['snare','Snare09.wav','6d39ad1e54bb792a8bdfb47b98fffecc3d05d795e251116aaef310015ff82dca'],
  ['clap','Clap01.wav','5a469c1e1072b210426e14ca2b020f27f1f4ce459fe116b0af837e4413e47742'],
  ['closedHat','ClosedHiHat01-01.wav','4159b05c0d04a5da8c20eeeb5d465da44c9dc23de1807ea34404a8e2c7a162a4'],
  ['openHat','OpenHiHat02-01.wav','a5558181f324b8cab6a0900c4aaa127c3ddd766163230d3aaa494a0b5e82768c'],
  ['tom','LowTom02-01.wav','3a739daf27956f690e0aeb25e22257b96f5bda415cd31a6d27e679a9e0d49b4a'],
  ['crash','Cymbal01-01.wav','43cc3d70d265dd8bae22cf4d7802b04f912300c162cc3418e47cfe511daeee9a'],
];
const cc0 = selected.map(([role, file, sha256]) =>
  ({ role, file, sha256, midi: gm[role], licence: 'CC0-1.0', author: 'Roberto (FreePats)', source, archive: pack }));

function peakWav(audio) {
  const peak = truePeak(audio);
  if (!Number.isFinite(peak)) throw new Error('Invalid drum audio samples');
  const gain = peak > ceiling ? ceiling / peak : 1;
  const wav = encodeWav({ ...audio, channels: audio.channels.map(ch => ch.map(sample => sample * gain)) });
  const measured = truePeak(decodeWav(wav));
  return { wav, truePeakDb: measured ? Number((20 * Math.log10(measured)).toFixed(3)) : null };
}

export function synthesise({ role, midi, decayMs, click, drive, seed }) {
  const frames = Math.ceil(rate * decayMs / 1000);
  const channel = new Float32Array(frames);
  let state = seed >>> 0 || 1, phase = 0, lowNoise = 0;
  const f = frequency(midi);
  for (let i = 0; i < frames; i++) {
    const t = i / rate, progress = i / frames;
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const noise = (state >>> 0) / 2147483648 - 1;
    lowNoise += .27 * (noise - lowNoise);
    const high = noise - lowNoise;
    phase += 2 * Math.PI * f * (1 + (role === 'sub808' ? .65 : 2.5) * Math.exp(-t / (role === 'sub808' ? .055 : .016))) / rate;
    const tone = Math.sin(phase);
    const metallic = [3019, 4471, 5347, 6827, 7919].reduce((sum, hz) => sum + Math.sign(Math.sin(2 * Math.PI * hz * t)), 0) / 5;
    const attack = click * high * Math.exp(-t / .004);
    let value;
    switch (role) {
      case 'kick': case 'sub808': value = tone + attack; break;
      case 'hardstyle': value = Math.tanh(5 * tone) * .9 + attack + .5 * Math.sin(phase * 3) * Math.exp(-t / .013); break;
      case 'snare': value = .32 * tone * Math.exp(-t / .042) + .78 * high + attack; break;
      case 'clap': value = high * (.28 + .7 * [0, .011, .023].reduce((sum, start) =>
        sum + (t >= start ? Math.exp(-(t - start) / .006) : 0), 0)); break;
      case 'rim': value = .6 * Math.sin(phase * 5.1) + attack; break;
      case 'tom': value = .83 * tone + .19 * Math.sin(1.54 * phase) + attack; break;
      case 'ride': value = .6 * metallic + .24 * high + attack; break;
      case 'crash': value = .35 * metallic + .66 * high + attack; break;
      case 'closedHat': value = (.6 * high + .4 * metallic) * Math.exp(-t / .045) + attack; break;
      case 'openHat': value = .48 * high + .52 * metallic + attack; break;
    }
    const envelope = Math.exp(-4.5 * progress) * Math.min(1, i / 15, (frames - i - 1) / 100);
    channel[i] = (drive ? Math.tanh((1 + 8 * drive) * value) : value) * envelope;
  }
  return { sampleRate: rate, channels: [channel], frames };
}

function interpolate(ch, index) {
  const i = Math.floor(index), mix = index - i;
  return (ch[i] ?? 0) * (1 - mix) + (ch[i + 1] ?? 0) * mix;
}

async function workspaceAudio(root, file) {
  const full = path.resolve(root, file);
  const directory = await realpath(root);
  const resolved = await realpath(full);
  const relative = path.relative(directory, resolved);
  const stat = await lstat(full);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep) ||
      !stat.isFile() || stat.size > maxWav) throw new Error('Expected a regular workspace WAV of at most 8 MiB');
  const bytes = await readFile(full);
  const audio = decodeWav(bytes);
  if (audio.sampleRate < 8000 || audio.sampleRate > 192000 || audio.frames / audio.sampleRate > 10 ||
      audio.channels.some(ch => ch.some(sample => !Number.isFinite(sample) || Math.abs(sample) > 1))) {
    throw new Error('Expected finite WAV audio up to 10 seconds, at 8–192 kHz');
  }
  return { ...audio, sha256: sha(bytes) };
}

async function unpack(archive, member, { outer = false } = {}) {
  const command = outer && process.platform !== 'win32' ? 'bsdtar' : 'tar';
  try {
    return (await run(command, ['-xOf', archive, member], { encoding: 'buffer', maxBuffer: maxWav, windowsHide: true })).stdout;
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('The FreePats pack needs bsdtar (Windows includes it as tar.exe)');
    throw new Error('Could not extract a verified FreePats pack member: ' + member, { cause: err });
  }
}

export async function fetchFreePats(cache) {
  const directory = path.join(cache, kitId);
  const existing = await lstat(directory).catch(err => { if (err.code !== 'ENOENT') throw err; });
  if (existing) {
    if (!existing.isDirectory()) throw new Error('FreePats cache path must be a directory');
    for (const entry of cc0) {
      const verified = await workspaceAudio(directory, entry.file);
      if (verified.sha256 !== entry.sha256) throw new Error('Cached FreePats file differs: ' + entry.file);
    }
    return { directory, files: cc0, reused: true };
  }
  const response = await fetch(pack, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok || !response.body) throw new Error('FreePats download failed: ' + response.status);
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxWav) throw new Error('Unexpected FreePats archive size');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, size);
  if (sha(bytes) !== sourceDigest) throw new Error('FreePats archive hash changed; review licence and contents before use');
  const scratch = await mkdtemp(path.join(tmpdir(), 'lmms-freepats-'));
  const extracted = new Map();
  try {
    const outer = path.join(scratch, 'pack.7z'), inner = path.join(scratch, 'kit.tar.gz');
    await writeFile(outer, bytes);
    await writeFile(inner, await unpack(outer, 'SynthesizerPercussion-H2-20220718/SynthesizerPercussion-20220718.h2drumkit', { outer: true }));
    for (const entry of cc0) {
      const wav = await unpack(inner, 'FreePats_synthesizer_percussion_20220718/' + entry.file);
      if (sha(wav) !== entry.sha256) throw new Error('FreePats sample hash changed: ' + entry.file);
      decodeWav(wav);
      extracted.set(entry.file, wav);
    }
  } finally {
    for (const file of ['pack.7z', 'kit.tar.gz']) {
      await unlink(path.join(scratch, file)).catch(err => { if (err.code !== 'ENOENT') throw err; });
    }
    await rmdir(scratch);
  }
  await mkdir(cache, { recursive: true });
  await mkdir(directory);
  for (const [file, wav] of extracted) await writeFile(path.join(directory, file), wav, { flag: 'wx' });
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ kit: kitId, archiveSha256: sourceDigest, files: cc0 }, null, 2) + '\n', { flag: 'wx' });
  return { directory, files: cc0, reused: false };
}

export function register({ tool, z, schemas, root, project, moduleGuidance }) {
  const role = z.enum(Object.keys(gm));
  const midi = z.number().int().min(12).max(119).describe('MIDI note number, 12–119');
  const write = (file, bytes) => writeFile(path.join(root, file), bytes, { flag: 'wx' });
  tool('synth_drums', 'Render deterministic 48 kHz mono drum one-shots and an MIT provenance manifest.', {
    outputDirectory: schemas.folderName,
    hits: z.array(z.object({
      role, midi: midi.min(24).max(84).default(36),
      decayMs: z.number().min(20).max(5000).default(400).describe('Total hit length in milliseconds'),
      click: z.number().min(0).max(1).default(.3).describe('Transient mix, 0–1'),
      drive: z.number().min(0).max(1).default(0).describe('Saturation amount, 0–1'),
      seed: z.number().int().min(0).max(4294967295).default(1),
    })).min(1).max(16),
  }, async ({ outputDirectory, hits }) => {
    await mkdir(path.join(root, outputDirectory));
    const files = [];
    for (const [i, hit] of hits.entries()) {
      const { wav, truePeakDb } = peakWav(synthesise(hit));
      const file = outputDirectory + '/' + hit.role + '-' + (i + 1) + '.wav';
      await write(file, wav);
      files.push({ file, role: hit.role, rootMidi: hit.midi, midi: gm[hit.role], truePeakDb,
        sha256: sha(wav), licence: 'MIT', author: 'LMMS MCP drum synthesizer',
        source: 'https://github.com/SarutobiSasuke8/lmms-mcp', params: hit });
    }
    const manifest = outputDirectory + '/manifest.json';
    await write(manifest, JSON.stringify({ files }, null, 2) + '\n');
    return { directory: outputDirectory, files, manifest };
  });

  tool('fetch_kit', 'Download or reuse the hash-pinned FreePats CC0 one-shots in the user cache. No credentials.', {
    kit: z.literal(kitId).default(kitId),
  }, () => fetchFreePats(path.join(homedir(), '.cache', 'lmms-mcp', 'drum-kits')));

  tool('build_kit', 'Map workspace WAVs to GM drum notes. Save an LMMS trigger project and a Decent Sampler preset.', {
    output: schemas.projectName,
    samples: z.array(z.object({ role, file: schemas.workspaceWav, midi: midi.optional() })).min(1).max(16),
    bpm: z.number().min(45).max(240).default(120).describe('Audition project tempo, BPM'),
  }, async ({ output, samples, bpm }) => {
    const entries = samples.map(entry => ({ ...entry, midi: entry.midi ?? gm[entry.role] }));
    if (new Set(entries.map(entry => entry.midi)).size !== entries.length) throw new Error('Assign a different MIDI note to each sample');
    const files = [];
    for (const entry of entries) files.push({ ...entry, sha256: (await workspaceAudio(root, entry.file)).sha256 });
    const tracks = files.map((entry, i) => ({
      name: entry.role, voice: 'sample', sample: entry.file, rootMidi: entry.midi, role: 'drums', volume: 75, pan: 0,
      patterns: [{ name: entry.role, bars: 1, bar: Math.floor(i / 4), notes: [{ midi: entry.midi, tick: (i % 4) * 48, length: 36, velocity: 90 }] }],
    }));
    const document = project.createSong(bpm, tracks, 70);
    const preset = output.replace(/\.mmpz?$/i, '.dspreset');
    const manifest = output.replace(/\.mmpz?$/i, '.kit.json');
    const midiFile = output.replace(/\.mmpz?$/i, '.mid');
    const mid = new midiPackage.Midi();
    mid.header.setTempo(bpm);
    const percussion = mid.addTrack();
    percussion.channel = 9;
    for (const [i, entry] of files.entries()) {
      percussion.addNote({ midi: entry.midi, ticks: i * mid.header.ppq, durationTicks: Math.floor(mid.header.ppq * .75), velocity: .9 });
    }
    const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    const zones = files.map(({ file, midi: key }) =>
      '    <sample path="' + escape(file) + '" rootNote="' + key + '" loNote="' + key + '" hiNote="' + key + '" />').join('\n');
    for (const file of [output, preset, manifest, midiFile]) {
      const exists = await lstat(path.join(root, file)).catch(err => { if (err.code !== 'ENOENT') throw err; });
      if (exists) throw new Error('Output exists: ' + file);
    }
    await project.save(document, output);
    await write(preset, '<?xml version="1.0" encoding="UTF-8"?>\n<DecentSampler minVersion="1.0.0">\n  <groups><group>\n' + zones + '\n  </group></groups>\n</DecentSampler>\n');
    await write(manifest, JSON.stringify({ files }, null, 2) + '\n');
    await write(midiFile, mid.toArray());
    return { project: output, preset, midi: midiFile, manifest, files };
  });

  tool('layer_drum', 'Layer drum WAVs with millisecond offsets and gain; write a 48 kHz WAV with true peak below −1 dBTP.', {
    output: schemas.wavName,
    layers: z.array(z.object({ file: schemas.workspaceWav,
      offsetMs: z.number().min(0).max(2000).default(0).describe('Delay in milliseconds'),
      gainDb: z.number().min(-48).max(12).default(0).describe('Layer gain in dB'),
    })).min(2).max(8),
  }, async ({ output, layers }) => {
    const inputs = await Promise.all(layers.map(async layer => ({ ...layer, ...await workspaceAudio(root, layer.file),
      start: Math.round(layer.offsetMs * rate / 1000), gain: 10 ** (layer.gainDb / 20) })));
    const frames = Math.max(...inputs.map(instrument => instrument.start + Math.ceil(instrument.frames * rate / instrument.sampleRate)));
    const channels = Array.from({ length: Math.max(...inputs.map(i => i.channels.length)) }, () => new Float32Array(frames));
    for (const input of inputs) for (const [channel, data] of channels.entries()) {
      const samples = input.channels[channel] ?? input.channels[0];
      for (let i = input.start; i < input.start + Math.ceil(input.frames * rate / input.sampleRate); i++) {
        data[i] += input.gain * interpolate(samples, (i - input.start) * input.sampleRate / rate);
      }
    }
    const { wav, truePeakDb } = peakWav({ sampleRate: rate, channels, frames });
    await write(output, wav);
    return { file: output, truePeakDb, inputs: inputs.map(i => ({ file: i.file, sha256: i.sha256 })) };
  });

  tool('tune_drum', 'Retune a pitched workspace WAV by resampling; duration changes with pitch.', {
    input: schemas.workspaceWav, output: schemas.wavName, fromMidi: midi, toMidi: midi,
  }, async ({ input, output, fromMidi, toMidi }) => {
    if (Math.abs(toMidi - fromMidi) > 24) throw new Error('Retune by at most 24 semitones');
    const audio = await workspaceAudio(root, input);
    const ratio = 2 ** ((toMidi - fromMidi) / 12);
    const frames = Math.max(1, Math.floor(audio.frames / ratio));
    const channels = audio.channels.map(ch => Float32Array.from({ length: frames }, (_, i) => interpolate(ch, i * ratio)));
    const { wav, truePeakDb } = peakWav({ ...audio, frames, channels });
    await write(output, wav);
    return { file: output, truePeakDb, fromMidi, toMidi, inputSha256: audio.sha256 };
  });
  moduleGuidance.push('Use synth_drums for original MIT one-shots, fetch_kit for the pinned CC0 FreePats bank, and build_kit to map WAVs to GM notes.');
}
