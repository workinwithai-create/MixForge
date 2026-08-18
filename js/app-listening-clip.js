'use strict';

// MixForge 2.5 compact listening clip.
// Gemini generateContent accepts inline audio/wav (see Gemini audio docs).
// Total request must stay well under the 20 MB inline cap and Vercel body limits.
// Do not send a full 24-bit master. Gemini folds channels to mono, so we send
// a mono excerpt and keep stereo facts in the measured JSON.

const MF_LISTEN_TARGET_RATE = 22050;
const MF_LISTEN_MAX_SECONDS = 20;
const MF_LISTEN_WINDOW_SECONDS = 6;
const MF_LISTEN_MAX_BASE64 = 3200000;

function mfListenClamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mfCreateScratchBuffer(channels, length, sampleRate) {
  if (typeof state !== 'undefined' && state.audioCtx?.createBuffer) {
    return state.audioCtx.createBuffer(channels, length, sampleRate);
  }
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  return {
    numberOfChannels: channels,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: (channel) => data[channel],
    copyToChannel: (source, channel) => { data[channel].set(source); },
  };
}

function mfWindowStats(buffer, startSec, endSec) {
  const sampleRate = buffer.sampleRate || 44100;
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const start = mfListenClamp(Math.floor(startSec * sampleRate), 0, buffer.length - 1);
  const end = mfListenClamp(Math.floor(endSec * sampleRate), start + 1, buffer.length);
  const step = Math.max(1, Math.floor((end - start) / 8000));
  let peak = 0;
  let sum = 0;
  let clips = 0;
  let cross = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  let count = 0;
  for (let index = start; index < end; index += step) {
    const l = left[index] || 0;
    const r = right[index] || 0;
    const framePeak = Math.max(Math.abs(l), Math.abs(r));
    peak = Math.max(peak, framePeak);
    sum += (l * l + r * r) * 0.5;
    leftEnergy += l * l;
    rightEnergy += r * r;
    cross += l * r;
    if (framePeak >= 0.999) clips += 1;
    count += 1;
  }
  const denom = Math.sqrt(Math.max(1e-20, leftEnergy * rightEnergy));
  return {
    peak,
    rms: Math.sqrt(sum / Math.max(1, count)),
    clips,
    correlation: denom > 1e-12 ? cross / denom : 1,
  };
}

function mfMergeListenWindows(windows, duration, maxSeconds) {
  const sorted = [...windows]
    .filter((window) => Number.isFinite(window.start) && Number.isFinite(window.end) && window.end > window.start)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const window of sorted) {
    const start = mfListenClamp(window.start, 0, Math.max(0, duration - 0.25));
    const end = mfListenClamp(window.end, start + 0.25, duration);
    const last = merged[merged.length - 1];
    if (last && start <= last.end + 0.35) {
      last.end = Math.max(last.end, end);
      if (window.reason && last.reason !== window.reason) last.reason = `${last.reason}+${window.reason}`;
    } else {
      merged.push({ start, end, reason: window.reason || 'excerpt' });
    }
  }
  let total = merged.reduce((sum, window) => sum + (window.end - window.start), 0);
  while (merged.length && total > maxSeconds) {
    const extra = total - maxSeconds;
    const last = merged[merged.length - 1];
    const span = last.end - last.start;
    if (span <= extra + 0.3) {
      merged.pop();
      total -= span;
    } else {
      last.end -= extra;
      total -= extra;
    }
  }
  return merged;
}

function pickListeningWindows(buffer, options = {}) {
  const duration = Number(buffer.duration) || buffer.length / Math.max(1, buffer.sampleRate || 44100);
  if (!duration || duration <= 0) return [];
  const hinted = Array.isArray(options.markers) ? options.markers : [];
  const fromMarkers = hinted.slice(0, 4).map((marker) => {
    const center = ((Number(marker.start) || 0) + (Number(marker.end) || 0)) / 2;
    const half = MF_LISTEN_WINDOW_SECONDS / 2;
    return {
      start: mfListenClamp(center - half, 0, duration),
      end: mfListenClamp(center + half, 0, duration),
      reason: String(marker.type || marker.reason || 'problem-window'),
    };
  });
  if (fromMarkers.length) return mfMergeListenWindows(fromMarkers, duration, MF_LISTEN_MAX_SECONDS);

  const hop = Math.min(2.5, Math.max(1.2, duration / 24));
  const win = Math.min(MF_LISTEN_WINDOW_SECONDS, Math.max(3, duration / 4));
  const scored = [];
  for (let start = 0; start < duration; start += hop) {
    const end = Math.min(duration, start + win);
    scored.push({ start, end, ...mfWindowStats(buffer, start, end) });
  }
  if (!scored.length) return [{ start: 0, end: Math.min(duration, MF_LISTEN_MAX_SECONDS), reason: 'full-excerpt' }];

  const loudest = [...scored].sort((a, b) => b.rms - a.rms)[0];
  const clippiest = [...scored].sort((a, b) => b.clips - a.clips || b.peak - a.peak)[0];
  const riskiestStereo = [...scored].sort((a, b) => a.correlation - b.correlation)[0];
  const section = scored[Math.floor(scored.length / 3)] || loudest;
  const chosen = [];
  const add = (window, reason) => {
    if (!window) return;
    if (chosen.some((item) => Math.abs(item.start - window.start) < 0.5)) return;
    chosen.push({ start: window.start, end: window.end, reason });
  };
  add(loudest, 'loudest');
  if (clippiest && clippiest.clips > 0) add(clippiest, 'clip-risk');
  if (riskiestStereo && riskiestStereo.correlation < 0.2) add(riskiestStereo, 'stereo-risk');
  add(section, 'section');
  return mfMergeListenWindows(chosen, duration, MF_LISTEN_MAX_SECONDS);
}

function mfReadMonoSample(buffer, sourceIndex) {
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const i0 = mfListenClamp(Math.floor(sourceIndex), 0, buffer.length - 1);
  const i1 = Math.min(buffer.length - 1, i0 + 1);
  const frac = sourceIndex - i0;
  const a = ((left[i0] || 0) + (right[i0] || 0)) * 0.5;
  const b = ((left[i1] || 0) + (right[i1] || 0)) * 0.5;
  return a + (b - a) * frac;
}

function mfRenderListeningMono(buffer, windows, targetRate) {
  const sourceRate = buffer.sampleRate || targetRate;
  const ratio = sourceRate / targetRate;
  const gapSamples = Math.round(targetRate * 0.08);
  let total = 0;
  const spans = windows.map((window) => {
    const start = Math.floor(window.start * sourceRate);
    const end = Math.min(buffer.length, Math.floor(window.end * sourceRate));
    const outLength = Math.max(1, Math.floor((end - start) / ratio));
    const span = { start, outLength, reason: window.reason };
    total += outLength + gapSamples;
    return span;
  });
  const out = mfCreateScratchBuffer(1, Math.max(1, total - gapSamples), targetRate);
  const dest = out.getChannelData(0);
  let write = 0;
  for (const span of spans) {
    for (let index = 0; index < span.outLength && write < dest.length; index += 1) {
      dest[write] = mfReadMonoSample(buffer, span.start + index * ratio);
      write += 1;
    }
    write = Math.min(dest.length, write + gapSamples);
  }
  return out;
}

function encodePcm16Wav(buffer) {
  const channels = 1;
  const length = buffer.length;
  const sampleRate = buffer.sampleRate;
  const dataSize = length * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);
  const samples = buffer.getChannelData(0);
  let offset = 44;
  for (let index = 0; index < length; index += 1) {
    const sample = mfListenClamp(samples[index] || 0, -1, 1);
    view.setInt16(offset, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true);
    offset += 2;
  }
  return bytes;
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function buildListeningClip(buffer, options = {}) {
  if (!buffer?.length || !buffer.sampleRate) {
    throw new Error('No decoded mix is available for the listening excerpt.');
  }
  const windows = pickListeningWindows(buffer, options);
  if (!windows.length) throw new Error('Could not choose listening windows.');
  const rendered = mfRenderListeningMono(buffer, windows, MF_LISTEN_TARGET_RATE);
  const wav = encodePcm16Wav(rendered);
  const data = bytesToBase64(wav);
  if (!data || data.length > MF_LISTEN_MAX_BASE64) {
    throw new Error('Listening excerpt exceeded the compact inline-audio budget.');
  }
  return {
    mimeType: 'audio/wav',
    data,
    sampleRate: rendered.sampleRate,
    channels: 1,
    durationSec: Number((rendered.length / rendered.sampleRate).toFixed(2)),
    byteLength: wav.length,
    windows: windows.map((window) => ({
      start: Number(window.start.toFixed(2)),
      end: Number(window.end.toFixed(2)),
      reason: window.reason,
    })),
  };
}

if (typeof globalThis !== 'undefined') {
  globalThis.pickListeningWindows = pickListeningWindows;
  globalThis.buildListeningClip = buildListeningClip;
  globalThis.encodePcm16Wav = encodePcm16Wav;
  globalThis.MF_LISTEN_MAX_SECONDS = MF_LISTEN_MAX_SECONDS;
}
