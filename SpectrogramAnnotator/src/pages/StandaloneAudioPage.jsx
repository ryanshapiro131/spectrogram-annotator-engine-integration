import React, { useCallback } from 'react';
import { useAudioChunker } from '../hooks/useAudioChunker';
import { useLocalAnnotations } from '../annotator/useLocalAnnotations';
import AudioAnnotator, { AudioDropZone, AUDIO_ACCEPT } from '../annotator/AudioAnnotator';
import { useAuth } from '../auth/AuthContext';
import ProjectFilePicker from './ProjectFilePicker';

// /audio: annotate any file on its own. Nothing is saved on the server;
// Export JSON keeps the work. Signed-in users are offered their projects'
// files first, since those autosave.
export default function StandaloneAudioPage() {
  const { authEnabled, user } = useAuth();
  const signedIn = authEnabled && !!user;
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
      renderIdle={() => (signedIn ? (
        <AudioDropZone
          onFile={loadFile}
          subtitle="Pick a recording from one of your projects, or annotate a file from your computer."
          before={<ProjectFilePicker mediaType="audio" noun="audio" />}
          dropLabel="Or annotate a local file"
        />
      ) : (
        <AudioDropZone
          onFile={loadFile}
          subtitle="Load an audio file to begin."
        />
      ))}
    />
  );
}
