import React, { useRef, useEffect } from 'react';
import './ChunkTimeline.css';

function formatTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

export default function ChunkTimeline({
  totalChunks, currentChunk, chunkUrls, sxxStatus,
  fileDuration, chunkDuration, onSelectChunk,
}) {
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!scrollRef.current) return;
    const active = scrollRef.current.querySelector('.chunk-cell--active');
    if (active) {
      const cr = scrollRef.current.getBoundingClientRect();
      const ar = active.getBoundingClientRect();
      scrollRef.current.scrollTo({
        left: scrollRef.current.scrollLeft + ar.left - cr.left - cr.width / 2 + ar.width / 2,
        behavior: 'smooth',
      });
    }
  }, [currentChunk]);

  return (
    <div className="chunk-timeline">
      <div className="chunk-timeline-label">
        <span>Chunks</span>
        <span className="chunk-timeline-info">
          {currentChunk + 1} / {totalChunks}
          <span className="chunk-timeline-time">
            {formatTime(currentChunk * chunkDuration)} – {formatTime(Math.min((currentChunk + 1) * chunkDuration, fileDuration))}
          </span>
        </span>
      </div>
      <div className="chunk-cells" ref={scrollRef}>
        {Array.from({ length: totalChunks }, (_, i) => {
          const isActive  = i === currentChunk;
          const isCached  = !!chunkUrls[i];
          const sxx       = sxxStatus?.[i];   // 'pending' | 'ready' | 'error' | undefined
          return (
            <button
              key={i}
              className={[
                'chunk-cell',
                isActive  ? 'chunk-cell--active'  : '',
                isCached  ? 'chunk-cell--cached'  : '',
                sxx === 'ready'   ? 'chunk-cell--sxx-ready'   : '',
                sxx === 'pending' ? 'chunk-cell--sxx-pending' : '',
              ].join(' ').trim()}
              onClick={() => onSelectChunk(i)}
              title={`Chunk ${i + 1} — ${formatTime(i * chunkDuration)}${sxx ? ` (sxx: ${sxx})` : ''}`}
            >
              <span className="chunk-cell-num">{i + 1}</span>
              <span className="chunk-cell-time">{formatTime(i * chunkDuration)}</span>
              {/* Small status pip */}
              {sxx === 'ready'   && <span className="chunk-pip chunk-pip--ready"   title="Spectrogram cached" />}
              {sxx === 'pending' && <span className="chunk-pip chunk-pip--pending" title="Computing…" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}