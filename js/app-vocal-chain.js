'use strict';

// MixForge 2.5.9 conservative isolated-vocal chain.
// After Forensic isolation: evidence-bounded EQ, control compression, light
// tempo-aware delay + room. Not a tuner. Pitch is not applied — this build has
// no musical engine (Rubber Band commercial WASM or high-quality PSOLA would
// be required). Autotalent-class / Cher-effect shifters are not shipped.

const MF_VOCAL_CHAIN_SKIP_WARNING = "Can't apply a vocal chain (EQ, compression, or space) without isolation.";
const MF_VOCAL_PITCH_SKIP = 'Pitch: not applied — no musical engine in this build. Needs Rubber Band (commercial WASM licence) or equivalent high-quality PSOLA; Autotalent-class / Cher-effect shifters are not shipped.';

const MF_CHAIN_HP_HZ = 80;
const MF_CHAIN_MUD_HZ = 250;
const MF_CHAIN_PRESENCE_HZ = 3500;
const MF_CHAIN_DEESS_HZ = 6800;
const MF_CHAIN_EQ_MAX_CUT = 4.5;
const MF_CHAIN_EQ_MAX_LIFT = 2.0;
const MF_CHAIN_COMP_MAX_RATIO = 3.2;
const MF_CHAIN_COMP_MAX_GR = 6;
const MF_CHAIN_DELAY_WET = 0.12;
const MF_CHAIN_REVERB_WET = 0.10;
const MF_CHAIN_REVERB_DECAY = 1.05;

function mfChainClamp(value, min, max) {
  if (typeof clamp === 'function') return clamp(value, min, max);
  return Math.max(min, Math.min(max, value));
}

function mfChainDbToGain(db) {
  if (typeof dbToGain === 'function') return dbToGain(db);
  return 10 ** (Number(db) / 20);
}

function mfChainGainToDb(gain) {
  if (typeof gainToDb === 'function') return gainToDb(gain);
  return 20 * Math.log10(Math.max(Number(gain) || 0, 1e-12));
}

function mfChainBand(metrics, name) {
  if (typeof band === 'function') return band(metrics, name);
  return (metrics?.midBands || []).find((item) => item.name === name)?.db ?? -120;
}

function mfChainCloneBuffer(buffer) {
  if (typeof cloneBuffer === 'function' && typeof state !== 'undefined' && state.audioCtx) {
    return cloneBuffer(buffer);
  }
  const data = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    data.push(new Float32Array(buffer.getChannelData(channel)));
  }
  return {
    numberOfChannels: buffer.numberOfChannels,
    length: buffer.length,
    sampleRate: buffer.sampleRate,
    duration: buffer.length / buffer.sampleRate,
    getChannelData(channel) { return data[channel]; },
    copyToChannel(source, channel) { data[channel].set(source); },
  };
}

function mfBiquadCoeffs(type, hz, q, gainDb, sampleRate) {
  const freq = mfChainClamp(hz, 20, sampleRate * 0.45);
  const w0 = 2 * Math.PI * freq / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * mfChainClamp(q, 0.1, 8));
  const A = 10 ** ((Number(gainDb) || 0) / 40);
  let b0 = 1;
  let b1 = 0;
  let b2 = 0;
  let a0 = 1;
  let a1 = 0;
  let a2 = 0;
  if (type === 'highpass') {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  } else if (type === 'lowshelf') {
    const sqrtA = Math.sqrt(A);
    b0 = A * ((A + 1) - (A - 1) * cos + 2 * sqrtA * alpha);
    b1 = 2 * A * ((A - 1) - (A + 1) * cos);
    b2 = A * ((A + 1) - (A - 1) * cos - 2 * sqrtA * alpha);
    a0 = (A + 1) + (A - 1) * cos + 2 * sqrtA * alpha;
    a1 = -2 * ((A - 1) + (A + 1) * cos);
    a2 = (A + 1) + (A - 1) * cos - 2 * sqrtA * alpha;
  } else if (type === 'highshelf') {
    const sqrtA = Math.sqrt(A);
    b0 = A * ((A + 1) + (A - 1) * cos + 2 * sqrtA * alpha);
    b1 = -2 * A * ((A - 1) + (A + 1) * cos);
    b2 = A * ((A + 1) + (A - 1) * cos - 2 * sqrtA * alpha);
    a0 = (A + 1) - (A - 1) * cos + 2 * sqrtA * alpha;
    a1 = 2 * ((A - 1) - (A + 1) * cos);
    a2 = (A + 1) - (A - 1) * cos - 2 * sqrtA * alpha;
  } else {
    b0 = 1 + alpha * A;
    b1 = -2 * cos;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cos;
    a2 = 1 - alpha / A;
  }
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  };
}

function mfBiquadProcess(input, coeffs) {
  const out = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i] || 0;
    const y = coeffs.b0 * x + coeffs.b1 * x1 + coeffs.b2 * x2 - coeffs.a1 * y1 - coeffs.a2 * y2;
    out[i] = y;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
  }
  return out;
}

function mfEstimateBpm(buffer) {
  if (!buffer?.length) return null;
  const sampleRate = Number(buffer.sampleRate) || 44100;
  const hop = Math.max(32, Math.round(sampleRate / 200));
  const data = buffer.getChannelData(0);
  const flux = [];
  let previous = 0;
  for (let start = 0; start < data.length; start += hop) {
    const end = Math.min(data.length, start + hop);
    let energy = 0;
    for (let i = start; i < end; i++) energy += (data[i] || 0) ** 2;
    const rms = Math.sqrt(energy / Math.max(1, end - start));
    flux.push(Math.max(0, rms - previous));
    previous = rms;
  }
  if (flux.length < 32) return null;
  let bestBpm = 0;
  let bestCorr = 0;
  for (let bpm = 72; bpm <= 168; bpm += 1) {
    const lag = Math.round((60 / bpm) * (sampleRate / hop));
    if (lag < 4 || lag >= flux.length / 2) continue;
    let corr = 0;
    for (let i = 0; i < flux.length - lag; i++) corr += flux[i] * flux[i + lag];
    if (corr > bestCorr) {
      bestCorr = corr;
      bestBpm = bpm;
    }
  }
  return bestBpm || null;
}

function mfPlanVocalChain(metrics, options = {}) {
  const eq = [];
  const sub = mfChainBand(metrics, 'Sub');
  const bassBand = mfChainBand(metrics, 'Bass');
  const lowMid = mfChainBand(metrics, 'Low-mids');
  const mids = mfChainBand(metrics, 'Mids');
  const presence = mfChainBand(metrics, 'Presence');
  const crest = Number(metrics?.crestDb);
  const dc = Number(metrics?.dcOffset);
  const sib = metrics?.sibilance || {};
  const flare = Number(sib.p95Db) - Number(sib.medianDb);

  if (Number.isFinite(dc) && Math.abs(dc) > 0.003) {
    eq.push({
      type: 'highpass',
      filterType: 'highpass',
      frequency: 20,
      q: 0.7,
      gain: 0,
      label: 'Remove DC and inaudible rumble',
    });
  }
  if ((Number.isFinite(sub) && Number.isFinite(bassBand) && sub - bassBand > 2.5)
    || (Number.isFinite(bassBand) && Number.isFinite(lowMid) && bassBand - lowMid > 4)) {
    eq.push({
      type: 'highpass',
      filterType: 'highpass',
      frequency: MF_CHAIN_HP_HZ,
      q: 0.7,
      gain: 0,
      label: `Vocal high-pass ${MF_CHAIN_HP_HZ} Hz (boom / rumble on the stem)`,
    });
  }
  if (Number.isFinite(lowMid) && Number.isFinite(mids) && lowMid - mids > 4) {
    const cut = mfChainClamp((lowMid - mids - 3) * 0.45, 1.2, MF_CHAIN_EQ_MAX_CUT);
    eq.push({
      type: 'eq',
      filterType: 'peaking',
      frequency: MF_CHAIN_MUD_HZ,
      gain: -cut,
      q: 1.1,
      label: `Cut mud/boom ${MF_CHAIN_MUD_HZ} Hz ${(-cut).toFixed(1)} dB`,
    });
  }
  const harsh = Number.isFinite(presence) && Number.isFinite(mids) && presence - mids > 6;
  if (harsh) {
    const cut = mfChainClamp((presence - mids - 4) * 0.35, 1.0, 3.0);
    eq.push({
      type: 'eq',
      filterType: 'peaking',
      frequency: 5000,
      gain: -cut,
      q: 1.2,
      label: `Tame harshness 5 kHz ${(-cut).toFixed(1)} dB`,
    });
  }
  if (Number.isFinite(flare) && flare > 7 && Number(sib.flares) > Number(sib.frames) * 0.05) {
    eq.push({
      type: 'deess',
      filterType: 'highshelf',
      frequency: MF_CHAIN_DEESS_HZ,
      gain: -1.8,
      q: 0.7,
      label: `Tame sibilance ${MF_CHAIN_DEESS_HZ} Hz −1.8 dB`,
    });
  }
  if (!harsh && Number.isFinite(lowMid) && Number.isFinite(presence) && lowMid - presence > 10) {
    const lift = mfChainClamp((lowMid - presence - 9) * 0.18, 0.8, MF_CHAIN_EQ_MAX_LIFT);
    eq.push({
      type: 'eq',
      filterType: 'peaking',
      frequency: MF_CHAIN_PRESENCE_HZ,
      gain: lift,
      q: 0.95,
      label: `Small presence ${MF_CHAIN_PRESENCE_HZ} Hz +${lift.toFixed(1)} dB (dark vocal)`,
    });
  }

  let compressor = null;
  if (Number.isFinite(crest) && crest > 14) {
    const ratio = mfChainClamp(1.6 + (crest - 14) * 0.18, 1.8, MF_CHAIN_COMP_MAX_RATIO);
    const threshold = mfChainClamp((Number(metrics.rmsDb) || -20) + 3, -28, -12);
    compressor = {
      type: 'compressor',
      threshold,
      ratio,
      attack: 0.018,
      release: 0.14,
      knee: 4,
      label: `Vocal control ${ratio.toFixed(1)}:1 · threshold ${threshold.toFixed(0)} dB`,
    };
  }

  const bpm = Number(options.bpm);
  const tempoKnown = Number.isFinite(bpm) && bpm >= 70 && bpm <= 180;
  const delayMs = tempoKnown ? (60000 / bpm) : 118;
  const delay = {
    type: 'delay',
    delayMs,
    musical: tempoKnown ? '1/8' : 'slap',
    bpm: tempoKnown ? Math.round(bpm) : null,
    wet: MF_CHAIN_DELAY_WET,
    feedback: tempoKnown ? 0.16 : 0.12,
    label: tempoKnown
      ? `Tempo delay 1/8 at ${Math.round(bpm)} BPM · ${(MF_CHAIN_DELAY_WET * 100).toFixed(0)}% send`
      : `Short slap delay ${Math.round(delayMs)} ms · ${(MF_CHAIN_DELAY_WET * 100).toFixed(0)}% send`,
  };
  const reverb = {
    type: 'reverb',
    decaySec: MF_CHAIN_REVERB_DECAY,
    wet: MF_CHAIN_REVERB_WET,
    predelayMs: 22,
    label: `Light room ${MF_CHAIN_REVERB_DECAY.toFixed(2)} s · ${(MF_CHAIN_REVERB_WET * 100).toFixed(0)}% wet`,
  };

  return {
    eq,
    compressor,
    delay,
    reverb,
    pitch: {
      applied: false,
      note: MF_VOCAL_PITCH_SKIP,
    },
    bpm: tempoKnown ? Math.round(bpm) : null,
  };
}

function mfCompressChannel(input, sampleRate, compressor) {
  const threshold = mfChainDbToGain(compressor.threshold);
  const ratio = mfChainClamp(Number(compressor.ratio) || 2, 1.1, MF_CHAIN_COMP_MAX_RATIO);
  const attack = Math.exp(-1 / Math.max(1, sampleRate * (Number(compressor.attack) || 0.018)));
  const release = Math.exp(-1 / Math.max(1, sampleRate * (Number(compressor.release) || 0.14)));
  const out = new Float32Array(input.length);
  let envelope = 0;
  let maxGr = 0;
  let grSum = 0;
  for (let i = 0; i < input.length; i++) {
    const sample = input[i] || 0;
    const peak = Math.abs(sample);
    envelope = peak > envelope ? attack * envelope + (1 - attack) * peak : release * envelope + (1 - release) * peak;
    let gain = 1;
    if (envelope > threshold) {
      const overDb = mfChainGainToDb(envelope / threshold);
      const reduced = overDb - overDb / ratio;
      const gr = Math.min(reduced, MF_CHAIN_COMP_MAX_GR);
      gain = mfChainDbToGain(-gr);
      if (gr > maxGr) maxGr = gr;
      grSum += gr;
    }
    out[i] = sample * gain;
  }
  return { data: out, grPeakDb: maxGr, grAvgDb: grSum / Math.max(1, input.length) };
}

function mfDelayChannel(input, sampleRate, delay) {
  const taps = Math.max(1, Math.round((Number(delay.delayMs) || 118) * sampleRate / 1000));
  const wet = mfChainClamp(Number(delay.wet) || MF_CHAIN_DELAY_WET, 0.04, 0.18);
  const feedback = mfChainClamp(Number(delay.feedback) || 0.14, 0.05, 0.28);
  const out = new Float32Array(input.length);
  const line = new Float32Array(taps + 2);
  let index = 0;
  const damp = mfBiquadCoeffs('highpass', 250, 0.7, 0, sampleRate);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const delayed = line[index] || 0;
    const filtered = damp.b0 * delayed + damp.b1 * x1 + damp.b2 * x2 - damp.a1 * y1 - damp.a2 * y2;
    x2 = x1;
    x1 = delayed;
    y2 = y1;
    y1 = filtered;
    const dry = input[i] || 0;
    out[i] = dry + filtered * wet;
    line[index] = dry + filtered * feedback;
    index += 1;
    if (index >= taps) index = 0;
  }
  return out;
}

function mfReverbChannel(input, sampleRate, reverb) {
  const wet = mfChainClamp(Number(reverb.wet) || MF_CHAIN_REVERB_WET, 0.05, 0.16);
  const decay = mfChainClamp(Number(reverb.decaySec) || MF_CHAIN_REVERB_DECAY, 0.6, 1.4);
  const scale = sampleRate / 44100;
  const combLengths = [1557, 1617, 1491, 1422, 1277, 1356, 1188, 1116].map((n) => Math.max(16, Math.round(n * scale)));
  const allpassLengths = [225, 556, 441, 341].map((n) => Math.max(8, Math.round(n * scale)));
  const feedback = mfChainClamp(1 - 0.32 / decay, 0.55, 0.82);
  const combs = combLengths.map((length) => ({ buf: new Float32Array(length), i: 0, filter: 0 }));
  const allpass = allpassLengths.map((length) => ({ buf: new Float32Array(length), i: 0 }));
  const predelay = Math.max(0, Math.round((Number(reverb.predelayMs) || 22) * sampleRate / 1000));
  const out = new Float32Array(input.length);
  for (let n = 0; n < input.length; n++) {
    const source = n >= predelay ? (input[n - predelay] || 0) : 0;
    let acc = 0;
    for (const comb of combs) {
      const delayed = comb.buf[comb.i] || 0;
      comb.filter = delayed * 0.82 + comb.filter * 0.18;
      comb.buf[comb.i] = source + comb.filter * feedback;
      comb.i += 1;
      if (comb.i >= comb.buf.length) comb.i = 0;
      acc += delayed;
    }
    acc /= combs.length;
    for (const ap of allpass) {
      const buf = ap.buf[ap.i] || 0;
      const next = acc + buf * -0.5;
      ap.buf[ap.i] = acc + next * 0.5;
      ap.i += 1;
      if (ap.i >= ap.buf.length) ap.i = 0;
      acc = buf + next * 0.5;
    }
    out[n] = (input[n] || 0) * (1 - wet) + acc * wet;
  }
  return out;
}

function mfLimitPeak(buffer, ceilingDb = -0.3) {
  let peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] || 0));
  }
  const ceiling = mfChainDbToGain(ceilingDb);
  if (peak <= ceiling || peak < 1e-8) return buffer;
  const scale = ceiling / peak;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) data[i] *= scale;
  }
  return buffer;
}

function mfApplyVocalChain(buffer, plan) {
  if (!buffer?.length) return { buffer, applied: false, moves: [], grPeakDb: 0 };
  const output = mfChainCloneBuffer(buffer);
  const moves = [];
  const sampleRate = output.sampleRate || 44100;
  for (let channel = 0; channel < output.numberOfChannels; channel++) {
    let data = new Float32Array(output.getChannelData(channel));
    for (const op of plan?.eq || []) {
      const type = op.type === 'highpass' || op.filterType === 'highpass'
        ? 'highpass'
        : op.type === 'deess' || op.filterType === 'highshelf'
          ? 'highshelf'
          : (op.filterType || 'peaking');
      data = mfBiquadProcess(data, mfBiquadCoeffs(type, op.frequency, op.q || 0.9, op.gain || 0, sampleRate));
      if (channel === 0) moves.push(op.label);
    }
    let grPeakDb = 0;
    if (plan?.compressor) {
      const compressed = mfCompressChannel(data, sampleRate, plan.compressor);
      data = compressed.data;
      grPeakDb = compressed.grPeakDb;
      if (channel === 0) {
        plan.compressor.grPeakDb = Number(grPeakDb.toFixed(1));
        moves.push(`${plan.compressor.label} · GR ${grPeakDb.toFixed(1)} dB`);
      }
    }
    if (plan?.delay) {
      data = mfDelayChannel(data, sampleRate, plan.delay);
      if (channel === 0) moves.push(plan.delay.label);
    }
    if (plan?.reverb) {
      data = mfReverbChannel(data, sampleRate, plan.reverb);
      if (channel === 0) moves.push(plan.reverb.label);
    }
    output.getChannelData(channel).set(data);
  }
  mfLimitPeak(output);
  return {
    buffer: output,
    applied: true,
    moves,
    grPeakDb: Number(plan?.compressor?.grPeakDb) || 0,
  };
}

function mfVocalChainSkipReport() {
  return {
    skipped: true,
    applied: false,
    skipWarning: MF_VOCAL_CHAIN_SKIP_WARNING,
    pitch: { applied: false, note: MF_VOCAL_PITCH_SKIP },
    moves: [],
    note: MF_VOCAL_CHAIN_SKIP_WARNING,
  };
}

function mfVocalChainWhatChangedLines(chain) {
  if (!chain) return { musician: [], bullets: [] };
  if (chain.skipped) {
    return {
      musician: [chain.skipWarning || MF_VOCAL_CHAIN_SKIP_WARNING],
      bullets: [chain.skipWarning || MF_VOCAL_CHAIN_SKIP_WARNING, chain.pitch?.note || MF_VOCAL_PITCH_SKIP],
    };
  }
  const musician = [];
  const bits = [];
  for (const op of chain.eq || []) bits.push(op.label.replace(/^Vocal /, ''));
  if (chain.compressor) {
    const gr = Number.isFinite(Number(chain.compressor.grPeakDb))
      ? ` · GR ${Number(chain.compressor.grPeakDb).toFixed(1)} dB`
      : '';
    bits.push(`${chain.compressor.ratio.toFixed(1)}:1 compression${gr}`);
  }
  if (chain.delay) bits.push(chain.delay.musical === '1/8' ? `${chain.delay.musical} delay at ${chain.delay.bpm} BPM` : 'short slap delay');
  if (chain.reverb) bits.push('light room');
  if (bits.length) musician.push(`On the isolated vocal: ${bits.slice(0, 4).join(', ')}.`);
  musician.push('Pitch was not applied — this build has no musical pitch engine.');
  const bullets = [];
  for (const op of chain.eq || []) bullets.push(`Vocal EQ: ${op.label}.`);
  if (chain.compressor) {
    bullets.push(`Vocal compression: ${chain.compressor.ratio.toFixed(1)}:1, threshold ${Number(chain.compressor.threshold).toFixed(0)} dB, GR ${Number(chain.compressor.grPeakDb || 0).toFixed(1)} dB (control, not smash).`);
  } else {
    bullets.push('Vocal compression: not justified by crest on the isolated stem.');
  }
  if (chain.delay) bullets.push(`Vocal delay: ${chain.delay.label}.`);
  if (chain.reverb) bullets.push(`Vocal reverb: ${chain.reverb.label}.`);
  bullets.push(chain.pitch?.note || MF_VOCAL_PITCH_SKIP);
  return { musician: musician.slice(0, 3), bullets };
}

function mfAttachVocalChainNotes(stemPlans, chain) {
  if (!stemPlans?.vocals || !chain || chain.skipped) return stemPlans;
  const vocals = stemPlans.vocals;
  const notes = [];
  for (const op of chain.eq || []) notes.push({ ...op });
  if (chain.compressor) notes.push({ ...chain.compressor });
  if (chain.delay) notes.push({ type: 'delay', label: chain.delay.label, delayMs: chain.delay.delayMs });
  if (chain.reverb) notes.push({ type: 'reverb', label: chain.reverb.label, decaySec: chain.reverb.decaySec });
  notes.push({ type: 'pitch', label: 'Pitch not applied', gainDb: 0 });
  const existing = Array.isArray(vocals.operations)
    ? vocals.operations.filter((op) => !/Vocal (high-pass|EQ|control|delay|reverb|mud|presence|sibilance|harshness)|Pitch not applied|Cut mud|Tame |Small presence|Remove DC/i.test(op.label || ''))
    : [];
  vocals.operations = [...notes, ...existing.filter((op) => op.label !== 'No corrective processing required')];
  return stemPlans;
}

function mfEnsureVocalChain(stateLike = typeof state === 'undefined' ? {} : state) {
  if (stateLike.vocalChain?.applied || stateLike.vocalChain?.detected) return stateLike.vocalChain;
  const vocal = stateLike.stemBuffers?.vocals;
  if (!vocal) {
    stateLike.vocalChain = mfVocalChainSkipReport();
    return stateLike.vocalChain;
  }
  const metrics = stateLike.stemPlans?.vocals?.metrics
    || (typeof measureBuffer === 'function' ? measureBuffer(vocal) : null);
  const tempoSource = stateLike.stemBuffers?.drums || stateLike.original || vocal;
  const bpm = mfEstimateBpm(tempoSource);
  const plan = mfPlanVocalChain(metrics || {}, { bpm });
  const rendered = mfApplyVocalChain(vocal, plan);
  const report = {
    ...plan,
    ...rendered,
    applied: true,
    skipped: false,
    detected: true,
    pitch: { applied: false, note: MF_VOCAL_PITCH_SKIP },
  };
  stateLike.vocalChain = report;
  if (stateLike.stemPlans) mfAttachVocalChainNotes(stateLike.stemPlans, report);
  return report;
}

if (typeof globalThis !== 'undefined') {
  globalThis.MF_VOCAL_CHAIN_SKIP_WARNING = MF_VOCAL_CHAIN_SKIP_WARNING;
  globalThis.MF_VOCAL_PITCH_SKIP = MF_VOCAL_PITCH_SKIP;
  globalThis.mfEstimateBpm = mfEstimateBpm;
  globalThis.mfPlanVocalChain = mfPlanVocalChain;
  globalThis.mfApplyVocalChain = mfApplyVocalChain;
  globalThis.mfVocalChainSkipReport = mfVocalChainSkipReport;
  globalThis.mfVocalChainWhatChangedLines = mfVocalChainWhatChangedLines;
  globalThis.mfAttachVocalChainNotes = mfAttachVocalChainNotes;
  globalThis.mfEnsureVocalChain = mfEnsureVocalChain;
  globalThis.mfBiquadCoeffs = mfBiquadCoeffs;
  globalThis.mfBiquadProcess = mfBiquadProcess;
}
