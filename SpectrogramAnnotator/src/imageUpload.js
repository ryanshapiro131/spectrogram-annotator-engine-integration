import { apiFetch, apiJson, apiUpload, ApiError } from './api';
import { hashFile } from './audioUpload';

export const IMAGE_ACCEPT = '.jpg,.jpeg,.png,.gif,.webp,.bmp,.tif,.tiff';
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i;

export const isImageFile = (file) => file.type.startsWith('image/') || IMAGE_EXT.test(file.name);

/**
 * Get an image onto the server, like uploadAudio: hash locally -> ask the
 * server if it already has it (GET /images/{id}) -> upload only if not.
 * With projectId the server also registers it in the project.
 * Resolves to { file_id, file_name, width, height, depth, media_file_id, … }.
 */
export async function uploadImage(file, { projectId, expectedFileId, onPhase, onTransfer } = {}) {
  onPhase?.('hashing');
  const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
  const fileId = await hashFile(file, (fraction) => onTransfer?.({ fraction, loaded: 0, total: file.size }));
  if (expectedFileId && fileId && fileId !== expectedFileId) {
    throw new ApiError(400, `"${file.name}" is a different image from the one this entry was created from.`);
  }
  if (fileId) {
    let res;
    try {
      res = await apiFetch(`/images/${fileId}${query}`);
    } catch {
      throw new ApiError(0, "Can't reach the server. Is it running?");
    }
    if (res.ok) return res.json();
    if (res.status !== 404) {
      const body = await res.json().catch(() => null);
      throw new ApiError(res.status, body?.detail || `HTTP ${res.status}`);
    }
  }
  const form = new FormData();
  form.append('file', file);
  onPhase?.('uploading');
  onTransfer?.({ fraction: 0, loaded: 0, total: file.size, bytesPerSec: null, etaSec: null });
  return apiUpload(`/images/upload${query}`, form, {
    onProgress: onTransfer,
    onSent: () => onPhase?.('decoding'),
  });
}

/**
 * The server's copy of an image as an object URL (the request needs the
 * session token, so it can't be a plain <img src>). null if the server no
 * longer has it. Revoke the URL when done with it.
 */
export async function fetchImageUrl(fileId) {
  const res = await apiFetch(`/images/${fileId}/raw`);
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiError(res.status, `Couldn't load the image (HTTP ${res.status}).`);
  return URL.createObjectURL(await res.blob());
}

/** Parse a labelImg / Pascal VOC .xml file on the server -> { filename, width, height, verified, boxes }. */
export async function parseVoc(file) {
  const form = new FormData();
  form.append('file', file);
  return apiJson('/voc/parse', { method: 'POST', body: form });
}

/** Save a fetch Response (or Blob) as a download. */
export async function saveDownload(resOrBlob, fallbackName) {
  let blob = resOrBlob;
  let name = fallbackName;
  if (resOrBlob instanceof Response) {
    if (!resOrBlob.ok) {
      const body = await resOrBlob.json().catch(() => null);
      throw new ApiError(resOrBlob.status, body?.detail || `Export failed (HTTP ${resOrBlob.status}).`);
    }
    const m = /filename="([^"]+)"/.exec(resOrBlob.headers.get('Content-Disposition') || '');
    if (m) name = m[1];
    blob = await resOrBlob.blob();
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Natural sort by file name, like labelImg's file list (img2 before img10). */
export const byFileName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** Boxes from another image size scaled onto this one, clamped and rounded. */
export function fitBoxes(boxes, from, to) {
  const sx = from?.width ? to.width / from.width : 1;
  const sy = from?.height ? to.height / from.height : 1;
  return boxes.map(b => {
    const box = {
      xmin: clamp(Math.round(Math.min(b.xmin, b.xmax) * sx), 0, to.width),
      ymin: clamp(Math.round(Math.min(b.ymin, b.ymax) * sy), 0, to.height),
      xmax: clamp(Math.round(Math.max(b.xmin, b.xmax) * sx), 0, to.width),
      ymax: clamp(Math.round(Math.max(b.ymin, b.ymax) * sy), 0, to.height),
    };
    return { ...b, box };
  }).filter(b => b.box.xmax - b.box.xmin >= 1 && b.box.ymax - b.box.ymin >= 1);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
