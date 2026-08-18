import { useState, useEffect, useRef } from 'react';

const SERVER = 'http://localhost:8000';
const POLL_MS = 1000;

/*
 * useTileViewer
 *
 * Tracks the spectrogram-engine tile-pyramid generation for the current
 * file. Generation is a one-time background job on the server (kicked off
 * in /upload) — this hook just polls /tiles-status until it's ready, then
 * hands back the manifest/tile URLs TileSpectrogramViewer needs. There's no
 * per-chunk or per-view fetching here; once status is "ready" the frontend
 * never asks the server to compute anything for this file again.
 */
export function useTileViewer(fileId) {
  const [status, setStatus] = useState('idle'); // idle | pending | running | ready | error
  const [error, setError] = useState(null);
  const timerRef = useRef(null);

  useEffect(() => {
    clearTimeout(timerRef.current);
    if (!fileId) {
      setStatus('idle');
      setError(null);
      return undefined;
    }

    let cancelled = false;
    setStatus('pending');
    setError(null);

    const poll = () => {
      fetch(`${SERVER}/tiles-status/${fileId}`)
        .then(res => { if (!res.ok) throw new Error(`${res.status}`); return res.json(); })
        .then(data => {
          if (cancelled) return;
          setStatus(data.status);
          setError(data.error || null);
          if (data.status === 'pending' || data.status === 'running') {
            timerRef.current = setTimeout(poll, POLL_MS);
          }
        })
        .catch(err => {
          if (cancelled) return;
          console.error('Tile status poll error:', err);
          timerRef.current = setTimeout(poll, POLL_MS * 2);
        });
    };
    poll();

    return () => { cancelled = true; clearTimeout(timerRef.current); };
  }, [fileId]);

  return {
    status,
    error,
    isReady: status === 'ready',
    manifestUrl: fileId ? `${SERVER}/tiles/${fileId}/manifest.json` : null,
    tileBaseUrl: fileId ? `${SERVER}/tiles/${fileId}/` : null,
  };
}
