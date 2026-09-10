import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Output,
  WavOutputFormat,
} from 'https://cdn.jsdelivr.net/npm/mediabunny@1.56.1/+esm';

const VERSION = '1.56.1';
const fileInput = document.querySelector('#audioFile');
const startInput = document.querySelector('#startTime');
const endInput = document.querySelector('#endTime');
const trimButton = document.querySelector('#trimButton');
const repeatButton = document.querySelector('#repeatButton');
const player = document.querySelector('#player');
const download = document.querySelector('#download');
const report = document.querySelector('#report');
let outputUrl = '';

function write(lines, state = '') {
  report.className = state;
  report.textContent = lines.join('\n');
}

function releaseOutput() {
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  outputUrl = '';
  player.removeAttribute('src');
  download.hidden = true;
}

async function inspect(file) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    if (!await input.canRead()) throw new Error('MediaBunny cannot read this file. Try a standard PCM WAV.');
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('No audio track was found.');
    return {
      duration: await input.computeDuration(),
      firstTimestamp: await input.getFirstTimestamp(),
      codec: await track.getCodec(),
      sampleRate: await track.getSampleRate(),
      channels: await track.getNumberOfChannels(),
    };
  } finally {
    input.dispose();
  }
}

async function trim(file, start, end) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const target = new BufferTarget();
  const output = new Output({ format: new WavOutputFormat(), target });
  try {
    const conversion = await Conversion.init({
      input,
      output,
      trim: { start, end },
      tracks: 'primary',
      copy: { mode: 'preferred', shiftTolerance: 0, boundaryPolicy: 'expand' },
    });
    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks.map((item) => item.reason).join(', ') || 'unknown reason';
      throw new Error(`Conversion rejected: ${reasons}`);
    }
    await conversion.execute();
    if (!target.buffer || target.buffer.byteLength === 0) throw new Error('The trim finished without producing audio.');
    return new Blob([target.buffer], { type: 'audio/wav' });
  } finally {
    input.dispose();
  }
}

async function run(repetitions) {
  const file = fileInput.files?.[0];
  if (!file) return;
  const start = Number(startInput.value);
  const end = Number(endInput.value);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    write(['FAIL', 'End must be greater than start, and both must be valid positive times.'], 'fail');
    return;
  }

  trimButton.disabled = true;
  repeatButton.disabled = true;
  releaseOutput();
  const started = performance.now();
  try {
    const meta = await inspect(file);
    if (end > meta.duration) throw new Error(`End time ${end.toFixed(2)}s exceeds the ${meta.duration.toFixed(2)}s file.`);
    let result;
    for (let i = 0; i < repetitions; i += 1) {
      write([`MediaBunny ${VERSION}`, `Run ${i + 1} of ${repetitions}…`]);
      result = await trim(file, start, end);
    }
    outputUrl = URL.createObjectURL(result);
    player.src = outputUrl;
    download.href = outputUrl;
    download.download = `${file.name.replace(/\.wav$/i, '')}-trim-${start}-${end}.wav`;
    download.hidden = false;
    const elapsed = performance.now() - started;
    const expected = end - start;
    write([
      'PASS — trim completed without hanging',
      `MediaBunny: ${VERSION}`,
      `Browser: ${navigator.userAgent}`,
      `Input: ${file.name} (${(file.size / 1048576).toFixed(2)} MB)`,
      `Input duration: ${meta.duration.toFixed(3)}s`,
      `First timestamp: ${meta.firstTimestamp.toFixed(6)}s`,
      `Codec: ${meta.codec || 'unknown'} · ${meta.sampleRate} Hz · ${meta.channels} channel(s)`,
      `Requested range: ${start.toFixed(3)}s–${end.toFixed(3)}s (${expected.toFixed(3)}s)`,
      `Runs: ${repetitions} · Total time: ${(elapsed / 1000).toFixed(2)}s`,
      `Output: ${(result.size / 1048576).toFixed(2)} MB`,
      '',
      'Listen for: clean start, clean end, no timing jump, and no silence added at the front.',
    ], 'pass');
  } catch (error) {
    write(['FAIL', `MediaBunny: ${VERSION}`, String(error?.message || error), '', navigator.userAgent], 'fail');
  } finally {
    trimButton.disabled = false;
    repeatButton.disabled = false;
  }
}

fileInput.addEventListener('change', async () => {
  releaseOutput();
  const file = fileInput.files?.[0];
  trimButton.disabled = !file;
  repeatButton.disabled = !file;
  if (!file) return write(['Waiting for a WAV file…']);
  try {
    const meta = await inspect(file);
    endInput.value = Math.min(6, Math.max(0.1, meta.duration)).toFixed(1);
    startInput.value = Math.min(1, Math.max(0, meta.duration - 0.1)).toFixed(1);
    write([
      `Ready — MediaBunny ${VERSION}`,
      `${file.name} · ${meta.duration.toFixed(3)}s`,
      `First timestamp: ${meta.firstTimestamp.toFixed(6)}s`,
      'Tap “Trim once”, then compare and download the result.',
    ]);
  } catch (error) {
    write(['FAIL', String(error?.message || error)], 'fail');
  }
});

trimButton.addEventListener('click', () => run(1));
repeatButton.addEventListener('click', () => run(5));
