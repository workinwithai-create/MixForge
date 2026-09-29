'use strict';

(() => {
  const params = new URLSearchParams(location.search);
  if (params.get('crew-worker') !== '1') return;
  const localHost = location.hostname === '127.0.0.1' || location.hostname === 'localhost';
  if (!localHost) {
    document.body.textContent = 'Pipe Dreams Dream Mix worker only runs from the local launcher.';
    return;
  }

  const CREW_API = 'https://czzjjssjxiusbjfqvgnj.supabase.co/functions/v1/crew-worker';
  let token = '';
  let stopped = false;

  const panel = document.createElement('section');
  panel.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#0d0f12;color:#f2eee6;padding:32px;font:15px/1.5 system-ui;overflow:auto';
  panel.innerHTML = '<div style="max-width:720px;margin:auto"><p style="letter-spacing:.16em;color:#c89b68">PIPE DREAMS · DREAM MIX</p><h1>MixForge Crew Worker</h1><p id="crewWorkerStatus">Starting local worker…</p><pre id="crewWorkerLog" style="white-space:pre-wrap;color:#aab6ae;background:#111;padding:16px;border-radius:12px"></pre></div>';
  document.body.append(panel);
  const status = panel.querySelector('#crewWorkerStatus');
  const logNode = panel.querySelector('#crewWorkerLog');

  function log(message) {
    const stamp = new Date().toLocaleTimeString();
    logNode.textContent = ('[' + stamp + '] ' + message + '\n' + logNode.textContent).slice(0, 8000);
  }

  async function localToken() {
    const response = await fetch('/__crew_token', { cache: 'no-store' });
    if (!response.ok) throw new Error('Local Dream Mix token is unavailable.');
    const data = await response.json();
    if (!data.token) throw new Error('Local Dream Mix token is missing.');
    return data.token;
  }

  async function crew(payload) {
    const response = await fetch(CREW_API, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || ('Crew API HTTP ' + response.status));
    return data;
  }

  function overlap(aStart, aEnd, bStart, bEnd) {
    return Math.max(aStart, bStart) < Math.min(aEnd, bEnd);
  }

  async function loadJobAudio(job) {
    const response = await fetch(job.inputUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not download current song audio.');
    const blob = await response.blob();
    const suffix = blob.type === 'audio/flac' ? '.flac' : '.wav';
    const file = new File([blob], 'pipe-dreams-current' + suffix, { type: blob.type || 'audio/wav' });
    await loadFile(file);
    if (!state.original) throw new Error('MixForge could not decode the current song.');
    return state.original;
  }

  async function renderJob(job) {
    const source = await loadJobAudio(job);
    state.masterPlan = { ceilingDb: -1.2, truePeakCeilingDb: -1.0 };
    const beforeAnalysis = await mfTimelineAnalyze(source);
    const requestedType = job.plan?.repairType;
    const region = job.region || {};
    const plan = mfTargetBuildPlanFromAnalysis(beforeAnalysis);
    const selected = plan.filter(item =>
      item.operation
      && item.marker?.type === requestedType
      && overlap(Number(item.marker.start), Number(item.marker.end), Number(region.start), Number(region.end))
    );

    if (!selected.length) {
      throw new Error('MixForge measurements did not confirm ' + String(requestedType || 'that repair') + ' inside the Producer-marked region.');
    }

    const beforeMetrics = measureBuffer(source);
    const candidate = await mfTargetRenderCandidate(source, selected);
    const afterMetrics = measureBuffer(candidate);
    const afterAnalysis = await mfTimelineAnalyze(candidate);
    const evaluation = mfTargetEvaluateCandidate(beforeAnalysis, afterAnalysis, beforeMetrics, afterMetrics, state.masterPlan);

    if (!evaluation.accepted) {
      throw new Error('MixForge blocked the candidate: ' + (evaluation.reasons.join('; ') || 'measured safeguards did not improve.'));
    }

    const wav = await encodeWav(candidate, 24);
    const upload = await fetch(job.upload.signedUrl, {
      method: 'PUT',
      headers: { 'content-type': 'audio/wav', 'cache-control': 'max-age=3600', 'x-upsert': 'false' },
      body: wav,
    });
    if (!upload.ok) throw new Error('Could not upload Dream Mix proposal (HTTP ' + upload.status + ').');

    const typeLabel = String(requestedType).replaceAll('_', ' ');
    return 'Dream Mix measured and rendered a bounded ' + typeLabel + ' repair. Problem load ' + evaluation.beforeLoad.toFixed(1) + ' → ' + evaluation.afterLoad.toFixed(1) + '; MixForge safety checks passed.';
  }

  async function handleOne() {
    const response = await crew({ action: 'next' });
    const job = response.job;
    if (!job) return false;
    status.textContent = 'Working on a private MixForge proposal…';
    log('Claimed Crew order ' + job.id);
    try {
      const summary = await renderJob(job);
      await crew({ action: 'complete', orderId: job.id, artifactId: job.artifactId, summary });
      log('Proposal ready for A/B review: ' + job.id);
      status.textContent = 'Proposal returned to Your Crew for approval.';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await crew({ action: 'complete', orderId: job.id, artifactId: job.artifactId, error: message });
      } catch (_) {}
      log('Blocked/failed ' + job.id + ': ' + message);
      status.textContent = 'MixForge refused or failed this pass. The current recording is unchanged.';
    }
    return true;
  }

  async function loop() {
    try {
      token = await localToken();
      await crew({ action: 'ping' });
      status.textContent = 'Dream Mix connected. Waiting for Crew work…';
      log('Worker authenticated as Dream Mix.');
      while (!stopped) {
        const worked = await handleOne();
        await new Promise(resolve => setTimeout(resolve, worked ? 1000 : 6000));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status.textContent = 'Dream Mix worker stopped: ' + message;
      log(message);
    }
  }

  addEventListener('beforeunload', () => { stopped = true; });
  void loop();
})();

