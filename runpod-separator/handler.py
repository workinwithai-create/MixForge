import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import requests
import runpod

CANONICAL_STEMS = {"vocals", "bass", "drums", "other"}
STEM_ALIASES = {"guitars": "other", "keys": "other", "instrumental": "other"}
MELBAND_STEMS = {"vocals", "other"}
SUPPORTED_ENGINES = {"demucs", "melband", "auto"}


def normalize_stems(stems):
    out = []
    for stem in stems or []:
        actual = STEM_ALIASES.get(str(stem).lower(), str(stem).lower())
        if actual in CANONICAL_STEMS and actual not in out:
            out.append(actual)
    return out


def download(url: str, destination: Path) -> None:
    with requests.get(url, stream=True, timeout=180) as response:
        response.raise_for_status()
        with destination.open("wb") as handle:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    handle.write(chunk)


def upload(url: str, source: Path) -> None:
    with source.open("rb") as handle:
        response = requests.put(
            url,
            data=handle,
            headers={"Content-Type": "audio/wav"},
            timeout=300,
        )
    response.raise_for_status()


def run_command(command, timeout_seconds):
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )
    if completed.returncode != 0:
        message = completed.stderr[-4000:] or completed.stdout[-4000:] or "separator failed"
        raise RuntimeError(message)


def choose_engine(payload, requested):
    requested_engine = str(
        payload.get("engine") or os.getenv("SEPARATION_ENGINE", "demucs")
    ).lower()
    if requested_engine not in SUPPORTED_ENGINES:
        requested_engine = "demucs"

    quality = str(payload.get("mode") or "").lower() in {"quality", "forensic", "hq"}
    engine = requested_engine
    fallback_reason = None

    if engine == "auto":
        engine = "melband" if quality and set(requested).issubset(MELBAND_STEMS) else "demucs"

    if engine == "melband" and not set(requested).issubset(MELBAND_STEMS):
        fallback_reason = "MelBand quality route currently supports vocals + instrumental only; used Demucs for the requested 4-stem-compatible set."
        engine = "demucs"

    return engine, fallback_reason


def run_demucs(source: Path, output_dir: Path, requested):
    model = os.getenv("DEMUCS_MODEL", "htdemucs")
    command = [
        "python",
        "-m",
        "demucs",
        "--name",
        model,
        "--out",
        str(output_dir),
        "--device",
        "cuda",
        str(source),
    ]
    run_command(command, 900)

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


def run_melband(source: Path, output_dir: Path, requested):
    model = os.getenv("MELBAND_MODEL", "melband-roformer-kim-vocals")
    input_dir = source.parent / "melband-input"
    input_dir.mkdir(parents=True, exist_ok=True)
    staged_source = input_dir / source.name
    shutil.copy2(source, staged_source)
    output_dir.mkdir(parents=True, exist_ok=True)

    command = [
        "melband-roformer-infer",
        "--input_folder",
        str(input_dir),
        "--store_dir",
        str(output_dir),
        "--device",
        "cuda",
        "--model",
        model,
    ]
    run_command(command, 1800)

    vocals = first_match(output_dir, "_vocals.wav")
    instrumental = first_match(output_dir, "_instrumental.wav")
    candidates = {"vocals": vocals, "other": instrumental}
    outputs = {}
    for stem in requested:
        file_path = candidates.get(stem)
        if not file_path or not file_path.exists():
            raise RuntimeError(f"Missing {stem} MelBand output")
        outputs[stem] = file_path
    return outputs, model


def handler(job):
    payload = job.get("input") or {}
    input_url = payload.get("inputUrl")
    requested = normalize_stems(payload.get("stems", []))
    upload_urls = payload.get("uploadUrls") or {}

    if not input_url:
        return {"error": "Missing inputUrl"}
    if not requested:
        return {"error": "No supported stems requested"}

    engine, fallback_reason = choose_engine(payload, requested)
    workspace = Path(tempfile.mkdtemp(prefix="mixforge-"))
    started_at = time.monotonic()

    try:
        source = workspace / "source.wav"
        output_dir = workspace / "out"
        download(input_url, source)

        if engine == "melband":
            files, model = run_melband(source, output_dir, requested)
        else:
            files, model = run_demucs(source, output_dir, requested)

        uploaded = {}
        for stem, file_path in files.items():
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
                "model": model,
                "requestedStems": requested,
                "elapsedSeconds": round(time.monotonic() - started_at, 2),
                "fallbackReason": fallback_reason,
            },
        }
    except subprocess.TimeoutExpired:
        return {"error": f"{engine} separation timed out"}
    except Exception as error:
        return {"error": str(error), "separator": {"engine": engine}}
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


runpod.serverless.start({"handler": handler})
