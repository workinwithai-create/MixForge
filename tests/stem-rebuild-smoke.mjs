import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Rebuild a song from its library stems: pure helpers first, then the page wiring.
new Function(readFileSync(new URL('../js/app-stem-rebuild-core.js', import.meta.url), 'utf8'))();
const core = globalThis.MixForgeStemRebuildCore;

// Newest playable file per stem name, in mixer order; non-stems and unplayable files are left out.
const picked = core.pickStems([
  { id: 'a', kind: 'stem', stem: 'other', playable: true, createdAt: '2026-11-21T00:00:01Z' },
  { id: 'b', kind: 'stem', stem: 'vocals', playable: true, createdAt: '2026-11-01T00:00:00Z' },
  { id: 'c', kind: 'stem', stem: 'vocals', playable: true, createdAt: '2026-11-21T00:00:00Z' },
  { id: 'd', kind: 'stem', stem: 'bass', playable: false, createdAt: '2026-11-21T00:00:00Z' },
  { id: 'e', kind: 'mix', playable: true },
  { id: 'f', kind: 'stem', label: 'Drums', playable: true, createdAt: '2026-11-20T00:00:00Z' },
]);
assert.deepEqual(picked.map((p) => `${p.name}:${p.asset.id}`), ['vocals:c', 'drums:f', 'other:a']);
assert.deepEqual(core.missingStems(['vocals', 'other', 'bass']), ['drums']);
assert.deepEqual(core.missingStems(['vocals', 'drums', 'bass', 'other']), []);

// Summing: gains in dB, shorter stems padded, a mono stem in both channels, muted stems skipped.
{
  const stereo = [new Float32Array([0.1, 0.1, 0.1, 0.1]), new Float32Array([0.2, 0.2, 0.2, 0.2])];
  const monoShort = [new Float32Array([0.1, 0.1])];
  const muted = [new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5, 0.5])];
  const out = core.sumStems([
    { channels: stereo, gainDb: 0 },
    { channels: monoShort, gainDb: 20 * Math.log10(2) },
    { channels: muted, gainDb: 0, muted: true },
  ]);
  assert.equal(out.length, 4, 'length follows the longest live stem, not the muted one');
  assert.equal(out.usedStems, 2);
  assert.equal(out.trimDb, 0);
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`);
  near(out.channels[0][0], 0.3); near(out.channels[1][0], 0.4);
  near(out.channels[0][3], 0.1); near(out.channels[1][3], 0.2);
}

// A sum that would clip is turned down evenly to −1 dBFS, never limited, and says by how much.
{
  const loud = [new Float32Array([0.8, -0.8, 0.4]), new Float32Array([0.8, -0.8, 0.4])];
  const out = core.sumStems([{ channels: loud, gainDb: 0 }, { channels: loud, gainDb: 0 }]);
  assert.ok(Math.abs(out.peak - core.SAFE_PEAK) < 1e-6);
  assert.ok(out.trimDb < -5 && out.trimDb > -6, `trim ${out.trimDb}`);
  const ratio = out.channels[0][2] / out.channels[0][0];
  assert.ok(Math.abs(ratio - 0.5) < 1e-6, 'the shape is kept (no limiting)');
}

// Everything muted makes an empty mix, which the page refuses to load or save.
assert.equal(core.sumStems([{ channels: [new Float32Array(3)], muted: true }]).length, 0);

// The save key is stable for the same files and levels in any order, changes with a level, and fits the Hub's rule.
const HUB_SOURCE_RULE = /^[a-z][a-z0-9-]{1,30}:[A-Za-z0-9._\/-]{1,260}$/;
const k1 = core.rebuildSourceKey([{ assetId: 'x', gainDb: 0 }, { assetId: 'y', gainDb: -3 }]);
const k2 = core.rebuildSourceKey([{ assetId: 'y', gainDb: -3.0 }, { assetId: 'x', gainDb: 0 }]);
const k3 = core.rebuildSourceKey([{ assetId: 'x', gainDb: 0 }, { assetId: 'y', gainDb: -2.5 }]);
const k4 = core.rebuildSourceKey([{ assetId: 'x', gainDb: 0 }, { assetId: 'y', gainDb: -3, muted: true }]);
assert.equal(k1, k2);
assert.notEqual(k1, k3);
assert.notEqual(k1, k4);
assert.match(k1, HUB_SOURCE_RULE);

// Forensic Fix reuses the saved stems only when the song has every stem the scan asks for.
assert.equal(core.coversStems(['vocals', 'bass'], ['vocals', 'bass', 'other']), true);
assert.equal(core.coversStems(['vocals', 'drums'], ['vocals', 'bass', 'other']), false);
assert.equal(core.coversStems([], ['vocals']), false);

// The stem check compares against the song's own original mix: the oldest real mix, never a rebuild of these stems.
{
  const assets = [
    { id: 's1', kind: 'stem', stem: 'vocals', playable: true, createdAt: '2026-11-01T00:00:00Z' },
    { id: 'm2', kind: 'mix', label: 'Rebuilt from stems', playable: true, createdAt: '2026-10-01T00:00:00Z' },
    { id: 'm3', kind: 'mix', label: 'Original mix', playable: true, createdAt: '2026-11-02T00:00:00Z' },
    { id: 'm1', kind: 'mix', label: 'Original mix', playable: true, createdAt: '2026-11-01T00:00:00Z' },
    { id: 'm0', kind: 'mix', label: 'Original mix', playable: false, createdAt: '2026-09-01T00:00:00Z' },
    { id: 'm4', kind: 'mix', label: 'Mix', source: 'mixforge:rebuild/0011223344556677', playable: true, createdAt: '2026-08-01T00:00:00Z' },
    { id: 'x1', kind: 'master', label: 'MixForge master', playable: true, createdAt: '2026-07-01T00:00:00Z' },
    { id: 'a1', kind: 'audio', label: 'Upload', playable: true, createdAt: '2026-06-01T00:00:00Z' },
  ];
  assert.equal(core.pickOriginalMix(assets).id, 'm1', 'the oldest playable mix that is not a rebuild');
  assert.equal(core.pickOriginalMix(assets.filter((a) => a.kind !== 'mix')).id, 'a1', 'uploaded audio stands in when there is no mix');
  assert.equal(core.pickOriginalMix(assets.filter((a) => a.id === 'm2' || a.id === 'm4' || a.kind === 'stem' || a.kind === 'master')), null, 'a rebuild or a master is never the reference');
  assert.equal(core.pickOriginalMix([]), null);
}

// One receipt for a Mix and master run: names and numbers only, and it says plainly whether the master was saved.
{
  const receipt = core.buildRunReceipt({
    song: { id: 'song-1', title: 'Coal', assets: ['not copied'] },
    parts: [{ name: 'vocals', assetId: 'a', gainDb: -6.04, muted: false }, { name: 'bass', assetId: 'b', gainDb: 0, muted: true }],
    trimDb: -1.234,
    stemCheck: { schemaVersion: 1, verdict: { className: 'good' } },
    corrections: [{ id: 'stage-1-vocals', verdict: { status: 'accepted' } }],
    targetLufs: -12,
    masterPlan: { truePeakCeilingDb: -1, ceilingDb: -0.5 },
    finalMetrics: { lufs: -12.04, peakDb: -1.31, lra: 6.2, crestDb: 9.87654, correlation: 0.81, clipPercent: 0, midBands: [1, 2, 3] },
    truePeakDb: -1.02,
    gate: { allow: true, verified: true, clipFail: false, tpFail: false, monoWarn: false },
    saved: { toSong: true, kind: 'master', source: 'mixforge:master/0011223344556677' },
    generatedAt: '2026-11-21T00:00:00.000Z',
  });
  assert.equal(receipt.schema, 'mixforge-run-receipt');
  assert.equal(receipt.schemaVersion, 1);
  assert.deepEqual(receipt.song, { id: 'song-1', title: 'Coal' });
  assert.deepEqual(receipt.stems, [{ name: 'vocals', assetId: 'a', levelDb: -6, muted: false }, { name: 'bass', assetId: 'b', levelDb: 0, muted: true }]);
  assert.equal(receipt.mixTrimDb, -1.23);
  assert.equal(receipt.stemCheck.verdict.className, 'good');
  assert.equal(receipt.corrections[0].verdict.status, 'accepted');
  assert.deepEqual(receipt.master, {
    targetLufs: -12, peakCeilingDb: -1,
    measured: { lufs: -12.04, peakDb: -1.31, oversampledPeakDb: -1.02, loudnessRange: 6.2, crestDb: 9.88, monoCorrelation: 0.81, clipPercent: 0 },
    hardChecks: { passed: true, verified: true, clipping: false, overCeiling: false, monoWarning: false },
  });
  assert.deepEqual(receipt.saved, { toSong: true, kind: 'master', source: 'mixforge:master/0011223344556677', reason: null });
  assert.deepEqual(JSON.parse(JSON.stringify(receipt)), receipt, 'a receipt is plain data');
  const blocked = core.buildRunReceipt({ song: { id: 's' }, parts: [], gate: { allow: false, clipFail: true }, saved: { toSong: false, kind: 'master', reason: 'Export blocked: clipping.' } });
  assert.equal(blocked.saved.toSong, false);
  assert.equal(blocked.saved.reason, 'Export blocked: clipping.');
  assert.equal(blocked.master.hardChecks.passed, false);
  assert.equal(blocked.master.hardChecks.clipping, true);
  assert.equal(blocked.master.measured, null, 'missing measurements stay missing, never zero');
  assert.equal(core.buildRunReceipt({}).saved.toSong, false);
}

// A set of stem files is named after what their file names share.
assert.equal(core.commonTitle(['MySong_Kick.wav', 'MySong_Bass.wav', 'MySong_Lead Vox.wav']), 'MySong');
assert.equal(core.commonTitle(['01 Coal - Drums.wav', '01 Coal - Bass.wav']), 'Coal');
assert.equal(core.commonTitle(['Ember Vox.wav', 'Ember Vocals BGV.wav']), 'Ember', 'half a shared word is not part of the name');
assert.equal(core.commonTitle(['Kick.wav', 'Bass.wav']), 'Your stems');
assert.equal(core.commonTitle(['a.wav']), 'Your stems');
assert.equal(core.commonTitle([]), 'Your stems');

// The run receipt also records the mix group of each stem, MixForge's own level fixes, and where the stems came from.
{
  const receipt = core.buildRunReceipt({
    song: { id: null, title: 'Coal' },
    sourceNote: 'your own stems, read in the browser; nothing uploaded and nothing split',
    parts: [{ name: 'Lead Vox', role: 'vocals', assetId: null, gainDb: 6, muted: false }, { name: 'Kick', role: 'drums', assetId: null, gainDb: 0, muted: false }],
    levels: { fixedByMixForge: [{ role: 'vocals', deltaDb: 6, reason: 'The vocal sat 25 LU under the band, where words get lost. Raised 6 dB.', files: ['Lead Vox'] }], vocalAgainstBandLu: { beforeLu: -25.04, afterLu: -19 } },
  });
  assert.equal(receipt.source, 'your own stems, read in the browser; nothing uploaded and nothing split');
  assert.deepEqual(receipt.song, { id: null, title: 'Coal' });
  assert.deepEqual(receipt.stems, [{ name: 'Lead Vox', group: 'vocals', assetId: null, levelDb: 6, muted: false }, { name: 'Kick', group: 'drums', assetId: null, levelDb: 0, muted: false }]);
  assert.deepEqual(receipt.levels, {
    fixedByMixForge: [{ group: 'vocals', changeDb: 6, reason: 'The vocal sat 25 LU under the band, where words get lost. Raised 6 dB.', files: ['Lead Vox'] }],
    vocalAgainstBandLu: { before: -25, after: -19 },
  });
  assert.deepEqual(core.buildRunReceipt({ song: { id: 's' }, parts: [] }).levels, { fixedByMixForge: [], vocalAgainstBandLu: null }, 'no level fixes is recorded as none');
  assert.equal(core.buildRunReceipt({ song: { id: 's' }, parts: [] }).source, 'stems saved in the song library; no new separation');
}
console.log('stem rebuild core smoke ok');

// Wiring.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const at = (f) => html.indexOf(f);
assert.ok(at('app-stem-rebuild-core.js') > at('app-song-handoff.js'), 'rebuild loads after the handoff');
assert.ok(at('app-stem-rebuild.js?') > at('app-stem-rebuild-core.js'), 'the core loads before the page module');
assert.ok(at('app-stem-rebuild.js?') > at('app-library-save.js'), 'rebuild wraps separation outside the save wrapper');
const handoff = readFileSync(new URL('../js/app-song-handoff.js', import.meta.url), 'utf8');
assert.match(handoff, /params\.get\('rebuild'\) === 'stems'\) return/, 'a rebuild link does not also load one file');
const page = readFileSync(new URL('../js/app-stem-rebuild.js', import.meta.url), 'utf8');
assert.match(page, /const fromLibrary = Boolean\(library\) && params\.get\('rebuild'\) === 'stems' && UUID\.test\(songId\)/, 'a library song opens only from its own rebuild link');
assert.match(page, /if \(!fromLibrary && !stemFilesBtn\) return;/, 'on a page with neither door the desk does nothing');
assert.match(page, /kind: 'mix'[\s\S]*label: 'Rebuilt from stems'[\s\S]*source/, 'the rebuilt mix is saved to the same song as its mix, once');
assert.match(page, /state\.librarySong = \{ id: song\.id/, 'later saves stay on the same song');
assert.match(page, /return previousSeparate\(stems, onProgress\)/, 'files other than the rebuilt mix still go to a real separation');
const mixAndMasterBody = page.slice(page.indexOf('async function mixAndMaster'), page.indexOf('playBtn.addEventListener'));
assert.ok(mixAndMasterBody.length > 200, 'Mix and master exists');
assert.doesNotMatch(mixAndMasterBody, /separateRequiredStems|callStemFunction|uploadOriginal/, 'Mix and master never splits or uploads');
assert.match(mixAndMasterBody, /renderReleaseMaster\(\)[\s\S]*kind: 'master'/, 'the release master is saved to the song');
assert.match(page, /state\.file !== run\.file/, 'saved stems are used only for the rebuilt mix itself');
assert.doesNotMatch(page, /innerHTML/, 'the rebuild panel builds its rows without innerHTML');
assert.doesNotMatch(page, /create-song/, 'rebuilding never makes a second song');
// The stem check, solo and the run receipt.
assert.ok(at('app-stem-rebuild.js?') > at('app-stem-reliability-core.js'), 'the stem check loads before the page module');
assert.match(page, /lab\.auditStems\(\{ sampleRate: parts\[0\]\.buffer\.sampleRate, stems: stemInputs\(\) \}\)/, 'stems are checked against each other as soon as they load');
assert.match(page, /core\.pickOriginalMix\(song\.assets\)/, 'the comparison uses the song\'s own original mix');
const stemInputsBody = page.slice(page.indexOf('const stemInputs'), page.indexOf('const checkSources'));
assert.doesNotMatch(stemInputsBody, /gainDb|muted|solo/, 'the check reads the stems as saved, not the slider levels');
const renderMixBody = page.slice(page.indexOf('function renderMix'), page.indexOf('function stopLeftover'));
assert.doesNotMatch(renderMixBody, /solo/, 'solo never changes the mix');
assert.doesNotMatch(mixAndMasterBody, /\.solo\b/, 'solo never changes what is mastered or saved');
assert.match(page, /const audibleGain = \(part\) => \(part\.muted \|\| \(anySolo\(\) && !part\.solo\) \? 0 : dbToGain\(part\.gainDb\)\)/);
assert.match(mixAndMasterBody, /evaluateExportGate\(state\)[\s\S]*if \(!gateResult\.allow\) \{[\s\S]*return;[\s\S]*library\.saveFile\(song\.id, \{\s*kind: 'master'/, 'a master that fails the hard checks is not saved to the song');
assert.equal(mixAndMasterBody.split('library.saveFile(').length - 1 >= 1, true);
assert.ok(mixAndMasterBody.indexOf('library.saveFile(song.id') > mixAndMasterBody.indexOf('if (!gateResult.allow)'), 'nothing is saved before the hard checks');
assert.ok(mixAndMasterBody.indexOf('library.saveFile(song.id') > mixAndMasterBody.indexOf('if (!song) {'), 'stems that are not a library song are never saved to one');
assert.match(mixAndMasterBody, /: \{ allow: false,/, 'with no release check available, nothing is saved');
assert.match(mixAndMasterBody, /core\.buildRunReceipt\(/);
assert.match(mixAndMasterBody, /mixForgeCriticGate\?\.receipts/, 'the run receipt carries the correction receipts');
// The second door: your own stems, read in the browser.
assert.match(html, /id="stemFilesBtn"/);
assert.match(html, /<input id="stemFilesInput" type="file"[^>]* multiple hidden>/, 'the stems input takes several files');
assert.ok(at('app-stem-rebuild.js?') > at('app-auto-mix-core.js'), 'level fixes and rides load before the desk');
const openLocalBody = page.slice(page.indexOf('async function openLocal'), page.indexOf("playBtn.addEventListener('click'"));
assert.ok(openLocalBody.length > 400, 'the desk opens stem files from disk');
assert.doesNotMatch(openLocalBody, /fetch\(|library\.|uploadOriginal|callStemFunction|separateRequiredStems/, 'stems from disk are never uploaded, saved or split');
assert.match(page, /event\.stopImmediatePropagation\(\);[\s\S]{0,120}void openLocal\(dropped\);/, 'several dropped files are stems and never reach the single-file loader');
assert.match(page, /if \(!dropped \|\| dropped\.length < 2\) return;/, 'one dropped file is still a mix');
assert.match(page, /if \(move && files\.some\(\(p\) => p\.touched\)\) \{ left\.push\(role\); continue; \}/, 'a group with a fader the member set is never moved by MixForge');
assert.match(page, /const ownLevel = \(part\) => part\.gainDb - \(autoDelta\.get\(part\.key\) \|\| 0\);/, 'level fixes are planned from the member\'s own levels, so they never stack');
const libraryPage = readFileSync(new URL('../js/app-library-page.js', import.meta.url), 'utf8');
assert.match(libraryPage, /&rebuild=stems/, 'library songs with stems link to the rebuild');
assert.match(libraryPage, /stemCount >= 2/);
console.log('stem rebuild wiring smoke ok');
