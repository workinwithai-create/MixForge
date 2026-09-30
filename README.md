# MixForge

## v2.6.4 — Pipe Dreams single-sign-on race fix (2026-09-30)

When embedded in Pipe Dreams Studio, a verified Warehouse session is now treated as trusted client state and cannot be overwritten by a later anonymous startup refresh. MixForge also requests the Studio session after its auth listener is installed, closing the iframe listener-timing gap. Standalone login remains separate from checkout.

MixForge is a browser forensic release-prep pipeline — not a one-click loudness clone.

LANDR, eMastered, BandLab Mastering, CloudBounce, and RoEx win on making a file louder in one click. MixForge wins on evidence: measure → locate problem windows → optional honest stem repair → conservative master → show measured change. It does not claim musical improvement.

1. Audit a stereo mix. Measurements are ground truth for clip %, LUFS, sample peak, correlation, and DC.
2. Optional Gemini listening pass hears a compact mix excerpt (not a vocal performance take). Performance / pitch / timing lives in [AuraMix](https://auramix.workinwithai.com).
3. Choose **Quick Master** (stereo release master + Original vs Master A/B) or **Forensic Fix** (timeline + opt-in stems + targeted repair). Quick Master skips Isolate / Confirm / Repair.
4. Separate only the stems needed (Demucs via RunPod: vocals / bass / drums / other). Guitars and keys are not confirmable stems — they share residual other.
5. Measure and repair affected stems conservatively.
6. Rebuild the original mix with the corrected stem deltas.
7. Master the corrected mix conservatively. Reference-bounded tonal language is used only when a reference file is loaded.
8. Verify loudness, peak safety, clipping, dynamics, and mono compatibility.
9. Export a 24-bit or 16-bit WAV. Stale masters cannot export. Clipping or true-peak over ceiling blocks export unless you explicitly override.

Thesis: evidence-first, conservative repairs, show measured change (loudness, peak, remaining risks). MixForge is mix repair + release master; dedicated vocal production lives in AuraMix.

## License and checkout

Stereo audit stays free. Quick Master, Forensic Fix, and WAV export require an active MixForge (`mix`) or Forge Pass (`bundle`) entitlement.

- Live Hub checkout: `POST https://workinwithai.com/api/checkout` with `{ lookupKey, returnTo }`.
  - MixForge monthly lookup key: `mix-monthly` ($9)
  - Forge Pass lookup key: `forge-pass-monthly` ($24)
  - `returnTo` must be first-party (`https://mixforge.workinwithai.com/`)
- Live Hub identity: `GET https://workinwithai.com/api/entitlements/me` returns `{ signedIn, hasMix, hasBundle, reason, loginUrl, checkoutLookupKeys }`.
- Local license issuer: `GET /api/entitlement` signs a 12-hour MixForge license when `MIXFORGE_LICENSE_SECRET` is set.
- The client never treats `ungated-preview` as entitled.

### Extra Vercel env for billing
- `MIXFORGE_LICENSE_SECRET` — HMAC secret for local license tokens (Production and Preview)
- `HUB_SUPABASE_ANON_KEY` — Hub identity project anon key (`kldstbhnpwpvvubphnas`)
- `HUB_SUPABASE_URL` (optional; defaults to the Hub identity project)
- `MIXFORGE_ADMIN_EMAILS` (optional comma list in addition to founder addresses)

## Required environment variables

### Vercel
- `GEMINI_API_KEY` — native-audio listening pass on the stereo mix audit. The API route reads **only** `process.env.GEMINI_API_KEY`. Set it on the Vercel mix-forge project for **Production and Preview**. No key is shipped in the client or repo.
- `GEMINI_MODEL` (optional; defaults to `gemini-3.8-flash`)
- `ANTHROPIC_API_KEY` — optional; used only for stem-plan text after isolation
- `ANTHROPIC_MODEL` (optional; defaults to `claude-sonnet-5`)

`GET /api/analyze` reports `{ listeningConfigured: true|false }` without exposing the key. If the env var is missing, the client skips the excerpt upload and says: “Listening model not configured — using measurements only.” Claude is not used to restate numbers it cannot hear.

### Supabase Edge Function (`separate-stem`)
- `RUNPOD_ENDPOINT_ID`
- `RUNPOD_API_KEY`
- Supabase-provided `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_ANON_KEY`

Stem-separation quota: 12 stems/hour and 30/day.

Music.ai is retired for this path and must not be configured as a fallback.

## Storage

The app uploads unreleased mixes to the private `audio` bucket. The Edge Function creates a short-lived signed URL for the RunPod separator and deletes the source upload after the separation job completes.

## Production readiness (2026-09-30)

Criteria for calling MixForge shipped (all must be true):

| Criterion | Status | Evidence |
| --- | --- | --- |
| Complete source on GitHub | **Met** | Public repo `workinwithai-create/MixForge`, full tree including `api/`, `js/`, `supabase/`, `tests/`, RunPod separator |
| Permanent live deployment works | **Met** | https://mixforge.workinwithai.com returns the live shell; Vercel project `mix-forge`; re-checked 2026-09-30 |
| Real checkout and license delivery connected | **Met** | Hub `POST /api/checkout` + `GET /api/entitlements/me` (anonymous JSON with `mix-monthly` lookup key re-checked 2026-09-30); MixForge `/api/entitlement` signs 12 h HMAC licenses; founder override + Supabase entitlement rows; license bar + mobile checkout paths live |
| Core exports tested | **Met** | `tests/export-state-smoke.mjs`, `tests/license-gate-smoke.mjs`, `tests/mastering-grade-smoke.mjs` and related smoke suite; export blocked when unlicensed or stale |
| Mobile onboarding verified | **Partial** | Coach + in-app-browser Safari warning + A2HS copy + `docs/mobile-onboarding.md` + `docs/iphone-signoff.md` + `tests/mobile-onboard-smoke.mjs`. Real-device sign-off on a physical iPhone is still required |

**Next production-ready milestone:** Fill `docs/iphone-signoff.md` on a physical iPhone (Safari, Files Download Now, free scan, licensed WAV download, Add to Home Screen). Until that human verification is logged, do not call MixForge shipped.

Do not invent additional gating criteria. When the iPhone checklist is signed off, remove the Partial row and the “Not shipped until” language permanently.
