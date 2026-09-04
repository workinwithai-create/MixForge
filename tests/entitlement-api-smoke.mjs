import assert from 'node:assert/strict';
import {
  APP_ORIGIN,
  FOUNDER_EMAILS,
  HUB_ORIGIN,
  evaluateEntitlement,
  extractBearer,
  extractLicenseToken,
  hubUrls,
  isFounder,
  normalizeProduct,
  pickEntitlement,
  rowProduct,
  signLicense,
  verifyLicense,
} from '../api/entitlement.js';

assert.equal(normalizeProduct('mix-monthly'), 'mix');
assert.equal(normalizeProduct('forge-pass-monthly'), 'bundle');
assert.equal(normalizeProduct('unknown-sku'), null);
assert.equal(rowProduct({ product: 'mix' }), 'mix');
assert.equal(rowProduct({ product_key: 'forge-pass' }), 'bundle');

assert.equal(isFounder('workinwithai@gmail.com'), true);
assert.equal(isFounder('markparsonsjrmusic@gmail.com'), true);
assert.equal(isFounder('mpjrecords90@gmail.com'), true);
assert.equal(isFounder('ops@workinwithai.com'), true);
assert.equal(isFounder('fan@example.com'), false);
assert.ok(FOUNDER_EMAILS.includes('workinwithai@gmail.com'));

const anon = evaluateEntitlement();
assert.equal(anon.entitled, false);
assert.equal(anon.reason, 'anonymous');
assert.equal(anon.product, null);
assert.notEqual(anon.reason, 'ungated-preview');
assert.match(anon.loginUrl, /workinwithai\.com\/login/);
assert.equal(anon.checkoutApi, `${HUB_ORIGIN}/api/checkout`);
assert.equal(anon.returnTo, `${APP_ORIGIN}/`);

const misconfigured = evaluateEntitlement({ misconfigured: true });
assert.equal(misconfigured.entitled, false);
assert.equal(misconfigured.reason, 'misconfigured');
assert.notEqual(misconfigured.reason, 'ungated-preview');

const founder = evaluateEntitlement({ user: { id: 'u1', email: 'workinwithai@gmail.com' } });
assert.equal(founder.entitled, true);
assert.equal(founder.product, 'bundle');
assert.equal(founder.reason, 'ok');

const unpaid = evaluateEntitlement({ user: { id: 'u2', email: 'artist@example.com' } });
assert.equal(unpaid.entitled, false);
assert.equal(unpaid.reason, 'signed-in-unpaid');

const mixRow = evaluateEntitlement({
  user: { id: 'u3', email: 'buyer@example.com' },
  rows: [{ product: 'mix', status: 'active' }],
});
assert.equal(mixRow.entitled, true);
assert.equal(mixRow.product, 'mix');

const bundleWins = evaluateEntitlement({
  user: { id: 'u4', email: 'pass@example.com' },
  rows: [
    { product: 'mix', status: 'active' },
    { product: 'bundle', status: 'active' },
  ],
});
assert.equal(bundleWins.product, 'bundle');

const expired = evaluateEntitlement({
  user: { id: 'u5', email: 'old@example.com' },
  rows: [{ product: 'mix', status: 'active', expires_at: '2020-01-01T00:00:00.000Z' }],
});
assert.equal(expired.entitled, false);
assert.equal(expired.reason, 'expired');

const pickedExpired = pickEntitlement([
  { product: 'mix', status: 'active', expires_at: '2020-01-01T00:00:00.000Z' },
]);
assert.equal(pickedExpired.product, null);
assert.equal(pickedExpired.expired, true);

const secret = 'mixforge-test-secret';
const token = signLicense({
  aud: 'mixforge',
  sub: 'u3',
  email: 'buyer@example.com',
  product: 'mix',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
}, secret);
const verified = verifyLicense(token, secret);
assert.equal(verified.product, 'mix');
assert.equal(verified.sub, 'u3');
assert.equal(verifyLicense('nope', secret), null);
assert.equal(verifyLicense(token, 'wrong-secret'), null);

const licensed = evaluateEntitlement({
  license: { product: 'mix', email: 'buyer@example.com', sub: 'u3' },
});
assert.equal(licensed.entitled, true);
assert.equal(licensed.product, 'mix');
assert.equal(licensed.reason, 'ok');

assert.equal(extractBearer({ headers: { authorization: 'Bearer abc.def' } }), 'abc.def');
assert.equal(extractLicenseToken({ headers: { 'x-mixforge-license': token } }), token);
assert.equal(extractLicenseToken({ headers: { cookie: `mixforge_license=${encodeURIComponent(token)}` } }), token);

const urls = hubUrls('https://mixforge.workinwithai.com/');
assert.equal(urls.checkoutApi, 'https://workinwithai.com/api/checkout');
assert.match(urls.loginUrl, /next=https%3A%2F%2Fmixforge\.workinwithai\.com%2F/);

console.log('entitlement-api-smoke: ok');
