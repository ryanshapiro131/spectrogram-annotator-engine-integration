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
 *   anywhere to seek.
 */
export default function WaveformNav({
  overview, overviewStatus,
  fileDuration,
  onSeek,
  getVisibleWindow, // () => { start, end } — the spectrogram viewer's current pan/zoom window, in absolute seconds
  getTileCoverage,  // () => { loaded: [[s,e]...], pending: [[s,e]...] } — from the spectrogram viewer
  viewTick,         // bumped whenever the spectrogram viewer pans/zooms, to re-trigger this draw
  coverageTick,     // bumped whenever the viewer's tile load state changes
}) {
  const canvasRef   = useRef(null);
  const wrapRef     = useRef(null);
  const [width, setWidth]     = useState(0);
  const [dragging, setDragging] = useState(false);
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
  }, [overview, width, fileDuration, hoverTime, getVisibleWindow, getTileCoverage, viewTick, coverageTick]);

  useEffect(() => { draw(); }, [draw]);

  // -------------------------------------------------------------------------
  // Pointer interaction — click or drag anywhere to seek
  // -------------------------------------------------------------------------
  const timeFromClientX = useCallback((clientX) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return frac * fileDuration;
  }, [fileDuration]);

  const handlePointerDown = useCallback((e) => {
    if (!fileDuration) return;
    setDragging(true);
    onSeek(timeFromClientX(e.clientX));
  }, [fileDuration, onSeek, timeFromClientX]);

  useEffect(() => {
    if (!dragging) return;
    const handleMove = (e) => onSeek(timeFromClientX(e.clientX));
    const handleUp    = () => setDragging(false);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [dragging, onSeek, timeFromClientX]);

  const handleMouseMove = useCallback((e) => {
    if (!fileDuration) return;
    setHoverTime(timeFromClientX(e.clientX));
  }, [fileDuration, timeFromClientX]);

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
          className="waveform-nav-canvas"
          onPointerDown={handlePointerDown}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverTime(null)}
        />
      </div>
    </div>
  );
}
