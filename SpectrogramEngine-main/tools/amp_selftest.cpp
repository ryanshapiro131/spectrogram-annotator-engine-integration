// Cross-window amplitude-consistency self-test.
//
// The engine normalizes magnitude by the window's coherent gain (magScale =
// 2/sum(window) in StftKernel.h), so a fixed-amplitude tone should read the SAME
// peak-bin dB at every FFT window size. If that normalization were missing, dB
// would scale ~6 dB per octave of N and the viewer's window toggle would visibly
// change brightness. This links libspectrogram and compares the engine's float dB
// directly (no PNG/colormap round-trip).
//
// The test tone is 1033.59375 Hz = 12 * 44100/512, a bin CENTER for 512..8192
// (a bin center of the smallest window is a bin center of every larger power of
// two), so scalloping loss is 0 and doesn't confound the amplitude comparison.

#include "Stft.h"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

using namespace spectro;

int main() {
    constexpr double kPi = 3.14159265358979323846;
    const uint32_t sr = 44100;
    const double freq = 12.0 * sr / 512.0;   // 1033.59375 Hz
    const double amp = 0.8;                   // -1.938 dBFS
    const int n = static_cast<int>(sr) * 2;   // 2 seconds
    std::vector<float> mono(static_cast<size_t>(n));
    for (int i = 0; i < n; ++i)
        mono[i] = static_cast<float>(amp * std::sin(2.0 * kPi * freq * i / sr));

    const int windows[] = {512, 1024, 2048, 4096, 8192};
    const int nw = 5;
    std::vector<double> peaks(nw);
    bool binsOk = true;

    std::printf("cross-window amplitude: %.5f Hz sine, amp %.2f (= %.3f dBFS expected)\n",
                freq, amp, 20.0 * std::log10(amp));
    for (int wi = 0; wi < nw; ++wi) {
        const int N = windows[wi];
        StftParams p;
        p.fftSize = N;
        p.numThreads = 1;
        DbGrid g;
        std::string err;
        if (!computeSpectrogram(mono, sr, p, g, err)) {
            std::printf("  N=%d FAILED: %s\n", N, err.c_str());
            return 1;
        }
        const int col = g.numFrames / 2;  // interior column (avoid zero-padded edges)
        double best = -1e9;
        int bestBin = 0;
        for (int b = 0; b < g.numBins; ++b) {
            const double d = g.db[static_cast<size_t>(col) * g.numBins + b];
            if (d > best) { best = d; bestBin = b; }
        }
        const int expectBin = 12 * N / 512;
        peaks[wi] = best;
        std::printf("  N=%5d  peakBin=%4d (expect %4d)  peak=%8.4f dB\n",
                    N, bestBin, expectBin, best);
        if (bestBin != expectBin) binsOk = false;
    }

    double mn = peaks[0], mx = peaks[0];
    for (int i = 1; i < nw; ++i) { mn = std::min(mn, peaks[i]); mx = std::max(mx, peaks[i]); }
    const double spread = mx - mn;
    const bool ok = binsOk && spread <= 0.5;
    std::printf("spread across windows: %.4f dB (tolerance 0.5 dB)%s -> %s\n",
                spread, binsOk ? "" : "  [PEAK BIN MISPLACED]", ok ? "PASS" : "FAIL");
    return ok ? 0 : 1;
}
