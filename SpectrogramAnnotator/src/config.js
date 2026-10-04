// Base URL of the annotation server (FastAPI, port 8000).
//
// Override with VITE_API_URL (e.g. in .env.local) to point the frontend at a
// specific backend. Otherwise, use the same host the page was loaded from, so
// http://localhost:5173 talks to localhost:8000 and
// http://152.20.12.219:5173 talks to 152.20.12.219:8000.
export const SERVER =
  import.meta.env.VITE_API_URL ||
  `${window.location.protocol}//${window.location.hostname}:8000`;
