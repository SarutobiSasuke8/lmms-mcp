// Audition pages, listener feedback and taste memory.
// build_audition_page writes one self-contained HTML file that plays an export_game_audio folder (intro into loop, layers,
// stingers) or compares workspace renders at matched loudness. The listener's notes come back as JSON through read_feedback,
// and durable preferences live in .lmms-taste.json through remember_taste and get_taste.
import { lstat, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export const feedbackSchema = 'lmms-mcp/audition-feedback';
export const feedbackVersion = 1;
export const tasteFile = '.lmms-taste.json';
export const tasteAreas = ['general', 'arrangement', 'mix', 'sound', 'drums', 'bass', 'harmony', 'lead', 'counter', 'texture', 'fx'];

// ---------- timing maths ----------
// These functions are also copied into the page with Function.prototype.toString, so the page and the tests run the same code.
// Keep them self-contained: no closures, no imports.

// Seconds in one bar. LMMS uses 48 ticks per quarter note and 192 * numerator / denominator ticks per bar.
export function barSeconds(bpm, meter) {
  const numerator = meter && meter[0] ? meter[0] : 4, denominator = meter && meter[1] ? meter[1] : 4;
  return 240 * numerator / (denominator * bpm);
}
// Bar (counted from zero, like LMMS projects) and beat (counted from one) at a song time in seconds.
export function barBeatAt(seconds, bpm, meter) {
  const numerator = meter && meter[0] ? meter[0] : 4;
  const bar = barSeconds(bpm, meter);
  const position = seconds / bar;
  const whole = Math.floor(position + 1e-9);
  const beat = Math.min(numerator, Math.floor((position - whole) * numerator + 1e-9) + 1);
  return { bar: whole, beat, position };
}
// Map unwrapped play time onto the song timeline: the intro plays once, then the loop repeats forever.
export function wrapSongTime(elapsed, introSeconds, loopSeconds) {
  if (elapsed < introSeconds || !(loopSeconds > 0)) return elapsed;
  return introSeconds + ((elapsed - introSeconds) % loopSeconds);
}
// Where each source starts when playback begins at a song time, all in frames so the join lands on a sample boundary.
// introOffset is null when the intro is already over. The loop starts loopDelay frames after the intro starts.
export function startPlan(songFrame, introFrames, loopFrames) {
  const frame = Math.max(0, Math.round(songFrame));
  if (frame < introFrames) return { introOffset: frame, loopDelay: introFrames - frame, loopOffset: 0 };
  return { introOffset: null, loopDelay: 0, loopOffset: loopFrames > 0 ? (frame - introFrames) % loopFrames : 0 };
}
// The section that contains a bar position, or null.
export function sectionAt(position, sections) {
  let found = null;
  for (const section of sections || []) {
    if (position + 1e-9 >= section.startBar && position < section.startBar + section.bars - 1e-9) found = section;
  }
  return found;
}
// Seconds until the next bar line, for stingers that wait for the downbeat. Zero when already on one.
export function secondsToNextBar(seconds, bpm, meter) {
  const bar = barSeconds(bpm, meter);
  const next = Math.ceil(seconds / bar - 1e-6) * bar;
  return Math.max(0, next - seconds);
}
const pageMaths = [barSeconds, barBeatAt, wrapSongTime, startPlan, sectionAt, secondsToNextBar];

// ---------- page model ----------
// Sections are given in song bars from zero. Missing lengths run to the next section or the end of the song.
export function normaliseSections(sections, songBars) {
  const sorted = [...sections].sort((a, b) => a.startBar - b.startBar);
  return sorted.map((section, index) => {
    if (!(section.startBar >= 0) || (songBars !== undefined && section.startBar >= songBars)) {
      throw new Error(`Section "${section.name}" starts at bar ${section.startBar}, outside the song${songBars !== undefined ? ` (0 to ${songBars})` : ''}`);
    }
    const next = sorted[index + 1]?.startBar ?? songBars;
    const bars = section.bars ?? (next !== undefined ? next - section.startBar : undefined);
    if (!(bars > 0)) throw new Error(`Section "${section.name}" needs a length in bars`);
    return { name: section.name, startBar: section.startBar, bars };
  });
}
// Gains that bring every file down to the quietest one, so A/B judges the music and not the level.
export function matchLoudness(lufsList) {
  const known = lufsList.filter(value => typeof value === 'number' && Number.isFinite(value));
  if (!known.length) return lufsList.map(() => 0);
  const target = Math.min(...known);
  return lufsList.map(value => typeof value === 'number' && Number.isFinite(value) ? Number((target - value).toFixed(2)) : 0);
}
const posix = value => value.split(path.sep).join('/');

// Build the page model for an export_game_audio manifest. `base` is the manifest's folder relative to the page ('' when
// the page sits beside it).
export function gameModel(manifest, { sections, title, spectrogram, base = '', manifestFile } = {}) {
  if (!manifest || typeof manifest !== 'object' || !manifest.loop?.file) throw new Error('Expected an export_game_audio manifest with a loop');
  const sampleRate = manifest.sampleRate ?? 48000;
  const meter = manifest.timeSignature ?? [4, 4];
  const files = manifest.files ?? [];
  const loopEntry = files.find(file => file.role === 'loop') ?? {};
  const introEntry = files.find(file => file.role === 'intro');
  const introBars = introEntry?.bars ?? 0;
  const loopFrames = manifest.loop.endFrame - manifest.loop.startFrame;
  const loopBars = loopEntry.bars ?? (manifest.bars - introBars);
  const songBars = introBars + loopBars;
  const src = file => base + file;
  const model = {
    kind: 'game', title: title ?? manifest.name, name: manifest.name, source: manifestFile ?? `${manifest.name}.manifest.json`,
    sampleRate, bpm: manifest.bpm, timeSignature: meter, songBars,
    intro: manifest.intro ? { src: src(manifest.intro.file), frames: manifest.intro.frames, bars: introBars } : null,
    loop: { src: src(manifest.loop.file), frames: loopFrames, startFrame: manifest.loop.startFrame, endFrame: manifest.loop.endFrame,
      bars: loopBars, startBar: introBars },
    layers: files.filter(file => file.role === 'layer').map(file => ({ name: file.layer, src: src(file.file), frames: file.frames, tracks: file.tracks ?? [] })),
    stingers: files.filter(file => file.role === 'stinger').map(file => ({ name: file.file.replace(/\.wav$/i, '').replace(`${manifest.name}-stinger-`, ''),
      src: src(file.file), frames: file.frames, startBar: file.startBar, bars: file.bars })),
    compare: [],
    sections: normaliseSections(sections?.length ? sections : [
      ...(introBars ? [{ name: 'Intro', startBar: 0, bars: introBars }] : []),
      { name: 'Loop', startBar: introBars, bars: loopBars },
    ], songBars),
    spectrogram: spectrogram ?? null,
    feedbackName: `${manifest.name}-feedback.json`,
  };
  if (model.intro && model.intro.frames !== Math.round(introBars * barSeconds(model.bpm, meter) * sampleRate)) {
    // export_game_audio cuts the intro at a rounded frame; flag any manifest that disagrees with its own tempo.
    model.warnings = ['The intro length does not match its bar count at this tempo; bar numbers may drift by a frame.'];
  }
  return model;
}
// Build the page model for one or more plain renders. Each file loops over its own length.
export function compareModel(files, { sections, title, spectrogram, bpm, timeSignature, sampleRate = 48000, name = 'audition' } = {}) {
  if (!files.length) throw new Error('Give at least one file');
  if (sections?.length && !bpm) throw new Error('Sections are given in bars, so they need bpm');
  const gains = matchLoudness(files.map(file => file.lufs));
  const longest = Math.max(...files.map(file => file.frames ?? 0));
  const songBars = bpm && longest ? longest / sampleRate / barSeconds(bpm, timeSignature) : undefined;
  return {
    kind: 'compare', title: title ?? (files.length > 1 ? 'A/B comparison' : files[0].src), name, source: null,
    sampleRate, bpm: bpm ?? null, timeSignature: timeSignature ?? [4, 4], songBars: songBars ?? null,
    intro: null, loop: null, layers: [], stingers: [],
    compare: files.map((file, index) => ({ label: String.fromCharCode(65 + index), src: file.src, frames: file.frames ?? null,
      lufs: file.lufs ?? null, gainDb: gains[index] })),
    sections: sections?.length ? normaliseSections(sections, songBars === undefined ? undefined : Math.ceil(songBars * 1000) / 1000) : [],
    spectrogram: spectrogram ?? null,
    feedbackName: `${name}-feedback.json`,
  };
}

// ---------- HTML ----------
const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// JSON inside a script element: no "</script", no HTML comment openers, no line separators that break old parsers.
const scriptJson = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const css = `
:root{--bg:#f5f4ef;--panel:#fff;--ink:#1d1d1b;--muted:#6b6a64;--line:#dcdad2;--accent:#2f6f5e;--accent-ink:#fff;--warn:#a2462b;--track:#e9e7df;--fill:#2f6f5e}
@media (prefers-color-scheme:dark){:root{--bg:#151614;--panel:#1f201d;--ink:#ecebe5;--muted:#9c9b93;--line:#353631;--accent:#6fbf9f;--accent-ink:#0d1210;--warn:#e08a6b;--track:#2b2c28;--fill:#6fbf9f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:4px 0 2px}
h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 8px}
.sub{color:var(--muted);font-size:13px;margin:0 0 12px}
section.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:0 0 12px}
button{font:inherit;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:7px;padding:6px 11px;cursor:pointer}
button:hover{border-color:var(--accent)}
button.on,button.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
button:disabled{opacity:.45;cursor:default}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.clock{font:600 26px/1.1 ui-monospace,"Cascadia Mono",Consolas,monospace;font-variant-numeric:tabular-nums;min-width:9ch}
.pos{font:15px ui-monospace,Consolas,monospace;color:var(--muted)}
.sectionname{font-weight:600}
.bar{position:relative;height:26px;background:var(--track);border-radius:6px;margin:10px 0 4px;cursor:pointer;overflow:hidden}
.bar .fill{position:absolute;inset:0 auto 0 0;background:var(--fill);opacity:.35;width:0}
.bar .head{position:absolute;top:0;bottom:0;width:2px;background:var(--fill)}
.bar .mark{position:absolute;top:0;bottom:0;border-left:1px dashed var(--muted);font-size:11px;color:var(--muted);padding-left:3px;white-space:nowrap}
.layer{display:grid;grid-template-columns:minmax(80px,140px) 1fr 58px auto auto;gap:8px;align-items:center;margin:4px 0}
.layer input[type=range]{width:100%}
input[type=range],input[type=checkbox]{accent-color:var(--accent)}
.db{font:13px ui-monospace,Consolas,monospace;color:var(--muted);text-align:right}
.sec{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;border-top:1px solid var(--line);padding:6px 0}
.sec:first-of-type{border-top:0}
.stars button{padding:2px 7px;min-width:30px}
textarea{width:100%;min-height:62px;font:inherit;border:1px solid var(--line);border-radius:7px;padding:8px;background:var(--panel);color:var(--ink)}
select{font:inherit;padding:5px;border-radius:7px;border:1px solid var(--line);background:var(--panel);color:var(--ink)}
ul.notes{list-style:none;padding:0;margin:8px 0 0}
ul.notes li{display:flex;gap:8px;align-items:flex-start;border-top:1px solid var(--line);padding:6px 0}
ul.notes .when{font:13px ui-monospace,Consolas,monospace;color:var(--muted);min-width:15ch;cursor:pointer}
ul.notes .text{flex:1;white-space:pre-wrap}
.status{font-size:13px;color:var(--muted)}
.status.err{color:var(--warn)}
.hidden{display:none}
img.spec{max-width:100%;border-radius:6px;display:block}
.kbd{font:12px ui-monospace,Consolas,monospace;border:1px solid var(--line);border-radius:4px;padding:0 4px}
@media (max-width:600px){.layer{grid-template-columns:1fr 1fr;}.clock{font-size:22px}}
`;

const body = `
<main>
<h1 id="title"></h1>
<p class="sub" id="subtitle"></p>
<section class="panel" id="loader">
<p class="status" id="status">Loading audio...</p>
<div id="picker" class="hidden">
<p class="sub">Browsers do not let a page opened from disk read files next to it. Choose the folder that holds this page (or select the audio files) and playback starts from there.</p>
<div class="row"><label><button type="button" id="pickfolder">Choose folder</button></label><input type="file" id="folderinput" class="hidden" multiple="multiple" webkitdirectory="webkitdirectory" /><button type="button" id="pickfiles">Choose files</button><input type="file" id="filesinput" class="hidden" multiple="multiple" accept="audio/*" /></div>
</div>
</section>
<section class="panel">
<div class="row"><button type="button" id="play" class="primary" disabled="disabled">Play</button><button type="button" id="restart" disabled="disabled">From start</button><span class="clock" id="clock">0:00.000</span><span class="pos" id="pos"></span><span class="sectionname" id="secname"></span></div>
<div class="bar" id="timeline"><div class="fill" id="fill"></div><div class="head" id="head"></div></div>
<div class="row"><span class="status">Master</span><input type="range" id="master" min="-30" max="6" step="0.5" value="0" /><span class="db" id="masterdb">0.0 dB</span><span class="status"><span class="kbd">Space</span> play or pause, <span class="kbd">N</span> new note</span></div>
</section>
<section class="panel hidden" id="comparepanel"><h2>Compare</h2><div class="row" id="comparebuttons"></div><p class="status" id="compareinfo"></p></section>
<section class="panel hidden" id="layerpanel"><h2>Layers</h2><div class="row" style="margin-bottom:6px"><button type="button" id="modemix">Full mix</button><button type="button" id="modelayers">Layers</button></div><div id="layers"></div></section>
<section class="panel hidden" id="stingerpanel"><h2>Stingers</h2><div class="row" id="stingers"></div><label class="status"><input type="checkbox" id="quantise" checked="checked" /> Wait for the next bar</label></section>
<section class="panel hidden" id="sectionpanel"><h2>Sections</h2><div id="sections"></div></section>
<section class="panel"><h2>Notes</h2>
<textarea id="notetext" placeholder="What do you hear? The note is pinned to the current time, bar and layer settings."></textarea>
<div class="row" style="margin-top:6px"><button type="button" id="addnote" class="primary">Add note here</button><select id="noterating"><option value="">No rating</option><option value="1">1 poor</option><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5">5 great</option></select><span class="status" id="notewhere"></span></div>
<ul class="notes" id="notes"></ul>
<div class="row" style="margin-top:8px"><button type="button" id="save">Save feedback</button><button type="button" id="copy">Copy feedback</button><span class="status" id="savestatus"></span></div>
</section>
<section class="panel hidden" id="specpanel"><h2>Spectrogram</h2><img class="spec" id="spec" alt="Spectrogram of the render" /></section>
</main>
`;

// The page's own code. Runs in the browser; the maths functions above are defined before it.
function auditionPage() {
  const config = JSON.parse(document.getElementById('audition-config').textContent);
  const $ = id => document.getElementById(id);
  const make = (tag, props, text) => { const el = document.createElement(tag); Object.assign(el, props || {}); if (text !== undefined) el.textContent = text; return el; };
  const sr = config.sampleRate;
  const timed = Boolean(config.bpm);
  const isGame = config.kind === 'game';
  const storeKey = 'lmms-audition:' + config.pageId;
  const state = { ctx: null, buffers: {}, playing: false, startCtx: 0, startSong: 0, pausedAt: 0, sources: [], nodes: {},
    mode: config.layers.length ? 'layers' : 'mix', active: 0, notes: [], ratings: {},
    layers: Object.fromEntries(config.layers.map(layer => [layer.name, { db: 0, muted: false, solo: false }])) };
  const dbToGain = value => Math.pow(10, value / 20);
  const fmt = seconds => { const m = Math.floor(seconds / 60), s = seconds - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(3); };
  const status = (text, error) => { const el = $('status'); el.textContent = text; el.className = 'status' + (error ? ' err' : ''); };

  $('title').textContent = config.title;
  document.title = config.title;
  const facts = [];
  if (timed) facts.push(config.bpm + ' bpm', config.timeSignature.join('/'));
  if (config.intro) facts.push('intro ' + config.intro.bars + ' bars');
  if (config.loop) facts.push('loop ' + config.loop.bars + ' bars from bar ' + config.loop.startBar);
  if (timed) facts.push('bars count from 0, like the project');
  $('subtitle').textContent = facts.join(' · ');

  // Every audio file the page needs, keyed by its relative path.
  const needed = [];
  if (config.intro) needed.push(config.intro.src);
  if (config.loop) needed.push(config.loop.src);
  for (const layer of config.layers) needed.push(layer.src);
  for (const stinger of config.stingers) needed.push(stinger.src);
  for (const file of config.compare) needed.push(file.src);
  const introSeconds = () => config.intro ? state.buffers[config.intro.src].length / sr : 0;
  const loopSeconds = () => isGame ? state.buffers[config.loop.src].length / sr : state.buffers[config.compare[state.active].src].length / sr;
  const spanSeconds = () => introSeconds() + loopSeconds();

  function makeContext() {
    try { return new AudioContext({ sampleRate: sr }); } catch (error) { return new AudioContext(); }
  }
  async function decodeAll(read) {
    state.ctx = state.ctx || makeContext();
    const frames = {};
    for (const src of needed) {
      if (state.buffers[src]) continue;
      const data = await read(src);
      state.buffers[src] = await state.ctx.decodeAudioData(data);
      frames[src] = state.buffers[src].length;
    }
    buildGraph();
    $('loader').dataset.ready = 'yes';
    $('loader').dataset.frames = JSON.stringify(frames);
    $('loader').dataset.contextRate = String(state.ctx.sampleRate);
    status('Ready. ' + needed.length + ' file' + (needed.length === 1 ? '' : 's') + ' decoded at ' + state.ctx.sampleRate + ' Hz' +
      (state.ctx.sampleRate !== sr ? ' (the browser resampled from ' + sr + ' Hz)' : '') + '.');
    $('play').disabled = false; $('restart').disabled = false;
    drawTimeline();
    if (location.hash === '#selftest' && isGame) {
      selfTest().then(result => { $('loader').dataset.selftest = JSON.stringify(result); },
        error => { $('loader').dataset.selftest = JSON.stringify({ error: String(error && error.message || error) }); });
    }
  }
  // Render the page's own schedule offline and compare it with the files joined end to end: across the intro to loop
  // join, across the loop seam, and the layers summed against the mix. Open the page with #selftest to run it.
  async function selfTest() {
    const rate = state.ctx.sampleRate, intro = config.intro ? state.buffers[config.intro.src] : null, loop = state.buffers[config.loop.src];
    const introFrames = intro ? intro.length : 0, span = Math.round(rate / 2);
    const expected = (frame, channel) => frame < introFrames ? intro.getChannelData(channel)[frame] : loop.getChannelData(channel)[(frame - introFrames) % loop.length];
    async function render(startFrame, keys) {
      const offline = new OfflineAudioContext(2, span * 2, rate);
      scheduleGame(rate, 0, startFrame / rate, (buffer, key, looped) => {
        if (!keys.includes(key) && !(keys.includes('layers') && key !== 'intro' && key !== 'mix')) return null;
        const node = offline.createBufferSource();
        node.buffer = buffer;
        if (looped) { node.loop = true; node.loopStart = 0; node.loopEnd = buffer.duration; }
        node.connect(offline.destination);
        return node;
      });
      return offline.startRendering();
    }
    function compare(rendered, startFrame) {
      let maxDiff = 0;
      for (let c = 0; c < 2; c++) {
        const data = rendered.getChannelData(c);
        for (let i = 0; i < data.length; i++) maxDiff = Math.max(maxDiff, Math.abs(data[i] - expected(startFrame + i, Math.min(c, loop.numberOfChannels - 1))));
      }
      return maxDiff;
    }
    const result = { sampleRate: rate, introFrames, loopFrames: loop.length };
    if (intro) { const start = introFrames - span; result.introJoinMaxDiff = compare(await render(start, ['intro', 'mix']), start); }
    const seam = introFrames + loop.length - span;
    result.loopSeamMaxDiff = compare(await render(seam, ['intro', 'mix']), seam);
    if (config.layers.length) {
      const start = introFrames + Math.max(0, Math.min(loop.length - 2 * span, rate));
      const layered = await render(start, ['layers']);
      let error = 0, reference = 0;
      for (let c = 0; c < 2; c++) {
        const data = layered.getChannelData(c);
        for (let i = 0; i < data.length; i++) { const want = expected(start + i, c); error += (data[i] - want) ** 2; reference += want * want; }
      }
      result.layersVsMixDb = reference > 0 ? (error > 0 ? 10 * Math.log10(error / reference) : -200) : null;
    }
    return result;
  }
  async function fetchAll() {
    try {
      await decodeAll(async src => { const response = await fetch(src); if (!response.ok) throw new Error(src + ': HTTP ' + response.status); return response.arrayBuffer(); });
    } catch (error) {
      status('Could not load the audio (' + error.message + '). Choose the files below instead.', true);
      $('picker').classList.remove('hidden');
    }
  }
  function fromPicker(list) {
    const byName = {};
    for (const file of list) byName[file.name.toLowerCase()] = file;
    const missing = needed.filter(src => !byName[src.split('/').pop().toLowerCase()]);
    if (missing.length) { status('Missing: ' + missing.join(', '), true); return; }
    status('Decoding...');
    decodeAll(src => byName[src.split('/').pop().toLowerCase()].arrayBuffer()).catch(error => status('Could not decode the audio: ' + error.message, true));
  }
  $('pickfolder').onclick = () => $('folderinput').click();
  $('pickfiles').onclick = () => $('filesinput').click();
  $('folderinput').onchange = event => fromPicker(event.target.files);
  $('filesinput').onchange = event => fromPicker(event.target.files);

  // ---------- audio graph ----------
  function buildGraph() {
    const ctx = state.ctx, nodes = state.nodes;
    nodes.master = ctx.createGain(); nodes.master.connect(ctx.destination);
    nodes.intro = ctx.createGain(); nodes.intro.connect(nodes.master);
    nodes.mix = ctx.createGain(); nodes.mix.connect(nodes.master);
    nodes.layerBus = ctx.createGain(); nodes.layerBus.connect(nodes.master);
    nodes.stingers = ctx.createGain(); nodes.stingers.connect(nodes.master);
    nodes.layer = {};
    for (const layer of config.layers) { nodes.layer[layer.name] = ctx.createGain(); nodes.layer[layer.name].connect(nodes.layerBus); }
    nodes.compare = config.compare.map(() => { const gain = ctx.createGain(); gain.connect(nodes.master); return gain; });
    applyGains(true);
  }
  function setGain(node, value, now) {
    const ctx = state.ctx;
    if (now) node.gain.value = value;
    else { node.gain.cancelScheduledValues(ctx.currentTime); node.gain.setTargetAtTime(value, ctx.currentTime, 0.012); }
  }
  function applyGains(now) {
    if (!state.ctx) return;
    const nodes = state.nodes;
    setGain(nodes.master, dbToGain(Number($('master').value)), now);
    if (isGame) {
      const layered = state.mode === 'layers' && config.layers.length > 0;
      setGain(nodes.mix, layered ? 0 : 1, now);
      setGain(nodes.layerBus, layered ? 1 : 0, now);
      const anySolo = Object.values(state.layers).some(layer => layer.solo);
      for (const layer of config.layers) {
        const s = state.layers[layer.name];
        setGain(nodes.layer[layer.name], (anySolo ? s.solo : !s.muted) ? dbToGain(s.db) : 0, now);
      }
    }
    config.compare.forEach((file, index) => setGain(nodes.compare[index], index === state.active ? dbToGain(file.gainDb) : 0, now));
  }
  function source(buffer, destination, loop) {
    const node = state.ctx.createBufferSource();
    node.buffer = buffer;
    if (loop) { node.loop = true; node.loopStart = 0; node.loopEnd = buffer.duration; }
    node.connect(destination);
    state.sources.push(node);
    return node;
  }
  function stopAll() {
    for (const node of state.sources) { try { node.stop(); } catch (error) { /* already stopped */ } node.disconnect(); }
    state.sources = [];
  }
  // Start every source from one song time. All start times are whole frames on the context clock, so the intro's last
  // frame and the loop's first frame are adjacent samples and every layer begins on the same frame as the mix.
  // One scheduler for live playback and the offline self-test. makeSource(buffer, key, loop) returns an unstarted source;
  // key is 'intro', 'mix' or a layer name.
  function scheduleGame(rate, when, songSeconds, makeSource) {
    const introFrames = config.intro ? state.buffers[config.intro.src].length : 0;
    const loopBuffer = state.buffers[config.loop.src];
    const plan = startPlan(songSeconds * rate, introFrames, loopBuffer.length);
    if (config.intro && plan.introOffset !== null) makeSource(state.buffers[config.intro.src], 'intro', false)?.start(when, plan.introOffset / rate);
    const loopWhen = when + plan.loopDelay / rate, loopOffset = plan.loopOffset / rate;
    makeSource(loopBuffer, 'mix', true)?.start(loopWhen, loopOffset);
    for (const layer of config.layers) makeSource(state.buffers[layer.src], layer.name, true)?.start(loopWhen, loopOffset);
  }
  function startAt(songSeconds) {
    const ctx = state.ctx;
    stopAll();
    const when = Math.ceil((ctx.currentTime + 0.06) * ctx.sampleRate) / ctx.sampleRate;
    const rate = ctx.sampleRate;
    if (isGame) {
      scheduleGame(rate, when, songSeconds, (buffer, key, loop) =>
        source(buffer, key === 'intro' ? state.nodes.intro : key === 'mix' ? state.nodes.mix : state.nodes.layer[key], loop));
    } else {
      config.compare.forEach((file, index) => {
        const buffer = state.buffers[file.src];
        source(buffer, state.nodes.compare[index], true).start(when, (Math.round(songSeconds * rate) % buffer.length) / rate);
      });
    }
    state.startCtx = when; state.startSong = songSeconds; state.playing = true;
    $('play').textContent = 'Pause';
  }
  function songTime() {
    if (!state.ctx) return 0;
    if (!state.playing) return state.pausedAt;
    const elapsed = Math.max(0, state.ctx.currentTime - state.startCtx) + state.startSong;
    return wrapSongTime(elapsed, introSeconds(), loopSeconds());
  }
  async function play(from) {
    if (!state.ctx) return;
    if (state.ctx.state === 'suspended') await state.ctx.resume();
    startAt(from === undefined ? state.pausedAt : from);
  }
  function pause() { state.pausedAt = songTime(); stopAll(); state.playing = false; $('play').textContent = 'Play'; }
  function seek(seconds) { if (state.playing) play(seconds); else { state.pausedAt = seconds; } }
  $('play').onclick = () => state.playing ? pause() : play();
  $('restart').onclick = () => play(0);
  $('master').oninput = () => { $('masterdb').textContent = Number($('master').value).toFixed(1) + ' dB'; applyGains(); };
  $('timeline').onclick = event => {
    if (!state.ctx || !needed.every(src => state.buffers[src])) return;
    const box = $('timeline').getBoundingClientRect();
    seek(Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * spanSeconds());
  };

  // ---------- position ----------
  function where(seconds) {
    const info = { seconds: Number(seconds.toFixed(3)), bar: null, beat: null, section: null };
    if (timed) {
      const at = barBeatAt(seconds, config.bpm, config.timeSignature);
      info.bar = at.bar; info.beat = at.beat;
      const section = sectionAt(at.position, config.sections);
      info.section = section ? section.name : null;
    }
    return info;
  }
  function describe(info) {
    return fmt(info.seconds) + (info.bar !== null ? '  bar ' + info.bar + '.' + info.beat : '');
  }
  function drawTimeline() {
    const bar = $('timeline');
    for (const mark of Array.from(bar.querySelectorAll('.mark'))) mark.remove();
    const span = spanSeconds();
    if (!span) return;
    const marks = timed ? config.sections.map(section => ({ at: section.startBar * barSeconds(config.bpm, config.timeSignature), label: section.name })) : [];
    if (config.intro && !marks.some(mark => Math.abs(mark.at - introSeconds()) < 1e-3)) marks.push({ at: introSeconds(), label: 'loop' });
    for (const mark of marks) {
      if (mark.at >= span) continue;
      const el = make('div', { className: 'mark' }, mark.label);
      el.style.left = (100 * mark.at / span) + '%';
      bar.appendChild(el);
    }
  }
  function tick() {
    if (state.ctx && needed.every(src => state.buffers[src])) {
      const seconds = songTime();
      const info = where(seconds);
      $('clock').textContent = fmt(seconds);
      $('pos').textContent = info.bar !== null ? 'bar ' + info.bar + ' · beat ' + info.beat : '';
      $('secname').textContent = info.section || '';
      const fraction = Math.min(1, seconds / spanSeconds());
      $('fill').style.width = (100 * fraction) + '%';
      $('head').style.left = 'calc(' + (100 * fraction) + '% - 1px)';
      $('notewhere').textContent = 'at ' + describe(info) + (info.section ? ' in ' + info.section : '');
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // ---------- layers ----------
  if (config.layers.length) {
    $('layerpanel').classList.remove('hidden');
    const modeButtons = () => { $('modemix').className = state.mode === 'mix' ? 'on' : ''; $('modelayers').className = state.mode === 'layers' ? 'on' : ''; };
    $('modemix').onclick = () => { state.mode = 'mix'; modeButtons(); applyGains(); };
    $('modelayers').onclick = () => { state.mode = 'layers'; modeButtons(); applyGains(); };
    modeButtons();
    for (const layer of config.layers) {
      const s = state.layers[layer.name];
      const row = make('div', { className: 'layer' });
      const name = make('span', { title: layer.tracks.join(', ') }, layer.name);
      const fader = make('input', { type: 'range', min: '-40', max: '6', step: '0.5', value: '0' });
      const readout = make('span', { className: 'db' }, '0.0 dB');
      const mute = make('button', { type: 'button' }, 'M');
      const solo = make('button', { type: 'button' }, 'S');
      fader.oninput = () => { s.db = Number(fader.value); readout.textContent = s.db.toFixed(1) + ' dB'; applyGains(); };
      mute.onclick = () => { s.muted = !s.muted; mute.className = s.muted ? 'on' : ''; applyGains(); };
      solo.onclick = () => { s.solo = !s.solo; solo.className = s.solo ? 'on' : ''; if (state.mode !== 'layers') { state.mode = 'layers'; modeButtons(); } applyGains(); };
      row.append(name, fader, readout, mute, solo);
      $('layers').appendChild(row);
    }
  }
  // ---------- compare ----------
  if (config.compare.length) {
    $('comparepanel').classList.remove('hidden');
    const buttons = config.compare.map((file, index) => {
      const button = make('button', { type: 'button', title: file.src }, file.label + ': ' + file.src.split('/').pop());
      button.onclick = () => { state.active = index; buttons.forEach((b, i) => { b.className = i === index ? 'on' : ''; }); applyGains(); drawTimeline(); };
      $('comparebuttons').appendChild(button);
      return button;
    });
    buttons[0].className = 'on';
    $('compareinfo').textContent = config.compare.length > 1 ? 'Levels matched to the quietest file: ' + config.compare.map(file => file.label + ' ' +
      (file.lufs === null ? 'not measured' : file.lufs.toFixed(1) + ' LUFS, ' + (file.gainDb > 0 ? '+' : '') + file.gainDb.toFixed(1) + ' dB')).join('; ') +
      '. All files play in sync; switching keeps the position.' : '';
  }
  // ---------- stingers ----------
  if (config.stingers.length) {
    $('stingerpanel').classList.remove('hidden');
    for (const stinger of config.stingers) {
      const button = make('button', { type: 'button', title: 'Cut from bar ' + stinger.startBar + ', ' + stinger.bars + ' bars' }, stinger.name);
      button.onclick = async () => {
        if (!state.ctx) return;
        if (state.ctx.state === 'suspended') await state.ctx.resume();
        const wait = state.playing && timed && $('quantise').checked ? secondsToNextBar(songTime(), config.bpm, config.timeSignature) : 0;
        source(state.buffers[stinger.src], state.nodes.stingers, false).start(state.ctx.currentTime + 0.02 + wait);
      };
      $('stingers').appendChild(button);
    }
  }
  // ---------- sections ----------
  function drawSections() {
    const box = $('sections');
    box.textContent = '';
    for (const section of config.sections) {
      const row = make('div', { className: 'sec' });
      const jump = make('button', { type: 'button' }, section.name + ' (bar ' + section.startBar + ', ' + section.bars + ' bars)');
      jump.onclick = () => { const at = section.startBar * barSeconds(config.bpm, config.timeSignature); if (state.playing) play(at); else seek(at); };
      const stars = make('span', { className: 'stars' });
      for (let value = 1; value <= 5; value++) {
        const star = make('button', { type: 'button', title: 'Rate ' + section.name + ' ' + value + ' of 5', className: state.ratings[section.name] >= value ? 'on' : '' }, String(value));
        star.onclick = () => { state.ratings[section.name] = state.ratings[section.name] === value ? null : value; persist(); drawSections(); };
        stars.appendChild(star);
      }
      row.append(jump, stars);
      box.appendChild(row);
    }
  }
  if (config.sections.length && timed) { $('sectionpanel').classList.remove('hidden'); drawSections(); }
  if (config.spectrogram) { $('specpanel').classList.remove('hidden'); $('spec').src = config.spectrogram; }

  // ---------- notes and feedback ----------
  function snapshot() {
    const info = where(songTime());
    const note = { seconds: info.seconds, bar: info.bar, beat: info.beat, section: info.section };
    if (config.layers.length) {
      note.mode = state.mode;
      if (state.mode === 'layers') note.layers = Object.fromEntries(config.layers.map(layer => [layer.name, Object.assign({}, state.layers[layer.name])]));
    }
    if (config.compare.length) note.compare = config.compare[state.active].label;
    return note;
  }
  function drawNotes() {
    const list = $('notes');
    list.textContent = '';
    state.notes.slice().sort((a, b) => a.seconds - b.seconds).forEach(note => {
      const item = make('li');
      const when = make('span', { className: 'when', title: 'Jump here' }, describe(note) + (note.compare ? ' [' + note.compare + ']' : ''));
      when.onclick = () => { if (note.compare) { const index = config.compare.findIndex(file => file.label === note.compare); if (index >= 0) $('comparebuttons').children[index].click(); } if (state.playing) play(note.seconds); else seek(note.seconds); };
      const text = make('span', { className: 'text' }, (note.rating ? '[' + note.rating + '/5] ' : '') + note.text);
      const remove = make('button', { type: 'button', title: 'Delete note' }, 'x');
      remove.onclick = () => { state.notes = state.notes.filter(other => other !== note); persist(); drawNotes(); };
      item.append(when, text, remove);
      list.appendChild(item);
    });
  }
  function addNote() {
    const text = $('notetext').value.trim();
    if (!text) { $('notetext').focus(); return; }
    const note = snapshot();
    note.text = text;
    note.rating = $('noterating').value ? Number($('noterating').value) : null;
    state.notes.push(note);
    $('notetext').value = ''; $('noterating').value = '';
    persist(); drawNotes();
  }
  $('addnote').onclick = addNote;
  $('notetext').onkeydown = event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); addNote(); } };
  function feedback() {
    return {
      schema: config.schema, version: config.version, title: config.title, source: config.source, page: config.pageName,
      files: needed, bpm: config.bpm, timeSignature: config.timeSignature, introBars: config.intro ? config.intro.bars : 0,
      savedAt: new Date().toISOString(),
      sections: config.sections.map(section => ({ name: section.name, startBar: section.startBar, bars: section.bars, rating: state.ratings[section.name] || null })),
      notes: state.notes.slice().sort((a, b) => a.seconds - b.seconds),
    };
  }
  $('save').onclick = () => {
    const blob = new Blob([JSON.stringify(feedback(), null, 2) + '\n'], { type: 'application/json' });
    const link = make('a', { href: URL.createObjectURL(blob), download: config.feedbackName });
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 4000);
    $('savestatus').textContent = 'Saved ' + config.feedbackName + '. Move it into the workspace and ask the agent to read_feedback, or use Copy and paste it into the chat.';
  };
  $('copy').onclick = async () => {
    const text = JSON.stringify(feedback(), null, 2);
    try { await navigator.clipboard.writeText(text); $('savestatus').textContent = 'Copied. Paste it into the chat; the agent passes it to read_feedback as text.'; }
    catch (error) {
      $('notetext').value = text; $('notetext').select();
      $('savestatus').textContent = 'The browser blocked the clipboard. The feedback is selected in the note box; copy it with Ctrl+C.';
    }
  };
  function persist() { try { localStorage.setItem(storeKey, JSON.stringify({ notes: state.notes, ratings: state.ratings })); } catch (error) { /* storage unavailable */ } }
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey) || 'null');
    if (saved) { state.notes = saved.notes || []; state.ratings = saved.ratings || {}; drawNotes(); if (timed) drawSections(); }
  } catch (error) { /* storage unavailable */ }

  document.addEventListener('keydown', event => {
    const typing = event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement;
    if (typing) return;
    if (event.code === 'Space') { event.preventDefault(); if (!$('play').disabled) $('play').click(); }
    if (event.key === 'n' || event.key === 'N') { event.preventDefault(); $('notetext').focus(); }
  });

  if (location.protocol === 'file:') {
    status('Opened from disk. Choose the folder that holds this page to load the audio.');
    $('picker').classList.remove('hidden');
  } else fetchAll();
}

// Render the model to a complete HTML document. Every asset path in the model is relative to the page.
export function renderPage(model, { pageName = 'audition.html', pageId } = {}) {
  const config = { ...model, schema: feedbackSchema, version: feedbackVersion, pageName, pageId: pageId ?? `${model.source ?? model.name}:${pageName}` };
  const script = [...pageMaths.map(fn => fn.toString()), auditionPage.toString(), 'auditionPage();'].join('\n');
  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="lmms-mcp build_audition_page" />
<title>${escapeHtml(model.title)}</title>
<style>${css}</style>
</head>
<body>${body}
<script type="application/json" id="audition-config">${scriptJson(config)}</script>
<script>
${script}
</script>
</body>
</html>
`;
}
// Every relative asset path the page loads, for checks.
export function pageAssets(model) {
  return [model.intro?.src, model.loop?.src, ...model.layers.map(layer => layer.src), ...model.stingers.map(stinger => stinger.src),
    ...model.compare.map(file => file.src), model.spectrogram].filter(Boolean);
}

// ---------- feedback ----------
const finite = value => typeof value === 'number' && Number.isFinite(value);
const cleanText = (value, max) => typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim().slice(0, max) : '';
const rating = value => Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
// Validate a feedback document saved or copied from an audition page and return a clean copy.
export function parseFeedback(input) {
  let data = input;
  if (typeof input === 'string') {
    try { data = JSON.parse(input.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch (error) { throw new Error('Feedback is not valid JSON: ' + error.message); }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Feedback must be a JSON object');
  if (data.schema !== feedbackSchema) throw new Error(`Expected schema "${feedbackSchema}", got ${JSON.stringify(data.schema)}`);
  if (data.version !== feedbackVersion) throw new Error(`Unsupported feedback version ${JSON.stringify(data.version)}; this server reads version ${feedbackVersion}`);
  if (!Array.isArray(data.notes)) throw new Error('Feedback has no notes array');
  const sections = (Array.isArray(data.sections) ? data.sections : []).filter(section => section && typeof section.name === 'string').map(section => ({
    name: cleanText(section.name, 60), startBar: finite(section.startBar) ? section.startBar : null, bars: finite(section.bars) ? section.bars : null,
    rating: rating(section.rating),
  }));
  const notes = data.notes.map((note, index) => {
    if (!note || typeof note !== 'object') throw new Error(`Note ${index + 1} is not an object`);
    if (!finite(note.seconds) || note.seconds < 0) throw new Error(`Note ${index + 1} has no valid seconds`);
    const text = cleanText(note.text, 2000);
    if (!text && !rating(note.rating)) throw new Error(`Note ${index + 1} has neither text nor rating`);
    const out = { seconds: Number(note.seconds.toFixed(3)), bar: Number.isInteger(note.bar) && note.bar >= 0 ? note.bar : null,
      beat: Number.isInteger(note.beat) && note.beat >= 1 ? note.beat : null, section: typeof note.section === 'string' ? cleanText(note.section, 60) : null,
      text, rating: rating(note.rating) };
    if (note.mode === 'mix' || note.mode === 'layers') out.mode = note.mode;
    if (note.layers && typeof note.layers === 'object') {
      out.layers = Object.fromEntries(Object.entries(note.layers).slice(0, 12).map(([name, layer]) => [cleanText(name, 80),
        { db: finite(layer?.db) ? layer.db : 0, muted: layer?.muted === true, solo: layer?.solo === true }]));
    }
    if (typeof note.compare === 'string') out.compare = cleanText(note.compare, 4);
    return out;
  });
  return {
    schema: feedbackSchema, version: feedbackVersion, title: cleanText(data.title, 200) || null, source: typeof data.source === 'string' ? data.source : null,
    page: typeof data.page === 'string' ? data.page : null, files: Array.isArray(data.files) ? data.files.filter(file => typeof file === 'string') : [],
    bpm: finite(data.bpm) ? data.bpm : null, timeSignature: Array.isArray(data.timeSignature) ? data.timeSignature : null,
    introBars: finite(data.introBars) ? data.introBars : 0, savedAt: typeof data.savedAt === 'string' ? data.savedAt : null, sections, notes,
  };
}
// What the listener heard as a short phrase: which layers were muted or soloed, which A/B file.
function context(note) {
  const parts = [];
  if (note.compare) parts.push(`file ${note.compare}`);
  if (note.mode === 'mix') parts.push('full mix');
  if (note.layers) {
    const entries = Object.entries(note.layers);
    const solo = entries.filter(([, layer]) => layer.solo).map(([name]) => name);
    const muted = entries.filter(([, layer]) => layer.muted).map(([name]) => name);
    const moved = entries.filter(([, layer]) => layer.db !== 0).map(([name, layer]) => `${name} ${layer.db > 0 ? '+' : ''}${layer.db} dB`);
    if (solo.length) parts.push(`solo ${solo.join(', ')}`);
    else if (muted.length) parts.push(`muted ${muted.join(', ')}`);
    if (moved.length) parts.push(moved.join(', '));
  }
  return parts.join('; ');
}
// Group feedback by section and bar so an agent can turn each note into an edit at the right place.
export function organiseFeedback(feedback) {
  const sections = feedback.sections.map(section => ({ ...section, endBar: section.startBar !== null && section.bars !== null ? section.startBar + section.bars : null, notes: [] }));
  const outside = [];
  for (const note of feedback.notes) {
    const entry = { bar: note.bar, beat: note.beat, seconds: note.seconds, text: note.text, rating: note.rating, heard: context(note) || undefined };
    const home = sections.find(section => section.name === note.section) ??
      (note.bar !== null ? sections.find(section => section.startBar !== null && note.bar >= section.startBar && note.bar < section.endBar) : undefined);
    (home ? home.notes : outside).push(entry);
  }
  const byBar = {};
  for (const note of feedback.notes) if (note.bar !== null) (byBar[note.bar] ??= []).push(note.text || `rated ${note.rating}/5`);
  const ratings = [...sections.map(section => section.rating), ...feedback.notes.map(note => note.rating)].filter(value => value !== null);
  const lines = [];
  for (const section of sections) {
    if (section.rating === null && !section.notes.length) continue;
    const span = section.startBar !== null ? ` (bars ${section.startBar} to ${section.endBar !== null ? section.endBar - 1 : '?'})` : '';
    lines.push(`${section.name}${span}: ${section.rating !== null ? `rated ${section.rating}/5` : 'not rated'}${section.notes.length ? `, ${section.notes.length} note${section.notes.length === 1 ? '' : 's'}` : ''}`);
    for (const note of section.notes) lines.push(`  ${note.bar !== null ? `bar ${note.bar} beat ${note.beat}` : `${note.seconds} s`}: ${note.text}${note.rating ? ` [${note.rating}/5]` : ''}${note.heard ? ` (heard: ${note.heard})` : ''}`);
  }
  for (const note of outside) lines.push(`${note.bar !== null ? `bar ${note.bar} beat ${note.beat}` : `${note.seconds} s`}: ${note.text}${note.heard ? ` (heard: ${note.heard})` : ''}`);
  const weakest = sections.filter(section => section.rating !== null).sort((a, b) => a.rating - b.rating)[0];
  return {
    title: feedback.title, source: feedback.source, savedAt: feedback.savedAt, bpm: feedback.bpm, timeSignature: feedback.timeSignature,
    noteCount: feedback.notes.length, averageRating: ratings.length ? Number((ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(2)) : null,
    weakestSection: weakest ? { name: weakest.name, rating: weakest.rating } : null,
    sections, outsideSections: outside, byBar, summary: lines,
  };
}

// ---------- taste memory ----------
const normalise = text => text.toLowerCase().replace(/\s+/g, ' ').replace(/[.!]+$/, '').trim();
export function emptyTaste() { return { version: 1, entries: [] }; }
export function parseTaste(text) {
  const data = JSON.parse(text);
  if (!data || data.version !== 1 || !Array.isArray(data.entries)) throw new Error(`${tasteFile} is not a version 1 taste file`);
  return data;
}
// Add a preference, or return the existing one when the same words are already stored for that area.
export function addTaste(store, { text, area = 'general', source }, now = new Date().toISOString()) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('A preference needs some text');
  const existing = store.entries.find(entry => entry.area === area && normalise(entry.text) === normalise(clean));
  if (existing) return { store, entry: existing, added: false };
  const next = Math.max(0, ...store.entries.map(entry => Number(String(entry.id).replace(/^t/, '')) || 0)) + 1;
  const entry = { id: `t${next}`, area, text: clean, ...(source ? { source } : {}), addedAt: now };
  return { store: { ...store, entries: [...store.entries, entry] }, entry, added: true };
}
export function forgetTaste(store, ids) {
  const drop = new Set(ids);
  const missing = ids.filter(id => !store.entries.some(entry => entry.id === id));
  if (missing.length) throw new Error(`No taste entry with id ${missing.join(', ')}`);
  return { ...store, entries: store.entries.filter(entry => !drop.has(entry.id)) };
}
export function tasteByArea(store, area) {
  const entries = area ? store.entries.filter(entry => entry.area === area || entry.area === 'general') : store.entries;
  const grouped = {};
  for (const entry of entries) (grouped[entry.area] ??= []).push({ id: entry.id, text: entry.text });
  return grouped;
}

// ---------- tools ----------
const audioPath = /^(?:[a-z0-9][a-z0-9 _-]{0,79}\/)?[a-z0-9][a-z0-9 _-]{0,99}\.(wav|ogg)$/i;
const pngPath = /^(?:[a-z0-9][a-z0-9 _-]{0,79}\/)?[a-z0-9][a-z0-9 _-]{0,99}\.png$/i;
const jsonPath = /^(?:[a-z0-9][a-z0-9 _-]{0,79}\/)?[a-z0-9][a-z0-9 _.()-]{0,119}\.json$/i;

export function register({ tool, z, dsp, root, schemas, moduleGuidance }) {
  moduleGuidance.push(
    'Call get_taste before composing or mixing and follow the listener\'s stored preferences; save new ones with remember_taste when feedback states a lasting preference.',
    'Before asking the listener to judge music, run build_audition_page on the export folder (or on two renders to A/B them) and give them the page path; read their notes back with read_feedback.',
  );
  const inside = relative => {
    const full = path.resolve(root, relative);
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error('Expected a path inside the workspace');
    return full;
  };
  const regularFile = async (full, label, maxBytes) => {
    let info;
    try { info = await lstat(full); } catch { throw new Error(`${label} was not found in the workspace`); }
    if (!info.isFile()) throw new Error(`${label} is not a regular file`);
    if (maxBytes && info.size > maxBytes) throw new Error(`${label} is larger than ${Math.round(maxBytes / 1048576)} MiB`);
    return info;
  };
  // Write through a temporary name so a reader never sees half a file.
  const writeAtomic = async (full, text, overwrite) => {
    if (!overwrite) {
      try { await lstat(full); throw new Error(`${path.basename(full)} already exists; pass overwrite: true to replace it`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const temporary = full + '.tmp-' + process.pid;
    await writeFile(temporary, text);
    await rename(temporary, full);
  };
  const sectionSchema = z.object({ name: z.string().min(1).max(60), startBar: z.number().min(0), bars: z.number().min(0.25).optional() });

  tool('build_audition_page', 'Write a self-contained HTML page so a person can listen to and judge the music in seconds. Give either an export_game_audio folder (plays the intro into the loop gaplessly, with layer faders, mute and solo, stinger buttons and section jumps) or one to four workspace WAV or OGG files (played in sync and switched A/B at matched loudness). The listener rates sections and pins notes to the time, bar and layer state, then saves or copies feedback JSON for read_feedback. No network access; audio is referenced by relative path.', {
    folder: schemas.folderName.optional().describe('Folder written by export_game_audio. The page is written into it.'),
    manifest: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.manifest\.json$/i).optional().describe('Manifest in the folder. Needed only when the folder holds more than one.'),
    files: z.array(z.string().regex(audioPath)).min(1).max(4).optional().describe('Workspace WAV or OGG renders to compare, optionally one folder down. The page is written to the workspace root.'),
    sections: z.array(sectionSchema).max(32).optional().describe('Named sections in song bars counted from zero (the intro starts at bar 0). Lengths default to the next section.'),
    bpm: z.number().min(20).max(400).optional().describe('Tempo for bar display and sections when comparing files. A game folder uses its manifest tempo.'),
    timeSignature: z.tuple([z.number().int().min(1).max(32), z.number().int().min(1).max(32)]).optional(),
    spectrogram: z.string().regex(pngPath).optional().describe('Workspace PNG, for example from analyze_audio, shown under the player.'),
    title: z.string().min(1).max(120).optional(),
    output: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.html$/i).optional().describe('Page file name. Defaults to <name>-audition.html.'),
    overwrite: z.boolean().default(true).describe('Replace an existing page of the same name.'),
  }, async ({ folder, manifest: manifestName, files, sections, bpm, timeSignature, spectrogram, title, output, overwrite }) => {
    if (Boolean(folder) === Boolean(files)) throw new Error('Give either folder (an export_game_audio folder) or files (renders to compare), not both');
    if (manifestName && !folder) throw new Error('manifest needs folder');
    const pageDir = folder ? inside(folder) : root;
    const relativeTo = full => posix(path.relative(pageDir, full));
    let spectrogramSrc = null;
    if (spectrogram) {
      const full = inside(spectrogram);
      await regularFile(full, spectrogram, 32 * 1048576);
      spectrogramSrc = relativeTo(full);
    }
    let model;
    const notes = [];
    if (folder) {
      if (!manifestName) {
        let listing;
        try { listing = await readdir(pageDir); } catch { throw new Error(`Folder "${folder}" was not found in the workspace`); }
        const found = listing.filter(name => name.endsWith('.manifest.json'));
        if (found.length !== 1) throw new Error(found.length ? `Folder "${folder}" holds ${found.length} manifests; pass manifest: one of ${found.join(', ')}` : `Folder "${folder}" has no .manifest.json; run export_game_audio first`);
        manifestName = found[0];
      }
      const manifestPath = path.join(pageDir, manifestName);
      await regularFile(manifestPath, `${folder}/${manifestName}`, 4 * 1048576);
      let manifest;
      try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch (error) { throw new Error(`${manifestName} is not valid JSON: ${error.message}`); }
      if (bpm || timeSignature) notes.push('bpm and timeSignature come from the manifest for a game folder; the given values were ignored.');
      model = gameModel(manifest, { sections, title, spectrogram: spectrogramSrc, manifestFile: manifestName });
      for (const asset of pageAssets(model).filter(src => src !== spectrogramSrc)) await regularFile(path.join(pageDir, asset), `${folder}/${asset}`);
      if (model.warnings) notes.push(...model.warnings);
    } else {
      const measured = [];
      let sampleRate;
      for (const file of files) {
        const full = inside(file);
        await regularFile(full, file, 256 * 1048576);
        // Loudness comes from the WAV; an OGG is measured through a WAV of the same name beside it when there is one.
        const wavFull = /\.ogg$/i.test(file) ? full.replace(/\.ogg$/i, '.wav') : full;
        let lufs = null, frames = null;
        try {
          await regularFile(wavFull, file, 256 * 1048576);
          const audio = dsp.decodeWav(await readFile(wavFull));
          lufs = dsp.loudness(audio).integratedLufs;
          frames = audio.frames;
          sampleRate ??= audio.sampleRate;
        } catch {
          notes.push(`${file}: no WAV to measure, so its level is not matched.`);
        }
        measured.push({ src: relativeTo(full), lufs, frames });
      }
      const base = path.basename(files[0]).replace(/\.(wav|ogg)$/i, '');
      model = compareModel(measured, { sections, title, spectrogram: spectrogramSrc, bpm, timeSignature, sampleRate, name: files.length > 1 ? `${base}-ab` : base });
    }
    const pageName = output ?? `${model.name}-audition.html`;
    const html = renderPage(model, { pageName });
    const pagePath = path.join(pageDir, pageName);
    await writeAtomic(pagePath, html, overwrite);
    const relativePage = posix(path.relative(root, pagePath));
    return {
      page: relativePage, path: pagePath, url: 'file:///' + posix(pagePath).replace(/^\/+/, ''), bytes: Buffer.byteLength(html), kind: model.kind,
      title: model.title, sampleRate: model.sampleRate, bpm: model.bpm,
      ...(model.intro ? { intro: { src: model.intro.src, frames: model.intro.frames, bars: model.intro.bars } } : {}),
      ...(model.loop ? { loop: { src: model.loop.src, frames: model.loop.frames, bars: model.loop.bars, startBar: model.loop.startBar } } : {}),
      layers: model.layers.map(layer => layer.name), stingers: model.stingers.map(stinger => stinger.name),
      compare: model.compare.map(({ label, src, lufs, gainDb }) => ({ label, src, lufs, gainDb })),
      sections: model.sections, assets: pageAssets(model), feedbackFile: model.feedbackName,
      howToListen: 'Open the page in a browser. Opened from disk, it asks once for its folder (browsers block pages from reading files beside them); served over http it loads directly. The listener saves or copies feedback for read_feedback.',
      ...(notes.length ? { notes } : {}),
    };
  });

  tool('read_feedback', 'Read listener feedback saved or copied from an audition page and return it grouped by section and bar, with ratings, the weakest section and what the listener was hearing (layers muted or soloed, A/B file) for each note. Pass a workspace JSON file or the pasted text.', {
    file: z.string().regex(jsonPath).optional().describe('Feedback JSON in the workspace, optionally one folder down.'),
    text: z.string().min(2).max(1048576).optional().describe('Feedback JSON pasted from the page\'s Copy feedback button.'),
  }, async ({ file, text }) => {
    if (Boolean(file) === Boolean(text)) throw new Error('Give either file or text');
    let raw = text;
    if (file) {
      const full = inside(file);
      await regularFile(full, file, 4 * 1048576);
      raw = await readFile(full, 'utf8');
    }
    return { ...(file ? { file } : {}), ...organiseFeedback(parseFeedback(raw)) };
  });

  const tastePath = path.join(root, tasteFile);
  const loadTaste = async () => {
    let text;
    try { text = await readFile(tastePath, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return emptyTaste(); throw error; }
    return parseTaste(text);
  };
  tool('remember_taste', `Store a lasting listener preference in ${tasteFile} in the workspace, for example "leads too busy, keep melodies sparse" or "less reverb on drums". Later sessions read it with get_taste. Repeated wording is stored once. Pass forget with entry ids to remove preferences that no longer hold.`, {
    text: z.string().min(1).max(400).optional(),
    area: z.enum(tasteAreas).default('general').describe('What the preference is about: a track role, the mix, the arrangement, sound choice or general.'),
    source: z.string().max(200).optional().describe('Where it came from, for example a feedback file name.'),
    forget: z.array(z.string().regex(/^t\d{1,6}$/)).max(50).optional(),
  }, async ({ text, area, source, forget }) => {
    if (!text && !forget?.length) throw new Error('Give text to remember or forget ids to remove');
    let store = await loadTaste();
    if (forget?.length) store = forgetTaste(store, forget);
    let result;
    if (text) result = addTaste(store, { text, area, source });
    if (result) store = result.store;
    await writeAtomic(tastePath, JSON.stringify(store, null, 2) + '\n', true);
    return { file: tasteFile, ...(result ? { entry: result.entry, added: result.added } : {}), ...(forget?.length ? { forgotten: forget } : {}), count: store.entries.length };
  });
  tool('get_taste', `Read the listener's stored preferences from ${tasteFile}, grouped by area. Call this before composing or mixing. Pass area to get that area and the general entries.`, {
    area: z.enum(tasteAreas).optional(),
  }, async ({ area }) => {
    const store = await loadTaste();
    return { file: tasteFile, count: store.entries.length, preferences: tasteByArea(store, area),
      ...(store.entries.length ? {} : { note: 'No preferences stored yet. Use remember_taste when the listener states one.' }) };
  });
}
