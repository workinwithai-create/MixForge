'use strict';

// MixForge critical-listening layer.
// Provides attenuation-only, loudness-matched comparisons and an aligned null
// monitor so "better" cannot simply mean "louder" and latency does not
// masquerade as processing. Both sides are matched down to the quieter program;
// neither side is boosted into clipping for the comparison.

function mfListenMonoSample(buffer, channelIndex) {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0)[channelIndex] || 0;
  return ((buffer.getChannelData(0)[channelIndex] || 0) + (buffer.getChannelData(1)[channelIndex] || 0)) * 0.5;
}

function mfListenFindAlignment(original, processed) {
  const sampleRate = original.sampleRate;
  const maxLag = Math.round(sampleRate * 0.025);
  const lagStep = 4;
  const sampleStep = 64;
  const start = Math.min(
    Math.max(0, Math.round(sampleRate * 0.5)),
    Math.max(0, Math.min(original.length, processed.length) - 1),
  );
  const analysisLength = Math.min(Math.round(sampleRate * 20), Math.min(original.length, processed.length) - start - maxLag - 1);
  if (analysisLength <= sampleRate) return { lagSamples: 0, correlation: 1 };

  let bestLag = 0;
  let bestCorrelation = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag += lagStep) {
    let xy = 0;
    let xx = 0;
    let yy = 0;
    for (let offset = 0; offset < analysisLength; offset += sampleStep) {
      const originalIndex = start + offset;
      const processedIndex = originalIndex + lag;
      if (processedIndex < 0 || processedIndex >= processed.length) continue;
      const x = mfListenMonoSample(original, originalIndex);
      const y = mfListenMonoSample(processed, processedIndex);
      xy += x * y;
      xx += x * x;
      yy += y * y;
    }
    const correlation = xy / Math.sqrt(Math.max(1e-20, xx * yy));
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }
  return { lagSamples: bestLag, correlation: bestCorrelation };
}

function mfListenMatchLevels(original, master) {
  const originalMetrics = measureBuffer(original);
  const masterMetrics = measureBuffer(master);
  const originalLufs = Number(originalMetrics.lufs);
  const masterLufs = Number(masterMetrics.lufs);
  const commonLufs = Number.isFinite(originalLufs) && Number.isFinite(masterLufs)
    ? Math.min(originalLufs, masterLufs)
    : null;
  return {
    originalMetrics,
    masterMetrics,
    commonLufs,
    originalGainDb: commonLufs == null ? 0 : clamp(commonLufs - originalLufs, -72, 0),
    masterGainDb: commonLufs == null ? 0 : clamp(commonLufs - masterLufs, -72, 0),
  };
}

function mfListenGainCopy(buffer, gainDb) {
  if (!buffer || Math.abs(gainDb) < 0.001) return buffer;
  const out = cloneBuffer(buffer);
  const gain = dbToGain(gainDb);
  for (let channel = 0; channel < out.numberOfChannels; channel++) {
    const data = out.getChannelData(channel);
    for (let index = 0; index < data.length; index++) data[index] *= gain;
  }
  return out;
}

function mfListenBuildMatchedPair(original, master) {
  if (!original || !master) return null;
  const match = mfListenMatchLevels(original, master);
  return {
    ...match,
    original: mfListenGainCopy(original, match.originalGainDb),
    master: mfListenGainCopy(master, match.masterGainDb),
  };
}

mfBuildDifferenceMonitor = async function mfBuildAlignedDifferenceMonitor(original, master) {
  if (!original || !master) return { buffer: null, metrics: null };
  const ctx = await ensureAudioContext(false);
  const alignment = mfListenFindAlignment(original, master);
  const match = mfListenMatchLevels(original, master);
  const originalGain = dbToGain(match.originalGainDb);
  const masterGain = dbToGain(match.masterGainDb);
  const channels = Math.max(1, Math.min(original.numberOfChannels, master.numberOfChannels));
  const length = Math.min(original.length, master.length);
  const output = ctx.createBuffer(channels, length, master.sampleRate);
  let referenceEnergy = 0;
  let differenceEnergy = 0;
  let rawPeak = 0;
  let count = 0;
  const chunk = 131072;

  for (let start = 0; start < length; start += chunk) {
    const end = Math.min(length, start + chunk);
    for (let channel = 0; channel < channels; channel++) {
      const before = original.getChannelData(Math.min(channel, original.numberOfChannels - 1));
      const after = master.getChannelData(Math.min(channel, master.numberOfChannels - 1));
      const delta = output.getChannelData(channel);
      for (let masterIndex = start; masterIndex < end; masterIndex++) {
        const originalIndex = masterIndex - alignment.lagSamples;
        const matchedOriginal = originalIndex >= 0 && originalIndex < before.length
          ? before[originalIndex] * originalGain
          : 0;
        const matchedMaster = after[masterIndex] * masterGain;
        const change = matchedMaster - matchedOriginal;
        delta[masterIndex] = change;
        referenceEnergy += matchedMaster * matchedMaster;
        differenceEnergy += change * change;
        rawPeak = Math.max(rawPeak, Math.abs(change));
        count++;
      }
    }
    await sleep(0);
  }

  const relativeDb = 10 * Math.log10(Math.max(differenceEnergy, 1e-20) / Math.max(referenceEnergy, 1e-20));
  const differenceRmsDb = 10 * Math.log10(Math.max(differenceEnergy / Math.max(1, count), 1e-20));
  const rawPeakDb = gainToDb(rawPeak);
  const monitorGain = rawPeak > 1e-9 ? clamp(dbToGain(-6) / rawPeak, 1, 20) : 1;
  for (let channel = 0; channel < channels; channel++) {
    const data = output.getChannelData(channel);
    for (let index = 0; index < data.length; index++) data[index] *= monitorGain;
  }

  return {
    buffer: output,
    metrics: {
      relativeDb,
      differenceRmsDb,
      rawPeakDb,
      monitorGainDb: gainToDb(monitorGain),
      alignmentMs: alignment.lagSamples / original.sampleRate * 1000,
      alignmentCorrelation: alignment.correlation,
      commonLufs: match.commonLufs,
      originalMatchDb: match.originalGainDb,
      masterMatchDb: match.masterGainDb,
      // Legacy field retained for any older UI consumer. Positive means the
      // original required more attenuation than the master.
      levelMatchDb: match.originalGainDb - match.masterGainDb,
    },
  };
};

const mfListenPreviousRenderReleaseMaster = renderReleaseMaster;
renderReleaseMaster = async function renderCriticalListeningMaster(...args) {
  const master = await mfListenPreviousRenderReleaseMaster(...args);
  const pair = mfListenBuildMatchedPair(state.original, master);
  if (pair) {
    state.originalLevelMatched = pair.original;
    state.masterLevelMatched = pair.master;
    state.masterLevelMatch = {
      commonLufs: pair.commonLufs,
      originalGainDb: pair.originalGainDb,
      masterGainDb: pair.masterGainDb,
    };
  }
  return master;
};

const mfListenPreviousInvalidateRenderedMaster = invalidateRenderedMaster;
invalidateRenderedMaster = function invalidateCriticalListeningMaster(...args) {
  state.originalLevelMatched = null;
  state.masterLevelMatched = null;
  state.masterLevelMatch = null;
  return mfListenPreviousInvalidateRenderedMaster(...args);
};

const mfListenPreviousPrepareMastering = prepareMastering;
prepareMastering = function prepareCriticalListeningMaster(...args) {
  state.originalLevelMatched = null;
  state.masterLevelMatched = null;
  state.masterLevelMatch = null;
  return mfListenPreviousPrepareMastering(...args);
};

const mfListenPreviousCurrentPreviewBuffer = currentPreviewBuffer;
currentPreviewBuffer = function currentCriticalPreviewBuffer() {
  const selected = document.querySelector('input[name="preview"]:checked')?.value;
  if (selected === 'matchedOriginal') return state.originalLevelMatched || state.original;
  if (selected === 'matched') return state.masterLevelMatched || state.master;
  return mfListenPreviousCurrentPreviewBuffer();
};

const mfListenPreviousVerification = renderVerification;
renderVerification = function renderCriticalListeningVerification(metrics, plan) {
  mfListenPreviousVerification(metrics, plan);
  const root = $('verificationList');
  for (const row of root.querySelectorAll('.check')) {
    if ((row.textContent || '').includes('Estimated true peak:')) row.remove();
  }
  const change = state.masterChange;
  if (!change) return;
  const aligned = Math.abs(change.alignmentMs) <= 25 && change.alignmentCorrelation > 0.75;
  const row = document.createElement('div');
  row.className = `check ${aligned ? '' : 'warn'}`;
  const common = Number.isFinite(change.commonLufs) ? `${change.commonLufs.toFixed(1)} LUFS common level` : 'common level unavailable';
  row.innerHTML = `<b>${aligned ? '✓' : '!'}</b><div><strong>Level-matched null alignment: </strong>Original ${change.originalMatchDb.toFixed(1)} dB · Master ${change.masterMatchDb.toFixed(1)} dB → ${common} · ${change.alignmentMs.toFixed(2)} ms alignment · ${change.alignmentCorrelation.toFixed(3)} correlation. Neither side is boosted for the comparison.</div>`;
  root.append(row);
};

const mfListenPreviousEncodeWav = encodeWav;
encodeWav = async function encodeWavMasteringGrade(buffer, bitDepth, onProgress) {
  if (![16, 24].includes(bitDepth)) return mfListenPreviousEncodeWav(buffer, bitDepth, onProgress);
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const sampleRate = buffer.sampleRate;
  const bytesPerSample = bitDepth / 8;
  const dataSize = length * channels * bytesPerSample;
  if (!Number.isSafeInteger(dataSize) || dataSize > 0xffffffff - 36) {
    throw new Error('This WAV would exceed the classic RIFF 4 GB limit. Export a shorter file or use a desktop RF64 renderer.');
  }

  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const channelData = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
  const quantizationScale = Math.pow(2, bitDepth - 1);
  const ditherScale = 1 / quantizationScale;
  const chunk = 131072;
  let offset = 44;
  for (let start = 0; start < length; start += chunk) {
    const end = Math.min(length, start + chunk);
    for (let index = start; index < end; index++) {
      for (let channel = 0; channel < channels; channel++) {
        const tpdf = (Math.random() - Math.random()) * ditherScale;
        const sample = clamp(channelData[channel][index] + tpdf, -1, 1);
        if (bitDepth === 24) {
          let value = Math.round(sample < 0 ? sample * 0x800000 : sample * 0x7fffff);
          if (value < 0) value += 0x1000000;
          view.setUint8(offset++, value & 0xff);
          view.setUint8(offset++, (value >> 8) & 0xff);
          view.setUint8(offset++, (value >> 16) & 0xff);
        } else {
          view.setInt16(offset, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true);
          offset += 2;
        }
      }
    }
    onProgress?.(Math.round(end / length * 100));
    await sleep(0);
  }
  return new Blob([arrayBuffer], { type: 'audio/wav' });
};

function mfInstallCriticalListeningUI() {
  const previewSelect = document.querySelector('.preview-select');
  if (!previewSelect) return;
  if (!$('mfMatchedOriginalPreview')) {
    const label = document.createElement('label');
    label.innerHTML = '<input id="mfMatchedOriginalPreview" type="radio" name="preview" value="matchedOriginal"> Original · loudness matched';
    previewSelect.append(label);
  }
  if (!$('mfMatchedPreview')) {
    const label = document.createElement('label');
    label.innerHTML = '<input id="mfMatchedPreview" type="radio" name="preview" value="matched"> Master · loudness matched';
    previewSelect.append(label);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mfInstallCriticalListeningUI);
else mfInstallCriticalListeningUI();
