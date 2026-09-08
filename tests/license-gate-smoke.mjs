import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const hubSource = fs.readFileSync(new URL('../js/app-hub-entitlement.js', import.meta.url), 'utf8');
const musicianSource = fs.readFileSync(new URL('../js/app-musician-ux.js', import.meta.url), 'utf8');
const exportSource = fs.readFileSync(new URL('../js/app-export.js', import.meta.url), 'utf8');
const masterSource = fs.readFileSync(new URL('../js/app-master.js', import.meta.url), 'utf8');
const indexHtml = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

assert.match(indexHtml, /app-hub-entitlement\.js/);
assert.match(indexHtml, /app-sequential-mixing\.js/);
assert.match(indexHtml, /app-mobile-onboard\.js/);
assert.match(indexHtml, /id="licenseBar"/);
assert.match(indexHtml, /id="licenseBuyBtn"/);
assert.match(indexHtml, /2\.6\.0/);
assert.equal(pkg.version, '2.6.0');
assert.match(pkg.scripts.test, /entitlement-api-smoke/);
assert.match(pkg.scripts.test, /license-gate-smoke/);
assert.match(pkg.scripts.test, /mobile-onboard-smoke/);

assert.match(hubSource, /https:\/\/workinwithai\.com\/api\/entitlements\/me/);
assert.match(hubSource, /https:\/\/workinwithai\.com\/api\/checkout/);
assert.match(hubSource, /MixForgeHubClient/);
assert.match(hubSource, /mix-monthly/);
assert.match(hubSource, /forge-pass-monthly/);
assert.match(exportSource, /requireEntitlement\(['"]export['"]\)/);
assert.match(masterSource, /requireEntitlement\(['"]quickMaster['"]\)/);

const context = vm.createContext({
  console,
  Math,
  Number,
  Object,
  Array,
  Set,
  Map,
  Promise,
  Boolean,
  String,
  JSON,
  encodeURIComponent,
  clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ signedIn: false, hasMix: false, hasBundle: false, reason: 'login' }) }),
  localStorage: { getItem() { return ''; }, setItem() {}, removeItem() {} },
  location: { hostname: 'mixforge.workinwithai.com', origin: 'https://mixforge.workinwithai.com', href: 'https://mixforge.workinwithai.com/' },
  globalThis: {},
});
context.globalThis = context;

// The real browser loads musician UX first, then the Hub client. This must not
// throw a duplicate-const SyntaxError, and the legacy closed-over gate must be
// replaced by the fail-closed real client.
vm.runInContext(musicianSource, context);
vm.runInContext(hubSource, context);

const hub = context.MixForgeHub;
assert.equal(typeof hub.requireEntitlement, 'function');
hub.status = {
  entitled: false,
  signedIn: false,
  hasMix: false,
  hasBundle: false,
  reason: 'login',
  loginUrl: 'https://workinwithai.com/login?next=https://mixforge.workinwithai.com/',
  checkoutUrl: 'https://workinwithai.com/#pricing',
};
for (const feature of ['quickMaster', 'forensicStems', 'export']) {
  const gate = hub.requireEntitlement(feature);
  assert.equal(gate.ok, false, `${feature} must be gated when unpaid`);
  assert.notEqual(gate.reason, 'ungated-preview');
  assert.ok(gate.redirectUrl);
}
assert.equal(hub.requireEntitlement('stereoAudit').ok, true);

const legacyQuick = vm.runInContext("MixForgeHub.requireEntitlement('quickMaster')", context);
assert.equal(legacyQuick.ok, false, 'musician UX closed-over gate must delegate to the real Hub client');
assert.notEqual(legacyQuick.reason, 'ungated-preview');

hub.status.entitled = true;
hub.status.hasMix = true;
hub.status.product = 'mix';
hub.status.reason = 'ok';
assert.equal(hub.requireEntitlement('export').ok, true);
const legacyPaid = vm.runInContext("MixForgeHub.requireEntitlement('quickMaster')", context);
assert.equal(legacyPaid.ok, true, 'paid musician path should unlock after Hub entitlement');

assert.match(readme, /MIXFORGE_LICENSE_SECRET/);
assert.match(readme, /api\/checkout/);
assert.doesNotMatch(readme, /currently ships ungated/);

console.log('license-gate-smoke: ok');
