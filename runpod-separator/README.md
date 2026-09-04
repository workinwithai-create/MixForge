# MixForge source-separation worker

This RunPod Serverless worker keeps HTDemucs as the production-safe baseline and adds an opt-in MelBand RoFormer quality route for vocal isolation.

## Canonical MixForge stems

MixForge's repair engine has four canonical source buckets:

- `vocals`
- `bass`
- `drums`
- `other` — Demucs residual content such as guitars, keys, and ambience

**Important:** MelBand's `instrumental` output is the complete non-vocal mix. It is not equivalent to MixForge/Demucs `other`, so the worker never aliases `instrumental` to `other`.

## Engines

- `demucs` — default and backward-compatible. Uses `DEMUCS_MODEL` (default `htdemucs`) and can return vocals, bass, drums, and residual `other`.
- `melband` — quality route only when the canonical request is vocals alone. Uses `MELBAND_MODEL` (default `melband-roformer-kim-vocals`).
- `auto` — recommended Forensic Fix mode. When quality mode needs vocals plus other canonical stems, the worker uses a **hybrid** result: MelBand supplies vocals; Demucs remains authoritative for bass, drums, and residual `other`. When vocals are not requested, it stays on Demucs.

MelBand is protected by the server-side `ENABLE_MELBAND` feature gate. It is **off by default**. Even if a browser asks for `auto` or `melband`, the worker uses Demucs until `ENABLE_MELBAND=true` is set on the RunPod worker.

Each completed job returns separator provenance including the actual engine, models, a per-stem source map, requested stems, elapsed time, routing note, and the MelBand checkpoint identity when MelBand participates.

## MelBand package and model

The worker pins `melband-roformer-infer==0.1.5` and uses its `melband-roformer-infer` CLI. The default `melband-roformer-kim-vocals` model outputs vocal and instrumental WAVs; MixForge consumes the vocal output only in canonical/hybrid mode.

The package is MIT licensed. The Kimberley Jensen checkpoint currently used by the default model is also marked MIT after an April 22, 2026 relicense by the original author.

The exact checkpoint identity locked by MixForge is:

- file: `MelBandRoformer.ckpt`
- size: `913,106,900` bytes
- SHA-256: `87201f4d31afb5bc79993230fc49446918425574db48c01c405e44f365c7559e`

The upstream downloader verifies this SHA-256. Candidate images that preload MelBand verify the same hash again during the Docker build. A mismatch fails the image build.

## Reproducible image publishing

The repository includes `.github/workflows/publish-separator.yml`. It is **manual-only** and does not run on pushes or merges.

When run, it publishes an immutable image tag:

`ghcr.io/workinwithai-create/mixforge-separator:sha-<git-commit-sha>`

Optional inputs:

- `preload_melband=true` — downloads and bakes the verified 913 MB checkpoint into the image, preventing first-job model download on a cold worker.
- `publish_candidate=true` — moves `ghcr.io/workinwithai-create/mixforge-separator:candidate` to the exact immutable image built by that run.

Publishing an image **does not enable MelBand**. The image still contains `ENABLE_MELBAND=false` by default. This lets a candidate image be deployed to RunPod and regression-tested on Demucs before the quality route is activated.

For rollback, point RunPod back to the previous immutable `sha-...` image rather than relying on a moving tag.

## Deploy

1. Publish or build the separator image.
2. Create/update the RunPod Serverless endpoint using an immutable image tag where possible.
3. Use a 16 GB or 24 GB GPU class and Flex workers so the endpoint can scale to zero.
4. Leave `ENABLE_MELBAND=false` while validating the new image. This keeps current Demucs behavior even though Forensic Fix requests quality routing.
5. Optional model settings:
   - `SEPARATION_ENGINE=demucs` (default when the request does not specify an engine)
   - `DEMUCS_MODEL=htdemucs`
   - `MELBAND_MODEL=melband-roformer-kim-vocals`
   - `MELBAND_ROFORMER_MODELS_PATH=/runpod-volume/melband-models` when a persistent RunPod volume is mounted and the model is not baked into the image.
6. Add the endpoint ID and API key to Supabase Edge Function secrets as `RUNPOD_ENDPOINT_ID` and `RUNPOD_API_KEY`.
7. Deploy the MixForge `separate-stem` Edge Function configured for the RunPod provider.
8. Run the current Demucs path first and confirm the existing forensic output is unchanged.
9. Enable MelBand on the benchmark worker and compare the same songs through Demucs vs hybrid quality routing.
10. Promote `ENABLE_MELBAND=true` only if the real-song benchmark wins.

## Safety rules

- Music.ai remains disabled as an automatic fallback.
- A model may only claim stems it actually produces.
- `instrumental` must never be mislabeled as residual `other`.
- Failed jobs must not consume successful-use quota.
- Current Demucs behavior remains the fallback until the quality route is explicitly enabled.
- Publishing a candidate image is not the same as enabling MelBand.
- Use immutable image tags for reproducible rollback.
- Do not promote a separator based on SDR alone. Compare audible bleed, transient integrity, vocal artifacts, reconstruction behavior, runtime, and GPU cost on the same test set.
