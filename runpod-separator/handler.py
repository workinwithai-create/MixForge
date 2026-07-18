import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import requests
import runpod

ALLOWED_STEMS = {"vocals", "bass", "drums", "guitars", "keys", "other"}


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


def handler(job):
    payload = job.get("input") or {}
    input_url = payload.get("inputUrl")
    requested = [stem for stem in payload.get("stems", []) if stem in ALLOWED_STEMS]
    upload_urls = payload.get("uploadUrls") or {}

    if not input_url:
        return {"error": "Missing inputUrl"}
    if not requested:
        return {"error": "No supported stems requested"}

    workspace = Path(tempfile.mkdtemp(prefix="mixforge-"))
    try:
        source = workspace / "source.wav"
        output_dir = workspace / "out"
        download(input_url, source)

        command = [
            "python", "-m", "demucs",
            "--name", os.getenv("DEMUCS_MODEL", "htdemucs"),
            "--out", str(output_dir),
            "--device", "cuda",
            str(source),
        ]
        completed = subprocess.run(command, capture_output=True, text=True, timeout=900)
        if completed.returncode != 0:
            return {"error": completed.stderr[-2000:] or "Demucs failed"}

        model_dir = output_dir / os.getenv("DEMUCS_MODEL", "htdemucs") / source.stem
        outputs = {}
        for stem in requested:
            source_stem = stem if stem in {"vocals", "bass", "drums", "other"} else "other"
            file_path = model_dir / f"{source_stem}.wav"
            if not file_path.exists():
                return {"error": f"Missing {source_stem} output for requested {stem} stem"}
            signed_upload = upload_urls.get(stem)
            if not signed_upload:
                return {"error": f"Missing upload URL for {stem}"}
            upload(signed_upload, file_path)
            outputs[stem] = True

        return {"ok": True, "outputs": outputs}
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


runpod.serverless.start({"handler": handler})