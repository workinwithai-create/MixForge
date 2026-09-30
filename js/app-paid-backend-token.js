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

// When MixForge runs inside Pipe Dreams, the Warehouse is the one authentication
// boundary. Accept its already-verified Dreamer session and turn it into the same
// local MixForge license used by the rest of this app.
(() => {
  function allowedParent(origin) {
    try {
      const host = new URL(origin).hostname;
      return host === 'studio.workinwithai.com'
        || host === 'pipe-dreams-warehouse.vercel.app'
        || (host.startsWith('pipe-dreams-warehouse-') && host.endsWith('.vercel.app'))
        || host === 'localhost' || host === '127.0.0.1';
    } catch (_) { return false; }
  }

  async function applyWarehouseSession(token, parentOrigin) {
    if (!token) return;
    try {
      const response = await fetch('/api/entitlement?returnTo=' + encodeURIComponent(location.href), {
        method: 'GET', credentials: 'include',
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload) return;
      if (payload.license) {
        try { localStorage.setItem('mixforge-license-v1', payload.license); } catch (_) {}
      }

      const client = globalThis.MixForgeHub;
      if (client) {
        const entitled = Boolean(payload.entitled);
        const product = payload.product || null;
        const studioStatus = {
          ok: true, entitled, signedIn: Boolean(payload.email || payload.userId), product,
          reason: payload.reason || (entitled ? 'ok' : 'signed-in-unpaid'),
          email: payload.email || null, userId: payload.userId || null,
          license: payload.license || null,
          hasMix: product === 'mix' || product === 'bundle', hasBundle: product === 'bundle',
          loginUrl: payload.loginUrl, checkoutUrl: payload.checkoutUrl,
          pricingUrl: payload.pricingUrl, returnTo: payload.returnTo,
        };
        if (typeof client.applyStudioStatus === 'function') client.applyStudioStatus(studioStatus);
        else {
          client.status = studioStatus;
          if (client.features) {
            client.features.quickMaster = entitled;
            client.features.forensicStems = entitled;
            client.features.export = entitled;
          }
          client.render?.();
        }
      }
      parent?.postMessage({ type: 'PIPE_DREAMS_STUDIO_SESSION_READY', room: 'MIXFORGE', entitled: Boolean(payload.entitled) }, parentOrigin);
    } catch (error) {
      console.warn('[MixForge] Pipe Dreams session bridge failed', error);
    }
  }

  window.addEventListener('message', (event) => {
    if (event.data?.type !== 'PIPE_DREAMS_STUDIO_SESSION' || !allowedParent(event.origin)) return;
    void applyWarehouseSession(event.data.accessToken, event.origin);
  });

  // The parent may have posted its token before this deferred script installed its listener.
  // Ask for it explicitly once the listener is ready; the request carries no credential.
  if (window.parent && window.parent !== window) {
    try {
      window.parent.postMessage({ type: 'PIPE_DREAMS_STUDIO_SESSION_REQUEST', room: 'MIXFORGE' }, '*');
    } catch (_) {}
  }
})();
