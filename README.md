# MixForge

MixForge is a browser forensic release-prep pipeline — not a one-click loudness clone.

LANDR, eMastered, BandLab Mastering, CloudBounce, and RoEx win on making a file louder in one click. MixForge wins on evidence: measure → locate problem windows → optional honest stem repair → conservative master → show measured change. It does not claim musical improvement.

1. Audit a stereo mix. Measurements are ground truth for clip %, LUFS, sample peak, correlation, and DC.
2. Optional Gemini Producer's Ear pass hears a compact reel of representative and problem sections (not a vocal performance take). It leads with specific strengths, an honest overall take, 1–3 plain-language fixes, and the musical quality worth protecting. Performance / pitch / timing lives in [AuraMix](https://auramix.workinwithai.com).
3. The producer review can be spoken aloud with the same Gemini producer voice pattern used by Release Forge. Engineer measurements and forensic evidence stay available in a collapsed details drawer.
4. Choose **Quick Master** (stereo release master + Original vs Master A/B) or **Forensic Fix** (timeline + opt-in stems + targeted repair). Quick Master skips Isolate / Confirm / Repair.
5. Separate only the stems needed (Demucs via RunPod: vocals / bass / drums / other). Guitars and keys are not confirmable stems — they share residual other.
6. Measure and repair affected stems conservatively.
7. Rebuild the original mix with the corrected stem deltas.
8. Master the corrected mix conservatively. Reference-bounded tonal language is used only when a reference file is loaded.
9. Verify loudness, peak safety, clipping, dynamics, and mono compatibility.
10. Export a 24-bit or 16-bit WAV. Stale masters cannot export. Clipping or true-peak over ceiling blocks export unless you explicitly override.

Thesis: evidence-first, conservative repairs, show measured change (loudness, peak, remaining risks). MixForge is mix repair + release master; dedicated vocal production lives in AuraMix.

## Required environment variables

### Vercel
- `GEMINI_API_KEY` — native-audio Producer's Ear pass and on-demand spoken producer review. The API routes read **only** `process.env.GEMINI_API_KEY`. Set it on the Vercel mix-forge project for **Production and Preview**. No key is shipped in the client or repo.
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

## Storage

The app uploads unreleased mixes to the private `audio` bucket. The Edge Function creates a short-lived signed URL for the RunPod separator and deletes the source upload after the separation job completes.

## Hub billing follow-up

MixForge is priced on the Hub ($9/mo or Forge Pass $24). This app currently ships ungated with `MixForgeHub.requireEntitlement()` stubs for a later Hub OAuth + Stripe wiring pass.
