#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace spectro {

// STFT configuration. Defaults match the project brief: 1024-point FFT,
// 50% overlap (hop = fftSize/2), Hann window.
struct StftParams {
    int fftSize = 1024;
    int hopSize = 0;         // <= 0 means "use fftSize / 2"
    int numThreads = 0;      // 0 = hardware concurrency; 1 = single-threaded
    float dbFloorInit = -120.0f;  // value written before a bin is computed
};

// Result of the STFT: a dense grid of magnitudes in decibels.
// Layout is column-major by time frame: db[frame * numBins + bin].
// dB is normalized so a full-scale sinusoid reads ~0 dB.
struct DbGrid {
    int numFrames = 0;       // time columns (one per hop)
    int numBins = 0;         // fftSize/2 + 1 frequency bins
    uint32_t sampleRate = 0;
    int fftSize = 0;
    int hopSize = 0;
    uint64_t totalSamples = 0;  // length of the source signal (mono samples)
    std::vector<float> db;   // size numFrames * numBins

    // Frequency of bin i is i * hzPerBin(); bin 0 = DC, bin numBins-1 = Nyquist.
    float hzPerBin() const {
        return (sampleRate > 0 && fftSize > 0)
                   ? static_cast<float>(sampleRate) / static_cast<float>(fftSize)
                   : 0.0f;
    }
    // Time span of one column, in seconds.
    double secondsPerFrame() const {
        return sampleRate > 0 ? static_cast<double>(hopSize) / sampleRate : 0.0;
    }
};

// Computes the STFT (Hann window -> real FFT -> magnitude -> dB) over the whole
// mono signal. Phase 1 holds the full grid in memory (fine for short files);
// bounded-memory streaming arrives in Phase 4. Returns false and fills `err`
// on invalid parameters.
bool computeSpectrogram(const std::vector<float>& mono, uint32_t sampleRate,
                        const StftParams& params, DbGrid& out, std::string& err);

} // namespace spectro
