'use strict';

// Shared song library client. One song record on WorkinWithAI, every tool's files attached to it,
// so a track is uploaded once and opened anywhere (MixForge, LRC Forge, INK, AuraMix).
// The Hub checks the member's own sign-in and song ownership; files stream through short-lived signed links.
(() => {
  const LIBRARY_API = 'https://workinwithai.com/api/studio/library';
  const TOKEN_URL = 'https://workinwithai.com/api/product-token?product=mix';
  let token = '';
  let tokenExpiresAtMs = 0;
  let pending = null;

  function titleFromFileName(name) {
    const base = String(name || '').replace(/\.[^.]+$/, '');
    const cleaned = base
      .replace(/[-_]+(separation|proxy|mix|master|final|bounce)\b/gi, ' ')
      .replace(/[_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned.slice(0, 200) || 'Untitled song';
  }

  function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
    if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
    return `${Math.max(1, Math.round(n / 1024))} KB`;
  }

  const EXT_MIME = { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/mp4', flac: 'audio/flac', aif: 'audio/aiff', aiff: 'audio/aiff', ogg: 'audio/ogg' };

  // Browsers often leave a file's type empty or guess wrong (iOS labels some WAVs video/mp4).
  function wavMime(type, name = '') {
    const ext = String(name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
    if (ext && EXT_MIME[ext]) return EXT_MIME[ext];
    const t = String(type || '').toLowerCase();
    if (!t || t === 'video/mp4' || t === 'application/octet-stream') return 'audio/wav';
    return t === 'audio/x-wav' || t === 'audio/wave' ? 'audio/wav' : t;
  }

  async function refreshToken() {
    const response = await fetch(TOKEN_URL, { credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.accessToken) {
      const error = new Error(response.status === 401
        ? 'Sign in with WorkinWithAI to open your song library.'
        : response.status === 402
          ? 'Your song library opens with a MixForge or Forge Pass membership.'
          : 'MixForge could not reach your song library.');
      error.status = response.status;
      throw error;
    }
    token = data.accessToken;
    tokenExpiresAtMs = Number(data.expiresAt || 0) * 1000;
    return token;
  }

  async function getToken() {
    if (token && (!tokenExpiresAtMs || tokenExpiresAtMs - Date.now() > 60_000)) return token;
    if (!pending) pending = refreshToken().finally(() => { pending = null; });
    return pending;
  }

  async function call(action, body = {}) {
    const bearer = await getToken();
    const response = await fetch(LIBRARY_API, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ action, ...body }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `Song library request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  // Upload one file to a song: ticket, straight-to-storage PUT, then index it on the song.
  async function saveFile(songId, { kind, blob, stem = null, label = '', durationSec = null }) {
    const mimeType = wavMime(blob.type, blob.name);
    const ticket = await call('upload', { songId, kind, stem, label, mimeType, size: blob.size, room: 'mix' });
    const put = await fetch(ticket.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType, 'x-upsert': 'false' },
      body: blob,
    });
    if (!put.ok) throw new Error(`Saving ${label || stem || kind} failed (${put.status}).`);
    const confirmed = await call('confirm', { songId, kind, stem, label, path: ticket.path, room: 'mix', durationSec });
    return confirmed.asset;
  }

  globalThis.MixForgeSongLibrary = { call, saveFile, titleFromFileName, formatBytes, wavMime };
})();
