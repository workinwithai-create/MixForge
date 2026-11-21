import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Runs the real rebuild page module against a tiny fake page and fake Web Audio, end to end:
// open a song's stems, set a level, mix it in MixForge, reuse the stems for Forensic Fix, save to the song.

// ---- Fake DOM: just what the module touches.
const listeners = new WeakMap();
function fakeElement(tag) {
  const node = {
    tagName: tag.toUpperCase(), children: [], attrs: {}, textContent: '', className: '', value: '', checked: false, disabled: false,
    classList: {
      remove(name) { node.className = node.className.split(' ').filter((c) => c && c !== name).join(' '); },
      add(name) { node.className = `${node.className} ${name}`.trim(); },
    },
    setAttribute(k, v) { node.attrs[k] = String(v); if (k === 'value') node.value = String(v); },
    append(...kids) { node.children.push(...kids); },
    replaceChildren(...kids) { node.children = kids; },
    insertBefore(kid) { node.children.unshift(kid); },
    addEventListener(type, fn) { const map = listeners.get(node) || {}; (map[type] ||= []).push(fn); listeners.set(node, map); },
    scrollIntoView() {},
    parentNode: null,
  };
  return node;
}
const all = [];
const loadPanel = fakeElement('section');
const main = fakeElement('main');
loadPanel.parentNode = main;
globalThis.document = {
  createElement(tag) { const n = fakeElement(tag); all.push(n); return n; },
  createTextNode(text) { return { textContent: text }; },
  querySelector() { return main; },
  body: main,
};
const fire = async (node, type) => { for (const fn of (listeners.get(node) || {})[type] || []) await fn(); };
const byAttr = (k, v) => all.find((n) => n.attrs[k] === v);
const byId = (id) => all.find((n) => n.attrs.id === id);
const settle = () => new Promise((r) => setTimeout(r, 0));

// ---- Fake Web Audio.
class FakeBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels; this.length = length; this.sampleRate = sampleRate;
    this.data = Array.from({ length: channels }, () => new Float32Array(length));
  }
  get duration() { return this.length / this.sampleRate; }
  getChannelData(c) { return this.data[c]; }
  copyToChannel(src, c) { this.data[c].set(src); }
}
const stemBuffer = (value, length = 8) => { const b = new FakeBuffer(2, length, 44100); b.data.forEach((ch) => ch.fill(value)); return b; };

// ---- Globals MixForge's other scripts normally provide.
const song = {
  id: '0b2368f2-1111-4222-8333-444455556666', title: 'Coal',
  assets: [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', kind: 'stem', stem: 'vocals', playable: true, createdAt: '2026-11-21T00:00:00Z' },
    { id: 'aaaaaaaa-0000-4000-8000-000000000002', kind: 'stem', stem: 'bass', playable: true, createdAt: '2026-11-21T00:00:00Z' },
    { id: 'aaaaaaaa-0000-4000-8000-000000000003', kind: 'stem', stem: 'other', playable: true, createdAt: '2026-11-21T00:00:00Z' },
  ],
};
const stemValues = { 'aaaaaaaa-0000-4000-8000-000000000001': 0.2, 'aaaaaaaa-0000-4000-8000-000000000002': 0.1, 'aaaaaaaa-0000-4000-8000-000000000003': 0.05 };
const saved = [];
let createdSongs = 0;
globalThis.MixForgeSongLibrary = {
  async getSong(id) { assert.equal(id, song.id); return song; },
  async call(action, body) {
    if (action === 'play') return { playUrl: `https://store.example/${body.assetId}` };
    if (action === 'create-song') createdSongs++;
    throw new Error(`unexpected ${action}`);
  },
  async saveFile(songId, opts) { saved.push({ songId, ...opts }); return { id: 'new-asset' }; },
  formatBytes: (n) => `${n} B`,
};
globalThis.fetch = async (url) => {
  const id = String(url).split('/').pop();
  return { ok: true, status: 200, headers: { get: () => null }, body: null, arrayBuffer: async () => new TextEncoder().encode(id).buffer };
};
const decodeQueue = [];
globalThis.decodeAudioDataSafe = async (_ctx, bytes) => {
  const id = new TextDecoder().decode(bytes);
  decodeQueue.push(id);
  return stemBuffer(stemValues[id]);
};
globalThis.state = { audioCtx: { createBuffer: (c, l, r) => new FakeBuffer(c, l, r) }, file: null, stemBuffers: {} };
globalThis.ensureAudioContext = async () => globalThis.state.audioCtx;
globalThis.OfflineCtx = null;
globalThis.$ = (id) => (id === 'loadPanel' ? loadPanel : null);
globalThis.dbToGain = (db) => Math.pow(10, db / 20);
globalThis.normalizeStemName = (s) => ({ guitars: 'other', keys: 'other' }[s] || s);
let encoded = null;
globalThis.encodeWav = async (buffer, bits) => { encoded = { buffer, bits }; return new Blob([new Uint8Array(44 + buffer.length * buffer.numberOfChannels * (bits / 8))]); };
globalThis.loadFile = async (file) => { globalThis.state.file = file; globalThis.state.stemBuffers = {}; };
let realSeparations = 0;
globalThis.separateRequiredStems = async () => { realSeparations++; return { drums: 'https://separated.example/drums.wav' }; };
let planBuilds = 0;
globalThis.buildStemPlans = async () => { planBuilds++; };
globalThis.location = { search: `?song=${song.id}&rebuild=stems` };
const objectUrls = [];
URL.createObjectURL = (blob) => { objectUrls.push(blob); return `blob:fake/${objectUrls.length}`; };
URL.revokeObjectURL = () => {};
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => (ms > 60_000 ? 0 : realSetTimeout(fn, ms));

new Function(readFileSync(new URL('../js/app-stem-rebuild-core.js', import.meta.url), 'utf8'))();
new Function(readFileSync(new URL('../js/app-stem-rebuild.js', import.meta.url), 'utf8'))();

// 1. It opens the song and loads its three stems.
for (let i = 0; i < 20 && !/ready/.test(byId('rebuildStatusLine')?.textContent || ''); i++) await settle();
assert.match(byId('rebuildStatusLine').textContent, /^3 stems ready/);
assert.deepEqual(decodeQueue.length, 3);
assert.match(byId('rebuildMissing').textContent, /No drums stem/);

// 2. Vocals down 6 dB, then "Mix it in MixForge".
const vocalSlider = byAttr('aria-label', 'vocals level');
vocalSlider.value = '-6';
await fire(vocalSlider, 'input');
await fire(byId('rebuildUseBtn'), 'click');
assert.ok(state.file && /Coal - rebuilt from stems\.wav/.test(state.file.name), 'the rebuilt mix is the loaded mix');
assert.equal(encoded.bits, 24);
const expected = 0.2 * dbToGain(-6) + 0.1 + 0.05;
assert.ok(Math.abs(encoded.buffer.getChannelData(0)[0] - expected) < 1e-6, 'the rebuilt mix follows the levels');
assert.equal(state.librarySong.id, song.id, 'later saves go to the same song');
assert.equal(state.libraryRebuild.gains.vocals, -6);
assert.match(byId('rebuildStatusLine').textContent, /rebuilt mix is loaded/);

// 3. Forensic Fix on the rebuilt mix uses the saved stems, not a new separation.
const outputs = await separateRequiredStems(['vocals', 'bass'], () => {});
assert.equal(realSeparations, 0);
assert.ok(outputs.vocals.startsWith('blob:') && outputs.bass.startsWith('blob:'));
assert.equal(state._stemDecodesRemaining, 2, 'the decode hook lines the stems up with the rebuilt mix');
// ...and each stem is set to its level in the rebuilt mix before MixForge measures it.
state.stemBuffers = { vocals: stemBuffer(1), bass: stemBuffer(1) };
await buildStemPlans();
assert.equal(planBuilds, 1);
assert.ok(Math.abs(state.stemBuffers.vocals.getChannelData(1)[3] - dbToGain(-6)) < 1e-6);
assert.equal(state.stemBuffers.bass.getChannelData(0)[0], 1, 'a stem left at 0 dB is untouched');
await buildStemPlans();
assert.ok(Math.abs(state.stemBuffers.vocals.getChannelData(0)[0] - dbToGain(-6)) < 1e-6, 'levels are applied once, not on every rebuild');

// 4. A stem the song does not have still goes to a real separation.
await separateRequiredStems(['drums'], () => {});
assert.equal(realSeparations, 1);
// So does any other loaded file.
state.file = new File([], 'something-else.wav');
await separateRequiredStems(['vocals'], () => {});
assert.equal(realSeparations, 2);

// 5. "Save rebuilt mix to this song": a 16-bit WAV on the same song as its mix, keyed so a repeat saves once.
await fire(byId('rebuildSaveBtn'), 'click');
assert.equal(saved.length, 1);
assert.equal(saved[0].songId, song.id);
assert.equal(saved[0].kind, 'mix');
assert.equal(saved[0].label, 'Rebuilt from stems');
assert.match(saved[0].source, /^mixforge:rebuild\/[0-9a-f]{16}$/);
assert.equal(encoded.bits, 16);
assert.equal(createdSongs, 0, 'no second song is made');
assert.match(byId('rebuildSaveStatus').textContent, /^Saved to “Coal”/);
console.log('stem rebuild runtime smoke ok');
