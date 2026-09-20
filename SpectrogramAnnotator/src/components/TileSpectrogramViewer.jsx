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
 *   - No client-side colormap/dB-range control: tiles are baked at
 *     generation time by the engine. If you need to change colormap or
 *     top_db, that's now an engine-generation-time setting, not a runtime
 *     one (see server.py's ENGINE_BIN invocation).
 *
 * Frequency axis: the manifest's per-window minFrequencyHz/maxFrequencyHz are
 * the *theoretical* 0..Nyquist range every tile row spans (see buildRowToBin
 * in the engine — row y always maps linearly to that theoretical axis,
 * whether the render used a linear or log frequency scale). contentMin/
 * MaxFrequencyHz is what's new: the engine now scans every analyzed column
 * for where this file's actual signal lives and writes that separately, so
 * this viewer can open zoomed to the real content instead of showing dead
 * black rows above/below it — no more guessing from loaded tile pixels.
 * vTop/vBot (below) are normalized [0,1] positions along the *theoretical*
 * axis, exactly like the engine's own viewer/app.js, so the user can always
 * zoom/pan back out to the full range even after opening cropped to content.
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
const INITIAL_VIEW_SECONDS = 180; // ~3 minutes visible on initial load, instead of fitting the whole file
const MIN_VSPAN = 1 / 64; // deepest frequency zoom (fraction of the full theoretical axis)
const CONTENT_FIT_PAD = 0.06; // extra headroom (fraction of content span) above/below content on initial fit

// Width of the frequency-zoom sidebar to the right of the canvas. The
// annotation overlay (a sibling in App.jsx) is told to stop this many px
// short of the right edge via a CSS var so its coordinates keep lining up
// with the canvas — see TileSpectrogramViewer.css / SpectrogramOverlay.css.
const FREQ_SIDEBAR_WIDTH = 46;

function fmtFreq(hz) {
  if (!isFinite(hz)) return '—';
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)}k` : `${Math.round(hz)}`;
}

function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

const TileSpectrogramViewer = forwardRef(function TileSpectrogramViewer(
  {
    manifestUrl,       // e.g. `${SERVER}/tiles/${fileId}/manifest.json`
    tileBaseUrl,        // e.g. `${SERVER}/tiles/${fileId}/`  (manifest's tilePathPattern is relative to this)
    height = 220,
    playheadTime = null,   // absolute seconds, draws a line if provided
    onSeek = null,          // (absoluteSeconds) => void — called on plain click (not drag)
    onVisibleWindowChange = null, // ({start,end}) => void, called after pan/zoom settles
  },
  ref
) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const ctxRef = useRef(null);

  const [status, setStatus] = useState('loading'); // loading | ready | error
  // Bumped on every vertical pan/zoom so the sidebar (a plain React render,
  // not a canvas) re-renders its handle positions/labels.
  const [vTick, setVTick] = useState(0);
  const manifestRef = useRef(null);
  const curWindowRef = useRef(null);
  const tileCacheRef = useRef(new Map());
  // startSec/secPerPx: horizontal (time). vTop/vBot: vertical (frequency),
  // normalized [0,1] fractions of the theoretical 0..Nyquist axis, 1 = top.
  const viewRef = useRef({ startSec: 0, secPerPx: 1, vTop: 1, vBot: 0 });
  const sizeRef = useRef({ cssW: 0, cssH: height, dpr: 1 });
  const drawPendingRef = useRef(false);
  const notifyPendingRef = useRef(false);
  const dragRef = useRef(null); // { startX, startY, startSec, startVTop, startVBot, moved }
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
        setInitialZoom();
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
  // Frequency axis helpers (ported from the engine's viewer/app.js)
  // -------------------------------------------------------------------
  function isLog() { return manifestRef.current && manifestRef.current.frequencyScale === 'log'; }
  // Theoretical axis bounds (full pannable/zoomable range) for the current window.
  function fMinHz() {
    const w = curWindowRef.current;
    return isLog() ? Math.max(w.minFrequencyHz, 1e-6) : w.minFrequencyHz;
  }
  function fMaxHz() { return curWindowRef.current.maxFrequencyHz; }
  function vToFreq(v) {
    const lo = fMinHz(), hi = fMaxHz();
    return isLog() ? lo * Math.pow(hi / lo, v) : lo + v * (hi - lo);
  }
  function freqToV(f) {
    const lo = fMinHz(), hi = fMaxHz();
    return isLog() ? Math.log(Math.max(f, lo) / lo) / Math.log(hi / lo) : (f - lo) / (hi - lo);
  }
  // Row y (0=top/high-freq .. tileH-1=bottom/low-freq) always maps linearly
  // to v — see buildRowToBin in the engine, which pre-warps rows for log
  // scale so this holds true regardless of frequencyScale.
  function vToRow(v, tileH) { return (1 - v) * (tileH - 1); }

  // -------------------------------------------------------------------
  // View helpers (time axis, ported from the engine's viewer/app.js)
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
    clampHorizontal();
    clampVertical();
  }

  function clampHorizontal() {
    const { minSPP, maxSPP } = zoomRange();
    const view = viewRef.current;
    view.secPerPx = clamp(view.secPerPx, minSPP, maxSPP);
    const { cssW } = sizeRef.current;
    const visibleSec = view.secPerPx * cssW;
    const dur = manifestRef.current.durationSeconds;
    view.startSec = clamp(view.startSec, 0, Math.max(0, dur - visibleSec));
  }

  function clampVertical() {
    const view = viewRef.current;
    const span = clamp(view.vTop - view.vBot, MIN_VSPAN, 1);
    let top = clamp(view.vTop, span, 1);
    let bot = top - span;
    if (bot < 0) { bot = 0; top = span; }
    view.vTop = top;
    view.vBot = bot;
  }

  // Files in this project run ~1h long, so fitting the whole timeline on
  // load would make every column span many minutes of audio — useless for
  // annotation. Instead, start zoomed in on a fixed initial window and let
  // the user zoom out from there if they want the wider view.
  //
  // Vertically, open fit to the file's real signal content (from the
  // engine's contentMin/MaxFrequencyHz) instead of the full theoretical
  // 0..Nyquist range, so there's no dead black band top or bottom — the
  // "black bar" fix. A small pad is added since content detection uses a
  // hard threshold and shouldn't visually clip right at the edge.
  function setInitialZoom() {
    const { cssW } = sizeRef.current;
    const manifest = manifestRef.current;
    const w = curWindowRef.current;
    const targetVisibleSec = Math.min(INITIAL_VIEW_SECONDS, manifest.durationSeconds);

    const contentLo = w.contentMinFrequencyHz;
    const contentHi = w.contentMaxFrequencyHz;
    const contentSpanHz = Math.max(1e-6, contentHi - contentLo);
    const padHz = contentSpanHz * CONTENT_FIT_PAD;
    const vBot = freqToV(Math.max(fMinHz(), contentLo - padHz));
    const vTop = freqToV(Math.min(fMaxHz(), contentHi + padHz));

    viewRef.current = {
      startSec: 0,
      secPerPx: targetVisibleSec / Math.max(1, cssW || 1),
      vTop: clamp(Math.max(vTop, vBot + MIN_VSPAN), 0, 1),
      vBot: clamp(vBot, 0, 1),
    };
    clampView();
    setVTick(t => t + 1);
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
    clampHorizontal();
    view.startSec = tUnder - anchorX * view.secPerPx;
    clampHorizontal();
  }

  // Zoom the frequency axis by `factor` (>1 = zoom out), keeping the value
  // under `anchorFrac` (0=bottom..1=top of the canvas) fixed on screen.
  function zoomFreq(factor, anchorFrac) {
    const view = viewRef.current;
    const vUnder = view.vBot + anchorFrac * (view.vTop - view.vBot);
    const span = clamp((view.vTop - view.vBot) * factor, MIN_VSPAN, 1);
    view.vBot = vUnder - anchorFrac * span;
    view.vTop = view.vBot + span;
    clampVertical();
    setVTick(t => t + 1);
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

  function getTile(L, t) {
    const key = curWindowRef.current.fftSize + '/' + L + '/' + t;
    let img = tileCacheRef.current.get(key);
    if (img) return img;
    img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => scheduleDraw();
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

  // rAF-throttled version of notifyVisibleWindow(), for call sites (pointer
  // drag) that fire many times per frame — without this, telling the
  // annotation overlay to re-render on every raw pointermove event would
  // mean a full React re-render tens of times a second while panning.
  const scheduleNotify = useCallback(() => {
    if (notifyPendingRef.current) return;
    notifyPendingRef.current = true;
    requestAnimationFrame(() => { notifyPendingRef.current = false; notifyVisibleWindow(); });
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
      clampHorizontal();
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

    ctx.imageSmoothingEnabled = true;

    const colToX = (col) => (col * spc - view.startSec) / view.secPerPx;
    const cStart = view.startSec / spc;
    const cEnd = (view.startSec + cssW * view.secPerPx) / spc;
    const tStart = Math.max(0, Math.floor(cStart / tileW));
    const tEnd = Math.min(numTiles - 1, Math.floor((cEnd - 1e-9) / tileW));

    // Vertical (frequency) window -> source rows within each tile. Row 0 is
    // the top (highest freq); vTop (closer to 1) is therefore the smaller
    // row index. See vToRow's comment for why this mapping is scale-agnostic.
    const rowAtTop = vToRow(view.vTop, tileH);
    const rowAtBot = vToRow(view.vBot, tileH);
    const sy = Math.max(0, rowAtTop);
    const sh = Math.max(1e-6, rowAtBot - rowAtTop);

    for (let t = tStart; t <= tEnd; t++) {
      const colLeft = t * tileW;
      const wActual = Math.min(tileW, numCols - colLeft);
      const x0 = Math.round(colToX(colLeft));
      const x1 = Math.round(colToX(colLeft + wActual));
      const w = x1 - x0;
      if (w <= 0) continue;
      const img = getTile(L, t);
      if (img.complete && img.naturalWidth > 0) {
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
  // Pointer interaction: drag = pan (time + freq), small movement on
  // release = seek click. Shift+wheel = frequency zoom (mirrors the
  // sidebar's scroll-to-zoom, for convenience without leaving the canvas).
  // -------------------------------------------------------------------
  const handlePointerDown = useCallback((e) => {
    if (e.button !== 0) return;
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      startSec: viewRef.current.startSec,
      startVTop: viewRef.current.vTop, startVBot: viewRef.current.vBot,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) > CLICK_DRAG_THRESHOLD || Math.abs(dy) > CLICK_DRAG_THRESHOLD) drag.moved = true;
    const view = viewRef.current;
    view.startSec = drag.startSec - dx * view.secPerPx;
    const { cssH } = sizeRef.current;
    const span = drag.startVTop - drag.startVBot;
    const dv = (dy / Math.max(1, cssH)) * span;
    view.vTop = drag.startVTop + dv;
    view.vBot = drag.startVBot + dv;
    clampView();
    scheduleDraw();
    scheduleNotify();
    setVTick(t => t + 1);
  }, [scheduleDraw, scheduleNotify]);

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
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= sizeRef.current.cssH;
    const step = Math.min(Math.abs(dy) * WHEEL_SENS, WHEEL_CAP);
    const factor = dy > 0 ? 1 + step : 1 / (1 + step);

    if (e.shiftKey) {
      const anchorFrac = 1 - clamp((e.clientY - rect.top) / sizeRef.current.cssH, 0, 1);
      zoomFreq(factor, anchorFrac);
    } else {
      const anchorX = e.clientX - rect.left;
      zoomTime(factor, anchorX);
    }
    scheduleDraw();
    notifyVisibleWindow();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleDraw]);

  // -------------------------------------------------------------------
  // Frequency-zoom sidebar: two draggable handles (top/bottom of the
  // visible band) plus scroll-to-zoom, per the right-side track.
  // -------------------------------------------------------------------
  const sidebarRef = useRef(null);
  const sidebarDragRef = useRef(null); // { which: 'top'|'bot'|'pan', ... }

  function sidebarPointerMove(e) {
    const drag = sidebarDragRef.current;
    if (!drag || !sidebarRef.current) return;
    const rect = sidebarRef.current.getBoundingClientRect();
    const dyFrac = -(e.clientY - drag.startY) / Math.max(1, rect.height); // up = increase v
    const view = viewRef.current;
    if (drag.which === 'pan') {
      const span = drag.startVTop - drag.startVBot;
      view.vTop = drag.startVTop + dyFrac * span;
      view.vBot = drag.startVBot + dyFrac * span;
    } else if (drag.which === 'top') {
      view.vTop = clamp(drag.startVTop + dyFrac, view.vBot + MIN_VSPAN, 1);
    } else if (drag.which === 'bot') {
      view.vBot = clamp(drag.startVBot + dyFrac, 0, view.vTop - MIN_VSPAN);
    }
    clampVertical();
    scheduleDraw();
    scheduleNotify();
    setVTick(t => t + 1);
  }

  function sidebarPointerUp() {
    sidebarDragRef.current = null;
    window.removeEventListener('pointermove', sidebarPointerMove);
    window.removeEventListener('pointerup', sidebarPointerUp);
    notifyVisibleWindow();
  }

  const sidebarHandlePointerDown = useCallback((which) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    sidebarDragRef.current = { which, startY: e.clientY, startVTop: viewRef.current.vTop, startVBot: viewRef.current.vBot };
    window.addEventListener('pointermove', sidebarPointerMove);
    window.addEventListener('pointerup', sidebarPointerUp);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sidebarTrackPointerDown = useCallback((e) => {
    // Click/drag on the track background (not a handle) pans the band.
    e.preventDefault();
    sidebarDragRef.current = { which: 'pan', startY: e.clientY, startVTop: viewRef.current.vTop, startVBot: viewRef.current.vBot };
    window.addEventListener('pointermove', sidebarPointerMove);
    window.addEventListener('pointerup', sidebarPointerUp);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSidebarWheel = useCallback((e) => {
    if (!manifestRef.current) return;
    e.preventDefault();
    const rect = sidebarRef.current.getBoundingClientRect();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= rect.height;
    const step = Math.min(Math.abs(dy) * WHEEL_SENS, WHEEL_CAP);
    const factor = dy > 0 ? 1 + step : 1 / (1 + step);
    const anchorFrac = 1 - clamp((e.clientY - rect.top) / rect.height, 0, 1);
    zoomFreq(factor, anchorFrac);
    scheduleDraw();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const haveManifest = status === 'ready' && !!manifestRef.current;
  const view = viewRef.current;
  // Handle positions as % from the top of the track (top = 1 - vTop, since vTop=1 is the top).
  const topPct = haveManifest ? (1 - view.vTop) * 100 : 0;
  const botPct = haveManifest ? (1 - view.vBot) * 100 : 100;
  void vTick; // referenced only to force a re-render when vTick changes

  return (
    <div className="tile-spec-viewer-row" style={{ height }}>
      <div
        ref={containerRef}
        className="tile-spec-viewer"
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

      <div
        ref={sidebarRef}
        className="freq-zoom-sidebar"
        style={{ width: FREQ_SIDEBAR_WIDTH }}
        onWheel={handleSidebarWheel}
        onPointerDown={sidebarTrackPointerDown}
        title="Drag to pan, scroll to zoom the frequency range"
      >
        {haveManifest && (
          <>
            <div className="freq-zoom-band" style={{ top: `${topPct}%`, bottom: `${100 - botPct}%` }} />
            <div className="freq-zoom-label freq-zoom-label--top" style={{ top: `${topPct}%` }}>
              {fmtFreq(vToFreq(view.vTop))}
            </div>
            <div className="freq-zoom-label freq-zoom-label--bot" style={{ top: `${botPct}%` }}>
              {fmtFreq(vToFreq(view.vBot))}
            </div>
            <div
              className="freq-zoom-handle freq-zoom-handle--top"
              style={{ top: `${topPct}%` }}
              onPointerDown={sidebarHandlePointerDown('top')}
            />
            <div
              className="freq-zoom-handle freq-zoom-handle--bot"
              style={{ top: `${botPct}%` }}
              onPointerDown={sidebarHandlePointerDown('bot')}
            />
          </>
        )}
      </div>
    </div>
  );
});

export { FREQ_SIDEBAR_WIDTH };
export default TileSpectrogramViewer;
