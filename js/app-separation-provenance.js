'use strict';

// Keeps forensic copy and repair intensity aligned with the backend model that
// actually produced each stem. Loaded after app-forensics.js so it can decorate
// and constrain the existing forensic planner without duplicating DSP code.

(function installSeparationProvenanceUI() {
  if (typeof renderStemPlans !== 'function') return;

  const baseRenderStemPlans = renderStemPlans;
  const baseBuildStemPlans = typeof buildStemPlans === 'function' ? buildStemPlans : null;

  function separatorInfo() {
    return state.separationInfo && typeof state.separationInfo === 'object'
      ? state.separationInfo
      : null;
  }

  function stemSource(stem) {
    const info = separatorInfo();
    const explicit = info?.stemSources?.[stem];
    if (explicit) return String(explicit).toLowerCase();
    const engine = String(info?.engine || 'demucs').toLowerCase();
    if (engine === 'melband' && stem === 'vocals') return 'melband';
    return 'demucs';
  }

  function melbandQualityStatus() {
    const info = separatorInfo();
    const raw = info?.modelProvenance?.melband?.qualityStatus || info?.melbandQualityStatus || 'candidate';
    const status = String(raw).toLowerCase();
    return ['hold', 'candidate', 'approved'].includes(status) ? status : 'candidate';
  }

  function modelTrust(stem) {
    const source = stemSource(stem);
    if (source !== 'melband') return { source, status: 'approved', constrained: false };
    const status = melbandQualityStatus();
    return { source, status, constrained: status !== 'approved' };
  }

  function constrainOperation(op, factor) {
    const next = { ...op };
    if (Number.isFinite(Number(next.gain))) next.gain = clamp(Number(next.gain) * factor, -3, 2);
    if (Number.isFinite(Number(next.gainDb))) next.gainDb = clamp(Number(next.gainDb) * factor, -2, 2);
    if (Number.isFinite(Number(next.ratio))) {
      const ratio = Math.max(1, Number(next.ratio));
      next.ratio = clamp(1 + (ratio - 1) * factor, 1, 2.4);
    }
    return next;
  }

  function constrainCandidateModel(stem, plan) {
    if (!plan || !plan.quality) return;
    const trust = modelTrust(stem);
    plan.separatorTrust = trust;
    if (!trust.constrained) return;

    const hold = trust.status === 'hold';
    const scoreCap = hold ? 55 : 79;
    const maxWet = hold ? 0.10 : 0.24;
    const operationFactor = hold ? 0.45 : 0.72;
    const previousScore = Number(plan.quality.score) || scoreCap;

    plan.quality.modelScoreBeforeTrust = previousScore;
    plan.quality.score = Math.min(previousScore, scoreCap);
    plan.quality.risk = plan.quality.score >= 65 ? 'moderate' : 'high';
    plan.quality.guidance = hold
      ? 'This separator model is on quality hold. Do not use it for corrective repair; prefer the Demucs fallback.'
      : 'Candidate MelBand vocal: audition and benchmark it, but keep corrective processing conservative until the model is explicitly approved.';

    if (Array.isArray(plan.candidates)) {
      plan.candidates = plan.candidates.map((candidate, index) => ({
        ...candidate,
        name: index === 2 && !hold ? 'Benchmark-safe max' : candidate.name,
        wet: Math.min(Number(candidate.wet) || maxWet, maxWet),
        operations: Array.isArray(candidate.operations)
          ? candidate.operations.map((op) => constrainOperation(op, operationFactor))
          : [],
      }));
      if (hold) plan.selectedCandidate = 0;
      else if ((plan.selectedCandidate ?? 1) > 1) plan.selectedCandidate = 1;
      const selected = plan.candidates[plan.selectedCandidate ?? 0] || plan.candidates[0];
      if (selected) {
        plan.operations = selected.operations;
        plan.wet = selected.wet;
      }
    } else {
      plan.wet = Math.min(Number(plan.wet) || maxWet, maxWet);
      plan.operations = (plan.operations || []).map((op) => constrainOperation(op, operationFactor));
    }
  }

  if (baseBuildStemPlans) {
    buildStemPlans = async function buildStemPlansWithModelTrust() {
      await baseBuildStemPlans();
      for (const [stem, plan] of Object.entries(state.stemPlans || {})) {
        constrainCandidateModel(stem, plan);
      }
    };
  }

  function measuredHeading(stem) {
    const source = stemSource(stem);
    if (source === 'melband') return 'Measured conditions on this MelBand RoFormer vocal stem';
    return 'Measured conditions on this isolated Demucs bucket';
  }

  function updatePanelProvenance() {
    const panel = $('stemPanel');
    if (!panel) return;
    const info = separatorInfo();
    const engine = String(info?.engine || 'demucs').toLowerCase();
    const title = panel.querySelector('.panel-title h2');
    const description = panel.querySelector('.panel-title p');

    if (!title || !description) return;

    if (engine === 'hybrid') {
      const status = melbandQualityStatus();
      title.textContent = 'Isolated source stems and measured conditions';
      description.textContent = status === 'approved'
        ? 'Quality routing used an approved MelBand RoFormer vocal stem while Demucs remained authoritative for bass, drums, and residual other. Guitars/keys still share residual other and are not separately confirmed.'
        : 'Quality routing used a candidate MelBand RoFormer vocal stem while Demucs remained authoritative for bass, drums, and residual other. Candidate-model vocal repairs are intensity-capped until the real-song benchmark is approved.';
      return;
    }

    if (engine === 'melband') {
      const status = melbandQualityStatus();
      title.textContent = 'Isolated vocal stem and measured conditions';
      description.textContent = status === 'approved'
        ? 'The vocal stem was isolated with an approved MelBand RoFormer model. MixForge reports only the source this model actually produced.'
        : 'The vocal stem was isolated with a candidate MelBand RoFormer model. Repairs are intensity-capped until the real-song benchmark is explicitly approved.';
      return;
    }

    title.textContent = 'Isolated Demucs buckets and measured conditions';
    description.textContent = 'A heuristic leakage/fit score is graded before processing — not lab SDR. Demucs separates vocals, bass, drums, and residual other; guitars/keys share residual other. That is not instrument confirmation.';
  }

  renderStemPlans = function renderStemPlansWithProvenance() {
    baseRenderStemPlans();
    updatePanelProvenance();

    const cards = [...document.querySelectorAll('#stemGrid .stem-card')];
    const entries = Object.entries(state.stemPlans || {});
    cards.forEach((card, index) => {
      const [stem, plan] = entries[index] || [];
      if (!stem) return;
      const heading = card.querySelector('.confirmation-list > b');
      if (heading) heading.textContent = measuredHeading(stem);

      const trust = plan?.separatorTrust || modelTrust(stem);
      if (trust.source === 'melband') {
        const guardrail = card.querySelector('.guardrail');
        if (guardrail) guardrail.textContent += ` · model trust ${trust.status}`;
      }
    });
  };
})();
