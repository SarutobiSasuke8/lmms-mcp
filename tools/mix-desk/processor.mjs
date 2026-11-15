const cap = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = value => Number.isFinite(value) ? value : 0;

export function createDeskDsp(kind, setting, rate = 48000) {
  let interval = 0, hold = [0, 0], envelope = 0;
  const amount = cap(finite(setting.amount), 0, 1);
  const ceiling = 10 ** (cap(finite(setting.ceiling), -12, 0) / 20);
  const width = cap(finite(setting.width), 0, 2);
  return function process(left, right, outputL, outputR) {
    for (let i = 0; i < outputL.length; i++) {
      let l = finite(left?.[i]), r = finite(right?.[i] ?? l);
      if (kind === 'width') {
        const mid = (l + r) * 0.5, side = (l - r) * 0.5 * width;
        l = mid + side; r = mid - side;
        const peak = Math.max(Math.abs(l), Math.abs(r));
        const gain = peak > ceiling ? ceiling / peak : 1;
        l *= gain; r *= gain;
      } else if (kind === 'gate') {
        const peak = Math.max(Math.abs(l), Math.abs(r));
        const smooth = peak > envelope ? 0.003 : 0.045;
        envelope += (peak - envelope) * (1 - Math.exp(-1 / (smooth * rate)));
        const threshold = 10 ** ((-66 + amount * 55) / 20);
        const gain = cap((envelope - threshold * 0.65) / (threshold * 0.7), 0, 1);
        l *= gain; r *= gain;
      } else if (kind === 'bitcrush') {
        if (--interval <= 0) {
          const levels = 2 ** Math.round(14 - amount * 11);
          hold = [Math.round(l * levels) / levels, Math.round(r * levels) / levels];
          interval = 1 + Math.round(amount * 27);
        }
        [l, r] = hold;
      }
      outputL[i] = l; outputR[i] = r;
    }
  };
}
if (typeof AudioWorkletProcessor !== 'undefined') {
  class DeskEffect extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const { kind, setting } = options.processorOptions;
      this.dsp = createDeskDsp(kind, setting, sampleRate);
    }
    process(inputs, outputs) {
      const [left, right] = inputs[0];
      this.dsp(left, right, outputs[0][0], outputs[0][1]);
      return true;
    }
  }
  class DeskCapture extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const { from, frames } = options.processorOptions;
      this.from = from;
      this.left = new Float32Array(frames);
      this.right = new Float32Array(frames);
    }
    process(inputs, outputs) {
      const [left, right] = inputs[0];
      const [, blockRight] = outputs[0];
      const frames = blockRight.length;
      const start = Math.max(0, this.from - currentFrame);
      const end = Math.min(frames, this.from + this.left.length - currentFrame);
      for (let i = start; i < end; i++) {
        const offset = currentFrame + i - this.from;
        this.left[offset] = left?.[i] ?? 0;
        this.right[offset] = right?.[i] ?? left?.[i] ?? 0;
      }
      if (currentFrame + frames >= this.from + this.left.length) {
        this.port.postMessage([this.left, this.right], [this.left.buffer, this.right.buffer]);
        return false;
      }
      return true;
    }
  }
  registerProcessor('desk-effect', DeskEffect);
  registerProcessor('desk-capture', DeskCapture);
}
