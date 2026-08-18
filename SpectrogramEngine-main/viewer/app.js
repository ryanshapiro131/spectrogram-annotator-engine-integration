// Throwaway test viewer for the spectrogram engine's tiled output.
//
// Reads manifest.json and renders spectrogram tiles onto a canvas inside a
// contained panel with a frequency axis (left) and a time-zoom slider (right).
// Zooming switches pyramid level (map-tile style); panning/zooming is pure tile
// lookup -- the engine never recomputes anything. All pixel <-> time/frequency
// mapping (including the log/linear frequency scale) comes from the manifest.
//
// Controls: drag = pan (time+freq), wheel = time zoom, Shift+wheel = freq zoom,
//           +/- = zoom one level, arrows = pan, Shift+up/down = freq pan, 0 = fit.

"use strict";

const els = {
  canvas: document.getElementById("spec"),
  axis: document.getElementById("axis"),
  src: document.getElementById("src"),
  load: document.getElementById("load"),
  reset: document.getElementById("reset"),
  rTime: document.getElementById("rTime"),
  rFreq: document.getElementById("rFreq"),
  badge: document.getElementById("badge"),
  err: document.getElementById("err"),
  zoom: document.getElementById("zoom"),
  zoomHandle: document.getElementById("zoomHandle"),
  windows: document.getElementById("windows"),
  res: document.getElementById("res"),
};
const ctx = els.canvas.getContext("2d", { alpha: false });
const actx = els.axis.getContext("2d");

// ---- state ----------------------------------------------------------------
let manifest = null;
let curWindow = null;             // the selected windows[] entry (per-window geometry)
let srcBase = "";                 // normalized, ends with "/"
const tileCache = new Map();      // "w/L/t" -> HTMLImageElement
// Time: startSec + secPerPx. Frequency: [vBot, vTop] in normalized [0,1] where
// v=0 is the bottom row (minFrequencyHz) and v=1 is the top row (maxFrequencyHz).
let view = { startSec: 0, secPerPx: 1, vTop: 1, vBot: 0 };
let cssW = 0, cssH = 0, axW = 0, dpr = 1;
let drawPending = false;

const MIN_VSPAN = 1 / 64;         // deepest frequency zoom (fraction of full axis)
const L0_MAX_PX = 8;              // one L0 column may stretch to at most this many px
const WHEEL_SENS = 0.0022;        // px of wheel delta -> zoom step
const WHEEL_CAP = 0.08;           // max zoom step per event (=> factor <= 1.08x)
const ZOOM_PAD = 12;              // slider handle inset (matches #zoomTrack CSS)

// ---- helpers --------------------------------------------------------------
function normSrc(s) {
  s = (s || "").trim();
  if (!s) s = "/out/chirp/";
  if (!s.endsWith("/")) s += "/";
  return s;
}
function fmtTime(sec) {
  if (!isFinite(sec)) return "—";
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60);
  return `${String(m).padStart(2, "0")}:${(sec - m * 60).toFixed(3).padStart(6, "0")}`;
}
function fmtFreq(hz) {
  if (!isFinite(hz)) return "—";
  return hz >= 1000 ? (hz / 1000).toFixed(2) + " kHz" : hz.toFixed(0) + " Hz";
}
function fmtTick(hz) {   // compact axis label
  if (hz >= 1000) { const k = hz / 1000; return (k >= 10 ? k.toFixed(0) : k.toFixed(1)) + "k"; }
  return Math.round(hz).toString();
}
function showError(msg) { els.err.style.display = "grid"; els.err.textContent = msg; }
function clearError() { els.err.style.display = "none"; }
function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

// ---- frequency axis mapping (frequencyScale is global; min/max are per-window) --
function isLog() { return manifest && manifest.frequencyScale === "log"; }
function fMinHz() { return isLog() ? Math.max(curWindow.minFrequencyHz, 1e-6) : curWindow.minFrequencyHz; }
function fMaxHz() { return curWindow.maxFrequencyHz; }
function vToFreq(v) {
  const lo = fMinHz(), hi = fMaxHz();
  return isLog() ? lo * Math.pow(hi / lo, v) : lo + v * (hi - lo);
}
function freqToV(f) {
  const lo = fMinHz(), hi = fMaxHz();
  return isLog() ? Math.log(Math.max(f, lo) / lo) / Math.log(hi / lo) : (f - lo) / (hi - lo);
}
function freqToY(f) { return (view.vTop - freqToV(f)) / (view.vTop - view.vBot) * cssH; }

// ---- manifest loading -----------------------------------------------------
async function loadManifest(src) {
  srcBase = normSrc(src);
  els.src.value = srcBase;
  try {
    const res = await fetch(srcBase + "manifest.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${srcBase}manifest.json`);
    manifest = await res.json();
  } catch (e) {
    manifest = null;
    showError(`Could not load ${srcBase}manifest.json\n\n${e.message}\n\n` +
      `Serve the project root over HTTP and pass ?src=/out/<name>/ , e.g.\n` +
      `  python3 -m http.server 8000\n  http://localhost:8000/viewer/?src=/out/gerygone/`);
    return;
  }
  normalizeManifest();          // v1 -> single-window v2 shim; pick default window
  clearError();
  tileCache.clear();
  buildWindowSelector();
  resize();          // establish cssW/cssH first (needed by fit + clamps)
  fitAll();
  applyViewParams(); // optional ?c=&spp=&vtop=&vbot=&window= deep-link
  afterViewChange();
}

// Accept both v2 (windows[]) and old v1 manifests. A v1 manifest is wrapped as a
// single window so old outputs still open. Sets curWindow to the default window.
function normalizeManifest() {
  if (!Array.isArray(manifest.windows)) {
    // v1: the per-spectrogram fields lived at the top level.
    manifest.windows = [{
      fftSize: manifest.fftSize,
      hopSize: manifest.hopSize,
      numFrequencyBins: manifest.numFrequencyBins,
      tileHeight: manifest.tileHeight,
      hzPerBin: manifest.hzPerBin,
      minFrequencyHz: manifest.minFrequencyHz,
      maxFrequencyHz: manifest.maxFrequencyHz,
      secondsPerColumn: manifest.levels[0].secondsPerColumn,
      levels: manifest.levels,
    }];
    manifest.defaultWindow = manifest.fftSize;
  }
  manifest.windows.sort((a, b) => a.fftSize - b.fftSize);
  const p = new URLSearchParams(location.search);
  const want = parseInt(p.get("window"), 10) || manifest.defaultWindow;
  curWindow = manifest.windows.find(w => w.fftSize === want) || manifest.windows[0];
}

function setWindow(n) {
  const w = manifest.windows.find(x => x.fftSize === n);
  if (!w || w === curWindow) return;
  curWindow = w;                 // view (startSec/secPerPx/vTop/vBot) is preserved
  tileCache.clear();             // tiles differ per window
  buildWindowSelector();
  clampView();                   // re-derives level selection + axis from this window
  afterViewChange();
}

function buildWindowSelector() {
  const box = els.windows;
  if (!box) return;
  if (manifest.windows.length < 2) { box.style.display = "none"; return; }
  box.style.display = "flex";
  box.innerHTML = "";
  for (const w of manifest.windows) {
    const b = document.createElement("button");
    b.textContent = String(w.fftSize);
    b.className = "wbtn" + (w === curWindow ? " on" : "");
    b.title = `${w.fftSize}-sample window`;
    b.addEventListener("click", () => setWindow(w.fftSize));
    box.appendChild(b);
  }
}

// Optional deep-link: c=<center seconds> spp=<sec/pixel> vtop/vbot=<0..1>
function applyViewParams() {
  const p = new URLSearchParams(location.search);
  const spp = parseFloat(p.get("spp"));
  const c = parseFloat(p.get("c"));
  const vt = parseFloat(p.get("vtop"));
  const vb = parseFloat(p.get("vbot"));
  if (isFinite(spp)) view.secPerPx = spp;
  clampView();
  if (isFinite(c)) view.startSec = c - (cssW * view.secPerPx) / 2;
  if (isFinite(vt)) view.vTop = vt;
  if (isFinite(vb)) view.vBot = vb;
  clampView();
}

// levels[] are emitted in order (per the currently selected window)
function level0() { return curWindow.levels[0]; }
function maxLevel() { return curWindow.levels[curWindow.levels.length - 1].level; }
function levelByIndex(L) { return curWindow.levels[L]; }

// ---- time zoom range + fitting --------------------------------------------
// Zoomed-out limit = whole file fits the panel; zoomed-in limit caps one L0
// column at L0_MAX_PX screen pixels (no real detail exists past L0).
function zoomRange() {
  const dur = manifest.durationSeconds;
  const spc0 = level0().secondsPerColumn;
  const maxSPP = Math.max(dur / Math.max(1, cssW), 1e-9);
  const minSPP = Math.min(spc0 / L0_MAX_PX, maxSPP);
  return { minSPP, maxSPP };
}

function fitAll() {
  view.secPerPx = manifest.durationSeconds / Math.max(1, cssW);
  view.startSec = 0;
  view.vTop = 1;
  view.vBot = 0;
  clampView();
}

function clampView() {
  const { minSPP, maxSPP } = zoomRange();
  view.secPerPx = clamp(view.secPerPx, minSPP, maxSPP);
  const visibleSec = view.secPerPx * cssW;
  view.startSec = clamp(view.startSec, 0, Math.max(0, manifest.durationSeconds - visibleSec));
  clampVertical();
}

function clampVertical() {
  const span = clamp(view.vTop - view.vBot, MIN_VSPAN, 1);
  let top = Math.min(1, view.vTop);
  let bot = top - span;
  if (bot < 0) { bot = 0; top = Math.min(1, span); }
  view.vTop = top; view.vBot = bot;
}

// pick the pyramid level whose columns are ~1 screen pixel wide
function pickLevel() {
  const spc0 = level0().secondsPerColumn;
  return clamp(Math.round(Math.log2(view.secPerPx / spc0)), 0, maxLevel());
}

// ---- zooming (shared by wheel, keyboard, slider) --------------------------
function timeAtX(x) { return view.startSec + x * view.secPerPx; }

function zoomTime(factor, anchorX) {
  const tUnder = timeAtX(anchorX);
  view.secPerPx *= factor;
  clampView();
  view.startSec = tUnder - anchorX * view.secPerPx;   // keep time under cursor fixed
  clampView();
}

function zoomFreq(factor, anchorY) {
  const span = view.vTop - view.vBot;
  const fracTop = anchorY / cssH;
  const vUnder = view.vTop - fracTop * span;
  const newSpan = clamp(span * factor, MIN_VSPAN, 1);
  view.vTop = vUnder + fracTop * newSpan;
  view.vBot = view.vTop - newSpan;
  clampVertical();
}

// Normalise wheel/trackpad input: many small trackpad events vs few large mouse
// events. Convert to px, then a small capped zoom step so nothing jumps a level.
function wheelZoomFactor(e) {
  let dy = e.deltaY;
  if (e.deltaMode === 1) dy *= 16;          // lines -> px
  else if (e.deltaMode === 2) dy *= cssH;   // pages -> px
  const step = Math.min(Math.abs(dy) * WHEEL_SENS, WHEEL_CAP);
  const factor = 1 + step;
  return dy > 0 ? factor : 1 / factor;      // scroll down = zoom out
}

// ---- tiles ----------------------------------------------------------------
function tilePath(L, t) {
  // {window} is present in v2 templates; a no-op replace for v1.
  return srcBase + manifest.tilePathPattern
    .replace("{window}", curWindow.fftSize).replace("{level}", L).replace("{tile}", t);
}
function getTile(L, t) {
  const key = curWindow.fftSize + "/" + L + "/" + t;
  let img = tileCache.get(key);
  if (img) return img;
  img = new Image();
  img.onload = scheduleDraw;
  img.onerror = () => {};
  img.src = tilePath(L, t);
  tileCache.set(key, img);
  return img;
}

// ---- drawing --------------------------------------------------------------
function scheduleDraw() {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(() => { drawPending = false; draw(); });
}

function draw() {
  if (!manifest) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, cssW, cssH);

  const L = pickLevel();
  const lvl = levelByIndex(L);
  const spc = lvl.secondsPerColumn;
  const tileW = manifest.tileWidth;
  const tileH = curWindow.tileHeight;   // per-window (== numFrequencyBins)
  const numCols = lvl.numColumns;
  const numTiles = lvl.numTiles;

  // Vertical source rows (reuses full-height tiles): row 0 = top (v=1).
  const srcYtop = (1 - view.vTop) * (tileH - 1);
  const srcYbot = (1 - view.vBot) * (tileH - 1);
  const srcH = Math.max(1, srcYbot - srcYtop);

  // Smooth (bilinear) only when upscaling past native detail; keep nearest at or
  // below native so real detail stays crisp.
  const horizScale = spc / view.secPerPx;   // screen px per column
  const vertScale = cssH / srcH;            // screen px per source row
  ctx.imageSmoothingEnabled = horizScale > 1.5 || vertScale > 1.5;

  const colToX = (col) => (col * spc - view.startSec) / view.secPerPx;
  const cStart = view.startSec / spc;
  const cEnd = (view.startSec + cssW * view.secPerPx) / spc;
  const tStart = Math.max(0, Math.floor(cStart / tileW));
  const tEnd = Math.min(numTiles - 1, Math.floor((cEnd - 1e-9) / tileW));

  for (let t = tStart; t <= tEnd; t++) {
    const colLeft = t * tileW;
    const wActual = Math.min(tileW, numCols - colLeft);
    // Rounded shared boundaries: tile t's right edge == tile t+1's left edge.
    const x0 = Math.round(colToX(colLeft));
    const x1 = Math.round(colToX(colLeft + wActual));
    const w = x1 - x0;
    if (w <= 0) continue;
    const img = getTile(L, t);
    if (img.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, 0, srcYtop, wActual, srcH, x0, 0, w, cssH);
    }
  }

  els.badge.textContent =
    `level L${L}/${maxLevel()}  ·  ${(view.secPerPx * 1000).toFixed(2)} ms/px  ·  ` +
    `${spc.toFixed(4)} s/col  ·  view ${fmtTime(view.startSec)}–${fmtTime(view.startSec + cssW * view.secPerPx)}`;

  // What this window means (biologists need to know what they're looking at):
  // primary = the window's intrinsic time smearing + frequency bin width.
  if (els.res) {
    const winMs = (curWindow.fftSize / manifest.sampleRate) * 1000;
    els.res.textContent =
      `${curWindow.fftSize} samples: ${winMs.toFixed(1)} ms window · ${curWindow.hzPerBin.toFixed(1)} Hz/bin`;
    els.res.title = `on screen now: ${(view.secPerPx * 1000).toFixed(1)} ms/pixel at this zoom`;
  }

  drawAxis();
}

// ---- frequency axis (left gutter), scale-aware ----------------------------
function niceStep(rough) {
  const p = Math.pow(10, Math.floor(Math.log10(rough)));
  const n = rough / p;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
}
function linearTicks(lo, hi, target) {
  const step = niceStep((hi - lo) / target);
  const out = [];
  for (let f = Math.ceil(lo / step) * step; f <= hi + 1e-6; f += step) out.push(f);
  return out;
}
function logTicks(lo, hi) {
  const out = [];
  for (let e = Math.floor(Math.log10(Math.max(lo, 1e-6))); e <= Math.ceil(Math.log10(hi)); e++) {
    for (const m of [1, 2, 5]) {
      const f = m * Math.pow(10, e);
      if (f >= lo && f <= hi) out.push(f);
    }
  }
  return out;
}
function computeTicks(lo, hi) {
  if (isLog()) {
    let t = logTicks(lo, hi);
    if (t.length < 3) t = linearTicks(lo, hi, 5);          // narrow band -> ~linear
    else if (t.length > 12) t = t.filter(f => {            // wide -> decades only
      const l = Math.log10(f); return Math.abs(l - Math.round(l)) < 1e-6;
    });
    return t;
  }
  return linearTicks(lo, hi, Math.max(4, Math.min(9, Math.round(cssH / 55))));
}

function drawAxis() {
  actx.setTransform(dpr, 0, 0, dpr, 0, 0);
  actx.fillStyle = "#0c0c0c";
  actx.fillRect(0, 0, axW, cssH);
  actx.strokeStyle = "#333";
  actx.lineWidth = 1;
  actx.beginPath(); actx.moveTo(axW - 0.5, 0); actx.lineTo(axW - 0.5, cssH); actx.stroke();

  const fBot = vToFreq(view.vBot), fTop = vToFreq(view.vTop);
  const ticks = computeTicks(fBot, fTop);
  actx.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
  actx.textAlign = "right";
  actx.textBaseline = "middle";
  for (const f of ticks) {
    const y = freqToY(f);
    if (y < 7 || y > cssH - 7) continue;
    actx.strokeStyle = "#4a4a4a";
    actx.beginPath(); actx.moveTo(axW - 6, y + 0.5); actx.lineTo(axW, y + 0.5); actx.stroke();
    actx.fillStyle = "#c4c4c4";
    actx.fillText(fmtTick(f), axW - 9, y);
  }
  // unit hint
  actx.fillStyle = "#666";
  actx.textAlign = "left";
  actx.textBaseline = "top";
  actx.fillText(isLog() ? "Hz·log" : "Hz", 4, 4);
}

// ---- zoom slider (right edge) ---------------------------------------------
function sToHandleTopPx(s) { return ZOOM_PAD + (1 - s) * (cssH - 2 * ZOOM_PAD); }
function sppToSliderS(spp) {
  const { minSPP, maxSPP } = zoomRange();
  if (maxSPP <= minSPP) return 1;
  return clamp(Math.log(spp / maxSPP) / Math.log(minSPP / maxSPP), 0, 1);
}
function sliderSToSpp(s) {
  const { minSPP, maxSPP } = zoomRange();
  return maxSPP * Math.pow(minSPP / maxSPP, clamp(s, 0, 1));
}
function updateSlider() {
  els.zoomHandle.style.top = sToHandleTopPx(sppToSliderS(view.secPerPx)) + "px";
}

// Everything that changes the view funnels through here to stay in sync.
function afterViewChange() { scheduleDraw(); updateSlider(); }

// ---- interaction ----------------------------------------------------------
function freqAtY(y) {
  return vToFreq(view.vTop - (y / cssH) * (view.vTop - view.vBot));
}

let dragging = false, lastX = 0, lastY = 0;
els.canvas.addEventListener("mousedown", (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
window.addEventListener("mouseup", () => { dragging = false; sliderDrag = false; });
window.addEventListener("mousemove", (e) => {
  if (!manifest) return;
  if (sliderDrag) { setSliderFromClientY(e.clientY); return; }
  const rect = els.canvas.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  if (dragging) {
    // 1:1 pan in both axes; content follows the cursor exactly
    view.startSec -= (e.clientX - lastX) * view.secPerPx;
    const dv = ((e.clientY - lastY) / cssH) * (view.vTop - view.vBot);
    view.vTop += dv; view.vBot += dv;
    lastX = e.clientX; lastY = e.clientY;
    clampView();
    afterViewChange();
  }
  if (x >= 0 && x <= cssW && y >= 0 && y <= cssH) {
    els.rTime.textContent = fmtTime(timeAtX(x));
    els.rFreq.textContent = fmtFreq(freqAtY(y));
  }
});

els.canvas.addEventListener("wheel", (e) => {
  if (!manifest) return;
  e.preventDefault();
  const rect = els.canvas.getBoundingClientRect();
  const factor = wheelZoomFactor(e);
  if (e.shiftKey) zoomFreq(factor, e.clientY - rect.top);
  else zoomTime(factor, e.clientX - rect.left);
  afterViewChange();
}, { passive: false });

// slider drag
let sliderDrag = false;
function setSliderFromClientY(clientY) {
  const r = els.zoom.getBoundingClientRect();
  const frac = clamp((clientY - r.top - ZOOM_PAD) / Math.max(1, r.height - 2 * ZOOM_PAD), 0, 1);
  const s = 1 - frac;   // top = zoomed in
  const cx = cssW / 2, tUnder = timeAtX(cx);
  view.secPerPx = sliderSToSpp(s);
  clampView();
  view.startSec = tUnder - cx * view.secPerPx;   // zoom about the panel centre
  clampView();
  afterViewChange();
}
els.zoom.addEventListener("mousedown", (e) => {
  if (!manifest) return;
  sliderDrag = true; setSliderFromClientY(e.clientY); e.preventDefault();
});

// keyboard
window.addEventListener("keydown", (e) => {
  if (!manifest || document.activeElement === els.src) return;
  const visSec = cssW * view.secPerPx;
  switch (e.key) {
    case "+": case "=": zoomTime(0.5, cssW / 2); afterViewChange(); e.preventDefault(); break;
    case "-": case "_": zoomTime(2.0, cssW / 2); afterViewChange(); e.preventDefault(); break;
    case "ArrowLeft":  view.startSec -= visSec * 0.2; clampView(); afterViewChange(); e.preventDefault(); break;
    case "ArrowRight": view.startSec += visSec * 0.2; clampView(); afterViewChange(); e.preventDefault(); break;
    case "ArrowUp":   if (e.shiftKey) { panFreq(+1); e.preventDefault(); } break;
    case "ArrowDown": if (e.shiftKey) { panFreq(-1); e.preventDefault(); } break;
    case "0": fitAll(); afterViewChange(); e.preventDefault(); break;
  }
});
function panFreq(dir) {
  const span = view.vTop - view.vBot;
  const dv = dir * 0.2 * span;
  view.vTop += dv; view.vBot += dv;
  clampVertical();
  afterViewChange();
}

els.reset.addEventListener("click", () => { fitAll(); afterViewChange(); });
els.load.addEventListener("click", () => loadManifest(els.src.value));
els.src.addEventListener("keydown", (e) => { if (e.key === "Enter") loadManifest(els.src.value); });

// ---- sizing ---------------------------------------------------------------
function resize() {
  dpr = window.devicePixelRatio || 1;
  cssW = els.canvas.clientWidth;
  cssH = els.canvas.clientHeight;
  axW = els.axis.clientWidth;
  els.canvas.width = Math.round(cssW * dpr);
  els.canvas.height = Math.round(cssH * dpr);
  els.axis.width = Math.round(axW * dpr);
  els.axis.height = Math.round(cssH * dpr);   // same height as spectrogram
  if (manifest) { clampView(); afterViewChange(); }
}
window.addEventListener("resize", resize);

// ---- boot -----------------------------------------------------------------
(function boot() {
  const params = new URLSearchParams(location.search);
  const src = params.get("src") || "/out/chirp/";
  resize();
  loadManifest(src);
})();
