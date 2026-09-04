import fs from 'node:fs';
import assert from 'node:assert/strict';

const handler = fs.readFileSync(new URL('../runpod-separator/handler.py', import.meta.url), 'utf8');
assert.match(handler, /CANONICAL_STEMS = \{"vocals", "bass", "drums", "other"\}/);
assert.match(handler, /STEM_ALIASES = \{"guitars": "other", "keys": "other"\}/);
assert.doesNotMatch(handler, /"instrumental": "other"/);
assert.match(handler, /SUPPORTED_ENGINES = \{"demucs", "melband", "auto"\}/);
assert.match(handler, /SEPARATION_SAMPLE_RATE = 44100/);
assert.match(handler, /SEPARATION_CHANNELS = 2/);
assert.match(handler, /MELBAND_CHECKPOINT_FILE = "MelBandRoformer\.ckpt"/);
assert.match(handler, /MELBAND_CHECKPOINT_SHA256_DEFAULT = "87201f4d31afb5bc79993230fc49446918425574db48c01c405e44f365c7559e"/);
assert.match(handler, /def normalize_stems/);
assert.match(handler, /def prepare_source/);
assert.match(handler, /"ffmpeg"/);
assert.match(handler, /"pcm_s16le"/);
assert.match(handler, /prepare_source\(downloaded, source\)/);
assert.match(handler, /def choose_engine/);
assert.match(handler, /ENABLE_MELBAND/);
assert.match(handler, /env_enabled\("ENABLE_MELBAND", False\)/);
assert.match(handler, /return "hybrid", "MelBand supplies the quality vocal stem; Demucs remains authoritative for bass, drums, and residual other\."/);
assert.match(handler, /MixForge 'other' is a Demucs residual bucket, not a full instrumental/);
assert.match(handler, /demucs_files, demucs_model = run_demucs/);
assert.match(handler, /files\["vocals"\] = vocals/);
assert.match(handler, /stem_sources\["vocals"\] = "melband"/);
assert.match(handler, /def melband_provenance/);
assert.match(handler, /"checkpointSha256"/);
assert.match(handler, /"checkpointBakedIntoImage"/);
assert.match(handler, /"checkpointAvailable"/);
assert.match(handler, /"imageRevision": os\.getenv\("MIXFORGE_SEPARATOR_REVISION", "unknown"\)/);
assert.doesNotMatch(handler, /ALLOWED_STEMS = \{.*"guitars"/);
assert.match(handler, /file_path = model_dir \/ f"\{stem\}\.wav"/);
assert.match(handler, /"separator": \{/);
assert.match(handler, /"models": models/);
assert.match(handler, /"modelProvenance": model_provenance/);
assert.match(handler, /"stemSources": stem_sources/);
assert.match(handler, /"routingNote": routing_note/);
assert.match(handler, /"inputNormalization": \{/);

const benchmark = fs.readFileSync(new URL('../runpod-separator/benchmark.py', import.meta.url), 'utf8');
assert.match(benchmark, /def benchmark_provenance/);
assert.match(benchmark, /"separatorImageRevision": os\.getenv\("MIXFORGE_SEPARATOR_REVISION", "unknown"\)/);
assert.match(benchmark, /"melbandCheckpointSha256": os\.getenv\("MELBAND_CHECKPOINT_SHA256", MELBAND_CHECKPOINT_SHA256_DEFAULT\)/);
assert.match(benchmark, /"melbandCheckpointBakedIntoImage": env_enabled\("MELBAND_PRELOADED", False\)/);
assert.match(benchmark, /json\.dumps\(\{"provenance": provenance, "tracks": summary\}/);

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
assert.match(upload, /SEPARATION_POLL_INTERVAL_MS = 2500/);
assert.match(upload, /SEPARATION_MAX_POLLS = 240/);
assert.match(upload, /attempt < SEPARATION_MAX_POLLS/);
assert.match(upload, /state\.separationInfo = status\.separator/);

const dockerfile = fs.readFileSync(new URL('../runpod-separator/Dockerfile', import.meta.url), 'utf8');
assert.match(dockerfile, /ARG PRELOAD_MELBAND=false/);
assert.match(dockerfile, /ARG BUILD_REVISION=unknown/);
assert.match(dockerfile, /ENV ENABLE_MELBAND=false/);
assert.match(dockerfile, /SEPARATION_ENGINE=demucs/);
assert.match(dockerfile, /MELBAND_ROFORMER_MODELS_PATH=\/opt\/mixforge\/models/);
assert.match(dockerfile, /MELBAND_CHECKPOINT_SHA256=87201f4d31afb5bc79993230fc49446918425574db48c01c405e44f365c7559e/);
assert.match(dockerfile, /MELBAND_PRELOADED=\$\{PRELOAD_MELBAND\}/);
assert.match(dockerfile, /MIXFORGE_SEPARATOR_REVISION=\$\{BUILD_REVISION\}/);
assert.match(dockerfile, /melband-roformer-infer --help/);
assert.match(dockerfile, /melband-roformer-download --help/);
assert.match(dockerfile, /melband-roformer-download/);
assert.match(dockerfile, /sha256sum/);

const init = fs.readFileSync(new URL('../js/app-init.js', import.meta.url), 'utf8');
assert.match(init, /const STEMS = \['vocals', 'bass', 'drums', 'other'\]/);
assert.doesNotMatch(init, /'guitars'/);

const analyze = fs.readFileSync(new URL('../api/analyze.js', import.meta.url), 'utf8');
assert.match(analyze, /canonicalStem/);
assert.doesNotMatch(analyze, /guitars', 'keys', 'other'/);

console.log('stems-normalize-smoke: ok');
