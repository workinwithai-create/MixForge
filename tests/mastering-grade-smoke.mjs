import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

class FakeBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.data = Array.from({ length: channels }, () => new Float32Array(length));
  }
  getChannelData(channel) { return this.data[channel]; }
  copyToChannel(source, channel) { this.data[channel].set(source); }
}

const context = vm.createContext({
  console, Math, Float32Array, Float64Array, Int32Array, WeakMap, Number, Object, Array, Promise, setTimeout, clearTimeout,
  clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
  dbToGain: (db) => 10 ** (db / 20),
  gainToDb: (gain) => 20 * Math.log10(Math.max(gain, 1e-12)),
  sleep: async () => {},
  percentile(values, p) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(Math.max(0, Math.min(1, p)) * (sorted.length - 1))];
  },
  kWeightCoefs(fs) {
    const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    const K = Math.tan(Math.PI * f0 / fs), Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416;
    let a0 = 1 + K / Q + K * K;
    const shelf = { b0: (Vh + Vb * K / Q + K * K) / a0, b1: 2 * (K * K - Vh) / a0, b2: (Vh - Vb * K / Q + K * K) / a0, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
    const f1 = 38.13547087602444, Q1 = 0.5003270373238773, K1 = Math.tan(Math.PI * f1 / fs);
    a0 = 1 + K1 / Q1 + K1 * K1;
    const hp = { b0: 1 / a0, b1: -2 / a0, b2: 1 / a0, a1: 2 * (K1 * K1 - 1) / a0, a2: (1 - K1 / Q1 + K1 * K1) / a0 };
    return { shelf, hp };
  },
  biquadSample(x, coefficients, state) {
    const y = coefficients.b0 * x + coefficients.b1 * state.x1 + coefficients.b2 * state.x2 - coefficients.a1 * state.y1 - coefficients.a2 * state.y2;
    state.x2 = state.x1; state.x1 = x; state.y2 = state.y1; state.y1 = y;
    return y;
  },
  measureBuffer(buffer) {
    let peak = 0, sum = 0;
    const data = buffer.getChannelData(0);
    for (const sample of data) { peak = Math.max(peak, Math.abs(sample)); sum += sample * sample; }
    const rms = Math.sqrt(sum / Math.max(1, data.length));
    return { lufs: -20, lra: 0, peakDb: 20 * Math.log10(Math.max(peak, 1e-12)), rmsDb: 20 * Math.log10(Math.max(rms, 1e-12)), crestDb: 20 * Math.log10(Math.max(peak, 1e-12)) - 20 * Math.log10(Math.max(rms, 1e-12)), clipPercent: 0, correlation: 1, midBands: [], sideBands: [] };
  },
  renderProcessedBuffer: async (buffer) => buffer,
  measureLUFS: () => -20,
  mfEstimateTruePeak: () => -20,
  buildMasterPlan: () => ({}),
  renderMasterChain: () => {},
  lookAheadLimit: (buffer) => buffer,
  renderReleaseMaster: async () => null,
  renderVerification: () => {},
  renderPreLimitedMaster: async (buffer) => buffer,
  cloneBuffer(buffer) {
    const out = new FakeBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) out.copyToChannel(buffer.getChannelData(channel), channel);
    return out;
  },
  band: () => -20,
  forensicState: { references: [] },
  state: { mixMetrics: { lufs: -14 }, corrected: null, masterPlan: null },
  document: { createElement: () => ({ append() {}, className: '', innerHTML: '' }) },
  $: () => ({ replaceChildren() {}, append() {} }),
  describeOperation: () => '',
  OfflineCtx: null,
});

vm.runInContext(fs.readFileSync(new URL('../js/app-mastering-grade.js', import.meta.url), 'utf8'), context);

function sine(seconds, amplitude = 0.25, sampleRate = 48000) {
  const buffer = new FakeBuffer(2, Math.round(seconds * sampleRate), sampleRate);
  for (let index = 0; index < buffer.length; index++) {
    const value = Math.sin(2 * Math.PI * 1000 * index / sampleRate) * amplitude;
    buffer.data[0][index] = value;
    buffer.data[1][index] = value;
  }
  return buffer;
}

context.testBuffer = sine(6);
const stats = vm.runInContext('mfProLoudnessStats(testBuffer)', context);
assert.ok(Number.isFinite(stats.integrated));
assert.ok(stats.lra < 0.5, `steady sine LRA should be near zero, got ${stats.lra}`);

const peak = vm.runInContext('mfProEstimateTruePeakDb(testBuffer)', context);
assert.ok(peak < -11.5 && peak > -12.5, `unexpected true peak ${peak}`);

context.hotBuffer = sine(1, 1.5);
context.state.audioCtx = { createBuffer: (channels, length, rate) => new FakeBuffer(channels, length, rate) };
const limited = vm.runInContext('lookAheadLimit(hotBuffer, -1.2)', context);
let limitedPeak = 0;
for (const sample of limited.getChannelData(0)) limitedPeak = Math.max(limitedPeak, Math.abs(sample));
assert.ok(limitedPeak <= 10 ** (-1.2 / 20) + 1e-5, `limiter exceeded ceiling: ${limitedPeak}`);

console.log('MixForge mastering-grade smoke tests passed');
