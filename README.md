# MixForge

MixForge is a browser forensic release-prep pipeline — not a one-click loudness clone.

LANDR, eMastered, BandLab Mastering, CloudBounce, and RoEx win on making a file louder in one click. MixForge wins on evidence: measure → locate problem windows → optional honest stem repair → conservative master → show measured change. It does not claim musical improvement.

1. Audit a stereo mix. Measurements are ground truth for clip %, LUFS, sample peak, correlation, and DC.
2. Optional Gemini listening pass hears a compact mix excerpt (not a vocal performance take). Performance / pitch / timing lives in [AuraMix](https://auramix.workinwithai.com).
3. Choose **Quick Master** (stereo release master + Original vs Master A/B) or **Forensic Fix** (timeline + opt-in stems + targeted repair). Quick Master skips Isolate / Confirm / Repair.
4. When a mix needs stem work, split it once into all four parts (Demucs via RunPod: vocals / bass / drums / other) and keep all four. Guitars and keys are not confirmable stems — they share residual other. A song opened from the library with its stems already saved is never split again.
5. Measure and repair affected stems conservatively.
6. Rebuild the original mix with the corrected stem deltas.
7. Master the corrected mix conservatively. Reference-bounded tonal language is used only when a reference file is loaded.
8. Verify loudness, peak safety, clipping, dynamics, and mono compatibility.
9. Export a 24-bit or 16-bit WAV. Stale masters cannot export. Clipping or true-peak over ceiling blocks export unless you explicitly override.

Thesis: evidence-first, conservative repairs, show measured change (loudness, peak, remaining risks). MixForge is mix repair + release master; dedicated vocal production lives in AuraMix.

## Two ways in, one mix stage

1. **One finished mix.** Drop it in and scan it. Quick Master masters the stereo file. If the mix needs stem work, MixForge splits it once into all four parts (vocals, drums, bass, other), keeps all four, and mixes from those.
2. **Your own stems from your DAW.** "Or bring your stems" in the load panel, or drop several files at once. Each file is read in the browser (nothing is uploaded, nothing is split), given one of the four mix groups from its name (you can change it), and mixed from there. Up to 24 files; export each one from the very start of the song.

Either way the same mix stage runs before mastering, so the master has something that is ready for it:

- **Levels.** A part that is clearly out of range is moved on its fader, where you can see, hear and undo it: a band part that is close to inaudible, or a vocal more than 6 LU under or over the band. At most 6 dB in total, with the reason in words. A fader you set yourself is never moved.
- **EQ and dynamics.** Each group is placed against the ones already placed: the lead first, then what competes with it, then the low end, then the groove. A move that leaves the mix measuring worse is halved, then undone.
- **Automation.** The lead vocal's level is ridden phrase by phrase: lifted where it drops under the band, eased where it jumps out, up to +3 / −2 dB, ramped. Kept only if the mix does not measure worse.
- Every stage can be auditioned, and every move has a receipt.

The level ranges and ride limits are product heuristics, written down in `js/app-auto-mix-core.js`. They fix what is measurably off; they are not a taste engine, and MixForge does not claim the result is how an engineer would have mixed it.

## Songs and stems

A song lives in the shared WorkinWithAI song library with its mix, stems and masters attached. MixForge works on that song and saves back to it, so a track is uploaded once and split once.

1. **Save.** After a separation, "Save mix + stems to my song library" keeps the original mix and every stem on one song (`library.html` lists them).
2. **Open.** `/?song=<id>&asset=<id>` opens one file of a song; stems saved afterwards join the same song.
3. **Put back together.** `/?song=<id>&rebuild=stems` loads the song's stems into a small mixer: a level, Mute and Solo per stem, and Play together. Solo is for listening only.
4. **Stem check.** As soon as the stems load they are checked against each other (same length, none near-empty, no two carrying the same part). If the song still has its original mix, "Compare with the original mix" says whether the stems add back up to it, and "Hear what the stems leave out" plays the leftover. It runs in the browser on the first 90 seconds; nothing is uploaded. A good result does not prove a stem holds only its own part.
5. **Mix and master.** The saved stems go straight to the stem stage (no upload, no separation job), the sequential mix is built, the release master is rendered, and the master is saved to the same song. It is saved only if it passes the same hard checks as Download release WAV (no clipping, peak under the ceiling).
6. **Receipts.** Every stage of the mix shows a correction receipt: the measured problem, the exact settings proposed, before/after measurements, both attempts, and an accepted / reduced / held / rejected verdict. "Download the receipt for this run" gives one JSON file with the stems and levels, the stem check, those corrections, the master's measurements and whether it was saved. Names and numbers only, no audio.

`stem-reliability-lab.html` is the same stem check as a standalone page for comparing separators: load any mix and its stems from disk (up to six buses plus residual) and download an audit report. Both use `js/app-stem-reliability-core.js`.

## Testing a preview while signed in

Sign-in is a cookie on `.workinwithai.com`. A Vercel preview address ends in `vercel.app`, so the browser never sends that cookie from it and the Hub does not accept it as a place to return to. That is why Sign in on a `vercel.app` preview lands on the live site: such a preview can only test the free, signed-out parts.

To test a branch signed in, serve it from an address on the same domain. `mix.workinwithai.com` is already attached to the Vercel project and already allowed everywhere the live address is (Hub sign-in return, entitlements, product token, checkout, song library, and the `separate-stem` and `stem-library` functions), so nothing needs redeploying:

1. DNS for `workinwithai.com`: a `CNAME` record for `mix` pointing to `cname.vercel-dns.com` (once).
2. Vercel → mix-forge → Settings → Domains → `mix.workinwithai.com` → Edit → set **Git Branch** to the branch under test.

Open `https://mix.workinwithai.com`, sign in, and you stay on that address. Every sign-in link in the app returns to the address it was opened from when that address is on `workinwithai.com`, and to the live site otherwise. The version in the page header tells you which build you are looking at. The address is public once it has a DNS record (Vercel's own login only guards `vercel.app` previews), and whatever branch it points at runs with the signed-in member's session, so point it only at branches you trust.

## Competitor benchmarking

`tools/master-diff.mjs` compares an original mix with a master returned by any service (LANDR, eMastered, Ozone, MixForge itself) and reports the loudness target, true-peak ceiling, effective EQ curve, per-band compression, stereo width and gain reduction. It measures audio only. See `docs/competitor-benchmarking.md`.

## License and checkout

Stereo audit stays free. Quick Master, Forensic Fix, and WAV export require an active MixForge (`mix`) or Forge Pass (`bundle`) entitlement.

- Live Hub checkout: `POST https://workinwithai.com/api/checkout` with `{ lookupKey, returnTo }`.
  - MixForge monthly lookup key: `mix-monthly` ($9)
  - Forge Pass lookup key: `forge-pass-monthly` ($24)
  - `returnTo` must be first-party (`https://mixforge.workinwithai.com/`)
- Live Hub identity: `GET https://workinwithai.com/api/entitlements/me` returns `{ signedIn, hasMix, hasBundle, reason, loginUrl, checkoutLookupKeys }`.
- Local license issuer: `GET /api/entitlement` signs a 12-hour MixForge license when `MIXFORGE_LICENSE_SECRET` is set.
- The client never treats `ungated-preview` as entitled.

### Extra Vercel env for billing
- `MIXFORGE_LICENSE_SECRET` — HMAC secret for local license tokens (Production and Preview)
- `HUB_SUPABASE_ANON_KEY` — Hub identity project anon key (`kldstbhnpwpvvubphnas`)
- `HUB_SUPABASE_URL` (optional; defaults to the Hub identity project)
- `MIXFORGE_ADMIN_EMAILS` (optional comma list in addition to founder addresses)

## Required environment variables

### Vercel
- `GEMINI_API_KEY` — native-audio listening pass on the stereo mix audit. The API route reads **only** `process.env.GEMINI_API_KEY`. Set it on the Vercel mix-forge project for **Production and Preview**. No key is shipped in the client or repo.
- `GEMINI_MODEL` (optional; defaults to `gemini-3.8-flash`)
- `ANTHROPIC_API_KEY` — optional; used only for stem-plan text after isolation
- `ANTHROPIC_MODEL` (optional; defaults to `claude-sonnet-5`)

`GET /api/analyze` reports `{ listeningConfigured: true|false }` without exposing the key. If the env var is missing, the client skips the excerpt upload and says: “Listening model not configured — using measurements only.” Claude is not used to restate numbers it cannot hear.

### Supabase Edge Function (`separate-stem`)
- `RUNPOD_ENDPOINT_ID`
- `RUNPOD_API_KEY`
- Supabase-provided `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_ANON_KEY`

Stem-separation quota: 12 stems/hour and 30/day.

Music.ai is retired for this path and must not be configured as a fallback.

## Storage

The app uploads unreleased mixes to the private `audio` bucket. The Edge Function creates a short-lived signed URL for the RunPod separator and deletes the source upload after the separation job completes.

## Production readiness (2026-10-01)

Criteria for calling MixForge shipped (all must be true):

| Criterion | Status | Evidence |
| --- | --- | --- |
| Complete source on GitHub | **Met** | Public repo `workinwithai-create/MixForge`, full tree including `api/`, `js/`, `supabase/`, `tests/`, RunPod separator |
| Permanent live deployment works | **Met** | https://mixforge.workinwithai.com returns the 2.7.1 shell; Vercel project `mix-forge`; `GET /api/analyze` reports `{ listeningConfigured: true }` (re-checked 2026-10-01) |
| Real checkout and license delivery connected | **Met** | Hub `POST /api/checkout` + `GET /api/entitlements/me` returns `mix-monthly` / `forge-pass-monthly`; MixForge `/api/entitlement` is fail-closed for anonymous (`reason: anonymous`, first-party `returnTo`); founder override + Supabase entitlement rows; license bar + mobile checkout paths live |
| Core exports tested | **Met** | `tests/export-state-smoke.mjs`, `tests/license-gate-smoke.mjs`, `tests/mastering-grade-smoke.mjs`, `tests/live-production-health-smoke.mjs` and related smoke suite; export blocked when unlicensed or stale |
| Mobile onboarding verified | **Partial** | Coach + in-app-browser Safari warning + A2HS copy + `docs/mobile-onboarding.md` + `docs/iphone-signoff.md` + `tests/mobile-onboard-smoke.mjs`. Real-device sign-off on a physical iPhone is still required |

**Not shipped.** Next production-ready milestone remains human: fill `docs/iphone-signoff.md` on a physical iPhone (Safari, Files Download Now, free scan, licensed WAV download, Add to Home Screen). Automated smokes cannot close that row.

Do not invent additional gating criteria. When the iPhone checklist is signed off, remove the Partial row and the “Not shipped” language permanently.
