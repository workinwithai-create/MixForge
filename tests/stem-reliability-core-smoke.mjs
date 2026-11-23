import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The stem check's maths, run on real numbers. The Stem Reliability Lab page and
// "Put your song back together" both call this module, so each rule is proved once, here.
const source = readFileSync(new URL('../js/app-stem-reliability-core.js', import.meta.url), 'utf8');
new Function(source)();
const lab = globalThis.MixForgeStemReliability;

const RATE = 8000;
const tone = (hz, seconds, level = 0.2, phase = 0) => {
  const out = new Float32Array(Math.round(RATE * seconds));
  for (let i = 0; i < out.length; i++) out[i] = level * Math.sin(2 * Math.PI * hz * i / RATE + phase);
  return out;
};
const add = (...parts) => {
  const out = new Float32Array(Math.max(...parts.map((p) => p.length)));
  for (const part of parts) for (let i = 0; i < part.length; i++) out[i] += part[i];
  return out;
};
const scale = (samples, g) => samples.map((v) => v * g);
const stem = (id, samples, durationSec) => ({ id, channels: [samples], ...(durationSec == null ? {} : { durationSec }) });
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);

const vocals = tone(440, 3, 0.3);
const bass = tone(110, 3, 0.25);
const other = tone(1230, 3, 0.15);
const mix = add(vocals, bass, other);

// 1. Complete stems rebuild the mix: nothing left over, no level correction, a strong verdict.
{
  const r = lab.auditStems({ sampleRate: RATE, mix: { channels: [mix] }, stems: [stem('vocals', vocals), stem('bass', bass), stem('other', other)] });
  assert.ok(r.metrics.exactSumResidualDb <= -100, `exact-sum residual ${r.metrics.exactSumResidualDb}`);
  assert.ok(r.metrics.gainFittedResidualDb <= -100);
  near(r.metrics.fittedGain, 1, 1e-3, 'fitted gain');
  near(r.metrics.amplitudeCoverage, 1, 1e-3, 'coverage');
  assert.ok(r.metrics.maxStemCorrelation < 0.05, 'different parts are not flagged as shared content');
  assert.equal(r.verdict.className, 'good');
  assert.equal(r.analysis.against, 'mix');
  assert.equal(r.analysis.channelMode, 'mono');
  near(r.analysis.windowSeconds, 3, 1e-6, 'window');
  assert.deepEqual(r.flags, { durationMismatches: [], nearEmptyStems: [], sharedContent: false });
  near(r.stems.find((s) => s.id === 'vocals').relativeLevelDb, 10 * Math.log10(0.09 / (0.09 + 0.0625 + 0.0225)), 0.05, 'vocals level vs mix');
  assert.match(lab.describe(r).headline, /^The stems add back up to the original mix\./);
  assert.deepEqual(lab.describe(r).notes, []);
}

// 2. A hidden level change: every stem returned 6 dB down. The exact sum shows it; the gain fit removes it.
{
  const r = lab.auditStems({ sampleRate: RATE, mix: { channels: [mix] }, stems: [stem('vocals', scale(vocals, 0.5)), stem('bass', scale(bass, 0.5)), stem('other', scale(other, 0.5))] });
  near(r.metrics.exactSumResidualDb, -6.02, 0.05, 'exact-sum residual catches the level change');
  assert.ok(r.metrics.gainFittedResidualDb <= -100, 'the gain fit accounts for one global level change');
  near(r.metrics.fittedGain, 2, 1e-3, 'fitted gain');
  assert.equal(r.verdict.className, 'good');
}

// 3. A missing part: the mix has "other", the stems do not. What is left over is that part.
{
  const r = lab.auditStems({ sampleRate: RATE, mix: { channels: [mix] }, stems: [stem('vocals', vocals), stem('bass', bass)] });
  const expected = 10 * Math.log10(0.0225 / (0.09 + 0.0625 + 0.0225));
  near(r.metrics.exactSumResidualDb, expected, 0.1, 'the residual is the missing part');
  assert.equal(r.verdict.className, 'weak');
  assert.match(lab.describe(r).headline, /do not add back up/);
  // The leftover audio is the missing part itself, so it can be heard.
  near(r.audio.residual[100], other[100], 0.02, 'residual audio');
  assert.equal(r.audio.mix.length, r.audio.residual.length);
}

// 4. A stem that stops early must not shrink the check to its own length (the old shortest-file bug).
//    The whole mix is scored, the missing tail counts as silence, and the mismatch blocks a strong verdict.
{
  const short = vocals.slice(0, RATE); // 1 of 3 seconds
  const r = lab.auditStems({ sampleRate: RATE, mix: { channels: [mix] }, stems: [stem('vocals', short), stem('bass', bass), stem('other', other)] });
  near(r.analysis.windowSeconds, 3, 1e-6, 'the window is the mix, not the shortest stem');
  assert.ok(r.metrics.gainFittedResidualDb > -10, `a missing tail is scored as silence (${r.metrics.gainFittedResidualDb} dB)`);
  assert.deepEqual(r.flags.durationMismatches, ['vocals']);
  assert.equal(r.stems.find((s) => s.id === 'vocals').durationMismatch, true);
  near(r.stems.find((s) => s.id === 'vocals').durationSeconds, 1, 1e-6, 'the stem reports its own full length');
  assert.notEqual(r.verdict.className, 'good');
  assert.match(lab.describe(r).notes.join(' '), /vocals stem is a different length from the original mix/);
}

// 5. A length mismatch past the analysis window is still caught: durations come from the full files,
//    not from the capped window. Here the first 2 seconds are perfect and one stem is 0.5 s short overall.
{
  const r = lab.auditStems({
    sampleRate: RATE, maxSeconds: 2,
    mix: { channels: [mix], durationSec: 3 },
    stems: [stem('vocals', vocals.slice(0, RATE * 2.5), 2.5), stem('bass', bass, 3), stem('other', other, 3)],
  });
  near(r.analysis.windowSeconds, 2, 1e-6, 'capped window');
  assert.ok(r.metrics.gainFittedResidualDb <= -100, 'inside the window the stems are complete');
  assert.deepEqual(r.flags.durationMismatches, ['vocals'], 'the mismatch beyond the window is still reported');
  assert.equal(r.verdict.className, 'review', 'a perfect window does not earn a strong verdict with a mismatch');
  assert.match(lab.describe(r).headline, /with something to check first/);
}
// ...and 10 ms of difference is tolerated.
{
  const r = lab.auditStems({ sampleRate: RATE, mix: { channels: [mix], durationSec: 3 }, stems: [stem('vocals', vocals, 3.009), stem('bass', bass, 3), stem('other', other, 2.991)] });
  assert.deepEqual(r.flags.durationMismatches, []);
}

// 6. A near-empty stem is flagged (it may be correct, so it is a warning, not a failure of the sum).
{
  const quiet = tone(2000, 3, 0.0005);
  const r = lab.auditStems({ sampleRate: RATE, mix: { channels: [add(mix, quiet)] }, stems: [stem('vocals', vocals), stem('bass', bass), stem('other', other), stem('drums', quiet)] });
  assert.deepEqual(r.flags.nearEmptyStems, ['drums']);
  assert.equal(r.stems.find((s) => s.id === 'drums').nearEmpty, true);
  assert.equal(r.verdict.className, 'review');
  assert.match(lab.describe(r).notes.join(' '), /drums stem is almost silent/);
}

// 7. The same part in two stems is flagged, and the pair is named.
{
  const r = lab.auditStems({ sampleRate: RATE, mix: { channels: [add(vocals, vocals, bass)] }, stems: [stem('vocals', vocals), stem('other', vocals), stem('bass', bass)] });
  assert.ok(r.metrics.maxStemCorrelation > 0.99);
  assert.equal(r.flags.sharedContent, true);
  assert.deepEqual(r.maxCorrelationPair, ['vocals', 'other']);
  assert.equal(r.verdict.className, 'review');
  assert.match(lab.describe(r).notes.join(' '), /vocals and other stems share a lot of the same sound/);
}

// 8. No original mix (a song saved as stems only): the stems are still checked against each other.
{
  const r = lab.auditStems({ sampleRate: RATE, stems: [stem('vocals', vocals), stem('bass', bass), stem('other', other)] });
  assert.equal(r.analysis.against, 'stems');
  assert.equal(r.metrics.gainFittedResidualDb, null);
  assert.equal(r.metrics.exactSumResidualDb, null);
  assert.equal(r.audio.residual, null);
  assert.equal(r.verdict.className, 'good');
  assert.match(lab.describe(r).headline, /^3 stems line up/);
  const uneven = lab.auditStems({ sampleRate: RATE, stems: [stem('vocals', vocals.slice(0, RATE * 2)), stem('bass', bass)] });
  assert.deepEqual(uneven.flags.durationMismatches, ['vocals']);
  assert.equal(uneven.verdict.className, 'review');
  assert.match(lab.describe(uneven).headline, /Check these stems before you mix/);
  assert.match(lab.describe(uneven).notes.join(' '), /different length from the longest stem/);
}

// 9. Stereo and mono inputs are both read as mono; a stereo mix of mono stems still reconstructs.
{
  const r = lab.auditStems({ sampleRate: RATE, mix: { channels: [mix, mix] }, stems: [{ id: 'vocals', channels: [vocals, vocals] }, stem('bass', bass), stem('other', other)] });
  assert.ok(r.metrics.gainFittedResidualDb <= -100);
}

// 10. The receipt carries numbers and file names only: no audio, and it survives JSON.
{
  const r = lab.auditStems({ sampleRate: RATE, mix: { channels: [mix] }, stems: [stem('vocals', vocals), stem('bass', bass), stem('other', other)] });
  const receipt = lab.toReceipt(r, { sourceFiles: [{ slot: 'mix', name: 'song.wav', type: 'audio/wav', sizeBytes: 123 }], generatedAt: '2026-11-21T00:00:00.000Z' });
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.privacy, 'Created locally; no audio uploaded.');
  assert.deepEqual(Object.keys(receipt), ['schemaVersion', 'generatedAt', 'privacy', 'sourceFiles', 'analysis', 'metrics', 'stems', 'flags', 'verdict']);
  assert.deepEqual(Object.keys(receipt.metrics).sort(), ['amplitudeCoverage', 'exactSumResidualDb', 'fittedGain', 'gainFittedResidualDb', 'maxStemCorrelation']);
  assert.equal('audio' in receipt, false);
  const text = JSON.stringify(receipt);
  assert.ok(text.length < 2000, 'a receipt is small');
  assert.deepEqual(JSON.parse(text), receipt);
}

// 11. Lossy files are recognised by name or type; lossless ones are not.
assert.equal(lab.isLossy('take.mp3'), true);
assert.equal(lab.isLossy('take.M4A'), true);
assert.equal(lab.isLossy('', 'audio/mpeg'), true);
assert.equal(lab.isLossy('', 'audio/ogg; codecs=opus'), true);
assert.equal(lab.isLossy('take.wav', 'audio/wav'), false);
assert.equal(lab.isLossy('take.flac', 'audio/flac'), false);
assert.equal(lab.isLossy('take.aiff'), false);

// 12. Refusals.
assert.throws(() => lab.auditStems({ sampleRate: RATE, mix: { channels: [mix.slice(0, 100)] }, stems: [stem('vocals', vocals)] }), /at least one second/);
assert.throws(() => lab.auditStems({ sampleRate: RATE, mix: { channels: [mix] }, stems: [] }), /at least one stem/);
assert.throws(() => lab.auditStems({ mix: { channels: [mix] }, stems: [stem('vocals', vocals)] }), /sample rate/);

// 13. It is pure: no network and no page access.
assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|WebSocket|document\.|window\./);

console.log('stem reliability core smoke ok');
