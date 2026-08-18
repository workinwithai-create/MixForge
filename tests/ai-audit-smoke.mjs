import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { compactMetrics as serverCompactMetrics } from '../api/analyze.js';

const context = vm.createContext({
  console,
  Math,
  Number,
  Object,
  Array,
  Set,
  Promise,
  JSON,
  String,
  Error,
  TypeError,
  DOMException,
  AbortController,
  setTimeout,
  clearTimeout,
});
context.globalThis = context;

vm.runInContext(fs.readFileSync(new URL('../js/app-audit-request.js', import.meta.url), 'utf8'), context);

assert.equal(typeof context.compactMetrics, 'function');
assert.equal(typeof context.compactAuditPayload, 'function');
assert.equal(typeof context.abortAITimeout, 'function');
assert.equal(typeof context.isRetryableAIError, 'function');
assert.equal(typeof context.requestAI, 'function');
assert.equal(typeof context.aiFallbackStatusMessage, 'function');

const fatMetrics = {
  lufs: -16.2,
  peakDb: -0.4,
  rmsDb: -18.1,
  crestDb: 12,
  lra: 8.4,
  correlation: 0.62,
  widthDb: -6.1,
  dcOffset: 0.0002,
  clipPercent: 0,
  duration: 187.4,
  sampleRate: 44100,
  channels: 2,
  leftoverSpectrum: new Array(2048).fill(0.123),
  midBands: [
    { name: 'Sub', lo: 20, hi: 60, db: -18.2, extra: 'drop-me' },
    { name: 'Bass', lo: 60, hi: 250, db: -16.4 },
  ],
  sideBands: [{ name: 'Low-mids', lo: 250, hi: 500, db: -22.1 }],
  sibilance: { medianDb: -30, p95Db: -22, flares: 3, frames: 140, raw: [1, 2, 3] },
};

const compacted = context.compactMetrics(fatMetrics);
assert.equal(compacted.duration, undefined);
assert.equal(compacted.sampleRate, undefined);
assert.equal(compacted.channels, undefined);
assert.equal(compacted.leftoverSpectrum, undefined);
assert.equal(JSON.stringify(compacted.midBands[0]), JSON.stringify({ name: 'Sub', db: -18.2 }));
assert.equal(compacted.sibilance.raw, undefined);
assert.equal(JSON.stringify(compacted), JSON.stringify(serverCompactMetrics(fatMetrics)));

const mixPayload = context.compactAuditPayload({
  phase: 'mix',
  notes: `${'vocal buried\n'.repeat(400)}`,
  targetLufs: -12,
  metrics: fatMetrics,
  ignored: { huge: true },
});
assert.equal(mixPayload.phase, 'mix');
assert.equal(mixPayload.listeningClip, null);
assert.equal(mixPayload.ignored, undefined);
assert.ok(mixPayload.notes.length <= 1200);
assert.equal(JSON.stringify(mixPayload.metrics).includes('leftoverSpectrum'), false);
assert.equal(JSON.stringify(mixPayload).length < JSON.stringify({ metrics: fatMetrics }).length, true);

const withClip = context.compactAuditPayload({
  phase: 'mix',
  metrics: { lufs: -14 },
  listeningClip: { mimeType: 'audio/wav', data: 'UklGRg==', windows: [{ start: 0, end: 6, reason: 'loudest' }] },
});
assert.equal(withClip.listeningClip.mimeType, 'audio/wav');
assert.equal(withClip.listeningClip.data, 'UklGRg==');
assert.equal(withClip.listeningClip.windows[0].reason, 'loudest');

const stemPayload = context.compactAuditPayload({
  phase: 'stems',
  notes: 'keep the punch',
  stems: { vocals: fatMetrics, other: fatMetrics },
  mixMetrics: fatMetrics,
});
assert.equal(stemPayload.phase, 'stems');
assert.equal(JSON.stringify(stemPayload.stems.vocals), JSON.stringify(compacted));
assert.equal(stemPayload.stems.vocals.duration, undefined);

const controller = new AbortController();
context.abortAITimeout(controller);
assert.equal(controller.signal.aborted, true);
assert.equal(controller.signal.reason.name, 'TimeoutError');
assert.match(String(controller.signal.reason.message), /timed out/i);

const timeoutError = Object.assign(new Error('AI audit timed out'), { name: 'TimeoutError' });
assert.equal(context.isRetryableAIError(timeoutError), true);
assert.equal(context.isRetryableAIError(Object.assign(new Error('AI request failed (502)'), { status: 502 })), true);
assert.equal(context.isRetryableAIError(Object.assign(new Error('AI request failed (504)'), { status: 504 })), true);
assert.equal(context.isRetryableAIError(new TypeError('Failed to fetch')), true);
assert.equal(context.isRetryableAIError(Object.assign(new Error('ANTHROPIC_API_KEY is not configured.'), { status: 400 })), false);
assert.match(context.aiFallbackStatusMessage(timeoutError), /timed out/i);
assert.match(context.aiFallbackStatusMessage(new Error('nope')), /unavailable|measurements only/i);
assert.match(context.aiFallbackStatusMessage(new Error('GEMINI_API_KEY is not configured.')), /Listening model not configured/);
assert.doesNotMatch(context.aiFallbackStatusMessage(new Error('GEMINI_API_KEY is not configured.')), /agree/i);

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function hangingFetch(_url, init) {
  return new Promise((_, reject) => {
    const fail = () => {
      const error = new DOMException('The operation was aborted.', 'AbortError');
      reject(error);
    };
    if (init.signal?.aborted) {
      fail();
      return;
    }
    init.signal.addEventListener('abort', fail, { once: true });
  });
}

let timeoutCalls = 0;
const timeoutThenOk = async (url, init) => {
  timeoutCalls += 1;
  const sent = JSON.parse(init.body);
  assert.equal(sent.metrics.leftoverSpectrum, undefined);
  assert.equal(sent.metrics.midBands[0].lo, undefined);
  if (timeoutCalls === 1) return hangingFetch(url, init);
  return jsonResponse(200, { ok: true, plan: { readinessScore: 81, summary: 'ok' } });
};

const retried = await context.requestAI(
  { phase: 'mix', metrics: fatMetrics, notes: 'vocal buried', targetLufs: -12 },
  { fetch: timeoutThenOk, timeoutMs: 40, maxAttempts: 2 },
);
assert.equal(retried.readinessScore, 81);
assert.equal(timeoutCalls, 2);

let serverErrorCalls = 0;
const serverThenOk = async () => {
  serverErrorCalls += 1;
  if (serverErrorCalls === 1) return jsonResponse(504, { ok: false, error: 'AI audit timed out' });
  return jsonResponse(200, { ok: true, plan: { readinessScore: 77 } });
};
const after504 = await context.requestAI(
  { phase: 'mix', metrics: { lufs: -14 } },
  { fetch: serverThenOk, timeoutMs: 1000, maxAttempts: 2 },
);
assert.equal(after504.readinessScore, 77);
assert.equal(serverErrorCalls, 2);

let badCalls = 0;
const always400 = async () => {
  badCalls += 1;
  return jsonResponse(400, { ok: false, error: 'ANTHROPIC_API_KEY is not configured.' });
};
await assert.rejects(
  () => context.requestAI({ phase: 'mix' }, { fetch: always400, timeoutMs: 1000, maxAttempts: 2 }),
  /ANTHROPIC_API_KEY/,
);
assert.equal(badCalls, 1, 'non-retryable 400 must not be retried');

let exhausted = 0;
const alwaysHang = (url, init) => {
  exhausted += 1;
  return hangingFetch(url, init);
};
await assert.rejects(
  () => context.requestAI({ phase: 'mix' }, { fetch: alwaysHang, timeoutMs: 30, maxAttempts: 2 }),
  (error) => error.name === 'TimeoutError' && /timed out/i.test(error.message),
);
assert.equal(exhausted, 2);

context.jsonResponse = jsonResponse;
vm.runInContext(`
  globalThis.fetch = function windowLikeFetch(url, init) {
    if (this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    }
    if (url !== '/api/analyze') throw new Error('unexpected url: ' + url);
    if (init.method !== 'POST') throw new Error('unexpected method');
    return jsonResponse(200, { ok: true, plan: { readinessScore: 90, summary: 'bound fetch' } });
  };
`, context);

const defaultFetchPlan = await context.requestAI(
  { phase: 'mix', metrics: { lufs: -14 } },
  { timeoutMs: 1000, maxAttempts: 1 },
);
assert.equal(defaultFetchPlan.readinessScore, 90, 'default fetch must be invoked as a method of globalThis/window');

let injectedCalls = 0;
const injectedFetch = async function injectedFetch() {
  injectedCalls += 1;
  assert.notEqual(this, context, 'injected fetch must be used as-is, not rebound to window');
  return jsonResponse(200, { ok: true, plan: { readinessScore: 64 } });
};
const injectedPlan = await context.requestAI(
  { phase: 'mix', metrics: { lufs: -11 } },
  { fetch: injectedFetch, timeoutMs: 1000, maxAttempts: 1 },
);
assert.equal(injectedPlan.readinessScore, 64);
assert.equal(injectedCalls, 1);

console.log('ai-audit-smoke: ok');
