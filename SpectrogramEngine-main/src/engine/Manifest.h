#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace spectro {

// One pyramid level's entry in the manifest.
struct LevelInfo {
    int level = 0;
    int numColumns = 0;
    double secondsPerColumn = 0.0;
    int numTiles = 0;
};

// Per-window (window-size-dependent) manifest entry. The engine fills fftSize,
// hopSize, numBins, secondsPerColumn (level-0 native) and levels[]; the writer
// derives hzPerBin / tileHeight / min-max frequency from these + the globals.
struct WindowInfo {
    int fftSize = 0;
    int hopSize = 0;
    int numBins = 0;                // == tileHeight
    double secondsPerColumn = 0.0;  // level-0 native = hopSize / sampleRate
    std::vector<LevelInfo> levels;
    std::string diagnosticsJson;    // optional; embedded as this window's "diagnostics"

    // Real signal-content frequency bounds for this window, found by scanning
    // every computed STFT column for bins above a noise-floor threshold
    // (see StreamingEngine.cpp / TilePyramid.cpp). Unlike minFrequencyHz/
    // maxFrequencyHz (the theoretical 0..Nyquist axis range), these describe
    // where this file's actual content lives, so a viewer can crop dead
    // (near-black) rows instead of showing empty space. Defaults to the full
    // theoretical range (filled in by the writer) when not computed.
    double contentMinFrequencyHz = -1.0;  // -1 sentinel = "not computed"
    double contentMaxFrequencyHz = -1.0;
};

// The whole manifest (schema v2). Global fields once, plus one entry per window
// size in `windows`. Tiles live at w{fftSize}/L{level}/{tile}.png.
struct ManifestV2 {
    uint32_t sampleRate = 0;
    uint64_t totalSamples = 0;
    uint32_t channels = 0;
    float dbMin = -100.0f;
    float dbMax = 0.0f;
    std::string colormap = "magma";
    std::string frequencyScale = "linear";  // "linear" | "log" (global render choice)
    int tileWidth = 0;
    int defaultWindow = 0;
    std::vector<WindowInfo> windows;
};

// Writes the v2 manifest to <path>. Returns false and fills `err` on failure.
// See README.md for the schema and the v1->v2 diff.
bool writeManifestV2(const ManifestV2& m, const std::string& path, std::string& err);

} // namespace spectro
