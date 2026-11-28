'use strict';

// Rebuild a song from the stems saved in the shared song library:
//   https://mixforge.workinwithai.com/?song=<songId>&rebuild=stems
// MixForge fetches the song's stems (short-lived signed links), lines them up, and shows a small stem mixer:
// a level and mute per stem, and Play together. Then the member can
//   - "Mix and master": the stems are already split, so MixForge skips separation entirely. It measures each
//     stem, applies its stem repairs, rebuilds the mix, renders the release master, and saves that master
//     to the same library song;
//   - "Load as one mix only": the summed stems become the loaded mix for the normal Scan / Quick Master path;
//     Forensic Fix on it reuses these stems and never splits the song again;
//   - "Save rebuilt mix to this song": a 16-bit WAV of the plain sum is added to the same song as its mix.
// The song keeps its id (no new song is made).
(() => {
  const library = globalThis.MixForgeSongLibrary;
  const core = globalThis.MixForgeStemRebuildCore;
  if (!library || !core || typeof loadFile !== 'function') return;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const params = new URLSearchParams(location.search);
  const songId = (params.get('song') || '').trim().toLowerCase();
  if (params.get('rebuild') !== 'stems' || !UUID.test(songId)) return;

  const STEM_NAMES = { vocals: 'Vocals', drums: 'Drums', bass: 'Bass', other: 'Other (guitars, keys, the rest)' };
  const make = (tag, attrs = {}, text = '') => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value;
      else node.setAttribute(key, value);
    }
    if (text) node.textContent = text;
    return node;
  };

  // ---- Panel, placed above "Load your mix".
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
  const note = make('p', { class: 'rebuild-note hidden', id: 'rebuildMissing' });
  const actions = make('div', { class: 'actions rebuild-actions hidden', id: 'rebuildActions' });
  const playBtn = make('button', { class: 'secondary', type: 'button', id: 'rebuildPlayBtn' }, '▶ Play together');
  const masterBtn = make('button', { class: 'primary', type: 'button', id: 'rebuildMasterBtn' }, 'Mix and master');
  const useBtn = make('button', { class: 'secondary', type: 'button', id: 'rebuildUseBtn' }, 'Load as one mix only');
  const saveBtn = make('button', { class: 'secondary', type: 'button', id: 'rebuildSaveBtn' }, 'Save rebuilt mix to this song');
  const libLink = make('a', { class: 'library-link', href: `/library.html?song=${encodeURIComponent(songId)}` }, 'Back to this song in my library');
  actions.append(playBtn, masterBtn, useBtn, saveBtn, libLink);
  const saveStatus = make('div', { class: 'status', id: 'rebuildSaveStatus', 'aria-live': 'polite' });
  panel.append(titleRow, status, rows, note, actions, saveStatus);
  const loadPanel = $('loadPanel');
  (loadPanel?.parentNode || document.querySelector('main') || document.body).insertBefore(panel, loadPanel || null);

  const say = (message, kind = 'busy') => { status.textContent = message; status.className = `status ${kind}`.trim(); };
  const sayBelow = (message, kind = 'busy') => { saveStatus.textContent = message; saveStatus.className = `status ${kind}`.trim(); };

  let song = null;
  let parts = []; // { name, asset, blob, buffer, gainDb, muted, gainNode }
  let preview = null; // { sources: AudioBufferSourceNode[] }

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

  async function downloadStem(asset, label, index, total) {
    const { playUrl } = await library.call('play', { songId: song.id, assetId: asset.id });
    const response = await fetch(playUrl);
    if (!response.ok) throw new Error(`Could not read the ${label} stem (${response.status}).`);
    const size = Number(response.headers.get('content-length')) || Number(asset.size) || 0;
    if (!response.body || !size) return new Blob([await response.arrayBuffer()], { type: 'audio/wav' });
    const reader = response.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      say(`Downloading the ${label} stem (${index} of ${total})… ${Math.min(100, Math.round(got / size * 100))}%`);
    }
    return new Blob(chunks, { type: 'audio/wav' });
  }

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

  // The current stem balance, summed into one AudioBuffer (turned down evenly only if it would clip).
  function renderMix() {
    const rate = parts[0].buffer.sampleRate;
    const width = Math.max(...parts.map((p) => Math.min(2, p.buffer.numberOfChannels)));
    const sum = core.sumStems(parts.map((p) => ({ channels: channelsOf(p.buffer), gainDb: p.gainDb, muted: p.muted })), { channels: width });
    if (!sum.length) throw new Error('Every stem is muted. Turn at least one back on.');
    const out = state.audioCtx.createBuffer(sum.channels.length, sum.length, rate);
    sum.channels.forEach((ch, c) => out.copyToChannel(ch, c));
    return { buffer: out, trimDb: sum.trimDb };
  }

  function stopPreviewTogether() {
    if (!preview) return;
    for (const src of preview.sources) { try { src.stop(); } catch (_) {} }
    preview = null;
    playBtn.textContent = '▶ Play together';
  }

  async function playTogether() {
    if (preview) { stopPreviewTogether(); return; }
    if (typeof stopPreview === 'function') stopPreview();
    const ctx = await ensureAudioContext(true);
    const when = ctx.currentTime + 0.08;
    const sources = [];
    for (const part of parts) {
      const src = ctx.createBufferSource();
      src.buffer = part.buffer;
      const gain = ctx.createGain();
      gain.gain.value = part.muted ? 0 : dbToGain(part.gainDb);
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

  function renderRows() {
    rows.replaceChildren();
    for (const part of parts) {
      const row = make('div', { class: 'rebuild-row' });
      const name = make('b', {}, STEM_NAMES[part.name] || part.name);
      const slider = make('input', { type: 'range', min: '-24', max: '6', step: '0.5', value: '0', 'aria-label': `${part.name} level` });
      const value = make('span', { class: 'rebuild-db' }, '0.0 dB');
      const muteLabel = make('label', { class: 'rebuild-mute' });
      const mute = make('input', { type: 'checkbox', 'aria-label': `Mute ${part.name}` });
      muteLabel.append(mute, document.createTextNode(' Mute'));
      const apply = () => {
        part.gainDb = Number(slider.value);
        part.muted = mute.checked;
        value.textContent = `${part.gainDb > 0 ? '+' : ''}${part.gainDb.toFixed(1)} dB`;
        if (part.gainNode) part.gainNode.gain.value = part.muted ? 0 : dbToGain(part.gainDb);
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save rebuilt mix to this song';
      };
      slider.addEventListener('input', apply);
      mute.addEventListener('change', apply);
      row.append(name, slider, value, muteLabel);
      rows.append(row);
    }
  }

  // Sum the stems at their levels and make that the loaded mix. Returns the even turn-down in dB.
  async function loadRebuilt() {
    stopPreviewTogether();
    say('Putting the stems back together…');
    const { buffer, trimDb } = renderMix();
    const blob = await encodeWav(buffer, 24, (p) => say(`Preparing the rebuilt mix… ${p}%`));
    const file = new File([blob], `${song.title || 'Song'} - rebuilt from stems.wav`, { type: 'audio/wav', lastModified: Date.now() });
    await loadFile(file);
    if (state.file !== file) throw new Error('MixForge could not open the rebuilt mix.');
    // Later saves in this page go to this song, and Forensic Fix reuses these stems (see the wrapper below).
    state.librarySong = { id: song.id, title: song.title, sourceAssetId: null };
    state.libraryRebuild = {
      file,
      songId: song.id,
      stems: Object.fromEntries(parts.filter((p) => !p.muted).map((p) => [p.name, p.blob])),
      // Each stem's level in the rebuilt mix, including any even turn-down, so MixForge measures
      // and repairs the stems at the level they actually play in this mix.
      gains: Object.fromEntries(parts.filter((p) => !p.muted).map((p) => [p.name, p.gainDb + trimDb])),
      applyGainsPending: false,
    };
    return trimDb;
  }

  const trimNote = (trimDb) => (trimDb < -0.05 ? ` (turned down ${Math.abs(trimDb).toFixed(1)} dB so it does not clip)` : '');

  async function useInMixForge() {
    useBtn.disabled = true;
    try {
      const trimDb = await loadRebuilt();
      say(`The rebuilt mix is loaded below${trimNote(trimDb)}. Scan it to pick Quick Master or Forensic Fix.`, 'ok');
      loadPanel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      console.error('[MixForge] rebuild failed', error);
      say(`Could not rebuild the mix: ${error.message}`, 'error');
    } finally {
      useBtn.disabled = false;
    }
  }

  // One stem at its level in the rebuilt mix, the same length and width as the loaded mix.
  function stemAtMixLevel(part, gainDb) {
    const mix = state.original;
    const out = state.audioCtx.createBuffer(mix.numberOfChannels, mix.length, mix.sampleRate);
    const g = dbToGain(gainDb);
    for (let c = 0; c < mix.numberOfChannels; c++) {
      const src = part.buffer.getChannelData(Math.min(c, part.buffer.numberOfChannels - 1));
      const dest = out.getChannelData(c);
      const n = Math.min(src.length, dest.length);
      for (let i = 0; i < n; i++) dest[i] = src[i] * g;
    }
    return out;
  }

  // The stems are already split, so this skips separation completely: it hands MixForge's stem stage
  // the saved stems, applies the stem repairs, rebuilds the mix, renders the release master,
  // and saves that master to the same library song.
  async function mixAndMaster() {
    const gate = globalThis.MixForgeHub?.requireEntitlement?.('forensicStems') || { ok: false, reason: 'login' };
    if (!gate.ok) {
      say(`Mix and master needs a MixForge or Forge Pass license (${gate.reason}). Sign in at the top of the page.`, 'error');
      return;
    }
    masterBtn.disabled = true;
    useBtn.disabled = true;
    try {
      const trimDb = await loadRebuilt();
      const run = state.libraryRebuild;
      const live = parts.filter((p) => !p.muted);

      say('Measuring the rebuilt mix…');
      state.mixMetrics = measureBuffer(state.original);
      const audit = typeof fallbackMixAudit === 'function'
        ? fallbackMixAudit(state.mixMetrics, $('notes')?.value.trim() || '', Number($('targetLufs')?.value || -12))
        : {};
      state.audit = { ...audit, stemsToInspect: live.map((p) => p.name) };
      state.mixforgePath = 'forensic';
      if (typeof mfSetPipeline === 'function') mfSetPipeline('forensic');

      // Stem stage, straight from the library: no upload, no separation job.
      state.stemBuffers = Object.fromEntries(live.map((p) => [p.name, stemAtMixLevel(p, run.gains[p.name])]));
      state.separationInfo = { engine: 'song library', mode: 'saved stems' };
      say(`Planning repairs for ${live.map((p) => p.name).join(', ')}…`);
      await buildStemPlans();
      renderStemPlans();
      reveal('stemPanel');

      say('Mixing: applying the stem repairs and rebuilding the song…');
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
      setStatus('masterStatus', 'Release master rendered from the saved stems and measured again after limiting.', 'ok');

      // Save the master to the same song (16-bit keeps the upload small; Download release WAV still gives 24-bit).
      say(`Saving the master to “${song.title || 'this song'}”…`);
      const target = Number($('targetLufs')?.value || -12);
      const blob = await encodeWav(state.master, 16, (p) => say(`Preparing the master WAV… ${p}%`));
      const source = core.rebuildSourceKey(parts.map((p) => ({ assetId: p.asset.id, gainDb: p.gainDb, muted: p.muted })), { kind: 'master', extra: String(target) });
      await library.saveFile(song.id, {
        kind: 'master', blob: new File([blob], 'mixforge-master.wav', { type: 'audio/wav' }),
        label: 'MixForge master', durationSec: state.master.duration, source,
      });
      say(`Mixed and mastered${trimNote(trimDb)}, and saved to “${song.title || 'this song'}” as its release master. Listen below, or download the 24-bit WAV.`, 'ok');
      $('verifyPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      console.error('[MixForge] mix and master failed', error);
      say(`Mix and master stopped: ${error.message}`, 'error');
    } finally {
      masterBtn.disabled = false;
      useBtn.disabled = false;
    }
  }

  async function saveToSong() {
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

  async function open() {
    try {
      song = await fetchSong(songId);
      heading.textContent = `Put “${song.title || 'Untitled song'}” back together`;
      const picked = core.pickStems(song.assets);
      if (!picked.length) {
        say('This song has no stems saved yet. Run a separation in MixForge, save the stems, then come back.', 'error');
        return;
      }
      const missing = core.missingStems(picked.map((p) => p.name));
      if (missing.length) {
        note.textContent = `No ${missing.join(', ')} stem on this song, so the rebuilt mix will not have ${missing.length === 1 ? 'that part' : 'those parts'}.`;
        note.classList.remove('hidden');
      }
      const ctx = await ensureAudioContext(false);
      state._stemDecodesRemaining = 0; // these decodes are not a separation, so keep their own length
      const loaded = [];
      for (const [i, { name, asset }] of picked.entries()) {
        const blob = await downloadStem(asset, name, i + 1, picked.length);
        say(`Decoding the ${name} stem (${i + 1} of ${picked.length})…`);
        const buffer = await decodeAudioDataSafe(ctx, await blob.arrayBuffer());
        loaded.push({ name, asset, blob, buffer, gainDb: 0, muted: false, gainNode: null });
      }
      const rate = loaded[0].buffer.sampleRate;
      for (const part of loaded) part.buffer = await resampleTo(part.buffer, rate);
      parts = loaded;
      renderRows();
      actions.classList.remove('hidden');
      const minutes = Math.max(...parts.map((p) => p.buffer.duration)) / 60;
      say(`${parts.length} stem${parts.length === 1 ? '' : 's'} ready (${minutes.toFixed(1)} min). Set the levels, press Play together, then Mix and master. No splitting needed.`, 'ok');
    } catch (error) {
      console.error('[MixForge] rebuild open failed', error);
      if (error.status === 401 || error.status === 402) say(error.message, 'error');
      else if (error.status === 404) say('That song is not in your library. It may belong to another account. Nothing was changed.', 'error');
      else say(`Could not open the stems: ${error.message}`, 'error');
    }
  }

  playBtn.addEventListener('click', () => { void playTogether().catch((error) => say(`Could not play: ${error.message}`, 'error')); });
  masterBtn.addEventListener('click', () => { void mixAndMaster(); });
  useBtn.addEventListener('click', () => { void useInMixForge(); });
  saveBtn.addEventListener('click', () => { void saveToSong(); });

  // Forensic Fix on a rebuilt mix: hand over the stems this song already has. The song is never split again:
  // the stem list becomes exactly the saved stems (a scan asking for a stem the song lacks just works without it).
  if (typeof separateRequiredStems === 'function') {
    const previousSeparate = separateRequiredStems;
    separateRequiredStems = async function separateFromLibraryStems(stems, onProgress) {
      const run = state.libraryRebuild;
      const saved = run ? Object.keys(run.stems) : [];
      if (!run || state.file !== run.file || !saved.length || !Array.isArray(stems)) {
        return previousSeparate(stems, onProgress);
      }
      const asked = stems.map((s) => (typeof normalizeStemName === 'function' ? normalizeStemName(s) : s) || s);
      const missing = asked.filter((n) => !saved.includes(n));
      // The caller loops over this same list, so set it to the saved stems in place.
      stems.splice(0, stems.length, ...saved);
      onProgress?.(`Using the stems already saved on this song. No new separation${missing.length ? ` (this song has no ${missing.join(', ')} stem)` : ''}.`);
      const outputs = {};
      stems.forEach((name) => {
        const url = URL.createObjectURL(run.stems[name]);
        outputs[name] = url;
        setTimeout(() => URL.revokeObjectURL(url), 30 * 60 * 1000);
      });
      // The separate step decodes each stem once; the upload module's decode hook lines them up with the mix.
      state._stemDecodesRemaining = stems.length;
      state.separationInfo = { engine: 'song library', mode: 'saved stems' };
      run.applyGainsPending = true;
      return outputs;
    };
  }

  // Right after those stems are decoded, set each to its level in the rebuilt mix before MixForge measures it.
  if (typeof buildStemPlans === 'function') {
    const previousBuild = buildStemPlans;
    buildStemPlans = async function buildStemPlansAtRebuildLevels(...args) {
      const run = state.libraryRebuild;
      if (run?.applyGainsPending && state.file === run.file) {
        run.applyGainsPending = false;
        for (const [name, buffer] of Object.entries(state.stemBuffers || {})) {
          const gainDb = run.gains[normalizeStemName(name) || name];
          if (!Number.isFinite(gainDb) || Math.abs(gainDb) < 0.01) continue;
          const g = dbToGain(gainDb);
          for (let c = 0; c < buffer.numberOfChannels; c++) {
            const data = buffer.getChannelData(c);
            for (let i = 0; i < data.length; i++) data[i] *= g;
          }
        }
      }
      return previousBuild.apply(this, args);
    };
  }

  void open();
})();
