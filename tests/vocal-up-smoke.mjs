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
assert.equal(typeof context.mfVocalUpLiftDb, 'function');
assert.equal(typeof context.mfPredictMaskingAfter, 'function');
assert.equal(typeof context.mfVocalUpMaskingProgress, 'function');

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
assert.ok(buried.liftDb > 2, `15.1 dB / 83% must not get a token +2 dB, got ${buried.liftDb}`);
assert.ok(buried.liftDb >= 4 && buried.liftDb <= context.MF_VOCAL_UP_MAX_DB, `15.1 dB bury should land in the +4 to +6 class, got ${buried.liftDb}`);
assert.ok(buried.competingEaseDb <= -0.7, `competing other must ease when low-mids mask this hard, got ${buried.competingEaseDb}`);
assert.match(buried.skipWarning, /Can't unbury the vocal without isolation/i);
assert.ok(buried.stemsNeeded.includes('vocals'));
assert.ok(buried.stemsNeeded.includes('other'), 'low-mid masker must request residual other');
assert.ok(!buried.stemsNeeded.includes('guitars'));
assert.ok(!buried.stemsNeeded.includes('keys'));

const tokenProgress = context.mfVocalUpMaskingProgress(15.1, 14.5);
assert.equal(tokenProgress.enough, false, '15.1 → 14.5 (−0.6 dB) is not enough');
assert.equal(tokenProgress.token, true);
assert.ok(context.mfVocalUpMaskingProgress(15.1, 12.4).enough, 'a >0.6 dB masking drop counts as enough');

const predicted = context.mfPredictMaskingAfter(15.1, buried.liftDb, buried.competingEaseDb);
assert.ok(Number.isFinite(predicted), 'plan must predict a post-masking number');
assert.ok(15.1 - predicted > 0.6, `planned lift/ease must move masking more than 0.6 dB, predicted ${predicted}`);

const shallow = context.mfVocalUpLiftDb(12.2);
const mid = context.mfVocalUpLiftDb(15.1);
const deep = context.mfVocalUpLiftDb(18);
assert.ok(shallow < mid, `more masking must lift more (${shallow} vs ${mid})`);
assert.ok(deep >= mid, `deeper bury must lift at least as much until the cap (${deep} vs ${mid})`);
assert.ok(Math.abs(mid - buried.liftDb) < 1e-9, 'plan lift must come from the masking-depth formula, not a track hardcode');
assert.equal(context.mfVocalUpLiftDb(20), context.MF_VOCAL_UP_MAX_DB, 'extreme bury still caps so this is not a smash');

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

const fiveSample = 1 + context.mfStemBalanceDelta(1, 1, 1, 0.28, 5);
const fiveDb = 20 * Math.log10(fiveSample);
assert.ok(Math.abs(fiveDb - 5) < 0.05, `mix-balance +5 dB must survive wet/level-match, got ${fiveDb}`);

const plans = {
  vocals: { operations: [{ type: 'gain', gainDb: 0, label: 'No corrective processing required' }], candidates: [{ operations: [] }] },
  other: { operations: [] },
};
context.mfApplyVocalUpPlan(plans, buried);
assert.equal(plans.vocals.mixGainDb, buried.liftDb);
assert.equal(plans.other.mixGainDb, buried.competingEaseDb);
assert.ok(plans.vocals.operations.some((op) => op.type === 'mixgain' && /Bring the lead up/i.test(op.label)));
assert.ok(plans.other.operations.some((op) => op.type === 'mixgain' && /competing residual/i.test(op.label || '')));
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
      appliedLiftDb: buried.liftDb,
      appliedEaseDb: buried.competingEaseDb,
      competingEaseApplied: true,
      maskingBefore: 15.1,
      maskingAfter: predicted,
      presenceBefore: -35.1,
      presenceAfter: -35.1 + (buried.liftDb * 0.30),
    },
  },
);
assert.ok(applied.bullets.some((line) => new RegExp(`Vocal lift: \\+${buried.liftDb.toFixed(1)} dB`).test(line)));
assert.ok(applied.bullets.some((line) => /Lead masking: 15\.1 →/.test(line)));
assert.ok(applied.bullets.some((line) => /Competing other:/.test(line) && /dB mix-balance/.test(line)));
assert.doesNotMatch(applied.bullets.join(' '), /out of tune|intonation|feel of the take/i);
assert.ok(!applied.remaining.some((line) => /not enough to unbury/i.test(line)));

const tokenReport = context.mfPlainWhatChanged(
  { lufs: -18, peakDb: -1.2, crestDb: 18, correlation: 0.87, clipPercent: 0 },
  { lufs: -13.4, peakDb: -1.1, crestDb: 12, correlation: 0.86, clipPercent: 0 },
  { eq: [], compressor: null, truePeakCeilingDb: -1 },
  'forensic',
  {
    vocalUp: {
      warranted: true,
      applied: true,
      appliedLiftDb: 2.0,
      maskingBefore: 15.1,
      maskingAfter: 14.5,
      presenceBefore: 2.6,
      presenceAfter: 3.3,
    },
  },
);
assert.ok(tokenReport.bullets.some((line) => /Vocal lift: \+2\.0 dB/.test(line)));
assert.ok(tokenReport.bullets.some((line) => /Lead masking: 15\.1 → 14\.5 dB/.test(line)));
assert.ok(tokenReport.remaining.some((line) => /not enough to unbury/i.test(line)), '15.1 → 14.5 must be called not enough');

const skipped = context.mfPlainWhatChanged(
  { lufs: -18, peakDb: -1.2, crestDb: 18, correlation: 0.87, clipPercent: 0 },
  { lufs: -12.3, peakDb: -1.0, crestDb: 12, correlation: 0.87, clipPercent: 0 },
  { eq: [], compressor: null, truePeakCeilingDb: -1 },
  'quick',
  { vocalUp: { warranted: true, skipped: true, skipWarning: context.MF_VOCAL_UP_SKIP_WARNING } },
);
assert.ok(skipped.bullets.some((line) => /Can't unbury the vocal without isolation/.test(line)));

const noOther = context.mfPlainWhatChanged(
  { lufs: -18, peakDb: -1.2, crestDb: 18, correlation: 0.87, clipPercent: 0 },
  { lufs: -12.3, peakDb: -1.0, crestDb: 12, correlation: 0.87, clipPercent: 0 },
  { eq: [], compressor: null, truePeakCeilingDb: -1 },
  'forensic',
  {
    vocalUp: {
      warranted: true,
      applied: true,
      appliedLiftDb: buried.liftDb,
      competingEaseDb: buried.competingEaseDb,
      competingEaseApplied: false,
      maskingBefore: 15.1,
      maskingAfter: 13.2,
    },
  },
);
assert.ok(noOther.bullets.some((line) => /residual other stem was not isolated/i.test(line)));

console.log('vocal-up smoke passed');
