import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const elements = new Map();
const getElement = (id) => {
  if (!elements.has(id)) elements.set(id, { disabled: false, classList: { add() {}, remove() {} } });
  return elements.get(id);
};
const listeners = {};
const context = vm.createContext({
  console, Object, Number, JSON, Promise, queueMicrotask,
  globalThis: null,
  state: {
    stemPlans: {
      vocals: { selectedCandidate: 1 },
      bass: { selectedCandidate: 1 },
    },
    corrected: { id: 'old-corrected' }, correctedMetrics: { lufs: -15 },
    masterPlan: { targetLufs: -12 }, master: { id: 'old-master' }, finalMetrics: { lufs: -12 },
    masterConstraint: { truePeakDb: -1.1 }, masterLevelMatched: {}, masterDelta: {}, masterChange: {},
    masterDirty: false, exportOverride: true,
  },
  mixForgeSequential: { plan: {}, stages: [1], snapshots: { 1: {} }, lastError: new Error('old') },
  stopPreview() {},
  hide() {},
  $: getElement,
  setStatus() {},
  document: { addEventListener(type, fn) { listeners[type] = fn; } },
  buildStemPlans: async () => {},
  rebuildCorrectedMix: async () => ({ id: 'new-corrected' }),
  prepareMastering: () => 'prepared',
  renderReleaseMaster: async () => ({ id: 'master' }),
  markMasterRendered: () => 'marked',
  evaluateExportGate: () => ({ allow: true, verified: true }),
});
context.globalThis = context;
vm.runInContext(fs.readFileSync(new URL('../js/app-state-integrity.js', import.meta.url), 'utf8'), context);

assert.equal(context.state.repairRevision, 0);
context.state.stemPlans.vocals.selectedCandidate = 2;
assert.equal(vm.runInContext('mixForgeStateIntegrity.noteRepairChoiceChange()', context), true);
assert.equal(context.state.repairRevision, 1);
assert.equal(context.state.corrected, null);
assert.equal(context.state.master, null);
assert.equal(context.state.masterPlan, null);
assert.equal(context.state.masterDirty, true);
assert.equal(context.state.exportOverride, false);
assert.equal(context.mixForgeSequential.plan, null);
assert.equal(getElement('exportBtn').disabled, true);

await context.buildStemPlans();
assert.equal(context.state.repairRevision, 2);
context.state.corrected = { id: 'source' };
const rebuilt = await context.rebuildCorrectedMix();
assert.equal(rebuilt.id, 'new-corrected');
assert.equal(context.state.correctedRepairRevision, 2);
context.state.corrected = rebuilt;
assert.equal(context.prepareMastering(), 'prepared');
await context.renderReleaseMaster();
context.markMasterRendered({ id: 'master' });
assert.equal(context.state.masterRepairRevision, 2);
assert.equal(context.evaluateExportGate(context.state).allow, true);

context.state.stemPlans.bass.selectedCandidate = 0;
vm.runInContext('mixForgeStateIntegrity.noteRepairChoiceChange()', context);
const gate = context.evaluateExportGate(context.state);
assert.equal(gate.allow, false);
assert.equal(gate.reason, 'stale-repair');
await assert.rejects(context.renderReleaseMaster(), /out of date/);
assert.throws(() => context.prepareMastering(), /out of date/);

console.log('MixForge state-integrity smoke tests passed');
