import { Sha1 } from './sha1';

// Hashes a File in 8 MB slices so even multi-GB recordings never sit in
// memory at once. Posts { progress } (0..1) as it goes, then { fileId }.
const SLICE = 8 * 1024 * 1024;

self.onmessage = async (e) => {
  const { file } = e.data;
  try {
    const h = new Sha1();
    for (let off = 0; off < file.size; off += SLICE) {
      h.update(new Uint8Array(await file.slice(off, off + SLICE).arrayBuffer()));
      self.postMessage({ progress: Math.min(1, (off + SLICE) / file.size) });
    }
    // Same id as the server's _file_id(): first 16 hex chars of the SHA-1.
    self.postMessage({ fileId: h.digestHex().slice(0, 16) });
  } catch (err) {
    self.postMessage({ error: String(err) });
  }
};
