# speaker-id-ml

Self-hosted ML sidecar for Plaudern: speaker diarization **and** transcription.
Wraps [pyannote.audio](https://github.com/pyannote/pyannote-audio) speaker
diarization (`pyannote/speaker-diarization-3.1`) and
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) transcription
behind a small FastAPI service. The NestJS API sends it a presigned audio URL;
it returns who-spoke-when segments plus one voice embedding per speaker
(used to recognize the same voice across recordings), or the transcribed text
with timestamped segments.

## One-time setup: Hugging Face token

The pyannote models are free but **gated**. Before first start:

1. Create a token at <https://huggingface.co/settings/tokens> (read scope).
2. While logged in, accept the user conditions of BOTH models:
   - <https://huggingface.co/pyannote/speaker-diarization-3.1>
   - <https://huggingface.co/pyannote/segmentation-3.0>
3. Export the token as `HUGGING_FACE_TOKEN` (e.g. in the repo's `.env` used by
   docker compose).

The whisper models are ungated — `HUGGING_FACE_TOKEN` is only needed for pyannote.

The models (~1 GB pyannote + ~0.5 GB whisper `small`) download on first start
into the `hfcache` volume; later starts are offline. `/health` returns 503
until both models are loaded.

## Running

Via the repo's docker compose (recommended — both transcription and
diarization use this sidecar by default):

```sh
HUGGING_FACE_TOKEN=hf_... docker compose up -d --build speaker-id api
```

Standalone for development:

```sh
pip install -r requirements.txt
HUGGING_FACE_TOKEN=hf_... uvicorn main:app --port 8000
```

## API

- `GET /health` →
  `{ "status": "ok", "diarization_model": "...", "diarization_device": "cpu|cuda", "transcription_model": "...", "transcription_device": "cpu|cuda" }`
  (503 while either model is loading).
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

- `POST /transcribe` with header `Authorization: Bearer $SPEAKER_ID_TOKEN` and
  body `{ "audio_url": "https://...", "language": null }` (language is an
  optional ISO code hint; auto-detected when omitted) →

```json
{
  "text": "Hello world.",
  "language": "en",
  "duration_seconds": 12.3,
  "segments": [ { "start": 0.0, "end": 2.1, "text": " Hello world." } ]
}
```

## Env vars

| Var | Default | Purpose |
| --- | --- | --- |
| `HUGGING_FACE_TOKEN` | — | Hugging Face token with accepted pyannote terms (required) |
| `SPEAKER_ID_TOKEN` | — | Shared bearer token; requests are rejected without it when set |
| `SPEAKER_ID_MODEL` | `pyannote/speaker-diarization-3.1` | Diarization pipeline to load |
| `WHISPER_MODEL` | `small` | faster-whisper model (`tiny`/`base`/`small`/`medium`/`large-v3` or an HF repo id) |
| `WHISPER_DEVICE` | `auto` | `auto` picks cuda when available, else cpu |
| `WHISPER_COMPUTE_TYPE` | int8 on cpu, float16 on cuda | CTranslate2 compute type |
| `SPEAKER_ID_DOWNLOAD_TIMEOUT_S` | `300` | Audio download timeout |
| `PORT` | `8000` | Listen port |

## Performance note

On CPU, diarization takes on the order of minutes per hour of audio;
faster-whisper `small` (int8) transcribes at roughly real time on a modern
CPU. With both models resident expect the container to use ~2.5–3 GB RAM. The
backend queues run one job of each kind at a time and the UI shows progress,
so slow is fine — but a GPU (`--gpus all` + CUDA torch) speeds both up
dramatically.
