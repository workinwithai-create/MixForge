'use strict';

// Put a song back together from its library stems. Pure helpers, no DOM or Web Audio,
// so the same code runs in the browser and in the Node smoke test.
(() => {
  const STEM_ORDER = ['vocals', 'drums', 'bass', 'other'];
  const SAFE_PEAK = 0.891; // −1 dBFS: room for MixForge's master stage, and no clipping in the saved WAV.

  const dbToGain = (db) => Math.pow(10, db / 20);

  // The stems to use for one song: the newest playable file for each stem name, in mixer order.
  // A song can hold two separations of the same track; mixing both would double every part.
  function pickStems(assets) {
    const newest = new Map();
    for (const asset of assets || []) {
      if (!asset || asset.kind !== 'stem' || !asset.playable) continue;
      const name = String(asset.stem || asset.label || '').trim().toLowerCase();
      if (!name) continue;
      const seen = newest.get(name);
      if (!seen || String(asset.createdAt || '') > String(seen.createdAt || '')) newest.set(name, asset);
    }
    const rank = (name) => {
      const i = STEM_ORDER.indexOf(name);
      return i === -1 ? STEM_ORDER.length : i;
    };
    return [...newest.entries()]
      .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
      .map(([name, asset]) => ({ name, asset }));
  }

  // The standard Demucs set a stem list is missing, so the page can say "no drums stem on this song".
  function missingStems(names) {
    const have = new Set((names || []).map((n) => String(n).toLowerCase()));
    return STEM_ORDER.filter((n) => !have.has(n));
  }

  // Sum stems into one mix. Each part is { channels: Float32Array[], gainDb, muted }.
  // All parts must share one sample rate (the caller resamples first). Shorter stems are padded with silence;
  // a mono stem plays in both channels. If the sum would clip, the whole mix is turned down evenly
  // (never limited), and trimDb says by how much.
  function sumStems(parts, { channels: outChannels = 2, safePeak = SAFE_PEAK } = {}) {
    const live = (parts || []).filter((p) => p && !p.muted && Array.isArray(p.channels) && p.channels.length);
    const length = live.reduce((max, p) => Math.max(max, ...p.channels.map((c) => c.length)), 0);
    const width = Math.max(1, Math.min(2, outChannels));
    const out = Array.from({ length: width }, () => new Float32Array(length));
    for (const part of live) {
      const gain = dbToGain(Number(part.gainDb) || 0);
      for (let c = 0; c < width; c++) {
        const src = part.channels[Math.min(c, part.channels.length - 1)];
        const dest = out[c];
        for (let i = 0; i < src.length; i++) dest[i] += src[i] * gain;
      }
    }
    let peak = 0;
    for (const ch of out) for (let i = 0; i < ch.length; i++) { const v = Math.abs(ch[i]); if (v > peak) peak = v; }
    let trimDb = 0;
    if (peak > safePeak) {
      const scale = safePeak / peak;
      trimDb = 20 * Math.log10(scale);
      for (const ch of out) for (let i = 0; i < ch.length; i++) ch[i] *= scale;
      peak = safePeak;
    }
    return { channels: out, length, peak, trimDb, usedStems: live.length };
  }

  // A stable key for one rebuild (which stem files, at which levels), so saving the same rebuild twice
  // attaches it once. Matches the Hub's source-key rule: "mixforge:rebuild/<hex>".
  // kind "master" (with the loudness target as extra) keys a mastered result the same way.
  function rebuildSourceKey(parts, { kind = 'rebuild', extra = '' } = {}) {
    const text = (parts || [])
      .map((p) => `${p.assetId}:${p.muted ? 'm' : (Math.round((Number(p.gainDb) || 0) * 10) / 10).toFixed(1)}`)
      .sort()
      .join('|') + (extra ? `#${extra}` : '');
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ code, 0x5bd1e995) >>> 0;
    }
    return `mixforge:${kind === 'master' ? 'master' : 'rebuild'}/${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
  }

  // Which of the stems a Forensic Fix asks for this rebuild already holds, so no new separation is needed.
  function coversStems(requested, available) {
    const have = new Set((available || []).map((n) => String(n).toLowerCase()));
    const wanted = (requested || []).map((n) => String(n).toLowerCase()).filter(Boolean);
    return wanted.length > 0 && wanted.every((n) => have.has(n));
  }

  globalThis.MixForgeStemRebuildCore = { pickStems, missingStems, sumStems, rebuildSourceKey, coversStems, SAFE_PEAK, STEM_ORDER };
})();
