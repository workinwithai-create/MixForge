// MixForge 4x inter-sample peak core.
// Coefficients are the 48 kHz / 4x polyphase interpolation values published in
// ITU-R BS.1770 Annex 2. This implementation is standards-derived engineering,
// not a claim that MixForge itself is a certified meter.

const PHASES = [
  [0.001708984375, 0.010986328125, -0.0196533203125, 0.033203125, -0.0594482421875, 0.1373291015625, 0.97216796875, -0.102294921875, 0.047607421875, -0.026611328125, 0.014892578125, -0.00830078125],
  [-0.0291748046875, 0.029296875, -0.0517578125, 0.089111328125, -0.16650390625, 0.465087890625, 0.77978515625, -0.2003173828125, 0.1015625, -0.0582275390625, 0.0330810546875, -0.0189208984375],
  [-0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625, -0.2003173828125, 0.77978515625, 0.465087890625, -0.16650390625, 0.089111328125, -0.0517578125, 0.029296875, -0.0291748046875],
  [-0.00830078125, 0.014892578125, -0.026611328125, 0.047607421875, -0.102294921875, 0.97216796875, 0.1373291015625, -0.0594482421875, 0.033203125, -0.0196533203125, 0.010986328125, 0.001708984375],
].map((phase) => Float64Array.from(phase));

export const MIXFORGE_TRUE_PEAK_PHASES = PHASES;
export const MIXFORGE_TRUE_PEAK_TAPS = 12;
export const MIXFORGE_TRUE_PEAK_OVERSAMPLE = 4;

export class MixForgeTruePeak4x {
  constructor(channelCount = 2) {
    this.peakLinear = 0;
    this.channelCount = 0;
    this.histories = [];
    this.pointers = [];
    this.ensureChannels(channelCount);
  }

  ensureChannels(channelCount) {
    const target = Math.max(1, Math.trunc(channelCount) || 1);
    while (this.channelCount < target) {
      this.histories.push(new Float64Array(MIXFORGE_TRUE_PEAK_TAPS));
      this.pointers.push(0);
      this.channelCount++;
    }
  }

  process(channels) {
    if (!Array.isArray(channels) || !channels.length) return this.peakLinear;
    this.ensureChannels(channels.length);
    for (let channel = 0; channel < channels.length; channel++) {
      this.processChannel(channel, channels[channel]);
    }
    return this.peakLinear;
  }

  processChannel(channel, samples) {
    if (!samples?.length) return this.peakLinear;
    this.ensureChannels(channel + 1);
    const history = this.histories[channel];
    let pointer = this.pointers[channel];
    let peak = this.peakLinear;

    for (let frame = 0; frame < samples.length; frame++) {
      history[pointer] = Number(samples[frame]) || 0;
      for (let phaseIndex = 0; phaseIndex < PHASES.length; phaseIndex++) {
        const phase = PHASES[phaseIndex];
        let sum = 0;
        let historyIndex = pointer;
        for (let tap = 0; tap < MIXFORGE_TRUE_PEAK_TAPS; tap++) {
          sum += phase[tap] * history[historyIndex];
          historyIndex--;
          if (historyIndex < 0) historyIndex = MIXFORGE_TRUE_PEAK_TAPS - 1;
        }
        const magnitude = Math.abs(sum);
        if (magnitude > peak) peak = magnitude;
      }
      pointer++;
      if (pointer === MIXFORGE_TRUE_PEAK_TAPS) pointer = 0;
    }

    this.pointers[channel] = pointer;
    this.peakLinear = peak;
    return peak;
  }

  processSilence(frameCount = MIXFORGE_TRUE_PEAK_TAPS) {
    const count = Math.max(0, Math.trunc(frameCount) || 0);
    if (!count) return this.peakLinear;
    const zeros = new Float32Array(count);
    for (let channel = 0; channel < this.channelCount; channel++) {
      this.processChannel(channel, zeros);
    }
    return this.peakLinear;
  }

  get peakDb() {
    return 20 * Math.log10(Math.max(this.peakLinear, 1e-12));
  }
}

export function measureTruePeak4xChannels(channels, flushFrames = MIXFORGE_TRUE_PEAK_TAPS + 4) {
  const meter = new MixForgeTruePeak4x(channels?.length || 1);
  meter.process(channels || []);
  meter.processSilence(flushFrames);
  return {
    peakLinear: meter.peakLinear,
    peakDb: meter.peakDb,
    oversample: MIXFORGE_TRUE_PEAK_OVERSAMPLE,
    tapsPerPhase: MIXFORGE_TRUE_PEAK_TAPS,
  };
}
