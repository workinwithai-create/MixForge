import fs from 'node:fs';
import assert from 'node:assert/strict';

const handler = fs.readFileSync(new URL('../runpod-separator/handler.py', import.meta.url), 'utf8');
assert.match(handler, /CANONICAL_STEMS = \{"vocals", "bass", "drums", "other"\}/);
assert.match(handler, /STEM_ALIASES = \{"guitars": "other", "keys": "other"\}/);
assert.doesNotMatch(handler, /"instrumental": "other"/);
assert.match(handler, /SUPPORTED_ENGINES = \{"demucs", "melband", "auto"\}/);
assert.match(handler, /def normalize_stems/);
assert.match(handler, /def choose_engine/);
assert.match(handler, /ENABLE_MELBAND/);
assert.match(handler, /env_enabled\("ENABLE_MELBAND", False\)/);
assert.match(handler, /return "hybrid", "MelBand supplies the quality vocal stem; Demucs remains authoritative for bass, drums, and residual other\."/);
assert.match(handler, /MixForge 'other' is a Demucs residual bucket, not a full instrumental/);
assert.match(handler, /demucs_files, demucs_model = run_demucs/);
assert.match(handler, /files\["vocals"\] = vocals/);
assert.match(handler, /stem_sources\["vocals"\] = "melband"/);
assert.doesNotMatch(handler, /ALLOWED_STEMS = \{.*"guitars"/);
assert.match(handler, /file_path = model_dir \/ f"\{stem\}\.wav"/);
assert.match(handler, /"separator": \{/);
assert.match(handler, /"models": models/);
assert.match(handler, /"stemSources": stem_sources/);
assert.match(handler, /"routingNote": routing_note/);

const edge = fs.readFileSync(new URL('../supabase/functions/separate-stem/index.ts', import.meta.url), 'utf8');
assert.match(edge, /vocals.*bass.*drums.*other/);
assert.match(edge, /guitars: "other"/);
assert.doesNotMatch(edge, /instrumental: "other"/);
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
