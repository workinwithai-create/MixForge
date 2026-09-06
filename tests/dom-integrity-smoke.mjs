import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

class FakeClassList {
  constructor(...names) { this.names = new Set(names); }
  contains(name) { return this.names.has(name); }
  add(name) { this.names.add(name); }
  remove(name) { this.names.delete(name); }
}

class FakeNode {
  constructor(parentElement = null, ...classes) {
    this.parentElement = parentElement;
    this.classList = new FakeClassList(...classes);
  }
}

const panel = {
  children: [],
  all: [],
  querySelectorAll(selector) {
    if (selector !== '.actions') return [];
    return this.all.filter((node) => node.classList.contains('actions'));
  },
};

const grid = new FakeNode(panel, 'stem-grid');
const directActions = new FakeNode(panel, 'actions');
const vocalCleanup = new FakeNode(grid, 'actions', 'vocal-cleanup-preview');
panel.children = [grid, directActions];
// DOM order deliberately puts the nested action group first, matching the bug.
panel.all = [vocalCleanup, directActions];

let calls = 0;
const context = vm.createContext({
  console,
  Array,
  globalThis: null,
  $: (id) => id === 'stemPanel' ? panel : null,
  rebuildCorrectedMix: async () => {
    calls++;
    const firstAction = panel.querySelectorAll('.actions')[0];
    if (firstAction.parentElement !== panel) {
      throw new Error("Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.");
    }
    return 'rebuilt';
  },
});
context.globalThis = context;
vm.runInContext(fs.readFileSync(new URL('../js/app-dom-integrity.js', import.meta.url), 'utf8'), context);

const result = await context.rebuildCorrectedMix();
assert.equal(result, 'rebuilt');
assert.equal(calls, 1);
assert.equal(vocalCleanup.classList.contains('actions'), true, 'nested action class must be restored after rebuild');
assert.equal(directActions.classList.contains('actions'), true, 'direct rebuild action class must never be removed');
assert.equal(context.mixForgeDomIntegrity.directActionChild(panel), directActions);
assert.deepEqual(context.mixForgeDomIntegrity.nestedActionNodes(panel), [vocalCleanup]);

console.log('DOM integrity regression tests passed');
