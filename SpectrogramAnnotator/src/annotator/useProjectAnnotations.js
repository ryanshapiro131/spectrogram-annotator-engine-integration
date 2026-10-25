import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { apiJson } from '../api';
import { LABEL_COLORS } from './useLocalAnnotations';

const ROLE_RANK = { viewer: 0, annotator: 1, admin: 2, owner: 3 };
const LABEL_PATCH_DELAY_MS = 400; // color pickers fire on every drag step

const fromLabel = (l) => ({
  id: l.id, key: l.id, title: l.name, color: l.color, height: l.display_height,
  visible: true, createdBy: l.created_by,
});

const fromAnnotation = (a) => ({
  id: a.id, key: a.id, labelId: a.label_id, name: a.name ?? '', start: a.start_sec, end: a.end_sec,
  createdBy: a.created_by, creatorName: a.creator_name,
});

// Annotation fields as the API names them.
const toAnnotationPatch = (changes) => {
  const out = {};
  if ('name' in changes) out.name = changes.name;
  if ('start' in changes) out.start_sec = changes.start;
  if ('end' in changes) out.end_sec = changes.end;
  return out;
};

const toLabelPatch = (changes) => {
  const out = {};
  if ('title' in changes) out.name = changes.title;
  if ('color' in changes) out.color = changes.color;
  return out;
};

const pick = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj[k]]));

/*
 * Annotation store for a project's media file: same shape as
 * useLocalAnnotations (see there), but loaded from and autosaved to the
 * server. Every change is applied to local state immediately (optimistic)
 * and queued as an API call; a failed call rolls that change back and
 * saveState reports it.
 *
 * Writes go through ONE serial queue. That keeps them in order and lets
 * temporary ids work: the label picker needs a label id synchronously, so
 * a new label (or annotation) gets a "tmp-…" id at once; its create request
 * is queued, and by the time any later request that refers to it runs, the
 * create has finished and idMap holds the real id. When it lands, local
 * state switches over to the real id.
 */
export function useProjectAnnotations({ projectId, mediaId, role, userId }) {
  const [labels, setLabels] = useState([]);
  const [anns, setAnns] = useState([]);
  const [activeLayerId, setActiveLayerId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [saveState, setSaveState] = useState({ status: 'idle', message: null });

  const labelsRef = useRef(labels);
  const annsRef = useRef(anns);
  labelsRef.current = labels;
  annsRef.current = anns;

  const idMap = useRef(new Map());      // tmp id -> real id (null if its create failed)
  const queueRef = useRef(Promise.resolve());
  const pendingRef = useRef(0);
  const batchErrorRef = useRef(null);   // first error since the queue was last empty
  const tmpCounter = useRef(1);
  const labelPatchRef = useRef({});     // label id -> { changes, before, timer }

  const base = `/projects/${projectId}`;

  // ---------------------------------------------------------------------------
  // Load
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    Promise.all([
      apiJson(`${base}/labels`),
      apiJson(`${base}/media/${mediaId}/annotations`),
    ]).then(([labelRows, annRows]) => {
      if (cancelled) return;
      const ls = labelRows.map(fromLabel);
      setLabels(ls);
      setAnns(annRows.map(fromAnnotation));
      setActiveLayerId(ls[0]?.id ?? null);
      setLoading(false);
    }).catch(err => {
      if (cancelled) return;
      setLoadError(err.message);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [base, mediaId]);

  // ---------------------------------------------------------------------------
  // Save queue
  // ---------------------------------------------------------------------------
  const enqueue = useCallback((op, rollback) => {
    if (pendingRef.current++ === 0) batchErrorRef.current = null;
    setSaveState({ status: 'saving', message: null });
    queueRef.current = queueRef.current
      .then(op)
      .catch(err => {
        console.error('Autosave failed:', err);
        batchErrorRef.current ??= err.message || 'Unknown error';
        try { rollback?.(err); } catch (e) { console.error(e); }
      })
      .finally(() => {
        if (--pendingRef.current === 0) {
          setSaveState(batchErrorRef.current
            ? { status: 'error', message: batchErrorRef.current }
            : { status: 'saved', message: null });
        }
      });
  }, []);

  // Don't let the tab close with changes still on their way to the server.
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (pendingRef.current > 0 || Object.keys(labelPatchRef.current).length) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // The id to use in local state (a tmp id may already have been replaced).
  const current = (id) => idMap.current.get(id) || id;
  // The id to send to the server; null when its create failed.
  const real = (id) => (idMap.current.has(id) ? idMap.current.get(id) : id);
  const sameId = (id) => (x) => x === id || x === idMap.current.get(id);

  // ---------------------------------------------------------------------------
  // Labels
  // ---------------------------------------------------------------------------
  const createLabel = useCallback((name) => {
    const tmp = `tmp-label-${tmpCounter.current++}`;
    const color = LABEL_COLORS[labelsRef.current.length % LABEL_COLORS.length];
    const label = { id: tmp, key: tmp, title: name, color, height: 32, visible: true, createdBy: userId };
    labelsRef.current = [...labelsRef.current, label]; // visible to a second call before re-render
    setLabels(ls => [...ls, label]);

    enqueue(async () => {
      let row;
      try {
        row = await apiJson(`${base}/labels`, { method: 'POST', json: { name, color } });
      } catch (err) {
        // Someone else created the same name meanwhile: use theirs.
        if (err.status !== 409) throw err;
        const all = await apiJson(`${base}/labels`);
        row = all.find(l => l.name.trim().toLowerCase() === name.toLowerCase());
        if (!row) throw err;
      }
      idMap.current.set(tmp, row.id);
      setLabels(ls => ls.map(l => l.id === tmp ? { ...l, id: row.id, color: row.color, createdBy: row.created_by } : l));
      setAnns(as => as.map(a => a.labelId === tmp ? { ...a, labelId: row.id } : a));
      setActiveLayerId(id => id === tmp ? row.id : id);
    }, () => {
      idMap.current.set(tmp, null);
      setLabels(ls => ls.filter(l => l.id !== tmp));
      setAnns(as => as.filter(a => a.labelId !== tmp));
      setActiveLayerId(id => id === tmp ? (labelsRef.current.find(l => l.id !== tmp)?.id ?? null) : id);
    });
    return tmp;
  }, [base, enqueue, userId]);

  // Synchronous by design (see the header comment): returns an existing
  // label's id (case-insensitive name match) or a new label's tmp id.
  const resolveOrCreateLabel = useCallback((name) => {
    const trimmed = name.trim();
    const existing = labelsRef.current.find(l => l.title.toLowerCase() === trimmed.toLowerCase());
    return existing ? existing.id : createLabel(trimmed);
  }, [createLabel]);

  const addLayer = useCallback(() => {
    const taken = new Set(labelsRef.current.map(l => l.title.toLowerCase()));
    let n = labelsRef.current.length + 1;
    while (taken.has(`label ${n}`)) n++;
    setActiveLayerId(createLabel(`Label ${n}`));
  }, [createLabel]);

  const flushLabelPatch = useCallback((labelId) => {
    const entry = labelPatchRef.current[labelId];
    if (!entry) return;
    clearTimeout(entry.timer);
    delete labelPatchRef.current[labelId];
    const { changes, before } = entry;
    enqueue(async () => {
      const id = real(labelId);
      if (!id) return;
      await apiJson(`${base}/labels/${id}`, { method: 'PATCH', json: toLabelPatch(changes) });
    }, () => {
      setLabels(ls => ls.map(l => sameId(labelId)(l.id) ? { ...l, ...before } : l));
    });
  }, [base, enqueue]);

  const updateLayer = useCallback((layerId, changes) => {
    const id = current(layerId);
    const label = labelsRef.current.find(l => l.id === id);
    if (!label) return;
    setLabels(ls => ls.map(l => l.id === id ? { ...l, ...changes } : l));
    const entry = labelPatchRef.current[id] || { changes: {}, before: {} };
    for (const k of Object.keys(changes)) if (!(k in entry.before)) entry.before[k] = label[k];
    entry.changes = { ...entry.changes, ...changes };
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => flushLabelPatch(id), LABEL_PATCH_DELAY_MS);
    labelPatchRef.current[id] = entry;
  }, [flushLabelPatch]);

  // Send any debounced label edits right away when leaving the page.
  useEffect(() => () => {
    Object.keys(labelPatchRef.current).forEach(flushLabelPatch);
  }, [flushLabelPatch]);

  const removeLayer = useCallback((layerId) => {
    const id = current(layerId);
    const idx = labelsRef.current.findIndex(l => l.id === id);
    if (idx < 0) return;
    const label = labelsRef.current[idx];
    const used = annsRef.current.filter(a => a.labelId === id).length;
    if (used) {
      setSaveState({
        status: 'error',
        message: `"${label.title}" still has ${used} annotation${used !== 1 ? 's' : ''} on this file. Delete those first.`,
      });
      return;
    }
    setLabels(ls => ls.filter(l => l.id !== id));
    setActiveLayerId(a => a === id ? (labelsRef.current.find(l => l.id !== id)?.id ?? null) : a);
    enqueue(async () => {
      const rid = real(id);
      if (!rid) return;
      await apiJson(`${base}/labels/${rid}`, { method: 'DELETE' });
    }, () => {
      // e.g. 409: annotations on OTHER files of the project still use it.
      setLabels(ls => (ls.some(l => l.id === label.id) ? ls : [...ls.slice(0, idx), label, ...ls.slice(idx)]));
    });
  }, [base, enqueue]);

  const toggleLayerVisible = useCallback((layerId) => {
    const id = current(layerId);
    setLabels(ls => ls.map(l => l.id === id ? { ...l, visible: l.visible === false } : l));
  }, []);

  // ---------------------------------------------------------------------------
  // Annotations
  // ---------------------------------------------------------------------------
  const addAnnotation = useCallback((labelId, { start, end }) => {
    const lid = current(labelId);
    const label = labelsRef.current.find(l => l.id === lid);
    const tmp = `tmp-ann-${tmpCounter.current++}`;
    const ann = { id: tmp, key: tmp, labelId: lid, name: label?.title ?? '', start, end, createdBy: userId, creatorName: null };
    setAnns(as => [...as, ann]);
    enqueue(async () => {
      const realLabel = real(lid);
      if (!realLabel) throw new Error('Its label could not be saved.');
      const row = await apiJson(`${base}/media/${mediaId}/annotations`, {
        method: 'POST',
        json: { label_id: realLabel, name: ann.name, start_sec: start, end_sec: end },
      });
      idMap.current.set(tmp, row.id);
      // Only the id/attribution: values may have been edited locally since.
      setAnns(as => as.map(a => a.id === tmp
        ? { ...a, id: row.id, labelId: row.label_id, createdBy: row.created_by, creatorName: row.creator_name }
        : a));
    }, () => {
      idMap.current.set(tmp, null);
      setAnns(as => as.filter(a => a.id !== tmp));
    });
  }, [base, mediaId, enqueue, userId]);

  const updateAnnotation = useCallback((_layerId, annId, changes) => {
    const id = current(annId);
    const before = annsRef.current.find(a => a.id === id);
    if (!before) return;
    setAnns(as => as.map(a => a.id === id ? { ...a, ...changes } : a));
    enqueue(async () => {
      const rid = real(id);
      if (!rid) return;
      await apiJson(`${base}/annotations/${rid}`, { method: 'PATCH', json: toAnnotationPatch(changes) });
    }, () => {
      const prev = pick(before, Object.keys(changes));
      setAnns(as => as.map(a => sameId(id)(a.id) ? { ...a, ...prev } : a));
    });
  }, [base, enqueue]);

  const deleteAnnotation = useCallback((_layerId, annId) => {
    const id = current(annId);
    const idx = annsRef.current.findIndex(a => a.id === id);
    if (idx < 0) return;
    const before = annsRef.current[idx];
    setAnns(as => as.filter(a => a.id !== id));
    enqueue(async () => {
      const rid = real(id);
      if (!rid) return;
      await apiJson(`${base}/annotations/${rid}`, { method: 'DELETE' });
    }, () => {
      const restored = { ...before, id: current(before.id) };
      setAnns(as => (as.some(a => a.id === restored.id) ? as : [...as.slice(0, idx), restored, ...as.slice(idx)]));
    });
  }, [base, enqueue]);

  // ---------------------------------------------------------------------------
  // Permissions (the server enforces these too)
  // ---------------------------------------------------------------------------
  const rank = ROLE_RANK[role] ?? -1;
  const canCreate = rank >= ROLE_RANK.annotator && !loading && !loadError;
  const canEditAnnotation = useCallback(
    (a) => rank >= ROLE_RANK.admin || (rank >= ROLE_RANK.annotator && a.createdBy === userId),
    [rank, userId]);
  const canEditLayer = useCallback(
    (l) => rank >= ROLE_RANK.admin || (rank >= ROLE_RANK.annotator && l.createdBy === userId),
    [rank, userId]);

  const layers = useMemo(
    () => labels.map(l => ({ ...l, annotations: anns.filter(a => a.labelId === l.id) })),
    [labels, anns]);

  return {
    layers,
    activeLayerId, setActiveLayerId,
    addAnnotation, updateAnnotation, deleteAnnotation, resolveOrCreateLabel,
    addLayer, removeLayer, updateLayer, toggleLayerVisible,
    clear: () => {},
    canCreate, canEditAnnotation, canEditLayer,
    saveState,
    loading, loadError,
  };
}
