'use strict';

// MixForge 2.3 Problem Timeline + Remaster Self-Check.
// Locates time-bounded risks in the source mix, lets the listener audition
// them, and re-runs the same detector after mastering so improvements and
// regressions are visible instead of inferred from one whole-song number.

const MF_TIMELINE_TYPES = Object.freeze({
  clipping: {
    label: 'Digital clipping',
    severity: 'high',
    weight: 3,
    message: 'Samples reached digital full scale in this section.',
  },
  peak_risk: {
    label: 'Peak safety risk',
    severity: 'high',
    weight: 3,
    message: 'The sample peak is above −1 dBFS, leaving little inter-sample headroom.',
  },
  mono_incompatibility: {
    label: 'Mono compatibility',
    severity: 'high',
    weight: 3,
    message: 'Negative stereo correlation indicates cancellation risk in mono.',
  },
  harshness_band: {
    label: 'Harshness band',
    severity: 'medium',
    weight: 2,
    message: 'Persistent 3–9 kHz energy is elevated in this section.',
  },
  sub_bass_heavy: {
    label: 'Sub-bass dominance',
    severity: 'medium',
    weight: 2,
    message: 'The 20–80 Hz band dominates the analyzed energy here.',
  },
  sibilance: {
    label: 'Sibilance / cymbal flare',
    severity: 'medium',
    weight: 2,
    message: 'The 6–10 kHz band rises sharply against the vocal-body range.',
  },
  loudness_dip: {
    label: 'Loudness dip',
    severity: 'medium',
    weight: 2,
    message: 'This section falls well below the song’s typical short-term level.',
  },
});

function mfTimelineClamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function mfTimelineGainToDb(value) {
  return 20 * Math.log10(Math.max(value, 1e-12));
}

function mfTimelineMedian(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) * 0.5;
}

function mfTimelineFormatTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const remainder = Math.floor(safe % 60).toString().padStart(2, '0');
  return `${minutes}:${remainder}`;
}

function mfTimelineFft(real, imaginary) {
  const length = real.length;
  for (let index = 1, swap = 0; index < length; index++) {
    let bit = length >> 1;
    for (; swap & bit; bit >>= 1) swap ^= bit;
    swap ^= bit;
    if (index < swap) {
      [real[index], real[swap]] = [real[swap], real[index]];
      [imaginary[index], imaginary[swap]] = [imaginary[swap], imaginary[index]];
    }
  }
  for (let size = 2; size <= length; size <<= 1) {
    const angle = -2 * Math.PI / size;
    const rotationReal = Math.cos(angle);
    const rotationImaginary = Math.sin(angle);
    for (let start = 0; start < length; start += size) {
      let currentReal = 1;
      let currentImaginary = 0;
      for (let offset = 0; offset < size / 2; offset++) {
        const evenReal = real[start + offset];
        const evenImaginary = imaginary[start + offset];
        const oddReal = real[start + offset + size / 2] * currentReal
          - imaginary[start + offset + size / 2] * currentImaginary;
        const oddImaginary = real[start + offset + size / 2] * currentImaginary
          + imaginary[start + offset + size / 2] * currentReal;
        real[start + offset] = evenReal + oddReal;
        imaginary[start + offset] = evenImaginary + oddImaginary;
        real[start + offset + size / 2] = evenReal - oddReal;
        imaginary[start + offset + size / 2] = evenImaginary - oddImaginary;
        const nextReal = currentReal * rotationReal - currentImaginary * rotationImaginary;
        currentImaginary = currentReal * rotationImaginary + currentImaginary * rotationReal;
        currentReal = nextReal;
      }
    }
  }
}

function mfTimelineSpectralFeatures(left, right, sampleRate, startSample, endSample) {
  const fftSize = 2048;
  const available = Math.max(1, endSample - startSample);
  const center = startSample + Math.floor(available / 2);
  const fftStart = mfTimelineClamp(center - Math.floor(fftSize / 2), 0, Math.max(0, left.length - fftSize));
  const real = new Float64Array(fftSize);
  const imaginary = new Float64Array(fftSize);

  for (let index = 0; index < fftSize; index++) {
    const sourceIndex = fftStart + index;
    const mid = ((left[sourceIndex] || 0) + (right[sourceIndex] || 0)) * 0.5;
    const window = 0.5 * (1 - Math.cos(2 * Math.PI * index / (fftSize - 1)));
    real[index] = mid * window;
  }
  mfTimelineFft(real, imaginary);

  const energy = {
    total: 0,
    sub: 0,
    lowMid: 0,
    mids: 0,
    body: 0,
    harsh: 0,
    sibilance: 0,
  };
  const nyquistLimit = Math.min(16000, sampleRate / 2);
  for (let bin = 1; bin < fftSize / 2; bin++) {
    const frequency = bin * sampleRate / fftSize;
    if (frequency < 20 || frequency > nyquistLimit) continue;
    const power = real[bin] * real[bin] + imaginary[bin] * imaginary[bin];
    energy.total += power;
    if (frequency <= 80) energy.sub += power;
    if (frequency >= 250 && frequency < 500) energy.lowMid += power;
    if (frequency >= 500 && frequency < 2000) energy.mids += power;
    if (frequency >= 300 && frequency < 4000) energy.body += power;
    if (frequency >= 3000 && frequency < 9000) energy.harsh += power;
    if (frequency >= 6000 && frequency < 10000) energy.sibilance += power;
  }

  const total = Math.max(energy.total, 1e-20);
  const bodyAndSibilance = Math.max(energy.body + energy.sibilance, 1e-20);
  return {
    subRatio: energy.sub / total,
    harshRatio: energy.harsh / total,
    sibilanceRatio: energy.sibilance / bodyAndSibilance,
    lowMidToMidDb: 10 * Math.log10(Math.max(energy.lowMid, 1e-20) / Math.max(energy.mids, 1e-20)),
  };
}

function mfTimelineFrame(buffer, startSeconds, windowSeconds) {
  const sampleRate = buffer.sampleRate;
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const startSample = Math.max(0, Math.floor(startSeconds * sampleRate));
  const endSample = Math.min(buffer.length, Math.max(startSample + 1, Math.ceil((startSeconds + windowSeconds) * sampleRate)));
  let peak = 0;
  let clipped = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  let crossEnergy = 0;
  let midEnergy = 0;
  let sideEnergy = 0;
  let sampleCount = 0;

  for (let index = startSample; index < endSample; index++) {
    const l = left[index] || 0;
    const r = right[index] || 0;
    const mid = (l + r) * 0.5;
    const side = (l - r) * 0.5;
    const framePeak = Math.max(Math.abs(l), Math.abs(r));
    peak = Math.max(peak, framePeak);
    if (framePeak >= 0.999) clipped++;
    leftEnergy += l * l;
    rightEnergy += r * r;
    crossEnergy += l * r;
    midEnergy += mid * mid;
    sideEnergy += side * side;
    sampleCount++;
  }

  const stereoDenominator = Math.sqrt(Math.max(1e-20, leftEnergy * rightEnergy));
  const rms = Math.sqrt((leftEnergy + rightEnergy) / Math.max(1, sampleCount * 2));
  const spectral = rms > 1e-5
    ? mfTimelineSpectralFeatures(left, right, sampleRate, startSample, endSample)
    : { subRatio: 0, harshRatio: 0, sibilanceRatio: 0, lowMidToMidDb: 0 };

  return {
    start: startSeconds,
    end: Math.min(buffer.duration, startSeconds + windowSeconds),
    peak,
    peakDb: mfTimelineGainToDb(peak),
    clipPercent: clipped / Math.max(1, sampleCount) * 100,
    rmsDb: mfTimelineGainToDb(rms),
    correlation: stereoDenominator > 1e-12 ? crossEnergy / stereoDenominator : 1,
    widthDb: 10 * Math.log10(Math.max(sideEnergy, 1e-20) / Math.max(midEnergy, 1e-20)),
    ...spectral,
  };
}

function mfTimelineMergeEvents(frames, definition, context, windowSeconds, hopSeconds) {
  const markers = [];
  const gapTolerance = Math.max(hopSeconds * 1.5, 0.03);
  let current = null;

  const flush = () => {
    if (!current) return;
    markers.push(current);
    current = null;
  };

  for (const frame of frames) {
    const result = definition.evaluate(frame, context);
    if (!result.active) {
      flush();
      continue;
    }
    const event = {
      type: definition.type,
      severity: definition.severity,
      start: frame.start,
      end: frame.end,
      intensity: result.intensity,
      evidence: result.evidence,
      message: MF_TIMELINE_TYPES[definition.type].message,
    };
    if (!current) {
      current = event;
      continue;
    }
    if (event.start <= current.end + gapTolerance) {
      current.end = Math.max(current.end, event.end);
      if (event.intensity > current.intensity) {
        current.intensity = event.intensity;
        current.evidence = event.evidence;
      }
    } else {
      flush();
      current = event;
    }
  }
  flush();
  return markers;
}

async function mfTimelineAnalyze(buffer, options = {}) {
  if (!buffer?.length || !buffer.sampleRate) return { frames: [], markers: [], counts: {}, issueLoad: 0 };
  const duration = Number(buffer.duration) || buffer.length / buffer.sampleRate;
  const hopSeconds = Math.max(0.5, duration / 480);
  const windowSeconds = mfTimelineClamp(hopSeconds * 1.5, 0.65, 1.5);
  const frames = [];

  for (let start = 0, index = 0; start < duration; start += hopSeconds, index++) {
    frames.push(mfTimelineFrame(buffer, start, windowSeconds));
    if (index > 0 && index % 24 === 0) {
      if (typeof options.onProgress === 'function') options.onProgress(Math.min(99, Math.round(start / duration * 100)));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  const activeLevels = frames.filter((frame) => frame.rmsDb > -65).map((frame) => frame.rmsDb);
  const medianLevel = mfTimelineMedian(activeLevels);
  const context = { medianLevel };
  const definitions = [
    {
      type: 'clipping', severity: 'high',
      evaluate: (frame) => ({
        active: frame.clipPercent > 0.0005,
        intensity: frame.clipPercent,
        evidence: `${frame.clipPercent.toFixed(3)}% clipped samples; peak ${frame.peakDb.toFixed(2)} dBFS.`,
      }),
    },
    {
      type: 'peak_risk', severity: 'high',
      evaluate: (frame) => ({
        active: frame.peakDb >= -1 && frame.clipPercent <= 0.0005,
        intensity: frame.peakDb + 1,
        evidence: `Sample peak ${frame.peakDb.toFixed(2)} dBFS in this window.`,
      }),
    },
    {
      type: 'mono_incompatibility', severity: 'high',
      evaluate: (frame) => ({
        active: frame.rmsDb > -55 && frame.correlation < -0.1,
        intensity: -frame.correlation,
        evidence: `Stereo correlation fell to ${frame.correlation.toFixed(2)}; side/mid ${frame.widthDb.toFixed(1)} dB.`,
      }),
    },
    {
      type: 'harshness_band', severity: 'medium',
      evaluate: (frame) => ({
        active: frame.rmsDb > -55 && frame.harshRatio >= 0.26,
        intensity: frame.harshRatio,
        evidence: `3–9 kHz carried ${(frame.harshRatio * 100).toFixed(1)}% of analyzed energy.`,
      }),
    },
    {
      type: 'sub_bass_heavy', severity: 'medium',
      evaluate: (frame) => ({
        active: frame.rmsDb > -55 && frame.subRatio >= 0.24,
        intensity: frame.subRatio,
        evidence: `20–80 Hz carried ${(frame.subRatio * 100).toFixed(1)}% of analyzed energy.`,
      }),
    },
    {
      type: 'sibilance', severity: 'medium',
      evaluate: (frame) => ({
        active: frame.rmsDb > -55 && frame.sibilanceRatio >= 0.20 && frame.harshRatio >= 0.16,
        intensity: frame.sibilanceRatio,
        evidence: `6–10 kHz reached ${(frame.sibilanceRatio * 100).toFixed(1)}% against the vocal-body band.`,
      }),
    },
    {
      type: 'loudness_dip', severity: 'medium',
      evaluate: (frame, currentContext) => {
        const delta = currentContext.medianLevel - frame.rmsDb;
        return {
          active: currentContext.medianLevel > -60 && frame.rmsDb > -65 && delta >= 8,
          intensity: delta,
          evidence: `Section level is ${delta.toFixed(1)} dB below the song median.`,
        };
      },
    },
  ];

  const markers = definitions.flatMap((definition) => (
    mfTimelineMergeEvents(frames, definition, context, windowSeconds, hopSeconds)
  ));
  markers.sort((a, b) => {
    const severityDelta = (b.severity === 'high' ? 2 : 1) - (a.severity === 'high' ? 2 : 1);
    if (severityDelta) return severityDelta;
    return (b.intensity * Math.max(0.25, b.end - b.start)) - (a.intensity * Math.max(0.25, a.end - a.start));
  });

  const counts = {};
  for (const marker of markers) counts[marker.type] = (counts[marker.type] || 0) + 1;
  const issueLoad = Object.entries(counts).reduce((sum, [type, count]) => (
    sum + (MF_TIMELINE_TYPES[type]?.weight || 1) * Math.sqrt(count)
  ), 0);
  if (typeof options.onProgress === 'function') options.onProgress(100);
  return { duration, hopSeconds, windowSeconds, frames, markers, counts, issueLoad };
}

function mfTimelineSelfCheck(sourceAnalysis, masteredAnalysis) {
  const sourceCounts = sourceAnalysis?.counts || {};
  const masteredCounts = masteredAnalysis?.counts || {};
  const types = [...new Set([...Object.keys(sourceCounts), ...Object.keys(masteredCounts)])].sort();
  const resolved = [];
  const improved = [];
  const remaining = [];
  const worsened = [];

  for (const type of types) {
    const before = Number(sourceCounts[type] || 0);
    const after = Number(masteredCounts[type] || 0);
    if (before > 0 && after === 0) resolved.push(type);
    if (after > 0) remaining.push(type);
    if (after < before) improved.push(type);
    else if (after > before) worsened.push(type);
  }

  const beforeLoad = Number(sourceAnalysis?.issueLoad || 0);
  const afterLoad = Number(masteredAnalysis?.issueLoad || 0);
  let assessment = 'unchanged';
  if (afterLoad <= Math.max(0, beforeLoad - 4)) assessment = 'strong_improvement';
  else if (afterLoad < beforeLoad - 0.01) assessment = 'partial_improvement';
  else if (afterLoad > beforeLoad + 0.01) assessment = 'regression';

  return {
    assessment,
    scoreBefore: beforeLoad,
    scoreAfter: afterLoad,
    scoreDelta: afterLoad - beforeLoad,
    resolved,
    improved,
    remaining,
    worsened,
  };
}
