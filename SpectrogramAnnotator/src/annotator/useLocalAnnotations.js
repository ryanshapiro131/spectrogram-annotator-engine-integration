import { useState, useCallback, useRef } from 'react';

export const LABEL_COLORS = ['#1a6b8a', '#2d7a4f', '#7a4f2d', '#4f2d7a', '#7a2d4f'];

const initialLayers = () => [
  { id: 'layer-1', title: 'Layer 1', color: '#1a6b8a', annotations: [], height: 32, visible: true },
];

/*
 * In-memory annotation store for the standalone /audio annotator: nothing
 * is saved; Export JSON is the way to keep the work.
 *
 * Annotation stores (this one and useProjectAnnotations) share one shape,
 * which AudioAnnotator consumes:
 *   layers            [{ id, title, color, height, visible, annotations: [{ id, name, start, end }] }]
 *   activeLayerId, setActiveLayerId
 *   addAnnotation(labelId, { start, end }), updateAnnotation(layerId, annId, changes),
 *   deleteAnnotation(layerId, annId)
 *   resolveOrCreateLabel(name) -> labelId   (synchronous)
 *   addLayer(), removeLayer(id), updateLayer(id, changes), toggleLayerVisible(id), clear()
 *   canCreate, canEditAnnotation(ann), canEditLayer(layer)
 *   saveState         null (not saved anywhere) or { status: 'idle'|'saving'|'saved'|'error', message }
 *
 * Each entry in `layers` IS a "label" (the user's mental model: a named,
 * colored annotation type like "chirp" or "engine noise") — despite the
 * `layer`-flavored names left over from when this only had generic
 * "Layer 1/2" tabs. `visible` controls whether this label's colored boxes
 * are drawn on the spectrogram (see SpectrogramOverlay); annotations don't
 * carry their own free-text label — the layer/label they live in *is* their
 * label, picked via SpectrogramOverlay's label picker.
 */
export function useLocalAnnotations() {
  const [annotationLayers, setAnnotationLayers] = useState(initialLayers);
  const [activeLayerId, setActiveLayerId] = useState('layer-1');
  const layerIdCounter = useRef(2);

  // Annotation CRUD. `labelId` lets the caller (SpectrogramOverlay's label
  // picker) target ANY existing label, not just whichever tab is active —
  // that's what lets a new annotation reuse a past label's color.
  const addAnnotation = useCallback((labelId, annotation) => {
    setAnnotationLayers(prev => prev.map(layer =>
      layer.id === labelId
        // Name defaults to the label's own title, but the caller may
        // override it since it spreads after the default.
        ? { ...layer, annotations: [...layer.annotations, { name: layer.title, ...annotation, id: `ann-${Date.now()}` }] }
        : layer
    ));
  }, []);

  // Resolves a typed label name to an existing label's id (case-insensitive
  // match) or creates a new one, returning its id either way. Used by
  // SpectrogramOverlay's label picker so picking/typing a name is all one
  // step regardless of whether that label already exists.
  const resolveOrCreateLabel = useCallback((name) => {
    const trimmed = name.trim();
    const existing = annotationLayers.find(l => l.title.toLowerCase() === trimmed.toLowerCase());
    if (existing) return existing.id;
    const id = `layer-${layerIdCounter.current++}`;
    const color = LABEL_COLORS[annotationLayers.length % LABEL_COLORS.length];
    setAnnotationLayers(prev => [
      ...prev,
      { id, title: trimmed, color, annotations: [], height: 32, visible: true }
    ]);
    return id;
  }, [annotationLayers]);

  const toggleLayerVisible = useCallback((layerId) => {
    setAnnotationLayers(prev => prev.map(l => l.id === layerId ? { ...l, visible: l.visible === false } : l));
  }, []);

  const updateAnnotation = useCallback((layerId, annId, changes) => {
    setAnnotationLayers(prev => prev.map(layer =>
      layer.id === layerId
        ? { ...layer, annotations: layer.annotations.map(a => a.id === annId ? { ...a, ...changes } : a) }
        : layer
    ));
  }, []);

  const deleteAnnotation = useCallback((layerId, annId) => {
    setAnnotationLayers(prev => prev.map(layer =>
      layer.id === layerId
        ? { ...layer, annotations: layer.annotations.filter(a => a.id !== annId) }
        : layer
    ));
  }, []);

  const addLayer = useCallback(() => {
    const id = `layer-${layerIdCounter.current++}`;
    setAnnotationLayers(prev => [
      ...prev,
      { id, title: `Layer ${prev.length + 1}`, color: LABEL_COLORS[prev.length % LABEL_COLORS.length], annotations: [], height: 32, visible: true }
    ]);
    setActiveLayerId(id);
  }, []);

  const removeLayer = useCallback((layerId) => {
    setAnnotationLayers(prev => {
      const next = prev.filter(l => l.id !== layerId);
      return next.length === 0 ? prev : next;
    });
    setActiveLayerId(prev =>
      prev === layerId ? annotationLayers.find(l => l.id !== layerId)?.id : prev
    );
  }, [annotationLayers]);

  const updateLayer = useCallback((layerId, changes) => {
    setAnnotationLayers(prev => prev.map(l => l.id === layerId ? { ...l, ...changes } : l));
  }, []);

  const clear = useCallback(() => {
    setAnnotationLayers(initialLayers());
    setActiveLayerId('layer-1');
    layerIdCounter.current = 2;
  }, []);

  return {
    layers: annotationLayers,
    activeLayerId, setActiveLayerId,
    addAnnotation, updateAnnotation, deleteAnnotation, resolveOrCreateLabel,
    addLayer, removeLayer, updateLayer, toggleLayerVisible, clear,
    canCreate: true,
    canEditAnnotation: () => true,
    canEditLayer: () => true,
    saveState: null,
    loading: false,
    loadError: null,
  };
}
