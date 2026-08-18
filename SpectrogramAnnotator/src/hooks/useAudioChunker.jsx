import { useState, useEffect, useRef, useCallback } from 'react';

const CHUNK_DURATION = 180;
const SERVER         = 'http://localhost:8000';
// How many chunks' worth of sxx matrices to keep in memory on EACH SIDE of
// wherever the user currently is. 20 chunks * 3 min = 60 min each way, so
// up to 2 hours stays instantly navigable around the current position
// without a refetch. Chunks outside this window are evicted from memory
// (but the server still has them cached to disk, so revisiting is fast,
// not a recompute).
const SXX_CACHE_RADIUS = 40;

export function useAudioChunker(spectrogramSettings) {
  const [status, setStatus]             = useState('idle');
  const [progress, setProgress]         = useState(0);
  const [fileName, setFileName]         = useState('');
  const [fileDuration, setFileDuration] = useState(0);
  const [sampleRate, setSampleRate]     = useState(16000);
  const [totalChunks, setTotalChunks]   = useState(0);
  const [currentChunk, setCurrentChunk] = useState(0);
  const [chunkUrls, setChunkUrls]       = useState({});
  const [sxxCache, setSxxCache]         = useState({});
  const [sxxStatus, setSxxStatus]       = useState({});
  const [overview, setOverview]         = useState(null);   // Float array, 0..1 RMS per point
  const [overviewStatus, setOverviewStatus] = useState('idle'); // idle | loading | ready | error

  const fileIdRef        = useRef(null);
  const urlCacheRef      = useRef({});
  const urlPendingRef    = useRef(new Set());
  const sxxCacheRef      = useRef({});
  const sxxPendingRef    = useRef(new Set());
  const chainFrontierRef = useRef(-1);
  const currentChunkRef  = useRef(0);
  const settingsRef      = useRef(spectrogramSettings);
  const totalChunksRef   = useRef(0);
  // Pool of reusable parse workers — one per logical CPU, max 4
  const workerPoolRef    = useRef(null);
  const workerQueueRef   = useRef([]);   // pending jobs waiting for a free worker
  const idleWorkersRef   = useRef([]);   // workers currently free

  useEffect(() => { settingsRef.current   = spectrogramSettings; }, [spectrogramSettings]);
  useEffect(() => { currentChunkRef.current = currentChunk; },     [currentChunk]);
  useEffect(() => { totalChunksRef.current  = totalChunks; },      [totalChunks]);

  // -------------------------------------------------------------------------
  // Worker pool — fetch + JSON.parse happens in workers, main thread stays free
  // -------------------------------------------------------------------------
  useEffect(() => {
    const size    = Math.min(Math.max(1, (navigator.hardwareConcurrency || 4) - 1), 4);
    const workers = Array.from({ length: size }, () =>
      new Worker(new URL('../workers/sxx.worker.js', import.meta.url))
    );

    workers.forEach(w => {
      idleWorkersRef.current.push(w);
      w.onmessage = (e) => {
        const { chunkIndex, sxx, error } = e.data;
        idleWorkersRef.current.push(w);   // return worker to pool
        _onSxxResult(chunkIndex, sxx, error);
        _drainQueue();
      };
    });

    workerPoolRef.current = workers;
    return () => workers.forEach(w => w.terminate());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function _drainQueue() {
    while (workerQueueRef.current.length > 0 && idleWorkersRef.current.length > 0) {
      const job    = workerQueueRef.current.shift();
      const worker = idleWorkersRef.current.pop();
      worker.postMessage(job);
    }
  }

  function _onSxxResult(chunkIndex, sxx, error) {
    sxxPendingRef.current.delete(chunkIndex);

    if (error || !sxx) {
      console.error(`Chunk ${chunkIndex} sxx error:`, error);
      setSxxStatus(prev => ({ ...prev, [chunkIndex]: 'error' }));
    } else {
      sxxCacheRef.current[chunkIndex]  = sxx;
      setSxxCache(prev => ({ ...prev, [chunkIndex]: sxx }));
      setSxxStatus(prev => ({ ...prev, [chunkIndex]: 'ready' }));
    }

    // Advance sequential chain regardless of error
    if (chunkIndex === chainFrontierRef.current) {
      const next  = chunkIndex + 1;
      const total = totalChunksRef.current;
      if (next < total) {
        chainFrontierRef.current = next;
        _dispatchChunk(next);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Windowed eviction — frees the heavy in-memory sxx matrix for chunks
  // that fall outside a window centered on wherever the user CURRENTLY is
  // (± SXX_CACHE_RADIUS chunks), rather than a plain least-recently-used
  // cache. Plain LRU drifts: as the sequential background loader keeps
  // computing new chunks ahead, they look "more recent" than the chunk the
  // user is actually sitting on, so LRU would evict the user's own
  // surroundings first — the opposite of what we want. Centering on the
  // current position instead guarantees nearby navigation (in either
  // direction) always stays instant.
  //
  // This does NOT touch sxxStatus: once a chunk has been computed it stays
  // 'ready' for nav/coloring purposes even after its matrix is evicted from
  // memory. The server has it cached to disk, so if the chunk is revisited
  // later, _dispatchSxx below will refetch it near-instantly rather than
  // recomputing.
  // -------------------------------------------------------------------------
  function _evictIfNeeded() {
    const cur   = currentChunkRef.current;
    const stale = Object.keys(sxxCacheRef.current)
      .map(Number)
      .filter(k => Math.abs(k - cur) > SXX_CACHE_RADIUS);

    if (stale.length === 0) return;

    stale.forEach(k => { delete sxxCacheRef.current[k]; });
    setSxxCache(prev => {
      const n = { ...prev };
      stale.forEach(k => delete n[k]);
      return n;
    });
  }

  // -------------------------------------------------------------------------
  // WAV fetch — stays on main thread (blob URL, no parsing needed)
  // -------------------------------------------------------------------------
  const fetchChunkUrl = useCallback((index) => {
    if (urlCacheRef.current[index])       return;
    if (urlPendingRef.current.has(index)) return;
    if (!fileIdRef.current)               return;

    urlPendingRef.current.add(index);
    fetch(`${SERVER}/chunk/${fileIdRef.current}/${index}`)
      .then(res => { if (!res.ok) throw new Error(`${res.status}`); return res.blob(); })
      .then(blob => {
        urlCacheRef.current[index] = URL.createObjectURL(blob);
        urlPendingRef.current.delete(index);
        setChunkUrls(prev => ({ ...prev, [index]: urlCacheRef.current[index] }));
      })
      .catch(err => {
        console.error(`Chunk ${index} WAV error:`, err);
        urlPendingRef.current.delete(index);
      });
  }, []);

  // -------------------------------------------------------------------------
  // sxx dispatch — hands off to a worker for fetch + parse
  // -------------------------------------------------------------------------
  function _dispatchSxx(index) {
    if (sxxCacheRef.current[index])       return;
    if (sxxPendingRef.current.has(index)) return;
    if (!fileIdRef.current)               return;

    _evictIfNeeded();
    sxxPendingRef.current.add(index);
    setSxxStatus(prev => ({ ...prev, [index]: 'pending' }));

    const job = {
      chunkIndex: index,
      url: `${SERVER}/sxx/${fileIdRef.current}/${index}`,
    };

    if (idleWorkersRef.current.length > 0) {
      const worker = idleWorkersRef.current.pop();
      worker.postMessage(job);
    } else {
      workerQueueRef.current.push(job);
    }
  }

  // -------------------------------------------------------------------------
  // Load one chunk (WAV + sxx)
  // -------------------------------------------------------------------------
  function _dispatchChunk(index) {
    const total = totalChunksRef.current;
    if (index < 0 || (total > 0 && index >= total)) return;
    if (sxxCacheRef.current[index]) return;
    fetchChunkUrl(index);
    _dispatchSxx(index);
  }

  const loadChunk = useCallback((index) => {
    _dispatchChunk(index);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchChunkUrl]);

  // -------------------------------------------------------------------------
  // On chunk change: load current chunk, reset frontier if jumped forward
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (status !== 'ready' || totalChunks === 0) return;
    _dispatchChunk(currentChunk);
    _evictIfNeeded();
    if (currentChunk > chainFrontierRef.current) {
      chainFrontierRef.current = currentChunk;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChunk, totalChunks, status]);

  // Start sequential chain from chunk 0 when file is ready
  useEffect(() => {
    if (status !== 'ready' || totalChunks === 0) return;
    chainFrontierRef.current = 0;
    _dispatchChunk(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

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
    // Cancel any queued worker jobs
    workerQueueRef.current = [];

    setStatus('uploading');
    setProgress(0);
    setFileName(file.name);

    fileIdRef.current        = null;
    urlCacheRef.current      = {};
    sxxCacheRef.current      = {};
    chainFrontierRef.current = -1;
    urlPendingRef.current.clear();
    sxxPendingRef.current.clear();
    setChunkUrls({});
    setSxxCache({});
    setSxxStatus({});
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

      // Kick off the full-file overview waveform in parallel — it's a single
      // fast RMS pass server-side and doesn't block chunk/sxx loading.
      fetchOverview(meta.file_id);

    } catch (err) {
      console.error('Load error:', err);
      setStatus('error');
    }
  }, [fetchOverview]);

  // -------------------------------------------------------------------------
  // onAudioTimeUpdate
  // -------------------------------------------------------------------------
  const onAudioTimeUpdate = useCallback((audioEl, bufferSeconds = 2) => {
    if (!audioEl) return;
    const total     = totalChunksRef.current;
    const cur       = currentChunkRef.current;
    const remaining = (audioEl.duration || 0) - audioEl.currentTime;
    if (Number.isFinite(remaining) && remaining <= bufferSeconds && cur + 1 < total) {
      _dispatchChunk(cur + 1);
    }
    if (audioEl.ended && cur + 1 < total) {
      setCurrentChunk(cur + 1);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goToChunk = useCallback((index) => setCurrentChunk(index), []);

  return {
    status, progress, fileName, fileDuration, sampleRate,
    totalChunks, currentChunk,
    fileId: fileIdRef.current,
    currentUrl: urlCacheRef.current[currentChunk] || null,
    chunkUrls, sxxCache, sxxStatus,
    overview, overviewStatus,
    chunkStartTime: currentChunk * CHUNK_DURATION,
    chunkEndTime:   Math.min((currentChunk + 1) * CHUNK_DURATION, fileDuration),
    loadFile, goToChunk, onAudioTimeUpdate,
    CHUNK_DURATION,
  };
}