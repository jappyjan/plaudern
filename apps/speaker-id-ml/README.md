# speaker-id-ml

Self-hosted speaker-identification sidecar for Plaudern. Wraps
[pyannote.audio](https://github.com/pyannote/pyannote-audio) speaker
diarization (`pyannote/speaker-diarization-3.1`) behind a small FastAPI
service. The NestJS API sends it a presigned audio URL; it returns
who-spoke-when segments plus one voice embedding per speaker, which the
backend uses to recognize the same voice across recordings.

## One-time setup: Hugging Face token

The pyannote models are free but **gated**. Before first start:

1. Create a token at <https://huggingface.co/settings/tokens> (read scope).
2. While logged in, accept the user conditions of BOTH models:
   - <https://huggingface.co/pyannote/speaker-diarization-3.1>
   - <https://huggingface.co/pyannote/segmentation-3.0>
3. Export the token as `HF_TOKEN` (e.g. in the repo's `.env` used by
   docker compose).

The models (~1 GB) download on first start into the `hfcache` volume; later
starts are offline.

## Running

Via the repo's docker compose (recommended):

```sh
HF_TOKEN=hf_... SPEAKER_ID_PROVIDER=pyannote docker compose up -d --build speaker-id api
```

Standalone for development:

```sh
pip install -r requirements.txt
HF_TOKEN=hf_... uvicorn main:app --port 8000
```

## API

- `GET /health` → `{ "status": "ok", "model": "...", "device": "cpu|cuda" }`
  (503 while the pipeline is loading).
- `POST /diarize` with header `Authorization: Bearer $SPEAKER_ID_TOKEN` and body
  `{ "audio_url": "https://...", "num_speakers": null }` →

```json
{
  "duration_seconds": 123.4,
  "segments": [ { "start": 0.03, "end": 4.21, "speaker": "SPEAKER_00" } ],
  "speakers": [
    { "label": "SPEAKER_00", "embedding": [0.01, ...], "speaking_seconds": 61.2 }
  ]
}
```

Embeddings are L2-normalized; cosine similarity between them is a plain dot
product.

## Env vars

| Var | Default | Purpose |
| --- | --- | --- |
| `HF_TOKEN` | — | Hugging Face token with accepted pyannote terms (required) |
| `SPEAKER_ID_TOKEN` | — | Shared bearer token; requests are rejected without it when set |
| `SPEAKER_ID_MODEL` | `pyannote/speaker-diarization-3.1` | Pipeline to load |
| `SPEAKER_ID_DOWNLOAD_TIMEOUT_S` | `300` | Audio download timeout |
| `PORT` | `8000` | Listen port |

## Performance note

On CPU, diarization takes on the order of minutes per hour of audio. The
backend queue runs one job at a time and the UI shows progress, so slow is
fine — but a GPU (`--gpus all` + CUDA torch) speeds it up dramatically.
