import { useState, useEffect, useRef, useCallback } from 'react';

// Manages a set of "mounted" chunk indices.
// The current chunk is always mounted immediately.
// Background chunks are admitted one at a time via requestIdleCallback
// so the main thread stays free between each player mount.
export function useMountQueue(currentChunk, sxxStatus) {
  const [mounted, setMounted] = useState(new Set([currentChunk]));
  const queueRef  = useRef([]);   // indices waiting to mount
  const draining  = useRef(false);
  const idleHandle = useRef(null);

  // Always ensure current chunk is mounted immediately
  useEffect(() => {
    setMounted(prev => {
      if (prev.has(currentChunk)) return prev;
      const next = new Set(prev);
      next.add(currentChunk);
      return next;
    });
  }, [currentChunk]);

  // When sxx becomes ready for a chunk, add it to the queue
  useEffect(() => {
    Object.entries(sxxStatus).forEach(([idxStr, status]) => {
      const idx = Number(idxStr);
      if (status === 'ready' && idx !== currentChunk) {
        if (!mounted.has(idx) && !queueRef.current.includes(idx)) {
          queueRef.current.push(idx);
        }
      }
    });
    drainQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sxxStatus]);

  const drainQueue = useCallback(() => {
    if (draining.current || queueRef.current.length === 0) return;
    draining.current = true;

    const mountNext = (deadline) => {
      if (queueRef.current.length === 0) {
        draining.current = false;
        return;
      }

      // Only mount if we have time left in this idle period, or fall back after 50ms
      if (deadline.timeRemaining() > 10 || deadline.didTimeout) {
        const idx = queueRef.current.shift();
        setMounted(prev => {
          if (prev.has(idx)) return prev;
          const next = new Set(prev);
          next.add(idx);
          return next;
        });
      }

      if (queueRef.current.length > 0) {
        idleHandle.current = requestIdleCallback(mountNext, { timeout: 300 });
      } else {
        draining.current = false;
      }
    };

    idleHandle.current = requestIdleCallback(mountNext, { timeout: 300 });
  }, []);

  // Cancel any pending idle callbacks on unmount
  useEffect(() => {
    return () => {
      if (idleHandle.current) cancelIdleCallback(idleHandle.current);
    };
  }, []);

  return mounted;
}