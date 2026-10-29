# REA — iZotope RX 12 Advanced → MixForge forensic restoration roadmap
**Investigated:** 2026-10-29  
**Target:** iZotope RX Advanced (current RX 12.1, released 2026-10-15)  
**Method:** public-product/documentation and observable-workflow analysis; inspection of our MixForge source and local comparison fixtures. **Not** RX binary disassembly, extraction of protected assets, or access to proprietary DSP/models.  
**Outcome:** independent feature specification and evidence-based test strategy; **no RX code is imported**.

## Source inventory (authoritative public features)
- Official RX Advanced release history: https://www.izotope.com/pages/release-notes/rx-advanced
- RX 12 feature/module inventory: https://www.izotope.com/en/products/rx/features
- What's new in RX 12: https://www.izotope.com/community/blog/rx-12
- RX 12 documentation: https://docs.izotope.com/rx12/en/index-en.html
- RX 12 stem splitting / Music Rebalance: https://www.izotope.com/en/learn/stem-separation-music-rebalance
- RX 12 film scene source separation: https://www.izotope.com/en/learn/scene-rebalance

**Version distinction:** The screenshot supplied by the user shows an RX Advanced editing workflow; it should not be treated as evidence of its current version. RX 12.0 released 2026-04-28, RX 12.1 released 2026-10-15.

## What to learn from RX, without copying its UI or code

### 1. Unified inspect / select / repair / compare / render loop
RX's differentiator is not a giant effects menu: it is a sound-focused workspace pairing waveform, frequency spectrogram, narrow selections, tuned tools, preview/bypass, and non-destructive history/recovery. In RX 12, Stems View allows a track-based workflow on isolated stems.

**MixForge independent implementation:** preserve the **approved MagicPath MixForge design** (charcoal, copper, mixer, section editor, repair tool panels). Add switchable waveform/spectrogram views **inside its existing panels**. One timeline/transport for the song and all stems; zoom, markers, selected time range and selected frequency region; drag handles, keyboard/numeric edit, source or stem target, audition/bypass, receipt, apply/rollback. No wholesale UI rebuild. Pipe Dreams Studio's production Mix Room should load this same canonical MixForge interface; the separate game *The Experience* must not be touched.

### 2. RX module family → MixForge engineering responsibilities

| RX workflow/module | Why users need it | Independent MixForge implementation | Evidence level |
|---|---|---|---|
| Spectrogram + spectral selection | Target transient hiss, whistles, mic clicks, unwanted frequency events | STFT magnitude display; selection mask with time-frequency feather; STFT/ISTFT processed region with reconstruction quality checks | **New development required** |
| Spectral Repair / Interpolate | Erase isolated transient without silencing the entire passage | Local patch/interpolation using neighboring time-frequency frames, residual preview, bounded strengths | **R&D required**; do not claim equivalent quality |
| De-click / De-crackle | Repair impulsive contamination | Transient detector with confidence, high-frequency energy, local interpolation, safeguards against guitar/drum transients | Small independent DSP possible; validation required |
| De-clip | Reconstruct flattened peaks | clipped-run detector, harmonic/AR interpolation or open research methods, no invented lost information | R&D required, evaluate distortion and false positives |
| De-hum | Remove stable 50/60Hz mains harmonics | measured harmonic detection, stable/adaptive notches, time-bounded preview | Practical initial independent DSP |
| De-ess / Breath / De-plosive | Vocal cleanup without dulling | sibilance detector + band-dependent gain, breath-event recognition only after tests, sub-bass plosive treatment | Existing effects may help, but RX parity unverified |
| Spectral De-noise / Voice De-noise | Reduce broadband noise | noise-profile STFT filtering, gentle spectral gating + residual listen; model-based optional later | Good early experiment, quality not assumed |
| De-reverb / Dialogue Isolate | Reduce room and competing audio | offline/source-aware ML models after license, dataset and performance review | Advanced/longer-term |
| Music Rebalance / Stems View | Change vocal/drum/bass/other balance after mixing | use **existing hybrid splitter candidate**, align stems, preserve summed mix, solo/mute/level/section edits | Prototype exists; integration/benchmark pending |
| De-bleed / Guitar De-noise | Restore dirty multi-mic and guitar capture | interference detection plus source separation, multi-source editing; protect intentional tone | Advanced/longer-term |
| EQ / EQ Match / Dynamics / Gain / Fade | Target individual mix problems | existing MixForge sequential processor plus clip/frequency-specific correction, non-destructive region envelopes | Partly in MixForge; UI and QA integration pending |
| Repair Assistant | Recommend conservative fixes, offer intensity and compare | measured problem → evidence → candidate processor/strength → loudness-matched preview → approve/reject/undo | Existing Forensic Fix/receipts; further QA required |
| Streaming / loudness / true-peak delivery | Master reliably after restoration | existing MixForge premaster corrections, mastering, LUFS/true-peak verification and export checks | Existing; preserve release gates |

RX 12 also includes Scene Rebalance (dialogue/music/effects), Music Rebalance realtime, ML De-bleed, Stems View, expanded dialogue and breath processing; these should be research targets, not claims of shipped MixForge functionality.

### 3. Existing *new* splitter must remain the candidate, not be replaced by the older Demucs baseline

**Verified local project:** /Volumes/HD - Data/StemSplitter-Test-2026-10-27/  
**Evidence artifacts:** 
- status.json — comparisons complete, CPU trials and locked checkpoint digest
- listening-feedback-2026-10-27.json — preferred candidate on **Collision_Course** (choice A) and **All_My_Life** (choice C), 2/2 **subjective** wins in 12-second comparisons
- blind-repair-test-2026-10-27/audit-and-repair-report.json — completed 18-second independent audit, measured correction and equal-master comparison
- blind-repair-test-2026-10-27/MixForge-Blind-Repair-Master-Test.zip — premaster, master, and blind listening variants
- stemdeck-reference.json — StemDeck defaults emulated with Demucs CLI; **not the StemDeck packaged app**
- checkpointSha256: 87201f4d31afb5bc79993230fc49446918425574db48c01c405e44f365c7559e

**Candidate signal path:** MelBand-RoFormer specialist vocal isolation → subtract vocals from source to obtain residual accompaniment → Demucs instruments from the residual → sum / align / verify reconstructed mix. Preserve vocal integrity and defer aggressive correction if leakage or source confidence is weak.

**Do not overclaim:** 2 preferred clips are not an objective win or a production-ready splitter. Need varied stems/reference truth, leakage, phase, residual energy, timbre, timing and artifact tests; checkpoint license/provenance and GPU costs. Existing MixForge PR #13 merged model quality routing; PR #14 merged controlled image publishing; PR #15 model trust guard remains **open** as of this investigation. Production promotion remains gated.

### 4. Proposed non-destructive processing architecture
1. Input full-res stereo buffer; capture PCM hash, sample rate, channel layout, original untouched.
2. Offline analyze: waveform peaks, STFT magnitude, spectral flux, transient/click candidates, hum harmonics, mask conflicts, current loudness, true peak and channel correlation.
3. If needed, run the locked candidate splitter through **authorized** service. Preserve model/build/weights identity and per-stem provenance. The existing Supabase / RunPod endpoints require authorization; never bypass paid entitlement by placing secrets/client tokens in MagicPath.
4. Select region: time [start,end], optional frequency [low,high], stem target, fade bounds, and operation. UI shows region before any processing.
5. Processor runs against an immutable source revision. Store operation args and spectral/PCM receipts in a versioned edit graph; **never** rewrite the original.
6. Audition corrected region and the entire reconstructed mix, with true loudness-matched A/B, solo, undo/redo, bypass and noise-only/residual checks.
7. Apply to corrected premaster only after user confirmation; verify mix sum, resampling, latency, phase, clipping, loudness and true peak. Gate unsafe or confidence-low edits.
8. Sequence approved corrections (vocal → conflicting accompaniment → bass → drums, based on evidence), carry the actual last corrected mix into next stage.
9. Master only the accepted premaster through existing MixForge chain, verify final export/receipts/rollback, then optionally hand to Pipe Dreams Studio and ReleasePilot.

### 5. Minimal independent spectral repair experiment
- **Viewport:** matched transport with waveform above 1024/2048-point STFT heatmap; logarithmic frequency axis, realistic units and anti-aliasing; no decorative mock spectrogram passed as measured audio.
- **Mask:** select time x frequency with feather; color only selected actual samples; allow audition of the proposed change.
- **Processor 1:** dynamic notch/hum, gain and fades, safe attack/release, compare against untouched source.
- **Processor 2:** interpolation of one short click/pop or small narrowband spectral defect using frames adjacent in time; refuse large or music-dominant selection.
- **Processor 3:** measured spectral denoise (noise-profile-based) with conservative defaults and residual listening.
- **Correctness:** STFT/ISTFT unity pass-through null test near machine precision for floating-point path, length preservation, seam click inspection, no NaN/infinite samples, correct stereo mapping, reference A/B equalized.
- **Listening:** test unwanted sound actually removed *without* removing snare attacks, guitar pick transients, vocal consonants, and reverb tails. Keep user-perceived sound quality first, not merely measured score.

### 6. Test plan: quality and usability gates
**A. Splitter study:** use local 12-sec listening and 18-sec audit fixtures as historical baseline. Compare HTDemucs, the StemDeck-style Demucs settings, MelBand vocal swap, experimental hybrid, and clean reference stems (if legitimately available). Randomize blind ordering. Measure residual sum to original, stem leakage, timbral distortion, clicks, offsets, reconstruction seam accuracy, CPU/GPU runtime, peak memory, failures, and cost per song. Do not calculate SI-SDR without ground-truth stems.

**B. Repairs:** create a small *owned or permissively licensed* fixture pack with deliberate de-hum (60Hz), isolated pop, peak clip, hiss, vocal sibilance, guitar pick/snare transient, room reverb and overlapping stems. Each fix needs before/after WAV, bypass, undo/redo, strength curve, retained original, and regression tests.

**C. iPhone/browser:** verify native audio playback unlock after a tap, no dead transport, correct scrub/scroll and full visible mobile mixer, solo changes heard immediately, selected-time EQ audible, no memory crashes for short clips. Distinguish MagicPath React canvas UI from actual production DSP backend.

**D. Export:** blind test original vs repaired premaster vs mastered audio on desktop and phone. Match listening loudness. Verify no double-mastering, exact receipt attribution, true-peak ceiling, and no incorrect success states.

**E. Protection:** preserve private audio and project authorization; verify service auth, origin policy, short-lived signed URLs, model license, confidential recordings, paid entitlement and secure cleanup. Do not place RunPod/Supabase credentials in browser.

### 7. Implementation priority / acceptance
**P0:** Fix playback; stabilize the already-approved MagicPath interface with real splitter-backed stems, instrument solo, time selection, fades/gain and A/B. No false "working" split button.
**P1:** Real measured spectrogram, selection tools, undo/redo receipts; connect narrow selected-region EQ and simple hum/click DSP. User hears change, not just sees sliders.
**P2:** Extend processor rack to spectral cleanup, declip and conservative denoise. Require real fixture tests and rollback.
**P3:** More computationally intensive restoration, de-bleed, de-reverb, spectral inpainting, richer music source taxonomy after proven benchmarks. No "full RX equivalent" claims until independently verified.

**Do not:** copy RX trade dress, icons, copyrighted code, proprietary model weights, or paid features via bypass; confuse benchmark features with shipped capabilities; claim full automatic musical instrument isolation when current models return only 4 verified buckets.

## Current confidence
- Official RX capabilities and version: **verified via official public documentation**.
- Local MixForge hybrid research outputs: **verified filesystem artifacts and local JSON**, 2/2 subjective preference only.
- Actual RX module DSP behavior/quality/implementation: **not tested** (no executable binary or license exercised); any algorithm details here are independent designs, not reverse-engineered original RX code.
- Custom MixForge UI audio playback and RX-style spectral tools: **not validated live on iPhone**; production remains unchanged.
