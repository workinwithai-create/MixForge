'use strict';

// MixForge 2.8 multiband dynamics layer.
// Loads after the mastering-grade layer. Splits the master into four bands
// with Linkwitz-Riley crossovers, measures each band's own dynamics, and only
// compresses bands that actually surge. Each engaged band gets make-up gain
// equal to its measured average reduction, so the long-term tonal balance stays
// where the mix put it and only the surges are controlled.

const MF_MB_CROSSOVERS = [120, 500, 4000];
const MF_MB_BANDS = [
  { key: 'low', name: 'Low (<120 Hz)', attackMs: 30, releaseMs: 300 },
  { key: 'lowMid', name: 'Low-mid (120-500 Hz)', attackMs: 20, releaseMs: 200 },
  { key: 'mid', name: 'Mid (500 Hz-4 kHz)', attackMs: 10, releaseMs: 150 },
  { key: 'high', name: 'High (>4 kHz)', attackMs: 5, releaseMs: 100 },
];
const MF_MB_BLOCK_SECONDS = 0.05;
const MF_MB_DETECTOR_MS = 10;
const MF_MB_KNEE_DB = 6;
const MF_MB_MAX_REDUCTION_DB = 3;
const MF_MB_SURGE_DB = 10;
const MF_MB_CHUNK = 1 << 17;
const mfMbAnalysisCache = new WeakMap();

// RBJ cookbook biquads. Two cascaded Butterworth sections make an LR4 low- or
// high-pass; LR4 low-pass + high-pass equals a second-order allpass at the same
// frequency with Q = 1/sqrt(2), which is what the compensation filters use.
function mfMbCoefficients(type, frequency, sampleRate, q = Math.SQRT1_2) {
  const w0 = 2 * Math.PI * Math.min(frequency, sampleRate * 0.45) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  let b0, b1, b2;
  if (type === 'lowpass') { b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2; }
  else if (type === 'highpass') { b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2; }
  else { b0 = 1 - alpha; b1 = -2 * cos; b2 = 1 + alpha; }
  return new Float64Array([b0 / a0, b1 / a0, b2 / a0, -2 * cos / a0, (1 - alpha) / a0]);
}

// Direct form I over a block, in place; state is [x1, x2, y1, y2].
function mfMbFilterBlock(c, s, data, length) {
  const b0 = c[0], b1 = c[1], b2 = c[2], a1 = c[3], a2 = c[4];
  let x1 = s[0], x2 = s[1], y1 = s[2], y2 = s[3];
  for (let i = 0; i < length; i++) {
    const x = data[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    data[i] = y;
  }
  s[0] = x1; s[1] = x2; s[2] = y1; s[3] = y2;
}

// Four-band LR4 tree: split at 500 Hz, then 120 Hz below and 4 kHz above.
// Each branch also gets the other branch's allpass, so the four bands sum to
// one magnitude-flat allpass.
function mfMbCrossover(sampleRate, channels, blockSize) {
  const [lowSplit, midSplit, highSplit] = MF_MB_CROSSOVERS;
  const midLp = mfMbCoefficients('lowpass', midSplit, sampleRate);
  const midHp = mfMbCoefficients('highpass', midSplit, sampleRate);
  const lowLp = mfMbCoefficients('lowpass', lowSplit, sampleRate);
  const lowHp = mfMbCoefficients('highpass', lowSplit, sampleRate);
  const highLp = mfMbCoefficients('lowpass', highSplit, sampleRate);
  const highHp = mfMbCoefficients('highpass', highSplit, sampleRate);
  const lowAp = mfMbCoefficients('allpass', lowSplit, sampleRate);
  const highAp = mfMbCoefficients('allpass', highSplit, sampleRate);
  const states = Array.from({ length: channels }, () => Array.from({ length: 14 }, () => new Float64Array(4)));
  // bands[channel][band] is the block buffer for that band.
  const bands = Array.from({ length: channels }, () => Array.from({ length: 4 }, () => new Float64Array(blockSize)));
  return {
    bands,
    split(channel, input, offset, length) {
      const s = states[channel];
      const [low, lowMid, mid, high] = bands[channel];
      for (let i = 0; i < length; i++) { const x = input[offset + i]; lowMid[i] = x; high[i] = x; }
      mfMbFilterBlock(midLp, s[0], lowMid, length);
      mfMbFilterBlock(midLp, s[1], lowMid, length);
      mfMbFilterBlock(highAp, s[2], lowMid, length);
      mfMbFilterBlock(midHp, s[3], high, length);
      mfMbFilterBlock(midHp, s[4], high, length);
      mfMbFilterBlock(lowAp, s[5], high, length);
      low.set(lowMid.subarray(0, length));
      mid.set(high.subarray(0, length));
      mfMbFilterBlock(lowLp, s[6], low, length);
      mfMbFilterBlock(lowLp, s[7], low, length);
      mfMbFilterBlock(lowHp, s[8], lowMid, length);
      mfMbFilterBlock(lowHp, s[9], lowMid, length);
      mfMbFilterBlock(highLp, s[10], mid, length);
      mfMbFilterBlock(highLp, s[11], mid, length);
      mfMbFilterBlock(highHp, s[12], high, length);
      mfMbFilterBlock(highHp, s[13], high, length);
    },
  };
}

function mfMbGainReductionDb(levelDb, band) {
  const over = levelDb - band.thresholdDb;
  const slope = 1 - 1 / band.ratio;
  const half = MF_MB_KNEE_DB / 2;
  let reduction = 0;
  if (over >= half) reduction = over * slope;
  else if (over > -half) reduction = slope * (over + half) ** 2 / (2 * MF_MB_KNEE_DB);
  return Math.min(reduction, band.maxReductionDb);
}

const MF_MB_BLOCK = 4096;
const MF_MB_CONTROL = 16;

// One pass over the buffer. mode 'analyze' collects 50 ms band levels;
// 'render' runs the compressors, applies make-up gain, writes the summed
// output and reports each band's power before and after compression.
// The gain computer runs every 16 samples and the gain is ramped linearly
// between updates, which keeps log/pow out of the per-sample loop.
function mfMbCreateRun(buffer, settings, mode) {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
  const crossover = mfMbCrossover(buffer.sampleRate, channels.length, MF_MB_BLOCK);
  const rate = buffer.sampleRate;
  const coeff = (ms, samples = 1) => Math.exp(-samples / Math.max(1, rate * ms / 1000));
  const detector = coeff(MF_MB_DETECTOR_MS);
  const bands = (settings?.bands || MF_MB_BANDS).map((band) => ({
    ...band,
    attack: coeff(band.attackMs, MF_MB_CONTROL),
    release: coeff(band.releaseMs, MF_MB_CONTROL),
    makeup: dbToGain(band.makeupDb || 0),
  }));
  const envelope = new Float64Array(4);
  const reduction = new Float64Array(4);
  const currentGain = new Float64Array(4).fill(1);
  const powerBefore = new Float64Array(4);
  const powerAfter = new Float64Array(4);
  const reductionSum = new Float64Array(4);
  const reductionMax = new Float64Array(4);
  const analysisBlock = Math.max(1, Math.round(MF_MB_BLOCK_SECONDS * rate));
  const blockPower = new Float64Array(4);
  let blockFill = 0;
  const blockLevels = [[], [], [], []];
  const linked = new Float64Array(MF_MB_BLOCK);
  const output = mode === 'render' ? cloneBuffer(buffer) : null;
  const outChannels = output ? Array.from({ length: output.numberOfChannels }, (_, channel) => output.getChannelData(channel)) : null;
  const scale = 1 / channels.length;
  let position = 0;

  function processBlock(offset, length) {
    for (let channel = 0; channel < channels.length; channel++) crossover.split(channel, channels[channel], offset, length);
    const split = crossover.bands;

    for (let b = 0; b < 4; b++) {
      linked.fill(0, 0, length);
      for (let channel = 0; channel < channels.length; channel++) {
        const data = split[channel][b];
        for (let i = 0; i < length; i++) linked[i] += data[i] * data[i];
      }
      if (mode === 'analyze') {
        let fill = blockFill;
        let power = blockPower[b];
        for (let i = 0; i < length; i++) {
          power += linked[i] * scale;
          if (++fill === analysisBlock) {
            blockLevels[b].push(10 * Math.log10(Math.max(power / analysisBlock, 1e-20)));
            power = 0;
            fill = 0;
          }
        }
        blockPower[b] = power;
        continue;
      }

      const band = bands[b];
      let before = 0;
      let after = 0;
      if (!band.engaged) {
        for (let i = 0; i < length; i++) before += linked[i];
        powerBefore[b] += before * scale;
        powerAfter[b] += before * scale;
        continue;
      }
      let env = envelope[b];
      let red = reduction[b];
      let gain = currentGain[b];
      for (let start = 0; start < length; start += MF_MB_CONTROL) {
        const end = Math.min(length, start + MF_MB_CONTROL);
        for (let i = start; i < end; i++) {
          const power = linked[i] * scale;
          env = power + detector * (env - power);
        }
        const target = mfMbGainReductionDb(10 * Math.log10(Math.max(env, 1e-20)), band);
        red = target + (target > red ? band.attack : band.release) * (red - target);
        const nextGain = dbToGain(-red);
        const delta = (nextGain - gain) / (end - start);
        for (let i = start; i < end; i++) {
          gain += delta;
          const power = linked[i] * scale;
          before += power;
          after += power * gain * gain;
          linked[i] = gain * band.makeup;
        }
        gain = nextGain;
        reductionSum[b] += red * (end - start);
        if (red > reductionMax[b]) reductionMax[b] = red;
      }
      envelope[b] = env;
      reduction[b] = red;
      currentGain[b] = gain;
      powerBefore[b] += before;
      powerAfter[b] += after;
      if (outChannels) {
        for (let channel = 0; channel < channels.length; channel++) {
          const data = split[channel][b];
          for (let i = 0; i < length; i++) data[i] *= linked[i];
        }
      }
    }
    if (mode === 'analyze') blockFill = (blockFill + length) % analysisBlock;

    if (outChannels) {
      for (let channel = 0; channel < channels.length; channel++) {
        const [low, lowMid, mid, high] = split[channel];
        const out = outChannels[channel];
        for (let i = 0; i < length; i++) out[offset + i] = low[i] + lowMid[i] + mid[i] + high[i];
      }
    }
  }

  return {
    get done() { return position >= buffer.length; },
    step(count) {
      const end = Math.min(buffer.length, position + count);
      while (position < end) {
        const length = Math.min(MF_MB_BLOCK, end - position);
        processBlock(position, length);
        position += length;
      }
    },
    result() {
      const frames = Math.max(1, buffer.length);
      return {
        output,
        blockLevels,
        bands: bands.map((band, b) => ({
          key: band.key,
          powerBeforeDb: 10 * Math.log10(Math.max(powerBefore[b] / frames, 1e-20)),
          powerAfterDb: 10 * Math.log10(Math.max(powerAfter[b] / frames, 1e-20)),
          averageReductionDb: reductionSum[b] / frames,
          maxReductionDb: reductionMax[b],
        })),
      };
    },
  };
}

async function mfMbRunAsync(buffer, settings, mode) {
  const run = mfMbCreateRun(buffer, settings, mode);
  while (!run.done) {
    run.step(MF_MB_CHUNK);
    await sleep(0);
  }
  return run.result();
}

function mfMbPercentile(values, p) {
  if (!values.length) return -120;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
}

// Decide per band whether it surges enough to justify control. A band is
// engaged when its loud moments (98th percentile of 50 ms levels) sit at least
// 10 dB above its typical level, and it carries a meaningful share of the mix.
// Make-up gain is the average power the static gain curve removes from the
// band's 50 ms blocks, so the band's long-term level is restored.
async function mfMbBuildPlan(buffer) {
  if (!buffer || !buffer.length) return null;
  const cached = mfMbAnalysisCache.get(buffer);
  if (cached !== undefined) return cached;

  const analysis = await mfMbRunAsync(buffer, null, 'analyze');
  const powerOf = (levels, reduce = () => 0) => {
    let sum = 0;
    for (const level of levels) sum += 10 ** ((level - reduce(level)) / 10);
    return 10 * Math.log10(Math.max(sum / Math.max(1, levels.length), 1e-20));
  };
  const bandPower = analysis.blockLevels.map((levels) => powerOf(levels));
  const totalPowerDb = 10 * Math.log10(bandPower.reduce((sum, db) => sum + 10 ** (db / 10), 0) || 1e-20);

  const bands = MF_MB_BANDS.map((template, b) => {
    const levels = analysis.blockLevels[b];
    const loudest = mfMbPercentile(levels, 0.995);
    const active = levels.filter((level) => level > loudest - 50);
    const typical = mfMbPercentile(active, 0.5);
    const surge = mfMbPercentile(active, 0.98) - typical;
    const share = bandPower[b] - totalPowerDb;
    const band = {
      ...template,
      engaged: active.length >= 20 && share > -30 && surge >= MF_MB_SURGE_DB,
      surgeDb: surge,
      shareDb: share,
      // Partway up from the typical level, so surges are reduced but the
      // band's normal level is left alone.
      thresholdDb: typical + surge * 0.4,
      ratio: clamp(1.3 + (surge - MF_MB_SURGE_DB) * 0.06, 1.3, 2),
      maxReductionDb: MF_MB_MAX_REDUCTION_DB,
      makeupDb: 0,
    };
    if (band.engaged) {
      const loss = bandPower[b] - powerOf(levels, (level) => mfMbGainReductionDb(level, band));
      band.makeupDb = clamp(loss, 0, MF_MB_MAX_REDUCTION_DB);
    }
    return band;
  });

  const plan = bands.some((band) => band.engaged)
    ? { type: 'multiband', crossovers: [...MF_MB_CROSSOVERS], bands, label: 'Surge-aware multiband control' }
    : null;
  mfMbAnalysisCache.set(buffer, plan);
  return plan;
}

async function mfMbCompress(buffer, multiband) {
  const run = await mfMbRunAsync(buffer, multiband, 'render');
  state.multibandReport = run.bands.map((measured, b) => ({ ...measured, name: multiband.bands[b].name, engaged: multiband.bands[b].engaged }));
  return run.output;
}

// Band analysis needs a full pass over the mix, so it runs at render time
// (async, behind the render status) instead of in the synchronous plan.
// Until then the plan carries a pending marker; a cached analysis is used
// straight away.
const mfMbPreviousBuildMasterPlan = buildMasterPlan;
buildMasterPlan = function buildMasterPlanMultiband(metrics, requestedTargetLufs) {
  const plan = mfMbPreviousBuildMasterPlan(metrics, requestedTargetLufs);
  const cached = state.corrected ? mfMbAnalysisCache.get(state.corrected) : undefined;
  if (cached === undefined) return { ...plan, multiband: { pending: true } };
  if (!cached) return { ...plan, multiband: null };
  // Multiband control replaces broadband glue rather than stacking on it.
  return { ...plan, compressor: null, multiband: cached };
};

const mfMbPreviousRenderPreLimitedMaster = renderPreLimitedMaster;
renderPreLimitedMaster = async function renderPreLimitedMasterMultiband(buffer, plan) {
  state.multibandReport = null;
  if (plan?.multiband?.pending) {
    plan.multiband = await mfMbBuildPlan(buffer);
    if (plan.multiband) plan.compressor = null;
    if (typeof $ === 'function' && $('masterChain')) renderMasterChain(plan);
  }
  if (!plan?.multiband) return mfMbPreviousRenderPreLimitedMaster(buffer, plan);
  // Gain is linear, so apply it after the band compressors; their thresholds
  // were measured on the un-gained mix.
  const shaped = await mfMbPreviousRenderPreLimitedMaster(buffer, { ...plan, gainDb: 0 });
  const compressed = await mfMbCompress(shaped, plan.multiband);
  return mfProGainBuffer(compressed, plan.gainDb);
};

function mfMbDescribeBand(band) {
  return `${band.ratio.toFixed(1)}:1 above ${band.thresholdDb.toFixed(1)} dBFS · ${band.attackMs}/${band.releaseMs} ms · max ${band.maxReductionDb.toFixed(0)} dB · make-up +${band.makeupDb.toFixed(1)} dB`;
}

const mfMbPreviousRenderMasterChain = renderMasterChain;
renderMasterChain = function renderMasterChainMultiband(plan) {
  mfMbPreviousRenderMasterChain(plan);
  if (!plan?.multiband) return;
  const root = $('masterChain');
  const rows = plan.multiband.pending
    ? [['Multiband dynamics', 'Each band is measured when you render; only bands that surge are controlled']]
    : plan.multiband.bands.map((band) => [
    `Multiband · ${band.name}`,
    band.engaged ? mfMbDescribeBand(band) : `Untouched · surges ${band.surgeDb.toFixed(1)} dB above typical`,
  ]);
  for (const [label, value] of rows) {
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

const mfMbPreviousRenderVerification = renderVerification;
renderVerification = function renderVerificationMultiband(metrics, plan) {
  mfMbPreviousRenderVerification(metrics, plan);
  const report = state.multibandReport;
  if (!plan?.multiband || !report) return;
  const engaged = report.filter((band) => band.engaged);
  const row = document.createElement('div');
  row.className = 'check';
  const icon = document.createElement('b');
  icon.textContent = '✓';
  const detail = document.createElement('div');
  const label = document.createElement('strong');
  label.textContent = 'Multiband gain reduction: ';
  detail.append(label, document.createTextNode(engaged
    .map((band) => `${band.name} avg ${band.averageReductionDb.toFixed(1)} dB / max ${band.maxReductionDb.toFixed(1)} dB`)
    .join(' · ')));
  row.append(icon, detail);
  $('verificationList').append(row);
};
