import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

class FakeBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.data = Array.from({ length: channels }, () => new Float32Array(length));
  }
  getChannelData(channel) { return this.data[channel]; }
}

const cloneBuffer = (buffer) => {
  const out = new FakeBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) out.data[channel].set(buffer.getChannelData(channel));
  return out;
};

const appended = [];
const context = vm.createContext({
  console, Math, Float32Array, Float64Array, WeakMap, Number, Object, Array, Promise,
  clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
  dbToGain: (db) => 10 ** (db / 20),
  gainToDb: (gain) => 20 * Math.log10(Math.max(gain, 1e-12)),
  sleep: async () => {},
  cloneBuffer,
  mfProGainBuffer(buffer, gainDb) {
    const out = cloneBuffer(buffer);
    const gain = 10 ** (gainDb / 20);
    for (const data of out.data) for (let i = 0; i < data.length; i++) data[i] *= gain;
    return out;
  },
  state: { corrected: null, multibandReport: null },
  buildMasterPlan: () => ({ eq: [], compressor: { type: 'compressor', label: 'Low-ratio program glue' }, gainDb: 3, targetLufs: -12 }),
  renderPreLimitedMaster: async (buffer, plan) => {
    context.lastPreLimitedGainDb = plan.gainDb;
    return cloneBuffer(buffer);
  },
  renderMasterChain: () => {},
  renderVerification: () => {},
  $: () => ({ append: (node) => appended.push(node), replaceChildren() {} }),
  document: { createElement: () => ({ append() {}, className: '', textContent: '' }), createTextNode: (text) => ({ text }) },
});

vm.runInContext(fs.readFileSync(new URL('../js/app-multiband.js', import.meta.url), 'utf8'), context);

const rate = 48000;
const run = (expression) => vm.runInContext(expression, context);

function stereo(seconds, sample) {
  const buffer = new FakeBuffer(2, Math.round(seconds * rate), rate);
  for (let i = 0; i < buffer.length; i++) {
    const value = sample(i);
    buffer.data[0][i] = value;
    buffer.data[1][i] = value;
  }
  return buffer;
}

// Goertzel magnitude of one frequency over a window.
function toneLevel(data, frequency, from, to) {
  const k = 2 * Math.cos(2 * Math.PI * frequency / rate);
  let s1 = 0, s2 = 0;
  for (let i = from; i < to; i++) { const s0 = data[i] + k * s1 - s2; s2 = s1; s1 = s0; }
  const power = s1 * s1 + s2 * s2 - k * s1 * s2;
  return 2 * Math.sqrt(Math.max(power, 0)) / (to - from);
}

// 1. With every band disengaged the crossover sums to an allpass: an impulse
// keeps its energy and its magnitude response is flat at every test frequency.
context.impulse = stereo(1, (i) => (i === 100 ? 1 : 0));
const passthrough = (await run('mfMbRunAsync(impulse, { bands: MF_MB_BANDS.map((band) => ({ ...band, engaged: false })) }, "render")')).output.getChannelData(0);
const energy = passthrough.reduce((sum, value) => sum + value * value, 0);
assert.ok(Math.abs(energy - 1) < 1e-3, `crossover sum must preserve impulse energy, got ${energy}`);
for (const frequency of [30, 90, 120, 300, 500, 1000, 4000, 8000, 15000]) {
  let re = 0, im = 0;
  for (let i = 0; i < passthrough.length; i++) {
    re += passthrough[i] * Math.cos(2 * Math.PI * frequency * i / rate);
    im -= passthrough[i] * Math.sin(2 * Math.PI * frequency * i / rate);
  }
  const db = 20 * Math.log10(Math.hypot(re, im));
  assert.ok(Math.abs(db) < 0.05, `crossover sum must be flat at ${frequency} Hz, got ${db.toFixed(3)} dB`);
}

// 2. Band separation: a 50 Hz tone lands in the low band, a 9 kHz tone in the high band.
for (const [frequency, band] of [[50, 0], [9000, 3]]) {
  context.toneBuffer = stereo(1, (i) => Math.sin(2 * Math.PI * frequency * i / rate) * 0.5);
  const levels = (await run('mfMbRunAsync(toneBuffer, null, "analyze")')).blockLevels.map((blocks) => blocks.slice(4).reduce((a, b) => a + b, 0) / (blocks.length - 4));
  const others = levels.filter((_, index) => index !== band);
  assert.ok(others.every((level) => levels[band] - level > 20), `${frequency} Hz should sit in band ${band}: ${levels.map((l) => l.toFixed(1)).join(', ')}`);
}

// 3. A steady mix has no surges: the plan is pending until render, then no
// band engages and broadband glue stays.
context.state.corrected = stereo(8, (i) => Math.sin(2 * Math.PI * 80 * i / rate) * 0.2 + Math.sin(2 * Math.PI * 2000 * i / rate) * 0.1);
context.steadyPlan = run('buildMasterPlan({}, -12)');
assert.equal(context.steadyPlan.multiband.pending, true, 'band analysis waits for render');
await run('renderPreLimitedMaster(state.corrected, steadyPlan)');
assert.equal(context.steadyPlan.multiband, null, 'steady material must not engage multiband');
assert.ok(context.steadyPlan.compressor, 'broadband glue stays when multiband is not engaged');
assert.equal(run('buildMasterPlan({}, -12)').multiband, null, 'a re-plan reuses the cached analysis');

// 4. A bass line that surges +14 dB one second in four beside a steady 2 kHz
// tone: the low band engages, the surge is reduced, the 2 kHz tone is not
// touched, and the multiband plan replaces broadband glue.
const surging = (i) => (Math.floor(i / rate) % 4 === 1 ? 5 : 1);
context.state.corrected = stereo(16, (i) => Math.sin(2 * Math.PI * 60 * i / rate) * 0.04 * surging(i) + Math.sin(2 * Math.PI * 2000 * i / rate) * 0.1);
context.plan = run('buildMasterPlan({}, -12)');
const rendered = await run('renderPreLimitedMaster(state.corrected, plan)');
const plan = context.plan;
assert.ok(plan.multiband && !plan.multiband.pending, 'surging bass must engage multiband');
assert.equal(plan.compressor, null, 'multiband replaces broadband glue');
// The 120-500 Hz band may engage too: the 60 Hz tone's LR4 skirt leaks into it
// and surges with it. The mid and high bands carry only the steady tone.
const engaged = plan.multiband.bands.map((band) => band.engaged);
assert.equal(engaged[0], true, 'the low band must engage');
assert.ok(!engaged[2] && !engaged[3], 'mid and high bands must stay untouched');
assert.ok(plan.multiband.bands[0].makeupDb > 0, 'engaged band gets make-up gain');
assert.equal(context.lastPreLimitedGainDb, 0, 'EQ stage renders without loudness gain');
assert.equal(run('buildMasterPlan({}, -12)').multiband, plan.multiband, 'a re-plan reuses the cached analysis');
const input = context.state.corrected.data[0];
const output = context.mfProGainBuffer(rendered, -plan.gainDb).getChannelData(0);
const window = (second) => [Math.round((second + 0.3) * rate), Math.round((second + 0.9) * rate)];
const surgeBefore = 20 * Math.log10(toneLevel(input, 60, ...window(5)) / toneLevel(input, 60, ...window(4)));
const surgeAfter = 20 * Math.log10(toneLevel(output, 60, ...window(5)) / toneLevel(output, 60, ...window(4)));
assert.ok(surgeBefore > 13.5, `test signal should surge ~14 dB, got ${surgeBefore}`);
assert.ok(surgeBefore - surgeAfter > 1.5 && surgeBefore - surgeAfter <= 3.2, `low band surge should drop by up to the 3 dB cap: ${surgeBefore.toFixed(1)} -> ${surgeAfter.toFixed(1)}`);
for (const second of [4, 5, 12, 13]) {
  const before = toneLevel(input, 2000, ...window(second));
  const after = toneLevel(output, 2000, ...window(second));
  assert.ok(Math.abs(20 * Math.log10(after / before)) < 0.1, `2 kHz tone must be untouched at ${second}s`);
}
const report = context.state.multibandReport;
assert.ok(report[0].maxReductionDb > 1 && report[0].maxReductionDb <= 3.001, `low band max reduction ${report[0].maxReductionDb}`);
const restored = report[0].powerAfterDb + plan.multiband.bands[0].makeupDb - report[0].powerBeforeDb;
assert.ok(Math.abs(restored) < 0.5, `make-up should restore the low band's long-term level, off by ${restored.toFixed(2)} dB`);

// 5. The verification row reports measured reduction for engaged bands only.
appended.length = 0;
run('renderVerification({}, plan)');
assert.equal(appended.length, 1, 'one multiband verification row');

console.log('multiband-smoke: ok');
