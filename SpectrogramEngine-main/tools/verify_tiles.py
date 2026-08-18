#!/usr/bin/env python3
"""Manifest-aware correctness check for the tiled pyramid (stdlib only).

For each pyramid level in manifest.json this:
  * loads the level's tiles and stitches them horizontally into one image,
  * checks tile geometry against the manifest (heights == tileHeight, widths sum
    to numColumns, last tile partial) -- a mismatch would mean a seam/gap,
  * finds the peak-energy frequency per column and validates it against the
    expected signal, using the manifest's own pixel<->time/freq mapping,
  * checks continuity across every internal tile boundary (the seam test),
  * optionally writes the stitched level image for visual inspection.

Because higher levels are built by time max-pooling, a rising chirp becomes a
diagonal *band* (each coarse column summarizes the sweep over its time span), so
the chirp check validates that each column's peak lies within the band the chirp
actually sweeps during that column -- the correct invariant for max-pooling. A
constant tone stays a thin line at every level.

Usage:
  python3 tools/verify_tiles.py out/sine  --expect-const 5000
  python3 tools/verify_tiles.py out/chirp --expect-sweep 500 15000
  python3 tools/verify_tiles.py out/chirp --expect-sweep 500 15000 --stitch-dir /tmp/st
"""

import argparse
import json
import os
import sys

from pnglite import read_png_rgb, write_png_rgb

GLOBAL_REQUIRED = ["sampleRate", "durationSeconds", "colormap", "dbRange",
                   "frequencyScale", "tileWidth"]
WINDOW_REQUIRED = ["fftSize", "hopSize", "numFrequencyBins", "tileHeight",
                   "hzPerBin", "secondsPerColumn", "minFrequencyHz",
                   "maxFrequencyHz", "levels"]


def windows_of(m):
    """Return the windows list (v2), or wrap a v1 manifest as one window. Each
    window dict gains 'subdir' (tile root) and 'frequencyScale' (global)."""
    scale = m.get("frequencyScale", "linear")
    if isinstance(m.get("windows"), list):
        out = []
        for w in m["windows"]:
            w = dict(w)
            w["subdir"] = f"w{w['fftSize']}"
            w["frequencyScale"] = scale
            out.append(w)
        return out
    w = {k: m.get(k) for k in WINDOW_REQUIRED if k in m}   # v1: fields at top level
    if "levels" in m and m["levels"]:
        w["secondsPerColumn"] = m["levels"][0]["secondsPerColumn"]
    w["subdir"] = "tiles"
    w["frequencyScale"] = scale
    return [w]


def check_manifest_consistency(m):
    """Return a list of problems (empty == consistent)."""
    problems = [f"missing global field: {k}" for k in GLOBAL_REQUIRED if k not in m]
    for w in windows_of(m):
        tag = f"w{w.get('fftSize', '?')}"
        missing = [k for k in WINDOW_REQUIRED if k not in w or w[k] is None]
        if missing:
            problems.append(f"{tag}: missing {missing}")
            continue
        num_bins = w["fftSize"] // 2 + 1
        if w["numFrequencyBins"] != num_bins:
            problems.append(f"{tag}: numFrequencyBins {w['numFrequencyBins']} != {num_bins}")
        if w["tileHeight"] != w["numFrequencyBins"]:
            problems.append(f"{tag}: tileHeight != numFrequencyBins")
        if abs(w["maxFrequencyHz"] - m["sampleRate"] / 2.0) > 1e-6:
            problems.append(f"{tag}: maxFrequencyHz != sampleRate/2")
        if abs(w["hzPerBin"] - m["sampleRate"] / w["fftSize"]) > 1e-6:
            problems.append(f"{tag}: hzPerBin inconsistent with sampleRate/fftSize")
        spc0 = w["hopSize"] / m["sampleRate"]
        for lv in w["levels"]:
            if abs(lv["secondsPerColumn"] - spc0 * (2 ** lv["level"])) > 1e-9:
                problems.append(f"{tag} L{lv['level']}: secondsPerColumn mismatch")
            if lv["numTiles"] != (lv["numColumns"] + m["tileWidth"] - 1) // m["tileWidth"]:
                problems.append(f"{tag} L{lv['level']}: numTiles mismatch")
    return problems


def stitch_level(outdir, m, win, lv):
    """Load + horizontally stitch a level's tiles. Returns (width, height, rows, problems)."""
    level, num_tiles, num_cols = lv["level"], lv["numTiles"], lv["numColumns"]
    tile_w, tile_h = m["tileWidth"], win["tileHeight"]
    rows = [bytearray() for _ in range(tile_h)]
    total_w = 0
    problems = []
    for t in range(num_tiles):
        path = os.path.join(outdir, win["subdir"], f"L{level}", f"{t}.png")
        w, h, trows = read_png_rgb(path)
        expected_w = min(tile_w, num_cols - t * tile_w)
        if h != tile_h or w != expected_w:
            problems.append(f"L{level} tile {t}: {w}x{h}, expected {expected_w}x{tile_h}")
        for y in range(h):
            rows[y] += trows[y]
        total_w += w
    if total_w != num_cols:
        problems.append(f"L{level}: stitched width {total_w} != numColumns {num_cols}")
    return total_w, tile_h, [bytes(r) for r in rows], problems


def row_to_freq(besty, height, win):
    """Map a tile row to Hz for a window, honoring frequencyScale (linear/log)."""
    v = 1.0 - besty / (height - 1) if height > 1 else 0.0   # v=0 bottom, v=1 top
    fmin, fmax = win["minFrequencyHz"], win["maxFrequencyHz"]
    if win.get("frequencyScale") == "log":
        lo = fmin if fmin > 0 else fmax / 65536.0
        return lo * (fmax / lo) ** v
    return fmin + v * (fmax - fmin)


def peak_per_column(width, height, rows, win):
    """Return list of (peak_freq_hz, brightness) per column (scale-aware)."""
    out = []
    for x in range(width):
        base = x * 3
        best, besty = -1, 0
        for y in range(height):
            px = rows[y]
            b = px[base] + px[base + 1] + px[base + 2]
            if b > best:
                best, besty = b, y
        out.append((row_to_freq(besty, height, win), best))
    return out


def main():
    p = argparse.ArgumentParser(formatter_class=argparse.RawDescriptionHelpFormatter,
                                description=__doc__)
    p.add_argument("outdir", help="engine output dir (contains manifest.json + tiles/)")
    p.add_argument("--expect-const", type=float, help="expected constant tone (Hz)")
    p.add_argument("--expect-sweep", type=float, nargs=2, metavar=("F0", "F1"))
    p.add_argument("--stitch-dir", help="write stitched per-level PNGs here")
    args = p.parse_args()

    with open(os.path.join(args.outdir, "manifest.json")) as f:
        m = json.load(f)

    print(f"== manifest: {args.outdir}/manifest.json ==")
    problems = check_manifest_consistency(m)
    print(f"  fields + self-consistency: {'OK' if not problems else 'PROBLEMS'}")
    for pr in problems:
        print("    -", pr)

    dur = m["durationSeconds"]
    is_log = m.get("frequencyScale") == "log"
    wins = windows_of(m)
    if args.stitch_dir:
        os.makedirs(args.stitch_dir, exist_ok=True)

    overall_ok = not problems
    for win in wins:
        hz_per_bin = win["hzPerBin"]
        print(f"\n#### window {win['fftSize']}  (hop {win['hopSize']}, {hz_per_bin:.2f} Hz/bin, "
              f"{len(win['levels'])} levels) ####")
        # frequency tolerance: 1.5 bins, or (for log) the coarser local resolution
        def ftol(f, hpb=hz_per_bin):
            return max(1.5 * hpb, 0.06 * f) if is_log else 1.5 * hpb

        for lv in win["levels"]:
            level = lv["level"]
            spc = lv["secondsPerColumn"]
            w, h, rows, geo = stitch_level(args.outdir, m, win, lv)
            print(f"-- L{level}: {w} cols x {h} rows, {lv['numTiles']} tiles, {spc:.5f} s/col --")
            for pr in geo:
                print("   geometry problem:", pr)
            level_ok = not geo

            if args.stitch_dir:
                out_png = os.path.join(args.stitch_dir, f"w{win['fftSize']}_L{level}.png")
                write_png_rgb(out_png, w, h, rows)
                print(f"   stitched -> {out_png}")

            peaks = peak_per_column(w, h, rows, win)
            freqs = [f for f, _ in peaks]
            lo, hi = 2, w - 2  # ignore window edge artifacts

            # boundary continuity (seam test): the two columns straddling each
            # internal tile boundary vs the local sweep rate.
            boundaries = [t * m["tileWidth"] for t in range(1, lv["numTiles"])]
            worst_seam = 0.0
            worst_seam_at = None
            seam_ok = True
            sweep_per_col = (abs(args.expect_sweep[1] - args.expect_sweep[0]) / dur * spc
                             if args.expect_sweep else 0.0)
            for b in boundaries:
                if 0 < b < w:
                    jump = abs(freqs[b] - freqs[b - 1])
                    if jump > ftol(freqs[b]) + 2 * sweep_per_col:
                        seam_ok = False
                    if jump > worst_seam:
                        worst_seam, worst_seam_at = jump, b
            if boundaries:
                print(f"   seam test: {len(boundaries)} boundaries, worst jump {worst_seam:.1f} Hz "
                      f"-> {'OK' if seam_ok else 'SEAM!'}"
                      + (f" at col {worst_seam_at}" if worst_seam_at else ""))
                level_ok = level_ok and seam_ok
            else:
                print("   seam test: single tile (no internal boundaries)")

            # signal-specific frequency validation
            if args.expect_const is not None:
                sample = freqs[lo:hi]
                avg = sum(sample) / len(sample)
                mn, mx = min(sample), max(sample)
                tol = ftol(args.expect_const)
                ok = abs(avg - args.expect_const) <= tol and (mx - mn) <= tol
                print(f"   constant tone: mean {avg:.1f} Hz, range [{mn:.1f}, {mx:.1f}], "
                      f"expect {args.expect_const} +/- {tol:.1f} -> {'OK' if ok else 'FAIL'}")
                level_ok = level_ok and ok

            if args.expect_sweep is not None:
                f0, f1 = args.expect_sweep
                # each column c summarizes the sweep over [c*spc, (c+1)*spc]; its
                # peak must fall inside that band (+/- local resolution).
                worst_out = 0.0
                worst_at = None
                for c in range(lo, hi):
                    t0, t1 = c * spc, (c + 1) * spc
                    if t1 > dur:
                        break
                    flo = f0 + (f1 - f0) * t0 / dur
                    fhi = f0 + (f1 - f0) * t1 / dur
                    fmeas = freqs[c]
                    bt = ftol(fmeas)
                    out = max(0.0, flo - bt - fmeas, fmeas - (fhi + bt))
                    if out > worst_out:
                        worst_out, worst_at = out, (c, fmeas, flo, fhi)
                ok = worst_out <= 1e-6
                msg = f"   sweep band: worst out-of-band {worst_out:.1f} Hz -> {'OK' if ok else 'FAIL'}"
                if worst_at:
                    c, fm, fl, fh = worst_at
                    msg += f" (col {c}: peak {fm:.0f}, band [{fl:.0f},{fh:.0f}])"
                print(msg)
                level_ok = level_ok and ok

            # hover-mapping demonstration: map a few pixels to (time, freq).
            print("   hover check (manifest mapping): ", end="")
            pts = []
            for frac in (0.25, 0.5, 0.75):
                c = int(frac * w)
                t = c * spc  # timeSeconds = columnIndex * secondsPerColumn
                fmeas = freqs[c]
                if args.expect_const is not None:
                    exp = args.expect_const
                elif args.expect_sweep is not None:
                    f0, f1 = args.expect_sweep
                    exp = f0 + (f1 - f0) * (t + 0.5 * spc) / dur
                else:
                    exp = None
                pts.append(f"t={t:5.2f}s f={fmeas:6.0f}Hz"
                           + (f"(exp~{exp:.0f})" if exp is not None else ""))
            print(" | ".join(pts))

            print(f"   L{level}: {'PASS' if level_ok else 'FAIL'}")
            overall_ok = overall_ok and level_ok

    print(f"\n== OVERALL: {'PASS' if overall_ok else 'FAIL'} ==")
    sys.exit(0 if overall_ok else 1)


if __name__ == "__main__":
    main()
