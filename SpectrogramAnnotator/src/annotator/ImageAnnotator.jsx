import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ImageCanvas from '../components/ImageCanvas';
import ImageAnnotationPanel from '../components/ImageAnnotationPanel';
import SaveIndicator from './SaveIndicator';
import { IMAGE_ACCEPT } from '../imageUpload';
import '../App.css';
import './ImageAnnotator.css';

/*
 * The photo annotator: bounding boxes on images, modeled on labelImg.
 *
 *   left    the image queue (labelImg's file list): verified ✓ and box counts
 *   center  ImageCanvas: draw / select / move / resize boxes, zoom + pan
 *   right   labels and this image's boxes (label, size, difficult)
 *
 * Like AudioAnnotator, where images and annotations come from is up to the
 * page: `store` is an annotation store (useProjectAnnotations for project
 * files, autosaved; useLocalImageAnnotations for /photo, in memory), and the
 * page supplies the queue, the current image and the actions it supports.
 *
 * Keyboard (labelImg's, where the browser allows):
 *   W            draw mode on/off          D / A     next / previous image
 *   Space        verify image              Ctrl+V    copy previous image's boxes
 *   Delete       delete selected box       Ctrl+D    duplicate selected box
 *   Arrows       nudge 1 px (Shift: 10)    E         change selected box's label
 *   F            fit image to window       Esc       deselect / cancel
 */
export default function ImageAnnotator({
  images = [],            // [{ key, name, verified, count }] — the queue
  currentIndex = -1,
  onNavigate,             // (index) => void
  image,                  // { status: idle|loading|ready|missing|error, url, width, height, name, verified, error }
  store,
  headerLeft, headerExtra,
  onClose, closeLabel = 'Close',
  renderIdle, renderMissing,
  onToggleVerified,       // () => void, or null when not allowed
  onCopyPrevious,         // () => void, or null
  onImportVoc,            // (File) => void, or null
  onExport,               // () => void, or null
}) {
  const [drawMode, setDrawMode] = useState(true);
  const [selectedKey, setSelectedKey] = useState(null);
  const [pending, setPending] = useState(null); // { box } new box, or { relabelKey } — waiting on the label picker
  const [singleClass, setSingleClass] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [fitSignal, setFitSignal] = useState(0);
  const lastLabelRef = useRef(null);
  const canAnnotate = store.canCreate;
  const ready = image?.status === 'ready';

  // Clear selection and any open picker when the image changes.
  useEffect(() => { setSelectedKey(null); setPending(null); }, [image?.url, currentIndex]);

  // Every visible label's boxes, flattened for the canvas.
  const { boxes, byKey } = useMemo(() => {
    const list = [];
    const map = new Map();
    for (const layer of store.layers) {
      for (const ann of layer.annotations) {
        if (!ann.box) continue;
        const key = ann.key ?? ann.id;
        const item = {
          key, ann, layerId: layer.id, box: ann.box, color: layer.color, title: layer.title,
          difficult: ann.difficult, editable: store.canEditAnnotation(ann),
        };
        map.set(key, item);
        if (layer.visible !== false) list.push(item);
      }
    }
    return { boxes: list, byKey: map };
  }, [store.layers, store.canEditAnnotation]);

  const selected = selectedKey ? byKey.get(selectedKey) : null;
  const labelExists = (id) => store.layers.some(l => l.id === id);

  const addBox = useCallback((labelId, box, difficult = false) => {
    const key = store.addAnnotation(labelId, { box, difficult });
    lastLabelRef.current = labelId;
    store.setActiveLayerId(labelId);
    return key;
  }, [store]);

  // A box was drawn: label it (single-class mode reuses the last label, as in labelImg).
  const handleDraw = useCallback((box) => {
    if (singleClass && lastLabelRef.current && labelExists(lastLabelRef.current)) {
      setSelectedKey(addBox(lastLabelRef.current, box));
      return;
    }
    setPending({ box });
  }, [singleClass, addBox, store.layers]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePick = useCallback((choice) => {
    const p = pending;
    setPending(null);
    if (!p) return;
    const labelId = choice.id ?? store.resolveOrCreateLabel(choice.name);
    if (p.relabelKey) {
      const item = byKey.get(p.relabelKey);
      const title = store.layers.find(l => l.id === labelId)?.title ?? choice.name;
      if (item && item.layerId !== labelId) store.updateAnnotation(item.layerId, item.ann.id, { labelId, name: title });
      lastLabelRef.current = labelId;
      return;
    }
    setSelectedKey(addBox(labelId, p.box));
  }, [pending, store, byKey, addBox]);

  const changeBox = useCallback((key, box) => {
    const item = byKey.get(key);
    if (item?.editable) store.updateAnnotation(item.layerId, item.ann.id, { box });
  }, [byKey, store]);

  const deleteSelected = useCallback(() => {
    if (!selected?.editable) return;
    store.deleteAnnotation(selected.layerId, selected.ann.id);
    setSelectedKey(null);
  }, [selected, store]);

  // labelImg's copy_selected_shape: same label, offset so it's visible, kept inside the image.
  const duplicateSelected = useCallback(() => {
    if (!selected || !canAnnotate || !image) return;
    const b = selected.box;
    const w = b.xmax - b.xmin, h = b.ymax - b.ymin;
    const off = 10;
    const x = b.xmax + off <= image.width ? b.xmin + off : Math.max(0, b.xmin - off);
    const y = b.ymax + off <= image.height ? b.ymin + off : Math.max(0, b.ymin - off);
    setSelectedKey(addBox(selected.layerId, { xmin: x, ymin: y, xmax: x + w, ymax: y + h }, selected.ann.difficult));
  }, [selected, canAnnotate, image, addBox]);

  // Arrow keys: move the selected box; blocked at the image edge (labelImg's move_out_of_bound).
  const nudge = useCallback((dx, dy) => {
    if (!selected?.editable || !image) return;
    const b = selected.box;
    const nb = { xmin: b.xmin + dx, ymin: b.ymin + dy, xmax: b.xmax + dx, ymax: b.ymax + dy };
    if (nb.xmin < 0 || nb.ymin < 0 || nb.xmax > image.width || nb.ymax > image.height) return;
    changeBox(selected.key, nb);
  }, [selected, image, changeBox]);

  const go = useCallback((delta) => {
    const i = currentIndex + delta;
    if (i >= 0 && i < images.length) onNavigate?.(i);
  }, [currentIndex, images.length, onNavigate]);

  useEffect(() => {
    const handler = (e) => {
      if (pending) return; // the label picker has the keyboard
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
      const k = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && k === 'd') { e.preventDefault(); duplicateSelected(); return; }
      if (ctrl && k === 'v') { if (onCopyPrevious && canAnnotate) { e.preventDefault(); onCopyPrevious(); } return; }
      if (ctrl || e.altKey) return;
      if (k === 'w' && canAnnotate) { e.preventDefault(); setDrawMode(m => !m); }
      else if (k === 'd') { e.preventDefault(); go(1); }
      else if (k === 'a') { e.preventDefault(); go(-1); }
      else if (k === 'f') { e.preventDefault(); setFitSignal(s => s + 1); }
      else if (k === 'e' && selected?.editable) { e.preventDefault(); setPending({ relabelKey: selected.key }); }
      else if (e.key === ' ' && tag !== 'BUTTON' && onToggleVerified && ready) { e.preventDefault(); onToggleVerified(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { e.preventDefault(); deleteSelected(); }
      else if (e.key === 'Escape') setSelectedKey(null);
      else if (e.key.startsWith('Arrow') && selected) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        nudge(
          e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0,
          e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0,
        );
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [pending, selected, canAnnotate, ready, go, nudge, deleteSelected, duplicateSelected, onCopyPrevious, onToggleVerified]);

  const status = image?.status ?? 'idle';
  const inWorkspace = status !== 'idle' && (images.length > 0 || ready);
  const boxCount = byKey.size;

  return (
    <div className="app app--image">
      <header className="app-header">
        <div className="header-left">
          {headerLeft ?? (
            <>
              <span className="media-type-badge">Photo</span>
              {image?.name && <span className="file-badge">{image.name}</span>}
            </>
          )}
          {ready && <span className="file-meta">{image.width} × {image.height}</span>}
          {ready && image.verified && <span className="verified-badge" title="This image's boxes have been checked">✓ Verified</span>}
        </div>
        <div className="header-right">
          {store.saveState && <SaveIndicator state={store.saveState} />}
          {ready && !canAnnotate && !store.loading && <span className="readonly-badge" title="Your role in this project can view but not annotate">View only</span>}
          {headerExtra}
          {ready && onImportVoc && canAnnotate && (
            <label className="btn btn-ghost btn-sm file-input-label" title="Add boxes from a labelImg / Pascal VOC .xml file">
              Import VOC
              <input
                type="file" accept=".xml" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files[0]; e.target.value = ''; if (f) onImportVoc(f); }}
              />
            </label>
          )}
          {inWorkspace && onExport && <button className="btn btn-ghost btn-sm" onClick={onExport}>Export</button>}
          {onClose && status !== 'idle' && (
            <>
              <div className="header-divider" />
              <button className="btn btn-ghost btn-sm" onClick={onClose}>{closeLabel}</button>
            </>
          )}
        </div>
      </header>

      <main className="app-main image-main">
        {status === 'idle' && renderIdle?.()}
        {store.loadError && (
          <div className="annotator-load-error">Couldn't load this image's annotations: {store.loadError}</div>
        )}

        {inWorkspace && (
          <div className="image-workspace">
            {images.length > 0 && (
              <ImageQueue images={images} currentIndex={currentIndex} onNavigate={onNavigate} />
            )}

            <section className="image-stage-section">
              <div className="section-header image-toolbar">
                <div className="section-header-left">
                  {canAnnotate && (
                    <button
                      className={`btn btn-sm annotate-toggle ${drawMode ? 'annotate-toggle--on' : ''}`}
                      onClick={() => setDrawMode(m => !m)}
                      title="Draw mode: drag on the image to draw a box. Off: select, move and resize boxes. (W)"
                    >
                      <span className="annotate-toggle-dot" />
                      {drawMode ? 'Drawing boxes' : 'Editing'}
                      <span className="annotate-toggle-key">W</span>
                    </button>
                  )}
                  {canAnnotate && (
                    <label className="image-toolbar-check" title="Label every new box with the last label used, without asking (labelImg's single class mode)">
                      <input type="checkbox" checked={singleClass} onChange={e => setSingleClass(e.target.checked)} />
                      Single label
                    </label>
                  )}
                  <label className="image-toolbar-check" title="Show each box's label on the image">
                    <input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} />
                    Label text
                  </label>
                </div>
                <div className="section-header-left">
                  {ready && onToggleVerified && (
                    <button
                      className={`btn btn-sm verify-toggle ${image.verified ? 'verify-toggle--on' : ''}`}
                      onClick={onToggleVerified}
                      title="Mark this image's boxes as checked (Space)"
                      aria-pressed={!!image.verified}
                    >
                      {image.verified ? '✓ Verified' : 'Verify'} <span className="annotate-toggle-key">Space</span>
                    </button>
                  )}
                  {ready && onCopyPrevious && canAnnotate && currentIndex > 0 && (
                    <button className="btn btn-ghost btn-sm" onClick={onCopyPrevious} title="Copy the previous image's boxes onto this one (Ctrl+V)">
                      Copy previous
                    </button>
                  )}
                  {images.length > 1 && (
                    <span className="image-nav">
                      <button className="btn btn-ghost btn-sm" disabled={currentIndex <= 0} onClick={() => go(-1)} title="Previous image (A)">‹ Prev</button>
                      <span className="image-nav-pos">{currentIndex + 1} / {images.length}</span>
                      <button className="btn btn-ghost btn-sm" disabled={currentIndex >= images.length - 1} onClick={() => go(1)} title="Next image (D)">Next ›</button>
                    </span>
                  )}
                  <ShortcutHelp />
                </div>
              </div>

              <div className="image-stage">
                {ready && (
                  <ImageCanvas
                    src={image.url}
                    width={image.width}
                    height={image.height}
                    boxes={boxes}
                    selectedKey={selectedKey}
                    onSelect={setSelectedKey}
                    drawing={drawMode && canAnnotate && !pending}
                    pendingBox={pending?.box ?? null}
                    onDraw={handleDraw}
                    onChangeBox={changeBox}
                    showLabels={showLabels}
                    fitSignal={fitSignal}
                  />
                )}
                {status === 'loading' && <div className="image-stage-message">Loading {image.name || 'image'}…</div>}
                {status === 'error' && (
                  <div className="image-stage-message image-stage-message--error">
                    Couldn't load this image. <code>{image.error || 'Unknown error'}</code>
                  </div>
                )}
                {status === 'missing' && <div className="image-stage-overlay">{renderMissing?.()}</div>}
                {pending && (
                  <LabelPicker
                    labels={store.layers}
                    defaultId={pending.relabelKey ? byKey.get(pending.relabelKey)?.layerId : (lastLabelRef.current ?? store.activeLayerId)}
                    title={pending.relabelKey ? 'Change label' : 'Label this box'}
                    onPick={handlePick}
                    onCancel={() => setPending(null)}
                  />
                )}
              </div>
            </section>

            <ImageAnnotationPanel
              layers={store.layers}
              activeLayerId={store.activeLayerId}
              onSelectLayer={store.setActiveLayerId}
              onAddLayer={store.addLayer}
              onRemoveLayer={store.removeLayer}
              onUpdateLayer={store.updateLayer}
              onToggleVisible={store.toggleLayerVisible}
              onResolveLabel={store.resolveOrCreateLabel}
              selectedKey={selectedKey}
              onSelectBox={setSelectedKey}
              onUpdateAnnotation={store.updateAnnotation}
              onDeleteAnnotation={store.deleteAnnotation}
              canCreate={canAnnotate}
              canEditLayer={store.canEditLayer}
              canEditAnnotation={store.canEditAnnotation}
              boxCount={boxCount}
            />
          </div>
        )}
      </main>
    </div>
  );
}

function ImageQueue({ images, currentIndex, onNavigate }) {
  const activeRef = useRef(null);
  useEffect(() => { activeRef.current?.scrollIntoView({ block: 'nearest' }); }, [currentIndex]);
  const verified = images.filter(im => im.verified).length;
  return (
    <aside className="image-queue" aria-label="Images">
      <div className="image-queue-head">
        <span className="section-label">Images</span>
        <span className="image-queue-progress" title="Verified images">{verified} / {images.length} ✓</span>
      </div>
      <ul className="image-queue-list">
        {images.map((im, i) => (
          <li key={im.key}>
            <button
              ref={i === currentIndex ? activeRef : null}
              className={`image-queue-item ${i === currentIndex ? 'image-queue-item--on' : ''}`}
              onClick={() => onNavigate?.(i)}
              aria-current={i === currentIndex ? 'true' : undefined}
              title={im.name}
            >
              <span className={`image-queue-check ${im.verified ? 'image-queue-check--on' : ''}`} aria-label={im.verified ? 'Verified' : undefined}>
                {im.verified ? '✓' : ''}
              </span>
              <span className="image-queue-name">{im.name}</span>
              <span className="image-queue-count">{im.count || ''}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

// labelImg's label dialog: pick an existing label (filter by typing) or type a new one.
function LabelPicker({ labels, defaultId, title, onPick, onCancel }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(() => Math.max(0, labels.findIndex(l => l.id === defaultId)));
  const q = query.trim().toLowerCase();
  const matches = q ? labels.filter(l => l.title.toLowerCase().includes(q)) : labels;
  const exact = labels.find(l => l.title.toLowerCase() === q);
  const options = [...matches.map(l => ({ id: l.id, name: l.title, color: l.color })),
    ...(q && !exact ? [{ id: null, name: query.trim(), isNew: true }] : [])];
  const active = Math.min(index, options.length - 1);

  useEffect(() => { if (q) setIndex(0); }, [q]);

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => Math.min(options.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const o = options[active];
      if (o) onPick(o);
    }
  };

  return (
    <div className="label-picker-backdrop" onPointerDown={onCancel}>
      <div className="label-picker" role="dialog" aria-label={title} onPointerDown={e => e.stopPropagation()}>
        <div className="label-picker-title">{title}</div>
        <input
          autoFocus
          className="label-picker-input"
          placeholder={labels.length ? 'Filter, or type a new label…' : 'Type a label name…'}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          maxLength={100}
        />
        <ul className="label-picker-list" role="listbox">
          {options.map((o, i) => (
            <li key={o.id ?? `new-${o.name}`}>
              <button
                className={`label-picker-option ${i === active ? 'label-picker-option--on' : ''}`}
                onMouseEnter={() => setIndex(i)}
                onClick={() => onPick(o)}
                role="option"
                aria-selected={i === active}
              >
                {o.isNew
                  ? <><span className="label-picker-plus">+</span> New label “{o.name}”</>
                  : <><span className="layer-dot" style={{ background: o.color }} /> {o.name}</>}
              </button>
            </li>
          ))}
          {options.length === 0 && <li className="label-picker-empty">No labels yet. Type a name.</li>}
        </ul>
        <div className="label-picker-hint">Enter to choose · Esc to discard the box</div>
      </div>
    </div>
  );
}

function ShortcutHelp() {
  return (
    <span className="shortcut-help" tabIndex={0} aria-label="Keyboard shortcuts">
      ?
      <span className="shortcut-help-pop" role="tooltip">
        <b>W</b> draw / edit · <b>D</b> / <b>A</b> next / previous image<br />
        <b>Space</b> verify · <b>Ctrl+V</b> copy previous image's boxes<br />
        <b>Del</b> delete box · <b>Ctrl+D</b> duplicate · <b>E</b> change label<br />
        <b>Arrows</b> nudge 1 px (<b>Shift</b> 10) · <b>F</b> fit · <b>Esc</b> deselect<br />
        Scroll to zoom · drag empty space (or middle-drag) to pan
      </span>
    </span>
  );
}

// The drop zone shown before any image is loaded (standalone /photo, or re-uploading a missing project image).
export function ImageDropZone({ onFiles, title = 'Photo Annotation', subtitle, multiple = true, before, dropLabel, folder = false }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div className="welcome-screen">
      <div className={`welcome-content ${before ? 'welcome-content--wide' : ''}`}>
        <div className="welcome-icon">▣</div>
        <h1 className="welcome-title">{title}</h1>
        {subtitle && <p className="welcome-subtitle">{subtitle}</p>}
        {before}
        {dropLabel && <div className="welcome-divider"><span>{dropLabel}</span></div>}
        <label
          className={`file-drop-zone ${dragging ? 'file-drop-zone--dragging' : ''}`}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => {
            e.preventDefault();
            setDragging(false);
            const files = [...e.dataTransfer.files];
            if (files.length) onFiles(multiple ? files : [files[0]]);
          }}
        >
          <span className="file-drop-icon">⊕</span>
          <span className="file-drop-text">Drop {multiple ? 'images' : 'the image'} here</span>
          <span className="file-drop-sub">or click to browse{multiple ? ' (labelImg .xml files alongside are imported too)' : ''}</span>
          <input
            type="file" accept={multiple ? `${IMAGE_ACCEPT},.xml` : IMAGE_ACCEPT} multiple={multiple} style={{ display: 'none' }}
            onChange={e => {
              const files = [...e.target.files];
              e.target.value = '';
              if (files.length) onFiles(files);
            }}
          />
        </label>
        {folder && (
          <label className="btn btn-ghost btn-sm file-input-label welcome-folder-btn">
            Open a folder…
            <input
              type="file" webkitdirectory="" directory="" multiple style={{ display: 'none' }}
              onChange={e => {
                const files = [...e.target.files];
                e.target.value = '';
                if (files.length) onFiles(files);
              }}
            />
          </label>
        )}
        <div className="welcome-hint">
          <span className="tag">.jpg</span>
          <span className="tag">.png</span>
          <span className="tag">.webp</span>
          <span className="tag">.bmp</span>
          <span className="tag">.tif</span>
        </div>
      </div>
    </div>
  );
}
