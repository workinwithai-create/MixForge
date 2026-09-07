'use strict';

// MixForge mobile onboarding. Uses the existing #mobileOnboard mount when present.
// Stereo scan is free; paid mastering/export are explained without blocking file selection.
const MF_ONBOARD_KEY = 'mixforge-mobile-onboard-v1';
const MF_HUB_PRICING = 'https://workinwithai.com/#pricing';
const MF_IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const MF_IS_MOBILE = MF_IS_IOS || window.matchMedia('(max-width: 660px)').matches || navigator.maxTouchPoints > 1;

function mfOnboardDismissed() {
  try { return localStorage.getItem(MF_ONBOARD_KEY) === 'done'; } catch (_) { return false; }
}

function mfMarkOnboardDone() {
  try { localStorage.setItem(MF_ONBOARD_KEY, 'done'); } catch (_) {}
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
  hint.textContent = MF_IS_IOS
    ? 'On iPhone: open Files, tap and hold the song, choose Download Now if it is only in iCloud, then pick it here. WAV, AIFF, M4A, or MP3.'
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
  sheet.innerHTML = `
    <div class="mobile-onboard-card">
      <p class="mobile-onboard-kicker">First open on this phone</p>
      <h2 id="mobileOnboardTitle">Load a mix, then hear a master</h2>
      <ol class="mobile-onboard-steps">
        <li>Tap <strong>Choose a mix</strong>. On iPhone, use <strong>Download Now</strong> first if the file is only in iCloud.</li>
        <li>Scan the stereo mix for free. Pick <strong>Quick Master</strong> for an Original vs Master A/B, or <strong>Forensic Fix</strong> when isolation is actually needed.</li>
        <li>Sign in on this phone before rendering or downloading the release WAV.</li>
      </ol>
      <p class="mobile-onboard-note">MixForge measures change; it does not claim the mix sounds better. Vocal performance lives in AuraMix.</p>
      <div class="mobile-onboard-actions">
        <button type="button" class="primary" id="mobileOnboardStart">Choose a mix</button>
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
  if (!MF_IS_MOBILE || mfOnboardDismissed()) return;
  const sheet = mfBuildOnboardSheet();
  sheet.hidden = false;
  sheet.classList.add('open');
  const start = document.getElementById('mobileOnboardStart');
  const dismiss = document.getElementById('mobileOnboardDismiss');
  const dropzone = document.getElementById('dropzone');
  start?.addEventListener('click', () => {
    mfCloseOnboard(sheet);
    dropzone?.click();
  }, { once: true });
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
    install: mfInstallMobileOnboard,
  };
}
