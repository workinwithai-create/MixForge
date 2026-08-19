'use strict';

// MixForge 2.5 musician UX layer.
// Dual-path productization: Quick Master (stereo release master) vs Forensic Fix
// (opt-in stem investigation). Keeps the evidence-first thesis; does not gate
// billing here — Hub entitlements are stubbed for a follow-up.

const MF_DEMUCS_STEMS = new Set(['vocals', 'bass', 'drums', 'other']);
const MF_STEM_ALIASES = { guitars: 'other', keys: 'other' };
const MF_STEM_HOURLY_LIMIT = 12;
const MF_STEM_DAILY_LIMIT = 30;
const MF_AURAMIX_URL = 'https://auramix.workinwithai.com';
const MF_STEM_DISPLAY = {
  vocals: 'Vocals',
  bass: 'Bass',
  drums: 'Drums',
  other: 'Other residual (guitars / keys / ambience)',
  guitars: 'Other residual (requested as guitars)',
  keys: 'Other residual (requested as keys)',
};

// TODO(hub): Replace with workinwithai-hub OAuth + Stripe entitlement checks.
// Hub prices MixForge at $9/mo or Forge Pass $24; this app is still ungated.
const MixForgeHub = {
  product: 'mixforge',
  pricing: { mixforgeMonthly: 9, forgePassMonthly: 24 },
  features: { quickMaster: true, forensicStems: true, export: true },
  requireEntitlement(feature) {
    // TODO(hub): return { ok:false, reason:'login'|'subscribe', redirectUrl } when gated.
    return { ok: true, feature, reason: 'ungated-preview' };
  },
};
if (typeof globalThis !== 'undefined') globalThis.MixForgeHub = MixForgeHub;

function mfOriginalPreviewPlan(stateLike = {}) {
  if (!stateLike.original) return { show: false, selected: null, showAb: false };
  return {
    show: true,
    selected: 'original',
    showAb: Boolean(stateLike.master),
  };
}

async function presentMeasuredAuditThenListen({ measure, present, listen }) {
  if (typeof measure !== 'function' || typeof present !== 'function') {
    throw new Error('measure and present are required');
  }
  const measured = await measure();
  present(measured);
  const listening = typeof listen === 'function'
    ? Promise.resolve().then(() => listen(measured))
    : Promise.resolve(null);
  return { measured, listening };
}

const MF_LEAD_MASKING_DB = 14;
const MF_VOCAL_UP_CONFIDENCE = 70;
const MF_VOCAL_UP_SKIP_WARNING = "Can't unbury the vocal without isolation — stereo master will only raise everything.";
const MF_VOCAL_UP_MASK_FLOOR_DB = 8;
const MF_VOCAL_UP_LIFT_COEFF = 0.70;
const MF_VOCAL_UP_MIN_DB = 2.2;
const MF_VOCAL_UP_MAX_DB = 6.0;
const MF_VOCAL_UP_EASE_START_DB = 12;
const MF_VOCAL_UP_EASE_COEFF = 0.38;
const MF_VOCAL_UP_EASE_MIN_DB = -2.4;
const MF_VOCAL_UP_EASE_MAX_DB = -0.7;
const MF_MIX_BALANCE_MIN_DB = -3;
const MF_MIX_BALANCE_MAX_DB = 6;
// Live 2.5.2: +2.0 dB vocal on a 15.1 dB bury moved presence +0.7 and masking −0.6.
const MF_VOCAL_PRESENCE_TRANSFER = 0.30;
const MF_OTHER_MIX_TRANSFER = 0.40;
const MF_TOKEN_MASKING_DROP_DB = 0.6;
const MF_VOCAL_RIDE_CLEAR_DB = 10;
const MF_VOCAL_RIDE_RED_DB = 14;
const MF_VOCAL_RIDE_PASS_MIN_DB = 0.5;
const MF_VOCAL_RIDE_PASS_MAX_DB = 3.0;
const MF_VOCAL_RIDE_TOTAL_MAX_DB = 6.0;
const MF_VOCAL_RIDE_EASE_TOTAL_MAX_DB = -4.5;
const MF_VOCAL_RIDE_EASE_PASS_MAX_DB = -3.2;
const MF_VOCAL_RIDE_MAX_PASSES = 8;
const MF_VOCAL_RIDE_PEAK_STOP_DB = -0.2;
const MF_VOCAL_RIDE_MIN_WINDOW_SEC = 0.45;
const MF_VOCAL_RIDE_MAX_WINDOW_SEC = 8;
const MF_VOCAL_RIDE_MAX_PHRASES = 8;
const MF_VOCAL_RIDE_MIN_RELATIVE_DB = 2.0;
const MF_VOCAL_SEAT_MAX_DB = 1.2;
const MF_VOCAL_VS_OTHER_DUCK_DB = -4;

function mfVocalUpLiftDb(maskingDb) {
  const masking = Number(maskingDb);
  const depth = Math.max(Number.isFinite(masking) ? masking : 15, 12);
  return clamp((depth - MF_VOCAL_UP_MASK_FLOOR_DB) * MF_VOCAL_UP_LIFT_COEFF, MF_VOCAL_UP_MIN_DB, MF_VOCAL_UP_MAX_DB);
}

function mfCompetingEaseDb(maskingDb) {
  const masking = Number.isFinite(Number(maskingDb)) ? Number(maskingDb) : 15;
  if (masking <= MF_VOCAL_UP_EASE_START_DB) return 0;
  return clamp(-(masking - MF_VOCAL_UP_EASE_START_DB) * MF_VOCAL_UP_EASE_COEFF, MF_VOCAL_UP_EASE_MIN_DB, MF_VOCAL_UP_EASE_MAX_DB);
}

function mfPredictMaskingAfter(maskingBefore, liftDb, competingEaseDb = 0, options = {}) {
  const before = Number(maskingBefore);
  if (!Number.isFinite(before)) return null;
  const lift = Math.max(0, Number(liftDb) || 0);
  const ease = Math.min(0, Number(competingEaseDb) || 0);
  const mixEase = options.competingEaseApplied !== false && ease < -0.05;
  const drop = lift * MF_VOCAL_PRESENCE_TRANSFER + (mixEase ? (-ease) * MF_OTHER_MIX_TRANSFER : 0);
  return before - drop;
}

function mfVocalUpMaskingProgress(maskingBefore, maskingAfter) {
  const before = Number(maskingBefore);
  const after = Number(maskingAfter);
  if (!Number.isFinite(before) || !Number.isFinite(after)) {
    return { drop: null, enough: false, token: true };
  }
  const drop = before - after;
  return {
    drop,
    enough: drop > MF_TOKEN_MASKING_DROP_DB,
    token: drop <= MF_TOKEN_MASKING_DROP_DB,
  };
}

function mfRideEnvelope(time, start, end, fadeSeconds = 0.14) {
  if (typeof mfTargetEnvelope === 'function') return mfTargetEnvelope(time, start, end, fadeSeconds);
  const outerStart = Math.max(0, start - fadeSeconds);
  const outerEnd = end + fadeSeconds;
  if (time < outerStart || time > outerEnd) return 0;
  if (time >= start && time <= end) return 1;
  if (time < start) {
    const position = (time - outerStart) / Math.max(1e-6, start - outerStart);
    return 0.5 - 0.5 * Math.cos(Math.PI * clamp(position, 0, 1));
  }
  const position = (outerEnd - time) / Math.max(1e-6, outerEnd - end);
  return 0.5 - 0.5 * Math.cos(Math.PI * clamp(position, 0, 1));
}

function mfStemRideDbAt(plan, time) {
  let db = Number(plan?.mixGainDb) || 0;
  for (const ride of plan?.rides || []) {
    const env = mfRideEnvelope(time, Number(ride.start), Number(ride.end));
    if (env > 0) db += (Number(ride.gainDb) || 0) * env;
  }
  return clamp(db, MF_MIX_BALANCE_MIN_DB, MF_VOCAL_RIDE_TOTAL_MAX_DB);
}

function mfFormatRideRange(start, end) {
  if (typeof mfTimelineFormatTime === 'function') {
    return `${mfTimelineFormatTime(start)}–${mfTimelineFormatTime(end)}`;
  }
  const fmt = (value) => {
    const safe = Math.max(0, Number(value) || 0);
    const minutes = Math.floor(safe / 60);
    const seconds = Math.floor(safe % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
  };
  return `${fmt(start)}–${fmt(end)}`;
}

function mfWindowMaskingDb(windowLike) {
  const masking = Number(windowLike?.maskingDb);
  if (Number.isFinite(masking)) return masking;
  const fromFrame = Number(windowLike?.lowMidToPresenceDb);
  if (Number.isFinite(fromFrame)) return fromFrame;
  const intensity = Number(windowLike?.intensity);
  return Number.isFinite(intensity) ? intensity : null;
}

function mfMeasureBufferWindowDb(buffer, start, end) {
  if (!buffer || typeof buffer.getChannelData !== 'function') return null;
  const sampleRate = Number(buffer.sampleRate) || 48000;
  const begin = Math.max(0, Math.floor(Number(start) * sampleRate));
  const finish = Math.min(buffer.length || 0, Math.ceil(Number(end) * sampleRate));
  if (finish <= begin) return null;
  let sum = 0;
  let count = 0;
  for (let channel = 0; channel < (buffer.numberOfChannels || 1); channel++) {
    const data = buffer.getChannelData(channel);
    for (let index = begin; index < finish; index++) {
      const sample = data[index] || 0;
      sum += sample * sample;
      count++;
    }
  }
  if (!count) return null;
  return 20 * Math.log10(Math.max(Math.sqrt(sum / count), 1e-12));
}

function mfWindowRideDepthDb(windowLike) {
  const parts = [];
  const masking = mfWindowMaskingDb(windowLike);
  if (Number.isFinite(masking)) parts.push(masking);
  const vsOther = Number(windowLike?.vocalVsOtherDb);
  if (Number.isFinite(vsOther)) parts.push(-vsOther + 6);
  const presenceGap = Number(windowLike?.presenceGapDb);
  if (Number.isFinite(presenceGap)) parts.push(presenceGap);
  return parts.length ? Math.max(...parts) : null;
}

function mfSortedMedian(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) * 0.5;
}

function mfPercentile(values, percentile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function mfMergeWindowStats(target, source) {
  target.maskingDb = Math.max(Number(target.maskingDb) || -120, Number(source.maskingDb) || -120);
  target.depthDb = Math.max(Number(target.depthDb) || -120, Number(source.depthDb) || -120);
  target.relativeDb = Math.max(Number(target.relativeDb) || 0, Number(source.relativeDb) || 0);
  if (Number.isFinite(source.vocalVsOtherDb)) {
    target.vocalVsOtherDb = Math.min(Number(target.vocalVsOtherDb ?? 99), source.vocalVsOtherDb);
  }
}

function mfMergeBuriedWindows(windows, maxSpanSec = MF_VOCAL_RIDE_MAX_WINDOW_SEC) {
  const sorted = [...windows].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    const combined = last ? Math.max(last.end, window.end) - last.start : 0;
    if (last && window.start <= last.end + 0.35 && combined <= maxSpanSec) {
      last.end = Math.max(last.end, window.end);
      mfMergeWindowStats(last, window);
      continue;
    }
    merged.push({ ...window });
  }
  return merged;
}

function mfSplitLongWindows(windows, maxSpanSec = MF_VOCAL_RIDE_MAX_WINDOW_SEC) {
  const split = [];
  for (const window of windows || []) {
    const duration = window.end - window.start;
    if (duration <= maxSpanSec + 0.05) {
      split.push({ ...window });
      continue;
    }
    const pieces = Math.ceil(duration / maxSpanSec);
    const step = duration / pieces;
    for (let index = 0; index < pieces; index++) {
      const start = window.start + index * step;
      const end = index === pieces - 1 ? window.end : start + step;
      split.push({ ...window, start, end });
    }
  }
  return split;
}

function mfAnnotateWindowWithStems(window, vocalBuffer, otherBuffer) {
  const vocalDb = mfMeasureBufferWindowDb(vocalBuffer, window.start, window.end);
  const otherDb = mfMeasureBufferWindowDb(otherBuffer, window.start, window.end);
  const vocalVsOtherDb = Number.isFinite(vocalDb) && Number.isFinite(otherDb) ? vocalDb - otherDb : window.vocalVsOtherDb;
  const annotated = { ...window, vocalDb, otherDb, vocalVsOtherDb };
  annotated.depthDb = mfWindowRideDepthDb(annotated);
  return annotated;
}

function mfSongDuckBaseline(frames) {
  const active = (frames || []).filter((frame) => frame.rmsDb > -55);
  const maskings = active.map((frame) => mfWindowMaskingDb(frame)).filter((value) => Number.isFinite(value));
  const presences = active.map((frame) => Number(frame.presenceRatio)).filter((value) => Number.isFinite(value));
  const vsOthers = active.map((frame) => Number(frame.vocalVsOtherDb)).filter((value) => Number.isFinite(value));
  const peakPresence = presences.length ? Math.max(...presences) : 0;
  const presenceCut = Math.max(peakPresence * 0.65, mfPercentile(presences, 0.75) || 0);
  const brightMaskings = active
    .filter((frame) => (frame.presenceRatio || 0) >= presenceCut && presenceCut > 1e-6)
    .map((frame) => mfWindowMaskingDb(frame))
    .filter((value) => Number.isFinite(value));
  return {
    forwardMaskingDb: mfSortedMedian(brightMaskings) ?? mfPercentile(maskings, 0.2),
    medianMaskingDb: mfSortedMedian(maskings),
    medianPresenceRatio: mfSortedMedian(presences) || 0,
    medianVocalVsOtherDb: mfSortedMedian(vsOthers),
  };
}

function mfFrameRelativeDuckDb(frame, baseline = {}) {
  const masking = mfWindowMaskingDb(frame);
  const vsOther = Number(frame.vocalVsOtherDb);
  const parts = [];
  if (Number.isFinite(masking) && Number.isFinite(baseline.forwardMaskingDb)) {
    parts.push(masking - baseline.forwardMaskingDb);
  } else if (Number.isFinite(masking)) {
    parts.push(masking - MF_VOCAL_RIDE_CLEAR_DB);
  }
  if (Number.isFinite(vsOther) && Number.isFinite(baseline.medianVocalVsOtherDb)) {
    parts.push(baseline.medianVocalVsOtherDb - vsOther);
  } else if (Number.isFinite(vsOther) && vsOther < MF_VOCAL_VS_OTHER_DUCK_DB) {
    parts.push(-vsOther + MF_VOCAL_VS_OTHER_DUCK_DB);
  }
  return parts.length ? Math.max(0, ...parts) : 0;
}

function mfFrameIsActuallyDucked(frame, baseline = {}, clearDb = MF_VOCAL_RIDE_CLEAR_DB) {
  if (!(frame.rmsDb > -55)) return false;
  const masking = mfWindowMaskingDb(frame);
  const vsOther = Number(frame.vocalVsOtherDb);
  const relativeDb = mfFrameRelativeDuckDb(frame, baseline);
  const presenceDuck = baseline.medianPresenceRatio > 1e-6
    && (frame.presenceRatio || 0) < baseline.medianPresenceRatio * 0.55
    && Number.isFinite(masking)
    && masking > 10;
  const maskingDuck = Number.isFinite(masking) && masking > clearDb && relativeDb >= MF_VOCAL_RIDE_MIN_RELATIVE_DB;
  const stemDuck = Number.isFinite(vsOther)
    && vsOther < MF_VOCAL_VS_OTHER_DUCK_DB
    && (
      !Number.isFinite(baseline.medianVocalVsOtherDb)
      || baseline.medianVocalVsOtherDb - vsOther >= 1.5
    );
  return presenceDuck || maskingDuck || stemDuck;
}

function mfWindowsOverlapSec(left, right) {
  return Math.max(0, Math.min(Number(left.end), Number(right.end)) - Math.max(Number(left.start), Number(right.start)));
}

function mfCoalesceBuriedWindows(currentWindows, priorWindows) {
  if (!priorWindows?.length) return [...(currentWindows || [])];
  const still = [];
  for (const prior of priorWindows) {
    const span = Math.max(0.25, Number(prior.end) - Number(prior.start));
    const fragments = (currentWindows || []).filter((window) => mfWindowsOverlapSec(window, prior) > 0.2 * span);
    if (!fragments.length) continue;
    const merged = { ...prior };
    for (const fragment of fragments) mfMergeWindowStats(merged, fragment);
    still.push(merged);
  }
  const extras = (currentWindows || []).filter((window) => {
    const span = Math.max(0.25, Number(window.end) - Number(window.start));
    return !priorWindows.some((prior) => mfWindowsOverlapSec(window, prior) > 0.2 * span);
  });
  return still.concat(extras).sort((left, right) => left.start - right.start);
}

function mfFindBuriedVocalWindows(analysis, options = {}) {
  const clearDb = Number.isFinite(Number(options.clearMaskingDb)) ? Number(options.clearMaskingDb) : MF_VOCAL_RIDE_CLEAR_DB;
  const remasure = options.remeasure === true;
  let frames = (analysis?.frames || []).map((frame) => ({ ...frame }));

  // Stem levels help the first detect. Remeasure uses the reprinted mix frames only —
  // original stems plus ride credit is bookkeeping, not a moved masking number.
  if (!remasure && options.vocalBuffer && options.otherBuffer) {
    frames = frames.map((frame) => (
      frame.rmsDb > -55
        ? mfAnnotateWindowWithStems(frame, options.vocalBuffer, options.otherBuffer)
        : frame
    ));
  }

  // Freeze the original song's forward chorus. Recomputing baseline after a ride
  // makes newly brighter phrases the reference, so more frames look buried (56→59)
  // or a hole-punched phrase splits into extra windows.
  const baseline = options.baseline || mfSongDuckBaseline(frames);
  const toWindow = (frame, relativeDb) => ({
    start: frame.start,
    end: frame.end,
    maskingDb: mfWindowMaskingDb(frame),
    vocalVsOtherDb: Number(frame.vocalVsOtherDb),
    presenceGapDb: Number(frame.presenceGapDb),
    relativeDb,
    depthDb: mfWindowMaskingDb(frame),
  });
  const fromFrames = [];
  for (const frame of frames) {
    if (!mfFrameIsActuallyDucked(frame, baseline, clearDb)) continue;
    fromFrames.push(toWindow(frame, mfFrameRelativeDuckDb(frame, baseline)));
  }

  if (!fromFrames.length && !remasure && Number(baseline.medianMaskingDb) > MF_VOCAL_RIDE_RED_DB) {
    const worst = frames
      .filter((frame) => frame.rmsDb > -55 && Number.isFinite(mfWindowMaskingDb(frame)))
      .sort((left, right) => (mfWindowMaskingDb(right) || 0) - (mfWindowMaskingDb(left) || 0))
      .slice(0, 6);
    for (const frame of worst) fromFrames.push(toWindow(frame, Math.max(2, mfFrameRelativeDuckDb(frame, baseline))));
  }

  const windows = mfSplitLongWindows(mfMergeBuriedWindows(fromFrames))
    .filter((window) => (
      window.end - window.start >= MF_VOCAL_RIDE_MIN_WINDOW_SEC
      && window.end - window.start <= MF_VOCAL_RIDE_MAX_WINDOW_SEC + 0.05
    ));
  return remasure ? windows : mfKeepWorstPhrases(windows);
}

function mfGlobalVocalSeatDb({ songMaskingDb, rideCount } = {}) {
  if (!(Number(rideCount) > 0)) return 0;
  const masking = Number(songMaskingDb);
  if (!Number.isFinite(masking) || masking <= 12) return 0;
  return clamp((masking - 10) * 0.10, 0.5, MF_VOCAL_SEAT_MAX_DB);
}

function mfExistingRideGain(rides, window, stem = 'vocals') {
  const span = Math.max(0.25, (window.end - window.start));
  let sum = 0;
  for (const ride of rides || []) {
    if ((ride.stem || 'vocals') !== stem) continue;
    const overlap = Math.min(ride.end, window.end) - Math.max(ride.start, window.start);
    if (overlap > 0.25 * span) sum += Number(ride.gainDb) || 0;
  }
  return sum;
}

function mfVocalRideAmountDb(depthDb, options = {}) {
  const relativeDb = Number.isFinite(Number(options.relativeDb))
    ? Math.max(0, Number(options.relativeDb))
    : Math.max(0, Number(depthDb) - MF_VOCAL_RIDE_CLEAR_DB);
  const otherAvailable = options.otherAvailable !== false;
  const coeff = otherAvailable ? 0.18 : 0.28;
  const maxDb = otherAvailable
    ? (relativeDb >= 6 ? 1.8 : relativeDb >= 4 ? 1.3 : 0.9)
    : (relativeDb >= 6 ? 2.2 : 1.6);
  return clamp(relativeDb * coeff, MF_VOCAL_RIDE_PASS_MIN_DB, Math.min(maxDb, MF_VOCAL_RIDE_PASS_MAX_DB));
}

function mfCompetingWindowEaseDb(relativeDb, options = {}) {
  if (!(Number(options.vocalVsOtherDb) < MF_VOCAL_VS_OTHER_DUCK_DB)) return 0;
  const depth = Math.max(0, Number(relativeDb) || 0);
  const passMax = Number(options.pass) > 1 ? -2.0 : -1.2;
  return clamp(-Math.max(depth, 2) * 0.20, passMax, -0.6);
}

function mfKeepWorstPhrases(windows, maxPhrases = MF_VOCAL_RIDE_MAX_PHRASES) {
  const sorted = [...(windows || [])].sort((left, right) => (
    (Number(right.relativeDb) || Number(right.maskingDb) || 0)
    - (Number(left.relativeDb) || Number(left.maskingDb) || 0)
  ));
  return sorted.slice(0, maxPhrases).sort((left, right) => left.start - right.start);
}

function mfMeasureWindowMaskingDb(analysis, window) {
  if (!window) return null;
  const frames = (analysis?.frames || []).filter((frame) => mfWindowsOverlapSec(frame, window) > 0);
  const maskings = frames.map((frame) => mfWindowMaskingDb(frame)).filter((value) => Number.isFinite(value));
  if (maskings.length) return Math.max(...maskings);
  return mfWindowMaskingDb(window);
}

function mfNextBuriedPhrase(windows, rides = []) {
  const remaining = (windows || []).filter((window) => mfExistingRideGain(rides, window, 'vocals') < 0.4);
  return mfKeepWorstPhrases(remaining, 1)[0] || null;
}

function mfPhraseRideClearer(beforeDb, afterDb) {
  const before = Number(beforeDb);
  const after = Number(afterDb);
  if (!Number.isFinite(before) || !Number.isFinite(after)) return false;
  return after < before - 0.05;
}

function mfVocalRideQualityStop(beforeCounts = {}, afterCounts = {}) {
  const harshBefore = Number(beforeCounts.harshness_band || 0);
  const harshAfter = Number(afterCounts.harshness_band || 0);
  if (harshAfter > harshBefore) {
    return {
      qualityStop: 'harshness',
      qualityDetail: 'Harshness got worse after the last ride pass. That pass is wrong — MixForge will not tear the top to unbury the lead.',
    };
  }
  const sibBefore = Number(beforeCounts.sibilance || 0);
  const sibAfter = Number(afterCounts.sibilance || 0);
  if (sibAfter > sibBefore) {
    return {
      qualityStop: 'sibilance',
      qualityDetail: 'Sibilance got worse after the last ride pass. That pass is wrong — MixForge will not stack presence/air until the top tears.',
    };
  }
  const boomBefore = Number(beforeCounts.sub_bass_heavy || 0);
  const boomAfter = Number(afterCounts.sub_bass_heavy || 0);
  if (boomAfter > boomBefore) {
    return {
      qualityStop: 'boom',
      qualityDetail: 'Sub-bass / boom got worse after the last ride pass. That pass is wrong — MixForge will not trade a buried vocal for a heavier bottom.',
    };
  }
  return null;
}

function mfPlanVocalRides(windows, existingRides = [], options = {}) {
  const added = [];
  const rides = (existingRides || []).map((ride) => ({ ...ride }));
  const otherAvailable = options.otherAvailable !== false;
  for (const window of mfSplitLongWindows(windows || [])) {
    const duration = window.end - window.start;
    if (duration < MF_VOCAL_RIDE_MIN_WINDOW_SEC) continue;
    const depthDb = mfWindowRideDepthDb(window) ?? Number(window.maskingDb);
    const relativeDb = Number.isFinite(Number(window.relativeDb))
      ? Number(window.relativeDb)
      : Math.max(0, (Number.isFinite(depthDb) ? depthDb : 0) - MF_VOCAL_RIDE_CLEAR_DB);
    if (otherAvailable) {
      const otherAlready = mfExistingRideGain(rides, window, 'other');
      const otherRoom = otherAlready - MF_VOCAL_RIDE_EASE_TOTAL_MAX_DB;
      if (otherRoom >= 0.35) {
        const want = mfCompetingWindowEaseDb(relativeDb || Math.max(0, (depthDb || 0) - 10), {
          vocalVsOtherDb: window.vocalVsOtherDb,
          pass: options.pass,
        });
        const easeDb = -Math.min(-want, otherRoom);
        if (easeDb <= -0.35) {
          added.push({
            stem: 'other',
            start: window.start,
            end: window.end,
            gainDb: easeDb,
            maskingDb: window.maskingDb,
            depthDb,
            relativeDb,
            label: `Ease other ${mfFormatRideRange(window.start, window.end)} · ${easeDb.toFixed(1)} dB`,
          });
        }
      }
    }
    const vocalAlready = mfExistingRideGain(rides, window, 'vocals');
    const vocalRoom = MF_VOCAL_RIDE_TOTAL_MAX_DB - vocalAlready;
    if (vocalRoom >= 0.4 && Number.isFinite(depthDb)) {
      const gainDb = clamp(
        mfVocalRideAmountDb(depthDb, { relativeDb, otherAvailable }),
        0.4,
        Math.min(vocalRoom, MF_VOCAL_RIDE_PASS_MAX_DB),
      );
      added.push({
        stem: 'vocals',
        start: window.start,
        end: window.end,
        gainDb,
        maskingDb: window.maskingDb,
        depthDb,
        relativeDb,
        label: `Vocal ride ${mfFormatRideRange(window.start, window.end)} · +${gainDb.toFixed(1)} dB`,
      });
    }
  }
  return { rides: rides.concat(added), added };
}

async function mfIterateVocalRides({
  analyze,
  applyRides,
  initialAnalysis = null,
  otherAvailable = false,
  windowOptions = {},
  maxPasses = MF_VOCAL_RIDE_MAX_PASSES,
} = {}) {
  let analysis = initialAnalysis;
  if (!analysis && typeof analyze === 'function') analysis = await analyze(null);
  let rides = [];
  const passes = [];
  let stop = { reason: 'clear', detail: 'No buried vocal windows on the timeline.' };
  const frozenBaseline = windowOptions.baseline || mfSongDuckBaseline(analysis?.frames || []);
  const remasureOptions = { remeasure: true, baseline: frozenBaseline };
  let tracked = mfFindBuriedVocalWindows(analysis, remasureOptions);

  for (let pass = 1; pass <= maxPasses; pass++) {
    const phrase = mfNextBuriedPhrase(tracked, rides);
    const redCount = tracked.length;
    if (!phrase) {
      stop = {
        reason: tracked.length ? (rides.length ? 'held' : 'clear') : 'clear',
        detail: tracked.length
          ? `Stopped after ${passes.filter((row) => !row.reverted).length} kept phrase ride(s); ${tracked.length} window(s) still masked.`
          : (pass === 1 ? 'No buried vocal windows on the timeline.' : 'Buried phrases are clear after time-sliced rides.'),
      };
      break;
    }
    const ridesBefore = rides.map((ride) => ({ ...ride }));
    const analysisBefore = analysis;
    const trackedBefore = tracked.map((window) => ({ ...window }));
    const maskingBefore = mfMeasureWindowMaskingDb(analysis, phrase);
    // Pass 1 (and later phrase attempts) are vocal-stem only. A 34-window other
    // ease is the old one-shot cut into slices and is why bury count rose.
    const planned = mfPlanVocalRides([phrase], rides, { otherAvailable: false, pass });
    if (!planned.added.length) {
      stop = {
        reason: 'cap',
        detail: `Hard cap: remaining masked windows already sit at the +${MF_VOCAL_RIDE_TOTAL_MAX_DB.toFixed(1)} dB ride limit, so MixForge will not smash.`,
      };
      break;
    }
    if (typeof applyRides !== 'function') {
      throw new Error('applyRides is required to write vocal rides.');
    }
    const applied = await applyRides(planned.rides, planned.added, pass);
    const nextAnalysis = applied?.analysis || (typeof analyze === 'function' ? await analyze(applied?.buffer) : analysis);
    const maskingAfter = mfMeasureWindowMaskingDb(nextAnalysis, phrase);
    const vocalAdded = planned.added.find((ride) => (ride.stem || 'vocals') === 'vocals');
    const phraseLabel = `${mfFormatRideRange(phrase.start, phrase.end)} ${vocalAdded && Number(vocalAdded.gainDb) >= 0 ? '+' : ''}${Number(vocalAdded?.gainDb || 0).toFixed(1)} dB`;
    const discovered = mfFindBuriedVocalWindows(nextAnalysis, remasureOptions);
    const stillRed = mfCoalesceBuriedWindows(discovered, tracked);
    const phraseClearer = mfPhraseRideClearer(maskingBefore, maskingAfter);

    const revertPass = async (reason, detail) => {
      rides = ridesBefore;
      analysis = analysisBefore;
      tracked = trackedBefore;
      if (ridesBefore.length || pass === 1) {
        await applyRides(ridesBefore, [], pass);
      }
      stop = { reason, detail };
      passes.push({
        pass,
        redBefore: redCount,
        redAfter: stillRed.length,
        added: planned.added,
        phrase,
        maskingBefore,
        maskingAfter,
        reverted: true,
      });
    };

    if (applied?.qualityStop) {
      await revertPass(
        applied.qualityStop,
        `${applied.qualityDetail || `Quality stop (${applied.qualityStop}) after pass ${pass}.`} Vocal ride ${phraseLabel} was reverted.`,
      );
      break;
    }
    if (!phraseClearer) {
      const beforeText = Number.isFinite(maskingBefore) ? maskingBefore.toFixed(1) : '—';
      const afterText = Number.isFinite(maskingAfter) ? maskingAfter.toFixed(1) : '—';
      await revertPass(
        'no-move',
        `Vocal ride ${phraseLabel} did not lower that window’s masking (${beforeText} → ${afterText}); that ride was reverted.`,
      );
      break;
    }
    rides = planned.rides;
    analysis = nextAnalysis;
    tracked = stillRed;
    passes.push({
      pass,
      redBefore: redCount,
      redAfter: stillRed.length,
      added: planned.added,
      phrase,
      maskingBefore,
      maskingAfter,
    });
    if (!stillRed.length) {
      stop = { reason: 'clear', detail: 'Buried phrases are clear after time-sliced rides.' };
      break;
    }
    if (pass === maxPasses) {
      stop = {
        reason: 'max-passes',
        detail: `Stopped after ${maxPasses} phrase ride(s); ${stillRed.length} window(s) still masked.`,
      };
    }
  }

  return {
    rides,
    passes,
    analysis,
    stop,
    windowsRemaining: tracked,
    baseline: frozenBaseline,
  };
}

function mfBandDb(metrics, name) {
  if (!metrics) return null;
  if (typeof band === 'function') {
    const value = band(metrics, name);
    if (Number.isFinite(value) && value > -119) return value;
  }
  const row = (metrics.midBands || []).find((item) => item.name === name);
  return Number.isFinite(row?.db) ? row.db : null;
}

function mfPresenceMaskingSnapshot(metrics) {
  const lowMids = mfBandDb(metrics, 'Low-mids');
  const presence = mfBandDb(metrics, 'Presence');
  if (!Number.isFinite(lowMids) || !Number.isFinite(presence)) return null;
  return { lowMids, presence, maskingDb: lowMids - presence };
}

function mfParseMaskingFromFindings(findings) {
  for (const finding of findings || []) {
    const text = `${finding.problem || ''} ${finding.evidence || ''}`;
    if (!/mask|presence|low-mid|buried|lead-band/i.test(text)) continue;
    const match = text.match(/(\d+(?:\.\d+)?)\s*dB/i);
    if (match) return Number(match[1]);
  }
  return null;
}

function mfLeadFindingText(findings) {
  return (findings || []).map((finding) => `${finding.problem || ''} ${finding.evidence || ''} ${finding.action || ''}`).join(' ');
}

function mfLeadBuriedEvidence(audit = {}, metrics = null) {
  const findings = Array.isArray(audit?.findings) ? audit.findings : [];
  const snapshot = mfPresenceMaskingSnapshot(metrics);
  const parsed = mfParseMaskingFromFindings(findings);
  const maskingDb = Number.isFinite(snapshot?.maskingDb) ? snapshot.maskingDb : parsed;
  const named = /buried|lead-band masking|lead.?band masking|masked lead|vocal.*recede|presence is .* below/i.test(mfLeadFindingText(findings));
  const buriedFinding = findings.find((finding) => /buried|mask|lead-band|vocal/i.test(`${finding.problem || ''} ${finding.evidence || ''}`));
  const candidateConfidence = Math.max(0, ...((buriedFinding?.candidates || []).map((item) => Number(item.likelihood) || 0)));
  const confidence = Number(buriedFinding?.confidence) || candidateConfidence || (named ? 80 : 0);
  const fromMetrics = Number.isFinite(maskingDb) && maskingDb > MF_LEAD_MASKING_DB;
  const fromFinding = named && (confidence >= MF_VOCAL_UP_CONFIDENCE || !Number.isFinite(maskingDb) || maskingDb > 10);
  const warranted = fromMetrics || fromFinding;
  const liftDb = warranted ? mfVocalUpLiftDb(maskingDb) : 0;
  const competingEaseDb = warranted ? mfCompetingEaseDb(maskingDb) : 0;
  return {
    warranted,
    maskingDb: Number.isFinite(maskingDb) ? maskingDb : null,
    presenceDb: snapshot?.presence ?? null,
    lowMidsDb: snapshot?.lowMids ?? null,
    confidence,
    liftDb,
    competingEaseDb,
    stemsNeeded: warranted ? ['vocals', 'other'] : ['vocals'],
    skipWarning: MF_VOCAL_UP_SKIP_WARNING,
  };
}

function mfDbToGain(db) {
  if (typeof dbToGain === 'function') return dbToGain(db);
  return 10 ** (Number(db) / 20);
}

function mfStemBalanceDelta(raw, fixed, match, wet, mixGainDb) {
  const safeWet = clamp(Number(wet) || 0, 0, 1);
  const balance = mfDbToGain(clamp(Number(mixGainDb) || 0, MF_MIX_BALANCE_MIN_DB, MF_MIX_BALANCE_MAX_DB));
  return (raw * (1 - safeWet) + fixed * match * safeWet) * balance - raw;
}

function mfIsPresenceStackOp(op) {
  return /lyric clarity|presence\/air|presence recovery|air recovery|air lift|open cymbal air/i.test(op?.label || '');
}

function mfStripPresenceStackOps(stemPlans) {
  for (const plan of Object.values(stemPlans || {})) {
    if (!Array.isArray(plan?.operations)) continue;
    plan.operations = plan.operations.filter((op) => !mfIsPresenceStackOp(op));
    if (Array.isArray(plan.candidates)) {
      for (const candidate of plan.candidates) {
        if (Array.isArray(candidate.operations)) {
          candidate.operations = candidate.operations.filter((op) => !mfIsPresenceStackOp(op));
        }
      }
    }
  }
  return stemPlans;
}

function mfApplyVocalUpPlan(stemPlans, evidence) {
  if (!evidence?.warranted || !stemPlans?.vocals) return stemPlans;
  const rides = Array.isArray(evidence.rides) ? evidence.rides : [];
  const vocalRides = rides.filter((ride) => (ride.stem || 'vocals') === 'vocals');
  const otherRides = rides.filter((ride) => ride.stem === 'other');
  const vocals = stemPlans.vocals;
  // liftDb is the old song-length one-shot. Do not write it. Seat is last/global only.
  const seat = clamp(Number(evidence.globalSeatDb) || 0, 0, MF_VOCAL_SEAT_MAX_DB);
  vocals.mixGainDb = seat;
  vocals.rides = vocalRides;
  const ops = Array.isArray(vocals.operations)
    ? vocals.operations.filter((op) => op.type !== 'mixgain' && op.label !== 'No corrective processing required' && !/Vocal ride /i.test(op.label || ''))
    : [];
  const rideNotes = vocalRides.map((ride) => ({
    type: 'mixgain',
    gainDb: ride.gainDb,
    start: ride.start,
    end: ride.end,
    label: ride.label || `Vocal ride ${mfFormatRideRange(ride.start, ride.end)} · +${Number(ride.gainDb).toFixed(1)} dB`,
  }));
  vocals.operations = [...rideNotes, ...ops];
  if (Array.isArray(vocals.candidates)) {
    for (const candidate of vocals.candidates) {
      candidate.mixGainDb = seat;
      candidate.rides = vocalRides;
    }
  }
  if (stemPlans.other) {
    stemPlans.other.mixGainDb = 0;
    stemPlans.other.rides = otherRides;
    const otherOps = Array.isArray(stemPlans.other.operations) ? stemPlans.other.operations : [];
    const cleaned = otherOps.filter((op) => (
      op.label !== 'No corrective processing required'
      && op.type !== 'mixgain'
      && !/Ease other |competing (low-mid|residual)/i.test(op.label || '')
    ));
    const easeNotes = otherRides.map((ride) => ({
      type: 'mixgain',
      gainDb: ride.gainDb,
      start: ride.start,
      end: ride.end,
      label: ride.label || `Ease other ${mfFormatRideRange(ride.start, ride.end)} · ${Number(ride.gainDb).toFixed(1)} dB`,
    }));
    stemPlans.other.operations = [...easeNotes, ...cleaned];
    if (Array.isArray(stemPlans.other.candidates)) {
      for (const candidate of stemPlans.other.candidates) {
        candidate.mixGainDb = 0;
        candidate.rides = otherRides;
      }
    }
  }
  return stemPlans;
}

function mfRecommendPath(audit, metrics) {
  const buried = mfLeadBuriedEvidence(audit, metrics);
  if (buried.warranted) {
    return {
      path: 'forensic',
      label: 'Forensic Fix',
      reason: 'Lead-band masking needs isolation so the vocal can be raised in the mix. A stereo master would only raise everything.',
      vocalUp: buried,
    };
  }
  const readiness = clamp(Number(audit?.readinessScore) || 0, 0, 100);
  const stems = Array.isArray(audit?.stemsToInspect) ? audit.stemsToInspect : [];
  const findings = Array.isArray(audit?.findings) ? audit.findings : [];
  const highMix = findings.filter((finding) => finding.severity === 'high' && finding.stage === 'mix');
  const isolationNeeded = stems.length > 0 && (highMix.length > 0 || readiness < 70);

  if (!stems.length || readiness >= 78) {
    return {
      path: 'quick',
      label: 'Quick Master',
      reason: readiness >= 78
        ? 'Stereo readiness is already high — hear a release master first, then decide if isolation is worth it.'
        : 'No stem isolation is required from the stereo evidence. Master the mix directly and A/B the result.',
    };
  }
  if (isolationNeeded) {
    return {
      path: 'forensic',
      label: 'Forensic Fix',
      reason: 'Measured mix problems still need isolation before a confident repair. Stem separation is optional and costs quota time.',
    };
  }
  return {
    path: 'quick',
    label: 'Quick Master',
    reason: 'You can hear a useful stereo master now. Open Forensic Fix only if you want to isolate remaining hypotheses.',
  };
}

function mfNormalizeDemucsStems(requested) {
  const input = Array.isArray(requested) ? requested : [];
  const stems = [];
  const routes = [];
  for (const raw of input) {
    const requestedStem = String(raw || '');
    if (!requestedStem) continue;
    const actual = MF_STEM_ALIASES[requestedStem] || requestedStem;
    if (!MF_DEMUCS_STEMS.has(actual)) continue;
    if (!stems.includes(actual)) stems.push(actual);
    routes.push({
      requested: requestedStem,
      actual,
      honest: actual === requestedStem
        ? MF_STEM_DISPLAY[actual] || actual
        : `${requestedStem} → Demucs “other” (no separate guitar/keys stem)`,
    });
  }
  return { stems, routes };
}

function mfStemJobFraming(stems, durationSec = 0) {
  const count = Math.max(1, (stems || []).length);
  const minutes = Math.max(2, Math.round((Number(durationSec) || 180) / 90) + (count > 2 ? 2 : 1));
  return {
    etaLabel: `Estimate: ${minutes}–${minutes + 4} min (GPU may cold-start)`,
    costLabel: `Quota: ${MF_STEM_HOURLY_LIMIT} stems/hour · ${MF_STEM_DAILY_LIMIT}/day · not required for Quick Master`,
    escapeLabel: 'Skip stems / master stereo only',
    hourlyLimit: MF_STEM_HOURLY_LIMIT,
    dailyLimit: MF_STEM_DAILY_LIMIT,
  };
}

function mfEstimateReadiness(metrics, findingsCount = 0) {
  if (!metrics) return null;
  let score = 92;
  if (metrics.peakDb > -0.2) score -= 18;
  if (metrics.clipPercent > 0.001) score -= 20;
  if (metrics.correlation < 0.15) score -= 16;
  if (metrics.crestDb < 8) score -= 14;
  if (Math.abs((metrics.lufs || -12) + 12) > 3) score -= 6;
  score -= clamp(findingsCount * 4, 0, 24);
  return clamp(Math.round(score), 20, 98);
}

function mfPlainWhatChanged(before, after, plan, path = 'quick', options = {}) {
  if (!before || !after) return { headline: 'No master yet.', bullets: [], remaining: [] };
  const lufsDelta = after.lufs - before.lufs;
  const sampleBefore = before.peakDb;
  const sampleAfter = after.peakDb;
  const peakBefore = options.truePeakBefore ?? before.peakDb;
  const peakAfter = options.truePeakAfter ?? after.peakDb;
  const corrBefore = Number(before.correlation);
  const corrAfter = Number(after.correlation);
  const readinessBefore = options.readinessBefore ?? mfEstimateReadiness(before, options.findingsCount || 0);
  const readinessAfter = options.readinessAfter ?? mfEstimateReadiness(after, options.remainingRisks?.length || 0);
  const bullets = [
    `Loudness ${before.lufs.toFixed(1)} → ${after.lufs.toFixed(1)} LUFS (${lufsDelta >= 0 ? '+' : ''}${lufsDelta.toFixed(1)}).`,
    `Sample peak ${sampleBefore.toFixed(2)} → ${sampleAfter.toFixed(2)} dBFS.`,
    `True-peak estimate ${peakBefore.toFixed(2)} → ${peakAfter.toFixed(2)} dBTP (ceiling ${Number(plan?.truePeakCeilingDb ?? plan?.ceilingDb ?? -1).toFixed(1)}; cubic-interp, not a certified meter).`,
    `Stereo correlation ${Number.isFinite(corrBefore) ? corrBefore.toFixed(2) : '—'} → ${Number.isFinite(corrAfter) ? corrAfter.toFixed(2) : '—'}.`,
    `Release readiness ${readinessBefore} → ${readinessAfter} (measurement-based, not a quality score).`,
    path === 'quick'
      ? 'Path: Quick Master — stereo-only release processing, no stem isolation.'
      : 'Path: Forensic Fix — measured stem repairs, then a conservative master.',
  ];
  if (plan?.eq?.length) bullets.push(`Tonal moves: ${plan.eq.map((item) => mfFormatEqMove(item)).join('; ')}.`);
  else bullets.push('Tonal balance: no broad EQ was justified by the measurements.');
  if (plan?.compressor) bullets.push(`Dynamics: ${plan.compressor.label}.`);
  else bullets.push('Dynamics: no master compression (source already controlled or not justified).');
  const vocalUp = options.vocalUp;
  if (vocalUp?.applied && Array.isArray(vocalUp.rides) && vocalUp.rides.length) {
    const vocalRides = vocalUp.rides.filter((ride) => (ride.stem || 'vocals') === 'vocals');
    const otherRides = vocalUp.rides.filter((ride) => ride.stem === 'other');
    const passCount = Number(vocalUp.passes?.length) || 1;
    if (vocalRides.length) {
      const rideBits = vocalRides.map((ride) => {
        const pass = (vocalUp.passes || []).find((row) => (
          row.phrase
          && Math.max(Number(row.phrase.start), Number(ride.start))
            < Math.min(Number(row.phrase.end), Number(ride.end))
        ));
        const windowBit = Number.isFinite(Number(pass?.maskingBefore)) && Number.isFinite(Number(pass?.maskingAfter))
          ? ` · window ${Number(pass.maskingBefore).toFixed(1)} → ${Number(pass.maskingAfter).toFixed(1)} dB`
          : '';
        return `${mfFormatRideRange(ride.start, ride.end)} ${Number(ride.gainDb) >= 0 ? '+' : ''}${Number(ride.gainDb).toFixed(1)} dB${windowBit}`;
      });
      bullets.push(`Vocal rides (${passCount} pass${passCount === 1 ? '' : 'es'}, mix balance, not pitch/timing): ${rideBits.join('; ')}.`);
    }
    if (Number(vocalUp.globalSeatDb) > 0.05) {
      bullets.push(`Global vocal seat: +${Number(vocalUp.globalSeatDb).toFixed(1)} dB after the rides (last trim, not the bury fix).`);
    }
    if (otherRides.length) {
      bullets.push(`Competing other eased in those windows: ${otherRides.map((ride) => `${mfFormatRideRange(ride.start, ride.end)} ${Number(ride.gainDb).toFixed(1)} dB`).join('; ')}.`);
    }
    if (Number.isFinite(Number(vocalUp.windowsBefore)) && Number.isFinite(Number(vocalUp.windowsAfter))) {
      bullets.push(`Buried windows: ${Number(vocalUp.windowsBefore)} → ${Number(vocalUp.windowsAfter)} (level-matched spectral check — louder is not done).`);
    }
    if (Number.isFinite(Number(vocalUp.maskingBefore)) && Number.isFinite(Number(vocalUp.maskingAfter))) {
      bullets.push(`Song-level lead masking: ${Number(vocalUp.maskingBefore).toFixed(1)} → ${Number(vocalUp.maskingAfter).toFixed(1)} dB (low-mids vs presence).`);
    }
    if (vocalUp.stopDetail || vocalUp.stopReason) {
      bullets.push(`Stopped: ${vocalUp.stopDetail || vocalUp.stopReason}.`);
    }
  } else if (vocalUp?.applied) {
    // Reverted / empty rides: never print leftover liftDb (+4.9 one-shot) as the unbury.
    if (vocalUp.stopDetail || vocalUp.stopReason) {
      bullets.push(`Stopped: ${vocalUp.stopDetail || vocalUp.stopReason}.`);
    }
    if (Number.isFinite(Number(vocalUp.windowsBefore)) && Number.isFinite(Number(vocalUp.windowsAfter))) {
      bullets.push(`Buried windows: ${Number(vocalUp.windowsBefore)} → ${Number(vocalUp.windowsAfter)} (level-matched spectral check — louder is not done).`);
    }
    if (Number.isFinite(Number(vocalUp.maskingBefore)) && Number.isFinite(Number(vocalUp.maskingAfter))) {
      bullets.push(`Song-level lead masking: ${Number(vocalUp.maskingBefore).toFixed(1)} → ${Number(vocalUp.maskingAfter).toFixed(1)} dB (low-mids vs presence).`);
    }
  } else if (vocalUp?.warranted && (vocalUp.skipped || vocalUp.failed || path === 'quick')) {
    bullets.push(vocalUp.skipWarning || MF_VOCAL_UP_SKIP_WARNING);
  }
  const remaining = Array.isArray(options.remainingRisks) ? options.remainingRisks.slice() : [];
  if (vocalUp?.applied) {
    const windowsLeft = Number(vocalUp.windowsAfter);
    const progress = mfVocalUpMaskingProgress(vocalUp.maskingBefore, vocalUp.maskingAfter);
    const windowsBefore = Number(vocalUp.windowsBefore);
    const windowsGrew = Number.isFinite(windowsBefore) && Number.isFinite(windowsLeft) && windowsLeft > windowsBefore;
    if (windowsGrew) {
      remaining.push('Buried windows increased after the ride pass — that pass failed.');
    }
    if (windowsLeft > 0 || windowsGrew || (progress.token && !vocalUp.rides?.length)) {
      remaining.push('Lead masking windows are still red — this was not enough to unbury the vocal.');
    }
    const lufsJump = Number(after.lufs) - Number(before.lufs);
    if (lufsJump >= 3 && (windowsLeft > 0 || windowsGrew || progress.token || vocalUp.failed)) {
      remaining.push('Loudness rose while the vocal stayed buried — louder is not done.');
    }
  }
  return {
    headline: path === 'quick'
      ? 'Measured change on Quick Master'
      : 'Measured change after Forensic Fix + master',
    bullets,
    remaining,
    readinessBefore,
    readinessAfter,
    disclaimer: 'These numbers show measured change. They do not claim the mix sounds better.',
  };
}

function mfBuildReadinessReportText(payload) {
  const lines = [];
  lines.push('MixForge release readiness report');
  lines.push('================================');
  lines.push(`File: ${payload.fileName || 'mix'}`);
  lines.push(`Path: ${payload.pathLabel || payload.path || 'unknown'}`);
  lines.push(`Generated: ${payload.generatedAt || new Date().toISOString()}`);
  lines.push('');
  lines.push('Before');
  lines.push(`- LUFS: ${payload.before?.lufs?.toFixed?.(1) ?? '—'}`);
  lines.push(`- Peak: ${payload.before?.peakDb?.toFixed?.(2) ?? '—'} dBFS`);
  lines.push(`- Readiness: ${payload.readinessBefore ?? '—'}`);
  lines.push('');
  lines.push('After');
  lines.push(`- LUFS: ${payload.after?.lufs?.toFixed?.(1) ?? '—'}`);
  lines.push(`- Peak: ${payload.after?.peakDb?.toFixed?.(2) ?? '—'} dBFS`);
  lines.push(`- True peak: ${payload.truePeakAfter?.toFixed?.(2) ?? '—'} dBTP`);
  lines.push(`- Readiness: ${payload.readinessAfter ?? '—'}`);
  lines.push('');
  lines.push('What changed');
  for (const bullet of payload.bullets || []) lines.push(`- ${bullet}`);
  lines.push('');
  lines.push('Remaining risks');
  if (payload.remaining?.length) {
    for (const risk of payload.remaining) lines.push(`- ${risk}`);
  } else {
    lines.push('- No outstanding marker risks listed.');
  }
  lines.push('');
  lines.push(`Seat: MixForge = mix repair + release master. Vocal performance lives in AuraMix (${MF_AURAMIX_URL}).`);
  lines.push('Thesis: evidence-first, conservative repairs, show measured change (loudness, peak, remaining risks).');
  return `${lines.join('\n')}\n`;
}

function mfFormatEqMove(item) {
  const hz = Math.round(Number(item?.frequency) || 0);
  const gain = Number(item?.gain);
  const label = item?.label || item?.filterType || 'EQ';
  if (hz && Number.isFinite(gain)) return `${label} · ${hz} Hz · ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB`;
  if (hz) return `${label} · ${hz} Hz`;
  if (Number.isFinite(gain)) return `${label} · ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB`;
  return label;
}

function mfCorrectedPreviewAvailable(stateLike = {}) {
  return Boolean(stateLike.corrected) && stateLike.corrected !== stateLike.original;
}

function mfAbMatchOffsetDb(beforeLufs, afterLufs) {
  const before = Number(beforeLufs);
  const after = Number(afterLufs);
  if (!Number.isFinite(before) || !Number.isFinite(after)) return 0;
  return Math.max(0, Math.round((after - before) * 10) / 10);
}

function mfAbBarCopy(offsetDb) {
  const offset = Math.max(0, Number(offsetDb) || 0);
  return {
    original: 'A · Original',
    matched: offset > 0.05 ? `B · Master (matched −${offset.toFixed(1)} dB)` : 'B · Master (matched)',
    release: 'Release master (loud)',
    hint: offset > 0.05
      ? `B is turned down ${offset.toFixed(1)} dB to match Original so louder ≠ better. Release master is the unmatched loud export.`
      : 'Press B to A/B · Space play/pause · level-matched so louder ≠ better. Release master is the unmatched loud export.',
    offsetDb: offset,
  };
}

function mfMusicianEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

function mfEnsureMusicianMounts() {
  if (typeof document === 'undefined') return;
  const auditPanel = $('auditPanel');
  if (auditPanel && !$('pathChooser')) {
    const chooser = mfMusicianEl('section', 'path-chooser hidden');
    chooser.id = 'pathChooser';
    chooser.setAttribute('aria-live', 'polite');
    const separate = $('separateActions');
    if (separate) auditPanel.insertBefore(chooser, separate);
    else auditPanel.append(chooser);
  }

  if ($('separateActions') && !$('stemConsent')) {
    const consent = mfMusicianEl('div', 'stem-consent hidden');
    consent.id = 'stemConsent';
    $('separateActions').before(consent);
  }

  const preview = $('previewBox');
  if (preview && !$('abToggleBar')) {
    const bar = mfMusicianEl('div', 'ab-toggle-bar');
    bar.id = 'abToggleBar';
    bar.innerHTML = `
      <div class="ab-toggle-group" role="group" aria-label="A/B preview">
        <button type="button" class="ab-btn" data-ab="original" id="abOriginalBtn">A · Original</button>
        <button type="button" class="ab-btn active" data-ab="matched" id="abMasterBtn">B · Master (matched)</button>
        <button type="button" class="ab-btn ab-release" data-ab="master" id="abReleaseBtn">Release master (loud)</button>
      </div>
      <p class="ab-hint" id="abHint">Press <kbd>B</kbd> to A/B · <kbd>Space</kbd> play/pause · level-matched so louder ≠ better. Release master is the unmatched loud export.</p>`;
    preview.insertBefore(bar, preview.firstChild);
  }

  const verify = $('verifyPanel');
  if (verify && !$('whatChanged')) {
    const box = mfMusicianEl('section', 'what-changed hidden');
    box.id = 'whatChanged';
    const metrics = $('finalMetrics');
    if (metrics) verify.insertBefore(box, metrics);
    else {
      const actions = verify.querySelector('.actions');
      if (actions) verify.insertBefore(box, actions);
      else verify.append(box);
    }
  }
  if (verify && !$('exportSafety')) {
    const safety = mfMusicianEl('div', 'export-safety hidden');
    safety.id = 'exportSafety';
    const msg = mfMusicianEl('p', '');
    msg.id = 'exportSafetyMsg';
    const label = document.createElement('label');
    label.className = 'export-override';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = 'exportOverride';
    label.append(box, document.createTextNode(' Export anyway — I accept a clipped or over-ceiling master'));
    safety.append(msg, label);
    const actions = verify.querySelector('.actions');
    if (actions) verify.insertBefore(safety, actions);
    else verify.append(safety);
    box.addEventListener('change', () => {
      state.exportOverride = Boolean(box.checked);
      if (typeof syncExportUi === 'function') syncExportUi(state);
    });
  }

  if ($('exportBtn') && !$('readinessReportBtn')) {
    const reportBtn = document.createElement('button');
    reportBtn.type = 'button';
    reportBtn.className = 'secondary';
    reportBtn.id = 'readinessReportBtn';
    reportBtn.textContent = 'Download readiness report';
    $('exportBtn').after(reportBtn);
  }
}

function mfRenderPathChooser(audit) {
  const root = $('pathChooser');
  if (!root) return;
  const recommendation = mfRecommendPath(audit, state.mixMetrics);
  state.mixforgeRecommendation = recommendation;
  if (recommendation.vocalUp?.warranted) state.vocalUpRepair = { ...(state.vocalUpRepair || {}), ...recommendation.vocalUp };
  root.classList.remove('hidden');
  root.replaceChildren();

  const head = mfMusicianEl('div', 'path-chooser-head');
  head.append(
    mfMusicianEl('h3', '', 'Choose your first path'),
    mfMusicianEl('p', '', `${recommendation.label} recommended. ${recommendation.reason}`),
  );
  root.append(head);

  const grid = mfMusicianEl('div', 'path-grid');
  const quick = mfMusicianEl('button', `path-card${recommendation.path === 'quick' ? ' recommended' : ''}`);
  quick.type = 'button';
  quick.id = 'quickMasterPathBtn';
  quick.innerHTML = `<strong>Quick Master</strong><span>Drop mix → hear Original vs Master fast. Stereo-only release processing. No stem separation.</span><em>${recommendation.path === 'quick' ? 'Suggested for this mix' : 'Available now'}</em>`;
  const forensic = mfMusicianEl('button', `path-card${recommendation.path === 'forensic' ? ' recommended' : ''}`);
  forensic.type = 'button';
  forensic.id = 'forensicPathBtn';
  forensic.innerHTML = recommendation.vocalUp?.warranted
    ? `<strong>Forensic Fix</strong><span>Isolate the vocal and write time-sliced rides on buried phrases (level/balance only). A stereo master cannot unbury a masked lead.</span><em>Suggested — vocal rides</em>`
    : `<strong>Forensic Fix</strong><span>Timeline windows → honest stem investigation → targeted repair → verify. Opt-in; not required for a first A/B.</span><em>${recommendation.path === 'forensic' ? 'Suggested when isolation is needed' : 'Deeper path'}</em>`;
  grid.append(quick, forensic);
  root.append(grid);

  const seat = mfMusicianEl('p', 'path-seat');
  seat.append(
    document.createTextNode('MixForge fixes mix problems, then masters for release. Dedicated vocal production lives in '),
  );
  const aura = document.createElement('a');
  aura.href = MF_AURAMIX_URL;
  aura.target = '_blank';
  aura.rel = 'noopener noreferrer';
  aura.textContent = 'AuraMix';
  seat.append(aura, document.createTextNode('. Gemini may listen to the mix/master excerpt; it does not judge performance.'));
  root.append(seat);

  quick.onclick = () => { void mfStartQuickMaster(); };
  forensic.onclick = () => { mfStartForensicPath(); };
}

function mfSetPipeline(path) {
  const pipeline = document.querySelector('.pipeline');
  const note = $('pipelineNote');
  if (pipeline) {
    if (path === 'quick') {
      pipeline.innerHTML = '<span>Observe</span><b>→</b><span>Locate</span><b>→</b><span>Master</span><b>→</b><span>Verify</span>';
      pipeline.setAttribute('aria-label', 'Quick Master path');
    } else if (path === 'forensic') {
      pipeline.innerHTML = '<span>Observe</span><b>→</b><span>Locate</span><b>→</b><span>Isolate</span><b>→</b><span>Confirm</span><b>→</b><span>Repair</span><b>→</b><span>Verify</span>';
      pipeline.setAttribute('aria-label', 'Forensic Fix path');
    }
  }
  if (note) {
    note.textContent = path === 'quick'
      ? 'Quick Master: Observe → Locate → Master → Verify. Gemini listens to the mix/master excerpt, not vocal performance.'
      : path === 'forensic'
        ? 'Forensic Fix: Observe → Locate → Isolate → Confirm → Repair → Verify. Demucs separates four buckets; guitars/keys share residual other.'
        : 'Quick Master skips Isolate / Confirm / Repair. Gemini listens to the mix/master, not vocal performance (AuraMix).';
  }
}

function mfUpdateMasterCopy() {
  const copy = document.querySelector('#masterPanel .panel-title p');
  if (!copy) return;
  const hasReference = Boolean(forensicState?.references?.length);
  copy.textContent = hasReference
    ? 'Reference-bounded tonal balance is active because a reference file is loaded, plus evidence-bounded repairs for measured #1 issues. Controlled dynamics, loudness, limiting, cubic-interp peak safety. First value is hearing Original vs Master.'
    : 'Evidence-bounded stereo master: measured #1 issues (sub-bass accumulation, dark top) are repaired before loudness. Optional reference-bounded tonal balance only if you load a reference. Controlled dynamics, loudness, limiting, cubic-interp peak safety. First value is hearing Original vs Master.';
}

function mfSyncAbBar(stateLike = state) {
  const offset = mfAbMatchOffsetDb(stateLike?.mixMetrics?.lufs, stateLike?.finalMetrics?.lufs);
  const copy = mfAbBarCopy(offset);
  if ($('abOriginalBtn')) $('abOriginalBtn').textContent = copy.original;
  if ($('abMasterBtn')) $('abMasterBtn').textContent = copy.matched;
  if ($('abReleaseBtn')) $('abReleaseBtn').textContent = copy.release;
  if ($('abHint')) $('abHint').textContent = copy.hint;
  return copy;
}

function mfHideStemUi() {
  hide('separateActions');
  if ($('stemConsent')) $('stemConsent').classList.add('hidden');
}

async function mfStartQuickMaster() {
  const gate = MixForgeHub.requireEntitlement('quickMaster');
  if (!gate.ok) {
    setStatus('auditStatus', `Quick Master needs Hub access (${gate.reason}).`, 'error');
    return;
  }
  state.mixforgePath = 'quick';
  mfSetPipeline('quick');
  mfUpdateMasterCopy();
  mfHideStemUi();
  state.master = null;
  state.finalMetrics = null;
  state.masterDirty = true;
  if ($('pathChooser')) {
    $('pathChooser').querySelectorAll('.path-card').forEach((card) => card.classList.remove('active'));
    $('quickMasterPathBtn')?.classList.add('active');
  }
  const buried = mfLeadBuriedEvidence(state.audit, state.mixMetrics);
  if (buried.warranted && !state.vocalUpRepair?.applied) {
    state.vocalUpRepair = { ...(state.vocalUpRepair || {}), ...buried, skipped: true, applied: false };
    setStatus('auditStatus', buried.skipWarning, 'warn');
  } else {
    setStatus('auditStatus', 'Quick Master: rendering a stereo release master for A/B…', 'busy');
  }
  state.corrected = state.original;
  state.correctedMetrics = state.mixMetrics || measureBuffer(state.original);
  prepareMastering();
  $('masterPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    $('renderMasterBtn').disabled = true;
    setStatus('masterStatus', 'Quick Master rendering tonal balance, loudness, and true-peak-safe limiting…', 'busy');
    state.master = await renderReleaseMaster();
    markMasterRendered(state.master);
    state.finalMetrics = measureBuffer(state.master);
    renderMetrics('finalMetrics', state.finalMetrics);
    renderVerification(state.finalMetrics, state.masterPlan);
    reveal('previewBox');
    if ($('abToggleBar')) $('abToggleBar').classList.remove('hidden');
    if (typeof syncPreviewSourceAvailability === 'function') syncPreviewSourceAvailability();
    reveal('verifyPanel');
    mfSelectAbPreview('matched');
    mfSyncAbBar(state);
    mfRenderWhatChanged();
    setStatus('masterStatus', 'Quick Master ready — A/B Original vs Master below.', 'ok');
    setStatus('auditStatus', 'Quick Master complete. Press B to flip A/B while listening.', 'ok');
    $('previewBox')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) {
    console.error(error);
    setStatus('masterStatus', `Quick Master failed: ${error.message}`, 'error');
    setStatus('auditStatus', `Quick Master failed: ${error.message}`, 'error');
  } finally {
    $('renderMasterBtn').disabled = false;
  }
}

function mfStartForensicPath() {
  const gate = MixForgeHub.requireEntitlement('forensicStems');
  if (!gate.ok) {
    setStatus('auditStatus', `Forensic Fix needs Hub access (${gate.reason}).`, 'error');
    return;
  }
  state.mixforgePath = 'forensic';
  if (typeof invalidateRenderedMaster === 'function') {
    invalidateRenderedMaster('Forensic Fix started. The previous stereo master is not the vocal-up export — isolate and rebuild first.');
  } else {
    state.master = null;
    state.finalMetrics = null;
    state.masterDirty = true;
    state.masterExportId = null;
  }
  mfSetPipeline('forensic');
  if ($('pathChooser')) {
    $('pathChooser').querySelectorAll('.path-card').forEach((card) => card.classList.remove('active'));
    $('forensicPathBtn')?.classList.add('active');
  }

  const buried = mfLeadBuriedEvidence(state.audit, state.mixMetrics);
  const requested = [...(state.audit?.stemsToInspect || [])];
  if (buried.warranted) {
    for (const stem of buried.stemsNeeded) {
      if (!requested.includes(stem)) requested.push(stem);
    }
    state.vocalUpRepair = { ...(state.vocalUpRepair || {}), ...buried, skipped: false, failed: false };
  }
  const normalized = mfNormalizeDemucsStems(requested);
  state.audit = {
    ...(state.audit || {}),
    stemsToInspect: normalized.stems.length ? normalized.stems : (buried.warranted ? ['vocals'] : ['other']),
    stemRoutes: normalized.routes,
  };
  mfRenderStemConsent(state.audit);
  reveal('separateActions');
  $('stemListLabel').textContent = normalized.routes.length
    ? `Honest Demucs routes: ${normalized.routes.map((route) => route.honest).join(' · ')}`
    : 'Stereo residual investigation';
  setStatus('auditStatus', 'Forensic path armed. Review stem cost/ETA, or skip to Quick Master.', 'ok');
  $('stemConsent')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function mfRenderStemConsent(audit) {
  const root = $('stemConsent');
  if (!root) return;
  const stems = audit?.stemsToInspect || [];
  const framing = mfStemJobFraming(stems, state.original?.duration || 0);
  root.classList.remove('hidden');
  root.replaceChildren();
  root.append(mfMusicianEl('h3', '', 'Before source investigation'));
  root.append(mfMusicianEl('p', '', 'Demucs htdemucs returns vocals, bass, drums, and one residual “other” bucket. Guitars and keys are not separate confirmable stems — they land in other.'));
  const meta = mfMusicianEl('div', 'stem-consent-meta');
  meta.innerHTML = `<span>${framing.etaLabel}</span><span>${framing.costLabel}</span>`;
  root.append(meta);
  if (audit?.stemRoutes?.length) {
    const list = mfMusicianEl('ul', 'stem-route-list');
    for (const route of audit.stemRoutes) {
      const item = document.createElement('li');
      item.textContent = route.honest;
      list.append(item);
    }
    root.append(list);
  }
  const actions = mfMusicianEl('div', 'stem-consent-actions');
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'secondary';
  skip.id = 'skipStemsBtn';
  skip.textContent = framing.escapeLabel;
  skip.onclick = () => {
    const buried = mfLeadBuriedEvidence(state.audit, state.mixMetrics);
    if (buried.warranted) {
      state.vocalUpRepair = { ...(state.vocalUpRepair || {}), ...buried, skipped: true, applied: false };
      setStatus('auditStatus', buried.skipWarning, 'warn');
    }
    void mfStartQuickMaster();
  };
  actions.append(skip);
  root.append(actions);
  const buried = mfLeadBuriedEvidence(audit, state.mixMetrics);
  root.append(mfMusicianEl('small', '', buried.warranted
    ? `${buried.skipWarning} After separation, Forensic writes time-sliced vocal rides on buried phrases (and eases residual other in those windows) — not a song-length one-shot, not pitch or timing (AuraMix).`
    : 'After separation you get a heuristic leakage/fit score — not lab SDR. Demucs separates four buckets; guitars/keys share residual other.'));
}

function mfSelectAbPreview(value) {
  const preferred = value === 'matched' && $('mfMatchedPreview') ? 'matched' : value === 'master' ? 'master' : value;
  const input = document.querySelector(`input[name="preview"][value="${preferred}"]`)
    || document.querySelector(`input[name="preview"][value="master"]`);
  if (input) {
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  document.querySelectorAll('.ab-btn').forEach((button) => {
    button.classList.toggle('active', button.getAttribute('data-ab') === preferred);
  });
}

function mfToggleAbPreview() {
  const selected = document.querySelector('input[name="preview"]:checked')?.value;
  const onMaster = selected === 'master' || selected === 'matched';
  mfSelectAbPreview(onMaster ? 'original' : ($('mfMatchedPreview') ? 'matched' : 'master'));
}

function mfRenderWhatChanged() {
  const root = $('whatChanged');
  if (!root || !state.mixMetrics || !state.finalMetrics) return;
  const remaining = [];
  if (state.timelineSelfCheck?.remaining?.length) {
    for (const type of state.timelineSelfCheck.remaining) remaining.push(String(type).replaceAll('_', ' '));
  }
  if (state.audit?.findings?.some((finding) => finding.severity === 'high')) {
    remaining.push('High-severity stereo findings may still need Forensic Fix if the A/B is not enough.');
  }
  const summary = mfPlainWhatChanged(state.mixMetrics, state.finalMetrics, state.masterPlan, state.mixforgePath || 'quick', {
    truePeakBefore: state.mixMetrics.peakDb,
    truePeakAfter: state.masterConstraint?.truePeakDb ?? state.finalMetrics.peakDb,
    readinessBefore: state.audit?.readinessScore,
    findingsCount: state.audit?.findings?.length || 0,
    remainingRisks: remaining,
    vocalUp: state.vocalUpRepair,
  });
  state.mixforgeWhatChanged = summary;
  root.classList.remove('hidden');
  root.replaceChildren();
  root.append(mfMusicianEl('h3', '', summary.headline));
  root.append(mfMusicianEl('p', 'what-changed-disclaimer', summary.disclaimer || 'These numbers show measured change. They do not claim the mix sounds better.'));
  const list = mfMusicianEl('ul', 'what-changed-list');
  for (const bullet of summary.bullets) list.append(Object.assign(document.createElement('li'), { textContent: bullet }));
  root.append(list);
  if (summary.remaining.length) {
    root.append(mfMusicianEl('p', 'what-changed-remaining', `Still watch: ${summary.remaining.join('; ')}.`));
  } else {
    root.append(mfMusicianEl('p', 'what-changed-remaining', 'No major remaining marker risks listed after verification.'));
  }
}

function mfShouldAutoVocalUp(stateLike = state) {
  return Boolean(
    stateLike.mixforgePath === 'forensic'
    && stateLike.vocalUpRepair?.warranted
    && !stateLike.vocalUpRepair?.autoRebuildStarted
    && stateLike.stemBuffers?.vocals
  );
}

async function mfRunVocalUpRebuildAndMaster() {
  const evidence = state.vocalUpRepair || mfLeadBuriedEvidence(state.audit, state.mixMetrics);
  if (!evidence?.warranted || !state.stemBuffers?.vocals) return;
  state.vocalUpRepair = { ...evidence, autoRebuildStarted: true };
  if (state.stemPlans) mfStripPresenceStackOps(state.stemPlans);
  if ($('rebuildBtn')) {
    $('rebuildBtn').disabled = true;
    $('rebuildBtn').textContent = 'Write vocal rides and rebuild mix';
  }
  setStatus('rebuildStatus', 'Measuring the timeline for buried vocal phrases, then writing time-sliced rides…', 'busy');
  try {
    const initialAnalysis = state.timelineSourceAnalysis
      || (typeof mfTimelineAnalyze === 'function' ? await mfTimelineAnalyze(state.original) : { markers: [], frames: [] });
    const windowOptions = {
      vocalBuffer: state.stemBuffers?.vocals,
      otherBuffer: state.stemBuffers?.other,
    };
    const windowsBefore = mfFindBuriedVocalWindows(initialAnalysis, { remeasure: true }).length;
    const otherAvailable = Boolean(state.stemBuffers?.other && state.stemPlans?.other);
    const result = await mfIterateVocalRides({
      initialAnalysis,
      otherAvailable,
      windowOptions,
      analyze: async (buffer) => {
        const target = buffer || state.corrected || state.original;
        return typeof mfTimelineAnalyze === 'function' ? mfTimelineAnalyze(target) : initialAnalysis;
      },
      applyRides: async (rides, added, pass) => {
        setStatus('rebuildStatus', `Writing vocal rides · pass ${pass} · ${added.filter((ride) => (ride.stem || 'vocals') === 'vocals').length} phrase(s)…`, 'busy');
        mfApplyVocalUpPlan(state.stemPlans, { ...evidence, warranted: true, rides });
        state.corrected = await rebuildCorrectedMix();
        state.correctedMetrics = measureBuffer(state.corrected);
        const analysis = typeof mfTimelineAnalyze === 'function'
          ? await mfTimelineAnalyze(state.corrected)
          : { markers: [], frames: [] };
        const peak = Number(state.correctedMetrics?.peakDb);
        if (Number.isFinite(peak) && peak > MF_VOCAL_RIDE_PEAK_STOP_DB) {
          return {
            buffer: state.corrected,
            analysis,
            qualityStop: 'true-peak',
            qualityDetail: `True-peak / sample-peak stop: reprint peaked at ${peak.toFixed(2)} dBFS. MixForge will not smash or clip to chase the remaining windows.`,
          };
        }
        const quality = mfVocalRideQualityStop(initialAnalysis?.counts, analysis?.counts);
        if (quality) {
          return {
            buffer: state.corrected,
            analysis,
            qualityStop: quality.qualityStop,
            qualityDetail: quality.qualityDetail,
          };
        }
        const crestBefore = Number(state.mixMetrics?.crestDb);
        const crestAfter = Number(state.correctedMetrics?.crestDb);
        if (Number.isFinite(crestBefore) && Number.isFinite(crestAfter) && crestAfter < crestBefore - 1.5) {
          return {
            buffer: state.corrected,
            analysis,
            qualityStop: 'smash',
            qualityDetail: `Smash stop: crest collapsed ${crestBefore.toFixed(1)} → ${crestAfter.toFixed(1)} dB. MixForge will not squash the mix to chase remaining windows.`,
          };
        }
        setStatus('rebuildStatus', `Remeasuring the ridden phrase (window masking, not a 56-wide count)…`, 'busy');
        return { buffer: state.corrected, analysis };
      },
    });
    if (!state.corrected) {
      mfApplyVocalUpPlan(state.stemPlans, { ...evidence, warranted: true, rides: result.rides });
      state.corrected = await rebuildCorrectedMix();
      state.correctedMetrics = measureBuffer(state.corrected);
    }
    const afterSnap = mfPresenceMaskingSnapshot(state.correctedMetrics);
    const beforeSnap = mfPresenceMaskingSnapshot(state.mixMetrics);
    const seat = result.stop?.reason === 'clear'
      ? mfGlobalVocalSeatDb({
        songMaskingDb: afterSnap?.maskingDb ?? evidence.maskingDb,
        rideCount: result.rides.filter((ride) => (ride.stem || 'vocals') === 'vocals').length,
      })
      : 0;
    if (seat > 0.05) {
      mfApplyVocalUpPlan(state.stemPlans, { ...evidence, warranted: true, rides: result.rides, globalSeatDb: seat });
      state.corrected = await rebuildCorrectedMix();
      state.correctedMetrics = measureBuffer(state.corrected);
    }
    const seatedSnap = mfPresenceMaskingSnapshot(state.correctedMetrics) || afterSnap;
    const progress = mfVocalUpMaskingProgress(
      evidence.maskingDb ?? beforeSnap?.maskingDb,
      seatedSnap?.maskingDb,
    );
    const unburyFailed = result.stop?.reason !== 'clear'
      || result.windowsRemaining.length > windowsBefore
      || (result.windowsRemaining.length > 0 && progress.token);
    state.vocalUpRepair = {
      ...state.vocalUpRepair,
      applied: true,
      skipped: false,
      failed: unburyFailed,
      liftDb: 0,
      appliedLiftDb: 0,
      rides: result.rides,
      passes: result.passes,
      globalSeatDb: seat,
      stopReason: result.stop?.reason,
      stopDetail: result.stop?.detail,
      windowsBefore,
      windowsAfter: result.windowsRemaining.length,
      competingEaseApplied: result.rides.some((ride) => ride.stem === 'other'),
      maskingBefore: evidence.maskingDb ?? beforeSnap?.maskingDb,
      maskingAfter: seatedSnap?.maskingDb,
      presenceBefore: evidence.presenceDb ?? beforeSnap?.presence,
      presenceAfter: seatedSnap?.presence,
    };
    setStatus('rebuildStatus', result.stop?.detail || 'Vocal rides written.', result.stop?.reason === 'clear' && !unburyFailed ? 'ok' : 'warn');
    prepareMastering();
    const canHearReprint = Boolean(state.corrected && state.correctedMetrics);
    if (!unburyFailed && typeof renderReleaseMaster === 'function') {
      $('renderMasterBtn') && ($('renderMasterBtn').disabled = true);
      setStatus('masterStatus', 'Mastering the reprinted mix after vocal rides…', 'busy');
      state.master = await renderReleaseMaster();
      markMasterRendered(state.master);
      state.finalMetrics = measureBuffer(state.master);
      renderMetrics('finalMetrics', state.finalMetrics);
      renderVerification(state.finalMetrics, state.masterPlan);
      reveal('previewBox');
      if ($('abToggleBar')) $('abToggleBar').classList.remove('hidden');
      if (typeof syncPreviewSourceAvailability === 'function') syncPreviewSourceAvailability();
      reveal('verifyPanel');
      mfSelectAbPreview('matched');
      mfSyncAbBar(state);
      mfRenderWhatChanged();
      setStatus('masterStatus', 'Forensic vocal-ride master ready — A/B Original vs Master below.', 'ok');
      setStatus('auditStatus', 'Time-sliced vocal rides written, then mastered. Press B to A/B.', 'ok');
    } else if (canHearReprint) {
      state.finalMetrics = state.correctedMetrics;
      renderMetrics('finalMetrics', state.finalMetrics);
      reveal('previewBox');
      if ($('abToggleBar')) $('abToggleBar').classList.remove('hidden');
      if (typeof syncPreviewSourceAvailability === 'function') syncPreviewSourceAvailability();
      reveal('verifyPanel');
      mfSelectAbPreview('matched');
      mfSyncAbBar(state);
      mfRenderWhatChanged();
      setStatus('masterStatus', 'Unbury did not clear. Hear the level-matched reprint — louder is not done.', 'warn');
      setStatus('auditStatus', result.stop?.detail || 'Lead masking windows are still red. A louder master would not be the fix.', 'warn');
    }
    $('masterPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    console.error(error);
    setStatus('rebuildStatus', `Vocal-up rebuild failed: ${error.message}`, 'error');
  } finally {
    if ($('rebuildBtn')) $('rebuildBtn').disabled = false;
    if ($('renderMasterBtn')) $('renderMasterBtn').disabled = false;
  }
}

function mfDownloadReadinessReport() {
  const gate = MixForgeHub.requireEntitlement('export');
  if (!gate.ok) {
    setStatus('exportStatus', `Report download needs Hub access (${gate.reason}).`, 'error');
    return;
  }
  const summary = state.mixforgeWhatChanged || mfPlainWhatChanged(
    state.mixMetrics,
    state.finalMetrics,
    state.masterPlan,
    state.mixforgePath || 'quick',
    { remainingRisks: state.timelineSelfCheck?.remaining || [] },
  );
  const text = mfBuildReadinessReportText({
    fileName: state.file?.name,
    path: state.mixforgePath,
    pathLabel: state.mixforgePath === 'forensic' ? 'Forensic Fix' : 'Quick Master',
    before: state.mixMetrics,
    after: state.finalMetrics,
    truePeakAfter: state.masterConstraint?.truePeakDb,
    readinessBefore: summary.readinessBefore ?? state.audit?.readinessScore,
    readinessAfter: summary.readinessAfter,
    bullets: summary.bullets,
    remaining: summary.remaining,
    generatedAt: new Date().toISOString(),
  });
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const base = (state.file?.name || 'mix').replace(/\.[^.]+$/, '').replace(/[^a-z0-9._-]/gi, '_');
  anchor.href = url;
  anchor.download = `${base}-mixforge-readiness.txt`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  setStatus('exportStatus', 'Readiness report downloaded.', 'ok');
}

function mfInstallMusicianKeyboard() {
  document.addEventListener('keydown', (event) => {
    const tag = (event.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || event.target?.isContentEditable) return;
    if ($('previewBox')?.classList.contains('hidden')) return;
    if (event.code === 'KeyB' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (!state.master) return;
      event.preventDefault();
      mfToggleAbPreview();
      return;
    }
    if (event.code === 'Space' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      if (typeof toggleTransport === 'function') void toggleTransport();
      else if ($('playBtn')) $('playBtn').click();
    }
  });
}

function mfInstallMusicianUi() {
  mfEnsureMusicianMounts();
  mfInstallMusicianKeyboard();

  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('.ab-btn');
    if (!button) return;
    mfSelectAbPreview(button.getAttribute('data-ab'));
  });

  $('readinessReportBtn')?.addEventListener('click', mfDownloadReadinessReport);

  const previousPrepareMastering = prepareMastering;
  prepareMastering = function prepareMasteringHonestCopy(...args) {
    const result = previousPrepareMastering(...args);
    mfUpdateMasterCopy();
    return result;
  };

  const previousRenderAudit = renderAudit;
  renderAudit = function renderAuditMusicianPath(audit, metrics, options = {}) {
    const normalized = mfNormalizeDemucsStems(audit?.stemsToInspect || []);
    const patched = {
      ...audit,
      stemsToInspect: normalized.stems,
      stemRoutes: normalized.routes,
    };
    state.audit = patched;
    previousRenderAudit(patched, metrics, options);
    if (options.attachOnly || state.mixforgePath) {
      if (!state.mixforgePath) mfRenderPathChooser(patched);
      return;
    }
    // Path chooser owns the next step — never surprise the musician with stems
    // or an auto-opened master panel before they pick Quick Master vs Forensic.
    hide('separateActions');
    if ($('stemConsent')) $('stemConsent').classList.add('hidden');
    hide('masterPanel');
    hide('stemPanel');
    hide('verifyPanel');
    state.corrected = null;
    state.master = null;
    state.masterPlan = null;
    mfRenderPathChooser(patched);
  };

  const previousSeparateRequiredStems = separateRequiredStems;
  separateRequiredStems = async function separateRequiredStemsHonest(stems, onProgress) {
    const normalized = mfNormalizeDemucsStems(stems);
    if (state.audit) state.audit.stemRoutes = normalized.routes;
    onProgress?.(`Honest Demucs mapping: ${normalized.routes.map((route) => route.honest).join('; ') || normalized.stems.join(', ')}`);
    try {
      return await previousSeparateRequiredStems(normalized.stems, onProgress);
    } catch (error) {
      const buried = mfLeadBuriedEvidence(state.audit, state.mixMetrics);
      if (buried.warranted) {
        state.vocalUpRepair = { ...(state.vocalUpRepair || {}), ...buried, failed: true, applied: false };
        const message = `${buried.skipWarning} (${error.message})`;
        throw Object.assign(error, { message });
      }
      throw error;
    }
  };

  const previousBuildStemPlans = buildStemPlans;
  buildStemPlans = async function buildStemPlansVocalUp(...args) {
    const result = await previousBuildStemPlans(...args);
    const evidence = state.vocalUpRepair?.warranted
      ? state.vocalUpRepair
      : mfLeadBuriedEvidence(state.audit, state.mixMetrics);
    if (evidence.warranted && state.stemPlans) {
      mfApplyVocalUpPlan(state.stemPlans, evidence);
      state.vocalUpRepair = { ...(state.vocalUpRepair || {}), ...evidence, planned: true };
      if ($('rebuildBtn')) $('rebuildBtn').textContent = 'Write vocal rides and rebuild mix';
    }
    return result;
  };

  const previousRenderStemPlans = renderStemPlans;
  renderStemPlans = function renderStemPlansHonest() {
    if (state.vocalUpRepair?.warranted && state.stemPlans) mfApplyVocalUpPlan(state.stemPlans, state.vocalUpRepair);
    previousRenderStemPlans();
    for (const card of document.querySelectorAll('#stemGrid .stem-card h3')) {
      const key = (card.textContent || '').trim().toLowerCase();
      if (MF_STEM_DISPLAY[key]) card.textContent = MF_STEM_DISPLAY[key];
    }
    const grid = $('stemGrid');
    if (grid && !$('extractionIntegrityNote')) {
      const note = mfMusicianEl('p', 'extraction-integrity-note');
      note.id = 'extractionIntegrityNote';
      note.textContent = 'Leakage/fit is a heuristic, not lab SDR. Demucs separates vocals, bass, drums, and residual other — it does not confirm guitars or keys.';
      grid.prepend(note);
    }
    if (state.vocalUpRepair?.warranted && grid && !$('vocalUpNote')) {
      const note = mfMusicianEl('p', 'extraction-integrity-note');
      note.id = 'vocalUpNote';
      note.textContent = 'Forensic writes time-sliced vocal rides on buried phrases (verse that ducks under other gets a ride; a forward chorus stays put). Remeasure stays in the loop until those windows clear or a hard cap stops it. Level/balance only — not pitch or timing.';
      grid.prepend(note);
    }
    if (mfShouldAutoVocalUp(state)) {
      state.vocalUpRepair = { ...state.vocalUpRepair, autoRebuildStarted: true };
      queueMicrotask(() => { void mfRunVocalUpRebuildAndMaster(); });
    }
  };

  const previousRenderReleaseMaster = renderReleaseMaster;
  renderReleaseMaster = async function renderReleaseMasterVocalUpGuard(...args) {
    const buried = state.vocalUpRepair;
    if (
      state.mixforgePath === 'forensic'
      && buried?.warranted
      && !buried.applied
      && !buried.skipped
      && (!state.corrected || state.corrected === state.original)
    ) {
      throw new Error('Vocal-up repair has not reprinted the mix yet. Wait for isolation to finish, or skip stems.');
    }
    return previousRenderReleaseMaster(...args);
  };

  const previousRenderVerification = renderVerification;
  renderVerification = function renderVerificationMusician(metrics, plan) {
    previousRenderVerification(metrics, plan);
    mfSyncAbBar(state);
    mfRenderWhatChanged();
    if (typeof syncExportUi === 'function') syncExportUi(state);
  };

  const previousResetResults = resetResults;
  resetResults = function resetResultsMusician(...args) {
    previousResetResults(...args);
    state.mixforgePath = null;
    state.mixforgeWhatChanged = null;
    state.mixforgeRecommendation = null;
    state.vocalUpRepair = null;
    state.masterExportId = null;
    state.exportOverride = false;
    if ($('exportOverride')) $('exportOverride').checked = false;
    if ($('pathChooser')) {
      $('pathChooser').classList.add('hidden');
      $('pathChooser').replaceChildren();
    }
    if ($('stemConsent')) {
      $('stemConsent').classList.add('hidden');
      $('stemConsent').replaceChildren();
    }
    if ($('whatChanged')) {
      $('whatChanged').classList.add('hidden');
      $('whatChanged').replaceChildren();
    }
  };

  // Soften engineer-only hero if the static HTML was cached with older copy.
  const heroCopy = document.querySelector('.hero p');
  if (heroCopy && /Observe the stereo evidence/i.test(heroCopy.textContent || '')) {
    heroCopy.textContent = 'Fix mix problems, then master for release. Start with Quick Master for a fast Original vs Master A/B — or open Forensic Fix when you need timeline evidence and honest stem investigation.';
  }
  const seat = document.querySelector('.hero .pipeline');
  if (seat && !$('heroModeRow')) {
    const modes = mfMusicianEl('div', 'hero-modes');
    modes.id = 'heroModeRow';
    modes.innerHTML = `<span>Quick Master</span><b>or</b><span>Forensic Fix</span><i>Mix repair + release master · vocals live in <a href="${MF_AURAMIX_URL}" target="_blank" rel="noopener noreferrer">AuraMix</a></i>`;
    seat.after(modes);
  } else if ($('heroModeRow') && !$('heroModeRow').querySelector('a')) {
    const italic = $('heroModeRow').querySelector('i');
    if (italic) italic.innerHTML = `Mix repair + release master · vocals live in <a href="${MF_AURAMIX_URL}" target="_blank" rel="noopener noreferrer">AuraMix</a>`;
  }
  mfSetPipeline(state.mixforgePath || null);
}

if (typeof globalThis !== 'undefined') {
  globalThis.mfRecommendPath = mfRecommendPath;
  globalThis.mfNormalizeDemucsStems = mfNormalizeDemucsStems;
  globalThis.mfStemJobFraming = mfStemJobFraming;
  globalThis.mfPlainWhatChanged = mfPlainWhatChanged;
  globalThis.mfBuildReadinessReportText = mfBuildReadinessReportText;
  globalThis.mfEstimateReadiness = mfEstimateReadiness;
  globalThis.mfSetPipeline = mfSetPipeline;
  globalThis.mfOriginalPreviewPlan = mfOriginalPreviewPlan;
  globalThis.mfFormatEqMove = mfFormatEqMove;
  globalThis.mfCorrectedPreviewAvailable = mfCorrectedPreviewAvailable;
  globalThis.mfAbMatchOffsetDb = mfAbMatchOffsetDb;
  globalThis.mfAbBarCopy = mfAbBarCopy;
  globalThis.mfLeadBuriedEvidence = mfLeadBuriedEvidence;
  globalThis.mfVocalUpLiftDb = mfVocalUpLiftDb;
  globalThis.mfCompetingEaseDb = mfCompetingEaseDb;
  globalThis.mfPredictMaskingAfter = mfPredictMaskingAfter;
  globalThis.mfVocalUpMaskingProgress = mfVocalUpMaskingProgress;
  globalThis.mfRideEnvelope = mfRideEnvelope;
  globalThis.mfStemRideDbAt = mfStemRideDbAt;
  globalThis.mfFindBuriedVocalWindows = mfFindBuriedVocalWindows;
  globalThis.mfCoalesceBuriedWindows = mfCoalesceBuriedWindows;
  globalThis.mfMeasureWindowMaskingDb = mfMeasureWindowMaskingDb;
  globalThis.mfNextBuriedPhrase = mfNextBuriedPhrase;
  globalThis.mfPhraseRideClearer = mfPhraseRideClearer;
  globalThis.mfSongDuckBaseline = mfSongDuckBaseline;
  globalThis.mfStripPresenceStackOps = mfStripPresenceStackOps;
  globalThis.mfKeepWorstPhrases = mfKeepWorstPhrases;
  globalThis.mfVocalRideQualityStop = mfVocalRideQualityStop;
  globalThis.mfMergeBuriedWindows = mfMergeBuriedWindows;
  globalThis.mfSplitLongWindows = mfSplitLongWindows;
  globalThis.mfWindowRideDepthDb = mfWindowRideDepthDb;
  globalThis.mfVocalRideAmountDb = mfVocalRideAmountDb;
  globalThis.MF_VOCAL_RIDE_MAX_WINDOW_SEC = MF_VOCAL_RIDE_MAX_WINDOW_SEC;
  globalThis.MF_VOCAL_RIDE_MAX_PHRASES = MF_VOCAL_RIDE_MAX_PHRASES;
  globalThis.mfGlobalVocalSeatDb = mfGlobalVocalSeatDb;
  globalThis.mfMeasureBufferWindowDb = mfMeasureBufferWindowDb;
  globalThis.mfPlanVocalRides = mfPlanVocalRides;
  globalThis.mfIterateVocalRides = mfIterateVocalRides;
  globalThis.mfFormatRideRange = mfFormatRideRange;
  globalThis.mfStemBalanceDelta = mfStemBalanceDelta;
  globalThis.mfApplyVocalUpPlan = mfApplyVocalUpPlan;
  globalThis.mfPresenceMaskingSnapshot = mfPresenceMaskingSnapshot;
  globalThis.mfShouldAutoVocalUp = mfShouldAutoVocalUp;
  globalThis.MF_VOCAL_UP_SKIP_WARNING = MF_VOCAL_UP_SKIP_WARNING;
  globalThis.MF_VOCAL_UP_MAX_DB = MF_VOCAL_UP_MAX_DB;
  globalThis.MF_TOKEN_MASKING_DROP_DB = MF_TOKEN_MASKING_DROP_DB;
  globalThis.MF_VOCAL_RIDE_CLEAR_DB = MF_VOCAL_RIDE_CLEAR_DB;
  globalThis.MF_VOCAL_RIDE_TOTAL_MAX_DB = MF_VOCAL_RIDE_TOTAL_MAX_DB;
  globalThis.MF_VOCAL_RIDE_PASS_MAX_DB = MF_VOCAL_RIDE_PASS_MAX_DB;
  globalThis.MF_VOCAL_SEAT_MAX_DB = MF_VOCAL_SEAT_MAX_DB;
  globalThis.presentMeasuredAuditThenListen = presentMeasuredAuditThenListen;
  globalThis.MF_STEM_HOURLY_LIMIT = MF_STEM_HOURLY_LIMIT;
  globalThis.MF_STEM_DAILY_LIMIT = MF_STEM_DAILY_LIMIT;
}

if (typeof document !== 'undefined' && typeof $ === 'function') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mfInstallMusicianUi);
  else mfInstallMusicianUi();
}
