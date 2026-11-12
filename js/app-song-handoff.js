'use strict';

// Song handoff: another Pipe Dreams room (INK, the library page) opens MixForge on a song it already has:
//   https://mixforge.workinwithai.com/?song=<songId>&asset=<assetId>
// MixForge loads that song from the shared library, opens the chosen audio file, and remembers the song,
// so stems saved after the separation are attached to the same song instead of a new one.
(() => {
  const library = globalThis.MixForgeSongLibrary;
  if (!library || typeof loadFile !== 'function') return;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const OPENABLE = new Set(['mix', 'master', 'audio', 'stem']);
  const params = new URLSearchParams(location.search);
  const songId = (params.get('song') || '').trim();
  const assetId = (params.get('asset') || '').trim();
  if (!UUID.test(songId)) return;

  const banner = document.createElement('aside');
  banner.className = 'license-bar song-handoff';
  banner.id = 'songHandoff';
  banner.setAttribute('aria-live', 'polite');
  const copy = document.createElement('div');
  copy.className = 'license-copy';
  const title = document.createElement('strong');
  title.textContent = 'Opening your song…';
  const detail = document.createElement('p');
  detail.id = 'songHandoffDetail';
  copy.append(title, detail);
  banner.append(copy);
  const hero = document.querySelector('header.hero');
  (hero?.parentNode || document.body).insertBefore(banner, hero ? hero.nextSibling : document.body.firstChild);

  const say = (head, text = '') => { title.textContent = head; detail.textContent = text; };

  async function open() {
    try {
      const song = await library.getSong(songId.toLowerCase());
      // Every later save in this page goes to this song (see app-library-save.js).
      state.librarySong = { id: song.id, title: song.title, sourceAssetId: null };
      const choices = (song.assets || []).filter((a) => a.playable && OPENABLE.has(a.kind));
      const asset = (UUID.test(assetId) && choices.find((a) => a.id === assetId.toLowerCase()))
        || choices.find((a) => a.kind === 'mix') || choices.find((a) => a.kind === 'audio') || null;
      say(`Working on “${song.title || 'Untitled song'}”`, `Song ID ${song.id}. Stems you save go to this song.`);
      banner.dataset.songId = song.id;
      if (!asset) {
        detail.textContent += ' It has no audio yet, so choose a mix below.';
        return;
      }
      detail.textContent = `Song ID ${song.id}. Loading “${asset.label || asset.kind}”…`;
      const { playUrl } = await library.call('play', { songId: song.id, assetId: asset.id });
      const response = await fetch(playUrl);
      if (!response.ok) throw new Error(`Could not read that file (${response.status}).`);
      const blob = await response.blob();
      const ext = (blob.type.split('/')[1] || 'wav').replace('x-', '').replace('mpeg', 'mp3').replace('wave', 'wav');
      const file = new File([blob], `${song.title || 'Song'} - ${asset.label || asset.kind}.${ext}`, { type: blob.type || 'audio/wav' });
      await loadFile(file);
      state.librarySong.sourceAssetId = asset.id;
      detail.textContent = `Song ID ${song.id}. Opened “${asset.label || asset.kind}”. Stems you save go to this song.`;
    } catch (error) {
      console.error('[MixForge] song handoff failed', error);
      if (error.status === 401 || error.status === 402) say('Sign in to open this song', error.message);
      else if (error.status === 404) say('That song is not in your library', 'It may belong to another account. Nothing was changed.');
      else say('Could not open that song', error.message);
      state.librarySong = null;
    }
  }

  void open();
})();
