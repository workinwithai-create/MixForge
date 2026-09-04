'use strict';

// Source-aware forensic safeguards learned from the 2.6.0 mobile test.
// The generic forensic layer is intentionally conservative, but frequency
// relationships that are suspicious on vocals are not automatically defects on
// bass/drums. This layer keeps low-confidence stems from receiving repair
// authority that contradicts their own leakage/fit warning.

(function installStemEvidenceGuard() {
  if (typeof renderStemPlans !== 'function') return;

  const baseRenderStemPlans = renderStemPlans;

  function stemLabel(stem) {
    if (stem === 'other') return 'Other residual';
    return stem ? stem[0].toUpperCase() + stem.slice(1) : 'Stem';
  }

  function filterOperationsForSource(stem, operations) {
    const ops = Array.isArray(operations) ? operations : [];
    if (stem !== 'bass') return ops;

    return ops.filter((op) => {
      const frequency = Number(op?.frequency) || 0;
      const label = String(op?.label || '').toLowerCase();
      if (op?.type === 'deess') return false;
      if (/lyric|sibil|vocal clarity|presence restore|air restore/.test(label)) return false;
      if (op?.type === 'eq' && frequency >= 2500 && Number(op?.gain) > 0) return false;
      if (op?.type === 'highpass' && frequency > 40) return false;
      return true;
    });
  }

  function applySourceEvidence(stem, plan) {
    if (!plan?.quality) return;

    // A stem that scores below 65 already says it is not trustworthy enough for
    // aggressive processing. Enforce that statement instead of defaulting to
    // Balanced because the global engineer profile happens to be Balanced.
    if (plan.quality.score < 65 && Array.isArray(plan.candidates) && plan.candidates.length) {
      plan.selectedCandidate = 0;
      const preserve = plan.candidates[0];
      preserve.operations = filterOperationsForSource(stem, preserve.operations);
      preserve.wet = Math.min(Number(preserve.wet) || 0.16, 0.16);
      plan.operations = preserve.operations;
      plan.wet = preserve.wet;
      plan.evidenceGuard = 'low-confidence-preserve';
    } else if (plan.quality.score < 82 && Array.isArray(plan.candidates)) {
      // Moderate stems may use Balanced, but never Assertive.
      if ((plan.selectedCandidate ?? 1) > 1) plan.selectedCandidate = 1;
      plan.candidates[1].operations = filterOperationsForSource(stem, plan.candidates[1].operations);
      plan.candidates[1].wet = Math.min(Number(plan.candidates[1].wet) || 0.24, 0.24);
      const selected = plan.candidates[plan.selectedCandidate] || plan.candidates[0];
      plan.operations = selected.operations;
      plan.wet = selected.wet;
      plan.evidenceGuard = 'moderate-confidence-cap';
    } else {
      plan.operations = filterOperationsForSource(stem, plan.operations);
    }

    // Source-specific evidence interpretation. A large low-mid/presence gap is
    // meaningful for a vocal or residual backing bucket, but is normal spectral
    // shape for a bass stem. Do not present it as a confirmed bass defect.
    if (Array.isArray(plan.confirmed) && stem === 'bass') {
      plan.confirmed = plan.confirmed.filter((item) => item?.condition !== 'Presence masking');
      plan.confirmed = plan.confirmed.map((item) => {
        if (item?.condition === 'High-frequency events') {
          return {
            ...item,
            condition: 'Upper-harmonic activity',
            confidence: Math.min(Number(item.confidence) || 60, 68),
          };
        }
        if (item?.condition === 'Low-mid buildup') {
          return {
            ...item,
            condition: 'Low-mid concentration',
            confidence: Math.min(Number(item.confidence) || 65, 72),
          };
        }
        return item;
      });
    }
  }

  function patchRenderedCards() {
    const entries = Object.entries(state.stemPlans || {});
    const cards = [...document.querySelectorAll('#stemGrid .stem-card')];

    cards.forEach((card, index) => {
      const [stem, plan] = entries[index] || [];
      if (!stem || !plan) return;

      const confirms = card.querySelector('.confirmation-list');
      if (confirms) {
        const heading = confirms.querySelector('b');
        const headingText = heading?.textContent || 'Measured conditions on this isolated source';
        confirms.replaceChildren();
        const h = document.createElement('b');
        h.textContent = headingText;
        confirms.append(h);
        if (plan.confirmed?.length) {
          for (const item of plan.confirmed) {
            const row = document.createElement('span');
            row.textContent = `${item.condition}: ${item.evidence} · ${item.confidence}%`;
            confirms.append(row);
          }
        } else {
          const healthy = document.createElement('span');
          healthy.className = 'healthy';
          healthy.textContent = `No source-specific defect is confirmed on this ${stemLabel(stem).toLowerCase()} stem; leave it substantially unchanged.`;
          confirms.append(healthy);
        }
      }

      const buttons = [...card.querySelectorAll('.candidate-choices button')];
      buttons.forEach((button, candidateIndex) => {
        const low = plan.quality.score < 65;
        const moderate = plan.quality.score >= 65 && plan.quality.score < 82;
        const blocked = (low && candidateIndex > 0) || (moderate && candidateIndex > 1);
        button.disabled = blocked;
        if (blocked) button.title = low
          ? 'Leakage/fit is too weak for this repair intensity.'
          : 'Assertive repair is disabled until separator confidence is high.';
        button.classList.toggle('selected', candidateIndex === plan.selectedCandidate);
      });

      const repairList = card.querySelector('.repair-list');
      if (repairList) {
        repairList.replaceChildren();
        for (const op of plan.operations || []) {
          const row = document.createElement('div');
          row.className = 'repair';
          const label = document.createElement('span');
          label.textContent = op.label || op.type;
          const value = document.createElement('span');
          value.textContent = typeof describeOperation === 'function' ? describeOperation(op) : op.type;
          row.append(label, value);
          repairList.append(row);
        }
      }

      const guidance = card.querySelector('.stem-guidance');
      if (guidance && plan.evidenceGuard === 'low-confidence-preserve') {
        guidance.textContent = 'Separation confidence is too low for corrective authority. Preserve is locked; use mix-bus correction or a better separation result.';
      }
      const guardrail = card.querySelector('.guardrail');
      if (guardrail && plan.evidenceGuard === 'low-confidence-preserve') {
        guardrail.textContent = `Guardrails: level matched · wet ${Math.round((plan.wet || 0) * 100)}% · Preserve locked by low separator confidence · original stem immutable`;
      }
    });
  }

  renderStemPlans = function renderStemPlansWithSourceEvidence() {
    baseRenderStemPlans();
    for (const [stem, plan] of Object.entries(state.stemPlans || {})) applySourceEvidence(stem, plan);
    patchRenderedCards();
  };

  if (typeof mfRenderWhatChanged === 'function') {
    const baseRenderWhatChanged = mfRenderWhatChanged;
    mfRenderWhatChanged = function renderWhatChangedWithoutPathContradiction() {
      baseRenderWhatChanged();
      if (state.mixforgePath !== 'forensic') return;
      const remaining = document.querySelector('#whatChanged .what-changed-remaining');
      if (!remaining) return;
      if (/may still need Forensic Fix/i.test(remaining.textContent || '')) {
        const correlation = Number(state.finalMetrics?.correlation);
        remaining.textContent = Number.isFinite(correlation) && correlation > 0.98
          ? 'Still watch: The master remains extremely narrow/mono. Forensic Fix has already run, so treat this as a mix characteristic to confirm by listening — do not widen it automatically.'
          : 'Still watch: Remaining stereo findings survived Forensic Fix. Confirm them by A/B/listening before any further correction.';
      }
    };
  }
})();
