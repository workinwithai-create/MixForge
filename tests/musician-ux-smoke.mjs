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
assert.equal(typeof context.mfFormatEqMove, 'function');
assert.equal(typeof context.mfAbBarCopy, 'function');
assert.equal(typeof context.mfCorrectedPreviewAvailable, 'function');

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

const maskedLead = context.mfRecommendPath({
  readinessScore: 80,
  stemsToInspect: ['vocals'],
  findings: [{
    severity: 'medium',
    stage: 'mix',
    problem: 'Lead-band masking condition',
    evidence: 'Center presence is 15.1 dB below dominant low-mids.',
    confidence: 83,
  }],
});
assert.equal(maskedLead.path, 'forensic', '15.1 dB lead-band masking must push Forensic even when readiness is high');

const mapped = context.mfNormalizeDemucsStems(['vocals', 'guitars', 'keys', 'bass', 'guitars']);
assert.equal(JSON.stringify([...mapped.stems]), JSON.stringify(['vocals', 'other', 'bass']));
assert.ok(mapped.routes.some((route) => route.requested === 'guitars' && route.actual === 'other'));
assert.ok(mapped.routes.some((route) => route.requested === 'keys' && route.actual === 'other'));
assert.equal(mapped.stems.filter((stem) => stem === 'other').length, 1, 'guitars+keys must collapse to one other stem');

const framing = context.mfStemJobFraming(['vocals', 'other'], 240);
assert.match(framing.etaLabel, /Estimate/i);
assert.match(framing.costLabel, /12 stems\/hour/);
assert.match(framing.costLabel, /30\/day/);
assert.match(framing.escapeLabel, /Skip stems/i);

const summary = context.mfPlainWhatChanged(
  { lufs: -16.2, peakDb: -0.4, crestDb: 12, correlation: 0.6, clipPercent: 0 },
  { lufs: -12.1, peakDb: -1.1, crestDb: 11, correlation: 0.62, clipPercent: 0 },
  { eq: [{ label: 'Evidence-bounded sub-bass cut', frequency: 70, gain: -2.9 }], compressor: null, truePeakCeilingDb: -1, ceilingDb: -1.2 },
  'quick',
  { readinessBefore: 74, remainingRisks: ['mono incompatibility'] },
);
assert.ok(summary.bullets.some((line) => /70 Hz/.test(line) && /-2\.9 dB/.test(line)), 'what-changed must list EQ Hz/dB');

const originalBuf = { id: 'orig' };
assert.equal(context.mfCorrectedPreviewAvailable({ original: originalBuf, corrected: originalBuf }), false);
assert.equal(context.mfCorrectedPreviewAvailable({ original: originalBuf, corrected: { id: 'fixed' } }), true);
assert.equal(context.mfAbMatchOffsetDb(-18, -12.3), 5.7);
const abCopy = context.mfAbBarCopy(5.7);
assert.match(abCopy.matched, /−5\.7 dB|5\.7 dB/);
assert.match(abCopy.hint, /turned down 5\.7 dB/);
assert.match(abCopy.release, /Release master \(loud\)/);
assert.match(summary.headline, /Quick Master/i);
assert.ok(summary.bullets.some((line) => /LUFS/.test(line)));
assert.ok(summary.bullets.some((line) => /no stem isolation/i.test(line)));
assert.ok(summary.bullets.some((line) => /Stereo correlation/.test(line)));
assert.match(summary.disclaimer, /do not claim/i);
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
assert.match(indexHtml, /auramix\.workinwithai\.com/, 'AuraMix must be a real link');
assert.match(indexHtml, /2\.5\.6/, 'version must be 2.5.6 so the preview cannot serve stale 2.5.4 JS');
assert.doesNotMatch(indexHtml, /2\.5\.5/, 'visible version must leave 2.5.5');
assert.doesNotMatch(indexHtml, /2\.5\.4/, 'visible version must leave 2.5.4');
assert.doesNotMatch(indexHtml, /2\.5\.3/, 'visible version must leave 2.5.3');
assert.doesNotMatch(indexHtml, /2\.5\.2/, 'visible version must leave 2.5.2');
assert.doesNotMatch(indexHtml, /2\.5\.1/, 'visible version must leave 2.5.1');
assert.doesNotMatch(indexHtml, /prove the master improved/);
assert.doesNotMatch(indexHtml, /AI and measured evidence agree/);
assert.match(indexHtml, /app-listening-clip\.js/, 'listening clip builder must load');

const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
assert.match(readme, /RUNPOD_ENDPOINT_ID/, 'README should document RunPod secrets');
assert.match(readme, /GEMINI_API_KEY/, 'README should document Gemini listening');
assert.match(readme, /process\.env\.GEMINI_API_KEY/, 'README should say the API reads process.env only');
assert.match(readme, /Production and Preview/, 'README should say to set the key on preview and production');
assert.doesNotMatch(readme, /MUSICAI_KEY/, 'README should not advertise Music.ai secrets');

console.log('musician-ux smoke passed');
