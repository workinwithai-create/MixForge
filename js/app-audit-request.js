'use strict';

const AI_AUDIT_TIMEOUT_MS = 58000;
const AI_AUDIT_MAX_ATTEMPTS = 2;

function compactMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return {};
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
  const bands = (items) => Array.isArray(items) ? items.slice(0, 8).map((item) => ({ name: String(item?.name || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 24), db: number(item?.db) })) : [];
  return {
    lufs: number(metrics.lufs), peakDb: number(metrics.peakDb), rmsDb: number(metrics.rmsDb), crestDb: number(metrics.crestDb), lra: number(metrics.lra),
    correlation: number(metrics.correlation), widthDb: number(metrics.widthDb), dcOffset: number(metrics.dcOffset), clipPercent: number(metrics.clipPercent),
    midBands: bands(metrics.midBands), sideBands: bands(metrics.sideBands),
    sibilance: metrics.sibilance ? { medianDb: number(metrics.sibilance.medianDb), p95Db: number(metrics.sibilance.p95Db), flares: number(metrics.sibilance.flares), frames: number(metrics.sibilance.frames) } : null,
  };
}

function compactAuditPayload(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const phase = source.phase === 'stems' ? 'stems' : 'mix';
  const notes = String(source.notes || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 1200);
  if (phase === 'stems') {
    const stems = {};
    for (const [name, metrics] of Object.entries(source.stems || {})) stems[name] = compactMetrics(metrics);
    return { phase, stems, mixMetrics: compactMetrics(source.mixMetrics), notes };
  }
  const targetLufs = Number(source.targetLufs);
  return {
    phase,
    metrics: compactMetrics(source.metrics),
    notes,
    targetLufs: Number.isFinite(targetLufs) ? targetLufs : -12,
  };
}

function createAITimeoutReason() {
  try {
    return new DOMException('AI audit timed out', 'TimeoutError');
  } catch (_) {
    const error = new Error('AI audit timed out');
    error.name = 'TimeoutError';
    return error;
  }
}

function abortAITimeout(controller) {
  const reason = createAITimeoutReason();
  try {
    controller.abort(reason);
  } catch (_) {
    controller.abort();
  }
}

function isTimeoutAIError(error) {
  if (!error) return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  return /timed out|aborted/i.test(String(error.message || error));
}

function isRetryableAIError(error) {
  if (!error) return false;
  const status = Number(error.status);
  if (status === 408 || status === 429 || status >= 500) return true;
  if (isTimeoutAIError(error)) return true;
  if (error.name === 'TypeError') return true;
  return /failed to fetch|networkerror|network request failed|load failed/i.test(String(error.message || error));
}

function aiFallbackStatusMessage(error) {
  if (isTimeoutAIError(error)) {
    return 'AI engineer timed out — using the built-in measurement engine so you can keep going.';
  }
  return 'AI engineer was unavailable — using the built-in measurement engine so you can keep going.';
}

function normalizeAIRequestError(error, signal) {
  const reason = signal?.aborted ? signal.reason : null;
  const reasonText = String(reason?.message || reason || '');
  if (error?.name === 'AbortError' || /timed out/i.test(reasonText)) {
    const timed = new Error(reason?.message || 'AI audit timed out');
    timed.name = 'TimeoutError';
    timed.cause = reason || error;
    return timed;
  }
  return error;
}

async function requestAIOnce(payload, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => abortAITimeout(controller), options.timeoutMs);
  try {
    const response = await options.fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      const error = new Error(data.error || `AI request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data.plan;
  } catch (error) {
    throw normalizeAIRequestError(error, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function requestAI(payload, options = {}) {
  const timeoutMs = options.timeoutMs ?? AI_AUDIT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? AI_AUDIT_MAX_ATTEMPTS;
  const fetchImpl = options.fetch || fetch;
  const compact = compactAuditPayload(payload);
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await requestAIOnce(compact, { timeoutMs, fetch: fetchImpl });
    } catch (error) {
      lastError = error;
      if (!isRetryableAIError(error) || attempt === maxAttempts) throw error;
      if (typeof options.onRetry === 'function') options.onRetry(error, attempt);
    }
  }
  throw lastError;
}
