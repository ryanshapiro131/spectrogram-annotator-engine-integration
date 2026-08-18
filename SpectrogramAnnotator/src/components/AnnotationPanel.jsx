import React, { useState } from 'react';
import './AnnotationPanel.css';

function timeToSec(str) {
  const parts = str.split(':');
  if (parts.length === 2) return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  return parseFloat(str) || 0;
}

function secToTime(sec) {
  if (isNaN(sec) || sec === undefined) return '0.000';
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(3);
  return m > 0 ? `${m}:${s.padStart(6, '0')}` : s;
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

// AddAnnotationForm: user types chunk-relative times (what they see on screen).
// chunkStartTime is added to convert to absolute before storing.
function AddAnnotationForm({ onAdd, chunkStartTime }) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    const s = timeToSec(start);
    const en = timeToSec(end);
    if (isNaN(s) || isNaN(en)) { setError('Invalid time values'); return; }
    if (s >= en) { setError('Start must be before end'); return; }
    if (!label.trim()) { setError('Label is required'); return; }
    // Store as absolute timestamps
    onAdd({ start: s + chunkStartTime, end: en + chunkStartTime, label: label.trim() });
    setStart(''); setEnd(''); setLabel(''); setError('');
  };

  return (
    <form className="add-form" onSubmit={handleSubmit}>
      <div className="add-form-title">
        New Annotation
        {chunkStartTime > 0 && (
          <span className="add-form-offset">
            chunk offset +{secToAbsTime(chunkStartTime)} — enter times as shown in player
          </span>
        )}
      </div>
      <div className="add-form-row">
        <div className="field">
          <label>Start (s)</label>
          <input type="text" placeholder="0.000" value={start} onChange={e => setStart(e.target.value)} />
        </div>
        <div className="field">
          <label>End (s)</label>
          <input type="text" placeholder="1.000" value={end} onChange={e => setEnd(e.target.value)} />
        </div>
        <div className="field field--wide">
          <label>Label</label>
          <input type="text" placeholder="Enter label..." value={label} onChange={e => setLabel(e.target.value)} />
        </div>
        <button type="submit" className="btn btn-primary btn-sm">Add</button>
      </div>
      {error && <div className="add-form-error">{error}</div>}
    </form>
  );
}

function AnnotationRow({ annotation, layerId, layerColor, onUpdate, onDelete, onSeek }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(annotation.label);
  const [start, setStart] = useState(String(annotation.start));
  const [end, setEnd] = useState(String(annotation.end));

  const save = () => {
    const s = timeToSec(start);
    const e = timeToSec(end);
    if (!isNaN(s) && !isNaN(e) && s < e && label.trim()) {
      onUpdate(layerId, annotation.id, { start: s, end: e, label: label.trim() });
      setEditing(false);
    }
  };

  const cancel = () => {
    setLabel(annotation.label);
    setStart(String(annotation.start));
    setEnd(String(annotation.end));
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="ann-row ann-row--editing" style={{ borderLeft: `3px solid ${layerColor}` }}>
        <input className="ann-edit-input" value={start} onChange={e => setStart(e.target.value)} title="Absolute start time (s)" />
        <span className="ann-arrow">→</span>
        <input className="ann-edit-input" value={end} onChange={e => setEnd(e.target.value)} title="Absolute end time (s)" />
        <input className="ann-edit-label" value={label} onChange={e => setLabel(e.target.value)} />
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
      <span className="ann-time">{secToAbsTime(annotation.start)}</span>
      <span className="ann-arrow">→</span>
      <span className="ann-time">{secToAbsTime(annotation.end)}</span>
      <span className="ann-label">{annotation.label}</span>
      <span className="ann-duration">{(annotation.end - annotation.start).toFixed(3)}s</span>
      <button className="btn btn-icon" onDoubleClick={e => e.stopPropagation()} onClick={() => setEditing(true)} title="Edit">✎</button>
      <button className="btn btn-icon btn-icon--danger" onDoubleClick={e => e.stopPropagation()} onClick={() => onDelete(layerId, annotation.id)} title="Delete">✕</button>
    </div>
  );
}

function LayerTab({ layer, isActive, onSelect, onUpdate, onRemove }) {
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(layer.title);

  const saveName = () => {
    if (name.trim()) onUpdate(layer.id, { title: name.trim() });
    setEditingName(false);
  };

  return (
    <div className={`layer-tab ${isActive ? 'layer-tab--active' : ''}`} onClick={onSelect}>
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

export default function AnnotationPanel({
  layers, activeLayerId, chunkStartTime,
  onSelectLayer, onAddLayer, onRemoveLayer, onUpdateLayer,
  onAddAnnotation, onUpdateAnnotation, onDeleteAnnotation, onSeek
}) {
  const activeLayer = layers.find(l => l.id === activeLayerId);
  const sorted = activeLayer ? [...activeLayer.annotations].sort((a, b) => a.start - b.start) : [];

  return (
    <section className="annotation-panel">
      <div className="layer-bar">
        <span className="layer-bar-label">Layers</span>
        <div className="layer-tabs">
          {layers.map(layer => (
            <LayerTab
              key={layer.id}
              layer={layer}
              isActive={layer.id === activeLayerId}
              onSelect={() => onSelectLayer(layer.id)}
              onUpdate={onUpdateLayer}
              onRemove={onRemoveLayer}
            />
          ))}
        </div>
        <button className="btn btn-ghost layer-add-btn" onClick={onAddLayer}>+ Add layer</button>
      </div>

      {activeLayer && (
        <>
          <div className="layer-controls">
            <label className="layer-control-item">
              Color
              <input
                type="color"
                value={activeLayer.color}
                onChange={e => onUpdateLayer(activeLayer.id, { color: e.target.value })}
              />
            </label>
            <label className="layer-control-item">
              Row height
              <input type="range" min={20} max={60} step={4}
                value={activeLayer.height}
                onChange={e => onUpdateLayer(activeLayer.id, { height: +e.target.value })}
              />
              <span>{activeLayer.height}px</span>
            </label>
          </div>

          <AddAnnotationForm onAdd={onAddAnnotation} chunkStartTime={chunkStartTime} />

          <div className="ann-list">
            <div className="ann-list-header">
              <span className="section-label">{activeLayer.title}</span>
              <span className="ann-count">{sorted.length} interval{sorted.length !== 1 ? 's' : ''}</span>
            </div>
            {sorted.length === 0 ? (
              <div className="ann-empty">
                No annotations in this layer.<br />
                Enter a time range and label above to add one.
              </div>
            ) : (
              <div className="ann-rows">
                {sorted.map(ann => (
                  <AnnotationRow
                    key={ann.id}
                    annotation={ann}
                    layerId={activeLayer.id}
                    layerColor={activeLayer.color}
                    onUpdate={onUpdateAnnotation}
                    onDelete={onDeleteAnnotation}
                    onSeek={onSeek}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}