import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiJson } from '../api';
import { useAuth } from '../auth/AuthContext';
import './pages.css';

export function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function RoleBadge({ role }) {
  return <span className={`role-badge role-badge--${role}`}>{role}</span>;
}

// Shown in place of project pages when the server runs without sign-in.
export function ProjectsUnavailable() {
  const { status } = useAuth();
  return (
    <div className="page">
      <div className="empty-state">
        <h2>Projects aren't available</h2>
        {status === 'offline' ? (
          <p>Can't reach the annotation server. Check that it's running, then reload.</p>
        ) : (
          <p>
            This server runs without sign-in (no database or sign-in method configured), so there are
            no shared projects. You can still annotate a file on its own in the{' '}
            <Link to="/audio">audio annotator</Link> and export the result as JSON.
          </p>
        )}
      </div>
    </div>
  );
}

export default function ProjectsPage() {
  const { authEnabled } = useAuth();
  const navigate = useNavigate();
  const [projects, setProjects] = useState(null);
  const [error, setError] = useState(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(() => {
    apiJson('/projects').then(setProjects).catch(err => setError(err.message));
  }, []);

  useEffect(() => { if (authEnabled) load(); }, [authEnabled, load]);

  if (!authEnabled) return <ProjectsUnavailable />;

  const create = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const p = await apiJson('/projects', { method: 'POST', json: { name: name.trim() } });
      navigate(`/projects/${p.id}`);
    } catch (err) {
      setError(err.message);
      setCreating(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Projects</h1>
        {!showCreate && (
          <button className="btn btn-solid" onClick={() => setShowCreate(true)}>+ New project</button>
        )}
      </div>

      {showCreate && (
        <form className="inline-form card" onSubmit={create}>
          <input
            autoFocus
            className="text-input"
            placeholder="Project name"
            maxLength={200}
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { setShowCreate(false); setName(''); } }}
          />
          <button className="btn btn-solid" type="submit" disabled={creating || !name.trim()}>
            {creating ? 'Creating…' : 'Create'}
          </button>
          <button className="btn btn-ghost" type="button" onClick={() => { setShowCreate(false); setName(''); }}>Cancel</button>
        </form>
      )}

      {error && <div className="form-error" role="alert">{error}</div>}

      {projects === null && !error && <div className="page-loading">Loading projects…</div>}

      {projects?.length === 0 && !showCreate && (
        <div className="empty-state">
          <h2>No projects yet</h2>
          <p>Create a project, upload recordings into it and invite people to annotate with you.
            If someone invited you, their project shows up here once they add your email.</p>
        </div>
      )}

      {projects?.length > 0 && (
        <div className="project-grid">
          {projects.map(p => (
            <Link key={p.id} to={`/projects/${p.id}`} className="project-card card">
              <div className="project-card-top">
                <span className="project-card-name">{p.name}</span>
                <RoleBadge role={p.role} />
              </div>
              {p.description && <div className="project-card-desc">{p.description}</div>}
              <div className="project-card-meta">
                <span>{p.media_count} file{p.media_count !== 1 ? 's' : ''}</span>
                <span>{p.member_count} member{p.member_count !== 1 ? 's' : ''}</span>
                <span>Updated {formatDate(p.updated_at)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
