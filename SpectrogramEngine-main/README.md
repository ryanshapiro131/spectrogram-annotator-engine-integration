# Spectrogram Engine

A standalone **C++ engine** that turns an audio file into spectrogram image
**tiles** on disk, so that even a multi-hour recording can be displayed and
zoomed **instantly** in a browser (panning/zooming just fetches pre-made tiles,
like map tiles — nothing is recomputed). It decodes WAV/MP3/FLAC, computes the
spectrogram in parallel, and streams the work in **bounded memory**.

This is **just the engine** plus a small throwaway viewer for checking its
output. It is *not* the annotation UI — that is a separate product built by
someone else; this module only produces the tiles + a `manifest.json` it reads.

---

## Requirements

You need three things installed (macOS one-line installs shown):

| Need           | Check           | Install (macOS)          |
|----------------|-----------------|--------------------------|
| C++17 compiler | `clang++ -v`    | `xcode-select --install` |
| CMake ≥ 3.15   | `cmake --version` | `brew install cmake`   |
| Python 3       | `python3 --version` | usually present; else `brew install python` |

Nothing else is needed — **all C/C++ libraries are vendored** in `third_party/`
(no package manager, no network at build time).

---

## Try it yourself

Go from clone to a spectrogram in three commands.

**1. Clone and enter the repo**
```bash
git clone <repo-url> SpectrogramEngine && cd SpectrogramEngine
```

**2. Process an audio file** (WAV, MP3, or FLAC)
```bash
./run.sh path/to/your/audio.wav
```
This builds the engine the first time (a few seconds), generates the tiles into
`out/<filename>/`, writes a metrics report, and starts a local web server.
*You should see* a metrics table printed, ending with a line like:
```
Open: http://localhost:8000/viewer/?src=/out/audio/
```
> No audio handy? Make a 10-second test tone first:
> `python3 tools/make_test_audio.py sine --dur 10` → then `./run.sh test-audio/sine.wav`

**3. Open the printed URL** in a browser.
*You should see* the spectrogram (time left→right, frequency bottom→top, brighter =
louder). Controls:
- **drag** = pan · **scroll** = zoom in/out (time) · **Shift+scroll** = zoom frequency
- **+ / −** = zoom one level · **← / →** = pan · **Shift+↑ / ↓** = pan frequency · **0** = fit whole file
- hover shows the exact time and frequency; the left axis is labelled in Hz/kHz.
- if the run built more than one window, **window buttons** in the toolbar switch
  between them (the current time and zoom are kept); a readout shows the active
  window's length in ms and its Hz/bin.

**4. The metrics report** for that run is saved as `metrics.txt` inside the output
folder that `run.sh` printed (e.g. `out/audio/metrics.txt`) — the same plain table
that was printed to the console. (Spaces in a filename become underscores in the
folder name; the exact path is always in the printed `Open:` line.)

---

## What a run produces

```
out/<filename>/
  manifest.json     the "contract": everything a UI needs to render + map pixels<->time/freq
  metrics.txt       plain-language timing/size report for this run
  w1024/L0/*.png     tiles for the 1024-sample window; L1, L2, ... are zoomed-out levels
  w4096/L0/*.png     tiles for the 4096-sample window (the default builds both)
```

The engine precomputes **one full pyramid per requested FFT window size** (default
`1024,4096`) into its own `w<N>/` folder. The viewer's window buttons then switch
between them as a pure tile-path swap — no recomputation on toggle. A larger window
gives finer frequency resolution but coarser time resolution; a smaller one, the
reverse. Request any set with `--window-sizes` (see below).

---

## Command-line reference

`run.sh` covers the common case. For direct control:

```bash
build/spectrogram-engine <audiofile> <outdir> [options]
```

| Flag                  | Meaning                                             | Default     |
|-----------------------|-----------------------------------------------------|-------------|
| `--threads N`         | worker threads (`0` = all CPU cores)                | `0`         |
| `--window-sizes L`    | comma list of FFT window sizes (pow2, 256…8192)     | `1024,4096` |
| `--overlap F`         | window overlap fraction, `0`…`<1` (`hop=N*(1-F)`)   | `0.5`       |
| `--hop N`             | explicit hop in samples (single window only)        | from overlap|
| `--fft N`             | **deprecated** alias for `--window-sizes N`         | —           |
| `--tile-width N`      | tile width in columns/pixels                        | `512`       |
| `--db-min X`          | dB mapped to the darkest color                      | `-100`      |
| `--db-max X`          | dB mapped to the brightest color                    | `0`         |
| `--freq-scale S`      | frequency axis: `linear` or `log`                   | `linear`    |
| `--chunk N`           | streaming block size in columns (memory knob)       | `8192`      |
| `--embed-diagnostics` | also embed detailed timings inside `manifest.json`  | off         |
| `--no-stream`         | load the whole file into RAM (reference path)       | off         |
| `--preview`           | with `--no-stream`, also write `preview.png`        | off         |

Notes: the first window in `--window-sizes` becomes the manifest's `defaultWindow`
(what the viewer opens on). `--overlap` sets the hop for **every** window
(`hop = round(N*(1-overlap))`); `--hop` overrides it but is rejected when more than
one window is requested (one sample count can't be right for every window). Windows
above `8192` are rejected.

Examples:
```bash
# default: 1024- and 4096-sample windows, both pyramids
build/spectrogram-engine song.mp3 out/song

# three windows, 75% overlap, log-frequency axis
build/spectrogram-engine song.mp3 out/song --window-sizes 512,2048,8192 --overlap 0.75 --freq-scale log

# single window, explicit hop
build/spectrogram-engine song.mp3 out/song --window-sizes 2048 --hop 256
```

---

## manifest.json — the integration contract

`manifest.json` is what makes the engine reusable: any UI can render and navigate
the tiles from this file alone, without reading the engine's code.

Since each run can build several FFT windows, the manifest is **version 2**: fields
shared by all windows stay at the top level, and everything that differs per window
(FFT size, hop, frequency binning, pyramid levels) lives inside a `windows[]` array.

```jsonc
{
  "version": 2,
  "generator": "spectrogram-engine",

  // ---- shared by every window ----
  "sampleRate": 44100,          // Hz
  "totalSamples": 2646000,      // mono samples
  "durationSeconds": 60.0,
  "channels": 1,                // source channels (engine mixes to mono)
  "dbRange": { "min": -100.0, "max": 0.0 },   // dB mapped across the colormap
  "colormap": "magma",
  "frequencyScale": "linear",   // "linear" | "log" (how rows map to frequency)
  "tileWidth": 512,             // nominal tile width in columns/pixels
  "tilePathPattern": "w{window}/L{level}/{tile}.png",
  "lastTileMayBePartial": true, // last tile of a level may be < tileWidth
  "columnTimeConvention":
    "timeSeconds = columnIndex * secondsPerColumn (column = window starting at columnIndex*hopSize)",
  "defaultWindow": 1024,        // which windows[].fftSize a viewer should open on

  // ---- one entry per requested FFT window size ----
  "windows": [
    {
      "fftSize": 1024,
      "hopSize": 512,
      "windowType": "hann",
      "numFrequencyBins": 513,      // == fftSize/2 + 1 == tileHeight
      "tileHeight": 513,            // full frequency height
      "hzPerBin": 43.06640625,      // freqOfBin = bin * hzPerBin
      "secondsPerColumn": 0.01161,  // level-0 native (hopSize/sampleRate)
      "minFrequencyHz": 0.0,        // bottom row (0 for linear; bin-1 freq for log)
      "maxFrequencyHz": 22050.0,    // top row (Nyquist = sampleRate/2)
      // Level 0 = full detail. Each higher level halves the time axis (max-pool by 2),
      // so secondsPerColumn doubles each level. Frequency resolution is unchanged.
      "levels": [
        { "level": 0, "numColumns": 5168, "secondsPerColumn": 0.01161, "numTiles": 11, "widthPixels": 5168, "heightPixels": 513 },
        { "level": 1, "numColumns": 2584, "secondsPerColumn": 0.02322, "numTiles": 6,  "widthPixels": 2584, "heightPixels": 513 }
      ]
    },
    {
      "fftSize": 4096,
      "hopSize": 2048,
      "windowType": "hann",
      "numFrequencyBins": 2049,
      "tileHeight": 2049,
      "hzPerBin": 10.7666015625,
      "secondsPerColumn": 0.04644,
      "minFrequencyHz": 0.0,
      "maxFrequencyHz": 22050.0,
      "levels": [
        { "level": 0, "numColumns": 1292, "secondsPerColumn": 0.04644, "numTiles": 3, "widthPixels": 1292, "heightPixels": 2049 }
      ]
    }
  ]
}
```

**Consuming it (the mapping a UI needs).** Pick a window `w` from `windows[]` (start
with the one whose `fftSize == defaultWindow`), then within it a level `lv`:
- Tile path: substitute into `tilePathPattern` — `w{window}` = `w.fftSize`,
  `L{level}` = `lv.level`, `{tile}` = tile index. Tile `t` holds columns
  `[t*tileWidth, t*tileWidth + cols)` with `cols = min(tileWidth, lv.numColumns - t*tileWidth)`.
- **x-pixel → time:** `time = columnIndex * lv.secondsPerColumn`.
- **y-pixel → frequency:** row 0 = top = highest frequency. With `v = 1 - row/(w.tileHeight-1)`:
  linear → `freq = w.minFrequencyHz + v*(w.maxFrequencyHz-w.minFrequencyHz)`;
  log → `freq = w.minFrequencyHz * (w.maxFrequencyHz/w.minFrequencyHz)^v`.
- **zoom → level:** pick the level whose `secondsPerColumn` best matches your target
  seconds-per-screen-pixel (`level ≈ round(log2(secPerPixel / lv0.secondsPerColumn))`).
- **switching window:** swap the tile source to the other window's `w{fftSize}/` and
  **re-derive the frequency axis** from its `minFrequencyHz`/`maxFrequencyHz`/`tileHeight`
  (bin width changes). Keep the current time range — no recomputation is involved.

> **v1 → v2 change (additive).** v1 was single-window: the STFT/frequency/`levels`
> fields sat at the top level and tiles lived in `tiles/L{level}/`. v2 moves exactly
> those per-window fields into `windows[]` (one entry, for a single-window run),
> adds `channels` and `defaultWindow`, and changes `tilePathPattern` to include
> `w{window}`. Everything else keeps its v1 name and meaning. A v1 reader can be
> upgraded by treating a v1 manifest as a one-element `windows[]`.

> `metrics.txt` and the optional per-window `--embed-diagnostics` block are
> informational and may vary run to run; the fields above are the stable contract.

---

## Design notes

- **Permissive licenses only** (no GPL, no FFTW). Vendored, single-header where
  possible: `pffft` (FFT, BSD-style), `dr_wav`/`dr_mp3`/`dr_flac` (decode, public
  domain), `stb_image_write` (PNG, public domain), `nlohmann/json` (manifest, MIT).
- **Precompute to tiles, once.** A multi-resolution pyramid is built (each level
  halves the time axis via per-bin max-pooling) and cut into fixed-size PNG tiles.
  Zoom/pan in a UI is then a pure tile fetch — never a recomputation.
- **Bounded-memory streaming (default).** The file is decoded incrementally and
  processed in blocks; tiles are encoded and freed as they complete, so peak memory
  is bounded by the largest FFT window (× the streaming chunk), **not** the file
  duration. At the default `1024,4096` set the 4096 window sets the peak: a 75-minute
  and a 2-hour recording both top out around 620 MB. `--no-stream` is a whole-file
  reference path that produces **byte-identical** tiles + manifest.
- **Parallel across CPU cores** (`std::thread`, no OpenMP). Output is deterministic:
  multi-threaded and single-threaded results are byte-for-byte identical.
- **Selectable FFT windows, precomputed not recomputed.** Each requested window size
  gets its own pyramid under `w<N>/`; the windows are processed sequentially so peak
  memory is set by the largest one, not their sum. The viewer's window toggle is a
  pure tile-path switch — the time/frequency trade-off is chosen by picking a
  precomputed window, never by re-running the STFT.
- **One PNG tile pyramid per window + one manifest.** PNGs are universally viewable
  and cache well; the single `manifest.json` (with its `windows[]`) is the whole
  contract, so the output is self-describing and needs no engine code to consume.

## Repo layout

```
run.sh              one-command build + generate + serve
src/engine/         libspectrogram: decode, STFT, pyramid, tiling, streaming, manifest
src/cli/            spectrogram-engine (thin CLI)
third_party/        vendored dependencies (committed)
viewer/             throwaway web viewer (index.html + app.js)
tools/              make_test_audio.py, verify_tiles.py, verify_spectrogram.py
out/                generated output (git-ignored)
```

## Verifying correctness (optional)

Synthetic signals with known answers (standard-library Python only):

```bash
python3 tools/make_test_audio.py chirp --f0 500 --f1 15000 --dur 60   # rising tone
./run.sh test-audio/chirp.wav
python3 tools/verify_tiles.py out/chirp --expect-sweep 500 15000      # numeric check, all levels
```
Expected: a clean diagonal that tracks the sweep at every zoom level, with no seams
at tile boundaries. (`make_test_audio.py sine` and `silence` give a flat horizontal
line and a uniform floor for the same kind of check.)
