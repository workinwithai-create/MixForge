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
    click() { node.clicked = (node.clicked || 0) + 1; },
    remove() {},
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
const fire = async (node, type) => {
  for (const fn of (listeners.get(node) || {})[type] || []) await fn();
  // Click handlers start async work without returning it; let it finish.
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
};
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
const started = [];
const gains = [];
globalThis.state = {
  audioCtx: {
    currentTime: 0, destination: {},
    createBuffer: (c, l, r) => new FakeBuffer(c, l, r),
    createBufferSource() { const src = { buffer: null, onended: null, connect: (n) => n, start() { started.push(src); }, stop() { src.stopped = true; } }; return src; },
    createGain() { const g = { gain: { value: 1 }, connect: (n) => n }; gains.push(g); return g; },
  },
  file: null, stemBuffers: {},
};
globalThis.ensureAudioContext = async () => globalThis.state.audioCtx;
globalThis.OfflineCtx = null;
globalThis.$ = (id) => (id === 'loadPanel' ? loadPanel : null);
globalThis.dbToGain = (db) => Math.pow(10, db / 20);
globalThis.normalizeStemName = (s) => ({ guitars: 'other', keys: 'other' }[s] || s);
let encoded = null;
globalThis.encodeWav = async (buffer, bits) => { encoded = { buffer, bits }; return new Blob([new Uint8Array(44 + buffer.length * buffer.numberOfChannels * (bits / 8))]); };
globalThis.loadFile = async (file) => { globalThis.state.file = file; globalThis.state.original = encoded?.buffer || null; globalThis.state.stemBuffers = {}; };
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

const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(' '));
const hidden = (id) => /\bhidden\b/.test(byId(id).className);
const runPage = () => new Function(readFileSync(new URL('../js/app-stem-rebuild.js', import.meta.url), 'utf8'))();
new Function(readFileSync(new URL('../js/app-stem-rebuild-core.js', import.meta.url), 'utf8'))();
new Function(readFileSync(new URL('../js/app-stem-reliability-core.js', import.meta.url), 'utf8'))();
runPage();

// 1. It opens the song and loads its three stems.
for (let i = 0; i < 20 && !/ready/.test(byId('rebuildStatusLine')?.textContent || ''); i++) await settle();
assert.match(byId('rebuildStatusLine').textContent, /^3 stems ready/);
assert.deepEqual(decodeQueue.length, 3);
assert.match(byId('rebuildMissing').textContent, /No drums stem/);
// These test stems are a few samples long, far too short to check. The mixer carries on without a stem check.
assert.ok(hidden('rebuildCheck'), 'no stem check is shown when it could not run');
assert.equal(warnings.filter((w) => /stem check unavailable/.test(w)).length, 1);

// 1b. Solo is for listening only: Play together plays just the soloed stem, at its level.
const bassSolo = byAttr('aria-label', 'Solo bass');
bassSolo.checked = true;
await fire(bassSolo, 'change');
assert.ok(!hidden('rebuildSoloNote'), 'the page says solo only changes what you hear');
await fire(byId('rebuildPlayBtn'), 'click');
assert.equal(started.length, 3, 'every stem starts together so they stay in time');
assert.deepEqual(gains.slice(-3).map((g) => g.gain.value), [0, 1, 0], 'only the soloed stem is heard');
const vocalMute = byAttr('aria-label', 'Mute vocals');
vocalMute.checked = true;
await fire(vocalMute, 'change');
vocalMute.checked = false;
await fire(vocalMute, 'change');
assert.deepEqual(gains.slice(-3).map((g) => g.gain.value), [0, 1, 0], 'changing another stem keeps the solo');
await fire(byId('rebuildPlayBtn'), 'click'); // stop

// 2. Vocals down 6 dB, then "Mix it in MixForge".
const vocalSlider = byAttr('aria-label', 'vocals level');
vocalSlider.value = '-6';
await fire(vocalSlider, 'input');
await fire(byId('rebuildUseBtn'), 'click');
assert.ok(state.file && /Coal - rebuilt from stems\.wav/.test(state.file.name), 'the rebuilt mix is the loaded mix');
assert.equal(encoded.bits, 24);
const expected = 0.2 * dbToGain(-6) + 0.1 + 0.05;
assert.ok(Math.abs(encoded.buffer.getChannelData(0)[0] - expected) < 1e-6, 'the rebuilt mix follows the levels');
// Bass is still soloed here: solo did not remove the other stems from the mix.
assert.equal(bassSolo.checked, true);
assert.deepEqual(Object.keys(state.libraryRebuild.stems), ['vocals', 'bass', 'other'], 'solo never changes which stems are mixed');
bassSolo.checked = false;
await fire(bassSolo, 'change');
assert.ok(hidden('rebuildSoloNote'));
assert.equal(state.librarySong.id, song.id, 'later saves go to the same song');
assert.equal(state.libraryRebuild.gains.vocals, -6);
assert.match(byId('rebuildStatusLine').textContent, /rebuilt mix is loaded/);

// 3. Forensic Fix on the rebuilt mix uses the saved stems, not a new separation.
const requested = ['vocals', 'bass'];
const outputs = await separateRequiredStems(requested, () => {});
assert.equal(realSeparations, 0);
assert.ok(outputs.vocals.startsWith('blob:') && outputs.bass.startsWith('blob:') && outputs.other.startsWith('blob:'));
assert.deepEqual(requested, ['vocals', 'bass', 'other'], 'every saved stem goes to the stem stage');
assert.equal(state._stemDecodesRemaining, 3, 'the decode hook lines the stems up with the rebuilt mix');
// ...and each stem is set to its level in the rebuilt mix before MixForge measures it.
state.stemBuffers = { vocals: stemBuffer(1), bass: stemBuffer(1) };
await buildStemPlans();
assert.equal(planBuilds, 1);
assert.ok(Math.abs(state.stemBuffers.vocals.getChannelData(1)[3] - dbToGain(-6)) < 1e-6);
assert.equal(state.stemBuffers.bass.getChannelData(0)[0], 1, 'a stem left at 0 dB is untouched');
await buildStemPlans();
assert.ok(Math.abs(state.stemBuffers.vocals.getChannelData(0)[0] - dbToGain(-6)) < 1e-6, 'levels are applied once, not on every rebuild');

// 4. Asking for a stem the song does not have never splits the song again: the list becomes the saved stems.
const asked = ['drums', 'vocals'];
const viaSaved = await separateRequiredStems(asked, () => {});
assert.equal(realSeparations, 0, 'the rebuilt song is never re-split');
assert.deepEqual(asked, ['vocals', 'bass', 'other'], 'the caller loops over the saved stems');
assert.ok(viaSaved.vocals.startsWith('blob:') && viaSaved.other.startsWith('blob:') && !viaSaved.drums);
// Any other loaded file still goes to a real separation.
const rebuiltFile = state.file;
state.file = new File([], 'something-else.wav');
await separateRequiredStems(['vocals'], () => {});
assert.equal(realSeparations, 1);
state.file = rebuiltFile;

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

// 6. "Mix and master": no separation at all, the stem stage gets the saved stems at their levels,
//    then mix rebuild, release master, and the master saved to the same song.
{
  const calls = [];
  const separationsBefore = realSeparations;
  globalThis.MixForgeHub = { requireEntitlement: (f) => { calls.push(`gate:${f}`); return { ok: true }; } };
  globalThis.measureBuffer = (b) => ({ lufs: -14, length: b.length });
  globalThis.fallbackMixAudit = () => ({ findings: [], stemsToInspect: ['drums'] });
  globalThis.mfSetPipeline = (p) => calls.push(`pipeline:${p}`);
  globalThis.buildStemPlans = async () => { calls.push(`plans:${Object.keys(state.stemBuffers).join('+')}`); };
  globalThis.renderStemPlans = () => calls.push('renderPlans');
  globalThis.reveal = (id) => calls.push(`reveal:${id}`);
  globalThis.rebuildCorrectedMix = async () => { calls.push('mix'); return stemBuffer(0.3); };
  globalThis.prepareMastering = () => { calls.push('prepareMaster'); state.masterPlan = { targetLufs: -12 }; };
  globalThis.renderReleaseMaster = async () => { calls.push('master'); return stemBuffer(0.5); };
  globalThis.markMasterRendered = () => calls.push('marked');
  globalThis.renderMetrics = () => {};
  globalThis.renderVerification = () => calls.push('verify');
  globalThis.setStatus = () => {};
  const gateSeen = [];
  let gateResult = { allow: true, reason: 'ok', verified: true, clipFail: false, tpFail: false, monoWarn: false, message: '' };
  globalThis.evaluateExportGate = (snapshot) => { gateSeen.push(Boolean(snapshot.master)); return gateResult; };
  globalThis.mixForgeCriticGate = { receipts: [{ id: 'stage-1-vocals', target: 'vocals', verdict: { status: 'accepted' } }, { id: 'stage-2-other', target: 'other', verdict: { status: 'rejected' } }] };
  saved.length = 0;
  await fire(byId('rebuildMasterBtn'), 'click');
  assert.equal(realSeparations, separationsBefore, 'Mix and master never runs a separation');
  assert.deepEqual(calls, ['gate:forensicStems', 'pipeline:forensic', 'plans:vocals+bass+other', 'renderPlans', 'reveal:stemPanel', 'mix', 'prepareMaster', 'master', 'marked', 'verify', 'reveal:previewBox', 'reveal:verifyPanel']);
  assert.deepEqual(state.audit.stemsToInspect, ['vocals', 'bass', 'other'], 'the stem stage covers the saved stems');
  assert.equal(state.separationInfo.engine, 'song library');
  assert.equal(state.stemBuffers.vocals.length, state.original?.length ?? state.stemBuffers.vocals.length);
  assert.ok(Math.abs(state.stemBuffers.vocals.getChannelData(0)[0] - 0.2 * dbToGain(-6)) < 1e-6, 'stems carry their level in the mix');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].songId, song.id);
  assert.equal(saved[0].kind, 'master');
  assert.equal(saved[0].label, 'MixForge master');
  assert.match(saved[0].source, /^mixforge:master\/[0-9a-f]{16}$/);
  assert.equal(encoded.bits, 16);
  assert.match(byId('rebuildStatusLine').textContent, /^Mixed and mastered.*saved to “Coal” as its release master/);
  assert.equal(createdSongs, 0);
  assert.deepEqual(gateSeen, [true], 'the rendered master is put through the release hard checks before it is saved');

  // One receipt covers the run, and it downloads as a small JSON file with no audio in it.
  assert.ok(!hidden('rebuildReceiptBtn'));
  await fire(byId('rebuildReceiptBtn'), 'click');
  const link = all.filter((n) => n.tagName === 'A' && n.attrs.download).pop();
  assert.match(link.attrs.download, /^mixforge-receipt-Coal-\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(link.clicked, 1);
  const receipt = JSON.parse(await objectUrls.at(-1).text());
  assert.equal(receipt.schema, 'mixforge-run-receipt');
  assert.deepEqual(receipt.song, { id: song.id, title: 'Coal' });
  assert.deepEqual(receipt.stems.map((x) => `${x.name}:${x.levelDb}:${x.muted}`), ['vocals:-6:false', 'bass:0:false', 'other:0:false']);
  assert.equal(receipt.stemCheck, null, 'no stem check ran on these few-sample stems, and the receipt says so');
  assert.deepEqual(receipt.corrections.map((c) => `${c.target}:${c.verdict.status}`), ['vocals:accepted', 'other:rejected']);
  assert.equal(receipt.master.targetLufs, -12);
  assert.equal(receipt.master.measured.lufs, -14);
  assert.equal(receipt.master.hardChecks.passed, true);
  assert.deepEqual(receipt.saved, { toSong: true, kind: 'master', source: saved[0].source, reason: null });
  assert.ok(objectUrls.at(-1).size < 4000);

  // A master that fails the hard checks (clipping, or peak over the ceiling) is not saved to the song.
  gateResult = { allow: false, reason: 'safety', verified: false, clipFail: true, tpFail: false, monoWarn: false, message: 'Export blocked: clipping. Check the override if you still want this file.' };
  saved.length = 0;
  await fire(byId('rebuildMasterBtn'), 'click');
  assert.equal(saved.length, 0, 'nothing is saved when the hard checks fail');
  assert.match(byId('rebuildStatusLine').textContent, /^Mixed and mastered.*but not saved to “Coal”: Export blocked: clipping/);
  assert.match(byId('rebuildStatusLine').className, /error/);
  await fire(byId('rebuildReceiptBtn'), 'click');
  const refused = JSON.parse(await objectUrls.at(-1).text());
  assert.equal(refused.saved.toSong, false);
  assert.match(refused.saved.reason, /clipping/);
  assert.equal(refused.master.hardChecks.clipping, true);

  // If the release check is not there at all, nothing is saved either.
  delete globalThis.evaluateExportGate;
  await fire(byId('rebuildMasterBtn'), 'click');
  assert.equal(saved.length, 0);
  assert.match(byId('rebuildStatusLine').textContent, /could not run its release checks/);
  globalThis.evaluateExportGate = () => ({ allow: true, verified: true });

  // Without a license it stops before doing anything.
  globalThis.MixForgeHub = { requireEntitlement: () => ({ ok: false, reason: 'subscribe' }) };
  saved.length = 0;
  await fire(byId('rebuildMasterBtn'), 'click');
  assert.equal(saved.length, 0);
  assert.match(byId('rebuildStatusLine').textContent, /needs a MixForge or Forge Pass license/);
}
console.log('stem rebuild mix-and-master smoke ok');

// 7. A song that still has its original mix: the stems are checked against each other on open, and on request
//    against that mix (never against a rebuild of the same stems). What they leave out can be heard.
{
  const RATE = 1000;
  const wave = (hz, level, channels = 2, length = 2000) => {
    const b = new FakeBuffer(channels, length, RATE);
    b.data.forEach((ch) => { for (let i = 0; i < length; i++) ch[i] = level * Math.sin(2 * Math.PI * hz * i / RATE); });
    return b;
  };
  const ids = { mix: 'bbbbbbbb-0000-4000-8000-000000000001', rebuilt: 'bbbbbbbb-0000-4000-8000-000000000002', vocals: 'bbbbbbbb-0000-4000-8000-000000000011', bass: 'bbbbbbbb-0000-4000-8000-000000000012', other: 'bbbbbbbb-0000-4000-8000-000000000013', drums: 'bbbbbbbb-0000-4000-8000-000000000014' };
  const stemsAudio = { [ids.vocals]: wave(50, 0.3), [ids.bass]: wave(20, 0.25, 1), [ids.other]: wave(130, 0.15), [ids.drums]: wave(210, 0.2) };
  const fullMix = new FakeBuffer(2, 2000, RATE);
  for (const b of Object.values(stemsAudio)) fullMix.data.forEach((ch, c) => { const src = b.data[Math.min(c, b.numberOfChannels - 1)]; for (let i = 0; i < 2000; i++) ch[i] += src[i]; });
  const song2 = {
    id: '1c3479a3-1111-4222-8333-444455556666', title: 'Ember',
    assets: [
      { id: ids.rebuilt, kind: 'mix', label: 'Rebuilt from stems', playable: true, createdAt: '2026-10-01T00:00:00Z' },
      { id: ids.mix, kind: 'mix', label: 'Original mix', playable: true, createdAt: '2026-11-01T00:00:00Z' },
      { id: ids.vocals, kind: 'stem', stem: 'vocals', playable: true, createdAt: '2026-11-02T00:00:00Z' },
      { id: ids.bass, kind: 'stem', stem: 'bass', playable: true, createdAt: '2026-11-02T00:00:00Z' },
      { id: ids.other, kind: 'stem', stem: 'other', playable: true, createdAt: '2026-11-02T00:00:00Z' },
      { id: ids.drums, kind: 'stem', stem: 'drums', playable: true, createdAt: '2026-11-02T00:00:00Z' },
    ],
  };
  const fetched = [];
  globalThis.MixForgeSongLibrary.getSong = async () => song2;
  globalThis.fetch = async (url) => {
    const id = String(url).split('/').pop();
    fetched.push(id);
    return { ok: true, status: 200, headers: { get: () => null }, body: null, arrayBuffer: async () => new TextEncoder().encode(id).buffer };
  };
  globalThis.decodeAudioDataSafe = async (_ctx, bytes) => {
    const id = new TextDecoder().decode(bytes);
    return id === ids.mix ? fullMix : stemsAudio[id];
  };
  globalThis.location = { search: `?song=${song2.id}&rebuild=stems` };
  all.length = 0;
  warnings.length = 0;
  started.length = 0;
  runPage();
  for (let i = 0; i < 20 && !/ready/.test(byId('rebuildStatusLine')?.textContent || ''); i++) await settle();
  assert.match(byId('rebuildStatusLine').textContent, /^4 stems ready/);

  // On open: stems against each other, with nothing extra downloaded.
  assert.equal(warnings.length, 0);
  assert.ok(!hidden('rebuildCheck'));
  assert.match(byId('rebuildCheck').className, /\bgood\b/);
  assert.match(byId('rebuildCheckLine').textContent, /^4 stems line up/);
  assert.equal(fetched.includes(ids.mix), false, 'the original mix is not downloaded until asked for');
  assert.ok(!hidden('rebuildCompareBtn'), 'a song with its original mix offers the comparison');
  assert.ok(hidden('rebuildLeftoverBtn'));

  // While MixForge is lining up stems for a Forensic Fix, the comparison waits instead of disturbing it.
  state._stemDecodesRemaining = 2;
  await fire(byId('rebuildCompareBtn'), 'click');
  assert.match(byId('rebuildCheckLine').textContent, /still loading stems/);
  assert.equal(state._stemDecodesRemaining, 2);
  assert.equal(fetched.includes(ids.mix), false);
  state._stemDecodesRemaining = 0;

  // Levels on the sliders do not change the check: it asks whether the saved files hold the whole song.
  const drumSlider = byAttr('aria-label', 'drums level');
  drumSlider.value = '-12';
  await fire(drumSlider, 'input');
  await fire(byId('rebuildCompareBtn'), 'click');
  assert.equal(fetched.filter((id) => id === ids.mix).length, 1, 'the original mix is used');
  assert.equal(fetched.includes(ids.rebuilt), false, 'a rebuild of these same stems is never the reference');
  assert.match(byId('rebuildCheck').className, /\bgood\b/);
  assert.match(byId('rebuildCheckLine').textContent, /^The stems add back up to the original mix\./);
  assert.ok(!hidden('rebuildCheckNumbers'));
  const numbers = byId('rebuildCheckNumbers').children[1].children.map((li) => li.textContent).join('\n');
  assert.match(numbers, /Left over after the best level match: -1\d\d\.\d dB/);
  assert.match(numbers, /Level correction that fits best: 1\.00×/);
  assert.match(numbers, /drums: -\d+\.\d dB against the original mix\./);
  assert.ok(!hidden('rebuildLeftoverBtn'));

  // What the stems leave out can be played, and stopped.
  started.length = 0;
  await fire(byId('rebuildLeftoverBtn'), 'click');
  assert.equal(started.length, 1);
  assert.equal(started[0].buffer.numberOfChannels, 1);
  assert.equal(started[0].buffer.length, 2000);
  assert.match(byId('rebuildLeftoverBtn').textContent, /Stop/);
  await fire(byId('rebuildLeftoverBtn'), 'click');
  assert.equal(started[0].stopped, true);
  assert.match(byId('rebuildLeftoverBtn').textContent, /Hear what the stems leave out/);

  // Mix and master carries that check into the run receipt, as numbers only.
  globalThis.MixForgeHub = { requireEntitlement: () => ({ ok: true }) };
  globalThis.evaluateExportGate = () => ({ allow: true, verified: true, clipFail: false, tpFail: false, monoWarn: false, message: '' });
  globalThis.loadFile = async (file) => { state.file = file; state.original = encoded?.buffer || null; state.stemBuffers = {}; };
  globalThis.rebuildCorrectedMix = async () => wave(50, 0.3);
  globalThis.renderReleaseMaster = async () => wave(50, 0.5);
  saved.length = 0;
  await fire(byId('rebuildMasterBtn'), 'click');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].songId, song2.id);
  await fire(byId('rebuildReceiptBtn'), 'click');
  const receipt = JSON.parse(await objectUrls.at(-1).text());
  assert.equal(receipt.song.title, 'Ember');
  assert.equal(receipt.stemCheck.analysis.against, 'mix');
  assert.equal(receipt.stemCheck.verdict.className, 'good');
  assert.deepEqual(receipt.stemCheck.sourceFiles.map((f) => f.slot), ['mix', 'vocals', 'drums', 'bass', 'other']);
  assert.equal(receipt.stemCheck.sourceFiles[0].assetId, ids.mix);
  assert.equal('audio' in receipt.stemCheck, false);
  assert.equal(receipt.stems.find((x) => x.name === 'drums').levelDb, -12);
  assert.ok(objectUrls.at(-1).size < 6000, 'the receipt holds no audio');
}
console.warn = realWarn;
console.log('stem rebuild stem-check smoke ok');
