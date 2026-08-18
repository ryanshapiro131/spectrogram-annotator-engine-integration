#pragma once
#include <cstdint>
#include <string>

#include "Manifest.h"     // WindowInfo
#include "Stft.h"         // StftParams
#include "TilePyramid.h"  // TilingParams

namespace spectro {

// Timing/shape/diagnostics from a streaming run (for reporting).
struct StreamStats {
    int numLevels = 0;
    int totalTiles = 0;
    uint64_t totalFrames = 0;  // audio PCM frames
    int64_t numColumns = 0;    // level-0 columns
    uint32_t sampleRate = 0;
    uint32_t channels = 0;
    double durationSeconds = 0.0;

    // Wall-clock breakdown of the (sequential) streaming-loop phases.
    double decodeSeconds = 0.0;  // incremental decode reads
    double stftSeconds = 0.0;    // STFT columns (parallel inside)
    double poolSeconds = 0.0;    // max-pool + tile-buffer fill
    double tileSeconds = 0.0;    // PNG encode/write (parallel inside)
    double totalSeconds = 0.0;   // whole run, wall clock

    // Chunking.
    int numChunks = 0;
    int64_t chunkCols = 0;       // block size in columns (--chunk)
    double chunkWallMinMs = 0.0;
    double chunkWallMeanMs = 0.0;
    double chunkWallMedianMs = 0.0;
    double chunkWallMaxMs = 0.0;

    // Resources.
    double cpuSeconds = 0.0;     // summed user+system CPU across all threads
    double peakMemMB = 0.0;
    uint64_t outputBytes = 0;    // on-disk size of this window's tiles
};

// Bounded-memory precompute for ONE window size. Decodes the file incrementally,
// processes it in blocks of `columnsPerBlock` STFT columns (carrying the window
// overlap between blocks), feeds each column into per-level running max-pool
// accumulators, and encodes/frees tiles as they complete. Memory stays
// proportional to one block + a few tiles, independent of file length. Tiles are
// written under outDir/<windowSubdir>/L{level}/{tile}.png; the manifest is written
// separately by the caller. Fills `stats` (timing) and `winInfo` (manifest
// metadata for this window). Output is byte-for-byte identical to
// buildTiledPyramid() for the same window. Returns false and fills `err`.
bool runStreaming(const std::string& inPath, const std::string& outDir,
                  const std::string& windowSubdir,
                  const StftParams& stft, const TilingParams& tiling,
                  int64_t columnsPerBlock, bool embedDiagnostics,
                  StreamStats& stats, WindowInfo& winInfo, std::string& err);

} // namespace spectro
