import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The shared library client is a browser IIFE; run it in this context and test its pure helpers.
globalThis.fetch = async () => { throw new Error('no network in smoke tests'); };
new Function(readFileSync(new URL('../js/app-song-library.js', import.meta.url), 'utf8'))();
const lib = globalThis.MixForgeSongLibrary;

assert.equal(lib.titleFromFileName('All_My_Life_51826-separation.wav'), 'All My Life 51826');
assert.equal(lib.titleFromFileName('Stay_For_a_Little_While.wav'), 'Stay For a Little While');
assert.equal(lib.titleFromFileName(''), 'Untitled song');
assert.equal(lib.wavMime('video/mp4', 'take.wav'), 'audio/wav');
assert.equal(lib.wavMime('', 'demo.mp3'), 'audio/mpeg');
assert.equal(lib.wavMime('audio/x-wav'), 'audio/wav');
assert.equal(lib.formatBytes(46906924), '45 MB');
assert.equal(lib.formatBytes(0), '');

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
assert.match(html, /href="\/library\.html"/);
const order = ['app-musician-ux.js', 'app-song-library.js', 'app-library-save.js'].map((f) => html.indexOf(f));
assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], 'library scripts load after the separation wrappers');
const page = readFileSync(new URL('../library.html', import.meta.url), 'utf8');
assert.match(page, /app-song-library\.js/);
assert.match(page, /app-library-page\.js/);
assert.doesNotMatch(readFileSync(new URL('../js/app-library-page.js', import.meta.url), 'utf8'), /innerHTML/, 'library page builds rows without innerHTML');
console.log('song library smoke ok');

// Fast server copy: only MixForge stem links turn into a storage path.
assert.equal(lib.mixforgeStoragePath('https://xbzypzgnwgrmmvtrmdzl.supabase.co/storage/v1/object/sign/audio/separated/68ad3a8e-06cc-4aaf-b258-b88f12aec2bb/vocals.wav?token=x'), 'separated/68ad3a8e-06cc-4aaf-b258-b88f12aec2bb/vocals.wav');
assert.equal(lib.mixforgeStoragePath('https://evil.example.com/storage/v1/object/sign/audio/separated/68ad3a8e-06cc-4aaf-b258-b88f12aec2bb/vocals.wav'), null);
assert.equal(lib.mixforgeStoragePath('https://xbzypzgnwgrmmvtrmdzl.supabase.co/storage/v1/object/sign/audio/uploads/x.wav'), null);
assert.equal(typeof lib.copyFromMixForge, 'function');
console.log('song library copy smoke ok');

// Older stem sets: a retry reuses only the empty song made for the same set, never one from another set that day.
const libraryPage = readFileSync(new URL('../js/app-library-page.js', import.meta.url), 'utf8');
assert.match(libraryPage, /MixForge stems · \$\{when\} · \$\{set\.id\.slice\(0, 8\)\}/, 'new older-set songs carry the set id');
assert.match(libraryPage, /setsThatDay === 1 \?/, 'a date-only leftover is reused only when that date has one set');
assert.match(libraryPage, /reservedSongs\.has\(s\.id\)/, 'a song being filled is never picked by a second Add');
console.log('song library reuse smoke ok');

// Song handoff: "?song=<id>&asset=<id>" opens a library song, and stems saved after it join that song.
const handoff = readFileSync(new URL('../js/app-song-handoff.js', import.meta.url), 'utf8');
assert.match(handoff, /library\.getSong\(/, 'handoff opens the song by id');
assert.match(handoff, /state\.librarySong = /, 'handoff remembers the song for later saves');
assert.match(handoff, /loadFile\(file\)/, 'handoff loads the chosen file into MixForge');
assert.ok(html.indexOf('app-song-handoff.js') > html.indexOf('app-library-save.js'), 'handoff loads after the save wrapper');
const saver = readFileSync(new URL('../js/app-library-save.js', import.meta.url), 'utf8');
assert.match(saver, /songId: handed/, 'stems saved after a handoff go to the handed-over song');
assert.match(saver, /!run\.handedOver/, 'a handed-over song is not given a second copy of its own mix');
assert.match(libraryPage, /Open in MixForge/, 'library rows open the file in MixForge on the same song');
assert.match(libraryPage, /cursor: nextCursor/, 'library pages through songs');
console.log('song handoff smoke ok');

// Retry-safe saves: one requestId per file, reused on every attempt; the same source is imported once.
{
  const calls = [];
  let putTries = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/api/product-token')) return new Response(JSON.stringify({ accessToken: 't', expiresAt: Math.floor(Date.now() / 1000) + 3600 }), { status: 200 });
    if (u.includes('/api/studio/library')) {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.action === 'upload') return new Response(JSON.stringify({ path: 'u/s/stem/vocals-x.wav', uploadUrl: 'https://upload.test/x' }), { status: 200 });
      if (body.action === 'confirm') return new Response(JSON.stringify({ asset: { id: 'a1' } }), { status: 201 });
    }
    if (u === 'https://upload.test/x') {
      putTries += 1;
      if (putTries === 1) return new Response('busy', { status: 503 });
      return new Response('{}', { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realTimeout(fn, 0);
  const asset = await lib.saveFile('0b7c2a4e-1f3d-4c55-9a8e-2d6f7a1b3c4d', { kind: 'stem', stem: 'vocals', blob: new Blob(['x'], { type: 'audio/wav' }), label: 'vocals', source: 'mixforge:separated/68ad3a8e-06cc-4aaf-b258-b88f12aec2bb/vocals.wav' });
  globalThis.setTimeout = realTimeout;
  assert.equal(asset.id, 'a1');
  const uploads = calls.filter((c) => c.action === 'upload');
  assert.equal(uploads.length, 2, 'a failed upload asks again');
  assert.equal(uploads[0].requestId, uploads[1].requestId, 'the retry reuses the same requestId, so it lands on the same path');
  assert.equal(calls.filter((c) => c.action === 'confirm').length, 1, 'only one confirm, so one asset record');
  assert.equal(uploads[0].source, 'mixforge:separated/68ad3a8e-06cc-4aaf-b258-b88f12aec2bb/vocals.wav');

  // Already on the song: the Hub answers 409 duplicate and nothing is uploaded again.
  calls.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/api/studio/library')) {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ duplicate: true, asset: { id: 'existing' } }), { status: 409 });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  const again = await lib.copyFromMixForge('0b7c2a4e-1f3d-4c55-9a8e-2d6f7a1b3c4d', { path: 'separated/68ad3a8e-06cc-4aaf-b258-b88f12aec2bb/vocals.wav', stem: 'vocals', label: 'vocals' });
  assert.equal(again.id, 'existing');
  assert.equal(calls.length, 1, 'a duplicate import stops before any copy or confirm');
  console.log('song library retry smoke ok');
}
