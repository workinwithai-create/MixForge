import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const sourceMetrics = { lufs: -18, crestDb: 12, lra: 8, peakDb: -5 };
const source = { duration: 180, kind: 'source', metrics: sourceMetrics };
const attempts = [];
let scenario = 'backoff';
let sourceTruePeak = -5;
let lastChainPlan = null;

function requestedPlan(targetLufs = -10) {
  return {
    eq: [{ type: 'eq', gain: -1 }],
    compressor: { type: 'compressor', ratio: 1.45 },
    gainDb: 8,
    targetLufs,
    ceilingDb: -1.2,
    truePeakCeilingDb: -1,
  };
}

const masterChainRoot = { append() {}, replaceChildren() {} };
const verificationRoot = { append() {}, replaceChildren() {} };
const context = vm.createContext({
  console, Math, Number, Object, Array, Promise,
  clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
  state: {
    corrected: source,
    masterPlan: requestedPlan(),
    masterConstraint: null,
    masterEffectivePlan: null,
  },
  measureBuffer(buffer) { return buffer?.metrics || sourceMetrics; },
  mfEstimateTruePeak() { return sourceTruePeak; },
  async renderReleaseMaster() {
    const plan = context.state.masterPlan;
    attempts.push({
      targetLufs: plan.targetLufs,
      gainDb: plan.gainDb,
      compressor: plan.compressor,
      eq: plan.eq,
      transparent: Boolean(plan.mfDynamicsTransparent),
    });

    let metrics;
    if (scenario === 'safe') {
      metrics = { lufs: plan.targetLufs, crestDb: 11.2, lra: 7.2, peakDb: -1.2 };
    } else if (scenario === 'backoff') {
      metrics = attempts.length === 1
        ? { lufs: plan.targetLufs, crestDb: 8, lra: 4, peakDb: -1.2 }
        : { lufs: plan.targetLufs, crestDb: 11.3, lra: 7, peakDb: -1.2 };
    } else {
      metrics = plan.mfDynamicsTransparent
        ? { lufs: plan.targetLufs, crestDb: 12, lra: 8, peakDb: -1.15 }
        : { lufs: plan.targetLufs, crestDb: 8, lra: 4, peakDb: -1.2 };
    }
    context.state.masterConstraint = {
      truePeakDb: -1.05,
      targetLufs: plan.targetLufs,
      achievedLufs: metrics.lufs,
    };
    return { duration: 180, kind: 'render', metrics };
  },
  renderVerification() {},
  renderMasterChain(plan) { lastChainPlan = plan; },
  prepareMastering() { return 'prepared'; },
  document: {
    createElement() {
      return { className: '', textContent: '', innerHTML: '', append() {} };
    },
  },
  $(id) {
    if (id === 'masterChain') return masterChainRoot;
    if (id === 'verificationList') return verificationRoot;
    return null;
  },
});
context.globalThis = context;
vm.runInContext(fs.readFileSync(new URL('../js/app-dynamics-guard.js', import.meta.url), 'utf8'), context);

// A master that stays inside the measured dynamics budget is left alone.
scenario = 'safe';
attempts.length = 0;
context.state.masterPlan = requestedPlan(-12);
context.state.masterConstraint = null;
await context.renderReleaseMaster();
assert.equal(attempts.length, 1);
assert.equal(context.state.masterConstraint.dynamicsGuardApplied, false);
assert.equal(context.state.masterConstraint.effectiveTargetLufs, -12);
assert.equal(context.state.masterEffectivePlan.compressor?.type, 'compressor');

// A squashed candidate backs off loudness, bypasses glue, and recomputes gain
// from measured source LUFS rather than from an already-clamped requested gain.
scenario = 'backoff';
attempts.length = 0;
context.state.masterPlan = requestedPlan(-10);
context.state.masterConstraint = null;
await context.renderReleaseMaster();
assert.equal(attempts.length, 2);
assert.equal(context.state.masterPlan.targetLufs, -10, 'requested settings must be restored');
assert.equal(context.state.masterConstraint.dynamicsSafe, true);
assert.equal(context.state.masterConstraint.dynamicsGuardApplied, true);
assert.equal(context.state.masterConstraint.compressorBypassed, true);
assert.equal(context.state.masterConstraint.transparentFallback, false);
assert.equal(context.state.masterConstraint.effectiveTargetLufs, -13.5);
assert.equal(context.state.masterEffectivePlan.gainDb, 4.5, 'effective gain should be target - measured source LUFS');
assert.equal(lastChainPlan.targetLufs, -13.5, 'displayed chain should show the effective measured path');

// If backoff still fails, fall all the way to a transparent path whose gain is
// bounded by source true-peak headroom instead of forcing the LUFS request.
scenario = 'transparent';
sourceTruePeak = -0.5;
attempts.length = 0;
context.state.masterPlan = requestedPlan(-9);
context.state.masterConstraint = null;
await context.renderReleaseMaster();
assert.equal(attempts.length, 3);
assert.equal(context.state.masterConstraint.dynamicsSafe, true);
assert.equal(context.state.masterConstraint.transparentFallback, true);
assert.equal(context.state.masterEffectivePlan.eq.length, 0);
assert.equal(context.state.masterEffectivePlan.compressor, null);
assert.ok(Math.abs(context.state.masterConstraint.effectiveTargetLufs - (-18.65)) < 1e-9);
assert.ok(Math.abs(context.state.masterEffectivePlan.gainDb - (-0.65)) < 1e-9);
assert.equal(context.state.masterPlan.targetLufs, -9, 'transparent safety must not overwrite the requested setting');

// Preparing a new corrected mix must not carry prior effective-path evidence.
context.state.masterEffectivePlan = { targetLufs: -99 };
context.state.masterConstraint = { dynamicsGuardApplied: true };
assert.equal(context.prepareMastering(), 'prepared');
assert.equal(context.state.masterEffectivePlan, null);
assert.equal(context.state.masterConstraint, null);

console.log('MixForge dynamics-guard smoke tests passed');
