'use strict';

// MixForge 2.2 vocal cleanup hardening.
// Keeps centered lead articulation immutable unless a frame is quiet, strongly
// noise-like, and independently supported by high-confidence evidence.

const mfVocalGuardAnalyze = mfAnalyzeVocalLayers;
mfAnalyzeVocalLayers = function mfAnalyzeVocalLayersGuarded(vocalBuffer, mixBuffer = null, extractionQuality = 100) {
  const analysis = mfVocalGuardAnalyze(vocalBuffer, mixBuffer, extractionQuality);
  if (!analysis) return analysis;
  const activePowers = analysis.frames.map((frame) => frame.totalEnergy).filter((power) => power > 1e-12);
  const medianPower = Math.max(1e-12, mfVocalPercentile(activePowers, 0.5));
  for (const frame of analysis.frames) {
    frame.levelPosition = clamp(
      (10 * Math.log10(Math.max(frame.totalEnergy, 1e-20) / medianPower) + 12) / 24,
      0,
      1,
    );
    frame.quietNonVocalNoise = frame.noiseScore > 0.82
      && frame.confidence > 0.74
      && frame.levelPosition < 0.32
      && frame.layerScore < 0.42;
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
  if (!frame?.quietNonVocalNoise) return { ...target, centerGain: 1 };
  const limits = MF_VOCAL_CLEANUP_MODES[mode] || MF_VOCAL_CLEANUP_MODES.preserve;
  const removeAuthorized = mode === 'remove' && frame.allowRemove;
  const reductionDb = clamp(
    (frame.noiseScore - 0.72) * 10,
    0,
    removeAuthorized ? limits.noiseLimitDb : Math.min(limits.noiseLimitDb, 2.5),
  );
  return { ...target, centerGain: dbToGain(-reductionDb) };
};
