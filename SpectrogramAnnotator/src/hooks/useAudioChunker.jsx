import { useState, useCallback, useRef } from 'react';
import { SERVER } from '../config';

// Audio is split server-side into chunks of this many seconds for playback
// (see useAudioPlayback, which fetches them on demand).
const CHUNK_DURATION = 180;

// Resolves to the server's id for this file (see _file_id in server.py), or
// null if hashing fails — the caller then just uploads.
function hashFile(file, onProgress) {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('../workers/sha1.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      if (e.data.progress != null) { onProgress(e.data.progress); return; }
      worker.terminate();
      if (e.data.error) console.warn('File hashing failed, uploading instead:', e.data.error);
      resolve(e.data.fileId || null);
    };
    worker.onerror = (e) => { console.warn('File hashing failed, uploading instead:', e.message); worker.terminate(); resolve(null); };
    worker.postMessage({ file });
  });
}

// POST with upload progress (fetch can't report it). onProgress gets the
// `transfer` shape; speed is averaged over the last ~5 s. onSent fires once
// every byte is out and the server starts processing.
function uploadWithProgress(url, body, onProgress, onSent) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.responseType = 'json';
    const samples = [];
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const now = performance.now();
      samples.push([now, e.loaded]);
      while (samples.length > 2 && now - samples[0][0] > 5000) samples.shift();
      const [t0, b0] = samples[0];
      const bytesPerSec = now - t0 > 1000 ? (e.loaded - b0) / ((now - t0) / 1000) : null;
      onProgress({
        fraction: e.loaded / e.total,
        loaded: e.loaded,
        total: e.total,
        bytesPerSec,
        etaSec: bytesPerSec ? (e.total - e.loaded) / bytesPerSec : null,
      });
    };
    xhr.upload.onload = onSent;
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
      else reject(new Error(xhr.response?.detail || `Upload failed (HTTP ${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error('Upload failed: the connection to the server was lost.'));
    xhr.send(body);
  });
}

// Upload + file metadata + the full-file overview waveform. Playback lives in
// useAudioPlayback; the spectrogram comes from the tile pyramid (useTileViewer).
export function useAudioChunker() {
  const [status, setStatus]             = useState('idle'); // idle | hashing | uploading | decoding | ready | error
  // { fraction 0..1, loaded, total (bytes), bytesPerSec, etaSec } for the
  // hashing/uploading phases.
  const [transfer, setTransfer]         = useState(null);
  const [error, setError]               = useState(null);
  const [fileName, setFileName]         = useState('');
  const [fileDuration, setFileDuration] = useState(0);
  const [sampleRate, setSampleRate]     = useState(16000);
  const [totalChunks, setTotalChunks]   = useState(0);
  const [overview, setOverview]         = useState(null);   // Float array, 0..1 RMS per point
  const [overviewStatus, setOverviewStatus] = useState('idle'); // idle | loading | ready | error

  const fileIdRef = useRef(null);

  // -------------------------------------------------------------------------
  // Overview — one downsampled RMS waveform for the whole file, fetched once
  // right after upload. Powers the full-file navigation strip.
  // -------------------------------------------------------------------------
  const fetchOverview = useCallback((fileId, numPoints = 2000) => {
    setOverviewStatus('loading');
    fetch(`${SERVER}/overview/${fileId}?num_points=${numPoints}`)
      .then(res => { if (!res.ok) throw new Error(`${res.status}`); return res.json(); })
      .then(data => {
        setOverview(data.points || null);
        setOverviewStatus('ready');
      })
      .catch(err => {
        console.error('Overview fetch error:', err);
        setOverview(null);
        setOverviewStatus('error');
      });
  }, []);

  // -------------------------------------------------------------------------
  // File load: hash locally -> ask the server if it already has the file ->
  // upload only if it doesn't. status walks hashing -> uploading ->
  // decoding (server is processing) -> ready; `transfer` carries progress.
  // -------------------------------------------------------------------------
  const loadFile = useCallback(async (file) => {
    setStatus('hashing');
    setError(null);
    setFileName(file.name);
    setTransfer({ fraction: 0, loaded: 0, total: file.size, bytesPerSec: null, etaSec: null });

    fileIdRef.current = null;
    setOverview(null);
    setOverviewStatus('idle');

    try {
      const health = await fetch(`${SERVER}/health`).catch(() => null);
      if (!health?.ok) throw new Error(
        `Cannot reach the server at ${SERVER}. Is the backend running?`
      );

      // Already on the server (uploaded before, by anyone)? Then skip the
      // upload entirely — over a slow VPN that's minutes saved.
      let meta = null;
      const fileId = await hashFile(file, (fraction) => setTransfer(t => ({ ...t, fraction })));
      if (fileId) {
        const res = await fetch(`${SERVER}/files/${fileId}`).catch(() => null);
        if (res?.ok) meta = await res.json();
      }

      if (!meta) {
        const form   = new FormData();
        form.append('file', file);
        // n_fft/hop_length/n_mels/top_db only affect the legacy /sxx endpoint
        // (unused by the tile viewer) — they used to be live UI sliders, now
        // just fixed defaults matching the server's own. See server.py's
        // /upload signature.
        const params = new URLSearchParams({
          n_fft: 1024, hop_length: 160,
          n_mels: 128, top_db: 80,
        });
        setStatus('uploading');
        setTransfer({ fraction: 0, loaded: 0, total: file.size, bytesPerSec: null, etaSec: null });
        meta = await uploadWithProgress(
          `${SERVER}/upload?${params}`, form,
          setTransfer,
          () => setStatus('decoding'),  // all bytes sent; server is decoding
        );
      }

      fileIdRef.current = meta.file_id;
      setFileDuration(meta.duration);
      setSampleRate(meta.sample_rate);
      setTotalChunks(meta.total_chunks);
      setStatus('ready');

      fetchOverview(meta.file_id);

    } catch (err) {
      console.error('Load error:', err);
      setError(err.message);
      setStatus('error');
    }
  }, [fetchOverview]);

  return {
    status, transfer, error, fileName, fileDuration, sampleRate, totalChunks,
    fileId: fileIdRef.current,
    overview, overviewStatus,
    loadFile,
    CHUNK_DURATION,
  };
}
