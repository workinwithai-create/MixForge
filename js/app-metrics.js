'use strict';
function kWeightCoefs(fs) {
  const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  const K = Math.tan(Math.PI * f0 / fs), Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = { b0: (Vh + Vb * K / Q + K * K) / a0, b1: 2 * (K * K - Vh) / a0, b2: (Vh - Vb * K / Q + K * K) / a0, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
  const f1 = 38.13547087602444, Q1 = 0.5003270373238773, K1 = Math.tan(Math.PI * f1 / fs);
  a0 = 1 + K1 / Q1 + K1 * K1;
  const hp = { b0: 1 / a0, b1: -2 / a0, b2: 1 / a0, a1: 2 * (K1 * K1 - 1) / a0, a2: (1 - K1 / Q1 + K1 * K1) / a0 };
  return { shelf, hp };
}

function biquadSample(x, c, state) {
  const y = c.b0 * x + c.b1 * state.x1 + c.b2 * state.x2 - c.a1 * state.y1 - c.a2 * state.y2;
  state.x2 = state.x1; state.x1 = x; state.y2 = state.y1; state.y1 = y;
  return y;
}

function measureLUFS(buffer) {
  const { shelf, hp } = kWeightCoefs(buffer.sampleRate);
  const channelCount = Math.min(buffer.numberOfChannels, 2);
  const channels = Array.from({ length: channelCount }, (_, c) => buffer.getChannelData(c));
  const states = Array.from({ length: channelCount }, () => ({ shelf: { x1: 0, x2: 0, y1: 0, y2: 0 }, hp: { x1: 0, x2: 0, y1: 0, y2: 0 } }));
  const block = Math.max(1, Math.floor(0.4 * buffer.sampleRate));
  const hop = Math.max(1, Math.floor(0.1 * buffer.sampleRate));
  const rings = Array.from({ length: channelCount }, () => new Float64Array(block));
  const sums = new Float64Array(channelCount);
  const loudness = [];
  for (let i = 0; i < buffer.length; i++) {
    const ringIndex = i % block;
    for (let c = 0; c < channelCount; c++) {
      const weighted = biquadSample(biquadSample(channels[c][i], shelf, states[c].shelf), hp, states[c].hp);
      const squared = weighted * weighted;
      sums[c] += squared - rings[c][ringIndex];
      rings[c][ringIndex] = squared;
    }
    if (i + 1 >= block && (i + 1 - block) % hop === 0) {
      let power = 0;
      for (let c = 0; c < channelCount; c++) power += sums[c] / block;
      loudness.push(-0.691 + 10 * Math.log10(power + 1e-12));
    }
  }
  let gated = loudness.filter((value) => value > -70);
  if (!gated.length) return -70;
  const powerAverage = (values) => 10 * Math.log10(values.reduce((acc, value) => acc + Math.pow(10, (value + 0.691) / 10), 0) / values.length) - 0.691;
  const relativeGate = powerAverage(gated) - 10;
  gated = gated.filter((value) => value > relativeGate);
  return gated.length ? powerAverage(gated) : -70;
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = -2 * Math.PI / len, wr = Math.cos(angle), wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nextCr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nextCr;
      }
    }
  }
}

function spectralScanChannels(left, right, sampleRate, mode) {
  const N = 2048, snapshots = 140;
  const maxStart = Math.max(0, left.length - N - 1);
  const step = Math.max(1, Math.floor(maxStart / snapshots));
  const accumulation = new Float64Array(N / 2);
  const hann = new Float32Array(N);
  for (let i = 0; i < N; i++) hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
  const bin = (hz) => clamp(Math.round(hz * N / sampleRate), 1, N / 2 - 1);
  const sib0 = bin(5500), sib1 = bin(9000), body0 = bin(300), body1 = bin(4000);
  const sibRatios = [];
  let count = 0;
  for (let start = 0; start + N < left.length; start += step) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const l = left[start + i], r = right[start + i];
      re[i] = (mode === 'side' ? (l - r) * 0.5 : (l + r) * 0.5) * hann[i];
    }
    fft(re, im);
    let sib = 0, body = 0;
    for (let k = 0; k < N / 2; k++) {
      const power = re[k] * re[k] + im[k] * im[k];
      accumulation[k] += power;
      if (k >= sib0 && k <= sib1) sib += power;
      if (k >= body0 && k <= body1) body += power;
    }
    if (body > 1e-12) sibRatios.push(10 * Math.log10(sib / body + 1e-12));
    count++;
    if (count >= snapshots + 1) break;
  }
  const bands = BANDS.map((band) => {
    const lo = bin(band.lo), hi = bin(band.hi);
    let energy = 0;
    for (let k = lo; k <= hi; k++) energy += accumulation[k];
    return { ...band, db: 10 * Math.log10(energy / Math.max(1, (hi - lo + 1) * count) + 1e-12) };
  });
  const sorted = [...sibRatios].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? -60;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? median;
  const flares = sibRatios.filter((value) => value > median + 8).length;
  return { bands, sibilance: { medianDb: median, p95Db: p95, flares, frames: sibRatios.length } };
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(clamp(p, 0, 1) * (sorted.length - 1))];
}

function measureBuffer(buffer) {
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const length = Math.min(left.length, right.length);
  let peak = 0, sum = 0, dc = 0, clips = 0, lr = 0, ll = 0, rr = 0, midEnergy = 0, sideEnergy = 0;
  const block = Math.max(1, Math.floor(buffer.sampleRate * 3));
  let blockSum = 0, blockCount = 0;
  const blockLevels = [];
  for (let i = 0; i < length; i++) {
    const l = left[i], r = right[i], mid = (l + r) * 0.5, side = (l - r) * 0.5;
    const framePeak = Math.max(Math.abs(l), Math.abs(r));
    peak = Math.max(peak, framePeak);
    if (framePeak >= 0.999) clips++;
    sum += (l * l + r * r) * 0.5; dc += mid; lr += l * r; ll += l * l; rr += r * r;
    midEnergy += mid * mid; sideEnergy += side * side;
    blockSum += mid * mid; blockCount++;
    if (blockCount === block) {
      blockLevels.push(gainToDb(Math.sqrt(blockSum / blockCount)));
      blockSum = 0; blockCount = 0;
    }
  }
  const rms = Math.sqrt(sum / Math.max(1, length));
  const peakDb = gainToDb(peak), rmsDb = gainToDb(rms);
  const correlation = Math.sqrt(ll * rr) > 1e-12 ? lr / Math.sqrt(ll * rr) : 1;
  const widthDb = 10 * Math.log10((sideEnergy + 1e-12) / (midEnergy + 1e-12));
  const midScan = spectralScanChannels(left, right, buffer.sampleRate, 'mid');
  const sideScan = spectralScanChannels(left, right, buffer.sampleRate, 'side');
  const lra = blockLevels.length >= 3 ? percentile(blockLevels, 0.95) - percentile(blockLevels, 0.1) : Math.max(0, peakDb - rmsDb - 4);
  return {
    lufs: measureLUFS(buffer), peakDb, rmsDb, crestDb: peakDb - rmsDb, lra, correlation, widthDb,
    dcOffset: dc / Math.max(1, length), clipPercent: clips / Math.max(1, length) * 100,
    duration: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels,
    midBands: midScan.bands, sideBands: sideScan.bands, sibilance: midScan.sibilance,
  };
}

function band(metrics, name, side = false) {
  return (side ? metrics.sideBands : metrics.midBands).find((item) => item.name === name)?.db ?? -120;
}
