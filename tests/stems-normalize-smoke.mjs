import fs from 'node:fs';
import assert from 'node:assert/strict';

const handler = fs.readFileSync(new URL('../runpod-separator/handler.py', import.meta.url), 'utf8');
assert.match(handler, /CANONICAL_STEMS = \{"vocals", "bass", "drums", "other"\}/);
assert.match(handler, /STEM_ALIASES = \{"guitars": "other", "keys": "other", "instrumental": "other"\}/);
assert.match(handler, /MELBAND_STEMS = \{"vocals", "other"\}/);
assert.match(handler, /SUPPORTED_ENGINES = \{"demucs", "melband", "auto"\}/);
assert.match(handler, /def normalize_stems/);
assert.match(handler, /def choose_engine/);
assert.match(handler, /ENABLE_MELBAND/);
assert.match(handler, /env_enabled\("ENABLE_MELBAND", False\)/);
assert.match(handler, /engine = "melband" if quality and set\(requested\)\.issubset\(MELBAND_STEMS\) else "demucs"/);
assert.match(handler, /MelBand quality route currently supports vocals \+ instrumental only/);
assert.doesNotMatch(handler, /ALLOWED_STEMS = \{.*"guitars"/);
assert.doesNotMatch(handler, /MELBAND_STEMS = \{[^}]*"bass"/);
assert.doesNotMatch(handler, /MELBAND_STEMS = \{[^}]*"drums"/);
assert.match(handler, /file_path = model_dir \/ f"\{stem\}\.wav"/);
assert.match(handler, /"separator": \{/);
assert.match(handler, /"model": model/);
assert.match(handler, /"fallbackReason": fallback_reason/);

const edge = fs.readFileSync(new URL('../supabase/functions/separate-stem/index.ts', import.meta.url), 'utf8');
assert.match(edge, /vocals.*bass.*drums.*other/);
assert.match(edge, /guitars: "other"/);
assert.match(edge, /instrumental: "other"/);
assert.match(edge, /SUPPORTED_ENGINES = new Set\(\["demucs", "melband", "auto"\]\)/);
assert.match(edge, /SUPPORTED_MODES = new Set\(\["fast", "quality", "forensic", "hq"\]\)/);
assert.match(edge, /input: \{ inputUrl, stems, uploadUrls, engine, mode \}/);
assert.match(edge, /separator: job\?\.output\?\.separator \|\| null/);
assert.doesNotMatch(edge, /ALLOWED_STEMS = new Set\(\["vocals", "bass", "drums", "guitars"/);

const upload = fs.readFileSync(new URL('../js/app-upload.js', import.meta.url), 'utf8');
assert.match(upload, /FORENSIC_SEPARATION_REQUEST = Object\.freeze\(\{ engine: 'auto', mode: 'quality' \}\)/);
assert.match(upload, /state\.separationInfo = status\.separator/);

const init = fs.readFileSync(new URL('../js/app-init.js', import.meta.url), 'utf8');
assert.match(init, /const STEMS = \['vocals', 'bass', 'drums', 'other'\]/);
assert.doesNotMatch(init, /'guitars'/);

const analyze = fs.readFileSync(new URL('../api/analyze.js', import.meta.url), 'utf8');
assert.match(analyze, /canonicalStem/);
assert.doesNotMatch(analyze, /guitars', 'keys', 'other'/);

console.log('stems-normalize-smoke: ok');
