import React, { useState } from 'react';
import { apiJson } from '../api';
import '../components/ExportModal.css';
import '../pages/pages.css';

const MIN_PASSWORD = 8;

// Change your own password (or add one, for an account that only used Google).
export default function ChangePasswordModal({ hasPassword = true, onClose }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (next.length < MIN_PASSWORD) return setError(`Use at least ${MIN_PASSWORD} characters.`);
    if (next !== confirm) return setError("The new passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      await apiJson('/auth/password/change', {
        method: 'POST', json: { current_password: hasPassword ? current : null, new_password: next },
      });
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal change-password-modal" onClick={e => e.stopPropagation()} role="dialog" aria-label="Change password">
        <div className="modal-header">
          <span className="modal-title">{hasPassword ? 'Change password' : 'Set a password'}</span>
          <button className="btn btn-icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">
          {done ? (
            <>
              <p className="change-password-done">Your password has been changed.</p>
              <div className="modal-actions">
                <button className="btn btn-solid btn-sm" onClick={onClose}>Done</button>
              </div>
            </>
          ) : (
            <form className="login-password" onSubmit={submit}>
              {hasPassword && (
                <label className="form-field">
                  <span>Current password</span>
                  <input type="password" required autoComplete="current-password" autoFocus
                    value={current} onChange={e => setCurrent(e.target.value)} />
                </label>
              )}
              <label className="form-field">
                <span>New password <em>(at least {MIN_PASSWORD} characters)</em></span>
                <input type="password" required autoComplete="new-password" autoFocus={!hasPassword}
                  value={next} onChange={e => setNext(e.target.value)} />
              </label>
              <label className="form-field">
                <span>Repeat the new password</span>
                <input type="password" required autoComplete="new-password"
                  value={confirm} onChange={e => setConfirm(e.target.value)} />
              </label>
              {error && <div className="form-error" role="alert">{error}</div>}
              <div className="modal-actions">
                <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
                <button type="submit" className="btn btn-solid btn-sm" disabled={busy}>
                  {busy ? 'Saving…' : 'Save password'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
