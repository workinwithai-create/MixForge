'use strict';
function buildMasterPlan(metrics, targetLufs) {
  const eq = [];
  const subExcess = band(metrics, 'Sub') - band(metrics, 'Bass');
  if (subExcess > 2.5) eq.push({ type: 'eq', filterType: 'lowshelf', frequency: 55, gain: -clamp(subExcess - 1, 1, 3.5), q: 0.7, label: 'Final sub trim' });
  const airDrop = band(metrics, 'Presence') - band(metrics, 'Air');
  if (airDrop > 10) eq.push({ type: 'eq', filterType: 'highshelf', frequency: 9000, gain: clamp((airDrop - 8) * 0.25, 0.8, 2.5), q: 0.7, label: 'Final air shelf' });
  const lowMid = band(metrics, 'Low-mids') - band(metrics, 'Mids');
  if (lowMid > 8) eq.push({ type: 'eq', filterType: 'peaking', frequency: 350, gain: -clamp((lowMid - 6) * 0.25, 0.8, 2.5), q: 0.9, label: 'Broad low-mid cleanup' });
  const compressor = metrics.crestDb > 16 && metrics.lra > 9 ? { type: 'compressor', threshold: -22, ratio: 1.7, attack: 0.035, release: 0.2, knee: 6, label: 'Gentle master glue' } : null;
  const gainDb = clamp(targetLufs - metrics.lufs, -10, 10);
  return { eq, compressor, gainDb, targetLufs, ceilingDb: -1 };
}

function prepareMastering() {
  if (!state.corrected) state.corrected = state.original;
  state.correctedMetrics = state.correctedMetrics || measureBuffer(state.corrected);
  state.masterPlan = buildMasterPlan(state.correctedMetrics, Number($('targetLufs').value));
  renderMetrics('correctedMetrics', state.correctedMetrics);
  renderMasterChain(state.masterPlan);
  reveal('masterPanel');
}

function renderMasterChain(plan) {
  const root = $('masterChain'); root.replaceChildren();
  const steps = [];
  for (const item of plan.eq) steps.push([item.label, describeOperation(item)]);
  if (plan.compressor) steps.push([plan.compressor.label, describeOperation(plan.compressor)]);
  steps.push(['Loudness gain', `${plan.gainDb >= 0 ? '+' : ''}${plan.gainDb.toFixed(1)} dB toward ${plan.targetLufs} LUFS`]);
  steps.push(['Look-ahead limiter', `${plan.ceilingDb.toFixed(1)} dBFS ceiling · linked stereo`]);
  for (const [label, value] of steps) {
    const row = document.createElement('div'); row.className = 'chain-item';
    const b = document.createElement('b'); b.textContent = label;
    const span = document.createElement('span'); span.textContent = value;
    row.append(b, span); root.append(row);
  }
}

async function renderPreLimitedMaster(buffer, plan) {
  if (!OfflineCtx) throw new Error('Offline audio rendering is not supported in this browser.');
  const off = new OfflineCtx(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  const src = off.createBufferSource(); src.buffer = buffer;
  let head = src;
  for (const op of plan.eq) { const node = makeFilter(off, op); head.connect(node); head = node; }
  if (plan.compressor) {
    const op = plan.compressor, comp = off.createDynamicsCompressor();
    comp.threshold.value = op.threshold; comp.ratio.value = op.ratio; comp.attack.value = op.attack; comp.release.value = op.release; comp.knee.value = op.knee;
    head.connect(comp); head = comp;
  }
  const gain = off.createGain(); gain.gain.value = dbToGain(plan.gainDb); head.connect(gain); head = gain;
  head.connect(off.destination); src.start();
  return off.startRendering();
}

function lookAheadLimit(buffer, ceilingDb = -1, lookaheadMs = 5, releaseMs = 90) {
  const ceiling = dbToGain(ceilingDb);
  const lookahead = Math.max(1, Math.floor(buffer.sampleRate * lookaheadMs / 1000));
  const releaseCoeff = Math.exp(-1 / Math.max(1, buffer.sampleRate * releaseMs / 1000));
  const out = cloneBuffer(buffer);
  const peakAt = (index) => {
    let peak = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) peak = Math.max(peak, Math.abs(buffer.getChannelData(c)[index]));
    return peak;
  };
  const capacity = lookahead + 3;
  const queue = new Int32Array(capacity);
  let qHead = 0, qTail = 0;
  const qGet = (position) => queue[position % capacity];
  const pushIndex = (index) => {
    const value = peakAt(index);
    while (qTail > qHead && peakAt(qGet(qTail - 1)) <= value) qTail--;
    queue[qTail % capacity] = index;
    qTail++;
  };
  for (let i = 0; i < Math.min(buffer.length, lookahead + 1); i++) pushIndex(i);
  let gain = 1;
  for (let i = 0; i < out.length; i++) {
    while (qTail > qHead && qGet(qHead) < i) qHead++;
    const futurePeak = qTail > qHead ? peakAt(qGet(qHead)) : peakAt(i);
    const desired = futurePeak > ceiling ? ceiling / futurePeak : 1;
    if (desired < gain) gain = desired;
    else gain = 1 - (1 - gain) * releaseCoeff;
    for (let c = 0; c < out.numberOfChannels; c++) out.getChannelData(c)[i] *= gain;
    const next = i + lookahead + 1;
    if (next < buffer.length) pushIndex(next);
  }
  return out;
}

async function renderReleaseMaster() {
  let rendered = await renderPreLimitedMaster(state.corrected, state.masterPlan);
  rendered = lookAheadLimit(rendered, state.masterPlan.ceilingDb);
  for (let pass = 0; pass < 2; pass++) {
    const metrics = measureBuffer(rendered);
    const error = state.masterPlan.targetLufs - metrics.lufs;
    if (Math.abs(error) < 0.35) break;
    const adjusted = cloneBuffer(rendered);
    const gain = dbToGain(clamp(error, -2.5, 2.5));
    for (let c = 0; c < adjusted.numberOfChannels; c++) {
      const data = adjusted.getChannelData(c);
      for (let i = 0; i < data.length; i++) data[i] *= gain;
    }
    rendered = lookAheadLimit(adjusted, state.masterPlan.ceilingDb);
    await sleep(0);
  }
  return rendered;
}

$('renderMasterBtn').addEventListener('click', async () => {
  $('renderMasterBtn').disabled = true;
  setStatus('masterStatus', 'Rendering tonal balance, dynamics, loudness and look-ahead limiting…', 'busy');
  try {
    state.master = await renderReleaseMaster();
    state.finalMetrics = measureBuffer(state.master);
    renderMetrics('finalMetrics', state.finalMetrics);
    renderVerification(state.finalMetrics, state.masterPlan);
    reveal('previewBox'); reveal('verifyPanel');
    setStatus('masterStatus', 'Release master rendered and measured again after limiting.', 'ok');
    $('verifyPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    console.error(error);
    setStatus('masterStatus', `Master render failed: ${error.message}`, 'error');
  } finally {
    $('renderMasterBtn').disabled = false;
  }
});

function renderVerification(metrics, plan) {
  const checks = [
    { ok: Math.abs(metrics.lufs - plan.targetLufs) <= 0.8, warn: Math.abs(metrics.lufs - plan.targetLufs) <= 1.5, label: 'Loudness target', detail: `${metrics.lufs.toFixed(1)} LUFS vs ${plan.targetLufs.toFixed(1)} LUFS target` },
    { ok: metrics.peakDb <= plan.ceilingDb + 0.08, warn: metrics.peakDb <= -0.5, label: 'Peak safety', detail: `${metrics.peakDb.toFixed(2)} dBFS sample peak; ceiling ${plan.ceilingDb.toFixed(1)} dBFS` },
    { ok: metrics.correlation >= 0.15, warn: metrics.correlation >= 0, label: 'Mono compatibility', detail: `Stereo correlation ${metrics.correlation.toFixed(2)}` },
    { ok: metrics.clipPercent === 0, warn: metrics.clipPercent < 0.001, label: 'Digital clipping', detail: `${metrics.clipPercent.toFixed(4)}% clipped frames` },
    { ok: metrics.crestDb >= 8, warn: metrics.crestDb >= 6, label: 'Transient preservation', detail: `Crest factor ${metrics.crestDb.toFixed(1)} dB` },
  ];
  const root = $('verificationList'); root.replaceChildren();
  for (const check of checks) {
    const row = document.createElement('div'); row.className = `check ${check.ok ? '' : check.warn ? 'warn' : 'fail'}`;
    const icon = document.createElement('b'); icon.textContent = check.ok ? '✓' : check.warn ? '!' : '×';
    const text = document.createElement('div');
    const strong = document.createElement('strong'); strong.textContent = `${check.label}: `;
    const detail = document.createTextNode(check.detail);
    text.append(strong, detail); row.append(icon, text); root.append(row);
  }
}

function currentPreviewBuffer() {
  const selected = document.querySelector('input[name="preview"]:checked')?.value;
  return selected === 'original' ? state.original : selected === 'corrected' ? state.corrected : state.master;
}

function stopPreview() {
  if (state.source) { try { state.source.stop(); } catch (_) {} try { state.source.disconnect(); } catch (_) {} state.source = null; }
  if (state.meterFrame) cancelAnimationFrame(state.meterFrame);
  state.meterFrame = null;
  if ($('playBtn')) $('playBtn').textContent = '▶ Play preview';
  if ($('meterFill')) $('meterFill').style.width = '0%';
}

async function playPreview() {
  if (state.source) { stopPreview(); return; }
  const buffer = currentPreviewBuffer();
  if (!buffer) return;
  const ctx = await ensureAudioContext();
  const source = ctx.createBufferSource(); source.buffer = buffer;
  const analyser = ctx.createAnalyser(); analyser.fftSize = 2048;
  source.connect(analyser); analyser.connect(ctx.destination);
  source.onended = stopPreview;
  source.start(); state.source = source; state.analyser = analyser;
  $('playBtn').textContent = '■ Stop preview';
  const meterData = new Float32Array(analyser.fftSize);
  const loop = () => {
    if (!state.source) return;
    analyser.getFloatTimeDomainData(meterData);
    let peak = 0;
    for (const sample of meterData) peak = Math.max(peak, Math.abs(sample));
    $('meterFill').style.width = `${clamp((gainToDb(peak) + 45) / 45 * 100, 0, 100)}%`;
    state.meterFrame = requestAnimationFrame(loop);
  };
  loop();
}

$('playBtn').addEventListener('click', playPreview);
document.addEventListener('change', (event) => { if (event.target.matches('input[name="preview"]')) stopPreview(); });
