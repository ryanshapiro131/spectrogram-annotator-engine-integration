import React from 'react';

// Autosave status for project files: Saving… / Saved / Couldn't save.
export default function SaveIndicator({ state }) {
  if (!state || state.status === 'idle') return null;
  const text = {
    saving: 'Saving…',
    saved: 'Saved',
    error: "Couldn't save",
  }[state.status];
  return (
    <span
      className={`save-indicator save-indicator--${state.status}`}
      title={state.message || (state.status === 'saved' ? 'All changes saved' : undefined)}
      role="status"
      aria-live="polite"
    >
      <span className="save-indicator-dot" />
      {text}
      {state.status === 'error' && state.message && (
        <span className="save-indicator-message">{state.message}</span>
      )}
    </span>
  );
}
