'use strict';

// My song library: every saved song, each opening to its mix and stems, played in the page.
// Audio streams from short-lived signed links (the browser fetches ranges as it plays),
// so nothing is downloaded until the member taps Save.
(() => {
  const library = globalThis.MixForgeSongLibrary;
  const $ = (id) => document.getElementById(id);
  const KIND_ORDER = { mix: 0, master: 1, stem: 2, audio: 3, lyrics: 4, video: 5 };
  const STEM_ORDER = { vocals: 0, drums: 1, bass: 2, other: 3 };
  const ROOM_NAMES = { mix: 'MixForge', lrc: 'LRC Forge', ink: 'INK', aura: 'AuraMix', release: 'Release Forge', spark: 'LRC Forge' };
  let songs = [];
  let nowPlaying = null;

  function setStatus(message, kind = '') {
    const el = $('libraryStatus');
    el.textContent = message;
    el.className = `status ${kind}`.trim();
  }

  function el(tag, attrs = {}, text = '') {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value;
      else node.setAttribute(key, value);
    }
    if (text) node.textContent = text;
    return node;
  }

  function dateLabel(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function assetTitle(asset) {
    if (asset.kind === 'stem') return asset.stem || asset.label || 'Stem';
    if (asset.kind === 'mix') return 'Original mix';
    if (asset.kind === 'master') return 'Release master';
    return asset.label || asset.kind || 'File';
  }

  function sortAssets(list) {
    return [...list].sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9)
      || (STEM_ORDER[a.stem] ?? 9) - (STEM_ORDER[b.stem] ?? 9)
      || String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  async function links(song, asset) {
    const cached = asset._links;
    if (cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) return cached;
    const data = await library.call('play', { songId: song.id, assetId: asset.id });
    asset._links = { playUrl: data.playUrl, downloadUrl: data.downloadUrl, expiresAt: Date.now() + Number(data.expiresInSec || 3600) * 1000 };
    return asset._links;
  }

  function renderAsset(song, asset) {
    const row = el('div', { class: 'library-asset' });
    const name = el('div');
    name.append(el('b', {}, assetTitle(asset)));
    const meta = [library.formatBytes(asset.size), ROOM_NAMES[asset.sourceRoom] || ''].filter(Boolean).join(' · ');
    if (meta) name.append(el('small', {}, meta));
    const actions = el('div', { class: 'library-asset-actions' });
    const play = el('button', { class: 'primary', type: 'button' }, '▶ Play');
    const save = el('button', { class: 'secondary', type: 'button' }, 'Save');
    if (!asset.playable) { play.disabled = true; save.disabled = true; }
    actions.append(play, save);
    row.append(name, actions);

    play.addEventListener('click', async () => {
      play.disabled = true;
      try {
        let audio = row.querySelector('audio');
        if (!audio) {
          const { playUrl } = await links(song, asset);
          audio = el('audio', { controls: '', preload: 'none' });
          audio.src = playUrl;
          audio.addEventListener('play', () => {
            if (nowPlaying && nowPlaying !== audio) nowPlaying.pause();
            nowPlaying = audio;
          });
          row.append(audio);
        }
        await audio.play();
      } catch (error) {
        setStatus(`Could not play ${assetTitle(asset)}: ${error.message}`, 'error');
      } finally {
        play.disabled = false;
      }
    });

    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const { downloadUrl } = await links(song, asset);
        const a = el('a', { href: downloadUrl, rel: 'noopener' });
        document.body.append(a);
        a.click();
        a.remove();
      } catch (error) {
        setStatus(`Could not save ${assetTitle(asset)}: ${error.message}`, 'error');
      } finally {
        save.disabled = false;
      }
    });
    return row;
  }

  function renderSong(song) {
    const details = el('details', { class: 'library-song' });
    const summary = el('summary');
    const head = el('div');
    head.append(el('b', {}, song.title || 'Untitled song'));
    const stems = song.assets.filter((a) => a.kind === 'stem').length;
    const parts = [
      dateLabel(song.updatedAt || song.createdAt),
      stems ? `${stems} stem${stems === 1 ? '' : 's'}` : '',
      song.assets.some((a) => a.kind === 'mix') ? 'mix' : '',
    ].filter(Boolean);
    head.append(el('small', {}, parts.join(' · ') || 'No audio yet'));
    summary.append(head, el('span', { class: 'library-chev', 'aria-hidden': 'true' }, '›'));
    details.append(summary);
    const body = el('div', { class: 'library-assets' });
    const audioAssets = sortAssets(song.assets.filter((a) => a.kind !== 'video' && a.kind !== 'lyrics'));
    if (!audioAssets.length) body.append(el('p', { class: 'library-empty' }, 'No audio saved to this song yet. Save stems from MixForge after a separation and they show up here.'));
    for (const asset of audioAssets) body.append(renderAsset(song, asset));
    details.append(body);
    return details;
  }

  function render() {
    const query = $('librarySearch').value.trim().toLowerCase();
    const visible = songs.filter((s) => !query || String(s.title || '').toLowerCase().includes(query));
    const list = $('libraryList');
    list.replaceChildren(...visible.map(renderSong));
    const withAudio = songs.filter((s) => s.assets.some((a) => a.kind !== 'video' && a.kind !== 'lyrics')).length;
    $('libraryCount').textContent = songs.length ? `${songs.length} song${songs.length === 1 ? '' : 's'} · ${withAudio} with audio` : '';
    if (!songs.length) list.append(el('p', { class: 'library-empty' }, 'No songs yet. Run a separation in MixForge and tap “Save mix + stems to my song library”.'));
    else if (!visible.length) list.append(el('p', { class: 'library-empty' }, 'No song matches that search.'));
  }

  async function load() {
    try {
      const data = await library.call('list');
      // Songs with audio first, newest first inside each group.
      songs = (data.songs || []).sort((a, b) => {
        const audio = (s) => (s.assets || []).some((x) => x.kind !== 'video' && x.kind !== 'lyrics') ? 0 : 1;
        return audio(a) - audio(b) || String(b.updatedAt).localeCompare(String(a.updatedAt));
      });
      setStatus('');
      render();
    } catch (error) {
      if (error.status === 401 || error.status === 402) {
        $('librarySignIn').classList.remove('hidden');
        if (error.status === 402) {
          $('librarySignInTitle').textContent = 'Your song library comes with MixForge or the Forge Pass';
          $('librarySignInDetail').textContent = error.message;
        }
        setStatus('');
        return;
      }
      setStatus(error.message, 'error');
    }
  }

  // ---- Older MixForge stems (before the library). Founder account only; hidden for everyone else.
  const OLDER_API = 'https://xbzypzgnwgrmmvtrmdzl.supabase.co/functions/v1/stem-library';
  const OLDER_KEY = 'sb_publishable_lhVBmqHvnAiAUR7Q7L_aQQ_BZH05ZGj';

  async function older(action, body = {}) {
    const response = await fetch(OLDER_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OLDER_KEY}`, apikey: OLDER_KEY },
      body: JSON.stringify({ action, ...body }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      const error = new Error(data.error || `Older stems request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function renderOlderSet(set) {
    const when = dateLabel(set.createdAt) || 'Unknown date';
    const details = el('details', { class: 'library-song' });
    const summary = el('summary');
    const head = el('div');
    head.append(el('b', {}, `Stems from ${when}`));
    head.append(el('small', {}, `${set.stems.length} stem${set.stems.length === 1 ? '' : 's'} · ${set.stems.map((s) => s.stem).join(', ')}`));
    summary.append(head, el('span', { class: 'library-chev', 'aria-hidden': 'true' }, '›'));
    const body = el('div', { class: 'library-assets' });
    const ordered = [...set.stems].sort((a, b) => (STEM_ORDER[a.stem] ?? 9) - (STEM_ORDER[b.stem] ?? 9));
    for (const file of ordered) body.append(olderAssetRow(file, file.stem, `MixForge stems ${when} - ${file.stem}.wav`));
    const add = el('button', { class: 'secondary', type: 'button' }, 'Add to my song library');
    const note = el('div', { class: 'status' });
    add.addEventListener('click', async () => {
      add.disabled = true;
      try {
        note.className = 'status busy';
        note.textContent = 'Adding to your song library…';
        const { song } = await library.call('create-song', { title: `MixForge stems · ${when}`, room: 'mix' });
        for (const file of ordered) {
          note.textContent = `Copying the ${file.stem} stem…`;
          const { playUrl } = await older('sign', { path: file.path });
          const res = await fetch(playUrl);
          if (!res.ok) throw new Error(`Could not read the ${file.stem} stem (${res.status}).`);
          const blob = new Blob([await res.blob()], { type: 'audio/wav' });
          await library.saveFile(song.id, { kind: 'stem', stem: file.stem, blob, label: file.stem });
        }
        note.className = 'status ok';
        note.textContent = 'Added. Rename it in your song library whenever you know which song it is.';
        add.textContent = 'Added to your song library';
        void load();
      } catch (error) {
        note.className = 'status error';
        note.textContent = `Not added: ${error.message}`;
        add.disabled = false;
      }
    });
    const actions = el('div', { class: 'actions' });
    actions.append(add);
    body.append(actions, note);
    details.append(summary, body);
    return details;
  }

  function olderAssetRow(file, title, downloadName) {
    const row = el('div', { class: 'library-asset' });
    const name = el('div');
    name.append(el('b', {}, title));
    if (file.size) name.append(el('small', {}, library.formatBytes(file.size)));
    const actions = el('div', { class: 'library-asset-actions' });
    const play = el('button', { class: 'primary', type: 'button' }, '▶ Play');
    const save = el('button', { class: 'secondary', type: 'button' }, 'Save');
    actions.append(play, save);
    row.append(name, actions);
    let cached = null;
    const sign = async () => {
      if (cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) return cached;
      const data = await older('sign', { path: file.path, downloadName });
      cached = { playUrl: data.playUrl, downloadUrl: data.downloadUrl, expiresAt: Date.now() + Number(data.expiresInSec || 3600) * 1000 };
      return cached;
    };
    play.addEventListener('click', async () => {
      play.disabled = true;
      try {
        let audio = row.querySelector('audio');
        if (!audio) {
          audio = el('audio', { controls: '', preload: 'none' });
          audio.src = (await sign()).playUrl;
          audio.addEventListener('play', () => {
            if (nowPlaying && nowPlaying !== audio) nowPlaying.pause();
            nowPlaying = audio;
          });
          row.append(audio);
        }
        await audio.play();
      } catch (error) {
        $('olderStatus').className = 'status error';
        $('olderStatus').textContent = `Could not play ${title}: ${error.message}`;
      } finally {
        play.disabled = false;
      }
    });
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const a = el('a', { href: (await sign()).downloadUrl, rel: 'noopener' });
        document.body.append(a);
        a.click();
        a.remove();
      } catch (error) {
        $('olderStatus').className = 'status error';
        $('olderStatus').textContent = `Could not save ${title}: ${error.message}`;
      } finally {
        save.disabled = false;
      }
    });
    return row;
  }

  async function loadOlder() {
    try {
      const data = await older('list');
      const sets = data.stemSets || [];
      const uploads = data.uploads || [];
      if (!sets.length && !uploads.length) return;
      $('olderPanel').classList.remove('hidden');
      const list = $('olderList');
      list.replaceChildren(...sets.map(renderOlderSet));
      if (uploads.length) {
        const details = el('details', { class: 'library-song' });
        const summary = el('summary');
        const head = el('div');
        head.append(el('b', {}, 'Uploads that never finished separating'));
        head.append(el('small', {}, `${uploads.length} file${uploads.length === 1 ? '' : 's'}`));
        summary.append(head, el('span', { class: 'library-chev', 'aria-hidden': 'true' }, '›'));
        const body = el('div', { class: 'library-assets' });
        for (const file of uploads) body.append(olderAssetRow(file, `${file.title} · ${dateLabel(file.createdAt)}`, `${file.title}.wav`));
        details.append(summary, body);
        list.append(details);
      }
    } catch (error) {
      // 401/402/403: not the founder account or not signed in. The section simply stays hidden.
      if (![401, 402, 403].includes(error.status)) console.warn('[MixForge] older stems unavailable', error);
    }
  }

  $('librarySearch').addEventListener('input', render);
  if (library) { void load(); void loadOlder(); }
  else setStatus('The song library did not load. Refresh the page.', 'error');
})();
