import assert from 'node:assert/strict';
import { MixForgeTruePeak4x, measureTruePeak4xChannels } from '../js/true-peak-core.mjs';

function sine({ frequency, sampleRate = 48000, seconds = 0.25, amplitude = 0.9, phase = 0 }) {
  const length = Math.round(sampleRate * seconds);
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) data[i] = amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate + phase);
  return data;
}

function samplePeak(data) {
  let peak = 0;
  for (const value of data) peak = Math.max(peak, Math.abs(value));
  return peak;
}

// High-frequency programme is where sample peak can materially understate the
// interpolated waveform. The 4x FIR must detect a peak above the raw samples.
const high = sine({ frequency: 18000, amplitude: 0.9 });
const highSamplePeak = samplePeak(high);
const highMeasured = measureTruePeak4xChannels([high]);
assert.ok(highMeasured.peakLinear > highSamplePeak + 0.02, `expected inter-sample rise, sample=${highSamplePeak}, 4x=${highMeasured.peakLinear}`);
assert.equal(highMeasured.oversample, 4);
assert.equal(highMeasured.tapsPerPhase, 12);

// Linear gain must translate exactly to the same dB change in the peak meter.
const half = Float32Array.from(high, (value) => value * 0.5);
const halfMeasured = measureTruePeak4xChannels([half]);
assert.ok(Math.abs((highMeasured.peakDb - halfMeasured.peakDb) - 6.020599913) < 0.002);

// Stereo/channel handling must preserve the highest channel rather than average
// peaks together.
const quiet = sine({ frequency: 1000, amplitude: 0.2 });
const stereo = measureTruePeak4xChannels([quiet, high]);
assert.ok(Math.abs(stereo.peakDb - highMeasured.peakDb) < 1e-9);

// Stateful block processing must produce the same result as one whole block.
const meter = new MixForgeTruePeak4x(1);
const split = Math.floor(high.length / 3);
meter.process([high.subarray(0, split)]);
meter.process([high.subarray(split, split * 2)]);
meter.process([high.subarray(split * 2)]);
meter.processSilence(16);
assert.ok(Math.abs(meter.peakDb - highMeasured.peakDb) < 1e-9);

// A signal ending at the file boundary still receives enough zero-padding to
// flush the interpolation history; this guards end-of-file inter-sample peaks.
const boundary = new Float32Array([0.0, 0.35, -0.82, 0.91, -0.64, 0.23]);
const withoutFlush = new MixForgeTruePeak4x(1);
withoutFlush.process([boundary]);
const withFlush = measureTruePeak4xChannels([boundary], 16);
assert.ok(withFlush.peakLinear >= withoutFlush.peakLinear);
assert.ok(Number.isFinite(withFlush.peakDb));

console.log('MixForge 4x true-peak core smoke tests passed');
