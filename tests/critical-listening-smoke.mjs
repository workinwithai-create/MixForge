import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

class FakeBuffer {
  constructor(value, lufs, length = 32, sampleRate = 48000) {
    this.numberOfChannels = 2;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.metrics = { lufs, crestDb: 12, lra: 6 };
    this.data = [new Float32Array(length).fill(value), new Float32Array(length).fill(value)];
  }
  getChannelData(channel) { return this.data[channel]; }
  copyToChannel(source, channel) { this.data[channel].set(source); }
}

let selectedValue = 'original';
const appendedLabels = [];
const previewSelect = { append(node) { appendedLabels.push(node); } };
const context = vm.createContext({
  console, Math, Number, Object, Array, Promise, Float32Array, ArrayBuffer, DataView, Blob,
  setTimeout, clearTimeout,
  clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
  dbToGain: (db) => 10 ** (db / 20),
  gainToDb: (gain) => 20 * Math.log10(Math.max(gain, 1e-12)),
  sleep: async () => {},
  measureBuffer: (buffer) => buffer.metrics,
  cloneBuffer(buffer) {
    const out = new FakeBuffer(0, buffer.metrics.lufs, buffer.length, buffer.sampleRate);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) out.copyToChannel(buffer.getChannelData(channel), channel);
    out.metrics = { ...buffer.metrics };
    return out;
  },
  state: {
    original: null,
    master: null,
    originalLevelMatched: null,
    masterLevelMatched: null,
    masterLevelMatch: null,
    masterChange: null,
  },
  renderReleaseMaster: async () => context.state.master,
  invalidateRenderedMaster: () => 'invalidated',
  prepareMastering: () => 'prepared',
  currentPreviewBuffer: () => ({ kind: 'legacy' }),
  renderVerification: () => {},
  encodeWav: async () => null,
  writeString: () => {},
  ensureAudioContext: async () => ({ createBuffer: () => new FakeBuffer(0, -30) }),
  document: {
    readyState: 'complete',
    querySelector(selector) {
      if (selector === '.preview-select') return previewSelect;
      if (selector === 'input[name="preview"]:checked') return { value: selectedValue };
      return null;
    },
    createElement() { return { innerHTML: '', className: '', textContent: '', append() {} }; },
    addEventListener() {},
  },
  $(id) {
    if (id === 'mfMatchedOriginalPreview' || id === 'mfMatchedPreview') return null;
    if (id === 'verificationList') return { querySelectorAll: () => [], append() {} };
    return null;
  },
});
context.globalThis = context;
vm.runInContext(fs.readFileSync(new URL('../js/app-critical-listening.js', import.meta.url), 'utf8'), context);

// A very quiet original should attenuate the master by the full measured gap,
// not stop at the old -18 dB cap.
const quietOriginal = new FakeBuffer(0.1, -32);
const loudMaster = new FakeBuffer(0.5, -10);
context.quietOriginal = quietOriginal;
context.loudMaster = loudMaster;
const quietPair = vm.runInContext('mfListenBuildMatchedPair(quietOriginal, loudMaster)', context);
assert.equal(quietPair.commonLufs, -32);
assert.equal(quietPair.originalGainDb, 0);
assert.equal(quietPair.masterGainDb, -22);
assert.ok(Math.abs(quietPair.master.getChannelData(0)[0] - 0.5 * 10 ** (-22 / 20)) < 1e-6);

// If the master is quieter, attenuate the original instead of boosting the
// master and risking a clipped comparison.
const loudOriginal = new FakeBuffer(0.5, -8);
const quietMaster = new FakeBuffer(0.2, -14);
context.loudOriginal = loudOriginal;
context.quietMaster = quietMaster;
const reversePair = vm.runInContext('mfListenBuildMatchedPair(loudOriginal, quietMaster)', context);
assert.equal(reversePair.commonLufs, -14);
assert.equal(reversePair.originalGainDb, -6);
assert.equal(reversePair.masterGainDb, 0);
assert.ok(Math.abs(reversePair.original.getChannelData(0)[0] - 0.5 * 10 ** (-6 / 20)) < 1e-6);
assert.strictEqual(reversePair.master, quietMaster, 'quieter side should not be copied or boosted');

// The render wrapper stores both sides of the matched pair for honest A/B.
context.state.original = quietOriginal;
context.state.master = loudMaster;
await context.renderReleaseMaster();
assert.equal(context.state.masterLevelMatch.commonLufs, -32);
assert.equal(context.state.masterLevelMatch.masterGainDb, -22);
selectedValue = 'matchedOriginal';
assert.strictEqual(context.currentPreviewBuffer(), context.state.originalLevelMatched);
selectedValue = 'matched';
assert.strictEqual(context.currentPreviewBuffer(), context.state.masterLevelMatched);

// Any new plan/master invalidates both matched previews.
assert.equal(context.invalidateRenderedMaster(), 'invalidated');
assert.equal(context.state.originalLevelMatched, null);
assert.equal(context.state.masterLevelMatched, null);
assert.equal(context.state.masterLevelMatch, null);
context.state.originalLevelMatched = quietOriginal;
context.state.masterLevelMatched = loudMaster;
context.state.masterLevelMatch = { commonLufs: -20 };
assert.equal(context.prepareMastering(), 'prepared');
assert.equal(context.state.originalLevelMatched, null);
assert.equal(context.state.masterLevelMatched, null);
assert.equal(context.state.masterLevelMatch, null);

assert.equal(appendedLabels.length, 2, 'matched Original and Master controls should both be installed');
console.log('MixForge critical-listening smoke tests passed');
