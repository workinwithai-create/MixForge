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
  return { url, anon, service, secret, ready: Boolean(url && (anon || service) && secret) };
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
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-MixForge-License');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed' });

  const cfg = configured();
  if (!cfg.ready) return json(res, 200, evaluateEntitlement({ misconfigured: true }));

  try {
    const license = verifyLicense(extractLicenseToken(req) || req.body?.license || '', cfg.secret);
    const accessToken = extractBearer(req) || req.body?.access_token || '';
    const user = accessToken ? await supabaseUser(cfg, accessToken) : null;
    const rows = user ? await supabaseEntitlements(cfg, user, accessToken) : [];
    return json(res, 200, attachLicense(evaluateEntitlement({ user, rows, license }), cfg));
  } catch (error) {
    console.error('MixForge entitlement error:', error);
    return json(res, 200, evaluateEntitlement({ misconfigured: true }));
  }
}
