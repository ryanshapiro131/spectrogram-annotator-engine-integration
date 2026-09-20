import React, { useState } from 'react';
import './ExportModal.css';

export default function ExportModal({ layers, audioFileName, onClose }) {
  const [tab, setTab] = useState('export');
  const [copied, setCopied] = useState(false);

  const exportData = {
    version: '1.0',
    audioFile: audioFileName,
    exportedAt: new Date().toISOString(),
    layers: layers.map(l => ({
      id: l.id,
      title: l.title,
      color: l.color,
      height: l.height,
      // Each annotation is denormalized with its label's own name/title —
      // annotations no longer carry separate free-text labels themselves
      // (the label they live under IS their label now), but downstream
      // consumers (e.g. SpectrogramPlayer, the NDSU pipeline) still expect
      // a `label` on every annotation, so keep that field populated.
      annotations: l.annotations.map(a => ({ start: a.start, end: a.end, label: l.title }))
    }))
  };

  const playerFormat = layers
    .filter(l => l.annotations.length > 0)
    .map(layer => ({
      data: layer.annotations.slice().sort((a, b) => a.start - b.start).map(a => [a.start, a.end, layer.title]),
      title: layer.title + ':',
      height: layer.height,
      strokeWidth: 1,
    }));

  const json = JSON.stringify(exportData, null, 2);
  const playerJson = JSON.stringify(playerFormat, null, 2);
  const totalAnns = layers.reduce((s, l) => s + l.annotations.length, 0);

  const copy = (text) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const download = (text, filename) => {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Export Annotations</span>
          <button className="btn btn-icon" onClick={onClose}>✕</button>
        </div>

        <div className="modal-tabs">
          <button className={`modal-tab ${tab === 'export' ? 'active' : ''}`} onClick={() => setTab('export')}>Full project</button>
          <button className={`modal-tab ${tab === 'player' ? 'active' : ''}`} onClick={() => setTab('player')}>Player format</button>
        </div>

        <div className="modal-body">
          {tab === 'export' && (
            <>
              <div className="export-meta">
                <span>{layers.length} layer{layers.length !== 1 ? 's' : ''}</span>
                <span className="export-meta-sep">·</span>
                <span>{totalAnns} annotation{totalAnns !== 1 ? 's' : ''}</span>
                <span className="export-meta-sep">·</span>
                <span>{audioFileName}</span>
              </div>
              <pre className="json-preview">{json}</pre>
              <div className="modal-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => copy(json)}>
                  {copied ? '✓ Copied' : 'Copy JSON'}
                </button>
                <button className="btn btn-primary btn-sm" onClick={() => download(json, `annotations-${Date.now()}.json`)}>
                  Download JSON
                </button>
              </div>
            </>
          )}
          {tab === 'player' && (
            <>
              <div className="export-meta">
                Ready-to-use format for the <code>annotations</code> prop of <code>SpectrogramPlayer</code>
              </div>
              <pre className="json-preview">{playerJson}</pre>
              <div className="modal-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => copy(playerJson)}>
                  {copied ? '✓ Copied' : 'Copy JSON'}
                </button>
                <button className="btn btn-primary btn-sm" onClick={() => download(playerJson, `player-annotations-${Date.now()}.json`)}>
                  Download JSON
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}