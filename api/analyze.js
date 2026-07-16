const ALLOWED_STEMS = new Set(['vocals', 'bass', 'drums', 'guitars', 'keys', 'other']);

function json(res, status, body) {
  res.status(status).json(body);
}

function clampText(value, max) {
  return String(value || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, max);
}

function compactMetrics(metrics) {
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

function extractJson(text) {
  const clean = String(text || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(clean); } catch (_) {}
  const objectStart = clean.indexOf('{'), objectEnd = clean.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) return JSON.parse(clean.slice(objectStart, objectEnd + 1));
  throw new Error('The model did not return valid JSON.');
}

function mixPrompt(body) {
  const metrics = compactMetrics(body.metrics);
  const notes = clampText(body.notes, 1200);
  const targetLufs = Math.max(-18, Math.min(-8, Number(body.targetLufs) || -12));
  return `You are MixForge, a conservative professional mix engineer. Audit a stereo mix BEFORE mastering. Identify only defects supported by the measurements. Do not prescribe master-bus processing for a source-level problem. Recommend stem separation only when isolation is necessary.

Measurements:
${JSON.stringify(metrics)}
Artist notes: ${notes || 'none'}
Requested release target: ${targetLufs} LUFS.

Return ONLY JSON with this shape:
{"readinessScore":0-100,"summary":"short professional assessment","stemsToInspect":["vocals"|"bass"|"drums"|"guitars"|"keys"|"other"],"findings":[{"severity":"high"|"medium"|"low","stage":"mix"|"master","problem":"title","evidence":"cite measured evidence","action":"specific corrective action","stem":"allowed stem or null"}]}

Rules:
- Prioritize clipping, phase/mono risk, masking, resonance, sibilance, unstable low end, over-compression, excessive width, and translation problems.
- A stereo audit cannot prove instrument-specific problems; use cautious wording and request the most relevant stem for confirmation.
- Do not invent exact frequencies unless measurements justify a band.
- 3 to 9 findings maximum.
- Mastering findings must be broad and conservative. Stem repair happens before mastering.`;
}

function stemPrompt(body) {
  const stems = {};
  for (const [name, metrics] of Object.entries(body.stems || {})) if (ALLOWED_STEMS.has(name)) stems[name] = compactMetrics(metrics);
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
- Include every supplied stem key.`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed' });
  try {
    const key = process.env.ANTHROPIC_API_KEY?.trim();
    if (!key) throw new Error('ANTHROPIC_API_KEY is not configured.');
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const phase = body.phase === 'stems' ? 'stems' : 'mix';
    const prompt = phase === 'stems' ? stemPrompt(body) : mixPrompt(body);
    if (prompt.length > 18000) throw new Error('Analysis payload is too large.');
    const model = process.env.ANTHROPIC_MODEL?.trim() || 'claude-sonnet-4-6';
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: phase === 'stems' ? 2400 : 1800, temperature: 0.1, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Anthropic ${response.status}: ${data?.error?.message || 'request failed'}`);
    const text = Array.isArray(data.content) ? data.content.filter((part) => part.type === 'text').map((part) => part.text).join('') : '';
    const plan = extractJson(text);
    return json(res, 200, { ok: true, plan });
  } catch (error) {
    console.error('MixForge analyze error:', error);
    return json(res, 400, { ok: false, error: error.message || String(error) });
  }
}
