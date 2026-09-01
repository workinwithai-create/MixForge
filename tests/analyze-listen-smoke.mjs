import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  canonicalStem,
  compactMetrics,
  sanitizeListeningClip,
  mixListeningPrompt,
  buildGeminiMixRequest,
  listeningConfigured,
  listeningStatusPayload,
} from '../api/analyze.js';
import handler from '../api/analyze.js';

assert.doesNotMatch(fs.readFileSync(new URL('../api/analyze.js', import.meta.url), 'utf8'), /AIza[0-9A-Za-z_-]{10,}/);
assert.equal(typeof listeningConfigured(), 'boolean');
assert.equal(listeningStatusPayload().ok, true);
assert.equal(Object.prototype.hasOwnProperty.call(listeningStatusPayload(), 'apiKey'), false);
assert.equal(canonicalStem('guitars'), 'other');
assert.equal(canonicalStem('keys'), 'other');
assert.equal(canonicalStem('vocals'), 'vocals');
assert.equal(canonicalStem('synth'), null);

const clip = sanitizeListeningClip({
  mimeType: 'audio/wav',
  data: 'UklGRg==',
  windows: [{ start: 12, end: 18, reason: 'loudest' }],
  sampleRate: 22050,
  channels: 1,
  durationSec: 6,
});
assert.equal(clip.mimeType, 'audio/wav');
assert.equal(clip.windows[0].reason, 'loudest');

const prompt = mixListeningPrompt({
  metrics: { lufs: -16, peakDb: -0.2, clipPercent: 0.2, correlation: 0.1 },
  notes: 'vocal buried',
  targetLufs: -12,
  listeningClip: clip,
});
assert.match(prompt, /GROUND TRUTH/i);
assert.match(prompt, /Do NOT judge performance/i);
assert.match(prompt, /AuraMix/);
assert.match(prompt, /Producer's Ear/i);
assert.match(prompt, /what is genuinely working/i);
assert.match(prompt, /never claim that you did/i);
assert.match(prompt, /producerReview/);
assert.doesNotMatch(prompt, /guitars or keys as separate/);

const previousKey = process.env.GEMINI_API_KEY;
const previousModel = process.env.GEMINI_MODEL;
process.env.GEMINI_API_KEY = 'test-key';
process.env.GEMINI_MODEL = 'gemini-3.6-flash';
const request = buildGeminiMixRequest({ metrics: { lufs: -14 }, notes: '', targetLufs: -12 }, clip);
assert.match(request.url, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.6-flash:generateContent/);
assert.equal(request.payload.contents[0].parts[1].inline_data.mime_type, 'audio/wav');
assert.equal(request.payload.contents[0].parts[1].inline_data.data, 'UklGRg==');
assert.equal(request.payload.generationConfig.responseMimeType, 'application/json');

function mockRes() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

delete process.env.GEMINI_API_KEY;
const statusRes = mockRes();
await handler({ method: 'GET' }, statusRes);
assert.equal(statusRes.statusCode, 200);
assert.equal(statusRes.body.listeningConfigured, false);
assert.equal(statusRes.body.listeningProvider, 'gemini-audio');
assert.ok(!JSON.stringify(statusRes.body).includes('AIza'));

const missing = mockRes();
await handler({ method: 'POST', body: { phase: 'mix', metrics: { lufs: -14 }, listeningClip: clip } }, missing);
assert.equal(missing.statusCode, 400);
assert.match(missing.body.error, /GEMINI_API_KEY/);

process.env.GEMINI_API_KEY = 'test-key';
assert.equal(listeningConfigured(), true);
const configured = mockRes();
await handler({ method: 'GET' }, configured);
assert.equal(configured.body.listeningConfigured, true);
assert.doesNotMatch(JSON.stringify(configured.body), /test-key/);

const originalFetch = globalThis.fetch;
let geminiCalls = 0;
globalThis.fetch = async (url, init) => {
  geminiCalls += 1;
  assert.match(String(url), /generativelanguage\.googleapis\.com/);
  assert.doesNotMatch(String(url), /anthropic/i);
  const sent = JSON.parse(init.body);
  assert.equal(sent.contents[0].parts[1].inline_data.mime_type, 'audio/wav');
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        readinessScore: 70,
        producerReview: {
          opening: 'The chorus has weight.',
          whatsWorking: ['The vocal tone feels believable.'],
          honestTake: 'The mix is close, but the middle crowds the vocal.',
          fixFirst: [{ title: 'Open the middle', why: 'The words recede.', move: 'Clear space around the vocal.' }],
          protect: 'Keep the vocal texture.',
        },
        summary: 'muddy chorus',
        stemsToInspect: ['other'],
        findings: [],
      }) }] } }],
    }),
  };
};
const listened = mockRes();
await handler({ method: 'POST', body: { phase: 'mix', metrics: compactMetrics({ lufs: -14 }), listeningClip: clip } }, listened);
assert.equal(listened.statusCode, 200);
assert.equal(listened.body.provider, 'gemini-audio');
assert.equal(listened.body.plan.summary, 'muddy chorus');
assert.equal(listened.body.plan.producerReview.fixFirst[0].title, 'Open the middle');
assert.equal(geminiCalls, 1);

delete process.env.ANTHROPIC_API_KEY;
const stemsMissing = mockRes();
await handler({ method: 'POST', body: { phase: 'stems', stems: { vocals: { lufs: -18 } } } }, stemsMissing);
assert.equal(stemsMissing.statusCode, 400);
assert.match(stemsMissing.body.error, /ANTHROPIC_API_KEY/);

globalThis.fetch = originalFetch;
if (previousKey == null) delete process.env.GEMINI_API_KEY;
else process.env.GEMINI_API_KEY = previousKey;
if (previousModel == null) delete process.env.GEMINI_MODEL;
else process.env.GEMINI_MODEL = previousModel;

console.log('analyze-listen-smoke: ok');
