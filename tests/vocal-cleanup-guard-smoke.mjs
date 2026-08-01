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

function metrics(buffer) {
  let peak = 0, leftEnergy = 0, rightEnergy = 0, cross = 0, midEnergy = 0, sideEnergy = 0;
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  for (let index = 0; index < buffer.length; index++) {
    const l = left[index], r = right[index];
    const mid = (l + r) * 0.5, side = (l - r) * 0.5;
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
    leftEnergy += l * l; rightEnergy += r * r; cross += l * r;
    midEnergy += mid * mid; sideEnergy += side * side;
  }
  const rms = Math.sqrt((leftEnergy + rightEnergy) / Math.max(1, buffer.length * 2));
  return {
    lufs: 20 * Math.log10(Math.max(rms, 1e-12)),
    peakDb: 20 * Math.log10(Math.max(peak, 1e-12)),
    widthDb: 10 * Math.log10(Math.max(sideEnergy, 1e-20) / Math.max(midEnergy, 1e-20)),
    correlation: cross / Math.sqrt(Math.max(1e-20, leftEnergy * rightEnergy)),
    midBands: [], sideBands: [],
  };
}

const context = vm.createContext({
  console, Math, Float32Array, Float64Array, Object, Array, Promise, setTimeout, clearTimeout,
  clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
  dbToGain: (db) => 10 ** (db / 20),
  gainToDb: (gain) => 20 * Math.log10(Math.max(gain, 1e-12)),
  sleep: async () => {},
  cloneBuffer(buffer) {
    const out = new FakeBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) out.copyToChannel(buffer.getChannelData(channel), channel);
    return out;
  },
  measureBuffer: metrics,
  band: () => -20,
  buildStemPlans: async () => {}, renderStemPlans: () => {}, rebuildCorrectedMix: async () => null,
  renderReleaseMaster: async () => null, mfProGainBuffer: (buffer) => buffer,
  stopPreview: () => {}, ensureAudioContext: async () => ({}),
  mfEl: () => ({ append() {}, querySelector() { return null; }, remove() {}, className: '', innerHTML: '', textContent: '' }),
  document: { querySelectorAll: () => [] }, $: () => null,
  state: { stemBuffers: {}, stemPlans: {}, original: null, vocalCleanupSource: null },
  forensicState: { reconstruction: null },
});

vm.runInContext(fs.readFileSync(new URL('../js/app-vocal-cleanup.js', import.meta.url), 'utf8'), context);
vm.runInContext(fs.readFileSync(new URL('../js/app-vocal-cleanup-guard.js', import.meta.url), 'utf8'), context);

const sampleRate = 48000;
const length = sampleRate * 4;
const vocal = new FakeBuffer(2, length, sampleRate);
const mix = new FakeBuffer(2, length, sampleRate);
for (let index = 0; index < length; index++) {
  const lead = Math.sin(2 * Math.PI * 220 * index / sampleRate) * 0.28;
  const wideDouble = index >= sampleRate ? Math.sin(2 * Math.PI * 440 * index / sampleRate) * 0.25 : 0;
  vocal.data[0][index] = lead + wideDouble;
  vocal.data[1][index] = lead - wideDouble;
  const accompaniment = Math.sin(2 * Math.PI * 110 * index / sampleRate) * 0.08;
  mix.data[0][index] = vocal.data[0][index] + accompaniment;
  mix.data[1][index] = vocal.data[1][index] + accompaniment;
}

context.vocal = vocal; context.mix = mix;
const analysis = vm.runInContext('mfAnalyzeVocalLayers(vocal, mix, 92)', context);
assert.ok(analysis.sections.length > 0, 'strong wide support layer should be detected');
assert.ok(analysis.frames.some((frame) => frame.layerScore >= 0.68 && frame.confidence >= 0.76), 'fixture should cross guarded wide-evidence threshold');
context.analysis = analysis;
const rendered = await vm.runInContext('mfRenderVocalCleanup(vocal, analysis, "reduce")', context);

function midSideEnergy(buffer, start = 0) {
  const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
  let mid = 0, side = 0;
  for (let index = start; index < buffer.length; index++) {
    const m = (left[index] + right[index]) * 0.5;
    const s = (left[index] - right[index]) * 0.5;
    mid += m * m; side += s * s;
  }
  return { mid, side };
}
const before = midSideEnergy(vocal, sampleRate);
const after = midSideEnergy(rendered.buffer, sampleRate);
assert.ok(after.side < before.side * 0.86, `strong support side energy should fall, got ratio ${after.side / before.side}`);
assert.ok(Math.abs(after.mid / before.mid - 1) < 0.01, `center lead must remain locked, got ratio ${after.mid / before.mid}`);

const monoLead = new FakeBuffer(1, sampleRate * 2, sampleRate);
for (let index = 0; index < monoLead.length; index++) monoLead.data[0][index] = Math.sin(2 * Math.PI * 3800 * index / sampleRate) * 0.22;
context.monoLead = monoLead;
const monoAnalysis = vm.runInContext('mfAnalyzeVocalLayers(monoLead, monoLead, 92)', context);
assert.equal(monoAnalysis.defaultMode, 'preserve');
assert.equal(monoAnalysis.removableSeconds, 0);

context.centerRisk = {
  mono: false, recommendation: 'remove', netRisk: 1, allowRemove: true,
  noiseScore: 1, confidence: 1, levelPosition: 0.1, layerScore: 0.1,
  sideShare: 0.02, quietNonVocalNoise: true,
};
const centerTarget = vm.runInContext('mfVocalFrameTarget(centerRisk, "remove")', context);
assert.equal(centerTarget.centerGain, 1, 'center path must remain immutable even for a noisy frame');
assert.equal(centerTarget.sideGain, 1, 'weak wide evidence must not trigger side reduction');

let stopped = 0, disconnected = 0;
context.state.vocalCleanupSource = { stop() { stopped++; }, disconnect() { disconnected++; }, onended: () => {} };
vm.runInContext('stopPreview()', context);
assert.equal(stopped, 1); assert.equal(disconnected, 1); assert.equal(context.state.vocalCleanupSource, null);

console.log('MixForge center-locked vocal cleanup guard tests passed');
