// Mix balancing by measurement: auto_balance renders stems, sets track volumes from role targets and protects the master,
// and compare_to_reference measures how a render differs from a reference track.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as dsp from '../audio.mjs';

// ---------- targets and roles ----------

// Starting points from a 15-track, 90-second game theme measured over its loudest 8 bars.
// Drums are peak targets (they are transients); pitched parts are RMS targets (they are sustained).
export const defaultTargets = {
  kick: { measure: 'peak', db: -7 },
  snare: { measure: 'peak', db: -8.5 },
  clap: { measure: 'peak', db: -15 },
  hat: { measure: 'peak', db: -19 },
  crash: { measure: 'peak', db: -13 },
  tom: { measure: 'peak', db: -9 },
  perc: { measure: 'peak', db: -15 },
  drums: { measure: 'peak', db: -8 },
  bass: { measure: 'rms', db: -18 },
  lead: { measure: 'rms', db: -17 },
  counter: { measure: 'rms', db: -22 },
  harmony: { measure: 'rms', db: -22.5 },
  texture: { measure: 'rms', db: -26 },
  fx: { measure: 'rms', db: -24 },
};
export const drumKinds = ['kick', 'snare', 'clap', 'hat', 'crash', 'tom', 'perc'];
export const pitchedRoles = ['bass', 'harmony', 'lead', 'counter', 'texture'];

const kindPatterns = [
  ['kick', /kick|\bbd\b|bass ?drum/i],
  ['snare', /snare|\bsd\b|\brim/i],
  ['clap', /clap|snap/i],
  ['hat', /\bhats?\b|hi-?hat|\bhh\b|shaker|tamb/i],
  ['crash', /crash|cymbal|\bride\b|splash|china/i],
  ['tom', /\btoms?\b|\btom[_ -]?\d|floor ?tom/i],
  ['perc', /perc|conga|bongo|cowbell|clave|block|triangle/i],
];
const rolePatterns = [
  ['drums', /drum|beat|kit|groove|break/i],
  ['bass', /bass|\bsub\b|808/i],
  ['counter', /counter|second lead|lead ?2|answer|response|obbligato/i],
  ['lead', /lead|melody|tune|theme|solo|hook|motif/i],
  ['texture', /pad|texture|ambi|atmos|drone|noise|wash|\bbed\b/i],
  ['harmony', /chord|harm|keys|piano|organ|string|comp|arp|pluck|guitar|rhythm/i],
  ['fx', /\bfx\b|sfx|riser|sweep|impact|whoosh|swell|reverse/i],
];

// Which drum a track or sample name points at, or null.
export function drumKind(...names) {
  for (const name of names.filter(Boolean)) {
    for (const [kind, pattern] of kindPatterns) if (pattern.test(name)) return kind;
  }
  return null;
}

// Decide a track's role. Declared roles win; otherwise guess from the name, then the instrument, then the measured sound.
// `facts` is plain data: { name, declared, plugin, sample, centroidHz, lowShare, crestDb, activeShare }.
export function guessRole(facts) {
  const { name = '', declared, plugin, sample } = facts;
  const kindFromText = () => drumKind(name, sample && path.basename(sample));
  if (declared) {
    const kind = declared === 'drums' ? kindFromText() ?? spectrumKind(facts) : null;
    return { role: declared, kind, source: 'declared' };
  }
  const nameKind = drumKind(name);
  if (nameKind) return { role: 'drums', kind: nameKind, source: 'guess from name' };
  for (const [role, pattern] of rolePatterns) {
    if (pattern.test(name)) return { role, kind: role === 'drums' ? kindFromText() ?? spectrumKind(facts) : null, source: 'guess from name' };
  }
  if (plugin === 'kicker') return { role: 'drums', kind: 'kick', source: 'guess from instrument' };
  if (sample) {
    const lower = sample.toLowerCase().replaceAll('\\', '/');
    const sampleKind = drumKind(path.basename(lower));
    if (lower.includes('drums/') || sampleKind) return { role: 'drums', kind: sampleKind ?? spectrumKind(facts), source: 'guess from instrument' };
    if (lower.includes('basses/') || /bass/.test(path.basename(lower))) return { role: 'bass', kind: null, source: 'guess from instrument' };
  }
  return { ...spectrumRole(facts), source: 'guess from spectrum' };
}
function spectrumKind({ centroidHz }) {
  if (!centroidHz) return null;
  if (centroidHz < 250) return 'kick';
  if (centroidHz > 5000) return 'hat';
  return null;
}
function spectrumRole({ centroidHz = 1000, lowShare = 0, crestDb = 10, activeShare = 1 }) {
  const percussive = crestDb > 18;
  if (lowShare > 0.6 && centroidHz < 300) return percussive ? { role: 'drums', kind: 'kick' } : { role: 'bass', kind: null };
  if (percussive) return { role: 'drums', kind: spectrumKind({ centroidHz }) };
  if (crestDb < 11 && activeShare > 0.6) return { role: centroidHz > 2500 ? 'texture' : 'harmony', kind: null };
  return { role: centroidHz > 700 ? 'lead' : 'harmony', kind: null };
}

// The target for one track: a per-track override, else a per-kind or per-role override, else the defaults.
// Overrides are dB numbers in the measure of that role, or { measure, db } objects.
export function targetFor({ role, kind }, trackName, overrides = {}) {
  const key = role === 'drums' ? kind ?? 'drums' : role;
  const base = defaultTargets[key] ?? defaultTargets[role] ?? defaultTargets.harmony;
  const pick = value => typeof value === 'number' ? { measure: base.measure, db: value } : { measure: value.measure ?? base.measure, db: value.db };
  if (overrides.tracks?.[trackName] !== undefined) return { ...pick(overrides.tracks[trackName]), from: 'track override' };
  if (overrides.roles?.[key] !== undefined) return { ...pick(overrides.roles[key]), from: 'role override' };
  if (key !== role && overrides.roles?.[role] !== undefined) return { ...pick(overrides.roles[role]), from: 'role override' };
  return { ...base, from: 'default ' + key };
}

// ---------- gain maths ----------
const toGain = decibels => 10 ** (decibels / 20);
const toDb = gain => 20 * Math.log10(gain);
const round = (value, places = 2) => value === null || value === undefined ? value : Number(value.toFixed(places));

// LMMS track and master volumes are linear: 100 is unity, 200 is +6 dB.
export function gainFor(measuredDb, targetDb, volume, { max = 200 } = {}) {
  const wanted = targetDb - measuredDb;
  const ideal = volume * toGain(wanted);
  const newVolume = round(Math.min(max, Math.max(0.01, ideal)));
  const gainDb = toDb(newVolume / volume);
  return { wantedDb: round(wanted), gainDb: round(gainDb), newVolume, clamped: Math.abs(gainDb - wanted) > 0.05 };
}

// Scale automation point values by a linear factor, clamped to the control range. Returns the scaled values.
export function scaleAutomation(values, factor, { max = 200 } = {}) {
  return values.map(value => round(Math.min(max, Math.max(0, value * factor)), 3));
}

// Master volume that keeps a predicted peak at or under -headroomDb.
// protect: only lower when needed; fit: set exactly; keep: leave alone.
export function masterFor(predictedPeak, master, headroomDb, mode = 'protect', { max = 200 } = {}) {
  if (mode === 'keep' || !(predictedPeak > 0)) return { volume: master, changeDb: 0 };
  const ceiling = toGain(-headroomDb);
  if (mode === 'protect' && predictedPeak <= ceiling) return { volume: master, changeDb: 0 };
  const volume = round(Math.min(max, Math.max(0.01, master * ceiling / predictedPeak)));
  return { volume, changeDb: round(toDb(volume / master)) };
}

// ---------- block statistics ----------
const bandNames = Object.keys(dsp.bandEdges);

// Per-block peak, sum of squares and band power (linear) of one stem. Blocks are usually one bar long.
export function blockStats(audio, blockFrames, { bands: withBands = true } = {}) {
  const blocks = [];
  for (let start = 0; start < audio.frames; start += blockFrames) {
    const end = Math.min(audio.frames, start + blockFrames);
    let peak = 0, sumSq = 0;
    for (const ch of audio.channels) {
      for (let i = start; i < end; i++) { const v = ch[i]; sumSq += v * v; const a = Math.abs(v); if (a > peak) peak = a; }
    }
    const frames = (end - start) * audio.channels.length;
    let bands = null;
    if (withBands && sumSq / frames > 1e-9) {
      const { bandsDbfs } = dsp.spectrum(dsp.slice(audio, start, end));
      bands = bandNames.map(name => bandsDbfs[name] === null ? 0 : 10 ** (bandsDbfs[name] / 10));
    }
    blocks.push({ peak, sumSq, frames, bands });
  }
  return blocks;
}
// Peak and RMS (dBFS) over blocks [from, to).
export function windowLevels(blocks, from, to) {
  let peak = 0, sumSq = 0, frames = 0;
  for (const block of blocks.slice(from, to)) { peak = Math.max(peak, block.peak); sumSq += block.sumSq; frames += block.frames; }
  return { peakDbfs: peak > 0 ? round(toDb(peak)) : null, rmsDbfs: sumSq > 0 ? round(10 * Math.log10(sumSq / frames)) : null };
}
// Index of the loudest run of `length` blocks by energy.
export function loudestWindow(blocks, length) {
  const span = Math.max(1, Math.min(length, blocks.length));
  let best = 0, bestEnergy = -1;
  for (let start = 0; start + span <= blocks.length; start++) {
    let energy = 0;
    for (let i = start; i < start + span; i++) energy += blocks[i].sumSq;
    if (energy > bestEnergy) { bestEnergy = energy; best = start; }
  }
  return { start: best, length: span };
}

// Sum gain-scaled stems into one buffer. Stems must share length, rate and channel count (mono stems are spread to both sides).
export function sumStems(stems, gains, masterGain = 1) {
  const { sampleRate, frames } = stems[0];
  const channels = [new Float32Array(frames), new Float32Array(frames)];
  stems.forEach((stem, index) => {
    const gain = gains[index] * masterGain;
    if (!gain) return;
    for (let ch = 0; ch < 2; ch++) {
      const source = stem.channels[Math.min(ch, stem.channels.length - 1)], out = channels[ch];
      for (let i = 0; i < frames; i++) out[i] += source[i] * gain;
    }
  });
  return { sampleRate, frames, channels };
}
export function correlation(audio) {
  if (audio.channels.length < 2) return 1;
  const [left, right] = audio.channels;
  let lr = 0, ll = 0, rr = 0;
  for (let i = 0; i < left.length; i++) { lr += left[i] * right[i]; ll += left[i] * left[i]; rr += right[i] * right[i]; }
  return ll > 0 && rr > 0 ? round(lr / Math.sqrt(ll * rr)) : null;
}

// ---------- masking ----------
const bandLabels = { sub: '20 to 60 Hz', bass: '60 to 150 Hz', lowMid: '150 to 500 Hz', mid: '500 Hz to 2 kHz', highMid: '2 to 6 kHz', air: '6 to 20 kHz' };
const priority = { lead: 0, bass: 1, counter: 2, harmony: 3, texture: 4 };

// For each pair of pitched stems, find bars where both put most of their energy in the same band.
// `stems` are { track, role, gainDb, blocks } with blocks from blockStats. Returns findings with a suggested fix.
export function maskingReport(stems, { secondsPerBlock, minShare = 0.5, minBlocks = 2 } = {}) {
  const pitched = stems.filter(stem => pitchedRoles.includes(stem.role));
  const findings = [];
  const activeOf = stem => {
    const loudest = Math.max(...stem.blocks.map(block => block.sumSq / block.frames));
    return stem.blocks.map(block => block.bands && block.sumSq / block.frames > Math.max(1e-6, loudest / 1000));
  };
  const active = new Map(pitched.map(stem => [stem, activeOf(stem)]));
  for (let a = 0; a < pitched.length; a++) {
    for (let b = a + 1; b < pitched.length; b++) {
      const [one, two] = [pitched[a], pitched[b]];
      const shared = [], perBand = {};
      let both = 0;
      for (let i = 0; i < Math.min(one.blocks.length, two.blocks.length); i++) {
        if (!active.get(one)[i] || !active.get(two)[i]) continue;
        both++;
        const scaled = stem => stem.blocks[i].bands.map(power => power * toGain(stem.gainDb ?? 0) ** 2);
        const [p1, p2] = [scaled(one), scaled(two)];
        const d1 = p1.indexOf(Math.max(...p1)), d2 = p2.indexOf(Math.max(...p2));
        if (d1 !== d2) continue;
        shared.push(i);
        (perBand[d1] ??= []).push(10 * Math.log10(p1[d1] / p2[d1]));
      }
      if (shared.length < minBlocks || shared.length / Math.max(1, both) < minShare) continue;
      const [bandIndex, diffs] = Object.entries(perBand).sort((x, y) => y[1].length - x[1].length)[0];
      const band = bandNames[bandIndex];
      const levelDifferenceDb = round(diffs.reduce((sum, v) => sum + v, 0) / diffs.length, 1);
      const [keep, change] = (priority[one.role] ?? 5) <= (priority[two.role] ?? 5) ? [one, two] : [two, one];
      findings.push({
        tracks: [one.track, two.track], band, range: bandLabels[band], sharedBars: shared.length, ofBarsTogether: both,
        bars: [shared[0], shared[shared.length - 1] + 1], ...(secondsPerBlock ? { seconds: [round(shared[0] * secondsPerBlock, 1), round((shared[shared.length - 1] + 1) * secondsPerBlock, 1)] } : {}),
        levelDifferenceDb, suggestion: maskingFix(keep, change, band, Math.abs(levelDifferenceDb)),
      });
    }
  }
  return findings.sort((x, y) => y.sharedBars - x.sharedBars);
}
function maskingFix(keep, change, band, gapDb) {
  const low = band === 'sub' || band === 'bass';
  const move = low ? 'move it up an octave or cut its low end with an EQ' : band === 'air' || band === 'highMid' ? 'move it down an octave or darken its filter' : 'move it an octave away';
  const quieter = gapDb > 10 ? ` It is already ${round(gapDb, 0)} dB apart, so the quieter part is mostly buried.` : '';
  const shorten = ['harmony', 'texture'].includes(change.role) ? ', or shorten its notes so the gaps leave room' : '';
  return `${change.track} (${change.role}) and ${keep.track} (${keep.role}) both centre on ${bandLabels[band]}. Keep ${keep.track} clear: lower ${change.track} by 2 to 3 dB, ${move}${shorten}.${quieter}`;
}

// ---------- reference comparison ----------
// Each band relative to the file's own total, so a level difference does not swamp the balance.
export function relativeBands(bandsDbfs) {
  const total = Object.values(bandsDbfs).reduce((sum, v) => sum + (v === null ? 0 : 10 ** (v / 10)), 0);
  if (!total) return Object.fromEntries(bandNames.map(name => [name, null]));
  return Object.fromEntries(bandNames.map(name => [name, bandsDbfs[name] === null ? null : round(bandsDbfs[name] - 10 * Math.log10(total))]));
}
const bandAdvice = {
  sub: ['add weight under the bass: drop the bass an octave or raise the kick', 'high-pass the parts that are not bass or kick, or lower the bass'],
  bass: ['raise the bass or the kick', 'lower the bass, or high-pass pads and harmony'],
  lowMid: ['give the harmony and pads more body', 'it may sound muddy: lower pads and harmony, or move them up an octave'],
  mid: ['raise the lead or the harmony', 'lower pads and harmony so the lead has room'],
  highMid: ['brighten the lead or raise the hats', 'it may sound harsh: lower the hats or darken the lead'],
  air: ['raise the hats and cymbals, or open filter cutoffs', 'lower the hats and cymbals'],
};
// Compare two measurement summaries ({ integratedLufs, peakDbfs, rmsDbfs, crestDb, stereoCorrelation, centroidHz, bandsDbfs }).
// Differences are audio minus reference. Returns the differences and plain suggestions, largest first.
export function compareMeasurements(audio, reference, { label = '' } = {}) {
  const diff = (a, b) => a === null || a === undefined || b === null || b === undefined ? null : round(a - b);
  const crest = m => m.crestDb ?? (m.peakDbfs !== null && m.rmsDbfs !== null ? m.peakDbfs - m.rmsDbfs : null);
  const ours = relativeBands(audio.bandsDbfs), theirs = relativeBands(reference.bandsDbfs);
  const differences = {
    loudnessLu: diff(audio.integratedLufs, reference.integratedLufs),
    crestDb: diff(crest(audio), crest(reference)),
    stereoCorrelation: diff(audio.stereoCorrelation, reference.stereoCorrelation),
    centroidHz: diff(audio.centroidHz, reference.centroidHz),
    centroidRatio: audio.centroidHz && reference.centroidHz ? round(audio.centroidHz / reference.centroidHz) : null,
    bandsDb: Object.fromEntries(bandNames.map(name => [name, diff(ours[name], theirs[name])])),
  };
  const prefix = label ? `${label}: ` : '';
  const suggestions = [];
  for (const name of bandNames) {
    const d = differences.bandsDb[name];
    if (d === null || Math.abs(d) < 2) continue;
    suggestions.push({ size: Math.abs(d), text: `${prefix}${round(Math.abs(d), 1)} dB ${d < 0 ? 'less' : 'more'} energy in ${bandLabels[name]} than the reference: ${bandAdvice[name][d < 0 ? 0 : 1]}.` });
  }
  const { loudnessLu, crestDb, stereoCorrelation, centroidRatio } = differences;
  if (loudnessLu !== null && Math.abs(loudnessLu) >= 1) {
    suggestions.push({ size: Math.abs(loudnessLu), text: `${prefix}${round(Math.abs(loudnessLu), 1)} LU ${loudnessLu < 0 ? 'quieter' : 'louder'} than the reference: ${loudnessLu < 0 ? 'raise it with render_mix targetLufs' : 'lower the loudness target'}.` });
  }
  if (crestDb !== null && Math.abs(crestDb) >= 3) {
    suggestions.push({ size: Math.abs(crestDb) * 0.8, text: crestDb > 0 ?
      `${prefix}Crest factor is ${round(crestDb, 1)} dB higher than the reference: the peaks stand further out. Lower the loudest drums or compress the drum bus.` :
      `${prefix}Crest factor is ${round(-crestDb, 1)} dB lower than the reference: it is more squashed. Ease the limiter or compressor, or let the drums hit harder.` });
  }
  if (stereoCorrelation !== null && Math.abs(stereoCorrelation) >= 0.2) {
    suggestions.push({ size: Math.abs(stereoCorrelation) * 10, text: stereoCorrelation < 0 ?
      `${prefix}Left and right are less alike than in the reference (correlation ${round(stereoCorrelation, 2)} lower): it is wider and may thin out in mono. Narrow the widest parts.` :
      `${prefix}Left and right are more alike than in the reference: it is narrower. Pan the harmony and texture parts apart or add stereo width.` });
  }
  if (centroidRatio !== null && (centroidRatio >= 1.2 || centroidRatio <= 1 / 1.2)) {
    // The centroid summarises the band balance, so it ranks below the band findings it explains.
    suggestions.push({ size: Math.abs(Math.log2(centroidRatio)) * 4, text: centroidRatio < 1 ?
      `${prefix}The spectral centre is ${Math.round((1 - centroidRatio) * 100)}% lower than the reference: it sounds darker overall.` :
      `${prefix}The spectral centre is ${Math.round((centroidRatio - 1) * 100)}% higher than the reference: it sounds brighter overall.` });
  }
  return { differences, relativeBandsDb: { audio: ours, reference: theirs }, suggestions: suggestions.sort((a, b) => b.size - a.size).map(s => s.text) };
}

// ---------- registration ----------
export function register({ tool, z, schemas, project, render, moduleGuidance, root }) {
  moduleGuidance.push('Run auto_balance after the parts are written and before mastering: it renders stems, sets every track volume from its role target, keeps the master under the headroom and reports masking. Set track roles first so it does not have to guess.');
  moduleGuidance.push('Use compare_to_reference to measure how a render differs from a reference WAV in loudness, band balance, crest factor, width and brightness.');

  const target = z.union([z.number().min(-60).max(0), z.object({ measure: z.enum(['peak', 'rms']).optional(), db: z.number().min(-60).max(0) })]);
  tool('auto_balance', 'Balance a mix by measurement in one call. Renders one stem per audio track, measures each over the loudest stretch of the song (or measureBars), decides each track\'s role (declared mcp-role, else a reported guess), sets track volumes so drums hit peak targets and pitched parts hit RMS targets, predicts the summed mix and lowers the master if the predicted peak would break the headroom. Scales volume automation instead of failing. Returns a per-track table, the predicted mix peak and loudness, a masking report and mono warnings. Targets are starting points, stated as stem levels at master volume 100; override them per role, drum kind or track.', {
    project: schemas.projectName,
    output: schemas.projectName.optional().describe('Where to write the balanced project. Required unless dryRun.'),
    overwrite: z.boolean().default(false),
    dryRun: z.boolean().default(false).describe('Measure and plan without writing a project.'),
    measureBars: z.object({ startBar: z.number().int().min(0), bars: z.number().int().min(1) }).optional()
      .describe('Bars to measure (zero-based). Default: the loudest 8 bars of the mix.'),
    targets: z.object({
      roles: z.record(z.string(), target).optional().describe('By role (bass, lead, counter, harmony, texture, fx, drums) or drum kind (kick, snare, clap, hat, crash, tom, perc). Numbers use the role\'s own measure.'),
      tracks: z.record(z.string(), target).optional().describe('By track name.'),
    }).optional(),
    headroomDb: z.number().min(0).max(12).default(2).describe('Keep the predicted mix peak this far under full scale.'),
    master: z.enum(['protect', 'fit', 'keep']).default('protect').describe('protect: lower the master only when the predicted peak breaks the headroom (default). fit: set the master so the peak lands exactly on the headroom. keep: never touch it.'),
  }, async ({ project: name, output, overwrite, dryRun, measureBars, targets = {}, headroomDb, master: masterMode }) => {
    if (!dryRun && !output) throw new Error('Pass output, or set dryRun');
    const doc = await project.load(name);
    const info = project.songInfo(doc);
    const all = project.tracks(doc);
    const wanted = all.map((t, index) => ({ t, index })).filter(({ t }) => !project.isControl(t) && t.getAttribute('muted') !== '1');
    if (!wanted.length) throw new Error('No unmuted audio tracks to balance');
    const frames = Math.round(info.lengthSeconds * 48000);
    if (!frames) throw new Error('The song is empty');
    const stems = await render.pool(wanted, render.parallelRenders, async ({ index }) =>
      dsp.fitLength(dsp.decodeWav(await render.renderDoc(render.isolate(doc, new Set([index])), { loop: true, prepared: true })), frames));
    const blockFrames = Math.max(1, Math.round(info.secondsPerBar * stems[0].sampleRate));
    const blocks = stems.map(stem => blockStats(stem, blockFrames));
    const before = sumStems(stems, stems.map(() => 1));
    const mixBlocks = blockStats(before, blockFrames, { bands: false });

    let window;
    if (measureBars) {
      if (measureBars.startBar + measureBars.bars > mixBlocks.length) throw new Error(`measureBars runs past the end of the song (${mixBlocks.length} bars)`);
      window = { start: measureBars.startBar, length: measureBars.bars, chosen: 'given' };
    } else window = { ...loudestWindow(mixBlocks, 8), chosen: 'loudest stretch of the mix' };

    const notes = [];
    const { head } = info;
    const mixer = project.children(project.children(doc.documentElement, 'song')[0], 'fxmixer')[0];
    const busEffects = new Map(project.children(mixer, 'fxchannel').map(channel => [channel.getAttribute('num'),
      { name: channel.getAttribute('name'), effects: project.children(project.children(channel, 'fxchain')[0], 'effect').length }]));

    const rows = wanted.map(({ t }, i) => {
      const trackName = t.getAttribute('name');
      const type = t.getAttribute('type');
      const instrumentTrack = project.children(t, 'instrumenttrack')[0];
      const instrument = project.children(instrumentTrack, 'instrument')[0];
      const plugin = instrument?.getAttribute('name');
      const sample = type === '2' ? project.children(t, 'sampletco').map(clip => clip.getAttribute('src')).find(Boolean) :
        project.children(instrument, 'audiofileprocessor')[0]?.getAttribute('src');
      const whole = dsp.spectrum(stems[i]);
      const powers = Object.values(whole.bandsDbfs).map(v => v === null ? 0 : 10 ** (v / 10));
      const total = powers.reduce((a, b) => a + b, 0);
      const activeBlocks = blocks[i].filter(block => block.sumSq / block.frames > 1e-7);
      const level = windowLevels(blocks[i], 0, blocks[i].length);
      const activeRms = activeBlocks.length ? 10 * Math.log10(activeBlocks.reduce((s, b) => s + b.sumSq, 0) / activeBlocks.reduce((s, b) => s + b.frames, 0)) : null;
      const decision = guessRole({
        name: trackName, declared: project.trackRole(t), plugin, sample, centroidHz: whole.centroidHz,
        lowShare: total ? (powers[0] + powers[1]) / total : 0, crestDb: level.peakDbfs !== null && activeRms !== null ? level.peakDbfs - activeRms : 10,
        activeShare: activeBlocks.length / blocks[i].length,
      });
      const goal = targetFor(decision, trackName, targets);
      let span = { start: window.start, length: window.length }, measuredOver = 'window';
      let measured = windowLevels(blocks[i], span.start, span.start + span.length);
      if (measured.rmsDbfs === null || measured.rmsDbfs < -80) {
        span = loudestWindow(blocks[i], window.length);
        measured = windowLevels(blocks[i], span.start, span.start + span.length);
        measuredOver = 'own loudest bars (silent in the window)';
      }
      // Volume control: instrument tracks and sample tracks have one; Beat/Bassline tracks do not.
      const holder = type === '0' ? instrumentTrack : type === '2' ? project.children(t, 'sampletrack')[0] : null;
      const model = holder && project.children(holder, 'vol')[0];
      const volume = holder ? Number(model ? model.getAttribute('value') : holder.getAttribute('vol') ?? 100) : null;
      const bus = instrumentTrack?.getAttribute('fxch');
      const row = { track: trackName, role: decision.role, ...(decision.kind ? { kind: decision.kind } : {}), roleSource: decision.source,
        measure: goal.measure, targetDb: goal.db, targetFrom: goal.from, measuredDb: measured[goal.measure === 'peak' ? 'peakDbfs' : 'rmsDbfs'],
        measuredOver: measuredOver === 'window' ? `bars ${span.start}-${span.start + span.length}` : measuredOver,
        stereoCorrelation: correlation(stems[i]), volumeBefore: volume };
      if (bus && bus !== '0' && busEffects.get(bus)?.effects) row.note = `Routed to mixer bus "${busEffects.get(bus).name}" with effects; the prediction assumes they are linear.`;
      return { row, holder, model, i, t };
    });

    // Targets are stem levels at master volume 100, so the track balance does not depend on where the master sits
    // and a second pass over a balanced project asks for nothing. The master then moves the whole mix.
    const masterModel = project.children(head, 'mastervol')[0];
    const masterBefore = Number(masterModel ? masterModel.getAttribute('value') : head.getAttribute('mastervol') ?? 100);
    if (!(masterBefore > 0)) throw new Error('Master volume is 0; raise it first');
    const masterOffsetDb = toDb(masterBefore / 100);
    const gains = rows.map(({ row: r, holder, model }) => {
      if (r.measuredDb === null) { r.skipped = 'silent'; return 1; }
      if (!holder) { r.skipped = 'Beat/Bassline tracks have no volume control; balance the tracks inside it'; return 1; }
      if (!(r.volumeBefore > 0)) { r.skipped = 'volume is 0; raise it first'; return 1; }
      const plan = gainFor(r.measuredDb - masterOffsetDb, r.targetDb, r.volumeBefore);
      r.gainDb = plan.gainDb;
      r.volumeAfter = plan.newVolume;
      if (plan.clamped) r.warning = `Needs ${plan.wantedDb} dB but track volume is limited to 0-200; ${round(plan.wantedDb - plan.gainDb, 1)} dB short. Raise the instrument or preset level.`;
      r.automated = Boolean(model);
      return plan.newVolume / r.volumeBefore;
    });

    const unprotected = sumStems(stems, gains);
    const masterPlan = masterFor(dsp.samplePeak(unprotected), masterBefore, headroomDb, masterMode);
    const masterGain = masterPlan.volume / masterBefore;
    const after = masterGain === 1 ? unprotected : sumStems(stems, gains, masterGain);
    rows.forEach(({ row }, k) => { if (row.measuredDb !== null) row.predictedDb = round(row.measuredDb + toDb(gains[k]) + masterPlan.changeDb); });

    const summary = audio => {
      const peak = dsp.samplePeak(audio);
      return { peakDbfs: peak > 0 ? round(toDb(peak)) : null, truePeakDbfs: dsp.db(dsp.truePeak(audio)), integratedLufs: dsp.loudness(audio).integratedLufs,
        windowRmsDbfs: windowLevels(blockStats(audio, blockFrames, { bands: false }), window.start, window.start + window.length).rmsDbfs };
    };
    const predicted = { before: summary(before), after: summary(after) };
    if (predicted.after.peakDbfs !== null && predicted.after.peakDbfs > -headroomDb + 0.01) {
      notes.push(`Predicted peak ${predicted.after.peakDbfs} dBFS is above -${headroomDb} dBFS${masterMode === 'keep' ? ' and master was kept' : ' because the master volume is at its limit'}.`);
    }

    const masking = maskingReport(rows.map(({ row }, i) => ({ track: row.track, role: row.role, gainDb: toDb(gains[i]), blocks: blocks[rows[i].i] })),
      { secondsPerBlock: info.secondsPerBar });
    const mono = rows.filter(({ row }) => row.stereoCorrelation !== null && row.stereoCorrelation < 0.2 && row.measuredDb !== null)
      .map(({ row }) => `${row.track}: left and right are weakly correlated (${row.stereoCorrelation}); it will thin out in mono. Narrow its stereo effect or chorus.`);
    const guessed = rows.filter(({ row }) => row.roleSource !== 'declared').map(({ row }) => row.track);
    if (guessed.length) notes.push(`Roles were guessed for ${guessed.join(', ')}. Check them and set them with set_track_role.`);
    const stemOffsetDb = round(toDb(masterPlan.volume / 100));
    if (masterPlan.changeDb) notes.push(`Master moved ${masterPlan.changeDb} dB to ${masterPlan.volume}.`);
    if (stemOffsetDb) notes.push(`Targets are levels at master volume 100. At master ${masterPlan.volume} every stem renders ${stemOffsetDb} dB from its target (see predictedDb); the balance between tracks is what matters.`);

    // Write everything in one save.
    const changes = [];
    if (!dryRun) {
      const scaleModel = (model, factor, label) => {
        const id = model.getAttribute('id');
        model.setAttribute('value', String(scaleAutomation([Number(model.getAttribute('value'))], factor)[0]));
        let points = 0;
        for (const t of all) {
          for (const clip of project.children(t, 'automationpattern')) {
            if (!project.children(clip, 'object').some(object => object.getAttribute('id') === id)) continue;
            const times = project.children(clip, 'time');
            scaleAutomation(times.map(point => Number(point.getAttribute('value'))), factor).forEach((value, k) => times[k].setAttribute('value', String(value)));
            points += times.length;
          }
        }
        changes.push(`${label}: scaled ${points} automation points by ${round(toDb(factor))} dB`);
      };
      rows.forEach(({ row, holder, model }, k) => {
        if (row.volumeAfter === undefined || gains[k] === 1) return;
        if (model) scaleModel(model, gains[k], row.track);
        else holder.setAttribute('vol', String(row.volumeAfter));
      });
      if (masterGain !== 1) {
        if (masterModel) scaleModel(masterModel, masterGain, 'Master');
        else head.setAttribute('mastervol', String(masterPlan.volume));
      }
      await project.save(doc, output, overwrite);
    }
    return {
      ...(dryRun ? { dryRun: true } : { project: output }),
      window: { startBar: window.start, bars: window.length, chosen: window.chosen,
        seconds: [round(window.start * info.secondsPerBar, 2), round((window.start + window.length) * info.secondsPerBar, 2)] },
      headroomDb, master: { before: masterBefore, after: masterPlan.volume, changeDb: masterPlan.changeDb, stemOffsetDb },
      tracks: rows.map(({ row }) => row), predictedMix: predicted, masking, mono,
      ...(changes.length ? { automation: changes } : {}), notes,
    };
  });

  const span = z.object({ name: z.string().min(1).max(60), startSeconds: z.number().min(0), endSeconds: z.number().min(0),
    referenceStartSeconds: z.number().min(0).optional(), referenceEndSeconds: z.number().min(0).optional() });
  tool('compare_to_reference', 'Measure how a render differs from a reference track: integrated loudness, band balance (each band relative to the file\'s own total, so overall level does not swamp it), crest factor, stereo correlation and spectral centroid, with the largest differences turned into plain suggestions. Optional sections compare matching passages; reference times default to the same as the audio.', {
    audio: schemas.workspaceWav, reference: schemas.workspaceWav, sections: z.array(span).max(32).default([]),
  }, async ({ audio: file, reference: referenceFile, sections }) => {
    const [ours, theirs] = await Promise.all([file, referenceFile].map(async name => dsp.decodeWav(await readFile(path.join(root, name)))));
    for (const s of sections) {
      if (s.endSeconds <= s.startSeconds) throw new Error(`Section "${s.name}" must end after it starts`);
      if ((s.referenceEndSeconds ?? s.endSeconds) <= (s.referenceStartSeconds ?? s.startSeconds)) throw new Error(`Section "${s.name}" reference span must end after it starts`);
    }
    const a = dsp.analyze(ours, { sections: sections.map(({ name, startSeconds, endSeconds }) => ({ name, startSeconds, endSeconds })) });
    const b = dsp.analyze(theirs, { sections: sections.map(s => ({ name: s.name, startSeconds: s.referenceStartSeconds ?? s.startSeconds, endSeconds: s.referenceEndSeconds ?? s.endSeconds })) });
    const keep = m => ({ integratedLufs: m.integratedLufs, peakDbfs: m.peakDbfs, rmsDbfs: m.rmsDbfs, crestDb: m.crestDb ?? (m.peakDbfs !== null && m.rmsDbfs !== null ? round(m.peakDbfs - m.rmsDbfs) : null),
      stereoCorrelation: m.stereoCorrelation ?? null, centroidHz: m.centroidHz, bandsDbfs: m.bandsDbfs });
    const whole = compareMeasurements(keep(a), keep(b));
    return {
      audio: { file, ...keep(a) }, reference: { file: referenceFile, ...keep(b) },
      differences: whole.differences, relativeBandsDb: whole.relativeBandsDb, suggestions: whole.suggestions,
      sections: a.sections.map((section, i) => {
        const result = compareMeasurements(keep(section), keep(b.sections[i]), { label: section.name });
        return { name: section.name, differences: result.differences, suggestions: result.suggestions };
      }),
    };
  });
}
