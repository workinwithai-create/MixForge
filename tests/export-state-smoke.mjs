import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const statuses = [];
const exportButton = {
  disabled: false,
  addEventListener(type, handler) {
    assert.equal(type, 'click');
    this.handler = handler;
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
  state: { master: { numberOfChannels: 1, length: 1, sampleRate: 48000, getChannelData: () => new Float32Array([0]) }, masterDirty: true },
  $: (id) => id === 'exportBtn' ? exportButton : { value: '24', textContent: '', className: '' },
  URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
  document: { createElement: () => ({ click() {}, remove() {} }), body: { append() {} } },
  setTimeout,
});

vm.runInContext(fs.readFileSync(new URL('../js/app-export.js', import.meta.url), 'utf8'), context);

await exportButton.handler();
assert.equal(statuses.at(-1).kind, 'error');
assert.match(statuses.at(-1).message, /out of date/i);

console.log('MixForge export-state smoke tests passed');
