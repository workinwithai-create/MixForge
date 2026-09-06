# Mastering correctness audit — 2026-09-06

Scope: repository main at 91b9009e4d80794cf2dedb85f7f4298ac6e4ee35. This is a code and regression-test audit, not a completed listening benchmark or verification of production backends.

## Confirmed defects addressed

| Requirement | Finding | Change |
| --- | --- | --- |
| Each mixing stage responds to the preceding result | The working mix was remeasured, but anchor and placed-bass measurements stayed raw | Measure the effective processed, blended, trimmed stem and pass those measurements forward |
| Follow the selected repair intensity | Sequential operations used the global intensity even after a per-stem selection | Read the selected candidate when deciding sequential operation strength |
| Honest sequential execution | Errors silently invoked the older parallel rebuild | Propagate failure and clear incomplete stage logs; never report a substituted process as completion |
| Preserve timing and original samples | Processing accepted mismatched stem rates and lengths | Reject mismatched processed stages; retain immutable original and verify no-op reconstruction |
| Accurate peak checks | Cubic estimator omitted the penultimate sample and boundary intervals | Include all sample positions and boundary intervals; still an estimate, not a certified true-peak meter |
| Export requires evidence | Missing/NaN measurements could pass export and receive a verified label | Require finite peak, clipping, correlation, peak estimate and ceiling; missing evidence cannot be overridden |
| Honor the current loudness target | Target selection invalidated a master without rebuilding its plan | Rebuild the plan on change, clear old derived buffers, reject settings/source changes during render |
| Honest improvement language | Frequency-gap reduction was asserted to prove clearer vocals | Label it band-balance change and require listening to assess clarity |

## What is implemented, and its limits

- Sequential mixing is connected in index.html after the forensic layer. It applies ordered stem corrections to the original mix; it is not a learned mixing engineer or a new source-separation model.
- Quick Master follows a separate stereo path. It does not invoke sequential stem mixing.
- Whole-buffer loudness and sample measurements exist, but spectral analysis samples windows. Gemini receives a compact listening excerpt. Do not claim it listens to every moment of the song.
- Demucs routing supports vocals, bass, drums and other. Guitar and keys remain combined in other. The leakage/fit score is a heuristic, not measured separation accuracy.
- Limiting and peak trimming exist. Repeated gain/limiter passes are not yet bounded by a measured maximum transient-loss or gain-reduction budget. A peak-safe file can still sound overcompressed.
- A level-matched master preview exists, but its attenuation is capped and cannot fully match every source/master loudness relationship. A broad loudness-range A/B test remains necessary.
- Producer-facing copy still contains technical terms and some heuristic judgments stated too confidently. The whole narrative needs a separate evidence-to-language review.
- UI controls for individual candidate changes do not yet comprehensively invalidate an already rebuilt corrected mix. This needs a unified revision model across repair, render, preview and export.

## Complaint-driven acceptance work

These are reported experiences, not proof of every current competitor's behavior:

- Harsh, overcompressed, unclear results: https://www.reddit.com/r/mixingmastering/comments/uv7xno/using_emastered_to_check_my_mixes/
- Overcompression and dissatisfaction: https://www.reddit.com/r/iZotopeAudio/comments/1iw9fxh/switching_from_landr_to_izotope/
- Wanting finer control and concerns about album consistency (older discussion): https://vi-control.net/community/threads/anyone-use-landr-for-mastering.65279/page-2

Before claiming superiority, compare identical licensed source tracks across current services at matched playback loudness. Include acoustic vocal/guitar, dense drums/bass, bright sibilance, already-limited mixes, quiet dynamic mixes, mono and phase-sensitive stereo. Record blind preferences plus clipping, true peak from an independent meter, dynamics change, tonal change, artifacts, processing time and recovery from failure. Separate testable engineering correctness from musical preference. Do not buy comparison services without authorization.

## Validation completed

- Existing npm test suite passed before changes, demonstrating its coverage gap.
- Full npm test suite passed after changes, including new sequential and target regression suites.
- Synthetic tests cover all peak positions in short buffers, stereo-channel peak detection, missing/invalid export measurements, effective-anchor feedback, immutable/no-op audio, stale sequential plans, render failure propagation and target changes during rendering.
- Cloud browser rejected the local test URL with ERR_BLOCKED_BY_CLIENT. No browser end-to-end success is claimed.
- No authenticated separation job, real-song listening comparison, independent certified meter comparison or production deployment was verified in this audit.
