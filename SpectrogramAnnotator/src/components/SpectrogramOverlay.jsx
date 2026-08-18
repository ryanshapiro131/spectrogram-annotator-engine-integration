import React, { useRef, useState, useEffect, useCallback } from 'react';
import './SpectrogramOverlay.css';

function secToDisplay(sec) {
  if (isNaN(sec)) return '0.000';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = (sec % 60).toFixed(3);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${s.padStart(6,'0')}`;
  if (m > 0) return `${m}:${s.padStart(6,'0')}`;
  return s;
}

// Pixel → absolute time, accounting for the current zoom window
function xToTime(x, width, win) {
  const span = win.end - win.start;
  if (!width || !span) return win.start;
  return Math.max(win.start, Math.min(win.end, win.start + (x / width) * span));
}

// Absolute time → pixel, accounting for the current zoom window
function timeToX(t, width, win) {
  const span = win.end - win.start;
  if (!span) return 0;
  return ((t - win.start) / span) * width;
}

/*
 * SpectrogramOverlay
 *
 * Previously this read its zoom/pan window by sniffing react-audio-
 * spectrogram-player's <svg viewBox> off the DOM (that library didn't expose
 * zoom state via props). Now that the spectrogram is TileSpectrogramViewer —
 * one continuous canvas spanning the whole file, not one instance per
 * 3-minute chunk — it takes the visible window via a plain getVisibleWindow()
 * callback (TileSpectrogramViewer exposes this through a ref), and works in
 * ABSOLUTE file seconds throughout rather than chunk-relative + an offset.
 *
 * Because the viewer now spans the whole file, this overlay also no longer
 * needs to be told which chunk it's "in" — it just filters annotations to
 * whatever's currently visible.
 */
export default function SpectrogramOverlay({
  duration,             // total file duration in seconds (fallback window)
  specHeight,           // height of the spectrogram canvas area
  activeLayer,          // { id, title, color, annotations[] }
  onAddAnnotation,      // (annotation) => void — stores absolute timestamps
  enabled,              // whether annotation mode is active (vs. plain navigation)
  getVisibleWindow,     // () => { start, end } in absolute seconds
}) {
  const overlayRef = useRef(null);
  const inputRef = useRef(null);

  // Annotation drawing state — times are absolute seconds; screen positions
  // are derived from these + the live zoom window at render time, rather
  // than cached as pixels, so they stay correct if the view changes mid-draw.
  const [mode, setMode] = useState('idle'); // idle | start_set | label
  const [startTime, setStartTime] = useState(null);
  const [endTime, setEndTime] = useState(null);
  const [hoverTime, setHoverTime] = useState(null);
  const [labelValue, setLabelValue] = useState('');
  const [popupX, setPopupX] = useState(0);

  const windowOf = useCallback(() => {
    return typeof getVisibleWindow === 'function'
      ? getVisibleWindow()
      : { start: 0, end: duration || 0 };
  }, [getVisibleWindow, duration]);

  // Focus input when popup appears
  useEffect(() => {
    if (mode === 'label' && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [mode]);

  const getRelativeX = (e) => {
    const rect = overlayRef.current.getBoundingClientRect();
    return e.clientX - rect.left;
  };

  const getWidth = () => overlayRef.current?.getBoundingClientRect().width || 1;

  const handleDoubleClick = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const x = getRelativeX(e);
    const w = getWidth();
    const win = windowOf();
    const t = xToTime(x, w, win);

    if (mode === 'idle') {
      setStartTime(t);
      setEndTime(null);
      setMode('start_set');
    } else if (mode === 'start_set') {
      // Ensure start < end regardless of click order
      const [finalStart, finalEnd] = t > startTime ? [startTime, t] : [t, startTime];

      setStartTime(finalStart);
      setEndTime(finalEnd);
      setPopupX(Math.min((timeToX(finalStart, w, win) + timeToX(finalEnd, w, win)) / 2, w - 280));
      setLabelValue('');
      setMode('label');
    }
  }, [mode, startTime, windowOf]);

  const handleMouseMove = useCallback((e) => {
    if (mode === 'idle' || mode === 'label') return;
    const x = getRelativeX(e);
    const w = getWidth();
    const win = windowOf();
    setHoverTime(xToTime(x, w, win));
  }, [mode, windowOf]);

  const handleMouseLeave = useCallback(() => {
    setHoverTime(null);
  }, []);

  const cancel = useCallback(() => {
    setMode('idle');
    setStartTime(null); setEndTime(null);
    setLabelValue('');
    setHoverTime(null);
  }, []);

  // If annotation mode gets toggled off mid-draw, don't leave a dangling
  // in-progress annotation around.
  useEffect(() => {
    if (!enabled) cancel();
  }, [enabled, cancel]);

  const confirm = useCallback(() => {
    if (!labelValue.trim()) return;
    onAddAnnotation({
      start: startTime,
      end: endTime,
      label: labelValue.trim(),
    });
    cancel();
  }, [labelValue, startTime, endTime, onAddAnnotation, cancel]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter') confirm();
    if (e.key === 'Escape') cancel();
    e.stopPropagation();
  }, [confirm, cancel]);

  const width = overlayRef.current?.getBoundingClientRect().width || 0;
  const win = windowOf();
  const startX = startTime !== null ? timeToX(startTime, width, win) : null;
  const endX = endTime !== null ? timeToX(endTime, width, win) : null;
  const hoverX = hoverTime !== null ? timeToX(hoverTime, width, win) : null;

  // Existing annotations currently visible on screen, for this layer
  const visibleInWindow = (activeLayer?.annotations || [])
    .filter(a => a.end > win.start && a.start < win.end)
    .sort((a, b) => a.start - b.start);

  return (
    <div
      ref={overlayRef}
      className={`spec-overlay ${enabled ? 'spec-overlay--enabled' : ''} ${mode !== 'idle' ? 'spec-overlay--active' : ''}`}
      style={{ height: specHeight }}
      onDoubleClick={enabled ? handleDoubleClick : undefined}
      onMouseMove={enabled ? handleMouseMove : undefined}
      onMouseLeave={enabled ? handleMouseLeave : undefined}
    >
      {/* Instruction hint */}
      {enabled && mode === 'idle' && (
        <div className="spec-overlay-hint">Double-click to set start point</div>
      )}
      {enabled && mode === 'start_set' && (
        <div className="spec-overlay-hint spec-overlay-hint--active">
          Start set — double-click to set end point
        </div>
      )}

      {/* Start marker */}
      {startX !== null && (
        <div className="spec-marker spec-marker--start" style={{ left: startX }}>
          <div className="spec-marker-line" />
          <div className="spec-marker-label">{secToDisplay(startTime)}</div>
        </div>
      )}

      {/* End marker */}
      {endX !== null && (
        <div className="spec-marker spec-marker--end" style={{ left: endX }}>
          <div className="spec-marker-line" />
          <div className="spec-marker-label spec-marker-label--end">
            {secToDisplay(endTime)}
          </div>
        </div>
      )}

      {/* Selected region shading */}
      {startX !== null && endX !== null && (
        <div
          className="spec-region"
          style={{
            left: Math.min(startX, endX),
            width: Math.abs(endX - startX),
            borderColor: activeLayer?.color || '#1a6b8a',
            background: `${activeLayer?.color || '#1a6b8a'}22`,
          }}
        />
      )}

      {/* Live hover marker while setting end point */}
      {mode === 'start_set' && hoverX !== null && (
        <div className="spec-marker spec-marker--hover" style={{ left: hoverX }}>
          <div className="spec-marker-line" />
          <div className="spec-marker-label spec-marker-label--hover">
            {secToDisplay(hoverTime)}
          </div>
        </div>
      )}

      {/* Label popup */}
      {mode === 'label' && (
        <div
          className="spec-popup"
          style={{ left: Math.max(8, Math.min(popupX, width - 296)) }}
          onDoubleClick={e => e.stopPropagation()}
        >
          <div className="spec-popup-header">
            <span className="spec-popup-layer" style={{ borderColor: activeLayer?.color }}>
              {activeLayer?.title || 'Layer'}
            </span>
            <span className="spec-popup-times">
              {secToDisplay(startTime)} → {secToDisplay(endTime)}
              <span className="spec-popup-duration">
                ({(endTime - startTime).toFixed(3)}s)
              </span>
            </span>
            <button className="spec-popup-close" onClick={cancel}>✕</button>
          </div>

          <div className="spec-popup-input-row">
            <input
              ref={inputRef}
              className="spec-popup-input"
              placeholder="Enter label..."
              value={labelValue}
              onChange={e => setLabelValue(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <button
              className="spec-popup-confirm"
              onClick={confirm}
              disabled={!labelValue.trim()}
            >
              Add
            </button>
          </div>

          {visibleInWindow.length > 0 && (
            <div className="spec-popup-existing">
              <div className="spec-popup-existing-label">Visible now:</div>
              <div className="spec-popup-existing-list">
                {visibleInWindow.map(a => (
                  <div key={a.id} className="spec-popup-existing-item">
                    <span className="spec-popup-existing-time">
                      {secToDisplay(a.start)} → {secToDisplay(a.end)}
                    </span>
                    <span className="spec-popup-existing-name">{a.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
