import assert from 'node:assert/strict';
import { compare, decodeWav, encodeWavFloat, formatReport, THIRD_OCTAVES } from '../tools/master-diff.mjs';

// Synthetic "service": +6 dB, a +4 dB high shelf above ~3 kHz, a hard clip at
// -1 dBFS, and 37 ms of extra leading silence. The tool should recover each.
const rate = 48000;
const seconds = 20;
const length = rate * seconds;
let seed = 7;
const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const left = new Float32Array(length);
const right = new Float32Array(length);
let lowL = 0, lowR = 0;
for (let i = 0; i < length; i++) {
  // Pink-ish noise with a slow loudness swell, plus a kick every half second.
  lowL = 0.98 * lowL + 0.2 * random();
  lowR = 0.98 * lowR + 0.2 * random();
  const swell = 0.5 + 0.5 * Math.sin(2 * Math.PI * i / (rate * 5));
  const kick = (i % (rate / 2)) < 2400 ? Math.sin(2 * Math.PI * 55 * i / rate) * Math.exp(-(i % (rate / 2)) / 600) * 0.5 : 0;
  left[i] = (lowL * 0.3 + random() * 0.03) * (0.3 + swell) + kick;
  right[i] = (lowR * 0.3 + random() * 0.03) * (0.3 + swell) + kick;
}

const offset = Math.round(0.037 * rate);
const masterL = new Float32Array(length + offset);
const masterR = new Float32Array(length + offset);
const shelf = (input) => {
  // First-order high shelf: y = x + k * highpass(x), corner ~3 kHz, +4 dB.
  const out = new Float32Array(input.length);
  const k = 10 ** (4 / 20) - 1;
  const rc = 1 / (2 * Math.PI * 3000), alpha = rc / (rc + 1 / rate);
  let px = 0, py = 0;
  for (let i = 0; i < input.length; i++) {
    const hp = alpha * (py + input[i] - px);
    px = input[i]; py = hp;
    out[i] = input[i] + k * hp;
  }
  return out;
};
const ceiling = 10 ** (-1 / 20);
const gain = 10 ** (6 / 20);
for (const [source, target] of [[shelf(left), masterL], [shelf(right), masterR]]) {
  for (let i = 0; i < length; i++) target[i + offset] = Math.max(-ceiling, Math.min(ceiling, source[i] * gain));
}

const original = decodeWav(encodeWavFloat([left, right], rate));
const master = decodeWav(encodeWavFloat([masterL, masterR], rate));
assert.equal(original.length, length);
assert.equal(original.sampleRate, rate);

const result = compare(original, master);
assert.equal(result.alignment.lagSamples, offset, `alignment should recover ${offset} samples, got ${result.alignment.lagSamples}`);
assert.ok(result.loudnessGainDb > 4 && result.loudnessGainDb < 8, `loudness gain ${result.loudnessGainDb}`);
assert.ok(result.after.samplePeakDb <= -0.99 && result.after.samplePeakDb > -1.2, `master sample peak ${result.after.samplePeakDb}`);
assert.ok(result.after.truePeakDb >= result.after.samplePeakDb, 'true peak must be at least the sample peak');

const eqAt = (hz) => result.eq[THIRD_OCTAVES.indexOf(hz)].midDb;
assert.ok(eqAt(10000) - eqAt(200) > 2.5, `high shelf should show in the effective EQ: 10k ${eqAt(10000)} vs 200 Hz ${eqAt(200)}`);
assert.ok(Math.abs(result.width[1].widthChangeDb) < 0.5, `no stereo processing was applied, width change ${result.width[1].widthChangeDb}`);
assert.ok(result.gainReduction.p95Db > 0.3, `clipping the loudest blocks should register as gain reduction, got ${result.gainReduction.p95Db}`);

const report = formatReport('synthetic', result);
assert.match(report, /Effective EQ/);
assert.match(report, /Integrated LUFS/);

assert.throws(() => compare(original, { ...master, sampleRate: 44100 }), /Sample rates differ/);

console.log('master-diff-smoke: ok');
