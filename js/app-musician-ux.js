'use strict';

// MixForge 2.4 musician UX layer.
// Dual-path productization: Quick Master (stereo release master) vs Forensic Fix
// (opt-in stem investigation). Keeps the evidence-first thesis; does not gate
// billing here — Hub entitlements are stubbed for a follow-up.

const MF_DEMUCS_STEMS = new Set(['vocals', 'bass', 'drums', 'other']);
const MF_STEM_ALIASES = { guitars: 'other', keys: 'other' };
const MF_STEM_DISPLAY = {
  vocals: 'Vocals',
  bass: 'Bass',
  drums: 'Drums',
  other: 'Other residual (guitars / keys / ambience)',
  guitars: 'Other residual (requested as guitars)',
  keys: 'Other residual (requested as keys)',
};

// TODO(hub): Replace with workinwithai-hub OAuth + Stripe entitlement checks.
// Hub prices MixForge at $9/mo or Forge Pass $24; this app is still ungated.
const MixForgeHub = {
  product: 'mixforge',
  pricing: { mixforgeMonthly: 9, forgePassMonthly: 24 },
  features: { quickMaster: true, forensicStems: true, export: true },
  requireEntitlement(feature) {
    // TODO(hub): return { ok:false, reason:'login'|'subscribe', redirectUrl } when gated.
    return { ok: true, feature, reason: 'ungated-preview' };
  },
};
if (typeof globalThis !== 'undefined') globalThis.MixForgeHub = MixForgeHub;

function mfRecommendPath(audit) {
  const readiness = clamp(Number(audit?.readinessScore) || 0, 0, 100);
  const stems = Array.isArray(audit?.stemsToInspect) ? audit.stemsToInspect : [];
  const findings = Array.isArray(audit?.findings) ? audit.findings : [];
  const highMix = findings.filter((finding) => finding.severity === 'high' && finding.stage === 'mix');
  const isolationNeeded = stems.length > 0 && (highMix.length > 0 || readiness < 70);

  if (!stems.length || readiness >= 78) {
    return {
      path: 'quick',
      label: 'Quick Master',
      reason: readiness >= 78
        ? 'Stereo readiness is already high — hear a release master first, then decide if isolation is worth it.'
        : 'No stem isolation is required from the stereo evidence. Master the mix directly and A/B the result.',
    };
  }
  if (isolationNeeded) {
    return {
      path: 'forensic',
      label: 'Forensic Fix',
      reason: 'Measured mix problems still need isolation before a confident repair. Stem separation is optional and costs quota time.',
    };
  }
  return {
    path: 'quick',
    label: 'Quick Master',
    reason: 'You can hear a useful stereo master now. Open Forensic Fix only if you want to isolate remaining hypotheses.',
  };
}

function mfNormalizeDemucsStems(requested) {
  const input = Array.isArray(requested) ? requested : [];
  const stems = [];
  const routes = [];
  for (const raw of input) {
    const requestedStem = String(raw || '');
    if (!requestedStem) continue;
    const actual = MF_STEM_ALIASES[requestedStem] || requestedStem;
    if (!MF_DEMUCS_STEMS.has(actual)) continue;
    if (!stems.includes(actual)) stems.push(actual);
    routes.push({
      requested: requestedStem,
      actual,
      honest: actual === requestedStem
        ? MF_STEM_DISPLAY[actual] || actual
        : `${requestedStem} → Demucs “other” (no separate guitar/keys stem)`,
    });
  }
  return { stems, routes };
}

function mfStemJobFraming(stems, durationSec = 0) {
  const count = Math.max(1, (stems || []).length);
  const minutes = Math.max(2, Math.round((Number(durationSec) || 180) / 90) + (count > 2 ? 2 : 1));
  return {
    etaLabel: `About ${minutes}–${minutes + 4} min (GPU may cold-start)`,
    costLabel: 'Uses stem-separation quota · not required for Quick Master',
    escapeLabel: 'Skip stems / master stereo only',
  };
}

function mfEstimateReadiness(metrics, findingsCount = 0) {
  if (!metrics) return null;
  let score = 92;
  if (metrics.peakDb > -0.2) score -= 18;
  if (metrics.clipPercent > 0.001) score -= 20;
  if (metrics.correlation < 0.15) score -= 16;
  if (metrics.crestDb < 8) score -= 14;
  if (Math.abs((metrics.lufs || -12) + 12) > 3) score -= 6;
  score -= clamp(findingsCount * 4, 0, 24);
  return clamp(Math.round(score), 20, 98);
}

function mfPlainWhatChanged(before, after, plan, path = 'quick', options = {}) {
  if (!before || !after) return { headline: 'No master yet.', bullets: [], remaining: [] };
  const lufsDelta = after.lufs - before.lufs;
  const peakBefore = options.truePeakBefore ?? before.peakDb;
  const peakAfter = options.truePeakAfter ?? after.peakDb;
  const readinessBefore = options.readinessBefore ?? mfEstimateReadiness(before, options.findingsCount || 0);
  const readinessAfter = options.readinessAfter ?? mfEstimateReadiness(after, options.remainingRisks?.length || 0);
  const bullets = [
    `Loudness ${before.lufs.toFixed(1)} → ${after.lufs.toFixed(1)} LUFS (${lufsDelta >= 0 ? '+' : ''}${lufsDelta.toFixed(1)}).`,
    `True peak / sample peak ${peakBefore.toFixed(2)} → ${peakAfter.toFixed(2)} dB (ceiling ${Number(plan?.truePeakCeilingDb ?? plan?.ceilingDb ?? -1).toFixed(1)}).`,
    `Release readiness ${readinessBefore} → ${readinessAfter}.`,
    path === 'quick'
      ? 'Quick Master applied stereo-only release processing — no stem separation.'
      : 'Forensic path rebuilt from measured stem repairs, then mastered.',
  ];
  if (plan?.eq?.length) bullets.push(`Tonal moves: ${plan.eq.map((item) => item.label).join('; ')}.`);
  else bullets.push('Tonal balance: no broad EQ was justified by the measurements.');
  if (plan?.compressor) bullets.push(`Dynamics: ${plan.compressor.label}.`);
  else bullets.push('Dynamics: no master compression (source already controlled or not justified).');
  const remaining = Array.isArray(options.remainingRisks) ? options.remainingRisks : [];
  return {
    headline: path === 'quick'
      ? 'What changed on Quick Master'
      : 'What changed after Forensic Fix + master',
    bullets,
    remaining,
    readinessBefore,
    readinessAfter,
  };
}

function mfBuildReadinessReportText(payload) {
  const lines = [];
  lines.push('MixForge release readiness report');
  lines.push('================================');
  lines.push(`File: ${payload.fileName || 'mix'}`);
  lines.push(`Path: ${payload.pathLabel || payload.path || 'unknown'}`);
  lines.push(`Generated: ${payload.generatedAt || new Date().toISOString()}`);
  lines.push('');
  lines.push('Before');
  lines.push(`- LUFS: ${payload.before?.lufs?.toFixed?.(1) ?? '—'}`);
  lines.push(`- Peak: ${payload.before?.peakDb?.toFixed?.(2) ?? '—'} dBFS`);
  lines.push(`- Readiness: ${payload.readinessBefore ?? '—'}`);
  lines.push('');
  lines.push('After');
  lines.push(`- LUFS: ${payload.after?.lufs?.toFixed?.(1) ?? '—'}`);
  lines.push(`- Peak: ${payload.after?.peakDb?.toFixed?.(2) ?? '—'} dBFS`);
  lines.push(`- True peak: ${payload.truePeakAfter?.toFixed?.(2) ?? '—'} dBTP`);
  lines.push(`- Readiness: ${payload.readinessAfter ?? '—'}`);
  lines.push('');
  lines.push('What changed');
  for (const bullet of payload.bullets || []) lines.push(`- ${bullet}`);
  lines.push('');
  lines.push('Remaining risks');
  if (payload.remaining?.length) {
    for (const risk of payload.remaining) lines.push(`- ${risk}`);
  } else {
    lines.push('- No outstanding marker risks listed.');
  }
  lines.push('');
  lines.push('Seat: MixForge = mix repair + release master. Vocals-as-product live in AuraMix.');
  lines.push('Thesis: evidence-first, conservative repairs, prove the master improved.');
  return `${lines.join('\n')}\n`;
}

function mfMusicianEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

function mfEnsureMusicianMounts() {
  if (typeof document === 'undefined') return;
  const auditPanel = $('auditPanel');
  if (auditPanel && !$('pathChooser')) {
    const chooser = mfMusicianEl('section', 'path-chooser hidden');
    chooser.id = 'pathChooser';
    chooser.setAttribute('aria-live', 'polite');
    const separate = $('separateActions');
    if (separate) auditPanel.insertBefore(chooser, separate);
    else auditPanel.append(chooser);
  }

  if ($('separateActions') && !$('stemConsent')) {
    const consent = mfMusicianEl('div', 'stem-consent hidden');
    consent.id = 'stemConsent';
    $('separateActions').before(consent);
  }

  const preview = $('previewBox');
  if (preview && !$('abToggleBar')) {
    const bar = mfMusicianEl('div', 'ab-toggle-bar');
    bar.id = 'abToggleBar';
    bar.innerHTML = `
      <div class="ab-toggle-group" role="group" aria-label="A/B preview">
        <button type="button" class="ab-btn" data-ab="original" id="abOriginalBtn">A · Original</button>
        <button type="button" class="ab-btn active" data-ab="matched" id="abMasterBtn">B · Master (matched)</button>
      </div>
      <p class="ab-hint">Press <kbd>B</kbd> to A/B · <kbd>Space</kbd> play/pause · level-matched so louder ≠ better</p>`;
    preview.insertBefore(bar, preview.firstChild);
  }

  const verify = $('verifyPanel');
  if (verify && !$('whatChanged')) {
    const box = mfMusicianEl('section', 'what-changed hidden');
    box.id = 'whatChanged';
    const actions = verify.querySelector('.actions');
    if (actions) verify.insertBefore(box, actions);
    else verify.append(box);
  }

  if ($('exportBtn') && !$('readinessReportBtn')) {
    const reportBtn = document.createElement('button');
    reportBtn.type = 'button';
    reportBtn.className = 'secondary';
    reportBtn.id = 'readinessReportBtn';
    reportBtn.textContent = 'Download readiness report';
    $('exportBtn').after(reportBtn);
  }
}

function mfRenderPathChooser(audit) {
  const root = $('pathChooser');
  if (!root) return;
  const recommendation = mfRecommendPath(audit);
  state.mixforgeRecommendation = recommendation;
  root.classList.remove('hidden');
  root.replaceChildren();

  const head = mfMusicianEl('div', 'path-chooser-head');
  head.append(
    mfMusicianEl('h3', '', 'Choose your first path'),
    mfMusicianEl('p', '', `${recommendation.label} recommended. ${recommendation.reason}`),
  );
  root.append(head);

  const grid = mfMusicianEl('div', 'path-grid');
  const quick = mfMusicianEl('button', `path-card${recommendation.path === 'quick' ? ' recommended' : ''}`);
  quick.type = 'button';
  quick.id = 'quickMasterPathBtn';
  quick.innerHTML = `<strong>Quick Master</strong><span>Drop mix → hear Original vs Master fast. Stereo-only release processing. No stem separation.</span><em>${recommendation.path === 'quick' ? 'Suggested for this mix' : 'Available now'}</em>`;
  const forensic = mfMusicianEl('button', `path-card${recommendation.path === 'forensic' ? ' recommended' : ''}`);
  forensic.type = 'button';
  forensic.id = 'forensicPathBtn';
  forensic.innerHTML = `<strong>Forensic Fix</strong><span>Timeline windows → honest stem investigation → targeted repair → verify. Opt-in; not required for a first A/B.</span><em>${recommendation.path === 'forensic' ? 'Suggested when isolation is needed' : 'Deeper path'}</em>`;
  grid.append(quick, forensic);
  root.append(grid);

  const seat = mfMusicianEl('p', 'path-seat');
  seat.textContent = 'MixForge fixes mix problems, then masters for release. Dedicated vocal production lives in AuraMix.';
  root.append(seat);

  quick.onclick = () => { void mfStartQuickMaster(); };
  forensic.onclick = () => { mfStartForensicPath(); };
}

function mfHideStemUi() {
  hide('separateActions');
  if ($('stemConsent')) $('stemConsent').classList.add('hidden');
}

async function mfStartQuickMaster() {
  const gate = MixForgeHub.requireEntitlement('quickMaster');
  if (!gate.ok) {
    setStatus('auditStatus', `Quick Master needs Hub access (${gate.reason}).`, 'error');
    return;
  }
  state.mixforgePath = 'quick';
  mfHideStemUi();
  if ($('pathChooser')) {
    $('pathChooser').querySelectorAll('.path-card').forEach((card) => card.classList.remove('active'));
    $('quickMasterPathBtn')?.classList.add('active');
  }
  setStatus('auditStatus', 'Quick Master: rendering a stereo release master for A/B…', 'busy');
  state.corrected = state.original;
  state.correctedMetrics = state.mixMetrics || measureBuffer(state.original);
  prepareMastering();
  $('masterPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    $('renderMasterBtn').disabled = true;
    setStatus('masterStatus', 'Quick Master rendering tonal balance, loudness, and true-peak-safe limiting…', 'busy');
    state.master = await renderReleaseMaster();
    state.finalMetrics = measureBuffer(state.master);
    renderMetrics('finalMetrics', state.finalMetrics);
    renderVerification(state.finalMetrics, state.masterPlan);
    reveal('previewBox');
    reveal('verifyPanel');
    mfSelectAbPreview('matched');
    mfRenderWhatChanged();
    setStatus('masterStatus', 'Quick Master ready — A/B Original vs Master below.', 'ok');
    setStatus('auditStatus', 'Quick Master complete. Press B to flip A/B while listening.', 'ok');
    $('previewBox')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) {
    console.error(error);
    setStatus('masterStatus', `Quick Master failed: ${error.message}`, 'error');
    setStatus('auditStatus', `Quick Master failed: ${error.message}`, 'error');
  } finally {
    $('renderMasterBtn').disabled = false;
  }
}

function mfStartForensicPath() {
  const gate = MixForgeHub.requireEntitlement('forensicStems');
  if (!gate.ok) {
    setStatus('auditStatus', `Forensic Fix needs Hub access (${gate.reason}).`, 'error');
    return;
  }
  state.mixforgePath = 'forensic';
  if ($('pathChooser')) {
    $('pathChooser').querySelectorAll('.path-card').forEach((card) => card.classList.remove('active'));
    $('forensicPathBtn')?.classList.add('active');
  }

  const normalized = mfNormalizeDemucsStems(state.audit?.stemsToInspect || []);
  state.audit = {
    ...(state.audit || {}),
    stemsToInspect: normalized.stems.length ? normalized.stems : ['other'],
    stemRoutes: normalized.routes,
  };
  mfRenderStemConsent(state.audit);
  reveal('separateActions');
  $('stemListLabel').textContent = normalized.routes.length
    ? `Honest Demucs routes: ${normalized.routes.map((route) => route.honest).join(' · ')}`
    : 'Stereo residual investigation';
  setStatus('auditStatus', 'Forensic path armed. Review stem cost/ETA, or skip to Quick Master.', 'ok');
  $('stemConsent')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function mfRenderStemConsent(audit) {
  const root = $('stemConsent');
  if (!root) return;
  const stems = audit?.stemsToInspect || [];
  const framing = mfStemJobFraming(stems, state.original?.duration || 0);
  root.classList.remove('hidden');
  root.replaceChildren();
  root.append(mfMusicianEl('h3', '', 'Before source investigation'));
  root.append(mfMusicianEl('p', '', 'Demucs htdemucs returns vocals, bass, drums, and one residual “other” bucket. Guitars and keys are not separate confirmable stems — they land in other.'));
  const meta = mfMusicianEl('div', 'stem-consent-meta');
  meta.innerHTML = `<span>${framing.etaLabel}</span><span>${framing.costLabel}</span>`;
  root.append(meta);
  if (audit?.stemRoutes?.length) {
    const list = mfMusicianEl('ul', 'stem-route-list');
    for (const route of audit.stemRoutes) {
      const item = document.createElement('li');
      item.textContent = route.honest;
      list.append(item);
    }
    root.append(list);
  }
  const actions = mfMusicianEl('div', 'stem-consent-actions');
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'secondary';
  skip.id = 'skipStemsBtn';
  skip.textContent = framing.escapeLabel;
  skip.onclick = () => { void mfStartQuickMaster(); };
  actions.append(skip);
  root.append(actions);
  root.append(mfMusicianEl('small', '', 'Extraction integrity is graded after separation, before any repair is applied.'));
}

function mfSelectAbPreview(value) {
  const preferred = value === 'matched' && $('mfMatchedPreview') ? 'matched' : value === 'master' ? 'master' : value;
  const input = document.querySelector(`input[name="preview"][value="${preferred}"]`)
    || document.querySelector(`input[name="preview"][value="master"]`);
  if (input) {
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  document.querySelectorAll('.ab-btn').forEach((button) => {
    const target = button.getAttribute('data-ab');
    const active = (preferred === 'matched' || preferred === 'master')
      ? target === 'matched' || target === 'master'
      : target === preferred;
    button.classList.toggle('active', active);
  });
}

function mfToggleAbPreview() {
  const selected = document.querySelector('input[name="preview"]:checked')?.value;
  const onMaster = selected === 'master' || selected === 'matched';
  mfSelectAbPreview(onMaster ? 'original' : ($('mfMatchedPreview') ? 'matched' : 'master'));
}

function mfRenderWhatChanged() {
  const root = $('whatChanged');
  if (!root || !state.mixMetrics || !state.finalMetrics) return;
  const remaining = [];
  if (state.timelineSelfCheck?.remaining?.length) {
    for (const type of state.timelineSelfCheck.remaining) remaining.push(String(type).replaceAll('_', ' '));
  }
  if (state.audit?.findings?.some((finding) => finding.severity === 'high')) {
    remaining.push('High-severity stereo findings may still need Forensic Fix if the A/B is not enough.');
  }
  const summary = mfPlainWhatChanged(state.mixMetrics, state.finalMetrics, state.masterPlan, state.mixforgePath || 'quick', {
    truePeakBefore: state.mixMetrics.peakDb,
    truePeakAfter: state.masterConstraint?.truePeakDb ?? state.finalMetrics.peakDb,
    readinessBefore: state.audit?.readinessScore,
    findingsCount: state.audit?.findings?.length || 0,
    remainingRisks: remaining,
  });
  state.mixforgeWhatChanged = summary;
  root.classList.remove('hidden');
  root.replaceChildren();
  root.append(mfMusicianEl('h3', '', summary.headline));
  const list = mfMusicianEl('ul', 'what-changed-list');
  for (const bullet of summary.bullets) list.append(Object.assign(document.createElement('li'), { textContent: bullet }));
  root.append(list);
  if (summary.remaining.length) {
    root.append(mfMusicianEl('p', 'what-changed-remaining', `Still watch: ${summary.remaining.join('; ')}.`));
  } else {
    root.append(mfMusicianEl('p', 'what-changed-remaining', 'No major remaining marker risks listed after verification.'));
  }
}

function mfDownloadReadinessReport() {
  const gate = MixForgeHub.requireEntitlement('export');
  if (!gate.ok) {
    setStatus('exportStatus', `Report download needs Hub access (${gate.reason}).`, 'error');
    return;
  }
  const summary = state.mixforgeWhatChanged || mfPlainWhatChanged(
    state.mixMetrics,
    state.finalMetrics,
    state.masterPlan,
    state.mixforgePath || 'quick',
    { remainingRisks: state.timelineSelfCheck?.remaining || [] },
  );
  const text = mfBuildReadinessReportText({
    fileName: state.file?.name,
    path: state.mixforgePath,
    pathLabel: state.mixforgePath === 'forensic' ? 'Forensic Fix' : 'Quick Master',
    before: state.mixMetrics,
    after: state.finalMetrics,
    truePeakAfter: state.masterConstraint?.truePeakDb,
    readinessBefore: summary.readinessBefore ?? state.audit?.readinessScore,
    readinessAfter: summary.readinessAfter,
    bullets: summary.bullets,
    remaining: summary.remaining,
    generatedAt: new Date().toISOString(),
  });
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const base = (state.file?.name || 'mix').replace(/\.[^.]+$/, '').replace(/[^a-z0-9._-]/gi, '_');
  anchor.href = url;
  anchor.download = `${base}-mixforge-readiness.txt`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  setStatus('exportStatus', 'Readiness report downloaded.', 'ok');
}

function mfInstallMusicianKeyboard() {
  document.addEventListener('keydown', (event) => {
    const tag = (event.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || event.target?.isContentEditable) return;
    if ($('previewBox')?.classList.contains('hidden')) return;
    if (event.code === 'KeyB' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      mfToggleAbPreview();
      return;
    }
    if (event.code === 'Space' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      if (typeof toggleTransport === 'function') void toggleTransport();
      else if ($('playBtn')) $('playBtn').click();
    }
  });
}

function mfInstallMusicianUi() {
  mfEnsureMusicianMounts();
  mfInstallMusicianKeyboard();

  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('.ab-btn');
    if (!button) return;
    mfSelectAbPreview(button.getAttribute('data-ab'));
  });

  $('readinessReportBtn')?.addEventListener('click', mfDownloadReadinessReport);

  const previousRenderAudit = renderAudit;
  renderAudit = function renderAuditMusicianPath(audit, metrics) {
    const normalized = mfNormalizeDemucsStems(audit?.stemsToInspect || []);
    const patched = {
      ...audit,
      stemsToInspect: normalized.stems,
      stemRoutes: normalized.routes,
    };
    state.audit = patched;
    previousRenderAudit(patched, metrics);
    // Path chooser owns the next step — never surprise the musician with stems
    // or an auto-opened master panel before they pick Quick Master vs Forensic.
    hide('separateActions');
    if ($('stemConsent')) $('stemConsent').classList.add('hidden');
    hide('masterPanel');
    hide('stemPanel');
    hide('verifyPanel');
    state.corrected = null;
    state.master = null;
    state.masterPlan = null;
    mfRenderPathChooser(patched);
  };

  const previousSeparateRequiredStems = separateRequiredStems;
  separateRequiredStems = async function separateRequiredStemsHonest(stems, onProgress) {
    const normalized = mfNormalizeDemucsStems(stems);
    if (state.audit) state.audit.stemRoutes = normalized.routes;
    onProgress?.(`Honest Demucs mapping: ${normalized.routes.map((route) => route.honest).join('; ') || normalized.stems.join(', ')}`);
    return previousSeparateRequiredStems(normalized.stems, onProgress);
  };

  const previousRenderStemPlans = renderStemPlans;
  renderStemPlans = function renderStemPlansHonest() {
    previousRenderStemPlans();
    for (const card of document.querySelectorAll('#stemGrid .stem-card h3')) {
      const key = (card.textContent || '').trim().toLowerCase();
      if (MF_STEM_DISPLAY[key]) card.textContent = MF_STEM_DISPLAY[key];
    }
    const grid = $('stemGrid');
    if (grid && !$('extractionIntegrityNote')) {
      const note = mfMusicianEl('p', 'extraction-integrity-note');
      note.id = 'extractionIntegrityNote';
      note.textContent = 'Extraction integrity is graded per stem above. Demucs cannot confirm guitars or keys separately — residual content is labeled Other.';
      grid.prepend(note);
    }
  };

  const previousRenderVerification = renderVerification;
  renderVerification = function renderVerificationMusician(metrics, plan) {
    previousRenderVerification(metrics, plan);
    mfRenderWhatChanged();
  };

  const previousResetResults = resetResults;
  resetResults = function resetResultsMusician(...args) {
    previousResetResults(...args);
    state.mixforgePath = null;
    state.mixforgeWhatChanged = null;
    state.mixforgeRecommendation = null;
    if ($('pathChooser')) {
      $('pathChooser').classList.add('hidden');
      $('pathChooser').replaceChildren();
    }
    if ($('stemConsent')) {
      $('stemConsent').classList.add('hidden');
      $('stemConsent').replaceChildren();
    }
    if ($('whatChanged')) {
      $('whatChanged').classList.add('hidden');
      $('whatChanged').replaceChildren();
    }
  };

  // Soften engineer-only hero if the static HTML was cached with older copy.
  const heroCopy = document.querySelector('.hero p');
  if (heroCopy && /Observe the stereo evidence/i.test(heroCopy.textContent || '')) {
    heroCopy.textContent = 'Fix mix problems, then master for release. Start with Quick Master for a fast Original vs Master A/B — or open Forensic Fix when you need timeline evidence and honest stem investigation.';
  }
  const seat = document.querySelector('.hero .pipeline');
  if (seat && !$('heroModeRow')) {
    const modes = mfMusicianEl('div', 'hero-modes');
    modes.id = 'heroModeRow';
    modes.innerHTML = '<span>Quick Master</span><b>or</b><span>Forensic Fix</span><i>Mix repair + release master · vocals live in AuraMix</i>';
    seat.after(modes);
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.mfRecommendPath = mfRecommendPath;
  globalThis.mfNormalizeDemucsStems = mfNormalizeDemucsStems;
  globalThis.mfStemJobFraming = mfStemJobFraming;
  globalThis.mfPlainWhatChanged = mfPlainWhatChanged;
  globalThis.mfBuildReadinessReportText = mfBuildReadinessReportText;
  globalThis.mfEstimateReadiness = mfEstimateReadiness;
}

if (typeof document !== 'undefined' && typeof $ === 'function') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mfInstallMusicianUi);
  else mfInstallMusicianUi();
}
