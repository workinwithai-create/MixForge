# Competitor benchmarking (black-box)

`tools/master-diff.mjs` measures what a mastering service did to a mix by
comparing the original with the master the service returned. It works only on
audio you have legitimately downloaded from your own account. It never touches
a service's code, and nothing it measures should be copied into MixForge as
someone else's implementation: use the numbers to set targets, then build our
own DSP to meet them.

## What it measures

| Output | How | Read it as |
| --- | --- | --- |
| Alignment | Envelope cross-correlation, then sample-level refinement | Services often add or trim leading silence. Check that the offset looks sane |
| LUFS, LRA, PLR, crest | BS.1770-style gated loudness, 4x oversampled peak estimate | The service's loudness target and how much dynamic range it gives up |
| True-peak ceiling | 4x oversampled estimate (not a certified meter) | Whether the service really keeps to -1 dBTP or lets inter-sample overs through |
| Effective EQ | 1/3-octave mid and side spectra, master minus original, after removing the LUFS gain change | Read the **shape**. The whole curve shifts up or down with the loudness normalization |
| Per-band dynamics | Slope of master band level against original band level, frame by frame | 1.0 = untouched. Lower = compressed in that band. Different slopes across bands mean multiband compression |
| Width change | Side-minus-mid energy per band, before vs after | Positive = widened, negative = narrowed (for example mono-ing the lows) |
| Gain reduction | 10 ms blocks, gain relative to quiet passages | How hard and how often the limiter and compressor work |

## Workflow

1. Choose 10 to 20 mixes across the genres our users bring: dense rock, sparse
   acoustic, hip-hop with heavy sub, EDM, and a vocal-forward pop track.
   Export them as 24-bit or 32-bit float WAV at their native sample rate.
2. Master each mix with every service at its default setting, then again at
   each intensity or style option you want to profile. Download WAV where the
   service offers it. Convert any MP3 with
   `ffmpeg -i master.mp3 -c:a pcm_f32le master.wav`. MP3 encoding blurs the
   true-peak and high-band numbers.
3. Master the same mixes with MixForge Quick Master and include it as a
   service.
4. Put everything under `benchmarks/` and write a manifest there:

   ```json
   [
     { "service": "LANDR",    "track": "rock-1", "original": "mixes/rock-1.wav", "master": "landr/rock-1.wav" },
     { "service": "MixForge", "track": "rock-1", "original": "mixes/rock-1.wav", "master": "mixforge/rock-1.wav" }
   ]
   ```

5. Run `node tools/master-diff.mjs --manifest benchmarks/pairs.json --json benchmarks/results.json > benchmarks/report.md`.
   The report opens with a side-by-side table of averages for each service,
   followed by a section for each track.

For a single pair, run `node tools/master-diff.mjs original.wav master.wav --label "eMastered warm"`.

If the master's sample rate differs from the original's, resample the master
first with the ffmpeg command the tool prints.

## What to do with the numbers

- Where a service consistently lands at a different LUFS or PLR than MixForge,
  decide whether our default target should move.
- An average EQ shape that holds across tracks for one service is that
  service's tonal "house curve". Use it to inform a target curve of our own. Do
  not use it as a blind match-EQ.
- Band slopes below about 0.9 in only some bands mean the service uses
  multiband compression. That is the next DSP gap for MixForge after the
  limiter.
- Keep the audio, manifest and results under `benchmarks/`, which is
  gitignored. They are unreleased mixes and notes on other companies' products,
  and should not go into this public repo.
