'use strict';

import { createHmac, timingSafeEqual } from 'node:crypto';

export const MIX_PRODUCTS = Object.freeze(['mix', 'bundle']);
export const HUB_ORIGIN = 'https://workinwithai.com';
export const APP_ORIGIN = 'https://mixforge.workinwithai.com';
export const DEFAULT_HUB_SUPABASE_URL = 'https://kldstbhnpwpvvubphnas.supabase.co';
export const LICENSE_TTL_SEC = 60 * 60 * 12;
export const FOUNDER_EMAILS = Object.freeze([
  'workinwithai@gmail.com',
  'markparsonsjrmusic@gmail.com',
  'mpjrecords90@gmail.com',
]);

const PRODUCT_ALIASES = {
  mix: 'mix',
  'mix-monthly': 'mix',
  mixforge: 'mix',
  'mix-forge': 'mix',
  bundle: 'bundle',
  'forge-pass': 'bundle',
  'forge-pass-monthly': 'bundle',
  'forge_pass': 'bundle',
  pass: 'bundle',
};

export function json(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}

export function hubUrls(returnTo = APP_ORIGIN + '/') {
  const safeReturn = String(returnTo || APP_ORIGIN + '/');
  const loginUrl = `${HUB_ORIGIN}/login?next=${encodeURIComponent(safeReturn)}`;
  return {
    loginUrl,
    checkoutUrl: `${HUB_ORIGIN}/#pricing`,
    pricingUrl: `${HUB_ORIGIN}/#pricing`,
    checkoutApi: `${HUB_ORIGIN}/api/checkout`,
    returnTo: APP_ORIGIN + '/',
  };
}

export function configured() {
  const url = process.env.HUB_SUPABASE_URL?.trim() || DEFAULT_HUB_SUPABASE_URL;
  const anon = process.env.HUB_SUPABASE_ANON_KEY?.trim() || '';
  const service = process.env.HUB_SUPABASE_SERVICE_ROLE_KEY?.trim() || '';
  const secret = process.env.MIXFORGE_LICENSE_SECRET?.trim() || '';
  const supabaseReady = Boolean(url && (anon || service));
  return { url, anon, service, secret, supabaseReady, ready: Boolean(secret || supabaseReady) };
}

export function normalizeProduct(value) {
  if (value == null || value === '') return null;
  return PRODUCT_ALIASES[String(value).trim().toLowerCase()] || null;
}

export function rowProduct(row) {
  if (!row || typeof row !== 'object') return null;
  return normalizeProduct(row.product_key || row.tool_key || row.product || row.key || row.sku);
}

export function isFounder(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!value) return false;
  if (FOUNDER_EMAILS.includes(value)) return true;
  if (value.endsWith('@workinwithai.com')) return true;
  const extra = String(process.env.MIXFORGE_ADMIN_EMAILS || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  return extra.includes(value);
}

export function rowActive(row, now = Date.now()) {
  if (!row) return false;
  if (row.revoked_at) return false;
  if (row.status && !['active', 'trialing', 'paid', 'ok'].includes(String(row.status).toLowerCase())) return false;
  const exp = row.expires_at ? Date.parse(row.expires_at) : NaN;
  if (Number.isFinite(exp) && exp <= now) return false;
  return Boolean(rowProduct(row));
}

export function pickEntitlement(rows, now = Date.now()) {
  const list = Array.isArray(rows) ? rows : [];
  const active = list.filter((row) => rowActive(row, now));
  const bundle = active.find((row) => rowProduct(row) === 'bundle');
  if (bundle) return { product: 'bundle', row: bundle, expired: false };
  const mix = active.find((row) => rowProduct(row) === 'mix');
  if (mix) return { product: 'mix', row: mix, expired: false };
  const expired = list.some((row) => {
    const product = rowProduct(row);
    if (!MIX_PRODUCTS.includes(product)) return false;
    const exp = row.expires_at ? Date.parse(row.expires_at) : NaN;
    return Number.isFinite(exp) && exp <= now;
  });
  return { product: null, row: null, expired };
}

export function signLicense(payload, secret) {
  if (!secret) throw new Error('MIXFORGE_LICENSE_SECRET is not configured.');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyLicense(token, secret, now = Date.now()) {
  if (!token || !secret) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || payload.aud !== 'mixforge') return null;
    if (Number(payload.exp) * 1000 <= now) return null;
    if (!MIX_PRODUCTS.includes(payload.product)) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

export function evaluateEntitlement({
  user = null,
  rows = [],
  license = null,
  misconfigured = false,
  now = Date.now(),
} = {}) {
  const urls = hubUrls();
  const email = user?.email || license?.email || null;
  const base = {
    ok: true,
    entitled: false,
    product: null,
    reason: 'anonymous',
    email,
    userId: user?.id || license?.sub || null,
    license: null,
    ...urls,
  };
  if (misconfigured) return { ...base, reason: 'misconfigured' };
  if (isFounder(email)) {
    return { ...base, entitled: true, product: 'bundle', reason: 'ok', email };
  }
  if (license && MIX_PRODUCTS.includes(license.product)) {
    return { ...base, entitled: true, product: license.product, reason: 'ok', email: license.email || email };
  }
  if (!user) return base;
  const picked = pickEntitlement(rows, now);
  if (picked.product) {
    return { ...base, entitled: true, product: picked.product, reason: 'ok', email: user.email || email, userId: user.id };
  }
  if (picked.expired) return { ...base, reason: 'expired', email: user.email || email, userId: user.id };
  return { ...base, reason: 'signed-in-unpaid', email: user.email || email, userId: user.id };
}

export function extractBearer(req) {
  const header = req?.headers?.authorization || req?.headers?.Authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  if (req?.query?.token || req?.query?.access_token) return String(req.query.token || req.query.access_token);
  return '';
}

export function extractLicenseToken(req) {
  if (req?.query?.license) return String(req.query.license);
  if (req?.headers?.['x-mixforge-license']) return String(req.headers['x-mixforge-license']);
  const cookie = String(req?.headers?.cookie || '');
  const found = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('mixforge_license='));
  return found ? decodeURIComponent(found.slice('mixforge_license='.length)) : '';
}

export function hubMeToIdentity(payload) {
  if (!payload || typeof payload !== 'object') return { user: null, rows: [] };
  const signedIn = Boolean(payload.signedIn || payload.email || payload.userId);
  if (!signedIn) return { user: null, rows: [] };
  const user = {
    id: payload.userId || payload.email || 'hub-user',
    email: payload.email || null,
  };
  const rows = [];
  if (payload.hasBundle) rows.push({ product: 'bundle', status: 'active' });
  if (payload.hasMix) rows.push({ product: 'mix', status: 'active' });
  const products = Array.isArray(payload.products) ? payload.products : [];
  for (const product of products) {
    const normalized = normalizeProduct(product);
    if (normalized) rows.push({ product: normalized, status: 'active' });
  }
  return { user, rows };
}

export async function fetchHubEntitlementsMe(req) {
  const headers = { Accept: 'application/json' };
  const cookie = req?.headers?.cookie || req?.headers?.Cookie;
  if (cookie) headers.Cookie = cookie;
  const authorization = req?.headers?.authorization || req?.headers?.Authorization;
  if (authorization) headers.Authorization = authorization;
  const response = await fetch(`${HUB_ORIGIN}/api/entitlements/me`, {
    method: 'GET',
    headers,
  });
  if (!response.ok) return null;
  const payload = await response.json().catch(() => null);
  return payload && typeof payload === 'object' ? payload : null;
}

async function supabaseUser(cfg, accessToken) {
  if (!accessToken) return null;
  const response = await fetch(`${cfg.url}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${accessToken}`, apikey: cfg.anon || cfg.service },
  });
  if (!response.ok) return null;
  const user = await response.json().catch(() => null);
  if (!user?.id) return null;
  return { id: user.id, email: user.email || user.user_metadata?.email || null };
}

async function supabaseEntitlements(cfg, user, accessToken) {
  if (!user?.id) return [];
  const key = cfg.service || cfg.anon;
  const token = cfg.service || accessToken;
  const response = await fetch(`${cfg.url}/rest/v1/entitlements?user_id=eq.${encodeURIComponent(user.id)}&select=*`, {
    headers: { Authorization: `Bearer ${token}`, apikey: key, Accept: 'application/json' },
  });
  if (!response.ok) return [];
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

function attachLicense(status, cfg) {
  if (!status.entitled || !cfg.secret || !status.userId) return status;
  try {
    const license = signLicense({
      aud: 'mixforge',
      sub: status.userId,
      email: status.email,
      product: status.product,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + LICENSE_TTL_SEC,
    }, cfg.secret);
    return { ...status, license };
  } catch (_) {
    return status;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const requestOrigin = req.headers.origin || '';
  const allowOrigin = /workinwithai\.com$/.test(new URL(requestOrigin || APP_ORIGIN).hostname) ? requestOrigin : APP_ORIGIN;
  try {
    if (requestOrigin) {
      const host = new URL(requestOrigin).hostname;
      if (host === 'workinwithai.com' || host.endsWith('.workinwithai.com') || host.endsWith('.vercel.app')) {
        res.setHeader('Access-Control-Allow-Origin', requestOrigin);
      }
    }
  } catch (_) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-MixForge-License');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed' });

  const cfg = configured();

  try {
    const license = cfg.secret
      ? verifyLicense(extractLicenseToken(req) || req.body?.license || '', cfg.secret)
      : null;

    let user = null;
    let rows = [];

    try {
      const hubMe = await fetchHubEntitlementsMe(req);
      const fromHub = hubMeToIdentity(hubMe);
      user = fromHub.user;
      rows = fromHub.rows;
    } catch (error) {
      console.error('MixForge entitlement Hub forward failed:', error);
    }

    const accessToken = extractBearer(req) || req.body?.access_token || '';
    if (!user && accessToken && cfg.supabaseReady) {
      user = await supabaseUser(cfg, accessToken);
      rows = user ? await supabaseEntitlements(cfg, user, accessToken) : [];
    }

    const status = evaluateEntitlement({ user, rows, license });
    if (status.reason === 'ungated-preview') status.reason = status.entitled ? 'ok' : (user ? 'signed-in-unpaid' : 'anonymous');
    return json(res, 200, attachLicense(status, cfg));
  } catch (error) {
    console.error('MixForge entitlement error:', error);
    return json(res, 200, evaluateEntitlement({ misconfigured: true }));
  }
}
