'use strict';

// MixForge 2.0.2 seekable A/B transport.
// Replaces the original start/stop-only preview without changing render audio.

const transportState = {
  offset: 0,
  startedAt: 0,
  duration: 0,
  raf: null,
  dragging: false,
};

function transportTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60).toString().padStart(2, '0');
  return `${minutes}:${secs}`;
}

function transportBuffer() {
  return currentPreviewBuffer();
}

function transportPosition() {
  if (state.source && state.audioCtx) {
    return clamp(transportState.offset + (state.audioCtx.currentTime - transportState.startedAt), 0, transportState.duration || 0);
  }
  return clamp(transportState.offset, 0, transportState.duration || 0);
}

function updateTransportUI(position = transportPosition()) {
  const buffer = transportBuffer();
  transportState.duration = buffer?.duration || 0;
  const duration = transportState.duration;
  const safe = clamp(position, 0, duration || 0);
  const seek = $('previewSeek');
  if (seek && !transportState.dragging) {
    seek.max = String(Math.max(duration, 0.001));
    seek.value = String(safe);
  }
  if ($('previewCurrent')) $('previewCurrent').textContent = transportTime(safe);
  if ($('previewDuration')) $('previewDuration').textContent = transportTime(duration);
}

function stopTransport({ preservePosition = true, reset = false } = {}) {
  const position = preservePosition ? transportPosition() : 0;
  if (state.source) {
    const source = state.source;
    state.source = null;
    try { source.onended = null; source.stop(); } catch (_) {}
    try { source.disconnect(); } catch (_) {}
  }
  if (state.analyser) { try { state.analyser.disconnect(); } catch (_) {} state.analyser = null; }
  if (state.meterFrame) cancelAnimationFrame(state.meterFrame);
  state.meterFrame = null;
  if (transportState.raf) cancelAnimationFrame(transportState.raf);
  transportState.raf = null;
  transportState.offset = reset ? 0 : position;
  if ($('playBtn')) $('playBtn').textContent = '▶ Play';
  if ($('meterFill')) $('meterFill').style.width = '0%';
  updateTransportUI(transportState.offset);
}

async function startTransport(at = transportState.offset) {
  const buffer = transportBuffer();
  if (!buffer) return;
  const ctx = await ensureAudioContext();
  const duration = buffer.duration || 0;
  const offset = duration > 0 ? clamp(at, 0, Math.max(0, duration - 0.001)) : 0;

  stopTransport({ preservePosition: false });
  transportState.duration = duration;
  transportState.offset = offset;

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  analyser.connect(ctx.destination);
  state.source = source;
  state.analyser = analyser;
  transportState.startedAt = ctx.currentTime;

  source.onended = () => {
    if (state.source !== source) return;
    const reachedEnd = transportPosition() >= duration - 0.08;
    stopTransport({ preservePosition: !reachedEnd, reset: reachedEnd });
  };
  source.start(0, offset);
  $('playBtn').textContent = '❚❚ Pause';

  const meterData = new Float32Array(analyser.fftSize);
  const loop = () => {
    if (state.source !== source) return;
    analyser.getFloatTimeDomainData(meterData);
    let peak = 0;
    for (const sample of meterData) peak = Math.max(peak, Math.abs(sample));
    if ($('meterFill')) $('meterFill').style.width = `${clamp((gainToDb(peak) + 45) / 45 * 100, 0, 100)}%`;
    updateTransportUI();
    transportState.raf = requestAnimationFrame(loop);
  };
  loop();
}

async function toggleTransport() {
  if (state.source) stopTransport({ preservePosition: true });
  else await startTransport();
}

async function seekTransport(seconds) {
  const wasPlaying = Boolean(state.source);
  const duration = transportBuffer()?.duration || 0;
  transportState.offset = clamp(Number(seconds) || 0, 0, duration);
  if (wasPlaying) await startTransport(transportState.offset);
  else updateTransportUI(transportState.offset);
}

function skipTransport(delta) {
  seekTransport(transportPosition() + delta);
}

function installTransport() {
  const preview = $('previewBox');
  const oldPlay = $('playBtn');
  if (!preview || !oldPlay || $('previewSeek')) return;

  // Cloning removes the original start/stop listener attached by app-master.js.
  const play = oldPlay.cloneNode(true);
  play.textContent = '▶ Play';
  oldPlay.replaceWith(play);

  const transport = document.createElement('div');
  transport.className = 'preview-transport';
  transport.innerHTML = `
    <div class="transport-buttons">
      <button type="button" class="transport-skip" id="previewBack" aria-label="Skip back 10 seconds">−10s</button>
      <span id="transportPlaySlot"></span>
      <button type="button" class="transport-skip" id="previewForward" aria-label="Skip forward 10 seconds">+10s</button>
    </div>
    <div class="transport-seek-row">
      <span id="previewCurrent">0:00</span>
      <input id="previewSeek" type="range" min="0" max="1" step="0.01" value="0" aria-label="Preview position">
      <span id="previewDuration">0:00</span>
    </div>`;
  preview.insertBefore(transport, preview.querySelector('.meter'));
  $('transportPlaySlot').replaceWith(play);

  play.addEventListener('click', toggleTransport);
  $('previewBack').addEventListener('click', () => skipTransport(-10));
  $('previewForward').addEventListener('click', () => skipTransport(10));

  const seek = $('previewSeek');
  seek.addEventListener('pointerdown', () => { transportState.dragging = true; });
  seek.addEventListener('input', () => {
    transportState.offset = Number(seek.value) || 0;
    if ($('previewCurrent')) $('previewCurrent').textContent = transportTime(transportState.offset);
  });
  const commitSeek = async () => {
    const target = Number(seek.value) || 0;
    transportState.dragging = false;
    await seekTransport(target);
  };
  seek.addEventListener('change', commitSeek);
  seek.addEventListener('pointerup', commitSeek);

  document.addEventListener('change', async (event) => {
    if (!event.target.matches('input[name="preview"]')) return;
    const position = transportPosition();
    const wasPlaying = Boolean(state.source);
    stopTransport({ preservePosition: true });
    transportState.duration = transportBuffer()?.duration || 0;
    transportState.offset = clamp(position, 0, transportState.duration);
    updateTransportUI();
    if (wasPlaying) await startTransport(transportState.offset);
  });

  const observer = new MutationObserver(() => {
    if (!preview.classList.contains('hidden')) updateTransportUI();
  });
  observer.observe(preview, { attributes: true, attributeFilter: ['class'] });
  updateTransportUI(0);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installTransport);
else installTransport();
