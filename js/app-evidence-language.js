'use strict';

// Evidence-to-language guard. Loaded after the musician UX so reports and
// producer-facing copy describe the measurement that actually gated the final
// audio rather than a superseded internal estimator.
(function installEvidenceLanguageGuard() {
  if (typeof mfPlainWhatChanged !== 'function' || typeof mfBuildReadinessReportText !== 'function') return;

  const previousPlainWhatChanged = mfPlainWhatChanged;
  const previousBuildReadinessReportText = mfBuildReadinessReportText;

  function peakEvidence(snapshot = state) {
    const constraint = snapshot?.masterConstraint || {};
    const measured = Number(constraint.truePeakDb);
    const ceiling = Number(constraint.truePeakCeilingDb ?? snapshot?.masterPlan?.truePeakCeilingDb ?? -1);
    const method = constraint.truePeakMethod || 'unknown';
    const trimDb = Number(constraint.truePeakSafetyTrimDb);
    const padDb = Number(constraint.truePeakSafetyPadDb);
    const standardsDerived = constraint.truePeakStandardsDerived === true;

    if (standardsDerived && Number.isFinite(measured)) {
      return {
        method,
        measured,
        ceiling,
        standardsDerived: true,
        shortLabel: '4× polyphase FIR inter-sample check',
        reportLabel: '4× polyphase FIR (BS.1770 Annex-2 coefficient set; browser implementation, not certified)',
        bullet: `Final inter-sample peak ${measured.toFixed(2)} dBTP (ceiling ${ceiling.toFixed(1)}; 4× polyphase FIR browser check${Number.isFinite(trimDb) && trimDb < -0.01 ? `; safety trim ${trimDb.toFixed(2)} dB` : ''}; not a certified meter).`,
      };
    }

    if (method === 'cubic-fallback' && Number.isFinite(measured)) {
      return {
        method,
        measured,
        ceiling,
        standardsDerived: false,
        shortLabel: 'conservative cubic fallback',
        reportLabel: `cubic fallback${Number.isFinite(padDb) ? ` with ${padDb.toFixed(2)} dB extra headroom` : ' with extra headroom'} (not certified)`,
        bullet: `Final peak safety ${measured.toFixed(2)} dBTP (ceiling ${ceiling.toFixed(1)}; cubic fallback${Number.isFinite(padDb) ? ` with ${padDb.toFixed(2)} dB extra headroom` : ''}${Number.isFinite(trimDb) && trimDb < -0.01 ? `; safety trim ${trimDb.toFixed(2)} dB` : ''}; not equivalent to the 4× check).`,
      };
    }

    return {
      method,
      measured: Number.isFinite(measured) ? measured : null,
      ceiling,
      standardsDerived: false,
      shortLabel: 'peak estimate',
      reportLabel: 'peak estimate (final 4× evidence unavailable)',
      bullet: Number.isFinite(measured)
        ? `Final peak estimate ${measured.toFixed(2)} dBTP (ceiling ${ceiling.toFixed(1)}; final 4× evidence unavailable; not a certified meter).`
        : 'Final inter-sample peak evidence is unavailable; do not treat this render as peak-verified.',
    };
  }

  mfPlainWhatChanged = function mfPlainWhatChangedWithPeakEvidence(...args) {
    const result = previousPlainWhatChanged(...args);
    const evidence = peakEvidence(state);
    const bullets = Array.isArray(result?.bullets) ? [...result.bullets] : [];
    const peakIndex = bullets.findIndex((bullet) => /true[- ]?peak|inter[- ]sample peak|final peak/i.test(String(bullet)));
    if (peakIndex >= 0) bullets[peakIndex] = evidence.bullet;
    else bullets.splice(Math.min(2, bullets.length), 0, evidence.bullet);
    return { ...result, bullets, peakEvidence: evidence };
  };

  mfBuildReadinessReportText = function mfBuildReadinessReportTextWithPeakEvidence(payload) {
    const evidence = payload?.peakEvidence || peakEvidence(state);
    let text = previousBuildReadinessReportText(payload);
    const value = Number.isFinite(evidence.measured)
      ? `${evidence.measured.toFixed(2)} dBTP`
      : 'unavailable';
    text = text.replace(/^- True peak:.*$/m, `- Final inter-sample peak: ${value}`);
    text = text.replace(
      /^- Readiness:/m,
      `- Peak evidence: ${evidence.reportLabel}\n- Readiness:`,
    );
    return text;
  };

  if (typeof mfUpdateMasterCopy === 'function') {
    const previousUpdateMasterCopy = mfUpdateMasterCopy;
    mfUpdateMasterCopy = function mfUpdateMasterCopyWithCurrentPeakPath(...args) {
      previousUpdateMasterCopy(...args);
      const copy = document.querySelector('#masterPanel .panel-title p');
      if (!copy) return;
      const hasReference = Boolean(typeof forensicState === 'object' && forensicState?.references?.length);
      copy.textContent = hasReference
        ? 'Reference-bounded tonal balance is active because a reference file is loaded. Controlled dynamics, loudness, limiting, then a final 4× inter-sample peak check with a conservative fallback. First value is hearing Original vs Master.'
        : 'Conservative stereo master. Optional reference-bounded tonal balance only if you load a reference. Controlled dynamics, loudness, limiting, then a final 4× inter-sample peak check with a conservative fallback. First value is hearing Original vs Master.';
    };
  }

  globalThis.mixForgeEvidenceLanguage = { peakEvidence };
  globalThis.mfPlainWhatChanged = mfPlainWhatChanged;
  globalThis.mfBuildReadinessReportText = mfBuildReadinessReportText;
  if (typeof mfUpdateMasterCopy === 'function') globalThis.mfUpdateMasterCopy = mfUpdateMasterCopy;
})();
