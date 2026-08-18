import { useState, useEffect } from 'react';

/**
 * useMountQueue
 *
 * Keeps only a small window of SpectrogramPlayer instances mounted in the DOM.
 * Mounting too many players at once causes heavy re-render work every time
 * sxxCache updates (each player re-renders even if its data didn't change).
 *
 * Strategy:
 *   - Always mount current chunk immediately
 *   - Mount current-1 and current+1 for instant back/forward navigation
 *   - Unmount everything outside that window
 *
 * This caps the number of live players at 3 regardless of how many chunks
 * have been visited, eliminating the re-render cascade that causes stuttering.
 */
export function useMountQueue(currentChunk) {
  const [mounted, setMounted] = useState(() => new Set([0]));

  useEffect(() => {
    const chunk = typeof currentChunk === 'number' ? currentChunk : 0;
    setMounted(new Set([
      chunk - 1,
      chunk,
      chunk + 1,
    ].filter(i => i >= 0)));
  }, [currentChunk]);

  return mounted;
}