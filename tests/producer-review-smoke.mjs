import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({
  console,
  Math,
  Number,
  Object,
  Array,
  String,
  Set,
});
context.globalThis = context;
vm.runInContext(fs.readFileSync(new URL('../js/app-producer-review.js', import.meta.url), 'utf8'), context);

assert.equal(typeof context.mfBuildFallbackProducerReview, 'function');
assert.equal(typeof context.mfProducerReviewScript, 'function');
assert.equal(typeof context.mfPlainProducerFix, 'function');

const review = context.mfBuildFallbackProducerReview({
  findings: [
    { severity: 'high', problem: 'Clipped or overloaded source', action: 'Export a clean pre-limiter bounce.' },
    { severity: 'medium', problem: 'Lead clarity is masked', action: 'Inspect the vocal.' },
  ],
}, {
  clipPercent: 0.02,
  peakDb: -0.01,
  correlation: 0.7,
  crestDb: 11,
});

assert.equal(review.source, 'measured');
assert.ok(review.whatsWorking.length >= 1);
assert.ok(review.fixFirst.length >= 1 && review.fixFirst.length <= 3);
assert.match(review.fixFirst[0].title, /cleaner bounce/i);
assert.doesNotMatch(review.honestTake, /spectral|inter-channel|crest factor/i);

const script = context.mfProducerReviewScript({
  opening: 'The chorus has real lift.',
  whatsWorking: ['The vocal stays believable.'],
  honestTake: 'The song is good; the mix is not showing all of it yet.',
  fixFirst: [{ title: 'Bring the vocal forward', why: 'The words disappear.', move: 'Clear space around it.' }],
  protect: 'Keep the crack in the vocal.',
});
assert.match(script, /what is working/i);
assert.match(script, /my honest take/i);
assert.match(script, /first thing I would fix/i);
assert.match(script, /what I would protect/i);

const indexHtml = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
assert.match(indexHtml, /id="producerReview"/);
assert.match(indexHtml, /Get my producer review/);
assert.match(indexHtml, /View engineer analysis/);
assert.match(indexHtml, /app-producer-review\.js/);
assert.match(indexHtml, /producer-review\.css/);
assert.match(indexHtml, /2\.6\.0/);

console.log('producer-review-smoke: ok');
