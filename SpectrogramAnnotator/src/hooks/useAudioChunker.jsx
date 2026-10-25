import { useState, useCallback, useRef } from 'react';
import { apiJson } from '../api';
import { uploadAudio, openServerFile } from '../audioUpload';

// Audio is split server-side into chunks of this many seconds for playback
// (see useAudioPlayback, which fetches them on demand).
const CHUNK_DURATION = 180;

// Upload + file metadata + the full-file overview waveform. Playback lives in
// useAudioPlayback; the spectrogram comes from the tile pyramid (useTileViewer).
export function useAudioChunker() {
  // idle | opening | hashing | uploading | decoding | ready | missing | error
  // (`missing`: openById found the file isn't cached on the server anymore)
  const [status, setStatus]             = useState('idle');
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
  const loadTokenRef = useRef(0); // bumped per load/reset; stale loads bail out

  // -------------------------------------------------------------------------
  // Overview — one downsampled RMS waveform for the whole file, fetched once
  // right after upload. Powers the full-file navigation strip.
  // -------------------------------------------------------------------------
  const fetchOverview = useCallback((fileId, token, numPoints = 2000) => {
    setOverviewStatus('loading');
    apiJson(`/overview/${fileId}?num_points=${numPoints}`)
      .then(data => {
        if (token !== loadTokenRef.current) return;
        setOverview(data.points || null);
        setOverviewStatus('ready');
      })
      .catch(err => {
        if (token !== loadTokenRef.current) return;
        console.error('Overview fetch error:', err);
        setOverview(null);
        setOverviewStatus('error');
      });
  }, []);

  const begin = useCallback((name) => {
    const token = ++loadTokenRef.current;
    setError(null);
    setFileName(name);
    fileIdRef.current = null;
    setOverview(null);
    setOverviewStatus('idle');
    return token;
  }, []);

  const finish = useCallback((meta, token) => {
    if (token !== loadTokenRef.current) return;
    fileIdRef.current = meta.file_id;
    setFileDuration(meta.duration);
    setSampleRate(meta.sample_rate);
    setTotalChunks(meta.total_chunks);
    setStatus('ready');
    fetchOverview(meta.file_id, token);
  }, [fetchOverview]);

  const fail = useCallback((err, token) => {
    if (token !== loadTokenRef.current) return;
    console.error('Load error:', err);
    setError(err.message);
    setStatus('error');
  }, []);

  // -------------------------------------------------------------------------
  // Load a local file: hash -> skip upload if the server has it -> upload.
  // status walks hashing -> uploading -> decoding (server is processing) ->
  // ready; `transfer` carries progress. Options go to uploadAudio
  // (projectId to register it in a project, expectedFileId).
  // -------------------------------------------------------------------------
  const loadFile = useCallback(async (file, options = {}) => {
    const token = begin(file.name);
    setStatus('hashing');
    try {
      const meta = await uploadAudio(file, {
        ...options,
        onPhase: (phase) => { if (token === loadTokenRef.current) setStatus(phase); },
        onTransfer: (t) => { if (token === loadTokenRef.current) setTransfer(prev => ({ ...prev, ...t })); },
      });
      finish(meta, token);
      return meta;
    } catch (err) {
      fail(err, token);
      return null;
    }
  }, [begin, finish, fail]);

  // -------------------------------------------------------------------------
  // Open a file the server already has, by its file_id (a project's
  // media_files.content_hash). If the server's cache no longer has it,
  // status becomes 'missing' and the caller can offer a re-upload.
  // -------------------------------------------------------------------------
  const openById = useCallback(async (fileId, name) => {
    const token = begin(name || fileId);
    setStatus('opening');
    try {
      const meta = await openServerFile(fileId);
      if (token !== loadTokenRef.current) return;
      if (!meta) { setStatus('missing'); return; }
      finish(meta, token);
    } catch (err) {
      fail(err, token);
    }
  }, [begin, finish, fail]);

  const reset = useCallback(() => {
    begin('');
    setStatus('idle');
    setTransfer(null);
    setFileDuration(0);
    setTotalChunks(0);
  }, [begin]);

  return {
    status, transfer, error, fileName, fileDuration, sampleRate, totalChunks,
    fileId: fileIdRef.current,
    overview, overviewStatus,
    loadFile, openById, reset,
    CHUNK_DURATION,
  };
}
