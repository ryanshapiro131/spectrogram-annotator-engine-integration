import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiJson } from '../api';
import { useAuth } from '../auth/AuthContext';
import { uploadAudio } from '../audioUpload';
import { AUDIO_ACCEPT, describeTransfer, formatDuration } from '../annotator/AudioAnnotator';
import { mediaFilePath, mediaTypeInfo } from '../mediaTypes';
import { formatDate, RoleBadge } from './ProjectsPage';
import './pages.css';

const ROLES = ['viewer', 'annotator', 'admin', 'owner'];
const rank = (role) => ROLES.indexOf(role);

export default function ProjectPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [project, setProject] = useState(null);
  const [media, setMedia] = useState(null);
  const [error, setError] = useState(null);

  const loadProject = useCallback(() =>
    apiJson(`/projects/${projectId}`).then(setProject), [projectId]);
  const loadMedia = useCallback(() =>
    apiJson(`/projects/${projectId}/media`).then(setMedia), [projectId]);

  useEffect(() => {
    setProject(null);
    setMedia(null);
    setError(null);
    Promise.all([loadProject(), loadMedia()]).catch(err => setError(err));
  }, [loadProject, loadMedia]);

  if (error) {
    return (
      <div className="page">
        <div className="empty-state">
          <h2>{error.status === 404 ? 'Project not found' : "Couldn't load this project"}</h2>
          <p>{error.status === 404 ? "It doesn't exist, or you're not a member of it." : error.message}</p>
          <Link to="/" className="btn btn-ghost">Back to projects</Link>
        </div>
      </div>
    );
  }
  if (!project) return <div className="page-loading">Loading project…</div>;

  const role = project.role;

  return (
    <div className="page">
      <ProjectHeader
        project={project}
        onRenamed={setProject}
        onDeleted={() => navigate('/', { replace: true })}
      />

      <FilesSection
        projectId={projectId}
        role={role}
        userId={user?.id}
        media={media}
        reload={loadMedia}
      />

      <MembersSection
        projectId={projectId}
        role={role}
        userId={user?.id}
        onLeft={() => navigate('/', { replace: true })}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header: name (rename for admins), role, delete (owner)
// ---------------------------------------------------------------------------
function ProjectHeader({ project, onRenamed, onDeleted }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [error, setError] = useState(null);
  const canRename = rank(project.role) >= rank('admin');

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === project.name) { setEditing(false); setName(project.name); return; }
    try {
      onRenamed(await apiJson(`/projects/${project.id}`, { method: 'PATCH', json: { name: trimmed } }));
      setEditing(false);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete the project "${project.name}" with all its files, labels and annotations? This can't be undone.`)) return;
    try {
      await apiJson(`/projects/${project.id}`, { method: 'DELETE' });
      onDeleted();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <>
      <div className="breadcrumbs"><Link to="/">Projects</Link> <span>/</span></div>
      <div className="page-header">
        {editing ? (
          <input
            className="text-input page-title-input"
            autoFocus
            maxLength={200}
            value={name}
            onChange={e => setName(e.target.value)}
            onBlur={save}
            onKeyDown={e => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') { setEditing(false); setName(project.name); }
            }}
          />
        ) : (
          <h1
            className={`page-title ${canRename ? 'page-title--editable' : ''}`}
            title={canRename ? 'Click to rename' : undefined}
            onClick={canRename ? () => setEditing(true) : undefined}
          >
            {project.name}
          </h1>
        )}
        <RoleBadge role={project.role} />
        <div className="page-header-spacer" />
        {project.role === 'owner' && (
          <button className="btn btn-danger btn-sm" onClick={remove}>Delete project</button>
        )}
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}
    </>
  );
}

// ---------------------------------------------------------------------------
// Files: list + upload audio
// ---------------------------------------------------------------------------
function FilesSection({ projectId, role, userId, media, reload }) {
  const [uploads, setUploads] = useState([]); // [{ key, name, status, transfer, error }]
  const [error, setError] = useState(null);
  const queueRef = useRef(Promise.resolve());
  const keyRef = useRef(0);
  const canUpload = rank(role) >= rank('annotator');
  const isAdmin = rank(role) >= rank('admin');

  const patchUpload = (key, changes) =>
    setUploads(us => us.map(u => u.key === key ? { ...u, ...(typeof changes === 'function' ? changes(u) : changes) } : u));

  // Files upload one after another (each can be large).
  const addFiles = (files) => {
    for (const file of files) {
      const key = ++keyRef.current;
      setUploads(us => [...us, { key, name: file.name, status: 'queued', transfer: null, error: null }]);
      queueRef.current = queueRef.current.then(async () => {
        try {
          await uploadAudio(file, {
            projectId,
            onPhase: (status) => patchUpload(key, { status }),
            onTransfer: (t) => patchUpload(key, u => ({ transfer: { ...u.transfer, ...t } })),
          });
          setUploads(us => us.filter(u => u.key !== key));
          await reload();
        } catch (err) {
          patchUpload(key, { status: 'error', error: err.message });
        }
      });
    }
  };

  const remove = async (f) => {
    const n = f.annotation_count;
    if (!window.confirm(`Remove "${f.file_name}"${n ? ` and its ${n} annotation${n !== 1 ? 's' : ''}` : ''} from this project?`)) return;
    try {
      await apiJson(`/projects/${projectId}/media/${f.id}`, { method: 'DELETE' });
      setError(null);
      await reload();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <section className="card section">
      <div className="section-head">
        <h2 className="section-title">Files</h2>
        {canUpload && (
          <label className="btn btn-solid btn-sm file-input-label">
            + Upload audio
            <input
              type="file" accept={AUDIO_ACCEPT} multiple style={{ display: 'none' }}
              data-testid="project-upload-input"
              onChange={e => { const files = [...e.target.files]; e.target.value = ''; addFiles(files); }}
            />
          </label>
        )}
      </div>

      {uploads.map(u => <UploadRow key={u.key} upload={u} onDismiss={() => setUploads(us => us.filter(x => x.key !== u.key))} />)}
      {error && <div className="form-error" role="alert">{error}</div>}

      {media === null ? (
        <div className="page-loading">Loading files…</div>
      ) : media.length === 0 ? (
        <div className="section-empty">
          {canUpload ? 'No files yet. Upload a recording to start annotating.' : 'No files in this project yet.'}
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th><th>Type</th><th>Length</th><th>Annotations</th><th>Uploaded by</th><th>Added</th><th />
            </tr>
          </thead>
          <tbody>
            {media.map(f => {
              const info = mediaTypeInfo(f.media_type);
              const canDelete = isAdmin || (canUpload && f.uploaded_by === userId);
              return (
                <tr key={f.id}>
                  <td>
                    <Link to={mediaFilePath(projectId, f)} className="file-link">{f.file_name}</Link>
                  </td>
                  <td><span className="type-chip">{info.icon} {info.label}</span></td>
                  <td className="num">{f.duration_sec != null ? formatDuration(f.duration_sec) : '—'}</td>
                  <td className="num">{f.annotation_count}</td>
                  <td>{f.uploader_name || '—'}</td>
                  <td>{formatDate(f.created_at)}</td>
                  <td className="row-actions">
                    {canDelete && (
                      <button className="btn btn-icon btn-icon--danger" title="Remove from project" onClick={() => remove(f)}>✕</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function UploadRow({ upload, onDismiss }) {
  if (upload.status === 'error') {
    return (
      <div className="upload-row upload-row--error">
        <span className="upload-name">{upload.name}</span>
        <span className="upload-detail">{upload.error}</span>
        <button className="btn btn-icon" onClick={onDismiss} title="Dismiss">✕</button>
      </div>
    );
  }
  if (upload.status === 'queued') {
    return (
      <div className="upload-row">
        <span className="upload-name">{upload.name}</span>
        <span className="upload-detail">Waiting…</span>
      </div>
    );
  }
  const { pct, label, detail, indeterminate } = describeTransfer(upload.status, upload.transfer);
  return (
    <div className="upload-row">
      <span className="upload-name">{upload.name}</span>
      <span className="upload-detail">{label}{detail ? ` · ${detail}` : ''}</span>
      <div className={`decoding-bar-track upload-bar ${indeterminate ? 'decoding-bar-track--indeterminate' : ''}`}>
        <div className="decoding-bar-fill" style={indeterminate ? undefined : { width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Members + invites
// ---------------------------------------------------------------------------
function MembersSection({ projectId, role, userId, onLeft }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [email, setEmail] = useState('');
  const [newRole, setNewRole] = useState('annotator');
  const isAdmin = rank(role) >= rank('admin');
  const isOwner = role === 'owner';
  const grantable = ROLES.filter(r => isOwner || rank(r) < rank('admin'));

  const load = useCallback(() =>
    apiJson(`/projects/${projectId}/members`).then(setData).catch(err => setError(err.message)), [projectId]);
  useEffect(() => { load(); }, [load]);

  const run = async (fn) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    }
    await load();
  };

  const add = (e) => {
    e.preventDefault();
    if (!email.trim()) return;
    run(async () => {
      const r = await apiJson(`/projects/${projectId}/members`, { method: 'POST', json: { email: email.trim(), role: newRole } });
      setNotice(r.status === 'added'
        ? `Added ${r.email} as ${r.role}.`
        : `Invited ${r.email} as ${r.role}. They'll join the project the first time they sign in.`);
      setEmail('');
    });
  };

  const canManage = (m) => isAdmin && (isOwner || rank(m.role) < rank('admin'));

  return (
    <section className="card section">
      <div className="section-head">
        <h2 className="section-title">Members</h2>
      </div>

      {data === null ? (
        <div className="page-loading">Loading members…</div>
      ) : (
        <>
          <ul className="member-list">
            {data.members.map(m => {
              const self = m.user_id === userId;
              return (
                <li key={m.user_id} className="member-row">
                  <span className="sidebar-avatar sidebar-avatar--initial">{(m.display_name || m.email)[0].toUpperCase()}</span>
                  <div className="member-text">
                    <div className="member-name">{m.display_name || m.email}{self && <span className="member-you"> (you)</span>}</div>
                    <div className="member-email">{m.email}</div>
                  </div>
                  {canManage(m) && !self ? (
                    <select
                      className="select-input"
                      value={m.role}
                      aria-label={`Role for ${m.email}`}
                      onChange={e => run(() => apiJson(`/projects/${projectId}/members/${m.user_id}`, { method: 'PATCH', json: { role: e.target.value } }))}
                    >
                      {ROLES.filter(r => grantable.includes(r) || r === m.role).map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  ) : (
                    <RoleBadge role={m.role} />
                  )}
                  {self ? (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        if (!window.confirm('Leave this project? You will lose access until someone adds you again.')) return;
                        run(async () => {
                          await apiJson(`/projects/${projectId}/members/${m.user_id}`, { method: 'DELETE' });
                          onLeft();
                        });
                      }}
                    >Leave</button>
                  ) : canManage(m) ? (
                    <button
                      className="btn btn-icon btn-icon--danger"
                      title="Remove from project"
                      onClick={() => {
                        if (!window.confirm(`Remove ${m.email} from this project? Their annotations stay.`)) return;
                        run(() => apiJson(`/projects/${projectId}/members/${m.user_id}`, { method: 'DELETE' }));
                      }}
                    >✕</button>
                  ) : <span className="member-action-spacer" />}
                </li>
              );
            })}
            {data.invites.map(inv => (
              <li key={inv.id} className="member-row member-row--invite">
                <span className="sidebar-avatar sidebar-avatar--initial sidebar-avatar--pending">?</span>
                <div className="member-text">
                  <div className="member-name">{inv.email}</div>
                  <div className="member-email">Invited · joins on first sign-in</div>
                </div>
                <RoleBadge role={inv.role} />
                {isAdmin ? (
                  <button
                    className="btn btn-icon btn-icon--danger"
                    title="Cancel invite"
                    onClick={() => run(() => apiJson(`/projects/${projectId}/invites/${inv.id}`, { method: 'DELETE' }))}
                  >✕</button>
                ) : <span className="member-action-spacer" />}
              </li>
            ))}
          </ul>

          {isAdmin && (
            <form className="inline-form member-add" onSubmit={add}>
              <input
                className="text-input"
                type="email"
                placeholder="Add by email"
                value={email}
                onChange={e => setEmail(e.target.value)}
              />
              <select className="select-input" value={newRole} onChange={e => setNewRole(e.target.value)} aria-label="Role">
                {grantable.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              <button className="btn btn-solid btn-sm" type="submit" disabled={!email.trim()}>Add</button>
            </form>
          )}
          <p className="section-help">
            Viewers can look at everything. Annotators can also upload files and add annotations, and edit or delete
            their own. Admins can edit anyone's work and manage members; owners can also manage admins and delete the project.
          </p>
        </>
      )}
      {notice && <div className="form-notice" role="status">{notice}</div>}
      {error && <div className="form-error" role="alert">{error}</div>}
    </section>
  );
}
