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
assert.equal(typeof context.mfPlanVocalRides, 'function');
assert.equal(typeof context.mfIterateVocalRides, 'function');
assert.equal(typeof context.mfFindBuriedVocalWindows, 'function');
assert.equal(typeof context.mfStemRideDbAt, 'function');

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
assert.match(buried.skipWarning, /Can't unbury the vocal without isolation/i);
assert.ok(buried.stemsNeeded.includes('vocals'));
assert.ok(buried.stemsNeeded.includes('other'), 'competing residual other must be available to ease a masker');
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

const verseChorusAnalysis = {
  markers: [
    {
      type: 'lead_masking',
      start: 12,
      end: 28,
      maskingDb: 15.1,
      intensity: 15.1,
      evidence: 'Lead presence is 15.1 dB below low-mids in this window.',
    },
  ],
  frames: [],
  counts: { lead_masking: 1 },
};
const red = context.mfFindBuriedVocalWindows(verseChorusAnalysis);
assert.equal(red.length, 1, 'the ducked verse must be a red window');
assert.ok(red[0].start === 12 && red[0].end === 28);
const firstPlan = context.mfPlanVocalRides(red, [], { otherAvailable: true });
assert.ok(firstPlan.added.some((ride) => ride.stem === 'vocals' && ride.start === 12 && ride.end === 28));
assert.ok(firstPlan.added.some((ride) => ride.stem === 'other' && ride.start === 12 && ride.end === 28));
assert.ok(firstPlan.added.every((ride) => Number.isFinite(ride.start) && Number.isFinite(ride.end) && Number.isFinite(ride.gainDb)));
assert.ok(!firstPlan.added.some((ride) => ride.start <= 0 && ride.end >= 200), 'rides must be time-sliced, not a song-length one-shot');
const vocalPass = firstPlan.added.find((ride) => ride.stem === 'vocals');
assert.ok(vocalPass.gainDb >= 1.2 && vocalPass.gainDb <= context.MF_VOCAL_RIDE_PASS_MAX_DB);
assert.ok(!firstPlan.added.some((ride) => ride.start >= 40), 'a forward chorus without a red window stays put');

const cancelled = context.mfStemBalanceDelta(1, 1.25, 1 / 1.25, 0.28, 0);
assert.ok(Math.abs(cancelled) < 1e-9, 'level-matched EQ must not change mix balance');

const liftSample = 1 + context.mfStemBalanceDelta(1, 1, 1, 0.28, 2);
assert.ok(Math.abs(20 * Math.log10(liftSample) - 2) < 0.05, 'mix-balance +2 dB must survive wet/level-match');

const ridePlan = { mixGainDb: 0, rides: [{ start: 10, end: 16, gainDb: 2.4 }] };
assert.ok(Math.abs(context.mfStemRideDbAt(ridePlan, 8)) < 0.05, 'ride gain must be 0 before the window');
assert.ok(Math.abs(context.mfStemRideDbAt(ridePlan, 13) - 2.4) < 0.05, 'ride gain must apply inside the window');
assert.ok(Math.abs(context.mfStemRideDbAt(ridePlan, 20)) < 0.05, 'ride gain must be 0 after the window');

const plans = {
  vocals: { operations: [{ type: 'gain', gainDb: 0, label: 'No corrective processing required' }], candidates: [{ operations: [] }] },
  other: { operations: [] },
};
context.mfApplyVocalUpPlan(plans, { warranted: true, liftDb: 5, rides: firstPlan.rides });
assert.equal(plans.vocals.mixGainDb, 0, 'Forensic must not write a song-length +5 dB one-shot');
assert.ok(plans.vocals.rides.some((ride) => ride.start === 12 && ride.end === 28));
assert.ok(plans.vocals.operations.some((op) => /Vocal ride /i.test(op.label || '')));
assert.ok(plans.other.rides.some((ride) => ride.stem === 'other'));

function analysisAt(maskingDb) {
  if (!(maskingDb > 10)) return { markers: [], frames: [], counts: {} };
  return {
    markers: [{
      type: 'lead_masking',
      start: 12,
      end: 28,
      maskingDb,
      intensity: maskingDb,
      evidence: `Lead presence is ${maskingDb.toFixed(1)} dB below low-mids in this window.`,
    }],
    frames: [],
    counts: { lead_masking: 1 },
  };
}

let measured = 15.1;
const iterated = await context.mfIterateVocalRides({
  initialAnalysis: analysisAt(15.1),
  applyRides: async (rides) => {
    const vocal = rides.filter((ride) => (ride.stem || 'vocals') === 'vocals')
      .reduce((sum, ride) => sum + Number(ride.gainDb), 0);
    const ease = rides.filter((ride) => ride.stem === 'other')
      .reduce((sum, ride) => sum + Number(ride.gainDb), 0);
    // Live 2.5.2 transfer: +2.0 dB song-length → 15.1 → 14.5.
    measured = 15.1 - vocal * 0.30 - (-ease) * 0.40;
    return { analysis: analysisAt(measured) };
  },
});
assert.ok(iterated.passes.length >= 2, `a 15.1 dB bury must not end at one token lift, got ${iterated.passes.length} pass(es)`);
assert.ok(iterated.rides.filter((ride) => (ride.stem || 'vocals') === 'vocals').length >= 2, 'still-red remasure must write another ride');
assert.ok(iterated.stop?.reason, 'what-changed needs a stop reason');
assert.ok(iterated.stop.detail, 'stop reason must say why the loop ended');
assert.ok(iterated.rides.every((ride) => ride.end > ride.start && Number.isFinite(ride.gainDb)));
assert.ok(iterated.rides.filter((ride) => (ride.stem || 'vocals') === 'vocals').every((ride) => ride.gainDb <= context.MF_VOCAL_RIDE_TOTAL_MAX_DB));

const tokenOneShot = context.mfVocalUpMaskingProgress(15.1, 14.5);
assert.equal(tokenOneShot.enough, false, '15.1 → 14.5 is still a fail');
assert.ok(iterated.passes[0].redAfter > 0, 'first remasure that is still red must not master');

const alreadyClear = await context.mfIterateVocalRides({
  initialAnalysis: {
    markers: [{ type: 'lead_masking', start: 40, end: 55, maskingDb: 8.4, intensity: 8.4 }],
    frames: [],
  },
  applyRides: async () => {
    throw new Error('a forward chorus must not receive a ride');
  },
});
assert.equal(alreadyClear.rides.length, 0);
assert.equal(alreadyClear.stop.reason, 'clear');

const peaked = await context.mfIterateVocalRides({
  initialAnalysis: analysisAt(15.1),
  applyRides: async (rides) => ({
    analysis: analysisAt(14.2),
    qualityStop: 'true-peak',
    qualityDetail: 'True-peak / sample-peak stop: reprint peaked at -0.05 dBFS.',
    rides,
  }),
});
assert.equal(peaked.stop.reason, 'true-peak');
assert.match(peaked.stop.detail, /peak|smash|clip/i);

const applied = context.mfPlainWhatChanged(
  { lufs: -18, peakDb: -1.2, crestDb: 18, correlation: 0.87, clipPercent: 0 },
  { lufs: -12.2, peakDb: -1.1, crestDb: 12, correlation: 0.86, clipPercent: 0 },
  { eq: [], compressor: null, truePeakCeilingDb: -1 },
  'forensic',
  {
    vocalUp: {
      warranted: true,
      applied: true,
      rides: iterated.rides,
      passes: iterated.passes,
      stopReason: iterated.stop.reason,
      stopDetail: iterated.stop.detail,
      windowsBefore: 1,
      windowsAfter: iterated.windowsRemaining.length,
      competingEaseApplied: true,
      maskingBefore: 15.1,
      maskingAfter: measured,
    },
  },
);
assert.ok(applied.bullets.some((line) => /Vocal rides/.test(line) && /0:12–0:28/.test(line)));
assert.ok(applied.bullets.some((line) => /Stopped:/.test(line)));
assert.ok(applied.bullets.some((line) => /Buried windows:/.test(line)));
assert.doesNotMatch(applied.bullets.join(' '), /out of tune|intonation|feel of the take/i);
assert.doesNotMatch(applied.bullets.join(' '), /Vocal lift: \+5\.0 dB on the isolated vocal stem/);

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
    },
  },
);
assert.ok(tokenReport.remaining.some((line) => /still red|not enough to unbury/i.test(line)), '15.1 → 14.5 one-shot must stay a fail');

const skipped = context.mfPlainWhatChanged(
  { lufs: -18, peakDb: -1.2, crestDb: 18, correlation: 0.87, clipPercent: 0 },
  { lufs: -12.3, peakDb: -1.0, crestDb: 12, correlation: 0.87, clipPercent: 0 },
  { eq: [], compressor: null, truePeakCeilingDb: -1 },
  'quick',
  { vocalUp: { warranted: true, skipped: true, skipWarning: context.MF_VOCAL_UP_SKIP_WARNING } },
);
assert.ok(skipped.bullets.some((line) => /Can't unbury the vocal without isolation/.test(line)));

console.log('vocal-up smoke passed');
