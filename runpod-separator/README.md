# MixForge source-separation worker

This RunPod Serverless worker keeps HTDemucs as the production-safe baseline and adds an opt-in MelBand RoFormer quality route for vocal / instrumental investigation.

## Engines

- `demucs` — default and backward-compatible. Uses `DEMUCS_MODEL` (default `htdemucs`) and can return vocals, bass, drums, and residual `other`.
- `melband` — higher-quality two-source route for `vocals` + `other` (instrumental). Uses `MELBAND_MODEL` (default `melband-roformer-kim-vocals`).
- `auto` — when the request is marked `quality` / `forensic` / `hq` and only vocals/other are needed, route to MelBand. Otherwise use Demucs.

If MelBand is requested for bass/drums, the worker falls back to Demucs rather than pretending the two-source model produced dedicated bass or drum stems.

Each completed job now returns separator provenance (`engine`, `model`, requested stems, elapsed time, and any fallback reason) so MixForge can record which model actually produced the evidence.

## Deploy

1. Build this directory's Docker image and create/update the RunPod Serverless endpoint.
2. Use a 16 GB or 24 GB GPU class and Flex workers so the endpoint can scale to zero.
3. Keep `SEPARATION_ENGINE=demucs` while validating the new image. Change to `auto` only after the A/B benchmark passes.
4. Optional model settings:
   - `DEMUCS_MODEL=htdemucs`
   - `MELBAND_MODEL=melband-roformer-kim-vocals`
   - `MELBAND_ROFORMER_MODELS_PATH=/runpod-volume/melband-models` when a persistent RunPod volume is mounted, to avoid re-downloading the ~913 MB default checkpoint on cold workers.
5. Add the endpoint ID and API key to Supabase Edge Function secrets as `RUNPOD_ENDPOINT_ID` and `RUNPOD_API_KEY`.
6. Deploy the MixForge `separate-stem` Edge Function configured for the RunPod provider.

## Safety rules

- Music.ai remains disabled as an automatic fallback.
- A model may only claim stems it actually produces.
- Failed jobs must not consume successful-use quota.
- Current Demucs behavior remains the fallback until the quality route is benchmarked on real MixForge material.
- Do not promote a separator based on SDR alone. Compare audible bleed, transient integrity, vocal artifacts, reconstruction error, runtime, and GPU cost on the same test set.
