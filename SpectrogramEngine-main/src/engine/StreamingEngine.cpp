#include "StreamingEngine.h"

#include "AudioFile.h"
#include "Manifest.h"
#include "Parallel.h"
#include "StftKernel.h"
#include "TileEncode.h"
#include "pffft.h"

#include "nlohmann/json.hpp"

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX          // stop windows.h from #define-ing min/max, which
#endif                    // breaks std::min/std::max and std::numeric_limits<T>::max()
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <psapi.h>
#ifdef _MSC_VER
#pragma comment(lib, "psapi.lib")
#endif
#else
#include <sys/resource.h>
#endif

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <mutex>
#include <vector>

namespace spectro {

namespace fs = std::filesystem;

namespace {

bool isPowerOfTwo(int n) { return n >= 1 && (n & (n - 1)) == 0; }

using Clock = std::chrono::steady_clock;
double secondsSince(Clock::time_point t) {
    return std::chrono::duration<double>(Clock::now() - t).count();
}

// Total user+system CPU time of the process so far (sums all threads).
double processCpuSeconds() {
#ifdef _WIN32
    FILETIME createTime, exitTime, kernelTime, userTime;
    if (!GetProcessTimes(GetCurrentProcess(), &createTime, &exitTime, &kernelTime, &userTime)) {
        return 0.0;
    }
    auto toSeconds = [](const FILETIME& ft) {
        ULARGE_INTEGER uli;
        uli.LowPart = ft.dwLowDateTime;
        uli.HighPart = ft.dwHighDateTime;
        return static_cast<double>(uli.QuadPart) * 100e-9;  // 100ns units -> seconds
    };
    return toSeconds(kernelTime) + toSeconds(userTime);
#else
    struct rusage r{};
    getrusage(RUSAGE_SELF, &r);
    return (r.ru_utime.tv_sec + r.ru_utime.tv_usec * 1e-6) +
           (r.ru_stime.tv_sec + r.ru_stime.tv_usec * 1e-6);
#endif
}

double processPeakMemMB() {
#ifdef _WIN32
    PROCESS_MEMORY_COUNTERS pmc{};
    if (!GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc))) {
        return 0.0;
    }
    return static_cast<double>(pmc.PeakWorkingSetSize) / (1024.0 * 1024.0);  // bytes -> MB
#else
    struct rusage r{};
    getrusage(RUSAGE_SELF, &r);
#if defined(__APPLE__)
    return r.ru_maxrss / (1024.0 * 1024.0);  // bytes on macOS
#else
    return r.ru_maxrss / 1024.0;              // KB on Linux
#endif
#endif
}

// Sum of regular-file sizes under `dir` (recursive).
uint64_t dirSizeBytes(const fs::path& dir) {
    uint64_t total = 0;
    std::error_code ec;
    for (auto it = fs::recursive_directory_iterator(dir, ec);
         !ec && it != fs::recursive_directory_iterator(); it.increment(ec)) {
        if (it->is_regular_file(ec)) total += it->file_size(ec);
    }
    return total;
}

double percentile(std::vector<double>& v, double p) {
    if (v.empty()) return 0.0;
    std::sort(v.begin(), v.end());
    const double idx = p * (v.size() - 1);
    const size_t lo = static_cast<size_t>(idx);
    const size_t hi = std::min(lo + 1, v.size() - 1);
    const double frac = idx - lo;
    return v[lo] + frac * (v[hi] - v[lo]);
}

// Number of pyramid levels for a given L0 column count — must match the
// whole-file path (start at numFrames, halve via (n+1)/2 until <= coarsestMax).
int computeNumLevels(int64_t numFrames, int coarsestMax) {
    int levels = 1;
    int64_t cur = numFrames;
    while (cur > coarsestMax) {
        cur = (cur + 1) / 2;
        ++levels;
    }
    return levels;
}

// A completed tile, owning its column data, queued for parallel encoding.
struct TileJob {
    int level = 0;
    int tileIndex = 0;
    int width = 0;
    std::vector<float> cols;  // column-major, width*numBins (may over-allocate)
};

// Per-level accumulator state.
struct LevelState {
    std::vector<float> tileBuf;  // tileWidth*numBins, current tile's columns
    int tileCols = 0;
    int tileIndex = 0;
    std::vector<float> pending;  // numBins, the unpaired column awaiting a pool partner
    bool hasPending = false;
    std::vector<float> pooled;   // numBins, scratch for max(pending, col)
};

// Replicates the whole-file max-pool tree with running accumulators: level L+1
// column j = max(levelL[2j], levelL[2j+1]); an odd trailing column carries up
// unchanged (handled by finalize()). Completed tiles are pushed to `jobs`.
struct PyramidStreamer {
    int numLevels = 0;
    int tileWidth = 0;
    int numBins = 0;
    std::vector<LevelState> levels;
    std::vector<TileJob>* jobs = nullptr;

    void init(int nLevels, int tw, int nb) {
        numLevels = nLevels;
        tileWidth = tw;
        numBins = nb;
        levels.resize(numLevels);
        for (auto& L : levels) {
            L.tileBuf.assign(static_cast<size_t>(tileWidth) * numBins, 0.0f);
            L.pending.assign(numBins, 0.0f);
            L.pooled.assign(numBins, 0.0f);
        }
    }

    void flushTile(int level, int width) {
        LevelState& L = levels[level];
        TileJob job;
        job.level = level;
        job.tileIndex = L.tileIndex;
        job.width = width;
        job.cols = std::move(L.tileBuf);
        jobs->push_back(std::move(job));
        ++L.tileIndex;
        L.tileBuf.assign(static_cast<size_t>(tileWidth) * numBins, 0.0f);
        L.tileCols = 0;
    }

    void emit(int level, const float* col) {
        LevelState& L = levels[level];
        std::copy(col, col + numBins, L.tileBuf.data() + static_cast<size_t>(L.tileCols) * numBins);
        ++L.tileCols;
        if (L.tileCols == tileWidth) flushTile(level, tileWidth);

        if (level + 1 < numLevels) {
            if (!L.hasPending) {
                std::copy(col, col + numBins, L.pending.data());
                L.hasPending = true;
            } else {
                for (int b = 0; b < numBins; ++b) L.pooled[b] = std::max(L.pending[b], col[b]);
                L.hasPending = false;
                emit(level + 1, L.pooled.data());
            }
        }
    }

    // At EOF, push any unpaired column up (odd-count carry), then flush partial
    // tiles. Processing levels bottom-up lets carries cascade correctly.
    void finalize() {
        for (int level = 0; level + 1 < numLevels; ++level) {
            if (levels[level].hasPending) {
                levels[level].hasPending = false;
                emit(level + 1, levels[level].pending.data());
            }
        }
        for (int level = 0; level < numLevels; ++level) {
            if (levels[level].tileCols > 0) flushTile(level, levels[level].tileCols);
        }
    }
};

// Encodes a batch of completed tiles in parallel, then clears the batch.
bool encodeJobs(std::vector<TileJob>& jobs, int numBins, const RenderParams& rp,
                const int* rowToBin, const std::string& tilesRoot, unsigned threads,
                std::string& err) {
    std::atomic<bool> failed{false};
    std::string tileErr;
    std::mutex errMutex;
    parallelBlocks(0, static_cast<int64_t>(jobs.size()), threads,
                   [&](int64_t a, int64_t b, unsigned) {
        for (int64_t i = a; i < b; ++i) {
            if (failed.load(std::memory_order_relaxed)) return;
            const TileJob& j = jobs[static_cast<size_t>(i)];
            const std::string path =
                (fs::path(tilesRoot) / ("L" + std::to_string(j.level)) /
                 (std::to_string(j.tileIndex) + ".png")).string();
            std::string localErr;
            if (!writeTilePng(j.cols.data(), numBins, 0, j.width, rp, rowToBin, path, localErr)) {
                std::lock_guard<std::mutex> lock(errMutex);
                if (!failed.exchange(true)) tileErr = localErr;
                return;
            }
        }
    });
    jobs.clear();
    if (failed) {
        err = tileErr;
        return false;
    }
    return true;
}

} // namespace

bool runStreaming(const std::string& inPath, const std::string& outDir,
                  const std::string& windowSubdir,
                  const StftParams& stftParams, const TilingParams& tiling,
                  int64_t columnsPerBlock, bool embedDiagnostics,
                  StreamStats& stats, WindowInfo& winInfo, std::string& err) {
    const auto tStart = Clock::now();
    const double cpuStart = processCpuSeconds();

    const int N = stftParams.fftSize;
    const int hop = stftParams.hopSize > 0 ? stftParams.hopSize : N / 2;
    if (!isPowerOfTwo(N) || N < 64) {
        err = "fftSize must be a power of two >= 64 (got " + std::to_string(N) + ").";
        return false;
    }
    if (hop < 1) {
        err = "hopSize must be >= 1.";
        return false;
    }
    if (tiling.tileWidth < 1) {
        err = "tileWidth must be >= 1.";
        return false;
    }
    if (columnsPerBlock < 1) columnsPerBlock = 8192;

    AudioReader reader;
    if (!openAudioReader(inPath, reader, err)) return false;
    if (reader.totalFrames == 0) {
        closeAudioReader(reader);
        err = "no audio samples to analyze: " + inPath;
        return false;
    }

    const int numBins = N / 2 + 1;
    const int tileWidth = tiling.tileWidth;
    const int coarsestMax = std::max(tiling.coarsestMaxColumns, tileWidth);
    const int64_t totalFrames = static_cast<int64_t>(reader.totalFrames);
    int64_t numFrames = (totalFrames + hop - 1) / hop;
    if (numFrames < 1) numFrames = 1;
    const int numLevels = computeNumLevels(numFrames, coarsestMax);
    const double spc0 = static_cast<double>(hop) / reader.sampleRate;
    const unsigned threads = resolveThreadCount(tiling.numThreads);
    const float eps = 1e-9f;

    // Output dirs: tiles live under outDir/<windowSubdir>/L{level}/.
    const fs::path tilesRoot = fs::path(outDir) / windowSubdir;
    std::error_code ec;
    for (int L = 0; L < numLevels; ++L) {
        fs::create_directories(tilesRoot / ("L" + std::to_string(L)), ec);
        if (ec) {
            closeAudioReader(reader);
            err = "could not create tile dirs under " + tilesRoot.string() + ": " + ec.message();
            return false;
        }
    }

    std::vector<float> window;
    float magScale = 0.0f;
    buildHannWindow(N, window, magScale);

    // Row -> bin mapping for the chosen frequency scale (same for every tile).
    const double hzPerBin = static_cast<double>(reader.sampleRate) / N;
    std::vector<int> rowToBin;
    buildRowToBin(numBins, hzPerBin, tiling.render.freqScale, rowToBin);

    PFFFT_Setup* setup = pffft_new_setup(N, PFFFT_REAL);
    if (!setup) {
        closeAudioReader(reader);
        err = "pffft_new_setup failed for N=" + std::to_string(N) + ".";
        return false;
    }

    PyramidStreamer streamer;
    streamer.init(numLevels, tileWidth, numBins);

    // Streaming state.
    std::vector<float> carry;          // mono samples currently buffered
    int64_t bufferStart = 0;           // absolute sample index of carry[0]
    bool eof = false;
    const int64_t decodeChunk = 65536; // frames per decoder read
    std::vector<float> readBuf(static_cast<size_t>(decodeChunk));
    std::vector<float> blockBuf;       // columnsPerBlock * numBins (reused)
    std::vector<TileJob> jobs;

    int64_t frameIndex = 0;
    bool ok = true;
    std::vector<double> chunkWallMs;

    while (frameIndex < numFrames && ok) {
        const auto tChunk = Clock::now();
        const int64_t blockFrames = std::min<int64_t>(columnsPerBlock, numFrames - frameIndex);
        // Samples needed so the last frame's window is covered (or until EOF).
        const int64_t neededEnd = (frameIndex + blockFrames - 1) * hop + N;

        const auto tDec = Clock::now();
        while (!eof && bufferStart + static_cast<int64_t>(carry.size()) < neededEnd) {
            const int64_t got = readAudioMono(reader, readBuf.data(), decodeChunk);
            if (got <= 0) { eof = true; break; }
            carry.insert(carry.end(), readBuf.data(), readBuf.data() + got);
        }
        stats.decodeSeconds += secondsSince(tDec);

        // Compute this block's L0 columns in parallel (frames independent).
        const auto tStft = Clock::now();
        blockBuf.resize(static_cast<size_t>(blockFrames) * numBins);
        const float* carryPtr = carry.data();
        const int64_t carryLen = static_cast<int64_t>(carry.size());
        const int64_t bStart = bufferStart;
        const int64_t fBase = frameIndex;
        parallelBlocks(0, blockFrames, threads, [&](int64_t i0, int64_t i1, unsigned) {
            float* in = static_cast<float*>(pffft_aligned_malloc(sizeof(float) * N));
            float* spec = static_cast<float*>(pffft_aligned_malloc(sizeof(float) * N));
            float* work = static_cast<float*>(pffft_aligned_malloc(sizeof(float) * N));
            for (int64_t i = i0; i < i1; ++i) {
                const int64_t winStart = (fBase + i) * hop - bStart;
                computeDbColumn(setup, in, spec, work, window.data(), magScale, N, numBins,
                                carryPtr, carryLen, winStart, eps,
                                &blockBuf[static_cast<size_t>(i) * numBins]);
            }
            pffft_aligned_free(in);
            pffft_aligned_free(spec);
            pffft_aligned_free(work);
        });
        stats.stftSeconds += secondsSince(tStft);

        // Feed columns (in order) into the pyramid accumulators, collecting tiles.
        const auto tPool = Clock::now();
        streamer.jobs = &jobs;
        for (int64_t i = 0; i < blockFrames; ++i) {
            streamer.emit(0, &blockBuf[static_cast<size_t>(i) * numBins]);
        }
        stats.poolSeconds += secondsSince(tPool);

        // Encode + free this block's completed tiles.
        const auto tTile = Clock::now();
        if (!encodeJobs(jobs, numBins, tiling.render, rowToBin.data(), tilesRoot.string(), threads, err))
            ok = false;
        stats.tileSeconds += secondsSince(tTile);

        frameIndex += blockFrames;

        // Drop samples no longer needed (before the next block's first frame).
        const int64_t keepFrom = frameIndex * hop;
        if (keepFrom > bufferStart) {
            const int64_t drop = std::min<int64_t>(keepFrom - bufferStart,
                                                   static_cast<int64_t>(carry.size()));
            carry.erase(carry.begin(), carry.begin() + drop);
            bufferStart += drop;
        }
        chunkWallMs.push_back(secondsSince(tChunk) * 1000.0);
    }

    if (ok) {
        streamer.jobs = &jobs;
        streamer.finalize();
        const auto tTile = Clock::now();
        if (!encodeJobs(jobs, numBins, tiling.render, rowToBin.data(), tilesRoot.string(), threads, err))
            ok = false;
        stats.tileSeconds += secondsSince(tTile);
    }

    pffft_destroy_setup(setup);
    closeAudioReader(reader);
    if (!ok) return false;

    // Per-window manifest metadata (levels[]); the caller assembles the manifest.
    std::vector<LevelInfo> levelInfos;
    levelInfos.reserve(numLevels);
    int totalTiles = 0;
    int64_t cols = numFrames;
    for (int L = 0; L < numLevels; ++L) {
        const int numTiles = static_cast<int>((cols + tileWidth - 1) / tileWidth);
        levelInfos.push_back({L, static_cast<int>(cols), spc0 * std::pow(2.0, L), numTiles});
        totalTiles += numTiles;
        cols = (cols + 1) / 2;
    }

    // Fill stats / diagnostics (before the manifest write so they can be embedded).
    stats.numLevels = numLevels;
    stats.totalTiles = totalTiles;
    stats.totalFrames = reader.totalFrames;
    stats.numColumns = numFrames;
    stats.sampleRate = reader.sampleRate;
    stats.channels = reader.channels;
    stats.durationSeconds =
        reader.sampleRate ? static_cast<double>(reader.totalFrames) / reader.sampleRate : 0.0;
    stats.chunkCols = columnsPerBlock;
    stats.numChunks = static_cast<int>(chunkWallMs.size());
    if (!chunkWallMs.empty()) {
        stats.chunkWallMinMs = *std::min_element(chunkWallMs.begin(), chunkWallMs.end());
        stats.chunkWallMaxMs = *std::max_element(chunkWallMs.begin(), chunkWallMs.end());
        stats.chunkWallMedianMs = percentile(chunkWallMs, 0.5);
        double sum = 0.0;
        for (double x : chunkWallMs) sum += x;
        stats.chunkWallMeanMs = sum / chunkWallMs.size();
    }
    stats.cpuSeconds = processCpuSeconds() - cpuStart;
    stats.peakMemMB = processPeakMemMB();
    stats.totalSeconds = secondsSince(tStart);

    const uint64_t tilesBytes = dirSizeBytes(tilesRoot);
    stats.outputBytes = tilesBytes;
    const double realtimeFactor =
        stats.totalSeconds > 0 ? stats.durationSeconds / stats.totalSeconds : 0.0;

    // Fill the per-window manifest entry for the caller to assemble.
    winInfo.fftSize = N;
    winInfo.hopSize = hop;
    winInfo.numBins = numBins;
    winInfo.secondsPerColumn = spc0;   // level-0 native
    winInfo.levels = std::move(levelInfos);

    // Optionally serialize this window's diagnostics for embedding in the manifest.
    if (embedDiagnostics) {
        nlohmann::json d;
        d["numChunks"] = stats.numChunks;
        d["chunkColumns"] = stats.chunkCols;
        d["numLevels"] = numLevels;
        d["totalTiles"] = totalTiles;
        d["numColumns"] = numFrames;
        d["wallClockSeconds"] = {{"decode", stats.decodeSeconds},
                                 {"stft", stats.stftSeconds},
                                 {"pool", stats.poolSeconds},
                                 {"pngEncode", stats.tileSeconds},
                                 {"total", stats.totalSeconds}};
        d["perChunkWallMs"] = {{"min", stats.chunkWallMinMs},
                               {"median", stats.chunkWallMedianMs},
                               {"max", stats.chunkWallMaxMs}};
        d["cpuSeconds"] = stats.cpuSeconds;
        d["realtimeFactor"] = realtimeFactor;
        d["peakMemoryMB"] = stats.peakMemMB;
        d["tilesBytes"] = tilesBytes;
        winInfo.diagnosticsJson = d.dump();
    }
    return true;
}

} // namespace spectro
