'use strict';

// Master controls: MixDoctor-style sliders on the Master step.
//
// MixForge still decides the master plan from its measurements. This file reads that plan, puts each
// slider where the plan put it, and lets the musician move it. A moved slider becomes an override that
// is applied on top of MixForge's plan; everything the musician leaves alone stays MixForge's choice.
// Changing a control after a master was rendered marks that master out of date (the app already
// refuses to export a stale master), so it has to be rendered and measured again.
//
// Loads after every other layer that wraps buildMasterPlan / renderMasterChain, so its wrappers are
// the outermost ones.

const MF_CTL_BANDS = [
  { key: 'sub', label: 'Sub (55 Hz shelf)', filterType: 'lowshelf', frequency: 55, q: 0.7, min: -4, max: 0, own: 'Your sub trim',
    match: (op) => op.filterType === 'lowshelf' && op.frequency <= 120 },
  { key: 'mud', label: 'Mud (350 Hz)', filterType: 'peaking', frequency: 350, q: 0.9, min: -4, max: 0, own: 'Your low-mid cut',
    match: (op) => op.filterType === 'peaking' && op.frequency >= 200 && op.frequency <= 600 },
  { key: 'presence', label: 'Presence / harshness (3.2 kHz)', filterType: 'peaking', frequency: 3200, q: 0.8, min: -4, max: 3, own: 'Your presence move',
    match: (op) => op.filterType === 'peaking' && op.frequency >= 2000 && op.frequency <= 5000 },
  { key: 'air', label: 'Air (9.5 kHz shelf)', filterType: 'highshelf', frequency: 9500, q: 0.7, min: 0, max: 4, own: 'Your air shelf',
    match: (op) => op.filterType === 'highshelf' && op.frequency >= 6000 },
];
const MF_CTL_LOUDNESS = { key: 'loudness', label: 'Loudness target', min: -16, max: -8, step: 0.5 };
const MF_CTL_CEILING = { key: 'ceiling', label: 'True-peak ceiling', min: -2, max: -0.5, step: 0.1 };
// The internal limiter ceiling sits this far under the final true-peak ceiling in MixForge's own plan.
const MF_CTL_LIMITER_MARGIN_DB = 0.2;

const mfCtlRound = (value, step = 0.5) => Math.round(value / step) * step;

// Where MixForge's own plan puts each control. Pure.
function mfCtlRead(plan) {
  const picks = { reasons: {} };
  for (const band of MF_CTL_BANDS) {
    const op = (plan.eq || []).find(band.match);
    picks[band.key] = op ? op.gain : 0;
    picks.reasons[band.key] = op ? op.label : 'left alone';
  }
  picks.loudness = plan.targetLufs;
  picks.ceiling = plan.truePeakCeilingDb ?? plan.ceilingDb;
  picks.dynamics = true;
  picks.reasons.dynamics = plan.multiband?.pending ? 'decided per band when you render'
    : plan.multiband ? 'multiband on the bands that surge'
      : plan.compressor ? 'gentle glue compression' : 'none needed for this mix';
  return picks;
}

// MixForge's plan with the musician's overrides on top. Pure: returns a new plan.
// `user` holds only the controls that were moved, e.g. { air: 2.5, dynamics: false }.
function mfCtlApply(plan, user = {}) {
  const out = { ...plan, eq: (plan.eq || []).map((op) => ({ ...op })) };
  const moved = [];
  for (const band of MF_CTL_BANDS) {
    if (!Number.isFinite(user[band.key])) continue;
    const gain = Math.max(band.min, Math.min(band.max, user[band.key]));
    out.eq = out.eq.filter((op) => !band.match(op));
    if (Math.abs(gain) >= 0.25) out.eq.push({ type: 'eq', filterType: band.filterType, frequency: band.frequency, gain, q: band.q, label: band.own });
    moved.push(band.key);
  }
  if (Number.isFinite(user.ceiling)) {
    const ceiling = Math.max(MF_CTL_CEILING.min, Math.min(MF_CTL_CEILING.max, user.ceiling));
    out.truePeakCeilingDb = ceiling;
    out.ceilingDb = ceiling - MF_CTL_LIMITER_MARGIN_DB;
    moved.push('ceiling');
  }
  if (user.dynamics === false) {
    out.compressor = null;
    out.multiband = null;
    out.dynamicsOff = true;
    moved.push('dynamics');
  }
  if (Number.isFinite(user.loudness)) moved.push('loudness');
  out.userMoved = moved;
  return out;
}

// What counts as "the same song" for settings the musician chose. A plain loaded file is the song for as
// long as it is loaded. Stems mixed in the stem mixer are re-summed into a fresh file on every Mix and
// master run, so there the song is the library song (or the set of stem files), not the summed file;
// otherwise a second run would throw the musician's settings away. Pure.
function mfSongIdentity(appState) {
  const run = appState?.libraryRebuild;
  if (run?.file && appState.file === run.file) return `stems:${run.songId || 'local'}:${run.file.name}`;
  // The vocal step swaps in a tuned copy of the loaded mix while it rebuilds; that is still the same song.
  const original = appState?.original || null;
  const aliases = typeof globalThis !== 'undefined' ? globalThis.mixForgeSongAliases : null;
  return (original && aliases?.get(original)) || original;
}

// A short, stable description of the overrides, for the key a saved master is filed under. Empty when
// nothing was moved, so an untouched run is filed exactly as before. Pure.
function mfCtlRunKey(user = {}) {
  const keys = Object.keys(user).filter((key) => user[key] === false || Number.isFinite(user[key])).sort();
  return keys.length ? `|controls:${keys.map((key) => `${key}=${user[key] === false ? 'off' : Number(user[key]).toFixed(2)}`).join(',')}` : '';
}

const mfCtl = { song: null, user: {}, picks: null };
function mfCtlUser() {
  // Overrides belong to one song. A new song starts from MixForge's picks again.
  if (typeof state !== 'undefined') {
    const song = mfSongIdentity(state);
    if (mfCtl.song !== song) { mfCtl.song = song; mfCtl.user = {}; }
  }
  return mfCtl.user;
}
// Anything that changes what a Mix and master run produces adds its part to the saved master's key here.
if (typeof globalThis !== 'undefined') {
  globalThis.mixForgeRunKeyParts = globalThis.mixForgeRunKeyParts || [];
  globalThis.mixForgeRunKeyParts.push(() => mfCtlRunKey(mfCtlUser()));
}

if (typeof buildMasterPlan === 'function') {
  const mfCtlPreviousBuildMasterPlan = buildMasterPlan;
  buildMasterPlan = function buildMasterPlanControls(metrics, requestedTargetLufs) {
    const user = mfCtlUser();
    const target = Number.isFinite(user.loudness) ? user.loudness : requestedTargetLufs;
    const auto = mfCtlPreviousBuildMasterPlan(metrics, target);
    // What MixForge would pick for loudness is the menu on the Load step, not the override.
    mfCtl.picks = { ...mfCtlRead(auto), loudness: Math.max(-18, Math.min(-8, Number(requestedTargetLufs) || -12)) };
    return mfCtlApply(auto, user);
  };

  const mfCtlPreviousRenderMasterChain = renderMasterChain;
  renderMasterChain = function renderMasterChainControls(plan) {
    mfCtlPreviousRenderMasterChain(plan);
    if (plan?.dynamicsOff) {
      for (const row of $('masterChain').querySelectorAll('.chain-item')) {
        if (row.querySelector('b')?.textContent === 'Dynamics decision') row.querySelector('span').textContent = 'Off: you switched dynamics control off';
      }
    }
    // The multiband decision is made at render time and written back into the plan; show it once it is known.
    else if (mfCtl.picks && plan) mfCtl.picks.reasons.dynamics = mfCtlRead(plan).reasons.dynamics;
    mfCtlRender();
  };
}

function mfCtlFormat(key, value) {
  if (key === 'loudness') return `${value.toFixed(1)} LUFS`;
  if (key === 'ceiling') return `${value.toFixed(1)} dBTP`;
  return `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;
}

function mfCtlValue(key) {
  const user = mfCtlUser();
  if (key === 'dynamics') return user.dynamics !== false;
  return Number.isFinite(user[key]) ? user[key] : mfCtl.picks?.[key] ?? 0;
}

function mfCtlChanged(key, value) {
  const user = mfCtlUser();
  const pick = mfCtl.picks?.[key];
  // Back on MixForge's own pick means no override at all.
  if (key === 'dynamics') { if (value) delete user.dynamics; else user.dynamics = false; }
  else if (Number.isFinite(pick) && Math.abs(value - pick) < 0.026) delete user[key];
  else user[key] = value;
  if (!state.correctedMetrics) return;
  state.masterPlan = buildMasterPlan(state.correctedMetrics, Number($('targetLufs').value));
  if (state.master) invalidateRenderedMaster('You moved a control. Render the master again to hear it and export it.');
  else state.masterDirty = true;
  renderMasterChain(state.masterPlan);
  if (typeof syncExportUi === 'function') syncExportUi(state);
}

function mfCtlRow(root, spec, step) {
  const row = document.createElement('label');
  row.className = 'mf-ctl';
  row.dataset.key = spec.key;
  const text = document.createElement('span');
  const name = document.createElement('b'); name.textContent = spec.label;
  const pick = document.createElement('small'); pick.className = 'mf-ctl-pick';
  text.append(name, pick);
  const input = document.createElement('input');
  input.type = 'range'; input.min = spec.min; input.max = spec.max; input.step = step; input.id = `mfCtl_${spec.key}`;
  const out = document.createElement('output'); out.htmlFor = input.id;
  input.addEventListener('input', () => { mfCtlPaintRow(row, Number(input.value)); });
  input.addEventListener('change', () => mfCtlChanged(spec.key, Number(input.value)));
  row.append(text, input, out);
  root.append(row);
}

function mfCtlPaintRow(row, value) {
  const key = row.dataset.key;
  const input = row.querySelector('input');
  const picks = mfCtl.picks || {};
  if (key === 'dynamics') {
    input.checked = Boolean(value);
    row.querySelector('.mf-ctl-pick').textContent = `MixForge: ${picks.reasons?.dynamics || 'decides from the mix'}`;
    row.classList.toggle('mf-ctl-moved', !value);
    return;
  }
  if (document.activeElement !== input || Number(input.value) !== value) input.value = String(value);
  const span = Number(input.max) - Number(input.min);
  input.style.setProperty('--p', `${span ? ((value - Number(input.min)) / span) * 100 : 0}%`);
  row.querySelector('output').textContent = mfCtlFormat(key, value);
  const pick = picks[key];
  const reason = picks.reasons?.[key];
  row.querySelector('.mf-ctl-pick').textContent = Number.isFinite(pick)
    ? `MixForge: ${mfCtlFormat(key, pick)}${reason && reason !== 'left alone' ? ` · ${reason}` : reason ? ' · left alone' : ''}`
    : '';
  row.classList.toggle('mf-ctl-moved', Number.isFinite(pick) && Math.abs(value - pick) >= 0.026);
}

function mfCtlRender() {
  const chain = typeof $ === 'function' ? $('masterChain') : null;
  if (!chain || !mfCtl.picks) return;
  let root = $('masterControls');
  if (!root) {
    root = document.createElement('section');
    root.id = 'masterControls';
    root.className = 'mf-controls';
    const head = document.createElement('div'); head.className = 'mf-controls-head';
    const title = document.createElement('h3'); title.textContent = 'Your controls';
    const reset = document.createElement('button');
    reset.type = 'button'; reset.id = 'masterControlsReset'; reset.className = 'secondary'; reset.textContent = "Back to MixForge's picks";
    reset.addEventListener('click', () => {
      const user = mfCtlUser();
      if (!Object.keys(user).length) return;
      for (const key of Object.keys(user)) delete user[key];
      mfCtlChanged('dynamics', true);
    });
    head.append(title, reset);
    const note = document.createElement('p'); note.className = 'mf-controls-note';
    note.textContent = 'Each control starts where MixForge put it for this mix. Move one and it becomes your call; the master is then rendered and measured again before it can be exported.';
    const rows = document.createElement('div'); rows.className = 'mf-controls-rows';
    mfCtlRow(rows, MF_CTL_LOUDNESS, MF_CTL_LOUDNESS.step);
    for (const band of MF_CTL_BANDS) mfCtlRow(rows, band, 0.5);
    const sw = document.createElement('label'); sw.className = 'mf-ctl mf-ctl-switch'; sw.dataset.key = 'dynamics';
    const swText = document.createElement('span');
    const swName = document.createElement('b'); swName.textContent = 'Dynamics control';
    const swPick = document.createElement('small'); swPick.className = 'mf-ctl-pick';
    swText.append(swName, swPick);
    const box = document.createElement('input'); box.type = 'checkbox'; box.id = 'mfCtl_dynamics';
    box.addEventListener('change', () => mfCtlChanged('dynamics', box.checked));
    sw.append(swText, box);
    rows.append(sw);
    mfCtlRow(rows, MF_CTL_CEILING, MF_CTL_CEILING.step);
    root.append(head, note, rows);
    chain.before(root);
  }
  for (const row of root.querySelectorAll('.mf-ctl')) mfCtlPaintRow(row, mfCtlValue(row.dataset.key));
  $('masterControlsReset').disabled = !Object.keys(mfCtlUser()).length;
}

// The loudness menu on the Load step is MixForge's pick; choosing there clears a loudness override.
if (typeof document !== 'undefined' && typeof $ === 'function' && $('targetLufs')) {
  $('targetLufs').addEventListener('change', () => {
    delete mfCtlUser().loudness;
    if (state.masterPlan && state.correctedMetrics) {
      state.masterPlan = buildMasterPlan(state.correctedMetrics, Number($('targetLufs').value));
      renderMasterChain(state.masterPlan);
    }
  });
}

if (typeof module !== 'undefined') module.exports = { MF_CTL_BANDS, mfCtlRead, mfCtlApply, mfSongIdentity, mfCtlRunKey };
