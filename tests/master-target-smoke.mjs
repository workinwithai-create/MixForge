import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const handlers = {};
const elements = {};
const context = vm.createContext({
  console, state: { correctedMetrics: {}, master: {}, masterConstraint: {}, masterLevelMatched: {} },
  $: id => elements[id] ||= { value: '-14', addEventListener: (type, fn) => { handlers[`${id}:${type}`] = fn; } },
  document: { addEventListener() {} }, hide() {}, setStatus() {},
});
vm.runInContext(fs.readFileSync(new URL('../js/app-master.js', import.meta.url), 'utf8'), context);
context.buildMasterPlan = (_m, targetLufs) => ({targetLufs});
context.renderMasterChain = () => {};
handlers['targetLufs:change']();
assert.equal(context.state.masterPlan.targetLufs, -14);
assert.equal(context.state.master, null);
assert.equal(context.state.masterConstraint, null);
assert.equal(context.state.masterLevelMatched, null);
elements.targetLufs.value = '-10';
handlers['targetLufs:change']();
assert.equal(context.state.masterPlan.targetLufs, -10, 'target must update even before a new master exists');
console.log('Master target regression tests passed');
