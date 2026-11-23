'use strict';

// The mix moves a person makes with faders, as pure maths: no DOM, no Web Audio, no network.
//   guessRole    which of MixForge's four mix groups a DAW stem file belongs to, from its name
//   planBalance  static levels: pull a part that is clearly out of range back into range
//   planRides    automation: short level rides that keep the lead steady against the band
//   applyRide    the ride as a per-sample gain on the lead
// Everything here is bounded and explained. The ranges are product heuristics, not a taste engine:
// a move is only proposed when a level sits outside a wide, defensible window, and never past a cap.
(() => {
  const ROLES = ['vocals', 'drums', 'bass', 'other'];

  // ---------------------------------------------------------------- roles

  const squash = (name) => String(name || '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .toLowerCase()
    .trim();

  // Words that settle it wherever they appear in the name, then short codes that only count as whole words.
  const DRUM_PARTS = /(kick|snare|hi ?hat|hihat|tom ?tom|cymbal|overhead|drum|percussion|shaker|tambourine|cowbell|conga|bongo|clap)/;
  const DRUM_WORDS = new Set(['bd', 'kik', 'sn', 'snr', 'hh', 'hat', 'hats', 'tom', 'toms', 'oh', 'ohs', 'ride', 'crash', 'kit', 'perc', 'room', 'rooms', 'rim', 'loop', 'beat']);
  const BASS_PARTS = /(bass|808)/;
  const BASS_WORDS = new Set(['sub', 'bs', 'upright', 'low']);
  const VOCAL_PARTS = /(vox|vocal|harmon|choir|adlib|ad lib|backing|singer|whisper)/;
  const VOCAL_WORDS = new Set(['voc', 'vocs', 'vx', 'lv', 'ld', 'bv', 'bvs', 'bgv', 'bgvs', 'rap', 'sing', 'lead']);

  // "Bass Drum" is a drum and "Lead Guitar" is not a vocal, so the order and the exceptions matter.
  function guessRole(fileName) {
    const text = squash(fileName);
    const words = new Set(text.split(' ').filter(Boolean));
    const has = (set) => [...words].some((w) => set.has(w));
    if (DRUM_PARTS.test(text) || /bass ?drum/.test(text)) return 'drums';
    if (BASS_PARTS.test(text)) return 'bass';
    if (VOCAL_PARTS.test(text)) return 'vocals';
    const instrument = /(gtr|guitar|git|keys|piano|synth|organ|pad|string|horn|brass|sax|violin|cello|fx|sfx)/.test(text);
    if (has(DRUM_WORDS) && !instrument) return 'drums';
    if (has(BASS_WORDS) && !instrument) return 'bass';
    if (has(VOCAL_WORDS) && !instrument) return 'vocals';
    return 'other';
  }

  // ---------------------------------------------------------------- balance

  const QUIET_PART_LU = 12;      // a band part this far under the loudest band part is close to inaudible
  const QUIET_BASS_LU = 15;      // bass reads lower on a loudness meter than it sounds, so it gets more room
  const LEAD_LOW_LU = -6;        // lead vocal this far under the band: buried
  const LEAD_HIGH_LU = 6;        // lead vocal this far over the band: sitting on top of the song
  const LEAD_SETTLE_LU = 4;      // a corrected vocal is brought to this distance from the band, not to the middle
  const MAX_LEVEL_MOVE_DB = 6;   // no single fader move is larger than this
  const SILENT_LUFS = -60;

  const sumLufs = (values) => 10 * Math.log10(values.reduce((sum, v) => sum + Math.pow(10, v / 10), 0) || 1e-12);
  const one = (value) => Math.round(value * 10) / 10;

  // buses: [{ role, lufs }] — the loudness of each mix group at the current fader settings.
  // Returns fader moves (in dB) with the reason for each, and the vocal-to-band level before and after.
  // Published analyses of commercial releases put the lead vocal within a few dB of its accompaniment
  // (about +1 dB on average since the mid-1970s, lower for heavier styles): Gerdes & Siedenburg,
  // "Lead-vocal level in recordings of popular music 1946–2020" (2023). The window here is deliberately
  // much wider than that, so only a clearly buried or clearly overpowering vocal is moved.
  function planBalance({ buses } = {}) {
    const live = (buses || []).filter((b) => b && ROLES.includes(b.role) && Number.isFinite(b.lufs) && b.lufs > SILENT_LUFS);
    const level = Object.fromEntries(live.map((b) => [b.role, b.lufs]));
    const moves = [];
    const band = live.filter((b) => b.role !== 'vocals').map((b) => b.role);

    if (band.length >= 2) {
      const loudest = Math.max(...band.map((role) => level[role]));
      for (const role of band) {
        const floor = loudest - (role === 'bass' ? QUIET_BASS_LU : QUIET_PART_LU);
        if (level[role] < floor - 0.05) {
          const deltaDb = one(Math.min(MAX_LEVEL_MOVE_DB, floor - level[role]));
          moves.push({
            role, deltaDb,
            reason: `The ${role} sat ${one(loudest - level[role])} LU under the loudest part of the band, close to inaudible. Raised ${deltaDb} dB.`,
          });
          level[role] += deltaDb;
        }
      }
    }

    let lead = null;
    if (Number.isFinite(level.vocals) && band.length) {
      const bandLevel = sumLufs(band.map((role) => level[role]));
      const before = level.vocals - bandLevel;
      let deltaDb = 0;
      if (before < LEAD_LOW_LU) deltaDb = Math.min(MAX_LEVEL_MOVE_DB, -LEAD_SETTLE_LU - before);
      else if (before > LEAD_HIGH_LU) deltaDb = -Math.min(MAX_LEVEL_MOVE_DB, before - LEAD_SETTLE_LU);
      deltaDb = one(deltaDb);
      if (Math.abs(deltaDb) >= 0.1) {
        const after = before + deltaDb;
        // The cap can stop short of the range. Say so, rather than let "raised" read as "fixed".
        const capped = Math.abs(deltaDb) >= MAX_LEVEL_MOVE_DB && (after < LEAD_LOW_LU || after > LEAD_HIGH_LU);
        const stillOff = capped
          ? ` That is the most MixForge moves a fader on its own; it is still ${one(Math.abs(after))} LU ${after < 0 ? 'under' : 'over'} the band, so move it further yourself if that is not what you want.`
          : '';
        moves.push({
          role: 'vocals', deltaDb, capped,
          reason: (deltaDb > 0
            ? `The vocal sat ${one(-before)} LU under the band, where words get lost. Raised ${deltaDb} dB.`
            : `The vocal sat ${one(before)} LU over the band, on top of the song rather than in it. Lowered ${Math.abs(deltaDb)} dB.`) + stillOff,
        });
        level.vocals += deltaDb;
      }
      lead = { beforeLu: one(before), afterLu: one(level.vocals - bandLevel) };
    }

    return {
      moves,
      lead,
      summary: moves.length
        ? moves.map((m) => m.reason).join(' ')
        : (live.length < 2
          ? 'There is only one part here, so there is nothing to balance.'
          : `Levels are inside the range MixForge corrects${lead ? ` (the vocal sits ${lead.beforeLu >= 0 ? `${lead.beforeLu} LU over` : `${Math.abs(lead.beforeLu)} LU under`} the band)` : ''}. Nothing moved.`),
    };
  }

  // ---------------------------------------------------------------- rides

  const HOP_SEC = 0.1;
  const WINDOW_HOPS = 4;         // 0.4 s level windows
  const DIP_TOLERANCE_DB = 2;    // the lead may sit this far under its usual place before it is lifted
  const PEAK_TOLERANCE_DB = 3;   // ...and this far over it before it is eased back
  const MAX_RIDE_UP_DB = 3;
  const MAX_RIDE_DOWN_DB = 2;
  const MIN_ACTIVE_SEC = 4;      // with less lead than this there is no "usual place" to measure
  const MIN_RIDE_DB = 1;         // a phrase that is out of place by less than this is left alone
  const RIDE_AUDIBLE_DB = 0.5;   // where a kept ride starts and ends, for the list

  const percentile = (values, p) => {
    if (!values.length) return 0;
    const sorted = Float64Array.from(values).sort();
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
  };

  // Level per 0.1 s hop, in dB, after a 300 Hz high-pass (12 dB per octave) so kick and bass energy do
  // not count as "covering" a lead that lives well above them.
  function hopLevels(samples, sampleRate) {
    const hop = Math.max(1, Math.round(sampleRate * HOP_SEC));
    const hops = Math.floor(samples.length / hop);
    const energy = new Float64Array(hops);
    const a = Math.exp(-2 * Math.PI * 300 / sampleRate);
    let low1 = 0;
    let low2 = 0;
    for (let h = 0; h < hops; h++) {
      let sum = 0;
      const end = (h + 1) * hop;
      for (let i = h * hop; i < end; i++) {
        low1 = a * low1 + (1 - a) * samples[i];
        const high1 = samples[i] - low1;
        low2 = a * low2 + (1 - a) * high1;
        const high = high1 - low2;
        sum += high * high;
      }
      energy[h] = sum / hop;
    }
    const levels = new Float64Array(hops);
    const hopDb = new Float64Array(hops);
    for (let h = 0; h < hops; h++) {
      let sum = 0;
      let n = 0;
      for (let k = Math.max(0, h - 1); k < Math.min(hops, h - 1 + WINDOW_HOPS); k++) { sum += energy[k]; n++; }
      levels[h] = 10 * Math.log10(sum / Math.max(1, n) + 1e-12);
      hopDb[h] = 10 * Math.log10(energy[h] + 1e-12);
    }
    return { levels, hopDb, hop };
  }

  // True where every 0.1 s step inside the 0.4 s window is above the gate. A window that is half word and
  // half silence reads low for a reason that has nothing to do with the mix, so it is not judged.
  function fullWindows(hopDb, gate) {
    const hops = hopDb.length;
    const full = new Uint8Array(hops);
    for (let h = 0; h < hops; h++) {
      let ok = 1;
      for (let k = Math.max(0, h - 1); k < Math.min(hops, h - 1 + WINDOW_HOPS); k++) if (hopDb[k] <= gate) { ok = 0; break; }
      full[h] = ok;
    }
    return full;
  }

  // Carry each lasting need two steps outward, so the fader is already in place when the phrase starts
  // and holds until it ends, instead of ramping in over the first words.
  function spread(values, reach) {
    const n = values.length;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let best = 0;
      for (let k = Math.max(0, i - reach); k <= Math.min(n - 1, i + reach); k++) if (Math.abs(values[k]) > Math.abs(best)) best = values[k];
      out[i] = best;
    }
    return out;
  }

  function smooth(values, medianSpan, averageSpan) {
    const n = values.length;
    const med = new Float64Array(n);
    const half = Math.floor(medianSpan / 2);
    const scratch = [];
    for (let i = 0; i < n; i++) {
      scratch.length = 0;
      for (let k = Math.max(0, i - half); k <= Math.min(n - 1, i + half); k++) scratch.push(values[k]);
      scratch.sort((x, y) => x - y);
      med[i] = scratch[Math.floor(scratch.length / 2)];
    }
    const out = new Float64Array(n);
    const reach = Math.floor(averageSpan / 2);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      let count = 0;
      for (let k = Math.max(0, i - reach); k <= Math.min(n - 1, i + reach); k++) { sum += med[k]; count++; }
      out[i] = sum / count;
    }
    return out;
  }

  // lead, rest: mono Float32Arrays of the same song (the placed lead, and everything else in the mix).
  // The plan keeps the lead near its own usual distance from the band: it does not change the overall
  // balance (that is planBalance's job), it steadies it phrase by phrase.
  // strength 0..1 scales the caps, for sources that should only be moved a little.
  function planRides({ lead, rest, sampleRate, strength = 1 } = {}) {
    const still = { dipSec: 0, worstDipDb: 0, hotSec: 0, worstHotDb: 0, strayDbSec: 0 };
    const none = (reason) => ({ hopSec: HOP_SEC, hopSamples: Math.max(1, Math.round((sampleRate || 44100) * HOP_SEC)), gainsDb: new Float32Array(0), rides: [], usualMarginDb: null, activeSec: 0, before: { ...still }, after: { ...still }, reason });
    if (!lead || !rest || !Number.isFinite(sampleRate) || sampleRate <= 0) return none('No lead and band to compare.');
    const scale = Math.max(0, Math.min(1, Number(strength) || 0));
    if (!scale) return none('This source is not trusted enough to ride.');
    const n = Math.min(lead.length, rest.length);
    const L = hopLevels(lead.subarray ? lead.subarray(0, n) : lead, sampleRate);
    const R = hopLevels(rest.subarray ? rest.subarray(0, n) : rest, sampleRate);
    const hops = L.levels.length;
    if (!hops) return none('The song is too short to ride.');

    const leadGate = Math.max(-55, percentile(L.levels, 0.9) - 20);
    const restGate = Math.max(-60, percentile(R.levels, 0.5) - 20);
    const margins = [];
    const active = new Uint8Array(hops);
    const leadFull = fullWindows(L.hopDb, leadGate);
    for (let h = 0; h < hops; h++) {
      if (leadFull[h] && R.levels[h] > restGate) { active[h] = 1; margins.push(L.levels[h] - R.levels[h]); }
    }
    const activeSec = margins.length * HOP_SEC;
    if (activeSec < MIN_ACTIVE_SEC) return none('There is not enough lead over the band to measure where it usually sits.');
    const usual = percentile(margins, 0.5);
    const low = usual - DIP_TOLERANCE_DB;
    const high = usual + PEAK_TOLERANCE_DB;
    const maxUp = MAX_RIDE_UP_DB * scale;
    const maxDown = MAX_RIDE_DOWN_DB * scale;

    // How far each window is from the lead's usual place, past the tolerance: positive needs a lift.
    const need = new Float64Array(hops);
    for (let h = 0; h < hops; h++) {
      if (!active[h]) continue;
      const margin = L.levels[h] - R.levels[h];
      if (margin < low) need[h] = low - margin;
      else if (margin > high) need[h] = -(margin - high);
    }
    // A fader moves in phrases, not syllables. A need that lasts under about 0.3 s is the edge of a
    // word or a single hit, not the lead being out of place: it is dropped (and not counted) first.
    // Then the move ramps over about half a second and is held inside the caps.
    const lasting = smooth(need, 5, 1);
    // A stretch that never strays by a whole dB is not worth a fader move: no ride, and not counted.
    for (let h = 0; h < hops;) {
      if (!lasting[h]) { h++; continue; }
      let end = h;
      let peak = 0;
      while (end < hops && lasting[end] && Math.sign(lasting[end]) === Math.sign(lasting[h])) { peak = Math.max(peak, Math.abs(lasting[end])); end++; }
      if (peak < MIN_RIDE_DB) for (let k = h; k < end; k++) lasting[k] = 0;
      h = end;
    }
    const eased = smooth(spread(lasting, 2), 1, 5);
    const gainsDb = new Float32Array(hops);
    for (let h = 0; h < hops; h++) gainsDb[h] = Math.max(-maxDown, Math.min(maxUp, eased[h]));

    // What was out of place before, and what is still out of place with the ride on.
    const tally = (left) => {
      const t = { dipSec: 0, worstDipDb: 0, hotSec: 0, worstHotDb: 0, strayDbSec: 0 };
      for (let h = 0; h < hops; h++) {
        if (Math.abs(lasting[h]) < 0.25) continue;
        const v = left(h);
        if (lasting[h] > 0 && v > 0.25) { t.dipSec += HOP_SEC; t.worstDipDb = Math.max(t.worstDipDb, v); t.strayDbSec += v * HOP_SEC; }
        if (lasting[h] < 0 && v < -0.25) { t.hotSec += HOP_SEC; t.worstHotDb = Math.max(t.worstHotDb, -v); t.strayDbSec += -v * HOP_SEC; }
      }
      for (const key of Object.keys(t)) t[key] = one(t[key]);
      return t;
    };
    const before = tally((h) => lasting[h]);
    const after = tally((h) => lasting[h] - gainsDb[h]);

    const rides = [];
    let open = null;
    const close = (endHop) => {
      if (!open) return;
      rides.push({ startSec: one(open.start * HOP_SEC), endSec: one(endHop * HOP_SEC), gainDb: one(open.peak) });
      open = null;
    };
    for (let h = 0; h < hops; h++) {
      const g = gainsDb[h];
      if (Math.abs(g) >= RIDE_AUDIBLE_DB) {
        if (open && Math.sign(g) !== Math.sign(open.peak)) close(h);
        if (!open) open = { start: h, peak: g };
        else if (Math.abs(g) > Math.abs(open.peak)) open.peak = g;
      } else {
        close(h);
      }
    }
    close(hops);

    return {
      hopSec: HOP_SEC,
      hopSamples: L.hop,
      gainsDb,
      rides,
      usualMarginDb: one(usual),
      activeSec: one(activeSec),
      before, after,
      reason: rides.length ? '' : 'The lead already holds its place against the band from phrase to phrase.',
    };
  }

  // The ride as a gain on one channel of the lead. Gain is interpolated between hop centres, so it ramps;
  // factor scales the whole ride (0.5 is "half strength"). Returns a new array; the input is not changed.
  function applyRide(samples, gainsDb, hopSamples, factor = 1) {
    const out = new Float32Array(samples.length);
    const hops = gainsDb.length;
    if (!hops) { out.set(samples); return out; }
    const linear = new Float32Array(hops);
    for (let h = 0; h < hops; h++) linear[h] = Math.pow(10, (gainsDb[h] * factor) / 20);
    const half = hopSamples / 2;
    for (let i = 0; i < samples.length; i++) {
      const position = (i - half) / hopSamples;
      const h0 = Math.max(0, Math.min(hops - 1, Math.floor(position)));
      const h1 = Math.min(hops - 1, h0 + 1);
      const t = Math.max(0, Math.min(1, position - h0));
      out[i] = samples[i] * (linear[h0] + (linear[h1] - linear[h0]) * t);
    }
    return out;
  }

  globalThis.MixForgeAutoMix = {
    guessRole, planBalance, planRides, applyRide, ROLES,
    LIMITS: { QUIET_PART_LU, QUIET_BASS_LU, LEAD_LOW_LU, LEAD_HIGH_LU, LEAD_SETTLE_LU, MAX_LEVEL_MOVE_DB, DIP_TOLERANCE_DB, PEAK_TOLERANCE_DB, MAX_RIDE_UP_DB, MAX_RIDE_DOWN_DB, MIN_RIDE_DB, MIN_ACTIVE_SEC },
  };
})();
