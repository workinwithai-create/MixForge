'use strict';

// MixForge 2.0.1 large-source handling.
// The full-resolution source remains in browser memory for analysis/rebuild.
// Storage receives only a temporary, size-safe PCM proxy for separation.

const SEPARATION_OBJECT_BUDGET = 45 * 1024 * 1024;

function uploadWithTus(file, path, onProgress) {
  if (!window.tus?.Upload) throw new Error('Large-file upload engine did not load. Refresh the page and try again.');
  return new Promise((resolve, reject) => {
    const upload = new window.tus.Upload(file, {
      endpoint: `${SUPA_URL}/storage/v1/upload/resumable`,
      retryDelays: [0, 1000, 3000, 5000, 10000],
      chunkSize: 6 * 1024 * 1024,
      removeFingerprintOnSuccess: true,
      headers: {
        Authorization: `Bearer ${SUPA_KEY}`,
        apikey: SUPA_KEY,
        'x-upsert': 'false',
      },
      metadata: {
        bucketName: 'audio',
        objectName: path,
        contentType: file.type || 'application/octet-stream',
        cacheControl: '3600',
      },
      onError(error) {
        reject(new Error(`Resumable private upload failed: ${error?.message || error}`));
      },
      onProgress(bytesUploaded, bytesTotal) {
        if (!bytesTotal) return;
        const percent = Math.max(1, Math.min(100, Math.round(bytesUploaded / bytesTotal * 100)));
        onProgress?.(`Uploading private separation proxy… ${percent}%`);
      },
      onSuccess() { resolve(path); },
    });
    upload.findPreviousUploads().then((previous) => {
      if (previous.length) upload.resumeFromPreviousUpload(previous[0]);
      upload.start();
    }).catch(reject);
  });
}

function chooseProxyFormat(buffer) {
  const duration = Math.max(1, buffer.duration);
  const candidates = [44100, 40000, 36000, 32000, 28000, 24000, 22050, 18000, 16000];
  for (const channels of [Math.min(2, buffer.numberOfChannels), 1]) {
    for (const sampleRate of candidates) {
      const estimated = 44 + Math.ceil(duration * sampleRate) * channels * 2;
      if (estimated <= SEPARATION_OBJECT_BUDGET) return { sampleRate, channels, estimated };
    }
  }
  throw new Error('This recording is too long for the separation service. Export the song in sections shorter than about 20 minutes.');
}

async function renderSeparationProxy(buffer, onProgress) {
  if (!OfflineCtx) throw new Error('This browser cannot prepare a separation proxy.');
  const format = chooseProxyFormat(buffer);
  const length = Math.ceil(buffer.duration * format.sampleRate);
  onProgress?.(`Preparing ${format.sampleRate / 1000} kHz, 16-bit ${format.channels === 1 ? 'mono' : 'stereo'} separation proxy…`);

  const offline = new OfflineCtx(format.channels, length, format.sampleRate);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  const blob = await encodeWav(rendered, 16, (percent) => onProgress?.(`Encoding separation proxy… ${percent}%`));
  if (blob.size > SEPARATION_OBJECT_BUDGET) throw new Error(`Prepared proxy is still too large (${Math.round(blob.size / 1024 / 1024)} MB).`);
  return { blob, format };
}

async function resampleBufferToOriginal(buffer) {
  if (!state.original || (buffer.sampleRate === state.original.sampleRate && buffer.length === state.original.length)) return buffer;
  if (!OfflineCtx) throw new Error('This browser cannot realign separated stems.');
  const targetRate = state.original.sampleRate;
  const targetLength = state.original.length;
  const channels = Math.max(1, Math.min(state.original.numberOfChannels, buffer.numberOfChannels));
  const offline = new OfflineCtx(channels, targetLength, targetRate);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  return offline.startRendering();
}

function installStemDecodeAlignment(ctx) {
  if (!ctx || ctx.__mixforgeStemAlignmentInstalled) return ctx;
  const nativeDecode = ctx.decodeAudioData.bind(ctx);
  ctx.decodeAudioData = function alignedDecode(bytes, success, failure) {
    const promise = nativeDecode(bytes).then(async (decoded) => {
      if ((state._stemDecodesRemaining || 0) > 0) {
        state._stemDecodesRemaining -= 1;
        return resampleBufferToOriginal(decoded);
      }
      return decoded;
    });
    if (typeof success === 'function') promise.then(success, failure);
    return promise;
  };
  ctx.__mixforgeStemAlignmentInstalled = true;
  return ctx;
}

const nativeEnsureAudioContextForUpload = ensureAudioContext;
ensureAudioContext = async function ensureAlignedAudioContext(resumeForPlayback = true) {
  return installStemDecodeAlignment(await nativeEnsureAudioContextForUpload(resumeForPlayback));
};

uploadOriginal = async function uploadOriginalProxy(onProgress) {
  if (!state.file || !state.original) throw new Error('No source file is loaded.');
  state.storagePath = null;

  let uploadBody = state.file;
  let proxyFormat = null;
  if (state.file.size > SEPARATION_OBJECT_BUDGET) {
    const proxy = await renderSeparationProxy(state.original, onProgress);
    uploadBody = new File([proxy.blob], `${state.file.name.replace(/\.[^.]+$/, '')}-separation-proxy.wav`, {
      type: 'audio/wav',
      lastModified: Date.now(),
    });
    proxyFormat = proxy.format;
  }

  const safeBase = state.file.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9._-]/gi, '_').slice(-100) || 'mix';
  const id = (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/[^a-z0-9-]/gi, '');
  const path = `uploads/${id}-${safeBase}-separation.wav`;
  await uploadWithTus(uploadBody, path, onProgress);
  state.storagePath = path;
  state.separationProxy = proxyFormat ? {
    sourceBytes: state.file.size,
    proxyBytes: uploadBody.size,
    sampleRate: proxyFormat.sampleRate,
    channels: proxyFormat.channels,
  } : null;
  return path;
};

separateRequiredStems = async function separateRequiredStemsFresh(stems, onProgress) {
  state.storagePath = null;
  state.stemBuffers = {};
  state._stemDecodesRemaining = 0;
  onProgress('Preparing private source for separation…');
  const storagePath = await uploadOriginal(onProgress);

  try {
    onProgress(`Starting separation for ${stems.join(', ')}…`);
    const started = await callStemFunction({ action: 'start', storagePath, stems });
    for (let attempt = 0; attempt < 90; attempt++) {
      await sleep(2500);
      const status = await callStemFunction({
        action: 'status',
        jobId: started.jobId,
        stems,
        storagePath,
        outputPaths: started.outputPaths || {},
      });
      if (status.status === 'SUCCEEDED') {
        state.storagePath = null;
        state._stemDecodesRemaining = stems.length;
        return status.outputs;
      }
      if (status.status === 'FAILED') {
        state.storagePath = null;
        throw new Error(status.error || 'The separation provider reported a failed job.');
      }
      onProgress(`Separating stems… ${status.status || 'processing'} (${Math.min(99, Math.round((attempt + 1) / 90 * 100))}%)`);
    }
    throw new Error('Stem separation timed out. Try again with a shorter source file.');
  } catch (error) {
    state.storagePath = null;
    state._stemDecodesRemaining = 0;
    throw error;
  }
};