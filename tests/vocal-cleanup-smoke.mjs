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
  let peak = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  let cross = 0;
  let midEnergy = 0;
  let sideEnergy = 0;
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  for (let index = 0; index < buffer.length; index++) {
    const l = left[index];
    const r = right[index];
    const mid = (l + r) * 0.5;
    const side = (l - r) * 0.5;
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
    leftEnergy += l * l;
    rightEnergy += r * r;
    cross += l * r;
    midEnergy += mid * mid;
    sideEnergy += side * side;
  }
  const rms = Math.sqrt((leftEnergy + rightEnergy) / Math.max(1, buffer.length * 2));
  return {
    lufs: 20 * Math.log10(Math.max(rms, 1e-12)),
    peakDb: 20 * Math.log10(Math.max(peak, 1e-12)),
    widthDb: 10 * Math.log10(Math.max(sideEnergy, 1e-20) / Math.max(midEnergy, 1e-20)),
    correlation: cross / Math.sqrt(Math.max(1e-20, leftEnergy * rightEnergy)),
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
  buildStemPlans: async () => {},
  renderStemPlans: () => {},
  rebuildCorrectedMix: async () => null,
  renderReleaseMaster: async () => null,
  mfProGainBuffer: (buffer) => buffer,
  stopPreview: () => {},
  ensureAudioContext: async () => ({}),
  mfEl: () => ({ append() {}, querySelector() { return null; }, remove() {}, className: '', innerHTML: '', textContent: '' }),
  document: { querySelectorAll: () => [] },
  $: () => null,
  state: { stemBuffers: {}, stemPlans: {}, original: null },
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
  const wideDouble = index >= sampleRate
    ? Math.sin(2 * Math.PI * 440 * index / sampleRate) * 0.17
    : 0;
  vocal.data[0][index] = lead + wideDouble;
  vocal.data[1][index] = lead - wideDouble;
  const accompaniment = Math.sin(2 * Math.PI * 110 * index / sampleRate) * 0.08;
  mix.data[0][index] = vocal.data[0][index] + accompaniment;
  mix.data[1][index] = vocal.data[1][index] + accompaniment;
}

context.vocal = vocal;
context.mix = mix;
const analysis = vm.runInContext('mfAnalyzeVocalLayers(vocal, mix, 92)', context);
assert.ok(analysis.sections.length > 0, 'wide support layer should produce at least one flagged section');
assert.ok(analysis.flaggedSeconds > 1, 'wide support layer should be flagged for a meaningful duration');

context.analysis = analysis;
const result = await vm.runInContext('mfRenderVocalCleanup(vocal, analysis, "reduce")', context);
const cleaned = result.buffer;

function midSideEnergy(buffer, start = 0) {
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  let mid = 0;
  let side = 0;
  for (let index = start; index < buffer.length; index++) {
    const m = (left[index] + right[index]) * 0.5;
    const s = (left[index] - right[index]) * 0.5;
    mid += m * m;
    side += s * s;
  }
  return { mid, side };
}

const before = midSideEnergy(vocal, sampleRate);
const after = midSideEnergy(cleaned, sampleRate);
assert.ok(after.side < before.side * 0.82, `support side energy should fall, got ratio ${after.side / before.side}`);
assert.ok(Math.abs(after.mid / before.mid - 1) < 0.01, `center lead must remain locked, got ratio ${after.mid / before.mid}`);
assert.ok(result.stats.relativeDeltaDb < -6, 'cleanup difference must remain bounded below the vocal program');

const cleanLead = new FakeBuffer(2, sampleRate * 2, sampleRate);
for (let index = 0; index < cleanLead.length; index++) {
  const lead = Math.sin(2 * Math.PI * 220 * index / sampleRate) * 0.28;
  cleanLead.data[0][index] = lead;
  cleanLead.data[1][index] = lead;
}
context.cleanLead = cleanLead;
const cleanAnalysis = vm.runInContext('mfAnalyzeVocalLayers(cleanLead, cleanLead, 92)', context);
assert.equal(cleanAnalysis.defaultMode, 'preserve', 'a centered clean lead should default to Preserve');

context.guardFrame = {
  recommendation: 'reduce', netRisk: 0.95, allowRemove: false,
  noiseScore: 0.96, confidence: 0.92, levelPosition: 0.8,
  layerScore: 0.2, quietNonVocalNoise: false,
};
const brightLeadTarget = vm.runInContext('mfVocalFrameTarget(guardFrame, "reduce")', context);
assert.equal(brightLeadTarget.centerGain, 1, 'bright/high-level lead articulation must remain center-locked');

context.quietNoiseFrame = {
  recommendation: 'remove', netRisk: 0.95, allowRemove: true,
  noiseScore: 0.96, confidence: 0.92, levelPosition: 0.15,
  layerScore: 0.1, quietNonVocalNoise: true,
};
const quietNoiseTarget = vm.runInContext('mfVocalFrameTarget(quietNoiseFrame, "remove")', context);
assert.ok(quietNoiseTarget.centerGain < 1, 'quiet high-confidence non-vocal noise may be attenuated');

console.log('MixForge vocal cleanup smoke tests passed');
