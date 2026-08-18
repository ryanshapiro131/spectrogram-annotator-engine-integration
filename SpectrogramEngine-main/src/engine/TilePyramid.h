#pragma once
#include <string>
#include <vector>

#include "Manifest.h"          // WindowInfo
#include "SpectrogramImage.h"  // RenderParams
#include "Stft.h"              // DbGrid

namespace spectro {

// Controls how the pyramid is cut into tiles and colored.
struct TilingParams {
    int tileWidth = 512;            // tile width in columns/pixels
    int coarsestMaxColumns = 2048;  // keep halving in time until a level is this narrow
    int numThreads = 0;             // 0 = hardware concurrency; 1 = single-threaded
    RenderParams render;            // dB display range for the colormap
    std::string colormapName = "magma";
    bool writePreview = false;      // also emit preview.png (full level-0 image)
};

// Per-level summary (mirrors what goes into the manifest).
struct PyramidLevelInfo {
    int level = 0;
    int numColumns = 0;
    double secondsPerColumn = 0.0;
    int numTiles = 0;
};

struct TilingResult {
    std::vector<PyramidLevelInfo> levels;
    int totalTiles = 0;
    std::string tilesDir;
};

// Whole-file (non-streaming) reference path for ONE window size. Builds the
// multi-resolution pyramid (Level 0 = full detail; each higher level halves the
// time axis via per-bin max-pooling) and cuts every level into PNG tiles at
// outDir/<windowSubdir>/L{level}/{tile}.png. The manifest is written separately
// by the caller; `winInfo` is filled with this window's manifest metadata.
// Byte-identical to runStreaming() for the same window. Returns false on failure.
bool buildTiledPyramid(const DbGrid& grid, const std::string& outDir,
                       const std::string& windowSubdir, const TilingParams& params,
                       TilingResult& result, WindowInfo& winInfo, std::string& err);

} // namespace spectro
