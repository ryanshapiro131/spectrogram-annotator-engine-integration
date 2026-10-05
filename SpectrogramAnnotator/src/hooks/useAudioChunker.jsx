import { useState, useCallback, useRef } from 'react';
import { SERVER } from '../config';

// Audio is split server-side into chunks of this many seconds for playback
// (see useAudioPlayback, which fetches them on demand).
const CHUNK_DURATION = 180;

// Upload + file metadata + the full-file overview waveform. Playback lives in
// useAudioPlayback; the spectrogram comes from the tile pyramid (useTileViewer).
export function useAudioChunker() {
  const [status, setStatus]             = useState('idle');
  const [progress, setProgress]         = useState(0);
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
  // File upload
  // -------------------------------------------------------------------------
  const loadFile = useCallback(async (file) => {
    setStatus('uploading');
    setProgress(0);
    setFileName(file.name);

    fileIdRef.current = null;
    setOverview(null);
    setOverviewStatus('idle');

    try {
      const health = await fetch(`${SERVER}/health`).catch(() => null);
      if (!health?.ok) throw new Error(
        `Cannot reach server at ${SERVER}.\nRun: py -m uvicorn server:app --port 8000`
      );

      setProgress(10);

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

      setStatus('decoding');
      setProgress(30);

      const res = await fetch(`${SERVER}/upload?${params}`, { method: 'POST', body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail || 'Upload failed');
      }

      const meta = await res.json();
      setProgress(100);

      fileIdRef.current = meta.file_id;
      setFileDuration(meta.duration);
      setSampleRate(meta.sample_rate);
      setTotalChunks(meta.total_chunks);
      setStatus('ready');

      fetchOverview(meta.file_id);

    } catch (err) {
      console.error('Load error:', err);
      setStatus('error');
    }
  }, [fetchOverview]);

  return {
    status, progress, fileName, fileDuration, sampleRate, totalChunks,
    fileId: fileIdRef.current,
    overview, overviewStatus,
    loadFile,
    CHUNK_DURATION,
  };
}
