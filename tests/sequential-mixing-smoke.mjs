import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

class Buffer {
  constructor(samples, rate = 48000) {
    this.data = new Float32Array(samples);
    this.length = this.data.length;
    this.sampleRate = rate;
    this.numberOfChannels = 1;
  }
  getChannelData() { return this.data; }
}
const metrics = buffer => {
  const marker = buffer.data[0];
  return { lufs: -20, peakDb: -6, widthDb: 0, correlation: 1, crestDb: 10,
    sibilance: { p95Db: 0, medianDb: 0, flares: 0, frames: 1 },
    bands: marker >= 9 ? { 'Low-mids': 30, Mids: 0, Presence: 0 }
      : marker === 1 ? { 'Low-mids': 10, Mids: 0, Presence: 0 }
        : marker === 2 ? { 'Low-mids': -10, Mids: -10, Presence: -2 }
          : { 'Low-mids': -50, Mids: -50, Presence: -50 } };
};
let fallbackCalls = 0;
const context = vm.createContext({ console, Math, Number, Object, Array, Float32Array,
  state: { original: new Buffer([10, 10]), stemBuffers: { vocals: new Buffer([1, 1]), other: new Buffer([2, 2]) }, stemPlans: {} },
  forensicState: { profile: { intensity: 'balanced' } },
  buildStemPlans: async () => {}, renderStemPlans: () => {},
  rebuildCorrectedMix: async () => { fallbackCalls++; },
  renderProcessedBuffer: async () => new Buffer([0.1, 0.1]),
  measureBuffer: metrics, cloneBuffer: b => new Buffer(b.data, b.sampleRate),
  bufferRms: b => Math.sqrt(b.data.reduce((s, x) => s + x*x, 0) / b.length),
  band: (m, name) => m.bands[name] ?? -50,
  clamp: (x, min, max) => Math.max(min, Math.min(max, x)),
  dbToGain: db => 10 ** (db / 20), sleep: async () => {}, $: () => null, setStatus: () => {},
});
for (const [stem, buffer] of Object.entries(context.state.stemBuffers)) {
  context.state.stemPlans[stem] = { metrics: metrics(buffer), quality: { score: 90 }, wet: 0.3 };
}
vm.runInContext(fs.readFileSync(new URL('../js/app-sequential-mixing.js', import.meta.url), 'utf8'), context);
const original = [...context.state.original.data];
await context.buildStemPlans();
await context.rebuildCorrectedMix();
const stages = context.mixForgeSequential.stages;
assert.equal(stages.length, 2);
assert.ok(stages[0].decision.operations.length > 0);
assert.ok(stages[1].decision.operations.some(op => op.frequency === 3000), 'support must react to the processed anchor; raw anchor would suppress this move');
assert.deepEqual([...context.state.original.data], original, 'original must remain immutable');

// No-op stages must exactly preserve samples and clear stale operation cards.
context.state.original = new Buffer([3, 3]);
context.state.stemBuffers = { vocals: new Buffer([3, 3]) };
context.state.stemPlans = { vocals: { metrics: metrics(context.state.stemBuffers.vocals), operations: [{type:'eq'}] } };
const unchanged = await context.rebuildCorrectedMix();
assert.deepEqual([...unchanged.data], [3, 3]);
assert.equal(context.state.stemPlans.vocals.operations.length, 0);
assert.equal(context.mixForgeSequential.stages.length, 1, 'rebuild must discard the previous session plan');

// A failed sequential render must never silently run the old method.
context.state.stemBuffers.vocals = new Buffer([1, 1], 44100);
context.state.stemPlans.vocals.metrics = metrics(context.state.stemBuffers.vocals);
await assert.rejects(context.rebuildCorrectedMix(), /timing/);
assert.equal(fallbackCalls, 0);
assert.equal(context.mixForgeSequential.stages.length, 0);
console.log('Sequential mixing regression tests passed');
