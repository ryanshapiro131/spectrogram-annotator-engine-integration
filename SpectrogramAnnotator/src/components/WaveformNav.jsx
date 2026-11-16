import React, { useRef, useEffect, useCallback, useState } from 'react';
import './WaveformNav.css';

function formatTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Reads CSS custom properties so canvas drawing stays in sync with the theme
function readThemeColors(el) {
  const cs = getComputedStyle(el);
  const get = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return {
    loaded:   get('--accent-mid',  '#2d8daf'),
    pending:  get('--amber',       '#92600a'),
    unloaded: get('--border-strong', '#bcc2cc'),
    viewport: get('--accent',      '#e0e1dd'),
    text:     get('--text-muted',  '#d9d9d9'),
  };
}

// Paints [start, end) second ranges onto a per-pixel state array.
function paintRanges(states, ranges, value, width, fileDuration) {
  for (const [start, end] of ranges) {
    const x0 = Math.max(0, Math.floor((start / fileDuration) * width));
    const x1 = Math.min(width, Math.ceil((end / fileDuration) * width));
    for (let x = x0; x < x1; x++) states[x] = Math.max(states[x], value);
  }
}

const EDGE_GRAB_PX = 6; // px either side of a viewport-box edge that grab it for resizing

const PENDING = 1;
const LOADED  = 2;

/**
 * Full-width navigation waveform for the entire audio file.
 *
 * - Draws one RMS bar per overview data point (mirrored around center).
 * - Color mirrors the spectrogram viewer: time ranges whose tiles are loaded
 *   at the viewer's current zoom level are full color, tiles still in flight
 *   are amber, and anything the viewer hasn't fetched yet is gray.
 * - The viewport rectangle is the viewer's visible window; click/drag
 *   anywhere to seek, or drag either edge of the box to set the window's
 *   start / end (zooming the spectrogram to match).
 */
export default function WaveformNav({
  overview, overviewStatus,
  fileDuration,
  onSeek,
  onSetWindow,      // (start, end, anchor, final) => void — set the viewer's visible window
  getVisibleWindow, // () => { start, end } — the spectrogram viewer's current pan/zoom window, in absolute seconds
  getTileCoverage,  // () => { loaded: [[s,e]...], pending: [[s,e]...] } — from the spectrogram viewer
  viewTick,         // bumped whenever the spectrogram viewer pans/zooms, to re-trigger this draw
  coverageTick,     // bumped whenever the viewer's tile load state changes
}) {
  const canvasRef   = useRef(null);
  const wrapRef     = useRef(null);
  const [width, setWidth]     = useState(0);
  // false | 'seek' | 'start' | 'end' (an edge of the viewport box)
  const [dragging, setDragging] = useState(false);
  const [edgeHover, setEdgeHover] = useState(false);
  const [hoverTime, setHoverTime] = useState(null);

  const HEIGHT = 64;

  // Track container width so the canvas always fills it (incl. resizes)
  useEffect(() => {
    if (!wrapRef.current) return;
    const el = wrapRef.current;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  // -------------------------------------------------------------------------
  // Draw
  // -------------------------------------------------------------------------
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width  = width * dpr;
    canvas.height = HEIGHT * dpr;
    canvas.style.width  = `${width}px`;
    canvas.style.height = `${HEIGHT}px`;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, HEIGHT);

    const colors = readThemeColors(canvas);
    const mid    = HEIGHT / 2;

    if (overview && overview.length > 0 && fileDuration > 0) {
      const n = overview.length;
      const w = Math.ceil(width);
      const states = new Uint8Array(w);
      const coverage = typeof getTileCoverage === 'function' ? getTileCoverage() : null;
      if (coverage) {
        paintRanges(states, coverage.pending, PENDING, w, fileDuration);
        paintRanges(states, coverage.loaded,  LOADED,  w, fileDuration);
      }

      for (let x = 0; x < w; x++) {
        const idx = Math.min(n - 1, Math.floor((x / width) * n));
        const amp = overview[idx] || 0;
        const barH = Math.max(1, amp * (HEIGHT - 8));

        const state = states[x];
        ctx.fillStyle = state === LOADED ? colors.loaded
                      : state === PENDING ? colors.pending
                      : colors.unloaded;
        ctx.globalAlpha = state === LOADED ? 0.9 : state === PENDING ? 0.75 : 0.45;
        ctx.fillRect(x, mid - barH / 2, 1, barH);
      }
      ctx.globalAlpha = 1;
    } else {
      // Loading / empty state — flat placeholder line
      ctx.strokeStyle = colors.unloaded;
      ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(width, mid);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Viewport rectangle — tracks the spectrogram viewer's actual pan/zoom
    // window (start/end at the current zoom level), not the audio chunk
    // boundaries, so it shrinks/grows and slides as the user zooms/pans the
    // spectrogram above.
    if (fileDuration > 0 && typeof getVisibleWindow === 'function') {
      const win = getVisibleWindow();
      const x1 = (win.start / fileDuration) * width;
      const x2 = (win.end / fileDuration) * width;

      ctx.fillStyle = colors.viewport;
      ctx.globalAlpha = 0.16;
      ctx.fillRect(x1, 0, Math.max(2, x2 - x1), HEIGHT);
      ctx.globalAlpha = 1;

      ctx.strokeStyle = colors.viewport;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x1 + 0.75, 0.75, Math.max(1, x2 - x1 - 1.5), HEIGHT - 1.5);

      // Grips on both edges, to show they can be dragged
      if (onSetWindow) {
        ctx.fillStyle = colors.viewport;
        const gh = 18, gy = mid - gh / 2;
        ctx.fillRect(x1 - 1, gy, 3, gh);
        ctx.fillRect(x2 - 2, gy, 3, gh);
      }
    }

    // Hover cursor line
    if (hoverTime != null && fileDuration > 0) {
      const hx = (hoverTime / fileDuration) * width;
      ctx.strokeStyle = colors.text;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(hx, 0);
      ctx.lineTo(hx, HEIGHT);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview, width, fileDuration, hoverTime, getVisibleWindow, getTileCoverage, onSetWindow, viewTick, coverageTick]);

  useEffect(() => { draw(); }, [draw]);

  // -------------------------------------------------------------------------
  // Pointer interaction — click or drag anywhere to seek
  // -------------------------------------------------------------------------
  const timeFromClientX = useCallback((clientX) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return frac * fileDuration;
  }, [fileDuration]);

  // Which viewport-box edge (if any) is under clientX: 'start' | 'end' | null.
  const edgeAt = useCallback((clientX) => {
    if (!onSetWindow || !fileDuration || typeof getVisibleWindow !== 'function') return null;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    const win = getVisibleWindow();
    const x1 = (win.start / fileDuration) * rect.width;
    const x2 = (win.end / fileDuration) * rect.width;
    const d1 = Math.abs(x - x1), d2 = Math.abs(x - x2);
    if (Math.min(d1, d2) > EDGE_GRAB_PX) return null;
    if (d1 === d2) return x < x1 ? 'start' : 'end'; // box narrower than the grab zone
    return d1 < d2 ? 'start' : 'end';
  }, [onSetWindow, fileDuration, getVisibleWindow]);

  const handlePointerDown = useCallback((e) => {
    if (!fileDuration || e.button !== 0) return;
    e.preventDefault();
    const edge = edgeAt(e.clientX);
    if (edge) { setDragging(edge); return; }
    setDragging('seek');
    onSeek(timeFromClientX(e.clientX));
  }, [fileDuration, onSeek, timeFromClientX, edgeAt]);

  useEffect(() => {
    if (!dragging) return;
    // Resizing: move the dragged edge, keep the other one fixed. A minimum
    // span keeps the edges from crossing (the viewer clamps zoom further).
    const resize = (e, final) => {
      const win = getVisibleWindow();
      const t = timeFromClientX(e.clientX);
      const minSpan = fileDuration / Math.max(1, width) * 4;
      if (dragging === 'start') onSetWindow(Math.min(t, win.end - minSpan), win.end, 'end', final);
      else onSetWindow(win.start, Math.max(t, win.start + minSpan), 'start', final);
    };
    const handleMove = (e) => {
      if (dragging === 'seek') onSeek(timeFromClientX(e.clientX));
      else resize(e, false);
    };
    const handleUp = (e) => {
      if (dragging !== 'seek') resize(e, true);
      setDragging(false);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [dragging, onSeek, onSetWindow, getVisibleWindow, timeFromClientX, fileDuration, width]);

  const handleMouseMove = useCallback((e) => {
    if (!fileDuration) return;
    setHoverTime(timeFromClientX(e.clientX));
    setEdgeHover(!!edgeAt(e.clientX));
  }, [fileDuration, timeFromClientX, edgeAt]);

  const win = typeof getVisibleWindow === 'function' ? getVisibleWindow() : { start: 0, end: fileDuration };

  return (
    <div className="waveform-nav">
      <div className="waveform-nav-label">
        <span>Navigate</span>
        <span className="waveform-nav-info">
          {overviewStatus === 'loading' && <span className="waveform-nav-loading">Loading waveform…</span>}
          <span className="waveform-nav-time">
            {formatTime(win.start)} – {formatTime(Math.min(fileDuration, win.end))}
          </span>
          {hoverTime != null && (
            <span className="waveform-nav-hover">{formatTime(hoverTime)}</span>
          )}
        </span>
      </div>
      <div className="waveform-nav-canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className={`waveform-nav-canvas ${edgeHover || dragging === 'start' || dragging === 'end' ? 'waveform-nav-canvas--edge' : ''}`}
          onPointerDown={handlePointerDown}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => { setHoverTime(null); setEdgeHover(false); }}
        />
      </div>
    </div>
  );
}
