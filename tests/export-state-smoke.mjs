import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const statuses = [];
const exportButton = {
  disabled: false,
  textContent: 'Download release WAV',
  addEventListener(type, handler) {
    if (type === 'click') this.handler = handler;
  },
};
const override = {
  checked: false,
  addEventListener(type, handler) {
    if (type === 'change') this.handler = handler;
  },
};

const context = vm.createContext({
  console,
  Math,
  Array,
  Blob,
  DataView,
  ArrayBuffer,
  clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
  sleep: async () => {},
  setStatus: (_id, message, kind) => statuses.push({ message, kind }),
  state: {
    master: { numberOfChannels: 1, length: 1, sampleRate: 48000, getChannelData: () => new Float32Array([0]) },
    masterDirty: true,
    finalMetrics: { clipPercent: 0, peakDb: -1.2, correlation: 0.6 },
    masterPlan: { truePeakCeilingDb: -1, ceilingDb: -1.2 },
    exportOverride: false,
  },
  $: (id) => {
    if (id === 'exportBtn') return exportButton;
    if (id === 'exportOverride') return override;
    if (id === 'exportSafety') return { classList: { add() {}, remove() {} } };
    if (id === 'exportSafetyMsg') return { textContent: '' };
    return { value: '24', textContent: '', className: '' };
  },
  URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
  document: { createElement: () => ({ click() {}, remove() {} }), body: { append() {} } },
  setTimeout,
});
context.globalThis = context;

vm.runInContext(fs.readFileSync(new URL('../js/app-export.js', import.meta.url), 'utf8'), context);

await exportButton.handler();
assert.equal(statuses.at(-1).kind, 'error');
assert.match(statuses.at(-1).message, /out of date/i);

context.state.masterDirty = false;
context.state.finalMetrics = { clipPercent: 0.2, peakDb: 0, correlation: 0.5 };
const clipGate = context.evaluateExportGate(context.state);
assert.equal(clipGate.allow, false);
assert.equal(clipGate.reason, 'safety');
assert.equal(clipGate.clipFail, true);

await exportButton.handler();
assert.equal(statuses.at(-1).kind, 'error');
assert.match(statuses.at(-1).message, /blocked|clip/i);

context.state.exportOverride = true;
const overridden = context.evaluateExportGate(context.state);
assert.equal(overridden.allow, true);
assert.equal(overridden.verified, false);

context.state.exportOverride = false;
context.state.finalMetrics = { clipPercent: 0, peakDb: -1.4, correlation: 0.6 };
context.state.masterConstraint = { truePeakDb: 0.2 };
const tpGate = context.evaluateExportGate(context.state);
assert.equal(tpGate.allow, false);
assert.equal(tpGate.tpFail, true);

const clean = context.evaluateExportGate({
  master: context.state.master,
  masterDirty: false,
  finalMetrics: { clipPercent: 0, peakDb: -1.4, correlation: 0.55 },
  masterPlan: { truePeakCeilingDb: -1 },
  masterConstraint: { truePeakDb: -1.05 },
  exportOverride: false,
});
assert.equal(clean.allow, true);
assert.equal(clean.verified, true);

console.log('MixForge export-state smoke tests passed');
