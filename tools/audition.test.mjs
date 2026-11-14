// Unit tests for the audition module: timing maths, the manifest-to-page model, the page itself, feedback and taste.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { DOMParser } from '@xmldom/xmldom';
import {
  barSeconds, barBeatAt, wrapSongTime, startPlan, sectionAt, secondsToNextBar, normaliseSections, matchLoudness,
  gameModel, compareModel, renderPage, pageAssets, parseFeedback, organiseFeedback, feedbackSchema,
  emptyTaste, addTaste, forgetTaste, tasteByArea, parseTaste,
} from './audition.mjs';

// The shape export_game_audio writes: 120 bpm 4/4, 2 intro bars, 6 loop bars, two layers and a stinger.
const manifest = {
  name: 'forest', source: 'song.mmp', bpm: 120, timeSignature: [4, 4], bars: 8, sampleRate: 48000, channels: 2, gainDb: 0,
  loop: { file: 'forest-loop.wav', startFrame: 0, endFrame: 576000, seamless: true, tail: 'folded into the loop start' },
  intro: { file: 'forest-intro.wav', frames: 192000, then: 'forest-loop.wav' },
  files: [
    { file: 'forest-loop.wav', role: 'loop', loopStartFrame: 0, loopEndFrame: 576000, bars: 6, frames: 576000 },
    { file: 'forest-intro.wav', role: 'intro', bars: 2, next: 'forest-loop.wav', frames: 192000 },
    { file: 'forest-layer-rhythm.wav', role: 'layer', layer: 'rhythm', tracks: ['Kick', 'Snare'], frames: 576000 },
    { file: 'forest-layer-tonal.wav', role: 'layer', layer: 'tonal', tracks: ['Bass', 'Keys'], frames: 576000 },
    { file: 'forest-stinger-hit.wav', role: 'stinger', startBar: 4, bars: 1, frames: 96000 },
  ],
};

test('bar length follows LMMS ticks: 192 * numerator / denominator ticks of 48 per beat', () => {
  assert.equal(barSeconds(120, [4, 4]), 2);
  assert.equal(barSeconds(120, [3, 4]), 1.5);
  assert.equal(barSeconds(120, [6, 8]), 1.5);
  assert.equal(barSeconds(90), 240 / 90);
});

test('bar and beat at a time count bars from zero and beats from one', () => {
  assert.deepEqual(barBeatAt(0, 120, [4, 4]), { bar: 0, beat: 1, position: 0 });
  assert.equal(barBeatAt(2, 120, [4, 4]).bar, 1);
  assert.equal(barBeatAt(2.5, 120, [4, 4]).beat, 2);
  assert.equal(barBeatAt(3.999, 120, [4, 4]).beat, 4);
  // Floating error just below a bar line must not land in the previous bar.
  assert.equal(barBeatAt(0.1 + 0.2 + 1.7, 120, [4, 4]).bar, 1);
  assert.deepEqual(barBeatAt(1.5 * 3, 120, [3, 4]), { bar: 3, beat: 1, position: 3 });
});

test('song time plays the intro once and wraps the loop', () => {
  assert.equal(wrapSongTime(1, 4, 12), 1);
  assert.equal(wrapSongTime(4, 4, 12), 4);
  assert.equal(wrapSongTime(15.5, 4, 12), 15.5);
  assert.equal(wrapSongTime(16, 4, 12), 4);
  assert.equal(wrapSongTime(30, 4, 12), 6);
  assert.equal(wrapSongTime(30, 0, 12), 6);
  assert.equal(wrapSongTime(5, 0, 0), 5);
});

test('start plan joins intro and loop on adjacent frames', () => {
  // From the top: the loop waits exactly the intro length, so its first frame follows the intro's last.
  assert.deepEqual(startPlan(0, 192000, 576000), { introOffset: 0, loopDelay: 192000, loopOffset: 0 });
  // Mid intro: the remaining intro frames and the loop delay are the same number.
  const mid = startPlan(150000.4, 192000, 576000);
  assert.equal(mid.introOffset + mid.loopDelay, 192000);
  // Past the intro the intro is skipped and the loop starts at the right frame, wrapping after one pass.
  assert.deepEqual(startPlan(192000, 192000, 576000), { introOffset: null, loopDelay: 0, loopOffset: 0 });
  assert.deepEqual(startPlan(192000 + 576000 + 10, 192000, 576000), { introOffset: null, loopDelay: 0, loopOffset: 10 });
  assert.deepEqual(startPlan(5, 0, 100), { introOffset: null, loopDelay: 0, loopOffset: 5 });
});

test('sections: lengths fill to the next section, lookups and validation', () => {
  const sections = normaliseSections([{ name: 'B', startBar: 4 }, { name: 'A', startBar: 0 }], 8);
  assert.deepEqual(sections, [{ name: 'A', startBar: 0, bars: 4 }, { name: 'B', startBar: 4, bars: 4 }]);
  assert.equal(sectionAt(3.99, sections).name, 'A');
  assert.equal(sectionAt(4, sections).name, 'B');
  assert.equal(sectionAt(8, sections), null);
  assert.throws(() => normaliseSections([{ name: 'X', startBar: 9 }], 8), /outside the song/);
  assert.throws(() => normaliseSections([{ name: 'X', startBar: 0 }]), /needs a length/);
});

test('stingers wait for the next bar line', () => {
  assert.equal(secondsToNextBar(0, 120, [4, 4]), 0);
  assert.equal(secondsToNextBar(0.5, 120, [4, 4]), 1.5);
  assert.equal(secondsToNextBar(2, 120, [4, 4]), 0);
  assert.ok(Math.abs(secondsToNextBar(3.9, 120, [4, 4]) - 0.1) < 1e-9);
});

test('loudness matching turns the louder files down to the quietest', () => {
  assert.deepEqual(matchLoudness([-14, -18.5]), [-4.5, 0]);
  assert.deepEqual(matchLoudness([-20, null, -16]), [0, 0, -4]);
  assert.deepEqual(matchLoudness([null]), [0]);
});

test('manifest to page model: intro, loop frames, layers, stingers and default sections', () => {
  const model = gameModel(manifest, { manifestFile: 'forest.manifest.json' });
  assert.equal(model.kind, 'game');
  assert.deepEqual(model.intro, { src: 'forest-intro.wav', frames: 192000, bars: 2 });
  assert.deepEqual(model.loop, { src: 'forest-loop.wav', frames: 576000, startFrame: 0, endFrame: 576000, bars: 6, startBar: 2 });
  assert.deepEqual(model.layers.map(layer => [layer.name, layer.src, layer.tracks]), [
    ['rhythm', 'forest-layer-rhythm.wav', ['Kick', 'Snare']], ['tonal', 'forest-layer-tonal.wav', ['Bass', 'Keys']]]);
  assert.deepEqual(model.stingers.map(s => [s.name, s.src, s.startBar]), [['hit', 'forest-stinger-hit.wav', 4]]);
  assert.deepEqual(model.sections, [{ name: 'Intro', startBar: 0, bars: 2 }, { name: 'Loop', startBar: 2, bars: 6 }]);
  assert.equal(model.songBars, 8);
  assert.equal(model.warnings, undefined);
  assert.equal(model.feedbackName, 'forest-feedback.json');
  assert.deepEqual(pageAssets(model), ['forest-intro.wav', 'forest-loop.wav', 'forest-layer-rhythm.wav', 'forest-layer-tonal.wav', 'forest-stinger-hit.wav']);
  const custom = gameModel(manifest, { sections: [{ name: 'Calm', startBar: 2 }, { name: 'Build', startBar: 5, bars: 3 }] });
  assert.deepEqual(custom.sections, [{ name: 'Calm', startBar: 2, bars: 3 }, { name: 'Build', startBar: 5, bars: 3 }]);
  assert.throws(() => gameModel(manifest, { sections: [{ name: 'Late', startBar: 8 }] }), /outside the song/);
  assert.throws(() => gameModel({ name: 'x' }), /manifest with a loop/);
  const noIntro = gameModel({ ...manifest, intro: undefined, files: manifest.files.filter(f => f.role !== 'intro').map(f => f.role === 'loop' ? { ...f, bars: 8 } : f) });
  assert.equal(noIntro.intro, null);
  assert.deepEqual(noIntro.sections, [{ name: 'Loop', startBar: 0, bars: 8 }]);
});

test('compare model matches loudness and needs bpm for sections', () => {
  const model = compareModel([{ src: 'a.wav', lufs: -12, frames: 480000 }, { src: 'mixes/b.wav', lufs: -15, frames: 480000 }], { bpm: 120, sections: [{ name: 'All', startBar: 0 }] });
  assert.deepEqual(model.compare.map(f => [f.label, f.src, f.gainDb]), [['A', 'a.wav', -3], ['B', 'mixes/b.wav', 0]]);
  assert.deepEqual(model.sections, [{ name: 'All', startBar: 0, bars: 5 }]);
  assert.throws(() => compareModel([{ src: 'a.wav', lufs: -12, frames: 10 }], { sections: [{ name: 'X', startBar: 0 }] }), /need bpm/);
  assert.throws(() => compareModel([]), /at least one/);
});

test('page is valid HTML with the config embedded, script that parses, and no network references', () => {
  const model = gameModel(manifest, { title: 'Forest </script><b>', spectrogram: '../spec.png' });
  const html = renderPage(model, { pageName: 'forest-audition.html' });
  const errors = [];
  const doc = new DOMParser({ onError: (level, message) => errors.push(`${level}: ${message}`) }).parseFromString(html, 'text/html');
  assert.deepEqual(errors, []);
  assert.equal(html.match(/<\/script>/g).length, 2, 'the title cannot close the script element');
  assert.match(html, /<title>Forest &lt;\/script&gt;&lt;b&gt;<\/title>/);
  const configText = html.match(/<script type="application\/json" id="audition-config">([^<]*)<\/script>/)[1];
  const config = JSON.parse(configText);
  assert.equal(config.loop.frames, 576000);
  assert.equal(config.intro.frames, 192000);
  assert.equal(config.schema, feedbackSchema);
  assert.equal(config.title, 'Forest </script><b>');
  assert.ok(doc.getElementsByTagName('main').length === 1);
  assert.doesNotMatch(html, /https?:\/\/|\/\/cdn|<link /i, 'no network references');
  // The page script compiles and the shared maths functions are in it.
  const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  assert.doesNotThrow(() => new vm.Script(script));
  for (const name of ['barBeatAt', 'wrapSongTime', 'startPlan', 'sectionAt', 'secondsToNextBar', 'auditionPage']) assert.match(script, new RegExp(`function ${name}\\(`));
});

test('the page script runs against a stub DOM and asks for the folder when opened from disk', () => {
  const html = renderPage(gameModel(manifest), { pageName: 'p.html' });
  const configText = html.match(/id="audition-config">([^<]*)<\/script>/)[1];
  const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const elements = {};
  const element = id => elements[id] ??= {
    id, textContent: id === 'audition-config' ? configText : '', value: id === 'master' ? '0' : '', dataset: {}, style: {}, children: [], className: '',
    classList: { hidden: true, remove() { this.hidden = false; }, add() { this.hidden = true; } },
    appendChild(child) { this.children.push(child); return child; }, append(...kids) { this.children.push(...kids); },
    querySelectorAll: () => [], getBoundingClientRect: () => ({ left: 0, width: 100 }),
  };
  const created = [];
  const document = {
    title: '', getElementById: element, addEventListener() {},
    createElement: tag => { const el = element(`new-${created.length}`); el.tag = tag; created.push(el); return el; },
    body: { appendChild() {} },
  };
  vm.runInNewContext(script, { document, location: { protocol: 'file:' }, requestAnimationFrame() {}, localStorage: { getItem: () => null, setItem() {} },
    HTMLTextAreaElement: class {}, HTMLInputElement: class {}, HTMLSelectElement: class {}, console });
  assert.equal(document.title, 'forest');
  assert.equal(elements.picker.classList.hidden, false, 'folder picker shown for file:// pages');
  assert.equal(elements.layerpanel.classList.hidden, false);
  assert.equal(elements.stingerpanel.classList.hidden, false);
  assert.equal(elements.sectionpanel.classList.hidden, false);
  assert.match(elements.subtitle.textContent, /120 bpm/);
});

const feedback = {
  schema: feedbackSchema, version: 1, title: 'forest', source: 'forest.manifest.json', bpm: 120, timeSignature: [4, 4], introBars: 2,
  savedAt: '2026-11-14T10:00:00.000Z', files: ['forest-loop.wav'],
  sections: [{ name: 'Intro', startBar: 0, bars: 2, rating: 4 }, { name: 'Loop', startBar: 2, bars: 6, rating: 2 }],
  notes: [
    { seconds: 9.01, bar: 4, beat: 1, section: 'Loop', text: '  Lead too busy here  ', rating: 2, mode: 'layers',
      layers: { rhythm: { db: 0, muted: true, solo: false }, tonal: { db: -3, muted: false, solo: false } } },
    { seconds: 1.2, bar: 0, beat: 3, section: 'Intro', text: 'Nice opening', rating: null, mode: 'mix' },
    { seconds: 30, bar: 15, beat: 1, section: null, text: 'Odd click?', rating: null },
  ],
};

test('feedback parsing validates the schema and cleans notes', () => {
  const parsed = parseFeedback(JSON.stringify(feedback));
  assert.equal(parsed.notes[0].text, 'Lead too busy here');
  assert.deepEqual(parsed.notes[0].layers.rhythm, { db: 0, muted: true, solo: false });
  assert.deepEqual(parseFeedback('```json\n' + JSON.stringify(feedback) + '\n```').notes.length, 3, 'pasted code fences are accepted');
  assert.throws(() => parseFeedback('{'), /not valid JSON/);
  assert.throws(() => parseFeedback({ ...feedback, schema: 'other' }), /Expected schema/);
  assert.throws(() => parseFeedback({ ...feedback, version: 2 }), /Unsupported feedback version/);
  assert.throws(() => parseFeedback({ ...feedback, notes: [{ seconds: -1, text: 'x' }] }), /valid seconds/);
  assert.throws(() => parseFeedback({ ...feedback, notes: [{ seconds: 1, text: '' }] }), /neither text nor rating/);
  assert.equal(parseFeedback({ ...feedback, notes: [{ seconds: 1, text: 'x', rating: 9, bar: -2 }] }).notes[0].rating, null);
});

test('feedback is organised by section and bar with what the listener heard', () => {
  const organised = organiseFeedback(parseFeedback(feedback));
  assert.equal(organised.noteCount, 3);
  assert.deepEqual(organised.weakestSection, { name: 'Loop', rating: 2 });
  assert.equal(organised.averageRating, Number(((4 + 2 + 2) / 3).toFixed(2)));
  const loop = organised.sections.find(section => section.name === 'Loop');
  assert.equal(loop.endBar, 8);
  assert.deepEqual(loop.notes.map(note => [note.bar, note.text, note.heard]), [[4, 'Lead too busy here', 'muted rhythm; tonal -3 dB']]);
  assert.equal(organised.sections[0].notes[0].heard, 'full mix');
  assert.equal(organised.outsideSections[0].text, 'Odd click?');
  assert.deepEqual(organised.byBar['4'], ['Lead too busy here']);
  assert.ok(organised.summary.some(line => /Loop \(bars 2 to 7\): rated 2\/5, 1 note/.test(line)));
  // Notes with no section name fall into the section that holds their bar.
  const bySection = organiseFeedback(parseFeedback({ ...feedback, notes: [{ seconds: 5, bar: 2, beat: 3, text: 'Drums enter late' }] }));
  assert.equal(bySection.sections[1].notes[0].text, 'Drums enter late');
});

test('taste memory adds, deduplicates, forgets and groups preferences', () => {
  let store = emptyTaste();
  let result = addTaste(store, { text: 'Leads too busy', area: 'lead' }, 'now');
  assert.deepEqual(result.entry, { id: 't1', area: 'lead', text: 'Leads too busy', addedAt: 'now' });
  store = result.store;
  result = addTaste(store, { text: '  leads   too busy. ', area: 'lead' });
  assert.equal(result.added, false);
  store = addTaste(store, { text: 'Less reverb on drums', area: 'drums', source: 'forest-feedback.json' }).store;
  store = addTaste(store, { text: 'Keep loops under a minute' }).store;
  assert.deepEqual(store.entries.map(entry => entry.id), ['t1', 't2', 't3']);
  assert.deepEqual(tasteByArea(store, 'drums'), { drums: [{ id: 't2', text: 'Less reverb on drums' }], general: [{ id: 't3', text: 'Keep loops under a minute' }] });
  store = forgetTaste(store, ['t1']);
  assert.equal(addTaste(store, { text: 'New one' }).entry.id, 't4', 'ids are not reused after the highest');
  assert.throws(() => forgetTaste(store, ['t9']), /No taste entry/);
  assert.throws(() => addTaste(store, { text: '   ' }), /needs some text/);
  assert.deepEqual(parseTaste(JSON.stringify(store)), store);
  assert.throws(() => parseTaste('{"version":2,"entries":[]}'), /version 1/);
});
