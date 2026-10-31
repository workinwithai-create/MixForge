import fs from 'node:fs';
import assert from 'node:assert/strict';

const html = fs.readFileSync(new URL('../vocal-style-prior-lab.html', import.meta.url), 'utf8');

assert.match(html, /isolated preview · no production route/i);
assert.match(html, /Interaction prototype only/i);
assert.match(html, /accepted correction receipts/i);
assert.match(html, /Rejected moves should not train it/i);
assert.match(html, /Loudness-match the audition/i);
assert.match(html, /aria-live="polite"/i);
assert.match(html, /type="range"/i);
assert.match(html, /2610\.38696/);
assert.doesNotMatch(html, /fetch\s*\(/);
assert.doesNotMatch(html, /firebase|supabase/i);

console.log('vocal-style-prior-lab-smoke: ok');
