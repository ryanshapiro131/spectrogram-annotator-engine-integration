// Every call to the annotation server goes through here, so the session
// token is attached in one place and an expired/invalid session (401) sends
// the user back to the login page from anywhere in the app.
//
// /tiles/... is the exception: tiles are plain public static files fetched
// directly by TileSpectrogramViewer (see the note in server.py).
import { SERVER } from './config';

const TOKEN_KEY = 'spectrogram-annotator.session';
let memoryToken = null; // fallback when localStorage is unavailable

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || memoryToken;
  } catch {
    return memoryToken;
  }
}

export function setToken(token) {
  memoryToken = token || null;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode etc.: memoryToken still works for this tab */ }
}

// Set by AuthProvider so a 401 can navigate within the SPA; falls back to a
// full page load.
let unauthorizedHandler = null;
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

function handleUnauthorized() {
  setToken(null);
  if (unauthorizedHandler) unauthorizedHandler();
  else window.location.assign('/login');
}

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// FastAPI errors: { detail: "text" } or, for validation, { detail: [{ msg }] }.
function detailOf(body) {
  const d = body?.detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) return d.map(e => e.msg).filter(Boolean).join('; ');
  return null;
}

export function apiUrl(path) {
  return /^https?:/.test(path) ? path : `${SERVER}${path}`;
}

function authHeaders(headers) {
  const h = new Headers(headers);
  const token = getToken();
  if (token) h.set('Authorization', `Bearer ${token}`);
  return h;
}

/**
 * fetch() against the API with the session token attached. Returns the
 * Response. Options beyond fetch's own:
 *   json            request body to send as JSON
 *   redirectOn401   default true; false for the sign-in calls themselves
 */
export async function apiFetch(path, { json, redirectOn401 = true, headers, ...init } = {}) {
  const h = authHeaders(headers);
  let body = init.body;
  if (json !== undefined) {
    h.set('Content-Type', 'application/json');
    body = JSON.stringify(json);
  }
  const res = await fetch(apiUrl(path), { ...init, headers: h, body });
  if (res.status === 401 && redirectOn401) handleUnauthorized();
  return res;
}

/** Like apiFetch, but parses the JSON reply and throws ApiError on failure. */
export async function apiJson(path, options) {
  let res;
  try {
    res = await apiFetch(path, options);
  } catch {
    throw new ApiError(0, `Can't reach the server at ${SERVER}. Is it running?`);
  }
  if (res.status === 204) return null;
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, detailOf(body) || `Request failed (HTTP ${res.status}).`, body);
  return body;
}

/**
 * POST a FormData body with upload progress (fetch can't report it).
 * onProgress gets { fraction, loaded, total, bytesPerSec, etaSec }, with speed
 * averaged over the last ~5 s; onSent fires once every byte is out and the
 * server starts processing.
 */
export function apiUpload(path, body, { onProgress, onSent } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl(path));
    xhr.responseType = 'json';
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    const samples = [];
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable || !onProgress) return;
      const now = performance.now();
      samples.push([now, e.loaded]);
      while (samples.length > 2 && now - samples[0][0] > 5000) samples.shift();
      const [t0, b0] = samples[0];
      const bytesPerSec = now - t0 > 1000 ? (e.loaded - b0) / ((now - t0) / 1000) : null;
      onProgress({
        fraction: e.loaded / e.total,
        loaded: e.loaded,
        total: e.total,
        bytesPerSec,
        etaSec: bytesPerSec ? (e.total - e.loaded) / bytesPerSec : null,
      });
    };
    if (onSent) xhr.upload.onload = onSent;
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve(xhr.response);
      if (xhr.status === 401) handleUnauthorized();
      reject(new ApiError(xhr.status, detailOf(xhr.response) || `Upload failed (HTTP ${xhr.status}).`, xhr.response));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Upload failed: the connection to the server was lost.'));
    xhr.send(body);
  });
}
