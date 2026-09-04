FROM runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04

WORKDIR /app

ARG PRELOAD_MELBAND=false

ENV ENABLE_MELBAND=false \
    SEPARATION_ENGINE=demucs \
    DEMUCS_MODEL=htdemucs \
    MELBAND_MODEL=melband-roformer-kim-vocals \
    MELBAND_ROFORMER_MODELS_PATH=/opt/mixforge/models \
    MELBAND_CHECKPOINT_SHA256=87201f4d31afb5bc79993230fc49446918425574db48c01c405e44f365c7559e

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

COPY runpod-separator/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt \
    && python -m demucs --help >/dev/null \
    && melband-roformer-infer --help >/dev/null \
    && melband-roformer-download --help >/dev/null

RUN mkdir -p "$MELBAND_ROFORMER_MODELS_PATH" \
    && if [ "$PRELOAD_MELBAND" = "true" ]; then \
         melband-roformer-download \
           --model "$MELBAND_MODEL" \
           --output-dir "$MELBAND_ROFORMER_MODELS_PATH"; \
         test "$(sha256sum "$MELBAND_ROFORMER_MODELS_PATH/$MELBAND_MODEL/MelBandRoformer.ckpt" | awk '{print $1}')" = "$MELBAND_CHECKPOINT_SHA256"; \
       fi

COPY runpod-separator/handler.py ./handler.py

CMD ["python", "-u", "handler.py"]
