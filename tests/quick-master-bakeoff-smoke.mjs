import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// Bake-off fixture: musician Logic bounce numbers from the lost 2.5.0 A/B.
// Do not invent other loudness / band-share figures.
const BAKEOFF = {
  lufs: -18.0,
  lra: 5.0,
  peakDb: -1.28,
  truePeakDb: -1.2,
  crestDb: 18.5,
  correlation: 0.87,
  clipPercent: 0,
  rmsDb: -19.78,
  midBands: [
    { name: 'Sub', lo: 20, hi: 60, db: -12.0 },
    { name: 'Bass', lo: 60, hi: 250, db: -14.5 },
    { name: 'Low-mids', lo: 250, hi: 500, db: -42.5 },
    { name: 'Mids', lo: 500, hi: 2000, db: -31.0 },
    { name: 'Presence', lo: 2000, hi: 5000, db: -33.0 },
    { name: 'Air', lo: 5000, hi: 16000, db: -47.4 },
  ],
  energyShares: {
    Sub: 0.208,
    Bass: 0.546,
    'Low-mids': 0.134,
    Mids: 0.084,
    Presence: 0.027,
    Air: 0.001,
  },
};

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
  console,
  Math,
  Float32Array,
  Float64Array,
  Int32Array,
  WeakMap,
  Number,
  Object,
  Array,
  Promise,
  setTimeout,
  clearTimeout,
  clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
  dbToGain: (db) => 10 ** (db / 20),
  gainToDb: (gain) => 20 * Math.log10(Math.max(gain, 1e-12)),
  sleep: async () => {},
  percentile(values, p) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(Math.max(0, Math.min(1, p)) * (sorted.length - 1))];
  },
  kWeightCoefs() { return { shelf: {}, hp: {} }; },
  biquadSample() { return 0; },
  measureBuffer() { return { lufs: -18, lra: 5, peakDb: -1.28, rmsDb: -19.78, crestDb: 18.5, clipPercent: 0, correlation: 0.87, midBands: [], sideBands: [] }; },
  renderProcessedBuffer: async (buffer) => buffer,
  measureLUFS: () => -18,
  mfEstimateTruePeak: () => -1.2,
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
  band(metrics, name) {
    return (metrics.midBands || []).find((item) => item.name === name)?.db ?? -120;
  },
  forensicState: { references: [] },
  state: { mixMetrics: { lufs: -18 }, corrected: null, masterPlan: null },
  document: { createElement: () => ({ append() {}, className: '', innerHTML: '' }) },
  $: () => ({ replaceChildren() {}, append() {} }),
  describeOperation: () => '',
  OfflineCtx: null,
  globalThis: {},
});
context.globalThis = context;

vm.runInContext(fs.readFileSync(new URL('../js/app-mastering-grade.js', import.meta.url), 'utf8'), context);

assert.equal(typeof context.buildMasterPlan, 'function');
assert.equal(typeof context.mfBuildEvidenceEq, 'function');
assert.equal(typeof context.mfTruePeakHonesty, 'function');

const bakeoffMetrics = {
  lufs: BAKEOFF.lufs,
  lra: BAKEOFF.lra,
  peakDb: BAKEOFF.peakDb,
  crestDb: BAKEOFF.crestDb,
  correlation: BAKEOFF.correlation,
  clipPercent: BAKEOFF.clipPercent,
  rmsDb: BAKEOFF.rmsDb,
  midBands: BAKEOFF.midBands,
};

const evidence = context.mfMasterEvidence(bakeoffMetrics);
assert.ok(evidence.subVsLowMids > 29 && evidence.subVsLowMids < 32, `mid-sub vs low-mids should be ~+30.5, got ${evidence.subVsLowMids}`);
assert.ok(evidence.subVsBass < 3, 'Sub vs Bass is not the #1 gap — old Quick Master missed this');
assert.ok(evidence.airDrop > 12, `dark top airDrop should exceed the old 12 dB token threshold, got ${evidence.airDrop}`);

const plan = context.buildMasterPlan(bakeoffMetrics, -12);
const subCut = plan.eq.find((item) => /sub-bass/i.test(item.label) && item.frequency >= 40 && item.frequency <= 120);
assert.ok(subCut, 'Quick Master must apply a 40–120 Hz sub-bass cut on this boom-heavy bounce');
assert.ok(subCut.gain <= -1.2, `sub-bass cut must be material, got ${subCut.gain}`);
const airLift = plan.eq.find((item) => /air|presence/i.test(item.label) && item.frequency >= 8000);
assert.ok(airLift, 'Quick Master must apply a presence/air lift');
assert.ok(airLift.gain > context.MF_TOKEN_AIR_SHELF_DB, `air lift must be more than the token +0.7 dB shelf, got ${airLift.gain}`);
assert.equal(plan.compressor, null, 'this file is already controlled (LRA 5.0) — no master glue');
assert.ok(plan.gainDb > 5 && plan.gainDb <= 8, `then raise toward −12 LUFS, got ${plan.gainDb}`);

const afterShares = context.mfApplyEqToEnergyShares({ byName: BAKEOFF.energyShares }, plan.eq);
const beforeBoom = BAKEOFF.energyShares.Sub + BAKEOFF.energyShares.Bass;
const afterBoom = afterShares.boom20_250;
assert.ok(afterBoom < beforeBoom, `boom share must fall, not rise (${(beforeBoom * 100).toFixed(1)} → ${(afterBoom * 100).toFixed(1)})`);
assert.ok(afterShares.sub20_60 < BAKEOFF.energyShares.Sub, '20–60 share must fall');
assert.ok(afterShares.bass60_250 < BAKEOFF.energyShares.Bass, '60–250 / boom-adjacent share must fall');
assert.ok(afterShares.air5k > BAKEOFF.energyShares.Air, 'air share must rise');
const beforeScore = context.mfTonalProblemScore({
  sub20_60: BAKEOFF.energyShares.Sub,
  bass60_250: BAKEOFF.energyShares.Bass,
  air5k: BAKEOFF.energyShares.Air,
});
const afterScore = context.mfTonalProblemScore(afterShares);
assert.ok(afterScore < beforeScore, `tonal problem score must improve (${beforeScore.toFixed(2)} → ${afterScore.toFixed(2)})`);

const balanced = context.buildMasterPlan({
  lufs: -12.2,
  lra: 7.5,
  peakDb: -1.4,
  crestDb: 12,
  correlation: 0.7,
  clipPercent: 0,
  rmsDb: -13.6,
  midBands: [
    { name: 'Sub', lo: 20, hi: 60, db: -22 },
    { name: 'Bass', lo: 60, hi: 250, db: -21 },
    { name: 'Low-mids', lo: 250, hi: 500, db: -20 },
    { name: 'Mids', lo: 500, hi: 2000, db: -19 },
    { name: 'Presence', lo: 2000, hi: 5000, db: -20 },
    { name: 'Air', lo: 5000, hi: 16000, db: -21 },
  ],
}, -12);
assert.ok(!balanced.eq.some((item) => /sub-bass/i.test(item.label)), 'a balanced mix must not get a boom cut');

const falseWin = context.mfTruePeakHonesty(-1.03, -1.0, 0.55);
assert.equal(falseWin.claimUnderCeiling, false, 'cubic −1.03 vs ebur128-hotter must not print an under-ceiling win');
assert.equal(falseWin.tone, 'warn');
assert.match(falseWin.detail, /not claimed under/i);

const honest = context.mfTruePeakHonesty(-1.62, -1.0, 0.55);
assert.equal(honest.claimUnderCeiling, true);

console.log('quick-master bake-off smoke passed');
