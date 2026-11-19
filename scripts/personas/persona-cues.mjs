// Reference cues for the four film personas. A cue is plain data built from a persona file and a seed, with no LMMS needed:
// parts with notes (ticks, 192 per bar), a native stock-voice sound for each part, and the sampled library file and articulation
// a part would use through Decent Sampler. Everything is deterministic for a given persona and seed.
import { rng } from '../../tools/melody.mjs';
import { parseKey } from '../../tools/motif.mjs';
import { getPersona } from '../../tools/personas.mjs';

const BAR = 192, BEAT = 48, STEP = 12;
const mod = (a, n) => ((a % n) + n) % n;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const romans = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii'];
const degreeOf = roman => romans.indexOf(roman.replace(/[^ivIV]/g, '').toLowerCase());
// Scale degree (0 is the tonic, 7 the tonic an octave up) to a MIDI note in an octave, where octave 4 holds middle C.
const pitchOf = (key, degree, octave) => 12 * (octave + 1) + key.tonic + key.scale[mod(degree, 7)] + 12 * Math.floor(degree / 7);
const at = (bar, step = 0) => bar * BAR + step * STEP;

// Written range of each sampled file (lowest and highest key it maps), so a note is folded into it by octaves rather than left silent.
const ranges = {
  'CelloEnsSpic': [36, 77], 'ContrabassSpic': [24, 60], 'ContrabassSusVB': [24, 60], 'ViolinEnsSusVib': [55, 86], 'ViolinEnsSpic': [55, 86],
  'ViolinEnsTrem': [55, 86], 'ViolaEnsTrem': [48, 86], 'TrumpetStac': [52, 84], 'TubaStac': [29, 62], 'Timpani': [36, 60],
  'SViolinTrem': [55, 96], 'SViolinPizz': [55, 96], 'FHornSus': [33, 77], 'Harp': [28, 101], 'FluteStac': [65, 96], 'ClarinetStac': [50, 89],
};
const rangeOf = sampled => ranges[sampled?.sfz.split('/').pop().replace(/\.sfz$/, '')];

function makePart(id, role, native, sampled) {
  const notes = [], range = rangeOf(sampled);
  if (sampled && !range) throw new Error(`No key range recorded for ${sampled.sfz}`);
  const part = { id, role, native, ...(sampled ? { sampled } : {}), notes };
  const fold = midi => {
    if (!range) return midi;
    while (midi > range[1]) midi -= 12;
    while (midi < range[0]) midi += 12;
    return midi;
  };
  part.add = (tick, length, midi, velocity = 90) => {
    const note = { tick: Math.round(tick), length: Math.max(1, Math.round(length)), midi: clamp(fold(Math.round(midi)), 12, 119), velocity: clamp(Math.round(velocity), 1, 127) };
    notes.push(note);
    return part;
  };
  return part;
}
const finish = parts => parts.filter(part => part.notes.length).map(({ add, ...part }) => ({ ...part, notes: part.notes.sort((a, b) => a.tick - b.tick || a.midi - b.midi) }));
const lerp = (from, to, t) => from + (to - from) * clamp(t, 0, 1);
// A phrase-by-phrase progression: each four-bar phrase takes one of the persona's progressions.
function chordsFor(persona, bars, random) {
  const lists = persona.harmony.progressions, out = [];
  for (let bar = 0; bar < bars; bar += 4) {
    const progression = lists[Math.floor(random() * lists.length)];
    for (let i = 0; i < 4 && bar + i < bars; i++) out.push(progression[i % progression.length]);
  }
  return out;
}
const triad = (key, roman, octave) => { const d = degreeOf(roman); return [0, 2, 4].map(i => pitchOf(key, d + i, octave)); };

function action(persona, ctx) {
  const { key, bars, random, chords } = ctx;
  const root = bar => degreeOf(chords[bar % chords.length]);
  const stripBar = bars - 8;
  const section = bar => bar < 4 ? 'intro' : bar < 12 ? 'build' : bar < stripBar ? 'hit' : bar === stripBar ? 'strip' : bar < bars - 1 ? 'climax' : 'cutoff';
  const level = { intro: 58, build: 84, hit: 100, climax: 108, cutoff: 120, strip: 0 };
  const sections = [['intro', 0, 4], ['build', 4, 8], ['hit', 12, stripBar - 12], ['strip', stripBar, 1], ['climax', stripBar + 1, bars - stripBar - 2], ['cutoff', bars - 1, 1]];
  const ostinato = makePart('low-strings-ostinato', 'bass', { voice: 'bass', volume: 40 },
    { sfz: 'VSCO-2-CE/CelloEnsSpic.sfz', articulation: 'spiccato', instrument: 'cello-section', gainDb: 2 });
  const basses = makePart('contrabass-ostinato', 'bass', { voice: 'bass', volume: 16 },
    { sfz: 'VSCO-2-CE/ContrabassSpic.sfz', articulation: 'spiccato', instrument: 'contrabass', gainDb: -1 });
  const sustain = makePart('violins-sustain', 'harmony', { voice: 'pad', volume: 34, pan: 14 },
    { sfz: 'VSCO-2-CE/ViolinEnsSusVib.sfz', articulation: 'sustain', instrument: 'violin-section', gainDb: -2, pan: 14 });
  const spiccato = makePart('violins-spiccato', 'harmony', { voice: 'pluck', volume: 40, pan: -14 },
    { sfz: 'VSCO-2-CE/ViolinEnsSpic.sfz', articulation: 'spiccato', instrument: 'violin-section', gainDb: -3, pan: -14 });
  const brass = makePart('trumpet-punches', 'lead', { voice: 'pluck', volume: 66 },
    { sfz: 'VSCO-2-CE/TrumpetStac.sfz', articulation: 'staccato', instrument: 'trumpet', gainDb: 0 });
  const tuba = makePart('tuba-marcato', 'bass', { voice: 'bass', volume: 18 },
    { sfz: 'VSCO-2-CE/TubaStac.sfz', articulation: 'marcato', instrument: 'tuba', gainDb: 0 });
  const drum = makePart('hand-drum-pulse', 'drums', { voice: 'kick', volume: 36 },
    { sfz: 'VSCO-2-CE/Timpani.sfz', articulation: 'sustain', instrument: 'timpani', gainDb: 2 });
  const snare = makePart('tight-snare', 'drums', { voice: 'clap', volume: 54 });
  const hat = makePart('tight-hat', 'drums', { voice: 'hat', volume: 34, pan: 18 });
  const crash = makePart('crash', 'fx', { voice: 'hat', volume: 34 });
  const cells = [[[0, 36], [84, 12], [96, 24]], [[0, 36], [72, 12], [132, 12]], [[48, 12], [96, 36], [156, 12]]];
  for (let bar = 0; bar < bars; bar++) {
    const s = section(bar), d = root(bar), v = level[s];
    if (s === 'cutoff') {
      ostinato.add(at(bar), 36, pitchOf(key, d, 2), v); basses.add(at(bar), 36, pitchOf(key, d, 1), v - 10);
      brass.add(at(bar), 30, pitchOf(key, d, 4), 124); brass.add(at(bar), 30, pitchOf(key, d + 4, 4), 118);
      tuba.add(at(bar), 30, pitchOf(key, d, 2), 124); drum.add(at(bar), 60, pitchOf(key, d, 2), 127);
      sustain.add(at(bar), 40, pitchOf(key, d, 4), 100); crash.add(at(bar), 90, 69, 120);
      continue;
    }
    if (s === 'strip') { for (const step of [0, 4, 8, 12]) drum.add(at(bar, step), 30, pitchOf(key, d, 2), 112); continue; }
    // Ostinato: short, short, long on every beat. The last beat of every other bar leans on the flat second.
    if (bar >= 2) {
      for (let beat = 0; beat < 4; beat++) {
        const base = at(bar) + beat * BEAT, lean = beat === 3 && bar % 2 === 1;
        const accent = beat === 0 ? 12 : 0, low = pitchOf(key, d, 2);
        ostinato.add(base, 9, low, v + accent).add(base + STEP, 9, lean ? pitchOf(key, d + 1, 2) : low, v - 12).add(base + 2 * STEP, 20, low, v - 4);
        if (bar >= 8) basses.add(base, 30, pitchOf(key, d, 1), v - 12);
      }
    }
    // Strings: a sustained swell in the build and the climax, short spiccato in the hit section. That switch is the articulation contrast.
    if (s === 'build' || s === 'climax') {
      for (const note of triad(key, chords[bar % chords.length], s === 'climax' ? 5 : 4)) sustain.add(at(bar), BAR - 6, note, v - 28 + Math.min(12, (bar % 8) * 2));
    } else if (s === 'hit') {
      for (let e = 0; e < 8; e++) spiccato.add(at(bar) + e * 24, 10, pitchOf(key, d + 4, 4), v - 18 + (e % 2 ? 0 : 8));
    }
    // Brass punches answer the strings in the hit and climax sections. The first stab of a cell is accented (marcato).
    if (s === 'hit' || s === 'climax') {
      const cell = cells[(bar + Math.floor(random() * 3)) % 3];
      cell.forEach(([onset, length], i) => {
        const velocity = i === 0 ? 118 : 100;
        brass.add(at(bar) + onset, length, pitchOf(key, d, 4), velocity).add(at(bar) + onset, length, pitchOf(key, d + 4, 4), velocity - 8);
        tuba.add(at(bar) + onset, Math.max(length, 24), pitchOf(key, d, 2), velocity);
      });
    }
    // Hybrid hand drums, then a tight kit on top from the build onwards.
    const pattern = s === 'intro' ? [0, 8] : s === 'build' ? [0, 4, 8, 12] : s === 'hit' ? [0, 6, 8, 14] : [0, 3, 6, 8, 11, 14];
    for (const step of pattern) drum.add(at(bar, step), 30, pitchOf(key, d, 2), s === 'intro' ? 60 : step === 0 ? 118 : 96);
    if (bar >= 8) {
      for (const step of [4, 12]) snare.add(at(bar, step), 12, 69, 96);
      for (let step = 0; step < 16; step++) if (step % 2 === 0 || bar >= 12) hat.add(at(bar, step), 5, 69, step % 4 === 0 ? 74 : 44);
    }
    if (bar === 12 || bar === stripBar + 1) crash.add(at(bar), 96, 69, 108);
  }
  return { sections, contrast: [{ legato: 'violins-sustain', short: 'violins-spiccato' }, { legato: 'violins-sustain', short: 'trumpet-punches' }], parts: [ostinato, basses, sustain, spiccato, brass, tuba, drum, snare, hat, crash] };
}

function horror(persona, ctx) {
  const { key, bars, random } = ctx;
  const tritone = pitchOf(key, 0, 4) + 6;
  const bass = makePart('contrabass-drone', 'bass', { voice: 'bass', volume: 34 },
    { sfz: 'VSCO-2-CE/ContrabassSusVB.sfz', articulation: 'sustain-vibrato', instrument: 'contrabass', gainDb: 4 });
  const cluster = makePart('viola-cluster-tremolo', 'harmony', { voice: 'pad', volume: 44, pan: -16 },
    { sfz: 'VSCO-2-CE/ViolaEnsTrem.sfz', articulation: 'tremolo', instrument: 'viola-section', gainDb: 0, pan: -16 });
  const riser = makePart('violin-riser', 'texture', { voice: 'pad', volume: 40, pan: 12 },
    { sfz: 'VSCO-2-CE/ViolinEnsTrem.sfz', articulation: 'tremolo', instrument: 'violin-section', gainDb: -2, pan: 12 });
  const edge = makePart('solo-violin-tremolo', 'texture', { voice: 'pluck', volume: 34, pan: 24 },
    { sfz: 'VSCO-2-CE/SViolinTrem.sfz', articulation: 'tremolo', instrument: 'solo-violin', gainDb: -4, pan: 24 });
  const ticks = makePart('solo-violin-pizzicato', 'texture', { voice: 'hat', volume: 24, pan: -26 },
    { sfz: 'VSCO-2-CE/SViolinPizz.sfz', articulation: 'pizzicato', instrument: 'solo-violin', gainDb: -3, pan: -26 });
  const heart = makePart('heartbeat', 'drums', { voice: 'kick', volume: 40 },
    { sfz: 'VSCO-2-CE/Timpani.sfz', articulation: 'sustain', instrument: 'timpani', gainDb: -3 });
  const root = 0, low = 1;
  // Bar plan (a bar is four seconds at 60 BPM): near silence, a drone, a cluster, a heartbeat that speeds into a riser,
  // then a cut and two empty bars with nothing answering it, and a sparse tail.
  const riseFrom = bars - 8, riseTo = bars - 4, cutBar = bars - 4, tailFrom = bars - 2;
  bass.add(at(0, 8), at(riseTo) - at(0, 8) - 30, pitchOf(key, root, low), 46);
  bass.add(at(tailFrom), at(bars - 1) - at(tailFrom), pitchOf(key, root, low), 40);
  // A chromatic cluster of four neighbouring semitones and, later, an unresolved tritone, swelling in bar by bar.
  for (let bar = 3; bar < cutBar; bar += 2) {
    const grow = (bar - 3) / 7, vel = Math.round(lerp(30, 58, grow));
    const notes = [0, 1, 2, 3].map(semitone => pitchOf(key, root, 3) + semitone).concat(bar >= 7 ? [tritone - 12] : []);
    for (const note of notes) cluster.add(at(bar), Math.min(BAR * 2 - 8, at(cutBar) - at(bar) - 8), note, vel - (note === tritone - 12 ? 6 : 0));
  }
  // Riser: climbs a semitone per beat for four bars, never reaching a landing. Heartbeat speeds up under it.
  for (let beat = 0, total = (riseTo - riseFrom) * 4; beat < total; beat++) {
    const t = beat / (total - 1);
    riser.add(at(riseFrom) + beat * BEAT, beat === total - 1 ? BEAT - 6 : BEAT + 6, pitchOf(key, 0, 4) + beat, Math.round(lerp(26, 70, t)));
  }
  let tick = at(2);
  while (tick < at(cutBar) - 40) {
    const t = (tick - at(2)) / (at(cutBar) - at(2)), gap = Math.round(lerp(BEAT * 1.5, BEAT * 0.55, t * t));
    heart.add(tick, 24, pitchOf(key, root, 2), Math.round(lerp(64, 100, t)));
    heart.add(tick + 14, 20, pitchOf(key, root, 2), Math.round(lerp(48, 78, t)));
    tick += gap;
  }
  // Aleatoric texture: irregular onsets from the seed, over a minor second and a tritone, thin and high.
  const scatter = (part, from, to, count, notes, length, velocity) => {
    for (let i = 0; i < count; i++) {
      const onset = from + Math.floor(random() * (to - from - length));
      part.add(onset, length, notes[Math.floor(random() * notes.length)], velocity + random.spread(8));
    }
  };
  scatter(edge, at(4), at(cutBar), 6, [pitchOf(key, 0, 5), pitchOf(key, 1, 5), tritone + 12, pitchOf(key, 6, 5)], BEAT * 3, 34);
  scatter(ticks, at(4), at(cutBar), 7, [pitchOf(key, 0, 5), pitchOf(key, 1, 5), pitchOf(key, 4, 5)], 18, 60);
  scatter(ticks, at(tailFrom), at(bars - 1), 4, [pitchOf(key, 0, 5), pitchOf(key, 1, 5), tritone + 12], 18, 52);
  scatter(edge, at(tailFrom), at(bars - 1), 2, [pitchOf(key, 1, 5), pitchOf(key, 0, 6)], BEAT * 4, 30);
  return { sections: [['near-silence', 0, 2], ['stalk', 2, riseFrom - 2], ['riser', riseFrom, riseTo - riseFrom], ['withheld', cutBar, tailFrom - cutBar], ['tail', tailFrom, bars - tailFrom]], parts: [bass, cluster, riser, edge, ticks, heart] };
}

const hornCall = [[0, 2], [4, 1], [5, 1], [7, 3], [6, 1], [5, 2], [4, 2], [2, 1], [3, 1], [0, 2]]; // [scale degree, beats]
function fantasy(persona, ctx) {
  const { key, bars, random, chords } = ctx;
  const lift = parseKey(`${'C C# D D# E F F# G G# A A# B'.split(' ')[key.tonic]} mixolydian`);
  const horn = makePart('horn-call-legato', 'lead', { voice: 'pad', volume: 44 },
    { sfz: 'VSCO-2-CE/FHornSus.sfz', articulation: 'sustain', instrument: 'french-horn', gainDb: 3 });
  const harp = makePart('harp-figure', 'harmony', { voice: 'pluck', volume: 48, pan: -18 },
    { sfz: 'VSCO-2-CE/Harp.sfz', articulation: 'sustain', instrument: 'harp', gainDb: 0, pan: -18 });
  const pads = makePart('string-pads-legato', 'harmony', { voice: 'pad', volume: 26, pan: 16 },
    { sfz: 'VSCO-2-CE/ViolinEnsSusVib.sfz', articulation: 'sustain', instrument: 'violin-section', gainDb: -1, pan: 16 });
  const ostinato = makePart('low-strings-ostinato', 'bass', { voice: 'bass', volume: 40 },
    { sfz: 'VSCO-2-CE/CelloEnsSpic.sfz', articulation: 'spiccato', instrument: 'cello-section', gainDb: 1 });
  const flute = makePart('flute-staccato', 'lead', { voice: 'pluck', volume: 40, pan: 20 },
    { sfz: 'VSCO-2-CE/FluteStac.sfz', articulation: 'staccato', instrument: 'flute', gainDb: 0, pan: 20 });
  const clarinet = makePart('clarinet-staccato', 'counter', { voice: 'pluck', volume: 24, pan: -20 },
    { sfz: 'VSCO-2-CE/ClarinetStac.sfz', articulation: 'staccato', instrument: 'clarinet', gainDb: 0, pan: -20 });
  const spic = makePart('violin-spiccato', 'harmony', { voice: 'pluck', volume: 26 },
    { sfz: 'VSCO-2-CE/ViolinEnsSpic.sfz', articulation: 'spiccato', instrument: 'violin-section', gainDb: -3 });
  const timp = makePart('timpani', 'drums', { voice: 'kick', volume: 40 },
    { sfz: 'VSCO-2-CE/Timpani.sfz', articulation: 'sustain', instrument: 'timpani', gainDb: 0 });
  const shaker = makePart('light-shaker', 'drums', { voice: 'hat', volume: 14, pan: 12 });
  const stac = bar => bar >= 8 && bar < 12;
  const mix = bar => bar >= 16 && bar < 20;
  const root = bar => degreeOf(chords[bar % chords.length]);
  const callAt = (part, bar0, octave, vel, legato = 6, shift = 0, k = key) => {
    let tick = at(bar0);
    for (const [degree, beats] of hornCall) { part.add(tick, beats * BEAT + legato, pitchOf(k, degree + shift, octave), vel + (beats >= 3 ? 6 : 0)); tick += beats * BEAT; }
  };
  const mixoDegree = ['I', 'VII', 'IV', 'I'];
  callAt(horn, 0, 3, 66); callAt(horn, 4, 3, 78); callAt(horn, 12, 3, 88);
  callAt(pads, 4, 4, 54, 6, 2); callAt(pads, 12, 4, 60, 6, 2);
  // High point: the same call over the mixolydian version of the key, so the major third replaces the minor third.
  callAt(horn, 16, 3, 96, 6, 0, lift); callAt(pads, 16, 4, 70, 6, 4, lift);
  for (let bar = 0; bar < bars - 2; bar++) {
    const chord = mix(bar) ? mixoDegree[bar % 4] : chords[bar % chords.length], k = mix(bar) ? lift : key, d = degreeOf(chord);
    // Harp figure: an eight-note rolling arpeggio, every bar of the cue until the ending.
    [0, 2, 4, 7, 9, 7, 4, 2].forEach((offset, i) => harp.add(at(bar) + i * 24, 40, pitchOf(k, d + offset, 3), 52 + (i === 0 ? 14 : 0) + random.spread(3)));
    if (bar >= 4 && !stac(bar)) for (const n of triad(k, chord, 4)) pads.add(at(bar), BAR - 4, n, 44 + (mix(bar) ? 14 : 0));
    if (bar >= 4) {
      for (let e = 0; e < 8; e++) ostinato.add(at(bar) + e * 24, 20, pitchOf(k, d + (e % 2 ? 4 : 0) + (bar % 4 === 3 && e === 7 ? 1 : 0), 2), 80 + (e % 4 === 0 ? 12 : 0));
    }
    if (stac(bar)) {
      // Staccato answer: short crisp figures that replace the legato lines.
      [0, 2, 4, 2, 4, 7, 4, 2].forEach((offset, i) => flute.add(at(bar) + i * 24, 12, pitchOf(k, d + offset, 5), 84 + (i % 4 === 0 ? 10 : 0)));
      [0, 2, 4, 6].forEach((i) => clarinet.add(at(bar) + i * 24 + 12, 12, pitchOf(k, d + 4, 4), 66));
      for (let e = 0; e < 8; e++) spic.add(at(bar) + e * 24, 10, pitchOf(k, d + 2, 4), 62 + (e % 2 ? 0 : 10));
    }
    if (bar >= 12 && bar < 20) for (const step of [0, 8]) timp.add(at(bar, step), 40, pitchOf(k, d, 2), step === 0 ? 100 : 80);
    if (bar >= 8) for (const step of [2, 6, 10, 14]) shaker.add(at(bar, step), 5, 69, 40);
  }
  // Ending: an open fifth held, nothing else.
  const last = bars - 2;
  for (const [offset, octave] of [[0, 3], [4, 3], [0, 4], [4, 4]]) pads.add(at(last), BAR * 2 - 12, pitchOf(key, offset, octave), 62);
  horn.add(at(last), BAR * 2 - 12, pitchOf(key, 0, 3), 72); horn.add(at(last), BAR * 2 - 12, pitchOf(key, 4, 3), 66);
  timp.add(at(last), 60, pitchOf(key, 0, 2), 90);
  return { sections: [['call', 0, 4], ['legato-answer', 4, 4], ['staccato', 8, 4], ['call-return', 12, 4], ['mixolydian-lift', 16, 4], ['open-fifth', 20, bars - 20]], contrast: [{ legato: 'horn-call-legato', short: 'flute-staccato' }], parts: [horn, harp, pads, ostinato, flute, clarinet, spic, timp, shaker] };
}

function scifi(persona, ctx) {
  const { key, bars, random, chords } = ctx;
  const root = bar => degreeOf(chords[bar % chords.length]);
  const drone = makePart('analog-drone', 'texture', { voice: 'pad', volume: 30 });
  const air = makePart('additive-air', 'texture', { voice: 'pad', volume: 14, pan: -22 });
  const arp = makePart('sequenced-arp', 'lead', { voice: 'pluck', volume: 38, pan: 14 });
  const bass = makePart('pulse-bass', 'bass', { voice: 'bass', volume: 52 });
  const kick = makePart('industrial-kick', 'drums', { voice: 'kick', volume: 66 });
  const metal = makePart('metal-hit', 'drums', { voice: 'clap', volume: 34 });
  const noise = makePart('noise-burst', 'drums', { voice: 'hat', volume: 20, pan: 20 });
  const peakFrom = 7, peakTo = 14, closing = bars - 3;
  drone.add(at(0), at(bars) - 6, pitchOf(key, 0, 2), 80).add(at(0), at(bars) - 6, pitchOf(key, 4, 2), 66);
  for (let bar = 0; bar < bars - 1; bar++) {
    const d = root(bar), chord = chords[bar % chords.length];
    if (bar >= 6 && bar < bars - 2) for (const n of triad(key, chord, 5)) air.add(at(bar), BAR - 4, n, 40 + (bar >= peakFrom && bar < peakTo ? 14 : 0));
    // Arpeggio: root, third, fifth and the octave in a 16-step pattern. Gate and octave change by section.
    if (bar >= 2 && bar < bars - 1) {
      const gate = bar < peakFrom ? 6 : bar < peakTo ? 14 : 8, up = bar >= 10 && bar < peakTo ? 1 : 0, quiet = bar >= peakTo ? -14 : 0;
      for (let step = 0; step < 16; step++) {
        const offset = [0, 2, 4, 7, 4, 2, 0, 2, 4, 7, 9, 7, 4, 2, 4, 2][step];
        arp.add(at(bar, step), gate, pitchOf(key, d + offset, 4 + up), 70 + (step % 4 === 0 ? 20 : 0) + quiet + random.spread(4));
      }
    }
    if (bar >= peakFrom && bar < peakTo) {
      for (let e = 0; e < 8; e++) bass.add(at(bar) + e * 24, 18, pitchOf(key, d, bar === peakTo - 1 ? 0 : 1), e % 2 ? 64 : 92);
      for (const step of [0, 8, 11]) kick.add(at(bar, step), 12, 69, step === 0 ? 112 : 88);
      for (const step of [4, 12]) metal.add(at(bar, step), 11, 69, 96);
      for (let step = 0; step < 16; step++) if (random() < 0.7) noise.add(at(bar, step), 4, 69, 36 + (step % 4 === 2 ? 20 : 0));
      if (bar === peakFrom || bar === 10) noise.add(at(bar), 90, 69, 100);
    }
  }
  return { sections: [['drone', 0, 2], ['arp-entry', 2, peakFrom - 2], ['peak', peakFrom, peakTo - peakFrom], ['strip', peakTo, closing - peakTo], ['filter-close', closing, bars - closing]], parts: [drone, air, arp, bass, kick, metal, noise],
    automation: [
      { part: 'analog-drone', control: 'cutoff', points: [[0, 260], [at(4), 520], [at(peakFrom), 2400], [at(10), 6500], [at(peakTo + 1), 3000], [at(closing), 320]] },
      { part: 'sequenced-arp', control: 'cutoff', points: [[0, 500], [at(4), 800], [at(peakFrom), 2600], [at(10), 6000], [at(peakTo + 1), 2400], [at(closing), 420]] },
      { part: 'additive-air', control: 'cutoff', points: [[0, 1500], [at(peakFrom), 7000], [at(closing), 1800]] },
    ] };
}

const builders = { 'action-score': action, 'horror-suspense': horror, 'epic-fantasy': fantasy, 'dark-synth-scifi': scifi };
const minBars = { 'action-score': 24, 'horror-suspense': 13, 'epic-fantasy': 22, 'dark-synth-scifi': 20 };
export const cuePersonas = Object.keys(builders);

export function buildCue(personaOrId, { seed, seconds, bpm, key: keyName } = {}, directory) {
  const persona = typeof personaOrId === 'string' ? getPersona(personaOrId, directory) : personaOrId;
  if (persona.kind !== 'film' || !builders[persona.id]) throw new Error(`No reference cue for persona "${persona.id}". Use one of: ${cuePersonas.join(', ')}`);
  const tempo = bpm ?? persona.tempo.default;
  if (tempo < persona.tempo.min || tempo > persona.tempo.max) throw new Error(`bpm must be between ${persona.tempo.min} and ${persona.tempo.max} for ${persona.id}`);
  const useSeed = seed ?? persona.testRender.seed, length = seconds ?? persona.testRender.seconds;
  if (length < 30 || length > 60) throw new Error('A reference cue is 30 to 60 seconds');
  const bars = Math.round(length * tempo / 240);
  if (bars < minBars[persona.id]) throw new Error(`${persona.id} needs at least ${minBars[persona.id]} bars; ${length} s at ${tempo} BPM gives ${bars}. Raise seconds or bpm.`);
  const random = rng(useSeed), key = parseKey(keyName ?? persona.harmony.keys?.[0] ?? 'A phrygian');
  const chords = chordsFor(persona, bars, random);
  const built = builders[persona.id](persona, { key, bars, random, chords });
  return { persona: persona.id, seed: useSeed, bpm: tempo, key: key.name, bars, seconds: Number((bars * 240 / tempo).toFixed(2)),
    sections: built.sections.map(([name, bar, count]) => ({ name, bar, bars: count })), parts: finish(built.parts), automation: built.automation ?? [], ...(built.contrast ? { contrast: built.contrast } : {}) };
}

// An LMMS project for create_project, using stock voices, plus the cutoff clips apply_edits can add.
export function cueProject(cue, { masterVolume = 86 } = {}) {
  const tracks = cue.parts.map(part => ({
    name: part.id, voice: part.native.voice, role: part.role, volume: part.native.volume, pan: part.native.pan ?? 0,
    patterns: [{ name: part.id, bar: 0, bars: cue.bars, notes: part.notes }],
  }));
  const edits = cue.automation.map(({ part, control, points }) => ({ op: 'automate_track', args: {
    trackName: part, name: `${part} ${control}`, control, startTick: 0, length: cue.bars * BAR, curve: 'linear',
    points: points.map(([tick, value]) => ({ tick, value })) } }));
  return { bpm: cue.bpm, lengthBars: cue.bars, masterVolume, tracks, edits };
}

export { BAR };
