#!/usr/bin/env python3
"""Generate synthetic test WAVs for the spectrogram engine.

Standard library only (no numpy), so it runs on a clean Python install. Samples
are streamed to disk in chunks, so the same script scales to the long file used
in Phase 4 without holding the whole signal in memory.

Examples:
  python3 tools/make_test_audio.py all                 # sine + chirp + silence
  python3 tools/make_test_audio.py sine   --freq 5000 --dur 3
  python3 tools/make_test_audio.py chirp  --f0 500 --f1 15000 --dur 5
  python3 tools/make_test_audio.py silence --dur 2
  python3 tools/make_test_audio.py --outdir test-audio all

Expected spectrogram results (Phase 1 correctness checks):
  sine    -> a single horizontal line at the chosen frequency
  chirp   -> a straight diagonal line rising over time
  silence -> uniform floor color
"""

import argparse
import math
import os
import wave
from array import array

CHUNK = 65536  # samples per write


def _write_stream(path, sample_iter, rate):
    """Stream float samples in [-1, 1] to a 16-bit mono WAV."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    count = 0
    buf = array("h")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        for s in sample_iter:
            if s > 1.0:
                s = 1.0
            elif s < -1.0:
                s = -1.0
            buf.append(int(s * 32767.0))
            count += 1
            if len(buf) >= CHUNK:
                w.writeframes(buf.tobytes())
                del buf[:]
        if buf:
            w.writeframes(buf.tobytes())
    print(f"wrote {path}  ({count} samples, {count / rate:.3f}s @ {rate} Hz)")


def gen_sine(rate, dur, freq, amp):
    n = int(rate * dur)
    k = 2.0 * math.pi * freq / rate
    for i in range(n):
        yield amp * math.sin(k * i)


def gen_chirp(rate, dur, f0, f1, amp):
    # Linear chirp: instantaneous frequency goes f0 -> f1 across the duration.
    # phase(t) = 2*pi * (f0*t + (f1-f0)*t^2 / (2*T))
    n = int(rate * dur)
    T = float(dur)
    for i in range(n):
        t = i / rate
        phase = 2.0 * math.pi * (f0 * t + (f1 - f0) * t * t / (2.0 * T))
        yield amp * math.sin(phase)


def gen_silence(rate, dur):
    for _ in range(int(rate * dur)):
        yield 0.0


def write_long(path, rate, total_dur, base_dur=30.0, amp=0.8):
    """Efficiently write a very long WAV by repeating a precomputed base chirp.

    Content is irrelevant for the memory/throughput benchmark, so we compute one
    `base_dur`-second sweep once and blit it to disk many times -- fast enough for
    a 2-hour file (which streaming should process with flat memory)."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    base_n = int(rate * base_dur)
    base = array("h")
    f0, f1 = 200.0, 8000.0
    for i in range(base_n):
        t = i / rate
        phase = 2.0 * math.pi * (f0 * t + (f1 - f0) * t * t / (2.0 * base_dur))
        v = amp * math.sin(phase)
        base.append(int(max(-1.0, min(1.0, v)) * 32767.0))
    base_bytes = base.tobytes()

    total_n = int(rate * total_dur)
    reps, rem = divmod(total_n, base_n)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        for _ in range(reps):
            w.writeframes(base_bytes)
        if rem:
            w.writeframes(base[:rem].tobytes())
    written = reps * base_n + rem
    print(f"wrote {path}  ({written} samples, {written / rate:.1f}s @ {rate} Hz, "
          f"{written * 2 / 1e6:.0f} MB)")


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("kind", choices=["all", "sine", "chirp", "silence", "long"])
    p.add_argument("--outdir", default="test-audio")
    p.add_argument("--rate", type=int, default=44100)
    p.add_argument("--dur", type=float, default=None, help="duration in seconds")
    p.add_argument("--amp", type=float, default=0.8, help="amplitude 0..1")
    p.add_argument("--freq", type=float, default=5000.0, help="sine frequency (Hz)")
    p.add_argument("--f0", type=float, default=500.0, help="chirp start freq (Hz)")
    p.add_argument("--f1", type=float, default=15000.0, help="chirp end freq (Hz)")
    args = p.parse_args()

    rate = args.rate

    def out(name):
        return os.path.join(args.outdir, name)

    if args.kind in ("all", "sine"):
        dur = args.dur if args.dur is not None else 3.0
        _write_stream(out("sine.wav"), gen_sine(rate, dur, args.freq, args.amp), rate)
    if args.kind in ("all", "chirp"):
        dur = args.dur if args.dur is not None else 5.0
        _write_stream(out("chirp.wav"), gen_chirp(rate, dur, args.f0, args.f1, args.amp), rate)
    if args.kind in ("all", "silence"):
        dur = args.dur if args.dur is not None else 2.0
        _write_stream(out("silence.wav"), gen_silence(rate, dur), rate)
    if args.kind == "long":
        dur = args.dur if args.dur is not None else 7200.0  # 2 hours
        write_long(out("long.wav"), rate, dur, amp=args.amp)


if __name__ == "__main__":
    main()
