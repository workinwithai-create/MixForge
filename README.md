# MixForge

MixForge is a release-preparation audio pipeline:

1. Audit a stereo mix for professional-quality problems.
2. Separate only the stems needed to isolate those problems.
3. Measure and repair the affected stems.
4. Rebuild the original mix with the corrected stem deltas.
5. Master the corrected mix.
6. Verify loudness, peak safety, clipping, dynamics, and mono compatibility.
7. Export a 24-bit or 16-bit WAV.

## Required environment variables

### Vercel
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_MODEL` (optional; defaults to `claude-sonnet-4-6`)

### Supabase Edge Function
- `MUSICAI_KEY`
- `MUSICAI_WORKFLOW`
- Supabase-provided `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_ANON_KEY`

## Storage

The app uploads unreleased mixes to the private `audio` bucket. The Edge Function creates a short-lived signed URL for the separation provider and deletes the source upload after the separation job completes.
