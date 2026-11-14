import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../stem-reliability-lab.html', import.meta.url), 'utf8');

assert.match(html, /decodeAudioData/);
assert.match(html, /least-squares gain fit/i);
assert.match(html, /residual/i);
assert.match(html, /exact-sum residual/i);
assert.match(html, /exactResidualEnergy/);
assert.match(html, /correlation/i);
assert.match(html, /first 90 seconds/i);
assert.match(html, /nothing is uploaded/i);
assert.match(html, /does not prove/i);
assert.match(html, /https:\/\/arxiv\.org\/abs\/2611\.09358/);
assert.match(html, /https:\/\/arxiv\.org\/abs\/2611\.16933/);
assert.match(html, /https:\/\/github\.com\/rapidly-labs\/rapidly-sdk/);
assert.match(html, /96 ms stated latency/i);
assert.match(html, /WebAssembly is not yet available/i);
assert.match(html, /\['guitar','Guitar stem','Optional'\]/);
assert.match(html, /\['piano','Piano stem','Optional'\]/);
assert.match(html, /\['residualBus','Residual bus','Optional'\]/);
assert.doesNotMatch(html, /fetch\s*\(/);
assert.doesNotMatch(html, /XMLHttpRequest|WebSocket/);

console.log('stem reliability lab smoke test passed');
