# MixForge

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
- `GEMINI_MODEL` (optional; defaults to `gemini-3.6-flash`)
- `ANTHROPIC_API_KEY` — optional; used only for stem-plan text after isolation
- `ANTHROPIC_MODEL` (optional; defaults to `claude-sonnet-4-6`)

`GET /api/analyze` reports `{ listeningConfigured: true|false }` without exposing the key. If the env var is missing, the client skips the excerpt upload and says: “Listening model not configured — using measurements only.” Claude is not used to restate numbers it cannot hear.

### Supabase Edge Function (`separate-stem`)
- `RUNPOD_ENDPOINT_ID`
- `RUNPOD_API_KEY`
- Supabase-provided `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_ANON_KEY`

Stem-separation quota: 12 stems/hour and 30/day.

Music.ai is retired for this path and must not be configured as a fallback.

## Experimental semantic source diagnosis

The `feature/sam-audio-prove-first` branch contains an off-by-default SAM-Audio-compatible diagnostic path. It does not change Quick Master, Forensic Fix, Demucs separation, export, or any existing sync flow.

- Enable a local or preview URL with `?semanticSeparation=1`.
- Exercise graceful fallback without credentials with `?semanticSeparation=1&semanticMock=reject` or `semanticMock=fail`.
- The browser sends at most a 12-second stereo WAV excerpt. The API refuses mono and longer or whole-song diagnostic requests.
- A source stays **Unconfirmed** unless target + residual reconstruct the excerpt, stereo is preserved, the target has plausible energy, and the measured symptom concentrates in the target.
- Source-aware repair stays locked until confirmation. Existing bounded stereo repair and Demucs standard stems remain independent fallbacks.
- The future full-song sync render is architecture only and disabled. It requires two matching confirmed spot checks before review, followed later by full-song reconstruction, bleed/artifact QC, and human approval.

Actual SAM-Audio inference is not bundled here. A preview deployment needs `SAM_AUDIO_ENDPOINT` and `SAM_AUDIO_API_KEY`; the endpoint must return stereo WAV `target` and `residual` payloads. Without those variables, the route returns a fast 503 and the app keeps working normally.

## Storage

The app uploads unreleased mixes to the private `audio` bucket. The Edge Function creates a short-lived signed URL for the RunPod separator and deletes the source upload after the separation job completes.

## Not shipped until

Do not call MixForge shipped until complete source is on GitHub, production at https://mixforge.workinwithai.com works, Hub checkout creates a Stripe session and writes an entitlement, WAV export is license-gated and tested, and mobile onboarding is verified on an iPhone.
