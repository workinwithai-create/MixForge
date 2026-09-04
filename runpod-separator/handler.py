import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import requests
import runpod

CANONICAL_STEMS = {"vocals", "bass", "drums", "other"}
STEM_ALIASES = {"guitars": "other", "keys": "other"}
SUPPORTED_ENGINES = {"demucs", "melband", "auto"}
SEPARATION_SAMPLE_RATE = 44100
SEPARATION_CHANNELS = 2
MELBAND_CHECKPOINT_FILE = "MelBandRoformer.ckpt"
MELBAND_CHECKPOINT_SHA256_DEFAULT = "87201f4d31afb5bc79993230fc49446918425574db48c01c405e44f365c7559e"


def normalize_stems(stems):
    out = []
    for stem in stems or []:
        actual = STEM_ALIASES.get(str(stem).lower(), str(stem).lower())
        if actual in CANONICAL_STEMS and actual not in out:
            out.append(actual)
    return out


def env_enabled(name: str, default=False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def download(url: str, destination: Path) -> None:
    with requests.get(url, stream=True, timeout=180) as response:
        response.raise_for_status()
        with destination.open("wb") as handle:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    handle.write(chunk)


def upload(url: str, source: Path) -> None:
    with source.open("rb") as handle:
        response = requests.put(url, data=handle, headers={"Content-Type": "audio/wav"}, timeout=300)
    response.raise_for_status()


def run_command(command, timeout_seconds):
    completed = subprocess.run(command, capture_output=True, text=True, timeout=timeout_seconds)
    if completed.returncode != 0:
        message = completed.stderr[-4000:] or completed.stdout[-4000:] or "separator failed"
        raise RuntimeError(message)


def prepare_source(downloaded: Path, destination: Path):
    run_command([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(downloaded),
        "-vn", "-ac", str(SEPARATION_CHANNELS), "-ar", str(SEPARATION_SAMPLE_RATE),
        "-c:a", "pcm_s16le", str(destination),
    ], 300)
    if not destination.exists() or destination.stat().st_size <= 44:
        raise RuntimeError("Could not prepare a valid PCM WAV for separation")


def choose_engine(payload, requested):
    requested_engine = str(payload.get("engine") or os.getenv("SEPARATION_ENGINE", "demucs")).lower()
    if requested_engine not in SUPPORTED_ENGINES:
        requested_engine = "demucs"
    quality = str(payload.get("mode") or "").lower() in {"quality", "forensic", "hq"}
    melband_enabled = env_enabled("ENABLE_MELBAND", False)
    requested_set = set(requested)
    if requested_engine == "demucs":
        return "demucs", None
    if not melband_enabled:
        return "demucs", "MelBand quality routing is installed but disabled on this worker; used Demucs."
    if requested_engine == "melband":
        if requested_set == {"vocals"}:
            return "melband", None
        return "demucs", "MelBand can safely replace only the canonical vocal stem. MixForge 'other' is a Demucs residual bucket, not a full instrumental; used Demucs to preserve source semantics."
    if quality and "vocals" in requested_set:
        if requested_set == {"vocals"}:
            return "melband", None
        return "hybrid", "MelBand supplies the quality vocal stem; Demucs remains authoritative for bass, drums, and residual other."
    return "demucs", None


def run_demucs(source: Path, output_dir: Path, requested):
    model = os.getenv("DEMUCS_MODEL", "htdemucs")
    run_command([
        "python", "-m", "demucs", "--name", model, "--out", str(output_dir),
        "--device", "cuda", str(source),
    ], 900)
    model_dir = output_dir / model / source.stem
    outputs = {}
    for stem in requested:
        file_path = model_dir / f"{stem}.wav"
        if not file_path.exists():
            raise RuntimeError(f"Missing {stem} Demucs output")
        outputs[stem] = file_path
    return outputs, model


def first_match(root: Path, suffix: str):
    matches = sorted(root.rglob(f"*{suffix}"))
    return matches[0] if matches else None


def melband_provenance(model):
    models_root = Path(os.getenv("MELBAND_ROFORMER_MODELS_PATH", "~/.cache/melband-roformer-infer")).expanduser()
    checkpoint_path = models_root / model / MELBAND_CHECKPOINT_FILE
    return {
        "model": model,
        "checkpoint": MELBAND_CHECKPOINT_FILE,
        "checkpointSha256": os.getenv("MELBAND_CHECKPOINT_SHA256", MELBAND_CHECKPOINT_SHA256_DEFAULT),
        "checkpointBakedIntoImage": env_enabled("MELBAND_PRELOADED", False),
        "checkpointAvailable": checkpoint_path.exists(),
    }


def worker_capabilities():
    melband_model = os.getenv("MELBAND_MODEL", "melband-roformer-kim-vocals")
    return {
        "ok": True,
        "action": "capabilities",
        "separator": {
            "imageRevision": os.getenv("MIXFORGE_SEPARATOR_REVISION", "unknown"),
            "defaultEngine": os.getenv("SEPARATION_ENGINE", "demucs"),
            "supportedEngines": sorted(SUPPORTED_ENGINES),
            "canonicalStems": ["vocals", "bass", "drums", "other"],
            "demucsModel": os.getenv("DEMUCS_MODEL", "htdemucs"),
            "melbandEnabled": env_enabled("ENABLE_MELBAND", False),
            "melband": melband_provenance(melband_model),
            "inputNormalization": {
                "format": "pcm_s16le",
                "sampleRate": SEPARATION_SAMPLE_RATE,
                "channels": SEPARATION_CHANNELS,
            },
        },
    }


def run_melband_vocals(source: Path, output_dir: Path):
    model = os.getenv("MELBAND_MODEL", "melband-roformer-kim-vocals")
    input_dir = source.parent / "melband-input"
    input_dir.mkdir(parents=True, exist_ok=True)
    staged_source = input_dir / source.name
    shutil.copy2(source, staged_source)
    output_dir.mkdir(parents=True, exist_ok=True)
    run_command([
        "melband-roformer-infer", "--input_folder", str(input_dir), "--store_dir", str(output_dir),
        "--device", "cuda", "--model", model,
    ], 1800)
    vocals = first_match(output_dir, "_vocals.wav")
    if not vocals or not vocals.exists():
        raise RuntimeError("Missing vocals MelBand output")
    return vocals, model


def handler(job):
    payload = job.get("input") or {}
    if str(payload.get("action") or "").lower() == "capabilities":
        return worker_capabilities()

    input_url = payload.get("inputUrl")
    requested = normalize_stems(payload.get("stems", []))
    upload_urls = payload.get("uploadUrls") or {}
    if not input_url:
        return {"error": "Missing inputUrl"}
    if not requested:
        return {"error": "No supported stems requested"}

    engine, routing_note = choose_engine(payload, requested)
    workspace = Path(tempfile.mkdtemp(prefix="mixforge-"))
    started_at = time.monotonic()
    try:
        downloaded = workspace / "source-input"
        source = workspace / "source.wav"
        download(input_url, downloaded)
        prepare_source(downloaded, source)

        files, models, model_provenance, stem_sources = {}, {}, {}, {}
        if engine == "melband":
            vocals, melband_model = run_melband_vocals(source, workspace / "melband-out")
            files["vocals"] = vocals
            models["melband"] = melband_model
            model_provenance["melband"] = melband_provenance(melband_model)
            stem_sources["vocals"] = "melband"
        elif engine == "hybrid":
            demucs_files, demucs_model = run_demucs(source, workspace / "demucs-out", requested)
            files.update(demucs_files)
            models["demucs"] = demucs_model
            stem_sources.update({stem: "demucs" for stem in requested})
            vocals, melband_model = run_melband_vocals(source, workspace / "melband-out")
            files["vocals"] = vocals
            models["melband"] = melband_model
            model_provenance["melband"] = melband_provenance(melband_model)
            stem_sources["vocals"] = "melband"
        else:
            demucs_files, demucs_model = run_demucs(source, workspace / "demucs-out", requested)
            files.update(demucs_files)
            models["demucs"] = demucs_model
            stem_sources.update({stem: "demucs" for stem in requested})

        uploaded = {}
        for stem in requested:
            file_path = files.get(stem)
            if not file_path or not file_path.exists():
                raise RuntimeError(f"Missing canonical {stem} output")
            signed_upload = upload_urls.get(stem)
            if not signed_upload:
                return {"error": f"Missing upload URL for {stem}"}
            upload(signed_upload, file_path)
            uploaded[stem] = True

        return {
            "ok": True,
            "outputs": uploaded,
            "separator": {
                "engine": engine,
                "imageRevision": os.getenv("MIXFORGE_SEPARATOR_REVISION", "unknown"),
                "models": models,
                "modelProvenance": model_provenance,
                "stemSources": stem_sources,
                "requestedStems": requested,
                "elapsedSeconds": round(time.monotonic() - started_at, 2),
                "routingNote": routing_note,
                "inputNormalization": {
                    "format": "pcm_s16le",
                    "sampleRate": SEPARATION_SAMPLE_RATE,
                    "channels": SEPARATION_CHANNELS,
                },
            },
        }
    except subprocess.TimeoutExpired:
        return {"error": f"{engine} separation timed out", "separator": {"engine": engine}}
    except Exception as error:
        return {"error": str(error), "separator": {"engine": engine}}
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


runpod.serverless.start({"handler": handler})
