// Sequential mixing regression tests. Runs the real metering code (app-metrics.js)
// against synthetic stems so the relationship measurements are genuine DSP, with a
// small JS biquad renderer standing in for OfflineAudioContext.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const RATE = 44100;
const SECONDS = 3;
const LENGTH = RATE * SECONDS;

class Buf {
  constructor(channels, rate = RATE) {
    this.channels = channels.map((data) => Float32Array.from(data));
    this.numberOfChannels = this.channels.length;
    this.length = this.channels[0].length;
    this.sampleRate = rate;
    this.duration = this.length / rate;
  }
  getChannelData(c) { return this.channels[c]; }
}

// ---------------------------------------------------------------- tiny DSP

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; };
}

function coefs(type, f, q, gainDb, fs = RATE) {
  const A = 10 ** (gainDb / 40), w = 2 * Math.PI * f / fs, cos = Math.cos(w), alpha = Math.sin(w) / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'peaking') { b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A; }
  else if (type === 'bandpass') { b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; }
  else if (type === 'highpass') { b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; }
  else {
    const sq = 2 * Math.sqrt(A) * alpha, sign = type === 'lowshelf' ? 1 : -1;
    b0 = A * ((A + 1) - sign * (A - 1) * cos + sq); b1 = sign * 2 * A * ((A - 1) - sign * (A + 1) * cos); b2 = A * ((A + 1) - sign * (A - 1) * cos - sq);
    a0 = (A + 1) + sign * (A - 1) * cos + sq; a1 = -sign * 2 * ((A - 1) + sign * (A + 1) * cos); a2 = (A + 1) + sign * (A - 1) * cos - sq;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function filter(data, c) {
  const out = new Float32Array(data.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const y = c.b0 * data[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = data[i]; y2 = y1; y1 = y; out[i] = y;
  }
  return out;
}

function noise(seed, gain = 1) {
  const r = rng(seed);
  return Float32Array.from({ length: LENGTH }, () => r() * gain);
}

function bandNoise(seed, freq, q, gain) {
  return filter(noise(seed), coefs('bandpass', freq, q, 0)).map((x) => x * gain);
}

const add = (...parts) => Float32Array.from({ length: LENGTH }, (_, i) => parts.reduce((sum, p) => sum + p[i], 0));
const stereo = (data) => new Buf([data, data]);

// Lead vocal: upper-mid voice energy with syllable gating plus some chest tone.
const syllables = Float32Array.from({ length: LENGTH }, (_, i) => 0.55 + 0.45 * Math.sin(2 * Math.PI * 3 * i / RATE) ** 2);
const vocalMono = add(bandNoise(1, 2800, 1.2, 0.35), bandNoise(2, 300, 1.5, 0.12)).map((x, i) => x * syllables[i]);
// Guitars / keys: broadband bed that sits right in the vocal's 2–5 kHz range.
const otherMono = add(bandNoise(3, 3000, 1.0, 0.32), bandNoise(4, 600, 0.9, 0.25), bandNoise(5, 350, 1.2, 0.15));
const bassMono = Float32Array.from({ length: LENGTH }, (_, i) => 0.3 * Math.sin(2 * Math.PI * 70 * i / RATE) + 0.25 * Math.sin(2 * Math.PI * 40 * i / RATE));
const drumMono = Float32Array.from({ length: LENGTH }, (_, i) => {
  const t = (i % (RATE / 2)) / RATE;
  return 0.6 * Math.exp(-t * 30) * Math.sin(2 * Math.PI * 65 * t);
});

// Stand-in for OfflineAudioContext rendering of the operation chain.
async function renderProcessedBuffer(source, operations) {
  const channels = source.channels.map((data) => {
    let out = data;
    for (const op of operations) {
      if (op.type === 'eq') out = filter(out, coefs(op.filterType || 'peaking', op.frequency, op.q || 0.9, op.gain || 0));
      else if (op.type === 'highpass') out = filter(out, coefs('highpass', op.frequency, op.q || 0.7, 0));
      else if (op.type === 'deess') out = filter(out, coefs('highshelf', op.frequency || 6800, 0.7, -1.5));
      else if (op.type === 'gain') out = out.map((x) => x * 10 ** ((op.gainDb || 0) / 20));
      // Dynamics are left out: the tests exercise the relational EQ/level logic.
    }
    return out;
  });
  return new Buf(channels, source.sampleRate);
}

// ------------------------------------------------------------- fake DOM

class Node {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.parentElement = null; this.textContent = '';
    this.className = ''; this.id = ''; this.dataset = {}; this.attributes = {};
    const node = this;
    this.classList = {
      contains: (name) => node.className.split(/\s+/).includes(name),
      toggle: (name, on) => {
        const set = new Set(node.className.split(/\s+/).filter(Boolean));
        if (on) set.add(name); else set.delete(name);
        node.className = [...set].join(' ');
      },
    };
  }
  append(...nodes) { for (const n of nodes) { if (n instanceof Node) { n.parentElement = this; this.children.push(n); } } }
  insertBefore(node, ref) {
    if (ref == null) return this.append(node);
    const index = this.children.indexOf(ref);
    if (index < 0) throw new Error("NotFoundError: Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.");
    node.parentElement = this; this.children.splice(index, 0, node);
  }
  replaceChildren() { this.children = []; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((n) => n !== this); }
  setAttribute(k, v) { this.attributes[k] = v; }
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    return [...this.walk()].filter((n) => (cls ? n.classList.contains(cls) : sel.startsWith('button') && n.tagName === 'button'));
  }
  find(id) { return [...this.walk()].find((n) => n.id === id) || null; }
}

function buildPanel() {
  const panel = new Node('section'); panel.id = 'stemPanel';
  const grid = new Node('div'); grid.id = 'stemGrid'; grid.className = 'stem-grid';
  const card = new Node('article'); card.className = 'stem-card';
  // Vocal Layer Cleanup puts its own nested `.actions` row inside the vocal card.
  const nested = new Node('div'); nested.className = 'actions vocal-cleanup-preview';
  card.append(nested); grid.append(card);
  const actions = new Node('div'); actions.className = 'actions';
  panel.append(grid, actions);
  return { panel, actions };
}

// ---------------------------------------------------------------- harness

function makeContext({ stems, original, quality = {}, autoMix = false }) {
  const dom = buildPanel();
  const context = vm.createContext({
    console, Math, Number, Object, Array, Float32Array, Float64Array, Set, Error, Promise, String, JSON,
    BANDS: [
      { name: 'Sub', lo: 20, hi: 60 }, { name: 'Bass', lo: 60, hi: 250 }, { name: 'Low-mids', lo: 250, hi: 500 },
      { name: 'Mids', lo: 500, hi: 2000 }, { name: 'Presence', lo: 2000, hi: 5000 }, { name: 'Air', lo: 5000, hi: 16000 },
    ],
    clamp: (v, min, max) => Math.max(min, Math.min(max, v)),
    dbToGain: (db) => 10 ** (db / 20),
    gainToDb: (g) => 20 * Math.log10(Math.max(g, 1e-12)),
    sleep: async () => {},
    setStatus: () => {},
    document: { createElement: (tag) => new Node(tag), createTextNode: (t) => { const n = new Node('#text'); n.textContent = t; return n; } },
    state: { original, stemBuffers: stems, stemPlans: {}, mixMetrics: null },
    forensicState: { profile: { intensity: 'balanced' } },
    buildStemPlans: async () => {},
    renderStemPlans: () => {},
    rebuildCorrectedMix: async () => { context.fallbackCalls++; },
    fallbackCalls: 0,
    renderProcessedBuffer,
    cloneBuffer: (b) => new Buf(b.channels, b.sampleRate),
    bufferRms: (b) => {
      let sum = 0, n = 0;
      for (const d of b.channels) for (let i = 0; i < d.length; i++) { sum += d[i] * d[i]; n++; }
      return Math.sqrt(sum / Math.max(1, n));
    },
  });
  context.$ = (id) => (id === 'stemPanel' ? dom.panel : dom.panel.find(id));
  vm.runInContext(fs.readFileSync(new URL('../js/app-metrics.js', import.meta.url), 'utf8'), context);
  context.state.mixMetrics = context.measureBuffer(original);
  for (const [stem, buffer] of Object.entries(stems)) {
    context.state.stemPlans[stem] = { metrics: context.measureBuffer(buffer), quality: { score: quality[stem] ?? 90 }, wet: 0.3 };
  }
  // The level-ride planner is optional: the engine rides the lead vocal only when it is loaded.
  if (autoMix) vm.runInContext(fs.readFileSync(new URL('../js/app-auto-mix-core.js', import.meta.url), 'utf8'), context);
  vm.runInContext(fs.readFileSync(new URL('../js/app-sequential-mixing.js', import.meta.url), 'utf8'), context);
  return { context, dom };
}

const sameSamples = (a, b) => a.channels.every((d, c) => d.every((x, i) => Math.abs(x - b.channels[c][i]) < 1e-6));

// ----------------------------------------------- 1. full sequential build

{
  const stems = { vocals: stereo(vocalMono), other: stereo(otherMono), bass: stereo(bassMono), drums: stereo(drumMono) };
  const original = stereo(add(vocalMono, otherMono, bassMono, drumMono));
  const untouched = original.channels.map((d) => Float32Array.from(d));
  const { context, dom } = makeContext({ stems, original });
  const seq = context.mixForgeSequential;

  await context.buildStemPlans();
  assert.equal(seq.plan.anchor, 'vocals', 'a present lead vocal is the anchor');
  assert.equal(seq.plan.stages.map((s) => s.stem).join(), 'vocals,other,bass,drums');

  // Production regression: the vocal card's nested `.actions` row used to be handed
  // to insertBefore(), which threw after the sequential mix had rendered and
  // silently discarded it.
  const out = await context.rebuildCorrectedMix();
  assert.equal(context.fallbackCalls, 0, 'must never run the parallel rebuild');
  const log = dom.panel.find('mixStageLog');
  assert.ok(log, 'stage log renders even with nested .actions rows in the stem cards');
  assert.equal(log.parentElement, dom.panel);
  assert.ok(dom.panel.children.indexOf(log) < dom.panel.children.indexOf(dom.actions), 'log sits above the rebuild button');
  assert.ok(dom.panel.find('stageAudition'), 'stage audition controls render');

  assert.equal(seq.stages.length, 4);
  const [vocals, other] = seq.stages;
  assert.equal(vocals.marginBefore, null);
  assert.ok(Number.isFinite(vocals.marginAfter), 'anchor stage measures the lead margin');
  assert.ok(other.decision.operations.some((op) => op.frequency === 3000), 'guitars carve room in the vocal range');
  assert.ok(other.applied, 'carve is kept');
  assert.ok(other.marginAfter > other.marginBefore, `lead margin must improve (${other.marginBefore.toFixed(2)} → ${other.marginAfter.toFixed(2)})`);
  for (const stage of seq.stages.slice(1)) {
    assert.equal(stage.marginBefore, seq.stages[stage.index - 2].marginAfter, 'each stage starts from the mix the previous stage left');
  }
  assert.ok(seq.assessment.summary.includes('vocal is carrying this song'));
  assert.ok(seq.assessment.summary.includes('guitars / keys bucket'), 'assessment names the main conflict');
  assert.ok(seq.assessment.marginLine);

  assert.ok(untouched.every((d, c) => d.every((x, i) => x === original.channels[c][i])), 'original must remain immutable');
  assert.ok(!sameSamples(out, original), 'the sequential mix actually changed the audio');

  // Replaying the kept decisions reproduces the rendered mix exactly, so any stage
  // can be auditioned without holding every stage in memory.
  seq.snapshots = {};
  const replay = await seq.renderStage(seq.stages.length);
  assert.ok(sameSamples(replay, out), 'stage replay matches the rendered mix');
  assert.equal(await seq.renderStage(0), original, 'stage 0 is the untouched original');
}

// ------------------------------------- 2. vocal bleed → contaminated source

{
  const bleedOther = add(otherMono, vocalMono.map((x) => x * 0.45));
  const stems = { vocals: stereo(vocalMono), other: stereo(bleedOther) };
  const original = stereo(add(vocalMono, otherMono));
  const { context } = makeContext({ stems, original });
  const seq = context.mixForgeSequential;
  await context.buildStemPlans();
  await context.rebuildCorrectedMix();
  const other = seq.stages[1];
  assert.ok(['contaminated', 'isolate-off'].includes(other.source.state), `vocal bleed must lower confidence (got ${other.source.state}, bleed ${other.source.bleed.toFixed(2)})`);
  assert.ok(!other.decision.operations.some((op) => op.frequency === 3000), 'never carve the vocal range out of a stem that carries the vocal');
}

// -------------------------------------------- 3. instrumental → no vocal anchor

{
  const stems = { vocals: stereo(vocalMono.map((x) => x * 0.001)), other: stereo(otherMono), bass: stereo(bassMono) };
  const original = stereo(add(otherMono, bassMono));
  const { context } = makeContext({ stems, original });
  await context.buildStemPlans();
  const plan = context.mixForgeSequential.plan;
  assert.equal(plan.anchor, 'other', 'an instrumental anchors on the melodic bed');
  assert.ok(plan.skipped.some((s) => s.stem === 'vocals'), 'a silent vocal stem is left untouched');
  assert.ok(!plan.stages.some((s) => s.stem === 'vocals'));
}

// ------------------------------------- 4. a stage that makes things worse is undone

{
  const stems = { vocals: stereo(vocalMono), other: stereo(otherMono) };
  const original = stereo(add(vocalMono, otherMono));
  const { context } = makeContext({ stems, original });
  const seq = context.mixForgeSequential;
  await context.buildStemPlans();
  // Sabotage the renderer for the support stem: every "carve" becomes a big boost.
  const honest = context.renderProcessedBuffer;
  context.renderProcessedBuffer = async (source, ops) => honest(source, source === stems.other ? ops.map((op) => ({ ...op, gain: 12 })) : ops);
  const out = await context.rebuildCorrectedMix();
  const other = seq.stages[1];
  assert.ok(other.reverted, 'a move that measures worse is undone');
  assert.equal(other.attempts.length, 2, 'half strength is tried before giving up');
  assert.ok(other.decision.changed.includes('undid'));
  assert.ok(seq.assessment.summary.includes('undid'));
  const anchorOnly = await seq.renderStage(1);
  assert.ok(sameSamples(out, anchorOnly), 'a reverted stage leaves the mix exactly as the previous stage left it');
}

// ------------------------- 5. poor separation → observed but not processed

{
  const stems = { vocals: stereo(vocalMono), other: stereo(otherMono) };
  const original = stereo(add(vocalMono, otherMono));
  const { context } = makeContext({ stems, original, quality: { other: 40 } });
  await context.buildStemPlans();
  await context.rebuildCorrectedMix();
  const other = context.mixForgeSequential.stages[1];
  assert.equal(other.source.state, 'isolate-off');
  assert.equal(other.decision.operations.length, 0);
  assert.equal(context.state.stemPlans.other.operations.length, 0, 'stale card operations are cleared');
}

// ------------------------------- 6. timing mismatch fails loudly, no fallback

{
  const stems = { vocals: new Buf([vocalMono.slice(0, LENGTH - 10), vocalMono.slice(0, LENGTH - 10)]) };
  const original = stereo(vocalMono);
  const { context } = makeContext({ stems, original });
  context.state.stemPlans.vocals.metrics.crestDb = 30; // force an anchor move
  await context.buildStemPlans();
  await assert.rejects(context.rebuildCorrectedMix(), /timing/);
  assert.equal(context.fallbackCalls, 0);
  assert.equal(context.mixForgeSequential.stages.length, 0);
}

// ------------------------------------------------ 8. vocal level rides (automation)

{
  // A 16-second song: four 3-second vocal phrases over a steady band. The second phrase is sung 6 dB quieter.
  const SEC = 16;
  const LEN = RATE * SEC;
  const longNoise = (seed) => { const r = rng(seed); return Float32Array.from({ length: LEN }, () => r()); };
  const longBand = (seed, freq, q, gain) => filter(longNoise(seed), coefs('bandpass', freq, q, 0)).map((x) => x * gain);
  const sum = (...parts) => Float32Array.from({ length: LEN }, (_, i) => parts.reduce((total, p) => total + p[i], 0));
  const phraseDb = [0, -6, 0, 0];
  const voice = sum(longBand(11, 2800, 1.2, 0.35), longBand(12, 300, 1.5, 0.12)).map((x, i) => {
    const t = i / RATE, phrase = Math.floor(t / 4);
    return t - phrase * 4 < 3 ? x * 10 ** (phraseDb[phrase] / 20) : 0;
  });
  const bed = sum(longBand(13, 3000, 1.0, 0.12), longBand(14, 600, 0.9, 0.2));
  const low = Float32Array.from({ length: LEN }, (_, i) => 0.25 * Math.sin(2 * Math.PI * 70 * i / RATE));
  const kit = Float32Array.from({ length: LEN }, (_, i) => { const t = (i % (RATE / 2)) / RATE; return 0.5 * Math.exp(-t * 30) * Math.sin(2 * Math.PI * 65 * t); });
  const build = (options = {}) => {
    const stems = { vocals: stereo(voice), other: stereo(bed), bass: stereo(low), drums: stereo(kit) };
    const original = stereo(sum(voice, bed, low, kit));
    return { stems, original, ...makeContext({ stems, original, autoMix: true, ...options }) };
  };
  const rmsOf = (data, from, to) => { let total = 0; for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) total += data[i] * data[i]; return Math.sqrt(total / Math.round((to - from) * RATE)); };

  // 8a. The dipped phrase is lifted; everything else is left alone.
  {
    const { context, dom, original } = build();
    const untouched = original.channels.map((d) => Float32Array.from(d));
    const seq = context.mixForgeSequential;
    await context.buildStemPlans();
    const out = await context.rebuildCorrectedMix();
    assert.equal(seq.stages.length, seq.plan.stages.length + 1, 'the ride is one more stage after the stems are placed');
    const ride = seq.stages[seq.stages.length - 1];
    assert.equal(ride.kind, 'ride');
    assert.equal(ride.stem, 'vocals');
    assert.equal(ride.title, 'Vocal level rides');
    assert.ok(ride.applied, `the ride is kept (${JSON.stringify(ride.attempts)})`);
    assert.equal(ride.applied.factor, 1);
    assert.equal(ride.proposed.rides.length, 1, `one phrase needs a ride (${JSON.stringify(ride.proposed.rides)})`);
    const [lift] = ride.proposed.rides;
    assert.ok(lift.gainDb > 2 && lift.gainDb <= 3, `a lift of a few dB, inside the cap (${lift.gainDb})`);
    assert.ok(lift.startSec >= 3.5 && lift.startSec <= 4.6 && lift.endSec >= 6.4 && lift.endSec <= 7.6, `on the quiet phrase (${lift.startSec}–${lift.endSec})`);
    assert.ok(ride.proposed.outOfPlaceAfter.worstDipDb < ride.proposed.outOfPlaceBefore.worstDipDb, 'the phrase is closer to its usual place');
    assert.match(ride.decision.heard, /the vocal usually sits .* the band/);
    assert.match(ride.decision.changed, /^rode the vocal level in 1 place \(\+\d\.\d dB at 0:0[34]–0:0[67]\)$/);
    assert.match(seq.assessment.summary, /rode the vocal's level in 1 place/);

    // The audio: inside the ride the change is the placed vocal times the ride gain; outside it nothing changed.
    const before = await seq.renderStage(ride.index - 1);
    const diff = Float32Array.from(out.channels[0], (x, i) => x - before.channels[0][i]);
    assert.ok(rmsOf(diff, 0.5, 2.5) < 1e-6, 'a phrase that held its place is untouched');
    assert.ok(rmsOf(diff, 8.5, 10.5) < 1e-6);
    const expected = 10 ** (lift.gainDb / 20) - 1;
    const actual = rmsOf(diff, 4.8, 6.2) / rmsOf(voice, 4.8, 6.2);
    assert.ok(Math.abs(actual - expected) < 0.08, `the lift in the audio matches the receipt (${actual.toFixed(3)} vs ${expected.toFixed(3)})`);
    assert.ok(untouched.every((d, c) => d.every((x, i) => x === original.channels[c][i])), 'original must remain immutable');

    // It shows up where every other stage does: the log, the stage player, and a deterministic replay.
    const headings = [...dom.panel.find('mixStageLog').walk()].filter((n) => n.tagName === 'h3').map((n) => n.textContent);
    assert.ok(headings.includes(`Stage ${ride.index} · Vocal level rides`), headings.join(' | '));
    const buttons = dom.panel.find('stageAudition').querySelectorAll('button').map((b) => b.textContent);
    assert.ok(buttons.includes(`After ${ride.index} · Vocal level rides`), buttons.join(' | '));
    seq.snapshots = {};
    seq.audition.cache = {};
    assert.ok(sameSamples(await seq.renderStage(seq.stages.length), out), 'replaying the kept decisions reproduces the ride exactly');
  }

  // 8b. Rides can be switched off: the mix is then exactly the static stages.
  {
    const { context } = build();
    context.state.mixOptions = { rides: false };
    const seq = context.mixForgeSequential;
    await context.buildStemPlans();
    await context.rebuildCorrectedMix();
    assert.equal(seq.stages.length, seq.plan.stages.length);
    assert.ok(!seq.stages.some((stage) => stage.kind === 'ride'));
  }

  // 8c. A vocal stem that cannot be trusted on its own is not ridden, and the stage says why.
  {
    const { context } = build({ quality: { vocals: 55 } });
    const seq = context.mixForgeSequential;
    await context.buildStemPlans();
    const out = await context.rebuildCorrectedMix();
    const ride = seq.stages[seq.stages.length - 1];
    assert.equal(ride.kind, 'ride');
    assert.equal(ride.applied, null);
    assert.equal(ride.reverted, false);
    assert.equal(ride.proposed.rides.length, 0);
    assert.match(ride.decision.heard, /cannot be trusted on its own/);
    assert.match(ride.decision.changed, /left exactly as it is/);
    assert.ok(sameSamples(await seq.renderStage(ride.index - 1), out), 'no ride, no change');
  }

  // 8d. A ride that leaves the mix measuring worse is tried at half strength, then undone.
  {
    const { context } = build();
    const seq = context.mixForgeSequential;
    await context.buildStemPlans();
    const realMeasure = context.measureBuffer;
    let rideChecks = 0;
    // The static stages measure normally. Every measurement the ride stage takes reports peaks 2 dB higher.
    context.setStatus = (_id, message) => { if (/Riding the vocal/.test(message)) rideChecks = 1; };
    context.measureBuffer = (buffer) => { const m = realMeasure(buffer); return rideChecks ? { ...m, peakDb: m.peakDb + 2 } : m; };
    const out = await context.rebuildCorrectedMix();
    const ride = seq.stages[seq.stages.length - 1];
    assert.equal(ride.kind, 'ride');
    assert.equal(ride.attempts.map((a) => a.factor).join(), '1,0.5', 'full strength, then half');
    assert.ok(ride.attempts.every((a) => a.problems.some((p) => /peaks rose/.test(p))));
    assert.equal(ride.applied, null);
    assert.equal(ride.reverted, true);
    assert.match(ride.decision.changed, /^nothing in the end — I tried 1 level ride, but the mix measured worse/);
    assert.equal(ride.proposed.rides.length, 1, 'the proposal stays on record');
    context.measureBuffer = realMeasure;
    assert.ok(sameSamples(await seq.renderStage(ride.index - 1), out), 'an undone ride leaves the mix as the static stages built it');
  }
}

console.log('sequential-mixing-smoke: ok');
