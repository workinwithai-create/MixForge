import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('./mediabunny-1-56-1/index.html', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('./mediabunny-1-56-1/lab.js', import.meta.url), 'utf8');

assert.match(html, /TEST BUILD · MEDIABUNNY 1\.56\.1 · NOT LIVE/);
assert.match(script, /mediabunny@1\.56\.1\/\+esm/);
assert.match(script, /trim: \{ start, end \}/);
assert.match(script, /shiftTolerance: 0/);
assert.match(script, /input\.dispose\(\)/);
console.log('MediaBunny 1.56.1 lab smoke test passed.');
