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
  String,
  clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
});
context.globalThis = context;
context.validateAudit = function original() { return null; };
vm.runInContext(fs.readFileSync(new URL('../js/app-forensics-guard.js', import.meta.url), 'utf8'), context);

const measured = {
  readinessScore: 41,
  summary: 'The mix has 2 corrective issues to address before mastering.',
  findings: [
    { severity: 'high', stage: 'mix', problem: 'Source overload detected', evidence: '0.200% clipped frames; sample peak -0.02 dBFS.', action: 'Bounce pre-limiter.' },
    { severity: 'high', stage: 'mix', problem: 'Mono compatibility risk', evidence: 'Stereo correlation is -0.12.', action: 'Inspect residual other.' },
  ],
  stemsToInspect: ['vocals'],
};

const listening = {
  readinessScore: 90,
  summary: 'Chorus vocal feels buried and the midrange is muddy.',
  findings: [
    { severity: 'low', stage: 'master', problem: 'No clipping', evidence: 'The mix is clean with no overload.', action: 'Master louder.', stem: null },
    { severity: 'medium', stage: 'mix', problem: 'Buried vocal in chorus', evidence: 'The lead recedes when the band enters.', action: 'Inspect vocals after isolation.', stem: 'vocals' },
    { severity: 'medium', stage: 'mix', problem: 'Mystery resonance', evidence: 'Cut 3472 Hz on the mix bus.', action: 'Notch 3472 Hz', stem: 'guitars' },
    { severity: 'medium', stage: 'mix', problem: 'Sharp intonation', evidence: 'The singer is out of tune in the verse.', action: 'Retune the take.', stem: 'vocals' },
  ],
  stemsToInspect: ['guitars', 'keys'],
};

const merged = context.mergeForensicAudit(listening, measured);
assert.ok(merged.findings.some((finding) => /overload|clip/i.test(finding.problem)), 'measured clip finding must survive');
assert.equal(merged.readinessScore, 41, 'measurements win on readiness');
assert.ok(merged.findings.some((finding) => /buried vocal/i.test(finding.problem)), 'listening hypothesis should be kept');
assert.ok(!merged.findings.some((finding) => /3472/i.test(`${finding.problem} ${finding.evidence} ${finding.action}`)), 'invented Hz must drop');
assert.ok(!merged.findings.some((finding) => /no clipping/i.test(finding.problem)), 'listening cannot dismiss measured clip');
assert.ok(merged.findings.some((finding) => /intonation|out of tune/i.test(`${finding.problem} ${finding.evidence}`)), 'pitch hypotheses from Gemini are kept; stem measurements decide');
assert.ok(!merged.stemsToInspect.includes('guitars'));
assert.ok(!merged.stemsToInspect.includes('keys'));
assert.ok(merged.stemsToInspect.includes('other') || merged.stemsToInspect.includes('vocals'));
assert.equal(context.normalizeAllowedStem('guitars'), 'other');
assert.equal(context.normalizeAllowedStem('keys'), 'other');

const unused = context.auditCompleteStatusMessage({ listeningUsed: false, aiUsed: false });
assert.doesNotMatch(unused, /agree/i);
assert.match(unused, /measurements only/i);
const used = context.auditCompleteStatusMessage(merged);
assert.doesNotMatch(used, /agree/i);
assert.match(used, /listening pass/i);

const noteOnly = context.auditCompleteStatusMessage({ listeningUsed: true, aiUsed: true, aiFindingsAdded: 0, listeningFindingsAdded: 0 });
assert.doesNotMatch(noteOnly, /agree/i);

console.log('forensics-merge-smoke: ok');
