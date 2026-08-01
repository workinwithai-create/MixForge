'use strict';

// Final replacement gate. This deliberately overrides the UI module's initial
// evaluator so only whole-song measurements—not an AudioBuffer-only helper
// called with metric data—decide whether a candidate may replace the master.
mfTargetEvaluateCandidate = function mfTargetEvaluateCandidateGuarded(beforeAnalysis, afterAnalysis, beforeMetrics, afterMetrics, plan = {}) {
  const beforeHigh = new Set((beforeAnalysis?.markers || []).filter((marker) => marker.severity === 'high').map((marker) => marker.type));
  const afterHigh = new Set((afterAnalysis?.markers || []).filter((marker) => marker.severity === 'high').map((marker) => marker.type));
  const newHigh = [...afterHigh].filter((type) => !beforeHigh.has(type));
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
};
