'use strict';

// MixForge Hub entitlement + checkout client.
// Stereo audit is free. Paid features: quickMaster, forensicStems, export.
// Never returns reason "ungated-preview".

const MF_HUB_ORIGIN = 'https://workinwithai.com';
const MF_APP_ORIGIN = 'https://mixforge.workinwithai.com';
const MF_LICENSE_KEY = 'mixforge-license-v1';
const MF_PAID_FEATURES = new Set(['quickMaster', 'forensicStems', 'export']);

function mfFirstPartyReturn() {
  try {
    const host = String(globalThis.location?.hostname || '');
    if (host === 'mixforge.workinwithai.com' || host === 'mix.workinwithai.com' || host.endsWith('.workinwithai.com')) {
      return `${globalThis.location.origin}/`;
    }
  } catch (_) {}
  return `${MF_APP_ORIGIN}/`;
}

function mfHubLoginUrl(returnTo = mfFirstPartyReturn()) {
  return `${MF_HUB_ORIGIN}/login?next=${encodeURIComponent(returnTo)}`;
}

function mfDefaultStatus(reason = 'anonymous') {
  return {
    ok: true,
    entitled: false,
    signedIn: false,
    product: null,
    reason,
    email: null,
    userId: null,
    license: null,
    hasMix: false,
    hasBundle: false,
    loginUrl: mfHubLoginUrl(),
    checkoutUrl: `${MF_HUB_ORIGIN}/#pricing`,
    pricingUrl: `${MF_HUB_ORIGIN}/#pricing`,
    checkoutApi: `${MF_HUB_ORIGIN}/api/checkout`,
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
  if (status.reason === 'ungated-preview') status.reason = status.entitled ? 'ok' : 'login';
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
  if (status.reason === 'ungated-preview') status.reason = status.entitled ? 'ok' : 'anonymous';
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
  return hub || local || mfDefaultStatus();
}

async function mfFetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, payload };
}

const MixForgeHub = {
  product: 'mixforge',
  pricing: { mixforgeMonthly: 9, forgePassMonthly: 24 },
  features: { quickMaster: false, forensicStems: false, export: false, stereoAudit: true },
  status: mfDefaultStatus('anonymous'),

  requireEntitlement(feature) {
    const name = String(feature || '');
    if (!MF_PAID_FEATURES.has(name)) {
      return { ok: true, feature: name, reason: 'ok', redirectUrl: null };
    }
    const status = this.status || mfDefaultStatus();
    if (status.entitled || status.hasMix || status.hasBundle) {
      return { ok: true, feature: name, reason: status.reason === 'ungated-preview' ? 'ok' : (status.reason || 'ok'), product: status.product };
    }
    const reason = status.reason === 'ungated-preview'
      ? (status.signedIn ? 'subscribe' : 'login')
      : (status.reason || (status.signedIn ? 'subscribe' : 'login'));
    const redirectUrl = reason === 'login' ? (status.loginUrl || mfHubLoginUrl()) : (status.checkoutUrl || `${MF_HUB_ORIGIN}/#pricing`);
    return { ok: false, feature: name, reason, redirectUrl, loginUrl: status.loginUrl, checkoutUrl: status.checkoutUrl };
  },

  async refresh() {
    const returnTo = mfFirstPartyReturn();
    let hub = null;
    let local = null;
    try {
      const hubRes = await mfFetchJson(`${MF_HUB_ORIGIN}/api/entitlements/me`, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (hubRes.payload) hub = mfNormalizeHubMe(hubRes.payload);
    } catch (_) {}
    try {
      const token = mfReadStoredLicense();
      const headers = { Accept: 'application/json' };
      if (token) headers['X-MixForge-License'] = token;
      const localRes = await mfFetchJson(`/api/entitlement?returnTo=${encodeURIComponent(returnTo)}`, {
        method: 'GET',
        credentials: 'include',
        headers,
      });
      if (localRes.payload) local = mfNormalizeLocalEntitlement(localRes.payload);
      if (local?.license) mfStoreLicense(local.license);
    } catch (_) {}
    this.status = mfPickRicher(hub, local);
    if (this.status.reason === 'ungated-preview') {
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
    const result = await mfFetchJson(`${MF_HUB_ORIGIN}/api/checkout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ lookupKey: key, returnTo }),
    });
    if (result.status === 401) {
      globalThis.location.href = mfHubLoginUrl(returnTo);
      return { ok: false, reason: 'login' };
    }
    if (!result.ok || !result.payload?.url) {
      return { ok: false, reason: result.payload?.error || 'checkout-failed' };
    }
    globalThis.location.href = result.payload.url;
    return { ok: true, url: result.payload.url, alreadySubscribed: Boolean(result.payload.alreadySubscribed) };
  },

  render() {
    const status = this.status || mfDefaultStatus();
    const bar = typeof document !== 'undefined' ? document.getElementById('licenseBar') : null;
    const label = typeof document !== 'undefined' ? document.getElementById('licenseStatus') : null;
    const detail = typeof document !== 'undefined' ? document.getElementById('licenseDetail') : null;
    const signIn = typeof document !== 'undefined' ? document.getElementById('licenseSignInBtn') : null;
    const buy = typeof document !== 'undefined' ? document.getElementById('licenseBuyBtn') : null;
    const hint = typeof document !== 'undefined' ? document.getElementById('exportLicenseHint') : null;
    if (signIn) signIn.href = status.loginUrl || mfHubLoginUrl();
    if (buy) {
      buy.href = status.pricingUrl || `${MF_HUB_ORIGIN}/#pricing`;
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

if (typeof globalThis !== 'undefined') globalThis.MixForgeHub = MixForgeHub;

if (typeof document !== 'undefined') {
  const start = () => { void MixForgeHub.refresh(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}
