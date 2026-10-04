import { useState, useEffect, useRef, useCallback } from 'react';
import { SERVER } from '../config';

const CHUNK_DURATION = 180;
// Audio is only fetched around wherever playback currently is: the current
// chunk plus this many on each side. Blob URLs further away are revoked so a
// long session doesn't hold the whole file's WAV in memory. The spectrogram
// itself comes from the tile pyramid (see useTileViewer), so nothing else
// needs per-chunk data anymore.
const AUDIO_PREFETCH_RADIUS = 1;
const AUDIO_KEEP_RADIUS     = 2;

export function useAudioChunker() {
  const [status, setStatus]             = useState('idle');
  const [progress, setProgress]         = useState(0);
  const [fileName, setFileName]         = useState('');
  const [fileDuration, setFileDuration] = useState(0);
  const [sampleRate, setSampleRate]     = useState(16000);
  const [totalChunks, setTotalChunks]   = useState(0);
  const [currentChunk, setCurrentChunk] = useState(0);
  const [chunkUrls, setChunkUrls]       = useState({});
  const [overview, setOverview]         = useState(null);   // Float array, 0..1 RMS per point
  const [overviewStatus, setOverviewStatus] = useState('idle'); // idle | loading | ready | error

  const fileIdRef        = useRef(null);
  const urlCacheRef      = useRef({});
  const urlPendingRef    = useRef(new Set());
  const currentChunkRef  = useRef(0);
  const totalChunksRef   = useRef(0);

  useEffect(() => { currentChunkRef.current = currentChunk; }, [currentChunk]);
  useEffect(() => { totalChunksRef.current  = totalChunks; },  [totalChunks]);

  // -------------------------------------------------------------------------
  // WAV fetch — one chunk's audio as a blob URL for an <audio> element
  // -------------------------------------------------------------------------
  const fetchChunkUrl = useCallback((index) => {
    const total = totalChunksRef.current;
    if (index < 0 || (total > 0 && index >= total)) return;
    if (urlCacheRef.current[index])       return;
    if (urlPendingRef.current.has(index)) return;
    if (!fileIdRef.current)               return;

    const fileId = fileIdRef.current;
    urlPendingRef.current.add(index);
    fetch(`${SERVER}/chunk/${fileId}/${index}`)
      .then(res => { if (!res.ok) throw new Error(`${res.status}`); return res.blob(); })
      .then(blob => {
        urlPendingRef.current.delete(index);
        if (fileIdRef.current !== fileId) return; // a different file was loaded meanwhile
        urlCacheRef.current[index] = URL.createObjectURL(blob);
        setChunkUrls(prev => ({ ...prev, [index]: urlCacheRef.current[index] }));
      })
      .catch(err => {
        console.error(`Chunk ${index} WAV error:`, err);
        urlPendingRef.current.delete(index);
      });
  }, []);

  // Revoke blob URLs for chunks far from the current one.
  function _evictAudio(cur) {
    const stale = Object.keys(urlCacheRef.current)
      .map(Number)
      .filter(k => Math.abs(k - cur) > AUDIO_KEEP_RADIUS);
    if (stale.length === 0) return;
    stale.forEach(k => {
      URL.revokeObjectURL(urlCacheRef.current[k]);
      delete urlCacheRef.current[k];
    });
    setChunkUrls(prev => {
      const n = { ...prev };
      stale.forEach(k => delete n[k]);
      return n;
    });
  }

  // On chunk change: make sure the current chunk's audio (and its neighbours)
  // are loaded, and drop anything far away.
  useEffect(() => {
    if (status !== 'ready' || totalChunks === 0) return;
    fetchChunkUrl(currentChunk);
    for (let d = 1; d <= AUDIO_PREFETCH_RADIUS; d++) {
      fetchChunkUrl(currentChunk + d);
      fetchChunkUrl(currentChunk - d);
    }
    _evictAudio(currentChunk);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChunk, totalChunks, status, fetchChunkUrl]);

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

    Object.values(urlCacheRef.current).forEach(u => URL.revokeObjectURL(u));
    fileIdRef.current   = null;
    urlCacheRef.current = {};
    urlPendingRef.current.clear();
    setChunkUrls({});
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

      fileIdRef.current       = meta.file_id;
      totalChunksRef.current  = meta.total_chunks;
      currentChunkRef.current = 0;

      setFileDuration(meta.duration);
      setSampleRate(meta.sample_rate);
      setTotalChunks(meta.total_chunks);
      setCurrentChunk(0);
      setStatus('ready');

      fetchOverview(meta.file_id);

    } catch (err) {
      console.error('Load error:', err);
      setStatus('error');
    }
  }, [fetchOverview]);

  // -------------------------------------------------------------------------
  // onAudioTimeUpdate — advance to the next chunk when playback ends
  // -------------------------------------------------------------------------
  const onAudioTimeUpdate = useCallback((audioEl, bufferSeconds = 2) => {
    if (!audioEl) return;
    const total     = totalChunksRef.current;
    const cur       = currentChunkRef.current;
    const remaining = (audioEl.duration || 0) - audioEl.currentTime;
    if (Number.isFinite(remaining) && remaining <= bufferSeconds && cur + 1 < total) {
      fetchChunkUrl(cur + 1);
    }
    if (audioEl.ended && cur + 1 < total) {
      setCurrentChunk(cur + 1);
    }
  }, [fetchChunkUrl]);

  const goToChunk = useCallback((index) => setCurrentChunk(index), []);

  return {
    status, progress, fileName, fileDuration, sampleRate,
    totalChunks, currentChunk,
    fileId: fileIdRef.current,
    currentUrl: urlCacheRef.current[currentChunk] || null,
    chunkUrls,
    overview, overviewStatus,
    chunkStartTime: currentChunk * CHUNK_DURATION,
    chunkEndTime:   Math.min((currentChunk + 1) * CHUNK_DURATION, fileDuration),
    loadFile, goToChunk, onAudioTimeUpdate,
    CHUNK_DURATION,
  };
}
