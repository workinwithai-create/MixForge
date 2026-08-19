import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const baseAnalysis = {
  duration: 60,
  issueLoad: 6,
  markers: [
    { type: 'loudness_dip', severity: 'medium', start: 0, end: 0.9, evidence: 'intro dip' },
    { type: 'loudness_dip', severity: 'medium', start: 10, end: 11.1, evidence: 'short musical dip' },
    { type: 'loudness_dip', severity: 'medium', start: 20, end: 23.2, evidence: 'sustained dip' },
    { type: 'harshness_band', severity: 'medium', start: 30, end: 31, evidence: 'upper-mid flare' },
    { type: 'clipping', severity: 'high', start: 40, end: 41, evidence: 'flattened samples' },
    { type: 'lead_masking', severity: 'medium', start: 12, end: 24, evidence: 'verse under low-mids' },
  ],
  counts: { loudness_dip: 3, harshness_band: 1, clipping: 1, lead_masking: 1 },
};

const context = vm.createContext({
  console,
  Math,
  Number,
  Object,
  Array,
  Set,
  Promise,
  MF_TIMELINE_TYPES: {
    loudness_dip: { weight: 2 },
    harshness_band: { weight: 2 },
    clipping: { weight: 3 },
    lead_masking: { weight: 2 },
  },
  mfTimelineAnalyze: async () => structuredClone(baseAnalysis),
  mfTimelineTypeLabel: (type) => type.replaceAll('_', ' '),
  mfTimelineClamp: (value, min, max) => Math.max(min, Math.min(max, value)),
  mfTimelineSelfCheck: (before, after) => ({
    resolved: Object.keys(before.counts).filter((type) => !after.counts[type]),
  }),
  structuredClone,
});

vm.runInContext(fs.readFileSync(new URL('../js/app-targeted-repair.js', import.meta.url), 'utf8'), context);
vm.runInContext(fs.readFileSync(new URL('../js/app-targeted-repair-guard.js', import.meta.url), 'utf8'), context);

const filtered = await vm.runInContext('mfTimelineAnalyze({ duration: 60 })', context);
assert.equal(filtered.markers.filter((marker) => marker.type === 'loudness_dip').length, 1, 'only sustained, non-boundary loudness dips should remain');
assert.equal(filtered.markers.find((marker) => marker.type === 'loudness_dip').start, 20);

context.filtered = filtered;
const plan = vm.runInContext('mfTargetBuildPlanFromAnalysis(filtered)', context);
const harshness = plan.find((item) => item.marker.type === 'harshness_band');
const clipping = plan.find((item) => item.marker.type === 'clipping');
const sustainedDip = plan.find((item) => item.marker.type === 'loudness_dip');
assert.equal(harshness.safety, 'safe');
assert.equal(harshness.defaultSelected, true);
assert.equal(clipping.safety, 'blocked');
assert.equal(clipping.operation, null);
assert.equal(sustainedDip.safety, 'review');
assert.equal(sustainedDip.defaultSelected, false);
const vocalWindow = plan.find((item) => item.marker.type === 'lead_masking');
assert.equal(vocalWindow.safety, 'blocked');
assert.equal(vocalWindow.operation, null, 'stereo targeted repair must not raise the masker with the vocal');

context.before = {
  issueLoad: 6,
  markers: [{ type: 'clipping', severity: 'high' }, { type: 'harshness_band', severity: 'medium' }],
  counts: { clipping: 1, harshness_band: 1 },
};
context.afterGood = {
  issueLoad: 2,
  markers: [{ type: 'harshness_band', severity: 'medium' }],
  counts: { harshness_band: 1 },
};
context.afterBad = {
  issueLoad: 7,
  markers: [{ type: 'mono_incompatibility', severity: 'high' }],
  counts: { mono_incompatibility: 1 },
};
context.beforeMetrics = { peakDb: -1.3, crestDb: 10, correlation: 0.5, lufs: -12 };
context.goodMetrics = { peakDb: -1.25, crestDb: 9.5, correlation: 0.48, lufs: -12.1 };
context.badMetrics = { peakDb: -0.2, crestDb: 5, correlation: -0.3, lufs: -10 };
context.planSettings = { truePeakCeilingDb: -1 };

const good = vm.runInContext('mfTargetEvaluateCandidate(before, afterGood, beforeMetrics, goodMetrics, planSettings)', context);
assert.equal(good.accepted, true, 'measurably improved, safe candidate should pass');
assert.ok(good.resolved.includes('clipping'));
const bad = vm.runInContext('mfTargetEvaluateCandidate(before, afterBad, beforeMetrics, badMetrics, planSettings)', context);
assert.equal(bad.accepted, false, 'regressive candidate should be blocked');
assert.ok(bad.reasons.length >= 3, 'guard should explain multiple regressions');

console.log('MixForge targeted repair smoke tests passed');
