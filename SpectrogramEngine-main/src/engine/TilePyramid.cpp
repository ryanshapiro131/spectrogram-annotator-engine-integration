#include "TilePyramid.h"

#include "Manifest.h"
#include "Parallel.h"
#include "TileEncode.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <filesystem>
#include <mutex>

namespace spectro {

namespace fs = std::filesystem;

namespace {

// Downsample a level in time by 2x: each output column is the per-bin maximum of
// two adjacent input columns (max-pooling preserves short/faint events better
// than averaging). An odd trailing column is carried through unchanged.
std::vector<float> maxPoolTime(const std::vector<float>& src, int srcCols,
                               int numBins, int& outCols) {
    outCols = (srcCols + 1) / 2;
    std::vector<float> dst(static_cast<size_t>(outCols) * numBins);
    for (int c = 0; c < outCols; ++c) {
        const int c0 = 2 * c;
        const int c1 = 2 * c + 1;
        const float* col0 = &src[static_cast<size_t>(c0) * numBins];
        float* out = &dst[static_cast<size_t>(c) * numBins];
        if (c1 < srcCols) {
            const float* col1 = &src[static_cast<size_t>(c1) * numBins];
            for (int b = 0; b < numBins; ++b) out[b] = std::max(col0[b], col1[b]);
        } else {
            for (int b = 0; b < numBins; ++b) out[b] = col0[b];
        }
    }
    return dst;
}

} // namespace

bool buildTiledPyramid(const DbGrid& grid, const std::string& outDir,
                       const std::string& windowSubdir, const TilingParams& params,
                       TilingResult& result, WindowInfo& winInfo, std::string& err) {
    if (grid.numFrames <= 0 || grid.numBins <= 0 || grid.db.empty()) {
        err = "empty spectrogram grid.";
        return false;
    }
    if (params.tileWidth < 1) {
        err = "tileWidth must be >= 1.";
        return false;
    }

    const int numBins = grid.numBins;
    const int tileWidth = params.tileWidth;
    const int coarsestMax = std::max(params.coarsestMaxColumns, tileWidth);
    const double spc0 = grid.secondsPerFrame();
    const unsigned threads = resolveThreadCount(params.numThreads);

    // Row -> bin mapping for the chosen frequency scale (same for every tile).
    const double hzPerBin =
        grid.fftSize > 0 ? static_cast<double>(grid.sampleRate) / grid.fftSize : 0.0;
    std::vector<int> rowToBin;
    buildRowToBin(numBins, hzPerBin, params.render.freqScale, rowToBin);

    // Tiles live under outDir/<windowSubdir>/L{level}/.
    const fs::path tilesRoot = fs::path(outDir) / windowSubdir;
    std::error_code ec;
    fs::create_directories(tilesRoot, ec);
    if (ec) {
        err = "could not create tiles dir under " + tilesRoot.string() + ": " + ec.message();
        return false;
    }

    // Level 0 starts as a copy of the full-resolution grid; each iteration writes
    // the current level's tiles, then max-pools down to the next level.
    std::vector<float> cur = grid.db;
    int curCols = grid.numFrames;
    int level = 0;
    result.levels.clear();
    result.totalTiles = 0;

    while (true) {
        const double spc = spc0 * std::pow(2.0, level);
        const fs::path levelDir = tilesRoot / ("L" + std::to_string(level));
        fs::create_directories(levelDir, ec);
        if (ec) {
            err = "could not create level dir " + levelDir.string() + ": " + ec.message();
            return false;
        }

        const int numTiles = (curCols + tileWidth - 1) / tileWidth;

        // Tiles within a level are independent PNG encodes, so write them in
        // parallel. Output bytes don't depend on thread scheduling.
        std::atomic<bool> failed{false};
        std::string tileErr;
        std::mutex errMutex;
        parallelBlocks(0, numTiles, threads, [&](int64_t tb, int64_t te, unsigned) {
            for (int64_t t = tb; t < te; ++t) {
                if (failed.load(std::memory_order_relaxed)) return;
                const int colStart = static_cast<int>(t) * tileWidth;
                const int width = std::min(tileWidth, curCols - colStart);
                const std::string path =
                    (levelDir / (std::to_string(t) + ".png")).string();
                std::string localErr;
                if (!writeTilePng(cur.data(), numBins, colStart, width, params.render,
                                  rowToBin.data(), path, localErr)) {
                    std::lock_guard<std::mutex> lock(errMutex);
                    if (!failed.exchange(true)) tileErr = localErr;
                    return;
                }
            }
        });
        if (failed) {
            err = tileErr;
            return false;
        }

        result.levels.push_back({level, curCols, spc, numTiles});
        result.totalTiles += numTiles;

        if (curCols <= coarsestMax) break;  // this level already shows the whole file

        int nextCols = 0;
        cur = maxPoolTime(cur, curCols, numBins, nextCols);
        curCols = nextCols;
        ++level;
    }

    if (params.writePreview) {
        const std::string previewPath = (fs::path(outDir) / "preview.png").string();
        if (!writeSpectrogramPng(grid, params.render, previewPath, err)) return false;
    }

    // Fill this window's manifest metadata (the caller assembles the manifest).
    winInfo.fftSize = grid.fftSize;
    winInfo.hopSize = grid.hopSize;
    winInfo.numBins = grid.numBins;
    winInfo.secondsPerColumn = spc0;  // level-0 native
    winInfo.levels.clear();
    winInfo.levels.reserve(result.levels.size());
    for (const auto& L : result.levels) {
        winInfo.levels.push_back({L.level, L.numColumns, L.secondsPerColumn, L.numTiles});
    }

    result.tilesDir = tilesRoot.string();
    return true;
}

} // namespace spectro
