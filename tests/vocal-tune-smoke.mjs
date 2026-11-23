// Vocal tuning: the tuned vocal lands on pitch, the harmony stays in the key, and folding it into a mix
// replaces the vocal without touching the band.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const load = (file) => { const sandbox = { module: { exports: {} }, console }; vm.runInNewContext(readFileSync(new URL(file, import.meta.url), 'utf8'), sandbox); return sandbox.module.exports; };
const E = load('../js/app-pitch-engine.js').MFPitch;
const { MF_TUNE_DEFAULTS, mfTuneActive, mfTuneRunKey, mfTuneHarmonyCurve, mfTuneVocal, mfTuneMix } = load('../js/app-vocal-tune.js');

const sr = 44100;
function tone(f, sec, amp = 0.3) {
  const n = Math.round(sr * sec), d = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { ph += 2 * Math.PI * f / sr; d[i] = amp * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.3 * Math.sin(3 * ph) + 0.2 * Math.sin(4 * ph)); }
  return d;
}
const hz = (d, at = 1.5) => E.f0At(d, sr * at, sr);
const rms = (d, from = sr, to = 2 * sr) => { let e = 0; for (let i = from; i < to; i++) e += d[i] * d[i]; return Math.sqrt(e / (to - from)); };

// Off by default, and "off" means nothing is done.
assert.equal(mfTuneActive(MF_TUNE_DEFAULTS), false);
assert.equal(mfTuneActive({ ...MF_TUNE_DEFAULTS, snap: true }), true);
assert.equal(mfTuneActive({ ...MF_TUNE_DEFAULTS, harmony: 'third' }), true);
const sung = tone(228, 3); // an A sung 62 cents sharp
const off = await mfTuneVocal(E, [sung], sr, MF_TUNE_DEFAULTS);
assert.equal(off.lead[0], sung, 'with everything off the vocal is handed back as it was');
assert.equal(off.harmony, null);

// Snap to key.
const snapped = await mfTuneVocal(E, [sung], sr, { snap: true, key: 'A', scale: 'minor', strength: 1 });
assert.ok(Math.abs(hz(snapped.lead[0]) - 220) < 0.7, `snap lands on A (got ${hz(snapped.lead[0]).toFixed(2)} Hz)`);
assert.ok(snapped.stats.movedShare > 0.9 && Math.abs(snapped.stats.averageCents - 62) < 4, `reports what it moved (${(snapped.stats.movedShare * 100).toFixed(0)}%, ${snapped.stats.averageCents.toFixed(0)} cents)`);
assert.notEqual(snapped.lead[0], sung, 'the input is not changed in place');
assert.ok(Math.abs(hz(sung) - 228) < 0.7);

// Half strength moves half way (31 cents of the 62).
const half = await mfTuneVocal(E, [sung], sr, { snap: true, key: 'A', scale: 'minor', strength: 0.5 });
const halfCents = 1200 * Math.log2(hz(half.lead[0]) / 220);
assert.ok(Math.abs(halfCents - 31) < 4, `half strength leaves about 31 cents (got ${halfCents.toFixed(1)})`);

// Snap and a pitch shift together in one pass: sharp A, snapped, up 2 semitones = B.
const both = await mfTuneVocal(E, [sung], sr, { snap: true, key: 'A', scale: 'minor', strength: 1, semitones: 2 });
assert.ok(Math.abs(hz(both.lead[0]) - 246.94) < 1.5, `snap + 2 semitones lands on B (got ${hz(both.lead[0]).toFixed(2)})`);

// Harmony in key: a third above A in A minor is C (3 semitones); a third above C is E (4 semitones).
const a = tone(220, 3), c = tone(261.63, 3);
const thirdA = await mfTuneVocal(E, [a], sr, { harmony: 'third', key: 'A', scale: 'minor' });
const thirdC = await mfTuneVocal(E, [c], sr, { harmony: 'third', key: 'A', scale: 'minor' });
assert.ok(Math.abs(hz(thirdA.harmony[0]) - 261.63) < 1.5, `third above A in A minor is C (got ${hz(thirdA.harmony[0]).toFixed(1)})`);
assert.ok(Math.abs(hz(thirdC.harmony[0]) - 329.63) < 2, `third above C in A minor is E (got ${hz(thirdC.harmony[0]).toFixed(1)})`);
assert.equal(thirdA.lead[0], a, 'harmony alone leaves the lead as it was');
const fifth = await mfTuneVocal(E, [a], sr, { harmony: 'fifth', key: 'A', scale: 'minor' });
assert.ok(Math.abs(hz(fifth.harmony[0]) - 329.63) < 2, `fifth above A is E (got ${hz(fifth.harmony[0]).toFixed(1)})`);
const up = await mfTuneVocal(E, [a], sr, { harmony: 'octave-up' });
assert.ok(Math.abs(hz(up.harmony[0]) - 440) < 2.5);
// The harmony of a sharp note is in tune, because it is built from the tuned lead.
const tunedHarmony = await mfTuneVocal(E, [sung], sr, { snap: true, strength: 1, harmony: 'third', key: 'A', scale: 'minor' });
assert.ok(Math.abs(hz(tunedHarmony.harmony[0]) - 261.63) < 1.5, `harmony of a snapped note is in tune (got ${hz(tunedHarmony.harmony[0]).toFixed(1)})`);
// A pentatonic scale borrows its seven-note parent to count harmony steps.
const pent = mfTuneHarmonyCurve(E, a, sr, 'A', 'minor_pent', 2);
assert.ok(Math.abs(pent.semis[60] - 3) < 0.1, `pentatonic third uses the parent scale (got ${pent.semis[60].toFixed(2)})`);
// Silence has no note: the curve still has a value everywhere and nothing blows up.
const quiet = await mfTuneVocal(E, [new Float32Array(sr * 2)], sr, { snap: true, harmony: 'third', key: 'A', scale: 'minor' });
assert.ok(quiet.lead[0].every((v) => v === 0) && quiet.harmony[0].every((v) => Number.isFinite(v)));

// Folding into a mix: mix = band + vocal. After tuning, the band must be exactly what it was and the
// vocal must be the tuned one.
const band = tone(98, 3, 0.2); // a low G under the vocal
const mix = Float32Array.from(band, (v, i) => v + sung[i]);
const mixBefore = Float32Array.from(mix);
const out = mfTuneMix([mix, mix], [sung], snapped.lead, null, 0)[0];
const vocalOut = Float32Array.from(out, (v, i) => v - band[i]);
assert.ok(Math.abs(hz(vocalOut) - 220) < 0.7, `the mix now carries the tuned vocal (got ${hz(vocalOut).toFixed(2)} Hz)`);
let bandError = 0; for (let i = 0; i < out.length; i++) bandError = Math.max(bandError, Math.abs(out[i] - snapped.lead[0][i] - band[i]));
assert.ok(bandError < 1e-6, `the band is untouched (largest difference ${bandError.toExponential(1)})`);
assert.ok(mix.every((v, i) => v === mixBefore[i]), 'the mix that was passed in is not changed');

// Nothing on: the mix comes back sample for sample.
const untouched = mfTuneMix([mix], [sung], off.lead, off.harmony, 0.3)[0];
assert.ok(untouched.every((v, i) => v === mix[i]));

// Harmony level: added at the level asked for, on top of the mix.
const withHarmony = mfTuneMix([mix], [a], thirdA.lead, thirdA.harmony, 0.5)[0];
const added = Float32Array.from(withHarmony, (v, i) => v - mix[i]);
assert.ok(Math.abs(rms(added) / rms(thirdA.harmony[0]) - 0.5) < 0.01, 'harmony goes in at the chosen level');

// The mix stage works out "everything except the vocal" as mix minus vocal stem, and may change the vocal's
// level (a +3 dB ride is a gain of 1.41). So it has to be given the song as if it had been sung in tune:
// the tuned stem AND a mix whose vocal is the tuned one.
const ride = 1.41;
const tunedMix = mfTuneMix([mix], [sung], snapped.lead, null, 0)[0]; // mix - vocal as it was + tuned vocal
let restError = 0; for (let i = 0; i < tunedMix.length; i++) restError = Math.max(restError, Math.abs(tunedMix[i] - snapped.lead[0][i] - band[i]));
assert.ok(restError < 1e-6, `"everything except the vocal" is exactly the band (largest difference ${restError.toExponential(1)})`);
const afterRide = Float32Array.from(tunedMix, (v, i) => v + (ride - 1) * snapped.lead[0][i]); // what the mix stage hands back
let rideError = 0; for (let i = 0; i < afterRide.length; i++) rideError = Math.max(rideError, Math.abs(afterRide[i] - band[i] - ride * snapped.lead[0][i]));
assert.ok(rideError < 1e-6, `after a level ride the mix is band + tuned vocal at the ridden level (largest difference ${rideError.toExponential(1)})`);
// Had only the stem been swapped, "everything except the vocal" would carry a ghost of both vocals.
let ghost = 0; for (let i = sr; i < 2 * sr; i++) ghost = Math.max(ghost, Math.abs(mix[i] - snapped.lead[0][i] - band[i]));
assert.ok(ghost > 0.05, 'a tuned stem against the untuned mix is not consistent, which is why the mix is swapped too');
// Harmony alone leaves the lead in the mix untouched.
const harmonyOnly = mfTuneMix([mix], [a], [a], thirdA.harmony, 0.3)[0];
assert.ok(harmonyOnly.some((v, i) => v !== mix[i]));

// The key a saved master is filed under: empty when off, stable, and different for different settings.
assert.equal(mfTuneRunKey(MF_TUNE_DEFAULTS), '');
assert.equal(mfTuneRunKey({ snap: true, key: 'A', scale: 'minor', strength: 0.8 }), mfTuneRunKey({ strength: 0.8, scale: 'minor', key: 'A', snap: true }));
assert.notEqual(mfTuneRunKey({ snap: true, key: 'A', scale: 'minor' }), mfTuneRunKey({ snap: true, key: 'C', scale: 'major' }));
assert.notEqual(mfTuneRunKey({ harmony: 'third', key: 'A', scale: 'minor' }), mfTuneRunKey({ harmony: 'fifth', key: 'A', scale: 'minor' }));
assert.match(mfTuneRunKey({ semitones: -2 }), /^\|vocal:shift=-2,tone=1\.00$/);

// The page code swaps both the stem and the mix before the mix stage, and always puts both back.
const pageCode = readFileSync(new URL('../js/app-vocal-tune.js', import.meta.url), 'utf8');
const stageCall = pageCode.indexOf('base = await previousRebuild();\n      } finally');
assert.ok(stageCall > 0);
assert.ok(pageCode.indexOf('stems.vocals = bufferFrom(result.lead') < stageCall && pageCode.indexOf('state.original = tunedOriginal;') < stageCall, 'both swaps are in place before the mix stage runs');
assert.match(pageCode, /finally \{\s*stems\.vocals = raw;\s*if \(state\.original === tunedOriginal\) state\.original = original;/, 'stem and mix are restored even if the rebuild throws');
// The run receipt carries the tuning.
const flow = readFileSync(new URL('../js/app-stem-rebuild.js', import.meta.url), 'utf8');
assert.match(flow, /vocalTuning: typeof globalThis\.mixForgeVocalTuneApplied/);

// Wiring: the tuning layer wraps the rebuild outside the vocal cleanup layer, and the engine loads first.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
assert.ok(html.indexOf('app-vocal-tune.js') > html.indexOf('app-vocal-cleanup-guard.js'));
assert.ok(html.indexOf('app-vocal-tune.js') > html.indexOf('app-pitch-engine.js'));
assert.ok(html.indexOf('app-steps.js') > html.indexOf('app-vocal-tune.js'));
assert.match(html, /id="vocalPanel"/);
console.log('vocal tune smoke ok');
