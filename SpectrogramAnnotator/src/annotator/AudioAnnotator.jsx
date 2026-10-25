import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useAudioPlayback } from '../hooks/useAudioPlayback';
import { useTileViewer } from '../hooks/useTileViewer';
import AnnotationPanel from '../components/AnnotationPanel';
import WaveformNav from '../components/WaveformNav';
import ChunkTimeline from '../components/ChunkTimeline';
import SpectrogramOverlay from '../components/SpectrogramOverlay';
import TileSpectrogramViewer from '../components/TileSpectrogramViewer';
import ExportModal from '../components/ExportModal';
import PlaybackBar from '../components/PlaybackBar';
import SaveIndicator from './SaveIndicator';
import '../App.css';

/*
 * The audio annotator: waveform navigation, tiled spectrogram with time and
 * frequency rulers, playback bar, annotation overlay + panel.
 *
 * Where the audio and the annotations come from is up to the page using it:
 *   chunker  useAudioChunker() — the page loads a local file into it
 *            (standalone /audio) or opens a project file by id
 *   store    an annotation store (useLocalAnnotations: in memory, or
 *            useProjectAnnotations: loaded from / autosaved to the server)
 *
 * Slots: headerLeft (title/breadcrumbs), headerExtra (extra header
 * buttons), onClose + closeLabel, renderIdle() for the no-file screen and
 * renderMissing() for a project file the server no longer has cached.
 */
export default function AudioAnnotator({
  chunker, store,
  headerLeft, headerExtra,
  onClose, closeLabel = 'Close file',
  renderIdle, renderMissing,
}) {
  const [spectrogramSettings, setSpectrogramSettings] = useState({
    specHeight: 300,
    navHeight:  60,
    // n_fft / hop_length / n_mels / top_db / colormap used to be live client
    // controls. The spectrogram is now generated once by spectrogram-engine
    // (see annotation_server/server.py), so those are now generation-time
    // settings baked into the tile pyramid, not runtime ones — see the
    // engine's --db-min/--db-max/--freq-scale CLI flags if you want to make
    // them configurable again.
    // Frequency crop/zoom is automatic (opens fit to the engine's detected
    // signal content) plus the TileSpectrogramViewer's own right-side
    // sidebar for manual vertical zoom/pan.
  });

  const tiles         = useTileViewer(chunker.fileId);
  const tileViewerRef = useRef(null);
  // Audio is fetched on demand (on play) in compressed chunks; the playhead
  // on the spectrogram follows playback every frame via onFrame.
  const playback      = useAudioPlayback({
    fileId:        chunker.fileId,
    totalChunks:   chunker.totalChunks,
    chunkDuration: chunker.CHUNK_DURATION,
    fileDuration:  chunker.fileDuration,
    onFrame:       (t) => tileViewerRef.current?.setPlayheadTime(t),
  });
  // Bumped by TileSpectrogramViewer's onVisibleWindowChange whenever the
  // spectrogram is panned/zoomed. SpectrogramOverlay computes annotation box
  // positions from tileViewerRef.getVisibleWindow() at render time, but
  // nothing else makes it re-render when that window changes — without this
  // tick the boxes would stay frozen at whatever window was visible on the
  // overlay's last unrelated render, instead of tracking their timestamps.
  const [viewTick, setViewTick]   = useState(0);
  // Bumped by TileSpectrogramViewer whenever tiles at its current zoom level
  // start or finish loading, so WaveformNav can recolor to match.
  const [coverageTick, setCoverageTick] = useState(0);

  const [showExport, setShowExport]     = useState(false);
  // Whether double-click annotation drawing is active on the spectrogram, or
  // clicks/zoom pass straight through to normal spectrogram navigation.
  const [annotateMode, setAnnotateMode] = useState(true);
  // Debug toggle: 'waveform' (default) or 'chunks' — lets you compare the
  // full-file waveform nav against the old per-chunk cell list.
  const [navMode, setNavMode]           = useState('waveform');

  const canAnnotate = store.canCreate;

  // Seek to an absolute time anywhere in the file: moves the playback
  // position (no audio download unless playing) and pans the spectrogram so
  // that time is centered.
  const handleSeek = useCallback((time) => {
    playback.seek(time);
    tileViewerRef.current?.seekTo(time);
  }, [playback]);

  // Keybinds, unless the user is typing somewhere (label popup, layer name
  // field, manual add-annotation form, etc.):
  //   A      toggle annotate mode
  //   Space  play / pause (left to the browser when a button has focus, so
  //          it doesn't press that button as well)
  //   ← / →  skip 5 seconds
  useEffect(() => {
    const handler = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
      if (e.key.toLowerCase() === 'a') {
        if (!canAnnotate) return;
        e.preventDefault();
        setAnnotateMode(m => !m);
      } else if (e.key === ' ' && tag !== 'BUTTON' && chunker.status === 'ready') {
        e.preventDefault();
        playback.toggle();
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && chunker.status === 'ready') {
        e.preventDefault();
        handleSeek(playback.getPosition() + (e.key === 'ArrowLeft' ? -5 : 5));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [playback, handleSeek, chunker.status, canAnnotate]);

  const isReady   = chunker.status === 'ready';
  const isLoading = ['hashing', 'uploading', 'decoding'].includes(chunker.status);
  const getVisibleWindow = () => tileViewerRef.current?.getVisibleWindow() || { start: 0, end: chunker.fileDuration };

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          {headerLeft ?? (
            <>
              <span className="media-type-badge">Audio</span>
              {chunker.fileName && <span className="file-badge">{chunker.fileName}</span>}
            </>
          )}
          {isReady && <span className="file-meta">{formatDuration(chunker.fileDuration)}</span>}
        </div>
        <div className="header-right">
          {store.saveState && <SaveIndicator state={store.saveState} />}
          {isReady && !canAnnotate && !store.loading && <span className="readonly-badge" title="Your role in this project can view but not annotate">View only</span>}
          {headerExtra}
          {isReady && (
            <>
              <button
                className="btn btn-ghost btn-sm"
                title="Debug: switch between waveform and chunk-list navigation"
                onClick={() => setNavMode(m => (m === 'waveform' ? 'chunks' : 'waveform'))}
              >
                Nav: {navMode === 'waveform' ? 'Waveform' : 'Chunks'}
              </button>
              <div className="header-divider" />
              <button className="btn btn-ghost btn-sm" onClick={() => setShowExport(true)}>Export JSON</button>
            </>
          )}
          {onClose && (isReady || chunker.status === 'missing' || chunker.status === 'error') && (
            <>
              <div className="header-divider" />
              <button className="btn btn-ghost btn-sm" onClick={onClose}>{closeLabel}</button>
            </>
          )}
        </div>
      </header>

      <main className="app-main">
        {chunker.status === 'idle' && renderIdle?.()}
        {chunker.status === 'opening' && (
          <div className="decoding-screen"><div className="decoding-content">
            <div className="decoding-filename">{chunker.fileName}</div>
            <div className="decoding-label">Opening…</div>
          </div></div>
        )}
        {chunker.status === 'missing' && renderMissing?.()}
        {isLoading && (
          <DecodingScreen
            transfer={chunker.transfer}
            fileName={chunker.fileName}
            status={chunker.status}
          />
        )}
        {chunker.status === 'error' && (
          <div className="error-screen">
            <p>Failed to load audio file.</p>
            <code style={{ fontSize: 12, opacity: 0.7 }}>{chunker.error || 'Unknown error'}</code>
            <button className="btn btn-ghost btn-sm" style={{ marginTop: 12 }}
              onClick={() => window.location.reload()}>Reload</button>
          </div>
        )}
        {store.loadError && (
          <div className="annotator-load-error">Couldn't load this file's annotations: {store.loadError}</div>
        )}

        {isReady && (
          <div className="workspace">
            <section className="spectrogram-section">
              <div className="section-header">
                <div className="section-header-left">
                  <span className="section-label">Spectrogram</span>
                  {canAnnotate && (
                    <button
                      className={`btn btn-sm annotate-toggle ${annotateMode ? 'annotate-toggle--on' : ''}`}
                      onClick={() => setAnnotateMode(m => !m)}
                      title="Toggle annotation drawing mode (keybind: A)"
                    >
                      <span className="annotate-toggle-dot" />
                      {annotateMode ? 'Annotating' : 'Navigating'}
                      <span className="annotate-toggle-key">A</span>
                    </button>
                  )}
                </div>
                <div className="settings-row">
                  <label>Window Size
                    <input type="range" min={120} max={400} step={20}
                      value={spectrogramSettings.specHeight}
                      onChange={e => setSpectrogramSettings(s => ({ ...s, specHeight: +e.target.value }))} />
                    <span>{spectrogramSettings.specHeight}px</span>
                  </label>
                </div>
              </div>

              {navMode === 'waveform' ? (
                <WaveformNav
                  overview={chunker.overview}
                  overviewStatus={chunker.overviewStatus}
                  fileDuration={chunker.fileDuration}
                  onSeek={handleSeek}
                  getVisibleWindow={getVisibleWindow}
                  getTileCoverage={() => tileViewerRef.current?.getTileCoverage() || null}
                  viewTick={viewTick}
                  coverageTick={coverageTick}
                />
              ) : (
                <ChunkTimeline
                  totalChunks={chunker.totalChunks}
                  currentChunk={playback.currentChunk}
                  chunkUrls={Object.fromEntries([...playback.loadedChunks].map(i => [i, true]))}
                  fileDuration={chunker.fileDuration}
                  chunkDuration={chunker.CHUNK_DURATION}
                  onSelectChunk={(i) => handleSeek(i * chunker.CHUNK_DURATION)}
                />
              )}

              <div className="tile-viewer-wrapper">
                {tiles.status !== 'ready' && (
                  <div className="tile-viewer-status-banner">
                    {tiles.status === 'error'
                      ? `Spectrogram generation failed: ${tiles.error || 'unknown error'}`
                      : `Generating spectrogram (spectrogram-engine, one-time per file)…`}
                  </div>
                )}
                {tiles.status === 'ready' && (
                  <div className="tile-viewer-stack">
                    <TileSpectrogramViewer
                      ref={tileViewerRef}
                      manifestUrl={tiles.manifestUrl}
                      tileBaseUrl={tiles.tileBaseUrl}
                      height={spectrogramSettings.specHeight}
                      onSeek={handleSeek}
                      onVisibleWindowChange={() => setViewTick(t => t + 1)}
                      onTileCoverageChange={() => setCoverageTick(t => t + 1)}
                    />
                    <SpectrogramOverlay
                      duration={chunker.fileDuration}
                      specHeight={spectrogramSettings.specHeight}
                      labels={store.layers}
                      activeLabelId={store.activeLayerId}
                      onAddAnnotation={store.addAnnotation}
                      onResolveOrCreateLabel={store.resolveOrCreateLabel}
                      enabled={annotateMode && canAnnotate}
                      getVisibleWindow={getVisibleWindow}
                      viewTick={viewTick}
                    />
                  </div>
                )}

                <PlaybackBar
                  playback={playback}
                  duration={chunker.fileDuration}
                  chunkDuration={chunker.CHUNK_DURATION}
                  onSeek={handleSeek}
                />
              </div>
            </section>

            <AnnotationPanel
              layers={store.layers}
              activeLayerId={store.activeLayerId}
              onSelectLayer={store.setActiveLayerId}
              onAddLayer={store.addLayer}
              onRemoveLayer={store.removeLayer}
              onUpdateLayer={store.updateLayer}
              onToggleVisible={store.toggleLayerVisible}
              onUpdateAnnotation={store.updateAnnotation}
              onDeleteAnnotation={store.deleteAnnotation}
              onSeek={handleSeek}
              canCreate={canAnnotate}
              canEditLayer={store.canEditLayer}
              canEditAnnotation={store.canEditAnnotation}
            />
          </div>
        )}
      </main>

      {showExport && (
        <ExportModal
          layers={store.layers}
          audioFileName={chunker.fileName}
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  );
}

export function formatDuration(sec) {
  if (sec == null || isNaN(sec)) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function fmtBytes(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}

function fmtEta(sec) {
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s left`;
  if (sec < 3600) return `about ${Math.round(sec / 60)} min left`;
  return `about ${(sec / 3600).toFixed(1)} h left`;
}

// One label/detail/hint for each phase of getting a file onto the server:
// checking (local hash) -> uploading (real bytes, speed, time left) ->
// processing on the server (indeterminate). Shared with the project page.
export function describeTransfer(status, transfer) {
  const t = transfer || { fraction: 0 };
  const pct = Math.round((t.fraction || 0) * 100);
  if (status === 'hashing') {
    return {
      pct, label: 'Checking file…', detail: `${pct}%`,
      hint: 'Checking whether the server already has this recording, so it can skip the upload.',
    };
  }
  if (status === 'uploading') {
    return {
      pct, label: `Uploading… ${pct}%`,
      detail: [
        t.total ? `${fmtBytes(t.loaded || 0)} of ${fmtBytes(t.total)}` : null,
        t.bytesPerSec ? `${fmtBytes(t.bytesPerSec)}/s` : null,
        t.etaSec != null ? fmtEta(t.etaSec) : null,
      ].filter(Boolean).join(' · '),
      hint: 'Only needed the first time: the server remembers this recording, so opening it again skips the upload.',
    };
  }
  return {
    pct, label: 'Processing on the server…', detail: null, indeterminate: true,
    hint: 'Decoding the audio and preparing the spectrogram. Long recordings can take a minute or two.',
  };
}

function DecodingScreen({ transfer, fileName, status }) {
  const { pct, label, detail, hint, indeterminate } = describeTransfer(status, transfer);
  return (
    <div className="decoding-screen">
      <div className="decoding-content">
        <div className="decoding-filename">{fileName}</div>
        <div className="decoding-label">{label}</div>
        <div className={`decoding-bar-track ${indeterminate ? 'decoding-bar-track--indeterminate' : ''}`}>
          <div className="decoding-bar-fill" style={indeterminate ? undefined : { width: `${pct}%` }} />
        </div>
        {detail && <div className="decoding-detail">{detail}</div>}
        <div className="decoding-hint">{hint}</div>
      </div>
    </div>
  );
}

// The drop zone / file picker shown before a file is loaded.
export function AudioDropZone({ onFile, title = 'Audio Annotation', subtitle, multiple = false }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div className="welcome-screen">
      <div className="welcome-content">
        <div className="welcome-icon">♪</div>
        <h1 className="welcome-title">{title}</h1>
        {subtitle && <p className="welcome-subtitle">{subtitle}</p>}
        <label
          className={`file-drop-zone ${dragging ? 'file-drop-zone--dragging' : ''}`}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => {
            e.preventDefault();
            setDragging(false);
            const files = [...e.dataTransfer.files];
            if (files.length) onFile(multiple ? files : files[0]);
          }}
        >
          <span className="file-drop-icon">⊕</span>
          <span className="file-drop-text">Drop audio file here</span>
          <span className="file-drop-sub">or click to browse</span>
          <input
            type="file" accept={AUDIO_ACCEPT} multiple={multiple} style={{ display: 'none' }}
            onChange={e => {
              const files = [...e.target.files];
              e.target.value = '';
              if (files.length) onFile(multiple ? files : files[0]);
            }}
          />
        </label>
        <div className="welcome-hint">
          <span className="tag">.wav</span>
          <span className="tag">.mp3</span>
          <span className="tag">.ogg</span>
          <span className="tag">.flac</span>
        </div>
      </div>
    </div>
  );
}

export const AUDIO_ACCEPT = '.wav,.mp3,.ogg,.flac,.aac,.m4a';
