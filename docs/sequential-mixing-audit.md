# Sequential mixing — architecture audit (2026-10-01, v2.7.0)

This audits MixForge against the "Recenter the Product Around Sequential AI Mixing" handoff. That handoff is the spec for an architecture that already existed in part. It is not a new feature request. The goal of this audit was to keep the sequential work that is correct, separate what was real from what was only on the surface, and finish the missing pieces without rebuilding the app.

## The pipeline as it actually runs

| Step | Where | Notes |
|---|---|---|
| Whole-song analysis | `app-metrics.js` `measureBuffer()`; audit in `app-audit.js` and `app-forensics.js` (`mfForensicAudit`, section timeline) | LUFS, peak, crest, width, correlation, six-band mid/side spectrum, sibilance. |
| Stem separation | `separateRequiredStems()` in `app-audit.js`, wrapped by `app-upload.js` and `app-musician-ux.js`; RunPod Demucs / MelBand backend | Four buckets: vocals, bass, drums, other. |
| Per-stem plans | `buildStemPlans()` in `app-stems.js` (AI plan or measured fallback). Wrapped in this order by `app-forensics.js` (quality score, Preserve/Balanced/Assertive candidates), `app-sequential-mixing.js` (mix plan), `app-signal-integrity.js` (wet floors) and `app-vocal-cleanup.js` (vocal layer analysis). | |
| Rebuild | `rebuildCorrectedMix()`: `app-stems.js` → `app-forensics.js` (parallel) → **`app-sequential-mixing.js` (sequential)** → `app-vocal-cleanup.js` (cleanup on top) | Triggered by `#rebuildBtn`. The result becomes `state.corrected`. |
| Mix bus / master | `app-master.js` and `app-mastering-grade.js` (`prepareMastering`, `renderReleaseMaster`) | Unchanged. It runs only after the rebuild. |

Before 2026-09-04, every stem was processed independently against the original and the deltas were summed. That is the parallel rebuild in `app-forensics.js`, and it is still there underneath as the base the sequential layer replaces.

## Real vs. superficial (state on `main` before this change)

**Real:**
- An ordered plan (vocals → other → bass → drums) was built after separation and shown in the stem panel.
- The rebuild did run stage by stage: each stem's delta was rendered on top of a working mix, and the mix was measured again after each stage.
- The original was never modified. Each stage is a bounded, level-matched parallel delta, with a stem trim of at most ±2 dB.
- Processing scaled with the separation-fit score.

**Superficial or broken:**
1. **The sequential mix was discarded in practice.** After rendering, the stage log was inserted before `stemPanel.querySelector('.actions')`. The Vocal Layer Cleanup box puts a nested `.actions` row inside the vocal card. That row is found first, so `insertBefore()` threw. The catch block then silently ran the old parallel rebuild, and the "rebuilt" status overwrote the warning. In any session with a vocal stem, users heard the parallel mix and never saw the stage log. The new test reproduces this against the old file.
2. **"Relative to the current mix" was only partly true.** Support stages compared themselves with the *raw* anchor and the *raw* bass, not the processed ones. PR #17 fixed this; that fix is ported here.
3. **The "clarity" measure moved the wrong way.** The re-evaluation read a whole-mix low-mid/presence ratio. Carving the guitars at 3 kHz lowers whole-mix presence, so a correct move read as worse. PR #17 relabelled it but did not replace it.
4. **Re-evaluation never changed a decision.** The mix was measured again, but nothing checked whether a stage had made things worse.
5. **Stage A/B was not available.** Snapshots were stored only when they fit a 320 MB budget, which rules out most songs longer than about 3.5–4 minutes. Nothing played them.
6. **No anchor reasoning.** Vocals were always the anchor, including on instrumentals.
7. **Confidence was a single score.** There was no notion of a contaminated stem: one that carries the anchor itself.
8. **The per-stem Preserve/Balanced/Assertive choice was ignored** by the sequential path. PR #17 fixed this; that fix is ported here.

## What was added (v2.7.0, `js/app-sequential-mixing.js`)

- **The rebuild is the sequential mix again.** Blocks are inserted before the panel's *direct* `.actions` child. A failure surfaces as an error instead of silently switching methods (PR #17's behaviour).
- **Anchor selection with a stated reason.** The anchor is the vocal when the vocal stem is within 20 LU of the mix. Otherwise it is the melodic/harmonic bed, or failing that the loudest stem. Stems more than 30 LU under the mix are listed as silent and left untouched.
- **Lead margin.** After each stage, the placed anchor is compared with *everything else in the working mix* (working mix − placed anchor) in the 2–5 kHz band. Support stages carve in proportion to how far that margin is below 6 dB. Once an earlier stage has opened the lead up, later stages carve less.
- **Closed loop.** After each stage the mix is checked for regressions: lead margin down by more than 0.25 dB, more low-mid build-up, a loudness drop of more than 1.5 LU, peaks up by more than 1 dB, or a loss of mono correlation. A regressing stage is retried at half strength, then undone. The explanation says so.
- **Source confidence states.** High confidence, Usable, Contaminated, Uncertain, and Do not process independently. Each comes from the separation-fit score plus an *anchor-bleed estimate*: the normalized correlation between the stem and the anchor stem. A contaminated stem is never carved in the anchor's range. A "do not process" stem is observed but left untouched.
- **Producer assessment first.** A plain-English summary leads the stage log: what carries the song, what was fighting it, what was left alone and why. The measured margin change comes after it, followed by per-stage cards with heard / changed / why / listen-for.
- **Stage audition.** Buttons for Original → After each stage → Rebuilt mix (which includes Vocal Layer Cleanup). Playback is level-matched to the original by default and keeps its position when switching. Stages that are not in memory are replayed deterministically from the original and the kept decisions, so this works for songs of any length.
- **Fit score no longer counts narrowness as leakage** (`app-forensics.js` `mfStemQuality`). The old `|widthDb| − 18` penalty marked clean, centred vocal stems as leaky, down to the 35% floor on a mono stem. Extreme width and anti-phase are still penalised. This fix surfaced in the browser check: without it, the new "do not process" gate would have skipped every stem.
- **Stem cards tell the truth after a rebuild.** Before a rebuild, each card says its list is only a starting point. After a rebuild, the cards are re-rendered with the moves that were actually kept and the stage that kept them.
- **The mix bus is the last plan step.** It is shown explicitly, and it uses the existing mastering chain, which runs only after the stems are placed.

## Not done (next iterations from the handoff)

- Section-aware decisions and automation. The forensic timeline exists, but stage decisions are still static across the song.
- Finer source types. Demucs "other" still lumps guitars, keys and ambience together.
- Stereo placement and depth stages.
- AI-written explanations. The text is deterministic and built from measurements. The AI stem plan from `/api/analyze` is still produced but is superseded by the sequential decisions at rebuild time.
- The Producer's Ear branch (`feature/producers-ear-review`, based on 2.5.0) was not merged.

## Relationship to PR #17

PR #17 (`codex/mastering-correctness-audit`) is still open. Its `app-sequential-mixing.js` changes are ported here as the first commit, and this branch builds on them. If PR #17 merges first, expect a conflict in that one file: take this branch's version. PR #17's `app-dom-integrity.js` guard becomes redundant but harmless once this fix is in.

## Verification

`tests/sequential-mixing-smoke.mjs` runs the real metering code against synthetic stems: a gated vocal, a guitar bed in the vocal range, bass and kick. It checks:
- the anchor and stage order
- that the stage log renders when the stem cards contain nested `.actions` rows (this fails on the previous file)
- that the guitar carve raises the measured lead margin (−1.9 → −1.2 dB on the synthetic mix)
- that each stage starts from the mix the previous stage left
- that the original is never modified
- that a stage replay is sample-identical to the rendered mix
- that vocal bleed blocks the vocal-range carve
- instrumental anchoring
- that a stage which makes things worse is tried at half strength and then undone
- that a poor separation is not processed
- that a timing mismatch fails without falling back

A real-Chromium check was also run: the actual `index.html`, the full wrapper chain, real `OfflineAudioContext` rendering, and Vocal Layer Cleanup's nested controls present. It confirmed the stage log renders, nothing falls back, and the stage player plays level-matched. The test cannot judge musical quality. That still needs listening, and the stage player exists for that.
