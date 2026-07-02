# Speaker-identification sidecar (pyannote.audio). CPU by default; runs fine
# on CUDA hosts too when started with `--gpus all`.
FROM python:3.11-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

# Models are gated + large: they download on first start into this volume-
# mounted cache using the HUGGING_FACE_TOKEN env var. Never bake the token into the image.
ENV HF_HOME=/cache/huggingface
VOLUME /cache/huggingface

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
