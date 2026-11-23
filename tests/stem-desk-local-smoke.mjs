import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// "Bring your stems from your DAW": runs the real desk module against a fake page and fake Web Audio.
// Stem files are read in the browser, sorted into four mix groups, level-checked, mixed and mastered.
// Nothing is uploaded, nothing is split, and nothing is saved to a library song.

// ---- Fake page.
const listeners = new WeakMap();
const all = [];
function fakeElement(tag) {
  const node = {
    tagName: tag.toUpperCase(), children: [], attrs: {}, textContent: '', className: '', value: '', checked: false, disabled: false,
    classList: {
      remove(name) { node.className = node.className.split(' ').filter((c) => c && c !== name).join(' '); },
      add(name) { if (!node.className.split(' ').includes(name)) node.className = `${node.className} ${name}`.trim(); },
    },
    setAttribute(k, v) { node.attrs[k] = String(v); if (k === 'value') node.value = String(v); },
    append(...kids) { node.children.push(...kids); },
    replaceChildren(...kids) { node.children = kids; },
    insertBefore(kid) { node.children.unshift(kid); },
    addEventListener(type, fn, capture) { const map = listeners.get(node) || {}; (map[type] ||= []).push({ fn, capture: Boolean(capture) }); listeners.set(node, map); },
    scrollIntoView() {},
    click() { node.clicked = (node.clicked || 0) + 1; },
    remove() {},
    parentNode: null,
  };
  all.push(node);
  return node;
}
const main = fakeElement('main');
const page = { loadPanel: fakeElement('section'), stemFilesBtn: fakeElement('button'), stemFilesInput: fakeElement('input'), dropzone: fakeElement('button') };
page.loadPanel.parentNode = main;
globalThis.document = { createElement: fakeElement, createTextNode: (text) => ({ textContent: text }), querySelector: () => main, body: main };
globalThis.$ = (id) => page[id] || null;
const fire = async (node, type, event = {}) => {
  for (const { fn } of (listeners.get(node) || {})[type] || []) await fn(event);
  for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 0));
};
const byId = (id) => all.filter((n) => n.attrs.id === id).pop();
const byLabel = (label) => all.filter((n) => n.attrs['aria-label'] === label).pop();
const hidden = (id) => /\bhidden\b/.test(byId(id).className);
const text = (id) => byId(id).textContent;

// ---- Fake Web Audio and the globals MixForge's other scripts provide.
const RATE = 1000;
const LEN = 2000;
class FakeBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels; this.length = length; this.sampleRate = sampleRate;
    this.data = Array.from({ length: channels }, () => new Float32Array(length));
  }
  get duration() { return this.length / this.sampleRate; }
  getChannelData(c) { return this.data[c]; }
  copyToChannel(src, c) { this.data[c].set(src); }
}
const wave = (hz, level, channels = 2, length = LEN) => {
  const b = new FakeBuffer(channels, length, RATE);
  b.data.forEach((ch) => { for (let i = 0; i < length; i++) ch[i] = level * Math.sin(2 * Math.PI * hz * i / RATE); });
  return b;
};
const audio = {
  'Coal_Lead Vox.wav': wave(50, 0.3),
  'Coal_Kick.wav': wave(20, 0.25, 1),
  'Coal_Snare.wav': wave(210, 0.15),
  'Coal_Bass DI.wav': wave(33, 0.25, 1),
  'Coal_Gtr L.wav': wave(130, 0.15),
  'Coal_Quiet Vox.wav': wave(50, 0.02),
};
const file = (name) => new File([new TextEncoder().encode(name)], name, { type: 'audio/wav' });
const fileSet = (...names) => names.map(file);
globalThis.decodeAudioDataSafe = async (_ctx, bytes) => {
  const name = new TextDecoder().decode(bytes);
  if (!audio[name]) throw new Error('unknown format');
  return audio[name];
};
globalThis.state = { audioCtx: { currentTime: 0, destination: {}, createBuffer: (c, l, r) => new FakeBuffer(c, l, r) }, file: null, stemBuffers: {} };
globalThis.ensureAudioContext = async () => globalThis.state.audioCtx;
globalThis.OfflineCtx = null;
globalThis.dbToGain = (db) => Math.pow(10, db / 20);
globalThis.normalizeStemName = (s) => ({ guitars: 'other', keys: 'other' }[s] || s);
globalThis.measureLUFS = (buffer) => { const d = buffer.getChannelData(0); let sum = 0; for (let i = 0; i < d.length; i++) sum += d[i] * d[i]; return 10 * Math.log10(sum / d.length + 1e-12); };
const encodes = [];
globalThis.encodeWav = async (buffer, bits) => { encodes.push({ buffer, bits }); return new Blob([new Uint8Array(44 + buffer.length * buffer.numberOfChannels * (bits / 8))]); };
globalThis.loadFile = async (f) => { globalThis.state.file = f; globalThis.state.original = encodes.at(-1).buffer; globalThis.state.stemBuffers = {}; };
let realSeparations = 0;
globalThis.separateRequiredStems = async () => { realSeparations++; return {}; };
const libraryCalls = [];
globalThis.MixForgeSongLibrary = {
  call: async (...args) => { libraryCalls.push(args); throw new Error('the library must not be called for stems from disk'); },
  getSong: async (...args) => { libraryCalls.push(args); throw new Error('no song'); },
  saveFile: async (...args) => { libraryCalls.push(args); return {}; },
  formatBytes: (n) => `${n} B`,
};
const fetches = [];
globalThis.fetch = async (...args) => { fetches.push(args); throw new Error('no network for stems from disk'); };
globalThis.location = { search: '' };
const objectUrls = [];
URL.createObjectURL = (blob) => { objectUrls.push(blob); return `blob:fake/${objectUrls.length}`; };
URL.revokeObjectURL = () => {};
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => (ms > 60_000 ? 0 : realSetTimeout(fn, ms));

for (const script of ['app-stem-rebuild-core.js', 'app-stem-reliability-core.js', 'app-auto-mix-core.js', 'app-stem-rebuild.js']) {
  new Function(readFileSync(new URL(`../js/${script}`, import.meta.url), 'utf8'))();
}

// 1. On the normal page the desk stays out of the way until stems are chosen.
assert.equal(main.children.length, 0, 'no desk panel until it is needed');
assert.equal(typeof globalThis.MixForgeStemDesk.openLocal, 'function');
await fire(page.stemFilesBtn, 'click');
assert.equal(page.stemFilesInput.clicked, 1, 'the button opens the file chooser');

// 2. Five stems from a DAW: sorted into mix groups by name, named after what the files share.
await fire(page.stemFilesInput, 'change', { target: { files: fileSet('Coal_Gtr L.wav', 'Coal_Kick.wav', 'Coal_Lead Vox.wav', 'Coal_Bass DI.wav', 'Coal_Snare.wav') } });
assert.equal(main.children.length, 1, 'the desk panel is on the page');
assert.equal(byId('rebuildPanel').children[0].children[1].children[0].textContent, 'Mix your stems');
assert.match(text('rebuildStatusLine'), /^5 stems ready/);
const rows = byId('rebuildRows').children;
assert.deepEqual(rows.map((r) => r.children[0].textContent), ['Coal_Lead Vox', 'Coal_Kick', 'Coal_Snare', 'Coal_Bass DI', 'Coal_Gtr L'], 'kept together by group: vocals, drums, bass, other');
assert.deepEqual(rows.map((r) => r.children[1].value), ['vocals', 'drums', 'drums', 'bass', 'other'], 'each file gets a group from its name');
assert.ok(!hidden('rebuildCheck'));
assert.match(text('rebuildCheckLine'), /^5 stems in 4 mix groups: none of the groups is empty/);
assert.match(byId('rebuildCheck').className, /\bgood\b/);
assert.ok(hidden('rebuildMissing'), 'all four groups are filled');
assert.ok(hidden('rebuildSaveBtn') && hidden('rebuildLibraryLink') && hidden('rebuildCompareBtn'), 'nothing here belongs to a library song');
assert.ok(!hidden('rebuildLevels') && !hidden('rebuildOptions') && !hidden('rebuildActions'));
assert.equal(byId('rebuildFixLevels').checked, true);
assert.equal(byId('rebuildRides').checked, true);

// 3. Levels in a sensible range are left alone, and the desk says so.
await fire(byId('rebuildLevelsBtn'), 'click');
assert.match(text('rebuildLevelsLine'), /Levels are inside the range MixForge corrects.*Nothing moved/);
assert.ok(hidden('rebuildLevelsUndoBtn'));

// 4. Mix and master: the four groups go straight to the mix stage. No upload, no split, no library save.
const calls = [];
globalThis.MixForgeHub = { requireEntitlement: (f) => { calls.push(`gate:${f}`); return { ok: true }; } };
globalThis.measureBuffer = (b) => ({ lufs: -14, peakDb: -1.2, lra: 5, crestDb: 10, correlation: 0.9, clipPercent: 0, length: b.length });
globalThis.fallbackMixAudit = () => ({ findings: [], stemsToInspect: [] });
globalThis.mfSetPipeline = (p) => calls.push(`pipeline:${p}`);
globalThis.buildStemPlans = async () => { calls.push(`plans:${Object.keys(state.stemBuffers).join('+')}`); };
globalThis.renderStemPlans = () => {};
globalThis.reveal = () => {};
globalThis.rebuildCorrectedMix = async () => { calls.push(`mix:rides=${state.mixOptions?.rides}`); return wave(50, 0.3); };
globalThis.prepareMastering = () => { state.masterPlan = { targetLufs: -12, truePeakCeilingDb: -1 }; };
globalThis.renderReleaseMaster = async () => { calls.push('master'); return wave(50, 0.5); };
globalThis.markMasterRendered = () => {};
globalThis.renderMetrics = () => {};
globalThis.renderVerification = () => {};
globalThis.setStatus = () => {};
globalThis.evaluateExportGate = () => ({ allow: true, verified: true, clipFail: false, tpFail: false, monoWarn: false, message: '' });
globalThis.mixForgeCriticGate = { receipts: [{ id: 'stage-1-vocals', target: 'vocals', verdict: { status: 'accepted' } }] };
await fire(byId('rebuildMasterBtn'), 'click');
assert.deepEqual(calls, ['gate:forensicStems', 'pipeline:forensic', 'plans:vocals+drums+bass+other', 'mix:rides=true', 'master']);
// These five stems add up to more than full scale, so the whole mix was turned down evenly (never limited).
assert.match(text('rebuildStatusLine'), /^Mixed and mastered \(turned down \d\.\d dB so it does not clip\)\. Listen below, then download the release WAV\.$/);
const trim = dbToGain(state.libraryRebuild.trimDb);
assert.ok(trim < 1 && trim > 0.7, `an even turn-down (${state.libraryRebuild.trimDb.toFixed(2)} dB)`);
assert.match(byId('rebuildStatusLine').className, /\bok\b/);
assert.match(state.file.name, /^Coal - mixed from stems\.wav$/);
assert.deepEqual(state.audit.stemsToInspect, ['vocals', 'drums', 'bass', 'other']);
assert.deepEqual(state.separationInfo, { engine: 'your stems', mode: 'stems from your DAW' });
// The drums group is the kick and the snare together, at their fader levels; a mono file plays in both channels.
const at = 137;
const kick = audio['Coal_Kick.wav'].data[0][at];
const snare = audio['Coal_Snare.wav'].data[0][at];
assert.ok(Math.abs(state.stemBuffers.drums.getChannelData(0)[at] - (kick + snare) * trim) < 1e-6);
assert.ok(Math.abs(state.stemBuffers.drums.getChannelData(1)[at] - (kick + snare) * trim) < 1e-6);
assert.ok(Math.abs(state.stemBuffers.vocals.getChannelData(0)[at] - audio['Coal_Lead Vox.wav'].data[0][at] * trim) < 1e-6);
assert.equal(state.stemBuffers.drums.length, state.original.length);
// And the loaded mix is every file summed.
const everything = ['Coal_Lead Vox.wav', 'Coal_Kick.wav', 'Coal_Snare.wav', 'Coal_Bass DI.wav', 'Coal_Gtr L.wav'].reduce((sum, name) => sum + audio[name].data[0][at], 0);
assert.ok(Math.abs(state.original.getChannelData(0)[at] - everything * trim) < 1e-6);
// So the groups add back up to the loaded mix exactly: the mix stage corrects on top of a consistent picture.
const groupSum = ['vocals', 'drums', 'bass', 'other'].reduce((sum, role) => sum + state.stemBuffers[role].getChannelData(0)[at], 0);
assert.ok(Math.abs(groupSum - state.original.getChannelData(0)[at]) < 1e-6);
assert.equal(realSeparations, 0, 'nothing is split');
assert.equal(fetches.length, 0, 'nothing is fetched or uploaded');
assert.equal(libraryCalls.length, 0, 'nothing is saved to a library song');
assert.equal(state.librarySong, undefined, 'later saves are not pointed at a song');

// The receipt names the files, their groups, where they came from, and that the master was not saved to a song.
await fire(byId('rebuildReceiptBtn'), 'click');
const receipt = JSON.parse(await objectUrls.at(-1).text());
assert.deepEqual(receipt.song, { id: null, title: 'Coal' });
assert.match(receipt.source, /your own stems.*nothing uploaded and nothing split/);
assert.deepEqual(receipt.stems.map((x) => `${x.name}>${x.group}`), ['Coal_Lead Vox>vocals', 'Coal_Kick>drums', 'Coal_Snare>drums', 'Coal_Bass DI>bass', 'Coal_Gtr L>other']);
assert.deepEqual(receipt.levels.fixedByMixForge, []);
assert.ok(receipt.levels.vocalAgainstBandLu.before > -6 && receipt.levels.vocalAgainstBandLu.before < 6);
assert.equal(receipt.stemCheck.analysis.against, 'stems');
assert.deepEqual(receipt.stemCheck.stems.map((x) => x.id), ['vocals', 'drums', 'bass', 'other']);
assert.equal(receipt.corrections.length, 1);
assert.equal(receipt.saved.toSong, false);
assert.match(receipt.saved.reason, /not a library song/);
assert.match(all.filter((n) => n.tagName === 'A' && n.attrs.download).pop().attrs.download, /^mixforge-receipt-Coal-/);

// 5. Changing a file's group regroups the mix; switching rides off reaches the mix stage.
const kickGroup = byLabel('Mix group for Coal_Kick');
kickGroup.value = 'other';
await fire(kickGroup, 'change');
byId('rebuildRides').checked = false;
calls.length = 0;
await fire(byId('rebuildMasterBtn'), 'click');
assert.deepEqual(calls.slice(2, 4), ['plans:vocals+drums+bass+other', 'mix:rides=false']);
assert.ok(Math.abs(state.stemBuffers.drums.getChannelData(0)[at] - snare * trim) < 1e-6, 'the drums group is now the snare alone');
assert.ok(Math.abs(state.stemBuffers.other.getChannelData(0)[at] - (kick + audio['Coal_Gtr L.wav'].data[0][at]) * trim) < 1e-6, 'the kick moved to "other"');
byId('rebuildRides').checked = true;

// 6. "Load as one mix only", then Forensic Fix: the groups on the desk are used. The song is never split.
await fire(byId('rebuildUseBtn'), 'click');
assert.match(text('rebuildStatusLine'), /mix of these stems is loaded/);
const asked = ['vocals', 'drums'];
const progress = [];
encodes.length = 0;
const outputs = await separateRequiredStems(asked, (m) => progress.push(m));
assert.equal(realSeparations, 0);
assert.deepEqual(asked, ['vocals', 'drums', 'bass', 'other']);
assert.deepEqual(Object.keys(outputs), ['vocals', 'drums', 'bass', 'other']);
assert.match(progress[0], /Using the stems already on the desk\. No new separation/);
assert.equal(encodes.length, 4);
assert.equal(state.separationInfo.engine, 'your stems');
// Any other loaded file still goes to a real separation.
state.file = new File([], 'a-finished-mix.wav');
await separateRequiredStems(['vocals'], () => {});
assert.equal(realSeparations, 1);

// 7. A buried vocal: "Set levels for me" raises it on the fader, says why, and can be undone.
await fire(page.stemFilesInput, 'change', { target: { files: fileSet('Coal_Quiet Vox.wav', 'Coal_Kick.wav', 'Coal_Bass DI.wav', 'Coal_Gtr L.wav') } });
assert.match(text('rebuildStatusLine'), /^4 stems ready/);
assert.ok(hidden('rebuildReceiptBtn'), 'a new set of stems starts with a clean desk');
const voxLevel = byLabel('Coal_Quiet Vox level');
assert.equal(voxLevel.value, '0');
await fire(byId('rebuildLevelsBtn'), 'click');
assert.equal(voxLevel.value, '6', 'raised by the cap, on the fader');
assert.match(text('rebuildLevelsLine'), /^The vocal sat \d+(\.\d)? LU under the band, where words get lost\. Raised 6 dB\. That is the most MixForge moves a fader on its own; it is still \d+(\.\d)? LU under the band/);
assert.ok(!hidden('rebuildLevelsUndoBtn'));
// Pressing it again does not stack: the cap is on MixForge's total, measured from the member's own level.
const firstLine = text('rebuildLevelsLine');
await fire(byId('rebuildLevelsBtn'), 'click');
assert.equal(voxLevel.value, '6');
assert.equal(text('rebuildLevelsLine'), firstLine);
await fire(byId('rebuildLevelsUndoBtn'), 'click');
assert.equal(voxLevel.value, '0');
assert.match(text('rebuildLevelsLine'), /Back to your levels/);
assert.ok(hidden('rebuildLevelsUndoBtn'));
// Mix and master does the same fix on its own (the option is on), and the receipt records it.
calls.length = 0;
await fire(byId('rebuildMasterBtn'), 'click');
assert.equal(voxLevel.value, '6');
await fire(byId('rebuildReceiptBtn'), 'click');
const fixed = JSON.parse(await objectUrls.at(-1).text());
assert.deepEqual(fixed.levels.fixedByMixForge.map((m) => `${m.group}:${m.changeDb}:${m.files.join()}`), ['vocals:6:Coal_Quiet Vox']);
assert.match(fixed.levels.fixedByMixForge[0].reason, /under the band/);
assert.equal(fixed.stems.find((x) => x.group === 'vocals').levelDb, 6);
assert.equal(fixed.levels.vocalAgainstBandLu.after - fixed.levels.vocalAgainstBandLu.before, 6);
// With the option off, levels are not touched.
await fire(byId('rebuildLevelsUndoBtn'), 'click');
byId('rebuildFixLevels').checked = false;
await fire(byId('rebuildMasterBtn'), 'click');
assert.equal(voxLevel.value, '0');
byId('rebuildFixLevels').checked = true;
// A fader the member set by hand is theirs: MixForge says what it would have done and leaves it.
voxLevel.value = '-3';
await fire(voxLevel, 'input');
await fire(byId('rebuildLevelsBtn'), 'click');
assert.equal(voxLevel.value, '-3');
assert.match(text('rebuildLevelsLine'), /would have moved the vocals, but you set that fader yourself, so nothing moved/);

// 8. Several files dropped on the box are stems; one dropped file is still a mix.
const dropListener = (listeners.get(page.dropzone) || {}).drop;
assert.equal(dropListener.length, 1);
assert.equal(dropListener[0].capture, true, 'the stems check runs before the single-file loader');
const drop = (files) => { const event = { dataTransfer: { files }, prevented: 0, stopped: 0, preventDefault() { this.prevented++; }, stopImmediatePropagation() { this.stopped++; } }; return event; };
const single = drop(fileSet('Coal_Kick.wav'));
const statusBeforeDrop = text('rebuildStatusLine');
await fire(page.dropzone, 'drop', single);
assert.equal(single.stopped, 0, 'one file is left for the mix loader');
assert.equal(single.prevented, 0);
assert.equal(text('rebuildStatusLine'), statusBeforeDrop, 'and the desk is not disturbed');
assert.equal(byId('rebuildRows').children.length, 4);
const several = drop(fileSet('Coal_Lead Vox.wav', 'Coal_Bass DI.wav'));
await fire(page.dropzone, 'drop', several);
assert.equal(several.stopped, 1);
assert.equal(several.prevented, 1);
assert.match(text('rebuildStatusLine'), /^2 stems ready/);
assert.match(text('rebuildMissing'), /Nothing is marked as drums or other/);

// 9. Refusals say what to do instead.
await fire(page.stemFilesInput, 'change', { target: { files: fileSet('Coal_Kick.wav') } });
assert.match(text('rebuildStatusLine'), /Choose at least two stem files/);
assert.ok(hidden('rebuildActions'));
await fire(page.stemFilesInput, 'change', { target: { files: Array.from({ length: 25 }, (_, i) => file(`Coal_Kick.wav`.replace('Kick', `Kick ${i}`))) } });
assert.match(text('rebuildStatusLine'), /That is 25 files\. MixForge mixes up to 24 stems at once/);
const realError = console.error;
console.error = () => {}; // the desk logs the refusal it is about to show
await fire(page.stemFilesInput, 'change', { target: { files: fileSet('Coal_Kick.wav', 'notes.txt') } });
console.error = realError;
assert.match(text('rebuildStatusLine'), /“notes\.txt” could not be read as audio/);
assert.ok(hidden('rebuildActions'));
assert.equal(fetches.length, 0);
assert.equal(libraryCalls.length, 0);

console.log('stem desk local smoke ok');
