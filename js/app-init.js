'use strict';

const $ = (id) => document.getElementById(id);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const dbToGain = (db) => Math.pow(10, db / 20);
const gainToDb = (g) => 20 * Math.log10(Math.max(g, 1e-12));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;

const SUPA_URL = 'https://xbzypzgnwgrmmvtrmdzl.supabase.co';
const SUPA_KEY = 'sb_publishable_lhVBmqHvnAiAUR7Q7L_aQQ_BZH05ZGj';
const STEMS = ['vocals', 'bass', 'drums', 'guitars', 'keys', 'other'];
const BANDS = [
  { name: 'Sub', lo: 20, hi: 60 },
  { name: 'Bass', lo: 60, hi: 250 },
  { name: 'Low-mids', lo: 250, hi: 500 },
  { name: 'Mids', lo: 500, hi: 2000 },
  { name: 'Presence', lo: 2000, hi: 5000 },
  { name: 'Air', lo: 5000, hi: 16000 },
];

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const FILE_READ_TIMEOUT_MS = 180000;
const AUDIO_DECODE_TIMEOUT_MS = 180000;

const state = {
  audioCtx: null,
  file: null,
  storagePath: null,
  original: null,
  corrected: null,
  master: null,
  mixMetrics: null,
  correctedMetrics: null,
  finalMetrics: null,
  audit: null,
  stemBuffers: {},
  stemPlans: {},
  masterPlan: null,
  source: null,
  analyser: null,
  meterFrame: null,
  loadToken: 0,
};

function setStatus(id, message = '', kind = '') {
  const el = $(id);
  el.textContent = message;
  el.className = `status${kind ? ` ${kind}` : ''}`;
}

function reveal(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function timeoutError(message) {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
}

async function ensureAudioContext(resumeForPlayback = true) {
  if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (resumeForPlayback && state.audioCtx.state === 'suspended') {
    await Promise.race([
      state.audioCtx.resume(),
      new Promise((_, reject) => setTimeout(() => reject(timeoutError('iPhone blocked audio playback. Tap Play again.')), 8000)),
    ]);
  }
  return state.audioCtx;
}

function readFileBytes(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      try { reader.abort(); } catch (_) {}
      const message = IS_IOS
        ? 'The file did not finish downloading from iCloud. In Files, tap and hold the song, choose Download Now, then select it again.'
        : 'The browser could not finish reading this file. Save a local copy and try again.';
      finish(reject, timeoutError(message));
    }, FILE_READ_TIMEOUT_MS);

    reader.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    reader.onload = () => {
      if (!(reader.result instanceof ArrayBuffer) || reader.result.byteLength === 0) {
        finish(reject, new Error('The selected file was empty or still stored only in iCloud. Download it to this iPhone first.'));
        return;
      }
      finish(resolve, reader.result);
    };
    reader.onerror = () => finish(reject, reader.error || new Error('iPhone could not read the selected file.'));
    reader.onabort = () => finish(reject, new Error('File reading was interrupted.'));

    try { reader.readAsArrayBuffer(file); }
    catch (error) { finish(reject, error); }
  });
}

function decodeAudioDataSafe(ctx, bytes) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      const message = IS_IOS
        ? 'iPhone could not decode this file in time. Export it as WAV, AIFF, MP3, or M4A and try again.'
        : 'The browser could not decode this audio file in time.';
      finish(reject, timeoutError(message));
    }, AUDIO_DECODE_TIMEOUT_MS);

    const success = (decoded) => finish(resolve, decoded);
    const failure = (error) => finish(reject, error instanceof Error ? error : new Error('Unsupported or damaged audio file.'));
    try {
      const maybePromise = ctx.decodeAudioData(bytes.slice(0), success, failure);
      if (maybePromise && typeof maybePromise.then === 'function') maybePromise.then(success, failure);
    } catch (error) {
      failure(error);
    }
  });
}

async function loadFile(file) {
  if (!file) return;
  const token = ++state.loadToken;
  if (file.size === 0) {
    setStatus('auditStatus', 'This file is not downloaded to the phone yet. Download it in Files, then choose it again.', 'error');
    return;
  }
  if (file.size > 750 * 1024 * 1024) {
    setStatus('auditStatus', 'This file is over 750 MB. Export a standard WAV or AIFF mix first.', 'error');
    return;
  }

  stopPreview();
  setStatus('auditStatus', IS_IOS ? 'Reading audio from your iPhone…' : 'Reading audio file…', 'busy');
  try {
    const bytes = await readFileBytes(file, (percent) => {
      if (token === state.loadToken) setStatus('auditStatus', `Reading audio… ${percent}%`, 'busy');
    });
    if (token !== state.loadToken) return;

    setStatus('auditStatus', 'Decoding audio…', 'busy');
    // Decoding does not require the AudioContext to be playing. Waiting for
    // resume() here can hang indefinitely after iOS returns from Files.
    const ctx = await ensureAudioContext(false);
    const decoded = await decodeAudioDataSafe(ctx, bytes);
    if (token !== state.loadToken) return;
    if (!decoded.length || !decoded.numberOfChannels) throw new Error('The file contained no decodable audio.');

    state.file = file;
    state.original = decoded;
    state.corrected = null;
    state.master = null;
    state.audit = null;
    state.storagePath = null;
    state.stemBuffers = {};
    state.stemPlans = {};
    resetResults();
    $('dropzone').classList.add('loaded');
    $('fileMeta').textContent = `${file.name} · ${formatDuration(decoded.duration)} · ${decoded.sampleRate / 1000} kHz · ${decoded.numberOfChannels === 1 ? 'mono' : 'stereo'}`;
    $('auditBtn').disabled = false;
    setStatus('auditStatus', 'Ready to audit.', 'ok');
  } catch (error) {
    if (token !== state.loadToken) return;
    console.error(error);
    state.file = null;
    state.original = null;
    $('auditBtn').disabled = true;
    const detail = error?.message || 'Unknown audio error';
    setStatus('auditStatus', `Could not open this audio file: ${detail}`, 'error');
  }
}

function resetResults() {
  ['auditPanel', 'stemPanel', 'masterPanel', 'verifyPanel'].forEach(hide);
  $('auditFindings').replaceChildren();
  $('stemGrid').replaceChildren();
  $('masterChain').replaceChildren();
  $('verificationList').replaceChildren();
}

$('dropzone').addEventListener('click', () => {
  // Clearing the value lets iPhone users retry the same file after a failed read.
  $('fileInput').value = '';
  $('fileInput').click();
});
$('fileInput').addEventListener('change', (event) => loadFile(event.target.files?.[0]));
for (const eventName of ['dragenter', 'dragover']) {
  $('dropzone').addEventListener(eventName, (event) => {
    event.preventDefault();
    $('dropzone').classList.add('drag');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  $('dropzone').addEventListener(eventName, (event) => {
    event.preventDefault();
    $('dropzone').classList.remove('drag');
  });
}
$('dropzone').addEventListener('drop', (event) => loadFile(event.dataTransfer.files?.[0]));
