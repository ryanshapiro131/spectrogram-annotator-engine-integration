import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useAudioChunker } from './hooks/useAudioChunker';
import { useMountQueue } from './hooks/useMountQueue';
import { useTileViewer } from './hooks/useTileViewer';
import AnnotationPanel from './components/AnnotationPanel';
import WaveformNav from './components/WaveformNav';
import ChunkTimeline from './components/ChunkTimeline';
import SpectrogramOverlay from './components/SpectrogramOverlay';
import TileSpectrogramViewer from './components/TileSpectrogramViewer';
import ExportModal from './components/ExportModal';
import './App.css';

function App() {
  const [spectrogramSettings, setSpectrogramSettings] = useState({
    specHeight: 300,
    navHeight:  60,
    // n_fft / hop_length / n_mels / top_db / colormap used to be live client
    // controls. The spectrogram is now generated once by spectrogram-engine
    // (see annotation_server/server.py), so those are now generation-time
    // settings baked into the tile pyramid, not runtime ones — see the
    // engine's --db-min/--db-max/--freq-scale CLI flags if you want to make
    // them configurable again.
    // Frequency crop/zoom used to be a manual "Scale" slider here; it's now
    // automatic (opens fit to the engine's detected signal content) plus the
    // TileSpectrogramViewer's own right-side sidebar for manual vertical
    // zoom/pan, so there's nothing to store in settings for it anymore.
  });

  const chunker      = useAudioChunker(spectrogramSettings);
  const mountedChunks = useMountQueue(chunker.currentChunk, chunker.sxxStatus || {});
  const tiles         = useTileViewer(chunker.fileId);
  const tileViewerRef  = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  // Bumped by TileSpectrogramViewer's onVisibleWindowChange whenever the
  // spectrogram is panned/zoomed. SpectrogramOverlay computes annotation box
  // positions from tileViewerRef.getVisibleWindow() at render time, but
  // nothing else makes it re-render when that window changes — without this
  // tick the boxes would stay frozen at whatever window was visible on the
  // overlay's last unrelated render, instead of tracking their timestamps.
  const [viewTick, setViewTick]   = useState(0);

  // Each entry here IS a "label" (the user's mental model: a named,
  // colored annotation type like "chirp" or "engine noise") — despite the
  // `layer`-flavored names left over from when this only had generic
  // "Layer 1/2" tabs. `visible` controls whether this label's colored boxes
  // are drawn on the spectrogram (see SpectrogramOverlay); annotations no
  // longer carry their own free-text label — the layer/label they live in
  // *is* their label now, picked via SpectrogramOverlay's label picker
  // instead of typed per-annotation.
  const [annotationLayers, setAnnotationLayers] = useState([
    { id: 'layer-1', title: 'Layer 1', color: '#1a6b8a', annotations: [], height: 32, visible: true },
  ]);
  const [activeLayerId, setActiveLayerId] = useState('layer-1');
  const [showExport, setShowExport]       = useState(false);
  // Whether double-click annotation drawing is active on the spectrogram, or
  // clicks/zoom pass straight through to normal spectrogram navigation.
  const [annotateMode, setAnnotateMode]   = useState(true);
  // Debug toggle: 'waveform' (default) or 'chunks' — lets you compare the
  // full-file waveform nav against the old per-chunk cell list.
  const [navMode, setNavMode]             = useState('waveform');
  const layerIdCounter                    = useRef(2);
  const playerContainerRefs              = useRef({});
  // Absolute time (seconds) to seek to once the target chunk's <audio> mounts.
  // Set by handleSeek when the click lands in a different chunk than the
  // one currently active; cleared once applied.
  const pendingSeekRef                    = useRef(null);

  // Annotation CRUD. `labelId` lets the caller (SpectrogramOverlay's label
  // picker) target ANY existing label, not just whichever tab is active —
  // that's what lets a new annotation reuse a past label's color.
  const addAnnotation = useCallback((labelId, annotation) => {
    setAnnotationLayers(prev => prev.map(layer =>
      layer.id === labelId
        // Name defaults to the label's own title, but the caller may
        // override it (e.g. a future bulk-import path) since it spreads
        // after the default.
        ? { ...layer, annotations: [...layer.annotations, { name: layer.title, ...annotation, id: `ann-${Date.now()}` }] }
        : layer
    ));
  }, []);

  // Resolves a typed label name to an existing label's id (case-insensitive
  // match) or creates a new one, returning its id either way. Used by
  // SpectrogramOverlay's label picker so picking/typing a name is all one
  // step regardless of whether that label already exists.
  const resolveOrCreateLabel = useCallback((name) => {
    const trimmed = name.trim();
    const existing = annotationLayers.find(l => l.title.toLowerCase() === trimmed.toLowerCase());
    if (existing) return existing.id;
    const id = `layer-${layerIdCounter.current++}`;
    const colors = ['#1a6b8a', '#2d7a4f', '#7a4f2d', '#4f2d7a', '#7a2d4f'];
    const color = colors[annotationLayers.length % colors.length];
    setAnnotationLayers(prev => [
      ...prev,
      { id, title: trimmed, color, annotations: [], height: 32, visible: true }
    ]);
    return id;
  }, [annotationLayers]);

  const toggleLayerVisible = useCallback((layerId) => {
    setAnnotationLayers(prev => prev.map(l => l.id === layerId ? { ...l, visible: l.visible === false ? true : false } : l));
  }, []);

  const updateAnnotation = useCallback((layerId, annId, changes) => {
    setAnnotationLayers(prev => prev.map(layer =>
      layer.id === layerId
        ? { ...layer, annotations: layer.annotations.map(a => a.id === annId ? { ...a, ...changes } : a) }
        : layer
    ));
  }, []);

  const deleteAnnotation = useCallback((layerId, annId) => {
    setAnnotationLayers(prev => prev.map(layer =>
      layer.id === layerId
        ? { ...layer, annotations: layer.annotations.filter(a => a.id !== annId) }
        : layer
    ));
  }, []);

  const addLayer = useCallback(() => {
    const id     = `layer-${layerIdCounter.current++}`;
    const colors = ['#1a6b8a', '#2d7a4f', '#7a4f2d', '#4f2d7a', '#7a2d4f'];
    setAnnotationLayers(prev => [
      ...prev,
      { id, title: `Layer ${prev.length + 1}`, color: colors[prev.length % colors.length], annotations: [], height: 32, visible: true }
    ]);
    setActiveLayerId(id);
  }, []);

  const removeLayer = useCallback((layerId) => {
    setAnnotationLayers(prev => {
      const next = prev.filter(l => l.id !== layerId);
      return next.length === 0 ? prev : next;
    });
    setActiveLayerId(prev =>
      prev === layerId ? annotationLayers.find(l => l.id !== layerId)?.id : prev
    );
  }, [annotationLayers]);

  const updateLayer = useCallback((layerId, changes) => {
    setAnnotationLayers(prev => prev.map(l => l.id === layerId ? { ...l, ...changes } : l));
  }, []);

  const handleClear = useCallback(() => {
    setAnnotationLayers([{ id: 'layer-1', title: 'Layer 1', color: '#1a6b8a', annotations: [], height: 32, visible: true }]);
    setActiveLayerId('layer-1');
    layerIdCounter.current = 2;
  }, []);

  // Pause all mounted audio players, then switch chunk
  const handleSelectChunk = useCallback((index) => {
    Object.values(playerContainerRefs.current).forEach(ref => {
      const audio = ref?.current?.querySelector('audio');
      if (audio && !audio.paused) audio.pause();
    });
    chunker.goToChunk(index);
  }, [chunker]);

  // Seek to an absolute time anywhere in the file. If the target time falls
  // in the currently-mounted chunk, seek the <audio> element directly (no
  // reload). Otherwise switch chunks and stash the target time; the attach
  // effect below applies it once that chunk's <audio> element mounts.
  const handleSeek = useCallback((time) => {
    const chunkDur = chunker.CHUNK_DURATION;
    if (!chunkDur || !chunker.totalChunks) return;
    const targetChunk = Math.min(chunker.totalChunks - 1, Math.max(0, Math.floor(time / chunkDur)));

    if (targetChunk === chunker.currentChunk) {
      const ref   = playerContainerRefs.current[targetChunk];
      const audio = ref?.current?.querySelector('audio');
      if (audio) audio.currentTime = time - targetChunk * chunkDur;
    } else {
      pendingSeekRef.current = time;
      handleSelectChunk(targetChunk);
    }

    // The spectrogram (TileSpectrogramViewer) spans the whole file
    // independently of which audio chunk is loaded, so it needs its own
    // explicit nudge to pan to the clicked timestamp — switching chunks
    // above only affects audio playback.
    tileViewerRef.current?.seekTo(time);
  }, [chunker, handleSelectChunk]);

  // Attach timeupdate + ended listeners to the active chunk's <audio> element
  useEffect(() => {
    if (chunker.status !== 'ready') return;

    let rafId;
    let tries = 0;
    const MAX_TRIES = 60;

    function attach() {
      const ref   = playerContainerRefs.current[chunker.currentChunk];
      const audio = ref?.current?.querySelector('audio');

      if (!audio) {
        if (++tries < MAX_TRIES) rafId = requestAnimationFrame(attach);
        return;
      }

      // Apply a seek that was requested before this chunk finished mounting.
      // Metadata may not be loaded yet, in which case currentTime writes are
      // silently ignored — wait for loadedmetadata in that case.
      if (pendingSeekRef.current != null) {
        const cs    = chunker.currentChunk * chunker.CHUNK_DURATION;
        const local = pendingSeekRef.current - cs;
        pendingSeekRef.current = null;
        if (local >= 0 && local <= chunker.CHUNK_DURATION + 1) {
          if (audio.readyState >= 1) {
            audio.currentTime = local;
          } else {
            audio.addEventListener('loadedmetadata', () => { audio.currentTime = local; }, { once: true });
          }
        }
      }

      const handler = () => chunker.onAudioTimeUpdate(audio, 2);
      const playheadHandler = () => {
        const abs = audio.currentTime + chunker.currentChunk * chunker.CHUNK_DURATION;
        tileViewerRef.current?.setPlayheadTime(abs);
      };
      const playHandler  = () => setIsPlaying(true);
      const pauseHandler = () => setIsPlaying(false);

      audio.addEventListener('timeupdate', handler);
      audio.addEventListener('ended',      handler);
      audio.addEventListener('timeupdate', playheadHandler);
      audio.addEventListener('play',  playHandler);
      audio.addEventListener('pause', pauseHandler);
      playheadHandler(); // paint the playhead at its starting position immediately

      return () => {
        audio.removeEventListener('timeupdate', handler);
        audio.removeEventListener('ended',      handler);
        audio.removeEventListener('timeupdate', playheadHandler);
        audio.removeEventListener('play',  playHandler);
        audio.removeEventListener('pause', pauseHandler);
      };
    }

    let cleanup;
    rafId = requestAnimationFrame(() => { cleanup = attach(); });
    return () => { cancelAnimationFrame(rafId); cleanup?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunker.currentChunk, chunker.status, chunker.currentUrl]);

  const handlePlayPause = useCallback(() => {
    const ref   = playerContainerRefs.current[chunker.currentChunk];
    const audio = ref?.current?.querySelector('audio');
    if (!audio) return;
    if (audio.paused) audio.play(); else audio.pause();
  }, [chunker.currentChunk]);

  const handleFileChange = useCallback((e) => {
    const file = e.target.files[0];
    if (file) chunker.loadFile(file);
  }, [chunker]);

  const handleFileDrop = useCallback((e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) chunker.loadFile(file);
  }, [chunker]);

  // Keybind: "A" toggles annotate mode, unless the user is typing somewhere
  // (label popup, layer name field, manual add-annotation form, etc.).
  useEffect(() => {
    const handler = (e) => {
      if (e.key.toLowerCase() !== 'a') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
      e.preventDefault();
      setAnnotateMode(m => !m);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const isReady    = chunker.status === 'ready';
  const isLoading  = chunker.status === 'uploading' || chunker.status === 'decoding';

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <span className="media-type-badge">Audio</span>
          {chunker.fileName && <span className="file-badge">{chunker.fileName}</span>}
          {isReady && (
            <span className="file-meta">
              {chunker.totalChunks} chunk{chunker.totalChunks !== 1 ? 's' : ''}
              <span className="file-meta-sep">·</span>
              {formatDuration(chunker.fileDuration)}
            </span>
          )}
        </div>
        <div className="header-right">
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
              <div className="header-divider" />
              <button className="btn btn-ghost btn-sm" onClick={handleClear}>Close file</button>
            </>
          )}
          {chunker.status === 'idle' && (
            <label className="btn btn-ghost btn-sm file-input-label"
              onDragOver={e => e.preventDefault()} onDrop={handleFileDrop}
            >
              Load audio
              <input type="file" accept=".wav,.mp3,.ogg,.flac,.aac,.m4a" onChange={handleFileChange} style={{ display: 'none' }} />
            </label>
          )}
        </div>
      </header>

      <main className="app-main">
        {chunker.status === 'idle' && (
          <WelcomeScreen onFileChange={handleFileChange} onFileDrop={handleFileDrop} />
        )}
        {isLoading && (
          <DecodingScreen
            progress={chunker.progress}
            fileName={chunker.fileName}
            status={chunker.status}
          />
        )}
        {chunker.status === 'error' && (
          <div className="error-screen">
            <p>Failed to load audio file. Is the spectrogram server running?</p>
            <code style={{ fontSize: 12, opacity: 0.7 }}>uvicorn server:app --port 8000</code>
            <button className="btn btn-ghost btn-sm" style={{ marginTop: 12 }}
              onClick={() => window.location.reload()}>Reload</button>
          </div>
        )}

        {isReady && (
          <div className="workspace">
            <section className="spectrogram-section">
              <div className="section-header">
                <div className="section-header-left">
                  <span className="section-label">Spectrogram</span>
                  <button
                    className={`btn btn-sm annotate-toggle ${annotateMode ? 'annotate-toggle--on' : ''}`}
                    onClick={() => setAnnotateMode(m => !m)}
                    title="Toggle annotation drawing mode (keybind: A)"
                  >
                    <span className="annotate-toggle-dot" />
                    {annotateMode ? 'Annotating' : 'Navigating'}
                    <span className="annotate-toggle-key">A</span>
                  </button>
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
                  totalChunks={chunker.totalChunks}
                  currentChunk={chunker.currentChunk}
                  sxxStatus={chunker.sxxStatus}
                  fileDuration={chunker.fileDuration}
                  chunkDuration={chunker.CHUNK_DURATION}
                  onSeek={handleSeek}
                  getVisibleWindow={() => tileViewerRef.current?.getVisibleWindow() || { start: 0, end: chunker.fileDuration }}
                  viewTick={viewTick}
                />
              ) : (
                <ChunkTimeline
                  totalChunks={chunker.totalChunks}
                  currentChunk={chunker.currentChunk}
                  chunkUrls={chunker.chunkUrls}
                  sxxStatus={chunker.sxxStatus}
                  fileDuration={chunker.fileDuration}
                  chunkDuration={chunker.CHUNK_DURATION}
                  onSelectChunk={handleSelectChunk}
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
                    />
                    <SpectrogramOverlay
                      duration={chunker.fileDuration}
                      specHeight={spectrogramSettings.specHeight}
                      labels={annotationLayers}
                      activeLabelId={activeLayerId}
                      onAddAnnotation={addAnnotation}
                      onResolveOrCreateLabel={resolveOrCreateLabel}
                      enabled={annotateMode}
                      getVisibleWindow={() => tileViewerRef.current?.getVisibleWindow() || { start: 0, end: chunker.fileDuration }}
                      viewTick={viewTick}
                    />
                  </div>
                )}

                <div className="transport-bar">
                  <button
                    className="btn btn-ghost btn-sm transport-play-btn"
                    onClick={handlePlayPause}
                    title="Play/pause (operates on the currently loaded chunk's audio)"
                  >
                    {isPlaying ? '⏸' : '▶'}
                  </button>
                  <span className="transport-time">
                    {formatDuration(chunker.currentChunk * chunker.CHUNK_DURATION)} / {formatDuration(chunker.fileDuration)}
                  </span>
                </div>
              </div>

              <div className="player-wrapper player-wrapper--headless">
                {Object.entries(chunker.chunkUrls).map(([idxStr, url]) => {
                  const idx       = Number(idxStr);
                  const isActive  = idx === chunker.currentChunk;
                  const isMounted = mountedChunks ? mountedChunks.has(idx) : false;

                  if (!isActive && !isMounted) return null;

                  if (!playerContainerRefs.current[idx]) {
                    playerContainerRefs.current[idx] = React.createRef();
                  }

                  // Audio playback only — the visual spectrogram above is a
                  // single TileSpectrogramViewer spanning the whole file, not
                  // one instance per chunk, so this no longer needs to render
                  // a spectrogram (or the old per-chunk overlay) itself.
                  return (
                    <div
                      key={`chunk-audio-${idx}`}
                      ref={playerContainerRefs.current[idx]}
                      style={{ display: 'none' }}
                    >
                      <audio src={url} preload="metadata" />
                    </div>
                  );
                })}
                {!chunker.currentUrl && (
                  <div className="chunk-loading">Preparing chunk {chunker.currentChunk + 1}…</div>
                )}
              </div>
            </section>

            <AnnotationPanel
              layers={annotationLayers}
              activeLayerId={activeLayerId}
              onSelectLayer={setActiveLayerId}
              onAddLayer={addLayer}
              onRemoveLayer={removeLayer}
              onUpdateLayer={updateLayer}
              onToggleVisible={toggleLayerVisible}
              onUpdateAnnotation={updateAnnotation}
              onDeleteAnnotation={deleteAnnotation}
              onSeek={handleSeek}
            />
          </div>
        )}
      </main>

      {showExport && (
        <ExportModal
          layers={annotationLayers}
          audioFileName={chunker.fileName}
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  );
}

function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function WelcomeScreen({ onFileChange, onFileDrop }) {
  const [dragging, setDragging] = React.useState(false);
  return (
    <div className="welcome-screen">
      <div className="welcome-content">
        <div className="welcome-icon">♪</div>
        <h1 className="welcome-title">Audio Annotation</h1>
        <p className="welcome-subtitle">
          Load an audio file to begin. Long files are automatically chunked into
          3-minute segments. Spectrograms are computed server-side using librosa
          and cached for instant revisits.
        </p>
        <label
          className={`file-drop-zone ${dragging ? 'file-drop-zone--dragging' : ''}`}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { setDragging(false); onFileDrop(e); }}
        >
          <span className="file-drop-icon">⊕</span>
          <span className="file-drop-text">Drop audio file here</span>
          <span className="file-drop-sub">or click to browse</span>
          <input type="file" accept=".wav,.mp3,.ogg,.flac,.aac,.m4a" onChange={onFileChange} style={{ display: 'none' }} />
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

function DecodingScreen({ progress, fileName, status }) {
  const label = status === 'uploading' ? 'Uploading…' : 'Decoding audio…';
  return (
    <div className="decoding-screen">
      <div className="decoding-content">
        <div className="decoding-filename">{fileName}</div>
        <div className="decoding-label">{label}</div>
        <div className="decoding-bar-track">
          <div className="decoding-bar-fill" style={{ width: `${progress}%` }} />
        </div>
        <div className="decoding-hint">
          The file is decoded server-side using librosa. Spectrograms are
          computed with native-speed FFT and cached to disk for instant revisits.
        </div>
      </div>
    </div>
  );
}

export default App;