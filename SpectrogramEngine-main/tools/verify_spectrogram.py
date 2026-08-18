#!/usr/bin/env python3
"""Quantitative correctness check for a SINGLE spectrogram PNG, LINEAR axis (stdlib).

Decodes an RGB8 PNG using only zlib, finds the brightest frequency row per time
column, and converts it to Hz assuming a linear axis with hzPerBin = --rate/--fft.
This is a lightweight per-image check; pass --fft to match the window that made
the image. For manifest-driven, multi-window, log-aware verification of a whole
output directory (all windows[] and pyramid levels), use verify_tiles.py instead.

Usage:
  python3 tools/verify_spectrogram.py preview.png --fft 4096 --expect-const 5000
  python3 tools/verify_spectrogram.py preview.png --expect-sweep 500 15000
  python3 tools/verify_spectrogram.py preview.png --expect-silence

Defaults to fft=1024 @ 44100 Hz unless --rate/--fft are given.
"""

import argparse
import sys

from pnglite import read_png_rgb


def peak_freq_per_column(width, height, rows, hz_per_bin):
    """For each column, return (peak_freq_hz, peak_brightness)."""
    result = []
    for x in range(width):
        best_bright = -1
        best_y = 0
        base = x * 3
        for y in range(height):
            px = rows[y]
            bright = px[base] + px[base + 1] + px[base + 2]
            if bright > best_bright:
                best_bright = bright
                best_y = y
        bin_index = (height - 1) - best_y  # row 0 = top = highest bin
        result.append((bin_index * hz_per_bin, best_bright))
    return result


def main():
    p = argparse.ArgumentParser()
    p.add_argument("png")
    p.add_argument("--rate", type=int, default=44100)
    p.add_argument("--fft", type=int, default=1024)
    p.add_argument("--hop", type=int, default=0, help="hop size (default fft/2)")
    p.add_argument("--dur", type=float, default=None, help="chirp duration (s), for --expect-sweep")
    p.add_argument("--expect-const", type=float, help="expected constant freq (Hz)")
    p.add_argument("--expect-sweep", type=float, nargs=2, metavar=("F0", "F1"))
    p.add_argument("--expect-silence", action="store_true")
    p.add_argument("--tol", type=float, default=60.0, help="freq tolerance (Hz)")
    args = p.parse_args()

    hz_per_bin = args.rate / args.fft
    width, height, rows = read_png_rgb(args.png)
    peaks = peak_freq_per_column(width, height, rows, hz_per_bin)
    freqs = [f for f, _ in peaks]
    print(f"{args.png}: {width} cols x {height} rows, hzPerBin={hz_per_bin:.3f}")

    ok = True
    # ignore the first/last couple of columns (edge windowing artifacts)
    lo, hi = 2, width - 2

    if args.expect_const is not None:
        sample = freqs[lo:hi]
        avg = sum(sample) / len(sample)
        mn, mx = min(sample), max(sample)
        print(f"  constant tone: mean peak = {avg:.1f} Hz, range [{mn:.1f}, {mx:.1f}] Hz")
        print(f"  expected {args.expect_const:.1f} Hz (+/- {args.tol} Hz)")
        if abs(avg - args.expect_const) > args.tol or (mx - mn) > 2 * args.tol:
            ok = False

    if args.expect_sweep is not None:
        f0, f1 = args.expect_sweep
        hop = args.hop if args.hop > 0 else args.fft // 2
        if args.dur is None:
            print("  ERROR: --expect-sweep needs --dur (chirp duration in seconds)")
            sys.exit(2)
        # Compare each column's measured peak against the theoretical instantaneous
        # frequency at that window's *center* time: f(t) = f0 + (f1-f0)*t/dur.
        # This is the real test that the rendered diagonal matches the chirp line.
        worst = 0.0
        worst_at = None
        checked = 0
        for x in range(lo, hi):
            t_center = (x * hop + args.fft / 2.0) / args.rate
            if t_center > args.dur:  # padded tail past the signal end
                break
            expected = f0 + (f1 - f0) * t_center / args.dur
            dev = abs(freqs[x] - expected)
            checked += 1
            if dev > worst:
                worst, worst_at = dev, (x, freqs[x], expected)
        probe = freqs[lo:hi:max(1, (hi - lo) // 20)]
        rising = all(b >= a - args.tol for a, b in zip(probe, probe[1:]))
        print(f"  sweep vs theoretical chirp line ({f0}->{f1} Hz over {args.dur}s):")
        print(f"    columns checked: {checked}, monotonic rising: {rising}")
        if worst_at:
            wx, wm, we = worst_at
            print(f"    worst deviation: {worst:.1f} Hz at col {wx} "
                  f"(measured {wm:.1f}, expected {we:.1f})")
        # Allow ~1.5 frequency bins of slack (peak lands on the nearest bin).
        tol = 1.5 * (args.rate / args.fft)
        if worst > tol or not rising:
            ok = False

    if args.expect_silence:
        max_bright = max(b for _, b in peaks)
        print(f"  silence: max column brightness (0..765) = {max_bright}")
        if max_bright > 90:  # magma floor is near-black; allow a little
            ok = False

    print("  RESULT:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
