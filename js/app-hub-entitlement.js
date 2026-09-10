'use strict';

// MixForge Hub entitlement + checkout client.
// Stereo audit is free. Paid features: quickMaster, forensicStems, export.
// Uses a distinct lexical name so it can safely load after the legacy musician UX object.
const MF_HUB_ORIGIN = 'https://workinwithai.com';
const MF_HUB_ENTITLEMENTS_URL = 'https://workinwithai.com/api/entitlements/me';
const MF_HUB_CHECKOUT_URL = 'https://workinwithai.com/api/checkout';
const MF_APP_ORIGIN = 'https://mixforge.workinwithai.com';
const MF_LICENSE_KEY = 'mixforge-license-v1';
const MF_PAID_FEATURES = new Set(['quickMaster', 'forensicStems', 'export']);
const MF_FETCH_TIMEOUT_MS = 4000;

function mfFirstPartyReturn() {
  try {
    const host = String(globalThis.location?.hostname || '');
    if (host === 'mixforge.workinwithai.com' || host.endsWith('.workinwithai.com')) {
      return `${globalThis.location.origin}/`;
    }
    if (host === 'mix-forge.vercel.app') {
      return `${globalThis.location.origin}/`;
    }
  } catch (_) {}
  return `${MF_APP_ORIGIN}/`;
}

function mfHubLoginUrl(returnTo = mfFirstPartyReturn()) {
  return `${MF_HUB_ORIGIN}/login?next=${encodeURIComponent(returnTo)}&checkout=mix-monthly&buy=mix-monthly`;
}

function mfDefaultStatus(reason = 'login') {
  return {
    ok: true,
    entitled: false,
    signedIn: false,
    product: null,
    reason: reason === 'ungated-preview' ? 'login' : reason,
    email: null,
    userId: null,
    license: null,
    hasMix: false,
    hasBundle: false,
    loginUrl: mfHubLoginUrl(),
    checkoutUrl: `${MF_HUB_ORIGIN}/get-mix-forge`,
    pricingUrl: `${MF_HUB_ORIGIN}/#pricing`,
    checkoutApi: MF_HUB_CHECKOUT_URL,
    returnTo: mfFirstPartyReturn(),
    checkoutLookupKeys: { mix: 'mix-monthly', pass: 'forge-pass-monthly' },
  };
}

function mfReadStoredLicense() {
  try { return localStorage.getItem(MF_LICENSE_KEY) || ''; } catch (_) { return ''; }
}

function mfStoreLicense(token) {
  try {
    if (token) localStorage.setItem(MF_LICENSE_KEY, token);
    else localStorage.removeItem(MF_LICENSE_KEY);
  } catch (_) {}
}

function mfNormalizeHubMe(payload) {
  const status = mfDefaultStatus(payload?.reason || 'login');
  if (!payload || typeof payload !== 'object') return status;
  status.signedIn = Boolean(payload.signedIn);
  status.email = payload.email || null;
  status.userId = payload.userId || null;
  status.hasMix = Boolean(payload.hasMix);
  status.hasBundle = Boolean(payload.hasBundle);
  status.entitled = Boolean(payload.hasMix || payload.hasBundle);
  status.product = payload.hasBundle ? 'bundle' : payload.hasMix ? 'mix' : null;
  status.reason = payload.reason || (status.entitled ? 'ok' : status.signedIn ? 'subscribe' : 'login');
  if (status.reason === 'ungated-preview') status.reason = status.entitled ? 'ok' : (status.signedIn ? 'subscribe' : 'login');
  if (payload.loginUrl) status.loginUrl = payload.loginUrl;
  if (payload.checkoutLookupKeys) status.checkoutLookupKeys = payload.checkoutLookupKeys;
  return status;
}

function mfNormalizeLocalEntitlement(payload) {
  const status = mfDefaultStatus(payload?.reason || 'anonymous');
  if (!payload || typeof payload !== 'object') return status;
  status.signedIn = Boolean(payload.email || payload.userId);
  status.email = payload.email || null;
  status.userId = payload.userId || null;
  status.entitled = Boolean(payload.entitled);
  status.product = payload.product || null;
  status.hasBundle = payload.product === 'bundle';
  status.hasMix = payload.product === 'mix' || payload.product === 'bundle';
  status.license = payload.license || null;
  status.reason = payload.reason || (status.entitled ? 'ok' : status.signedIn ? 'signed-in-unpaid' : 'anonymous');
  if (status.reason === 'ungated-preview') status.reason = status.entitled ? 'ok' : (status.signedIn ? 'signed-in-unpaid' : 'login');
  if (payload.loginUrl) status.loginUrl = payload.loginUrl;
  if (payload.checkoutUrl) status.checkoutUrl = payload.checkoutUrl;
  if (payload.pricingUrl) status.pricingUrl = payload.pricingUrl;
  return status;
}

function mfPickRicher(hub, local) {
  if (hub?.entitled) return hub;
  if (local?.entitled) return local;
  if (hub?.signedIn) return hub;
  if (local?.signedIn) return local;
  return hub || local || mfDefaultStatus('login');
}

function mfTimeout(ms) {
  return new Promise((_, reject) => {
    const timer = typeof setTimeout === 'function' ? setTimeout : null;
    if (!timer) {
      reject(new Error('timeout-unavailable'));
      return;
    }
    timer(() => reject(new Error('timeout')), ms);
  });
}

async function mfFetchJson(url, options = {}, timeoutMs = MF_FETCH_TIMEOUT_MS) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const fetchOptions = controller ? { ...options, signal: controller.signal } : options;
  const request = fetch(url, fetchOptions).then(async (response) => {
    const payload = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, payload };
  });
  try {
    return await Promise.race([request, mfTimeout(timeoutMs)]);
  } catch (_) {
    try { controller?.abort(); } catch (__) {}
    return { ok: false, status: 0, payload: null, timedOut: true };
  }
}

const MixForgeHubClient = {
  product: 'mixforge',
  pricing: { mixforgeMonthly: 9, forgePassMonthly: 24 },
  features: { quickMaster: false, forensicStems: false, export: false, stereoAudit: true },
  status: mfDefaultStatus('login'),

  requireEntitlement(feature) {
    const name = String(feature || '');
    if (!MF_PAID_FEATURES.has(name)) {
      return { ok: true, feature: name, reason: 'ok', redirectUrl: null };
    }
    const status = this.status || mfDefaultStatus('login');
    if (status.entitled || status.hasMix || status.hasBundle) {
      const reason = status.reason === 'ungated-preview' ? 'ok' : (status.reason || 'ok');
      return { ok: true, feature: name, reason, product: status.product };
    }
    const reason = status.reason === 'ungated-preview'
      ? (status.signedIn ? 'subscribe' : 'login')
      : (status.reason || (status.signedIn ? 'subscribe' : 'login'));
    const redirectUrl = reason === 'login'
      ? (status.loginUrl || mfHubLoginUrl())
      : (status.checkoutUrl || `${MF_HUB_ORIGIN}/get-mix-forge`);
    return { ok: false, feature: name, reason, redirectUrl, loginUrl: status.loginUrl, checkoutUrl: status.checkoutUrl };
  },

  async refresh() {
    const returnTo = mfFirstPartyReturn();
    this.status = mfDefaultStatus('login');
    this.features.quickMaster = false;
    this.features.forensicStems = false;
    this.features.export = false;
    this.render();

    const token = mfReadStoredLicense();
    const localHeaders = { Accept: 'application/json' };
    if (token) localHeaders['X-MixForge-License'] = token;

    const hubPromise = mfFetchJson(MF_HUB_ENTITLEMENTS_URL, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    }).catch(() => ({ ok: false, status: 0, payload: null }));

    const localPromise = mfFetchJson(`/api/entitlement?returnTo=${encodeURIComponent(returnTo)}`, {
      method: 'GET',
      credentials: 'include',
      headers: localHeaders,
    }).catch(() => ({ ok: false, status: 0, payload: null }));

    const [hubRes, localRes] = await Promise.all([hubPromise, localPromise]);
    const hub = hubRes?.payload ? mfNormalizeHubMe(hubRes.payload) : null;
    const local = localRes?.payload ? mfNormalizeLocalEntitlement(localRes.payload) : null;
    if (local?.license) mfStoreLicense(local.license);

    this.status = mfPickRicher(hub, local);
    if (this.status.reason === 'ungated-preview' || this.status.reason === 'anonymous' || this.status.reason === 'checking') {
      this.status.reason = this.status.entitled ? 'ok' : (this.status.signedIn ? 'subscribe' : 'login');
    }
    this.features.quickMaster = this.status.entitled;
    this.features.forensicStems = this.status.entitled;
    this.features.export = this.status.entitled;
    this.render();
    return this.status;
  },

  async startCheckout(lookupKey = 'mix-monthly') {
    const key = lookupKey === 'forge-pass-monthly' || lookupKey === 'pass' || lookupKey === 'bundle'
      ? 'forge-pass-monthly'
      : 'mix-monthly';
    const returnTo = mfFirstPartyReturn();
    try {
      const result = await mfFetchJson(MF_HUB_CHECKOUT_URL, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ lookupKey: key, returnTo }),
      }, 8000);
      if (result.status === 401) {
        const loginUrl = result.payload?.loginUrl || mfHubLoginUrl(returnTo);
        if (globalThis.location) globalThis.location.href = loginUrl;
        return { ok: false, reason: 'login', loginUrl };
      }
      if (!result.ok || !result.payload?.url) {
        const fallback = `${MF_HUB_ORIGIN}/get-mix-forge`;
        if (globalThis.location) globalThis.location.href = fallback;
        return { ok: false, reason: result.payload?.error || 'checkout-failed', fallback: true };
      }
      if (globalThis.location) globalThis.location.href = result.payload.url;
      return { ok: true, url: result.payload.url, alreadySubscribed: Boolean(result.payload.alreadySubscribed) };
    } catch (_) {
      if (globalThis.location) globalThis.location.href = `${MF_HUB_ORIGIN}/get-mix-forge`;
      return { ok: false, reason: 'checkout-unreachable', fallback: true };
    }
  },

  render() {
    const status = this.status || mfDefaultStatus('login');
    const bar = typeof document !== 'undefined' ? document.getElementById('licenseBar') : null;
    const label = typeof document !== 'undefined' ? document.getElementById('licenseStatus') : null;
    const detail = typeof document !== 'undefined' ? document.getElementById('licenseDetail') : null;
    const signIn = typeof document !== 'undefined' ? document.getElementById('licenseSignInBtn') : null;
    const buy = typeof document !== 'undefined' ? document.getElementById('licenseBuyBtn') : null;
    const hint = typeof document !== 'undefined' ? document.getElementById('exportLicenseHint') : null;
    if (signIn) signIn.href = status.loginUrl || mfHubLoginUrl();
    if (buy) {
      buy.href = status.checkoutUrl || `${MF_HUB_ORIGIN}/get-mix-forge`;
      buy.onclick = (event) => {
        event.preventDefault();
        void this.startCheckout('mix-monthly');
      };
    }
    const state = status.entitled ? 'licensed' : status.signedIn ? 'unpaid' : 'login';
    if (bar) bar.setAttribute('data-state', state);
    if (label) {
      label.textContent = status.entitled
        ? (status.hasBundle ? 'Forge Pass active' : 'MixForge license active')
        : status.signedIn
          ? 'Signed in — MixForge license needed'
          : 'Sign in to unlock mastering and export';
    }
    if (detail) {
      detail.textContent = status.entitled
        ? `Licensed as ${status.email || 'this account'}. Stereo audit stays free; Quick Master, Forensic Fix, and WAV export are unlocked.`
        : 'Stereo audit stays free. Quick Master, Forensic Fix, and WAV export need MixForge ($9/mo) or the Forge Pass ($24/mo).';
    }
    if (hint) hint.hidden = Boolean(status.entitled);
    return status;
  },
};

// The full musician UX on main still closes over its legacy MixForgeHub object.
// Mutate that object instead of redeclaring it, then expose the real client globally.
try {
  if (typeof MixForgeHub !== 'undefined' && MixForgeHub && MixForgeHub !== MixForgeHubClient) {
    MixForgeHub.requireEntitlement = (feature) => MixForgeHubClient.requireEntitlement(feature);
    MixForgeHub.features = MixForgeHubClient.features;
    MixForgeHub.pricing = MixForgeHubClient.pricing;
    MixForgeHub.status = MixForgeHubClient.status;
    MixForgeHub.refresh = () => MixForgeHubClient.refresh();
    MixForgeHub.startCheckout = (key) => MixForgeHubClient.startCheckout(key);
    MixForgeHub.render = () => MixForgeHubClient.render();
  }
} catch (_) {}
if (typeof globalThis !== 'undefined') globalThis.MixForgeHub = MixForgeHubClient;

if (typeof document !== 'undefined') {
  const start = () => {
    MixForgeHubClient.render();
    void MixForgeHubClient.refresh();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}
