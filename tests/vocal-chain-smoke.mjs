import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

class FakeBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.data = Array.from({ length: channels }, () => new Float32Array(length));
  }
  getChannelData(channel) { return this.data[channel]; }
  copyToChannel(source, channel) { this.data[channel].set(source); }
}

const context = vm.createContext({
  console,
  Math,
  Float32Array,
  Float64Array,
  Object,
  Array,
  Number,
  String,
  clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
  dbToGain: (db) => 10 ** (db / 20),
  gainToDb: (gain) => 20 * Math.log10(Math.max(gain, 1e-12)),
  band: (metrics, name) => (metrics?.midBands || []).find((item) => item.name === name)?.db ?? -120,
});
context.globalThis = context;
vm.runInContext(fs.readFileSync(new URL('../js/app-vocal-chain.js', import.meta.url), 'utf8'), context);

const muddy = context.mfPlanVocalChain({
  crestDb: 18,
  rmsDb: -18,
  dcOffset: 0,
  midBands: [
    { name: 'Sub', db: -28 },
    { name: 'Bass', db: -22 },
    { name: 'Low-mids', db: -12 },
    { name: 'Mids', db: -20 },
    { name: 'Presence', db: -24 },
    { name: 'Air', db: -30 },
  ],
  sibilance: { medianDb: -20, p95Db: -18, flares: 0, frames: 40 },
}, { bpm: 96 });
assert.ok(muddy.eq.some((op) => op.frequency === 250 && op.gain < 0), 'muddy/boomy vocal gets a 250 Hz cut');
assert.ok(muddy.eq.every((op) => Number(op.gain || 0) >= -4.5), 'EQ cuts stay bounded');
assert.ok(muddy.compressor, 'high-crest vocal gets control compression');
assert.ok(muddy.compressor.ratio >= 1.8 && muddy.compressor.ratio <= 3.2, 'ratio stays in the control range');
assert.ok(Number.isFinite(muddy.compressor.threshold), 'threshold is reported');
assert.equal(muddy.delay.musical, '1/8');
assert.equal(muddy.delay.bpm, 96);
assert.ok(muddy.reverb.wet <= 0.16 && muddy.reverb.decaySec <= 1.4, 'room stays light');
assert.equal(muddy.pitch.applied, false);
assert.match(muddy.pitch.note, /Pitch: not applied — no musical engine in this build/);
assert.match(muddy.pitch.note, /Rubber Band/);
assert.doesNotMatch(JSON.stringify(muddy), /professionally mixed|professionally tuned|verified in tune/i);

const dark = context.mfPlanVocalChain({
  crestDb: 12,
  rmsDb: -16,
  dcOffset: 0,
  midBands: [
    { name: 'Sub', db: -30 },
    { name: 'Bass', db: -22 },
    { name: 'Low-mids', db: -14 },
    { name: 'Mids', db: -16 },
    { name: 'Presence', db: -28 },
    { name: 'Air', db: -32 },
  ],
  sibilance: { medianDb: -22, p95Db: -20, flares: 1, frames: 40 },
});
assert.ok(dark.eq.some((op) => op.frequency === 3500 && op.gain > 0 && op.gain <= 2), 'dark vocal gets a small presence lift');
assert.equal(dark.compressor, null, 'already-controlled crest is not smashed');
assert.equal(dark.delay.musical, 'slap', 'unknown tempo uses a short musical default');

const sibilant = context.mfPlanVocalChain({
  crestDb: 13,
  rmsDb: -15,
  dcOffset: 0,
  midBands: [
    { name: 'Sub', db: -32 },
    { name: 'Bass', db: -24 },
    { name: 'Low-mids', db: -18 },
    { name: 'Mids', db: -16 },
    { name: 'Presence', db: -15 },
    { name: 'Air', db: -14 },
  ],
  sibilance: { medianDb: -18, p95Db: -8, flares: 8, frames: 40 },
});
assert.ok(sibilant.eq.some((op) => op.type === 'deess' && op.frequency === 6800), 'sibilant stem gets a de-ess');

const sampleRate = 44100;
const length = sampleRate;
const boom = new FakeBuffer(1, length, sampleRate);
for (let i = 0; i < length; i++) {
  boom.data[0][i] = Math.sin(2 * Math.PI * 250 * i / sampleRate) * 0.55
    + Math.sin(2 * Math.PI * 1000 * i / sampleRate) * 0.08;
}
const applied = context.mfApplyVocalChain(boom, muddy);
assert.equal(applied.applied, true);
assert.ok(applied.moves.length >= 3, 'what-changed lists each move');
assert.ok(applied.moves.some((line) => /250 Hz/.test(line)));
assert.ok(Number(muddy.compressor.grPeakDb) >= 0, 'GR is reported');

function bandEnergy(buffer, hz) {
  const data = buffer.getChannelData(0);
  let energy = 0;
  const period = Math.max(8, Math.round(sampleRate / hz));
  for (let i = period; i < data.length; i++) {
    energy += Math.abs(data[i] - data[i - period]);
  }
  return energy / (data.length - period);
}
assert.ok(bandEnergy(applied.buffer, 250) < bandEnergy(boom, 250), 'mud cut actually changes the vocal stem');

const skip = context.mfVocalChainSkipReport();
assert.match(skip.skipWarning, /without isolation/);
assert.equal(skip.pitch.applied, false);

const lines = context.mfVocalChainWhatChangedLines(applied.applied ? { ...muddy, applied: true } : muddy);
assert.ok(lines.bullets.some((line) => /Vocal EQ/.test(line)));
assert.ok(lines.bullets.some((line) => /Vocal compression/.test(line) && /GR/.test(line)));
assert.ok(lines.bullets.some((line) => /Pitch: not applied/.test(line)));
assert.doesNotMatch(lines.bullets.join(' '), /professionally mixed|professionally tuned|verified in tune/i);

const musician = context.mfVocalChainWhatChangedLines(skip);
assert.match(musician.musician.join(' '), /without isolation/);

const indexHtml = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
assert.match(indexHtml, /app-vocal-chain\.js/);
assert.match(indexHtml, /conservative vocal chain/);
assert.doesNotMatch(indexHtml, /does not judge vocal performance/);
assert.doesNotMatch(indexHtml, /vocals live in/);
assert.doesNotMatch(indexHtml, /professionally mixed|professionally tuned/);

const uxSrc = fs.readFileSync(new URL('../js/app-musician-ux.js', import.meta.url), 'utf8');
assert.doesNotMatch(uxSrc, /not pitch or timing \(AuraMix\)/);
assert.doesNotMatch(uxSrc, /Gemini may listen to the mix\/master excerpt; it does not judge performance/);
assert.match(uxSrc, /mfEnsureVocalChain/);

console.log('vocal-chain-smoke: ok');
