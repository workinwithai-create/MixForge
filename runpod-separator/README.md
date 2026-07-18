# MixForge low-cost stem separator

This worker replaces Music.ai with a self-hosted Demucs endpoint on RunPod Serverless.

## Deploy

1. Create a RunPod Serverless endpoint from this directory's Docker image.
2. Use a 16 GB or 24 GB GPU class and Flex workers so the endpoint scales to zero.
3. Set `DEMUCS_MODEL=htdemucs` on the worker.
4. Add the endpoint ID and API key to Supabase Edge Function secrets as:
   - `RUNPOD_ENDPOINT_ID`
   - `RUNPOD_API_KEY`
5. Deploy the MixForge `separate-stem` Edge Function configured for the RunPod provider.

Music.ai must remain disabled as an automatic fallback. Failed jobs must not consume MixForge usage reservations, and completed stem objects should be cached by source fingerprint.
