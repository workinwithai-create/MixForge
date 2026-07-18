'use strict';

// MixForge 2.1 critical-listening layer.
// Provides level-matched comparisons and an aligned null monitor so "better"
// cannot simply mean "louder" and latency does not masquerade as processing.

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

mfBuildDifferenceMonitor = async function mfBuildAlignedDifferenceMonitor(original, master) {
  if (!original || !master) return { buffer: null, metrics: null };
  const ctx = await ensureAudioContext(false);
  const alignment = mfListenFindAlignment(original, master);
  const channels = Math.max(1, Math.min(original.numberOfChannels, master.numberOfChannels));
  const length = Math.min(original.length, master.length);
  const output = ctx.createBuffer(channels, length, master.sampleRate);
  const originalMetrics = measureBuffer(original);
  const masterMetrics = measureBuffer(master);
  const levelMatchDb = clamp(masterMetrics.lufs - originalMetrics.lufs, -18, 18);
  const originalGain = dbToGain(levelMatchDb);
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
        const change = after[masterIndex] - matchedOriginal;
        delta[masterIndex] = change;
        referenceEnergy += after[masterIndex] * after[masterIndex];
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
      levelMatchDb,
    },
  };
};

const mfListenPreviousCurrentPreviewBuffer = currentPreviewBuffer;
currentPreviewBuffer = function currentCriticalPreviewBuffer() {
  const selected = document.querySelector('input[name="preview"]:checked')?.value;
  if (selected === 'matched') return state.masterLevelMatched || state.master;
  return mfListenPreviousCurrentPreviewBuffer();
};

const mfListenPreviousVerification = renderVerification;
renderVerification = function renderCriticalListeningVerification(metrics, plan) {
  mfListenPreviousVerification(metrics, plan);
  const change = state.masterChange;
  if (!change) return;
  const root = $('verificationList');
  const aligned = Math.abs(change.alignmentMs) <= 25 && change.alignmentCorrelation > 0.75;
  const row = document.createElement('div');
  row.className = `check ${aligned ? '' : 'warn'}`;
  row.innerHTML = `<b>${aligned ? '✓' : '!'}</b><div><strong>Level-matched null alignment: </strong>${change.levelMatchDb >= 0 ? '+' : ''}${change.levelMatchDb.toFixed(1)} dB source match · ${change.alignmentMs.toFixed(2)} ms alignment · ${change.alignmentCorrelation.toFixed(3)} correlation.</div>`;
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
  if (previewSelect && !$('mfMatchedPreview')) {
    const label = document.createElement('label');
    label.innerHTML = '<input id="mfMatchedPreview" type="radio" name="preview" value="matched"> Master · loudness matched';
    previewSelect.append(label);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mfInstallCriticalListeningUI);
else mfInstallCriticalListeningUI();
