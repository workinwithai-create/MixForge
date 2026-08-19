import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const context = vm.createContext({
  console,
  Math,
  Number,
  Object,
  Array,
  Set,
  Promise,
  globalThis: {},
  clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
});
context.globalThis = context;
vm.runInContext(fs.readFileSync(new URL('../js/app-musician-ux.js', import.meta.url), 'utf8'), context);

assert.equal(typeof context.mfLeadBuriedEvidence, 'function');
assert.equal(typeof context.mfStemBalanceDelta, 'function');
assert.equal(typeof context.mfApplyVocalUpPlan, 'function');

const bakeoffAudit = {
  readinessScore: 80,
  stemsToInspect: ['vocals'],
  findings: [{
    severity: 'medium',
    stage: 'mix',
    problem: 'Lead-band masking condition',
    evidence: 'Center presence is 15.1 dB below dominant low-mids.',
    action: 'Isolate the vocal and determine whether it needs level.',
    confidence: 83,
    candidates: [{ stem: 'vocals', likelihood: 70 }],
  }],
};

const buried = context.mfLeadBuriedEvidence(bakeoffAudit, {
  midBands: [
    { name: 'Low-mids', db: -20 },
    { name: 'Presence', db: -35.1 },
  ],
});
assert.equal(buried.warranted, true);
assert.ok(Math.abs(buried.maskingDb - 15.1) < 0.05, `masking should be 15.1, got ${buried.maskingDb}`);
assert.ok(buried.liftDb >= 1.8 && buried.liftDb <= 3.5, `vocal lift must be evidence-bounded, got ${buried.liftDb}`);
assert.match(buried.skipWarning, /Can't unbury the vocal without isolation/i);
assert.ok(buried.stemsNeeded.includes('vocals'));
assert.ok(!buried.stemsNeeded.includes('guitars'));
assert.ok(!buried.stemsNeeded.includes('keys'));

const path = context.mfRecommendPath(bakeoffAudit);
assert.equal(path.path, 'forensic', 'buried/masked lead must push Forensic even at readiness 80');
assert.match(path.reason, /isolation|raise|vocal/i);

const stillQuick = context.mfRecommendPath({
  readinessScore: 86,
  stemsToInspect: ['vocals'],
  findings: [{ severity: 'low', stage: 'mix' }],
});
assert.equal(stillQuick.path, 'quick', 'a vocal stem without masking must not force Forensic');

const cancelled = context.mfStemBalanceDelta(1, 1.25, 1 / 1.25, 0.28, 0);
assert.ok(Math.abs(cancelled) < 1e-9, 'level-matched EQ must not change mix balance');

const liftSample = 1 + context.mfStemBalanceDelta(1, 1, 1, 0.28, 2);
const liftDb = 20 * Math.log10(liftSample);
assert.ok(Math.abs(liftDb - 2) < 0.05, `mix-balance +2 dB must survive wet/level-match, got ${liftDb}`);

const plans = {
  vocals: { operations: [{ type: 'gain', gainDb: 0, label: 'No corrective processing required' }], candidates: [{ operations: [] }] },
  other: { operations: [] },
};
context.mfApplyVocalUpPlan(plans, buried);
assert.equal(plans.vocals.mixGainDb, buried.liftDb);
assert.ok(plans.vocals.operations.some((op) => op.type === 'mixgain' && /Bring the lead up/i.test(op.label)));
assert.ok(plans.other.operations.some((op) => /competing low-mid/i.test(op.label || '')));

const applied = context.mfPlainWhatChanged(
  { lufs: -18, peakDb: -1.2, crestDb: 18, correlation: 0.87, clipPercent: 0 },
  { lufs: -12.2, peakDb: -1.1, crestDb: 12, correlation: 0.86, clipPercent: 0 },
  { eq: [], compressor: null, truePeakCeilingDb: -1 },
  'forensic',
  {
    vocalUp: {
      warranted: true,
      applied: true,
      appliedLiftDb: 2.0,
      maskingBefore: 15.1,
      maskingAfter: 12.4,
      presenceBefore: -35.1,
      presenceAfter: -32.8,
    },
  },
);
assert.ok(applied.bullets.some((line) => /Vocal lift: \+2\.0 dB/.test(line)));
assert.ok(applied.bullets.some((line) => /Lead masking: 15\.1 → 12\.4 dB/.test(line)));
assert.ok(applied.bullets.some((line) => /Presence: -35\.1 → -32\.8 dB/.test(line)));
assert.doesNotMatch(applied.bullets.join(' '), /out of tune|intonation|feel of the take/i);

const skipped = context.mfPlainWhatChanged(
  { lufs: -18, peakDb: -1.2, crestDb: 18, correlation: 0.87, clipPercent: 0 },
  { lufs: -12.3, peakDb: -1.0, crestDb: 12, correlation: 0.87, clipPercent: 0 },
  { eq: [], compressor: null, truePeakCeilingDb: -1 },
  'quick',
  { vocalUp: { warranted: true, skipped: true, skipWarning: context.MF_VOCAL_UP_SKIP_WARNING } },
);
assert.ok(skipped.bullets.some((line) => /Can't unbury the vocal without isolation/.test(line)));

console.log('vocal-up smoke passed');
