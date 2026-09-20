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
 * Reads its zoom/pan window via a plain getVisibleWindow() callback
 * (TileSpectrogramViewer exposes this through a ref) and works in ABSOLUTE
 * file seconds throughout.
 *
 * Two responsibilities:
 *   1. Persistently render every visible label's annotations as colored,
 *      translucent boxes wherever they fall in the current time window —
 *      each label's `visible` flag (toggled in AnnotationPanel) controls
 *      whether its boxes are drawn at all. Boxes span the full height (no
 *      per-annotation frequency range — see TileSpectrogramViewer comment).
 *   2. Drive the double-click-to-draw-a-region flow. Once start+end are
 *      set, instead of a free-text field this shows a label PICKER: existing
 *      labels (colored swatches, filterable by typing) to reuse, or type a
 *      new name to create one — so a repeated label always keeps its color.
 */
export default function SpectrogramOverlay({
  duration,             // total file duration in seconds (fallback window)
  specHeight,           // height of the spectrogram canvas area
  labels,               // [{ id, title, color, visible, annotations[] }] — ALL labels
  activeLabelId,        // id to preselect in the picker
  onAddAnnotation,      // (labelId, {start,end}) => void — stores absolute timestamps
  onResolveOrCreateLabel, // (name) => labelId — reuses an existing label or creates one
  enabled,              // whether annotation mode is active (vs. plain navigation)
  getVisibleWindow,     // () => { start, end } in absolute seconds
  viewTick,             // bumped by the parent on every pan/zoom — forces this
                         // component to re-render and re-read getVisibleWindow(),
                         // since that window otherwise lives outside React state.
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
  const [labelQuery, setLabelQuery] = useState('');
  const [popupX, setPopupX] = useState(0);
  // Force a re-render on a resize-only re-measure (box positions depend on
  // overlayRef's live width, read at render time below).
  const [, forceTick] = useState(0);

  const windowOf = useCallback(() => {
    return typeof getVisibleWindow === 'function'
      ? getVisibleWindow()
      : { start: 0, end: duration || 0 };
  }, [getVisibleWindow, duration]);

  // Re-measure/redraw boxes on container resize (annotation boxes are plain
  // absolutely-positioned divs, not canvas, so they don't repaint on their
  // own when the container changes width).
  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => forceTick(t => t + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
      const activeLabel = labels.find(l => l.id === activeLabelId);
      setLabelQuery(activeLabel ? activeLabel.title : '');
      setMode('label');
    }
  }, [mode, startTime, windowOf, labels, activeLabelId]);

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
    setLabelQuery('');
    setHoverTime(null);
  }, []);

  // If annotation mode gets toggled off mid-draw, don't leave a dangling
  // in-progress annotation around.
  useEffect(() => {
    if (!enabled) cancel();
  }, [enabled, cancel]);

  const confirm = useCallback((name) => {
    const trimmed = (name != null ? name : labelQuery).trim();
    if (!trimmed) return;
    const labelId = onResolveOrCreateLabel(trimmed);
    onAddAnnotation(labelId, { start: startTime, end: endTime });
    cancel();
  }, [labelQuery, startTime, endTime, onAddAnnotation, onResolveOrCreateLabel, cancel]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter') confirm();
    if (e.key === 'Escape') cancel();
    e.stopPropagation();
  }, [confirm, cancel]);

  void viewTick; // referenced only to force a re-render when the visible window changes

  const width = overlayRef.current?.getBoundingClientRect().width || 0;
  const win = windowOf();
  const startX = startTime !== null ? timeToX(startTime, width, win) : null;
  const endX = endTime !== null ? timeToX(endTime, width, win) : null;
  const hoverX = hoverTime !== null ? timeToX(hoverTime, width, win) : null;

  const activeLabel = labels.find(l => l.id === activeLabelId);
  const drawColor = activeLabel?.color || '#1a6b8a';

  // Suggestions for the label picker: existing labels whose name contains
  // the typed text (case-insensitive), most-annotations-first so frequently
  // used labels surface quickly. Typing a name with no match just means
  // "create a new label with this name" on confirm.
  const query = labelQuery.trim().toLowerCase();
  const suggestions = query
    ? labels.filter(l => l.title.toLowerCase().includes(query))
    : labels;
  const exactMatch = labels.some(l => l.title.toLowerCase() === query);

  // Persistent boxes: every visible label's annotations that fall in the
  // current time window, full height, translucent, colored per label.
  const boxes = [];
  if (width > 0) {
    for (const label of labels) {
      if (label.visible === false) continue;
      for (const a of label.annotations) {
        if (a.end <= win.start || a.start >= win.end) continue;
        const x0 = timeToX(Math.max(a.start, win.start), width, win);
        const x1 = timeToX(Math.min(a.end, win.end), width, win);
        boxes.push({ key: `${label.id}:${a.id}`, left: x0, width: Math.max(1, x1 - x0), color: label.color, title: a.name || label.title });
      }
    }
  }

  return (
    <div
      ref={overlayRef}
      className={`spec-overlay ${enabled ? 'spec-overlay--enabled' : ''} ${mode !== 'idle' ? 'spec-overlay--active' : ''}`}
      style={{ height: specHeight }}
      onDoubleClick={enabled ? handleDoubleClick : undefined}
      onMouseMove={enabled ? handleMouseMove : undefined}
      onMouseLeave={enabled ? handleMouseLeave : undefined}
    >
      {/* Persistent annotation boxes, every visible label */}
      {boxes.map(b => (
        <div
          key={b.key}
          className="spec-ann-box"
          title={b.title}
          style={{ left: b.left, width: b.width, background: `${b.color}33`, borderColor: b.color }}
        />
      ))}

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

      {/* Selected region shading (before a label is chosen) */}
      {startX !== null && endX !== null && (
        <div
          className="spec-region"
          style={{
            left: Math.min(startX, endX),
            width: Math.abs(endX - startX),
            borderColor: drawColor,
            background: `${drawColor}22`,
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

      {/* Label picker popup */}
      {mode === 'label' && (
        <div
          className="spec-popup"
          style={{ left: Math.max(8, Math.min(popupX, width - 296)) }}
          onDoubleClick={e => e.stopPropagation()}
        >
          <div className="spec-popup-header">
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
              placeholder="Pick or type a label..."
              value={labelQuery}
              onChange={e => setLabelQuery(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <button
              className="spec-popup-confirm"
              onClick={() => confirm()}
              disabled={!labelQuery.trim()}
            >
              {exactMatch ? 'Add' : 'Add (new)'}
            </button>
          </div>

          {suggestions.length > 0 && (
            <div className="spec-popup-labels">
              {suggestions.map(l => (
                <button
                  key={l.id}
                  className="spec-popup-label-option"
                  onClick={() => confirm(l.title)}
                  title={`${l.annotations.length} annotation${l.annotations.length !== 1 ? 's' : ''}`}
                >
                  <span className="spec-popup-label-dot" style={{ background: l.color }} />
                  <span className="spec-popup-label-name">{l.title}</span>
                  <span className="spec-popup-label-count">{l.annotations.length}</span>
                </button>
              ))}
            </div>
          )}
          {suggestions.length === 0 && (
            <div className="spec-popup-labels-empty">No matching label — press Add to create "{labelQuery.trim()}".</div>
          )}
        </div>
      )}
    </div>
  );
}
