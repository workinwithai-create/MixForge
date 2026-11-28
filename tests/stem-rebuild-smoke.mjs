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
assert.match(page, /params\.get\('rebuild'\) !== 'stems'/);
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
const libraryPage = readFileSync(new URL('../js/app-library-page.js', import.meta.url), 'utf8');
assert.match(libraryPage, /&rebuild=stems/, 'library songs with stems link to the rebuild');
assert.match(libraryPage, /stemCount >= 2/);
console.log('stem rebuild wiring smoke ok');
