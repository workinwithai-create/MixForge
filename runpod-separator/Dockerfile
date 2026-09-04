FROM runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04

WORKDIR /app

ENV ENABLE_MELBAND=false \
    SEPARATION_ENGINE=demucs \
    DEMUCS_MODEL=htdemucs \
    MELBAND_MODEL=melband-roformer-kim-vocals

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

COPY runpod-separator/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt \
    && python -m demucs --help >/dev/null \
    && melband-roformer-infer --help >/dev/null

COPY runpod-separator/handler.py ./handler.py

CMD ["python", "-u", "handler.py"]
