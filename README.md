# MixForge

MixForge is a browser forensic release-prep pipeline — not a one-click loudness clone.

LANDR, eMastered, BandLab Mastering, CloudBounce, and RoEx win on making a file louder in one click. MixForge wins on evidence: measure → locate problem windows → optional honest stem repair → conservative master → show measured change. It does not claim musical improvement.

1. Audit a stereo mix. Measurements are ground truth for clip %, LUFS, sample peak, correlation, and DC.
2. Optional Gemini listening pass hears a compact mix excerpt (not a vocal performance take). Performance / pitch / timing lives in [AuraMix](https://auramix.workinwithai.com).
3. Choose **Quick Master** (stereo release master + Original vs Master A/B) or **Forensic Fix** (timeline + opt-in stems + targeted repair). Quick Master skips Isolate / Confirm / Repair, but it still applies evidence-bounded stereo EQ for measured #1 issues (sub-bass accumulation, dark top) before loudness — it does not wait for Forensic stems. When the scan finds a buried/masked lead, Forensic is recommended and writes time-sliced vocal rides on buried timeline windows (a verse that ducks under other gets a ride; a forward chorus stays put). It remasures those windows — including rides already written — and repeats until they clear or a hard cap / quality stop (true-peak, harshness, smash) ends the loop. A song-length +2 dB (or a bigger one-shot) is not done. Skipping stems is honest: a stereo master cannot unbury the vocal.
4. Separate only the stems needed (Demucs via RunPod: vocals / bass / drums / other). Guitars and keys are not confirmable stems — they share residual other.
5. Measure and repair affected stems conservatively.
6. Rebuild the original mix with the corrected stem deltas.
7. Master the corrected mix conservatively. Reference-bounded tonal language is used only when a reference file is loaded.
8. Verify loudness, peak safety, clipping, dynamics, and mono compatibility.
9. Export a 24-bit or 16-bit WAV. Stale masters cannot export. Clipping or true-peak over ceiling blocks export unless you explicitly override.

Thesis: evidence-first, conservative repairs, show measured change (loudness, peak, remaining risks). MixForge is mix repair + release master; dedicated vocal production lives in AuraMix.

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

## Storage

The app uploads unreleased mixes to the private `audio` bucket. The Edge Function creates a short-lived signed URL for the RunPod separator and deletes the source upload after the separation job completes.

## Hub billing follow-up

MixForge is priced on the Hub ($9/mo or Forge Pass $24). This app currently ships ungated with `MixForgeHub.requireEntitlement()` stubs for a later Hub OAuth + Stripe wiring pass.
