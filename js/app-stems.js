'use strict';
function fallbackStemPlan(stem, metrics) {
  const operations = [];
  const addEq = (type, frequency, gain, q = 0.9, label = '') => operations.push({ type: 'eq', filterType: type, frequency, gain, q, label: label || `${type} ${frequency} Hz ${gain > 0 ? '+' : ''}${gain.toFixed(1)} dB` });
  if (Math.abs(metrics.dcOffset) > 0.003) operations.push({ type: 'highpass', frequency: 20, q: 0.7, label: 'Remove DC and inaudible rumble' });
  const lowMid = band(metrics, 'Low-mids'), mids = band(metrics, 'Mids'), presence = band(metrics, 'Presence'), air = band(metrics, 'Air'), sub = band(metrics, 'Sub'), bass = band(metrics, 'Bass');
  if (stem === 'vocals') {
    if (lowMid - mids > 6) addEq('peaking', 320, -clamp((lowMid - mids - 4) * 0.35, 1, 3.5), 1.1, 'Reduce vocal boxiness');
    if (lowMid - presence > 12) addEq('peaking', 3600, clamp((lowMid - presence - 10) * 0.25, 1, 3), 0.9, 'Restore lyric clarity');
    const flare = metrics.sibilance.p95Db - metrics.sibilance.medianDb;
    if (metrics.sibilance.flares > metrics.sibilance.frames * 0.05 && flare > 7) operations.push({ type: 'deess', frequency: 6800, threshold: -30, label: 'Dynamic vocal de-essing' });
    if (metrics.crestDb > 18) operations.push({ type: 'compressor', threshold: -22, ratio: 2.2, attack: 0.025, release: 0.16, knee: 5, label: 'Gentle vocal leveling' });
  } else if (stem === 'bass') {
    if (sub - bass > 2) addEq('lowshelf', 55, -clamp(sub - bass, 1, 4), 0.7, 'Control sub-bass headroom');
    if (lowMid - mids > 8) addEq('peaking', 280, -2, 1, 'Reduce bass wool');
    if (metrics.crestDb > 16) operations.push({ type: 'compressor', threshold: -24, ratio: 2.5, attack: 0.035, release: 0.18, knee: 5, label: 'Stabilize bass notes' });
  } else if (stem === 'drums') {
    if (presence - air > 12) addEq('highshelf', 8500, 1.5, 0.7, 'Open cymbal air gently');
    if (lowMid - mids > 8) addEq('peaking', 380, -2, 1, 'Clean drum-box buildup');
    if (metrics.crestDb > 22) operations.push({ type: 'compressor', threshold: -20, ratio: 1.8, attack: 0.035, release: 0.12, knee: 4, label: 'Add light drum glue' });
  } else {
    if (lowMid - mids > 7) addEq('peaking', 350, -2.2, 1, 'Reduce low-mid masking');
    if (presence - air > 15) addEq('peaking', 3200, -1.5, 1.2, 'Tame forward upper mids');
  }
  if (!operations.length) operations.push({ type: 'gain', gainDb: 0, label: 'No corrective processing required' });
  return { stem, summary: `${stem[0].toUpperCase()}${stem.slice(1)} measured independently; only evidence-based repairs are enabled.`, operations };
}

function validateStemPlans(value, fallback) {
  if (!value || typeof value !== 'object' || !value.stems) return fallback;
  const safe = {};
  for (const stem of Object.keys(fallback)) {
    const candidate = value.stems[stem];
    if (!candidate || !Array.isArray(candidate.operations)) { safe[stem] = fallback[stem]; continue; }
    const operations = candidate.operations.slice(0, 8).filter((op) => ['eq', 'highpass', 'deess', 'compressor', 'gain'].includes(op.type)).map((op) => ({ ...op, label: String(op.label || op.type).slice(0, 140) }));
    safe[stem] = { stem, summary: String(candidate.summary || fallback[stem].summary).slice(0, 400), operations: operations.length ? operations : fallback[stem].operations };
  }
  return safe;
}

async function buildStemPlans() {
  const metricsByStem = {};
  const fallback = {};
  for (const [stem, buffer] of Object.entries(state.stemBuffers)) {
    metricsByStem[stem] = measureBuffer(buffer);
    fallback[stem] = fallbackStemPlan(stem, metricsByStem[stem]);
  }
  try {
    const ai = await requestAI({ phase: 'stems', stems: metricsByStem, mixMetrics: state.mixMetrics, notes: $('notes').value.trim() });
    state.stemPlans = validateStemPlans(ai, fallback);
  } catch (error) {
    console.warn('AI stem planning unavailable; using measured rules.', error);
    state.stemPlans = fallback;
  }
  for (const stem of Object.keys(state.stemPlans)) state.stemPlans[stem].metrics = metricsByStem[stem];
}

function describeOperation(op) {
  if (op.type === 'eq') return `${op.filterType || 'peaking'} · ${Math.round(Number(op.frequency) || 1000)} Hz · ${(Number(op.gain) || 0) >= 0 ? '+' : ''}${(Number(op.gain) || 0).toFixed(1)} dB`;
  if (op.type === 'highpass') return `high-pass · ${Math.round(Number(op.frequency) || 20)} Hz`;
  if (op.type === 'deess') return `${Math.round(Number(op.frequency) || 6800)} Hz · conservative parallel control`;
  if (op.type === 'compressor') return `${Number(op.ratio || 2).toFixed(1)}:1 · threshold ${Math.round(Number(op.threshold) || -24)} dB`;
  if (op.type === 'gain') return `${Number(op.gainDb || 0) >= 0 ? '+' : ''}${Number(op.gainDb || 0).toFixed(1)} dB`;
  return op.type;
}

function renderStemPlans() {
  const root = $('stemGrid'); root.replaceChildren();
  for (const [stem, plan] of Object.entries(state.stemPlans)) {
    const card = document.createElement('article'); card.className = 'stem-card';
    const head = document.createElement('div'); head.className = 'stem-head';
    const h3 = document.createElement('h3'); h3.textContent = stem;
    const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = `${plan.metrics.lufs.toFixed(1)} LUFS · crest ${plan.metrics.crestDb.toFixed(1)} dB`;
    head.append(h3, badge);
    const summary = document.createElement('p'); summary.textContent = plan.summary; summary.style.color = 'var(--muted)'; summary.style.fontSize = '.86rem';
    const list = document.createElement('div'); list.className = 'repair-list';
    for (const op of plan.operations) {
      const row = document.createElement('div'); row.className = 'repair';
      const name = document.createElement('span'); name.textContent = op.label || op.type;
      const value = document.createElement('span'); value.textContent = describeOperation(op);
      row.append(name, value); list.append(row);
    }
    card.append(head, summary, list); root.append(card);
  }
}

function makeFilter(ctx, op) {
  const node = ctx.createBiquadFilter();
  node.type = op.type === 'highpass' ? 'highpass' : (op.filterType || 'peaking');
  node.frequency.value = clamp(Number(op.frequency) || 1000, 10, 20000);
  node.Q.value = clamp(Number(op.q) || 0.9, 0.1, 12);
  node.gain.value = clamp(Number(op.gain) || 0, -12, 12);
  return node;
}

async function renderProcessedBuffer(sourceBuffer, operations) {
  if (!OfflineCtx) throw new Error('Offline audio rendering is not supported in this browser.');
  const off = new OfflineCtx(sourceBuffer.numberOfChannels, sourceBuffer.length, sourceBuffer.sampleRate);
  const src = off.createBufferSource(); src.buffer = sourceBuffer;
  let head = src;
  for (const op of operations) {
    if (op.type === 'eq' || op.type === 'highpass') {
      const node = makeFilter(off, op); head.connect(node); head = node;
    } else if (op.type === 'deess') {
      // The former phase-subtraction de-esser could cancel vocals and guitars.
      // Use a gentle high-shelf reduction; the parallel rebuild below limits it further.
      const node = off.createBiquadFilter();
      node.type = 'highshelf';
      node.frequency.value = clamp(Number(op.frequency) || 6800, 4500, 10000);
      node.gain.value = -1.5;
      head.connect(node); head = node;
    } else if (op.type === 'compressor') {
      const comp = off.createDynamicsCompressor();
      comp.threshold.value = clamp(Number(op.threshold) || -24, -60, 0); comp.ratio.value = clamp(Number(op.ratio) || 2, 1, 6);
      comp.attack.value = clamp(Number(op.attack) || 0.03, 0.005, 1); comp.release.value = clamp(Number(op.release) || 0.15, 0.03, 1); comp.knee.value = clamp(Number(op.knee) || 4, 0, 30);
      head.connect(comp); head = comp;
    } else if (op.type === 'gain') {
      const gain = off.createGain(); gain.gain.value = dbToGain(clamp(Number(op.gainDb) || 0, -3, 3)); head.connect(gain); head = gain;
    }
  }
  head.connect(off.destination); src.start();
  return off.startRendering();
}

function cloneBuffer(buffer) {
  const out = state.audioCtx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let c = 0; c < buffer.numberOfChannels; c++) out.copyToChannel(buffer.getChannelData(c), c);
  return out;
}

function bufferRms(buffer) {
  let sum = 0, count = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    const step = Math.max(1, Math.floor(data.length / 250000));
    for (let i = 0; i < data.length; i += step) { sum += data[i] * data[i]; count++; }
  }
  return Math.sqrt(sum / Math.max(1, count));
}

async function rebuildCorrectedMix() {
  const out = cloneBuffer(state.original);
  const wet = 0.28;
  for (const [stem, originalStem] of Object.entries(state.stemBuffers)) {
    const plan = state.stemPlans[stem];
    if (!plan) continue;
    const processed = await renderProcessedBuffer(originalStem, plan.operations);
    const rawRms = bufferRms(originalStem);
    const fixedRms = bufferRms(processed);
    const levelMatch = fixedRms > 1e-8 ? clamp(rawRms / fixedRms, dbToGain(-2), dbToGain(2)) : 1;
    const length = Math.min(out.length, originalStem.length, processed.length);
    for (let c = 0; c < out.numberOfChannels; c++) {
      const dest = out.getChannelData(c);
      const raw = originalStem.getChannelData(Math.min(c, originalStem.numberOfChannels - 1));
      const fixed = processed.getChannelData(Math.min(c, processed.numberOfChannels - 1));
      for (let i = 0; i < length; i++) {
        const repaired = raw[i] * (1 - wet) + fixed[i] * levelMatch * wet;
        dest[i] += repaired - raw[i];
      }
    }
    await sleep(0);
  }
  return out;
}

$('rebuildBtn').addEventListener('click', async () => {
  $('rebuildBtn').disabled = true;
  setStatus('rebuildStatus', 'Rendering level-matched parallel repairs while preserving the original vocals and instruments…', 'busy');
  try {
    state.corrected = await rebuildCorrectedMix();
    state.correctedMetrics = measureBuffer(state.corrected);
    setStatus('rebuildStatus', 'Corrective mix rebuilt with source-preservation safeguards. Preparing the mastering chain.', 'ok');
    prepareMastering();
    $('masterPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    console.error(error);
    setStatus('rebuildStatus', `Could not rebuild the mix: ${error.message}`, 'error');
  } finally {
    $('rebuildBtn').disabled = false;
  }
});