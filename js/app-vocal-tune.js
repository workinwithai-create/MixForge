'use strict';

// Vocal tuning: snap to key, pitch shift and harmony, on the separated vocal.
//
// MixForge already pulls the vocal out as its own stem. This file tunes that stem with MixDoctor's
// pitch engine (js/app-pitch-engine.js) and folds the change into the rebuilt mix the same way the
// vocal cleanup layer does: the rebuilt mix gets (tuned vocal - vocal as it was), plus any harmony.
// The band is never touched.
//
// Everything is off until the musician switches something on. With nothing on, the rebuilt mix is
// exactly what it was before this file existed.
//
// Loads after app-vocal-cleanup.js so it wraps rebuildCorrectedMix() outside the cleanup layer and can
// tune the cleaned vocal.

const MF_TUNE_DEFAULTS = Object.freeze({
  snap: false, key: 'C', scale: 'major', strength: 0.8,
  semitones: 0, harmony: '', harmonyMix: 0.3, preserve: 1,
});
const MF_TUNE_HARMONIES = [
  ['', 'None'],
  ['third', 'Third above, in key'],
  ['fifth', 'Fifth above, in key'],
  ['octave-up', 'Octave up'],
  ['octave-down', 'Octave down'],
];
// A harmony that follows the key needs a seven-note scale to count steps in.
const MF_TUNE_PARENT_SCALE = { major_pent: 'major', minor_pent: 'minor' };

function mfTuneActive(settings) {
  return Boolean(settings && (settings.snap || settings.semitones || settings.harmony));
}

function mfTuneMono(chs) {
  if (chs.length === 1) return chs[0];
  const n = chs[0].length, mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (chs[0][i] + chs[1][i]) * 0.5;
  return mono;
}

// How far each stretch of the lead has to move to become the note `steps` scale steps above it,
// so the harmony stays in the key (a third is 3 semitones on some notes and 4 on others).
// Stretches with no clear note carry the last interval. Pure.
function mfTuneHarmonyCurve(engine, mono, sr, key, scale, steps) {
  const scaleName = MF_TUNE_PARENT_SCALE[scale] || scale;
  const degrees = engine.SCALES[scaleName] || engine.SCALES.major;
  const root = Math.max(0, engine.NAMES.indexOf(key));
  const hop = 1024, frames = Math.ceil(mono.length / hop);
  const raw = new Float32Array(frames), semis = new Float32Array(frames);
  // Every scale note from far below to far above, as MIDI numbers.
  const ladder = [];
  for (let octave = -1; octave <= 10; octave++) for (const degree of degrees) ladder.push(octave * 12 + root + degree);
  let last = degrees.length === 7 && steps === 2 ? 4 : 7, seen = false;
  for (let f = 0; f < frames; f++) {
    const f0 = engine.f0At(mono, f * hop + hop / 2, sr);
    if (f0) {
      const midi = 69 + 12 * Math.log2(f0 / 440);
      let nearest = 0, best = Infinity;
      for (let i = 0; i < ladder.length; i++) { const d = Math.abs(ladder[i] - midi); if (d < best) { best = d; nearest = i; } }
      const target = ladder[Math.min(ladder.length - 1, nearest + steps)];
      last = target - midi;
      seen = true;
    }
    raw[f] = last;
  }
  if (!seen) raw.fill(last);
  for (let f = 0; f < frames; f++) { // middle of three, as the tuning curve does: drops one-frame jumps
    const a = raw[Math.max(0, f - 1)], b = raw[f], c = raw[Math.min(frames - 1, f + 1)];
    semis[f] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  }
  return { hop, semis };
}

// Tune a vocal. chs: one Float32Array per channel. Returns new arrays; the input is not changed.
//   lead:    the vocal after snap-to-key and pitch shift (the same arrays as the input if neither is on)
//   harmony: the extra voice, or null
//   stats:   how much of the vocal was moved, and by how much on average
async function mfTuneVocal(engine, chs, sr, settings, progress) {
  const s = { ...MF_TUNE_DEFAULTS, ...settings };
  const stage = (label, from, to) => (progress ? (f) => progress(label, from + (to - from) * f) : undefined);
  const stats = { movedShare: 0, averageCents: 0, snapped: false, shifted: 0, harmony: '' };
  let lead = chs;

  if (s.snap || s.semitones) {
    let ratioAt = () => Math.pow(2, s.semitones / 12);
    if (s.snap) {
      const curve = engine.tuneCurve(mfTuneMono(chs), sr, s.key, s.scale, s.strength);
      const last = curve.semis.length - 1;
      let moved = 0, cents = 0;
      for (let f = 0; f <= last; f++) if (curve.semis[f]) { moved++; cents += Math.abs(curve.semis[f]) * 100; }
      stats.movedShare = moved / (last + 1);
      stats.averageCents = moved ? cents / moved : 0;
      stats.snapped = true;
      ratioAt = (p) => Math.pow(2, (curve.semis[Math.min(last, Math.max(0, Math.floor(p / curve.hop)))] + s.semitones) / 12);
    }
    stats.shifted = s.semitones;
    lead = await engine.wsolaShift(chs, sr, ratioAt, s.preserve, stage('Tuning the vocal', 0, s.harmony ? 0.5 : 1));
  }

  let harmony = null;
  if (s.harmony) {
    let ratioAt;
    if (s.harmony === 'octave-up') ratioAt = () => 2;
    else if (s.harmony === 'octave-down') ratioAt = () => 0.5;
    else {
      const curve = mfTuneHarmonyCurve(engine, mfTuneMono(lead), sr, s.key, s.scale, s.harmony === 'fifth' ? 4 : 2);
      const last = curve.semis.length - 1;
      ratioAt = (p) => Math.pow(2, curve.semis[Math.min(last, Math.max(0, Math.floor(p / curve.hop)))] / 12);
    }
    harmony = await engine.wsolaShift(lead, sr, ratioAt, s.preserve, stage('Building the harmony', lead === chs ? 0 : 0.5, 1));
    stats.harmony = s.harmony;
  }
  return { lead, harmony, stats };
}

// base + (tuned lead - vocal as it was) + harmony. All arguments are arrays of Float32Array; returns new arrays.
// A mono vocal against a stereo mix goes to both sides, as the rest of MixForge does. Pure.
function mfTuneMix(base, source, lead, harmony, harmonyMix) {
  return base.map((channel, c) => {
    const out = Float32Array.from(channel);
    const src = source[Math.min(c, source.length - 1)], tuned = lead[Math.min(c, lead.length - 1)];
    const extra = harmony ? harmony[Math.min(c, harmony.length - 1)] : null;
    const n = Math.min(out.length, src.length, tuned.length);
    if (tuned !== src) for (let i = 0; i < n; i++) out[i] += tuned[i] - src[i];
    if (extra) { const m = Math.min(out.length, extra.length); for (let i = 0; i < m; i++) out[i] += extra[i] * harmonyMix; }
    return out;
  });
}

// ---------------------------------------------------------------------------------------------------
// Page wiring. Nothing below runs in the tests.
// ---------------------------------------------------------------------------------------------------
if (typeof document !== 'undefined' && typeof state !== 'undefined' && typeof MFPitch !== 'undefined' && typeof rebuildCorrectedMix === 'function') {
  const tune = { song: null, settings: { ...MF_TUNE_DEFAULTS }, heard: null, applied: null, previewUrl: null };
  state.vocalTune = tune;
  const channelsOf = (buffer) => Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const bufferFrom = (chs, sampleRate) => {
    const buffer = state.audioCtx.createBuffer(chs.length, chs[0].length, sampleRate);
    chs.forEach((data, c) => buffer.copyToChannel(data, c));
    return buffer;
  };
  const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));

  function current() {
    // Settings belong to one song. A new song starts with everything off and its own key.
    if (tune.song !== state.original) {
      tune.song = state.original;
      tune.settings = { ...MF_TUNE_DEFAULTS };
      tune.applied = null;
      tune.heard = null;
      if (state.original) {
        try {
          tune.heard = MFPitch.detectKeyJS(state.original);
          tune.settings.key = tune.heard.key;
          tune.settings.scale = tune.heard.scale;
        } catch (error) { console.warn('MixForge could not work out the key', error); }
      }
    }
    return tune;
  }

  // The vocal the mix will end up with before tuning: the cleaned one if cleanup is on, else the stem.
  function sourceVocal() {
    const raw = state.stemBuffers?.vocals;
    const cleanup = state.vocalCleanup;
    return (cleanup && cleanup.mode !== 'preserve' && cleanup.rendered) || raw || null;
  }

  const previousRebuild = rebuildCorrectedMix;
  rebuildCorrectedMix = async function rebuildCorrectedMixWithVocalTune() {
    const base = await previousRebuild();
    const t = current();
    const source = sourceVocal();
    if (!source || !mfTuneActive(t.settings)) { t.applied = null; paint(); return base; }
    const settings = { ...t.settings };
    const show = async (label, fraction) => {
      if (typeof setStatus === 'function') setStatus('rebuildStatus', `${label}… ${Math.round(fraction * 100)}%`, 'busy');
      await breathe();
    };
    const src = channelsOf(source);
    const result = await mfTuneVocal(MFPitch, src, source.sampleRate, settings, show);
    const mixed = bufferFrom(mfTuneMix(channelsOf(base), src, result.lead, result.harmony, settings.harmonyMix), base.sampleRate);
    t.applied = { settings, stats: result.stats };
    if (typeof forensicState !== 'undefined' && typeof measureBuffer === 'function') {
      // Keep the whole-mix change figures describing the mix that is actually handed on.
      const before = measureBuffer(state.original), after = measureBuffer(mixed);
      forensicState.reconstruction = {
        peakShift: after.peakDb - before.peakDb, lufsShift: after.lufs - before.lufs,
        widthShift: after.widthDb - before.widthDb, correlationShift: after.correlation - before.correlation,
      };
    }
    paint();
    return mixed;
  };

  function changed() {
    const t = current();
    if (tune.previewUrl) { try { URL.revokeObjectURL(tune.previewUrl); } catch { /* already gone */ } tune.previewUrl = null; }
    const player = $('vocalTunePlayer'); if (player) { player.pause(); player.hidden = true; player.removeAttribute('src'); }
    const inMix = t.applied && JSON.stringify(t.applied.settings) === JSON.stringify(t.settings);
    const mixBuilt = Boolean(state.corrected && state.corrected !== state.original);
    if (!inMix && (mixBuilt || t.applied)) {
      if (state.master && typeof invalidateRenderedMaster === 'function') invalidateRenderedMaster('The vocal tuning changed. Rebuild the mix, then render the master again.');
      say('Changed. Press "Rebuild mix with this vocal" to put it in the song.', 'warn');
    } else if (!mfTuneActive(t.settings)) say('Everything is off. The vocal is left as it was sung.');
    else say('Ready. Preview it on its own, or rebuild the mix to hear it in the song.');
    paint();
  }

  function say(message, kind = '') {
    const el = $('vocalTuneStatus'); if (!el) return;
    el.textContent = message; el.className = `status${kind ? ` ${kind}` : ''}`;
  }

  function row(root, { key, label, min, max, step, format }) {
    const wrap = document.createElement('label'); wrap.className = 'mf-ctl'; wrap.dataset.key = key;
    const text = document.createElement('span'); const name = document.createElement('b'); name.textContent = label; text.append(name);
    const input = document.createElement('input'); input.type = 'range'; input.min = min; input.max = max; input.step = step; input.id = `vocalTune_${key}`;
    const out = document.createElement('output');
    const sync = () => {
      const value = Number(input.value), span = max - min;
      out.textContent = format(value);
      input.style.setProperty('--p', `${span ? ((value - min) / span) * 100 : 0}%`);
    };
    input.addEventListener('input', sync);
    input.addEventListener('change', () => { current().settings[key] = Number(input.value); changed(); });
    wrap.append(text, input, out); wrap.sync = sync; root.append(wrap);
  }
  function pick(root, { key, label, options }) {
    const wrap = document.createElement('label'); wrap.className = 'mf-ctl mf-ctl-select'; wrap.dataset.key = key;
    const text = document.createElement('span'); const name = document.createElement('b'); name.textContent = label; text.append(name);
    const select = document.createElement('select'); select.id = `vocalTune_${key}`;
    for (const [value, title] of options) { const o = document.createElement('option'); o.value = value; o.textContent = title; select.append(o); }
    select.addEventListener('change', () => { current().settings[key] = select.value; changed(); });
    wrap.append(text, select); root.append(wrap);
  }

  function build() {
    const panel = $('vocalPanel');
    if (!panel || $('vocalTuneRows')) return;
    const rows = document.createElement('div'); rows.id = 'vocalTuneRows'; rows.className = 'mf-controls mf-controls-rows';
    const snap = document.createElement('label'); snap.className = 'mf-ctl mf-ctl-switch'; snap.dataset.key = 'snap';
    const snapText = document.createElement('span'); const snapName = document.createElement('b'); snapName.textContent = 'Snap to key';
    const heard = document.createElement('small'); heard.className = 'mf-ctl-pick'; heard.id = 'vocalTuneHeard'; snapText.append(snapName, heard);
    const box = document.createElement('input'); box.type = 'checkbox'; box.id = 'vocalTune_snap';
    box.addEventListener('change', () => { current().settings.snap = box.checked; changed(); });
    snap.append(snapText, box); rows.append(snap);
    pick(rows, { key: 'key', label: 'Key', options: MFPitch.NAMES.map((n) => [n, n]) });
    pick(rows, { key: 'scale', label: 'Scale', options: Object.keys(MFPitch.SCALES).map((n) => [n, n.replace('_pent', ' pentatonic')]) });
    row(rows, { key: 'strength', label: 'Snap strength', min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` });
    row(rows, { key: 'semitones', label: 'Pitch shift', min: -12, max: 12, step: 1, format: (v) => `${v > 0 ? '+' : ''}${v} st` });
    pick(rows, { key: 'harmony', label: 'Harmony', options: MF_TUNE_HARMONIES });
    row(rows, { key: 'harmonyMix', label: 'Harmony level', min: 0, max: 0.8, step: 0.05, format: (v) => `${Math.round(v * 100)}%` });
    row(rows, { key: 'preserve', label: 'Keep natural tone', min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` });

    const actions = document.createElement('div'); actions.className = 'actions';
    const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'secondary'; preview.id = 'vocalTunePreviewBtn'; preview.textContent = 'Preview tuned vocal';
    const rebuild = document.createElement('button'); rebuild.type = 'button'; rebuild.className = 'primary'; rebuild.id = 'vocalTuneRebuildBtn'; rebuild.textContent = 'Rebuild mix with this vocal';
    actions.append(preview, rebuild);
    const player = document.createElement('audio'); player.id = 'vocalTunePlayer'; player.controls = true; player.hidden = true;
    const status = document.createElement('div'); status.className = 'status'; status.id = 'vocalTuneStatus'; status.setAttribute('aria-live', 'polite');
    const applied = document.createElement('p'); applied.className = 'mf-controls-note'; applied.id = 'vocalTuneApplied';
    panel.append(rows, actions, player, status, applied);

    preview.addEventListener('click', async () => {
      const source = sourceVocal(), t = current();
      if (!source) return;
      preview.disabled = true;
      try {
        const result = await mfTuneVocal(MFPitch, channelsOf(source), source.sampleRate, t.settings, async (label, f) => { say(`${label}… ${Math.round(f * 100)}%`, 'busy'); await breathe(); });
        const silent = channelsOf(source).map((d) => new Float32Array(d.length));
        // The vocal alone, as the mix will get it: tuned lead plus harmony.
        const solo = mfTuneMix(silent, silent, result.lead, result.harmony, t.settings.harmonyMix);
        const blob = await encodeWav(bufferFrom(solo, source.sampleRate), 16);
        if (tune.previewUrl) URL.revokeObjectURL(tune.previewUrl);
        tune.previewUrl = URL.createObjectURL(blob);
        player.src = tune.previewUrl; player.hidden = false;
        say(result.stats.snapped
          ? `Snap moved ${Math.round(result.stats.movedShare * 100)}% of the vocal, ${Math.round(result.stats.averageCents)} cents on average. Listen for warble before you rebuild.`
          : 'Preview ready. Listen for warble before you rebuild.', 'ok');
      } catch (error) {
        console.error(error); say(`Could not tune the vocal: ${error.message}`, 'error');
      } finally { preview.disabled = false; }
    });
    // The rebuild itself stays where it always was; this is a second handle on the same button.
    rebuild.addEventListener('click', () => { $('rebuildBtn')?.click(); });
  }

  function paint() {
    build();
    if (!$('vocalTuneRows')) return;
    const t = current(), s = t.settings;
    $('vocalTune_snap').checked = s.snap;
    for (const key of ['key', 'scale', 'harmony']) $(`vocalTune_${key}`).value = s[key];
    for (const key of ['strength', 'semitones', 'harmonyMix', 'preserve']) {
      const input = $(`vocalTune_${key}`);
      if (document.activeElement !== input) input.value = String(s[key]);
      input.closest('.mf-ctl').sync();
    }
    $('vocalTuneHeard').textContent = t.heard
      ? `MixForge heard ${t.heard.key} ${t.heard.scale} in the whole mix. Change it below if that is wrong.`
      : 'Set the key below.';
    $('vocalTunePreviewBtn').disabled = !mfTuneActive(s);
    const a = t.applied;
    $('vocalTuneApplied').textContent = a
      ? `In the rebuilt mix now: ${[
        a.stats.snapped ? `snap to ${a.settings.key} ${a.settings.scale} at ${Math.round(a.settings.strength * 100)}% (moved ${Math.round(a.stats.movedShare * 100)}% of the vocal, ${Math.round(a.stats.averageCents)} cents on average)` : '',
        a.stats.shifted ? `pitch shift ${a.stats.shifted > 0 ? '+' : ''}${a.stats.shifted} semitones` : '',
        a.stats.harmony ? `harmony at ${Math.round(a.settings.harmonyMix * 100)}%` : '',
      ].filter(Boolean).join('; ')}.`
      : 'Nothing from this step is in the mix yet.';
  }

  // Show the step once there is a vocal stem; put it away with the stems.
  const previousRenderStemPlans = renderStemPlans;
  renderStemPlans = function renderStemPlansWithVocalTune() {
    previousRenderStemPlans();
    const panel = $('vocalPanel'); if (!panel) return;
    if (state.stemBuffers?.vocals) { current(); paint(); panel.classList.remove('hidden'); if (!$('vocalTuneStatus').textContent) say('Everything is off. The vocal is left as it was sung.'); }
    else panel.classList.add('hidden');
  };
  const stemPanel = $('stemPanel');
  if (stemPanel && $('vocalPanel')) {
    new MutationObserver(() => { if (stemPanel.classList.contains('hidden')) $('vocalPanel').classList.add('hidden'); })
      .observe(stemPanel, { attributes: true, attributeFilter: ['class'] });
  }
}

if (typeof module !== 'undefined') module.exports = { MF_TUNE_DEFAULTS, mfTuneActive, mfTuneHarmonyCurve, mfTuneVocal, mfTuneMix };
