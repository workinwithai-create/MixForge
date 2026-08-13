import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const context = vm.createContext({
  console,
  Math,
  Number,
  Object,
  Array,
  Set,
  Promise,
  globalThis: {},
  clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
});
context.globalThis = context;

vm.runInContext(fs.readFileSync(new URL('../js/app-musician-ux.js', import.meta.url), 'utf8'), context);

assert.equal(typeof context.mfRecommendPath, 'function');
assert.equal(typeof context.mfNormalizeDemucsStems, 'function');
assert.equal(typeof context.mfPlainWhatChanged, 'function');
assert.equal(typeof context.mfBuildReadinessReportText, 'function');

const highReady = context.mfRecommendPath({
  readinessScore: 86,
  stemsToInspect: ['vocals'],
  findings: [{ severity: 'low', stage: 'mix' }],
});
assert.equal(highReady.path, 'quick', 'high readiness should recommend Quick Master');

const clean = context.mfRecommendPath({
  readinessScore: 72,
  stemsToInspect: [],
  findings: [],
});
assert.equal(clean.path, 'quick', 'no stems should recommend Quick Master');

const damaged = context.mfRecommendPath({
  readinessScore: 48,
  stemsToInspect: ['vocals', 'other'],
  findings: [{ severity: 'high', stage: 'mix' }, { severity: 'medium', stage: 'mix' }],
});
assert.equal(damaged.path, 'forensic', 'low readiness with isolation needs should recommend Forensic Fix');

const mapped = context.mfNormalizeDemucsStems(['vocals', 'guitars', 'keys', 'bass', 'guitars']);
assert.equal(JSON.stringify([...mapped.stems]), JSON.stringify(['vocals', 'other', 'bass']));
assert.ok(mapped.routes.some((route) => route.requested === 'guitars' && route.actual === 'other'));
assert.ok(mapped.routes.some((route) => route.requested === 'keys' && route.actual === 'other'));
assert.equal(mapped.stems.filter((stem) => stem === 'other').length, 1, 'guitars+keys must collapse to one other stem');

const framing = context.mfStemJobFraming(['vocals', 'other'], 240);
assert.match(framing.etaLabel, /min/i);
assert.match(framing.costLabel, /quota/i);
assert.match(framing.escapeLabel, /Skip stems/i);

const summary = context.mfPlainWhatChanged(
  { lufs: -16.2, peakDb: -0.4, crestDb: 12, correlation: 0.6, clipPercent: 0 },
  { lufs: -12.1, peakDb: -1.1, crestDb: 11, correlation: 0.62, clipPercent: 0 },
  { eq: [{ label: 'Conservative sub trim' }], compressor: null, truePeakCeilingDb: -1, ceilingDb: -1.2 },
  'quick',
  { readinessBefore: 74, remainingRisks: ['mono incompatibility'] },
);
assert.match(summary.headline, /Quick Master/i);
assert.ok(summary.bullets.some((line) => /LUFS/.test(line)));
assert.ok(summary.bullets.some((line) => /no stem separation/i.test(line)));
assert.equal(JSON.stringify([...summary.remaining]), JSON.stringify(['mono incompatibility']));

const report = context.mfBuildReadinessReportText({
  fileName: 'demo.wav',
  path: 'quick',
  pathLabel: 'Quick Master',
  before: { lufs: -16.2, peakDb: -0.4 },
  after: { lufs: -12.1, peakDb: -1.1 },
  truePeakAfter: -1.05,
  readinessBefore: 74,
  readinessAfter: 88,
  bullets: summary.bullets,
  remaining: summary.remaining,
  generatedAt: '2026-08-12T00:00:00.000Z',
});
assert.match(report, /MixForge release readiness report/);
assert.match(report, /Quick Master/);
assert.match(report, /AuraMix/);
assert.match(report, /mono incompatibility/);

const indexHtml = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
assert.match(indexHtml, /app-musician-ux\.js/, 'musician UX layer must load');
assert.match(indexHtml, /musician-ux\.css/, 'musician UX styles must load');
assert.match(indexHtml, /Quick Master/, 'hero/path copy must mention Quick Master');
assert.match(indexHtml, /Forensic Fix/, 'hero/path copy must mention Forensic Fix');
assert.match(indexHtml, /AuraMix/, 'seat clarification should mention AuraMix');

const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
assert.match(readme, /RUNPOD_ENDPOINT_ID/, 'README should document RunPod secrets');
assert.doesNotMatch(readme, /MUSICAI_KEY/, 'README should not advertise Music.ai secrets');

console.log('musician-ux smoke passed');
