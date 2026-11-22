// Pitch engine: MixDoctor's own checks, repeated here against the copy MixForge ships.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const sandbox = { module: { exports: {} }, console };
vm.runInNewContext(readFileSync(new URL('../js/app-pitch-engine.js', import.meta.url), 'utf8'), sandbox);
const E = sandbox.module.exports.MFPitch;

function tone(f, sr, sec, amp = 0.3) {
  const n = Math.round(sr * sec), d = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) {
    ph += 2 * Math.PI * (typeof f === 'function' ? f(i / sr) : f) / sr;
    d[i] = amp * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.3 * Math.sin(3 * ph) + 0.2 * Math.sin(4 * ph));
  }
  return d;
}
function noise(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; }; }
const ratioFrom = (curve) => { const last = curve.semis.length - 1; return (p) => Math.pow(2, curve.semis[Math.min(last, Math.max(0, Math.floor(p / curve.hop)))] / 12); };

const sr = 44100, src = tone(220, sr, 3);
for (const f of [82.4, 146.8, 220, 330, 523.3]) {
  const got = E.f0At(tone(f, sr, 3), sr * 1.5, sr);
  assert.ok(Math.abs(got - f) < f * 0.003, `pitch detector hears ${f} Hz (got ${got.toFixed(2)})`);
}
const r = noise(2), hiss = Float32Array.from({ length: sr * 3 }, () => r());
assert.equal(E.f0At(hiss, sr * 1.5, sr), 0, 'no note in plain noise');

const same = (await E.wsolaShift([src], sr, () => 1, 1))[0];
let worst = 0; for (let i = 4096; i < src.length - 4096; i++) worst = Math.max(worst, Math.abs(same[i] - src[i]));
assert.ok(worst < 1e-5, `a shift of zero leaves the audio alone (largest difference ${worst.toExponential(1)})`);

for (const [semi, want] of [[12, 440], [7, 329.63], [-5, 164.81], [-12, 110]]) {
  const got = E.f0At((await E.wsolaShift([src], sr, () => Math.pow(2, semi / 12), 0))[0], sr * 1.5, sr);
  assert.ok(Math.abs(got - want) < want * 0.005, `shift ${semi} semitones turns 220 Hz into ${want} Hz (got ${got.toFixed(1)})`);
}
const kept = E.f0At((await E.wsolaShift([src], sr, () => Math.pow(2, 4 / 12), 1))[0], sr * 1.5, sr);
assert.ok(Math.abs(kept - 277.18) < 1.5, `"keep natural tone" still lands on the note (got ${kept.toFixed(1)})`);

// A note 62 cents sharp of A, in A minor, comes back as A.
const sharp = tone(228, sr, 3);
const tuned = E.f0At((await E.wsolaShift([sharp], sr, ratioFrom(E.tuneCurve(sharp, sr, 'A', 'minor', 1)), 1))[0], sr * 1.5, sr);
assert.ok(Math.abs(tuned - 220) < 0.7, `snap to key pulls a sharp A back to 220 Hz (got ${tuned.toFixed(2)})`);

// A slow slide from G to B in C major comes out on the steps G, A, B.
const slide = tone((t) => 196 * Math.pow(247 / 196, t / 3), sr, 3);
const stepped = (await E.wsolaShift([slide], sr, ratioFrom(E.tuneCurve(slide, sr, 'C', 'major', 1)), 1))[0];
const notes = [0.4, 1.5, 2.6].map((s) => E.f0At(stepped, sr * s, sr));
assert.ok(Math.abs(notes[0] - 196) < 1.5 && Math.abs(notes[1] - 220) < 1.5 && Math.abs(notes[2] - 246.94) < 1.5, `slide becomes scale steps (${notes.map((v) => v.toFixed(1)).join(', ')})`);

// Stereo balance survives a shift.
const st = await E.wsolaShift([src, src.map((v) => v * 0.5)], sr, () => Math.pow(2, 3 / 12), 1);
let eL = 0, eR = 0; for (let i = sr; i < 2 * sr; i++) { eL += st[0][i] ** 2; eR += st[1][i] ** 2; }
assert.ok(Math.abs(10 * Math.log10(eL / eR) - 6.02) < 0.2, 'left/right balance kept');

// Key detection on a plain A minor chord run.
const chord = (fs) => { const d = new Float32Array(sr * 2); for (const f of fs) { const t = tone(f, sr, 2, 0.15); for (let i = 0; i < d.length; i++) d[i] += t[i]; } return d; };
const song = Float32Array.from([...chord([220, 261.63, 329.63]), ...chord([146.83, 174.61, 220]), ...chord([164.81, 196, 246.94]), ...chord([220, 261.63, 329.63])]);
const key = E.detectKeyJS({ sampleRate: sr, numberOfChannels: 1, length: song.length, getChannelData: () => song });
assert.equal(`${key.key} ${key.scale}`, 'A minor', `key of an A minor progression (got ${key.key} ${key.scale})`);
console.log('pitch engine smoke ok');
