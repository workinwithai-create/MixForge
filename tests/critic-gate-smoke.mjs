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

// Automation gets a receipt like any other stage: every ride with its place and size, what was out of
// place before and after, and the strength it was kept at.
const rideStage = {
  index: 5, stem: 'vocals', kind: 'ride', role: 'automation — level rides on the lead vocal',
  source: { state: 'high', label: 'High confidence', score: 92, bleed: 0 },
  proposed: {
    heard: 'Measured above the bass, the vocal usually sits 1.9 dB under the band. Past a 2–3 dB tolerance, it dropped up to 4.0 dB further under it for 2.7 s in total.',
    listenFor: 'The phrases that dropped back should sit where the others do.',
    operations: [], trimDb: 0, wet: 1,
    rides: [{ startSec: 7.7, endSec: 71.2, gainDb: 3 }, { startSec: 95.7, endSec: 99.2, gainDb: -2 }],
    usualMarginDb: -1.9,
    outOfPlaceBefore: { dipSec: 2.7, worstDipDb: 4, hotSec: 2.7, worstHotDb: 4, strayDbSec: 21.6 },
    outOfPlaceAfter: { dipSec: 2.7, worstDipDb: 1, hotSec: 2.7, worstHotDb: 2, strayDbSec: 8.1 },
  },
  applied: { kind: 'ride', factor: 0.5 },
  backedOff: true,
  attempts: [{ factor: 1, problems: ['peaks rose 1.4 dB'] }, { factor: 0.5, problems: [] }],
  before: { lufs: -12, peakDb: -2, correlation: 0.8 },
  after: { lufs: -11.9, peakDb: -1.6, correlation: 0.8 },
  marginBefore: 3.1, marginAfter: 3.2,
  delta: { lufs: 0.1, correlation: 0, margin: 0.1, mud: 0 },
};
const rideReceipt = context.mfCriticGateBuildReceipt(rideStage, { anchor: 'vocals' });
assert.equal(rideReceipt.id, 'stage-5-vocals');
assert.equal(rideReceipt.verdict.status, 'accepted-reduced');
assert.equal(rideReceipt.proposedChanges.length, 2, 'one change per ride, and no blend line');
assert.equal(rideReceipt.proposedChanges[0].label, 'Lift the lead');
assert.equal(rideReceipt.proposedChanges[0].parameter, 'ride 0:07–1:11');
assert.equal(rideReceipt.proposedChanges[0].proposed, 3);
assert.equal(rideReceipt.proposedChanges[1].label, 'Ease the lead back');
assert.equal(rideReceipt.proposedChanges[1].proposed, -2);
assert.equal(rideReceipt.automation.usualLeadOverBandDb, -1.9);
assert.equal(rideReceipt.automation.outOfPlaceBefore.worstDipDb, 4);
assert.equal(rideReceipt.automation.outOfPlaceAfter.worstDipDb, 1);
assert.equal(rideReceipt.automation.ridesProposed, 2);
assert.equal(rideReceipt.automation.appliedStrength, 0.5);
assert.equal(context.mfCriticGateValidateReceipt(rideReceipt).valid, true);
assert.equal(accepted.automation, null, 'ordinary stages carry no automation block');
// A long song's receipt lists the first twelve rides and says how many there were.
const many = context.mfCriticGateBuildReceipt({ ...rideStage, proposed: { ...rideStage.proposed, rides: Array.from({ length: 30 }, (_, i) => ({ startSec: i * 5, endSec: i * 5 + 2, gainDb: 1.5 })) } }, { anchor: 'vocals' });
assert.equal(many.proposedChanges.length, 12);
assert.equal(many.automation.ridesProposed, 30);
assert.equal(many.automation.ridesListed, 12);

// Receipts follow the current mix: rendering a run stores it, and clearing forgets it.
context.mfCriticGateRender([base, { ...base, index: 3, stem: 'bass' }], { plan: { anchor: 'vocals' } });
assert.equal(context.mixForgeCriticGate.receipts.length, 2);
assert.equal(context.mixForgeCriticGate.receipts[1].id, 'stage-3-bass');
assert.equal(context.mixForgeCriticGate.receipts[0].validation.valid, true);
context.mfCriticGateClear();
assert.equal(context.mixForgeCriticGate.receipts.length, 0, 'a cleared run leaves no receipts behind');
assert.equal(typeof context.mixForgeCriticGate.renderStages, 'function');

// The mixing engine clears receipts wherever it clears its own stage log, and keeps the proposal for audit.
const engine = fs.readFileSync(new URL('../js/app-sequential-mixing.js', import.meta.url), 'utf8');
assert.match(engine, /removeBlock\('mixStageLog'\);[\s\S]{0,160}mfCriticGateClear\(\)/, 'new stem plans clear the old receipts');
assert.match(engine, /seq\.lastError = error;[\s\S]{0,200}mfCriticGateClear\(\)/, 'a failed mix clears the receipts');
assert.match(engine, /proposed: decision,/, 'the original proposal is kept next to the final decision');
assert.match(engine, /mfCriticGateRender\(seq\.stages, \{ plan: seq\.plan/);
const page = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
assert.ok(page.indexOf('app-critic-gate.js') > page.indexOf('app-sequential-mixing.js'), 'receipts load after the mixing engine');
assert.ok(page.indexOf('app-critic-gate.js') < page.indexOf('app-separation-provenance.js'), 'receipts do not change the engine load order that follows');

console.log('critic-gate-smoke: ok');
