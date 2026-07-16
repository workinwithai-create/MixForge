# iOS upload/decode hardening

MixForge 1.0.1 separates file reading and decoding from AudioContext playback activation. It uses FileReader progress events, callback-based Safari decoding, bounded timeouts, and actionable iCloud errors instead of allowing an indefinite spinner.
