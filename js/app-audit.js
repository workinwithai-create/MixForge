'use strict';
function fallbackMixAudit(metrics, notes, targetLufs) {
  const findings = [];
  const add = (severity, stage, problem, evidence, action, stem = null) => findings.push({ severity, stage, problem, evidence, action, stem });
  if (metrics.clipPercent > 0.001 || metrics.peakDb > -0.1) add('high', 'mix', 'Clipped or overloaded source', `${metrics.clipPercent.toFixed(3)}% of frames touch digital full scale; sample peak is ${metrics.peakDb.toFixed(2)} dBFS.`, 'Repairing distortion after the fact is limited. Lower the mix bus before export or use a clean pre-limiter bounce.');
  if (Math.abs(metrics.dcOffset) > 0.003) add('medium', 'mix', 'DC offset', `Average waveform offset is ${(metrics.dcOffset * 100).toFixed(2)}%.`, 'Remove DC before compression or limiting so the waveform has equal headroom in both directions.');
  const centerMud = band(metrics, 'Low-mids') - band(metrics, 'Mids');
  if (centerMud > 7) add('medium', 'mix', 'Center low-mid congestion', `Center low-mids are ${centerMud.toFixed(1)} dB above the mids.`, 'Inspect vocals, guitars/keys and bass separately instead of cutting the entire mix.', 'vocals');
  const presenceGap = band(metrics, 'Low-mids') - band(metrics, 'Presence');
  if (presenceGap > 14) add('medium', 'mix', 'Lead clarity is masked', `Center presence is ${presenceGap.toFixed(1)} dB below the low-mids.`, 'Isolate the vocal and determine whether it needs level, subtractive low-mid EQ, or presence EQ.', 'vocals');
  const subExcess = band(metrics, 'Sub') - band(metrics, 'Bass');
  if (subExcess > 2.5) add('medium', 'mix', 'Sub energy is consuming headroom', `Sub energy is ${subExcess.toFixed(1)} dB above the bass band.`, 'Inspect the bass stem before applying a broad master-bus cut.', 'bass');
  const sideMud = band(metrics, 'Low-mids', true) - band(metrics, 'Mids', true);
  if (sideMud > 8) add('medium', 'mix', 'Wide low-mid smear', `Side-channel low-mids are ${sideMud.toFixed(1)} dB above side mids.`, 'Inspect guitars, keys or ambience stems and clean the source of the width.', 'guitars');
  const sibDelta = metrics.sibilance.p95Db - metrics.sibilance.medianDb;
  if (metrics.sibilance.flares > metrics.sibilance.frames * 0.05 && sibDelta > 7) add('medium', 'mix', 'Sibilance or cymbal spikes', `${metrics.sibilance.flares} high-frequency flares rise ${sibDelta.toFixed(1)} dB above the normal top end.`, 'Separate vocals first; use dynamic de-essing only on the stem that creates the flare.', 'vocals');
  if (metrics.correlation < 0.15) add('high', 'mix', 'Mono compatibility risk', `Stereo correlation is ${metrics.correlation.toFixed(2)}.`, 'Inspect wide instruments and ambience stems for polarity or excessive decorrelation.', 'other');
  if (metrics.crestDb < 8) add('high', 'mix', 'Dynamics already over-controlled', `Crest factor is only ${metrics.crestDb.toFixed(1)} dB.`, 'Do not add mastering compression. Return to a less-limited mix if punch and transients are missing.');
  if (metrics.lra > 15) add('low', 'master', 'Very wide macro-dynamics', `Approximate loudness range is ${metrics.lra.toFixed(1)} LU.`, 'Use gentle automation or compression only if sections fail to translate consistently.');
  const stemsToInspect = [...new Set(findings.map((f) => f.stem).filter(Boolean))];
  if (!stemsToInspect.length && findings.some((f) => f.stage === 'mix')) stemsToInspect.push('other');
  const penalty = findings.reduce((sum, f) => sum + (f.severity === 'high' ? 18 : f.severity === 'medium' ? 10 : 5), 0);
  const readinessScore = clamp(Math.round(96 - penalty), 20, 98);
  const summary = findings.length
    ? `The mix has ${findings.filter((f) => f.stage === 'mix').length} corrective issue${findings.filter((f) => f.stage === 'mix').length === 1 ? '' : 's'} to address before mastering. The mastering stage should stay conservative until those source-level problems are repaired.`
    : 'No major source-level defects were detected. The song can move directly into conservative release mastering.';
  return { readinessScore, summary, findings, stemsToInspect, targetLufs, notes };
}

function validateAudit(value, fallback) {
  if (!value || typeof value !== 'object') return fallback;
  const findings = Array.isArray(value.findings) ? value.findings.slice(0, 12).map((f) => ({
    severity: ['high', 'medium', 'low'].includes(f.severity) ? f.severity : 'medium',
    stage: f.stage === 'master' ? 'master' : 'mix',
    problem: String(f.problem || 'Mix issue').slice(0, 120),
    evidence: String(f.evidence || '').slice(0, 400),
    action: String(f.action || '').slice(0, 500),
    stem: STEMS.includes(f.stem) ? f.stem : null,
  })) : fallback.findings;
  const stemsToInspect = [...new Set((Array.isArray(value.stemsToInspect) ? value.stemsToInspect : []).filter((s) => STEMS.includes(s)))];
  return {
    readinessScore: clamp(Number(value.readinessScore) || fallback.readinessScore, 0, 100),
    summary: String(value.summary || fallback.summary).slice(0, 700),
    findings,
    stemsToInspect: stemsToInspect.length ? stemsToInspect : fallback.stemsToInspect,
  };
}

async function requestAI(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35000);
  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || `AI request failed (${response.status})`);
    return data.plan;
  } finally {
    clearTimeout(timer);
  }
}

$('auditBtn').addEventListener('click', async () => {
  if (!state.original) return;
  $('auditBtn').disabled = true;
  setStatus('auditStatus', 'Measuring loudness, spectrum, dynamics, stereo field, clipping and translation risks…', 'busy');
  await sleep(30);
  try {
    const metrics = measureBuffer(state.original);
    state.mixMetrics = metrics;
    const notes = $('notes').value.trim();
    const targetLufs = Number($('targetLufs').value);
    const fallback = fallbackMixAudit(metrics, notes, targetLufs);
    let audit = fallback;
    try {
      const ai = await requestAI({ phase: 'mix', metrics, notes, targetLufs });
      audit = validateAudit(ai, fallback);
      setStatus('auditStatus', 'Audit complete. AI and measured evidence agree on the repair path.', 'ok');
    } catch (error) {
      console.warn('AI audit unavailable; using measured rule engine.', error);
      setStatus('auditStatus', 'Audit complete using the built-in measurement engine. The AI layer was unavailable, but the repair pipeline remains functional.', 'ok');
    }
    state.audit = audit;
    renderAudit(audit, metrics);
    reveal('auditPanel');
    $('auditPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    console.error(error);
    setStatus('auditStatus', `Audit failed: ${error.message}`, 'error');
  } finally {
    $('auditBtn').disabled = false;
  }
});

function renderMetrics(containerId, metrics) {
  const items = [
    ['LUFS', metrics.lufs.toFixed(1)],
    ['Sample peak', `${metrics.peakDb.toFixed(2)} dBFS`],
    ['Crest factor', `${metrics.crestDb.toFixed(1)} dB`],
    ['Loudness range', `${metrics.lra.toFixed(1)} LU`],
    ['Stereo correlation', metrics.correlation.toFixed(2)],
    ['Side / mid energy', `${metrics.widthDb.toFixed(1)} dB`],
  ];
  const root = $(containerId);
  root.replaceChildren(...items.map(([label, value]) => {
    const card = document.createElement('div'); card.className = 'metric';
    const b = document.createElement('b'); b.textContent = value;
    const span = document.createElement('span'); span.textContent = label;
    card.append(b, span); return card;
  }));
}

function renderAudit(audit, metrics) {
  $('readinessScore').textContent = Math.round(audit.readinessScore);
  $('auditSummary').textContent = audit.summary;
  renderMetrics('mixMetrics', metrics);
  const root = $('auditFindings');
  root.replaceChildren();
  for (const finding of audit.findings) {
    const card = document.createElement('article'); card.className = `finding ${finding.severity}`;
    const top = document.createElement('div'); top.className = 'finding-top';
    const title = document.createElement('h3'); title.textContent = finding.problem;
    const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = `${finding.stage}${finding.stem ? ` · ${finding.stem}` : ''}`;
    top.append(title, badge);
    const evidence = document.createElement('p'); evidence.textContent = finding.evidence;
    const action = document.createElement('p'); action.className = 'action'; action.textContent = `Fix: ${finding.action}`;
    card.append(top, evidence, action); root.append(card);
  }
  if (audit.stemsToInspect.length) {
    reveal('separateActions');
    $('stemListLabel').textContent = `Required: ${audit.stemsToInspect.join(', ')}`;
  } else {
    hide('separateActions');
    state.corrected = state.original;
    prepareMastering();
  }
}

async function uploadOriginal() {
  if (state.storagePath) return state.storagePath;
  if (!state.file) throw new Error('No source file is loaded.');
  const safeName = state.file.name.replace(/[^a-z0-9._-]/gi, '_').slice(-120) || 'mix.wav';
  const id = (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/[^a-z0-9-]/gi, '');
  const path = `uploads/${id}-${safeName}`;
  const response = await fetch(`${SUPA_URL}/storage/v1/object/audio/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPA_KEY}`,
      apikey: SUPA_KEY,
      'Content-Type': state.file.type || 'application/octet-stream',
      'x-upsert': 'false',
    },
    body: state.file,
  });
  if (!response.ok) throw new Error(`Private audio upload failed (${response.status}): ${(await response.text()).slice(0, 220)}`);
  state.storagePath = path;
  return path;
}

async function callStemFunction(body) {
  const response = await fetch(`${SUPA_URL}/functions/v1/separate-stem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SUPA_KEY}`, apikey: SUPA_KEY },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || `Stem service failed (${response.status})`);
  return data;
}

async function separateRequiredStems(stems, onProgress) {
  onProgress('Uploading the unreleased mix to private storage…');
  const storagePath = await uploadOriginal();
  onProgress(`Starting separation for ${stems.join(', ')}…`);
  const started = await callStemFunction({ action: 'start', storagePath, stems });
  for (let attempt = 0; attempt < 90; attempt++) {
    await sleep(2500);
    const status = await callStemFunction({ action: 'status', jobId: started.jobId, stems, storagePath });
    if (status.status === 'SUCCEEDED') return status.outputs;
    if (status.status === 'FAILED') throw new Error(status.error || 'The separation provider reported a failed job.');
    onProgress(`Separating stems… ${status.status || 'processing'} (${Math.min(99, Math.round((attempt + 1) / 90 * 100))}%)`);
  }
  throw new Error('Stem separation timed out. Try again with a shorter or lossless source file.');
}

$('separateBtn').addEventListener('click', async () => {
  const stems = state.audit?.stemsToInspect || [];
  if (!stems.length) return;
  $('separateBtn').disabled = true;
  setStatus('separationStatus', 'Preparing stem separation…', 'busy');
  try {
    const outputs = await separateRequiredStems(stems, (message) => setStatus('separationStatus', message, 'busy'));
    const ctx = await ensureAudioContext();
    for (const stem of stems) {
      const url = outputs?.[stem];
      if (!url) throw new Error(`The separation job did not return a ${stem} stem.`);
      setStatus('separationStatus', `Downloading and measuring ${stem}…`, 'busy');
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not download ${stem} (${response.status}).`);
      const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
      state.stemBuffers[stem] = buffer;
    }
    await buildStemPlans();
    renderStemPlans();
    reveal('stemPanel');
    $('stemPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    setStatus('separationStatus', 'Required stems are isolated and measured. Review the source-level repairs below.', 'ok');
  } catch (error) {
    console.error(error);
    setStatus('separationStatus', `Stem separation failed: ${error.message}`, 'error');
  } finally {
    $('separateBtn').disabled = false;
  }
});
