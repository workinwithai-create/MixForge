'use strict';

// MixForge 2.6 musician UX layer.
// Dual-path productization: Quick Master (stereo release master) vs Forensic Fix
// (opt-in stem investigation). Billing and license delivery live in
// js/app-hub-entitlement.js — this file must never assign an ungated stub.

const MF_DEMUCS_STEMS = new Set(['vocals', 'bass', 'drums', 'other']);
const MF_STEM_ALIASES = { guitars: 'other', keys: 'other' };
const MF_STEM_HOURLY_LIMIT = 12;
const MF_STEM_DAILY_LIMIT = 30;
const MF_AURAMIX_URL = 'https://auramix.workinwithai.com';
const MF_STEM_DISPLAY = {
  vocals: 'Vocals',
  bass: 'Bass',
  drums: 'Drums',
  other: 'Other residual (guitars / keys / ambience)',
  guitars: 'Other residual (requested as guitars)',
  keys: 'Other residual (requested as keys)',
};

const MF_HUB_PRICING = 'https://workinwithai.com/#pricing';
const MF_HUB_LOGIN = 'https://workinwithai.com/login?next=https://mixforge.workinwithai.com/';

function mfHubGate(feature) {
  const live = (typeof globalThis !== 'undefined' && globalThis.MixForgeHub) || null;
  if (live && typeof live.requireEntitlement === 'function' && live.requireEntitlement !== mfHubGate) {
    return live.requireEntitlement(feature);
  }
  const name = String(feature || '');
  if (!name || name === 'stereoAudit') {
    return { ok: true, feature: name, reason: 'ok', redirectUrl: null };
  }
  return {
    ok: false,
    feature: name,
    reason: 'login',
    redirectUrl: MF_HUB_PRICING,
    loginUrl: MF_HUB_LOGIN,
    checkoutUrl: MF_HUB_PRICING,
  };
}

const MixForgeHub = {
  product: 'mixforge',
  pricing: { mixforgeMonthly: 9, forgePassMonthly: 24 },
  features: { quickMaster: false, forensicStems: false, export: false, stereoAudit: true },
  requireEntitlement: mfHubGate,
};
