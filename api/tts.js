const TTS_TIMEOUT_MS = 52000;
const TTS_MAX_SCRIPT_LENGTH = 4000;
const TTS_MODELS = [
  'gemini-2.5-flash-preview-tts',
  'gemini-2.5-flash-tts',
  'gemini-2.0-flash-tts',
];

export const config = {
  maxDuration: 60,
};

function json(res, status, body) {
  res.status(status).json(body);
}

export function parsePcmMime(mime) {
  const bitsMatch = String(mime || '').match(/\bL(\d+)\b/i);
  const rateMatch = String(mime || '').match(/rate=(\d+)/i);
  const channelsMatch = String(mime || '').match(/channels=(\d+)/i);
  if (!bitsMatch || !rateMatch) return null;
  return {
    bitsPerSample: Number(bitsMatch[1]),
    sampleRate: Number(rateMatch[1]),
    channels: channelsMatch ? Number(channelsMatch[1]) : 1,
  };
}

export function wrapPcmAsWav(pcm, sampleRate, channels, bitsPerSample) {
  const source = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const wav = Buffer.alloc(44 + source.length);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + source.length, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(source.length, 40);
  source.copy(wav, 44);
  return wav;
}

export function buildTtsRequest(script, model = TTS_MODELS[0], voiceName = 'Charon') {
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    payload: {
      contents: [{
        role: 'user',
        parts: [{
          text: `Read this as an experienced, encouraging record producer giving honest feedback in the studio. Keep it conversational and grounded. Do not sound like an announcer.\n\n${script}`,
        }],
      }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
      },
    },
  };
}

function extractPlayableAudio(data) {
  const parts = Array.isArray(data?.candidates)
    ? data.candidates.flatMap((candidate) => candidate?.content?.parts || [])
    : [];
  for (const part of parts) {
    const inline = part?.inlineData || part?.inline_data;
    if (!inline?.data) continue;
    const mimeType = String(inline.mimeType || inline.mime_type || '');
    const raw = Buffer.from(inline.data, 'base64');
    if (/\b(wav|wave|mpeg|mp3|ogg|webm|m4a|mp4|aac)\b/i.test(mimeType)) {
      return { audioB64: raw.toString('base64'), mimeType: mimeType || 'audio/wav' };
    }
    const format = parsePcmMime(mimeType) || { sampleRate: 24000, channels: 1, bitsPerSample: 16 };
    return {
      audioB64: wrapPcmAsWav(raw, format.sampleRate, format.channels, format.bitsPerSample).toString('base64'),
      mimeType: 'audio/wav',
    };
  }
  return null;
}

async function callGeminiTts(script, voiceName) {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    const error = new Error('GEMINI_API_KEY is not configured.');
    error.statusCode = 400;
    throw error;
  }
  let lastError;
  for (const model of TTS_MODELS) {
    const request = buildTtsRequest(script, model, voiceName);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
    try {
      const response = await fetch(request.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(request.payload),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message || `Gemini TTS request failed (${response.status})`);
      const audio = extractPlayableAudio(data);
      if (audio) return { ...audio, model };
      throw new Error('Gemini TTS returned no playable audio.');
    } catch (error) {
      lastError = error?.name === 'AbortError' ? new Error('Producer voice timed out.') : error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('Producer voice is unavailable.');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed' });
  try {
    const script = String(req.body?.script || '').trim();
    if (!script) return json(res, 400, { ok: false, error: 'Missing script' });
    if (script.length > TTS_MAX_SCRIPT_LENGTH) return json(res, 413, { ok: false, error: 'Script is too long' });
    const voiceName = String(req.body?.voiceName || 'Charon').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'Charon';
    const audio = await callGeminiTts(script, voiceName);
    return json(res, 200, { ok: true, ...audio });
  } catch (error) {
    console.error('MixForge TTS error:', error);
    return json(res, error?.statusCode || 502, { ok: false, error: error?.message || String(error) });
  }
}
