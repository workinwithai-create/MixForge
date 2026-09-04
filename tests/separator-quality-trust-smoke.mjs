import fs from 'node:fs';
import assert from 'node:assert/strict';

const handler = fs.readFileSync(new URL('../runpod-separator/handler.py', import.meta.url), 'utf8');
assert.match(handler, /MELBAND_APPROVED_MODEL = "melband-roformer-kim-vocals"/);
assert.match(handler, /MELBAND_QUALITY_STATUSES = \{"hold", "candidate", "approved"\}/);
assert.match(handler, /def requested_melband_quality_status/);
assert.match(handler, /def melband_identity_is_locked/);
assert.match(handler, /model == MELBAND_APPROVED_MODEL and checkpoint_sha == MELBAND_CHECKPOINT_SHA256_DEFAULT/);
assert.match(handler, /if requested == "approved" and not melband_identity_is_locked\(\):\n        return "candidate"/);
assert.match(handler, /if quality_status == "hold":\n        return "demucs"/);
assert.match(handler, /"qualityStatusRequested": requested_melband_quality_status\(\)/);
assert.match(handler, /"qualityStatus": melband_quality_status\(\)/);
assert.match(handler, /"identityLockedForApproval": melband_identity_is_locked\(\)/);

const ui = fs.readFileSync(new URL('../js/app-separation-provenance.js', import.meta.url), 'utf8');
assert.match(ui, /const scoreCap = hold \? 55 : 79/);
assert.match(ui, /const maxWet = hold \? 0\.10 : 0\.24/);
assert.match(ui, /const operationFactor = hold \? 0\.45 : 0\.72/);
assert.match(ui, /if \(hold\) plan\.selectedCandidate = 0/);
assert.match(ui, /else if \(\(plan\.selectedCandidate \?\? 1\) > 1\) plan\.selectedCandidate = 1/);
assert.match(ui, /Candidate MelBand vocal/);
assert.match(ui, /model trust \$\{trust\.status\}/);

const dockerfile = fs.readFileSync(new URL('../runpod-separator/Dockerfile', import.meta.url), 'utf8');
assert.match(dockerfile, /MELBAND_QUALITY_STATUS=candidate/);

console.log('separator-quality-trust-smoke: ok');
