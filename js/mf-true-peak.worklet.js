import { MixForgeTruePeak4x, MIXFORGE_TRUE_PEAK_TAPS } from './true-peak-core.mjs';

class MixForgeTruePeakProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const settings = options?.processorOptions || {};
    this.sourceFrames = Math.max(0, Number(settings.sourceFrames) || 0);
    this.flushFrames = Math.max(MIXFORGE_TRUE_PEAK_TAPS + 4, Number(settings.flushFrames) || 32);
    this.channelCount = Math.max(1, Number(settings.channelCount) || 2);
    this.processedFrames = 0;
    this.finalSent = false;
    this.meter = new MixForgeTruePeak4x(this.channelCount);
    this.zeroBlock = new Float32Array(128);
  }

  process(inputs, outputs) {
    const input = inputs[0] || [];
    const output = outputs[0] || [];
    const blockFrames = input[0]?.length || output[0]?.length || 128;

    if (input.length) {
      this.meter.process(input);
    } else {
      if (this.zeroBlock.length !== blockFrames) this.zeroBlock = new Float32Array(blockFrames);
      for (let channel = 0; channel < this.channelCount; channel++) {
        this.meter.processChannel(channel, this.zeroBlock);
      }
    }

    for (let channel = 0; channel < output.length; channel++) {
      const destination = output[channel];
      const source = input[Math.min(channel, Math.max(0, input.length - 1))];
      if (source?.length) destination.set(source);
      else destination.fill(0);
    }

    this.processedFrames += blockFrames;
    const finalFrame = this.sourceFrames + this.flushFrames;
    if (!this.finalSent && this.processedFrames >= finalFrame) {
      this.finalSent = true;
      this.port.postMessage({
        final: true,
        peakLinear: this.meter.peakLinear,
        peakDb: this.meter.peakDb,
        processedFrames: this.processedFrames,
      });
    }

    return true;
  }
}

registerProcessor('mixforge-true-peak', MixForgeTruePeakProcessor);
