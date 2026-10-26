import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const context = vm.createContext({ console, globalThis: null, Number, Object, Array, Math, JSON });
context.globalThis = context;
vm.runInContext(fs.readFileSync(new URL('../js/app-critic-gate.js', import.meta.url), 'utf8'), context);

const base = {
  index: 2,
  stem: 'other',
  role: 'harmonic bed',
  source: { state: 'high', label: 'High confidence', score: 91, bleed: 0.03 },
  proposed: {
    heard: 'Guitars compete with the vocal around 3 kHz.',
    listenFor: 'A clearer vocal without extra brightness.',
    operations: [{
      type: 'eq',
      label: 'Carve upper-mid room',
      frequency: 3000,
      q: 1.2,
      gain: -1.5,
    }],
    trimDb: -0.5,
    wet: 0.3,
  },
  applied: { operations: [{}], wet: 0.3 },
  attempts: [{ factor: 1, problems: [] }],
  before: { lufs: -12, peakDb: -1.8, correlation: 0.72 },
  after: { lufs: -12.1, peakDb: -1.9, correlation: 0.73 },
  marginBefore: 1.2,
  marginAfter: 2.1,
  delta: { lufs: -0.1, correlation: 0.01, margin: 0.9, mud: -0.2 },
};

const accepted = context.mfCriticGateBuildReceipt(base, { anchor: 'vocals' });
assert.equal(accepted.verdict.status, 'accepted');
assert.equal(accepted.anchor, 'vocals');
assert.ok(accepted.proposedChanges.some((item) => item.parameter === 'eq.gain' && item.proposed === -1.5));
assert.equal(context.mfCriticGateValidateReceipt(accepted).valid, true);

const reduced = context.mfCriticGateBuildReceipt({
  ...base,
  backedOff: true,
  applied: { operations: [{}], wet: 0.15 },
  attempts: [{ factor: 1, problems: ['peaks rose 1.2 dB'] }, { factor: 0.5, problems: [] }],
}, { anchor: 'vocals' });
assert.equal(reduced.verdict.status, 'accepted-reduced');
assert.match(reduced.verdict.reason, /half strength/);

const rejected = context.mfCriticGateBuildReceipt({
  ...base,
  applied: null,
  reverted: true,
  attempts: [
    { factor: 1, problems: ['lead margin fell 0.8 dB'] },
    { factor: 0.5, problems: ['lead margin fell 0.4 dB'] },
  ],
}, { anchor: 'vocals' });
assert.equal(rejected.verdict.status, 'rejected');
assert.equal(rejected.audit.originalPreserved, true);
assert.equal(rejected.proposedChanges.find((item) => item.parameter === 'eq.gain').proposed, -1.5,
  'rejected proposals remain inspectable');

const held = context.mfCriticGateBuildReceipt({
  ...base,
  proposed: { heard: 'No measured problem.', operations: [], trimDb: 0, wet: 0.3 },
  applied: null,
  attempts: [],
}, { anchor: 'vocals' });
assert.equal(held.verdict.status, 'held');
assert.equal(held.proposedChanges.length, 0);

const invalid = structuredClone(accepted);
invalid.proposedChanges[0].proposed = 'not-a-number';
assert.equal(context.mfCriticGateValidateReceipt(invalid).valid, false);

console.log('critic-gate-smoke: ok');
