import React, { useState } from 'react';
import './AnnotationPanel.css';

function timeToSec(str) {
  const parts = str.split(':');
  if (parts.length === 2) return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  return parseFloat(str) || 0;
}

// Display helper: always show absolute time with an h:mm:ss.sss style for long files
function secToAbsTime(sec) {
  if (isNaN(sec) || sec === undefined) return '0.000';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = (sec % 60).toFixed(2);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${s.padStart(5,'0')}`;
  return m > 0 ? `${m}:${s.padStart(5,'0')}` : s;
}

function AnnotationRow({ annotation, layerId, layerColor, onUpdate, onDelete, onSeek }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(annotation.name || '');
  const [start, setStart] = useState(String(annotation.start));
  const [end, setEnd] = useState(String(annotation.end));

  const save = () => {
    const s = timeToSec(start);
    const e = timeToSec(end);
    if (!isNaN(s) && !isNaN(e) && s < e) {
      onUpdate(layerId, annotation.id, { start: s, end: e, name: name.trim() || annotation.name });
      setEditing(false);
    }
  };

  const cancel = () => {
    setName(annotation.name || '');
    setStart(String(annotation.start));
    setEnd(String(annotation.end));
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="ann-row ann-row--editing" style={{ borderLeft: `3px solid ${layerColor}` }}>
        <input
          className="ann-edit-label"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Annotation name"
          title="Annotation name"
        />
        <input className="ann-edit-input" value={start} onChange={e => setStart(e.target.value)} title="Absolute start time (s)" />
        <span className="ann-arrow">→</span>
        <input className="ann-edit-input" value={end} onChange={e => setEnd(e.target.value)} title="Absolute end time (s)" />
        <button className="btn btn-icon" onClick={save} title="Save">✓</button>
        <button className="btn btn-icon" onClick={cancel} title="Cancel">✕</button>
      </div>
    );
  }

  return (
    <div
      className="ann-row ann-row--seekable"
      style={{ borderLeft: `3px solid ${layerColor}` }}
      onDoubleClick={() => onSeek?.(annotation.start)}
      title="Double-click to jump to this timestamp"
    >
      <span className="ann-name" title={annotation.name}>{annotation.name}</span>
      <span className="ann-time">{secToAbsTime(annotation.start)}</span>
      <span className="ann-arrow">→</span>
      <span className="ann-time">{secToAbsTime(annotation.end)}</span>
      <span className="ann-duration">{(annotation.end - annotation.start).toFixed(3)}s</span>
      <button className="btn btn-icon" onDoubleClick={e => e.stopPropagation()} onClick={() => setEditing(true)} title="Edit">✎</button>
      <button className="btn btn-icon btn-icon--danger" onDoubleClick={e => e.stopPropagation()} onClick={() => onDelete(layerId, annotation.id)} title="Delete">✕</button>
    </div>
  );
}

function LayerTab({ layer, isActive, onSelect, onUpdate, onRemove, onToggleVisible }) {
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(layer.title);

  const saveName = () => {
    if (name.trim()) onUpdate(layer.id, { title: name.trim() });
    setEditingName(false);
  };

  return (
    <div className={`layer-tab ${isActive ? 'layer-tab--active' : ''}`} onClick={onSelect}>
      <input
        type="checkbox"
        className="layer-visible-checkbox"
        checked={layer.visible !== false}
        onClick={e => e.stopPropagation()}
        onChange={() => onToggleVisible(layer.id)}
        title="Show/hide this label's boxes on the spectrogram"
      />
      <span className="layer-dot" style={{ background: layer.color }} />
      {editingName ? (
        <input
          className="layer-name-input"
          value={name}
          autoFocus
          onChange={e => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={e => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setEditingName(false); }}
          onClick={e => e.stopPropagation()}
        />
      ) : (
        <span className="layer-name" onDoubleClick={e => { e.stopPropagation(); setEditingName(true); }}>
          {layer.title}
        </span>
      )}
      <span className="layer-count">{layer.annotations.length}</span>
      {isActive && (
        <button
          className="btn btn-icon btn-icon--danger layer-remove"
          onClick={e => { e.stopPropagation(); onRemove(layer.id); }}
          title="Remove layer"
        >✕</button>
      )}
    </div>
  );
}

// One layer's section within the combined annotation list: a sticky header
// (color + name + count) followed by that layer's own rows, sorted by
// start time. Rendered for every layer at once — see AnnotationPanel below
// for why this isn't scoped to just the active layer.
function LayerAnnotationGroup({ layer, isActive, onUpdateAnnotation, onDeleteAnnotation, onSeek }) {
  const sorted = [...layer.annotations].sort((a, b) => a.start - b.start);

  return (
    <div className={`ann-layer-group ${isActive ? 'ann-layer-group--active' : ''}`}>
      <div className="ann-list-header">
        <span className="ann-layer-header-label">
          <span className="layer-dot" style={{ background: layer.color }} />
          {layer.title}
        </span>
        <span className="ann-count">{sorted.length} interval{sorted.length !== 1 ? 's' : ''}</span>
      </div>
      {sorted.length === 0 ? (
        <div className="ann-empty ann-empty--compact">No annotations in this label yet.</div>
      ) : (
        <div className="ann-rows">
          {sorted.map(ann => (
            <AnnotationRow
              key={ann.id}
              annotation={ann}
              layerId={layer.id}
              layerColor={layer.color}
              onUpdate={onUpdateAnnotation}
              onDelete={onDeleteAnnotation}
              onSeek={onSeek}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function AnnotationPanel({
  layers, activeLayerId,
  onSelectLayer, onAddLayer, onRemoveLayer, onUpdateLayer, onToggleVisible,
  onUpdateAnnotation, onDeleteAnnotation, onSeek
}) {
  const activeLayer = layers.find(l => l.id === activeLayerId);

  return (
    <section className="annotation-panel">
      <div className="layer-bar">
        <span className="layer-bar-label">Labels</span>
        <div className="layer-tabs">
          {layers.map(layer => (
            <LayerTab
              key={layer.id}
              layer={layer}
              isActive={layer.id === activeLayerId}
              onSelect={() => onSelectLayer(layer.id)}
              onUpdate={onUpdateLayer}
              onRemove={onRemoveLayer}
              onToggleVisible={onToggleVisible}
            />
          ))}
        </div>
        <button className="btn btn-ghost layer-add-btn" onClick={onAddLayer}>+ Add label</button>
      </div>

      {activeLayer && (
        <div className="layer-controls">
          <label className="layer-control-item">
            Color
            <input
              type="color"
              value={activeLayer.color}
              onChange={e => onUpdateLayer(activeLayer.id, { color: e.target.value })}
            />
          </label>
        </div>
      )}

      {/* Every label's annotations, grouped under their own header — not
          just the active tab's — so the user can scroll through everything
          they've labeled without switching tabs. */}
      <div className="ann-list">
        {layers.map(layer => (
          <LayerAnnotationGroup
            key={layer.id}
            layer={layer}
            isActive={layer.id === activeLayerId}
            onUpdateAnnotation={onUpdateAnnotation}
            onDeleteAnnotation={onDeleteAnnotation}
            onSeek={onSeek}
          />
        ))}
      </div>
    </section>
  );
}
