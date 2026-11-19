import React, { useState } from 'react';
import './ExportModal.css';

/*
 * Export choices for the photo annotator. The page decides what's on offer
 * (a project exports from the server; /photo exports what's in memory):
 *   options  [{ id, title, detail, run: async () => void }]
 *   summary  text line above the choices
 */
export default function ImageExportModal({ options, summary, onClose }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const run = async (o) => {
    setBusy(o.id);
    setError(null);
    try {
      await o.run();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-label="Export annotations">
        <div className="modal-header">
          <span className="modal-title">Export annotations</span>
          <button className="btn btn-icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">
          {summary && <div className="export-meta">{summary}</div>}
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="image-export-options">
            {options.map(o => (
              <div key={o.id} className="image-export-option">
                <div>
                  <div className="image-export-title">{o.title}</div>
                  <div className="image-export-detail">{o.detail}</div>
                </div>
                <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => run(o)}>
                  {busy === o.id ? 'Preparing…' : 'Download'}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
