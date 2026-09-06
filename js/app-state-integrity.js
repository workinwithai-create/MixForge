'use strict';

// Downstream-state integrity for Forensic repair decisions.
// Loaded last so it observes the final wrapped rebuild/master/export functions.
(function installRepairRevisionIntegrity() {
  if (typeof state !== 'object') return;

  state.repairRevision = Number.isInteger(state.repairRevision) ? state.repairRevision : 0;
  state.correctedRepairRevision = Number.isInteger(state.correctedRepairRevision) ? state.correctedRepairRevision : null;
  state.masterRepairRevision = Number.isInteger(state.masterRepairRevision) ? state.masterRepairRevision : null;

  const hasRepairPlan = (snapshot = state) => Boolean(snapshot?.stemPlans && Object.keys(snapshot.stemPlans).length);
  const choiceSignature = (snapshot = state) => {
    const plans = snapshot?.stemPlans || {};
    return JSON.stringify(Object.keys(plans).sort().map((stem) => [stem, Number(plans[stem]?.selectedCandidate ?? -1)]));
  };

  let lastChoiceSignature = choiceSignature();

  function clearDownstreamAudio(message = 'Repair choice changed. Apply the selected repairs again before mastering or export.') {
    if (typeof stopPreview === 'function') stopPreview();
    state.corrected = null;
    state.correctedMetrics = null;
    state.correctedRepairRevision = null;
    state.masterPlan = null;
    state.masterEffectivePlan = null;
    state.master = null;
    state.finalMetrics = null;
    state.masterConstraint = null;
    state.masterLevelMatched = null;
    state.masterDelta = null;
    state.masterChange = null;
    state.masterRepairRevision = null;
    state.masterDirty = true;
    state.exportOverride = false;

    if (globalThis.mixForgeSequential) {
      mixForgeSequential.plan = null;
      mixForgeSequential.stages = [];
      mixForgeSequential.snapshots = {};
      mixForgeSequential.lastError = null;
    }

    if (typeof hide === 'function') {
      for (const id of ['previewBox', 'verifyPanel', 'masterPanel']) {
        try { hide(id); } catch (_) {}
      }
    }
    if (typeof $ === 'function') {
      const exportBtn = $('exportBtn');
      if (exportBtn) exportBtn.disabled = true;
    }
    if (typeof setStatus === 'function') {
      try { setStatus('rebuildStatus', message, 'warn'); } catch (_) {}
    }
  }

  function noteRepairChoiceChange() {
    const signature = choiceSignature();
    if (signature === lastChoiceSignature) return false;
    lastChoiceSignature = signature;
    state.repairRevision += 1;
    clearDownstreamAudio();
    return true;
  }

  if (typeof buildStemPlans === 'function') {
    const previousBuildStemPlans = buildStemPlans;
    buildStemPlans = async function buildRevisionedStemPlans(...args) {
      const result = await previousBuildStemPlans(...args);
      state.repairRevision += 1;
      state.correctedRepairRevision = null;
      state.masterRepairRevision = null;
      lastChoiceSignature = choiceSignature();
      return result;
    };
  }

  if (typeof rebuildCorrectedMix === 'function') {
    const previousRebuildCorrectedMix = rebuildCorrectedMix;
    rebuildCorrectedMix = async function rebuildRevisionedCorrectedMix(...args) {
      const revision = state.repairRevision;
      const signature = choiceSignature();
      const result = await previousRebuildCorrectedMix(...args);
      if (state.repairRevision !== revision || choiceSignature() !== signature) {
        throw new Error('Repair settings changed during the mix rebuild. Apply the selected repairs again.');
      }
      state.correctedRepairRevision = revision;
      state.masterRepairRevision = null;
      return result;
    };
  }

  if (typeof prepareMastering === 'function') {
    const previousPrepareMastering = prepareMastering;
    prepareMastering = function prepareRevisionedMastering(...args) {
      if (hasRepairPlan() && state.correctedRepairRevision !== state.repairRevision) {
        throw new Error('The corrected mix is out of date with the selected repairs. Rebuild it before mastering.');
      }
      return previousPrepareMastering(...args);
    };
  }

  if (typeof renderReleaseMaster === 'function') {
    const previousRenderReleaseMaster = renderReleaseMaster;
    renderReleaseMaster = async function renderRevisionedReleaseMaster(...args) {
      if (hasRepairPlan() && state.correctedRepairRevision !== state.repairRevision) {
        throw new Error('The corrected mix is out of date with the selected repairs. Rebuild it before mastering.');
      }
      const revision = state.repairRevision;
      const corrected = state.corrected;
      const result = await previousRenderReleaseMaster(...args);
      if (state.repairRevision !== revision || state.corrected !== corrected) {
        throw new Error('Repair settings changed during mastering. Render the master again.');
      }
      return result;
    };
  }

  if (typeof markMasterRendered === 'function') {
    const previousMarkMasterRendered = markMasterRendered;
    markMasterRendered = function markRevisionedMasterRendered(buffer) {
      if (hasRepairPlan() && state.correctedRepairRevision !== state.repairRevision) {
        throw new Error('Cannot mark a master current because its corrected mix is stale.');
      }
      const result = previousMarkMasterRendered(buffer);
      state.masterRepairRevision = state.repairRevision;
      return result;
    };
  }

  if (typeof evaluateExportGate === 'function') {
    const previousEvaluateExportGate = evaluateExportGate;
    evaluateExportGate = function evaluateRevisionedExportGate(snapshot = state) {
      if (hasRepairPlan(snapshot)) {
        if (snapshot.correctedRepairRevision !== snapshot.repairRevision || snapshot.masterRepairRevision !== snapshot.repairRevision) {
          return {
            allow: false,
            reason: 'stale-repair',
            verified: false,
            clipFail: false,
            tpFail: false,
            monoWarn: false,
            message: 'Export blocked: repair choices changed after this audio was rendered. Rebuild the corrected mix and master again.',
          };
        }
      }
      return previousEvaluateExportGate(snapshot);
    };
  }

  if (typeof document === 'object' && document?.addEventListener) {
    const scheduleChoiceCheck = (event) => {
      const target = event.target;
      if (!target?.closest?.('#stemGrid .candidate-choices')) return;
      queueMicrotask(noteRepairChoiceChange);
    };
    document.addEventListener('click', scheduleChoiceCheck);
    document.addEventListener('change', scheduleChoiceCheck);
  }

  globalThis.mixForgeStateIntegrity = {
    choiceSignature,
    noteRepairChoiceChange,
    clearDownstreamAudio,
  };
})();
