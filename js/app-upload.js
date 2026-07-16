'use strict';

// MixForge 1.0.2 storage lifecycle hardening.
// The separation service deletes the private source after a terminal job state.
// A retry must therefore create a new object instead of reusing storagePath.

uploadOriginal = async function uploadOriginalFresh() {
  if (!state.file) throw new Error('No source file is loaded.');

  state.storagePath = null;
  const safeName = state.file.name.replace(/[^a-z0-9._-]/gi, '_').slice(-120) || 'mix.wav';
  const id = (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/[^a-z0-9-]/gi, '');
  const path = `uploads/${id}-${safeName}`;
  const response = await fetch(`${SUPA_URL}/storage/v1/object/audio/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPA_KEY}`,
      apikey: SUPA_KEY,
      'Content-Type': state.file.type || 'application/octet-stream',
      'x-upsert': 'false',
    },
    body: state.file,
  });

  if (!response.ok) {
    throw new Error(`Private audio upload failed (${response.status}): ${(await response.text()).slice(0, 220)}`);
  }

  state.storagePath = path;
  return path;
};

separateRequiredStems = async function separateRequiredStemsFresh(stems, onProgress) {
  state.storagePath = null;
  state.stemBuffers = {};
  onProgress('Uploading a fresh private copy of the unreleased mix…');
  const storagePath = await uploadOriginal();

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
    // The Edge Function may already have removed the temporary object. Never
    // retain its path because the next button press must upload again.
    state.storagePath = null;
    throw error;
  }
};
