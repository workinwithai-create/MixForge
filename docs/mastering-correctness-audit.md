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
| Repair choices invalidate downstream audio | Preserve/Balanced/Assertive could change in the UI while an older corrected mix/master remained current | Add monotonic repair revisions across rebuild, mastering and export; clear corrected/mastered buffers and block stale export when a repair choice changes |
| Preserve dynamics before chasing LUFS | A peak-safe master had no measured bound on transient/macro-dynamic loss | Measure crest/LRA-like loss against the corrected source; back off loudness and bypass glue when needed; fall back to a transparent headroom-bounded path instead of forcing the target |
| Guarded gain math remains accurate | Backing off from a target whose original gain was already capped could produce a mismatched effective gain | Recompute guarded gain from measured corrected-mix LUFS instead of subtracting from an already-clamped requested gain |
| Honest level-matched listening | The matched-master preview could only attenuate 18 dB, while the null monitor could boost the quieter side by up to 18 dB | Build a symmetric attenuation-only pair at the quieter measured LUFS, expose matched Original and matched Master previews, and use the same no-boost rule in the aligned null monitor |
| Source attribution | A two-tone test signal was labeled 84% likely lead vocal by a band-energy formula | Remove instrument-presence percentages; distinguish user notes from confirmed identity |
| Timeline claims | Zero issue load before and after was called strong improvement | Require a positive starting issue load before claiming improvement |
| Honest improvement language | Frequency-gap reduction was asserted to prove clearer vocals | Label it band-balance change and require listening to assess clarity |

## What is implemented, and its limits

- Sequential mixing is connected in index.html after the forensic layer. It applies ordered stem corrections to the original mix; it is not a learned mixing engineer or a new source-separation model.
- Quick Master follows a separate stereo path. It does not invoke sequential stem mixing.
- Whole-buffer loudness and sample measurements exist, but spectral analysis samples windows. Gemini receives a compact listening excerpt. Do not claim it listens to every moment of the song.
- Demucs routing supports vocals, bass, drums and other. Guitar and keys remain combined in other. The leakage/fit score is a heuristic, not measured separation accuracy.
- Mastering now has a measured dynamics-preservation guard. Its crest-loss and LRA-like limits are conservative MixForge product heuristics, not published mastering standards. They still require calibration against real music and blind listening.
- If the requested target costs too much measured dynamics, MixForge first lowers the effective target and bypasses planned master glue. If that still fails, it uses a transparent safety path with no mastering EQ/compression and limits gain to measured peak headroom. The requested target remains visible as the request; the effective target is reported separately.
- Level-matched A/B now attenuates both sides to the quieter programme instead of boosting either side or stopping at an 18 dB attenuation cap. This removes a loudness bias, but perceptual preference still requires real listening tests.
- The peak estimator is still cubic interpolation and must not be represented as a standards-compliant true-peak meter. ITU-R BS.1770 Annex 2 uses oversampling/interpolation; replacing the estimator with an efficient oversampled FIR path remains engineering work and must be performance-tested in the browser before adoption.
- Producer-facing copy still contains technical terms and some heuristic judgments stated too confidently. The whole narrative needs a separate evidence-to-language review.
- Repair selection now has a unified revision model across corrected mix, master and export. Browser interaction still needs a real-song pass to confirm the intended UX when a user changes a repair after rendering.

## Complaint-driven acceptance work

These are reported experiences, not proof of every current competitor's behavior:

- Harsh, overcompressed, unclear results: https://www.reddit.com/r/mixingmastering/comments/uv7xno/using_emastered_to_check_my_mixes/
- Overcompression and dissatisfaction: https://www.reddit.com/r/iZotopeAudio/comments/1iw9fxh/switching_from_landr_to_izotope/
- Wanting finer control and concerns about album consistency (older discussion): https://vi-control.net/community/threads/anyone-use-landr-for-mastering.65279/page-2

Before claiming superiority, compare identical licensed source tracks across current services at matched playback loudness. Include acoustic vocal/guitar, dense drums/bass, bright sibilance, already-limited mixes, quiet dynamic mixes, mono and phase-sensitive stereo. Record blind preferences plus clipping, true peak from an independent meter, dynamics change, tonal change, artifacts, processing time and recovery from failure. Separate testable engineering correctness from musical preference. Do not buy comparison services without authorization.

## Validation completed

- Existing npm test suite passed before the first audit changes, demonstrating its earlier coverage gap.
- Full GitHub Actions `npm test` passed after the dynamics guard, script wiring and dynamics regression test were added. The dynamics test exercises normal pass-through, measured loudness backoff/no-glue behavior, transparent fallback, source-LUFS-derived guarded gain and reset of prior effective-path evidence.
- Full GitHub Actions `npm test` also passed on commit c106afae with the symmetric A/B regression wired into the suite. That regression covers a 22 dB master attenuation case beyond the old cap, the reverse case where the original must be attenuated instead of boosting the master, matched-preview routing, and invalidation of stale matched buffers.
- Synthetic tests cover all peak positions in short buffers, stereo-channel peak detection, missing/invalid export measurements, effective-anchor feedback, immutable/no-op audio, stale sequential plans, render failure propagation, target changes during rendering, stale repair choices, dynamics-preservation fallback behavior, and symmetric loudness matching.
- Vercel automatically created READY preview deployments for the audit branch, including the state-integrity and dynamics commits. The branch preview remains protected by Vercel authentication in the available fetch tooling, so this audit does not claim a fresh end-to-end click-through of the newest UI state.
- A prior temporary authenticated Vercel preview loaded successfully. On commit 45d7454, an eight-second synthetic tone file decoded, scanned, received a Gemini response, rendered at -12 LUFS, invalidated export after a target change, and rerendered at -14 LUFS. Browser observations then motivated the source-attribution and zero-issue timeline corrections.
- The download event timed out in browser tooling; a downloaded WAV was not inspected.
- No authenticated separation job, real-song listening comparison, independent certified meter comparison or production deployment was verified in this audit.
