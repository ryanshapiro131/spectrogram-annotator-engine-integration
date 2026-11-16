import React, { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { apiJson } from '../api';
import { useAuth } from '../auth/AuthContext';
import { useAudioChunker } from '../hooks/useAudioChunker';
import { useProjectAnnotations } from '../annotator/useProjectAnnotations';
import AudioAnnotator, { AudioDropZone } from '../annotator/AudioAnnotator';
import { mediaFilePath } from '../mediaTypes';
import './pages.css';

// The audio annotator bound to one of a project's files: annotations load
// from the server and every change autosaves.
export default function ProjectAudioPage() {
  const { projectId, mediaId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [project, setProject] = useState(null);
  const [media, setMedia] = useState(null);
  const [error, setError] = useState(null);

  const chunker = useAudioChunker();
  const store = useProjectAnnotations({ projectId, mediaId, role: project?.role, userId: user?.id });
  const { openById } = chunker;

  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([
      apiJson(`/projects/${projectId}`),
      apiJson(`/projects/${projectId}/media/${mediaId}`),
    ]).then(([p, m]) => {
      if (cancelled) return;
      setProject(p);
      setMedia(m);
      if (m.media_type === 'audio') openById(m.content_hash, m.file_name);
    }).catch(err => { if (!cancelled) setError(err); });
    return () => { cancelled = true; };
  }, [projectId, mediaId, openById]);

  if (error) {
    return (
      <div className="page">
        <div className="empty-state">
          <h2>{error.status === 404 ? 'File not found' : "Couldn't open this file"}</h2>
          <p>{error.status === 404 ? "It isn't in this project, or you're not a member of the project." : error.message}</p>
          <Link to={`/projects/${projectId}`} className="btn btn-ghost">Back to project</Link>
        </div>
      </div>
    );
  }
  if (!media) return <div className="page-loading">Loading…</div>;
  // A photo/video entry: send it to that annotator's route.
  if (media.media_type !== 'audio') return <Navigate to={mediaFilePath(projectId, media)} replace />;

  const canUpload = project && ['annotator', 'admin', 'owner'].includes(project.role);

  return (
    <AudioAnnotator
      chunker={chunker}
      store={store}
      headerLeft={
        <nav className="annotator-breadcrumbs">
          <Link to="/">Projects</Link>
          <span>/</span>
          <Link to={`/projects/${projectId}`}>{project.name}</Link>
          <span>/</span>
          <span className="annotator-breadcrumbs-file">{media.file_name}</span>
        </nav>
      }
      onClose={() => navigate(`/projects/${projectId}`)}
      closeLabel="Back to project"
      renderMissing={() => (
        canUpload ? (
          <AudioDropZone
            title="Recording not on the server"
            subtitle={`The audio server no longer has "${media.file_name}" cached (its cache may have been cleared). Choose the same file again to keep annotating; the annotations are safe.`}
            onFile={(file) => chunker.loadFile(file, { projectId, expectedFileId: media.content_hash })}
          />
        ) : (
          <div className="empty-state">
            <h2>Recording not on the server</h2>
            <p>The audio server no longer has "{media.file_name}" cached. Ask an annotator or admin of this project to upload it again.</p>
          </div>
        )
      )}
    />
  );
}
