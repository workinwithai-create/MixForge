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

  // The song's own full mix to check the stems against: the oldest playable mix (or uploaded audio)
  // that is not itself a rebuild from these stems. Comparing stems with their own sum proves nothing.
  function pickOriginalMix(assets) {
    const isRebuild = (asset) => /^rebuilt from stems$/i.test(String(asset.label || '').trim())
      || /^mixforge:(rebuild|master)\//.test(String(asset.source || asset.sourceKey || ''));
    const usable = (assets || []).filter((a) => a && a.playable && (a.kind === 'mix' || a.kind === 'audio') && !isRebuild(a));
    const oldestFirst = (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    return usable.filter((a) => a.kind === 'mix').sort(oldestFirst)[0] || usable.filter((a) => a.kind === 'audio').sort(oldestFirst)[0] || null;
  }

  const num = (value, digits = 2) => (value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null);

  // One receipt for a whole "Mix and master" run: which stems at which levels, what the stem check found,
  // every correction the mix stage proposed with its verdict, what the master measured, and whether it was
  // saved to the song. Numbers and names only; no audio.
  function buildRunReceipt({ song, parts, trimDb = 0, stemCheck = null, corrections = [], targetLufs = null, masterPlan = null, finalMetrics = null, truePeakDb = null, gate = null, saved = null, levels = null, sourceNote = undefined, generatedAt = new Date().toISOString() } = {}) {
    const ceiling = masterPlan ? (masterPlan.truePeakCeilingDb ?? masterPlan.ceilingDb ?? null) : null;
    return {
      schema: 'mixforge-run-receipt',
      schemaVersion: 1,
      generatedAt,
      privacy: 'Numbers and names only. No audio is included.',
      song: { id: song?.id || null, title: song?.title || null },
      source: sourceNote || 'stems saved in the song library; no new separation',
      stems: (parts || []).map((p) => ({ name: p.name, ...(p.role ? { group: p.role } : {}), assetId: p.assetId || null, levelDb: num(p.gainDb, 1) ?? 0, muted: Boolean(p.muted) })),
      mixTrimDb: num(trimDb) ?? 0,
      // Fader moves MixForge made on its own before mixing, each with its reason. Empty when it made none.
      levels: {
        fixedByMixForge: ((levels && levels.fixedByMixForge) || []).map((m) => ({ group: m.role, changeDb: num(m.deltaDb, 1), reason: m.reason || '', files: m.files || [] })),
        vocalAgainstBandLu: levels && levels.vocalAgainstBandLu ? { before: num(levels.vocalAgainstBandLu.beforeLu, 1), after: num(levels.vocalAgainstBandLu.afterLu, 1) } : null,
      },
      stemCheck,
      corrections: (corrections || []).map((c) => ({ ...c })),
      master: {
        targetLufs: num(targetLufs, 1),
        peakCeilingDb: num(ceiling, 1),
        // Master controls the musician moved off MixForge's own pick for this run. Empty when none were.
        setByMusician: Array.isArray(masterPlan?.userMoved) ? [...masterPlan.userMoved] : [],
        measured: finalMetrics ? {
          lufs: num(finalMetrics.lufs),
          peakDb: num(finalMetrics.peakDb),
          oversampledPeakDb: num(truePeakDb),
          loudnessRange: num(finalMetrics.lra),
          crestDb: num(finalMetrics.crestDb),
          monoCorrelation: num(finalMetrics.correlation),
          clipPercent: num(finalMetrics.clipPercent, 4),
        } : null,
        hardChecks: gate ? { passed: Boolean(gate.allow), verified: Boolean(gate.verified), clipping: Boolean(gate.clipFail), overCeiling: Boolean(gate.tpFail), monoWarning: Boolean(gate.monoWarn) } : null,
      },
      saved: saved ? { toSong: Boolean(saved.toSong), kind: saved.kind || null, source: saved.source || null, reason: saved.reason || null } : { toSong: false, kind: null, source: null, reason: null },
    };
  }

  // A name for a set of stem files: what their file names start with in common ("MySong_Kick", "MySong_Bass"
  // gives "MySong"), or "Your stems" when they share nothing useful.
  function commonTitle(names) {
    const list = (names || []).map((n) => String(n || '').replace(/\.[a-z0-9]{2,5}$/i, '')).filter(Boolean);
    if (list.length < 2) return 'Your stems';
    let prefix = list[0];
    for (const name of list.slice(1)) {
      let i = 0;
      while (i < prefix.length && i < name.length && prefix[i].toLowerCase() === name[i].toLowerCase()) i++;
      prefix = prefix.slice(0, i);
    }
    // Stop at the last separator so half a word is never left on the end, then tidy.
    const cut = prefix.search(/[\s_.-]+[^\s_.-]*$/);
    const whole = /[\s_.-]$/.test(prefix) ? prefix : (cut > 0 ? prefix.slice(0, cut) : '');
    const title = whole.replace(/^[\s_.\-\d]+/, '').replace(/[\s_.-]+$/, '').replace(/[_]+/g, ' ').trim();
    return title.length >= 3 ? title.slice(0, 80) : 'Your stems';
  }

  globalThis.MixForgeStemRebuildCore = { pickStems, missingStems, sumStems, rebuildSourceKey, coversStems, pickOriginalMix, buildRunReceipt, commonTitle, SAFE_PEAK, STEM_ORDER };
})();
