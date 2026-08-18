'use strict';
function writeString(view, offset, string) { for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i)); }

function evaluateExportGate(snapshot) {
  const current = snapshot && typeof snapshot === 'object' ? snapshot : {};
  if (!current.master) {
    return { allow: false, reason: 'no-master', verified: false, clipFail: false, tpFail: false, monoWarn: false, message: 'There is no rendered master to export. Render it first.' };
  }
  if (current.masterDirty) {
    return { allow: false, reason: 'dirty', verified: false, clipFail: false, tpFail: false, monoWarn: false, message: 'This master is out of date. Render the release master again before exporting.' };
  }
  const metrics = current.finalMetrics || {};
  const clipFail = Number(metrics.clipPercent) > 0.001 || Number(metrics.peakDb) > -0.1;
  const ceiling = Number(current.masterPlan?.truePeakCeilingDb ?? current.masterPlan?.ceilingDb ?? -1);
  const truePeak = Number(current.masterConstraint?.truePeakDb ?? metrics.peakDb);
  const tpFail = Number.isFinite(truePeak) && Number.isFinite(ceiling) && truePeak > ceiling + 0.05;
  const monoWarn = Number.isFinite(Number(metrics.correlation)) && Number(metrics.correlation) < 0.15;
  const verified = !clipFail && !tpFail && !monoWarn;
  if ((clipFail || tpFail) && !current.exportOverride) {
    const bits = [];
    if (clipFail) bits.push('clipping');
    if (tpFail) bits.push('true-peak over ceiling');
    return {
      allow: false,
      reason: 'safety',
      verified: false,
      clipFail,
      tpFail,
      monoWarn,
      message: `Export blocked: ${bits.join(' and ')}. Check the override if you still want this file.`,
    };
  }
  return { allow: true, reason: 'ok', verified, clipFail, tpFail, monoWarn, message: '' };
}

function syncExportUi(snapshot = state) {
  const gate = evaluateExportGate(snapshot);
  const button = $('exportBtn');
  const box = $('exportSafety');
  const msg = $('exportSafetyMsg');
  if (button) button.textContent = gate.verified ? 'Download verified release WAV' : 'Download release WAV';
  if (box && msg) {
    if (gate.clipFail || gate.tpFail) {
      box.classList.remove('hidden');
      const bits = [];
      if (gate.clipFail) bits.push('clipping');
      if (gate.tpFail) bits.push('true-peak over the safety ceiling');
      msg.textContent = `Hard check failed: ${bits.join(' and ')}. Export is blocked unless you explicitly override.`;
    } else {
      box.classList.add('hidden');
    }
  }
  return gate;
}

async function encodeWav(buffer, bitDepth, onProgress) {
  const channels = buffer.numberOfChannels, length = buffer.length, sampleRate = buffer.sampleRate;
  const bytesPerSample = bitDepth === 24 ? 3 : 2;
  const dataSize = length * channels * bytesPerSample;
  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);
  writeString(view, 0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeString(view, 8, 'WAVE'); writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true); view.setUint16(32, channels * bytesPerSample, true); view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data'); view.setUint32(40, dataSize, true);
  const channelData = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  const chunk = 131072;
  let offset = 44;
  for (let start = 0; start < length; start += chunk) {
    const end = Math.min(length, start + chunk);
    for (let i = start; i < end; i++) {
      for (let c = 0; c < channels; c++) {
        let sample = clamp(channelData[c][i], -1, 1);
        if (bitDepth === 24) {
          let value = Math.round(sample < 0 ? sample * 0x800000 : sample * 0x7fffff);
          if (value < 0) value += 0x1000000;
          view.setUint8(offset++, value & 0xff); view.setUint8(offset++, (value >> 8) & 0xff); view.setUint8(offset++, (value >> 16) & 0xff);
        } else {
          const dither = (Math.random() - Math.random()) / 65536;
          sample = clamp(sample + dither, -1, 1);
          view.setInt16(offset, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true); offset += 2;
        }
      }
    }
    onProgress?.(Math.round(end / length * 100));
    await sleep(0);
  }
  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

$('exportBtn').addEventListener('click', async () => {
  const gate = evaluateExportGate(state);
  if (!gate.allow) {
    setStatus('exportStatus', gate.message, 'error');
    syncExportUi(state);
    return;
  }
  $('exportBtn').disabled = true;
  setStatus('exportStatus', 'Encoding release WAV…', 'busy');
  try {
    const bitDepth = Number($('bitDepth').value) === 16 ? 16 : 24;
    const blob = await encodeWav(state.master, bitDepth, (percent) => setStatus('exportStatus', `Encoding ${bitDepth}-bit WAV… ${percent}%`, 'busy'));
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const base = (state.file?.name || 'mix').replace(/\.[^.]+$/, '').replace(/[^a-z0-9._-]/gi, '_');
    anchor.href = url; anchor.download = `${base}-mixforge-release-${bitDepth}bit.wav`; document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    setStatus('exportStatus', gate.verified ? 'Verified release WAV exported.' : 'Release WAV exported. Hard checks did not all pass.', gate.verified ? 'ok' : 'warn');
  } catch (error) {
    console.error(error);
    setStatus('exportStatus', `Export failed: ${error.message}`, 'error');
  } finally {
    $('exportBtn').disabled = false;
  }
});

if ($('exportOverride')) {
  $('exportOverride').addEventListener('change', (event) => {
    state.exportOverride = Boolean(event.target.checked);
    syncExportUi(state);
  });
}

if (typeof globalThis !== 'undefined') {
  globalThis.evaluateExportGate = evaluateExportGate;
  globalThis.syncExportUi = syncExportUi;
}
