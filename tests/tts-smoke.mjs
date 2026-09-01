import assert from 'node:assert/strict';
import handler, { buildTtsRequest, parsePcmMime, wrapPcmAsWav } from '../api/tts.js';

assert.deepEqual(parsePcmMime('audio/L16;codec=pcm;rate=24000'), {
  bitsPerSample: 16,
  sampleRate: 24000,
  channels: 1,
});
const wav = wrapPcmAsWav(Buffer.from([0, 0, 1, 0]), 24000, 1, 16);
assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');

const request = buildTtsRequest('The chorus is landing.', 'gemini-2.5-flash-preview-tts', 'Charon');
assert.match(request.url, /gemini-2\.5-flash-preview-tts:generateContent/);
assert.deepEqual(request.payload.generationConfig.responseModalities, ['AUDIO']);
assert.equal(request.payload.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Charon');
assert.match(request.payload.contents[0].parts[0].text, /experienced.*record producer/i);

function mockRes() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const previousKey = process.env.GEMINI_API_KEY;
const originalFetch = globalThis.fetch;
process.env.GEMINI_API_KEY = 'test-key';
let calls = 0;
globalThis.fetch = async (_url, init) => {
  calls += 1;
  const sent = JSON.parse(init.body);
  assert.deepEqual(sent.generationConfig.responseModalities, ['AUDIO']);
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ inlineData: {
        mimeType: 'audio/L16;codec=pcm;rate=24000',
        data: Buffer.from([0, 0, 1, 0]).toString('base64'),
      } }] } }],
    }),
  };
};

const response = mockRes();
await handler({ method: 'POST', body: { script: 'The vocal feels honest.', voiceName: 'Charon' } }, response);
assert.equal(response.statusCode, 200);
assert.equal(response.body.ok, true);
assert.equal(response.body.mimeType, 'audio/wav');
assert.equal(Buffer.from(response.body.audioB64, 'base64').subarray(0, 4).toString('ascii'), 'RIFF');
assert.equal(calls, 1);

const missing = mockRes();
await handler({ method: 'POST', body: {} }, missing);
assert.equal(missing.statusCode, 400);

globalThis.fetch = originalFetch;
if (previousKey == null) delete process.env.GEMINI_API_KEY;
else process.env.GEMINI_API_KEY = previousKey;

console.log('tts-smoke: ok');
