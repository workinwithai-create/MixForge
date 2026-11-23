// Steps layout: the rule that picks which step is on screen, and the page wiring.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/app-steps.js', import.meta.url), 'utf8');
const sandbox = { module: { exports: {} } };
vm.runInNewContext(source, sandbox); // no document here, so only the pure parts run
const { MF_STEPS, MF_STEP_COMPANIONS, mfStepsResolve } = sandbox.module.exports;

assert.equal(MF_STEPS.map((s) => s.key).join(','), 'load,diagnose,stems,vocals,master,verify');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
for (const step of MF_STEPS) assert.match(html, new RegExp(`id="${step.panel}"`), `${step.panel} must be in the page`);

// The stem mixer sits with Load, and its id is the one the stem flow really creates.
assert.equal(MF_STEP_COMPANIONS.rebuildPanel, 'load');
assert.match(readFileSync(new URL('../js/app-stem-rebuild.js', import.meta.url), 'utf8'), /id: 'rebuildPanel'/);

const none = { load: true, diagnose: false, stems: false, vocals: false, master: false, verify: false };
assert.equal(mfStepsResolve('load', none), 'load');
assert.equal(mfStepsResolve('master', none), 'load', 'a step that is not reached cannot be shown');
assert.equal(mfStepsResolve(null, none), 'load');

// Quick Master path: stems are never opened.
const quick = { load: true, diagnose: true, stems: false, vocals: false, master: true, verify: false };
assert.equal(mfStepsResolve('master', quick), 'master');
assert.equal(mfStepsResolve('stems', quick), 'diagnose', 'falls back to the step before');
assert.equal(mfStepsResolve('vocals', quick), 'diagnose', 'no vocal stem on the Quick Master path');
assert.equal(mfStepsResolve('verify', quick), 'master');

// A new song hides everything after Load while the user sits on Verify.
assert.equal(mfStepsResolve('verify', none), 'load');

// Wiring: loads last, its styles load after the theme, and the stacked page is still reachable.
assert.ok(html.indexOf('app-steps.js') > html.indexOf('app-stem-rebuild.js'), 'steps layout loads after the app');
assert.ok(html.indexOf('/steps.css') > html.indexOf('/pipe-dreams.css'), 'steps styles load after the theme');
assert.match(source, /steps'\) === '0'/, '?steps=0 must turn the layout off');
const css = readFileSync(new URL('../steps.css', import.meta.url), 'utf8');
for (const rule of css.split('}').map((r) => r.trim()).filter((r) => r && !r.startsWith('@') && !r.startsWith('/*'))) {
  const selector = rule.slice(0, rule.indexOf('{')).replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (!selector || selector.startsWith('@')) continue;
  for (const part of selector.split(',')) assert.match(part, /\.mf-steps/, `"${part.trim()}" must be scoped to the steps layout`);
}
console.log('steps layout smoke ok');
