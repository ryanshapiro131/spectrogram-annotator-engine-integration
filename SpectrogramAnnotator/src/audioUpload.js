import { apiFetch, apiUpload, ApiError } from './api';
import { SERVER } from './config';

// Resolves to the server's id for this file (see _file_id in server.py), or
// null if hashing fails — the caller then just uploads.
export function hashFile(file, onProgress) {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./workers/sha1.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      if (e.data.progress != null) { onProgress?.(e.data.progress); return; }
      worker.terminate();
      if (e.data.error) console.warn('File hashing failed, uploading instead:', e.data.error);
      resolve(e.data.fileId || null);
    };
    worker.onerror = (e) => { console.warn('File hashing failed, uploading instead:', e.message); worker.terminate(); resolve(null); };
    worker.postMessage({ file });
  });
}

/**
 * Get an audio file onto the server: hash locally -> ask the server if it
 * already has it (GET /files/{id}) -> upload only if it doesn't. With
 * projectId, the server also registers it in that project; the reply's
 * media_file_id is the project's media_files row.
 *
 *   onPhase('hashing' | 'uploading' | 'decoding')
 *   onTransfer({ fraction, loaded, total, bytesPerSec, etaSec })
 *   expectedFileId: refuse (before uploading) if the file isn't this recording
 *
 * Resolves to the server's file metadata (file_id, duration, sample_rate,
 * total_chunks, media_file_id, …).
 */
export async function uploadAudio(file, { projectId, expectedFileId, onPhase, onTransfer } = {}) {
  onPhase?.('hashing');
  onTransfer?.({ fraction: 0, loaded: 0, total: file.size, bytesPerSec: null, etaSec: null });

  const health = await fetch(`${SERVER}/health`).catch(() => null);
  if (!health?.ok) throw new ApiError(0, `Cannot reach the server at ${SERVER}. Is the backend running?`);

  const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';

  // Already on the server (uploaded before, by anyone)? Then skip the
  // upload entirely — over a slow VPN that's minutes saved.
  const fileId = await hashFile(file, (fraction) => onTransfer?.({ fraction, loaded: 0, total: file.size }));
  if (expectedFileId && fileId && fileId !== expectedFileId) {
    throw new ApiError(400, `"${file.name}" is a different recording from the one this entry was created from.`);
  }
  if (fileId) {
    const res = await apiFetch(`/files/${fileId}${query}`).catch(() => null);
    if (res?.ok) return res.json();
    if (res && res.status !== 404) {
      const body = await res.json().catch(() => null);
      throw new ApiError(res.status, body?.detail || `HTTP ${res.status}`);
    }
  }

  const form = new FormData();
  form.append('file', file);
  // n_fft/hop_length/n_mels/top_db only affect the legacy /sxx endpoint
  // (unused by the tile viewer) — fixed defaults matching the server's own.
  const params = new URLSearchParams({ n_fft: 1024, hop_length: 160, n_mels: 128, top_db: 80 });
  if (projectId) params.set('project_id', projectId);
  onPhase?.('uploading');
  onTransfer?.({ fraction: 0, loaded: 0, total: file.size, bytesPerSec: null, etaSec: null });
  return apiUpload(`/upload?${params}`, form, {
    onProgress: onTransfer,
    onSent: () => onPhase?.('decoding'), // all bytes sent; server is decoding
  });
}

/** Metadata for a file the server already has, or null if it's not cached there. */
export async function openServerFile(fileId) {
  const res = await apiFetch(`/files/${fileId}`);
  if (res.status === 404) return null;
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.detail || `HTTP ${res.status}`);
  return body;
}
