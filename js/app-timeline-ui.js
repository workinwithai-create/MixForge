'use strict';

function mfTimelineTypeLabel(type) {
  return MF_TIMELINE_TYPES[type]?.label || String(type).replaceAll('_', ' ');
}

function mfTimelineRender(analysis, rootId = 'problemTimeline') {
  if (typeof document === 'undefined') return;
  const root = document.getElementById(rootId);
  if (!root) return;
  root.replaceChildren();

  const heading = document.createElement('div');
  heading.className = 'timeline-heading';
  const titleBox = document.createElement('div');
  const title = document.createElement('h3');
  title.textContent = 'Problem Timeline';
  const subtitle = document.createElement('p');
  subtitle.textContent = analysis.markers.length
    ? `${analysis.markers.length} time-bounded risk${analysis.markers.length === 1 ? '' : 's'} found. Audition the exact evidence before approving a repair.`
    : 'No time-bounded clipping, mono, harshness, sub-bass, sibilance, or loudness-dip marker crossed the conservative thresholds.';
  titleBox.append(title, subtitle);
  const badge = document.createElement('span');
  badge.className = `timeline-health ${analysis.markers.length ? 'attention' : 'clear'}`;
  badge.textContent = analysis.markers.length ? `${analysis.markers.length} markers` : 'clear';
  heading.append(titleBox, badge);
  root.append(heading);

  const track = document.createElement('div');
  track.className = 'timeline-track';
  track.setAttribute('aria-label', 'Song problem timeline');
  const duration = Math.max(analysis.duration || 0, 0.001);
  for (let index = 0; index < analysis.markers.length; index++) {
    const marker = analysis.markers[index];
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = `timeline-pin ${marker.severity} type-${marker.type}`;
    pin.style.left = `${mfTimelineClamp(marker.start / duration * 100, 0, 100)}%`;
    pin.style.width = `${mfTimelineClamp((marker.end - marker.start) / duration * 100, 0.7, 100)}%`;
    pin.dataset.timelineMarker = String(index);
    pin.title = `${mfTimelineTypeLabel(marker.type)} · ${mfTimelineFormatTime(marker.start)}–${mfTimelineFormatTime(marker.end)}`;
    pin.setAttribute('aria-label', pin.title);
    track.append(pin);
  }
  const ticks = document.createElement('div');
  ticks.className = 'timeline-ticks';
  ticks.innerHTML = `<span>0:00</span><span>${mfTimelineFormatTime(duration / 2)}</span><span>${mfTimelineFormatTime(duration)}</span>`;
  root.append(track, ticks);

  if (!analysis.markers.length) return;
  const list = document.createElement('div');
  list.className = 'timeline-list';
  for (let index = 0; index < Math.min(14, analysis.markers.length); index++) {
    const marker = analysis.markers[index];
    const row = document.createElement('article');
    row.className = `timeline-marker ${marker.severity}`;
    const time = document.createElement('button');
    time.type = 'button';
    time.className = 'timeline-time';
    time.dataset.timelineMarker = String(index);
    time.textContent = `▶ ${mfTimelineFormatTime(marker.start)}–${mfTimelineFormatTime(marker.end)}`;
    const copy = document.createElement('div');
    const markerTitle = document.createElement('strong');
    markerTitle.textContent = mfTimelineTypeLabel(marker.type);
    const evidence = document.createElement('span');
    evidence.textContent = marker.evidence;
    copy.append(markerTitle, evidence);
    const severity = document.createElement('i');
    severity.textContent = marker.severity;
    row.append(time, copy, severity);
    list.append(row);
  }
  root.append(list);
  root.onclick = (event) => {
    const button = event.target.closest('[data-timeline-marker]');
    if (!button) return;
    const marker = analysis.markers[Number(button.dataset.timelineMarker)];
    if (marker) void mfTimelinePlay(marker, rootId === 'masterTimeline');
  };
}

async function mfTimelinePlay(marker, useMaster = false) {
  if (typeof state === 'undefined') return;
  const buffer = useMaster ? state.master : state.original;
  if (!buffer) return;
  stopPreview();
  const context = await ensureAudioContext(true);
  const source = context.createBufferSource();
  const gain = context.createGain();
  gain.gain.value = Math.pow(10, -3 / 20);
  source.buffer = buffer;
  source.connect(gain).connect(context.destination);
  const start = mfTimelineClamp(marker.start - 1.25, 0, Math.max(0, buffer.duration - 0.1));
  const duration = Math.min(10, Math.max(3, marker.end - start + 1.5), buffer.duration - start);
  source.onended = () => {
    if (state.timelineSource === source) state.timelineSource = null;
  };
  state.timelineSource = source;
  source.start(0, start, duration);
}

function mfTimelineRenderSelfCheck(check) {
  if (typeof document === 'undefined') return;
  const root = document.getElementById('verificationList');
  if (!root) return;
  root.querySelectorAll('[data-mixforge-self-check]').forEach((node) => node.remove());

  const overall = document.createElement('div');
  overall.dataset.mixforgeSelfCheck = 'overall';
  const improved = ['strong_improvement', 'partial_improvement'].includes(check.assessment);
  overall.className = `check ${check.assessment === 'regression' ? 'fail' : check.assessment === 'unchanged' ? 'warn' : ''}`;
  const icon = document.createElement('b');
  icon.textContent = improved ? '✓' : check.assessment === 'regression' ? '×' : '!';
  const copy = document.createElement('div');
  const heading = document.createElement('strong');
  heading.textContent = 'Problem-timeline self-check: ';
  const assessmentLabel = check.assessment.replaceAll('_', ' ');
  copy.append(heading, document.createTextNode(`${assessmentLabel} · weighted issue load ${check.scoreBefore.toFixed(1)} → ${check.scoreAfter.toFixed(1)}.`));
  overall.append(icon, copy);
  root.append(overall);

  const addSummary = (label, types, className = '') => {
    if (!types.length) return;
    const row = document.createElement('div');
    row.dataset.mixforgeSelfCheck = label.toLowerCase();
    row.className = `check ${className}`.trim();
    const rowIcon = document.createElement('b');
    rowIcon.textContent = className === 'fail' ? '×' : className === 'warn' ? '!' : '✓';
    const rowCopy = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = `${label}: `;
    rowCopy.append(strong, document.createTextNode(types.map(mfTimelineTypeLabel).join(', ')));
    row.append(rowIcon, rowCopy);
    root.append(row);
  };
  addSummary('Resolved', check.resolved);
  addSummary('Improved', check.improved.filter((type) => !check.resolved.includes(type)));
  addSummary('Still present', check.remaining, 'warn');
  addSummary('Worsened', check.worsened, 'fail');
}

async function mfTimelineAnalyzeSource() {
  if (!state.original) return null;
  const root = document.getElementById('problemTimeline');
  if (root) root.innerHTML = '<div class="timeline-loading">Mapping problem windows… <span>0%</span></div>';
  const token = (state.timelineToken || 0) + 1;
  state.timelineToken = token;
  const promise = mfTimelineAnalyze(state.original, {
    onProgress(percent) {
      if (state.timelineToken !== token) return;
      const span = root?.querySelector('span');
      if (span) span.textContent = `${percent}%`;
    },
  }).then((analysis) => {
    if (state.timelineToken !== token) return null;
    state.timelineSourceAnalysis = analysis;
    mfTimelineRender(analysis, 'problemTimeline');
    return analysis;
  }).catch((error) => {
    console.error('MixForge timeline source analysis failed:', error);
    if (root) root.textContent = `Problem timeline unavailable: ${error.message}`;
    return null;
  });
  state.timelineSourcePromise = promise;
  return promise;
}

async function mfTimelineAnalyzeMaster() {
  if (!state.master) return null;
  const token = (state.timelineMasterToken || 0) + 1;
  state.timelineMasterToken = token;
  const sourceAnalysis = state.timelineSourceAnalysis || await state.timelineSourcePromise || await mfTimelineAnalyzeSource();
  if (state.timelineMasterToken !== token) return null;
  const masteredAnalysis = await mfTimelineAnalyze(state.master);
  if (state.timelineMasterToken !== token) return null;
  state.timelineMasterAnalysis = masteredAnalysis;
  mfTimelineRender(masteredAnalysis, 'masterTimeline');
  const check = mfTimelineSelfCheck(sourceAnalysis, masteredAnalysis);
  state.timelineSelfCheck = check;
  mfTimelineRenderSelfCheck(check);
  return check;
}

function mfTimelineResetUi() {
  if (typeof document === 'undefined') return;
  for (const id of ['problemTimeline', 'masterTimeline']) {
    const root = document.getElementById(id);
    if (root) root.replaceChildren();
  }
  if (typeof state !== 'undefined') {
    state.timelineToken = (state.timelineToken || 0) + 1;
    state.timelineMasterToken = (state.timelineMasterToken || 0) + 1;
    state.timelineSourceAnalysis = null;
    state.timelineMasterAnalysis = null;
    state.timelineSourcePromise = null;
    state.timelineSelfCheck = null;
  }
}

function mfTimelineInstall() {
  if (typeof document === 'undefined' || typeof state === 'undefined') return;
  const previousRenderAudit = renderAudit;
  renderAudit = function renderAuditWithTimeline(audit, metrics) {
    previousRenderAudit(audit, metrics);
    void mfTimelineAnalyzeSource();
  };

  const previousRenderVerification = renderVerification;
  renderVerification = function renderVerificationWithTimeline(metrics, plan) {
    previousRenderVerification(metrics, plan);
    const masterRoot = document.getElementById('masterTimeline');
    if (masterRoot) masterRoot.innerHTML = '<div class="timeline-loading">Re-checking the rendered master…</div>';
    void mfTimelineAnalyzeMaster().catch((error) => {
      console.error('MixForge remaster self-check failed:', error);
      if (masterRoot) masterRoot.textContent = `Remaster self-check unavailable: ${error.message}`;
    });
  };

  const previousStopPreview = stopPreview;
  stopPreview = function stopPreviewWithTimeline(...args) {
    const source = state.timelineSource;
    state.timelineSource = null;
    if (source) {
      try { source.onended = null; source.stop(); } catch (_) {}
      try { source.disconnect(); } catch (_) {}
    }
    return previousStopPreview(...args);
  };

  const previousResetResults = resetResults;
  resetResults = function resetResultsWithTimeline(...args) {
    mfTimelineResetUi();
    return previousResetResults(...args);
  };
}

mfTimelineInstall();
