import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const onboardJs = readFileSync(new URL('../js/app-mobile-onboard.js', import.meta.url), 'utf8');
const entitlementJs = readFileSync(new URL('../js/app-hub-entitlement.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../musician-ux.css', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../site.webmanifest', import.meta.url), 'utf8'));
const docs = readFileSync(new URL('../docs/mobile-onboarding.md', import.meta.url), 'utf8');

assert.match(indexHtml, /site\.webmanifest/, 'index must link the PWA manifest');
assert.match(indexHtml, /apple-mobile-web-app-capable/, 'index must declare iOS standalone mode');
assert.match(indexHtml, /app-mobile-onboard\.js/, 'index must load mobile onboarding');
assert.match(indexHtml, /accept="audio\/\*,\.wav,\.mp3,\.m4a/, 'file input must accept phone audio types');
assert.match(indexHtml, /viewport-fit=cover/, 'viewport must cover the iPhone safe area');

assert.match(onboardJs, /Download Now/, 'iOS iCloud Download Now hint is required');
assert.match(onboardJs, /Quick Master/, 'coach must mention Quick Master');
assert.match(onboardJs, /Forensic Fix/, 'coach must mention Forensic Fix');
assert.match(onboardJs, /mixforge-mobile-onboard-v1/, 'first-run dismissal key must be stable');
assert.match(onboardJs, /Choose a mix/, 'coach CTA must start the file picker');
assert.match(onboardJs, /MF_ONBOARD_HUB_ORIGIN/, 'onboard must use a private Hub origin name');
assert.doesNotMatch(onboardJs, /^const MF_HUB_ORIGIN/m, 'onboard must not declare global MF_HUB_ORIGIN');
assert.match(entitlementJs, /mixForgeHubEntitlementIIFE/, 'entitlement constants must stay inside an IIFE');
assert.match(onboardJs, /in-app browser/i, 'coach must warn that in-app browsers do not share Safari Hub login');

assert.match(css, /mobile-onboard/, 'onboarding sheet styles must exist');
assert.match(css, /min-height:\s*44px/, 'primary phone actions need 44px touch targets');

assert.equal(manifest.display, 'standalone');
assert.equal(manifest.start_url, '/');
assert.ok(manifest.icons?.length >= 1, 'manifest needs at least one icon');

assert.match(docs, /Download Now/);
assert.match(docs, /mixforge\.workinwithai\.com/);

console.log('mobile-onboard-smoke: ok');
