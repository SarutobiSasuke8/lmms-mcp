import { loopSeconds, nextBar } from './state.mjs';
import { ampCurve, detectPitch, latencyProbe, measureProbeOffset, shiftRecorded } from './live.mjs';
const db = value => 10 ** (value / 20);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const workletURL = new URL('./processor.mjs', import.meta.url);
const node = (ctx, kind, setting) => new AudioWorkletNode(ctx, 'desk-effect', {
  numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { kind, setting },
});
function filter(ctx, type, frequency, gain = 0, q = 0.75) {
  const unit = ctx.createBiquadFilter();
  unit.type = type; unit.frequency.value = frequency; unit.gain.value = gain; unit.Q.value = q;
  return unit;
}
function compressor(ctx, amount, glue = false) {
  const unit = ctx.createDynamicsCompressor();
  unit.threshold.value = glue ? -20 : -8 - amount * 28;
  unit.ratio.value = glue ? 2.5 : 1 + amount * 7;
  unit.knee.value = 14; unit.attack.value = glue ? 0.018 : 0.006; unit.release.value = 0.12;
  return unit;
}
function impulse(ctx, seconds) {
  const frames = Math.ceil(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, frames, ctx.sampleRate);
  let seed = 24305;
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < frames; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i] = (seed / 2147483648 - 1) * ((1 - i / frames) ** 3) * Math.min(1, i / 36);
    }
  }
  return buffer;
}
function reverb(ctx, seconds) {
  const convolver = ctx.createConvolver();
  convolver.buffer = impulse(ctx, seconds);
  return convolver;
}
function feedbackDelay(ctx, time, feedback) {
  const delay = ctx.createDelay(2), loop = ctx.createGain();
  delay.delayTime.value = time;
  loop.gain.value = feedback;
  delay.connect(loop).connect(delay);
  return { input: delay, output: delay, stop: () => loop.disconnect() };
}
function series(units) {
  for (let i = 1; i < units.length; i++) units[i - 1].connect(units[i]);
  return { input: units[0], output: units.at(-1), stop: () => units.forEach(unit => unit.disconnect()) };
}
function wetUnit(ctx, effect) {
  const amount = effect.amount;
  switch (effect.type) {
    case 'eq': {
      const [hp, low, mid, high, lp] = effect.eq;
      return series([filter(ctx, 'highpass', hp), filter(ctx, 'lowshelf', 180, low), filter(ctx, 'peaking', 1000, mid),
        filter(ctx, 'highshelf', 4800, high), filter(ctx, 'lowpass', lp)]);
    }
    case 'compressor': return series([compressor(ctx, amount)]);
    case 'filter': return series([filter(ctx, 'lowpass', 60 * 180 ** amount, 0, 1.1 + amount * 5)]);
    case 'saturation': {
      const unit = ctx.createWaveShaper(), curve = new Float32Array(1024), drive = 1 + amount * 10;
      for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh((2 * i / (curve.length - 1) - 1) * drive) / Math.tanh(drive);
      unit.curve = curve; unit.oversample = '4x';
      return series([unit]);
    }
    case 'amp-clean':
    case 'amp-crunch':
    case 'amp-lead': {
      const drive = ctx.createWaveShaper();
      drive.curve = ampCurve(effect.type,amount); drive.oversample = '4x';
      const output = ctx.createGain(); output.gain.value = .71;
      return series([filter(ctx,'highpass',68),drive,filter(ctx,'lowshelf',170,-3+amount*4),
        filter(ctx,'peaking',950,5-amount*7,1.1),filter(ctx,'highshelf',2900,-5+amount*4),output]);
    }
    case 'cabinet': {
      const cab = reverb(ctx, .022 + .035 * amount);
      return series([filter(ctx,'highpass',68),cab,filter(ctx,'lowpass',3800+amount*1600)]);
    }
    case 'mic-chain': {
      const input = filter(ctx,'highpass',72 + amount*75), output = compressor(ctx,.35+amount*.4);
      const low = filter(ctx,'lowpass',5800), high = filter(ctx,'highpass',5800);
      const ess = compressor(ctx,.58+amount*.32);
      input.connect(low).connect(output); input.connect(high).connect(ess).connect(output);
      return { input, output, stop() { [input,output,low,high,ess].forEach(unit=>unit.disconnect()); } };
    }
    case 'delay': return feedbackDelay(ctx, 0.055 + amount * 0.45, amount * 0.55);
    case 'reverb': return series([reverb(ctx, 0.3 + amount * 2)]);
    case 'chorus': {
      const delay = ctx.createDelay(0.08), lfo = ctx.createOscillator(), depth = ctx.createGain();
      delay.delayTime.value = 0.018;
      depth.gain.value = 0.003 + 0.007 * amount;
      lfo.frequency.value = 0.22 + 0.45 * amount;
      lfo.connect(depth).connect(delay.delayTime);
      lfo.start();
      return { input: delay, output: delay, stop() { lfo.stop(); lfo.disconnect(); depth.disconnect(); delay.disconnect(); } };
    }
    default: return series([node(ctx, effect.type, effect)]);
  }
}
function rack(ctx, input, output, effects) {
  let previous = input;
  const cleanups = [];
  for (const effect of effects) {
    if (effect.bypass || !effect.wet) continue;
    const wet = ctx.createGain(), dry = ctx.createGain(), mix = ctx.createGain();
    wet.gain.value = effect.wet; dry.gain.value = 1 - effect.wet;
    const unit = wetUnit(ctx, effect);
    previous.connect(dry).connect(mix);
    previous.connect(unit.input);
    unit.output.connect(wet).connect(mix);
    previous = mix;
    cleanups.push(() => { unit.stop(); wet.disconnect(); dry.disconnect(); mix.disconnect(); });
  }
  previous.connect(output);
  return () => { input.disconnect(); for (const cleanup of cleanups) cleanup(); };
}
function meter(ctx, input) {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  input.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  return {
    peak() {
      analyser.getFloatTimeDomainData(samples);
      let peak = 0;
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
      return peak;
    },
    power() {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      return sum / samples.length;
    },
  };
}
function loudnessTap(ctx, input) {
  const splitter = ctx.createChannelSplitter(2);
  input.connect(splitter);
  const taps = [0, 1].map(index => {
    const shelf = filter(ctx, 'highshelf', 1682, 4);
    const highPass = filter(ctx, 'highpass', 38, 0, 0.5);
    splitter.connect(shelf, index); shelf.connect(highPass);
    return meter(ctx, highPass);
  });
  let powers = [];
  return () => {
    powers.push(taps.reduce((sum, channel) => sum + channel.power(), 0));
    if (powers.length > 8) powers.shift();
    const power = powers.reduce((sum, value) => sum + value, 0) / powers.length;
    return power > 1e-7 ? -0.691 + 10 * Math.log10(power) : null;
  };
}
function smooth(param, value, ctx) {
  if (ctx.state === 'suspended' || ctx instanceof OfflineAudioContext) param.value = value;
  else param.setTargetAtTime(value, ctx.currentTime, 0.009);
}

function graph(ctx, session) {
  const bus = ctx.createGain(), masterGain = ctx.createGain(), insertIn = ctx.createGain(), output = ctx.createGain();
  const hall = reverb(ctx, 2.0), delay = feedbackDelay(ctx, 0.375, 0.37);
  hall.connect(bus); delay.output.connect(bus);
  bus.connect(insertIn);
  output.connect(ctx.destination);
  const loudness = loudnessTap(ctx, output);
  const channels = session.channels.map(() => {
    const input = ctx.createGain(), gain = ctx.createGain(), pan = ctx.createStereoPanner();
    const verb = ctx.createGain(), echo = ctx.createGain();
    gain.connect(pan).connect(bus);
    pan.connect(verb).connect(hall);
    pan.connect(echo).connect(delay.input);
    return { input, gain, pan, verb, echo, output: pan, meter: meter(ctx, pan), signature: '', cleanup: null };
  });
  let signature = null;
  let masterUnits = [];
  function setSession(state) {
    const solo = state.channels.some(channel => channel.solo);
    state.channels.forEach((channel, i) => {
      const target = channels[i];
      const sig = JSON.stringify(channel.inserts);
      if (target.signature !== sig) {
        target.cleanup?.();
        target.cleanup = rack(ctx, target.input, target.gain, channel.inserts);
        target.signature = sig;
      }
      smooth(target.gain.gain, channel.mute || (solo && !channel.solo) ? 0 : channel.gain, ctx);
      smooth(target.pan.pan, channel.pan, ctx);
      smooth(target.verb.gain, channel.reverb, ctx);
      smooth(target.echo.gain, channel.delay, ctx);
    });
    const { gain, ...controls } = state.master;
    smooth(masterGain.gain, gain, ctx);
    const sig = JSON.stringify(controls);
    if (sig !== signature) {
      insertIn.disconnect();
      masterUnits.forEach(unit => unit.disconnect());
      const { low, mid, high, glue } = state.master;
      masterUnits = [filter(ctx, 'lowshelf', 180, low), filter(ctx, 'peaking', 1100, mid), filter(ctx, 'highshelf', 5800, high)];
      if (glue) masterUnits.push(compressor(ctx, 0.5, true));
      masterUnits.push(node(ctx, 'width', controls));
      const chain = [insertIn, ...masterUnits.slice(0, -1), masterGain, masterUnits.at(-1), output];
      masterGain.disconnect();
      for (let i = 1; i < chain.length; i++) chain[i - 1].connect(chain[i]);
      signature = sig;
    }
    smooth(delay.input.delayTime, 45 / state.bpm, ctx);
  }
  setSession(session);
  return { setSession, channels, output, loudness };
}
function sourceBuffer(ctx, audio, settings) {
  if (!settings.reverse) return [audio, settings.start * audio.duration, settings.end * audio.duration];
  const from = Math.floor(audio.length * settings.start), until = Math.ceil(audio.length * settings.end);
  const out = ctx.createBuffer(audio.numberOfChannels, Math.max(1, until - from), audio.sampleRate);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const source = audio.getChannelData(c), target = out.getChannelData(c);
    for (let i = 0; i < target.length; i++) target[i] = source[until - 1 - i] ?? 0;
  }
  return [out, 0, out.duration];
}
function playSource(ctx, input, buffer, state, at) {
  const [audio, from, until] = sourceBuffer(ctx, buffer, state);
  const source = ctx.createBufferSource();
  source.buffer = audio; source.playbackRate.value = state.rate;
  source.loop = state.loop; source.loopStart = from; source.loopEnd = until;
  source.connect(input);
  if (state.loop) source.start(at, from);
  else source.start(at, from, until - from);
  return source;
}

export async function createAudioDesk(session) {
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule(workletURL);
  const mix = graph(ctx, session);
  const buffers = Array(8).fill(null), sources = Array(8).fill(null);
  const undo = Array.from({length: 8}, () => []);
  let origin = null;
  let capture, media, splitter, inputDevice = '';
  let monitored = false;
  const inputTaps = Array(8).fill(null);
  const synthNotes = new Map();
  const instrumentResolvers = new Map();
  async function load(index, source) {
    if (!source) { buffers[index] = null; return; }
    if (source.type === 'instrument') {
      if (source.id === 'tone') { buffers[index] = null; return; }
      const fn = instrumentResolvers.get(source.id);
      if (!fn) throw new Error(`Instrument ${source.id} has no renderer attached.`);
      buffers[index] = await fn(ctx);
    } else {
      const response = await fetch(source.url);
      if (!response.ok) throw new Error(`Could not load ${source.name}.`);
      buffers[index] = await ctx.decodeAudioData(await response.arrayBuffer());
    }
    return buffers[index];
  }
  function replace(index, buffer) {
    undo[index].push(buffers[index]);
    if (undo[index].length > 8) undo[index].shift();
    buffers[index] = buffer;
  }
  function stopTrack(index) {
    const old = sources[index];
    if (old) { old.stop(); old.disconnect(); sources[index] = null; }
  }
  function quantised(session) {
    const now = ctx.currentTime + 0.045;
    return origin === null ? now : nextBar(now, origin, session.bpm);
  }
  function disconnectInput() {
    for (let index=0;index<inputTaps.length;index++) {
      const tap=inputTaps[index];
      if (tap) { splitter.disconnect(tap.gain); tap.gain.disconnect(); tap.analyser.disconnect(); inputTaps[index]=null; }
    }
    splitter?.disconnect();
    media?.getTracks().forEach(track=>track.stop());
    splitter=null; media=null; monitored=false;
  }
  async function configureInput(device = inputDevice) {
    if (media && inputDevice === device) return;
    if (capture) throw new Error('Wait for the active capture to finish.');
    disconnectInput();
    inputDevice = device;
    media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount:{ideal:8},
      ...(device ? {deviceId:{exact:device}} : {}), echoCancellation:false, autoGainControl:false, noiseSuppression:false } });
    const channels = media.getAudioTracks()[0].getSettings().channelCount || 1;
    splitter = ctx.createChannelSplitter(Math.min(8,channels));
    ctx.createMediaStreamSource(media).connect(splitter);
  }
  function inputFor(index, session) {
    const setting=session.channels[index], output=setting.input-1;
    if (!splitter || output >= splitter.numberOfOutputs) throw new Error('This input channel is unavailable on the selected device.');
    let tap=inputTaps[index];
    if (!tap || tap.output !== output) {
      if (tap) { splitter.disconnect(tap.gain); tap.gain.disconnect(); tap.analyser.disconnect(); }
      const gain=ctx.createGain(), analyser=ctx.createAnalyser();
      analyser.fftSize=2048;
      splitter.connect(gain,output); gain.connect(analyser);
      tap={ output,gain,analyser,connected:false,samples:new Float32Array(analyser.fftSize) }; inputTaps[index]=tap;
    }
    smooth(tap.gain.gain,setting.inputGain,ctx);
    if (setting.monitor !== tap.connected) {
      if (setting.monitor) tap.gain.connect(mix.channels[index].input);
      else tap.gain.disconnect(mix.channels[index].input);
      tap.connected=setting.monitor;
    }
    return tap;
  }
  function inspectInput(index, session, tuner=false) {
    if (!splitter) return null;
    const tap=inputFor(index,session);
    tap.analyser.getFloatTimeDomainData(tap.samples);
    const peak=tap.samples.reduce((m,v)=>Math.max(m,Math.abs(v)),0);
    return { peak, pitch:tuner ? detectPitch(tap.samples,ctx.sampleRate) : null };
  }
  async function getCapture(source, at, length, onStart) {
    const tap = new AudioWorkletNode(ctx, 'desk-capture', { numberOfInputs:1, numberOfOutputs:1,outputChannelCount:[2],
      processorOptions:{from:Math.round(at*ctx.sampleRate),frames:length} });
    const silence=ctx.createGain(); silence.gain.value=0;
    source.connect(tap).connect(silence).connect(ctx.destination);
    try {
      return await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Audio capture did not finish.')),10000+Math.ceil((at-ctx.currentTime+length/ctx.sampleRate)*1000));
        tap.port.onmessage=event=>{clearTimeout(timer);resolve(event.data);};
        tap.onprocessorerror=()=>{clearTimeout(timer);reject(new Error('Audio capture failed.'));};
        onStart?.();
      });
    } finally { source.disconnect(tap);tap.disconnect();silence.disconnect(); }
  }
  async function measureLatency(index, session, device) {
    if (capture) throw new Error('Wait for the active capture to finish.');
    if (session.channels.some(channel=>channel.monitor)) throw new Error('Turn monitoring off on every channel before measuring loopback.');
    await configureInput(device);
    const token={}; capture=token;
    try {
      const probe=latencyProbe(ctx.sampleRate), source=ctx.createBufferSource();
      source.buffer=ctx.createBuffer(1,probe.length,ctx.sampleRate);
      source.buffer.copyToChannel(probe,0); source.connect(ctx.destination);
      const at=ctx.currentTime+.18;
      const [actual]=await getCapture(inputFor(index,session).gain,at,Math.round(ctx.sampleRate*.65),()=>source.start(at));
      const offset=measureProbeOffset(probe,actual);
      if (offset === null) throw new Error('Loopback signal not detected. Connect the selected output to this input and try again.');
      return offset * 1000 / ctx.sampleRate;
    } finally { if (capture===token) capture=null; }
  }
  function playMidi(index,note,velocity) {
    const key=`${index}:${note}`, old=synthNotes.get(key);
    if (old) {
      smooth(old.gain.gain,0,ctx);old.osc.stop(ctx.currentTime+.05);synthNotes.delete(key);
    }
    if (!velocity) return;
    if (synthNotes.size >= 32) {
      const [_,previous]=synthNotes.entries().next().value;
      previous.osc.stop(); synthNotes.delete(synthNotes.keys().next().value);
    }
    const osc=ctx.createOscillator(), gain=ctx.createGain();
    osc.type='triangle'; osc.frequency.value=440*2**((note-69)/12);
    gain.gain.value=0; smooth(gain.gain,velocity*.25,ctx);
    osc.connect(gain).connect(mix.channels[index].input); osc.start();
    osc.onended=()=>{osc.disconnect();gain.disconnect();};
    synthNotes.set(key,{osc,gain});
  }
  async function record(index, session, target, overdub, device) {
    if (target === 'input') await configureInput(device);
    if (capture) throw new Error('A capture is already active.');
    const token = {};
    capture = token;
    try {
      await ctx.resume();
      const source = target === 'input' ? inputFor(index,session).gain : target === 'master' ? mix.output : mix.channels[Number(target)].output;
      const at = quantised(session);
      const length = Math.round(loopSeconds(session.bpm, session.bars) * ctx.sampleRate);
      const offset = target === 'input' ? Math.round(session.io.latencyMs * ctx.sampleRate / 1000) : 0;
      const channels = await getCapture(source,at,length+Math.max(0,offset));
      if (offset) {
        for (let c=0;c<channels.length;c++) channels[c]=shiftRecorded(channels[c],offset).subarray(0,length);
      }
      const clip = ctx.createBuffer(2, length, ctx.sampleRate);
      channels.forEach((data, c) => {
        if (overdub && buffers[index]) {
          const prev = buffers[index].getChannelData(Math.min(c, buffers[index].numberOfChannels - 1));
          for (let i = 0; i < data.length; i++) data[i] = clamp(data[i] + prev[i % prev.length], -1, 1);
        }
        clip.copyToChannel(data, c);
      });
      replace(index, clip);
      return clip;
    } finally {
      if (capture === token) capture = null;
      if (!monitored) disconnectInput();
    }
  }
  async function render(session) {
    const duration = loopSeconds(session.bpm, session.bars);
    const offline = new OfflineAudioContext(2, Math.ceil(ctx.sampleRate * (duration + 2)), ctx.sampleRate);
    await offline.audioWorklet.addModule(workletURL);
    const desk = graph(offline, session);
    for (let i = 0; i < buffers.length; i++) {
      if (!buffers[i]) continue;
      const source = playSource(offline, desk.channels[i].input, buffers[i], session.channels[i], 0);
      source.stop(duration);
    }
    return offline.startRendering();
  }
  return {
    context: ctx, load, buffer: i => buffers[i], record, render, stopTrack, configureInput, inspectInput, measureLatency, playMidi,
    setSession(state) {
      mix.setSession(state);
      if (!splitter || capture) return;
      state.channels.forEach((setting,index)=>{
        if (setting.monitor || inputTaps[index]) {
          try { inputFor(index,state); } catch { /* The device selector reports unavailable channels. */ }
        }
      });
    },
    async setInputMonitoring(state,device) {
      const wanted=state.channels.some(channel=>channel.monitor);
      if (wanted) {
        await configureInput(device);
        state.channels.forEach((setting,i)=>{ if (setting.monitor || inputTaps[i]) inputFor(i,state); });
      } else if (!capture) disconnectInput();
      monitored=wanted;
    },
    async setOutput(device) {
      if (typeof ctx.setSinkId !== 'function') throw new Error('Output selection is unavailable in this browser.');
      await ctx.setSinkId(device);
    },
    cancelInput() { if (!capture) disconnectInput(); },
    meters: () => ({ channels: mix.channels.map(channel => channel.meter.peak()), lufs: mix.loudness() }),
    attachInstrument(id, renderer) { instrumentResolvers.set(id, renderer); },
    async playOne(index, session) {
      await ctx.resume();
      if (!buffers[index]) return;
      stopTrack(index);
      const at = quantised(session);
      sources[index] = playSource(ctx, mix.channels[index].input, buffers[index], session.channels[index], at);
    },
    async play(session) {
      await ctx.resume();
      const at = quantised(session);
      origin = at;
      for (let i = 0; i < buffers.length; i++) {
        stopTrack(i);
        if (buffers[i]) sources[i] = playSource(ctx, mix.channels[i].input, buffers[i], session.channels[i], at);
      }
    },
    stop() {
      origin = null;
      for (let i = 0; i < sources.length; i++) stopTrack(i);
      for (const voice of synthNotes.values()) { smooth(voice.gain.gain,0,ctx);voice.osc.stop(ctx.currentTime+.05); }
      synthNotes.clear();
    },
    undo(index) { if (undo[index].length) { buffers[index] = undo[index].pop(); return true; } return false; },
  };
}

export function wave(buffer) {
  const channels = Math.min(2, buffer.numberOfChannels);
  const out = new ArrayBuffer(44 + buffer.length * channels * 2);
  const view = new DataView(out);
  const tag = (text, at) => [...text].forEach((letter,i) => view.setUint8(at+i, letter.charCodeAt(0)));
  tag('RIFF',0); tag('WAVEfmt ',8); tag('data',36);
  view.setUint32(4, out.byteLength-8,true); view.setUint32(16,16,true);
  view.setUint16(20,1,true); view.setUint16(22,channels,true);
  view.setUint32(24,buffer.sampleRate,true); view.setUint32(28,buffer.sampleRate*channels*2,true);
  view.setUint16(32,channels*2,true); view.setUint16(34,16,true); view.setUint32(40,out.byteLength-44,true);
  const samples = Array.from({ length: channels }, (_, i) => buffer.getChannelData(i));
  let offset = 44;
  for (let i = 0; i < buffer.length; i++) for (const channel of samples) {
    view.setInt16(offset, Math.round(clamp(channel[i], -1, 1) * 32767), true); offset += 2;
  }
  return out;
}
