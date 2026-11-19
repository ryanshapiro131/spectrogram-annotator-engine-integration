import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiJson } from '../api';
import { useAuth } from '../auth/AuthContext';
import { formatDuration } from '../annotator/AudioAnnotator';
import { mediaFilePath } from '../mediaTypes';
import './pages.css';

// Start-screen picker on /audio: choose one of your projects, then one of its
// files of `mediaType`, and open it in the project (where annotations autosave).
// Renders nothing when sign-in is off or nobody is signed in.
export default function ProjectFilePicker({ mediaType = 'audio', noun = 'audio' }) {
  const { authEnabled, user } = useAuth();
  const navigate = useNavigate();
  const [projects, setProjects] = useState(null);
  const [selected, setSelected] = useState(null);
  const [files, setFiles] = useState(null);
  const [error, setError] = useState(null);
  const active = authEnabled && !!user;

  useEffect(() => {
    if (!active) return;
    apiJson('/projects').then(ps => {
      setProjects(ps);
      if (ps.length === 1) setSelected(ps[0].id);
    }).catch(err => setError(err.message));
  }, [active]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setFiles(null);
    apiJson(`/projects/${selected}/media`)
      .then(ms => { if (!cancelled) setFiles(ms.filter(m => m.media_type === mediaType)); })
      .catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [selected, mediaType]);

  if (!active) return null;
  if (projects === null && !error) {
    return <section className="project-picker"><div className="picker-empty">Loading your projects…</div></section>;
  }

  if (projects?.length === 0) {
    return (
      <div className="picker-hint">
        No project files. <Link to="/">Create a project</Link>
      </div>
    );
  }

  const project = projects?.find(p => p.id === selected);

  return (
    <section className="project-picker">
      <div className="project-picker-head">
        <h2 className="project-picker-title">Open {noun} from a project</h2>
      </div>

      {error && <div className="form-error" role="alert">{error}</div>}

      {projects && (
        <div className="project-picker-body">
          <ul className="picker-list picker-list--projects" aria-label="Projects">
            {projects.map(p => (
              <li key={p.id}>
                <button
                  className={`picker-item ${p.id === selected ? 'picker-item--on' : ''}`}
                  onClick={() => setSelected(p.id)}
                  aria-pressed={p.id === selected}
                >
                  <span className="picker-item-name">{p.name}</span>
                  <span className="picker-item-meta">{p.media_count}</span>
                </button>
              </li>
            ))}
          </ul>

          <div className="picker-files">
            {!selected ? (
              <div className="picker-empty">Choose a project to see its {noun} files.</div>
            ) : files === null ? (
              <div className="picker-empty">Loading files…</div>
            ) : files.length === 0 ? (
              <div className="picker-empty">
                No {noun} in {project?.name} yet. <Link to={`/projects/${selected}`}>Open the project</Link> to upload some.
              </div>
            ) : (
              <ul className="picker-list" aria-label={`Files in ${project?.name}`}>
                {files.map(f => (
                  <li key={f.id}>
                    <button className="picker-item picker-item--file" onClick={() => navigate(mediaFilePath(selected, f))}>
                      <span className="picker-item-name">{f.file_name}</span>
                      <span className="picker-item-meta">
                        {f.duration_sec != null ? formatDuration(f.duration_sec) : f.width_px ? `${f.width_px}×${f.height_px}` : ''}
                        {f.verified_at ? ' · ✓' : ''}
                        {f.annotation_count ? ` · ${f.annotation_count} ann.` : ''}
                      </span>
                      <span className="picker-item-go" aria-hidden="true">→</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
