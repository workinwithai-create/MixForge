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

async function ensureAudioContext() {
  if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (state.audioCtx.state === 'suspended') await state.audioCtx.resume();
  return state.audioCtx;
}

async function loadFile(file) {
  if (!file) return;
  if (file.size > 750 * 1024 * 1024) { setStatus('auditStatus', 'This file is over 750 MB. Export a standard WAV or AIFF mix first.', 'error'); return; }
  stopPreview();
  setStatus('auditStatus', 'Decoding audio…', 'busy');
  try {
    const ctx = await ensureAudioContext();
    const bytes = await file.arrayBuffer();
    const decoded = await ctx.decodeAudioData(bytes.slice(0));
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
    console.error(error);
    state.file = null;
    state.original = null;
    $('auditBtn').disabled = true;
    setStatus('auditStatus', `Could not open this audio file: ${error.message}`, 'error');
  }
}

function resetResults() {
  ['auditPanel', 'stemPanel', 'masterPanel', 'verifyPanel'].forEach(hide);
  $('auditFindings').replaceChildren();
  $('stemGrid').replaceChildren();
  $('masterChain').replaceChildren();
  $('verificationList').replaceChildren();
}

$('dropzone').addEventListener('click', () => $('fileInput').click());
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
