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

/**
 * Full-width navigation waveform for the entire audio file.
 *
 * - Draws one RMS bar per overview data point (mirrored around center).
 * - Color reflects whether the chunk covering that time range has a ready
 *   spectrogram (full color), is currently computing (amber), or hasn't
 *   been requested yet (gray) — so the whole file's load state is visible
 *   at a glance.
 * - Click/drag anywhere to seek: dragging moves a viewport rectangle that
 *   represents the current chunk's time range.
 */
export default function WaveformNav({
  overview, overviewStatus,
  totalChunks, currentChunk, sxxStatus,
  fileDuration, chunkDuration,
  onSeek,
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
      for (let x = 0; x < width; x++) {
        const t   = (x / width) * fileDuration;
        const idx = Math.min(n - 1, Math.floor((x / width) * n));
        const amp = overview[idx] || 0;
        const barH = Math.max(1, amp * (HEIGHT - 8));

        const chunkIdx = chunkDuration > 0 ? Math.floor(t / chunkDuration) : 0;
        const status    = sxxStatus?.[chunkIdx];
        const color = status === 'ready'   ? colors.loaded
                    : status === 'pending' ? colors.pending
                    : colors.unloaded;

        ctx.fillStyle = color;
        ctx.globalAlpha = status === 'ready' ? 0.9 : status === 'pending' ? 0.75 : 0.45;
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

    // Viewport rectangle for the current chunk
    if (fileDuration > 0 && chunkDuration > 0) {
      const cs = currentChunk * chunkDuration;
      const ce = Math.min(fileDuration, cs + chunkDuration);
      const x1 = (cs / fileDuration) * width;
      const x2 = (ce / fileDuration) * width;

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
  }, [overview, width, fileDuration, chunkDuration, currentChunk, sxxStatus, hoverTime]);

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

  const cs = currentChunk * chunkDuration;
  const ce = Math.min(fileDuration, cs + chunkDuration);

  return (
    <div className="waveform-nav">
      <div className="waveform-nav-label">
        <span>Navigate</span>
        <span className="waveform-nav-info">
          {overviewStatus === 'loading' && <span className="waveform-nav-loading">Loading waveform…</span>}
          {currentChunk + 1} / {totalChunks}
          <span className="waveform-nav-time">
            {formatTime(cs)} – {formatTime(ce)}
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
