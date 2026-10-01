import assert from 'node:assert/strict';

const LIVE = 'https://mixforge.workinwithai.com';
const HUB_ME = 'https://workinwithai.com/api/entitlements/me';

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  assert.equal(res.ok, true, `${url} must return ok, got ${res.status}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url);
  assert.equal(res.ok, true, `${url} must return ok, got ${res.status}`);
  return res.text();
}

const shell = await getText(`${LIVE}/`);
assert.match(shell, /MixForge/);
assert.match(shell, /2\.7\.1/);
assert.match(shell, /Download release WAV/);
assert.doesNotMatch(shell, /ungated-preview/);

const analyze = await getJson(`${LIVE}/api/analyze`);
assert.equal(analyze.ok, true);
assert.equal(analyze.listeningConfigured, true);
assert.equal(analyze.listeningProvider, 'gemini-audio');

const entitlement = await getJson(`${LIVE}/api/entitlement`);
assert.equal(entitlement.ok, true);
assert.equal(entitlement.entitled, false);
assert.equal(entitlement.reason, 'anonymous');
assert.equal(entitlement.returnTo, `${LIVE}/`);
assert.equal(entitlement.checkoutApi, 'https://workinwithai.com/api/checkout');
assert.match(entitlement.loginUrl, /workinwithai\.com\/login/);
assert.match(entitlement.loginUrl, /mixforge\.workinwithai\.com/);

const me = await getJson(HUB_ME);
assert.equal(me.signedIn, false);
assert.equal(me.hasMix, false);
assert.equal(me.hasBundle, false);
assert.equal(me.checkoutLookupKeys.mix, 'mix-monthly');
assert.equal(me.checkoutLookupKeys.pass, 'forge-pass-monthly');
assert.equal(me.hubOrigin, 'https://workinwithai.com');

console.log('live-production-health-smoke: ok');
