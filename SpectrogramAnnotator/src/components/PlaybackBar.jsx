import React, { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import './PlaybackBar.css';

const SKIP_SECONDS = 5;
const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

// h:mm:ss (or m:ss for files under an hour), optionally with tenths.
function fmtTime(sec, showHours, tenths) {
  const s = Math.max(0, sec);
  const totalTenths = Math.floor(s * 10 + 1e-6);
  const h = Math.floor(totalTenths / 36000);
  const m = Math.floor((totalTenths % 36000) / 600);
  const ss = Math.floor((totalTenths % 600) / 10);
  const t = totalTenths % 10;
  const base = showHours
    ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${m}:${String(ss).padStart(2, '0')}`;
  return tenths ? `${base}.${t}` : base;
}

// Parse a typed position: plain seconds ("3304.9") or colon-separated
// HH:MM:SS.S / MM:SS.S ("0:55:04.9", "55:04.9"). Returns seconds, or null
// if it isn't a valid time.
export function parseTimeInput(text) {
  const str = String(text).trim();
  if (!str) return null;
  const parts = str.split(':');
  if (parts.length > 3) return null;
  if (!parts.every(x => /^\d+(\.\d*)?$|^\.\d+$/.test(x))) return null;
  // Only the last field may have a fraction; minutes/seconds after a colon
  // must be under 60.
  if (parts.slice(0, -1).some(x => x.includes('.'))) return null;
  const nums = parts.map(Number);
  if (nums.slice(1).some(n => n >= 60)) return null;
  return nums.reduce((acc, n) => acc * 60 + n, 0);
}

const Icon = {
  play: <path d="M8 5.5v13l11-6.5z" />,
  pause: <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />,
  back: <path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z" />,
  fwd: <path d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z" />,
  volume: <path d="M4 9v6h4l5 4V5L8 9zm11.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM13 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z" />,
  muted: <path d="M4 9v6h4l5 4V5L8 9zm12.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4z" />,
};

function SvgIcon({ name }) {
  return <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">{Icon[name]}</svg>;
}

/**
 * Standard media-player style transport for the whole file:
 * skip back / play-pause / skip forward, current time, a full-file scrubber
 * (played portion, downloaded audio, hover time, click/drag to seek), total
 * time, volume, and playback speed.
 */
export default function PlaybackBar({ playback, duration, chunkDuration, onSeek }) {
  const position = useSyncExternalStore(playback.positionStore.subscribe, playback.positionStore.get);
  const trackRef = useRef(null);
  const [dragTime, setDragTime] = useState(null);
  const [hover, setHover] = useState(null); // { time, x }
  // Typed-position editing (double-click the current time): the text, or
  // null when not editing.
  const [editText, setEditText] = useState(null);
  const [editError, setEditError] = useState(false);
  const showHours = duration >= 3600;

  const timeAt = useCallback((clientX) => {
    const rect = trackRef.current.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return { time: frac * duration, x: frac * rect.width };
  }, [duration]);

  // Drag previews the position; the seek (and any audio download) happens
  // once, on release. Pointer capture keeps the drag going outside the bar.
  const draggingRef = useRef(false);
  const handlePointerDown = (e) => {
    if (e.button !== 0 || !duration) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    setDragTime(timeAt(e.clientX).time);
  };
  const handlePointerMove = (e) => {
    const h = timeAt(e.clientX);
    setHover(h);
    if (draggingRef.current) setDragTime(h.time);
  };
  const handlePointerUp = (e) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    onSeek(timeAt(e.clientX).time);
    setDragTime(null);
  };

  const startEdit = () => {
    if (!duration) return;
    setEditText(fmtTime(position, showHours, true));
    setEditError(false);
  };
  const commitEdit = () => {
    const t = parseTimeInput(editText);
    if (t == null || t > duration) { setEditError(true); return; }
    setEditText(null);
    onSeek(t);
  };
  const handleEditKey = (e) => {
    e.stopPropagation(); // keep Space / arrows / A out of the global shortcuts
    if (e.key === 'Enter') commitEdit();
    else if (e.key === 'Escape') setEditText(null);
  };

  const shown = dragTime ?? position;
  const pct = duration > 0 ? (shown / duration) * 100 : 0;
  const volumeShown = playback.muted ? 0 : playback.volume;

  return (
    <div className="playback-bar">
      <div className="pb-buttons">
        <button className="pb-btn" onClick={() => onSeek(playback.getPosition() - SKIP_SECONDS)}
          title={`Back ${SKIP_SECONDS}s (←)`} aria-label={`Back ${SKIP_SECONDS} seconds`}>
          <SvgIcon name="back" />
        </button>
        <button className="pb-btn pb-btn--play" onClick={playback.toggle}
          title={playback.isPlaying ? 'Pause (Space)' : 'Play (Space)'}
          aria-label={playback.isPlaying ? 'Pause' : 'Play'}>
          {playback.isLoading ? <span className="pb-spinner" /> : <SvgIcon name={playback.isPlaying ? 'pause' : 'play'} />}
        </button>
        <button className="pb-btn" onClick={() => onSeek(playback.getPosition() + SKIP_SECONDS)}
          title={`Forward ${SKIP_SECONDS}s (→)`} aria-label={`Forward ${SKIP_SECONDS} seconds`}>
          <SvgIcon name="fwd" />
        </button>
      </div>

      {editText != null ? (
        <input
          className={`pb-time pb-time-input ${editError ? 'pb-time-input--error' : ''}`}
          value={editText}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => { setEditText(e.target.value); setEditError(false); }}
          onKeyDown={handleEditKey}
          onBlur={() => setEditText(null)}
          aria-label="Go to time"
          title={editError
            ? `Not a valid time in this file (0 to ${fmtTime(duration, showHours, false)})`
            : 'Type a time (H:MM:SS.S, M:SS.S or seconds) and press Enter; Esc cancels'}
          spellCheck={false}
        />
      ) : (
        <span
          className="pb-time pb-time--editable"
          title="Current position — double-click to type a time"
          tabIndex={0}
          role="button"
          aria-label={`Current position ${fmtTime(shown, showHours, true)}. Press Enter to type a time.`}
          onDoubleClick={startEdit}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); startEdit(); } }}
        >
          {fmtTime(shown, showHours, true)}
        </span>
      )}

      <div
        ref={trackRef}
        className={`pb-track ${dragTime != null ? 'pb-track--dragging' : ''}`}
        role="slider"
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(shown)}
        aria-valuetext={fmtTime(shown, showHours, false)}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={() => { if (!draggingRef.current) setHover(null); }}
      >
        <div className="pb-rail">
          {duration > 0 && [...playback.loadedChunks].map(i => (
            <div key={i} className="pb-buffered" style={{
              left: `${(i * chunkDuration / duration) * 100}%`,
              width: `${(Math.min(chunkDuration, duration - i * chunkDuration) / duration) * 100}%`,
            }} />
          ))}
          <div className="pb-played" style={{ width: `${pct}%` }} />
        </div>
        <div className="pb-thumb" style={{ left: `${pct}%` }} />
        {hover && (
          <div className="pb-hover-time" style={{ left: hover.x }}>{fmtTime(hover.time, showHours, true)}</div>
        )}
      </div>

      <span className="pb-time pb-time--total" title="Duration">{fmtTime(duration, showHours, false)}</span>

      <div className="pb-volume">
        <button className="pb-btn" onClick={() => playback.setMuted(!playback.muted)}
          title={playback.muted ? 'Unmute' : 'Mute'} aria-label={playback.muted ? 'Unmute' : 'Mute'}>
          <SvgIcon name={volumeShown === 0 ? 'muted' : 'volume'} />
        </button>
        <input
          type="range" min={0} max={1} step={0.01}
          value={volumeShown}
          onChange={(e) => playback.setVolume(+e.target.value)}
          aria-label="Volume"
          style={{ '--pb-fill': `${volumeShown * 100}%` }}
        />
      </div>

      <select
        className="pb-rate"
        value={playback.rate}
        onChange={(e) => playback.setRate(+e.target.value)}
        title="Playback speed"
        aria-label="Playback speed"
      >
        {RATES.map(r => <option key={r} value={r}>{r}×</option>)}
      </select>

      {playback.error && <span className="pb-error">{playback.error}</span>}
    </div>
  );
}
