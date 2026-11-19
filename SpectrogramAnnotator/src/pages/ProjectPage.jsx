import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiFetch, apiJson } from '../api';
import { useAuth } from '../auth/AuthContext';
import { uploadAudio } from '../audioUpload';
import { IMAGE_ACCEPT, saveDownload, uploadImage } from '../imageUpload';
import { AUDIO_ACCEPT, describeTransfer, formatDuration } from '../annotator/AudioAnnotator';
import { mediaFilePath, mediaTypeInfo } from '../mediaTypes';
import { formatDate, RoleBadge } from './ProjectsPage';
import './pages.css';

const ROLES = ['viewer', 'annotator', 'admin', 'owner'];
const rank = (role) => ROLES.indexOf(role);

// Files are shown in one group per media type, in this order.
const FILE_GROUPS = [
  { type: 'audio', title: 'Audio', none: 'No audio yet.' },
  { type: 'video', title: 'Video', none: 'No video files yet.' },
  { type: 'image', title: 'Photos', none: 'No photos yet.' },
];

const MEMBERS_OPEN_KEY = 'projectMembersOpen';

function readMembersOpen() {
  try {
    const v = localStorage.getItem(MEMBERS_OPEN_KEY);
    return v === null ? window.innerWidth >= 1200 : v === '1';
  } catch {
    return false;
  }
}

export default function ProjectPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [project, setProject] = useState(null);
  const [media, setMedia] = useState(null);
  const [error, setError] = useState(null);
  const [membersOpen, setMembersOpen] = useState(readMembersOpen);
  const [memberCount, setMemberCount] = useState(null);

  const toggleMembers = () => setMembersOpen(open => {
    try { localStorage.setItem(MEMBERS_OPEN_KEY, open ? '0' : '1'); } catch { /* per-viewer nicety only */ }
    return !open;
  });

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
    <div className={`project-layout ${membersOpen ? 'project-layout--members' : ''}`}>
      <div className="page project-main">
        <ProjectHeader
          project={project}
          onRenamed={setProject}
          onDeleted={() => navigate('/', { replace: true })}
          membersButton={
            <button
              className={`btn btn-ghost btn-sm members-toggle ${membersOpen ? 'members-toggle--on' : ''}`}
              onClick={toggleMembers}
              aria-expanded={membersOpen}
              aria-controls="members-panel"
            >
              Members{memberCount != null && <span className="members-toggle-count">{memberCount}</span>}
            </button>
          }
        />

        <FilesSection
          projectId={projectId}
          role={role}
          userId={user?.id}
          media={media}
          reload={loadMedia}
        />
      </div>

      <aside id="members-panel" className="members-panel" aria-label="Members" aria-hidden={!membersOpen}>
        <div className="members-panel-inner">
          <MembersSection
            projectId={projectId}
            role={role}
            userId={user?.id}
            onCount={setMemberCount}
            onClose={toggleMembers}
            onLeft={() => navigate('/', { replace: true })}
          />
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header: name (rename for admins), role, delete (owner)
// ---------------------------------------------------------------------------
function ProjectHeader({ project, onRenamed, onDeleted, membersButton }) {
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
        {membersButton}
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}
    </>
  );
}

// ---------------------------------------------------------------------------
// Files: one group per media type + upload audio / photos
// ---------------------------------------------------------------------------
function FilesSection({ projectId, role, userId, media, reload }) {
  const [uploads, setUploads] = useState([]); // [{ key, type, name, status, transfer, error }]
  const [error, setError] = useState(null);
  const queueRef = useRef(Promise.resolve());
  const keyRef = useRef(0);
  const canUpload = rank(role) >= rank('annotator');
  const isAdmin = rank(role) >= rank('admin');

  const patchUpload = (key, changes) =>
    setUploads(us => us.map(u => u.key === key ? { ...u, ...(typeof changes === 'function' ? changes(u) : changes) } : u));

  // Files upload one after another (each can be large).
  const addFiles = (files, type = 'audio') => {
    const upload = type === 'image' ? uploadImage : uploadAudio;
    for (const file of files) {
      const key = ++keyRef.current;
      setUploads(us => [...us, { key, type, name: file.name, status: 'queued', transfer: null, error: null }]);
      queueRef.current = queueRef.current.then(async () => {
        try {
          await upload(file, {
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

  const exportImages = async () => {
    try {
      setError(null);
      await saveDownload(await apiFetch(`/projects/${projectId}/export/images?format=voc`), 'annotations_voc.zip');
    } catch (err) {
      setError(err.message);
    }
  };

  if (media === null) return <div className="page-loading">Loading files…</div>;

  return (
    <div className="file-groups">
      {error && <div className="form-error" role="alert">{error}</div>}
      {FILE_GROUPS.map(group => {
        const info = mediaTypeInfo(group.type);
        const files = media.filter(f => mediaTypeInfo(f.media_type).type === group.type);
        const isAudio = group.type === 'audio';
        const isImage = group.type === 'image';
        const uploadable = isAudio || isImage;
        const timed = group.type !== 'image';
        const groupUploads = uploads.filter(u => u.type === group.type);
        return (
          <section key={group.type} className={`card section file-group file-group--${group.type}`}>
            <div className="section-head">
              <div className="file-group-title">
                <span className="file-group-icon" aria-hidden="true">{info.icon}</span>
                <h2 className="section-title">{group.title}</h2>
                <span className="file-group-count">{files.length}</span>
              </div>
              {isImage && files.length > 0 && (
                <button className="btn btn-ghost btn-sm" onClick={exportImages} title="Download every photo's boxes as labelImg / Pascal VOC .xml files (zip)">
                  Export VOC
                </button>
              )}
              {uploadable && canUpload && (
                <label className="btn btn-solid btn-sm file-input-label">
                  {isAudio ? '+ Upload audio' : '+ Upload photos'}
                  <input
                    type="file" accept={isAudio ? AUDIO_ACCEPT : IMAGE_ACCEPT} multiple style={{ display: 'none' }}
                    data-testid={isAudio ? 'project-upload-input' : 'project-upload-images'}
                    onChange={e => { const fs = [...e.target.files]; e.target.value = ''; addFiles(fs, group.type); }}
                  />
                </label>
              )}
              {!info.available && <span className="file-group-soon">Annotator coming soon</span>}
            </div>

            {groupUploads.map(u => <UploadRow key={u.key} upload={u} onDismiss={() => setUploads(us => us.filter(x => x.key !== u.key))} />)}

            {files.length === 0 ? (
              <div className="section-empty">
                {group.none}{isAudio && canUpload ? ' Upload a recording to start annotating.' : ''}
                {isImage && canUpload ? ' Upload photos to start drawing boxes.' : ''}
              </div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    {timed && <th>Length</th>}
                    {isImage && <th>Size</th>}
                    <th>{isImage ? 'Boxes' : 'Annotations'}</th>
                    {isImage && <th>Verified</th>}
                    <th className="col-optional">Uploaded by</th>
                    <th className="col-optional">Added</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {files.map(f => {
                    const canDelete = isAdmin || (canUpload && f.uploaded_by === userId);
                    return (
                      <tr key={f.id}>
                        <td>
                          <Link to={mediaFilePath(projectId, f)} className="file-link">{f.file_name}</Link>
                        </td>
                        {timed && <td className="num">{f.duration_sec != null ? formatDuration(f.duration_sec) : '—'}</td>}
                        {isImage && <td className="num">{f.width_px && f.height_px ? `${f.width_px} × ${f.height_px}` : '—'}</td>}
                        <td className="num">{f.annotation_count}</td>
                        {isImage && <td title={f.verifier_name ? `by ${f.verifier_name}` : undefined}>{f.verified_at ? '✓' : ''}</td>}
                        <td className="col-optional">{f.uploader_name || '—'}</td>
                        <td className="col-optional">{formatDate(f.created_at)}</td>
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
      })}
    </div>
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
function MembersSection({ projectId, role, userId, onCount, onClose, onLeft }) {
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
  useEffect(() => { if (data) onCount(data.members.length); }, [data, onCount]);

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
      setNotice(`Added ${r.email} as ${r.role}.`);
      setEmail('');
    });
  };

  const canManage = (m) => isAdmin && (isOwner || rank(m.role) < rank('admin'));

  return (
    <section className="members-section">
      <div className="section-head">
        <h2 className="section-title">Members</h2>
        <button className="btn btn-icon" title="Hide members" aria-label="Hide members" onClick={onClose}>✕</button>
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
                  <div className="member-email">Older invite · joins when they sign in with Google</div>
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
                placeholder="Email of their account"
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
            {isAdmin && 'You can add anyone who already has an account; others need to create one on the sign-in page first. '}
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
