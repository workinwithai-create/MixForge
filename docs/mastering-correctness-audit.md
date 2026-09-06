# Mastering correctness audit — 2026-09-06

Scope: repository main at 91b9009e4d80794cf2dedb85f7f4298ac6e4ee35. This is a code and regression-test audit, not a completed listening benchmark or verification of production backends.

## Confirmed defects addressed

| Requirement | Finding | Change |
| --- | --- | --- |
| Each mixing stage responds to the preceding result | The working mix was remeasured, but anchor and placed-bass measurements stayed raw | Measure the effective processed, blended, trimmed stem and pass those measurements forward |
| Follow the selected repair intensity | Sequential operations used the global intensity even after a per-stem selection | Read the selected candidate when deciding sequential operation strength |
| Honest sequential execution | Errors silently invoked the older parallel rebuild | Propagate failure and clear incomplete stage logs; never report a substituted process as completion |
| Preserve timing and original samples | Processing accepted mismatched stem rates and lengths | Reject mismatched processed stages; retain immutable original and verify no-op reconstruction |
| Accurate fast peak estimate | Cubic estimator omitted the penultimate sample and boundary intervals | Include all sample positions and boundary intervals; retain cubic interpolation only as a fast iterative estimate / fallback, not the preferred final export authority |
| Final inter-sample peak authority | The cubic estimate was still the final peak evidence used to release a master | Add a local 4× polyphase FIR final verification pass using the BS.1770 Annex-2 coefficient set; run it once after the dynamics path is chosen and transparently attenuate the final master when needed before downstream previews are derived |
| Honest peak fallback | A browser without the new Offline AudioWorklet path could silently regress to weaker peak evidence | Mark cubic fallback explicitly and reserve an additional 0.55 dB of headroom instead of treating fallback evidence as equivalent |
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
- The mastering renderer still uses cubic interpolation internally for fast candidate iteration. It is no longer intended to be the preferred final export peak authority.
- The chosen final master now receives a local 4× polyphase FIR inter-sample peak pass in an Offline AudioWorklet when the browser supports it. The coefficient set is derived from ITU-R BS.1770 Annex 2. If the measurement requires correction, MixForge applies linear attenuation before null/difference and loudness-matched previews are generated.
- The 4× path reserves a small MixForge safety pad: 0.05 dB at 48 kHz, 0.15 dB at 44.1 kHz and 0.25 dB at other sample rates. These are conservative product guardrails, not standardized tolerances.
- If the Offline AudioWorklet path cannot run or return a final result, MixForge falls back to the existing cubic estimate and reserves an additional 0.55 dB of headroom. The UI identifies this as a fallback rather than presenting it as equivalent evidence.
- The 4× implementation is standards-derived but is not a certified meter. It still needs comparison against an independent standards-compliant meter and current official test signals before any compliance or certification claim.
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
- Full GitHub Actions `npm test` passed on commit c106afae with the symmetric A/B regression wired into the suite. That regression covers a 22 dB master attenuation case beyond the old cap, the reverse case where the original must be attenuated instead of boosting the master, matched-preview routing, and invalidation of stale matched buffers.
- Full GitHub Actions `npm test` passed on commit 210dfcd8 with the local 4× true-peak core wired into the suite. The core regression covers high-frequency inter-sample rise, linear-gain accuracy, stereo maximum selection, block/state continuity and end-of-file filter flushing.
- Full GitHub Actions `npm test` passed on commit d02ae359 with the final peak-safety wrapper and fallback regression wired into the suite. The fallback regression proves that unavailable Offline AudioWorklet support does not masquerade as equivalent evidence: the method is labeled `cubic-fallback`, the extra safety reservation is applied, achieved LUFS is adjusted with the final trim and the returned master is the gain-trimmed buffer.
- A direct JavaScript sanity benchmark of the same 4-phase × 12-tap inner-loop pattern processed ten seconds of 48 kHz stereo in about 129 ms in the available Node runtime, extrapolating to roughly 2.3 seconds for a three-minute stereo programme before browser/AudioWorklet overhead. This is not a browser performance benchmark.
- Synthetic tests also cover all cubic peak positions in short buffers, stereo-channel peak detection, missing/invalid export measurements, effective-anchor feedback, immutable/no-op audio, stale sequential plans, render failure propagation, target changes during rendering, stale repair choices, dynamics-preservation fallback behavior and symmetric loudness matching.
- Vercel created a READY preview deployment for current peak-safety head d02ae359 as well as the intermediate 4× meter commits. Deployment readiness proves the branch built and deployed; it does not prove the Offline AudioWorklet executed successfully in a real browser.
- The protected branch preview still redirects the available fetch tooling through Vercel SSO, so this audit does not claim an interactive browser run of the newest 4× AudioWorklet path.
- A prior temporary authenticated Vercel preview loaded successfully on older commit 45d7454. An eight-second synthetic tone file decoded, scanned, received a Gemini response, rendered at -12 LUFS, invalidated export after a target change, and rerendered at -14 LUFS. Browser observations then motivated the source-attribution and zero-issue timeline corrections.
- The download event timed out in earlier browser tooling; a downloaded WAV was not independently inspected.
- No authenticated separation job, real-song listening comparison, independent certified-meter comparison or production deployment was verified in this audit.
