FROM runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

COPY runpod-separator/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY runpod-separator/handler.py ./handler.py

CMD ["python", "-u", "handler.py"]
