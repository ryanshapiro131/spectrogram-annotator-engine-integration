import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './ImageCanvas.css';

/*
 * The image annotator's drawing surface, modeled on labelImg's Canvas
 * (libs/canvas.py):
 *   - Draw mode: press-drag-release draws a rectangle. Points are clamped to
 *     the image and snapped to whole pixels, so what you see is exactly what
 *     a Pascal VOC export writes. Boxes under 2 px are dropped as misclicks.
 *   - Edit mode: click a box to select it; drag it to move (kept inside the
 *     image, like bounded_move_shape); drag a corner/edge handle to resize
 *     (bounded_move_vertex). Drag empty space to pan.
 *   - Wheel zooms around the pointer; middle-drag pans in either mode.
 * Everything is in image pixels; the view is a CSS transform (scale +
 * translate) over the <img> and an SVG of the same size.
 *
 * Keyboard (nudge, delete, duplicate…) lives in ImageAnnotator, which owns
 * the annotation data; this component only reports gestures:
 *   onDraw(box)            a new box (the parent asks for its label)
 *   onChangeBox(key, box)  a box was moved or resized
 *   onSelect(key | null)
 */

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const MIN_DRAW_PX = 2;
const MIN_SCALE = 0.02;
const MAX_SCALE = 40;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const norm = (x0, y0, x1, y1) => ({
  xmin: Math.min(x0, x1), ymin: Math.min(y0, y1), xmax: Math.max(x0, x1), ymax: Math.max(y0, y1),
});
const sameBox = (a, b) => a.xmin === b.xmin && a.ymin === b.ymin && a.xmax === b.xmax && a.ymax === b.ymax;

function handlePoint(h, b) {
  const x = h.includes('w') ? b.xmin : h.includes('e') ? b.xmax : (b.xmin + b.xmax) / 2;
  const y = h.includes('n') ? b.ymin : h.includes('s') ? b.ymax : (b.ymin + b.ymax) / 2;
  return { x, y };
}

export default function ImageCanvas({
  src, width, height,
  boxes,              // [{ key, box, color, title, difficult, editable }]
  selectedKey = null,
  onSelect,
  drawing = false,    // draw mode (W)
  pendingBox = null,  // a new box waiting for its label
  onDraw,
  onChangeBox,
  showLabels = true,
  fitSignal = 0,      // bump to re-fit the image to the view
}) {
  const wrapRef = useRef(null);
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const fittedRef = useRef(true);   // keep fitting on resize until the user zooms/pans
  const dragRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const [cursor, setCursor] = useState(null); // image coords under the pointer, or null

  // ---------------------------------------------------------------------------
  // View
  // ---------------------------------------------------------------------------
  const fit = useCallback(() => {
    const el = wrapRef.current;
    if (!el || !width || !height) return;
    const cw = el.clientWidth, ch = el.clientHeight;
    const scale = clamp(Math.min(cw / width, ch / height) * 0.96, MIN_SCALE, MAX_SCALE);
    setView({ scale, tx: (cw - width * scale) / 2, ty: (ch - height * scale) / 2 });
    fittedRef.current = true;
  }, [width, height]);

  useLayoutEffect(() => { fit(); }, [fit, src, fitSignal]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => { if (fittedRef.current) fit(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  const zoomAt = useCallback((factor, cx, cy) => {
    setView(v => {
      const scale = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
      const f = scale / v.scale;
      return { scale, tx: cx - (cx - v.tx) * f, ty: cy - (cy - v.ty) * f };
    });
    fittedRef.current = false;
  }, []);

  const zoomCenter = useCallback((factor) => {
    const el = wrapRef.current;
    if (el) zoomAt(factor, el.clientWidth / 2, el.clientHeight / 2);
  }, [zoomAt]);

  const actualSize = useCallback(() => {
    const el = wrapRef.current;
    if (el) zoomAt(1 / viewRef.current.scale, el.clientWidth / 2, el.clientHeight / 2);
  }, [zoomAt]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const toImage = (e) => {
    const r = wrapRef.current.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (e.clientX - r.left - v.tx) / v.scale, y: (e.clientY - r.top - v.ty) / v.scale };
  };
  const clampToImage = (p) => ({ x: Math.round(clamp(p.x, 0, width)), y: Math.round(clamp(p.y, 0, height)) });

  // ---------------------------------------------------------------------------
  // Gestures
  // ---------------------------------------------------------------------------
  const startDrag = (e, d) => {
    e.preventDefault();
    wrapRef.current.setPointerCapture(e.pointerId);
    dragRef.current = d;
    setDrag(d);
  };

  const onPointerDown = (e) => {
    if (e.button === 1) {
      startDrag(e, { kind: 'pan', x0: e.clientX, y0: e.clientY, v0: viewRef.current });
      return;
    }
    if (e.button !== 0) return;
    const t = e.target;
    const key = t.dataset?.key;
    const target = key ? boxes.find(b => b.key === key) : null;
    const p = toImage(e);

    if (t.dataset?.handle && target?.editable) {
      startDrag(e, { kind: 'resize', key, handle: t.dataset.handle, start: target.box, box: null });
    } else if (drawing) {
      if (p.x < 0 || p.y < 0 || p.x > width || p.y > height) return; // labelImg ignores clicks off the image
      startDrag(e, { kind: 'draw', p0: clampToImage(p), box: null });
    } else if (target) {
      onSelect?.(key);
      if (target.editable) startDrag(e, { kind: 'move', key, p0: p, start: target.box, box: null });
    } else {
      onSelect?.(null);
      startDrag(e, { kind: 'pan', x0: e.clientX, y0: e.clientY, v0: viewRef.current });
    }
  };

  const onPointerMove = (e) => {
    const p = toImage(e);
    setCursor(p.x >= 0 && p.y >= 0 && p.x <= width && p.y <= height ? p : null);
    const d = dragRef.current;
    if (!d) return;
    let next = d;
    if (d.kind === 'pan') {
      setView({ ...d.v0, tx: d.v0.tx + e.clientX - d.x0, ty: d.v0.ty + e.clientY - d.y0 });
      fittedRef.current = false;
      return;
    }
    if (d.kind === 'draw') {
      const q = clampToImage(p);
      next = { ...d, box: norm(d.p0.x, d.p0.y, q.x, q.y) };
    } else if (d.kind === 'move') {
      const b = d.start;
      const dx = clamp(Math.round(p.x - d.p0.x), -b.xmin, width - b.xmax);
      const dy = clamp(Math.round(p.y - d.p0.y), -b.ymin, height - b.ymax);
      next = { ...d, box: { xmin: b.xmin + dx, ymin: b.ymin + dy, xmax: b.xmax + dx, ymax: b.ymax + dy } };
    } else if (d.kind === 'resize') {
      const q = clampToImage(p);
      let { xmin, ymin, xmax, ymax } = d.start;
      if (d.handle.includes('w')) xmin = q.x;
      if (d.handle.includes('e')) xmax = q.x;
      if (d.handle.includes('n')) ymin = q.y;
      if (d.handle.includes('s')) ymax = q.y;
      next = { ...d, box: norm(xmin, ymin, xmax, ymax) };
    }
    dragRef.current = next;
    setDrag(next);
  };

  const endDrag = (commit) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!commit || !d?.box) return;
    const w = d.box.xmax - d.box.xmin, h = d.box.ymax - d.box.ymin;
    if (d.kind === 'draw') {
      if (w >= MIN_DRAW_PX && h >= MIN_DRAW_PX) onDraw?.(d.box);
    } else if ((d.kind === 'move' || d.kind === 'resize') && w >= 1 && h >= 1 && !sameBox(d.box, d.start)) {
      onChangeBox?.(d.key, d.box);
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const { scale, tx, ty } = view;
  const px = 1 / scale; // one screen pixel, in image units

  // Big boxes first so small ones nested inside stay clickable; selected on top.
  const ordered = useMemo(() => {
    const area = (b) => (b.box.xmax - b.box.xmin) * (b.box.ymax - b.box.ymin);
    return [...boxes].sort((a, b) => (a.key === selectedKey) - (b.key === selectedKey) || area(b) - area(a));
  }, [boxes, selectedKey]);

  const drawnBox = drag?.kind === 'draw' ? drag.box : null;
  const cursorClass = drag?.kind === 'pan' ? 'image-canvas--panning' : drawing ? 'image-canvas--drawing' : '';

  return (
    <div
      ref={wrapRef}
      className={`image-canvas ${cursorClass}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => endDrag(true)}
      onPointerCancel={() => endDrag(false)}
      onPointerLeave={() => setCursor(null)}
      onAuxClick={e => e.preventDefault()}
    >
      <div
        className="image-canvas-stage"
        style={{ width, height, transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}
      >
        <img
          src={src} width={width} height={height} alt="" draggable={false}
          style={{ imageRendering: scale >= 3 ? 'pixelated' : 'auto' }}
        />
        <svg className="image-canvas-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
          {ordered.map(b => {
            const box = drag?.key === b.key && drag.box ? drag.box : b.box;
            const selected = b.key === selectedKey;
            return (
              <BoxShape
                key={b.key} item={b} box={box} px={px} selected={selected}
                showLabel={showLabels} showHandles={selected && b.editable && !drawing}
              />
            );
          })}
          {pendingBox && <PlainRect box={pendingBox} px={px} className="image-canvas-pending" />}
          {drawnBox && <PlainRect box={drawnBox} px={px} className="image-canvas-drawn" />}
          {drawing && cursor && !drag && (
            <g className="image-canvas-crosshair" strokeWidth={px}>
              <line x1={cursor.x} y1={0} x2={cursor.x} y2={height} />
              <line x1={0} y1={cursor.y} x2={width} y2={cursor.y} />
            </g>
          )}
        </svg>
      </div>

      <div className="image-canvas-hud" onPointerDown={e => e.stopPropagation()}>
        <span className="image-canvas-coords">
          {cursor ? `${Math.floor(cursor.x)}, ${Math.floor(cursor.y)}` : `${width} × ${height}`}
          {drawnBox && ` · ${drawnBox.xmax - drawnBox.xmin} × ${drawnBox.ymax - drawnBox.ymin}`}
        </span>
        <span className="image-canvas-zoom">
          <button className="btn btn-icon" onClick={() => zoomCenter(1 / 1.25)} title="Zoom out (scroll down)">−</button>
          <span className="image-canvas-zoom-pct">{Math.round(scale * 100)}%</span>
          <button className="btn btn-icon" onClick={() => zoomCenter(1.25)} title="Zoom in (scroll up)">+</button>
          <button className="btn btn-ghost btn-sm" onClick={fit} title="Fit the image to the window (F)">Fit</button>
          <button className="btn btn-ghost btn-sm" onClick={actualSize} title="Actual size: one image pixel per screen pixel">1:1</button>
        </span>
      </div>
    </div>
  );
}

function PlainRect({ box, px, className }) {
  return (
    <rect
      className={className}
      x={box.xmin} y={box.ymin} width={box.xmax - box.xmin} height={box.ymax - box.ymin}
      strokeWidth={2 * px} strokeDasharray={`${6 * px} ${4 * px}`}
    />
  );
}

function BoxShape({ item, box, px, selected, showLabel, showHandles }) {
  const w = box.xmax - box.xmin, h = box.ymax - box.ymin;
  const fontSize = 12 * px;
  const tagH = 16 * px;
  const tagW = (item.title.length * 7 + 10 + (item.difficult ? 18 : 0)) * px;
  // Tag sits above the box, or just inside when the box touches the top edge.
  const tagY = box.ymin - tagH >= 0 ? box.ymin - tagH : box.ymin;
  const hs = 9 * px;
  return (
    <g className={`image-box ${selected ? 'image-box--selected' : ''} ${item.editable ? '' : 'image-box--locked'}`}>
      <rect
        data-key={item.key}
        x={box.xmin} y={box.ymin} width={w} height={h}
        fill={item.color} fillOpacity={selected ? 0.25 : 0.1}
        stroke={item.color} strokeWidth={(selected ? 3 : 2) * px}
        strokeDasharray={item.difficult ? `${8 * px} ${4 * px}` : undefined}
        pointerEvents="all"
      />
      {selected && (
        <rect
          x={box.xmin} y={box.ymin} width={w} height={h} fill="none"
          stroke="#fff" strokeWidth={px} strokeOpacity={0.9} pointerEvents="none"
        />
      )}
      {showLabel && (
        <g pointerEvents="none">
          <rect x={box.xmin} y={tagY} width={tagW} height={tagH} fill={item.color} />
          <text x={box.xmin + 5 * px} y={tagY + 12 * px} fontSize={fontSize} className="image-box-tag">
            {item.title}{item.difficult ? ' ⚑' : ''}
          </text>
        </g>
      )}
      {showHandles && HANDLES.map(hd => {
        const p = handlePoint(hd, box);
        return (
          <rect
            key={hd} data-key={item.key} data-handle={hd}
            className={`image-box-handle image-box-handle--${hd}`}
            x={p.x - hs / 2} y={p.y - hs / 2} width={hs} height={hs}
            strokeWidth={px} pointerEvents="all"
          />
        );
      })}
    </g>
  );
}
