#pragma once
// Shared per-frame STFT math, used by BOTH the whole-file path (Stft.cpp) and
// the streaming path (StreamingEngine.cpp). Keeping it in one place guarantees
// the two produce bit-for-bit identical columns.

#include "pffft.h"

#include <cmath>
#include <cstdint>
#include <vector>

namespace spectro {

// Periodic Hann window of length N. Its coefficients sum to N/2; magScale =
// 2/sum makes a full-scale sinusoid land at ~0 dB.
inline void buildHannWindow(int N, std::vector<float>& window, float& magScale) {
    constexpr double kPi = 3.14159265358979323846;
    window.resize(N);
    double windowSum = 0.0;
    for (int n = 0; n < N; ++n) {
        double w = 0.5 - 0.5 * std::cos(2.0 * kPi * n / N);
        window[n] = static_cast<float>(w);
        windowSum += w;
    }
    magScale = static_cast<float>(2.0 / windowSum);
}

// Compute one STFT column (magnitude in dB) for the analysis window that starts
// at sample index `winStart` within `src` (length `srcLen`). Samples outside
// [0, srcLen) are treated as zero (edge padding). Writes numBins values to dbCol.
//
// `in`, `spec`, `work` are caller-owned pffft-aligned scratch buffers of N
// floats each (one set per thread). `setup` is a shared read-only PFFFT_Setup.
inline void computeDbColumn(PFFFT_Setup* setup, float* in, float* spec, float* work,
                            const float* window, float magScale, int N, int numBins,
                            const float* src, int64_t srcLen, int64_t winStart,
                            float eps, float* dbCol) {
    for (int n = 0; n < N; ++n) {
        const int64_t idx = winStart + n;
        const float s = (idx >= 0 && idx < srcLen) ? src[static_cast<size_t>(idx)] : 0.0f;
        in[n] = s * window[n];
    }
    pffft_transform_ordered(setup, in, spec, work, PFFFT_FORWARD);

    // pffft "ordered" real output packs DC and Nyquist (both purely real) into
    // the first complex slot: spec[0]=Re(DC), spec[1]=Re(Nyquist), then
    // spec[2k], spec[2k+1] = Re/Im of bin k for k=1..N/2-1.
    {
        const float m = std::fabs(spec[0]) * magScale;  // DC
        dbCol[0] = 20.0f * std::log10(m > eps ? m : eps);
    }
    {
        const float m = std::fabs(spec[1]) * magScale;  // Nyquist
        dbCol[numBins - 1] = 20.0f * std::log10(m > eps ? m : eps);
    }
    for (int k = 1; k < N / 2; ++k) {
        const float re = spec[2 * k];
        const float im = spec[2 * k + 1];
        const float m = std::sqrt(re * re + im * im) * magScale;
        dbCol[k] = 20.0f * std::log10(m > eps ? m : eps);
    }
}

} // namespace spectro
