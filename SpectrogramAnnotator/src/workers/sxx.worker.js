/* eslint-disable no-restricted-globals */
/**
 * sxx.worker.js
 * Fetches an sxx JSON payload from the server and parses it off the main
 * thread, so JSON.parse (which can block for 50-200ms on large matrices)
 * never causes a UI stutter.
 *
 * Message IN:  { chunkIndex, url }
 * Message OUT: { chunkIndex, sxx }   on success
 *              { chunkIndex, error }  on failure
 */
self.addEventListener('message', async (e) => {
  const { chunkIndex, url } = e.data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // res.text() + JSON.parse both happen here in the worker — main thread free
    const text = await res.text();
    const { sxx } = JSON.parse(text);
    self.postMessage({ chunkIndex, sxx });
  } catch (err) {
    self.postMessage({ chunkIndex, error: err.message });
  }
});
