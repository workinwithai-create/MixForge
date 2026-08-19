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

assert.equal(typeof context.mfOriginalPreviewPlan, 'function');
assert.equal(typeof context.presentMeasuredAuditThenListen, 'function');

const beforeScan = context.mfOriginalPreviewPlan({ original: { duration: 12 }, master: null });
assert.equal(beforeScan.show, true, 'decoded original must unlock preview before scan');
assert.equal(beforeScan.selected, 'original');
assert.equal(beforeScan.showAb, false, 'A/B stays hidden until a master exists');

const noFile = context.mfOriginalPreviewPlan({});
assert.equal(noFile.show, false);

const afterMaster = context.mfOriginalPreviewPlan({ original: {}, master: {} });
assert.equal(afterMaster.show, true);
assert.equal(afterMaster.showAb, true);

let presentedAt = 0;
let listenStartedAt = 0;
let listenResolved = false;
let resolveListen;
const hangListen = () => {
  listenStartedAt = Date.now();
  return new Promise((resolve) => {
    resolveListen = () => {
      listenResolved = true;
      resolve({ listeningUsed: true, findings: [{ problem: 'Chorus vocal recedes' }] });
    };
  });
};

const orchestration = context.presentMeasuredAuditThenListen({
  measure: async () => ({
    metrics: { lufs: -16.2, peakDb: -0.4 },
    audit: { readinessScore: 74, findings: [{ problem: 'Source overload detected' }], listeningUsed: false },
  }),
  present: (measured) => {
    presentedAt = Date.now() || 1;
    context.presentedAudit = measured.audit;
  },
  listen: hangListen,
});

const presented = await Promise.race([
  orchestration,
  new Promise((_, reject) => setTimeout(() => reject(new Error('path render waited on listening')), 40)),
]);
assert.ok(presentedAt, 'audit/path must render as soon as measurements exist');
assert.equal(presented.measured.audit.listeningUsed, false);
assert.equal(presented.measured.audit.readinessScore, 74);
assert.equal(listenResolved, false, 'listening must still be in flight after path render');
assert.ok(presented.listening, 'listening promise is returned but not awaited by the presenter');

resolveListen();
const listening = await presented.listening;
assert.equal(listenResolved, true);
assert.equal(listening.listeningUsed, true);
assert.ok(listenStartedAt >= presentedAt || presentedAt > 0);

const indexHtml = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const loadStart = indexHtml.indexOf('id="loadPanel"');
const loadEnd = indexHtml.indexOf('id="auditPanel"');
const loadPanel = indexHtml.slice(loadStart, loadEnd);
const masterStart = indexHtml.indexOf('id="masterPanel"');
const masterEnd = indexHtml.indexOf('id="verifyPanel"');
const masterPanel = indexHtml.slice(masterStart, masterEnd);
assert.match(loadPanel, /id="previewBox"/, 'preview transport must live in the load panel so Original can play before Scan');
assert.doesNotMatch(masterPanel, /id="previewBox"/, 'preview must not stay trapped inside the hidden master panel');
assert.match(loadPanel, /id="moreOptions"/);
assert.match(loadPanel, /More options/);
assert.match(loadPanel, /id="notes"/);
assert.match(indexHtml, /Skip listening · measurements only/);
assert.match(indexHtml, /id="skipListeningBtn"/);
assert.doesNotMatch(indexHtml, /2\.5\.0/, 'visible version must leave 2.5.0');
assert.doesNotMatch(indexHtml, /2\.5\.1/, 'visible version must leave 2.5.1');
assert.doesNotMatch(indexHtml, /2\.5\.2/, 'visible version must leave 2.5.2');
assert.match(indexHtml, /2\.5\.3/);

const initSrc = fs.readFileSync(new URL('../js/app-init.js', import.meta.url), 'utf8');
assert.match(initSrc, /function revealOriginalPreview/);
assert.match(initSrc, /revealOriginalPreview\(\)/);
assert.ok(
  initSrc.indexOf('state.original = decoded') < initSrc.indexOf('revealOriginalPreview()'),
  'preview must be offered after decode',
);

const auditSrc = fs.readFileSync(new URL('../js/app-audit.js', import.meta.url), 'utf8');
const runMix = auditSrc.slice(auditSrc.indexOf('async function runMixAudit'), auditSrc.indexOf("$('auditBtn').addEventListener"));
assert.match(runMix, /presentMeasuredAudit/);
assert.doesNotMatch(runMix, /await requestAI/);
assert.doesNotMatch(runMix, /await startListeningPass/);
assert.match(auditSrc, /async function startListeningPass/);
assert.match(auditSrc, /requestAI/);
assert.match(auditSrc, /attachOnly:\s*true/);
assert.match(auditSrc, /function skipListeningPass/);

const forensicSrc = fs.readFileSync(new URL('../js/app-forensics.js', import.meta.url), 'utf8');
assert.match(forensicSrc, /moreOptions/);
assert.match(forensicSrc, /mfGenre/);

console.log('first-listen smoke passed');
