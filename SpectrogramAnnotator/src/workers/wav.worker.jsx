/* eslint-disable no-restricted-globals */
/**
 * wav.worker.js — runs off the main thread.
 * Receives raw PCM channel data, encodes a WAV, and posts back a Blob URL.
 *
 * Message IN:
 *   { chunkIndex, channels: Float32Array[], sampleRate }
 *   (channels is an array of transferable Float32Array buffers — one per channel)
 *
 * Message OUT:
 *   { chunkIndex, url }  on success
 *   { chunkIndex, error } on failure
 */
self.addEventListener('message', function (e) {
  const { chunkIndex, channels, sampleRate } = e.data;
  try {
    const url = encodeWav(channels, sampleRate);
    self.postMessage({ chunkIndex, url });
  } catch (err) {
    self.postMessage({ chunkIndex, error: err.message });
  }
});

function encodeWav(channels, sampleRate) {
  const numChannels  = channels.length;
  const numFrames    = channels[0].length;
  const bytesPerSample = 2;
  const blockAlign   = numChannels * bytesPerSample;
  const dataSize     = numFrames * blockAlign;
  const ab           = new ArrayBuffer(44 + dataSize);
  const view         = new DataView(ab);

  const ws = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true);
  ws(8, 'WAVE'); ws(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true); view.setUint16(34, 16, true);
  ws(36, 'data'); view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  const blob = new Blob([ab], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
}
