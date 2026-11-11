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
