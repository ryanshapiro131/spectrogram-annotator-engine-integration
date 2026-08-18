import React, { useRef, useEffect, useCallback, useImperativeHandle, forwardRef, useState } from 'react';
import './TileSpectrogramViewer.css';

/*
 * TileSpectrogramViewer
 *
 * Renders a spectrogram from a spectrogram-engine tile pyramid (manifest.json
 * + w<N>/L<level>/<tile>.png), instead of a raw magnitude matrix. Ported from
 * the engine's own viewer/app.js, trimmed to what this app needs:
 *
 *   - ONE viewer spans the whole file's timeline (in absolute seconds), not
 *     one per 3-minute chunk — the tile pyramid isn't chunked, so there's no
 *     reason for the viewer to be either. Chunking still exists one layer up
 *     for streaming *audio* playback, but the spectrogram no longer cares.
 *   - Horizontal (time) pan/zoom only. The engine viewer also supports
 *     vertical frequency zoom, but nothing in this app's annotation model
 *     uses a frequency range, so that's left out to keep this component
 *     small — add it back by porting zoomFreq/clampVertical from
 *     viewer/app.js if a future annotation type needs it.
 *   - No client-side colormap/dB-range control: tiles are baked at
 *     generation time by the engine. If you need to change colormap or
 *     top_db, that's now an engine-generation-time setting, not a runtime
 *     one (see server.py's ENGINE_BIN invocation).
 *
 * Exposes getVisibleWindow() via ref, in ABSOLUTE file seconds — this is the
 * same contract SpectrogramOverlay expects (see its comment block), so the
 * annotation overlay works unmodified whether it's sitting on top of this
 * viewer or (in principle) something else that implements the same ref API.
 */

const L0_MAX_PX = 8;   // one native column may stretch to at most this many px
const WHEEL_SENS = 0.0022;
const WHEEL_CAP = 0.08;
const CLICK_DRAG_THRESHOLD = 4; // px — below this, a pointerup counts as a click/seek, not a pan

const TileSpectrogramViewer = forwardRef(function TileSpectrogramViewer(
  {
    manifestUrl,       // e.g. `${SERVER}/tiles/${fileId}/manifest.json`
    tileBaseUrl,        // e.g. `${SERVER}/tiles/${fileId}/`  (manifest's tilePathPattern is relative to this)
    height = 220,
    playheadTime = null,   // absolute seconds, draws a line if provided
    onSeek = null,          // (absoluteSeconds) => void — called on plain click (not drag)
    onVisibleWindowChange = null, // ({start,end}) => void, called after pan/zoom settles
    freqCropTop = 0,        // 0..1 — fraction of the top (highest-freq) rows to crop out of view
  },
  ref
) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const ctxRef = useRef(null);
  const cropTopRef = useRef(freqCropTop);
  // Smallest row index (0 = top/highest-freq) that any analyzed tile has
  // been found to contain real signal in, for the currently loaded file.
  // Cropping is capped to this so a loud transient that only reaches high
  // frequencies occasionally can never get silently sliced off — see
  // analyzeTileSignalTop() below.
  const signalTopRowRef = useRef(null);
  const analysisCanvasRef = useRef(null);

  const [status, setStatus] = useState('loading'); // loading | ready | error
  const manifestRef = useRef(null);
  const curWindowRef = useRef(null);
  const tileCacheRef = useRef(new Map());
  const viewRef = useRef({ startSec: 0, secPerPx: 1 });
  const sizeRef = useRef({ cssW: 0, cssH: height, dpr: 1 });
  const drawPendingRef = useRef(false);
  const dragRef = useRef(null); // { startX, startSec, moved }
  const playheadRef = useRef(playheadTime);

  // -------------------------------------------------------------------
  // Manifest load
  // -------------------------------------------------------------------
  useEffect(() => {
    if (!manifestUrl) return;
    let cancelled = false;
    setStatus('loading');
    tileCacheRef.current.clear();

    fetch(manifestUrl, { cache: 'no-store' })
      .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
      .then(manifest => {
        if (cancelled) return;
        manifest.windows = [...manifest.windows].sort((a, b) => a.fftSize - b.fftSize);
        manifestRef.current = manifest;
        curWindowRef.current =
          manifest.windows.find(w => w.fftSize === manifest.defaultWindow) || manifest.windows[0];
        signalTopRowRef.current = null; // reset the safety cap for the new file
        fitAll();
        setStatus('ready');
        scheduleDraw();
        notifyVisibleWindow();
      })
      .catch(err => {
        if (cancelled) return;
        console.error('TileSpectrogramViewer: manifest load failed', err);
        setStatus('error');
      });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifestUrl]);

  // Keep the crop fraction in a ref (read inside draw(), which isn't itself
  // a useCallback) and redraw whenever it changes.
  useEffect(() => {
    cropTopRef.current = Math.min(0.95, Math.max(0, freqCropTop || 0));
    scheduleDraw();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freqCropTop]);

  // -------------------------------------------------------------------
  // Sizing — canvas backing store follows container width via ResizeObserver
  // -------------------------------------------------------------------
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const canvas = canvasRef.current;
    ctxRef.current = canvas.getContext('2d', { alpha: false });

    const resize = () => {
      const rect = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      sizeRef.current = { cssW: rect.width, cssH: height, dpr };
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${height}px`;
      clampView();
      scheduleDraw();
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    return () => ro.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height]);

  // -------------------------------------------------------------------
  // View helpers (ported from the engine's viewer/app.js, time-axis only)
  // -------------------------------------------------------------------
  function level0() { return curWindowRef.current.levels[0]; }
  function maxLevel() { return curWindowRef.current.levels[curWindowRef.current.levels.length - 1].level; }

  function zoomRange() {
    const manifest = manifestRef.current;
    const { cssW } = sizeRef.current;
    const dur = manifest.durationSeconds;
    const spc0 = level0().secondsPerColumn;
    const maxSPP = Math.max(dur / Math.max(1, cssW), 1e-9);
    const minSPP = Math.min(spc0 / L0_MAX_PX, maxSPP);
    return { minSPP, maxSPP };
  }

  function clampView() {
    if (!manifestRef.current) return;
    const { minSPP, maxSPP } = zoomRange();
    const view = viewRef.current;
    view.secPerPx = clamp(view.secPerPx, minSPP, maxSPP);
    const { cssW } = sizeRef.current;
    const visibleSec = view.secPerPx * cssW;
    const dur = manifestRef.current.durationSeconds;
    view.startSec = clamp(view.startSec, 0, Math.max(0, dur - visibleSec));
  }

  function fitAll() {
    const { cssW } = sizeRef.current;
    const manifest = manifestRef.current;
    viewRef.current = {
      startSec: 0,
      secPerPx: manifest.durationSeconds / Math.max(1, cssW || 1),
    };
    clampView();
  }

  function pickLevel() {
    const spc0 = level0().secondsPerColumn;
    return clamp(Math.round(Math.log2(viewRef.current.secPerPx / spc0)), 0, maxLevel());
  }

  function timeAtX(x) { return viewRef.current.startSec + x * viewRef.current.secPerPx; }

  function zoomTime(factor, anchorX) {
    const tUnder = timeAtX(anchorX);
    const view = viewRef.current;
    view.secPerPx *= factor;
    clampView();
    view.startSec = tUnder - anchorX * view.secPerPx;
    clampView();
  }

  function notifyVisibleWindow() {
    if (!onVisibleWindowChange) return;
    const { startSec, secPerPx } = viewRef.current;
    const { cssW } = sizeRef.current;
    onVisibleWindowChange({ start: startSec, end: startSec + cssW * secPerPx });
  }

  // -------------------------------------------------------------------
  // Tiles
  // -------------------------------------------------------------------
  function tilePath(L, t) {
    const manifest = manifestRef.current;
    const w = curWindowRef.current;
    return tileBaseUrl + manifest.tilePathPattern
      .replace('{window}', w.fftSize).replace('{level}', L).replace('{tile}', t);
  }

  // Anchor 0 of the engine's magma colormap ("floor: near-black") is
  // (0,0,4) — luma ~0.5. The next anchor up is already luma ~11. A small
  // threshold well below that cleanly separates "baked-in floor color"
  // from "there's actually something here", without being thrown off by
  // PNG compression noise.
  const SIGNAL_LUMA_THRESHOLD = 6;

  // Scans a loaded tile image for the topmost row containing real signal
  // (as opposed to floor-color padding) and folds it into signalTopRowRef
  // so cropping never hides a row that's known to hold content. Runs once
  // per tile, off the main draw path. Cheap: tiles are small, and columns
  // are sampled rather than scanned exhaustively.
  function analyzeTileSignalTop(img) {
    try {
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) return;
      if (!analysisCanvasRef.current) analysisCanvasRef.current = document.createElement('canvas');
      const off = analysisCanvasRef.current;
      off.width = w; off.height = h;
      const octx = off.getContext('2d', { willReadFrequently: true });
      octx.drawImage(img, 0, 0);
      const { data } = octx.getImageData(0, 0, w, h);
      const colStep = Math.max(1, Math.floor(w / 64)); // sample ~64 columns
      for (let y = 0; y < h; y++) {
        const rowBase = y * w * 4;
        for (let x = 0; x < w; x += colStep) {
          const o = rowBase + x * 4;
          const luma = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
          if (luma > SIGNAL_LUMA_THRESHOLD) {
            signalTopRowRef.current = signalTopRowRef.current == null
              ? y : Math.min(signalTopRowRef.current, y);
            scheduleDraw();
            return;
          }
        }
      }
    } catch (err) {
      // Cross-origin tiles without CORS headers taint the canvas and throw
      // on getImageData — in that case just skip the safety analysis
      // rather than breaking tile rendering. The manual crop slider still
      // works, it just loses its safety cap.
    }
  }

  function getTile(L, t) {
    const key = curWindowRef.current.fftSize + '/' + L + '/' + t;
    let img = tileCacheRef.current.get(key);
    if (img) return img;
    img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { scheduleDraw(); analyzeTileSignalTop(img); };
    img.onerror = () => {};
    img.src = tilePath(L, t);
    tileCacheRef.current.set(key, img);
    return img;
  }

  // -------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------
  const scheduleDraw = useCallback(() => {
    if (drawPendingRef.current) return;
    drawPendingRef.current = true;
    requestAnimationFrame(() => { drawPendingRef.current = false; draw(); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Public API. getVisibleWindow() is read by the annotation overlay.
  // setPlayheadTime() is driven directly from the <audio> element's
  // timeupdate (which can fire tens of times a second) — updating a ref
  // and redrawing the canvas is far cheaper than a React re-render on
  // every tick, so this bypasses props/state entirely.
  useImperativeHandle(ref, () => ({
    getVisibleWindow() {
      const { startSec, secPerPx } = viewRef.current;
      const { cssW } = sizeRef.current;
      return { start: startSec, end: startSec + cssW * secPerPx };
    },
    setPlayheadTime(t) {
      playheadRef.current = t;
      scheduleDraw();
    },
    // Pan the view so absolute time `t` is centered, keeping the current
    // zoom level. Used when navigation happens elsewhere (chunk timeline,
    // waveform nav click) and the spectrogram itself needs to catch up.
    seekTo(t) {
      if (!manifestRef.current) return;
      const { cssW } = sizeRef.current;
      const view = viewRef.current;
      const visibleSec = view.secPerPx * cssW;
      view.startSec = t - visibleSec / 2;
      clampView();
      scheduleDraw();
      notifyVisibleWindow();
    },
  }), [scheduleDraw]);

  function draw() {
    const manifest = manifestRef.current;
    const curWindow = curWindowRef.current;
    const ctx = ctxRef.current;
    if (!manifest || !curWindow || !ctx) return;

    const { cssW, cssH, dpr } = sizeRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cssW, cssH);

    const view = viewRef.current;
    const L = pickLevel();
    const lvl = curWindow.levels[L];
    const spc = lvl.secondsPerColumn;
    const tileW = manifest.tileWidth;
    const tileH = curWindow.tileHeight;
    const numCols = lvl.numColumns;
    const numTiles = lvl.numTiles;

    const horizScale = spc / view.secPerPx;
    ctx.imageSmoothingEnabled = horizScale > 1.5;

    const colToX = (col) => (col * spc - view.startSec) / view.secPerPx;
    const cStart = view.startSec / spc;
    const cEnd = (view.startSec + cssW * view.secPerPx) / spc;
    const tStart = Math.max(0, Math.floor(cStart / tileW));
    const tEnd = Math.min(numTiles - 1, Math.floor((cEnd - 1e-9) / tileW));

    for (let t = tStart; t <= tEnd; t++) {
      const colLeft = t * tileW;
      const wActual = Math.min(tileW, numCols - colLeft);
      const x0 = Math.round(colToX(colLeft));
      const x1 = Math.round(colToX(colLeft + wActual));
      const w = x1 - x0;
      if (w <= 0) continue;
      const img = getTile(L, t);
      if (img.complete && img.naturalWidth > 0) {
        // Rows are top=high-freq .. bottom=low-freq (see buildRowToBin in
        // the engine). Cropping the top `cropTop` fraction skips rows that
        // are baked-in near-black (below the noise floor for this file) and
        // stretches the remaining, actually-informative band to fill the
        // full view height instead of leaving a dead black band on screen.
        //
        // The requested crop is capped by signalTopRowRef — the highest
        // row any loaded tile has been observed to actually contain signal
        // in — so a rare loud transient that pokes up into otherwise-empty
        // high frequencies never gets cropped away just because most of
        // the file is quiet up there.
        const requestedRows = cropTopRef.current * tileH;
        const safeMaxRows = signalTopRowRef.current != null
          ? Math.max(0, signalTopRowRef.current - 2) // small margin above the loudest known row
          : 0; // nothing analyzed yet — don't crop until we know it's safe to
        const sy = Math.min(requestedRows, safeMaxRows);
        const sh = tileH - sy;
        ctx.drawImage(img, 0, sy, wActual, sh, x0, 0, w, cssH);
      }
    }

    // Playhead
    const playheadTime = playheadRef.current;
    if (playheadTime != null) {
      const x = (playheadTime - view.startSec) / view.secPerPx;
      if (x >= 0 && x <= cssW) {
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, cssH);
        ctx.stroke();
      }
    }
  }

  // -------------------------------------------------------------------
  // Pointer interaction: drag = pan, small movement on release = seek click
  // -------------------------------------------------------------------
  const handlePointerDown = useCallback((e) => {
    if (e.button !== 0) return;
    dragRef.current = { startX: e.clientX, startSec: viewRef.current.startSec, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    if (Math.abs(dx) > CLICK_DRAG_THRESHOLD) drag.moved = true;
    viewRef.current.startSec = drag.startSec - dx * viewRef.current.secPerPx;
    clampView();
    scheduleDraw();
  }, [scheduleDraw]);

  const handlePointerUp = useCallback((e) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    notifyVisibleWindow();
    if (!drag.moved && onSeek) {
      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      onSeek(timeAtX(x));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSeek]);

  const handleWheel = useCallback((e) => {
    if (!manifestRef.current) return;
    e.preventDefault();
    const rect = containerRef.current.getBoundingClientRect();
    const anchorX = e.clientX - rect.left;
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= sizeRef.current.cssH;
    const step = Math.min(Math.abs(dy) * WHEEL_SENS, WHEEL_CAP);
    const factor = dy > 0 ? 1 + step : 1 / (1 + step);
    zoomTime(factor, anchorX);
    scheduleDraw();
    notifyVisibleWindow();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleDraw]);

  return (
    <div
      ref={containerRef}
      className="tile-spec-viewer"
      style={{ height }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onWheel={handleWheel}
    >
      <canvas ref={canvasRef} />
      {status === 'loading' && (
        <div className="tile-spec-viewer-status">Generating spectrogram tiles…</div>
      )}
      {status === 'error' && (
        <div className="tile-spec-viewer-status tile-spec-viewer-status--error">
          Could not load spectrogram tiles.
        </div>
      )}
    </div>
  );
});

function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

export default TileSpectrogramViewer;
