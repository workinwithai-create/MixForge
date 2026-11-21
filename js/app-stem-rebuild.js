'use strict';

// The stem desk: mix a song from stems, then master it. Two ways in, one mixer.
//   1. A song in the shared library:  https://mixforge.workinwithai.com/?song=<songId>&rebuild=stems
//      MixForge fetches the stems saved on the song (short-lived signed links).
//   2. Your own stems from your DAW: "Bring your stems" in the load panel, or drop several files at once.
//      They are read in this browser. Nothing is uploaded and nothing is split.
// Either way each stem gets a level, Mute and Solo, and sits in one of four mix groups (vocals, drums, bass,
// other). A stem check says whether the stems line up and, when a library song still has its original mix,
// whether they add back up to it (with what they leave out playable). Then the member can
//   - "Mix and master": no separation at all. MixForge fixes levels that are clearly off, places each group
//     against the others (EQ, dynamics), rides the lead vocal, renders the release master, and, for a library
//     song, saves that master to the same song when it passes the same hard checks as Download release WAV.
//     One receipt covers the run: stems and levels, the stem check, every correction with its verdict, the master;
//   - "Load as one mix only": the summed stems become the loaded mix for the normal Scan / Quick Master path;
//     Forensic Fix on it reuses these stems and never splits the song;
//   - "Save rebuilt mix to this song" (library songs): a 16-bit WAV of the plain sum is added to the song.
// A library song keeps its id (no new song is made).
(() => {
  const library = globalThis.MixForgeSongLibrary || null;
  const core = globalThis.MixForgeStemRebuildCore;
  const lab = globalThis.MixForgeStemReliability || null; // the stem check; the mixer works without it
  const auto = globalThis.MixForgeAutoMix || null; // level fixes and rides; the mixer works without it
  if (!core || typeof loadFile !== 'function') return;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const params = new URLSearchParams(location.search);
  const songId = (params.get('song') || '').trim().toLowerCase();
  const fromLibrary = Boolean(library) && params.get('rebuild') === 'stems' && UUID.test(songId);
  const stemFilesBtn = $('stemFilesBtn');
  const stemFilesInput = $('stemFilesInput');
  if (!fromLibrary && !stemFilesBtn) return;

  const ROLES = ['vocals', 'drums', 'bass', 'other'];
  const STEM_NAMES = { vocals: 'Vocals', drums: 'Drums', bass: 'Bass', other: 'Other (guitars, keys, the rest)' };
  const MAX_LOCAL_FILES = 24;
  const MAX_DECODED_BYTES = 1000 * 1024 * 1024; // about twelve 4-minute stereo stems; more than that and a tab runs out of memory
  const make = (tag, attrs = {}, text = '') => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value;
      else node.setAttribute(key, value);
    }
    if (text) node.textContent = text;
    return node;
  };
  const show = (node, on = true) => node.classList[on ? 'remove' : 'add']('hidden');

  // ---- Panel, placed above "Load your mix" when the desk opens.
  const panel = make('section', { class: 'panel stem-rebuild', id: 'rebuildPanel' });
  const titleRow = make('div', { class: 'panel-title' });
  const badge = make('span', {}, '↻');
  const titleCopy = make('div');
  const heading = make('h2', {}, 'Put your song back together');
  const intro = make('p', {}, 'MixForge loads the stems saved on this song, so you can set each level, hear them together, and turn them back into one mix.');
  titleCopy.append(heading, intro);
  titleRow.append(badge, titleCopy);
  const status = make('div', { class: 'status busy', id: 'rebuildStatusLine', 'aria-live': 'polite' }, 'Opening your song…');
  const rows = make('div', { class: 'rebuild-rows', id: 'rebuildRows' });
  const soloNote = make('p', { class: 'rebuild-note hidden', id: 'rebuildSoloNote' }, 'Solo only changes what you hear. Mix and master still uses every stem that is not muted.');
  const note = make('p', { class: 'rebuild-note hidden', id: 'rebuildMissing' });
  // Levels: fix a part that is clearly out of range, on the faders, where it can be seen, heard and undone.
  const levels = make('div', { class: 'rebuild-levels hidden', id: 'rebuildLevels' });
  const levelsBtn = make('button', { class: 'secondary', type: 'button', id: 'rebuildLevelsBtn' }, 'Set levels for me');
  const levelsUndoBtn = make('button', { class: 'secondary hidden', type: 'button', id: 'rebuildLevelsUndoBtn' }, 'Back to my levels');
  const levelsLine = make('p', { class: 'rebuild-levels-line', id: 'rebuildLevelsLine', 'aria-live': 'polite' }, 'MixForge can move a part that is clearly too quiet or too loud. Everything else stays where you put it.');
  levels.append(levelsBtn, levelsUndoBtn, levelsLine);
  // Stem check: do the stems line up, and do they add back up to the song's original mix?
  const check = make('div', { class: 'rebuild-check hidden', id: 'rebuildCheck' });
  const checkLine = make('p', { class: 'rebuild-check-line', id: 'rebuildCheckLine', 'aria-live': 'polite' });
  const checkNotes = make('ul', { class: 'rebuild-check-notes', id: 'rebuildCheckNotes' });
  const checkActions = make('div', { class: 'actions rebuild-check-actions' });
  const compareBtn = make('button', { class: 'secondary hidden', type: 'button', id: 'rebuildCompareBtn' }, 'Compare with the original mix');
  const leftoverBtn = make('button', { class: 'secondary hidden', type: 'button', id: 'rebuildLeftoverBtn' }, '▶ Hear what the stems leave out');
  checkActions.append(compareBtn, leftoverBtn);
  const checkNumbers = make('details', { class: 'rebuild-check-numbers hidden', id: 'rebuildCheckNumbers' });
  check.append(make('b', {}, 'Stem check'), checkLine, checkNotes, checkActions, checkNumbers);
  // What "Mix and master" is allowed to do on its own.
  const options = make('div', { class: 'rebuild-options hidden', id: 'rebuildOptions' });
  const optionBox = (id, text, title) => {
    const label = make('label', { class: 'rebuild-option', title });
    const box = make('input', { type: 'checkbox', id });
    box.checked = true;
    label.append(box, document.createTextNode(` ${text}`));
    options.append(label);
    return box;
  };
  const fixLevelsBox = optionBox('rebuildFixLevels', 'Fix levels that are clearly off', 'Before mixing, raise a part that is close to inaudible and bring a buried or overpowering vocal back into range. At most 6 dB.');
  const ridesBox = optionBox('rebuildRides', 'Ride the vocal (automation)', 'After the stems are placed, lift the phrases that drop under the band and ease the ones that jump out. A few dB at most.');
  const actions = make('div', { class: 'actions rebuild-actions hidden', id: 'rebuildActions' });
  const playBtn = make('button', { class: 'secondary', type: 'button', id: 'rebuildPlayBtn' }, '▶ Play together');
  const masterBtn = make('button', { class: 'primary', type: 'button', id: 'rebuildMasterBtn' }, 'Mix and master');
  const useBtn = make('button', { class: 'secondary', type: 'button', id: 'rebuildUseBtn' }, 'Load as one mix only');
  const saveBtn = make('button', { class: 'secondary', type: 'button', id: 'rebuildSaveBtn' }, 'Save rebuilt mix to this song');
  const libLink = make('a', { class: 'library-link', id: 'rebuildLibraryLink', href: `/library.html${fromLibrary ? `?song=${encodeURIComponent(songId)}` : ''}` }, 'Back to this song in my library');
  actions.append(playBtn, masterBtn, useBtn, saveBtn, libLink);
  const saveStatus = make('div', { class: 'status', id: 'rebuildSaveStatus', 'aria-live': 'polite' });
  const receiptBtn = make('button', { class: 'secondary hidden', type: 'button', id: 'rebuildReceiptBtn' }, 'Download the receipt for this run');
  panel.append(titleRow, status, rows, soloNote, note, levels, check, options, actions, saveStatus, receiptBtn);
  const loadPanel = $('loadPanel');
  let attached = false;
  function attachPanel() {
    if (attached) return;
    (loadPanel?.parentNode || document.querySelector('main') || document.body).insertBefore(panel, loadPanel || null);
    attached = true;
  }

  const say = (message, kind = 'busy') => { status.textContent = message; status.className = `status ${kind}`.trim(); };
  const sayBelow = (message, kind = 'busy') => { saveStatus.textContent = message; saveStatus.className = `status ${kind}`.trim(); };

  let song = null; // the library song, when the stems come from one
  let local = null; // { title } when the stems are the member's own files
  let parts = []; // { key, name, label, role, asset, blob, buffer, gainDb, muted, solo, gainNode, slider, valueText }
  let preview = null; // { sources: AudioBufferSourceNode[] }
  let originalMix = null; // the song's own full mix, if it has one
  let stemCheck = null; // { report, receipt } from the last stem check
  let leftover = null; // { samples, sampleRate, source } what the stems leave out of the original mix
  let lastReceipt = null; // the receipt of the last Mix and master run
  let levelMoves = []; // what MixForge's level fix moved, for the receipt
  const autoDelta = new Map(); // part key -> dB MixForge added to that fader; the rest of its position is the member's
  const title = () => (song ? (song.title || 'this song') : (local?.title || 'your stems'));

  // Solo is a listening tool: it never changes what is mixed, saved or mastered.
  const anySolo = () => parts.some((p) => p.solo);
  const audibleGain = (part) => (part.muted || (anySolo() && !part.solo) ? 0 : dbToGain(part.gainDb));
  function syncAudible() {
    for (const part of parts) if (part.gainNode) part.gainNode.gain.value = audibleGain(part);
    soloNote.classList[anySolo() ? 'remove' : 'add']('hidden');
  }

  // The Hub's "get" opens one song by id. A Hub without it still answers "list", so look the song up there.
  async function fetchSong(id) {
    try {
      if (typeof library.getSong === 'function') return await library.getSong(id);
    } catch (error) {
      if (error.status !== 400) throw error;
    }
    const data = await library.call('list');
    const found = (data.songs || []).find((s) => s.id === id);
    if (!found) throw Object.assign(new Error('That song is not in your library.'), { status: 404 });
    return found;
  }

  // One of the song's files through its short-lived signed link, with progress.
  async function downloadAsset(asset, what, onProgress) {
    const { playUrl } = await library.call('play', { songId: song.id, assetId: asset.id });
    const response = await fetch(playUrl);
    if (!response.ok) throw new Error(`Could not read the ${what} (${response.status}).`);
    const type = response.headers.get('content-type') || 'audio/wav';
    const size = Number(response.headers.get('content-length')) || Number(asset.size) || 0;
    if (!response.body || !size) return new Blob([await response.arrayBuffer()], { type });
    const reader = response.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress?.(Math.min(100, Math.round(got / size * 100)));
    }
    return new Blob(chunks, { type });
  }

  const downloadStem = (asset, label, index, total) => downloadAsset(asset, `${label} stem`,
    (percent) => say(`Downloading the ${label} stem (${index} of ${total})… ${percent}%`));

  async function resampleTo(buffer, rate) {
    if (buffer.sampleRate === rate) return buffer;
    if (!OfflineCtx) throw new Error('This browser cannot line up stems recorded at different sample rates.');
    const length = Math.ceil(buffer.duration * rate);
    const offline = new OfflineCtx(Math.min(2, buffer.numberOfChannels), length, rate);
    const src = offline.createBufferSource();
    src.buffer = buffer;
    src.connect(offline.destination);
    src.start();
    return offline.startRendering();
  }

  function channelsOf(buffer) {
    return Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) => buffer.getChannelData(c));
  }

  // ---- Mix groups. The mix stage works on four groups; a group is every stem file given that role.
  const rolesWith = (list) => ROLES.filter((role) => list.some((p) => p.role === role));
  const mixLength = () => Math.max(...parts.map((p) => p.buffer.length));
  const mixWidth = () => Math.max(...parts.map((p) => Math.min(2, p.buffer.numberOfChannels)));

  // One group as a single buffer: its files summed. `gain(part)` says how loud each file goes in (0 leaves it out).
  function groupBuffer(role, gain, length = mixLength(), width = mixWidth()) {
    const out = state.audioCtx.createBuffer(width, length, parts[0].buffer.sampleRate);
    for (const part of parts) {
      if (part.role !== role) continue;
      const g = gain(part);
      if (!g) continue;
      for (let c = 0; c < width; c++) {
        const src = part.buffer.getChannelData(Math.min(c, part.buffer.numberOfChannels - 1));
        const dest = out.getChannelData(c);
        const n = Math.min(src.length, dest.length);
        for (let i = 0; i < n; i++) dest[i] += src[i] * g;
      }
    }
    return out;
  }

  // ---- Stem check. Always the stems as they were saved or exported, whatever the faders say:
  // the question is whether these files hold the whole song.
  const asDelivered = () => 1;
  const stemInputs = () => rolesWith(parts).map((role) => {
    const files = parts.filter((p) => p.role === role);
    const buffer = files.length === 1 ? files[0].buffer : groupBuffer(role, asDelivered);
    return { id: role, channels: channelsOf(buffer), durationSec: Math.max(...files.map((p) => p.buffer.duration)) };
  });
  const checkSources = (mixAsset = null) => [
    ...(mixAsset ? [{ slot: 'mix', assetId: mixAsset.id, sizeBytes: Number(mixAsset.size) || null }] : []),
    ...parts.map((p) => ({ slot: p.role, name: p.asset ? undefined : p.label, assetId: p.asset?.id || null, sizeBytes: Number(p.asset?.size ?? p.blob?.size) || null })),
  ];

  // With several files in a group, a file that is a different length or silent is an export mistake worth naming.
  function fileNotes() {
    if (!local) return [];
    const longest = Math.max(...parts.map((p) => p.buffer.duration));
    const notes = [];
    const short = parts.filter((p) => longest - p.buffer.duration > 0.01);
    if (short.length) {
      notes.push(`${short.map((p) => `“${p.label}”`).join(', ')} ${short.length === 1 ? 'is' : 'are'} shorter than the longest stem. Stems line up only when each one is exported from the very start of the song.`);
    }
    const silent = parts.filter((p) => {
      const data = p.buffer.getChannelData(0);
      const step = Math.max(1, Math.floor(data.length / 200000));
      for (let i = 0; i < data.length; i += step) if (Math.abs(data[i]) > 0.0003) return false;
      return true;
    });
    if (silent.length) notes.push(`${silent.map((p) => `“${p.label}”`).join(', ')} ${silent.length === 1 ? 'is' : 'are'} silent.`);
    return notes;
  }

  function showCheck(report, extraNotes = []) {
    const words = lab.describe(report);
    check.className = `rebuild-check ${extraNotes.length && words.tone === 'good' ? 'review' : words.tone}`;
    checkLine.textContent = local && report.analysis.against !== 'mix' && !words.notes.length
      ? `${parts.length} stems in ${report.stems.length} mix group${report.stems.length === 1 ? '' : 's'}: none of the groups is empty and no two carry the same part.`
      : words.headline;
    checkNotes.replaceChildren(...[...words.notes, ...extraNotes].map((text) => make('li', {}, text)));
    const m = report.metrics;
    const withMix = report.analysis.against === 'mix';
    const lines = [];
    if (withMix) {
      lines.push(`Left over after the best level match: ${m.gainFittedResidualDb.toFixed(1)} dB against the song (more negative is better).`);
      lines.push(`Left over at the saved levels: ${m.exactSumResidualDb.toFixed(1)} dB.`);
      lines.push(`Level correction that fits best: ${m.fittedGain.toFixed(2)}×.`);
    }
    if (m.maxStemCorrelation != null) lines.push(`Most alike pair of ${local ? 'groups' : 'stems'}: ${m.maxStemCorrelation.toFixed(2)} (0 means nothing shared, 1 means the same sound).`);
    for (const stem of report.stems) {
      lines.push(`${stem.id}: ${stem.relativeLevelDb.toFixed(1)} dB against ${withMix ? 'the original mix' : 'the stems together'}${stem.nearEmpty ? ', almost silent' : ''}${stem.durationMismatch ? ', different length' : ''}.`);
    }
    lines.push(`Checked the first ${report.analysis.windowSeconds.toFixed(0)} seconds in mono, in this browser. A good result does not prove a stem holds only its own part.`);
    const list = make('ul');
    list.append(...lines.map((text) => make('li', {}, text)));
    checkNumbers.replaceChildren(make('summary', {}, 'The numbers'), list);
    checkNumbers.classList.remove('hidden');
  }

  // The stems against each other, as soon as they are decoded. Nothing extra is downloaded.
  function checkStemsAlone() {
    if (!lab) return;
    try {
      const report = lab.auditStems({ sampleRate: parts[0].buffer.sampleRate, stems: stemInputs() });
      // Only the numbers are kept; the audio used for the check is dropped.
      stemCheck = { report: { ...report, audio: null }, receipt: lab.toReceipt(report, { sourceFiles: checkSources() }) };
      showCheck(report, fileNotes());
      originalMix = song ? core.pickOriginalMix(song.assets) : null;
      show(compareBtn, Boolean(originalMix));
    } catch (error) {
      console.warn('[MixForge] stem check unavailable', error);
    }
  }

  // The stems against the song's original mix. That mix is downloaded once, only when asked for.
  async function compareWithOriginal() {
    if (!lab || !originalMix) return;
    if ((state._stemDecodesRemaining || 0) > 0) {
      checkLine.textContent = 'MixForge is still loading stems below. Try the comparison again in a moment.';
      return;
    }
    compareBtn.disabled = true;
    stopLeftover();
    try {
      checkLine.textContent = 'Downloading the original mix…';
      const blob = await downloadAsset(originalMix, 'original mix', (percent) => { checkLine.textContent = `Downloading the original mix… ${percent}%`; });
      checkLine.textContent = 'Comparing the stems with the original mix…';
      const ctx = await ensureAudioContext(false);
      const rate = parts[0].buffer.sampleRate;
      const mixBuffer = await resampleTo(await decodeAudioDataSafe(ctx, await blob.arrayBuffer()), rate);
      const report = lab.auditStems({ sampleRate: rate, mix: { channels: channelsOf(mixBuffer), durationSec: mixBuffer.duration }, stems: stemInputs() });
      stemCheck = { report, receipt: lab.toReceipt(report, { sourceFiles: checkSources(originalMix) }) };
      const extra = [];
      // MP3, AAC and similar encodings change the samples, so some leftover is expected even from complete stems.
      if (lab.isLossy(originalMix.label || '', blob.type) || parts.some((p) => lab.isLossy(p.asset?.label || '', p.blob.type))) {
        extra.push('One of these files is MP3, AAC or similar. That encoding alone leaves something over, so judge by ear. WAV gives an exact comparison.');
      }
      showCheck(report, extra);
      // Keep only what is needed to listen to the leftover; the decoded mix itself is dropped.
      leftover = { samples: report.audio.residual, sampleRate: rate, source: null };
      stemCheck.report = { ...report, audio: null };
      leftoverBtn.classList.remove('hidden');
      compareBtn.textContent = 'Compare again';
    } catch (error) {
      console.error('[MixForge] stem comparison failed', error);
      checkLine.textContent = `Could not compare with the original mix: ${error.message}`;
    } finally {
      compareBtn.disabled = false;
    }
  }

  async function playLeftover() {
    if (!leftover) return;
    if (leftover.source) { stopLeftover(); return; }
    stopPreviewTogether();
    if (typeof stopPreview === 'function') stopPreview();
    const ctx = await ensureAudioContext(true);
    const buffer = ctx.createBuffer(1, leftover.samples.length, leftover.sampleRate);
    buffer.copyToChannel(leftover.samples, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => { if (leftover?.source === source) stopLeftover(); };
    leftover.source = source;
    source.start();
    leftoverBtn.textContent = '■ Stop';
  }

  // The current stem balance, summed into one AudioBuffer (turned down evenly only if it would clip).
  function renderMix() {
    const rate = parts[0].buffer.sampleRate;
    const sum = core.sumStems(parts.map((p) => ({ channels: channelsOf(p.buffer), gainDb: p.gainDb, muted: p.muted })), { channels: mixWidth() });
    if (!sum.length) throw new Error('Every stem is muted. Turn at least one back on.');
    const out = state.audioCtx.createBuffer(sum.channels.length, sum.length, rate);
    sum.channels.forEach((ch, c) => out.copyToChannel(ch, c));
    return { buffer: out, trimDb: sum.trimDb };
  }

  function stopLeftover() {
    if (!leftover?.source) return;
    const source = leftover.source;
    leftover.source = null;
    source.onended = null;
    try { source.stop(); } catch (_) {}
    leftoverBtn.textContent = '▶ Hear what the stems leave out';
  }

  function stopPreviewTogether() {
    if (!preview) return;
    for (const src of preview.sources) { try { src.stop(); } catch (_) {} }
    preview = null;
    playBtn.textContent = '▶ Play together';
  }

  async function playTogether() {
    if (preview) { stopPreviewTogether(); return; }
    stopLeftover();
    if (typeof stopPreview === 'function') stopPreview();
    const ctx = await ensureAudioContext(true);
    const when = ctx.currentTime + 0.08;
    const sources = [];
    for (const part of parts) {
      const src = ctx.createBufferSource();
      src.buffer = part.buffer;
      const gain = ctx.createGain();
      gain.gain.value = audibleGain(part);
      part.gainNode = gain;
      src.connect(gain).connect(ctx.destination);
      src.start(when);
      sources.push(src);
    }
    // Play together sums the stems at their levels; MixForge's own master stage handles loudness later.
    sources[0].onended = () => { if (preview && preview.sources === sources) stopPreviewTogether(); };
    preview = { sources };
    playBtn.textContent = '■ Stop';
  }

  const levelText = (db) => `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
  function setLevel(part, db) {
    part.gainDb = Math.max(-24, Math.min(6, Math.round(db * 2) / 2));
    if (part.slider) part.slider.value = String(part.gainDb);
    if (part.valueText) part.valueText.textContent = levelText(part.gainDb);
  }
  function mixChanged() {
    syncAudible();
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save rebuilt mix to this song';
  }

  function renderRows() {
    rows.replaceChildren();
    for (const part of parts) {
      const row = make('div', { class: `rebuild-row${local ? ' rebuild-row-local' : ''}` });
      const name = make('b', { title: part.label }, part.label);
      const slider = make('input', { type: 'range', min: '-24', max: '6', step: '0.5', value: '0', 'aria-label': `${part.name} level` });
      const value = make('span', { class: 'rebuild-db' }, '0.0 dB');
      part.slider = slider;
      part.valueText = value;
      const toggles = make('div', { class: 'rebuild-toggles' });
      const muteLabel = make('label', { class: 'rebuild-mute' });
      const mute = make('input', { type: 'checkbox', 'aria-label': `Mute ${part.name}` });
      muteLabel.append(mute, document.createTextNode(' Mute'));
      const soloLabel = make('label', { class: 'rebuild-mute rebuild-solo', title: 'Listen to this stem on its own. Solo does not change the mix.' });
      const solo = make('input', { type: 'checkbox', 'aria-label': `Solo ${part.name}` });
      soloLabel.append(solo, document.createTextNode(' Solo'));
      toggles.append(muteLabel, soloLabel);
      const apply = () => {
        part.gainDb = Number(slider.value);
        part.muted = mute.checked;
        value.textContent = levelText(part.gainDb);
        mixChanged();
      };
      // A fader the member moved is theirs: MixForge's own level fixes leave it alone from then on.
      slider.addEventListener('input', () => { part.touched = true; autoDelta.delete(part.key); });
      slider.addEventListener('input', apply);
      mute.addEventListener('change', apply);
      solo.addEventListener('change', () => { part.solo = solo.checked; syncAudible(); });
      row.append(name);
      if (local) {
        // Which of the four mix groups this file belongs to. Guessed from its name; the member can correct it.
        const pick = make('select', { class: 'rebuild-role', 'aria-label': `Mix group for ${part.name}` });
        for (const role of ROLES) {
          const option = make('option', { value: role }, STEM_NAMES[role].replace(/ \(.*$/, ''));
          if (role === part.role) option.setAttribute('selected', '');
          pick.append(option);
        }
        pick.value = part.role;
        pick.addEventListener('change', () => { part.role = ROLES.includes(pick.value) ? pick.value : 'other'; describeGroups(); checkStemsAlone(); });
        row.append(pick);
      }
      row.append(slider, value, toggles);
      rows.append(row);
    }
  }

  // ---- Levels. Each mix group's loudness at the current faders, and the moves that would bring a part
  // that is clearly out of range back into range.
  // The plan is always made from the member's own levels (each fader without anything MixForge added),
  // so pressing the button again, or letting Mix and master do it, lands in the same place. The cap on
  // a move is a cap on MixForge's total, not on each press.
  const ownLevel = (part) => part.gainDb - (autoDelta.get(part.key) || 0);
  const atOwnLevel = (part) => (part.muted ? 0 : dbToGain(ownLevel(part)));
  function planLevels() {
    if (!auto || typeof measureLUFS !== 'function') return null;
    const live = parts.filter((p) => !p.muted);
    const buses = rolesWith(live).map((role) => ({ role, lufs: measureLUFS(groupBuffer(role, atOwnLevel)) }));
    return auto.planBalance({ buses });
  }

  // Put the moves on the faders. A group whose fader the member set by hand is left where they put it.
  // Returns what was moved and what was left alone.
  function applyLevelMoves(plan) {
    const moved = [];
    const left = [];
    const wanted = new Map(plan.moves.map((move) => [move.role, move]));
    for (const role of ROLES) {
      const files = parts.filter((p) => p.role === role && !p.muted);
      const move = wanted.get(role);
      if (move && files.some((p) => p.touched)) { left.push(role); continue; }
      let applied = 0;
      for (const part of files) {
        if (part.touched) continue;
        const own = ownLevel(part);
        setLevel(part, own + (move ? move.deltaDb : 0));
        // A fader stops at the end of its travel, so record what it actually moved.
        const delta = Math.round((part.gainDb - own) * 10) / 10;
        if (delta) autoDelta.set(part.key, delta); else autoDelta.delete(part.key);
        if (Math.abs(delta) > Math.abs(applied)) applied = delta;
      }
      if (move && applied) moved.push({ role, deltaDb: applied, reason: move.reason, files: files.map((p) => p.label) });
    }
    levelMoves = moved;
    show(levelsUndoBtn, autoDelta.size > 0);
    mixChanged();
    return { moved, left };
  }

  function setLevelsNow() {
    levelsBtn.disabled = true;
    try {
      const plan = planLevels();
      if (!plan) { levelsLine.textContent = 'Level help is not available in this browser.'; return null; }
      const { moved, left } = applyLevelMoves(plan);
      const kept = left.length ? ` Left the ${left.join(' and ')} where you set ${left.length === 1 ? 'it' : 'them'}.` : '';
      levelsLine.textContent = moved.length
        ? `${moved.map((m) => m.reason).join(' ')}${kept}`
        : (left.length ? `MixForge would have moved the ${left.join(' and ')}, but you set ${left.length === 1 ? 'that fader' : 'those faders'} yourself, so nothing moved.` : plan.summary);
      return plan;
    } catch (error) {
      console.error('[MixForge] set levels failed', error);
      levelsLine.textContent = `Could not set levels: ${error.message}`;
      return null;
    } finally {
      levelsBtn.disabled = false;
    }
  }

  function undoLevels() {
    if (!autoDelta.size) return;
    for (const part of parts) if (autoDelta.has(part.key)) setLevel(part, ownLevel(part));
    autoDelta.clear();
    levelMoves = [];
    show(levelsUndoBtn, false);
    levelsLine.textContent = 'Back to your levels.';
    mixChanged();
  }

  // Sum the stems at their levels and make that the loaded mix. Returns the even turn-down in dB.
  async function loadRebuilt() {
    stopPreviewTogether();
    stopLeftover();
    say('Putting the stems together…');
    const { buffer, trimDb } = renderMix();
    const blob = await encodeWav(buffer, 24, (p) => say(`Preparing the mix… ${p}%`));
    const file = new File([blob], `${song ? (song.title || 'Song') : title()} - ${song ? 'rebuilt from stems' : 'mixed from stems'}.wav`, { type: 'audio/wav', lastModified: Date.now() });
    await loadFile(file);
    if (state.file !== file) throw new Error('MixForge could not open the mix of these stems.');
    // Later saves in this page go to this song, and Forensic Fix reuses these stems (see the wrapper below).
    if (song) state.librarySong = { id: song.id, title: song.title, sourceAssetId: null };
    const live = parts.filter((p) => !p.muted);
    const cache = {};
    state.libraryRebuild = {
      file,
      songId: song?.id || null,
      source: song ? 'song library' : 'your stems',
      roles: rolesWith(live),
      trimDb,
      // Each mix group exactly as it sits in this mix: its files at their fader levels, plus the even
      // turn-down, the same length and width as the loaded mix. MixForge measures and corrects the
      // groups at the level they actually play.
      group(role) {
        if (!cache[role]) {
          const mix = state.original;
          cache[role] = groupBuffer(role, (part) => (part.muted ? 0 : dbToGain(part.gainDb + trimDb)), mix.length, mix.numberOfChannels);
        }
        return cache[role];
      },
    };
    return trimDb;
  }

  const trimNote = (trimDb) => (trimDb < -0.05 ? ` (turned down ${Math.abs(trimDb).toFixed(1)} dB so it does not clip)` : '');

  async function useInMixForge() {
    useBtn.disabled = true;
    try {
      const trimDb = await loadRebuilt();
      say(`The mix of these stems is loaded below${trimNote(trimDb)}. Scan it to pick Quick Master or Forensic Fix.`, 'ok');
      loadPanel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      console.error('[MixForge] rebuild failed', error);
      say(`Could not put the stems together: ${error.message}`, 'error');
    } finally {
      useBtn.disabled = false;
    }
  }

  // The stems are already separate, so this skips separation completely: it fixes levels that are clearly
  // off, hands MixForge's mix stage the four groups, renders the release master, and (for a library song)
  // saves that master to the same song.
  async function mixAndMaster() {
    const gate = globalThis.MixForgeHub?.requireEntitlement?.('forensicStems') || { ok: false, reason: 'login' };
    if (!gate.ok) {
      say(`Mix and master needs a MixForge or Forge Pass license (${gate.reason}). Sign in at the top of the page.`, 'error');
      return;
    }
    masterBtn.disabled = true;
    useBtn.disabled = true;
    lastReceipt = null;
    receiptBtn.classList.add('hidden');
    try {
      let levelsPlan = null;
      if (fixLevelsBox.checked && auto) {
        say('Checking the levels…');
        levelsPlan = setLevelsNow();
      }
      state.mixOptions = { ...(state.mixOptions || {}), rides: Boolean(ridesBox.checked) };
      const trimDb = await loadRebuilt();
      const run = state.libraryRebuild;

      say('Measuring the mix…');
      state.mixMetrics = measureBuffer(state.original);
      const audit = typeof fallbackMixAudit === 'function'
        ? fallbackMixAudit(state.mixMetrics, $('notes')?.value.trim() || '', Number($('targetLufs')?.value || -12))
        : {};
      state.audit = { ...audit, stemsToInspect: [...run.roles] };
      state.mixforgePath = 'forensic';
      if (typeof mfSetPipeline === 'function') mfSetPipeline('forensic');

      // Mix stage, straight from the stems: no upload, no splitting job.
      state.stemBuffers = Object.fromEntries(run.roles.map((role) => [role, run.group(role)]));
      state.separationInfo = { engine: run.source, mode: song ? 'saved stems' : 'stems from your DAW' };
      say(`Planning the mix for ${run.roles.join(', ')}…`);
      await buildStemPlans();
      renderStemPlans();
      reveal('stemPanel');

      say('Mixing: placing each group against the others…');
      state.corrected = await rebuildCorrectedMix();
      state.correctedMetrics = measureBuffer(state.corrected);
      prepareMastering();

      say('Mastering for release…');
      setStatus('masterStatus', 'Rendering tonal balance, dynamics, loudness and look-ahead limiting…', 'busy');
      state.master = null;
      state.finalMetrics = null;
      state.masterDirty = true;
      state.master = await renderReleaseMaster();
      markMasterRendered(state.master);
      state.finalMetrics = measureBuffer(state.master);
      renderMetrics('finalMetrics', state.finalMetrics);
      renderVerification(state.finalMetrics, state.masterPlan);
      reveal('previewBox');
      reveal('verifyPanel');
      setStatus('masterStatus', 'Release master rendered from the stems and measured again after limiting.', 'ok');

      const target = Number($('targetLufs')?.value || -12);
      const keyParts = parts.map((p) => ({ assetId: p.asset?.id || p.key, gainDb: p.gainDb, muted: p.muted }));
      const source = core.rebuildSourceKey(keyParts, { kind: 'master', extra: String(target) });
      // A master goes onto the song only if it passes the same hard checks as Download release WAV
      // (no clipping, peak under the ceiling). If the check itself is missing, nothing is saved.
      const gateResult = typeof evaluateExportGate === 'function'
        ? evaluateExportGate(state)
        : { allow: false, verified: false, message: 'MixForge could not run its release checks on this master.' };
      const receiptFor = (saved) => core.buildRunReceipt({
        song: song || { id: null, title: title() },
        sourceNote: song ? undefined : 'your own stems, read in the browser; nothing uploaded and nothing split',
        trimDb, targetLufs: target, gate: gateResult, saved,
        parts: parts.map((p) => ({ name: p.name, role: p.role, assetId: p.asset?.id || null, gainDb: p.gainDb, muted: p.muted })),
        levels: { fixedByMixForge: levelMoves.map((m) => ({ ...m })), vocalAgainstBandLu: levelsPlan?.lead || null },
        stemCheck: stemCheck?.receipt || null,
        corrections: globalThis.mixForgeCriticGate?.receipts || [],
        masterPlan: state.masterPlan, finalMetrics: state.finalMetrics,
        truePeakDb: state.masterConstraint?.truePeakDb ?? null,
      });
      const done = (text, kind) => {
        receiptBtn.classList.remove('hidden');
        say(text, kind);
        $('verifyPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      if (!song) {
        lastReceipt = receiptFor({ toSong: false, kind: 'master', source: null, reason: gateResult.allow ? 'These stems are not a library song, so the master is yours to download.' : gateResult.message });
        done(gateResult.allow
          ? `Mixed and mastered${trimNote(trimDb)}. Listen below, then download the release WAV.`
          : `Mixed and mastered${trimNote(trimDb)}, but the master did not pass its release checks: ${gateResult.message} Listen below and check the release verification.`,
        gateResult.allow ? 'ok' : 'error');
        return;
      }
      if (!gateResult.allow) {
        lastReceipt = receiptFor({ toSong: false, kind: 'master', source, reason: gateResult.message });
        done(`Mixed and mastered${trimNote(trimDb)}, but not saved to “${title()}”: ${gateResult.message} Listen below and check the release verification.`, 'error');
        return;
      }

      // Save the master to the same song (16-bit keeps the upload small; Download release WAV still gives 24-bit).
      say(`Saving the master to “${title()}”…`);
      const blob = await encodeWav(state.master, 16, (p) => say(`Preparing the master WAV… ${p}%`));
      await library.saveFile(song.id, {
        kind: 'master', blob: new File([blob], 'mixforge-master.wav', { type: 'audio/wav' }),
        label: 'MixForge master', durationSec: state.master.duration, source,
      });
      lastReceipt = receiptFor({ toSong: true, kind: 'master', source });
      done(`Mixed and mastered${trimNote(trimDb)}, and saved to “${title()}” as its release master. Listen below, or download the 24-bit WAV.`, 'ok');
    } catch (error) {
      console.error('[MixForge] mix and master failed', error);
      say(`Mix and master stopped: ${error.message}`, 'error');
    } finally {
      masterBtn.disabled = false;
      useBtn.disabled = false;
    }
  }

  async function saveToSong() {
    if (!song) return;
    saveBtn.disabled = true;
    try {
      stopPreviewTogether();
      sayBelow('Putting the stems back together…');
      const { buffer } = renderMix();
      // 16-bit keeps the upload near 10 MB a minute; MixForge's release master is still exported at 24-bit.
      const blob = await encodeWav(buffer, 16, (p) => sayBelow(`Preparing the WAV… ${p}%`));
      sayBelow(`Saving the rebuilt mix (${library.formatBytes(blob.size)}) to “${song.title || 'this song'}”…`);
      const source = core.rebuildSourceKey(parts.map((p) => ({ assetId: p.asset.id, gainDb: p.gainDb, muted: p.muted })));
      await library.saveFile(song.id, {
        kind: 'mix', blob: new File([blob], 'rebuilt-from-stems.wav', { type: 'audio/wav' }),
        label: 'Rebuilt from stems', durationSec: buffer.duration, source,
      });
      sayBelow(`Saved to “${song.title || 'this song'}” as its mix. It plays from My song library.`, 'ok');
      saveBtn.textContent = 'Saved to this song';
    } catch (error) {
      console.error('[MixForge] rebuild save failed', error);
      sayBelow(`Not saved: ${error.message}`, 'error');
      saveBtn.disabled = false;
    }
  }

  function downloadReceipt() {
    if (!lastReceipt) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(lastReceipt, null, 2)], { type: 'application/json' }));
    const link = make('a', { href: url, download: `mixforge-receipt-${String(title()).replace(/[^a-z0-9._-]+/gi, '_').slice(0, 60)}-${lastReceipt.generatedAt.slice(0, 10)}.json` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Which groups the stems fill, in words, and what a missing group means for the mix.
  function describeGroups() {
    const have = rolesWith(parts);
    if (song) {
      const missing = core.missingStems(parts.map((p) => p.name));
      show(note, missing.length > 0);
      if (missing.length) note.textContent = `No ${missing.join(', ')} stem on this song, so the rebuilt mix will not have ${missing.length === 1 ? 'that part' : 'those parts'}.`;
      return;
    }
    const lines = [];
    if (!have.includes('vocals')) lines.push('Nothing is marked as vocals, so MixForge will build the mix around the instruments and there is no vocal to ride.');
    const empty = ROLES.filter((role) => role !== 'vocals' && !have.includes(role));
    if (empty.length) lines.push(`Nothing is marked as ${empty.join(' or ')}. That is fine if the song has none; otherwise change a file's group.`);
    show(note, lines.length > 0);
    note.textContent = lines.join(' ');
  }

  // Start again with a clean desk (a second set of files, or a different song).
  function resetDesk() {
    stopPreviewTogether();
    stopLeftover();
    parts = [];
    originalMix = null;
    stemCheck = null;
    leftover = null;
    lastReceipt = null;
    levelMoves = [];
    autoDelta.clear();
    rows.replaceChildren();
    for (const node of [note, levels, check, options, actions, receiptBtn, compareBtn, leftoverBtn, levelsUndoBtn, checkNumbers, soloNote]) show(node, false);
    levelsLine.textContent = 'MixForge can move a part that is clearly too quiet or too loud. Everything else stays where you put it.';
    sayBelow('', '');
  }

  function deskReady(message) {
    renderRows();
    describeGroups();
    checkStemsAlone();
    if (lab && stemCheck) show(check, true);
    show(levels, Boolean(auto) && typeof measureLUFS === 'function');
    show(options, Boolean(auto));
    show(saveBtn, Boolean(song));
    show(libLink, Boolean(song));
    show(actions, true);
    say(message, 'ok');
  }

  async function open() {
    attachPanel();
    try {
      song = await fetchSong(songId);
      local = null;
      heading.textContent = `Put “${song.title || 'Untitled song'}” back together`;
      const picked = core.pickStems(song.assets);
      if (!picked.length) {
        say('This song has no stems saved yet. Run a separation in MixForge, save the stems, then come back.', 'error');
        return;
      }
      const ctx = await ensureAudioContext(false);
      state._stemDecodesRemaining = 0; // these decodes are not a separation, so keep their own length
      const loaded = [];
      for (const [i, { name, asset }] of picked.entries()) {
        const blob = await downloadStem(asset, name, i + 1, picked.length);
        say(`Decoding the ${name} stem (${i + 1} of ${picked.length})…`);
        const buffer = await decodeAudioDataSafe(ctx, await blob.arrayBuffer());
        // A stem saved under another name (guitar, piano) goes with "other", which is where the mix stage puts it.
        const role = ROLES.includes(name) ? name : 'other';
        loaded.push({ key: asset.id, name, label: STEM_NAMES[name] || name, role, asset, blob, buffer, gainDb: 0, muted: false, solo: false, gainNode: null });
      }
      const rate = loaded[0].buffer.sampleRate;
      for (const part of loaded) part.buffer = await resampleTo(part.buffer, rate);
      parts = loaded;
      const minutes = Math.max(...parts.map((p) => p.buffer.duration)) / 60;
      deskReady(`${parts.length} stem${parts.length === 1 ? '' : 's'} ready (${minutes.toFixed(1)} min). Set the levels, press Play together, then Mix and master. No splitting needed.`);
    } catch (error) {
      console.error('[MixForge] rebuild open failed', error);
      if (error.status === 401 || error.status === 402) {
        say(error.message, 'error');
        // Signed out: sign in and come straight back to this same song.
        if (error.status === 401 && typeof library.signInUrl === 'function') {
          const signIn = make('a', { class: 'primary library-rebuild', id: 'rebuildSignInLink', href: library.signInUrl() }, 'Sign in and come back to this song');
          const row = make('div', { class: 'actions library-rebuild-row' });
          row.append(signIn);
          panel.append(row);
        }
      }
      else if (error.status === 404) say('That song is not in your library. It may belong to another account. Nothing was changed.', 'error');
      else say(`Could not open the stems: ${error.message}`, 'error');
    }
  }

  // Your own stems from your DAW: read here, never uploaded. Each file is given a mix group from its name.
  async function openLocal(fileList) {
    const files = [...(fileList || [])].filter((f) => f && f.size > 0);
    attachPanel();
    resetDesk();
    song = null;
    local = { title: core.commonTitle(files.map((f) => f.name)) };
    heading.textContent = 'Mix your stems';
    intro.textContent = 'Your stems stay in this browser: nothing is uploaded and nothing is split. Check each one’s group, set levels, hear them together, then Mix and master.';
    panel.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    if (files.length < 2) {
      say('Choose at least two stem files. For one finished mix, use “Choose a mix” below instead.', 'error');
      return;
    }
    if (files.length > MAX_LOCAL_FILES) {
      say(`That is ${files.length} files. MixForge mixes up to ${MAX_LOCAL_FILES} stems at once; bounce related tracks together first (for example all the drums to one stem).`, 'error');
      return;
    }
    try {
      const ctx = await ensureAudioContext(false);
      state._stemDecodesRemaining = 0; // these decodes are not a separation, so keep their own length
      const loaded = [];
      let bytes = 0;
      for (const [i, file] of files.entries()) {
        say(`Reading “${file.name}” (${i + 1} of ${files.length})…`);
        let buffer;
        try {
          buffer = await decodeAudioDataSafe(ctx, await file.arrayBuffer());
        } catch (error) {
          throw new Error(`“${file.name}” could not be read as audio (${error.message || 'unsupported file'}).`);
        }
        bytes += buffer.length * Math.min(2, buffer.numberOfChannels) * 4;
        if (bytes > MAX_DECODED_BYTES) {
          throw new Error('These stems add up to more audio than a browser tab can hold. Bounce them down to fewer stems (for example Vocals, Drums, Bass, Guitars, Keys) and try again.');
        }
        const label = String(file.name).replace(/\.[a-z0-9]{2,5}$/i, '');
        loaded.push({ key: `local-${i}`, name: label, label, role: auto ? auto.guessRole(file.name) : 'other', asset: null, blob: file, buffer, gainDb: 0, muted: false, solo: false, gainNode: null });
      }
      const rate = loaded[0].buffer.sampleRate;
      for (const part of loaded) part.buffer = await resampleTo(part.buffer, rate);
      // Keep the groups together in the list: vocals, drums, bass, then everything else.
      parts = loaded.sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role));
      const minutes = Math.max(...parts.map((p) => p.buffer.duration)) / 60;
      deskReady(`${parts.length} stems ready (${minutes.toFixed(1)} min). Check each one’s group, press Play together, then Mix and master.`);
    } catch (error) {
      console.error('[MixForge] local stems failed', error);
      parts = [];
      say(`Could not open these stems: ${error.message}`, 'error');
    }
  }

  playBtn.addEventListener('click', () => { void playTogether().catch((error) => say(`Could not play: ${error.message}`, 'error')); });
  masterBtn.addEventListener('click', () => { void mixAndMaster(); });
  useBtn.addEventListener('click', () => { void useInMixForge(); });
  saveBtn.addEventListener('click', () => { void saveToSong(); });
  compareBtn.addEventListener('click', () => { void compareWithOriginal(); });
  leftoverBtn.addEventListener('click', () => { void playLeftover().catch((error) => { checkLine.textContent = `Could not play: ${error.message}`; }); });
  receiptBtn.addEventListener('click', downloadReceipt);
  levelsBtn.addEventListener('click', () => { setLevelsNow(); });
  levelsUndoBtn.addEventListener('click', undoLevels);

  // Forensic Fix on a mix made here: hand over the groups these stems already give. The song is never split:
  // the stem list becomes exactly the groups on the desk (a scan asking for one that is not there works without it).
  if (typeof separateRequiredStems === 'function') {
    const previousSeparate = separateRequiredStems;
    separateRequiredStems = async function separateFromLibraryStems(stems, onProgress) {
      const run = state.libraryRebuild;
      const saved = run ? run.roles : [];
      if (!run || state.file !== run.file || !saved.length || !Array.isArray(stems)) {
        return previousSeparate(stems, onProgress);
      }
      const asked = stems.map((s) => (typeof normalizeStemName === 'function' ? normalizeStemName(s) : s) || s);
      const missing = asked.filter((n) => !saved.includes(n));
      // The caller loops over this same list, so set it to the groups on the desk in place.
      stems.splice(0, stems.length, ...saved);
      onProgress?.(`Using the stems already ${run.songId ? 'saved on this song' : 'on the desk'}. No new separation${missing.length ? ` (there is no ${missing.join(', ')} here)` : ''}.`);
      const outputs = {};
      for (const role of stems) {
        // The separate step downloads and decodes each stem, so each group is handed over as a WAV in memory.
        const blob = await encodeWav(run.group(role), 24, (p) => onProgress?.(`Preparing the ${role} group… ${p}%`));
        const url = URL.createObjectURL(blob);
        outputs[role] = url;
        setTimeout(() => URL.revokeObjectURL(url), 30 * 60 * 1000);
      }
      // The separate step decodes each stem once; the upload module's decode hook lines them up with the mix.
      state._stemDecodesRemaining = stems.length;
      state.separationInfo = { engine: run.source, mode: run.songId ? 'saved stems' : 'stems from your DAW' };
      return outputs;
    };
  }

  // ---- The second door: stem files chosen from disk, or several files dropped at once.
  if (stemFilesBtn && stemFilesInput) {
    stemFilesBtn.addEventListener('click', () => {
      stemFilesInput.value = '';
      stemFilesInput.click();
    });
    stemFilesInput.addEventListener('change', (event) => { void openLocal(event.target.files); });
    const dropzone = $('dropzone');
    if (dropzone) {
      // One dropped file is a mix (the existing behaviour). Two or more are stems, and never reach the single-file loader.
      dropzone.addEventListener('drop', (event) => {
        const dropped = event.dataTransfer?.files;
        if (!dropped || dropped.length < 2) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        dropzone.classList.remove('drag');
        void openLocal(dropped);
      }, true);
    }
  }

  if (fromLibrary) void open();
  globalThis.MixForgeStemDesk = { openLocal };
})();
