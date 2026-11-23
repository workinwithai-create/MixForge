// Master controls: reading MixForge's picks out of a plan, and applying the musician's overrides on top.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/app-master-controls.js', import.meta.url), 'utf8');
const sandbox = { module: { exports: {} } };
vm.runInNewContext(source, sandbox); // no page and no app here, so only the pure parts run
const { mfCtlRead, mfCtlApply, mfSongIdentity, mfCtlRunKey } = sandbox.module.exports;

const plan = () => ({
  eq: [
    { type: 'eq', filterType: 'lowshelf', frequency: 55, gain: -1.2, q: 0.7, label: 'Conservative sub trim' },
    { type: 'eq', filterType: 'highshelf', frequency: 9500, gain: 0.8, q: 0.7, label: 'Conservative air shelf' },
  ],
  compressor: { type: 'compressor', threshold: -18, ratio: 1.45, attack: 0.035, release: 0.2, knee: 8, label: 'Low-ratio program glue' },
  multiband: { pending: true },
  gainDb: 3, targetLufs: -12, ceilingDb: -1.2, truePeakCeilingDb: -1.0, referenceUsed: false,
});

// Picks: sliders start where the plan put them, zero where the plan left a band alone.
const picks = mfCtlRead(plan());
assert.equal(picks.sub, -1.2);
assert.equal(picks.mud, 0);
assert.equal(picks.presence, 0);
assert.equal(picks.air, 0.8);
assert.equal(picks.ceiling, -1.0);
assert.equal(picks.loudness, -12);
assert.equal(picks.reasons.sub, 'Conservative sub trim');
assert.equal(picks.reasons.mud, 'left alone');

// No overrides: the plan is MixForge's, untouched.
const same = mfCtlApply(plan(), {});
assert.equal(JSON.stringify(same.eq), JSON.stringify(plan().eq));
assert.equal(same.compressor.ratio, 1.45);
assert.equal(same.multiband.pending, true);
assert.equal(same.ceilingDb, -1.2);
assert.equal(same.userMoved.length, 0);

// Applying never changes the plan it was given.
const original = plan();
const frozen = JSON.stringify(original);
mfCtlApply(original, { air: 3, sub: 0, ceiling: -1.5, dynamics: false });
assert.equal(JSON.stringify(original), frozen);

// A moved band replaces MixForge's move in that band and leaves the others.
const moved = mfCtlApply(plan(), { air: 3, mud: -2 });
const byLabel = Object.fromEntries(moved.eq.map((op) => [op.label, op]));
assert.equal(byLabel['Your air shelf'].gain, 3);
assert.equal(byLabel['Your low-mid cut'].gain, -2);
assert.equal(byLabel['Your low-mid cut'].frequency, 350);
assert.equal(byLabel['Conservative sub trim'].gain, -1.2, 'untouched band keeps MixForge\'s move');
assert.equal(moved.eq.filter((op) => op.filterType === 'highshelf').length, 1, 'no stacked shelves');

// Slider at zero removes the move in that band.
const flat = mfCtlApply(plan(), { sub: 0 });
assert.equal(flat.eq.some((op) => op.filterType === 'lowshelf'), false);

// Out-of-range values are held to the slider's range.
assert.equal(mfCtlApply(plan(), { air: 99 }).eq.find((op) => op.filterType === 'highshelf').gain, 4);
assert.equal(mfCtlApply(plan(), { sub: -99 }).eq.find((op) => op.filterType === 'lowshelf').gain, -4);
assert.equal(mfCtlApply(plan(), { sub: 2 }).eq.some((op) => op.filterType === 'lowshelf'), false, 'sub can only be cut');

// Ceiling moves the final ceiling and keeps the limiter under it.
const ceiling = mfCtlApply(plan(), { ceiling: -1.5 });
assert.equal(ceiling.truePeakCeilingDb, -1.5);
assert.ok(Math.abs(ceiling.ceilingDb - -1.7) < 1e-9);
assert.equal(mfCtlApply(plan(), { ceiling: 0 }).truePeakCeilingDb, -0.5, 'ceiling cannot go above -0.5 dBTP');

// Dynamics off removes both the glue compressor and the multiband stage, pending or not.
const dry = mfCtlApply(plan(), { dynamics: false });
assert.equal(dry.compressor, null);
assert.equal(dry.multiband, null);
assert.equal(dry.dynamicsOff, true);

// Song identity. A loaded file is the song. Stems in the stem mixer are re-summed into a new file on
// every Mix and master run, so the identity there must not change from run to run.
const bufferA = { id: 'a' }, bufferB = { id: 'b' };
assert.equal(mfSongIdentity({ original: bufferA }), bufferA);
assert.notEqual(mfSongIdentity({ original: bufferA }), mfSongIdentity({ original: bufferB }));
const fileOne = { name: 'Demo - mixed from stems.wav' }, fileTwo = { name: 'Demo - mixed from stems.wav' };
const runOne = { original: bufferA, file: fileOne, libraryRebuild: { file: fileOne, songId: null } };
const runTwo = { original: bufferB, file: fileTwo, libraryRebuild: { file: fileTwo, songId: null } };
assert.equal(mfSongIdentity(runOne), mfSongIdentity(runTwo), 'a second run on the same stems is the same song');
assert.notEqual(mfSongIdentity({ ...runTwo, libraryRebuild: { file: fileTwo, songId: 'song_9' } }), mfSongIdentity(runTwo), 'a library song is not "local"');
// A different file loaded afterwards is no longer the stem run, even though the run record is still there.
assert.equal(mfSongIdentity({ original: bufferB, file: { name: 'other.wav' }, libraryRebuild: runOne.libraryRebuild }), bufferB);
assert.equal(mfSongIdentity(undefined), null);

// The saved-master key: empty when nothing moved, the same for the same settings, different otherwise.
assert.equal(mfCtlRunKey({}), '');
assert.equal(mfCtlRunKey({ air: 2, dynamics: false }), mfCtlRunKey({ dynamics: false, air: 2 }), 'order does not matter');
assert.notEqual(mfCtlRunKey({ air: 2 }), mfCtlRunKey({ air: 2.5 }));
assert.match(mfCtlRunKey({ ceiling: -1.5, dynamics: false }), /^\|controls:ceiling=-1\.50,dynamics=off$/);
// The stem flow asks for those parts when it files a master, and reads the loudness from the plan.
const stemFlow = readFileSync(new URL('../js/app-stem-rebuild.js', import.meta.url), 'utf8');
assert.match(stemFlow, /mixForgeRunKeyParts/);
assert.match(stemFlow, /state\.masterPlan\?\.targetLufs/);

// The run receipt names the controls the musician moved.
const rebuildCore = {};
vm.runInNewContext(readFileSync(new URL('../js/app-stem-rebuild-core.js', import.meta.url), 'utf8'), { globalThis: rebuildCore, module: { exports: {} }, console });
const coreApi = Object.values(rebuildCore).find((value) => value && typeof value.buildRunReceipt === 'function');
if (coreApi) {
  const movedPlan = mfCtlApply(plan(), { air: 3, ceiling: -1.5 });
  const receipt = coreApi.buildRunReceipt({ song: { id: 's', title: 't' }, parts: [], masterPlan: movedPlan, targetLufs: -12 });
  assert.equal(receipt.master.setByMusician.join(','), 'air,ceiling');
  assert.equal(receipt.master.peakCeilingDb, -1.5);
  assert.equal(coreApi.buildRunReceipt({ song: {}, parts: [], masterPlan: plan() }).master.setByMusician.length, 0);
} else {
  assert.match(readFileSync(new URL('../js/app-stem-rebuild-core.js', import.meta.url), 'utf8'), /setByMusician/);
}

// Wiring: outermost wrapper, so it must load after the multiband layer.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
assert.ok(html.indexOf('app-master-controls.js') > html.indexOf('app-multiband.js'));
assert.ok(html.indexOf('app-master-controls.js') > html.indexOf('app-musician-ux.js'));
assert.match(html, /master-controls\.css/);
console.log('master controls smoke ok');
