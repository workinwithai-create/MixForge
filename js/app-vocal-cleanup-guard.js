'use strict';

// MixForge 2.2 vocal cleanup hardening.
// Enforces an immutable mono/lead center path, iterative whole-mix regression
// limits, and one shared preview lifecycle for vocal and master auditioning.

function mfVocalGuardStopCandidateSource() {
  const source = state.vocalCleanupSource;
  if (!source) return;
  state.vocalCleanupSource = null;
  try { source.onended = null; source.stop(); } catch (_) {}
  try { source.disconnect(); } catch (_) {}
}

const mfVocalGuardStopPreview = stopPreview;
stopPreview = function stopPreviewWithVocalCleanup(...args) {
  mfVocalGuardStopCandidateSource();
  return mfVocalGuardStopPreview(...args);
};

if (typeof stopTransport === 'function') {
  const mfVocalGuardStopTransport = stopTransport;
  stopTransport = function stopTransportWithVocalCleanup(options) {
    mfVocalGuardStopCandidateSource();
    return mfVocalGuardStopTransport(options);
  };
}

const mfVocalGuardAnalyze = mfAnalyzeVocalLayers;
mfAnalyzeVocalLayers = function mfAnalyzeVocalLayersGuarded(vocalBuffer, mixBuffer = null, extractionQuality = 100) {
  const analysis = mfVocalGuardAnalyze(vocalBuffer, mixBuffer, extractionQuality);
  if (!analysis) return analysis;
  const mono = vocalBuffer.numberOfChannels < 2;
  const activePowers = analysis.frames.map((frame) => frame.totalEnergy).filter((power) => power > 1e-12);
  const medianPower = Math.max(1e-12, mfVocalPercentile(activePowers, 0.5));

  for (const frame of analysis.frames) {
    frame.mono = mono;
    frame.levelPosition = clamp(
      (10 * Math.log10(Math.max(frame.totalEnergy, 1e-20) / medianPower) + 12) / 24,
      0,
      1,
    );
    frame.quietNonVocalNoise = !mono
      && frame.noiseScore > 0.82
      && frame.confidence > 0.74
      && frame.levelPosition < 0.32
      && frame.layerScore < 0.42;
    if (mono) frame.allowRemove = false;
  }

  if (mono) {
    analysis.removableSeconds = 0;
    analysis.defaultMode = 'preserve';
    return analysis;
  }

  const hasRemovalEvidence = analysis.frames.some((frame) => frame.allowRemove);
  analysis.defaultMode = analysis.confidence >= 0.72
    && analysis.flaggedSeconds >= 0.6
    && (analysis.risk >= 0.36 || hasRemovalEvidence)
    ? 'reduce'
    : 'preserve';
  return analysis;
};

const mfVocalGuardFrameTarget = mfVocalFrameTarget;
mfVocalFrameTarget = function mfVocalFrameTargetGuarded(frame, mode) {
  const target = mfVocalGuardFrameTarget(frame, mode);
  if (!frame || frame.mono || !frame.quietNonVocalNoise) return { ...target, centerGain: 1 };
  const limits = MF_VOCAL_CLEANUP_MODES[mode] || MF_VOCAL_CLEANUP_MODES.preserve;
  const removeAuthorized = mode === 'remove' && frame.allowRemove;
  const reductionDb = clamp(
    (frame.noiseScore - 0.72) * 10,
    0,
    removeAuthorized ? limits.noiseLimitDb : Math.min(limits.noiseLimitDb, 2.5),
  );
  return { ...target, centerGain: dbToGain(-reductionDb) };
};

function mfVocalGuardRegressionMetrics(before, after) {
  return {
    lufsShift: after.lufs - before.lufs,
    widthShift: after.widthDb - before.widthDb,
    correlationShift: after.correlation - before.correlation,
    peakShift: after.peakDb - before.peakDb,
  };
}

function mfVocalGuardRegressionSafe(metrics) {
  return Math.abs(metrics.lufsShift) <= 0.8
    && Math.abs(metrics.widthShift) <= 3.5
    && metrics.correlationShift >= -0.04
    && metrics.peakShift <= 0.25;
}

mfVocalMixCleanup = function mfVocalMixCleanupGuarded(baseMix, rawVocal, cleanedVocal, mode) {
  const before = measureBuffer(baseMix);
  const length = Math.min(baseMix.length, rawVocal.length, cleanedVocal.length);
  const requestedScale = mode === 'remove' ? 1 : 0.9;
  let appliedScale = requestedScale;
  let output = null;
  let after = before;
  let shifts = mfVocalGuardRegressionMetrics(before, after);
  let safe = false;

  for (let attempt = 0; attempt < 8; attempt++) {
    output = cloneBuffer(baseMix);
    for (let channel = 0; channel < output.numberOfChannels; channel++) {
      const destination = output.getChannelData(channel);
      const raw = rawVocal.getChannelData(Math.min(channel, rawVocal.numberOfChannels - 1));
      const cleaned = cleanedVocal.getChannelData(Math.min(channel, cleanedVocal.numberOfChannels - 1));
      for (let index = 0; index < length; index++) {
        destination[index] += (cleaned[index] - raw[index]) * appliedScale;
      }
    }
    after = measureBuffer(output);
    shifts = mfVocalGuardRegressionMetrics(before, after);
    safe = mfVocalGuardRegressionSafe(shifts);
    if (safe) break;
    appliedScale *= 0.5;
  }

  if (!safe) {
    output = cloneBuffer(baseMix);
    appliedScale = 0;
    after = before;
    shifts = mfVocalGuardRegressionMetrics(before, after);
  }

  return {
    buffer: output,
    metrics: {
      ...shifts,
      appliedScale,
      requestedScale,
      limitedByRegressionGuard: appliedScale < requestedScale - 1e-6,
      reverted: appliedScale === 0,
    },
  };
};
