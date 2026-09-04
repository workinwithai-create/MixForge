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
assert.match(indexHtml, /id="licenseBar"/);
assert.match(indexHtml, /id="licenseBuyBtn"/);
assert.match(indexHtml, /2\.6\.0/);
assert.doesNotMatch(indexHtml, /ungated-preview/);

assert.equal(pkg.version, '2.6.0');
assert.match(pkg.scripts.test, /entitlement-api-smoke/);
assert.match(pkg.scripts.test, /license-gate-smoke/);
assert.match(pkg.scripts.test, /app-hub-entitlement\.js/);

assert.match(hubSource, /workinwithai\.com\/api\/entitlements\/me/);
assert.match(hubSource, /workinwithai\.com\/api\/checkout/);
assert.match(hubSource, /mix-monthly/);
assert.match(hubSource, /forge-pass-monthly/);
assert.doesNotMatch(hubSource, /ungated-preview'\)/);

const context = vm.createContext({
  console,
  Set,
  Map,
  Object,
  Array,
  Boolean,
  String,
  JSON,
  encodeURIComponent,
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ signedIn: false, hasMix: false, hasBundle: false, reason: 'login' }) }),
  localStorage: { getItem() { return ''; }, setItem() {}, removeItem() {} },
  document: {
    readyState: 'complete',
    getElementById() { return null; },
    addEventListener() {},
  },
  location: { hostname: 'mixforge.workinwithai.com', origin: 'https://mixforge.workinwithai.com', href: 'https://mixforge.workinwithai.com/' },
  globalThis: {},
});
context.globalThis = context;
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

hub.status.entitled = true;
hub.status.hasMix = true;
hub.status.product = 'mix';
hub.status.reason = 'ok';
assert.equal(hub.requireEntitlement('export').ok, true);
assert.notEqual(hub.requireEntitlement('export').reason, 'ungated-preview');

assert.doesNotMatch(musicianSource, /reason: 'ungated-preview'/);
assert.match(musicianSource, /requireEntitlement\('quickMaster'\)/);
assert.match(musicianSource, /requireEntitlement\('forensicStems'\)/);
assert.match(exportSource, /requireEntitlement\(['"]export['"]\)/);
assert.match(masterSource, /requireEntitlement\(['"]quickMaster['"]\)/);

assert.match(readme, /MIXFORGE_LICENSE_SECRET/);
assert.match(readme, /api\/checkout/);
assert.doesNotMatch(readme, /currently ships ungated/);

console.log('license-gate-smoke: ok');
