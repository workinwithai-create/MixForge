'use strict';
function writeString(view, offset, string) { for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i)); }

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
  if (!state.master) return;
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
    setStatus('exportStatus', 'Release WAV exported.', 'ok');
  } catch (error) {
    console.error(error);
    setStatus('exportStatus', `Export failed: ${error.message}`, 'error');
  } finally {
    $('exportBtn').disabled = false;
  }
});
