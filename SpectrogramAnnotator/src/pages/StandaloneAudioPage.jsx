import React, { useCallback } from 'react';
import { useAudioChunker } from '../hooks/useAudioChunker';
import { useLocalAnnotations } from '../annotator/useLocalAnnotations';
import AudioAnnotator, { AudioDropZone, AUDIO_ACCEPT } from '../annotator/AudioAnnotator';

// /audio: annotate any file on its own. Nothing is saved on the server;
// Export JSON keeps the work.
export default function StandaloneAudioPage() {
  const chunker = useAudioChunker();
  const store = useLocalAnnotations();
  const { loadFile, reset } = chunker;
  const { clear } = store;

  const close = useCallback(() => {
    if (store.layers.some(l => l.annotations.length) &&
        !window.confirm('Close this file? Its annotations are not saved anywhere; export them first if you need them.')) return;
    clear();
    reset();
  }, [store.layers, clear, reset]);

  return (
    <AudioAnnotator
      chunker={chunker}
      store={store}
      onClose={close}
      closeLabel="Close file"
      headerExtra={chunker.status === 'idle' && (
        <label className="btn btn-ghost btn-sm file-input-label">
          Load audio
          <input
            type="file" accept={AUDIO_ACCEPT} style={{ display: 'none' }}
            onChange={e => { const f = e.target.files[0]; e.target.value = ''; if (f) loadFile(f); }}
          />
        </label>
      )}
      renderIdle={() => (
        <AudioDropZone
          onFile={loadFile}
          subtitle="Load an audio file to begin. Long files are automatically chunked into 3-minute segments for playback, and the spectrogram is generated once on the server and cached for instant revisits. Annotations here aren't saved: use Export JSON, or work inside a project to save automatically."
        />
      )}
    />
  );
}
