"""ML sidecar for Plaudern: speaker diarization and transcription.

Wraps pyannote.audio speaker diarization and faster-whisper transcription
behind a tiny HTTP API. The NestJS backend POSTs a presigned audio URL; this
service downloads it and either diarizes it (speaker-labeled segments plus one
L2-normalized embedding per speaker cluster, used by the backend for
cross-recording voice matching) or transcribes it (text plus timestamped
segments).

Requires HF_TOKEN with accepted terms for the gated models
pyannote/speaker-diarization-3.1 and pyannote/segmentation-3.0. The whisper
models are ungated.
"""

import asyncio
import logging
import os
import tempfile

import httpx
import numpy as np
import uvicorn
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

MODEL_NAME = os.environ.get("SPEAKER_ID_MODEL", "pyannote/speaker-diarization-3.1")
HF_TOKEN = os.environ.get("HF_TOKEN", "")
AUTH_TOKEN = os.environ.get("SPEAKER_ID_TOKEN", "")
DOWNLOAD_TIMEOUT_S = float(os.environ.get("SPEAKER_ID_DOWNLOAD_TIMEOUT_S", "300"))
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "auto")
WHISPER_COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("speaker-id")

app = FastAPI(title="plaudern-speaker-id")

_pipeline = None
_device = "cpu"
# pyannote pipelines are not thread-safe and inference is heavy; run one job
# at a time (the backend queue is concurrency-1 anyway).
_inference_lock = asyncio.Lock()
_whisper = None
_whisper_device = "cpu"
# separate lock so the backend's independent transcription and diarization
# queues don't serialize each other; each model still runs one job at a time.
_whisper_lock = asyncio.Lock()


class DiarizeRequest(BaseModel):
    audio_url: str
    num_speakers: int | None = None


class TranscribeRequest(BaseModel):
    audio_url: str
    language: str | None = None


@app.on_event("startup")
def load_pipeline() -> None:
    global _pipeline, _device
    import torch
    from pyannote.audio import Pipeline

    logger.info("loading %s (first run downloads the model)...", MODEL_NAME)
    pipeline = Pipeline.from_pretrained(MODEL_NAME, use_auth_token=HF_TOKEN or None)
    if pipeline is None:
        raise RuntimeError(
            f"could not load {MODEL_NAME}. Set HF_TOKEN and accept the model "
            "terms on huggingface.co (see apps/speaker-id-ml/README.md)."
        )
    if torch.cuda.is_available():
        pipeline.to(torch.device("cuda"))
        _device = "cuda"
    _pipeline = pipeline
    logger.info("pipeline ready on %s", _device)


@app.on_event("startup")
def load_whisper() -> None:
    global _whisper, _whisper_device
    import torch
    from faster_whisper import WhisperModel

    if WHISPER_DEVICE == "auto":
        _whisper_device = "cuda" if torch.cuda.is_available() else "cpu"
    else:
        _whisper_device = WHISPER_DEVICE
    compute = WHISPER_COMPUTE_TYPE or (
        "float16" if _whisper_device == "cuda" else "int8"
    )
    logger.info(
        "loading whisper model %s (first run downloads the model)...", WHISPER_MODEL
    )
    _whisper = WhisperModel(WHISPER_MODEL, device=_whisper_device, compute_type=compute)
    logger.info("whisper ready on %s (%s)", _whisper_device, compute)


@app.get("/health")
def health():
    if _pipeline is None:
        raise HTTPException(status_code=503, detail="diarization pipeline not loaded")
    if _whisper is None:
        raise HTTPException(status_code=503, detail="whisper model not loaded")
    return {
        "status": "ok",
        "diarization_model": MODEL_NAME,
        "diarization_device": _device,
        "transcription_model": WHISPER_MODEL,
        "transcription_device": _whisper_device,
    }


async def _download_audio(url: str, tmp) -> None:
    try:
        async with httpx.AsyncClient(timeout=DOWNLOAD_TIMEOUT_S) as client:
            async with client.stream("GET", url) as res:
                res.raise_for_status()
                async for chunk in res.aiter_bytes():
                    tmp.write(chunk)
        tmp.flush()
    except httpx.HTTPError as err:
        raise HTTPException(status_code=422, detail=f"could not download audio: {err}")


@app.post("/diarize")
async def diarize(req: DiarizeRequest, authorization: str | None = Header(default=None)):
    if AUTH_TOKEN and authorization != f"Bearer {AUTH_TOKEN}":
        raise HTTPException(status_code=401, detail="invalid token")
    if _pipeline is None:
        raise HTTPException(status_code=503, detail="pipeline not loaded")

    with tempfile.NamedTemporaryFile(suffix=".audio", delete=True) as tmp:
        await _download_audio(req.audio_url, tmp)

        async with _inference_lock:
            loop = asyncio.get_running_loop()
            try:
                result = await loop.run_in_executor(
                    None, _run_pipeline, tmp.name, req.num_speakers
                )
            except Exception as err:  # surface pipeline errors as a clean 500
                logger.exception("diarization failed")
                raise HTTPException(status_code=500, detail=f"diarization failed: {err}")

    return result


def _run_pipeline(path: str, num_speakers: int | None):
    kwargs = {"return_embeddings": True}
    if num_speakers:
        kwargs["num_speakers"] = num_speakers
    diarization, embeddings = _pipeline(path, **kwargs)

    labels = diarization.labels()
    segments = []
    speaking_seconds: dict[str, float] = {label: 0.0 for label in labels}
    duration = 0.0
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        segments.append(
            {"start": round(turn.start, 3), "end": round(turn.end, 3), "speaker": speaker}
        )
        speaking_seconds[speaker] += turn.end - turn.start
        duration = max(duration, turn.end)

    speakers = []
    for i, label in enumerate(labels):
        embedding = np.asarray(embeddings[i], dtype=np.float64)
        norm = np.linalg.norm(embedding)
        if norm > 0:
            embedding = embedding / norm
        speakers.append(
            {
                "label": label,
                "embedding": [float(x) for x in embedding],
                "speaking_seconds": round(speaking_seconds[label], 3),
            }
        )

    return {
        "duration_seconds": round(duration, 3),
        "segments": segments,
        "speakers": speakers,
    }


@app.post("/transcribe")
async def transcribe(
    req: TranscribeRequest, authorization: str | None = Header(default=None)
):
    if AUTH_TOKEN and authorization != f"Bearer {AUTH_TOKEN}":
        raise HTTPException(status_code=401, detail="invalid token")
    if _whisper is None:
        raise HTTPException(status_code=503, detail="whisper model not loaded")

    with tempfile.NamedTemporaryFile(suffix=".audio", delete=True) as tmp:
        await _download_audio(req.audio_url, tmp)

        async with _whisper_lock:
            loop = asyncio.get_running_loop()
            try:
                result = await loop.run_in_executor(
                    None, _run_whisper, tmp.name, req.language
                )
            except Exception as err:  # surface model errors as a clean 500
                logger.exception("transcription failed")
                raise HTTPException(
                    status_code=500, detail=f"transcription failed: {err}"
                )

    return result


def _run_whisper(path: str, language: str | None):
    segments_iter, info = _whisper.transcribe(
        path, language=language, vad_filter=True
    )
    segments = [
        {"start": round(s.start, 3), "end": round(s.end, 3), "text": s.text}
        for s in segments_iter
    ]
    return {
        "text": "".join(s["text"] for s in segments).strip(),
        "language": info.language,
        "duration_seconds": round(info.duration, 3),
        "segments": segments,
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
