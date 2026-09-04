# Mobile onboarding verification

MixForge 2.5 mobile onboarding is a first-run coach plus iOS Files guidance. It is not a native App Store install.

## What must work on an iPhone

1. Open https://mixforge.workinwithai.com (brand domain) or https://mix-forge.vercel.app.
2. First visit shows the sheet: load a mix → scan → Quick Master or Forensic Fix → download WAV.
3. Tap **Choose a mix**. The Files picker accepts WAV, AIFF, M4A, MP3, CAF.
4. If the song is only in iCloud, Files → Download Now, then pick it again. The app must not spin forever.
5. After a successful decode, **Scan mix** is enabled.
6. After a master renders, **Download release WAV** is reachable without horizontal scroll.
7. Add to Home Screen uses `site.webmanifest` + the apple touch icon.

## Not claimed by this milestone

- Real Hub checkout and license delivery (separate milestone).
- Certified EBU metering.
- Stem separation quality.

## Regression

`npm test` includes `tests/mobile-onboard-smoke.mjs`.
