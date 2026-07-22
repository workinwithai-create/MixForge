'use strict';

// MixForge 2.2 vocal-layer cleanup.
// Operates only on an already-separated vocal stem. The probable centered lead
// remains locked while wide support layers and low-confidence noise are reduced
// section by section. No source audio is deleted and Preserve is always available.

const MF_VOCAL_CLEANUP_MODES = Object.freeze({
  preserve: { label: 'Preserve', sideLimitDb: 0, noiseLimitDb: 0 },
  reduce: { label: 'Reduce clutter', sideLimitDb: 6.5, noiseLimitDb: 3 },
  remove: { label: 'Remove high-confidence only', sideLimitDb: 14, noiseLimitDb: 7 },
});

function mfVocalPercentile(values, percentileValue) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.floor(clamp(percentileValue, 0, 1) * (sorted.length - 1));
  return sorted[index];
}

function mfVocalFrameSize(sampleRate) {
  const target = sampleRate * 0.085;
  return clamp(2 ** Math.round(Math.log2(target)), 2048, 8192);
}

function mfVocalFrameFeatures(vocalBuffer, mixBuffer, start, end) {
  const stereo = vocalBuffer.numberOfChannels > 1;
  const left = vocalBuffer.getChannelData(0);
  const right = stereo ? vocalBuffer.getChannelData(1) : left;
  const mixLeft = mixBuffer?.getChannelData(0) || left;
  const mixRight = mixBuffer?.numberOfChannels > 1 ? mixBuffer.getChannelData(1) : mixLeft;
  let midEnergy = 0;
  let sideEnergy = 0;
  let residualEnergy = 0;
  let highEnergy = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  let crossEnergy = 0;
  let zeroCrossings = 0;
  let previousMid = 0;
  let previousSign = 0;
  const count = Math.max(1, end - start);

  for (let index = start; index < end; index++) {
    const l = left[index] || 0;
    const r = right[index] || 0;
    const mid = (l + r) * 0.5;
    const side = (l - r) * 0.5;
    const mixMid = ((mixLeft[index] || 0) + (mixRight[index] || 0)) * 0.5;
    const residual = mixMid - mid;
    const derivative = mid - previousMid;
    const sign = mid > 0 ? 1 : mid < 0 ? -1 : previousSign;
    if (previousSign && sign && sign !== previousSign) zeroCrossings++;
    previousSign = sign;
    previousMid = mid;
    midEnergy += mid * mid;
    sideEnergy += side * side;
    residualEnergy += residual * residual;
    highEnergy += derivative * derivative;
    leftEnergy += l * l;
    rightEnergy += r * r;
    crossEnergy += l * r;
  }

  const totalEnergy = midEnergy + sideEnergy;
  return {
    start,
    end,
    midEnergy: midEnergy / count,
    sideEnergy: sideEnergy / count,
    residualEnergy: residualEnergy / count,
    totalEnergy: totalEnergy / count,
    highEnergy: highEnergy / count,
    zcr: zeroCrossings / count,
    correlation: crossEnergy / Math.sqrt(Math.max(1e-20, leftEnergy * rightEnergy)),
  };
}

function mfVocalMergeSections(frames, hop, sampleRate) {
  const sections = [];
  let current = null;
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    if (frame.recommendation === 'preserve') {
      if (current && index - current.lastFrame > 2) {
        sections.push(current);
        current = null;
      }
      continue;
    }
    if (!current || index - current.lastFrame > 2 || frame.recommendation !== current.recommendation) {
      if (current) sections.push(current);
      current = {
        start: frame.start / sampleRate,
        end: frame.end / sampleRate,
        lastFrame: index,
        recommendation: frame.recommendation,
        confidenceTotal: frame.confidence,
        riskTotal: frame.netRisk,
        noiseTotal: frame.noiseScore,
        layerTotal: frame.layerScore,
        count: 1,
      };
    } else {
      current.end = frame.end / sampleRate;
      current.lastFrame = index;
      current.confidenceTotal += frame.confidence;
      current.riskTotal += frame.netRisk;
      current.noiseTotal += frame.noiseScore;
      current.layerTotal += frame.layerScore;
      current.count++;
    }
  }
  if (current) sections.push(current);

  return sections
    .map((section) => {
      const noise = section.noiseTotal / section.count;
      const layer = section.layerTotal / section.count;
      return {
        start: section.start,
        end: section.end,
        duration: section.end - section.start,
        recommendation: section.recommendation,
        confidence: Math.round(100 * section.confidenceTotal / section.count),
        risk: section.riskTotal / section.count,
        reason: noise > layer
          ? 'probable breath, bleed, ambience or non-vocal noise'
          : 'probable wide double or supporting-vocal buildup',
      };
    })
    .filter((section) => section.duration >= Math.max(0.22, hop / sampleRate))
    .sort((a, b) => b.risk * b.duration - a.risk * a.duration)
    .slice(0, 10);
}

function mfAnalyzeVocalLayers(vocalBuffer, mixBuffer = null, extractionQuality = 100) {
  if (!vocalBuffer?.length) return null;
  const sampleRate = vocalBuffer.sampleRate;
  const frameSize = mfVocalFrameSize(sampleRate);
  const hop = Math.max(512, Math.floor(frameSize / 2));
  const rawFrames = [];
  for (let start = 0; start < vocalBuffer.length; start += hop) {
    rawFrames.push(mfVocalFrameFeatures(vocalBuffer, mixBuffer, start, Math.min(vocalBuffer.length, start + frameSize)));
  }

  const activePowers = rawFrames.map((frame) => frame.totalEnergy).filter((power) => power > 1e-12);
  const medianPower = Math.max(1e-12, mfVocalPercentile(activePowers, 0.5));
  const highPower = Math.max(medianPower, mfVocalPercentile(activePowers, 0.9));
  const activityFloor = Math.max(1e-12, highPower * dbToGain(-42) ** 2);
  const qualityFactor = clamp((extractionQuality - 45) / 45, 0.15, 1);

  const frames = rawFrames.map((frame) => {
    const active = frame.totalEnergy > activityFloor;
    const sideShare = frame.sideEnergy / Math.max(1e-20, frame.midEnergy + frame.sideEnergy);
    const highShare = frame.highEnergy / Math.max(1e-20, frame.midEnergy * 4 + frame.highEnergy);
    const maskingRatio = frame.residualEnergy / Math.max(frame.midEnergy, 1e-20);
    const levelPosition = clamp(
      (10 * Math.log10(Math.max(frame.totalEnergy, 1e-20) / medianPower) + 12) / 24,
      0,
      1,
    );
    const centerDominance = clamp(1 - sideShare * 1.35, 0, 1);
    const layerScore = active && vocalBuffer.numberOfChannels > 1
      ? clamp((sideShare - 0.11) * 2.8 + Math.max(0, 0.82 - frame.correlation) * 0.42, 0, 1)
      : 0;
    const noiseScore = active
      ? clamp((frame.zcr - 0.11) * 3.6 + (highShare - 0.16) * 2.1 + Math.max(0, 0.2 - frame.correlation) * 0.45 + (1 - levelPosition) * 0.16, 0, 1)
      : 0;
    const chorusBenefit = clamp(levelPosition * 0.42 + Math.max(0, frame.correlation) * 0.22 + (1 - noiseScore) * 0.2, 0, 0.72);
    const maskingPressure = clamp((10 * Math.log10(Math.max(maskingRatio, 1e-12)) + 18) / 30, 0, 1);
    const harmScore = clamp(Math.max(noiseScore, layerScore * (0.78 + maskingPressure * 0.22)) - chorusBenefit * 0.38, 0, 1);
    const confidence = clamp((0.5 + Math.max(noiseScore, layerScore) * 0.5) * qualityFactor, 0, 1);
    const allowRemove = confidence >= 0.78 && harmScore >= 0.74 && (noiseScore >= 0.78 || frame.correlation < -0.05);
    const recommendation = !active || confidence < 0.48 || (harmScore < 0.36 && layerScore < 0.52)
      ? 'preserve'
      : allowRemove
        ? 'remove'
        : 'reduce';
    return {
      ...frame,
      active,
      sideShare,
      highShare,
      maskingPressure,
      centerDominance,
      layerScore,
      noiseScore,
      netRisk: harmScore,
      confidence,
      allowRemove,
      recommendation,
    };
  });

  const sections = mfVocalMergeSections(frames, hop, sampleRate);
  let weightedRisk = 0;
  let weightedConfidence = 0;
  let activeWeight = 0;
  let flaggedSeconds = 0;
  let removableSeconds = 0;
  let centerTotal = 0;
  for (const frame of frames) {
    if (!frame.active) continue;
    const weight = Math.sqrt(Math.max(frame.totalEnergy, 1e-20));
    activeWeight += weight;
    weightedRisk += frame.netRisk * weight;
    weightedConfidence += frame.confidence * weight;
    centerTotal += frame.centerDominance * weight;
    if (frame.recommendation !== 'preserve') flaggedSeconds += hop / sampleRate;
    if (frame.allowRemove) removableSeconds += hop / sampleRate;
  }
  const risk = activeWeight ? weightedRisk / activeWeight : 0;
  const confidence = activeWeight ? weightedConfidence / activeWeight : 0;
  const centerLock = activeWeight ? centerTotal / activeWeight : 1;
  const defaultMode = confidence >= 0.66 && risk >= 0.22 && flaggedSeconds >= 0.6 ? 'reduce' : 'preserve';

  return {
    frameSize,
    hop,
    frames,
    sections,
    risk,
    confidence,
    centerLock,
    flaggedSeconds,
    removableSeconds,
    defaultMode,
    extractionQuality,
    stereo: vocalBuffer.numberOfChannels > 1,
  };
}

function mfVocalFrameTarget(frame, mode) {
  if (!frame || mode === 'preserve' || frame.recommendation === 'preserve') return { sideGain: 1, centerGain: 1 };
  const limits = MF_VOCAL_CLEANUP_MODES[mode] || MF_VOCAL_CLEANUP_MODES.preserve;
  const removeAuthorized = mode === 'remove' && frame.allowRemove;
  const sideReductionDb = removeAuthorized
    ? clamp(4 + frame.netRisk * 10, 0, limits.sideLimitDb)
    : clamp(1 + frame.netRisk * 6.5, 0, Math.min(limits.sideLimitDb, 6.5));
  const noiseReductionDb = frame.noiseScore > 0.66 && frame.confidence > 0.62
    ? clamp((frame.noiseScore - 0.58) * 11, 0, removeAuthorized ? limits.noiseLimitDb : Math.min(limits.noiseLimitDb, 3))
    : 0;
  return {
    sideGain: dbToGain(-sideReductionDb),
    centerGain: dbToGain(-noiseReductionDb),
  };
}

function mfVocalDeltaScale(raw, cleaned, mode) {
  let rawEnergy = 0;
  let deltaEnergy = 0;
  let count = 0;
  const step = Math.max(1, Math.floor(raw.length / 800000));
  for (let channel = 0; channel < raw.numberOfChannels; channel++) {
    const before = raw.getChannelData(channel);
    const after = cleaned.getChannelData(channel);
    for (let index = 0; index < raw.length; index += step) {
      const delta = after[index] - before[index];
      rawEnergy += before[index] * before[index];
      deltaEnergy += delta * delta;
      count++;
    }
  }
  const relativeDb = 10 * Math.log10(Math.max(deltaEnergy, 1e-20) / Math.max(rawEnergy, 1e-20));
  const limitDb = mode === 'remove' ? -8.5 : -13;
  return {
    scale: relativeDb > limitDb ? dbToGain((limitDb - relativeDb) * 0.5) : 1,
    relativeDb,
    count,
  };
}

async function mfRenderVocalCleanup(vocalBuffer, analysis, mode = 'preserve') {
  if (!analysis || mode === 'preserve') return { buffer: cloneBuffer(vocalBuffer), stats: { mode: 'preserve', relativeDeltaDb: -Infinity, scale: 1 } };
  const output = cloneBuffer(vocalBuffer);
  const left = vocalBuffer.getChannelData(0);
  const right = vocalBuffer.numberOfChannels > 1 ? vocalBuffer.getChannelData(1) : left;
  const outLeft = output.getChannelData(0);
  const outRight = output.numberOfChannels > 1 ? output.getChannelData(1) : outLeft;
  const attack = Math.exp(-1 / Math.max(1, vocalBuffer.sampleRate * 0.012));
  const release = Math.exp(-1 / Math.max(1, vocalBuffer.sampleRate * 0.095));
  let sideGain = 1;
  let centerGain = 1;
  const chunk = 262144;

  for (let start = 0; start < vocalBuffer.length; start += chunk) {
    const end = Math.min(vocalBuffer.length, start + chunk);
    for (let index = start; index < end; index++) {
      const frame = analysis.frames[Math.min(analysis.frames.length - 1, Math.floor(index / analysis.hop))];
      const target = mfVocalFrameTarget(frame, mode);
      sideGain = target.sideGain < sideGain
        ? target.sideGain + attack * (sideGain - target.sideGain)
        : target.sideGain + release * (sideGain - target.sideGain);
      centerGain = target.centerGain < centerGain
        ? target.centerGain + attack * (centerGain - target.centerGain)
        : target.centerGain + release * (centerGain - target.centerGain);
      const mid = (left[index] + right[index]) * 0.5 * centerGain;
      const side = (left[index] - right[index]) * 0.5 * sideGain;
      outLeft[index] = mid + side;
      if (output.numberOfChannels > 1) outRight[index] = mid - side;
    }
    await sleep(0);
  }

  const delta = mfVocalDeltaScale(vocalBuffer, output, mode);
  if (delta.scale < 0.999) {
    for (let channel = 0; channel < output.numberOfChannels; channel++) {
      const before = vocalBuffer.getChannelData(Math.min(channel, vocalBuffer.numberOfChannels - 1));
      const after = output.getChannelData(channel);
      for (let index = 0; index < output.length; index++) after[index] = before[index] + (after[index] - before[index]) * delta.scale;
    }
  }
  return { buffer: output, stats: { mode, relativeDeltaDb: delta.relativeDb, scale: delta.scale } };
}

function mfVocalMixCleanup(baseMix, rawVocal, cleanedVocal, mode) {
  const output = cloneBuffer(baseMix);
  const length = Math.min(output.length, rawVocal.length, cleanedVocal.length);
  const amount = mode === 'remove' ? 1 : 0.9;
  for (let channel = 0; channel < output.numberOfChannels; channel++) {
    const destination = output.getChannelData(channel);
    const raw = rawVocal.getChannelData(Math.min(channel, rawVocal.numberOfChannels - 1));
    const cleaned = cleanedVocal.getChannelData(Math.min(channel, cleanedVocal.numberOfChannels - 1));
    for (let index = 0; index < length; index++) destination[index] += (cleaned[index] - raw[index]) * amount;
  }

  const before = measureBuffer(baseMix);
  let after = measureBuffer(output);
  const excessive = Math.abs(after.lufs - before.lufs) > 0.8
    || Math.abs(after.widthDb - before.widthDb) > 3.5
    || after.correlation < before.correlation - 0.04
    || after.peakDb > before.peakDb + 0.25;
  if (excessive) {
    for (let channel = 0; channel < output.numberOfChannels; channel++) {
      const base = baseMix.getChannelData(channel);
      const destination = output.getChannelData(channel);
      for (let index = 0; index < length; index++) destination[index] = base[index] + (destination[index] - base[index]) * 0.5;
    }
    after = measureBuffer(output);
  }
  return {
    buffer: output,
    metrics: {
      limitedByRegressionGuard: excessive,
      lufsShift: after.lufs - before.lufs,
      widthShift: after.widthDb - before.widthDb,
      correlationShift: after.correlation - before.correlation,
      peakShift: after.peakDb - before.peakDb,
    },
  };
}

function mfVocalFormatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainder}`;
}

function mfVocalFindCard() {
  return [...document.querySelectorAll('#stemGrid .stem-card')]
    .find((card) => card.querySelector('h3')?.textContent?.trim().toLowerCase() === 'vocals') || null;
}

async function mfVocalPlayCandidate(cleaned) {
  const cleanup = state.vocalCleanup;
  const raw = state.stemBuffers.vocals;
  if (!cleanup || !raw) return;
  stopPreview();
  if (state.vocalCleanupSource) {
    try { state.vocalCleanupSource.stop(); } catch (_) {}
    state.vocalCleanupSource = null;
  }
  const ctx = await ensureAudioContext(true);
  let buffer = raw;
  if (cleaned) {
    const rendered = await mfRenderVocalCleanup(raw, cleanup.analysis, cleanup.mode);
    buffer = rendered.buffer;
  }
  const section = cleanup.analysis.sections[0];
  const start = section ? clamp(section.start - 1, 0, Math.max(0, buffer.duration - 1)) : 0;
  const duration = Math.min(12, Math.max(2, buffer.duration - start));
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  gain.gain.value = dbToGain(-3);
  source.buffer = buffer;
  source.connect(gain).connect(ctx.destination);
  source.onended = () => { if (state.vocalCleanupSource === source) state.vocalCleanupSource = null; };
  state.vocalCleanupSource = source;
  source.start(0, start, duration);
}

function mfRenderVocalCleanupUI() {
  const cleanup = state.vocalCleanup;
  const card = mfVocalFindCard();
  if (!cleanup || !card) return;
  card.querySelector('.vocal-cleanup')?.remove();
  const analysis = cleanup.analysis;
  const box = mfEl('section', 'vocal-cleanup');
  const heading = mfEl('div', 'vocal-cleanup-head');
  heading.append(
    mfEl('div', '', ''),
    mfEl('span', 'badge', `${Math.round(analysis.confidence * 100)}% decision confidence`),
  );
  heading.firstChild.innerHTML = '<strong>Vocal Layer Cleanup</strong><small>center-locked, section-aware, reversible</small>';
  box.append(heading);

  const summary = mfEl('p', 'vocal-cleanup-summary');
  summary.textContent = analysis.stereo
    ? `${analysis.sections.length} questionable section${analysis.sections.length === 1 ? '' : 's'} detected across ${analysis.flaggedSeconds.toFixed(1)} seconds. The probable centered lead remains locked; only wide support energy and high-confidence noise can be attenuated.`
    : 'This vocal stem is mono. Wide-layer separation is unavailable, so MixForge will preserve it except for very high-confidence low-level noise.';
  box.append(summary);

  const choices = mfEl('div', 'candidate-choices vocal-cleanup-choices');
  for (const [mode, definition] of Object.entries(MF_VOCAL_CLEANUP_MODES)) {
    const button = mfEl('button', cleanup.mode === mode ? 'selected' : '', definition.label);
    button.type = 'button';
    if (mode === 'remove' && (analysis.removableSeconds < 0.2 || analysis.confidence < 0.7)) {
      button.disabled = true;
      button.title = 'No section met the confidence and artifact-safety threshold for removal.';
    }
    button.onclick = () => {
      cleanup.mode = mode;
      cleanup.rendered = null;
      cleanup.renderStats = null;
      mfRenderVocalCleanupUI();
    };
    choices.append(button);
  }
  box.append(choices);

  const evidence = mfEl('div', 'vocal-cleanup-evidence');
  if (analysis.sections.length) {
    for (const section of analysis.sections.slice(0, 5)) {
      const row = mfEl('div', 'vocal-cleanup-section');
      row.innerHTML = `<b>${mfVocalFormatTime(section.start)}–${mfVocalFormatTime(section.end)}</b><span>${section.reason}</span><i>${section.recommendation} · ${section.confidence}%</i>`;
      evidence.append(row);
    }
  } else {
    evidence.append(mfEl('span', 'healthy', 'No supporting layer or noise met the threshold for automatic reduction.'));
  }
  box.append(evidence);

  const preview = mfEl('div', 'actions vocal-cleanup-preview');
  const originalButton = mfEl('button', 'secondary', 'Hear original vocal section');
  const cleanedButton = mfEl('button', 'secondary', 'Hear cleanup candidate');
  originalButton.type = cleanedButton.type = 'button';
  originalButton.onclick = () => mfVocalPlayCandidate(false);
  cleanedButton.onclick = () => mfVocalPlayCandidate(true);
  preview.append(originalButton, cleanedButton);
  box.append(preview);

  const guardrail = mfEl('small', 'guardrail');
  guardrail.textContent = cleanup.mode === 'remove'
    ? 'Remove mode affects only frames that pass the high-confidence removal gate. Every other frame falls back to Reduce or Preserve.'
    : 'No hard deletion · probable lead center locked · smoothed automation · extraction quality and whole-mix regression checks enforced.';
  box.append(guardrail);
  card.append(box);
}

const mfVocalPreviousBuildStemPlans = buildStemPlans;
buildStemPlans = async function buildStemPlansWithVocalCleanup() {
  await mfVocalPreviousBuildStemPlans();
  const vocalBuffer = state.stemBuffers.vocals;
  const vocalPlan = state.stemPlans.vocals;
  if (!vocalBuffer || !vocalPlan) {
    state.vocalCleanup = null;
    return;
  }
  const quality = vocalPlan.quality?.score ?? 70;
  const analysis = mfAnalyzeVocalLayers(vocalBuffer, state.original, quality);
  const previousMode = state.vocalCleanup?.mode;
  state.vocalCleanup = {
    analysis,
    mode: previousMode && MF_VOCAL_CLEANUP_MODES[previousMode] ? previousMode : analysis.defaultMode,
    rendered: null,
    renderStats: null,
    appliedMetrics: null,
  };
  if (analysis.sections.length) {
    vocalPlan.confirmed.push({
      condition: 'Questionable vocal-layer regions',
      evidence: `${analysis.sections.length} section${analysis.sections.length === 1 ? '' : 's'} · ${analysis.flaggedSeconds.toFixed(1)} s flagged`,
      confidence: Math.round(analysis.confidence * 100),
    });
  }
};

const mfVocalPreviousRenderStemPlans = renderStemPlans;
renderStemPlans = function renderStemPlansWithVocalCleanup() {
  mfVocalPreviousRenderStemPlans();
  mfRenderVocalCleanupUI();
};

const mfVocalPreviousRebuildCorrectedMix = rebuildCorrectedMix;
rebuildCorrectedMix = async function rebuildCorrectedMixWithVocalCleanup() {
  const base = await mfVocalPreviousRebuildCorrectedMix();
  const cleanup = state.vocalCleanup;
  const raw = state.stemBuffers.vocals;
  if (!cleanup || !raw || cleanup.mode === 'preserve') return base;
  const rendered = await mfRenderVocalCleanup(raw, cleanup.analysis, cleanup.mode);
  cleanup.rendered = rendered.buffer;
  cleanup.renderStats = rendered.stats;
  const mixed = mfVocalMixCleanup(base, raw, rendered.buffer, cleanup.mode);
  cleanup.appliedMetrics = mixed.metrics;
  if (typeof forensicState !== 'undefined') {
    const before = measureBuffer(state.original);
    const after = measureBuffer(mixed.buffer);
    forensicState.reconstruction = {
      peakShift: after.peakDb - before.peakDb,
      lufsShift: after.lufs - before.lufs,
      widthShift: after.widthDb - before.widthDb,
      correlationShift: after.correlation - before.correlation,
    };
  }
  return mixed.buffer;
};

// Final fair-listening correction: permit attenuation or boost when matching the
// rendered master to the original for audition. The comparison buffer is never
// exported, and the ±18 dB bound prevents accidental runaway gain.
if (typeof renderReleaseMaster === 'function' && typeof mfProGainBuffer === 'function') {
  const mfVocalPreviousRenderReleaseMaster = renderReleaseMaster;
  renderReleaseMaster = async function renderReleaseMasterWithBidirectionalMatch() {
    const rendered = await mfVocalPreviousRenderReleaseMaster();
    const finalMetrics = measureBuffer(rendered);
    state.masterLevelMatched = mfProGainBuffer(rendered, clamp(state.mixMetrics.lufs - finalMetrics.lufs, -18, 18));
    return rendered;
  };
}
