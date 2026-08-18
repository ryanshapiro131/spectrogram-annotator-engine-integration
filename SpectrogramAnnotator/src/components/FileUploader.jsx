import React, { useRef, useState } from 'react';
import './FileUploader.css';

export default function FileUploader({ onFileLoad, large }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const handleFile = (file) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    onFileLoad(url, file.name);
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  return (
    <div
      className={`file-uploader ${large ? 'file-uploader--large' : ''} ${dragging ? 'dragging' : ''}`}
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onClick={() => inputRef.current.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".wav,.mp3,.ogg,.flac,.aac,.m4a"
        style={{ display: 'none' }}
        onChange={e => handleFile(e.target.files[0])}
      />
      {large ? (
        <>
          <div className="uploader-icon">⊕</div>
          <div className="uploader-text">Drop audio file here</div>
          <div className="uploader-sub">or click to browse</div>
        </>
      ) : (
        <span className="uploader-inline">+ Load Audio</span>
      )}
    </div>
  );
}
