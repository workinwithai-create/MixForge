'use strict';

(() => {
  const HUB = 'https://workinwithai.com';
  const MIX = 'https://mixforge.workinwithai.com';
  const PRODUCT_TOKEN_URL = `${HUB}/api/product-token?product=mix`;
  const ENTITLEMENTS_URL = `${HUB}/api/entitlements/me`;
  const PROTECTED_URL_PARTS = ['/api/analyze', '/functions/v1/separate-stem'];

  document.documentElement.classList.add('wwa-gate-pending');

  const style = document.createElement('style');
  style.textContent = `
    html.wwa-gate-pending body > main { visibility: hidden !important; }
    #wwaGate { position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center; padding: 22px; background: rgba(8,10,12,.98); color: #f5f7f8; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    #wwaGate .wwa-card { width: min(720px, 100%); border: 1px solid rgba(255,255,255,.13); border-radius: 24px; padding: clamp(24px,5vw,44px); background: #101318; box-shadow: 0 28px 90px rgba(0,0,0,.45); }
    #wwaGate .wwa-kicker { color: #74e0c2; text-transform: uppercase; letter-spacing: .18em; font-size: 12px; font-weight: 800; }
    #wwaGate h1 { margin: 10px 0 12px; font-size: clamp(32px,7vw,52px); line-height: 1; letter-spacing: -.04em; }
    #wwaGate p { color: #aeb8c2; line-height: 1.65; margin: 0; }
    #wwaGate .wwa-actions { display: grid; gap: 12px; margin-top: 26px; }
    #wwaGate button, #wwaGate a.wwa-button { appearance: none; border: 1px solid rgba(255,255,255,.14); border-radius: 14px; padding: 15px 18px; background: #1a2027; color: #fff; font: inherit; font-weight: 800; cursor: pointer; text-align: center; text-decoration: none; }
    #wwaGate button.wwa-primary, #wwaGate a.wwa-primary { background: #74e0c2; color: #06110e; border-color: transparent; }
    #wwaGate .wwa-plans { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 14px; margin-top: 26px; }
    #wwaGate .wwa-plan { border: 1px solid rgba(255,255,255,.1); border-radius: 18px; padding: 20px; background: rgba(255,255,255,.025); }
    #wwaGate .wwa-price { font-size: 32px; font-weight: 900; margin: 7px 0; }
    #wwaGate .wwa-price span { font-size: 13px; color: #8f9aa5; font-weight: 600; }
    #wwaGate .wwa-error { margin-top: 16px; color: #ffb4b4; font-size: 14px; }
    @media (max-width: 620px) { #wwaGate .wwa-plans { grid-template-columns: 1fr; } }
  `;
  document.head.appendChild(style);

  let gate;
  let token = null;
  let fetchWrapped = false;

  function isProtectedUrl(url) {
    return PROTECTED_URL_PARTS.some((part) => url.includes(part));
  }

  function installProtectedFetch() {
    if (fetchWrapped) return;
    fetchWrapped = true;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = function wwaProtectedFetch(input, init = {}) {
      const url = typeof input === 'string' || input instanceof URL
        ? String(input)
        : String(input?.url || '');
      if (!isProtectedUrl(url)) return nativeFetch(input, init);

      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init.headers || {}).forEach((value, key) => headers.set(key, value));
      if (token) headers.set('x-wwa-token', token);
      return nativeFetch(input, { ...init, headers });
    };
  }

  function ensureGate() {
    if (gate) return gate;
    gate = document.createElement('div');
    gate.id = 'wwaGate';
    document.body.appendChild(gate);
    return gate;
  }

  function card(inner) {
    ensureGate().innerHTML = `<section class="wwa-card">${inner}</section>`;
  }

  function showLogin() {
    const next = encodeURIComponent(MIX);
    card(`
      <div class="wwa-kicker">WorkinWithAI · MixForge</div>
      <h1>One account for the whole suite.</h1>
      <p>Sign in with your WorkinWithAI account to use MixForge. If MixForge is not on your plan yet, you’ll see the membership options next.</p>
      <div class="wwa-actions">
        <a class="wwa-button wwa-primary" href="${HUB}/login?next=${next}">Sign in with WorkinWithAI</a>
        <a class="wwa-button" href="${HUB}">Back to WorkinWithAI</a>
      </div>
    `);
  }

  async function checkout(lookupKey) {
    const buttons = gate?.querySelectorAll('button');
    buttons?.forEach((button) => { button.disabled = true; });
    const errorEl = gate?.querySelector('.wwa-error');
    if (errorEl) errorEl.textContent = '';
    try {
      const response = await fetch(`${HUB}/api/checkout`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lookupKey, returnTo: MIX }),
      });
      if (response.status === 401) {
        location.href = `${HUB}/login?next=${encodeURIComponent(MIX)}`;
        return;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.url) throw new Error(data.error || 'Checkout could not start.');
      location.href = data.url;
    } catch (error) {
      if (errorEl) errorEl.textContent = error?.message || 'Checkout could not start.';
      buttons?.forEach((button) => { button.disabled = false; });
    }
  }

  function showSubscribe() {
    card(`
      <div class="wwa-kicker">WorkinWithAI · MixForge membership</div>
      <h1>You’re signed in. Pick your access.</h1>
      <p>Your WorkinWithAI account is recognized here. MixForge is the paid part—not a second login.</p>
      <div class="wwa-plans">
        <article class="wwa-plan">
          <strong>MixForge</strong>
          <div class="wwa-price">$9 <span>/ month</span></div>
          <p>Full MixForge mix repair, AI listening, source investigation and mastering workflow.</p>
          <div class="wwa-actions"><button class="wwa-primary" data-plan="mix-monthly">Get MixForge</button></div>
        </article>
        <article class="wwa-plan">
          <strong>Forge Pass</strong>
          <div class="wwa-price">$24 <span>/ month</span></div>
          <p>MixForge plus LRC Forge, Release Forge and AuraMix under the same account.</p>
          <div class="wwa-actions"><button data-plan="forge-pass-monthly">Get Forge Pass</button></div>
        </article>
      </div>
      <div class="wwa-error" aria-live="polite"></div>
    `);
    gate.querySelectorAll('[data-plan]').forEach((button) => {
      button.addEventListener('click', () => checkout(button.dataset.plan));
    });
  }

  function showUnavailable(message = 'The WorkinWithAI access check could not be reached.') {
    card(`
      <div class="wwa-kicker">WorkinWithAI · MixForge</div>
      <h1>Access check unavailable.</h1>
      <p>${message}</p>
      <div class="wwa-actions">
        <button class="wwa-primary" id="wwaRetry">Try again</button>
        <a class="wwa-button" href="${HUB}">Open WorkinWithAI</a>
      </div>
    `);
    gate.querySelector('#wwaRetry')?.addEventListener('click', () => resolveAccess(true));
  }

  function unlock() {
    installProtectedFetch();
    gate?.remove();
    gate = null;
    document.documentElement.classList.remove('wwa-gate-pending');
  }

  async function fallbackEntitlements() {
    const response = await fetch(ENTITLEMENTS_URL, { credentials: 'include', cache: 'no-store' });
    if (!response.ok) return { kind: 'unavailable' };
    const data = await response.json().catch(() => ({}));
    if (!data.signedIn) return { kind: 'login' };
    if (!data.hasMix) return { kind: 'subscribe' };
    return { kind: 'access-without-token' };
  }

  async function accessAttempt() {
    const response = await fetch(PRODUCT_TOKEN_URL, { credentials: 'include', cache: 'no-store' });
    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      if (!data.accessToken) return { kind: 'unavailable' };
      token = data.accessToken;
      return { kind: 'access' };
    }
    if (response.status === 401) return { kind: 'login' };
    if (response.status === 402) return { kind: 'subscribe' };
    if (response.status === 404) return fallbackEntitlements();
    return { kind: 'unavailable' };
  }

  async function resolveAccess(force = false) {
    if (force) token = null;
    ensureGate();
    card(`
      <div class="wwa-kicker">WorkinWithAI · MixForge</div>
      <h1>Checking your access…</h1>
      <p>Using your WorkinWithAI account and product membership.</p>
    `);

    try {
      const purchased = new URLSearchParams(location.search).get('purchased') === '1';
      const attempts = purchased ? 4 : 1;
      let result = { kind: 'unavailable' };
      for (let i = 0; i < attempts; i++) {
        result = await accessAttempt();
        if (result.kind !== 'subscribe' || !purchased || i === attempts - 1) break;
        await new Promise((resolve) => setTimeout(resolve, 900));
      }

      if (result.kind === 'access') return unlock();
      if (result.kind === 'access-without-token') {
        return showUnavailable('Your membership is active, but the secure product token is not live yet. Try again after the WorkinWithAI update finishes deploying.');
      }
      if (result.kind === 'login') return showLogin();
      if (result.kind === 'subscribe') return showSubscribe();
      return showUnavailable();
    } catch (error) {
      console.error('MixForge WorkinWithAI gate error:', error);
      return showUnavailable('MixForge could not verify your WorkinWithAI session.');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => resolveAccess(), { once: true });
  } else {
    resolveAccess();
  }
})();
