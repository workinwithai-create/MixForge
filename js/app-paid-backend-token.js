'use strict';

// Paid backend bridge. MixForge keeps its free stereo audit, while expensive
// source separation must prove the same WorkinWithAI entitlement server-side.
(() => {
  const PRODUCT_TOKEN_URL = 'https://workinwithai.com/api/product-token?product=mix';
  const PROTECTED_PATHS = ['/functions/v1/separate-stem'];
  const nativeFetch = window.fetch.bind(window);
  let accessToken = '';
  let expiresAtMs = 0;
  let pending = null;

  function protectedUrl(input) {
    const url = typeof input === 'string' || input instanceof URL
      ? String(input)
      : String(input?.url || '');
    return PROTECTED_PATHS.some((path) => url.includes(path));
  }

  async function refreshToken() {
    const response = await nativeFetch(PRODUCT_TOKEN_URL, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.accessToken) {
      const error = new Error(
        response.status === 402
          ? 'MixForge or Forge Pass membership is required for source separation.'
          : response.status === 401
            ? 'Sign in with WorkinWithAI before starting source separation.'
            : 'MixForge could not verify paid backend access.'
      );
      error.status = response.status;
      throw error;
    }
    accessToken = data.accessToken;
    expiresAtMs = Number(data.expiresAt || 0) * 1000;
    return accessToken;
  }

  async function getToken() {
    const stillFresh = accessToken && (!expiresAtMs || expiresAtMs - Date.now() > 60_000);
    if (stillFresh) return accessToken;
    if (!pending) pending = refreshToken().finally(() => { pending = null; });
    return pending;
  }

  window.fetch = async function mixForgePaidFetch(input, init = {}) {
    if (!protectedUrl(input)) return nativeFetch(input, init);

    const token = await getToken();
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers || {}).forEach((value, key) => headers.set(key, value));
    headers.set('x-wwa-token', token);
    return nativeFetch(input, { ...init, headers });
  };
})();
