import { useState, useCallback, useMemo, useRef } from 'react';
import { LABEL_COLORS } from './useLocalAnnotations';

/*
 * In-memory annotation store for the standalone /photo annotator: one label
 * list shared by every loaded image (labelImg's label history), boxes kept
 * per image. Nothing is saved; Export keeps the work.
 *
 * Same store shape as useProjectAnnotations / useLocalAnnotations (see
 * there), scoped to `imageKey`, the image on screen. Image annotations are
 *   { id, key, labelId, name, box: { xmin, ymin, xmax, ymax }, difficult }
 * Extras for export / import: labels, annotationsFor(imageKey).
 */
export function useLocalImageAnnotations(imageKey) {
  const [labels, setLabels] = useState([]);
  const [anns, setAnns] = useState([]);
  const [activeLayerId, setActiveLayerId] = useState(null);
  const counter = useRef(1);
  const labelsRef = useRef(labels);
  labelsRef.current = labels;

  const createLabel = useCallback((title) => {
    const id = `label-${counter.current++}`;
    const color = LABEL_COLORS[labelsRef.current.length % LABEL_COLORS.length];
    const label = { id, key: id, title, color, height: 32, visible: true };
    labelsRef.current = [...labelsRef.current, label];
    setLabels(ls => [...ls, label]);
    return id;
  }, []);

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

  const removeLayer = useCallback((layerId) => {
    const used = anns.filter(a => a.labelId === layerId).length;
    if (used && !window.confirm(`Delete this label and its ${used} box${used !== 1 ? 'es' : ''} on all images?`)) return;
    setLabels(ls => ls.filter(l => l.id !== layerId));
    setAnns(as => as.filter(a => a.labelId !== layerId));
    setActiveLayerId(a => (a === layerId ? labelsRef.current.find(l => l.id !== layerId)?.id ?? null : a));
  }, [anns]);

  const updateLayer = useCallback((layerId, changes) => {
    setLabels(ls => ls.map(l => l.id === layerId ? { ...l, ...changes } : l));
    if ('title' in changes) setAnns(as => as.map(a => a.labelId === layerId ? { ...a, name: changes.title } : a));
  }, []);

  const toggleLayerVisible = useCallback((layerId) => {
    setLabels(ls => ls.map(l => l.id === layerId ? { ...l, visible: l.visible === false } : l));
  }, []);

  const addAnnotation = useCallback((labelId, fields, forImage = imageKey) => {
    const id = `ann-${counter.current++}`;
    const label = labelsRef.current.find(l => l.id === labelId);
    setAnns(as => [...as, { id, key: id, imageKey: forImage, labelId, name: label?.title ?? '', difficult: false, ...fields }]);
    return id;
  }, [imageKey]);

  const updateAnnotation = useCallback((_layerId, annId, changes) => {
    setAnns(as => as.map(a => a.id === annId ? { ...a, ...changes } : a));
  }, []);

  const deleteAnnotation = useCallback((_layerId, annId) => {
    setAnns(as => as.filter(a => a.id !== annId));
  }, []);

  const clear = useCallback(() => {
    setLabels([]);
    setAnns([]);
    setActiveLayerId(null);
  }, []);

  const annotationsFor = useCallback((key) => anns.filter(a => a.imageKey === key), [anns]);

  const layers = useMemo(() => labels.map(l => ({
    ...l, annotations: anns.filter(a => a.imageKey === imageKey && a.labelId === l.id),
  })), [labels, anns, imageKey]);

  const countsByImage = useMemo(() => {
    const out = {};
    for (const a of anns) out[a.imageKey] = (out[a.imageKey] || 0) + 1;
    return out;
  }, [anns]);

  return {
    layers,
    activeLayerId, setActiveLayerId,
    addAnnotation, updateAnnotation, deleteAnnotation, resolveOrCreateLabel,
    addLayer, removeLayer, updateLayer, toggleLayerVisible, clear,
    canCreate: true,
    canEditAnnotation: () => true,
    canEditLayer: () => true,
    saveState: null,
    loading: false,
    loadError: null,
    labels, annotationsFor, countsByImage, hasAnnotations: anns.length > 0,
  };
}
