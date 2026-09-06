import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

class FakeBuffer {
  constructor(value = 0.9, length = 16, sampleRate = 48000) {
    this.numberOfChannels = 2;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.data = [new Float32Array(length).fill(value), new Float32Array(length).fill(value)];
  }
  getChannelData(channel) { return this.data[channel]; }
}

const source = new FakeBuffer();
const context = vm.createContext({
  console, Math, Number, Object, Promise, Float32Array, setTimeout,
  state: {
    masterPlan: { truePeakCeilingDb: -1 },
    masterEffectivePlan: { truePeakCeilingDb: -1 },
    masterConstraint: { achievedLufs: -12, truePeakCeilingDb: -1 },
  },
  async renderReleaseMaster() { return source; },
  renderVerification() {},
  cloneBuffer(buffer) {
    const out = new FakeBuffer(0, buffer.length, buffer.sampleRate);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) out.getChannelData(channel).set(buffer.getChannelData(channel));
    return out;
  },
  dbToGain: (db) => 10 ** (db / 20),
  mfEstimateTruePeak: () => -0.8,
  $: () => null,
  document: { createElement: () => ({ append() {}, className: '', textContent: '' }), createTextNode: (text) => ({ text }) },
});
context.globalThis = context;
vm.runInContext(fs.readFileSync(new URL('../js/app-standards-meter.js', import.meta.url), 'utf8'), context);

const guard = context.mixForgeStandardsPeak;
const standard48 = guard.peakSafetyDecision(-0.9, -1, { standardsDerived: true, sampleRate: 48000 });
assert.equal(standard48.safetyPadDb, 0.05);
assert.ok(Math.abs(standard48.trimDb - (-0.15)) < 1e-12);

const standard441 = guard.peakSafetyDecision(-1.05, -1, { standardsDerived: true, sampleRate: 44100 });
assert.equal(standard441.safetyPadDb, 0.15);
assert.ok(Math.abs(standard441.trimDb - (-0.10)) < 1e-12);

const fallback = guard.peakSafetyDecision(-1.2, -1, { standardsDerived: false, sampleRate: 48000 });
assert.equal(fallback.safetyPadDb, 0.55);
assert.ok(Math.abs(fallback.effectiveCeilingDb - (-1.55)) < 1e-12);
assert.ok(Math.abs(fallback.trimDb - (-0.35)) < 1e-12);

// In a non-browser test environment the worklet path is unavailable. The
// wrapper must transparently fall back, add the larger safety pad, and return a
// gain-trimmed copy rather than pretending the cubic estimate is equivalent.
const rendered = await context.renderReleaseMaster();
assert.notStrictEqual(rendered, source);
assert.equal(context.state.masterConstraint.truePeakMethod, 'cubic-fallback');
assert.equal(context.state.masterConstraint.truePeakStandardsDerived, false);
assert.equal(context.state.masterConstraint.truePeakSafetyPadDb, 0.55);
assert.ok(Math.abs(context.state.masterConstraint.truePeakSafetyTrimDb - (-0.75)) < 1e-12);
assert.ok(Math.abs(context.state.masterConstraint.truePeakDb - (-1.55)) < 1e-12);
assert.ok(Math.abs(context.state.masterConstraint.achievedLufs - (-12.75)) < 1e-12);
const expectedSample = 0.9 * 10 ** (-0.75 / 20);
assert.ok(Math.abs(rendered.getChannelData(0)[0] - expectedSample) < 1e-6);

console.log('MixForge standards peak safety smoke tests passed');
