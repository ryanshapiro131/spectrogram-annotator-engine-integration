"""
Image files for the photo annotator: upload / open / serve, plus stateless
Pascal VOC conversion (pascal_voc.py, ported from labelImg).

Images work like audio (server.py): the server keys each file by a content
hash (`file_id`, the same sha1 prefix the frontend computes to skip
re-uploads), keeps it on disk, and links it to a project as a media_files
row (media_type 'image') when a project_id is given.

On upload the image is decoded once with Pillow to read its size and
channel count. A photo whose EXIF says "rotate me" is stored already
rotated (and without that tag), because browsers apply EXIF orientation
when displaying: box coordinates must be in the pixels people see, and
width/height in VOC exports must match them.

Routes:
  POST /images/upload            multipart file (+ ?project_id)
  GET  /images/{file_id}         metadata; 404 if not on the server (+ ?project_id registers)
  GET  /images/{file_id}/raw     the image bytes
  POST /voc/export               boxes -> one .xml, or a .zip for several images
  POST /voc/parse                a .xml file -> boxes (labelImg import)
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import tempfile
import zipfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

import pascal_voc
from app_auth import AuthUser, current_user, register_media_file

router = APIRouter(tags=["images"])

# Same cache root as server.py's CACHE_DIR (SPECTROGRAM_CACHE_DIR).
IMAGES_DIR = Path(os.environ.get("SPECTROGRAM_CACHE_DIR") or Path(tempfile.gettempdir()) / "spectrogram_cache") / "images"
IMAGES_DIR.mkdir(parents=True, exist_ok=True)

MAX_IMAGE_BYTES = 200 * 1024 * 1024
MAX_PIXELS = 300_000_000           # Pillow's decompression-bomb guard, raised for large survey photos
Image.MAX_IMAGE_PIXELS = MAX_PIXELS
MAX_XML_BYTES = 5 * 1024 * 1024

# Pillow format -> (extension, content type). Anything else is re-encoded as PNG.
_FORMATS = {
    "JPEG": (".jpg", "image/jpeg"),
    "PNG": (".png", "image/png"),
    "GIF": (".gif", "image/gif"),
    "WEBP": (".webp", "image/webp"),
    "BMP": (".bmp", "image/bmp"),
}
# Channels per Pillow mode, for VOC <depth> (labelImg: 1 if grayscale else 3).
_DEPTH = {"1": 1, "L": 1, "LA": 1, "I": 1, "I;16": 1, "F": 1, "P": 3, "RGB": 3, "RGBA": 3, "CMYK": 3, "YCbCr": 3}


def _file_id(data: bytes) -> str:
    # Must match server.py's _file_id and src/workers/sha1.worker.js.
    return hashlib.sha1(data).hexdigest()[:16]


def _meta_path(file_id: str) -> Path:
    return IMAGES_DIR / f"{file_id}_meta.json"


def _check_id(file_id: str) -> None:
    if len(file_id) != 16 or any(c not in "0123456789abcdef" for c in file_id):
        raise HTTPException(400, "Bad file id.")


def lookup_image(file_id: str) -> dict | None:
    """The image's metadata if it's still on disk, else None."""
    _check_id(file_id)
    try:
        meta = json.loads(_meta_path(file_id).read_text())
    except (OSError, ValueError):
        return None
    if not (IMAGES_DIR / meta["stored_name"]).exists():
        return None
    return meta


def _store_image(data: bytes, file_name: str) -> dict:
    file_id = _file_id(data)
    meta = lookup_image(file_id)
    if meta is not None:
        return meta
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise HTTPException(422, f"Could not read this image: {exc}")

    fmt = img.format
    rotated = img.getexif().get(0x0112, 1) not in (None, 1)   # EXIF Orientation
    upright = ImageOps.exif_transpose(img) if rotated else img
    if fmt in _FORMATS and not rotated:
        ext, content_type = _FORMATS[fmt]
        payload = data
    else:
        # Bake in the EXIF rotation (or convert an unusual format, e.g. TIFF)
        # so the stored pixels are what a browser displays.
        out = io.BytesIO()
        if fmt == "JPEG":
            upright.convert("RGB").save(out, "JPEG", quality=95)
            ext, content_type = _FORMATS["JPEG"]
        else:
            save = upright if upright.mode in ("RGB", "RGBA", "L", "LA", "P") else upright.convert("RGBA")
            save.save(out, "PNG")
            ext, content_type = _FORMATS["PNG"]
        payload = out.getvalue()

    stored_name = f"{file_id}{ext}"
    (IMAGES_DIR / stored_name).write_bytes(payload)
    meta = {
        "file_id": file_id,
        "media_type": "image",
        "file_name": file_name or "untitled",
        "width": upright.width,
        "height": upright.height,
        "depth": _DEPTH.get(upright.mode, 3),
        "format": fmt,
        "content_type": content_type,
        "stored_name": stored_name,
    }
    _meta_path(file_id).write_text(json.dumps(meta))
    return meta


async def _response(meta: dict, project_id: str | None, user: AuthUser | None) -> dict:
    media_file = None
    if project_id:
        if user is None:
            raise HTTPException(401, "Sign in to add files to a project.")
        media_file = await run_in_threadpool(register_media_file, user, project_id, meta["file_id"], {
            "media_type": "image",
            "file_name": meta["file_name"],
            "width": meta["width"],
            "height": meta["height"],
            "n_channels": meta["depth"],
        })
    public = {k: v for k, v in meta.items() if k != "stored_name"}
    return public | {"media_file_id": media_file["id"] if media_file else None}


@router.post("/images/upload")
async def upload_image(
    file: UploadFile = File(...),
    project_id: str | None = Query(None, description="Project (UUID) to register this image in"),
    user: AuthUser | None = Depends(current_user),
):
    data = await file.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(413, f"Images are limited to {MAX_IMAGE_BYTES // (1024 * 1024)} MB.")
    if not data:
        raise HTTPException(400, "The file is empty.")
    meta = await run_in_threadpool(_store_image, data, file.filename)
    return await _response(meta, project_id, user)


@router.get("/images/{file_id}")
async def get_image(
    file_id: str,
    project_id: str | None = Query(None, description="Project (UUID) to register this image in"),
    user: AuthUser | None = Depends(current_user),
):
    """Open an image the server already has (the frontend hashes first to skip uploads)."""
    meta = lookup_image(file_id)
    if meta is None:
        raise HTTPException(404, "Not on the server. Upload it.")
    return await _response(meta, project_id, user)


@router.get("/images/{file_id}/raw")
def get_image_bytes(file_id: str, _user=Depends(current_user)):
    meta = lookup_image(file_id)
    if meta is None:
        raise HTTPException(404, "Not on the server. Upload it.")
    # Content-addressed, so the bytes never change for a file_id.
    return FileResponse(IMAGES_DIR / meta["stored_name"], media_type=meta["content_type"],
                        headers={"Cache-Control": "private, max-age=86400"})


# ---------------------------------------------------------------------------
# Pascal VOC (stateless: used by the standalone /photo annotator; project
# exports build the same structures from the database in projects_api.py)
# ---------------------------------------------------------------------------

class VocBox(BaseModel):
    label: str = Field(min_length=1, max_length=200)
    xmin: float
    ymin: float
    xmax: float
    ymax: float
    difficult: bool = False


class VocImage(BaseModel):
    filename: str = Field(min_length=1, max_length=500)
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    depth: int | None = 3
    verified: bool = False
    boxes: list[VocBox] = Field(default_factory=list)


class VocExportIn(BaseModel):
    folder: str = Field(default="images", max_length=500)
    images: list[VocImage] = Field(min_length=1, max_length=20000)


def voc_files(folder: str, images: list[dict]) -> list[tuple[str, bytes]]:
    """[(xml name, xml bytes)] — one per image, names made unique."""
    out, seen = [], set()
    for im in images:
        name = pascal_voc.voc_name(Path(im["filename"]).name)
        base, n = name[:-4], 2
        while name.lower() in seen:
            name, n = f"{base}_{n}.xml", n + 1
        seen.add(name.lower())
        out.append((name, pascal_voc.write_voc(
            filename=Path(im["filename"]).name, width=im["width"], height=im["height"],
            depth=im.get("depth") or 3, boxes=im["boxes"], folder=folder, verified=im.get("verified", False),
        )))
    return out


def voc_response(folder: str, images: list[dict], zip_name: str, force_zip: bool = False) -> Response:
    files = voc_files(folder, images)
    if len(files) == 1 and not force_zip:
        name, xml = files[0]
        return Response(xml, media_type="application/xml",
                        headers={"Content-Disposition": f'attachment; filename="{_safe_header(name)}"'})
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, xml in files:
            zf.writestr(name, xml)
    return Response(buf.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{_safe_header(zip_name)}"'})


def _safe_header(name: str) -> str:
    return "".join(c if c.isascii() and c.isprintable() and c not in '"\\' else "_" for c in name)


@router.post("/voc/export")
def export_voc(body: VocExportIn, _user=Depends(current_user)):
    for im in body.images:
        for b in im.boxes:
            if b.xmax <= b.xmin or b.ymax <= b.ymin:
                raise HTTPException(400, f'A "{b.label}" box on {im.filename} has no area.')
    return voc_response(body.folder or "images", [im.model_dump() for im in body.images], "annotations_voc.zip")


@router.post("/voc/parse")
async def parse_voc(file: UploadFile = File(...), _user=Depends(current_user)):
    data = await file.read(MAX_XML_BYTES + 1)
    if len(data) > MAX_XML_BYTES:
        raise HTTPException(413, "That XML file is too large.")
    try:
        return pascal_voc.read_voc(data)
    except pascal_voc.VocError as exc:
        raise HTTPException(422, str(exc))
