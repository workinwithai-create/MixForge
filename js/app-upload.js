'use strict';

// MixForge 1.0.3 large-file upload support.
// Supabase standard uploads can reject large WAV files even when the bucket
// itself has no explicit limit. TUS uploads send the file in resumable chunks.

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
        onProgress?.(`Uploading private mix… ${percent}%`);
      },
      onSuccess() { resolve(path); },
    });
    upload.findPreviousUploads().then((previous) => {
      if (previous.length) upload.resumeFromPreviousUpload(previous[0]);
      upload.start();
    }).catch(reject);
  });
}

uploadOriginal = async function uploadOriginalFresh(onProgress) {
  if (!state.file) throw new Error('No source file is loaded.');
  state.storagePath = null;
  const safeName = state.file.name.replace(/[^a-z0-9._-]/gi, '_').slice(-120) || 'mix.wav';
  const id = (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/[^a-z0-9-]/gi, '');
  const path = `uploads/${id}-${safeName}`;

  // Use TUS for every source so desktop and mobile follow the same reliable path.
  await uploadWithTus(state.file, path, onProgress);
  state.storagePath = path;
  return path;
};

separateRequiredStems = async function separateRequiredStemsFresh(stems, onProgress) {
  state.storagePath = null;
  state.stemBuffers = {};
  onProgress('Preparing resumable private upload…');
  const storagePath = await uploadOriginal(onProgress);

  try {
    onProgress(`Starting separation for ${stems.join(', ')}…`);
    const started = await callStemFunction({ action: 'start', storagePath, stems });
    for (let attempt = 0; attempt < 90; attempt++) {
      await sleep(2500);
      const status = await callStemFunction({ action: 'status', jobId: started.jobId, stems, storagePath });
      if (status.status === 'SUCCEEDED') {
        state.storagePath = null;
        return status.outputs;
      }
      if (status.status === 'FAILED') {
        state.storagePath = null;
        throw new Error(status.error || 'The separation provider reported a failed job.');
      }
      onProgress(`Separating stems… ${status.status || 'processing'} (${Math.min(99, Math.round((attempt + 1) / 90 * 100))}%)`);
    }
    throw new Error('Stem separation timed out. Try again with a shorter or lossless source file.');
  } catch (error) {
    state.storagePath = null;
    throw error;
  }
};
