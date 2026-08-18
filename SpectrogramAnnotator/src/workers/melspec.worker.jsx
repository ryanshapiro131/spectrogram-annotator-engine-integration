/* eslint-disable no-restricted-globals */
/**
 * melspec.worker.jsx — Web Worker using fft.js (radix-4) for fast FFT.
 *
 * fft.js is a pure-JS radix-4 FFT — 3-4x faster than the old Cooley-Tukey
 * implementation, zero WASM loading complexity, works in any worker context.
 *
 * Message IN:
 *   { chunkIndex, channelData: Float32Array, sampleRate,
 *     n_fft, win_length, hop_length, n_mels, f_min, f_max, top_db }
 *
 * Message OUT (success): { chunkIndex, sxx: Float32Array, nMels, nFrames }
 *   sxx is flat row-major [nMels × nFrames], transferred zero-copy.
 * Message OUT (error):   { chunkIndex, error: string }
 */

import FFT from 'fft.js';

// ---------------------------------------------------------------------------
// Per-size FFT cache — reuse FFT instance + buffers across frames
// ---------------------------------------------------------------------------
const _fftCache = new Map();

function getFFTResources(n_fft) {
  if (_fftCache.has(n_fft)) return _fftCache.get(n_fft);
  const fft    = new FFT(n_fft);
  const input  = fft.createComplexArray(); // interleaved [re,im, re,im …] length n_fft*2
  const output = fft.createComplexArray();
  const res    = { fft, input, output };
  _fftCache.set(n_fft, res);
  return res;
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------
self.addEventListener('message', function (e) {
  const {
    chunkIndex, channelData, sampleRate,
    n_fft = 1024, win_length, hop_length = 160,
    n_mels = 128, f_min = 0, f_max, top_db = 80,
  } = e.data;

  try {
    const { sxx, nMels, nFrames } = melSpectrogram(channelData, {
      sampleRate,
      n_fft,
      win_length: win_length || n_fft,
      hop_length,
      n_mels,
      f_min,
      f_max: f_max || sampleRate / 2,
      top_db,
    });
    self.postMessage({ chunkIndex, sxx, nMels, nFrames }, [sxx.buffer]);
  } catch (err) {
    self.postMessage({ chunkIndex, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DSP helpers
// ---------------------------------------------------------------------------

function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

function hzToMel(hz) { return 2595 * Math.log10(1 + hz / 700); }
function melToHz(mel) { return 700 * (Math.pow(10, mel / 2595) - 1); }

function buildSparseFilterbank({ sampleRate, n_fft, n_mels, f_min, f_max }) {
  const bins   = n_fft / 2 + 1;
  const melMin = hzToMel(f_min);
  const melMax = hzToMel(f_max);

  const melPts = new Float64Array(n_mels + 2);
  for (let i = 0; i < n_mels + 2; i++)
    melPts[i] = melMin + (i / (n_mels + 1)) * (melMax - melMin);
  const hzPts = melPts.map(m => melToHz(m));

  const binFreqs = new Float64Array(bins);
  for (let i = 0; i < bins; i++) binFreqs[i] = (i * sampleRate) / n_fft;

  const starts  = new Int32Array(n_mels);
  const ends    = new Int32Array(n_mels);
  const weights = [];

  for (let m = 1; m <= n_mels; m++) {
    const left   = hzPts[m - 1];
    const center = hzPts[m];
    const right  = hzPts[m + 1];

    let s = bins, e = 0;
    for (let k = 0; k < bins; k++) {
      const freq = binFreqs[k];
      if (freq >= left && freq <= right) { if (k < s) s = k; if (k > e) e = k; }
    }
    if (s > e) {
      starts[m - 1] = 0; ends[m - 1] = 0; weights.push(new Float32Array(0)); continue;
    }

    const w = new Float32Array(e - s + 1);
    for (let k = s; k <= e; k++) {
      const freq = binFreqs[k];
      if (freq >= left && freq <= center)      w[k - s] = (freq - left)  / (center - left);
      else if (freq > center && freq <= right) w[k - s] = (right - freq) / (right - center);
    }
    starts[m - 1] = s;
    ends[m - 1]   = e + 1; // exclusive
    weights.push(w);
  }

  return { starts, ends, weights };
}

function melSpectrogram(signal, { sampleRate, n_fft, win_length, hop_length, n_mels, f_min, f_max, top_db }) {
  const win = hannWindow(win_length);
  const fb  = buildSparseFilterbank({ sampleRate, n_fft, n_mels, f_min, f_max });
  const { fft, input, output } = getFFTResources(n_fft);

  const padLen = Math.floor(n_fft / 2);
  const padded = new Float32Array(signal.length + 2 * padLen);
  padded.set(signal, padLen);

  const nFrames = Math.floor((padded.length - n_fft) / hop_length) + 1;
  const pad     = Math.floor((n_fft - win_length) / 2);

  // Pass 1: mel power [nFrames × n_mels]
  const melPow = new Float32Array(nFrames * n_mels);

  for (let t = 0; t < nFrames; t++) {
    const start = t * hop_length;

    // Zero the interleaved input buffer and write windowed real samples
    input.fill(0);
    const copyLen = Math.min(win_length, padded.length - start);
    for (let i = 0; i < copyLen; i++) {
      input[(i + pad) * 2] = padded[start + i] * win[i]; // real part; imag stays 0
    }

    fft.transform(output, input);

    // Accumulate mel power from interleaved complex output
    const base = t * n_mels;
    for (let m = 0; m < n_mels; m++) {
      const s   = fb.starts[m];
      const e   = fb.ends[m];
      const w   = fb.weights[m];
      let   acc = 0;
      for (let k = s; k < e; k++) {
        const re  = output[k * 2];
        const im  = output[k * 2 + 1];
        acc += w[k - s] * (re * re + im * im);
      }
      melPow[base + m] = acc;
    }
  }

  // Pass 2: power → dB
  const REF    = 1e-10;
  const dbData = new Float32Array(nFrames * n_mels);
  let   dbMax  = -Infinity;
  for (let i = 0; i < nFrames * n_mels; i++) {
    const v = 10 * Math.log10(Math.max(melPow[i], REF));
    dbData[i] = v;
    if (v > dbMax) dbMax = v;
  }

  // Pass 3: clip + transpose to [n_mels × nFrames]
  const floor = dbMax - top_db;
  const sxx   = new Float32Array(n_mels * nFrames);
  for (let t = 0; t < nFrames; t++) {
    for (let m = 0; m < n_mels; m++) {
      sxx[m * nFrames + t] = Math.max(dbData[t * n_mels + m], floor);
    }
  }

  return { sxx, nMels: n_mels, nFrames };
}
