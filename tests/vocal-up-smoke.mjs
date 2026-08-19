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
assert.equal(typeof context.mfCoalesceBuriedWindows, 'function');
assert.equal(typeof context.mfStripPresenceStackOps, 'function');
assert.equal(typeof context.mfMeasureWindowMaskingDb, 'function');
assert.equal(typeof context.mfStemRideDbAt, 'function');

const stacked = {
  vocals: { operations: [{ type: 'eq', label: 'Restore lyric clarity' }, { type: 'highpass', label: 'Remove DC and inaudible rumble' }] },
  drums: { operations: [{ type: 'eq', label: 'Open cymbal air gently' }] },
};
context.mfStripPresenceStackOps(stacked);
assert.ok(!stacked.vocals.operations.some((op) => /lyric clarity/i.test(op.label)), 'vocal-up reprint must not stack the 3600 Hz lyric-clarity shelf');
assert.ok(stacked.vocals.operations.some((op) => /DC/i.test(op.label)), 'safety ops stay');

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
    { start: 12, end: 28, rmsDb: -18, lowMidToPresenceDb: 15.1, presenceRatio: 0.04, vocalVsOtherDb: -8.5 },
    { start: 40, end: 55, rmsDb: -16, lowMidToPresenceDb: 8.4, presenceRatio: 0.22, vocalVsOtherDb: 1.0 },
  ],
  counts: {},
};
const red = context.mfFindBuriedVocalWindows(verseChorusAnalysis);
assert.ok(red.length >= 1, 'the ducked verse must be a red window');
assert.ok(red.every((window) => window.end - window.start <= context.MF_VOCAL_RIDE_MAX_WINDOW_SEC + 0.05), 'verse must stay phrase-sized');
assert.ok(red.every((window) => window.start < 32 && window.end <= 32), 'only the verse is ducked');
const firstPlan = context.mfPlanVocalRides(red, [], { otherAvailable: true });
assert.ok(firstPlan.added.some((ride) => ride.stem === 'vocals' && ride.start < 28 && ride.end > 12));
assert.ok(firstPlan.added.some((ride) => ride.stem === 'other' && ride.start < 28 && ride.end > 12));
assert.ok(firstPlan.added.every((ride) => Number.isFinite(ride.start) && Number.isFinite(ride.end) && Number.isFinite(ride.gainDb)));
assert.ok(firstPlan.added.every((ride) => ride.end - ride.start <= context.MF_VOCAL_RIDE_MAX_WINDOW_SEC + 0.05), 'a 16s verse may split, but must not become a section ride');
assert.ok(!firstPlan.added.some((ride) => ride.start <= 0 && ride.end >= 200), 'rides must be time-sliced, not a song-length one-shot');
const vocalPass = firstPlan.added.find((ride) => ride.stem === 'vocals');
assert.ok(vocalPass.gainDb >= 0.5 && vocalPass.gainDb <= context.MF_VOCAL_RIDE_PASS_MAX_DB);
assert.ok(vocalPass.gainDb < 3.0, 'a 15.1 verse must not pin the +3 hard cap when other can ease');
assert.ok(!firstPlan.added.some((ride) => ride.start >= 40), 'a forward chorus without a red window stays put');
const otherEase = firstPlan.added.find((ride) => ride.stem === 'other');
assert.ok(otherEase, 'ease other only where the residual is sitting on the vocal');
assert.ok(otherEase.start < 32, 'do not ease a forward chorus');
assert.ok(otherEase.gainDb <= -0.55 && otherEase.gainDb >= -1.25, `first-pass ease should be remasure-sized, not a -1.8 smear (${otherEase.gainDb})`);
const noSit = context.mfPlanVocalRides(
  [{ start: 12, end: 20, maskingDb: 15.1, relativeDb: 6.7 }],
  [],
  { otherAvailable: true },
);
assert.ok(!noSit.added.some((ride) => ride.stem === 'other'), 'other must not be eased unless that slice is sitting on the vocal');

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
    { start: 28, end: 36, rmsDb: -16, lowMidToPresenceDb: 8.4, presenceRatio: 0.22 },
    { start: 40, end: 56, rmsDb: -20, lowMidToPresenceDb: 12.4, presenceRatio: 0.08 },
  ],
});
assert.ok(twoSlices.some((window) => window.start <= 10 && window.end >= 16), 'the 18 dB verse stays a window');
assert.ok(twoSlices.some((window) => window.start <= 40 && window.end >= 40), 'a milder 12.4 dB slice vs a forward chorus must also get a window');
const hiddenPlan = context.mfPlanVocalRides(twoSlices, [], { otherAvailable: false });
const hiddenDeep = hiddenPlan.added.find((ride) => ride.stem === 'vocals' && ride.start <= 10);
const hiddenMild = hiddenPlan.added.find((ride) => ride.stem === 'vocals' && ride.start >= 39);
assert.ok(hiddenDeep && hiddenMild, 'both detected sections must be ridden');
assert.ok(hiddenDeep.gainDb > hiddenMild.gainDb + 0.6, `worse section must get the larger ride (${hiddenDeep.gainDb} vs ${hiddenMild.gainDb})`);

const duckedVsOther = context.mfFindBuriedVocalWindows({
  markers: [],
  frames: [
    { start: 0, end: 6, rmsDb: -18, lowMidToPresenceDb: 8.0, vocalVsOtherDb: -1.0, presenceRatio: 0.2 },
    { start: 8, end: 16, rmsDb: -20, lowMidToPresenceDb: 9.2, vocalVsOtherDb: -8.5, presenceRatio: 0.06 },
  ],
});
assert.ok(duckedVsOther.some((window) => window.start >= 7 && window.start <= 8), 'vocal-stem under competing other must count as a buried slice');
const vsOtherPlan = context.mfPlanVocalRides(duckedVsOther, [], { otherAvailable: true });
assert.ok(vsOtherPlan.added.some((ride) => ride.stem === 'vocals' && ride.start >= 7 && ride.gainDb > 0.5));

const reprintUnchanged = {
  markers: [],
  frames: [
    { start: 12, end: 20, rmsDb: -18, lowMidToPresenceDb: 15.1, presenceRatio: 0.04 },
    { start: 40, end: 55, rmsDb: -16, lowMidToPresenceDb: 8.4, presenceRatio: 0.22 },
  ],
};
const bookkeep = context.mfFindBuriedVocalWindows(
  reprintUnchanged,
  { remeasure: true, appliedRides: [{ stem: 'vocals', start: 12, end: 20, gainDb: 5.0 }] },
);
assert.ok(bookkeep.length >= 1, 'remasure must not bookkeep-clear unchanged mix frames via ride credit');

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
assert.ok(plans.vocals.rides.some((ride) => ride.start <= 12 && ride.end > 12));
assert.ok(plans.vocals.rides.every((ride) => ride.end - ride.start <= context.MF_VOCAL_RIDE_MAX_WINDOW_SEC + 0.05));
assert.ok(plans.vocals.operations.some((op) => /Vocal ride /i.test(op.label || '')));
assert.ok(plans.other.rides.some((ride) => ride.stem === 'other'));

function analysisAt(maskingDb) {
  return {
    markers: [],
    frames: [
      { start: 12, end: 20, rmsDb: -18, lowMidToPresenceDb: maskingDb, presenceRatio: 0.04 },
      { start: 40, end: 55, rmsDb: -16, lowMidToPresenceDb: 8.4, presenceRatio: 0.22 },
    ],
    counts: {},
  };
}

let measured = 15.1;
const iterated = await context.mfIterateVocalRides({
  initialAnalysis: analysisAt(15.1),
  applyRides: async (rides, added) => {
    assert.ok(!added.some((ride) => ride.stem === 'other'), 'pass 1 must be vocal-stem only — no other-ease');
    assert.equal(added.filter((ride) => (ride.stem || 'vocals') === 'vocals').length, 1, 'each pass writes one worst phrase');
    const vocal = rides.filter((ride) => (ride.stem || 'vocals') === 'vocals')
      .reduce((sum, ride) => sum + Number(ride.gainDb), 0);
    const ease = rides.filter((ride) => ride.stem === 'other')
      .reduce((sum, ride) => sum + Number(ride.gainDb), 0);
    // Live 2.5.2 transfer: +2.0 dB song-length → 15.1 → 14.5.
    measured = 15.1 - vocal * 0.30 - (-ease) * 0.40;
    return { analysis: analysisAt(measured) };
  },
});
assert.ok(iterated.rides.filter((ride) => (ride.stem || 'vocals') === 'vocals').length >= 1, 'a clearer phrase ride must be kept');
assert.ok(!iterated.rides.some((ride) => ride.stem === 'other'), 'first kept rides must not include a 34-window other cut');
assert.ok(iterated.passes[0].maskingAfter < iterated.passes[0].maskingBefore, 'remasure that window’s masking, not only a global count');
assert.ok(!iterated.passes[0].reverted, 'a phrase that remasures clearer must be kept');
assert.ok(iterated.stop?.reason, 'what-changed needs a stop reason');
assert.ok(iterated.stop.detail, 'stop reason must say why the loop ended');
assert.ok(iterated.rides.every((ride) => ride.end > ride.start && Number.isFinite(ride.gainDb)));
assert.ok(iterated.rides.filter((ride) => (ride.stem || 'vocals') === 'vocals').every((ride) => ride.gainDb <= context.MF_VOCAL_RIDE_TOTAL_MAX_DB));

function twoPhraseAnalysis(earlyDb, lateDb) {
  return {
    markers: [],
    frames: [
      { start: 12, end: 20, rmsDb: -18, lowMidToPresenceDb: earlyDb, presenceRatio: 0.04 },
      { start: 40, end: 55, rmsDb: -16, lowMidToPresenceDb: 8.4, presenceRatio: 0.22 },
      { start: 60, end: 68, rmsDb: -19, lowMidToPresenceDb: lateDb, presenceRatio: 0.03 },
    ],
    counts: {},
  };
}
const twoPhrase = await context.mfIterateVocalRides({
  initialAnalysis: twoPhraseAnalysis(15.1, 18.0),
  applyRides: async (rides, added) => {
    assert.equal(added.filter((ride) => (ride.stem || 'vocals') === 'vocals').length, 1);
    assert.ok(!added.some((ride) => ride.stem === 'other'));
    const frames = [
      { start: 12, end: 20, rmsDb: -18, lowMidToPresenceDb: 15.1, presenceRatio: 0.04 },
      { start: 40, end: 55, rmsDb: -16, lowMidToPresenceDb: 8.4, presenceRatio: 0.22 },
      { start: 60, end: 68, rmsDb: -19, lowMidToPresenceDb: 18.0, presenceRatio: 0.03 },
    ];
    for (const frame of frames) {
      const vocal = rides
        .filter((ride) => (ride.stem || 'vocals') === 'vocals' && ride.end > frame.start && ride.start < frame.end)
        .reduce((sum, ride) => sum + Number(ride.gainDb), 0);
      frame.lowMidToPresenceDb -= vocal * 0.30;
    }
    return { analysis: { markers: [], frames, counts: {} } };
  },
});
assert.ok(twoPhrase.passes.filter((row) => !row.reverted).length >= 2, 'after a kept phrase, consider a second phrase');
assert.ok(twoPhrase.rides.filter((ride) => (ride.stem || 'vocals') === 'vocals').length >= 2, 'two buried phrases can each keep a vocal ride');

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

assert.equal(context.mfVocalRideQualityStop({ harshness_band: 1 }, { harshness_band: 2 }).qualityStop, 'harshness');
assert.equal(context.mfVocalRideQualityStop({ sibilance: 0 }, { sibilance: 1 }).qualityStop, 'sibilance');
assert.equal(context.mfVocalRideQualityStop({ sub_bass_heavy: 1 }, { sub_bass_heavy: 2 }).qualityStop, 'boom');
assert.equal(context.mfVocalRideQualityStop({ harshness_band: 2, sibilance: 1, sub_bass_heavy: 3 }, { harshness_band: 2, sibilance: 1, sub_bass_heavy: 3 }), null);

const harsher = await context.mfIterateVocalRides({
  initialAnalysis: analysisAt(15.1),
  applyRides: async (rides) => ({
    analysis: analysisAt(14.2),
    qualityStop: 'harshness',
    qualityDetail: 'Harshness got worse after the last ride pass. That pass is wrong — MixForge will not tear the top to unbury the lead.',
    rides,
  }),
});
assert.equal(harsher.stop.reason, 'harshness');
assert.equal(harsher.rides.length, 0, 'a harsher pass must be reverted');
assert.match(harsher.stop.detail, /harshness|tear the top/i);

const moreSibilance = await context.mfIterateVocalRides({
  initialAnalysis: analysisAt(15.1),
  applyRides: async (rides) => ({
    analysis: analysisAt(14.2),
    qualityStop: 'sibilance',
    qualityDetail: 'Sibilance got worse after the last ride pass. That pass is wrong — MixForge will not stack presence/air until the top tears.',
    rides,
  }),
});
assert.equal(moreSibilance.stop.reason, 'sibilance');
assert.equal(moreSibilance.rides.length, 0, 'a more-sibilant pass must be reverted');

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

let duckMeasured = 15.1;
const stemDuckLoop = await context.mfIterateVocalRides({
  initialAnalysis: {
    markers: [],
    frames: [
      { start: 0, end: 6, rmsDb: -18, lowMidToPresenceDb: 8.0, vocalVsOtherDb: -1.0, presenceRatio: 0.2 },
      { start: 8, end: 16, rmsDb: -20, lowMidToPresenceDb: 15.1, vocalVsOtherDb: -8.5, presenceRatio: 0.05 },
    ],
  },
  applyRides: async (rides) => {
    const vocal = rides.filter((ride) => (ride.stem || 'vocals') === 'vocals')
      .reduce((sum, ride) => sum + Number(ride.gainDb), 0);
    const ease = rides.filter((ride) => ride.stem === 'other')
      .reduce((sum, ride) => sum + Number(ride.gainDb), 0);
    duckMeasured = 15.1 - vocal * 0.30 - (-ease) * 0.40;
    return {
      analysis: {
        markers: [],
        frames: [
          { start: 0, end: 6, rmsDb: -18, lowMidToPresenceDb: 8.0, presenceRatio: 0.2 },
          { start: 8, end: 16, rmsDb: -20, lowMidToPresenceDb: duckMeasured, presenceRatio: 0.05 },
        ],
      },
    };
  },
});
assert.ok(stemDuckLoop.rides.some((ride) => (ride.stem || 'vocals') === 'vocals'));
assert.ok(duckMeasured < 15.1, 'post-reprint window masking must move; ride credit on old frames is not remasure');

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
assert.ok(applied.bullets.some((line) => /Vocal rides/.test(line) && /0:12/.test(line)));
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

const liveSmear = context.mfPlainWhatChanged(
  { lufs: -18, peakDb: -1.2, crestDb: 18, correlation: 0.87, clipPercent: 0 },
  { lufs: -13.4, peakDb: -1.1, crestDb: 12, correlation: 0.86, clipPercent: 0 },
  { eq: [], compressor: null, truePeakCeilingDb: -1 },
  'forensic',
  {
    vocalUp: {
      warranted: true,
      applied: true,
      rides: Array.from({ length: 37 }, (_, index) => ({
        stem: 'vocals',
        start: 10 + index,
        end: 11 + index,
        gainDb: 3.0,
      })),
      maskingBefore: 15.1,
      maskingAfter: 14.2,
      windowsBefore: 37,
      windowsAfter: 50,
      stopReason: 'harshness',
      stopDetail: 'Harshness windows increased after the last ride pass, so MixForge stopped instead of pumping the lead.',
    },
  },
);
assert.ok(liveSmear.remaining.some((line) => /increased|failed|still red|not enough to unbury/i.test(line)), '15.1 → 14.2 with 37 → 50 windows is a fail');
assert.ok(liveSmear.remaining.some((line) => /increased/i.test(line)), 'a pass that creates more buried windows must be called a fail');
assert.ok(liveSmear.remaining.some((line) => /louder is not done/i.test(line)), 'LUFS −18.0 → −13.4 is not the unbury');

const longLastMinute = {
  markers: [],
  frames: [
    ...Array.from({ length: 60 }, (_, index) => ({
      start: index,
      end: index + 1.2,
      rmsDb: -18,
      lowMidToPresenceDb: 15.1,
      presenceRatio: 0.04,
    })),
    { start: 90, end: 140, rmsDb: -16, lowMidToPresenceDb: 8.4, presenceRatio: 0.22 },
    ...Array.from({ length: 59 }, (_, index) => ({
      start: 228 + index,
      end: 229.2 + index,
      rmsDb: -18,
      lowMidToPresenceDb: 15.6 + (index % 5) * 0.15,
      presenceRatio: 0.035,
    })),
  ],
};
const longWindows = context.mfFindBuriedVocalWindows(longLastMinute);
const longPlan = context.mfPlanVocalRides(longWindows, [], { otherAvailable: true });
const vocalChunks = longPlan.added.filter((ride) => ride.stem === 'vocals');
assert.ok(vocalChunks.length, 'ducked phrases still get rides');
assert.ok(vocalChunks.every((ride) => ride.end - ride.start <= context.MF_VOCAL_RIDE_MAX_WINDOW_SEC + 0.05), 'no 59s last-minute ride');
assert.ok(!vocalChunks.some((ride) => ride.end - ride.start >= 59), 'a 59s block is not a ride');
const pinned = vocalChunks.filter((ride) => Math.abs(ride.gainDb - 3) < 0.05);
assert.ok(pinned.length < Math.max(3, vocalChunks.length * 0.25), `must not pin most rides at +3.0 (${pinned.length}/${vocalChunks.length})`);
assert.ok(vocalChunks.length <= context.MF_VOCAL_RIDE_MAX_PHRASES, `must ride the worst phrases only, not 37 chunks (got ${vocalChunks.length})`);
assert.ok(vocalChunks.every((ride) => ride.gainDb < 2.95), 'must not pin phrase rides to the +3 hard cap');

const regression = await context.mfIterateVocalRides({
  initialAnalysis: analysisAt(15.1),
  applyRides: async (rides) => ({
    rides,
    analysis: {
      markers: [],
      frames: Array.from({ length: 20 }, (_, index) => ({
        start: 10 + index * 2,
        end: 11.5 + index * 2,
        rmsDb: -18,
        lowMidToPresenceDb: 15.6,
        presenceRatio: 0.03,
      })).concat([{ start: 80, end: 90, rmsDb: -16, lowMidToPresenceDb: 8.4, presenceRatio: 0.22 }]),
    },
  }),
});
assert.equal(regression.stop.reason, 'no-move', 'a phrase whose window masking did not drop must revert');
assert.equal(regression.rides.length, 0, 'the worsened pass must not be kept');
assert.match(regression.stop.detail, /0:12|12–20/, 'revert copy must name the window start–end');
assert.match(regression.stop.detail, /did not lower that window/i);

const countRosePhraseDown = await context.mfIterateVocalRides({
  initialAnalysis: analysisAt(16.8),
  applyRides: async (rides) => {
    const lifted = rides.some((ride) => (ride.stem || 'vocals') === 'vocals' && ride.gainDb > 0);
    return {
      analysis: {
        markers: [],
        frames: [
          { start: 12, end: 20, rmsDb: -16, lowMidToPresenceDb: lifted ? 12.4 : 16.8, presenceRatio: lifted ? 0.12 : 0.04 },
          { start: 40, end: 55, rmsDb: -16, lowMidToPresenceDb: 8.4, presenceRatio: 0.22 },
          ...Array.from({ length: 20 }, (_, index) => ({
            start: 80 + index,
            end: 81 + index,
            rmsDb: -18,
            lowMidToPresenceDb: 15.6,
            presenceRatio: 0.03,
          })),
        ],
      },
    };
  },
});
assert.ok(countRosePhraseDown.rides.some((ride) => (ride.stem || 'vocals') === 'vocals'), '56→59 must not reject a phrase whose own masking dropped');
assert.ok(countRosePhraseDown.passes.some((row) => !row.reverted && row.maskingAfter < row.maskingBefore));

const holeBefore = {
  markers: [],
  frames: [
    { start: 12, end: 20, rmsDb: -18, lowMidToPresenceDb: 16.8, presenceRatio: 0.04 },
    { start: 40, end: 55, rmsDb: -16, lowMidToPresenceDb: 8.4, presenceRatio: 0.22 },
  ],
  counts: {},
};
const holeAfter = {
  markers: [],
  frames: [
    { start: 12, end: 14, rmsDb: -18, lowMidToPresenceDb: 16.2, presenceRatio: 0.05 },
    { start: 14, end: 18, rmsDb: -17, lowMidToPresenceDb: 9.0, presenceRatio: 0.18 },
    { start: 18, end: 20, rmsDb: -18, lowMidToPresenceDb: 16.0, presenceRatio: 0.05 },
    { start: 40, end: 55, rmsDb: -16, lowMidToPresenceDb: 8.4, presenceRatio: 0.22 },
  ],
  counts: {},
};
const holePrior = context.mfFindBuriedVocalWindows(holeBefore, { remeasure: true });
const holeDiscovered = context.mfFindBuriedVocalWindows(holeAfter, { remeasure: true });
assert.equal(holePrior.length, 1, 'the verse starts as one phrase');
assert.ok(holeDiscovered.length > holePrior.length, 'rediscovery after a hole punch must not be the remasure score');
const holeScored = context.mfCoalesceBuriedWindows(holeDiscovered, holePrior);
assert.equal(holeScored.length, holePrior.length, 'fragments inside the original phrase still count as that one window');

const holeLoop = await context.mfIterateVocalRides({
  initialAnalysis: holeBefore,
  applyRides: async (rides) => ({
    rides,
    analysis: rides.some((ride) => (ride.stem || 'vocals') === 'vocals' && ride.gainDb > 0)
      ? holeAfter
      : holeBefore,
  }),
});
assert.notEqual(holeLoop.stop.reason, 'regression', 'a hole-punched phrase must not revert the pass as 1→2 windows');
assert.ok(holeLoop.rides.some((ride) => (ride.stem || 'vocals') === 'vocals'), 'the verse ride must be kept');

const dropLoop = await context.mfIterateVocalRides({
  initialAnalysis: {
    markers: [],
    frames: [
      { start: 12, end: 20, rmsDb: -18, lowMidToPresenceDb: 16.8, presenceRatio: 0.04 },
      { start: 40, end: 55, rmsDb: -16, lowMidToPresenceDb: 8.4, presenceRatio: 0.22 },
    ],
  },
  applyRides: async (rides) => {
    const lifted = rides.some((ride) => (ride.stem || 'vocals') === 'vocals' && ride.gainDb > 0);
    return {
      analysis: {
        markers: [],
        frames: [
          { start: 12, end: 20, rmsDb: -16, lowMidToPresenceDb: lifted ? 8.6 : 16.8, presenceRatio: lifted ? 0.21 : 0.04 },
          { start: 40, end: 55, rmsDb: -16, lowMidToPresenceDb: 8.4, presenceRatio: 0.22 },
        ],
      },
    };
  },
});
assert.notEqual(dropLoop.stop.reason, 'regression', 'a real phrase ride that unburies the verse is not revert-only');
assert.ok(dropLoop.rides.some((ride) => (ride.stem || 'vocals') === 'vocals'), 'the successful verse ride must be kept');
assert.ok(dropLoop.windowsRemaining.length < 1, 'buried window count must drop when the verse actually clears');
assert.ok(dropLoop.passes[0].redAfter < dropLoop.passes[0].redBefore, 'pass 1 must drop window count, not rise');

const revertedCopy = context.mfPlainWhatChanged(
  { lufs: -18, peakDb: -1.2, crestDb: 18, correlation: 0.87, clipPercent: 0 },
  { lufs: -18.2, peakDb: -1.2, crestDb: 18, correlation: 0.87, clipPercent: 0 },
  { eq: [], compressor: null, truePeakCeilingDb: -1 },
  'forensic',
  {
    vocalUp: {
      warranted: true,
      applied: true,
      rides: [],
      liftDb: 4.9,
      appliedLiftDb: 4.9,
      maskingBefore: 15.1,
      maskingAfter: 14.2,
      windowsBefore: 56,
      windowsAfter: 59,
      stopReason: 'regression',
      stopDetail: 'Buried windows rose 56 → 59 after pass 1; that pass was reverted.',
      failed: true,
    },
  },
);
assert.doesNotMatch(revertedCopy.bullets.join(' '), /Vocal lift: \+4\.9 dB on the isolated vocal stem/, 'reverted rides must not print the leftover +4.9 one-shot as the unbury');
assert.ok(revertedCopy.bullets.some((line) => /56 → 59|reverted/i.test(line)), 'what-changed must say the ride pass was reverted');

const skipped = context.mfPlainWhatChanged(
  { lufs: -18, peakDb: -1.2, crestDb: 18, correlation: 0.87, clipPercent: 0 },
  { lufs: -12.3, peakDb: -1.0, crestDb: 12, correlation: 0.87, clipPercent: 0 },
  { eq: [], compressor: null, truePeakCeilingDb: -1 },
  'quick',
  { vocalUp: { warranted: true, skipped: true, skipWarning: context.MF_VOCAL_UP_SKIP_WARNING } },
);
assert.ok(skipped.bullets.some((line) => /Can't unbury the vocal without isolation/.test(line)));

console.log('vocal-up smoke passed');
