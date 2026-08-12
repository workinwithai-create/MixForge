# MixForge

MixForge is a browser forensic release-prep pipeline:

1. Audit a stereo mix for professional-quality problems.
2. Choose **Quick Master** (stereo release master + Original vs Master A/B) or **Forensic Fix** (timeline + opt-in stems + targeted repair).
3. Separate only the stems needed to isolate those problems (Demucs via RunPod: vocals / bass / drums / other).
4. Measure and repair the affected stems conservatively.
5. Rebuild the original mix with the corrected stem deltas.
6. Master the corrected mix.
7. Verify loudness, peak safety, clipping, dynamics, and mono compatibility.
8. Export a 24-bit or 16-bit WAV.

Thesis: evidence-first, conservative repairs, prove the master improved. MixForge is mix repair + release master; dedicated vocal production lives in AuraMix.

## Required environment variables

### Vercel
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_MODEL` (optional; defaults to `claude-sonnet-4-6`)

### Supabase Edge Function (`separate-stem`)
- `RUNPOD_ENDPOINT_ID`
- `RUNPOD_API_KEY`
- Supabase-provided `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_ANON_KEY`

Music.ai is retired for this path and must not be configured as a fallback.

## Storage

The app uploads unreleased mixes to the private `audio` bucket. The Edge Function creates a short-lived signed URL for the RunPod separator and deletes the source upload after the separation job completes.

## Hub billing follow-up

MixForge is priced on the Hub ($9/mo or Forge Pass $24). This app currently ships ungated with `MixForgeHub.requireEntitlement()` stubs for a later Hub OAuth + Stripe wiring pass.
