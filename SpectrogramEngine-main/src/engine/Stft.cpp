#include "Stft.h"

#include "Parallel.h"
#include "StftKernel.h"
#include "pffft.h"

namespace spectro {

namespace {
bool isPowerOfTwo(int n) { return n >= 1 && (n & (n - 1)) == 0; }
} // namespace

bool computeSpectrogram(const std::vector<float>& mono, uint32_t sampleRate,
                        const StftParams& params, DbGrid& out, std::string& err) {
    const int N = params.fftSize;
    const int hop = params.hopSize > 0 ? params.hopSize : N / 2;

    // pffft real transforms require N to be a multiple of 32; a power of two
    // >= 64 satisfies that and keeps the pyramid math simple later.
    if (!isPowerOfTwo(N) || N < 64) {
        err = "fftSize must be a power of two >= 64 (got " + std::to_string(N) + ").";
        return false;
    }
    if (hop < 1) {
        err = "hopSize must be >= 1 (got " + std::to_string(hop) + ").";
        return false;
    }
    if (mono.empty()) {
        err = "no audio samples to analyze.";
        return false;
    }

    const int numBins = N / 2 + 1;
    const int64_t numSamples = static_cast<int64_t>(mono.size());
    // One column per hop, covering the whole file (last columns zero-padded).
    int numFrames = static_cast<int>((numSamples + hop - 1) / hop);
    if (numFrames < 1) numFrames = 1;

    std::vector<float> window;
    float magScale = 0.0f;
    buildHannWindow(N, window, magScale);

    // One pffft setup, shared read-only across threads (per the pffft docs).
    PFFFT_Setup* setup = pffft_new_setup(N, PFFFT_REAL);
    if (!setup) {
        err = "pffft_new_setup failed for N=" + std::to_string(N) + ".";
        return false;
    }

    out.numFrames = numFrames;
    out.numBins = numBins;
    out.sampleRate = sampleRate;
    out.fftSize = N;
    out.hopSize = hop;
    out.totalSamples = static_cast<uint64_t>(numSamples);
    out.db.assign(static_cast<size_t>(numFrames) * numBins, params.dbFloorInit);

    const float eps = 1e-9f;  // floor to keep log10 finite
    const unsigned threads = resolveThreadCount(params.numThreads);

    // Frames are independent and write to disjoint rows of out.db, so we split
    // the frame range across threads. Each thread owns its own aligned scratch
    // buffers; the transform of a given frame is identical regardless of which
    // thread runs it, so the result is bit-for-bit the same as single-threaded.
    parallelBlocks(0, numFrames, threads, [&](int64_t f0, int64_t f1, unsigned) {
        float* in = static_cast<float*>(pffft_aligned_malloc(sizeof(float) * N));
        float* spec = static_cast<float*>(pffft_aligned_malloc(sizeof(float) * N));
        float* work = static_cast<float*>(pffft_aligned_malloc(sizeof(float) * N));

        for (int64_t f = f0; f < f1; ++f) {
            float* dbCol = &out.db[static_cast<size_t>(f) * numBins];
            computeDbColumn(setup, in, spec, work, window.data(), magScale, N, numBins,
                            mono.data(), numSamples, f * hop, eps, dbCol);
        }

        pffft_aligned_free(in);
        pffft_aligned_free(spec);
        pffft_aligned_free(work);
    });

    pffft_destroy_setup(setup);
    return true;
}

} // namespace spectro
