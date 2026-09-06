'use strict';

// MixForge dynamics-preservation guard.
// Loudness is a request, not permission to flatten a mix. This layer measures
// the corrected source against each rendered candidate and backs off when the
// master costs more crest factor / macro-dynamic movement than our conservative
// internal guardrails allow. These are product guardrails, not industry standards.
(function installDynamicsGuard() {
  const ready = typeof renderReleaseMaster === 'function'
    && typeof renderVerification === 'function'
    && typeof measureBuffer === 'function'
    && typeof mfEstimateTruePeak === 'function'
    && typeof clamp === 'function';
  if (!ready) {
    console.warn('Dynamics guard not installed: mastering-grade globals are missing.');
    return;
  }

  const previousRenderReleaseMaster = renderReleaseMaster;
  const previousRenderVerification = renderVerification;

  function budgetFor(metrics, duration = 0) {
    const crest = Number(metrics?.crestDb);
    const lra = Number(metrics?.lra);
    const maxCrestLossDb = crest < 8 ? 0.6 : crest < 11 ? 1.0 : crest < 15 ? 1.5 : 2.0;
    const maxLraLossLu = lra < 4 ? 0.7 : lra < 8 ? 1.2 : lra < 12 ? 2.0 : 3.0;
    return {
      maxCrestLossDb,
      maxLraLossLu,
      // LRA-like measurements need enough program time to mean anything.
      enforceLra: Number.isFinite(lra) && lra >= 1 && duration >= 10,
    };
  }

  function evaluateDynamics(sourceMetrics, finalMetrics, budget) {
    const crestLossDb = Number.isFinite(sourceMetrics?.crestDb) && Number.isFinite(finalMetrics?.crestDb)
      ? Math.max(0, sourceMetrics.crestDb - finalMetrics.crestDb)
      : Infinity;
    const lraLossLu = Number.isFinite(sourceMetrics?.lra) && Number.isFinite(finalMetrics?.lra)
      ? Math.max(0, sourceMetrics.lra - finalMetrics.lra)
      : Infinity;
    const crestExcessDb = Math.max(0, crestLossDb - budget.maxCrestLossDb);
    const lraExcessLu = budget.enforceLra ? Math.max(0, lraLossLu - budget.maxLraLossLu) : 0;
    return {
      crestLossDb,
      lraLossLu,
      crestExcessDb,
      lraExcessLu,
      safe: crestExcessDb <= 0.05 && lraExcessLu <= 0.05,
    };
  }

  function candidatePlan(requestedPlan, targetLufs, { bypassCompressor = false, transparent = false } = {}) {
    const deltaTarget = targetLufs - requestedPlan.targetLufs;
    return {
      ...requestedPlan,
      eq: transparent ? [] : requestedPlan.eq,
      compressor: bypassCompressor || transparent ? null : requestedPlan.compressor,
      gainDb: clamp(requestedPlan.gainDb + deltaTarget, -24, 8),
      targetLufs,
      mfDynamicsCompressorBypassed: Boolean((bypassCompressor || transparent) && requestedPlan.compressor),
      mfDynamicsTransparent: transparent,
    };
  }

  function adaptiveBackoff(evaluation) {
    const excess = Math.max(evaluation.crestExcessDb, evaluation.lraExcessLu);
    return clamp(Math.ceil((excess + 0.75) * 2) / 2, 1, 4);
  }

  function transparentTarget(sourceMetrics, requestedPlan, sourceBuffer) {
    const sourceTruePeakDb = mfEstimateTruePeak(sourceBuffer);
    const requestedGainDb = requestedPlan.targetLufs - sourceMetrics.lufs;
    const truePeakCeilingDb = Number(requestedPlan.truePeakCeilingDb ?? requestedPlan.ceilingDb ?? -1);
    const peakHeadroomDb = Number.isFinite(sourceTruePeakDb)
      ? truePeakCeilingDb - sourceTruePeakDb - 0.15
      : 0;
    const safeGainDb = Math.min(requestedGainDb, peakHeadroomDb);
    return {
      targetLufs: sourceMetrics.lufs + safeGainDb,
      sourceTruePeakDb,
      peakHeadroomDb,
    };
  }

  async function renderCandidate(plan, requestedPlan) {
    if (state.masterPlan !== requestedPlan) {
      throw new Error('Mastering settings changed before the dynamics guard could render. Render again.');
    }
    state.masterPlan = plan;
    try {
      const buffer = await previousRenderReleaseMaster();
      if (state.masterPlan !== plan) {
        throw new Error('Mastering settings changed during the dynamics guard render. Render again.');
      }
      return {
        buffer,
        metrics: measureBuffer(buffer),
        constraint: { ...(state.masterConstraint || {}) },
        plan,
      };
    } finally {
      // A user change during rendering must win. Never restore an old plan over it.
      if (state.masterPlan === plan) state.masterPlan = requestedPlan;
    }
  }

  renderReleaseMaster = async function renderDynamicsPreservedMaster() {
    const source = state.corrected;
    const requestedPlan = state.masterPlan;
    if (!source || !requestedPlan) return previousRenderReleaseMaster();

    const sourceMetrics = measureBuffer(source);
    const budget = budgetFor(sourceMetrics, Number(source.duration) || 0);
    const requestedTargetLufs = requestedPlan.targetLufs;
    let attempt = await renderCandidate(requestedPlan, requestedPlan);
    let evaluation = evaluateDynamics(sourceMetrics, attempt.metrics, budget);
    let guardApplied = false;

    if (!evaluation.safe) {
      guardApplied = true;
      const backoffDb = adaptiveBackoff(evaluation);
      const backedOffTarget = Math.max(-24, requestedTargetLufs - backoffDb);
      const backedOffPlan = candidatePlan(requestedPlan, backedOffTarget, { bypassCompressor: true });
      attempt = await renderCandidate(backedOffPlan, requestedPlan);
      evaluation = evaluateDynamics(sourceMetrics, attempt.metrics, budget);
    }

    if (!evaluation.safe) {
      // Last resort is intentionally boring: no tonal EQ, no compressor, and no
      // gain beyond measured true-peak headroom. Better a quieter transparent
      // master than a loud file that MixForge itself measured as over-processed.
      const transparent = transparentTarget(sourceMetrics, requestedPlan, source);
      const transparentPlan = candidatePlan(requestedPlan, transparent.targetLufs, {
        bypassCompressor: true,
        transparent: true,
      });
      attempt = await renderCandidate(transparentPlan, requestedPlan);
      evaluation = evaluateDynamics(sourceMetrics, attempt.metrics, budget);
    }

    if (state.corrected !== source || state.masterPlan !== requestedPlan) {
      throw new Error('The source or mastering settings changed during dynamics verification. Render again.');
    }

    const effectivePlan = attempt.plan;
    state.masterEffectivePlan = effectivePlan;
    state.masterConstraint = {
      ...attempt.constraint,
      requestedTargetLufs,
      effectiveTargetLufs: effectivePlan.targetLufs,
      dynamicsBackoffDb: Math.max(0, requestedTargetLufs - effectivePlan.targetLufs),
      compressorBypassed: Boolean(effectivePlan.mfDynamicsCompressorBypassed),
      transparentFallback: Boolean(effectivePlan.mfDynamicsTransparent),
      dynamicsGuardApplied: guardApplied || Boolean(effectivePlan.mfDynamicsTransparent),
      dynamicsSafe: evaluation.safe,
      sourceCrestDb: sourceMetrics.crestDb,
      finalCrestDb: attempt.metrics.crestDb,
      crestLossDb: evaluation.crestLossDb,
      maxCrestLossDb: budget.maxCrestLossDb,
      sourceLra: sourceMetrics.lra,
      finalLra: attempt.metrics.lra,
      lraLossLu: evaluation.lraLossLu,
      maxLraLossLu: budget.maxLraLossLu,
      lraGuardMeasured: budget.enforceLra,
    };

    return attempt.buffer;
  };

  renderVerification = function renderDynamicsVerification(metrics, requestedPlan) {
    const constraint = state.masterConstraint || {};
    const effectivePlan = state.masterEffectivePlan || requestedPlan;
    previousRenderVerification(metrics, effectivePlan);

    const root = $('verificationList');
    if (!root || !Number.isFinite(constraint.crestLossDb)) return;
    const safe = constraint.dynamicsSafe !== false;
    const row = document.createElement('div');
    row.className = `check ${safe ? '' : 'fail'}`;
    const crestText = `${constraint.crestLossDb.toFixed(1)} dB crest loss (guardrail ${constraint.maxCrestLossDb.toFixed(1)} dB)`;
    const lraText = constraint.lraGuardMeasured
      ? ` · ${constraint.lraLossLu.toFixed(1)} LU range loss (guardrail ${constraint.maxLraLossLu.toFixed(1)} LU)`
      : ' · range guard not scored on this short/low-range source';
    row.innerHTML = `<b>${safe ? '✓' : '×'}</b><div><strong>Dynamics preservation: </strong>${crestText}${lraText}.</div>`;
    root.append(row);

    if (constraint.dynamicsGuardApplied) {
      const action = document.createElement('div');
      action.className = 'check warn';
      const parts = [];
      if (constraint.dynamicsBackoffDb > 0.05) {
        parts.push(`finished at ${constraint.effectiveTargetLufs.toFixed(1)} LUFS instead of forcing the requested ${constraint.requestedTargetLufs.toFixed(1)} LUFS`);
      }
      if (constraint.compressorBypassed) parts.push('bypassed planned master glue');
      if (constraint.transparentFallback) parts.push('used the transparent safety path with no mastering EQ or compression');
      action.innerHTML = `<b>!</b><div><strong>Dynamics guard intervened: </strong>${parts.join(' · ')}. Loudness yielded to measured punch and movement.</div>`;
      root.append(action);
    }
  };

  const previousRenderMasterChain = renderMasterChain;
  renderMasterChain = function renderDynamicsAwareMasterChain(plan) {
    previousRenderMasterChain(plan);
    const constraint = state.masterConstraint;
    if (!constraint?.dynamicsGuardApplied || !state.masterEffectivePlan) return;
    const effective = state.masterEffectivePlan;
    const root = $('masterChain');
    if (!root) return;
    const row = document.createElement('div');
    row.className = 'chain-item';
    const label = document.createElement('b');
    label.textContent = 'Measured dynamics safety';
    const value = document.createElement('span');
    const parts = [`effective target ${effective.targetLufs.toFixed(1)} LUFS`];
    if (constraint.compressorBypassed) parts.push('master glue bypassed');
    if (constraint.transparentFallback) parts.push('transparent EQ/comp bypass');
    value.textContent = `${parts.join(' · ')} · requested loudness was not forced`;
    row.append(label, value);
    root.append(row);
  };

  globalThis.mixForgeDynamicsGuard = {
    budgetFor,
    evaluateDynamics,
    candidatePlan,
    adaptiveBackoff,
    transparentTarget,
  };
})();
