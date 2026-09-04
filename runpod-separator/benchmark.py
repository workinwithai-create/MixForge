import argparse
import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

AUDIO_SUFFIXES = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".aif", ".aiff", ".ogg"}
SAMPLE_RATE = 44100
CHANNELS = 2
MELBAND_CHECKPOINT_FILE = "MelBandRoformer.ckpt"
MELBAND_CHECKPOINT_SHA256_DEFAULT = "87201f4d31afb5bc79993230fc49446918425574db48c01c405e44f365c7559e"


def env_enabled(name, default=False):
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def run(command, timeout):
    started = time.monotonic()
    completed = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    elapsed = round(time.monotonic() - started, 2)
    if completed.returncode != 0:
        message = completed.stderr[-5000:] or completed.stdout[-5000:] or "command failed"
        raise RuntimeError(message)
    return elapsed


def slugify(value):
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "-", value).strip("-._")
    return cleaned or "track"


def benchmark_provenance(demucs_model, melband_model):
    return {
        "separatorImageRevision": os.getenv("MIXFORGE_SEPARATOR_REVISION", "unknown"),
        "demucsModel": demucs_model,
        "melbandModel": melband_model,
        "melbandCheckpoint": MELBAND_CHECKPOINT_FILE,
        "melbandCheckpointSha256": os.getenv("MELBAND_CHECKPOINT_SHA256", MELBAND_CHECKPOINT_SHA256_DEFAULT),
        "melbandCheckpointBakedIntoImage": env_enabled("MELBAND_PRELOADED", False),
        "inputNormalization": {
            "sampleRate": SAMPLE_RATE,
            "channels": CHANNELS,
            "codec": "pcm_s16le",
        },
    }


def normalize(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    return run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(source), "-vn", "-ac", str(CHANNELS), "-ar", str(SAMPLE_RATE),
        "-c:a", "pcm_s16le", str(destination),
    ], 300)


def run_demucs(source, track_dir, model):
    output_dir = track_dir / "demucs"
    elapsed = run([
        "python", "-m", "demucs", "--name", model, "--out", str(output_dir),
        "--device", "cuda", str(source),
    ], 1200)
    stem_dir = output_dir / model / source.stem
    stems = {stem: stem_dir / f"{stem}.wav" for stem in ("vocals", "bass", "drums", "other")}
    missing = [stem for stem, path in stems.items() if not path.exists()]
    if missing:
        raise RuntimeError(f"Demucs did not produce: {', '.join(missing)}")
    return stems, elapsed


def run_melband(source, track_dir, model):
    input_dir = track_dir / "melband-input"
    output_dir = track_dir / "melband"
    input_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    staged = input_dir / "source.wav"
    shutil.copy2(source, staged)
    elapsed = run([
        "melband-roformer-infer", "--input_folder", str(input_dir),
        "--store_dir", str(output_dir), "--device", "cuda", "--model", model,
    ], 2400)
    vocals = sorted(output_dir.rglob("*_vocals.wav"))
    instrumental = sorted(output_dir.rglob("*_instrumental.wav"))
    if not vocals or not instrumental:
        raise RuntimeError("MelBand did not produce both vocals and instrumental outputs")
    return {"vocals": vocals[0], "instrumental": instrumental[0]}, elapsed


def build_demucs_accompaniment(stems, destination):
    return run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(stems["bass"]), "-i", str(stems["drums"]), "-i", str(stems["other"]),
        "-filter_complex", "[0:a][1:a][2:a]amix=inputs=3:normalize=0:dropout_transition=0[a]",
        "-map", "[a]", "-c:a", "pcm_f32le", str(destination),
    ], 300)


def collect_inputs(paths):
    files = []
    for raw in paths:
        path = Path(raw).expanduser().resolve()
        if path.is_dir():
            files.extend(sorted(p for p in path.iterdir() if p.is_file() and p.suffix.lower() in AUDIO_SUFFIXES))
        elif path.is_file() and path.suffix.lower() in AUDIO_SUFFIXES:
            files.append(path)
    deduped = []
    seen = set()
    for path in files:
        key = str(path)
        if key not in seen:
            seen.add(key)
            deduped.append(path)
    return deduped


def benchmark_track(source, output_root, demucs_model, melband_model, provenance):
    track_dir = output_root / slugify(source.stem)
    track_dir.mkdir(parents=True, exist_ok=True)
    normalized = track_dir / "source-44100-stereo.wav"

    normalization_seconds = normalize(source, normalized)
    demucs_stems, demucs_seconds = run_demucs(normalized, track_dir, demucs_model)
    melband_stems, melband_seconds = run_melband(normalized, track_dir, melband_model)
    demucs_accompaniment = track_dir / "demucs-accompaniment.wav"
    accompaniment_seconds = build_demucs_accompaniment(demucs_stems, demucs_accompaniment)

    manifest = {
        "source": str(source),
        "provenance": provenance,
        "normalization": {
            "path": str(normalized),
            "sampleRate": SAMPLE_RATE,
            "channels": CHANNELS,
            "seconds": normalization_seconds,
        },
        "models": {
            "demucs": demucs_model,
            "melband": melband_model,
        },
        "runtimeSeconds": {
            "demucs": demucs_seconds,
            "melband": melband_seconds,
            "demucsAccompanimentBuild": accompaniment_seconds,
        },
        "audition": {
            "original": str(normalized),
            "demucsVocals": str(demucs_stems["vocals"]),
            "melbandVocals": str(melband_stems["vocals"]),
            "demucsAccompaniment": str(demucs_accompaniment),
            "melbandInstrumental": str(melband_stems["instrumental"]),
            "demucsBass": str(demucs_stems["bass"]),
            "demucsDrums": str(demucs_stems["drums"]),
            "demucsOther": str(demucs_stems["other"]),
        },
        "scorecard": {
            "vocalBleed": None,
            "vocalArtifacts": None,
            "backingBleed": None,
            "transientIntegrity": None,
            "toneNaturalness": None,
            "preferredVocalStem": None,
            "notes": "Score by listening. Do not promote a model from SDR, reconstruction error, or runtime alone.",
        },
    }
    (track_dir / "benchmark.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def main():
    parser = argparse.ArgumentParser(description="Benchmark HTDemucs vs MelBand on real MixForge songs.")
    parser.add_argument("inputs", nargs="+", help="Audio files and/or folders")
    parser.add_argument("--output", default="separator-benchmark", help="Output folder")
    parser.add_argument("--limit", type=int, default=20, help="Maximum tracks to process")
    parser.add_argument("--demucs-model", default=os.getenv("DEMUCS_MODEL", "htdemucs"))
    parser.add_argument("--melband-model", default=os.getenv("MELBAND_MODEL", "melband-roformer-kim-vocals"))
    args = parser.parse_args()

    inputs = collect_inputs(args.inputs)[: max(1, args.limit)]
    if not inputs:
        raise SystemExit("No supported audio files found")

    output_root = Path(args.output).expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    provenance = benchmark_provenance(args.demucs_model, args.melband_model)
    summary = []
    for index, source in enumerate(inputs, start=1):
        print(f"[{index}/{len(inputs)}] {source.name}", flush=True)
        try:
            result = benchmark_track(source, output_root, args.demucs_model, args.melband_model, provenance)
            summary.append({
                "source": str(source),
                "ok": True,
                "manifest": str(output_root / slugify(source.stem) / "benchmark.json"),
                "runtimeSeconds": result["runtimeSeconds"],
            })
        except Exception as error:
            summary.append({"source": str(source), "ok": False, "error": str(error)})
            print(f"  failed: {error}", flush=True)

    summary_path = output_root / "summary.json"
    summary_path.write_text(json.dumps({"provenance": provenance, "tracks": summary}, indent=2), encoding="utf-8")
    passed = sum(1 for item in summary if item["ok"])
    print(f"Completed {passed}/{len(summary)} tracks. Summary: {summary_path}")
    if passed != len(summary):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
