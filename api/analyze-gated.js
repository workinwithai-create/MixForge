import analyzeHandler from './analyze.js';

const HUB_ENTITLEMENTS_URL = 'https://workinwithai.com/api/entitlements/me';
const MIX_ORIGIN = 'https://mixforge.workinwithai.com';

function json(res, status, body) {
  res.status(status).json(body);
}

async function verifyMixAccess(req) {
  const cookie = String(req.headers?.cookie || '');
  if (!cookie) return { ok: false, status: 401, reason: 'login' };

  let response;
  try {
    response = await fetch(HUB_ENTITLEMENTS_URL, {
      method: 'GET',
      headers: {
        Cookie: cookie,
        Origin: MIX_ORIGIN,
        Accept: 'application/json',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    console.error('MixForge entitlement check failed:', error);
    return { ok: false, status: 503, reason: 'unavailable' };
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, status: 503, reason: 'unavailable' };
  if (!data?.signedIn) return { ok: false, status: 401, reason: 'login' };
  if (!data?.hasMix) return { ok: false, status: 402, reason: 'subscribe' };
  return { ok: true, status: 200, reason: 'ok' };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // The lightweight GET capability probe is harmless and remains public.
  // Every request that can spend Gemini/Anthropic credits is paywalled.
  if (req.method !== 'POST') return analyzeHandler(req, res);

  const access = await verifyMixAccess(req);
  if (!access.ok) {
    if (access.reason === 'login') {
      return json(res, 401, {
        ok: false,
        error: 'WorkinWithAI login required',
        reason: 'login',
        loginUrl: `https://workinwithai.com/login?next=${encodeURIComponent(MIX_ORIGIN)}`,
      });
    }
    if (access.reason === 'subscribe') {
      return json(res, 402, {
        ok: false,
        error: 'MixForge subscription required',
        reason: 'subscribe',
        membershipUrl: `${MIX_ORIGIN}/membership/`,
      });
    }
    return json(res, 503, {
      ok: false,
      error: 'WorkinWithAI access check is temporarily unavailable',
      reason: 'unavailable',
    });
  }

  return analyzeHandler(req, res);
}
