import fs from 'node:fs';
import assert from 'node:assert/strict';

const handler = fs.readFileSync(new URL('../runpod-separator/handler.py', import.meta.url), 'utf8');
assert.match(handler, /CANONICAL_STEMS = \{"vocals", "bass", "drums", "other"\}/);
assert.match(handler, /STEM_ALIASES = \{"guitars": "other", "keys": "other"\}/);
assert.match(handler, /def normalize_stems/);
assert.doesNotMatch(handler, /ALLOWED_STEMS = \{.*"guitars"/);
assert.match(handler, /file_path = model_dir \/ f"\{stem\}\.wav"/);

const edge = fs.readFileSync(new URL('../supabase/functions/separate-stem/index.ts', import.meta.url), 'utf8');
assert.match(edge, /vocals.*bass.*drums.*other/);
assert.match(edge, /guitars: "other"/);
assert.doesNotMatch(edge, /ALLOWED_STEMS = new Set\(\["vocals", "bass", "drums", "guitars"/);

const init = fs.readFileSync(new URL('../js/app-init.js', import.meta.url), 'utf8');
assert.match(init, /const STEMS = \['vocals', 'bass', 'drums', 'other'\]/);
assert.doesNotMatch(init, /'guitars'/);

const analyze = fs.readFileSync(new URL('../api/analyze.js', import.meta.url), 'utf8');
assert.match(analyze, /canonicalStem/);
assert.doesNotMatch(analyze, /guitars', 'keys', 'other'/);

console.log('stems-normalize-smoke: ok');
