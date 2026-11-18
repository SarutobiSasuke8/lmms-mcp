// Measurement-based checks for a persona demo render. Nothing here hears the audio: it reads levels, silences, onsets,
// spectral centroid and pitch-class energy from the WAV and compares them with what the persona's signature predicts.
import { analyze, decodeWav, loudness, truePeak, db } from '../../audio.mjs';

const mono = audio => {
  if (audio.channels.length === 1) return audio.channels[0];
  const out = new Float32Array(audio.frames), [l, r] = audio.channels;
  for (let i = 0; i < out.length; i++) out[i] = (l[i] + r[i]) / 2;
  return out;
};
const lin2db = v => v > 0 ? 20 * Math.log10(v) : -120;
const round = (v, n = 2) => v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(n));

// RMS in dBFS for each hop of `hopSeconds`.
export function rmsSeries(audio, hopSeconds = 0.1) {
  const signal = mono(audio), hop = Math.round(hopSeconds * audio.sampleRate), out = [];
  for (let start = 0; start + hop <= signal.length; start += hop) {
    let sum = 0;
    for (let i = start; i < start + hop; i++) sum += signal[i] * signal[i];
    out.push(lin2db(Math.sqrt(sum / hop)));
  }
  return { hopSeconds, values: out };
}
// Runs where the level stays under `thresholdDb` for at least `minSeconds`.
export function silentRuns(series, { thresholdDb = -60, minSeconds = 1 } = {}) {
  const runs = [];
  let from = null;
  const close = end => { if (from !== null && (end - from) * series.hopSeconds >= minSeconds) runs.push({ startSeconds: round(from * series.hopSeconds), seconds: round((end - from) * series.hopSeconds) }); from = null; };
  series.values.forEach((value, index) => { if (value < thresholdDb) { if (from === null) from = index; } else close(index); });
  close(series.values.length);
  return runs;
}
// Note onsets: a rise of at least `riseDb` in a 10 ms energy envelope, at least 50 ms apart.
export function onsets(audio, { riseDb = 5, floorDb = -70 } = {}) {
  const env = rmsSeries(audio, 0.01).values, times = [];
  let last = -10;
  for (let i = 4; i < env.length; i++) {
    const before = Math.max(env[i - 4], floorDb);
    if (env[i] > floorDb + 10 && env[i] - before >= riseDb && i - last >= 5) { times.push(i * 0.01); last = i; }
  }
  return times;
}
// How strongly the onset pattern repeats at one lag, from 0 to 1 (normalised autocorrelation of a 10 ms onset-strength curve).
export function periodicity(audio, startSeconds, endSeconds, lagSeconds) {
  const env = rmsSeries(audio, 0.01).values.map(v => Math.max(v, -70) + 70);
  const from = Math.floor(startSeconds * 100), to = Math.min(env.length, Math.floor(endSeconds * 100));
  const flux = [];
  for (let i = from + 1; i < to; i++) flux.push(Math.max(0, env[i] - env[i - 1]));
  const mean = flux.reduce((a, b) => a + b, 0) / (flux.length || 1), x = flux.map(v => v - mean);
  let den = 0;
  for (const v of x) den += v * v;
  // The lag is rarely a whole number of 10 ms steps, so take the better of the two neighbouring steps.
  const at = lag => { let num = 0; for (let i = 0; i + lag < x.length; i++) num += x[i] * x[i + lag]; return num; };
  const exact = lagSeconds * 100;
  return den > 0 ? round(Math.max(at(Math.floor(exact)), at(Math.ceil(exact))) / den, 3) : 0;
}
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = -2 * Math.PI / size, wr = Math.cos(angle), wi = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let cr = 1, ci = 0;
      for (let k = 0; k < size / 2; k++) {
        const a = start + k, b = a + size / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}
// Energy in each of the 12 pitch classes (C is 0) between 60 Hz and 2 kHz, from long frames so low notes resolve.
export function chroma(audio, startSeconds, endSeconds) {
  const signal = mono(audio), size = 16384, re = new Float64Array(size), im = new Float64Array(size), bins = new Float64Array(12);
  const start = Math.floor(startSeconds * audio.sampleRate), end = Math.min(signal.length, Math.floor(endSeconds * audio.sampleRate));
  for (let at = start; at + size <= end; at += size / 2) {
    for (let i = 0; i < size; i++) { re[i] = signal[at + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / size)); im[i] = 0; }
    fft(re, im);
    for (let k = 1; k < size / 2; k++) {
      const hz = k * audio.sampleRate / size;
      if (hz < 60 || hz > 2000) continue;
      const midi = 69 + 12 * Math.log2(hz / 440), pc = ((Math.round(midi) % 12) + 12) % 12;
      bins[pc] += re[k] * re[k] + im[k] * im[k];
    }
  }
  return Array.from(bins);
}
// Adjacent pitch classes both sounding within `withinDb` of the strongest one: a cluster index, not a judgement of taste.
export function clusterPairs(bins, withinDb = 15) {
  const top = Math.max(...bins);
  if (!(top > 0)) return 0;
  const on = bins.map(v => 10 * Math.log10(v / top + 1e-12) >= -withinDb);
  return bins.filter((_, i) => on[i] && on[(i + 1) % 12]).length;
}
export function centroidSeries(audio, windowSeconds = 2) {
  const out = [];
  for (let start = 0; start + windowSeconds <= audio.frames / audio.sampleRate; start += windowSeconds) {
    const part = analyze({ ...audio, frames: audio.frames, channels: audio.channels }, { sections: [{ name: 'w', startSeconds: start, endSeconds: start + windowSeconds }] }).sections[0];
    out.push({ startSeconds: start, centroidHz: part.centroidHz, rmsDbfs: part.rmsDbfs });
  }
  return out;
}

export function measureWav(wav, cue, { tailSeconds = 0 } = {}) {
  const audio = decodeWav(wav), spans = cue.sections.map(({ name, bar, bars }) => ({ name, startSeconds: bar * 240 / cue.bpm, endSeconds: Math.min(audio.frames / audio.sampleRate, (bar + bars) * 240 / cue.bpm) }));
  const report = analyze(audio, { sections: spans });
  const series = rmsSeries(audio, 0.1);
  const sections = Object.fromEntries(report.sections.map(s => [s.name, s]));
  const beat = 60 / cue.bpm;
  const stats = {
    durationSeconds: round(audio.frames / audio.sampleRate), integratedLufs: round(loudness(audio).integratedLufs), truePeakDbfs: db(truePeak(audio)), peakDbfs: report.peakDbfs,
    rmsDbfs: report.rmsDbfs, crestDb: report.crestDb, centroidHz: report.centroidHz, bandsDbfs: report.bandsDbfs, clippedSamples: report.clippedSamples, stereoCorrelation: report.stereoCorrelation ?? null,
    sections: report.sections.map(s => ({ name: s.name, startSeconds: round(s.startSeconds), endSeconds: round(s.endSeconds), integratedLufs: round(s.integratedLufs), rmsDbfs: s.rmsDbfs, peakDbfs: s.peakDbfs, centroidHz: s.centroidHz })),
    silentRuns: silentRuns(series, { thresholdDb: -60, minSeconds: 1 }),
  };
  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });
  const level = name => sections[name]?.integratedLufs;
  const at = name => [sections[name].startSeconds, sections[name].endSeconds];
  const onsetsIn = (name) => { const [a, b] = at(name); return Number((onsets(audio).filter(t => t >= a && t < b).length / (b - a)).toFixed(2)); };
  if (cue.persona === 'action-score') {
    const [a, b] = at('hit');
    stats.hitPeriodicity = Object.fromEntries([['sixteenth', beat / 4], ['beat', beat], ['twoBeats', beat * 2], ['bar', beat * 4]].map(([name, lag]) => [name, periodicity(audio, a, b, lag)]));
    stats.envelopeFluxDbPer10ms = { build: flux(audio, ...at('build')), hit: flux(audio, ...at('hit')) };
    check('ostinato: the onset pattern repeats strongly at a sixteenth, beat, two-beat or bar lag', Math.max(...Object.values(stats.hitPeriodicity)) >= 0.3, JSON.stringify(stats.hitPeriodicity));
    check('build: intro is quieter than build, and build is quieter than hit', level('intro') < level('build') && level('build') < level('hit'), `${level('intro')}, ${level('build')}, ${level('hit')} LUFS`);
    check('the strip bar thins the texture: at least 3 LU under the hit section', level('strip') < level('hit') - 3, `${level('strip')} against ${level('hit')} LUFS`);
  } else if (cue.persona === 'horror-suspense') {
    const [wa, wb] = at('withheld'), [ca, cb] = at('stalk');
    stats.stalkClusterPairs = clusterPairs(chroma(audio, ca + 3, cb));
    stats.dynamicSpreadLu = round(Math.max(...report.sections.map(s => s.integratedLufs).filter(Number.isFinite)) - Math.min(...report.sections.map(s => s.integratedLufs).filter(Number.isFinite)));
    stats.withheldRmsDbfs = round(rmsDb(audio, wa + 1, wb));
    stats.riserRmsDbfs = round(rmsDb(audio, ...at('riser')));
    check('space: at least one silence of 1 s or more', stats.silentRuns.length >= 1, JSON.stringify(stats.silentRuns));
    check('space: the withheld bars sit at least 20 dB under the riser, from 1 s after the cut', stats.withheldRmsDbfs < stats.riserRmsDbfs - 20, `${stats.withheldRmsDbfs} dBFS against ${stats.riserRmsDbfs} dBFS RMS`);
    check('dissonance: three or more adjacent pitch classes sound together in the stalk', stats.stalkClusterPairs >= 3, `${stats.stalkClusterPairs} adjacent pairs`);
    check('no pay-off: nothing after the riser is louder than the riser', Math.max(level('withheld'), level('tail')) < level('riser'), `riser ${level('riser')}, withheld ${level('withheld')}, tail ${level('tail')} LUFS`);
  } else if (cue.persona === 'epic-fantasy') {
    const [la, lb] = at('legato-answer'), [sa, sb] = at('staccato');
    const callTonic = chroma(audio, at('call-return')[0], at('call-return')[1]), lift = chroma(audio, at('mixolydian-lift')[0], at('mixolydian-lift')[1]);
    const root = cue.key.split(' ')[0], tonic = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].indexOf(root);
    const third = key => key[(tonic + 3) % 12] / key[(tonic + 4) % 12];
    stats.minorOverMajorThird = { dorianCall: round(third(callTonic), 3), mixolydianLift: round(third(lift), 3) };
    stats.envelopeFluxDbPer10ms = { legato: flux(audio, la, lb), staccato: flux(audio, sa, sb) };
    check('modal colour: the minor third dominates the dorian call and the major third dominates the mixolydian lift', stats.minorOverMajorThird.dorianCall > 1 && stats.minorOverMajorThird.mixolydianLift < 1, JSON.stringify(stats.minorOverMajorThird));
    check('lift: the mixolydian lift is louder than the opening call', level('mixolydian-lift') > level('call'), `${level('call')} to ${level('mixolydian-lift')} LUFS`);
  } else if (cue.persona === 'dark-synth-scifi') {
    const centroids = centroidSeries(audio, 2).filter(w => Number.isFinite(w.centroidHz));
    const hz = centroids.map(w => w.centroidHz);
    stats.centroidSweepHz = { min: Math.min(...hz), max: Math.max(...hz), ratio: round(Math.max(...hz) / Math.min(...hz)) };
    stats.onsetsPerSecond = { arpEntry: onsetsIn('arp-entry'), peak: onsetsIn('peak') };
    stats.droneQuietestWindowDbfs = round(Math.min(...centroids.map(w => w.rmsDbfs)));
    check('filter movement: the spectral centroid changes by at least 2 times across the cue', stats.centroidSweepHz.ratio >= 2, JSON.stringify(stats.centroidSweepHz));
    check('drone: no window falls below -50 dBFS RMS', stats.droneQuietestWindowDbfs > -50, `${stats.droneQuietestWindowDbfs} dBFS`);
    check('arp: the peak section has at least 4 onsets per second', stats.onsetsPerSecond.peak >= 4, JSON.stringify(stats.onsetsPerSecond));
    check('peak section is louder than the strip', level('peak') > level('strip'), `${level('peak')} against ${level('strip')} LUFS`);
  }
  return { ...stats, checks };
}
function rmsDb(audio, from, to) {
  const s = mono(audio), a = Math.floor(from * audio.sampleRate), b = Math.min(s.length, Math.floor(to * audio.sampleRate));
  let sum = 0;
  for (let i = a; i < b; i++) sum += s[i] * s[i];
  return lin2db(Math.sqrt(sum / Math.max(1, b - a)));
}
// Mean absolute change of the 10 ms level in dB: low for sustained sound, higher for short notes with gaps between them.
function flux(audio, from, to) {
  const env = rmsSeries(audio, 0.01).values.slice(Math.floor(from * 100), Math.floor(to * 100)).map(v => Math.max(v, -80));
  let sum = 0;
  for (let i = 1; i < env.length; i++) sum += Math.abs(env[i] - env[i - 1]);
  return round(sum / Math.max(1, env.length - 1), 3);
}

// How much of its peak a part still has late in each note: the level 80% of the way to the next onset, relative to the loudest
// 10 ms level in the first half of the gap (sampled strings can take 100 ms or more to speak), as a median in dB. Close to 0 for sustained notes, strongly negative for short ones that decay between hits.
export function retentionDb(wav, notes, bpm) {
  const audio = decodeWav(wav), env = rmsSeries(audio, 0.01).values, perTick = 240 / bpm / 192;
  const ticks = [...new Set(notes.map(note => note.tick))].sort((a, b) => a - b), values = [];
  for (let i = 0; i + 1 < ticks.length; i++) {
    const at = ticks[i] * perTick, gap = (ticks[i + 1] - ticks[i]) * perTick;
    if (gap < 0.12 || gap > 4) continue;
    const mean = (from, to) => { const slice = env.slice(Math.floor(from * 100), Math.max(Math.floor(from * 100) + 1, Math.floor(to * 100))); return slice.reduce((a, b) => a + b, 0) / slice.length; };
    const late = mean(at + gap * 0.8 - 0.03, at + gap * 0.8), early = Math.max(...env.slice(Math.floor(at * 100), Math.max(Math.floor(at * 100) + 1, Math.floor((at + gap * 0.5) * 100))));
    if (early > -60) values.push(late - early);
  }
  values.sort((a, b) => a - b);
  return values.length ? round(values[Math.floor(values.length / 2)], 2) : null;
}
// Articulation contrast on isolated stems: a sustained part should hold its level through a note, a short one should not.
// `stems` maps a part id to its WAV.
export function articulationContrast(cue, stems) {
  if (!cue.contrast) return null;
  const notesOf = id => cue.parts.find(part => part.id === id).notes;
  const retention = id => retentionDb(stems[id], notesOf(id), cue.bpm);
  const pairs = cue.contrast.map(({ legato, short }) => ({ legato, short, legatoRetentionDb: retention(legato), shortRetentionDb: retention(short) }));
  const checks = pairs.map(pair => ({ name: `articulation contrast: ${pair.short} decays at least 6 dB more than ${pair.legato} before the next onset`,
    pass: pair.legatoRetentionDb !== null && pair.shortRetentionDb !== null && pair.shortRetentionDb < pair.legatoRetentionDb - 6,
    detail: `${pair.legato} ${pair.legatoRetentionDb} dB against ${pair.short} ${pair.shortRetentionDb} dB` }));
  return { pairs, checks };
}
