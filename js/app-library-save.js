'use strict';

// "Save to my song library" after a separation: keeps the original mix and every returned stem
// on one song record so any WorkinWithAI music tool can open them later without a new upload.
(() => {
  const library = globalThis.MixForgeSongLibrary;
  if (!library || typeof separateRequiredStems !== 'function') return;

  // Remember the stems the last separation returned (signed links stay valid for about an hour).
  const previousSeparate = separateRequiredStems;
  separateRequiredStems = async function separateAndRemember(stems, onProgress) {
    const outputs = await previousSeparate(stems, onProgress);
    state.lastSeparation = { outputs: { ...(outputs || {}) }, stems: [...stems], at: Date.now(), songId: null, savedParts: [], savedSongId: null };
    showSaveButton();
    return outputs;
  };

  function ensureControls() {
    const panel = $('stemPanel');
    if (!panel || $('librarySaveBtn')) return;
    const row = document.createElement('div');
    row.className = 'actions library-save-row';
    row.innerHTML = '<button class="secondary" id="librarySaveBtn" type="button">Save mix + stems to my song library</button>'
      + '<a class="library-link" href="/library.html">Open my song library</a>';
    const status = document.createElement('div');
    status.className = 'status';
    status.id = 'librarySaveStatus';
    status.setAttribute('aria-live', 'polite');
    panel.append(row, status);
    $('librarySaveBtn').addEventListener('click', () => { void saveToLibrary(); });
  }

  function showSaveButton() {
    ensureControls();
    const button = $('librarySaveBtn');
    if (!button) return;
    const saved = Boolean(state.lastSeparation?.savedSongId);
    button.disabled = saved;
    button.textContent = saved ? 'Saved to your song library' : 'Save mix + stems to my song library';
  }

  async function saveToLibrary() {
    const run = state.lastSeparation;
    if (!run || run.savedSongId) return;
    const button = $('librarySaveBtn');
    button.disabled = true;
    const say = (message, kind = 'busy') => setStatus('librarySaveStatus', message, kind);
    try {
      if (Date.now() - run.at > 55 * 60 * 1000) throw new Error('These stems are more than an hour old. Run the separation again, then save.');
      const title = library.titleFromFileName(state.file?.name);
      // A retry after a dropped connection keeps filling the same song instead of making a second one.
      if (!run.songId) {
        say(`Creating “${title}” in your song library…`);
        run.songId = (await library.call('create-song', { title, room: 'mix' })).song.id;
        run.savedParts = [];
      }
      const song = { id: run.songId };
      if (state.file && !run.savedParts.includes('mix')) {
        say(`Saving the original mix (${library.formatBytes(state.file.size)})…`);
        await library.saveFile(song.id, {
          kind: 'mix', blob: state.file, label: 'Original mix', durationSec: state.original?.duration || null,
        });
        run.savedParts.push('mix');
      }
      for (const stem of run.stems) {
        const url = run.outputs[stem];
        if (!url || run.savedParts.includes(stem)) continue;
        say(`Saving the ${stem} stem…`);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Could not read the ${stem} stem (${response.status}).`);
        const blob = await response.blob();
        await library.saveFile(song.id, {
          kind: 'stem', stem, blob: new Blob([blob], { type: 'audio/wav' }), label: stem,
          durationSec: state.original?.duration || null,
        });
        run.savedParts.push(stem);
      }
      run.savedSongId = song.id;
      say(`Saved “${title}” with ${run.stems.length} stem${run.stems.length === 1 ? '' : 's'}. Open it any time from My song library.`, 'ok');
    } catch (error) {
      console.error('[MixForge] song library save failed', error);
      say(`Not saved: ${error.message}`, 'error');
    } finally {
      showSaveButton();
    }
  }
})();
