# Mobile onboarding verification

MixForge 2.6.1 mobile onboarding is a first-run coach plus iOS Files guidance. It is not a native App Store install.

## What must work on an iPhone

1. Open https://mixforge.workinwithai.com in **Safari** (brand domain) or https://mix-forge.vercel.app.
2. First visit shows the sheet: load a mix → scan → Quick Master or Forensic Fix → download WAV.
3. Tap **Choose a mix**. The Files picker accepts WAV, AIFF, M4A, MP3, CAF.
4. If the song is only in iCloud, Files → Download Now, then pick it again. The app must not spin forever.
5. After a successful decode, **Scan mix** is enabled.
6. After a master renders, **Download release WAV** encodes, then **Save release WAV to Files** is a second tap (iPhone drops blob downloads started after `await`). The save control is sticky above the home indicator. If the browser can share files, the share sheet writes to Files.
7. Add to Home Screen uses `site.webmanifest` + the apple touch icon (Share → Add to Home Screen).
8. The license bar must leave **Checking MixForge license…** within a few seconds. Anonymous phones show Sign in, not a hung check.
9. A Hub license is account-based, not stored on the device. Sign in on *this* browser. In-app browsers (Grok, Instagram, Mail) do not share Safari cookies, so an existing Hub login will look like “no license.” The coach now detects that case and tells the musician to Open in Safari.

## Remote checks logged 2026-09-30

- Brand domain https://mixforge.workinwithai.com returns the live MixForge shell.
- Hub identity `GET https://workinwithai.com/api/entitlements/me` returns structured JSON with `hasMix`, `hasBundle`, `checkoutLookupKeys.mix = mix-monthly`, and `reason: login` when anonymous.
- These checks do **not** replace physical iPhone sign-off.

## Not claimed by this milestone

- Certified EBU metering.
- Stem separation quality.
- Physical iPhone sign-off of the Files / Download Now / Add to Home Screen path. See `docs/iphone-signoff.md`.

## Regression

`npm test` includes `tests/mobile-onboard-smoke.mjs`.
`tests/license-gate-smoke.mjs` covers entitlement copy.

Classic scripts must not share a top-level `const MF_HUB_ORIGIN` — that SyntaxError freezes the license bar.
