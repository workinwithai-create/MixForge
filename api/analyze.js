const CANONICAL_STEMS = new Set(['vocals', 'bass', 'drums', 'other']);
const STEM_ALIASES = { guitars: 'other', keys: 'other' };
const GEMINI_TIMEOUT_MS = 52000;
const ANTHROPIC_TIMEOUT_MS = 52000;
const GEMINI_DEFAULT_MODEL = 'gemini-3.6-flash';
const LISTENING_CLIP_MAX_CHARS = 3500000;

export const config = {
  maxDuration: 60,
};

function json(res, status, body) {
  res.status(status).json(body);
}

function clampText(value, max) {
  return String(value || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, max);
}

export function canonicalStem(name) {
  const actual = STEM_ALIASES[name] || name;
  return CANONICAL_STEMS.has(actual) ? actual : null;
}

export function compactMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return {};
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
  const bands = (items) => Array.isArray(items) ? items.slice(0, 8).map((item) => ({ name: clampText(item?.name, 24), db: number(item?.db) })) : [];
  return {
    lufs: number(metrics.lufs), peakDb: number(metrics.peakDb), rmsDb: number(metrics.rmsDb), crestDb: number(metrics.crestDb), lra: number(metrics.lra),
    correlation: number(metrics.correlation), widthDb: number(metrics.widthDb), dcOffset: number(metrics.dcOffset), clipPercent: number(metrics.clipPercent),
    midBands: bands(metrics.midBands), sideBands: bands(metrics.sideBands),
    sibilance: metrics.sibilance ? { medianDb: number(metrics.sibilance.medianDb), p95Db: number(metrics.sibilance.p95Db), flares: number(metrics.sibilance.flares), frames: number(metrics.sibilance.frames) } : null,
  };
}

export function sanitizeListeningClip(clip) {
  if (!clip || typeof clip !== 'object') return null;
  const mime = String(clip.mimeType || clip.mime_type || '');
  if (mime !== 'audio/wav') throw new Error('Listening clip must be audio/wav.');
  const data = String(clip.data || '');
  if (!data) throw new Error('Listening clip is missing.');
  if (data.length > LISTENING_CLIP_MAX_CHARS) throw new Error('Listening clip is too large for the inline audio path.');
  if (!/^[A-Za-z0-9+/]+=*$/.test(data.slice(0, 120))) throw new Error('Listening clip is not valid base64.');
  const windows = Array.isArray(clip.windows)
    ? clip.windows.slice(0, 6).map((window) => ({
      start: Number(window?.start),
      end: Number(window?.end),
      reason: clampText(window?.reason, 40),
    }))
    : [];
  return {
    mimeType: 'audio/wav',
    data,
    windows,
    sampleRate: Number(clip.sampleRate) || null,
    channels: Number(clip.channels) || 1,
    durationSec: Number(clip.durationSec) || null,
  };
}

function extractJson(text) {
  const clean = String(text || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(clean); } catch (_) {}
  const objectStart = clean.indexOf('{'), objectEnd = clean.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) return JSON.parse(clean.slice(objectStart, objectEnd + 1));
  throw new Error('The model did not return valid JSON.');
}

export function mixListeningPrompt(body) {
  const metrics = compactMetrics(body.metrics);
  const notes = clampText(body.notes, 1200);
  const targetLufs = Math.max(-18, Math.min(-8, Number(body.targetLufs) || -12));
  const windows = Array.isArray(body.listeningClip?.windows) ? body.listeningClip.windows : [];
  return `You are MixForge's mix/master listening engineer. You are hearing a compact excerpt of a stereo mix (loudest and/or problem windows), not a vocal performance take.

The attached WAV is a downsampled mono fold. Gemini combines channels, so stereo image is NOT something you can prove from the file. Measured correlation and width below are ground truth for stereo.

Measured facts are GROUND TRUTH. Do not override or invent clip %, LUFS, sample peak, correlation, or DC. Do not invent exact frequencies.

Do NOT judge performance: pitch, timing, lyrics, take quality, intonation, or singer skill. That belongs to AuraMix. MixForge listens to the mix/master only.

Artist notes: ${notes || 'none'}
Requested release target: ${targetLufs} LUFS.
Excerpt windows (source times): ${windows.length ? JSON.stringify(windows) : 'unspecified compact excerpt'}
Measurements:
${JSON.stringify(metrics)}

Listen for mix/master hypotheses only: mud, harshness, buried vocal, pumping, stereo weirdness (as a hypothesis checked against measured correlation/width), section contrast, masking, over-limiting.

Return ONLY JSON with this shape:
{"readinessScore":0-100,"summary":"short mix/master listening note","stemsToInspect":["vocals"|"bass"|"drums"|"other"],"findings":[{"severity":"high"|"medium"|"low","stage":"mix"|"master","problem":"title","evidence":"what you heard and/or which measured fact supports it","action":"specific conservative next test","stem":"vocals"|"bass"|"drums"|"other"|null}]}

Rules:
- 3 to 8 findings maximum.
- Demucs htdemucs only yields vocals, bass, drums, and residual other. Never request guitars or keys.
- A listening pass cannot confirm an instrument identity. Source assignments stay hypotheses until stems are isolated.
- Prefer Quick Master language when isolation is not needed.
- Mastering suggestions must stay conservative. Do not ask to make it louder.`;
}

function stemPrompt(body) {
  const stems = {};
  for (const [name, metrics] of Object.entries(body.stems || {})) {
    const stem = canonicalStem(name);
    if (stem && !stems[stem]) stems[stem] = compactMetrics(metrics);
  }
  return `You are MixForge's stem repair engineer. Each stem below was separated because the stereo audit found a possible source-level flaw. Build a conservative corrective plan for each stem. Use no processing unless the measurements support it.

Stem measurements:
${JSON.stringify(stems)}
Original mix measurements:
${JSON.stringify(compactMetrics(body.mixMetrics))}
Artist notes: ${clampText(body.notes, 1200) || 'none'}

Return ONLY JSON:
{"stems":{"stemName":{"summary":"what the measurement indicates","operations":[OPERATION]}}}
Allowed OPERATION objects:
- {"type":"eq","filterType":"peaking"|"lowshelf"|"highshelf","frequency":20-18000,"gain":-6..6,"q":0.3..4,"label":"reason"}
- {"type":"highpass","frequency":15-120,"q":0.5..1.2,"label":"reason"}
- {"type":"deess","frequency":5000-9000,"threshold":-45..-15,"label":"reason"}
- {"type":"compressor","threshold":-45..-8,"ratio":1.2..4,"attack":0.005..0.08,"release":0.05..0.5,"knee":0..12,"label":"reason"}
- {"type":"gain","gainDb":-6..6,"label":"reason"}

Rules:
- Preserve transients and emotion.
- Never use compression just to make a stem louder.
- Use de-essing only for flare behavior, not a permanently bright stem.
- Maximum 5 operations per stem.
- Include every supplied stem key.
- Canonical stem names only: vocals, bass, drums, other.`;
}

export function buildGeminiMixRequest(body, clip) {
  const model = process.env.GEMINI_MODEL?.trim() || GEMINI_DEFAULT_MODEL;
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    model,
    payload: {
      contents: [{
        role: 'user',
        parts: [
          { text: mixListeningPrompt({ ...body, listeningClip: clip }) },
          { inline_data: { mime_type: 'audio/wav', data: clip.data } },
        ],
      }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1800,
        responseMimeType: 'application/json',
      },
    },
  };
}

function abortError(message) {
  const timed = new Error(message);
  timed.statusCode = 504;
  return timed;
}

async function callGeminiMix(body) {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    const error = new Error('GEMINI_API_KEY is not configured.');
    error.statusCode = 400;
    throw error;
  }
  const clip = sanitizeListeningClip(body.listeningClip);
  if (!clip) throw new Error('A compact listening clip is required for the mix listening pass.');
  const request = buildGeminiMixRequest(body, clip);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
      },
      body: JSON.stringify(request.payload),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw abortError('Listening pass timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || data?.error?.status || 'Gemini request failed';
    throw new Error(`Gemini ${response.status}: ${message}`);
  }
  const text = Array.isArray(data?.candidates)
    ? data.candidates.flatMap((candidate) => candidate?.content?.parts || []).filter((part) => part?.text).map((part) => part.text).join('')
    : '';
  return extractJson(text);
}

async function callAnthropicStems(body) {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw new Error('ANTHROPIC_API_KEY is not configured.');
  const prompt = stemPrompt(body);
  if (prompt.length > 18000) throw new Error('Analysis payload is too large.');
  const model = process.env.ANTHROPIC_MODEL?.trim() || 'claude-sonnet-4-6';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS);
  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 2400, temperature: 0.1, messages: [{ role: 'user', content: prompt }] }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw abortError('AI audit timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Anthropic ${response.status}: ${data?.error?.message || 'request failed'}`);
  const text = Array.isArray(data.content) ? data.content.filter((part) => part.type === 'text').map((part) => part.text).join('') : '';
  return extractJson(text);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed' });
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const phase = body.phase === 'stems' ? 'stems' : 'mix';
    const plan = phase === 'stems' ? await callAnthropicStems(body) : await callGeminiMix(body);
    return json(res, 200, { ok: true, plan, provider: phase === 'stems' ? 'anthropic' : 'gemini-audio' });
  } catch (error) {
    console.error('MixForge analyze error:', error);
    const status = error.statusCode === 504 ? 504 : 400;
    return json(res, status, { ok: false, error: error.message || String(error) });
  }
}
