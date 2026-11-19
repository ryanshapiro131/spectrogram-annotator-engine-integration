import React, { useEffect, useRef } from 'react';
import { LayerTab } from './AnnotationPanel';
import './AnnotationPanel.css';

/*
 * Right-hand panel of the photo annotator: the project's labels (shared
 * with the audio annotator's label model: name + color, show/hide) and the
 * current image's boxes grouped by label. Rows select the box on the
 * canvas; editable rows can change label, toggle "difficult" (Pascal VOC's
 * flag, as in labelImg) or delete.
 */
export default function ImageAnnotationPanel({
  layers, activeLayerId,
  onSelectLayer, onAddLayer, onRemoveLayer, onUpdateLayer, onToggleVisible, onResolveLabel,
  selectedKey, onSelectBox,
  onUpdateAnnotation, onDeleteAnnotation,
  canCreate = true, canEditLayer = () => true, canEditAnnotation = () => true,
  boxCount = 0,
}) {
  const activeLayer = layers.find(l => l.id === activeLayerId);

  // labelImg's predefined_classes.txt: one label name per line.
  const loadClasses = async (file) => {
    const text = await file.text();
    const names = [...new Set(text.split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
    names.slice(0, 500).forEach(n => onResolveLabel(n));
  };

  return (
    <section className="annotation-panel image-panel">
      <div className="image-panel-section">
        <div className="image-panel-head">
          <span className="section-label">Labels</span>
          {canCreate && (
            <span className="image-panel-actions">
              <label className="btn btn-ghost btn-sm file-input-label" title="Add labels from a text file, one per line (labelImg's predefined_classes.txt)">
                Load list
                <input
                  type="file" accept=".txt,text/plain" style={{ display: 'none' }}
                  onChange={e => { const f = e.target.files[0]; e.target.value = ''; if (f) loadClasses(f); }}
                />
              </label>
              <button className="btn btn-ghost btn-sm" onClick={onAddLayer}>+ Add</button>
            </span>
          )}
        </div>
        {layers.length === 0 ? (
          <div className="ann-empty ann-empty--compact">
            No labels yet.{canCreate ? ' Draw a box and type a name, or load a list.' : ''}
          </div>
        ) : (
          <div className="image-label-list">
            {layers.map(layer => (
              <LayerTab
                key={layer.key ?? layer.id}
                layer={layer}
                isActive={layer.id === activeLayerId}
                canEdit={canEditLayer(layer)}
                onSelect={() => onSelectLayer(layer.id)}
                onUpdate={onUpdateLayer}
                onRemove={onRemoveLayer}
                onToggleVisible={onToggleVisible}
              />
            ))}
          </div>
        )}
        {activeLayer && canEditLayer(activeLayer) && (
          <label className="layer-control-item image-panel-color">
            Color of “{activeLayer.title}”
            <input
              type="color"
              value={activeLayer.color}
              onChange={e => onUpdateLayer(activeLayer.id, { color: e.target.value })}
            />
          </label>
        )}
      </div>

      <div className="image-panel-head image-panel-head--boxes">
        <span className="section-label">Boxes on this image</span>
        <span className="ann-count">{boxCount}</span>
      </div>
      <div className="ann-list">
        {boxCount === 0 && (
          <div className="ann-empty">No boxes yet.{canCreate ? ' Drag on the image to draw one.' : ''}</div>
        )}
        {layers.filter(l => l.annotations.some(a => a.box)).map(layer => (
          <div key={layer.key ?? layer.id} className="ann-layer-group">
            <div className="ann-list-header">
              <span className="ann-layer-header-label">
                <span className="layer-dot" style={{ background: layer.color }} />
                {layer.title}
                {layer.visible === false && <span className="image-panel-hidden"> (hidden)</span>}
              </span>
              <span className="ann-count">{layer.annotations.length}</span>
            </div>
            <div className="ann-rows">
              {layer.annotations.filter(a => a.box).map(ann => (
                <BoxRow
                  key={ann.key ?? ann.id}
                  ann={ann}
                  layer={layer}
                  layers={layers}
                  selected={(ann.key ?? ann.id) === selectedKey}
                  canEdit={canEditAnnotation(ann)}
                  onSelect={() => onSelectBox((ann.key ?? ann.id))}
                  onUpdate={onUpdateAnnotation}
                  onDelete={onDeleteAnnotation}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function BoxRow({ ann, layer, layers, selected, canEdit, onSelect, onUpdate, onDelete }) {
  const ref = useRef(null);
  useEffect(() => { if (selected) ref.current?.scrollIntoView({ block: 'nearest' }); }, [selected]);
  const b = ann.box;
  const stop = (e) => e.stopPropagation();
  return (
    <div
      ref={ref}
      className={`ann-row image-box-row ${selected ? 'image-box-row--selected' : ''}`}
      style={{ borderLeft: `3px solid ${layer.color}` }}
      onClick={onSelect}
      title={ann.creatorName ? `by ${ann.creatorName}` : undefined}
    >
      {canEdit ? (
        <select
          className="image-box-row-label"
          value={layer.id}
          onClick={stop}
          onChange={e => {
            const next = layers.find(l => l.id === e.target.value);
            if (next) onUpdate(layer.id, ann.id, { labelId: next.id, name: next.title });
          }}
          aria-label="Label"
        >
          {layers.map(l => <option key={l.key ?? l.id} value={l.id}>{l.title}</option>)}
        </select>
      ) : (
        <span className="ann-name">{layer.title}</span>
      )}
      <span className="ann-time" title="Top-left corner (x, y) and size, in image pixels">
        {Math.round(b.xmin)},{Math.round(b.ymin)} · {Math.round(b.xmax - b.xmin)}×{Math.round(b.ymax - b.ymin)}
      </span>
      <label className="image-box-row-difficult" onClick={stop} title="Pascal VOC 'difficult': hard to recognize; many detectors skip these in training/evaluation">
        <input
          type="checkbox"
          checked={!!ann.difficult}
          disabled={!canEdit}
          onChange={e => onUpdate(layer.id, ann.id, { difficult: e.target.checked })}
        />
        difficult
      </label>
      {canEdit && (
        <button className="btn btn-icon btn-icon--danger" onClick={e => { stop(e); onDelete(layer.id, ann.id); }} title="Delete box (Del)">✕</button>
      )}
    </div>
  );
}
