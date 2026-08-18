r"""
Spectrogram annotation server.

Key properties:
  - All uploads are transcoded to WAV on arrival so soundfile.seek()
    is always O(1) regardless of original format or file position.
  - Audio is never loaded fully into RAM; soundfile reads only the
    samples needed for each chunk.
  - The spectrogram itself is generated ONCE per file by the
    spectrogram-engine C++ CLI (see ENGINE_BIN below), as a full
    multi-resolution tile pyramid + manifest.json. The frontend fetches
    tiles directly as static files — this server never computes or
    serves spectrogram magnitude data itself. Generation runs in a
    background thread right after upload; /tiles-status/{file_id}
    reports progress.
  - The legacy /sxx endpoint (raw per-chunk mel matrix as JSON) is kept
    only as a fallback / for comparison — the frontend no longer uses it.

Requires the spectrogram-engine binary to be built. Point
SPECTROGRAM_ENGINE_BIN at it, e.g.:
    export SPECTROGRAM_ENGINE_BIN=C:\Users\bensh\OneDrive\Documents\bb-annotation\spectrogram-annotator-engine-integration\SpectrogramEngine-main\build\Release\spectrogram-engine.exe
Usage:
    py -m uvicorn server:app --reload --port 8000
"""

import hashlib
import io
import json
import math
import os
import subprocess
import tempfile
import threading
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, JSONResponse
from fastapi.staticfiles import StaticFiles

CHUNK_DURATION = 180
CACHE_DIR      = Path(tempfile.gettempdir()) / "spectrogram_cache"
CACHE_DIR.mkdir(exist_ok=True)

# Where per-file tile pyramids + manifest.json live. Mounted below as static
# files at /tiles/{file_id}/... so the frontend fetches them directly with no
# server-side computation per request.
TILES_DIR = CACHE_DIR / "tiles"
TILES_DIR.mkdir(exist_ok=True)

# The compiled spectrogram-engine CLI. Default guess assumes SpectrogramEngine
# is checked out as a sibling of this repo; override with the env var if not.
ENGINE_BIN = os.environ.get(
    "SPECTROGRAM_ENGINE_BIN",
    str(Path(__file__).resolve().parent.parent.parent / "SpectrogramEngine" / "build" / "spectrogram-engine"),
)
_engine_bin_path = Path(ENGINE_BIN)
if not _engine_bin_path.exists():
    print(
        f"[server] WARNING: spectrogram-engine binary not found at {ENGINE_BIN}\n"
        f"[server]   Set SPECTROGRAM_ENGINE_BIN to its path, or build it:\n"
        f"[server]   cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build\n"
        f"[server]   Tile generation will fail until this is fixed."
    )

app = FastAPI(title="Spectrogram Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000", "http://127.0.0.1:3000",
        "http://localhost:5173", "http://127.0.0.1:5173",
        "http://localhost:4173", "http://127.0.0.1:4173",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

_registry: dict[str, dict] = {}
_registry_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _file_id(data: bytes) -> str:
    return hashlib.sha1(data).hexdigest()[:16]


def _wav_path(file_id: str) -> Path:
    """Path to the transcoded WAV file — always seekable in O(1)."""
    return CACHE_DIR / f"{file_id}_audio.wav"


def _cache_path(file_id: str, kind: str, chunk: int) -> Path:
    return CACHE_DIR / f"{file_id}_{kind}_{chunk}"


def _get_meta(file_id: str) -> dict:
    meta = _registry.get(file_id)
    if meta is None:
        raise HTTPException(404, "File not found. Please re-upload.")
    if not _wav_path(file_id).exists():
        raise HTTPException(410, "Cache expired. Please re-upload.")
    return meta


def _read_chunk(file_id: str, chunk_index: int,
                mono: bool = False) -> tuple[np.ndarray, int]:
    """
    Read exactly one chunk from the on-disk WAV using soundfile.seek().
    Because the file is always a WAV, seeking to any position is O(1) —
    no decoding of prior frames needed regardless of chunk index.
    """
    meta        = _get_meta(file_id)
    sr          = meta["sample_rate"]
    start_frame = int(chunk_index * CHUNK_DURATION * sr)
    max_frames  = int(CHUNK_DURATION * sr)

    with sf.SoundFile(str(_wav_path(file_id))) as f:
        f.seek(start_frame)
        frames = f.read(max_frames, dtype="float32", always_2d=True)

    if mono:
        return frames.mean(axis=1), sr
    return frames, sr


def _build_mel_filterbank(sr, n_fft, n_mels, fmin, fmax):
    return librosa.filters.mel(sr=sr, n_fft=n_fft, n_mels=n_mels,
                               fmin=fmin, fmax=fmax)


def _stft_columns(chunk: np.ndarray, n_fft: int,
                  hop_length: int, win: np.ndarray) -> np.ndarray:
    """
    Vectorised STFT — one np.fft.rfft call over all frames at once.
    Returns magnitude matrix (n_fft//2+1, n_frames) as float32.
    """
    pad          = n_fft // 2
    padded       = np.pad(chunk, pad, mode="reflect")
    n_frames     = 1 + (len(padded) - n_fft) // hop_length
    shape        = (n_frames, n_fft)
    strides      = (padded.strides[0] * hop_length, padded.strides[0])
    frames       = np.lib.stride_tricks.as_strided(padded, shape=shape,
                                                    strides=strides).copy()
    frames      *= win
    spectra      = np.fft.rfft(frames, n=n_fft, axis=1)
    return np.abs(spectra).astype(np.float32).T   # (bins, n_frames)


def _power_to_db(S: np.ndarray, top_db: float) -> np.ndarray:
    power = S ** 2
    ref   = np.max(power)
    db    = 10.0 * np.log10(np.maximum(power, 1e-10) / max(ref, 1e-10))
    return np.maximum(db, db.max() - top_db).astype(np.float32)


def _compute_overview(file_id: str, num_points: int) -> list[float]:
    """
    Downsample the ENTIRE file to `num_points` RMS values — one sequential
    pass over raw samples, no FFT. This powers the full-file navigation
    waveform, so it needs to stay fast even for multi-hour files.

    Reads in blocks sized so each block maps to exactly one output point,
    keeping peak memory at O(one block) rather than O(whole file).
    """
    path         = str(_wav_path(file_id))
    total_frames = sf.info(path).frames
    frames_per_point = max(1, math.ceil(total_frames / num_points))

    points: list[float] = []
    with sf.SoundFile(path) as f:
        while True:
            block = f.read(frames_per_point, dtype="float32", always_2d=True)
            if len(block) == 0:
                break
            mono = block.mean(axis=1) if block.shape[1] > 1 else block[:, 0]
            points.append(float(np.sqrt(np.mean(np.square(mono)))) if len(mono) else 0.0)

    peak = max(points) if points else 0.0
    if peak > 0:
        points = [p / peak for p in points]
    return points


def _compute_sxx(file_id: str, chunk_index: int) -> np.ndarray:
    meta      = _get_meta(file_id)
    chunk, sr = _read_chunk(file_id, chunk_index, mono=True)
    win       = np.hanning(meta["n_fft"]).astype(np.float32)
    mel_fb    = _build_mel_filterbank(sr, meta["n_fft"], meta["n_mels"],
                                      0.0, sr / 2)
    mags      = _stft_columns(chunk, meta["n_fft"], meta["hop_length"], win)
    mel       = mel_fb @ mags
    return _power_to_db(mel, meta["top_db"])   # (n_mels, n_frames)


# ---------------------------------------------------------------------------
# Tile pyramid generation (spectrogram-engine)
# ---------------------------------------------------------------------------

def _tiles_out_dir(file_id: str) -> Path:
    return TILES_DIR / file_id


def _tiles_manifest_path(file_id: str) -> Path:
    return _tiles_out_dir(file_id) / "manifest.json"


def _set_tiles_status(file_id: str, status: str, error: str | None = None) -> None:
    with _registry_lock:
        meta = _registry.get(file_id)
        if meta is None:
            return
        meta["tiles_status"] = status
        if error is not None:
            meta["tiles_error"] = error
        elif "tiles_error" in meta:
            del meta["tiles_error"]


def _run_engine(file_id: str) -> None:
    """
    Runs in a background thread, started right after a new file's WAV is
    written. Invokes the spectrogram-engine CLI once on the whole file —
    this is the ONLY spectrogram computation that happens for this file;
    every zoom/pan afterwards is a static tile fetch, never a recompute.
    """
    out_dir = _tiles_out_dir(file_id)
    if _tiles_manifest_path(file_id).exists():
        # Already generated in a previous run (server restarted but disk
        # cache survived) — no need to redo ~2-3 minutes of work.
        _set_tiles_status(file_id, "ready")
        return

    if not _engine_bin_path.exists():
        _set_tiles_status(
            file_id, "error",
            f"spectrogram-engine binary not found at {ENGINE_BIN}. "
            f"Set SPECTROGRAM_ENGINE_BIN or build it (see server.py header).",
        )
        return

    _set_tiles_status(file_id, "running")
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(
            [str(_engine_bin_path), str(_wav_path(file_id)), str(out_dir)],
            check=True, capture_output=True, timeout=3600, text=True,
        )
        if not _tiles_manifest_path(file_id).exists():
            raise RuntimeError("engine exited cleanly but wrote no manifest.json")
        _set_tiles_status(file_id, "ready")
    except subprocess.CalledProcessError as exc:
        _set_tiles_status(file_id, "error", exc.stderr[-2000:] if exc.stderr else str(exc))
    except Exception as exc:
        _set_tiles_status(file_id, "error", str(exc))


def _start_tile_generation(file_id: str) -> None:
    with _registry_lock:
        meta = _registry.get(file_id)
        if meta is None:
            return
        if meta.get("tiles_status") in ("pending", "running", "ready"):
            return  # already generated or in flight
        meta["tiles_status"] = "pending"
    threading.Thread(target=_run_engine, args=(file_id,), daemon=True).start()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.post("/upload")
async def upload(
    file: UploadFile = File(...),
    n_fft:      int   = Query(1024),
    hop_length: int   = Query(160),
    n_mels:     int   = Query(128),
    top_db:     float = Query(80.0),
):
    """
    Receive audio, transcode to WAV, cache to disk.

    Transcoding happens once on upload. After this point every chunk
    request uses soundfile.seek() on an uncompressed WAV, so seek time
    is O(1) for chunk 1 and chunk 500 alike.
    """
    data    = await file.read()
    file_id = _file_id(data)

    if file_id not in _registry:
        wav_path = _wav_path(file_id)

        # Try reading directly with soundfile first (WAV, FLAC, OGG, AIFF…)
        try:
            buf = io.BytesIO(data)
            y, sr = sf.read(buf, dtype="float32", always_2d=True)
            # y shape: (n_frames, n_channels)
        except Exception:
            # Fall back to librosa for MP3, AAC, M4A, etc.
            try:
                buf = io.BytesIO(data)
                y_lr, sr = librosa.load(buf, sr=None, mono=False)
                # librosa returns (channels, frames) or (frames,)
                y = y_lr.T if y_lr.ndim == 2 else y_lr[:, None]
            except Exception as exc:
                raise HTTPException(422, f"Could not decode audio: {exc}")

        # Always write as 32-bit float WAV — perfect quality, O(1) seeks
        sf.write(str(wav_path), y, sr, subtype="FLOAT")
        del y  # free RAM immediately

        n_frames     = sf.info(str(wav_path)).frames
        n_channels   = sf.info(str(wav_path)).channels
        duration     = n_frames / sr
        total_chunks = math.ceil(duration / CHUNK_DURATION)

        _registry[file_id] = {
            "file_name":    file.filename,
            "sample_rate":  int(sr),
            "duration":     float(duration),
            "total_chunks": total_chunks,
            "n_channels":   int(n_channels),
            "n_fft":        n_fft,
            "hop_length":   hop_length,
            "n_mels":       n_mels,
            "top_db":       top_db,
            "tiles_status": "idle",
        }

    # Kick off (or resume) tile pyramid generation. Idempotent: no-ops if
    # already running/ready for this file_id, and skips straight to "ready"
    # if a manifest from a prior run is still on disk.
    _start_tile_generation(file_id)

    return JSONResponse(_registry[file_id] | {"file_id": file_id})


@app.get("/chunk/{file_id}/{chunk_index}")
def get_chunk_wav(file_id: str, chunk_index: int):
    """Return (and cache) a WAV blob for the requested chunk."""
    cache = _cache_path(file_id, "wav", chunk_index)
    if cache.exists():
        return Response(content=cache.read_bytes(), media_type="audio/wav")

    frames, sr = _read_chunk(file_id, chunk_index, mono=False)
    buf        = io.BytesIO()
    sf.write(buf, frames, sr, format="WAV", subtype="PCM_16")
    buf.seek(0)
    wav_bytes = buf.read()
    cache.write_bytes(wav_bytes)
    return Response(content=wav_bytes, media_type="audio/wav")


@app.get("/sxx/{file_id}/{chunk_index}")
def get_sxx(file_id: str, chunk_index: int):
    """
    Return the full sxx matrix as JSON.
    Computed once and cached to disk; repeat requests are instant reads.
    """
    cache = _cache_path(file_id, "sxx", chunk_index)
    if cache.exists():
        return Response(content=cache.read_bytes(), media_type="application/json")

    mel_db  = _compute_sxx(file_id, chunk_index)
    payload = json.dumps({
        "sxx":         mel_db.tolist(),
        "chunk_index": chunk_index,
    }).encode()
    cache.write_bytes(payload)
    return Response(content=payload, media_type="application/json")


@app.get("/overview/{file_id}")
def get_overview(file_id: str, num_points: int = Query(2000, ge=100, le=8000)):
    """
    Return a downsampled RMS waveform for the whole file — used to render
    the full-file navigation strip (color = loaded, gray = not yet loaded).
    Computed once per (file_id, num_points) and cached to disk.
    """
    _get_meta(file_id)  # 404/410 if unknown or evicted

    cache = _cache_path(file_id, f"overview{num_points}", 0)
    if cache.exists():
        return Response(content=cache.read_bytes(), media_type="application/json")

    meta    = _registry[file_id]
    points  = _compute_overview(file_id, num_points)
    payload = json.dumps({
        "points":     points,
        "num_points": len(points),
        "duration":   meta["duration"],
        "file_id":    file_id,
    }).encode()
    cache.write_bytes(payload)
    return Response(content=payload, media_type="application/json")


@app.get("/tiles-status/{file_id}")
def get_tiles_status(file_id: str):
    """
    Poll this after upload. status is one of:
      idle | pending | running | ready | error
    Once "ready", GET /tiles/{file_id}/manifest.json and the tiles
    underneath it are servable directly (static files, no compute).
    """
    meta = _get_meta(file_id)
    return {
        "file_id":      file_id,
        "status":       meta.get("tiles_status", "idle"),
        "error":        meta.get("tiles_error"),
        "manifest_url": f"/tiles/{file_id}/manifest.json",
    }


@app.get("/health")
def health():
    return {"status": "ok"}


@app.delete("/file/{file_id}")
def evict_file(file_id: str):
    _registry.pop(file_id, None)
    for p in CACHE_DIR.glob(f"{file_id}_*"):
        p.unlink(missing_ok=True)
    tiles_dir = _tiles_out_dir(file_id)
    if tiles_dir.exists():
        import shutil
        shutil.rmtree(tiles_dir, ignore_errors=True)
    return {"deleted": file_id}


# Serve tile pyramids + manifest.json as plain static files — this is the
# whole point of the engine integration: zero server-side work per tile
# request, just disk reads. Mounted last so it doesn't shadow the API routes
# above.
app.mount("/tiles", StaticFiles(directory=str(TILES_DIR)), name="tiles")


if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)