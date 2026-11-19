import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { apiFetch, apiJson } from '../api';
import { useAuth } from '../auth/AuthContext';
import { useProjectAnnotations } from '../annotator/useProjectAnnotations';
import ImageAnnotator, { ImageDropZone } from '../annotator/ImageAnnotator';
import ImageExportModal from '../components/ImageExportModal';
import { byFileName, fetchImageUrl, fitBoxes, parseVoc, saveDownload, uploadImage } from '../imageUpload';
import { mediaFilePath } from '../mediaTypes';
import './pages.css';

const ROLE_RANK = { viewer: 0, annotator: 1, admin: 2, owner: 3 };

// The photo annotator bound to a project: the queue is the project's images
// (sorted by name, like labelImg's file list), boxes autosave, and
// "verified" is stored per file.
export default function ProjectImagePage() {
  const { projectId, mediaId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [project, setProject] = useState(null);
  const [media, setMedia] = useState(null);   // every file in the project
  const [error, setError] = useState(null);
  const [imageState, setImageState] = useState({ status: 'loading' });
  const [showExport, setShowExport] = useState(false);
  const [notice, setNotice] = useState(null);
  const urlCache = useRef(new Map());          // content_hash -> Promise<object URL | null>

  useEffect(() => { setNotice(null); }, [mediaId]);

  const store = useProjectAnnotations({ projectId, mediaId, role: project?.role, userId: user?.id });
  const canAnnotate = (ROLE_RANK[project?.role] ?? -1) >= ROLE_RANK.annotator;

  // Reloaded on every image change so the queue's box counts stay current.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiJson(`/projects/${projectId}`),
      apiJson(`/projects/${projectId}/media`),
    ]).then(([p, m]) => {
      if (cancelled) return;
      setProject(p);
      setMedia(m);
      setError(null);
    }).catch(err => { if (!cancelled) setError(err); });
    return () => { cancelled = true; };
  }, [projectId, mediaId]);

  const queue = useMemo(
    () => (media || []).filter(f => f.media_type === 'image').sort((a, b) => byFileName(a.file_name, b.file_name)),
    [media]);
  const file = media?.find(f => f.id === mediaId) ?? null;
  const index = queue.findIndex(f => f.id === mediaId);

  const getUrl = useCallback((hash) => {
    if (!urlCache.current.has(hash)) {
      const p = fetchImageUrl(hash);
      p.catch(() => urlCache.current.delete(hash));
      urlCache.current.set(hash, p);
    }
    return urlCache.current.get(hash);
  }, []);

  useEffect(() => () => {
    for (const p of urlCache.current.values()) p.then(u => u && URL.revokeObjectURL(u)).catch(() => {});
  }, []);

  // Load the current image, then warm the cache for its neighbours (D / A).
  const hash = file?.media_type === 'image' ? file.content_hash : null;
  useEffect(() => {
    if (!hash) return undefined;
    let cancelled = false;
    setImageState({ status: 'loading' });
    getUrl(hash).then(url => {
      if (cancelled) return;
      setImageState(url ? { status: 'ready', url } : { status: 'missing' });
      [queue[index + 1], queue[index - 1]].forEach(n => n && getUrl(n.content_hash).catch(() => {}));
    }).catch(err => { if (!cancelled) setImageState({ status: 'error', error: err.message }); });
    return () => { cancelled = true; };
  }, [hash, getUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const liveCount = store.layers.reduce((n, l) => n + l.annotations.length, 0);
  const images = useMemo(() => queue.map(f => ({
    key: f.id,
    name: f.file_name,
    verified: !!f.verified_at,
    count: f.id === mediaId && !store.loading ? liveCount : f.annotation_count,
  })), [queue, mediaId, liveCount, store.loading]);

  const image = file && {
    ...imageState,
    name: file.file_name,
    width: file.width_px,
    height: file.height_px,
    verified: !!file.verified_at,
  };

  const patchFile = (changes) => setMedia(ms => ms.map(f => f.id === mediaId ? { ...f, ...changes } : f));

  const toggleVerified = useCallback(async () => {
    const before = file.verified_at;
    patchFile({ verified_at: before ? null : new Date().toISOString() });
    try {
      const row = await apiJson(`/projects/${projectId}/media/${mediaId}`, { method: 'PATCH', json: { verified: !before } });
      patchFile({ verified_at: row.verified_at, verified_by: row.verified_by });
    } catch (err) {
      patchFile({ verified_at: before });
      setNotice(`Couldn't change verified: ${err.message}`);
    }
  }, [file, projectId, mediaId]); // eslint-disable-line react-hooks/exhaustive-deps

  // labelImg's "copy previous bounding boxes" (Ctrl+V).
  const copyPrevious = useCallback(async () => {
    const prev = queue[index - 1];
    if (!prev || !file) return;
    try {
      const rows = await apiJson(`/projects/${projectId}/media/${prev.id}/annotations`);
      const size = { width: file.width_px, height: file.height_px };
      const boxes = fitBoxes(
        rows.filter(r => r.extra?.bbox).map(r => ({ labelId: r.label_id, difficult: !!r.extra.difficult, ...r.extra.bbox })),
        size, size);
      boxes.forEach(b => store.addAnnotation(b.labelId, { box: b.box, difficult: b.difficult }));
      setNotice(boxes.length ? `Copied ${boxes.length} box${boxes.length !== 1 ? 'es' : ''} from ${prev.file_name}.` : `${prev.file_name} has no boxes to copy.`);
    } catch (err) {
      setNotice(`Couldn't copy boxes: ${err.message}`);
    }
  }, [queue, index, file, projectId, store]);

  const importVoc = useCallback(async (xml) => {
    try {
      const voc = await parseVoc(xml);
      const size = { width: file.width_px, height: file.height_px };
      const boxes = fitBoxes(voc.boxes, voc.width && voc.height ? voc : size, size);
      boxes.forEach(b => store.addAnnotation(store.resolveOrCreateLabel(b.label), { box: b.box, difficult: b.difficult }));
      const other = voc.filename && voc.filename !== file.file_name ? ` (the file was written for ${voc.filename})` : '';
      setNotice(`Imported ${boxes.length} box${boxes.length !== 1 ? 'es' : ''} from ${xml.name}${other}.`);
    } catch (err) {
      setNotice(`Couldn't import ${xml.name}: ${err.message}`);
    }
  }, [file, store]);

  const download = (query, fallback) => async () => {
    const res = await apiFetch(`/projects/${projectId}/export/images?${query}`);
    await saveDownload(res, fallback);
  };

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
  if (!media || !project) return <div className="page-loading">Loading…</div>;
  if (!file) {
    return (
      <div className="page">
        <div className="empty-state">
          <h2>File not found</h2>
          <p>It isn't in this project any more.</p>
          <Link to={`/projects/${projectId}`} className="btn btn-ghost">Back to project</Link>
        </div>
      </div>
    );
  }
  if (file.media_type !== 'image') return <Navigate to={mediaFilePath(projectId, file)} replace />;

  return (
    <>
      <ImageAnnotator
        images={images}
        currentIndex={index}
        onNavigate={(i) => navigate(mediaFilePath(projectId, queue[i]), { replace: true })}
        image={image}
        store={store}
        headerLeft={
          <nav className="annotator-breadcrumbs">
            <Link to="/">Projects</Link>
            <span>/</span>
            <Link to={`/projects/${projectId}`}>{project.name}</Link>
            <span>/</span>
            <span className="annotator-breadcrumbs-file">{file.file_name}</span>
          </nav>
        }
        headerExtra={notice && (
          <span className="header-notice" role="status">
            {notice}
            <button className="btn btn-icon" onClick={() => setNotice(null)} aria-label="Dismiss">✕</button>
          </span>
        )}
        onClose={() => navigate(`/projects/${projectId}`)}
        closeLabel="Back to project"
        onToggleVerified={canAnnotate ? toggleVerified : null}
        onCopyPrevious={canAnnotate ? copyPrevious : null}
        onImportVoc={canAnnotate ? importVoc : null}
        onExport={() => setShowExport(true)}
        renderMissing={() => (canAnnotate ? (
          <ImageDropZone
            multiple={false}
            title="Image not on the server"
            subtitle={`The server no longer has "${file.file_name}" (its cache may have been cleared). Choose the same file again to keep annotating; the boxes are safe.`}
            onFiles={async ([f]) => {
              try {
                setImageState({ status: 'loading' });
                await uploadImage(f, { projectId, expectedFileId: file.content_hash });
                urlCache.current.delete(file.content_hash);
                const url = await getUrl(file.content_hash);
                setImageState(url ? { status: 'ready', url } : { status: 'missing' });
              } catch (err) {
                setImageState({ status: 'missing' });
                setNotice(err.message);
              }
            }}
          />
        ) : (
          <div className="empty-state">
            <h2>Image not on the server</h2>
            <p>The server no longer has "{file.file_name}". Ask an annotator or admin of this project to upload it again.</p>
          </div>
        ))}
      />
      {showExport && (
        <ImageExportModal
          onClose={() => setShowExport(false)}
          summary={`${project.name} · ${queue.length} image${queue.length !== 1 ? 's' : ''}${store.saveState?.status === 'saving' ? ' · finishing autosave first is recommended' : ''}`}
          options={[
            {
              id: 'voc-one', title: 'Pascal VOC — this image',
              detail: `One labelImg-style .xml for ${file.file_name}.`,
              run: download(`format=voc&media_id=${mediaId}`, 'annotation.xml'),
            },
            {
              id: 'voc-all', title: 'Pascal VOC — every image',
              detail: 'A .zip with one .xml per image in the project.',
              run: download('format=voc', 'annotations_voc.zip'),
            },
            {
              id: 'json-all', title: 'JSON — every image',
              detail: 'Labels, image sizes, verified flags and boxes in one file.',
              run: download('format=json', 'annotations.json'),
            },
          ]}
        />
      )}
    </>
  );
}
