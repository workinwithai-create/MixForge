'use strict';

// MixForge mobile onboarding. Uses the existing #mobileOnboard mount when present.
// Stereo scan is free; paid mastering/export go through Hub checkout on this phone.
const MF_ONBOARD_KEY = 'mixforge-mobile-onboard-v1';
const MF_ONBOARD_HUB_ORIGIN = 'https://workinwithai.com';
const MF_HUB_PRICING = `${MF_ONBOARD_HUB_ORIGIN}/#pricing`;
const MF_RETURN_TO = 'https://mixforge.workinwithai.com/';
const MF_IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const MF_IS_MOBILE = MF_IS_IOS || window.matchMedia('(max-width: 660px)').matches || navigator.maxTouchPoints > 1;
const MF_IN_APP_BROWSER = /FBAN|FBAV|Instagram|Twitter|Grok|Line\/|MicroMessenger|Snapchat|TikTok|Pinterest|LinkedInApp|EdgA|CriOS|FxiOS|GSA\//i.test(navigator.userAgent) && MF_IS_IOS;
const MF_IS_SAFARI = MF_IS_IOS && /Safari/i.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//i.test(navigator.userAgent) && !MF_IN_APP_BROWSER;

function mfOnboardDismissed() {
  try { return localStorage.getItem(MF_ONBOARD_KEY) === 'done'; } catch (_) { return false; }
}

function mfMarkOnboardDone() {
  try { localStorage.setItem(MF_ONBOARD_KEY, 'done'); } catch (_) {}
}

function mfPurchaseReturn() {
  try {
    const params = new URLSearchParams(globalThis.location?.search || '');
    return params.get('purchased') === '1' || params.get('buy') === '1' || params.get('buy') === 'mix-monthly';
  } catch (_) {
    return false;
  }
}

function mfHubLoginUrl() {
  return `${MF_ONBOARD_HUB_ORIGIN}/login?next=${encodeURIComponent(MF_RETURN_TO)}&checkout=mix-monthly&buy=mix-monthly`;
}

function mfStartMobileCheckout() {
  if (MF_IN_APP_BROWSER) {
    mfWarnOpenSafari();
    return Promise.resolve({ ok: false, reason: 'in-app-browser' });
  }
  const hub = globalThis.MixForgeHub;
  if (hub && typeof hub.startCheckout === 'function') {
    return hub.startCheckout('mix-monthly');
  }
  if (globalThis.location) globalThis.location.href = mfHubLoginUrl();
  return Promise.resolve({ ok: false, reason: 'login' });
}

function mfWarnOpenSafari() {
  const hint = document.getElementById('mobileFileHint');
  if (hint) {
    hint.hidden = false;
    hint.textContent = 'This is an in-app browser. Hub login and Stripe checkout live in Safari cookies. Tap Share → Open in Safari, then sign in there.';
  }
}

function mfEnsureMobileHint() {
  const dropzone = document.getElementById('dropzone');
  if (!dropzone) return;
  let hint = document.getElementById('mobileFileHint');
  if (!hint) {
    hint = document.createElement('p');
    hint.id = 'mobileFileHint';
    hint.className = 'mobile-file-hint';
    dropzone.insertAdjacentElement('afterend', hint);
  }
  hint.hidden = false;
  if (MF_IN_APP_BROWSER) {
    hint.textContent = 'In-app browsers (Grok, Instagram, Mail) do not share Safari Hub login. Open this page in Safari before signing in or buying.';
    return;
  }
  hint.textContent = MF_IS_IOS
    ? 'On iPhone: open Files, tap and hold the song, choose Download Now if it is only in iCloud, then pick it here. WAV, AIFF, M4A, or MP3. Add to Home Screen: Share → Add to Home Screen.'
    : 'On a phone: pick a local WAV, AIFF, M4A, or MP3. Cloud-only files will fail until they finish downloading.';
}

function mfBuildOnboardSheet() {
  let sheet = document.getElementById('mobileOnboard');
  if (!sheet) {
    sheet = document.createElement('aside');
    sheet.id = 'mobileOnboard';
    sheet.className = 'mobile-onboard';
    document.querySelector('.hero')?.insertAdjacentElement('afterend', sheet);
  }
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-labelledby', 'mobileOnboardTitle');
  const purchased = mfPurchaseReturn();
  const safariNote = MF_IN_APP_BROWSER
    ? 'You are not in Safari. Open MixForge in Safari before Sign in or Get MixForge license — in-app browsers such as Grok do not share the Hub login from Safari.'
    : purchased
      ? 'Stripe returned purchased=1. The license bar refreshes the Hub entitlement and stores the MixForge license before WAV export unlocks.'
      : 'A license is not stored on the phone. Sign in on <em>this</em> browser (Safari, not an in-app browser), then tap <strong>Get MixForge license</strong> ($9/mo or Forge Pass $24/mo). In-app browsers such as Grok do not share the Hub login from Safari.';
  sheet.innerHTML = `
    <div class="mobile-onboard-card">
      <p class="mobile-onboard-kicker">${purchased ? 'License returning' : (MF_IN_APP_BROWSER ? 'Open in Safari first' : 'First open on this phone')}</p>
      <h2 id="mobileOnboardTitle">${purchased ? 'Unlocking MixForge on this phone' : 'Load a mix, then hear a master'}</h2>
      <ol class="mobile-onboard-steps">
        <li>Tap <strong>Choose a mix</strong>. On iPhone, use <strong>Download Now</strong> first if the file is only in iCloud.</li>
        <li>Scan the stereo mix for free. Pick <strong>Quick Master</strong> for an Original vs Master A/B, or <strong>Forensic Fix</strong> when isolation is actually needed.</li>
        <li>${safariNote}</li>
        <li>After a master renders, <strong>Download release WAV</strong> stays on screen without sideways scroll. To pin MixForge: Safari Share → <strong>Add to Home Screen</strong>.</li>
      </ol>
      <p class="mobile-onboard-note">MixForge measures change; it does not claim the mix sounds better. Vocal performance lives in AuraMix. Physical iPhone sign-off is still required before calling MixForge shipped.</p>
      <div class="mobile-onboard-actions">
        <button type="button" class="primary" id="mobileOnboardStart">Choose a mix</button>
        <button type="button" class="secondary" id="mobileOnboardLicense">Get MixForge license</button>
        <a class="secondary mobile-onboard-hub" href="${MF_HUB_PRICING}">Hub pricing</a>
        <button type="button" class="secondary" id="mobileOnboardDismiss">Got it</button>
      </div>
    </div>`;
  return sheet;
}

function mfCloseOnboard(sheet) {
  sheet.hidden = true;
  sheet.classList.remove('open');
  mfMarkOnboardDone();
}

function mfOpenOnboard() {
  if (!MF_IS_MOBILE) return;
  if (mfOnboardDismissed() && !mfPurchaseReturn() && !MF_IN_APP_BROWSER) return;
  const sheet = mfBuildOnboardSheet();
  sheet.hidden = false;
  sheet.classList.add('open');
  const start = document.getElementById('mobileOnboardStart');
  const license = document.getElementById('mobileOnboardLicense');
  const dismiss = document.getElementById('mobileOnboardDismiss');
  const dropzone = document.getElementById('dropzone');
  start?.addEventListener('click', () => {
    mfCloseOnboard(sheet);
    dropzone?.click();
  }, { once: true });
  license?.addEventListener('click', () => {
    void mfStartMobileCheckout();
  });
  dismiss?.addEventListener('click', () => mfCloseOnboard(sheet), { once: true });
}

function mfInstallMobileOnboard() {
  if (!MF_IS_MOBILE) return;
  mfEnsureMobileHint();
  mfOpenOnboard();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mfInstallMobileOnboard);
  else mfInstallMobileOnboard();
}

if (typeof globalThis !== 'undefined') {
  globalThis.MixForgeMobileOnboard = {
    key: MF_ONBOARD_KEY,
    isIos: MF_IS_IOS,
    isSafari: MF_IS_SAFARI,
    inAppBrowser: MF_IN_APP_BROWSER,
    startCheckout: mfStartMobileCheckout,
    purchaseReturn: mfPurchaseReturn,
    install: mfInstallMobileOnboard,
  };
}
