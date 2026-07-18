'use strict';

// MixForge 2.0.4 signal-integrity layer.
// Keeps corrective work reconstruction-safe while making playback and the
// actual original-to-master change independently verifiable on iPhone.

const mfSignalPreviewUrls = new WeakMap();
let mfNativePreviewToken = 0;

async function mfResumeContextWithTimeout(ctx) {
  try {
    await Promise.race([
      ctx.resume(),
      new Promise((resolve) => setTimeout(resolve, 1400)),
    ]);
  } catch (_) {}
}

function mfPulseAudioContext(ctx) {
  try {
    const buffer = ctx.createBuffer(1, 2, Math.max(22050, ctx.sampleRate || 44100));
    buffer.getChannelData(0)[0] = 0.00001;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
  } catch (_) {}
}

const mfPreviousEnsureAudioContext = ensureAudioContext;
ensureAudioContext = async function ensureMixForgeAudioContext(resumeForPlayback = true) {
  let ctx = await mfPreviousEnsureAudioContext(false);
  if (!resumeForPlayback) return ctx;

  await mfResumeContextWithTimeout(ctx);
  mfPulseAudioContext(ctx);
  for (let attempt = 0; attempt < 4 && ctx.state !== 'running'; attempt++) {
    await sleep(80);
    await mfResumeContextWithTimeout(ctx);
    mfPulseAudioContext(ctx);
  }

  if (ctx.state !== 'running') {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const fresh = new AudioCtx({ latencyHint: 'interactive' });
      state.audioCtx = typeof installStemDecodeAlignment === 'function'
        ? installStemDecodeAlignment(fresh)
        : fresh;
      ctx = state.audioCtx;
      await mfResumeContextWithTimeout(ctx);
      mfPulseAudioContext(ctx);
      await sleep(60);
    } catch (_) {}
  }

  if (ctx.state !== 'running') {
    throw new Error(`iPhone audio engine remained ${ctx.state}. Use the native iPhone preview player below.`);
  }
  return ctx;
};

// The old default was so conservative that valid repairs could be effectively
// inaudible. Increase only the differential wet path, and scale it down when
// extraction quality is not high enough to support it.
const mfPreviousBuildStemPlans = buildStemPlans;
buildStemPlans = async function buildAudibleGuardedStemPlans() {
  await mfPreviousBuildStemPlans();
  for (const plan of Object.values(state.stemPlans || {})) {
    if (!Array.isArray(plan.candidates) || plan.candidates.length < 3) continue;
    const quality = Number(plan.quality?.score || 75);
    const targets = quality >= 82
      ? [0.22, 0.42, 0.45]
      : quality >= 65
        ? [0.18, 0.34, 0.42]
        : [0.12, 0.22, 0.30];
    plan.candidates.forEach((candidate, index) => {
      candidate.wet = Math.max(Number(candidate.wet) || 0, targets[index] || targets[1]);
    });
    const selected = clamp(Number(plan.selectedCandidate) || 0, 0, plan.candidates.length - 1);
    plan.wet = plan.candidates[selected].wet;
    plan.operations = plan.candidates[selected].operations;
  }
};

async function mfBuildDifferenceMonitor(original, master) {
  if (!original || !master) return { buffer: null, metrics: null };
  const ctx = await ensureAudioContext(false);
  const channels = Math.max(1, Math.min(original.numberOfChannels, master.numberOfChannels));
  const length = Math.min(original.length, master.length);
  const output = ctx.createBuffer(channels, length, original.sampleRate);
  let originalEnergy = 0;
  let differenceEnergy = 0;
  let rawPeak = 0;
  let count = 0;
  const chunk = 131072;

  for (let start = 0; start < length; start += chunk) {
    const end = Math.min(length, start + chunk);
    for (let channel = 0; channel < channels; channel++) {
      const before = original.getChannelData(Math.min(channel, original.numberOfChannels - 1));
      const after = master.getChannelData(Math.min(channel, master.numberOfChannels - 1));
      const delta = output.getChannelData(channel);
      for (let index = start; index < end; index++) {
        const change = after[index] - before[index];
        delta[index] = change;
        originalEnergy += before[index] * before[index];
        differenceEnergy += change * change;
        rawPeak = Math.max(rawPeak, Math.abs(change));
        count++;
      }
    }
    await sleep(0);
  }

  const relativeDb = 10 * Math.log10(Math.max(differenceEnergy, 1e-20) / Math.max(originalEnergy, 1e-20));
  const differenceRmsDb = 10 * Math.log10(Math.max(differenceEnergy / Math.max(1, count), 1e-20));
  const rawPeakDb = gainToDb(rawPeak);
  const monitorGain = rawPeak > 1e-9 ? clamp(dbToGain(-6) / rawPeak, 1, 20) : 1;

  for (let channel = 0; channel < channels; channel++) {
    const data = output.getChannelData(channel);
    for (let index = 0; index < data.length; index++) data[index] *= monitorGain;
    await sleep(0);
  }

  return {
    buffer: output,
    metrics: {
      relativeDb,
      differenceRmsDb,
      rawPeakDb,
      monitorGainDb: gainToDb(monitorGain),
    },
  };
}

const mfPreviousRenderReleaseMaster = renderReleaseMaster;
renderReleaseMaster = async function renderVerifiedReleaseMaster() {
  const master = await mfPreviousRenderReleaseMaster();
  const difference = await mfBuildDifferenceMonitor(state.original, master);
  state.masterDelta = difference.buffer;
  state.masterChange = difference.metrics;
  setTimeout(() => mfPrepareNativePreview(), 0);
  return master;
};

const mfPreviousCurrentPreviewBuffer = currentPreviewBuffer;
currentPreviewBuffer = function currentVerifiedPreviewBuffer() {
  const selected = document.querySelector('input[name="preview"]:checked')?.value;
  if (selected === 'difference') return state.masterDelta;
  return mfPreviousCurrentPreviewBuffer();
};

const mfPreviousRenderVerification = renderVerification;
renderVerification = function renderSignalVerification(metrics, plan) {
  mfPreviousRenderVerification(metrics, plan);
  const change = state.masterChange;
  if (!change) return;
  const root = $('verificationList');
  const meaningful = change.relativeDb > -48;
  const clear = change.relativeDb > -34;
  const row = document.createElement('div');
  row.className = `check ${meaningful ? (clear ? '' : 'warn') : 'fail'}`;
  const icon = document.createElement('b');
  icon.textContent = meaningful ? (clear ? '✓' : '!') : '×';
  const detail = document.createElement('div');
  const label = document.createElement('strong');
  label.textContent = 'Original-to-master change: ';
  detail.append(label, document.createTextNode(`${change.relativeDb.toFixed(1)} dB relative delta; raw change peak ${change.rawPeakDb.toFixed(1)} dBFS. The “Changes only” preview is boosted ${change.monitorGainDb.toFixed(1)} dB for inspection and is never exported.`));
  row.append(icon, detail);
  root.append(row);
};

async function mfPreviewUrl(buffer) {
  if (!buffer) throw new Error('No rendered preview is available.');
  const cached = mfSignalPreviewUrls.get(buffer);
  if (cached) return cached;
  const blob = await encodeWav(buffer, 16);
  const url = URL.createObjectURL(blob);
  mfSignalPreviewUrls.set(buffer, url);
  return url;
}

async function mfPrepareNativePreview() {
  if (!IS_IOS) return;
  const player = $('mfNativePreview');
  const status = $('mfNativePreviewStatus');
  if (!player || !status) return;
  const buffer = currentPreviewBuffer();
  if (!buffer) return;
  const token = ++mfNativePreviewToken;
  status.textContent = 'Preparing native iPhone preview…';
  try {
    const url = await mfPreviewUrl(buffer);
    if (token !== mfNativePreviewToken) return;
    const position = player.currentTime || 0;
    player.src = url;
    player.load();
    try { player.currentTime = Math.min(position, Math.max(0, buffer.duration - 0.01)); } catch (_) {}
    const selected = document.querySelector('input[name="preview"]:checked')?.value || 'master';
    status.textContent = `${selected === 'difference' ? 'Changes only · boosted monitor' : `${selected} preview`} ready in the native iPhone player.`;
  } catch (error) {
    status.textContent = `Native preview failed: ${error.message}`;
  }
}

function mfInstallSignalIntegrityUI() {
  const previewSelect = document.querySelector('.preview-select');
  if (previewSelect && !$('mfDifferencePreview')) {
    const label = document.createElement('label');
    label.innerHTML = '<input id="mfDifferencePreview" type="radio" name="preview" value="difference"> Changes only';
    previewSelect.append(label);
  }

  const preview = $('previewBox');
  if (IS_IOS && preview && !$('mfNativePreview')) {
    const box = document.createElement('div');
    box.className = 'native-preview';
    box.innerHTML = '<strong>Native iPhone preview</strong><audio id="mfNativePreview" controls playsinline preload="metadata"></audio><small id="mfNativePreviewStatus">Rendered audio will appear here after mastering.</small>';
    preview.append(box);
  }

  document.addEventListener('change', (event) => {
    if (!event.target.matches('input[name="preview"]')) return;
    setTimeout(() => mfPrepareNativePreview(), 0);
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mfInstallSignalIntegrityUI);
else mfInstallSignalIntegrityUI();
