import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { SERVER } from '../config';

// Ogg Vorbis is sample-accurate (the playhead must line up with annotations)
// and ~10x smaller than WAV. Browsers without Ogg support get MP3.
const CHUNK_FORMAT =
  typeof Audio !== 'undefined' && new Audio().canPlayType('audio/ogg; codecs=vorbis') ? 'ogg' : 'mp3';

// Decoded chunks kept around the one playing; the rest are released.
const KEEP_RADIUS = 2;

/*
 * Plays a long file that the server serves as fixed-length chunks
 * (/chunk/{file}/{index}), as if it were one continuous track.
 *
 * Audio is fetched on demand: seeking while paused only moves the position;
 * nothing is downloaded until play is pressed. While playing, the next chunk
 * is prefetched so playback continues across the boundary.
 *
 * The position (absolute seconds in the file) changes every frame while
 * playing, so it lives in a small external store (positionStore, for
 * useSyncExternalStore) plus an onFrame callback, instead of React state —
 * the rest of the app doesn't re-render 60 times a second.
 */
export function useAudioPlayback({ fileId, totalChunks, chunkDuration, fileDuration, onFrame }) {
  const audioRef = useRef(null);
  if (audioRef.current === null && typeof Audio !== 'undefined') audioRef.current = new Audio();

  const [isPlaying, setIsPlaying]       = useState(false);
  const [isLoading, setIsLoading]       = useState(false);
  const [error, setError]               = useState(null);
  const [loadedChunks, setLoadedChunks] = useState(() => new Set());
  const [currentChunk, setCurrentChunk] = useState(0);
  const [rate, setRateState]            = useState(1);
  const [volume, setVolumeState]        = useState(1);
  const [muted, setMutedState]          = useState(false);

  const urlsRef      = useRef({});   // chunk index -> blob URL
  const pendingRef   = useRef({});   // chunk index -> Promise<blob URL>
  const srcChunkRef  = useRef(null); // chunk currently loaded into the <audio>
  const playingRef   = useRef(false);
  const tokenRef     = useRef(0);    // bumped to cancel an in-progress start
  const posRef       = useRef(0);
  const listenersRef = useRef(new Set());
  const fileIdRef    = useRef(fileId);
  const metaRef      = useRef({ totalChunks, chunkDuration, fileDuration });
  const onFrameRef   = useRef(onFrame);
  fileIdRef.current  = fileId;
  metaRef.current    = { totalChunks, chunkDuration, fileDuration };
  onFrameRef.current = onFrame;

  const chunkOf = (t) => {
    const { totalChunks: n, chunkDuration: d } = metaRef.current;
    return Math.min(Math.max(0, n - 1), Math.max(0, Math.floor(t / d)));
  };

  const setPos = useCallback((t) => {
    posRef.current = t;
    setCurrentChunk(chunkOf(t));
    listenersRef.current.forEach(l => l());
    onFrameRef.current?.(t);
  }, []);

  const positionStore = useMemo(() => ({
    get: () => posRef.current,
    subscribe: (listener) => {
      listenersRef.current.add(listener);
      return () => listenersRef.current.delete(listener);
    },
  }), []);

  // -------------------------------------------------------------------------
  // Chunk loading
  // -------------------------------------------------------------------------
  const loadChunk = useCallback((idx) => {
    if (urlsRef.current[idx]) return Promise.resolve(urlsRef.current[idx]);
    if (pendingRef.current[idx]) return pendingRef.current[idx];
    const fid = fileIdRef.current;
    const p = fetch(`${SERVER}/chunk/${fid}/${idx}?format=${CHUNK_FORMAT}`)
      .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.blob(); })
      .then(blob => {
        if (fileIdRef.current !== fid) throw new Error('file changed');
        const url = URL.createObjectURL(blob);
        urlsRef.current[idx] = url;
        setLoadedChunks(prev => new Set(prev).add(idx));
        return url;
      })
      .finally(() => { delete pendingRef.current[idx]; });
    pendingRef.current[idx] = p;
    return p;
  }, []);

  const evictFarChunks = useCallback((cur) => {
    const stale = Object.keys(urlsRef.current).map(Number)
      .filter(k => Math.abs(k - cur) > KEEP_RADIUS && k !== srcChunkRef.current);
    if (!stale.length) return;
    stale.forEach(k => { URL.revokeObjectURL(urlsRef.current[k]); delete urlsRef.current[k]; });
    setLoadedChunks(prev => {
      const next = new Set(prev);
      stale.forEach(k => next.delete(k));
      return next;
    });
  }, []);

  // Load the chunk containing `t` into the <audio>, seek to `t`, and start
  // playing if playback is still wanted. Superseded calls bail out early.
  const startAt = useCallback(async (t) => {
    const audio = audioRef.current;
    const token = ++tokenRef.current;
    const idx = chunkOf(t);
    const local = t - idx * metaRef.current.chunkDuration;

    if (srcChunkRef.current !== idx) {
      setIsLoading(true);
      let url;
      try {
        url = await loadChunk(idx);
      } catch (err) {
        if (token !== tokenRef.current) return;
        console.error(`Audio chunk ${idx} failed to load:`, err);
        setError('Could not load audio. Press play to retry.');
        setIsLoading(false);
        playingRef.current = false;
        setIsPlaying(false);
        return;
      }
      if (token !== tokenRef.current) return;
      audio.src = url;
      srcChunkRef.current = idx;
      if (audio.readyState < 1) {
        await new Promise(res => audio.addEventListener('loadedmetadata', res, { once: true }));
        if (token !== tokenRef.current) return;
      }
    }

    audio.currentTime = local;
    setIsLoading(false);
    if (!playingRef.current) return;
    try {
      await audio.play();
    } catch (err) {
      if (token !== tokenRef.current || err.name === 'AbortError') return;
      console.error('Audio play failed:', err);
      setError('Playback failed. Press play to retry.');
      playingRef.current = false;
      setIsPlaying(false);
      return;
    }
    if (idx + 1 < metaRef.current.totalChunks) loadChunk(idx + 1).catch(() => {});
    evictFarChunks(idx);
  }, [loadChunk, evictFarChunks]);

  // -------------------------------------------------------------------------
  // Public controls
  // -------------------------------------------------------------------------
  const play = useCallback(() => {
    if (!fileIdRef.current || !metaRef.current.totalChunks) return;
    setError(null);
    if (posRef.current >= metaRef.current.fileDuration - 0.05) setPos(0);
    playingRef.current = true;
    setIsPlaying(true);
    startAt(posRef.current);
  }, [startAt, setPos]);

  const pause = useCallback(() => {
    playingRef.current = false;
    tokenRef.current++;
    setIsPlaying(false);
    setIsLoading(false);
    audioRef.current?.pause();
  }, []);

  const toggle = useCallback(() => {
    if (playingRef.current) pause(); else play();
  }, [play, pause]);

  // Seeking while paused only moves the position — no download until play.
  const seek = useCallback((t) => {
    const dur = metaRef.current.fileDuration || 0;
    const clamped = Math.min(dur, Math.max(0, t));
    setPos(clamped);
    if (playingRef.current) {
      startAt(clamped);
    } else if (srcChunkRef.current === chunkOf(clamped) && audioRef.current.readyState >= 1) {
      audioRef.current.currentTime = clamped - srcChunkRef.current * metaRef.current.chunkDuration;
    }
  }, [startAt, setPos]);

  const skip = useCallback((dt) => seek(posRef.current + dt), [seek]);

  const setRate = useCallback((r) => {
    const audio = audioRef.current;
    audio.playbackRate = r;
    audio.defaultPlaybackRate = r; // survives src changes between chunks
    setRateState(r);
  }, []);

  const setVolume = useCallback((v) => {
    audioRef.current.volume = v;
    if (v > 0 && audioRef.current.muted) { audioRef.current.muted = false; setMutedState(false); }
    setVolumeState(v);
  }, []);

  const setMuted = useCallback((m) => {
    audioRef.current.muted = m;
    setMutedState(m);
  }, []);

  // -------------------------------------------------------------------------
  // <audio> events: advance across chunk boundaries, reflect buffering
  // -------------------------------------------------------------------------
  useEffect(() => {
    const audio = audioRef.current;
    const onEnded = () => {
      if (!playingRef.current) return;
      const next = (srcChunkRef.current ?? 0) + 1;
      if (next < metaRef.current.totalChunks) {
        const t = next * metaRef.current.chunkDuration;
        setPos(t);
        startAt(t);
      } else {
        playingRef.current = false;
        setIsPlaying(false);
        setPos(metaRef.current.fileDuration);
      }
    };
    const onWaiting = () => { if (playingRef.current) setIsLoading(true); };
    const onPlaying = () => setIsLoading(false);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('waiting', onWaiting);
    audio.addEventListener('playing', onPlaying);
    return () => {
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('waiting', onWaiting);
      audio.removeEventListener('playing', onPlaying);
    };
  }, [startAt, setPos]);

  // While playing, publish the position every frame.
  useEffect(() => {
    if (!isPlaying) return undefined;
    let raf;
    const tick = () => {
      const audio = audioRef.current;
      if (!audio.paused && srcChunkRef.current != null) {
        setPos(srcChunkRef.current * metaRef.current.chunkDuration + audio.currentTime);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, setPos]);

  // New file (or unmount): stop and release everything.
  useEffect(() => {
    const reset = () => {
      playingRef.current = false;
      tokenRef.current++;
      const audio = audioRef.current;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      Object.values(urlsRef.current).forEach(u => URL.revokeObjectURL(u));
      urlsRef.current = {};
      pendingRef.current = {};
      srcChunkRef.current = null;
      setIsPlaying(false);
      setIsLoading(false);
      setError(null);
      setLoadedChunks(new Set());
    };
    reset();
    setPos(0);
    return reset;
  }, [fileId, setPos]);

  return {
    isPlaying, isLoading, error, loadedChunks, currentChunk,
    rate, volume, muted,
    positionStore,
    getPosition: () => posRef.current,
    play, pause, toggle, seek, skip, setRate, setVolume, setMuted,
  };
}
