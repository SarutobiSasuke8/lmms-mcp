// Timeline page: one song as a DAW-style view. Each stem is a lane with its waveform, above them a bar ruler,
// the sections and any DJ effects as blocks. Lanes play in sync with mute, solo and volume, a section can be looped,
// the finished mix can be switched in, and notes pinned to a bar can be copied back to the agent.
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { guessRole, relativeUrl, waveformPeaks } from './library-browser.mjs';

// "12_Conga Open.wav" -> { order: 12, name: "Conga Open" }
export function laneName(file) {
  const base = file.replace(/\.[^.]+$/, ''), match = /^(\d+)[_ -]+(.+)$/.exec(base);
  return match ? { order: Number(match[1]), name: match[2].replace(/_/g, ' ') } : { order: 1e6, name: base.replace(/_/g, ' ') };
}
// Lanes are coloured by family so drums, bass, harmony and leads can be told apart at a glance.
export function laneFamily(name, role) {
  const r = role ?? guessRole(name);
  if (['drums', 'kick', 'snare', 'hat', 'clap', 'cymbal', 'tom', 'percussion'].includes(r)) return 'drums';
  if (r === 'bass') return 'bass';
  if (['lead', 'counter', 'brass', 'vocal'].includes(r)) return 'lead';
  if (['texture', 'fx'].includes(r)) return 'texture';
  return 'harmony';
}
// Sections with every start and length filled in, clipped to the song.
export function layoutSections(sections = [], totalBars) {
  const sorted = sections.map(s => ({ ...s })).sort((a, b) => (a.startBar ?? 0) - (b.startBar ?? 0));
  let at = 0;
  return sorted.map((s, i) => {
    const startBar = s.startBar ?? at, next = sorted[i + 1]?.startBar;
    const bars = Math.max(0.25, Math.min(s.bars ?? (next !== undefined ? next - startBar : totalBars - startBar), totalBars - startBar));
    at = startBar + bars;
    return { name: s.name, startBar, bars };
  }).filter(s => s.startBar < totalBars);
}

const escapeForScript = text => text.replace(/</g, '\\u003c');
export function timelineHtml({ title, bpm, bars, seconds, lanes, mix, sections, effects, generated }) {
  const data = escapeForScript(JSON.stringify({ title, bpm, bars, seconds, lanes, mix, sections, effects, generated }));
  const safeTitle = title.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
:root{--bg:#f6f5f1;--panel:#fff;--ink:#1c1b19;--muted:#6b675f;--line:#dedbd3;--accent:#b4441f;--accent-ink:#fff;--lane:#efece5;--drums:#b4441f;--bass:#2d6a8f;--harmony:#5b7a2e;--lead:#8a4fb0;--texture:#a07a16;--fxc:#1f8a80}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151412;--panel:#1e1d1a;--ink:#ece9e2;--muted:#a09a8e;--line:#34322d;--accent:#e8794f;--accent-ink:#1a1206;--lane:#23211e;--drums:#e8794f;--bass:#6fb3dc;--harmony:#a3c66b;--lead:#c79be6;--texture:#e0bc55;--fxc:#5fd0c5}}
:root[data-theme="dark"]{--bg:#151412;--panel:#1e1d1a;--ink:#ece9e2;--muted:#a09a8e;--line:#34322d;--accent:#e8794f;--accent-ink:#1a1206;--lane:#23211e;--drums:#e8794f;--bass:#6fb3dc;--harmony:#a3c66b;--lead:#c79be6;--texture:#e0bc55;--fxc:#5fd0c5}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.4 system-ui,"Segoe UI",sans-serif}
header{position:sticky;top:0;z-index:6;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 16px}
h1{font-size:18px;margin:0 0 8px;letter-spacing:-.01em}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
button,select{font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:7px 11px;cursor:pointer}
button.on{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
#play{background:var(--accent);color:var(--accent-ink);border-color:var(--accent);min-width:56px;font-size:16px}
.clock{font:600 17px/1 ui-monospace,Consolas,monospace;font-variant-numeric:tabular-nums;min-width:15ch}
.hint{color:var(--muted);font-size:12.5px}
.board{display:grid;grid-template-columns:250px minmax(0,1fr);margin:0 16px 24px;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--panel)}
.side,.track{border-bottom:1px solid var(--line);min-height:44px}
.side{padding:5px 8px;display:flex;align-items:center;gap:6px;border-right:1px solid var(--line);border-left:4px solid var(--c,var(--line))}
.side .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:13px}
.side button{padding:2px 7px;border-radius:6px;font-size:12px;min-width:26px}.side button.m.on{background:#8a8275;border-color:#8a8275;color:#fff}.side button.s.on{background:var(--good,#2e7d4f);border-color:transparent;color:#fff}
.side input{width:46px;accent-color:var(--accent)}
.track{position:relative;background:var(--lane);cursor:pointer;overflow:hidden}.track svg{display:block;width:100%;height:44px}.track.dim svg{opacity:.25}
.ruler{height:26px;font-size:11px;color:var(--muted)}.ruler span{position:absolute;top:6px;transform:translateX(3px)}.ruler i{position:absolute;top:0;bottom:0;width:1px;background:var(--line)}
.blocks{height:26px}.blocks div{position:absolute;top:3px;bottom:3px;border-radius:5px;padding:1px 6px;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#fff}
.blocks.sec div{background:var(--bass);cursor:pointer}.blocks.sec div:nth-child(even){background:var(--lead)}.blocks.sec div.on{outline:2px solid var(--ink);outline-offset:-2px}
.blocks.fx div{background:var(--fxc);color:#06201d}
.label{font-size:12px;color:var(--muted);font-weight:600}
#head{position:absolute;top:0;bottom:0;width:2px;background:var(--accent);pointer-events:none;z-index:4;left:250px}
.wrap{position:relative}
.notes{margin:0 16px 40px}.notes li{margin:4px 0}.notes button{padding:1px 8px;font-size:12px;margin-left:8px}
textarea{width:100%;min-height:54px;font:inherit;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px}
@media (max-width:700px){.board{grid-template-columns:120px minmax(0,1fr)}#head{left:120px}.side input{display:none}}
</style></head><body>
<header><h1>${safeTitle}</h1>
<div class="row"><button id="play" type="button" title="Play or pause (space)">▶</button><button id="start" type="button" title="Back to the start">⏮</button>
<span class="clock" id="clock">bar 1 · 0:00.0</span>
<button id="mode" type="button" title="Switch between the separate stems and the finished mix">Stems</button>
<select id="loop" title="Repeat one section"><option value="">Loop: off</option></select>
<button id="unsolo" type="button">Clear mute and solo</button><button id="note" type="button" title="Pin a note to the bar under the playhead (n)">Add note here</button>
<span class="hint" id="status"></span></div></header>
<div class="wrap"><div id="head"></div><div class="board" id="board"></div></div>
<div class="notes"><h2 style="font-size:15px;margin:0 0 6px">Notes for the next version</h2><ul id="notes"></ul>
<div class="row"><button id="copy" type="button">Copy notes</button><span class="hint">Each note is pinned to a bar and records which lanes were soloed or muted. Paste them to the agent.</span></div></div>
<script id="data" type="application/json">${data}</script>
<script>
(function(){
var D=JSON.parse(document.getElementById('data').textContent),$=function(id){return document.getElementById(id)};
var barSeconds=240/D.bpm,total=D.seconds,board=$('board'),state={mode:D.lanes.length?'stems':'mix',loop:null,notes:[]};
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
function pct(seconds){return (seconds/total*100)+'%'}
function addRow(label,cls){var side=el('div','side');side.appendChild(el('span','label',label));var track=el('div','track '+cls);board.appendChild(side);board.appendChild(track);return track}
var ruler=addRow('Bars','ruler'),step=D.bars>64?8:D.bars>24?4:D.bars>12?2:1;
for(var b=0;b<D.bars;b+=step){var mark=el('i');mark.style.left=pct(b*barSeconds);ruler.appendChild(mark);var n=el('span','',String(b+1));n.style.left=pct(b*barSeconds);ruler.appendChild(n)}
if(D.sections.length){var secRow=addRow('Sections','blocks sec');D.sections.forEach(function(s,i){var d=el('div','',s.name);d.style.left=pct(s.startBar*barSeconds);d.style.width=pct(s.bars*barSeconds);d.title=s.name+': bars '+(s.startBar+1)+' to '+(s.startBar+s.bars)+'. Click to jump, double-click to loop.';
  d.onclick=function(e){e.stopPropagation();seek(s.startBar*barSeconds)};d.ondblclick=function(e){e.stopPropagation();$('loop').value=String(i);$('loop').onchange()};secRow.appendChild(d);
  var o=el('option','',s.name);o.value=String(i);$('loop').appendChild(o)})}
if(D.effects.length){var fxRow=addRow('DJ effects','blocks fx');D.effects.forEach(function(e){var d=el('div','',e.type.replace(/_/g,' '));d.style.left=pct(e.startBar*barSeconds);d.style.width='max('+pct(e.bars*barSeconds)+',10px)';d.title=e.type+' at bar '+(e.startBar+1)+' for '+e.bars+' bars'+(e.detail?': '+e.detail:'');fxRow.appendChild(d)})}
function wave(peaks,color){var NS='http://www.w3.org/2000/svg',s=document.createElementNS(NS,'svg');s.setAttribute('viewBox','0 0 '+peaks.length+' 100');s.setAttribute('preserveAspectRatio','none');
  var top='',bottom='';for(var i=0;i<peaks.length;i++){var h=Math.max(peaks[i],.6)/2;top+=(i?'L':'M')+i+' '+(50-h)+' ';bottom='L'+i+' '+(50+h)+' '+bottom}
  var p=document.createElementNS(NS,'path');p.setAttribute('d',top+bottom+'Z');p.setAttribute('fill',color);s.appendChild(p);return s}
var players=[];
function addLane(lane,isMix){
  var side=el('div','side');side.style.setProperty('--c','var(--'+(isMix?'accent':lane.family)+')');side.appendChild(el('span','name',lane.name));side.title=lane.name;
  var track=el('div','track');track.appendChild(wave(lane.peaks,'var(--'+(isMix?'accent':lane.family)+')'));
  var p={lane:lane,isMix:isMix,audio:new Audio(lane.url),mute:false,solo:false,volume:1,track:track};p.audio.preload='auto';
  if(!isMix){var m=el('button','m','M');m.type='button';m.title='Mute';m.onclick=function(){p.mute=!p.mute;m.classList.toggle('on',p.mute);levels()};
    var so=el('button','s','S');so.type='button';so.title='Solo';so.onclick=function(){p.solo=!p.solo;so.classList.toggle('on',p.solo);levels()};
    var v=el('input');v.type='range';v.min=0;v.max=100;v.value=100;v.title='Volume';v.oninput=function(){p.volume=v.value/100;levels()};
    side.appendChild(m);side.appendChild(so);side.appendChild(v);p.buttons=[m,so]}
  board.appendChild(side);board.appendChild(track);players.push(p)}
if(D.mix)addLane(D.mix,true);
D.lanes.forEach(function(l){addLane(l,false)});
function levels(){var anySolo=players.some(function(p){return p.solo});
  players.forEach(function(p){var on=p.isMix?state.mode==='mix':state.mode==='stems'&&!p.mute&&(!anySolo||p.solo);p.audio.volume=on?p.volume:0;p.track.classList.toggle('dim',!on)});
  $('mode').textContent=state.mode==='mix'?'Finished mix':'Stems';$('mode').classList.toggle('on',state.mode==='mix')}
var playing=false,lastSync=0;
function clock(){var live=players.filter(function(p){return p.audio.readyState>0});return live.length?live[0].audio.currentTime:0}
function seek(t){t=Math.max(0,Math.min(total-.05,t));players.forEach(function(p){try{p.audio.currentTime=t}catch(e){}});paint()}
function play(){var t=clock();players.forEach(function(p){try{p.audio.currentTime=t}catch(e){}});playing=true;
  // A pause that arrives while a lane is still starting rejects its play() with AbortError; only real failures are reported.
  players.forEach(function(p){p.audio.play().catch(function(e){if(e&&e.name!=='AbortError')$('status').textContent='"'+p.lane.name+'" could not play. Open this page through the library server (node library-server.mjs).'})});
  lastSync=performance.now()-1100;$('play').textContent='⏸'}
function pause(){playing=false;players.forEach(function(p){p.audio.pause()});$('play').textContent='▶'}
function paint(){var t=clock(),head=$('head'),first=board.querySelector('.track'),box=first.getBoundingClientRect(),wrap=head.parentNode.getBoundingClientRect();
  head.style.left=(box.left-wrap.left+box.width*Math.min(1,t/total))+'px';
  var tenths=Math.floor(t*10)%10,sec=Math.floor(t)%60,min=Math.floor(t/60);$('clock').textContent='bar '+(Math.floor(t/barSeconds)+1)+' · '+min+':'+(sec<10?'0':'')+sec+'.'+tenths}
function frame(now){if(playing){var t=clock();
    if(state.loop&&t>=(state.loop.startBar+state.loop.bars)*barSeconds)seek(state.loop.startBar*barSeconds);
    else if(t>=total-.06){pause();seek(0)}
    // Separate audio elements drift a little, so pull any lane that has wandered back to the first one.
    if(now-lastSync>1500){lastSync=now;players.forEach(function(p){if(Math.abs(p.audio.currentTime-t)>.045)try{p.audio.currentTime=t}catch(e){}})}}
  paint();requestAnimationFrame(frame)}
board.addEventListener('click',function(e){var track=e.target.closest('.track');if(!track)return;var r=track.getBoundingClientRect();seek((e.clientX-r.left)/r.width*total)});
$('play').onclick=function(){if(playing)pause();else play()};$('start').onclick=function(){seek(0)};
$('mode').onclick=function(){if(!D.mix||!D.lanes.length)return;state.mode=state.mode==='mix'?'stems':'mix';levels()};
$('loop').onchange=function(){state.loop=this.value===''?null:D.sections[Number(this.value)];var blocks=document.querySelectorAll('.blocks.sec div');for(var i=0;i<blocks.length;i++)blocks[i].classList.toggle('on',String(i)===this.value);if(state.loop)seek(state.loop.startBar*barSeconds)};
$('unsolo').onclick=function(){players.forEach(function(p){p.mute=p.solo=false;if(p.buttons)p.buttons.forEach(function(b){b.classList.remove('on')})});levels()};
function sectionAt(bar){for(var i=0;i<D.sections.length;i++){var s=D.sections[i];if(bar>=s.startBar&&bar<s.startBar+s.bars)return s.name}return null}
function drawNotes(){var list=$('notes');list.innerHTML='';if(!state.notes.length)list.appendChild(el('li','hint','No notes yet. Stop where something is wrong and press "Add note here".'));
  state.notes.forEach(function(n,i){var li=el('li','','Bar '+n.bar+(n.section?' ('+n.section+')':'')+': '+n.text+(n.solo.length?'  [solo: '+n.solo.join(', ')+']':''));
    var go=el('button','','Go');go.type='button';go.onclick=function(){seek((n.bar-1)*barSeconds)};var x=el('button','','Remove');x.type='button';x.onclick=function(){state.notes.splice(i,1);store();drawNotes()};li.appendChild(go);li.appendChild(x);list.appendChild(li)})}
var storeKey='lmms-timeline-notes:'+D.title;
function store(){try{localStorage.setItem(storeKey,JSON.stringify(state.notes))}catch(e){}}
try{state.notes=JSON.parse(localStorage.getItem(storeKey)||'[]')}catch(e){}
$('note').onclick=function(){var was=playing;pause();var bar=Math.floor(clock()/barSeconds)+1,text=window.prompt('Note for bar '+bar+' (what is wrong or what you want):');
  if(text&&text.trim()){state.notes.push({bar:bar,section:sectionAt(bar-1),text:text.trim(),mode:state.mode,solo:players.filter(function(p){return p.solo}).map(function(p){return p.lane.name}),muted:players.filter(function(p){return p.mute}).map(function(p){return p.lane.name})});
    state.notes.sort(function(a,b){return a.bar-b.bar});store();drawNotes()}if(was)play()};
$('copy').onclick=function(){var text=JSON.stringify({track:D.title,bpm:D.bpm,notes:state.notes},null,1),done=function(){$('status').textContent=state.notes.length+' notes copied.'};
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(text).then(done,function(){window.prompt('Copy your notes:',text)});else window.prompt('Copy your notes:',text)};
document.addEventListener('keydown',function(e){if(e.target&&/INPUT|SELECT|TEXTAREA/.test(e.target.tagName))return;
  if(e.key===' '){e.preventDefault();$('play').onclick()}else if(e.key==='n'){$('note').onclick()}
  else if(e.key==='ArrowRight'){e.preventDefault();seek(clock()+barSeconds)}else if(e.key==='ArrowLeft'){e.preventDefault();seek(clock()-barSeconds)}});
$('status').textContent=D.lanes.length+' lanes · '+D.bars+' bars at '+D.bpm+' bpm · built '+D.generated+'. Arrow keys move one bar.';
levels();drawNotes();requestAnimationFrame(frame);
})();
</script></body></html>
`;
}

export function register({ tool, z, dsp, root, schemas, project, moduleGuidance }) {
  moduleGuidance.push('To show a person a whole song the way a DAW would, call build_timeline_page after render_stems: every stem becomes a lane with its waveform under a bar ruler, sections and DJ effects are drawn as blocks, lanes play in sync with mute and solo, and the listener can pin notes to bars and paste them back.');
  tool('build_timeline_page', 'Write a self-contained HTML timeline of one song: each stem from a render_stems folder is a lane with its waveform, under a bar ruler, the sections and any DJ effects. Lanes play in sync with mute, solo and volume, a section can be looped, the finished mix can be switched in, and notes pinned to bars can be copied back as JSON. Audio is referenced by relative path.', {
    stems: schemas.folderName.optional().describe('Folder written by render_stems. One lane per WAV.'),
    mix: schemas.workspaceWav.optional().describe('The finished mix, shown as the top lane and playable in place of the stems.'),
    bpm: z.number().min(40).max(260),
    sections: z.array(schemas.section).max(64).default([]).describe('Section names with startBar and bars, counted from zero.'),
    effects: z.array(z.object({ type: z.string().min(1).max(40), startBar: z.number().min(0), bars: z.number().min(1 / 64) }).passthrough()).max(200).default([])
      .describe('The effects list that was passed to dj_effects, to draw them on the timeline.'),
    project: schemas.projectName.optional().describe('The project the stems came from. Used to colour lanes by track role.'),
    title: z.string().min(1).max(80).default('Timeline'),
    output: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}\.html$/i),
    overwrite: z.boolean().default(false),
  }, async ({ stems, mix, bpm, sections, effects, project: projectName, title, output, overwrite }) => {
    if (!stems && !mix) throw new Error('Give a stems folder, a mix, or both');
    const target = path.join(root, output);
    if (!overwrite && existsSync(target)) throw new Error('Output already exists. Pass overwrite: true to rebuild it.');
    const roles = {};
    if (projectName) {
      const doc = await project.load(projectName);
      for (const t of project.tracks(doc)) { const role = project.trackRole(t); if (role) roles[t.getAttribute('name')] = role; }
    }
    const read = async relative => {
      const full = path.join(root, relative), info = await lstat(full).catch(() => null);
      if (!info?.isFile()) throw new Error(`"${relative}" was not found in the workspace`);
      if (info.size > 256 * 1024 * 1024) throw new Error(`"${relative}" is larger than 256 MiB`);
      return dsp.decodeWav(await readFile(full));
    };
    let seconds = 0;
    const lanes = [];
    if (stems) {
      const files = (await readdir(path.join(root, stems)).catch(() => { throw new Error(`Folder "${stems}" was not found in the workspace`); })).filter(f => /\.wav$/i.test(f) && !/^mix\.wav$/i.test(f));
      if (!files.length) throw new Error(`Folder "${stems}" holds no WAV stems`);
      if (files.length > 64) throw new Error('A timeline shows at most 64 lanes');
      const points = Math.round(Math.min(2400, Math.max(600, 16 * 60)));
      for (const file of files) {
        const audio = await read(`${stems}/${file}`), named = laneName(file);
        seconds = Math.max(seconds, audio.frames / audio.sampleRate);
        let peak = 0;
        for (const ch of audio.channels) for (let i = 0; i < ch.length; i += 16) peak = Math.max(peak, Math.abs(ch[i]));
        lanes.push({ ...named, family: laneFamily(named.name, roles[named.name]), url: relativeUrl(`${stems}/${file}`), peaks: waveformPeaks(audio, points), silent: peak < 1e-4 });
      }
      lanes.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    }
    let mixLane = null;
    if (mix) {
      const audio = await read(mix);
      seconds = Math.max(seconds, audio.frames / audio.sampleRate);
      mixLane = { name: 'Finished mix', family: 'harmony', url: relativeUrl(mix), peaks: waveformPeaks(audio, 1600) };
    }
    const bars = Math.max(1, Math.round(seconds / (240 / bpm) * 100) / 100), wholeBars = Math.ceil(bars - 0.01);
    const laid = layoutSections(sections, wholeBars);
    const drawn = effects.map(({ type, startBar, bars: length, ...rest }) => ({ type, startBar, bars: length, detail: Object.entries(rest).map(([k, v]) => `${k} ${v}`).join(', ') })).filter(e => e.startBar < wholeBars);
    const html = timelineHtml({ title, bpm, bars: wholeBars, seconds: Number(seconds.toFixed(3)), lanes: lanes.map(({ order, silent, ...lane }) => lane), mix: mixLane, sections: laid, effects: drawn, generated: new Date().toISOString().slice(0, 10) });
    await writeFile(target, html, { flag: overwrite ? 'w' : 'wx' });
    return { page: output, path: target, lanes: lanes.length, silentLanes: lanes.filter(l => l.silent).map(l => l.name), bars: wholeBars, seconds: Number(seconds.toFixed(2)), sections: laid.length, effects: drawn.length,
      next: 'Open the page through the library server (node library-server.mjs) or straight from disk. Paste "Copy notes" back to act on the listener\'s bar-by-bar feedback.' };
  });
}
