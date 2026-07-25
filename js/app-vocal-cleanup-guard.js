'use strict';

// MixForge 2.2 vocal cleanup hardening.
// Preserves the lead center, limits side-channel intervention, rejects tonal
// or stereo collapse, and shares one preview lifecycle with the master player.

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
      && frame.noiseScore > 0.88
      && frame.confidence > 0.82
      && frame.levelPosition < 0.24
      && frame.layerScore < 0.32;
    if (mono) frame.allowRemove = false;
  }

  if (mono) {
    analysis.removableSeconds = 0;
    analysis.defaultMode = 'preserve';
    return analysis;
  }

  // A separated vocal can already contain watery/phaselike residue. Automatic
  // cleanup now requires unusually strong evidence; otherwise the natural vocal
  // remains untouched until the listener explicitly chooses a candidate.
  const strongWideEvidence = analysis.frames.some((frame) => (
    frame.layerScore >= 0.76
    && frame.confidence >= 0.82
    && frame.sideShare >= 0.2
    && frame.netRisk >= 0.48
  ));
  analysis.defaultMode = extractionQuality >= 86
    && analysis.confidence >= 0.84
    && analysis.flaggedSeconds >= 1.2
    && analysis.risk >= 0.48
    && strongWideEvidence
    ? 'reduce'
    : 'preserve';
  return analysis;
};

const mfVocalGuardFrameTarget = mfVocalFrameTarget;
mfVocalFrameTarget = function mfVocalFrameTargetGuarded(frame, mode) {
  if (!frame || mode === 'preserve' || frame.recommendation === 'preserve' || frame.mono) {
    return { sideGain: 1, centerGain: 1 };
  }

  // Never reshape the probable lead center. Broadband center attenuation is one
  // of the fastest ways to expose separation residue and create a robotic tone.
  const centerGain = 1;
  const removeAuthorized = mode === 'remove'
    && frame.allowRemove
    && frame.confidence >= 0.86
    && frame.netRisk >= 0.82;
  const wideEvidence = frame.layerScore >= (removeAuthorized ? 0.72 : 0.68)
    && frame.confidence >= (removeAuthorized ? 0.84 : 0.76)
    && frame.sideShare >= (removeAuthorized ? 0.17 : 0.19);

  if (!wideEvidence) return { sideGain: 1, centerGain };

  // Reduce mode is deliberately subtle. It should tuck a distracting double,
  // not strip width, room tone, consonants or the vocal's natural edge.
  const maxReductionDb = removeAuthorized ? 5 : 2.5;
  const evidence = clamp(
    (frame.layerScore - 0.62) * 4.2
      + (frame.netRisk - 0.38) * 2.2
      + (frame.sideShare - 0.15) * 2,
    0,
    1,
  );
  const reductionDb = clamp(0.6 + evidence * maxReductionDb, 0, maxReductionDb);
  return { sideGain: dbToGain(-reductionDb), centerGain };
};

const mfVocalGuardRenderUI = mfRenderVocalCleanupUI;
mfRenderVocalCleanupUI = function mfRenderVocalCleanupUIGuarded() {
  mfVocalGuardRenderUI();
  const cleanup = state.vocalCleanup;
  const analysis = cleanup?.analysis;
  if (!analysis) return;
  const card = mfVocalFindCard();
  const summary = card?.querySelector('.vocal-cleanup-summary');
  if (!analysis.stereo) {
    if (summary) summary.textContent = 'This vocal stem is mono. MixForge preserves the entire center path; vocal-layer reduction and removal remain unavailable.';
    return;
  }
  if (summary && cleanup.mode === 'preserve') {
    summary.textContent = `${analysis.sections.length} possible supporting-layer region${analysis.sections.length === 1 ? '' : 's'} found. Preserve is selected because vocal tone and natural ambience take priority over uncertain cleanup.`;
  }
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
  return Math.abs(metrics.lufsShift) <= 0.45
    && Math.abs(metrics.widthShift) <= 1.8
    && metrics.correlationShift >= -0.025
    && metrics.correlationShift <= 0.12
    && metrics.peakShift <= 0.18;
}

function mfVocalGuardTonalSafe(rawVocal, cleanedVocal) {
  const before = measureBuffer(rawVocal);
  const after = measureBuffer(cleanedVocal);
  const presenceShift = (band(after, 'Presence') - after.lufs) - (band(before, 'Presence') - before.lufs);
  const airShift = (band(after, 'Air') - after.lufs) - (band(before, 'Air') - before.lufs);
  const lowMidShift = (band(after, 'Low-mids') - after.lufs) - (band(before, 'Low-mids') - before.lufs);
  const widthShift = after.widthDb - before.widthDb;
  const correlationShift = after.correlation - before.correlation;
  return {
    safe: Math.abs(presenceShift) <= 0.9
      && Math.abs(airShift) <= 1.1
      && Math.abs(lowMidShift) <= 0.9
      && Math.abs(widthShift) <= 2.4
      && correlationShift <= 0.14,
    presenceShift,
    airShift,
    lowMidShift,
    widthShift,
    correlationShift,
  };
}

mfVocalMixCleanup = function mfVocalMixCleanupGuarded(baseMix, rawVocal, cleanedVocal, mode) {
  const before = measureBuffer(baseMix);
  const tonal = mfVocalGuardTonalSafe(rawVocal, cleanedVocal);
  const length = Math.min(baseMix.length, rawVocal.length, cleanedVocal.length);
  const requestedScale = tonal.safe ? (mode === 'remove' ? 0.72 : 0.52) : 0;
  let appliedScale = requestedScale;
  let output = null;
  let after = before;
  let shifts = mfVocalGuardRegressionMetrics(before, after);
  let safe = false;

  for (let attempt = 0; attempt < 9; attempt++) {
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
    safe = tonal.safe && mfVocalGuardRegressionSafe(shifts);
    if (safe) break;
    appliedScale *= 0.5;
  }

  if (!safe || appliedScale < 0.04) {
    output = cloneBuffer(baseMix);
    appliedScale = 0;
    after = before;
    shifts = mfVocalGuardRegressionMetrics(before, after);
  }

  return {
    buffer: output,
    metrics: {
      ...shifts,
      tonal,
      appliedScale,
      requestedScale,
      limitedByRegressionGuard: appliedScale < requestedScale - 1e-6,
      reverted: appliedScale === 0,
    },
  };
};