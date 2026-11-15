import { createSession, defaultChannel, insertTypes, normalizeSession, samplePath, idPattern } from './state.mjs';
import { createAudioDesk, wave } from './engine.mjs';
import {decodeMidi} from './live.mjs';

const byId = id => document.getElementById(id);
const storage = 'lmms-mix-desk/1:session';
const cap = (value, min, max) => Math.min(max, Math.max(min, value));
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function say(message, error = false) {
  byId('status').textContent = message;
  byId('status').toggleAttribute('data-error', error);
}
function checked(action) {
  return async (...args) => {
    try { await action(...args); }
    catch (error) { say(error.message || 'The action could not finish.', true); }
  };
}
function restore() {
  try { return normalizeSession(JSON.parse(sessionStorage.getItem(storage))); }
  catch { return createSession(); }
}
let state = restore(), selected = 0, desk, loadingDesk, playing = false;
let rows = [], facets = [], drag = null;
let inputDevice = '', outputDevice = '', tuning = false, midiAccess, learning = false, learnTarget;
const pressedMidi = new Set(), playedMidi = new Map();
const pendingTakes = new Set();
const history = Array.from({ length: 8 }, () => []);
const metering = Array(8);
const current = () => state.channels[selected];
function controlKey(control) {
  if (control.id) return 'id:' + control.id;
  const area=control.closest('#channels,#loop-controls,#master-controls,#rack,#input-controls');
  if (!area) return null;
  const prefix=['loop-controls','rack','input-controls'].includes(area.id) ? `${area.id}/${selected}` : area.id;
  return prefix + '/' + [...area.querySelectorAll('button,input,select')].indexOf(control);
}
function applyMapping(control,midi) {
  if (control.type==='range' || control.type==='number') {
    const min=Number(control.min)||0,max=Number(control.max)||127,step=Number(control.step)||1;
    const value=Math.min(max,Math.max(min,min+Math.round((max-min)*midi.value/step)*step));
    const str=String(Number(value.toFixed(4)));
    if (control.value !== str) {
      control.value = str;
      control.dispatchEvent(new Event('input',{bubbles:true}));
      control.dispatchEvent(new Event('change',{bubbles:true}));
    }
    return;
  }
  if (control.tagName==='SELECT') {
    const index=Math.round(midi.value*Math.max(0,control.options.length-1));
    if (index!==control.selectedIndex) { control.selectedIndex=index;control.dispatchEvent(new Event('change',{bubbles:true})); }
    return;
  }
  const signature=`${midi.type}:${midi.channel}:${midi.number}`;
  if (midi.value < 0.5) { pressedMidi.delete(signature); return; }
  if (!pressedMidi.has(signature)) { pressedMidi.add(signature); control.click(); }
}
async function onMidi(event) {
  const midi=decodeMidi(event.data ?? []);
  if (!midi) return;
  if (learning) {
    if (!learnTarget || !midi.value) return;
    state.midi=state.midi.filter(entry=>entry.control!==learnTarget && !(entry.type===midi.type && entry.channel===midi.channel && entry.number===midi.number));
    state.midi.push({type:midi.type,channel:midi.channel,number:midi.number,control:learnTarget});
    learning=false; learnTarget=null;
    byId('midi-learn').setAttribute('aria-pressed','false');
    byId('midi-state').textContent=`${state.midi.length} mapped`;
    persist(); say('MIDI mapping saved with the session.'); return;
  }
  const match=state.midi.find(entry=>entry.type===midi.type&&entry.channel===midi.channel&&entry.number===midi.number);
  if (match) {
    const control=[...document.querySelectorAll('button,input,select')].find(node=>controlKey(node)===match.control);
    if (control && !control.disabled) applyMapping(control,midi);
    return;
  }
  if (midi.type !== 'note') return;
  const key=`${midi.channel}:${midi.number}`;
  if (!midi.value) {
    if (playedMidi.has(key)) { desk?.playMidi(playedMidi.get(key),midi.number,0); playedMidi.delete(key); }
    return;
  }
  const index=current().source?.type==='instrument' ? selected : state.channels.findIndex(channel=>channel.source?.type==='instrument');
  if (index>=0) { const audio=await getDesk(); audio.playMidi(index,midi.number,midi.value);playedMidi.set(key,index); }
}
function hookMidi() {
  for (const input of midiAccess.inputs.values()) input.onmidimessage=checked(onMidi);
  byId('midi-state').textContent=`${midiAccess.inputs.size} inputs · ${state.midi.length} mapped`;
}
function chooseLearnTarget(event) {
  if (!learning) return;
  const control=event.target.closest?.('button,input,select');
  if (!control || ['midi-learn','midi-connect','clear-midi'].includes(control.id) || control.closest('#device-dialog [method=dialog]')) return;
  const key=controlKey(control);
  if (!key) return;
  event.preventDefault(); event.stopPropagation();
  learnTarget=key;
  say('Move the MIDI control to assign it.');
}
document.addEventListener('click',chooseLearnTarget,true);
document.addEventListener('keydown',event=>{if(event.key==='Enter')chooseLearnTarget(event);},true);
async function deviceList() {
  if (!navigator.mediaDevices) throw new Error('This browser does not expose local devices.');
  const devices=await navigator.mediaDevices.enumerateDevices();
  for (const [kind,id,selectedId] of [['audioinput','input-device',inputDevice],['audiooutput','output-device',outputDevice]]) {
    const select=byId(id);
    const matches=devices.filter(device=>device.kind===kind&&device.deviceId&&device.deviceId!=='default');
    selectValues(select,matches.map((device,i)=>[device.deviceId,device.label||`${kind==='audioinput'?'Input':'Output'} ${i+1}`]),'System default');
    select.value=matches.some(device=>device.deviceId===selectedId)?selectedId:'';
  }
}

function persist() {
  desk?.setSession(state);
  try { sessionStorage.setItem(storage, JSON.stringify(state)); } catch { /* Session files remain available. */ }
}
async function getDesk() {
  if (!loadingDesk) {
    loadingDesk = createAudioDesk(state).then(async audio => {
      await Promise.all(state.channels.map(async (channel, index) => {
        if (!channel.source) return;
        try { await audio.load(index, channel.source); }
        catch (error) { say(error.message, true); }
      }));
      desk = audio;
      return audio;
    }).catch(error => { loadingDesk = null; throw error; });
  }
  const audio = await loadingDesk;
  await audio.context.resume();
  return audio;
}
function action(text, callback, pressed) {
  const button = element('button', text);
  button.type = 'button';
  if (pressed !== undefined) button.setAttribute('aria-pressed', pressed);
  button.addEventListener('click', checked(callback));
  return button;
}
function slider(label, value, min, max, step, callback, display = x => String(x)) {
  const control = element('label'), caption = element('span'), input = element('input');
  input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = value;
  input.setAttribute('aria-label', label);
  const text = inputValue => { caption.textContent = `${label} ${display(Number(inputValue))}`; };
  text(value);
  input.addEventListener('input', () => { text(input.value); callback(Number(input.value)); });
  control.append(caption, input);
  return control;
}
function selectValues(select, choices, first) {
  const current = select.value;
  select.replaceChildren();
  for (const [value, label] of first ? [['', first], ...choices] : choices) {
    const option = element('option', label); option.value = value; select.append(option);
  }
  if ([...select.options].some(option => option.value === current)) select.value = current;
}
const pct = value => `${Math.round(value * 100)}%`;
const dbText = value => `${value > 0 ? '+' : ''}${value} dB`;
function renderMixer() {
  const mixer = byId('channels'); mixer.replaceChildren();
  state.channels.forEach((channel, index) => {
    const strip = element('article', undefined, 'channel');
    strip.toggleAttribute('data-selected', selected === index);
    const head = action(String(index + 1).padStart(2, '0'), () => { selected = index; draw(); });
    head.className = 'number';
    head.setAttribute('aria-label', `Select channel ${index + 1}`);
    const name = pendingTakes.has(index) ? 'Unsaved take' : channel.source?.name ?? channel.source?.id ?? 'Empty';
    const source = element('span', name, 'name'); source.title = name;
    const fader = element('div', undefined, 'fader');
    fader.append(slider(`Gain ${index + 1}`, channel.gain, 0, 2, 0.01, value => { channel.gain = value; persist(); }, pct));
    const meter = element('div', undefined, 'meter');
    meter.setAttribute('role', 'meter'); meter.setAttribute('aria-label', `Channel ${index + 1} peak`);
    meter.setAttribute('aria-valuemin', '0'); meter.setAttribute('aria-valuemax', '100'); meter.setAttribute('aria-valuenow', '0');
    const fill = element('span'); meter.append(fill); metering[index] = { meter, fill }; fader.append(meter);
    const footer = element('footer');
    for (const [id, label] of [['mute', 'M'], ['solo', 'S']]) {
      const button = action(label, () => { channel[id] = !channel[id]; persist(); draw(); }, channel[id]);
      button.setAttribute('aria-label', `${id} channel ${index + 1}`); footer.append(button);
    }
    strip.append(head, source, fader, footer, slider(`Pan ${index + 1}`, channel.pan, -1, 1, .01, value => {
      channel.pan = value; persist();
    }, value => value === 0 ? 'C' : `${value < 0 ? 'L' : 'R'}${Math.round(Math.abs(value) * 100)}`));
    mixer.append(strip);
  });
}
function renderMaster() {
  const controls = byId('master-controls'); controls.replaceChildren();
  for (const [key, title, min, max, step, format] of [
    ['gain','Level',0,2,.01,pct],['low','Low',-18,18,1,dbText],['mid','Mid',-18,18,1,dbText],
    ['high','High',-18,18,1,dbText],['ceiling','Ceiling',-12,0,.1,dbText],['width','Width',0,2,.01,pct]
  ]) {
    controls.append(slider(title, state.master[key], min, max, step, value => { state.master[key] = value; persist(); }, format));
  }
  controls.append(action('Glue', () => { state.master.glue = !state.master.glue; persist(); renderMaster(); }, state.master.glue));
}
function reorder(from, to) {
  const inserts = current().inserts;
  if (from === to || from < 0 || to < 0 || to >= inserts.length) return;
  const [effect] = inserts.splice(from, 1); inserts.splice(to, 0, effect);
  persist(); renderRack();
}
function renderRack() {
  const rack = byId('rack'); rack.replaceChildren();
  current().inserts.forEach((effect, index) => {
    const item = element('li', undefined, 'insert'), header = element('div', undefined, 'section-heading');
    const controls = element('div', undefined, 'controls');
    item.draggable = true;
    item.addEventListener('dragstart', event => { drag = index; event.dataTransfer.setData('text/plain', String(index)); });
    item.addEventListener('dragover', event => { event.preventDefault(); item.setAttribute('aria-current','true'); });
    item.addEventListener('dragleave', () => item.removeAttribute('aria-current'));
    item.addEventListener('dragend', () => { drag = null; item.removeAttribute('aria-current'); });
    item.addEventListener('drop', event => { event.preventDefault(); if (drag !== null) reorder(drag, index); drag = null; item.removeAttribute('aria-current'); });
    const group = element('div', undefined, 'controls');
    const up = action('↑', () => reorder(index, index - 1));
    up.setAttribute('aria-label', 'Move insert up'); up.disabled = index === 0;
    const down = action('↓', () => reorder(index, index + 1));
    down.setAttribute('aria-label', 'Move insert down'); down.disabled = index === current().inserts.length - 1;
    group.append(up, down, action('Bypass', () => { effect.bypass = !effect.bypass; persist(); renderRack(); }, effect.bypass),
      action('Remove', () => { current().inserts.splice(index, 1); persist(); renderRack(); }));
    header.append(element('strong', effect.type), group);
    if (effect.type === 'eq') {
      const names = ['HP','Low','Mid','High','LP'];
      for (const [idx, min, max, step] of [[0,20,1500,1],[1,-18,18,1],[2,-18,18,1],[3,-18,18,1],[4,900,20000,1]]) {
        controls.append(slider(names[idx], effect.eq[idx], min, max, step, value => { effect.eq[idx] = value; persist(); },
          idx === 0 || idx === 4 ? value => `${value} Hz` : dbText));
      }
    } else {
      controls.append(slider(effect.type === 'filter' ? 'Sweep' : 'Amount', effect.amount, 0, 1, .01, value => { effect.amount = value; persist(); }, pct));
    }
    controls.append(slider('Wet', effect.wet, 0, 1, .01, value => { effect.wet = value; persist(); }, pct));
    item.append(header, controls); rack.append(item);
  });
  byId('insert-type').disabled = current().inserts.length >= 14;
}
function renderInspector() {
  const channel = current(), index = selected;
  byId('selected').textContent = `Channel ${index + 1}`;
  byId('current-source').textContent = pendingTakes.has(index) ? 'Unsaved recording' : channel.source?.name ?? channel.source?.id ?? 'Empty channel';
  byId('save-take').disabled = !pendingTakes.has(index);
  byId('undo').disabled = !history[index].length;
  const live = byId('input-controls'); live.replaceChildren();
  const inputLabel=element('label','Input channel'), channelInput=element('select');
  selectValues(channelInput,Array.from({length:8},(_,i)=>[String(i+1),String(i+1)]));
  channelInput.value=channel.input;
  channelInput.addEventListener('change',checked(async ()=>{
    channel.input=Number(channelInput.value);
    persist(); if (desk && channel.monitor) await desk.setInputMonitoring(state,inputDevice);
  }));
  inputLabel.append(channelInput);
  live.append(inputLabel,slider('Input gain',channel.inputGain,0,4,.01,value=>{channel.inputGain=value;persist();},pct),
    action('Monitor',async ()=>{
      const previous=channel.monitor;
      const audio=await getDesk();
      channel.monitor=!previous;
      try { await audio.setInputMonitoring(state,inputDevice); }
      catch(error) { channel.monitor=previous; throw error; }
      persist(); renderInspector();
    },channel.monitor));
  const controls = byId('loop-controls'); controls.replaceChildren();
  async function cue() { if (playing && desk?.buffer(index)) await desk.playOne(index, state); }
  for (const [key,label] of [['reverb','Reverb send'],['delay','Delay send'],['start','Trim in'],['end','Trim out']]) {
    const item = slider(label, channel[key], 0, 1, .01, value => {
      channel[key] = key === 'start' ? Math.min(value, channel.end - .01) : key === 'end' ? Math.max(value, channel.start + .01) : value;
      persist();
    }, pct);
    if (key === 'start' || key === 'end') item.querySelector('input').addEventListener('change', checked(cue));
    controls.append(item);
  }
  controls.append(action(channel.loop ? 'Loop' : 'One-shot', async () => { channel.loop = !channel.loop; persist(); renderInspector(); await cue(); }, channel.loop),
    action('Reverse', async () => { channel.reverse = !channel.reverse; persist(); renderInspector(); await cue(); }, channel.reverse));
  const label = element('label', 'Speed'), speed = element('select');
  selectValues(speed, [['0.5','½×'],['1','1×'],['2','2×']]);
  speed.value = channel.rate;
  speed.addEventListener('change', checked(async () => { channel.rate = Number(speed.value); persist(); await cue(); }));
  label.append(speed); controls.append(label);
  renderRack();
}
function draw() {
  byId('bpm').value = state.bpm; byId('bars').value = state.bars; byId('latency').value=state.io.latencyMs;
  renderMixer(); renderMaster(); renderInspector();
}
async function api(path, data) {
  const response = await fetch('/api/mix-desk/' + path, data);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? 'The library said the request failed.');
  return payload;
}
function drawLibrary() {
  const view = byId('sample-list'), q = byId('search').value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const source = byId('source-filter').value, tag = byId('tag-filter').value, key = byId('facet').value, value = byId('facet-value').value;
  const found = rows.filter(row => (!source || row.source === source) && (!tag || row.tags.includes(tag)) &&
    (!key || !value || row.facets[key]?.includes(value)) &&
    q.every(word => [row.name,row.role,...row.tags,...Object.values(row.facets).flat()].join(' ').toLowerCase().includes(word)));
  view.replaceChildren();
  for (const row of found.slice(0, 160)) {
    const result = element('div', undefined, 'sample-row'), text = element('div', row.name);
    text.append(element('small', [row.source,row.role,...row.tags.slice(0,4)].join(' · ')));
    result.append(text, action('Load', async () => {
      const index = selected;
      const audio = await getDesk();
      const assignment = { type:'sample', name:row.name, url:row.url };
      await audio.load(index,assignment);
      state.channels[index].source = assignment;
      pendingTakes.delete(index); persist(); draw(); byId('sample-dialog').close();
      if (playing) await audio.playOne(index, state);
      say(`Loaded ${row.name} on channel ${index+1}.`);
    }));
    view.append(result);
  }
  if (!found.length) view.append(element('p','No samples match.'));
  if (found.length > 160) view.append(element('p',`Showing 160 of ${found.length}. Narrow the search for more.`));
}
function facetValues() {
  const key = byId('facet').value;
  const values = [...new Set(rows.flatMap(row => row.facets[key] ?? []))].sort();
  selectValues(byId('facet-value'), values.map(value => [value,value]), 'All values');
}
async function openLibrary() {
  if (!byId('sample-dialog').open) byId('sample-dialog').showModal();
  byId('sample-list').textContent = 'Loading local library…';
  ({ rows, facets } = await api('library'));
  selectValues(byId('source-filter'), [...new Set(rows.map(row => row.source))].map(source => [source,source]), 'All sources');
  selectValues(byId('tag-filter'), [...new Set(rows.flatMap(row => row.tags))].sort().map(tag => [tag,tag]), 'All tags');
  selectValues(byId('facet'), facets.map(([id,label]) => [id,label.replace(/^All /,'')]), 'All facets');
  facetValues(); drawLibrary();
}
function write(kind, name, buffer) {
  return api(`take?${new URLSearchParams({ name, kind, tags: byId('tags').value })}`, {
    method:'POST', headers:{'content-type':'audio/wav'}, body:wave(buffer),
  });
}
function fileName() {
  const name = byId('name').value.trim();
  if (!idPattern.test(name)) throw new Error('Use a file name with letters, digits, underscores or hyphens.');
  return name;
}
function download(data, name) {
  const url = URL.createObjectURL(new Blob([data], {type:'audio/wav'}));
  const link = element('a');
  link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function refreshSessions() {
  const list = await api('sessions');
  selectValues(byId('sessions'), list.map(name => [name,name]), 'Saved sessions');
}
function patchInitialSource() {
  const args = new URLSearchParams(location.search), url = args.get('sample');
  if (!samplePath(url)) return;
  const free = state.channels.findIndex(channel => !channel.source);
  if (free < 0) { say('All eight channels already have sources.', true); return; }
  state.channels[free].source = { type:'sample', url, name:(args.get('label') ?? url.split('/').at(-1)).slice(0,160) };
  selected = free; persist();
  historyReplace();
}
function historyReplace() {
  window.history.replaceState(null,'',location.pathname);
}
const connect = (id, event, work) => byId(id).addEventListener(event, checked(work));
connect('devices','click',async()=>{ byId('device-dialog').showModal();await deviceList(); });
connect('refresh-devices','click',deviceList);
connect('input-device','change',async()=>{
  inputDevice=byId('input-device').value;
  if (desk && (state.channels.some(channel=>channel.monitor)||tuning)) {
    await desk.configureInput(inputDevice);
    if (state.channels.some(channel=>channel.monitor)) await desk.setInputMonitoring(state,inputDevice);
  }
});
connect('output-device','change',async()=>{
  outputDevice=byId('output-device').value;await (await getDesk()).setOutput(outputDevice);
});
connect('latency','change',()=>{state.io.latencyMs=cap(Number(byId('latency').value)||0,-500,500);persist();});
connect('measure-latency','click',async()=>{
  const audio=await getDesk();
  byId('latency-status').textContent='Measuring…';
  try {
    const ms=await audio.measureLatency(selected,state,inputDevice);
    state.io.latencyMs=Math.round(ms*10)/10;
    byId('latency').value=state.io.latencyMs;
    byId('latency-status').textContent=`Round trip: ${state.io.latencyMs} ms`;
    persist();
  } catch (error) {
    byId('latency-status').textContent='No measurement'; throw error;
  } finally { if (!tuning&&!state.channels.some(channel=>channel.monitor)) audio.cancelInput(); }
});
connect('tuner','click',async()=>{
  const audio=await getDesk();
  if (!tuning) await audio.configureInput(inputDevice);
  tuning=!tuning;
  byId('tuner').setAttribute('aria-pressed',tuning);
  byId('tuner-display').hidden=!tuning;
  if (!tuning&&!state.channels.some(channel=>channel.monitor)) audio.cancelInput();
});
connect('instrument','click',async()=>{
  const index=selected,audio=await getDesk();
  audio.stopTrack(index);
  state.channels[index].source={type:'instrument',id:'tone'};
  await audio.load(index,state.channels[index].source);
  pendingTakes.delete(index);persist();draw();say(`MIDI synth assigned to channel ${index+1}.`);
});
connect('midi-connect','click',async()=>{
  if (!navigator.requestMIDIAccess) throw new Error('Web MIDI is not supported by this browser.');
  midiAccess=await navigator.requestMIDIAccess({sysex:false});
  midiAccess.onstatechange=hookMidi;hookMidi();
});
connect('midi-learn','click',()=>{
  if (!midiAccess) throw new Error('Connect MIDI before learning a mapping.');
  learning=!learning;learnTarget=null;byId('midi-learn').setAttribute('aria-pressed',learning);
  if (learning) byId('device-dialog').close();
  say(learning?'Select a control, then move the MIDI controller.':'MIDI learn stopped.');
});
connect('clear-midi','click',()=>{state.midi=[];pressedMidi.clear();persist();if(midiAccess)hookMidi();});
for (const id of ['library','pick']) connect(id,'click',openLibrary);
for (const id of ['search','source-filter','tag-filter','facet-value']) connect(id, id === 'search' ? 'input' : 'change',drawLibrary);
connect('facet','change',() => { facetValues(); drawLibrary(); });
connect('files','click',async () => { byId('file-dialog').showModal(); await refreshSessions(); });
connect('sessions','change',() => { if (byId('sessions').value) byId('name').value = byId('sessions').value; });
connect('save-session','click',async () => {
  if (pendingTakes.size) throw new Error('Save recorded takes before saving the session.');
  const name = fileName();
  await api('session?name='+encodeURIComponent(name),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(state)});
  await refreshSessions(); say(`Saved session ${name}.`); byId('file-dialog').close();
});
connect('load-session','click',async () => {
  if (pendingTakes.size) throw new Error('Save or clear the recorded takes before loading another session.');
  const loaded = normalizeSession(await api('session?name='+encodeURIComponent(byId('sessions').value || fileName())));
  const audio = await getDesk(); audio.stop(); playing = false;
  await Promise.all(loaded.channels.map((channel,index) => audio.load(index,channel.source)));
  history.forEach(items => items.splice(0)); state = loaded; persist(); draw();
  byId('file-dialog').close(); say('Session loaded.');
});
connect('write-mix','click',async () => {
  const name = fileName();
  const audio = await getDesk();
  await write('mix',name,await audio.render(state));
  byId('file-dialog').close(); say(`Saved ${name}.wav and its library tags.`);
});
connect('save-take','click',async () => {
  const index = selected;
  const candidate = window.prompt('Name this recorded take', `take-${Date.now()}`);
  if (candidate === null) return;
  if (!idPattern.test(candidate)) throw new Error('Use letters, digits, underscores or hyphens for the take name.');
  const result = await write('take',candidate,desk.buffer(index));
  state.channels[index].source = { type:'sample', url:result.url, name:result.name };
  pendingTakes.delete(index); persist(); draw(); say(`Saved ${candidate}.wav and its library tags.`);
});
connect('play','click',async () => { const audio = await getDesk(); await audio.play(state); playing = true; say('Playing.'); });
connect('stop','click',() => { desk?.stop(); playing = false; say('Stopped.'); });
connect('export','click',async () => { const audio = await getDesk(); download(wave(await audio.render(state)), 'desk-mix.wav'); say('WAV exported.'); });
connect('bpm','change',() => { state.bpm = cap(Number(byId('bpm').value)||120,40,240); byId('bpm').value = state.bpm; persist(); });
connect('bars','change',() => { state.bars = Math.round(cap(Number(byId('bars').value)||2,1,16)); byId('bars').value = state.bars; persist(); });
connect('insert-type','change',() => {
  const type = byId('insert-type').value; byId('insert-type').value = '';
  if (!insertTypes.includes(type) || current().inserts.length >= 14) return;
  current().inserts.push({ type, amount:.5, wet:1, bypass:false, ...(type === 'eq' ? { eq:[20,0,0,0,20000] } : {}) });
  persist(); renderRack();
});
connect('record','click',async () => {
  const audio = await getDesk(), index = selected, channel = state.channels[index];
  byId('record').setAttribute('aria-pressed','true'); byId('record').disabled = true;
  say('Capture armed. Playback and recording follow the desk clock.');
  try {
    await audio.record(index,state,byId('capture-source').value,byId('overdub').checked,inputDevice);
    history[index].push({source:channel.source, pending:pendingTakes.has(index), start:channel.start, end:channel.end, reverse:channel.reverse, rate:channel.rate, loop:channel.loop});
    if (history[index].length > 8) history[index].shift();
    Object.assign(channel,{ source:null,start:0,end:1,reverse:false,rate:1,loop:true });
    pendingTakes.add(index); persist(); draw();
    await audio.playOne(index,state); say(`Captured ${state.bars} bars on channel ${index+1}.`);
  } finally { byId('record').setAttribute('aria-pressed','false'); byId('record').disabled = false; }
});
connect('undo','click',async () => {
  const index = selected;
  if (!desk?.undo(index)) return;
  const { pending, ...previous } = history[index].pop();
  Object.assign(state.channels[index],previous);
  if (pending) pendingTakes.add(index); else pendingTakes.delete(index);
  if (playing) { desk.stopTrack(index); await desk.playOne(index,state); }
  persist(); draw();
});
connect('unload','click',async () => {
  const index = selected;
  desk?.stopTrack(index);
  await desk?.load(index,null);
  state.channels[index] = defaultChannel(); pendingTakes.delete(index); history[index].length = 0;
  persist(); draw();
});
selectValues(byId('capture-source'), [['input','Mic / line'],['master','Master output'],...Array.from({length:8},(_,i) => [String(i),`Channel ${i+1}`])]);
selectValues(byId('insert-type'), insertTypes.map(type => [type,type]), 'Select effect');
patchInitialSource();
draw();
let tuneFrame=0;
setInterval(() => {
  if (!desk) return;
  const { channels, lufs } = desk.meters();
  channels.forEach((peak,i) => {
    const value = Math.round(Math.min(1,peak)*100);
    metering[i].fill.style.height = value+'%';
    metering[i].meter.setAttribute('aria-valuenow',value);
  });
  byId('loudness').textContent = lufs === null ? '— LUFS' : lufs.toFixed(1)+' LUFS';
  try {
    const refresh=tuning&&tuneFrame++%3===0;
    const input=desk.inspectInput(selected,state,refresh);
    byId('input-peak').textContent=!input?'Input off':input.peak>=.99?'CLIP':`Input ${input.peak ? (20*Math.log10(input.peak)).toFixed(1) : '—'} dBFS`;
    byId('input-peak').toggleAttribute('data-clip',!!input&&input.peak>=.99);
    if (refresh) {
      const pitch=input?.pitch;
      byId('pitch').textContent=pitch?`${pitch.note} · ${pitch.hz.toFixed(1)} Hz · ${pitch.cents}¢`:'—';
      byId('tuner-display').querySelector('i').style.left=(50+cap(pitch?.cents??0,-50,50))+'%';
    }
  } catch { byId('input-peak').textContent='Input unavailable'; }
}, 50);
