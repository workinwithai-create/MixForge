'use strict';

// The stereo scan may use AI to refine prose, but it must not replace measured
// forensic findings or claim source attribution before stems are isolated.
validateAudit = function validateForensicAudit(aiValue, measuredFallback) {
  if (!aiValue || typeof aiValue !== 'object') return measuredFallback;
  const aiSummary = String(aiValue.summary || '').trim();
  return {
    ...measuredFallback,
    summary: aiSummary
      ? `${measuredFallback.summary} Engineer note: ${aiSummary.slice(0, 360)}`
      : measuredFallback.summary,
    readinessScore: measuredFallback.readinessScore,
    findings: measuredFallback.findings,
    stemsToInspect: measuredFallback.stemsToInspect,
  };
};
