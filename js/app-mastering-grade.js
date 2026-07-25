'use strict';

// MixForge 2.1 mastering-grade DSP layer.
// This file deliberately loads after the forensic rule engine and before the
// signal-integrity wrapper so every later stage uses the upgraded renderer.

const mfProLegacyMeasureBuffer = measureBuffer;
const mfProLegacyRenderProcessedBuffer = renderProcessedBuffer;
const mfProLoudnessCache = new WeakMap();
const mfProTruePeakCache = new WeakMap();

function mfProPowerToLufs(power) {
  return -0.691 + 10 * Math.log10(Math.max(power, 1e-20));
}

function mfProLufsToPower(lufs) {
  return Math.pow(10, (lufs + 0.691) / 10);
}

function mfProPowerAverage(values) {
  if (!values.length) return -70;
  let sum = 0;
  for (const value of values) sum += mfProLufsToPower(value);
  return mfProPowerToLufs(sum / values.length);
}

function mfProLoudnessStats(buffer) {
  const cached = mfProLoudnessCache.get(buffer);
  if (cached) return cached;

  const { shelf, hp } = kWeightCoefs(buffer.sampleRate);
  const channelCount = Math.min(buffer.numberOfChannels, 2);
  const channels = Array.from({ length: channelCount }, (_, channel) => buffer.getChannelData(channel));
  const states = Array.from({ length: channelCount }, () => ({
    shelf: { x1: 0, x2: 0, y1: 0, y2: 0 },
    hp: { x1: 0, x2: 0, y1: 0, y2: 0 },
  }));

  const momentarySamples = Math.max(1, Math.round(0.4 * buffer.sampleRate));
  const momentaryHop = Math.max(1, Math.round(0.1 * buffer.sampleRate));
  const shortSamples = Math.max(momentarySamples, Math.round(3 * buffer.sampleRate));
  const shortHop = Math.max(1, Math.round(buffer.sampleRate));
  const momentaryRing = new Float64Array(momentarySamples);
  const shortRing = new Float64Array(shortSamples);
  let momentarySum = 0;
  let shortSum = 0;
  const momentary = [];
  const shortTerm = [];

  for (let index = 0; index < buffer.length; index++) {
    let framePower = 0;
    for (let channel = 0; channel < channelCount; channel++) {
      const weighted = biquadSample(
        biquadSample(channels[channel][index], shelf, states[channel].shelf),
        hp,
        states[channel].hp,
      );
      framePower += weighted * weighted;
    }

    const momentaryIndex = index % momentarySamples;
    momentarySum += framePower - momentaryRing[momentaryIndex];
    momentaryRing[momentaryIndex] = framePower;

    const shortIndex = index % shortSamples;
    shortSum += framePower - shortRing[shortIndex];
    shortRing[shortIndex] = framePower;

    if (index + 1 >= momentarySamples && (index + 1 - momentarySamples) % momentaryHop === 0) {
      momentary.push(mfProPowerToLufs(momentarySum / momentarySamples));
    }
    if (index + 1 >= shortSamples && (index + 1 - shortSamples) % shortHop === 0) {
      shortTerm.push(mfProPowerToLufs(shortSum / shortSamples));
    }
  }

  const absoluteGated = momentary.filter((value) => value > -70);
  const ungated = absoluteGated.length ? mfProPowerAverage(absoluteGated) : -70;
  const relativeGate = Math.max(-70, ungated - 10);
  const integratedBlocks = absoluteGated.filter((value) => value > relativeGate);
  const integrated = integratedBlocks.length ? mfProPowerAverage(integratedBlocks) : -70;

  const lraGate = Math.max(-70, integrated - 20);
  const lraBlocks = shortTerm.filter((value) => value > lraGate);
  const lra = lraBlocks.length >= 2
    ? Math.max(0, percentile(lraBlocks, 0.95) - percentile(lraBlocks, 0.10))
    : 0;

  const stats = {
    integrated,
    lra,
    momentaryMax: momentary.length ? Math.max(...momentary) : integrated,
    shortTermMax: shortTerm.length ? Math.max(...shortTerm) : integrated,
    relativeGate,
    measuredMomentaryBlocks: momentary.length,
    measuredShortTermBlocks: shortTerm.length,
  };
  mfProLoudnessCache.set(buffer, stats);
  return stats;
}

measureLUFS = function measureIntegratedLoudness(buffer) {
  return mfProLoudnessStats(buffer).integrated;
};

measureBuffer = function measureBufferPro(buffer) {
  const metrics = mfProLegacyMeasureBuffer(buffer);
  const loudness = mfProLoudnessStats(buffer);
  return {
    ...metrics,
    lufs: loudness.integrated,
    lra: loudness.lra,
    momentaryMax: loudness.momentaryMax,
    shortTermMax: loudness.shortTermMax,
    loudnessGate: loudness.relativeGate,
  };
};

function mfProCubicSample(p0, p1, p2, p3, t) {
  const a0 = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
  const a1 = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3;
  const a2 = -0.5 * p0 + 0.5 * p2;
  return ((a0 * t + a1) * t + a2) * t + p1;
}

function mfProEstimateTruePeakDb(buffer) {
  const cached = mfProTruePeakCache.get(buffer);
  if (Number.isFinite(cached)) return cached;

  let peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    if (!data.length) continue;
    peak = Math.max(peak, Math.abs(data[0]), Math.abs(data[data.length - 1]));
    for (let index = 1; index < data.length - 2; index++) {
      const p0 = data[index - 1];
      const p1 = data[index];
      const p2 = data[index + 1];
      const p3 = data[index + 2];
      peak = Math.max(
        peak,
        Math.abs(p1),
        Math.abs(mfProCubicSample(p0, p1, p2, p3, 0.25)),
        Math.abs(mfProCubicSample(p0, p1, p2, p3, 0.5)),
        Math.abs(mfProCubicSample(p0, p1, p2, p3, 0.75)),
      );
    }
  }
  const result = gainToDb(peak);
  mfProTruePeakCache.set(buffer, result);
  return result;
}

mfEstimateTruePeak = mfProEstimateTruePeakDb;

function mfProNormalizedBand(metrics, name, side = false) {
  return band(metrics, name, side) - metrics.lufs;
}

function mfProReferenceMove(metrics, referenceMetrics, name, side = false) {
  if (!referenceMetrics) return null;
  return mfProNormalizedBand(metrics, name, side) - mfProNormalizedBand(referenceMetrics, name, side);
}

buildMasterPlan = function buildMasterPlanPro(metrics, requestedTargetLufs) {
  const targetLufs = clamp(Number(requestedTargetLufs) || -12, -18, -8);
  const referenceMetrics = forensicState?.references?.[0]?.metrics || null;
  const eq = [];
  const addEq = (filterType, frequency, gain, q, label) => {
    if (Math.abs(gain) < 0.35) return;
    eq.push({ type: 'eq', filterType, frequency, gain: clamp(gain, -2.5, 2.0), q, label });
  };

  if (referenceMetrics) {
    const subMove = mfProReferenceMove(metrics, referenceMetrics, 'Sub');
    const lowMidMove = mfProReferenceMove(metrics, referenceMetrics, 'Low-mids');
    const presenceMove = mfProReferenceMove(metrics, referenceMetrics, 'Presence');
    const airMove = mfProReferenceMove(metrics, referenceMetrics, 'Air');
    if (subMove > 2.5) addEq('lowshelf', 55, -(subMove - 1.5) * 0.32, 0.7, 'Reference-bounded sub control');
    if (lowMidMove > 3) addEq('peaking', 340, -(lowMidMove - 1.5) * 0.28, 0.85, 'Reference-bounded low-mid cleanup');
    if (presenceMove < -4) addEq('peaking', 3200, (-presenceMove - 2.5) * 0.22, 0.8, 'Reference-bounded presence recovery');
    if (airMove < -5) addEq('highshelf', 9500, (-airMove - 3) * 0.18, 0.7, 'Reference-bounded air recovery');
  } else {
    const subExcess = band(metrics, 'Sub') - band(metrics, 'Bass');
    const lowMid = band(metrics, 'Low-mids') - band(metrics, 'Mids');
    const airDrop = band(metrics, 'Presence') - band(metrics, 'Air');
    if (subExcess > 3) addEq('lowshelf', 55, -(subExcess - 1.5) * 0.32, 0.7, 'Conservative sub trim');
    if (lowMid > 9) addEq('peaking', 350, -(lowMid - 7) * 0.22, 0.9, 'Broad low-mid cleanup');
    if (airDrop > 12) addEq('highshelf', 9500, (airDrop - 10) * 0.16, 0.7, 'Conservative air shelf');
  }

  const compressionEligible = metrics.crestDb > 13
    && metrics.lra > 7
    && metrics.clipPercent === 0
    && metrics.correlation > -0.05;
  const compressor = compressionEligible ? {
    type: 'compressor',
    threshold: clamp(metrics.rmsDb + 7, -28, -12),
    ratio: 1.45,
    attack: 0.035,
    release: 0.2,
    knee: 8,
    label: 'Low-ratio program glue',
  } : null;

  return {
    eq,
    compressor,
    gainDb: clamp(targetLufs - metrics.lufs, -12, 8),
    targetLufs,
    ceilingDb: -1.2,
    truePeakCeilingDb: -1.0,
    referenceUsed: Boolean(referenceMetrics),
  };
};

renderMasterChain = function renderMasterChainPro(plan) {
  const root = $('masterChain');
  root.replaceChildren();
  const steps = [];
  for (const item of plan.eq) steps.push([item.label, describeOperation(item)]);
  if (plan.compressor) steps.push([plan.compressor.label, describeOperation(plan.compressor)]);
  else steps.push(['Dynamics decision', 'No master compression; source dynamics are already controlled or do not justify it']);
  steps.push(['Loudness normalization', `${plan.gainDb >= 0 ? '+' : ''}${plan.gainDb.toFixed(1)} dB requested toward ${plan.targetLufs.toFixed(1)} LUFS`]);
  steps.push(['Linked look-ahead limiter', `${plan.ceilingDb.toFixed(1)} dBFS internal ceiling`]);
  steps.push(['True-peak safety trim', `${plan.truePeakCeilingDb.toFixed(1)} dBTP final ceiling · loudness yields to peak safety`]);
  steps.push(['Tonal context', plan.referenceUsed ? 'Reference-informed, level-normalized and correction-limited' : 'Conservative internal guardrails; no blind match-EQ']);

  for (const [label, value] of steps) {
    const row = document.createElement('div');
    row.className = 'chain-item';
    const strong = document.createElement('b');
    strong.textContent = label;
    const span = document.createElement('span');
    span.textContent = value;
    row.append(strong, span);
    root.append(row);
  }
};

lookAheadLimit = function lookAheadLimitPro(buffer, ceilingDb = -1.2, lookaheadMs = 7, releaseMs = 110) {
  const ceiling = dbToGain(ceilingDb);
  const lookahead = Math.max(1, Math.round(buffer.sampleRate * lookaheadMs / 1000));
  const releaseCoeff = Math.exp(-1 / Math.max(1, buffer.sampleRate * releaseMs / 1000));
  const out = cloneBuffer(buffer);
  const framePeaks = new Float32Array(buffer.length);
  for (let index = 0; index < buffer.length; index++) {
    let peak = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      peak = Math.max(peak, Math.abs(buffer.getChannelData(channel)[index]));
    }
    framePeaks[index] = peak;
  }

  const capacity = lookahead + 3;
  const queue = new Int32Array(capacity);
  let head = 0;
  let tail = 0;
  const get = (position) => queue[position % capacity];
  const push = (index) => {
    const value = framePeaks[index];
    while (tail > head && framePeaks[get(tail - 1)] <= value) tail--;
    queue[tail % capacity] = index;
    tail++;
  };
  for (let index = 0; index < Math.min(buffer.length, lookahead + 1); index++) push(index);

  let gain = 1;
  for (let index = 0; index < out.length; index++) {
    while (tail > head && get(head) < index) head++;
    const futurePeak = tail > head ? framePeaks[get(head)] : framePeaks[index];
    const desired = futurePeak > ceiling ? ceiling / futurePeak : 1;
    gain = desired < gain ? desired : 1 - (1 - gain) * releaseCoeff;
    for (let channel = 0; channel < out.numberOfChannels; channel++) {
      out.getChannelData(channel)[index] *= gain;
    }
    const next = index + lookahead + 1;
    if (next < buffer.length) push(next);
  }
  return out;
};

function mfProGainBuffer(buffer, gainDb) {
  const out = cloneBuffer(buffer);
  const gain = dbToGain(gainDb);
  for (let channel = 0; channel < out.numberOfChannels; channel++) {
    const data = out.getChannelData(channel);
    for (let index = 0; index < data.length; index++) data[index] *= gain;
  }
  return out;
}

async function mfProDynamicDeEss(sourceBuffer, operation) {
  const out = cloneBuffer(sourceBuffer);
  const sampleRate = out.sampleRate;
  const frequency = clamp(Number(operation.frequency) || 6800, 4500, 10000);
  const threshold = dbToGain(clamp(Number(operation.threshold) || -30, -45, -15));
  const maxReductionDb = clamp(Number(operation.maxReductionDb) || 3.5, 1, 5);
  const rc = 1 / (2 * Math.PI * frequency);
  const highPassAlpha = rc / (rc + 1 / sampleRate);
  const detectorAttack = Math.exp(-1 / Math.max(1, sampleRate * 0.0015));
  const detectorRelease = Math.exp(-1 / Math.max(1, sampleRate * 0.045));
  const bodyRelease = Math.exp(-1 / Math.max(1, sampleRate * 0.08));
  const gainAttack = Math.exp(-1 / Math.max(1, sampleRate * 0.001));
  const gainRelease = Math.exp(-1 / Math.max(1, sampleRate * 0.07));
  const previousX = new Float64Array(out.numberOfChannels);
  const previousY = new Float64Array(out.numberOfChannels);
  let highEnvelope = 0;
  let bodyEnvelope = 0;
  let gain = 1;
  const chunk = 262144;

  for (let start = 0; start < out.length; start += chunk) {
    const end = Math.min(out.length, start + chunk);
    for (let index = start; index < end; index++) {
      let high = 0;
      let body = 0;
      for (let channel = 0; channel < out.numberOfChannels; channel++) {
        const data = out.getChannelData(channel);
        const x = data[index];
        const y = highPassAlpha * (previousY[channel] + x - previousX[channel]);
        previousX[channel] = x;
        previousY[channel] = y;
        high = Math.max(high, Math.abs(y));
        body = Math.max(body, Math.abs(x));
      }

      highEnvelope = high > highEnvelope
        ? high + detectorAttack * (highEnvelope - high)
        : high + detectorRelease * (highEnvelope - high);
      bodyEnvelope = body > bodyEnvelope ? body : body + bodyRelease * (bodyEnvelope - body);
      const ratio = highEnvelope / Math.max(bodyEnvelope, 1e-8);
      let desired = 1;
      if (highEnvelope > threshold && ratio > 0.16) {
        const overDb = Math.max(0, gainToDb(highEnvelope / threshold));
        const specificity = clamp((ratio - 0.16) / 0.34, 0, 1);
        const reductionDb = clamp(overDb * 0.36 * specificity, 0, maxReductionDb);
        desired = dbToGain(-reductionDb);
      }
      gain = desired < gain
        ? desired + gainAttack * (gain - desired)
        : desired + gainRelease * (gain - desired);
      for (let channel = 0; channel < out.numberOfChannels; channel++) {
        out.getChannelData(channel)[index] *= gain;
      }
    }
    await sleep(0);
  }
  return out;
}

renderProcessedBuffer = async function renderProcessedBufferPro(sourceBuffer, operations) {
  const deEssers = operations.filter((operation) => operation.type === 'deess');
  let working = sourceBuffer;
  for (const operation of deEssers) working = await mfProDynamicDeEss(working, operation);
  return mfProLegacyRenderProcessedBuffer(working, operations.filter((operation) => operation.type !== 'deess'));
};

renderReleaseMaster = async function renderReleaseMasterPro() {
  let rendered = await renderPreLimitedMaster(state.corrected, state.masterPlan);
  rendered = lookAheadLimit(rendered, state.masterPlan.ceilingDb);

  for (let pass = 0; pass < 2; pass++) {
    const metrics = measureBuffer(rendered);
    const error = state.masterPlan.targetLufs - metrics.lufs;
    if (Math.abs(error) < 0.3) break;
    rendered = lookAheadLimit(mfProGainBuffer(rendered, clamp(error, -2.5, 2.5)), state.masterPlan.ceilingDb);
    await sleep(0);
  }

  let truePeakDb = mfProEstimateTruePeakDb(rendered);
  if (truePeakDb > state.masterPlan.truePeakCeilingDb) {
    rendered = mfProGainBuffer(rendered, state.masterPlan.truePeakCeilingDb - truePeakDb - 0.03);
    truePeakDb = mfProEstimateTruePeakDb(rendered);
  }

  const finalMetrics = measureBuffer(rendered);
  state.masterConstraint = {
    truePeakDb,
    targetLufs: state.masterPlan.targetLufs,
    achievedLufs: finalMetrics.lufs,
    loudnessShortfall: state.masterPlan.targetLufs - finalMetrics.lufs,
    peakLimited: Math.abs(truePeakDb - state.masterPlan.truePeakCeilingDb) < 0.18,
  };
  state.masterLevelMatched = mfProGainBuffer(rendered, clamp(state.mixMetrics.lufs - finalMetrics.lufs, -18, 0));
  return rendered;
};

const mfProPreviousVerification = renderVerification;
renderVerification = function renderVerificationPro(metrics, plan) {
  mfProPreviousVerification(metrics, plan);
  const root = $('verificationList');
  const loudness = mfProLoudnessStats(state.master);
  const truePeakDb = state.masterConstraint?.truePeakDb ?? mfProEstimateTruePeakDb(state.master);
  const peakSafe = truePeakDb <= plan.truePeakCeilingDb + 0.05;
  const truePeakRow = document.createElement('div');
  truePeakRow.className = `check ${peakSafe ? '' : 'fail'}`;
  truePeakRow.innerHTML = `<b>${peakSafe ? '✓' : '×'}</b><div><strong>4× interpolated true peak: </strong>${truePeakDb.toFixed(2)} dBTP vs ${plan.truePeakCeilingDb.toFixed(1)} dBTP ceiling.</div>`;
  root.append(truePeakRow);

  const rangeRow = document.createElement('div');
  rangeRow.className = 'check';
  rangeRow.innerHTML = `<b>✓</b><div><strong>EBU-style program dynamics: </strong>${loudness.lra.toFixed(1)} LU LRA · ${loudness.shortTermMax.toFixed(1)} LUFS max short-term · ${loudness.momentaryMax.toFixed(1)} LUFS max momentary.</div>`;
  root.append(rangeRow);

  const shortfall = state.masterConstraint?.loudnessShortfall || 0;
  if (shortfall > 0.55) {
    const targetRow = document.createElement('div');
    targetRow.className = `check ${shortfall <= 1.5 ? 'warn' : 'fail'}`;
    targetRow.innerHTML = `<b>${shortfall <= 1.5 ? '!' : '×'}</b><div><strong>Peak-safe loudness limit: </strong>The master finished ${shortfall.toFixed(1)} LU below the requested target because true-peak safety took priority over extra limiting.</div>`;
    root.append(targetRow);
  }
};
