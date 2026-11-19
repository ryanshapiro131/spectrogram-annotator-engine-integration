import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../api';
import { useAuth } from '../auth/AuthContext';
import { useLocalImageAnnotations } from '../annotator/useLocalImageAnnotations';
import ImageAnnotator, { ImageDropZone } from '../annotator/ImageAnnotator';
import ImageExportModal from '../components/ImageExportModal';
import { IMAGE_ACCEPT, byFileName, fitBoxes, isImageFile, parseVoc, saveDownload } from '../imageUpload';
import ProjectFilePicker from './ProjectFilePicker';
import './pages.css';

let nextKey = 1;

// Decode a local file just enough to know its size (EXIF-rotated, as displayed).
async function loadLocalImage(file) {
  const url = URL.createObjectURL(file);
  const key = `img-${nextKey++}`;
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { key, name: file.name, url, width: img.naturalWidth, height: img.naturalHeight, verified: false };
  } catch {
    return { key, name: file.name, url, width: 0, height: 0, verified: false,
      error: "This browser can't display this file. Add it to a project instead: the server converts formats like TIFF." };
  }
}

/*
 * /photo: annotate images from this computer, like opening a folder in
 * labelImg. Nothing is saved on the server; Export keeps the work (Pascal
 * VOC is written by the server's labelImg port, so it needs the server
 * running). labelImg .xml files dropped with the images are imported onto
 * the image they name. Signed-in users are offered their projects' photos
 * first, since those autosave.
 */
export default function StandaloneImagePage() {
  const { authEnabled, user } = useAuth();
  const signedIn = authEnabled && !!user;
  const [images, setImages] = useState([]);
  const [index, setIndex] = useState(0);
  const [folder, setFolder] = useState('images');
  const [notice, setNotice] = useState(null);
  const [showExport, setShowExport] = useState(false);
  const imagesRef = useRef(images);
  imagesRef.current = images;

  const current = images[index] ?? null;
  useEffect(() => { setNotice(null); }, [index]);
  const store = useLocalImageAnnotations(current?.key ?? null);
  const { resolveOrCreateLabel, addAnnotation, annotationsFor, labels, clear } = store;

  useEffect(() => () => imagesRef.current.forEach(im => URL.revokeObjectURL(im.url)), []);

  const addVocBoxes = useCallback((voc, target) => {
    const size = { width: target.width, height: target.height };
    const boxes = fitBoxes(voc.boxes, voc.width && voc.height ? voc : size, size);
    boxes.forEach(b => addAnnotation(resolveOrCreateLabel(b.label), { box: b.box, difficult: b.difficult }, target.key));
    return boxes.length;
  }, [addAnnotation, resolveOrCreateLabel]);

  const addFiles = useCallback(async (files) => {
    const imgFiles = files.filter(isImageFile);
    const xmlFiles = files.filter(f => /\.xml$/i.test(f.name));
    if (!imgFiles.length && !xmlFiles.length) {
      setNotice('No images in that selection.');
      return;
    }
    const rel = files[0]?.webkitRelativePath;
    if (rel && rel.includes('/')) setFolder(rel.split('/').slice(-2, -1)[0] || 'images');

    const have = new Set(imagesRef.current.map(im => im.name));
    const fresh = imgFiles.filter(f => !have.has(f.name));
    const loaded = await Promise.all(fresh.map(loadLocalImage));
    const all = [...imagesRef.current, ...loaded].sort((a, b) => byFileName(a.name, b.name));
    imagesRef.current = all;
    setImages(all);
    // Stay on the image that was open (sorting may have moved it).
    setIndex(Math.max(0, all.findIndex(im => im.key === current?.key)));

    // labelImg's folder layout: photo.jpg + photo.xml side by side.
    let imported = 0;
    const problems = [];
    for (const xml of xmlFiles) {
      try {
        const voc = await parseVoc(xml);
        const stem = xml.name.replace(/\.xml$/i, '').toLowerCase();
        const target = all.find(im => im.name === voc.filename)
          || all.find(im => im.name.replace(/\.[^.]+$/, '').toLowerCase() === stem);
        if (!target || target.error) { problems.push(`${xml.name}: no matching image`); continue; }
        imported += addVocBoxes(voc, target);
        if (voc.verified) setImages(ims => ims.map(im => im.key === target.key ? { ...im, verified: true } : im));
      } catch (err) {
        problems.push(`${xml.name}: ${err.message}`);
      }
    }
    const skipped = imgFiles.length - fresh.length;
    setNotice([
      loaded.length ? `Added ${loaded.length} image${loaded.length !== 1 ? 's' : ''}` : null,
      skipped ? `${skipped} already open` : null,
      xmlFiles.length ? `imported ${imported} box${imported !== 1 ? 'es' : ''} from ${xmlFiles.length} .xml` : null,
      problems.length ? `problems: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? '…' : ''}` : null,
    ].filter(Boolean).join(' · ') || null);
  }, [current, addVocBoxes]);

  const close = useCallback(() => {
    if (store.hasAnnotations &&
        !window.confirm('Close these images? Their boxes are not saved anywhere; export them first if you need them.')) return;
    images.forEach(im => URL.revokeObjectURL(im.url));
    setImages([]);
    setIndex(0);
    setNotice(null);
    clear();
  }, [store.hasAnnotations, images, clear]);

  const toggleVerified = useCallback(() => {
    setImages(ims => ims.map((im, i) => i === index ? { ...im, verified: !im.verified } : im));
  }, [index]);

  const copyPrevious = useCallback(() => {
    const prev = images[index - 1];
    if (!prev || !current) return;
    const size = { width: current.width, height: current.height };
    const boxes = fitBoxes(annotationsFor(prev.key).map(a => ({ ...a.box, labelId: a.labelId, difficult: a.difficult })), size, size);
    boxes.forEach(b => addAnnotation(b.labelId, { box: b.box, difficult: b.difficult }));
    setNotice(boxes.length ? `Copied ${boxes.length} box${boxes.length !== 1 ? 'es' : ''} from ${prev.name}.` : `${prev.name} has no boxes to copy.`);
  }, [images, index, current, annotationsFor, addAnnotation]);

  const importVoc = useCallback(async (xml) => {
    try {
      const n = addVocBoxes(await parseVoc(xml), current);
      setNotice(`Imported ${n} box${n !== 1 ? 'es' : ''} from ${xml.name}.`);
    } catch (err) {
      setNotice(`Couldn't import ${xml.name}: ${err.message}`);
    }
  }, [addVocBoxes, current]);

  const queue = useMemo(() => images.map(im => ({
    key: im.key, name: im.name, verified: im.verified, count: store.countsByImage[im.key] || 0,
  })), [images, store.countsByImage]);

  const titleOf = (labelId) => labels.find(l => l.id === labelId)?.title ?? 'unlabeled';
  const vocImage = (im) => ({
    filename: im.name, width: im.width, height: im.height, depth: 3, verified: im.verified,
    boxes: annotationsFor(im.key).map(a => ({ label: titleOf(a.labelId), ...a.box, difficult: !!a.difficult })),
  });
  const exportVoc = (list, fallback) => async () => {
    const res = await apiFetch('/voc/export', { method: 'POST', json: { folder, images: list.filter(im => !im.error).map(vocImage) } })
      .catch(() => { throw new Error("Can't reach the server, which writes the Pascal VOC files. Is it running?"); });
    await saveDownload(res, fallback);
  };
  const exportJson = async () => {
    const data = {
      version: '1.0', type: 'image', folder, exportedAt: new Date().toISOString(),
      labels: labels.map(l => ({ name: l.title, color: l.color })),
      images: images.filter(im => !im.error).map(im => {
        const v = vocImage(im);
        return { file: v.filename, width: v.width, height: v.height, verified: v.verified, boxes: v.boxes };
      }),
    };
    await saveDownload(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `${folder}_annotations.json`);
  };

  const image = current
    ? { status: current.error ? 'error' : 'ready', url: current.url, width: current.width, height: current.height,
        name: current.name, verified: current.verified, error: current.error }
    : { status: 'idle' };

  return (
    <>
      <ImageAnnotator
        images={queue}
        currentIndex={index}
        onNavigate={setIndex}
        image={image}
        store={store}
        onClose={close}
        closeLabel="Close images"
        headerExtra={<>
          {notice && (
            <span className="header-notice" role="status">
              {notice}
              <button className="btn btn-icon" onClick={() => setNotice(null)} aria-label="Dismiss">✕</button>
            </span>
          )}
          {current && (
            <label className="btn btn-ghost btn-sm file-input-label" title="Add more images (and labelImg .xml files)">
              Add images
              <input
                type="file" accept={`${IMAGE_ACCEPT},.xml`} multiple style={{ display: 'none' }}
                onChange={e => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) addFiles(fs); }}
              />
            </label>
          )}
        </>}
        onToggleVerified={toggleVerified}
        onCopyPrevious={copyPrevious}
        onImportVoc={importVoc}
        onExport={() => setShowExport(true)}
        renderIdle={() => (
          <ImageDropZone
            folder
            onFiles={addFiles}
            subtitle={signedIn
              ? 'Pick photos from one of your projects, or annotate images from your computer.'
              : 'Load images (or a whole folder) to begin. Nothing is saved on the server; export when done.'}
            before={signedIn ? <ProjectFilePicker mediaType="image" noun="photos" /> : null}
            dropLabel={signedIn ? 'Or annotate local images' : null}
          />
        )}
      />
      {showExport && (
        <ImageExportModal
          onClose={() => setShowExport(false)}
          summary={`${images.length} image${images.length !== 1 ? 's' : ''} · folder "${folder}" · not saved anywhere until exported`}
          options={[
            {
              id: 'voc-one', title: 'Pascal VOC — this image',
              detail: `One labelImg-style .xml for ${current?.name}.`,
              run: exportVoc(current ? [current] : [], 'annotation.xml'),
            },
            {
              id: 'voc-all', title: 'Pascal VOC — every image',
              detail: 'A .zip with one .xml per image (a single image downloads as .xml).',
              run: exportVoc(images, 'annotations_voc.zip'),
            },
            {
              id: 'json-all', title: 'JSON — every image',
              detail: 'Labels, image sizes, verified flags and boxes in one file.',
              run: exportJson,
            },
          ]}
        />
      )}
    </>
  );
}
