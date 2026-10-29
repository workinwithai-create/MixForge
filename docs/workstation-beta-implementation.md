# MixForge workstation UI — beta implementation

## Product ownership
This interface belongs to **MixForge**, which is the canonical audio correction and mastering engine. Pipe Dreams Studio's **production Warehouse Mix Room** already embeds that same MixForge deployment via `warehouse/room-registry.js` and `warehouse/mix-room.js`. It is not part of the separate game **Pipe Dreams Studio: The Experience**.

## Intent
Keep the approved dark, copper-accented, channel-strip / section-editor / forensic-repair visual language. Put actual audio controls on top of the existing MixForge pipeline, without inventing audio measurements, faking instrument sources, or replacing the sequential DSP/master code.

## Implemented on this gated branch
- Optional "Open MixForge Workstation · preview" launcher after the current MixForge hero.
- Actual available stem buffers become channel strips. Before separation, show only the stereo mix; Demucs's `vocals`, `drums`, `bass`, and `other` remain the canonical four buckets rather than pretending guitar and atmosphere are isolated.
- Mute, solo and per-track dB adjustments control the non-destructive browser Web Audio audition.
- Workstation timeline is drawn from **real source/stem sample peaks**; one selected section has start/end controls and a playhead.
- Clip gain, crossfades, and a time-bounded peaking EQ can be auditioned without modifying MixForge's original, corrected, or mastered AudioBuffers.
- Split marker, visual repair catalogue and edit-note JSON export.
- Existing original MixForge UI, source-analysis pipeline, source-separation procedures, sequential correction, verification, receipts, licensing, export, and Warehouse postMessage handoffs are preserved.

## Boundaries and unfinished functionality
- Split presently places a **marker**. Cutting, moving, ripple editing, and rebuilding the source render are not yet implemented.
- Only EQ and clip gain/fade audition have real Web Audio signal operations in this beta. De-essing, spectral repair, cleanup, automation and masking tiles are interface targets that must be connected to proven MixForge processors with receipts, A/B listening, and rollback.
- The workstation's preview renders into the browser speakers but does **not** write to `state.corrected`, `state.master`, or export audio.
- Stem isolation, original/processed mix identity, loudness verification, and production release approval remain owned by the existing pipeline.

## Release gates
1. Load stereo-only WAV and confirm exactly one stereo lane, no false instrument attribution.
2. Run source investigation and confirm the exact available separated buckets and independent solo/mute.
3. Compare with all lanes active, then solo only vocals, then solo drums; verify no outside MixForge transport double-playback.
4. Validate stem gain changes, section start/end, gain/fades, EQ, pause/resume, and no signal discontinuities on iPhone Safari and desktop Chrome.
5. Confirm reopening the workstation after loading a different song does not retain incompatible edits or mute/solo state.
6. Verify preview never changes the canonical corrected/master audio or its receipts and that existing Forensic Fix, Quick Master, paid entitlement and release WAV export still work.
7. Test Warehouse Mix Room iframe sizing, mobile scrolling, PIPE_DREAMS_SONG_HANDOFF, release-ready message routing and account session bridge.
8. Compare screenshots against the approved MixForge design direction and refine accessibility, slider hit targets, and narrow mobile layouts.

Do not merge or deploy until these checks pass; PR is deliberately draft.
