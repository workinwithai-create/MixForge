import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The mix moves MixForge makes on its own (which group a stem belongs to, level corrections, level rides),
// proved on real numbers.
const source = readFileSync(new URL('../js/app-auto-mix-core.js', import.meta.url), 'utf8');
new Function(source)();
const mix = globalThis.MixForgeAutoMix;
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);

// ---- 1. Stem files from a DAW land in the right mix group by name.
const roles = {
  vocals: ['Lead Vox.wav', 'LD VOX 01.wav', 'LeadVocal_comp.wav', 'BGV Stack.wav', 'bv L.wav', 'Harmonies.aif', 'Adlibs.wav', 'Choir.wav', 'vocals.wav', 'Rap verse 2.wav', 'Lead.wav'],
  drums: ['Kick In.wav', '01_Kick.wav', 'Snare Top.wav', 'Hi-Hat.wav', 'HH.wav', 'OH L.wav', 'Overheads.wav', 'Room.wav', 'Toms.wav', 'Bass Drum.wav', 'Drum Loop.wav', 'Perc.wav', 'Claps.wav', 'drums.wav', 'Ride.wav'],
  bass: ['Bass DI.wav', 'BASS.wav', 'Sub Bass.wav', 'Synth Bass.wav', '808.wav', 'Bass Guitar.wav', 'bass.wav', 'Sub.wav'],
  other: ['Gtr L.wav', 'Lead Guitar.wav', 'Acoustic.wav', 'Keys.wav', 'Piano low.wav', 'Synth Lead.wav', 'Pad.wav', 'Strings.wav', 'Brass.wav', 'FX.wav', 'Guitar Loop.wav', 'other.wav', 'Track 7.wav', ''],
};
for (const [role, names] of Object.entries(roles)) {
  for (const name of names) assert.equal(mix.guessRole(name), role, `"${name}" belongs with the ${role}`);
}

// ---- 2. Levels: only a part that is clearly out of range is moved, by a bounded amount, with a reason.
{
  // A sensible mix is left alone.
  const fine = mix.planBalance({ buses: [{ role: 'vocals', lufs: -18 }, { role: 'drums', lufs: -19 }, { role: 'bass', lufs: -24 }, { role: 'other', lufs: -21 }] });
  assert.deepEqual(fine.moves, []);
  assert.match(fine.summary, /Nothing moved/);
  assert.ok(fine.lead.beforeLu > -6 && fine.lead.beforeLu < 6);

  // A buried vocal is raised until it is 4 LU under the band, not to the middle of the range.
  const buried = mix.planBalance({ buses: [{ role: 'vocals', lufs: -26 }, { role: 'drums', lufs: -19 }, { role: 'other', lufs: -21 }] });
  assert.equal(buried.moves.length, 1);
  assert.equal(buried.moves[0].role, 'vocals');
  const bandLevel = 10 * Math.log10(10 ** -1.9 + 10 ** -2.1);
  near(buried.lead.beforeLu, -26 - bandLevel, 0.06, 'vocal against the band, before');
  near(buried.moves[0].deltaDb, -4 - (-26 - bandLevel), 0.06, 'the lift');
  near(buried.lead.afterLu, -4, 0.11, 'vocal against the band, after');
  assert.match(buried.moves[0].reason, /under the band, where words get lost\. Raised/);

  // A vocal that is extremely low is raised by the cap and no more.
  const veryLow = mix.planBalance({ buses: [{ role: 'vocals', lufs: -40 }, { role: 'drums', lufs: -18 }] });
  assert.equal(veryLow.moves[0].deltaDb, 6);
  // A vocal sitting far on top is eased back to 4 LU over.
  const onTop = mix.planBalance({ buses: [{ role: 'vocals', lufs: -10 }, { role: 'drums', lufs: -19 }] });
  assert.equal(onTop.moves[0].deltaDb, -5);
  assert.match(onTop.moves[0].reason, /over the band.*Lowered 5 dB/);
  // Just inside the window: untouched (no nudging toward a target).
  assert.deepEqual(mix.planBalance({ buses: [{ role: 'vocals', lufs: -24.9 }, { role: 'drums', lufs: -19 }] }).moves, []);

  // A band part that is close to inaudible is raised toward the others; bass is given more room than the rest.
  const lost = mix.planBalance({ buses: [{ role: 'drums', lufs: -18 }, { role: 'bass', lufs: -32 }, { role: 'other', lufs: -34 }] });
  assert.deepEqual(lost.moves.map((m) => `${m.role}:${m.deltaDb}`), ['other:4']);
  const noBass = mix.planBalance({ buses: [{ role: 'drums', lufs: -18 }, { role: 'bass', lufs: -45 }] });
  assert.deepEqual(noBass.moves.map((m) => `${m.role}:${m.deltaDb}`), ['bass:6'], 'never more than 6 dB in one move');
  // The vocal is judged against the band as it is after the band moves.
  const both = mix.planBalance({ buses: [{ role: 'vocals', lufs: -30 }, { role: 'drums', lufs: -18 }, { role: 'other', lufs: -33 }] });
  assert.deepEqual(both.moves.map((m) => m.role), ['other', 'vocals']);
  // Silent or unknown groups are ignored; one part alone has nothing to balance against.
  assert.match(mix.planBalance({ buses: [{ role: 'vocals', lufs: -18 }, { role: 'drums', lufs: -90 }, { role: 'kazoo', lufs: -10 }] }).summary, /only one part/);
  assert.deepEqual(mix.planBalance({}).moves, []);
}

// ---- 3. Rides: the lead is kept near its own usual place against the band, phrase by phrase.
const RATE = 8000;
const seconds = 24;
const N = RATE * seconds;
// Band: steady. Lead: six 3-second phrases with a 1-second gap; phrase 3 is 6 dB down, phrase 5 is 7 dB up.
const rest = new Float32Array(N);
const lead = new Float32Array(N);
const phraseDb = [0, 0, -6, 0, 7, 0];
for (let i = 0; i < N; i++) {
  const t = i / RATE;
  rest[i] = 0.1 * Math.sin(2 * Math.PI * 500 * t) + 0.08 * Math.sin(2 * Math.PI * 1700 * t + 1);
  const phrase = Math.floor(t / 4);
  const inPhrase = t - phrase * 4 < 3;
  lead[i] = inPhrase ? 0.1 * Math.pow(10, phraseDb[phrase] / 20) * Math.sin(2 * Math.PI * 1000 * t) : 0;
}
{
  const plan = mix.planRides({ lead, rest, sampleRate: RATE });
  assert.equal(plan.hopSec, 0.1);
  assert.equal(plan.hopSamples, 800);
  assert.ok(plan.activeSec >= 15 && plan.activeSec <= 18.5, `six 3 s phrases, judged only where a whole window is lead (${plan.activeSec})`);
  assert.equal(plan.rides.length, 2, `two phrases need a ride (${JSON.stringify(plan.rides)})`);
  const [up, down] = plan.rides;
  // Phrase 3 (8–11 s) dips 6 dB: lifted to the edge of the 2 dB tolerance, capped at 3 dB.
  assert.ok(up.startSec >= 7.5 && up.startSec <= 8.6 && up.endSec >= 10.4 && up.endSec <= 11.6, `lift window ${up.startSec}–${up.endSec}`);
  assert.ok(up.gainDb > 2.5 && up.gainDb <= 3, `lift ${up.gainDb}`);
  // Phrase 5 (16–19 s) jumps 7 dB: eased back, capped at 2 dB.
  assert.ok(down.startSec >= 15.5 && down.startSec <= 16.6 && down.endSec >= 18.4 && down.endSec <= 19.6, `ease window ${down.startSec}–${down.endSec}`);
  assert.ok(down.gainDb < -1.5 && down.gainDb >= -2, `ease ${down.gainDb}`);
  // Everything else is left alone.
  for (const second of [1.5, 5.5, 13.5, 21.5]) near(plan.gainsDb[Math.round(second / 0.1)], 0, 0.05, `no ride at ${second}s`);
  // The plan says what was out of place and what is left: the dip was about 4 dB past the tolerance for
  // about 3 s; a 3 dB lift leaves about 1 dB. Word edges are not counted as dips.
  assert.ok(plan.before.dipSec >= 2.4 && plan.before.dipSec <= 3.2, `dip seconds ${plan.before.dipSec}`);
  near(plan.before.worstDipDb, 4, 0.4, 'worst dip before');
  near(plan.after.worstDipDb, 1, 0.5, 'worst dip after');
  assert.ok(plan.before.hotSec >= 2.4 && plan.before.hotSec <= 3.2, `hot seconds ${plan.before.hotSec}`);
  near(plan.before.worstHotDb, 4, 0.4, 'worst jump before');
  near(plan.after.worstHotDb, 2, 0.5, 'worst jump after');
  assert.ok(plan.after.strayDbSec < plan.before.strayDbSec * 0.6, `the lead strays less: ${plan.before.strayDbSec} -> ${plan.after.strayDbSec} dB·s`);
  assert.ok(Math.max(...plan.gainsDb) <= 3 && Math.min(...plan.gainsDb) >= -2, 'the caps hold');

  // Applied to the lead, the dipped phrase really is about 3 dB louder, other phrases are untouched, and gain ramps.
  const ridden = mix.applyRide(lead, plan.gainsDb, plan.hopSamples);
  const rmsDb = (x, from, to) => { let s = 0; for (let i = from * RATE; i < to * RATE; i++) s += x[i] * x[i]; return 10 * Math.log10(s / ((to - from) * RATE)); };
  near(rmsDb(ridden, 8.8, 10.2) - rmsDb(lead, 8.8, 10.2), up.gainDb, 0.25, 'the lift is audible in the audio');
  near(rmsDb(ridden, 16.8, 18.2) - rmsDb(lead, 16.8, 18.2), down.gainDb, 0.25, 'the ease is audible in the audio');
  near(rmsDb(ridden, 0.5, 2.5) - rmsDb(lead, 0.5, 2.5), 0, 0.02, 'an untouched phrase is identical');
  assert.equal(ridden.length, lead.length);
  assert.notEqual(ridden, lead, 'the original lead is not modified');
  near(rmsDb(lead, 8.8, 10.2), 10 * Math.log10(0.005) - 6, 0.05, 'input untouched');
  let biggestStep = 0;
  for (let h = 1; h < plan.gainsDb.length; h++) biggestStep = Math.max(biggestStep, Math.abs(plan.gainsDb[h] - plan.gainsDb[h - 1]));
  assert.ok(biggestStep <= 1.3, `the fader ramps, it does not jump (${biggestStep.toFixed(2)} dB between 0.1 s steps)`);

  // Half strength halves the move; a source that is not trusted is not ridden at all.
  const half = mix.planRides({ lead, rest, sampleRate: RATE, strength: 0.5 });
  assert.ok(Math.max(...half.gainsDb) <= 1.5 + 1e-6 && Math.min(...half.gainsDb) >= -1 - 1e-6);
  near(rmsDb(mix.applyRide(lead, plan.gainsDb, plan.hopSamples, 0.5), 8.8, 10.2) - rmsDb(lead, 8.8, 10.2), up.gainDb / 2, 0.2, 'applied at half strength');
  const untrusted = mix.planRides({ lead, rest, sampleRate: RATE, strength: 0 });
  assert.equal(untrusted.rides.length, 0);
  assert.match(untrusted.reason, /not trusted/);
}
// A steady lead needs no rides, and says so.
{
  const steady = new Float32Array(N);
  for (let i = 0; i < N; i++) { const t = i / RATE; steady[i] = (t % 4 < 3) ? 0.1 * Math.sin(2 * Math.PI * 1000 * t) : 0; }
  const plan = mix.planRides({ lead: steady, rest, sampleRate: RATE });
  assert.deepEqual(plan.rides, []);
  assert.match(plan.reason, /already holds its place/);
  assert.ok(Math.max(...plan.gainsDb.map(Math.abs)) < 0.05);
  assert.deepEqual(plan.before, { dipSec: 0, worstDipDb: 0, hotSec: 0, worstHotDb: 0, strayDbSec: 0 }, 'word edges are not counted as the lead being out of place');
}
// Too little lead to know where it usually sits: no rides.
{
  const brief = new Float32Array(N);
  for (let i = 0; i < RATE * 2; i++) brief[i] = 0.1 * Math.sin(2 * Math.PI * 1000 * i / RATE);
  const plan = mix.planRides({ lead: brief, rest, sampleRate: RATE });
  assert.deepEqual(plan.rides, []);
  assert.match(plan.reason, /not enough lead/);
  assert.equal(mix.planRides({}).rides.length, 0);
}
// Kick and bass under a lead do not count as covering it: a low thump in one phrase causes no ride.
{
  const thump = Float32Array.from(rest);
  for (let i = RATE * 8; i < RATE * 11; i++) thump[i] += 0.6 * Math.sin(2 * Math.PI * 55 * i / RATE);
  const steady = new Float32Array(N);
  for (let i = 0; i < N; i++) { const t = i / RATE; steady[i] = (t % 4 < 3) ? 0.1 * Math.sin(2 * Math.PI * 1000 * t) : 0; }
  assert.deepEqual(mix.planRides({ lead: steady, rest: thump, sampleRate: RATE }).rides, []);
}

// It is pure: no network and no page access.
assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|WebSocket|document\.|window\./);
console.log('auto mix core smoke ok');
