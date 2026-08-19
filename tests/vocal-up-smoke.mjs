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
  markers: [],
  frames: [
    { start: 12, end: 28, rmsDb: -18, lowMidToPresenceDb: 15.1, presenceRatio: 0.04 },
    { start: 40, end: 55, rmsDb: -16, lowMidToPresenceDb: 8.4, presenceRatio: 0.22 },
  ],
  counts: {},
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
assert.ok(vocalPass.gainDb >= 0.8 && vocalPass.gainDb <= context.MF_VOCAL_RIDE_PASS_MAX_DB);
assert.ok(!firstPlan.added.some((ride) => ride.start >= 40), 'a forward chorus without a red window stays put');

const uneven = context.mfPlanVocalRides([
  { start: 10, end: 22, maskingDb: 12.4 },
  { start: 40, end: 56, maskingDb: 18.0 },
], [], { otherAvailable: false });
const mild = uneven.added.find((ride) => ride.stem === 'vocals' && ride.start === 10);
const deep = uneven.added.find((ride) => ride.stem === 'vocals' && ride.start === 40);
assert.ok(mild && deep, 'both buried sections must get a ride');
assert.ok(deep.gainDb > mild.gainDb + 0.6, `worse 18 dB section must get a larger ride than 12.4 dB (${deep.gainDb} vs ${mild.gainDb})`);

const twoSlices = context.mfFindBuriedVocalWindows({
  markers: [],
  frames: [
    { start: 10, end: 22, rmsDb: -18, lowMidToPresenceDb: 18.0, presenceRatio: 0.03 },
    { start: 40, end: 56, rmsDb: -20, lowMidToPresenceDb: 12.4, presenceRatio: 0.08 },
  ],
});
assert.ok(twoSlices.some((window) => window.start <= 10 && window.end >= 16), 'the 18 dB verse stays a window');
assert.ok(twoSlices.some((window) => window.start <= 40 && window.end >= 40), 'a milder 12.4 dB slice must also get a window');
const hiddenPlan = context.mfPlanVocalRides(twoSlices, [], { otherAvailable: false });
const hiddenDeep = hiddenPlan.added.find((ride) => ride.stem === 'vocals' && ride.start <= 10);
const hiddenMild = hiddenPlan.added.find((ride) => ride.stem === 'vocals' && ride.start >= 39);
assert.ok(hiddenDeep && hiddenMild, 'both detected sections must be ridden');
assert.ok(hiddenDeep.gainDb > hiddenMild.gainDb + 0.6, `worse section must get the larger ride (${hiddenDeep.gainDb} vs ${hiddenMild.gainDb})`);

const duckedVsOther = context.mfFindBuriedVocalWindows({
  markers: [],
  frames: [{
    start: 8,
    end: 16,
    rmsDb: -20,
    lowMidToPresenceDb: 9.2,
    vocalVsOtherDb: -8.5,
  }],
});
assert.ok(duckedVsOther.some((window) => window.start === 8), 'vocal-stem under competing other must count as a buried slice');
const vsOtherPlan = context.mfPlanVocalRides(duckedVsOther, [], { otherAvailable: true });
assert.ok(vsOtherPlan.added.some((ride) => ride.stem === 'vocals' && ride.start === 8 && ride.gainDb > 1));

const duckFrame = {
  start: 8,
  end: 16,
  rmsDb: -20,
  lowMidToPresenceDb: 9.2,
  vocalVsOtherDb: -8.5,
};
const uncreditedDuck = context.mfFindBuriedVocalWindows({ markers: [], frames: [duckFrame] });
assert.equal(uncreditedDuck.length, 1, 'original stem duck stays red before rides are credited');
const creditedDuck = context.mfFindBuriedVocalWindows(
  { markers: [], frames: [duckFrame] },
  { appliedRides: [{ stem: 'vocals', start: 8, end: 16, gainDb: 5.0 }] },
);
assert.equal(creditedDuck.length, 0, 'remasure must credit written rides; original stems alone would never clear');

assert.equal(context.mfGlobalVocalSeatDb({ songMaskingDb: 15.1, rideCount: 0 }), 0, 'a song-length seat is not the bury fix');
const seat = context.mfGlobalVocalSeatDb({ songMaskingDb: 13.6, rideCount: 2 });
assert.ok(seat >= 0.5 && seat <= 1.2, `global seat must stay a last trim, got ${seat}`);

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
const scaledOnly = {
  vocals: { operations: [], candidates: [{ operations: [] }] },
  other: { operations: [] },
};
context.mfApplyVocalUpPlan(scaledOnly, { warranted: true, liftDb: 5.0 });
assert.equal(scaledOnly.vocals.mixGainDb, 0, '2.5.3 must not scale vocals.mixGainDb as the bury fix');
assert.ok(!scaledOnly.vocals.rides?.length, 'liftDb alone must not invent a song-length ride');

context.mfApplyVocalUpPlan(plans, { warranted: true, liftDb: 5, rides: firstPlan.rides });
assert.equal(plans.vocals.mixGainDb, 0, 'Forensic must not write a song-length +5 dB one-shot');
const seated = {
  vocals: { operations: [], candidates: [{ operations: [] }] },
  other: { operations: [] },
};
context.mfApplyVocalUpPlan(seated, { warranted: true, rides: firstPlan.rides, globalSeatDb: 1.0, liftDb: 5 });
assert.equal(seated.vocals.mixGainDb, 1.0, 'last/global seat is a small trim after rides');
assert.ok(seated.vocals.rides.length, 'seat must not replace the time-sliced rides');
assert.ok(plans.vocals.rides.some((ride) => ride.start === 12 && ride.end === 28));
assert.ok(plans.vocals.operations.some((op) => /Vocal ride /i.test(op.label || '')));
assert.ok(plans.other.rides.some((ride) => ride.stem === 'other'));

function analysisAt(maskingDb) {
  if (!(maskingDb > 10)) return { markers: [], frames: [], counts: {} };
  return {
    markers: [],
    frames: [{
      start: 12,
      end: 28,
      rmsDb: -18,
      lowMidToPresenceDb: maskingDb,
      presenceRatio: 0.04,
    }],
    counts: {},
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
    markers: [],
    frames: [{ start: 40, end: 55, rmsDb: -16, lowMidToPresenceDb: 8.4, presenceRatio: 0.22 }],
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

const smashed = await context.mfIterateVocalRides({
  initialAnalysis: analysisAt(15.1),
  applyRides: async (rides) => ({
    analysis: analysisAt(14.2),
    qualityStop: 'smash',
    qualityDetail: 'Smash stop: crest collapsed 18.0 → 16.2 dB. MixForge will not squash the mix to chase remaining windows.',
    rides,
  }),
});
assert.equal(smashed.stop.reason, 'smash');
assert.match(smashed.stop.detail, /smash|crest|squash/i);

const stemDuckLoop = await context.mfIterateVocalRides({
  initialAnalysis: {
    markers: [],
    frames: [{ start: 8, end: 16, rmsDb: -20, lowMidToPresenceDb: 9.2, vocalVsOtherDb: -8.5 }],
  },
  applyRides: async () => ({
    analysis: {
      markers: [],
      frames: [{ start: 8, end: 16, rmsDb: -20, lowMidToPresenceDb: 9.2, vocalVsOtherDb: -8.5 }],
    },
  }),
});
assert.equal(stemDuckLoop.stop.reason, 'clear', 'written rides must clear a stem-duck remasure; looping to the cap is a fail');
assert.ok(stemDuckLoop.rides.some((ride) => (ride.stem || 'vocals') === 'vocals'));

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
      globalSeatDb: 0.8,
      competingEaseApplied: true,
      maskingBefore: 15.1,
      maskingAfter: measured,
    },
  },
);
assert.ok(applied.bullets.some((line) => /Vocal rides/.test(line) && /0:12–0:28/.test(line)));
assert.ok(applied.bullets.some((line) => /Stopped:/.test(line)));
assert.ok(applied.bullets.some((line) => /Buried windows:/.test(line)));
assert.ok(applied.bullets.some((line) => /Global vocal seat: \+0\.8 dB/.test(line)));
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
