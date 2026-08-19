'use strict';

const MF_TARGET_REPAIR_TYPES = Object.freeze({
  harshness_band: {
    label: 'Tame harshness only here',
    safety: 'safe',
    defaultSelected: true,
    explanation: 'Apply a conservative upper-mid cut only inside this time window, with short crossfades.',
    operation: { mode: 'filter', type: 'eq', filterType: 'peaking', frequency: 4600, gain: -2.2, q: 1.15, wet: 0.82 },
  },
  sibilance: {
    label: 'De-ess only here',
    safety: 'safe',
    defaultSelected: true,
    explanation: 'Use a conservative dynamic high-frequency reduction only around the detected flare.',
    operation: { mode: 'filter', type: 'deess', frequency: 7200, threshold: -30, maxReductionDb: 2.5, wet: 0.82 },
  },
  sub_bass_heavy: {
    label: 'Trim sub-bass only here',
    safety: 'safe',
    defaultSelected: true,
    explanation: 'Reduce 20–80 Hz energy in this section without changing the rest of the song.',
    operation: { mode: 'filter', type: 'eq', filterType: 'lowshelf', frequency: 62, gain: -2.5, q: 0.7, wet: 0.85 },
  },
  mono_incompatibility: {
    label: 'Narrow the unstable width here',
    safety: 'safe',
    defaultSelected: true,
    explanation: 'Reduce only the side channel in this window while preserving the center and lead vocal.',
    operation: { mode: 'width', sideScale: 0.65, wet: 1 },
  },
  peak_risk: {
    label: 'Trim the risky peak here',
    safety: 'safe',
    defaultSelected: true,
    explanation: 'Apply a short, transparent gain ride only around the unsafe peak.',
    operation: { mode: 'gain', gainDb: -1.5, wet: 1 },
  },
  loudness_dip: {
    label: 'Raise this sustained section slightly',
    safety: 'review',
    defaultSelected: false,
    explanation: 'A level dip can be intentional arrangement dynamics. This +1.5 dB ride requires your approval.',
    operation: { mode: 'gain', gainDb: 1.5, wet: 1 },
  },
  clipping: {
    label: 'Clipped source cannot be reconstructed safely',
    safety: 'blocked',
    defaultSelected: false,
    explanation: 'Lowering this section can stop further overload, but it cannot restore waveform detail already flattened. Use a clean pre-limiter mix or stem.',
    operation: null,
  },
});

function mfTargetRecountAnalysis(analysis, markers) {
  const counts = {};
  for (const marker of markers) counts[marker.type] = (counts[marker.type] || 0) + 1;
  const issueLoad = Object.entries(counts).reduce((sum, [type, count]) => (
    sum + (MF_TIMELINE_TYPES[type]?.weight || 1) * Math.sqrt(count)
  ), 0);
  return { ...analysis, markers, counts, issueLoad };
}

const mfTargetLegacyAnalyze = mfTimelineAnalyze;
mfTimelineAnalyze = async function mfTimelineAnalyzeWithMusicalDipGuard(buffer, options = {}) {
  const analysis = await mfTargetLegacyAnalyze(buffer, options);
  const duration = Math.max(0, analysis.duration || buffer?.duration || 0);
  const markers = analysis.markers.filter((marker) => {
    if (marker.type !== 'loudness_dip') return true;
    const markerDuration = Math.max(0, marker.end - marker.start);
    const nearBoundary = marker.start < 3 || marker.end > duration - 3;
    return markerDuration >= 2.25 && !nearBoundary;
  });
  return mfTargetRecountAnalysis(analysis, markers);
};

function mfTargetBuildPlanFromAnalysis(analysis) {
  return (analysis?.markers || []).map((marker, index) => {
    const definition = MF_TARGET_REPAIR_TYPES[marker.type] || {
      label: `Review ${mfTimelineTypeLabel(marker.type)}`,
      safety: 'blocked',
      defaultSelected: false,
      explanation: 'MixForge does not have a bounded repair for this finding yet.',
      operation: null,
    };
    return {
      id: `${marker.type}-${index}-${Math.round(marker.start * 100)}`,
      marker,
      ...definition,
      operation: definition.operation ? { ...definition.operation } : null,
    };
  });
}

function mfTargetEnvelope(time, start, end, fadeSeconds = 0.14) {
  const outerStart = Math.max(0, start - fadeSeconds);
  const outerEnd = end + fadeSeconds;
  if (time < outerStart || time > outerEnd) return 0;
  if (time >= start && time <= end) return 1;
  if (time < start) {
    const position = (time - outerStart) / Math.max(1e-6, start - outerStart);
    return 0.5 - 0.5 * Math.cos(Math.PI * mfTimelineClamp(position, 0, 1));
  }
  const position = (outerEnd - time) / Math.max(1e-6, outerEnd - end);
  return 0.5 - 0.5 * Math.cos(Math.PI * mfTimelineClamp(position, 0, 1));
}

function mfTargetBlendFilteredRegion(source, filtered, markers, wet = 0.82) {
  const out = cloneBuffer(source);
  const sampleRate = source.sampleRate;
  for (let channel = 0; channel < out.numberOfChannels; channel++) {
    const dryData = source.getChannelData(channel);
    const wetData = filtered.getChannelData(Math.min(channel, filtered.numberOfChannels - 1));
    const destination = out.getChannelData(channel);
    for (const marker of markers) {
      const begin = Math.max(0, Math.floor((marker.start - 0.15) * sampleRate));
      const finish = Math.min(out.length, Math.ceil((marker.end + 0.15) * sampleRate));
      for (let index = begin; index < finish; index++) {
        const envelope = mfTargetEnvelope(index / sampleRate, marker.start, marker.end) * wet;
        destination[index] = dryData[index] * (1 - envelope) + wetData[index] * envelope;
      }
    }
  }
  return out;
}

function mfTargetApplyGainRegions(source, repairs) {
  const out = cloneBuffer(source);
  const sampleRate = source.sampleRate;
  for (const repair of repairs) {
    const gain = dbToGain(repair.operation.gainDb);
    const marker = repair.marker;
    const begin = Math.max(0, Math.floor((marker.start - 0.15) * sampleRate));
    const finish = Math.min(out.length, Math.ceil((marker.end + 0.15) * sampleRate));
    for (let channel = 0; channel < out.numberOfChannels; channel++) {
      const data = out.getChannelData(channel);
      for (let index = begin; index < finish; index++) {
        const envelope = mfTargetEnvelope(index / sampleRate, marker.start, marker.end);
        const localGain = 1 + (gain - 1) * envelope;
        data[index] *= localGain;
      }
    }
  }
  return out;
}

function mfTargetApplyWidthRegions(source, repairs) {
  if (source.numberOfChannels < 2) return source;
  const out = cloneBuffer(source);
  const sampleRate = source.sampleRate;
  const left = out.getChannelData(0);
  const right = out.getChannelData(1);
  for (const repair of repairs) {
    const marker = repair.marker;
    const scale = mfTimelineClamp(repair.operation.sideScale, 0.45, 1);
    const begin = Math.max(0, Math.floor((marker.start - 0.15) * sampleRate));
    const finish = Math.min(out.length, Math.ceil((marker.end + 0.15) * sampleRate));
    for (let index = begin; index < finish; index++) {
      const envelope = mfTargetEnvelope(index / sampleRate, marker.start, marker.end);
      const localScale = 1 + (scale - 1) * envelope;
      const mid = (left[index] + right[index]) * 0.5;
      const side = (left[index] - right[index]) * 0.5 * localScale;
      left[index] = mid + side;
      right[index] = mid - side;
    }
  }
  return out;
}

function mfTargetOperationKey(operation) {
  return [operation.type, operation.filterType, operation.frequency, operation.gain, operation.q, operation.threshold, operation.maxReductionDb, operation.wet].join('|');
}

async function mfTargetRenderCandidate(source, repairs) {
  let output = cloneBuffer(source);
  const filters = repairs.filter((repair) => repair.operation?.mode === 'filter');
  const filterGroups = new Map();
  for (const repair of filters) {
    const key = mfTargetOperationKey(repair.operation);
    if (!filterGroups.has(key)) filterGroups.set(key, []);
    filterGroups.get(key).push(repair);
  }
  for (const group of filterGroups.values()) {
    const operation = group[0].operation;
    const processed = await renderProcessedBuffer(output, [{ ...operation }]);
    output = mfTargetBlendFilteredRegion(output, processed, group.map((repair) => repair.marker), operation.wet);
    await sleep(0);
  }
  const widthRepairs = repairs.filter((repair) => repair.operation?.mode === 'width');
  if (widthRepairs.length) output = mfTargetApplyWidthRegions(output, widthRepairs);
  const gainRepairs = repairs.filter((repair) => repair.operation?.mode === 'gain');
  if (gainRepairs.length) output = mfTargetApplyGainRegions(output, gainRepairs);
  return lookAheadLimit(output, state.masterPlan?.ceilingDb ?? -1.2);
}

function mfTargetEvaluateCandidate(beforeAnalysis, afterAnalysis, beforeMetrics, afterMetrics, plan = {}) {
  const beforeHigh = new Set((beforeAnalysis?.markers || []).filter((marker) => marker.severity === 'high').map((marker) => marker.type));
  const afterHigh = new Set((afterAnalysis?.markers || []).filter((marker) => marker.severity === 'high').map((marker) => marker.type));
  const newHigh = [...afterHigh].filter((type) => !beforeHigh.has(type));
  const truePeak = typeof mfEstimateTruePeak === 'function' ? mfEstimateTruePeak : null;
  const afterTruePeak = truePeak ? truePeak({
    ...afterMetrics,
  }) : null;
  const peakLimit = Number(plan.truePeakCeilingDb ?? plan.ceilingDb ?? -1);
  const peakSafe = Number(afterMetrics.peakDb) <= peakLimit + 0.2;
  const crestSafe = Number(afterMetrics.crestDb) >= Math.max(6.5, Number(beforeMetrics.crestDb) - 1.5);
  const correlationSafe = Number(afterMetrics.correlation) >= Number(beforeMetrics.correlation) - 0.08;
  const loudnessSafe = Math.abs(Number(afterMetrics.lufs) - Number(beforeMetrics.lufs)) <= 0.8;
  const loadImproved = Number(afterAnalysis?.issueLoad || 0) < Number(beforeAnalysis?.issueLoad || 0) - 0.05;
  const reasons = [];
  if (!loadImproved) reasons.push('the measured problem load did not decrease');
  if (newHigh.length) reasons.push(`new high-risk finding: ${newHigh.map(mfTimelineTypeLabel).join(', ')}`);
  if (!peakSafe) reasons.push(`peak safety exceeded ${peakLimit.toFixed(1)} dBFS`);
  if (!crestSafe) reasons.push('too much transient contrast was lost');
  if (!correlationSafe) reasons.push('stereo correlation worsened');
  if (!loudnessSafe) reasons.push('the repair changed whole-song loudness too much');
  return {
    accepted: loadImproved && !newHigh.length && peakSafe && crestSafe && correlationSafe && loudnessSafe,
    reasons,
    beforeLoad: Number(beforeAnalysis?.issueLoad || 0),
    afterLoad: Number(afterAnalysis?.issueLoad || 0),
    resolved: mfTimelineSelfCheck(beforeAnalysis, afterAnalysis).resolved,
    remaining: Object.keys(afterAnalysis?.counts || {}),
  };
}

function mfTargetSetStatus(root, message, kind = '') {
  const status = root.querySelector('[data-target-status]');
  if (!status) return;
  status.textContent = message;
  status.className = `targeted-repair-status${kind ? ` ${kind}` : ''}`;
}

function mfTargetPlayBuffer(buffer, start = 0, duration = 10) {
  return (async () => {
    stopPreview();
    const context = await ensureAudioContext(true);
    const source = context.createBufferSource();
    source.buffer = buffer;
    const gain = context.createGain();
    gain.gain.value = dbToGain(-3);
    source.connect(gain).connect(context.destination);
    state.targetRepairSource = source;
    source.onended = () => {
      if (state.targetRepairSource === source) state.targetRepairSource = null;
    };
    source.start(0, mfTimelineClamp(start, 0, Math.max(0, buffer.duration - 0.1)), Math.min(duration, buffer.duration - start));
  })();
}

function mfTargetRenderResult(root, selected, candidate, afterAnalysis, afterMetrics, evaluation) {
  root.querySelector('[data-target-result]')?.remove();
  const result = document.createElement('div');
  result.dataset.targetResult = 'true';
  result.className = `targeted-repair-result${evaluation.accepted ? '' : ' targeted-repair-rejected'}`;
  const heading = document.createElement('h4');
  heading.textContent = evaluation.accepted ? 'Targeted repair candidate passed' : 'Candidate blocked by MixForge safeguards';
  const copy = document.createElement('p');
  copy.textContent = evaluation.accepted
    ? `The selected moves reduced measured problem load without introducing a new high-risk issue. Resolved: ${evaluation.resolved.length ? evaluation.resolved.map(mfTimelineTypeLabel).join(', ') : 'none fully resolved yet'}.`
    : `MixForge will not replace the current master because ${evaluation.reasons.join('; ')}.`;
  result.append(heading, copy);

  const delta = document.createElement('div');
  delta.className = 'targeted-repair-delta';
  const metrics = [
    [`${evaluation.beforeLoad.toFixed(1)} → ${evaluation.afterLoad.toFixed(1)}`, 'problem load'],
    [`${afterMetrics.lufs.toFixed(1)} LUFS`, 'candidate loudness'],
    [`${afterMetrics.peakDb.toFixed(2)} dBFS`, 'candidate sample peak'],
  ];
  for (const [value, label] of metrics) {
    const item = document.createElement('div');
    const strong = document.createElement('b'); strong.textContent = value;
    const span = document.createElement('span'); span.textContent = label;
    item.append(strong, span); delta.append(item);
  }
  result.append(delta);

  const auditionStart = Math.max(0, Math.min(...selected.map((repair) => repair.marker.start)) - 1.25);
  const auditionEnd = Math.max(...selected.map((repair) => repair.marker.end)) + 1.5;
  const auditionDuration = Math.min(12, Math.max(5, auditionEnd - auditionStart));
  const actions = document.createElement('div');
  actions.className = 'targeted-repair-ab';
  const currentButton = document.createElement('button');
  currentButton.type = 'button'; currentButton.textContent = 'A · Current master';
  currentButton.onclick = () => void mfTargetPlayBuffer(state.master, auditionStart, auditionDuration);
  const candidateButton = document.createElement('button');
  candidateButton.type = 'button'; candidateButton.textContent = 'B · Repair candidate';
  candidateButton.onclick = () => void mfTargetPlayBuffer(candidate, auditionStart, auditionDuration);
  actions.append(currentButton, candidateButton);
  if (evaluation.accepted) {
    const keepButton = document.createElement('button');
    keepButton.type = 'button'; keepButton.className = 'targeted-repair-keep'; keepButton.textContent = 'Keep improved repair';
    keepButton.onclick = async () => {
      stopPreview();
      state.master = candidate;
      if (typeof markMasterRendered === 'function') markMasterRendered(candidate);
      else {
        state.masterDirty = false;
        state.masterRevision = (state.masterRevision || 0) + 1;
        state.masterRenderSignature = `${candidate.length}:${candidate.sampleRate}:${candidate.numberOfChannels}`;
        if ($('exportBtn')) $('exportBtn').disabled = false;
      }
      state.finalMetrics = afterMetrics;
      state.timelineMasterAnalysis = afterAnalysis;
      renderMetrics('finalMetrics', state.finalMetrics);
      renderVerification(state.finalMetrics, state.masterPlan);
      mfTargetSetStatus(root, 'Improved candidate kept. The download button now exports this repaired master.', 'ok');
      root.querySelector('[data-target-result]')?.remove();
    };
    actions.append(keepButton);
  }
  const discardButton = document.createElement('button');
  discardButton.type = 'button'; discardButton.textContent = 'Discard candidate';
  discardButton.onclick = () => {
    stopPreview();
    result.remove();
    mfTargetSetStatus(root, 'Candidate discarded. The current master is unchanged.');
  };
  actions.append(discardButton);
  result.append(actions);
  root.append(result);
}

function mfTargetRenderWorkspace(analysis, root) {
  const previous = root.querySelector('[data-target-workspace]');
  if (previous) previous.remove();
  const plan = mfTargetBuildPlanFromAnalysis(analysis);
  if (!plan.length) return;

  const workspace = document.createElement('section');
  workspace.dataset.targetWorkspace = 'true';
  workspace.className = 'targeted-repair';
  const head = document.createElement('div');
  head.className = 'targeted-repair-head';
  const copy = document.createElement('div');
  const title = document.createElement('h3'); title.textContent = 'Do more than report it';
  const paragraph = document.createElement('p');
  paragraph.textContent = 'Choose bounded repairs, hear the same passage before and after, and let MixForge re-measure the candidate before it can replace your master.';
  copy.append(title, paragraph);
  const count = document.createElement('span');
  count.className = 'targeted-repair-count';
  count.textContent = `${plan.filter((item) => item.safety !== 'blocked').length} repairable`;
  head.append(copy, count);
  workspace.append(head);

  const list = document.createElement('div');
  list.className = 'targeted-repair-list';
  for (const repair of plan) {
    const card = document.createElement('label');
    card.className = `targeted-repair-card ${repair.safety}`;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.targetRepair = repair.id;
    checkbox.checked = repair.defaultSelected;
    checkbox.disabled = repair.safety === 'blocked';
    const cardCopy = document.createElement('span');
    cardCopy.className = 'targeted-repair-card-copy';
    const strong = document.createElement('strong');
    strong.textContent = `${mfTimelineFormatTime(repair.marker.start)}–${mfTimelineFormatTime(Math.max(repair.marker.end, repair.marker.start + 1))} · ${repair.label}`;
    const evidence = document.createElement('span'); evidence.textContent = repair.marker.evidence;
    const why = document.createElement('small'); why.textContent = repair.explanation;
    cardCopy.append(strong, evidence, why);
    const badge = document.createElement('span');
    badge.className = 'targeted-repair-badge';
    badge.textContent = repair.safety === 'safe' ? 'Safe candidate' : repair.safety === 'review' ? 'Your approval' : 'Source required';
    card.append(checkbox, cardCopy, badge);
    list.append(card);
  }
  workspace.append(list);

  const actions = document.createElement('div');
  actions.className = 'targeted-repair-actions';
  const build = document.createElement('button');
  build.type = 'button'; build.className = 'primary'; build.textContent = 'Build targeted repair';
  build.onclick = async () => {
    const selectedIds = new Set([...workspace.querySelectorAll('[data-target-repair]:checked')].map((input) => input.dataset.targetRepair));
    const selected = plan.filter((repair) => selectedIds.has(repair.id) && repair.operation);
    if (!selected.length) {
      mfTargetSetStatus(workspace, 'Select at least one repairable item first.', 'warn');
      return;
    }
    build.disabled = true;
    mfTargetSetStatus(workspace, 'Rendering only the selected time windows, then re-measuring the complete song…');
    try {
      const beforeMetrics = measureBuffer(state.master);
      const candidate = await mfTargetRenderCandidate(state.master, selected);
      const afterMetrics = measureBuffer(candidate);
      const afterAnalysis = await mfTimelineAnalyze(candidate);
      const evaluation = mfTargetEvaluateCandidate(analysis, afterAnalysis, beforeMetrics, afterMetrics, state.masterPlan);
      state.targetRepairCandidate = candidate;
      mfTargetRenderResult(workspace, selected, candidate, afterAnalysis, afterMetrics, evaluation);
      mfTargetSetStatus(workspace, evaluation.accepted
        ? 'Candidate passed. Use A/B, then keep or discard it.'
        : 'Candidate was rendered for inspection but failed the replacement safeguards.', evaluation.accepted ? 'ok' : 'error');
    } catch (error) {
      console.error('Targeted repair failed:', error);
      mfTargetSetStatus(workspace, `Targeted repair failed: ${error.message}`, 'error');
    } finally {
      build.disabled = false;
    }
  };
  actions.append(build);
  workspace.append(actions);
  const status = document.createElement('div');
  status.dataset.targetStatus = 'true';
  status.className = 'targeted-repair-status';
  status.textContent = 'Automatic repairs are selected. Musical level rides require your approval; clipped-source restoration is blocked.';
  workspace.append(status);
  root.append(workspace);
}

function mfTargetInstall() {
  if (typeof document === 'undefined' || typeof state === 'undefined') return;
  const previousTimelineRender = mfTimelineRender;
  mfTimelineRender = function mfTimelineRenderChronologicalAndRepairable(analysis, rootId = 'problemTimeline') {
    const chronological = { ...analysis, markers: [...analysis.markers].sort((a, b) => a.start - b.start || a.end - b.end) };
    previousTimelineRender(chronological, rootId);
    if (rootId === 'masterTimeline') {
      const root = document.getElementById(rootId);
      if (root) mfTargetRenderWorkspace(chronological, root);
    }
  };

  const previousStopPreview = stopPreview;
  stopPreview = function stopPreviewWithTargetRepair(...args) {
    const source = state.targetRepairSource;
    state.targetRepairSource = null;
    if (source) {
      try { source.onended = null; source.stop(); } catch (_) {}
      try { source.disconnect(); } catch (_) {}
    }
    return previousStopPreview(...args);
  };
}

mfTargetInstall();
