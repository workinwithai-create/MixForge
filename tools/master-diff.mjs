#!/usr/bin/env node
// MixForge master-diff: black-box benchmarking of mastering services.
//
// Feed it an original mix and the master a service (LANDR, eMastered, Ozone,
// MixForge itself, ...) returned for it. It aligns the two files and measures
// what the service actually did: loudness target, true-peak ceiling, the
// effective EQ curve (mid and side), stereo width changes, per-band
// compression slopes, and level-dependent gain reduction.
//
// It only looks at audio you legitimately have. Nothing here touches a
// service's code.
//
// Usage:
//   node tools/master-diff.mjs original.wav master.wav [--label "LANDR warm/high"] [--json out.json]
//   node tools/master-diff.mjs --manifest pairs.json [--json out.json]
//
// pairs.json: [{ "service": "LANDR", "track": "song-a", "original": "a.wav", "master": "a-landr.wav" }, ...]
// Paths in a manifest are resolved relative to the manifest file.
// Inputs must be WAV (16/24/32-bit PCM or 32/64-bit float). Convert MP3s first:
//   ffmpeg -i master.mp3 -c:a pcm_f32le master.wav

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- WAV ----------

export function decodeWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a RIFF/WAVE file');
  let format = null;
  let dataOffset = -1;
  let dataLength = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      let code = view.getUint16(body, true);
      if (code === 0xfffe && size >= 26) code = view.getUint16(body + 24, true);
      format = {
        code,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = Math.min(size, bytes.length - body);
    }
    offset = body + size + (size & 1);
  }
  if (!format || dataOffset < 0) throw new Error('WAV is missing fmt or data chunk');
  const { code, channels, sampleRate, bits } = format;
  const bytesPerSample = bits / 8;
  const frames = Math.floor(dataLength / (bytesPerSample * channels));
  const read = (() => {
    if (code === 3 && bits === 32) return (at) => view.getFloat32(at, true);
    if (code === 3 && bits === 64) return (at) => view.getFloat64(at, true);
    if (code === 1 && bits === 16) return (at) => view.getInt16(at, true) / 32768;
    if (code === 1 && bits === 24) return (at) => ((view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16))) / 8388608;
    if (code === 1 && bits === 32) return (at) => view.getInt32(at, true) / 2147483648;
    throw new Error(`Unsupported WAV format (code ${code}, ${bits}-bit). Convert with: ffmpeg -i in -c:a pcm_f32le out.wav`);
  })();
  const out = [new Float32Array(frames), new Float32Array(frames)];
  for (let frame = 0; frame < frames; frame++) {
    const base = dataOffset + frame * channels * bytesPerSample;
    const left = read(base);
    out[0][frame] = left;
    out[1][frame] = channels > 1 ? read(base + bytesPerSample) : left;
  }
  return { sampleRate, channels: out, length: frames };
}

export function encodeWavFloat(channels, sampleRate) {
  const frames = channels[0].length;
  const bytes = new Uint8Array(44 + frames * 8);
  const view = new DataView(bytes.buffer);
  const write = (offset, text) => { for (let i = 0; i < 4; i++) bytes[offset + i] = text.charCodeAt(i); };
  write(0, 'RIFF'); view.setUint32(4, 36 + frames * 8, true); write(8, 'WAVE');
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 8, true); view.setUint16(32, 8, true); view.setUint16(34, 32, true);
  write(36, 'data'); view.setUint32(40, frames * 8, true);
  for (let i = 0; i < frames; i++) {
    view.setFloat32(44 + i * 8, channels[0][i], true);
    view.setFloat32(48 + i * 8, channels[1][i], true);
  }
  return bytes;
}

// ---------- helpers ----------

const db = (power) => 10 * Math.log10(Math.max(power, 1e-20));
const ampDb = (amplitude) => 20 * Math.log10(Math.max(amplitude, 1e-10));
const percentile = (values, p) => {
  if (!values.length) return NaN;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
};
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
function slope(xs, ys) {
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den > 0 ? num / den : NaN;
}

// ---------- loudness (BS.1770 / EBU R128 style) ----------

function kWeighting(fs) {
  const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  const K = Math.tan(Math.PI * f0 / fs), Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  const f1 = 38.13547087602444, Q1 = 0.5003270373238773, K1 = Math.tan(Math.PI * f1 / fs);
  a0 = 1 + K1 / Q1 + K1 * K1;
  const hp = [1 / a0, -2 / a0, 1 / a0, 2 * (K1 * K1 - 1) / a0, (1 - K1 / Q1 + K1 * K1) / a0];
  return [shelf, hp];
}

function biquad(input, [b0, b1, b2, a1, a2]) {
  const out = new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y; out[i] = y;
  }
  return out;
}

export function loudness(audio) {
  const [shelf, hp] = kWeighting(audio.sampleRate);
  const weighted = audio.channels.map((data) => biquad(biquad(data, shelf), hp));
  const blockLoudness = (seconds, hopSeconds) => {
    const size = Math.round(seconds * audio.sampleRate);
    const hop = Math.round(hopSeconds * audio.sampleRate);
    const blocks = [];
    for (let start = 0; start + size <= audio.length; start += hop) {
      let power = 0;
      for (const data of weighted) for (let i = start; i < start + size; i++) power += data[i] * data[i];
      blocks.push(-0.691 + db(power / size));
    }
    return blocks;
  };
  const powerMean = (values) => -0.691 + db(mean(values.map((v) => 10 ** ((v + 0.691) / 10))));
  const momentary = blockLoudness(0.4, 0.1).filter((v) => v > -70);
  const ungated = momentary.length ? powerMean(momentary) : -70;
  const gated = momentary.filter((v) => v > ungated - 10);
  const integrated = gated.length ? powerMean(gated) : -70;
  const shortTerm = blockLoudness(3, 1).filter((v) => v > Math.max(-70, integrated - 20));
  const lra = shortTerm.length >= 2 ? percentile(shortTerm, 0.95) - percentile(shortTerm, 0.10) : 0;
  return { integrated, lra, shortTermMax: shortTerm.length ? Math.max(...shortTerm) : integrated };
}

// 4x oversampled peak, same kernel family as the MixForge limiter. An estimate,
// not a certified meter.
const OS_TAPS = (() => {
  const phases = [];
  for (let phase = 1; phase < 4; phase++) {
    const taps = new Float64Array(16);
    let sum = 0;
    for (let tap = 0; tap < 16; tap++) {
      const x = phase / 4 - (tap - 7);
      const sinc = Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      taps[tap] = sinc * (0.42 + 0.5 * Math.cos(Math.PI * x / 8) + 0.08 * Math.cos(Math.PI * x / 4));
      sum += taps[tap];
    }
    phases.push(taps.map((value) => value / sum));
  }
  return phases;
})();

export function peaks(audio) {
  let sample = 0, truePeak = 0;
  for (const data of audio.channels) {
    for (let i = 0; i < data.length; i++) {
      const value = Math.abs(data[i]);
      if (value > sample) sample = value;
      if (value > truePeak) truePeak = value;
      if (i < 7 || i + 9 > data.length || Math.max(value, Math.abs(data[i + 1])) < truePeak * 0.5) continue;
      for (const taps of OS_TAPS) {
        let acc = 0;
        for (let tap = 0; tap < 16; tap++) acc += taps[tap] * data[i - 7 + tap];
        if (Math.abs(acc) > truePeak) truePeak = Math.abs(acc);
      }
    }
  }
  return { samplePeakDb: ampDb(sample), truePeakDb: ampDb(truePeak) };
}

// ---------- spectrum ----------

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = -2 * Math.PI / size;
    const wr = Math.cos(angle), wi = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let cr = 1, ci = 0;
      for (let k = 0; k < size / 2; k++) {
        const a = start + k, b = a + size / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

export const THIRD_OCTAVES = [25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000];
export const DYNAMIC_BANDS = [
  { name: 'Sub/low (<120 Hz)', lo: 20, hi: 120 },
  { name: 'Low-mid (120-500 Hz)', lo: 120, hi: 500 },
  { name: 'Mid (500 Hz-4 kHz)', lo: 500, hi: 4000 },
  { name: 'High (>4 kHz)', lo: 4000, hi: 20000 },
];

// Short-time band powers for mid (L+R)/2 and side (L-R)/2.
function spectralFrames(audio, size = 8192) {
  const hop = size / 2;
  const window = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size));
  const binHz = audio.sampleRate / size;
  const toBins = (lo, hi) => [Math.max(1, Math.ceil(lo / binHz)), Math.min(size / 2, Math.floor(hi / binHz))];
  const thirdBins = THIRD_OCTAVES.map((f) => toBins(f * 2 ** (-1 / 6), f * 2 ** (1 / 6)));
  const dynBins = DYNAMIC_BANDS.map((b) => toBins(b.lo, Math.min(b.hi, audio.sampleRate / 2)));
  const [left, right] = audio.channels;
  const frames = [];
  const re = new Float64Array(size), im = new Float64Array(size), sre = new Float64Array(size), sim = new Float64Array(size);
  for (let start = 0; start + size <= audio.length; start += hop) {
    for (let i = 0; i < size; i++) {
      re[i] = (left[start + i] + right[start + i]) * 0.5 * window[i]; im[i] = 0;
      sre[i] = (left[start + i] - right[start + i]) * 0.5 * window[i]; sim[i] = 0;
    }
    fft(re, im); fft(sre, sim);
    const sum = (r, m, [lo, hi]) => { let p = 0; for (let k = lo; k <= hi; k++) p += r[k] * r[k] + m[k] * m[k]; return p / Math.max(1, hi - lo + 1); };
    frames.push({
      midThirds: thirdBins.map((bins) => sum(re, im, bins)),
      sideThirds: thirdBins.map((bins) => sum(sre, sim, bins)),
      midBands: dynBins.map((bins) => sum(re, im, bins)),
      sideBands: dynBins.map((bins) => sum(sre, sim, bins)),
    });
  }
  return frames;
}

// ---------- alignment ----------

// Returns lag such that master[n + lag] lines up with original[n].
export function findLag(original, master, maxSeconds = 2) {
  const mono = (audio) => { const out = new Float32Array(audio.length); for (let i = 0; i < audio.length; i++) out[i] = audio.channels[0][i] + audio.channels[1][i]; return out; };
  const a = mono(original), b = mono(master);
  const block = 64;
  const envelope = (data) => {
    const out = new Float64Array(Math.floor(Math.min(data.length, original.sampleRate * 90) / block));
    for (let i = 0; i < out.length; i++) { let s = 0; for (let j = 0; j < block; j++) s += Math.abs(data[i * block + j]); out[i] = s; }
    const m = mean(out); return out.map((v) => v - m);
  };
  const ea = envelope(a), eb = envelope(b);
  const maxLag = Math.ceil(maxSeconds * original.sampleRate / block);
  let bestCoarse = 0, bestScore = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = Math.max(0, -lag); i < ea.length && i + lag < eb.length; i++) s += ea[i] * eb[i + lag];
    if (s > bestScore) { bestScore = s; bestCoarse = lag; }
  }
  const centre = Math.floor(a.length / 2);
  const span = Math.min(original.sampleRate * 10, Math.floor(a.length / 3));
  let best = bestCoarse * block, bestFine = -Infinity;
  for (let lag = bestCoarse * block - block; lag <= bestCoarse * block + block; lag++) {
    let s = 0;
    for (let i = centre - span; i < centre + span; i++) {
      const j = i + lag;
      if (i >= 0 && j >= 0 && j < b.length) s += a[i] * b[j];
    }
    if (s > bestFine) { bestFine = s; best = lag; }
  }
  return best;
}

function overlap(original, master, lag) {
  const start = Math.max(0, -lag);
  const length = Math.min(original.length - start, master.length - (start + lag));
  const slice = (audio, from) => ({ sampleRate: audio.sampleRate, length, channels: audio.channels.map((d) => d.subarray(from, from + length)) });
  return [slice(original, start), slice(master, start + lag)];
}

// ---------- comparison ----------

function describe(audio) {
  const loud = loudness(audio);
  const peak = peaks(audio);
  let sum = 0, lr = 0, ll = 0, rr = 0;
  const [left, right] = audio.channels;
  for (let i = 0; i < audio.length; i++) {
    sum += left[i] * left[i] + right[i] * right[i];
    lr += left[i] * right[i]; ll += left[i] * left[i]; rr += right[i] * right[i];
  }
  const rmsDb = db(sum / (2 * Math.max(1, audio.length)));
  return {
    lufs: loud.integrated,
    lra: loud.lra,
    shortTermMaxLufs: loud.shortTermMax,
    ...peak,
    plr: peak.truePeakDb - loud.integrated,
    crestDb: peak.samplePeakDb - rmsDb,
    correlation: lr / Math.sqrt(Math.max(1e-20, ll * rr)),
  };
}

export function compare(originalAudio, masterAudio) {
  if (originalAudio.sampleRate !== masterAudio.sampleRate) {
    throw new Error(`Sample rates differ (${originalAudio.sampleRate} vs ${masterAudio.sampleRate}). Resample the master first: ffmpeg -i master.wav -ar ${originalAudio.sampleRate} -c:a pcm_f32le master-${originalAudio.sampleRate}.wav`);
  }
  const lag = findLag(originalAudio, masterAudio);
  const [original, master] = overlap(originalAudio, masterAudio, lag);
  const before = describe(original);
  const after = describe(master);
  const gain = after.lufs - before.lufs;

  const of = spectralFrames(original);
  const mf = spectralFrames(master);
  const avg = (frames, key, index) => mean(frames.map((f) => f[key][index]));
  const eq = THIRD_OCTAVES.map((hz, i) => ({
    hz,
    midDb: db(avg(mf, 'midThirds', i)) - db(avg(of, 'midThirds', i)) - gain,
    sideDb: db(avg(mf, 'sideThirds', i)) - db(avg(of, 'sideThirds', i)) - gain,
  }));
  const width = DYNAMIC_BANDS.map((band, i) => ({
    band: band.name,
    sideMinusMidBeforeDb: db(avg(of, 'sideBands', i)) - db(avg(of, 'midBands', i)),
    sideMinusMidAfterDb: db(avg(mf, 'sideBands', i)) - db(avg(mf, 'midBands', i)),
  })).map((row) => ({ ...row, widthChangeDb: row.sideMinusMidAfterDb - row.sideMinusMidBeforeDb }));

  // Per-band dynamics: regress master band level on original band level across
  // frames. Slope 1 = untouched, below 1 = compressed in that band.
  const dynamics = DYNAMIC_BANDS.map((band, i) => {
    const xs = of.map((f) => db(f.midBands[i]));
    const ys = mf.map((f) => db(f.midBands[i]));
    const top = percentile(xs, 0.98);
    const keep = xs.map((x) => x > top - 30);
    const fx = xs.filter((_, k) => keep[k]);
    const fy = ys.filter((_, k) => keep[k]);
    const s = slope(fx, fy);
    return { band: band.name, slope: s, effectiveRatio: s > 0 ? 1 / s : NaN, frames: fx.length };
  });

  // Level-dependent gain reduction on 10 ms blocks of the mid signal,
  // referenced to the gain applied in quieter passages.
  const blockSize = Math.round(original.sampleRate * 0.01);
  const levels = [];
  for (let start = 0; start + blockSize <= original.length; start += blockSize) {
    let po = 0, pm = 0;
    for (let i = start; i < start + blockSize; i++) {
      const o = original.channels[0][i] + original.channels[1][i];
      const m = master.channels[0][i] + master.channels[1][i];
      po += o * o; pm += m * m;
    }
    levels.push([db(po / blockSize), db(pm / blockSize)]);
  }
  const loudest = percentile(levels.map(([o]) => o), 0.99);
  const active = levels.filter(([o]) => o > loudest - 40);
  const activeLevels = active.map(([o]) => o);
  const lo = percentile(activeLevels, 0.2), mid = percentile(activeLevels, 0.5);
  const reference = percentile(active.filter(([o]) => o >= lo && o <= mid).map(([o, m]) => m - o), 0.5);
  const reduction = active.map(([o, m]) => reference - (m - o));
  const gainReduction = {
    medianDb: percentile(reduction, 0.5),
    p95Db: percentile(reduction, 0.95),
    maxDb: percentile(reduction, 0.999),
    percentAbove1Db: 100 * reduction.filter((r) => r > 1).length / Math.max(1, reduction.length),
    percentAbove3Db: 100 * reduction.filter((r) => r > 3).length / Math.max(1, reduction.length),
    broadbandSlope: slope(active.map(([o]) => o), active.map(([, m]) => m)),
  };

  return {
    alignment: { lagSamples: lag, lagMs: 1000 * lag / original.sampleRate, overlapSeconds: original.length / original.sampleRate },
    before,
    after,
    loudnessGainDb: gain,
    eq,
    width,
    dynamics,
    gainReduction,
  };
}

// ---------- reporting ----------

const f1 = (value) => (Number.isFinite(value) ? value.toFixed(1) : 'n/a');
const f2 = (value) => (Number.isFinite(value) ? value.toFixed(2) : 'n/a');
const signed = (value) => (Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(1)}` : 'n/a');

export function formatReport(label, result) {
  const { before, after } = result;
  const lines = [`## ${label}`, ''];
  lines.push(`Aligned at ${f1(result.alignment.lagMs)} ms offset · ${f1(result.alignment.overlapSeconds)} s compared`, '');
  lines.push('| Metric | Original | Master | Change |', '| --- | --- | --- | --- |');
  const row = (name, key, fmt = f1) => lines.push(`| ${name} | ${fmt(before[key])} | ${fmt(after[key])} | ${signed(after[key] - before[key])} |`);
  row('Integrated LUFS', 'lufs');
  row('True peak (dBTP, 4x est.)', 'truePeakDb', f2);
  row('Sample peak (dBFS)', 'samplePeakDb', f2);
  row('PLR (TP - LUFS)', 'plr');
  row('Crest factor (dB)', 'crestDb');
  row('LRA (LU)', 'lra');
  row('Stereo correlation', 'correlation', f2);
  lines.push('', '### Effective EQ (level-matched, dB)', '', '| Hz | Mid | Side |', '| --- | --- | --- |');
  for (const band of result.eq) lines.push(`| ${band.hz} | ${signed(band.midDb)} | ${signed(band.sideDb)} |`);
  lines.push('', '### Per-band dynamics', '', '| Band | Level slope | Effective ratio | Width change (side-mid, dB) |', '| --- | --- | --- | --- |');
  result.dynamics.forEach((band, i) => lines.push(`| ${band.band} | ${f2(band.slope)} | ${f1(band.effectiveRatio)}:1 | ${signed(result.width[i].widthChangeDb)} |`));
  const gr = result.gainReduction;
  lines.push('', '### Level-dependent gain reduction (compression + limiting, 10 ms blocks)', '');
  lines.push(`Median ${f1(gr.medianDb)} dB · 95th pct ${f1(gr.p95Db)} dB · max ${f1(gr.maxDb)} dB · >1 dB ${f1(gr.percentAbove1Db)}% of the time · >3 dB ${f1(gr.percentAbove3Db)}% · broadband level slope ${f2(gr.broadbandSlope)}`);
  lines.push('');
  return lines.join('\n');
}

function averageProfiles(results) {
  const avgOf = (pick) => mean(results.map(pick).filter(Number.isFinite));
  return {
    tracks: results.length,
    lufs: avgOf((r) => r.after.lufs),
    truePeakDb: avgOf((r) => r.after.truePeakDb),
    plr: avgOf((r) => r.after.plr),
    lraChange: avgOf((r) => r.after.lra - r.before.lra),
    crestChange: avgOf((r) => r.after.crestDb - r.before.crestDb),
    eq: THIRD_OCTAVES.map((hz, i) => ({ hz, midDb: avgOf((r) => r.eq[i].midDb), sideDb: avgOf((r) => r.eq[i].sideDb) })),
    dynamics: DYNAMIC_BANDS.map((band, i) => ({ band: band.name, slope: avgOf((r) => r.dynamics[i].slope), widthChangeDb: avgOf((r) => r.width[i].widthChangeDb) })),
    gainReductionP95Db: avgOf((r) => r.gainReduction.p95Db),
  };
}

export function formatProfiles(profiles) {
  const names = Object.keys(profiles);
  const lines = ['# Service profiles (averaged over tracks)', ''];
  lines.push(`| Metric | ${names.join(' | ')} |`, `| --- |${names.map(() => ' --- |').join('')}`);
  const row = (label, pick, fmt = f1) => lines.push(`| ${label} | ${names.map((n) => fmt(pick(profiles[n]))).join(' | ')} |`);
  row('Tracks', (p) => p.tracks, String);
  row('Output LUFS', (p) => p.lufs);
  row('Output true peak (dBTP)', (p) => p.truePeakDb, f2);
  row('Output PLR', (p) => p.plr);
  row('LRA change (LU)', (p) => p.lraChange, signed);
  row('Crest change (dB)', (p) => p.crestChange, signed);
  row('Gain reduction p95 (dB)', (p) => p.gainReductionP95Db);
  DYNAMIC_BANDS.forEach((band, i) => row(`${band.name} slope`, (p) => p.dynamics[i].slope, f2));
  DYNAMIC_BANDS.forEach((band, i) => row(`${band.name} width change`, (p) => p.dynamics[i].widthChangeDb, signed));
  lines.push('', '## Average effective EQ, mid (dB)', '', `| Hz | ${names.join(' | ')} |`, `| --- |${names.map(() => ' --- |').join('')}`);
  THIRD_OCTAVES.forEach((hz, i) => lines.push(`| ${hz} | ${names.map((n) => signed(profiles[n].eq[i].midDb)).join(' | ')} |`));
  lines.push('');
  return lines.join('\n');
}

// ---------- CLI ----------

function readAudio(file) {
  return decodeWav(fs.readFileSync(file));
}

function main(argv) {
  const args = [...argv];
  const take = (flag) => { const i = args.indexOf(flag); if (i < 0) return null; const [, value] = args.splice(i, 2); return value; };
  const jsonOut = take('--json');
  const manifest = take('--manifest');
  const label = take('--label');
  const output = {};
  if (manifest) {
    const dir = path.dirname(path.resolve(manifest));
    const pairs = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const byService = {};
    const reports = [];
    for (const pair of pairs) {
      const name = `${pair.service} · ${pair.track}`;
      process.stderr.write(`Comparing ${name}…\n`);
      const result = compare(readAudio(path.resolve(dir, pair.original)), readAudio(path.resolve(dir, pair.master)));
      (byService[pair.service] ||= []).push(result);
      reports.push(formatReport(name, result));
      output[name] = result;
    }
    const profiles = Object.fromEntries(Object.entries(byService).map(([service, results]) => [service, averageProfiles(results)]));
    output.profiles = profiles;
    process.stdout.write(`${formatProfiles(profiles)}\n${reports.join('\n')}`);
  } else {
    if (args.length !== 2) {
      process.stderr.write('Usage: node tools/master-diff.mjs original.wav master.wav [--label name] [--json out.json]\n       node tools/master-diff.mjs --manifest pairs.json [--json out.json]\n');
      process.exit(2);
    }
    const result = compare(readAudio(args[0]), readAudio(args[1]));
    output.result = result;
    process.stdout.write(formatReport(label || path.basename(args[1]), result));
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(output, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv.slice(2));
