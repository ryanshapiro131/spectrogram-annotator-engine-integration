// spectrogram-engine — thin CLI wrapper around libspectrogram.
//
// Phase 4: bounded-memory streaming precompute is the default (incremental
// decode + block STFT + running max-pool + emit/encode/free tiles). --no-stream
// selects the whole-file path (loads everything into RAM); both produce
// byte-identical tiles + manifest.json.

#include "AudioFile.h"
#include "Manifest.h"
#include "Parallel.h"
#include "SpectrogramImage.h"
#include "Stft.h"
#include "StreamingEngine.h"
#include "TilePyramid.h"

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
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

using namespace spectro;

namespace {

void printUsage(const char* prog) {
    std::fprintf(stderr,
        "Spectrogram Engine (Phase 4)\n"
        "Usage: %s <audiofile> <outdir> [options]\n"
        "\n"
        "  Decodes WAV/MP3/FLAC and writes <outdir>/manifest.json + tiles/L*/*.png.\n"
        "  Default is bounded-memory streaming; memory stays flat regardless of\n"
        "  file length. Prints a decode/STFT/tiling breakdown, throughput, peak RSS.\n"
        "\n"
        "Options:\n"
        "  --window-sizes L  comma list of FFT window sizes, pow2 256..8192 (default 1024,4096)\n"
        "                    each becomes its own pyramid under w<N>/\n"
        "  --overlap R     window overlap ratio in [0,1); hop = N*(1-R)   (default 0.5)\n"
        "  --hop N         fixed hop override in samples (single window only)\n"
        "  --fft N         DEPRECATED: alias for --window-sizes N (single window)\n"
        "  --threads N     worker threads; 0 = hardware concurrency  (default 0)\n"
        "  --chunk N       streaming block size in columns            (default 8192)\n"
        "  --embed-diagnostics   embed a diagnostics object in manifest.json (streaming)\n"
        "  --no-stream     whole-file path (loads all audio into RAM; reference)\n"
        "  --tile-width N  tile width in columns/pixels               (default 512)\n"
        "  --db-min X      dB mapped to colormap floor                (default -100)\n"
        "  --db-max X      dB mapped to colormap peak                 (default 0)\n"
        "  --freq-scale S  frequency axis: linear | log               (default linear)\n"
        "  --preview       (with --no-stream) also write preview.png\n",
        prog);
}

const char* requireValue(int argc, char** argv, int& i, const char* flag) {
    if (i + 1 >= argc) {
        std::fprintf(stderr, "Error: missing value for %s\n", flag);
        std::exit(2);
    }
    return argv[++i];
}

// Parse a comma-separated window-size list and validate each: power of two,
// 256 <= N <= 8192. Fills `out` (order preserved) or sets `err` and returns false.
bool parseWindowSizes(const std::string& csv, std::vector<int>& out, std::string& err) {
    out.clear();
    size_t start = 0;
    while (start <= csv.size()) {
        size_t comma = csv.find(',', start);
        std::string tok = (comma == std::string::npos) ? csv.substr(start)
                                                        : csv.substr(start, comma - start);
        if (!tok.empty()) {
            const int n = std::atoi(tok.c_str());
            if (n < 1 || (n & (n - 1)) != 0) {
                err = "window size '" + tok + "' is not a power of two"; return false;
            }
            if (n < 256) {
                err = "window size " + std::to_string(n) + " is below the minimum of 256"; return false;
            }
            if (n > 8192) {
                err = "window size " + std::to_string(n) +
                      " exceeds the maximum of 8192 (larger windows give <3 Hz / >340 ms per "
                      "column and 8193px-tall tiles, not useful for this domain)";
                return false;
            }
            out.push_back(n);
        }
        if (comma == std::string::npos) break;
        start = comma + 1;
    }
    if (out.empty()) { err = "no window sizes given"; return false; }
    return true;
}

double millis(std::chrono::steady_clock::time_point a,
              std::chrono::steady_clock::time_point b) {
    return std::chrono::duration<double, std::milli>(b - a).count();
}

double peakMemMB() {
#ifdef _WIN32
    PROCESS_MEMORY_COUNTERS pmc{};
    if (!GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof(pmc))) {
        return 0.0;
    }
    return static_cast<double>(pmc.PeakWorkingSetSize) / (1024.0 * 1024.0);  // bytes -> MB
#else
    struct rusage ru{};
    getrusage(RUSAGE_SELF, &ru);
#if defined(__APPLE__)
    return ru.ru_maxrss / (1024.0 * 1024.0);  // bytes on macOS
#else
    return ru.ru_maxrss / 1024.0;              // KB on Linux
#endif
#endif
}

// Recursive on-disk byte size of a directory.
uint64_t dirBytes(const std::string& dir) {
    uint64_t total = 0;
    std::error_code ec;
    for (auto it = std::filesystem::recursive_directory_iterator(dir, ec);
         !ec && it != std::filesystem::recursive_directory_iterator(); it.increment(ec)) {
        if (it->is_regular_file(ec)) total += static_cast<uint64_t>(it->file_size(ec));
    }
    return total;
}

// Process ONE window size via the whole-file (reference) path. Writes tiles to
// outDir/<subdir>/ and fills winInfo (manifest metadata) + st (timing).
int windowWholeFile(const std::string& inPath, const std::string& outDir,
                    const std::string& subdir, StftParams& stft, TilingParams& tiling,
                    WindowInfo& wi, StreamStats& st) {
    std::string err;
    const auto t0 = std::chrono::steady_clock::now();
    AudioData audio;
    if (!loadAudioMono(inPath, audio, err)) { std::fprintf(stderr, "Error: %s\n", err.c_str()); return 1; }
    const auto t1 = std::chrono::steady_clock::now();
    DbGrid grid;
    if (!computeSpectrogram(audio.samples, audio.sampleRate, stft, grid, err)) {
        std::fprintf(stderr, "Error: %s\n", err.c_str());
        return 1;
    }
    const auto t2 = std::chrono::steady_clock::now();
    TilingResult tiles;
    if (!buildTiledPyramid(grid, outDir, subdir, tiling, tiles, wi, err)) {
        std::fprintf(stderr, "Error: %s\n", err.c_str());
        return 1;
    }
    const auto t3 = std::chrono::steady_clock::now();

    st.sampleRate = audio.sampleRate;
    st.channels = audio.sourceChannels;
    st.totalFrames = audio.numFrames;
    st.durationSeconds = audio.sampleRate ? static_cast<double>(audio.numFrames) / audio.sampleRate : 0.0;
    st.numColumns = grid.numFrames;
    st.numLevels = static_cast<int>(tiles.levels.size());
    st.totalTiles = tiles.totalTiles;
    st.numChunks = 1;   // whole-file = a single pass
    st.chunkCols = grid.numFrames;
    st.decodeSeconds = millis(t0, t1) / 1000.0;
    st.stftSeconds = millis(t1, t2) / 1000.0;
    st.tileSeconds = millis(t2, t3) / 1000.0;
    st.totalSeconds = millis(t0, t3) / 1000.0;
    st.chunkWallMinMs = st.chunkWallMeanMs = st.chunkWallMedianMs = st.chunkWallMaxMs = millis(t0, t3);
    st.peakMemMB = peakMemMB();
    st.outputBytes = dirBytes((std::filesystem::path(outDir) / subdir).string());
    return 0;
}

// Plain-language, jargon-free report (console + file): one block per window size,
// then totals, then a single projected-disk figure for a full 2-hour recording.
std::string buildMetrics(const std::string& inPath,
                         const std::vector<WindowInfo>& windows,
                         const std::vector<StreamStats>& per) {
    const StreamStats& s0 = per[0];
    const std::string fname = std::filesystem::path(inPath).filename().string();
    const int durMin = static_cast<int>(s0.durationSeconds / 60);
    const int durSec = static_cast<int>(s0.durationSeconds - durMin * 60);

    std::string wlist;
    for (size_t i = 0; i < windows.size(); ++i) {
        if (i) wlist += ", ";
        wlist += std::to_string(windows[i].fftSize);
    }

    char line[640];
    std::string out = "Spectrogram generation report\n";
    std::snprintf(line, sizeof(line), "File: %s\n", fname.c_str());
    out += line;
    std::snprintf(line, sizeof(line),
                  "Duration: %02d:%02d  |  Sample rate: %u Hz  |  Channels: %u\n",
                  durMin, durSec, s0.sampleRate, s0.channels);
    out += line;
    std::snprintf(line, sizeof(line), "Window sizes: %s\n\nPer window:\n", wlist.c_str());
    out += line;

    double totalTime = 0.0, peakRSS = 0.0;
    uint64_t totalDisk = 0;
    for (size_t i = 0; i < windows.size(); ++i) {
        const WindowInfo& w = windows[i];
        const StreamStats& s = per[i];
        const double windowMs = static_cast<double>(w.fftSize) / s0.sampleRate * 1000.0;
        const double hzBin = static_cast<double>(s0.sampleRate) / w.fftSize;
        totalTime += s.totalSeconds;
        totalDisk += s.outputBytes;
        peakRSS = std::max(peakRSS, s.peakMemMB);
        std::snprintf(line, sizeof(line),
            "  window %d  (hop %d, %.1f ms window, %.1f Hz/bin)\n"
            "    chunks %d  ·  avg %.1f ms/chunk (min %.1f, max %.1f)  ·  time %.3f s\n"
            "    levels %d  ·  tiles %d  ·  disk %.1f MB  ·  peak memory %.0f MB\n",
            w.fftSize, w.hopSize, windowMs, hzBin,
            s.numChunks, s.chunkWallMeanMs, s.chunkWallMinMs, s.chunkWallMaxMs, s.totalSeconds,
            s.numLevels, s.totalTiles, s.outputBytes / (1024.0 * 1024.0), s.peakMemMB);
        out += line;
    }

    const double rt = totalTime > 0 ? s0.durationSeconds / totalTime : 0.0;
    const double totalDiskMB = totalDisk / (1024.0 * 1024.0);
    const double bytesPerSec = s0.durationSeconds > 0 ? totalDisk / s0.durationSeconds : 0.0;
    const double proj2hGB = bytesPerSec * 7200.0 / (1024.0 * 1024.0 * 1024.0);

    out += "\nTotals:\n";
    std::snprintf(line, sizeof(line), "  Total generation time: %.3f s\n", totalTime);
    out += line;
    std::snprintf(line, sizeof(line),
                  "  Realtime factor: %.0fx  (processed %.0fx faster than playback speed)\n", rt, rt);
    out += line;
    std::snprintf(line, sizeof(line),
                  "  Peak memory used: %.0f MB  (bounded; set by the largest window, not the file length)\n",
                  peakRSS);
    out += line;
    std::snprintf(line, sizeof(line),
                  "  Output size on disk: %.1f MB  (this recording, all windows)\n", totalDiskMB);
    out += line;

    out += "\nFor storage planning:\n";
    std::snprintf(line, sizeof(line),
                  "  A full 2-hour recording at these window sizes (%s) would use about %.1f GB\n"
                  "  on disk (estimated by scaling this recording's size to 2 hours).\n",
                  wlist.c_str(), proj2hGB);
    out += line;
    return out;
}

// Process ONE window size via the streaming (default) path.
int windowStream(const std::string& inPath, const std::string& outDir,
                 const std::string& subdir, StftParams& stft, TilingParams& tiling,
                 int64_t chunkCols, bool embedDiag, WindowInfo& wi, StreamStats& st) {
    std::string err;
    if (!runStreaming(inPath, outDir, subdir, stft, tiling, chunkCols, embedDiag, st, wi, err)) {
        std::fprintf(stderr, "Error: %s\n", err.c_str());
        return 1;
    }
    return 0;
}

} // namespace

int main(int argc, char** argv) {
    if (argc < 3) {
        printUsage(argv[0]);
        return 2;
    }

    const std::string inPath = argv[1];
    const std::string outDir = argv[2];
    StftParams stft;
    TilingParams tiling;
    int threadsArg = 0;
    int64_t chunkCols = 8192;
    bool stream = true;
    bool embedDiag = false;
    std::vector<int> windowSizes;   // empty => use default below
    double overlap = 0.5;           // hop = round(N * (1 - overlap)) per window
    int hopOverride = 0;            // --hop (only valid with a single window)

    for (int i = 3; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--threads") {
            threadsArg = std::atoi(requireValue(argc, argv, i, "--threads"));
        } else if (arg == "--chunk") {
            chunkCols = std::atoll(requireValue(argc, argv, i, "--chunk"));
        } else if (arg == "--embed-diagnostics") {
            embedDiag = true;
        } else if (arg == "--no-stream") {
            stream = false;
        } else if (arg == "--window-sizes") {
            std::string wErr;
            if (!parseWindowSizes(requireValue(argc, argv, i, "--window-sizes"), windowSizes, wErr)) {
                std::fprintf(stderr, "Error: %s\n", wErr.c_str());
                return 2;
            }
        } else if (arg == "--overlap") {
            overlap = std::atof(requireValue(argc, argv, i, "--overlap"));
            if (!(overlap >= 0.0 && overlap < 1.0)) {
                std::fprintf(stderr, "Error: --overlap must be in [0, 1) (got %g)\n", overlap);
                return 2;
            }
        } else if (arg == "--fft") {
            // Deprecated alias for a single-value --window-sizes.
            std::string wErr;
            if (!parseWindowSizes(requireValue(argc, argv, i, "--fft"), windowSizes, wErr) ||
                windowSizes.size() != 1) {
                std::fprintf(stderr, "Error: --fft takes one power-of-two window size%s\n",
                             wErr.empty() ? "" : (" (" + wErr + ")").c_str());
                return 2;
            }
            std::fprintf(stderr, "Note: --fft is deprecated; use --window-sizes %d.\n",
                         windowSizes[0]);
        } else if (arg == "--hop") {
            hopOverride = std::atoi(requireValue(argc, argv, i, "--hop"));
        } else if (arg == "--tile-width") {
            tiling.tileWidth = std::atoi(requireValue(argc, argv, i, "--tile-width"));
        } else if (arg == "--db-min") {
            tiling.render.dbMin = static_cast<float>(std::atof(requireValue(argc, argv, i, "--db-min")));
        } else if (arg == "--db-max") {
            tiling.render.dbMax = static_cast<float>(std::atof(requireValue(argc, argv, i, "--db-max")));
        } else if (arg == "--freq-scale") {
            const std::string v = requireValue(argc, argv, i, "--freq-scale");
            if (v == "log") {
                tiling.render.freqScale = FreqScale::Log;
            } else if (v == "linear") {
                tiling.render.freqScale = FreqScale::Linear;
            } else {
                std::fprintf(stderr, "Error: --freq-scale must be 'linear' or 'log'\n");
                return 2;
            }
        } else if (arg == "--preview") {
            tiling.writePreview = true;
        } else if (arg == "-h" || arg == "--help") {
            printUsage(argv[0]);
            return 0;
        } else {
            std::fprintf(stderr, "Error: unknown argument '%s'\n", arg.c_str());
            printUsage(argv[0]);
            return 2;
        }
    }

    stft.numThreads = threadsArg;
    tiling.numThreads = threadsArg;
    const unsigned threadsUsed = resolveThreadCount(threadsArg);

    std::error_code ec;
    std::filesystem::create_directories(outDir, ec);
    if (ec) {
        std::fprintf(stderr, "Error: could not create output dir '%s': %s\n",
                     outDir.c_str(), ec.message().c_str());
        return 1;
    }

    if (tiling.writePreview && stream) {
        std::fprintf(stderr, "Note: --preview requires --no-stream; skipping preview.\n");
        tiling.writePreview = false;
    }
    if (embedDiag && !stream) {
        std::fprintf(stderr, "Note: --embed-diagnostics applies to the streaming path only.\n");
    }

    // Window sizes to precompute (one pyramid per size, under w<N>/). Default set.
    if (windowSizes.empty()) windowSizes = {1024, 4096};
    if (hopOverride > 0 && windowSizes.size() > 1) {
        std::fprintf(stderr, "Error: --hop (a fixed hop) cannot be combined with more than one "
                             "window size; use --overlap so the hop derives from each window.\n");
        return 2;
    }
    const int defaultWindow = windowSizes[0];   // first listed = the default view
    std::printf("Threads: %u   Windows:", threadsUsed);
    for (int N : windowSizes) std::printf(" %d", N);
    std::printf("\n");

    std::vector<WindowInfo> windows;
    std::vector<StreamStats> perWindow;
    for (int N : windowSizes) {
        StftParams wstft = stft;
        wstft.fftSize = N;
        // Hop: explicit override (single window only) or derived from --overlap.
        wstft.hopSize = hopOverride > 0 ? hopOverride
                                        : std::max(1, static_cast<int>(N * (1.0 - overlap) + 0.5));
        const std::string subdir = "w" + std::to_string(N);
        WindowInfo wi;
        StreamStats st;
        const int rc = stream
            ? windowStream(inPath, outDir, subdir, wstft, tiling, chunkCols, embedDiag, wi, st)
            : windowWholeFile(inPath, outDir, subdir, wstft, tiling, wi, st);
        if (rc != 0) return rc;
        windows.push_back(std::move(wi));
        perWindow.push_back(st);
    }

    // Assemble the single v2 manifest describing every window.
    ManifestV2 mf;
    mf.sampleRate = perWindow[0].sampleRate;
    mf.totalSamples = perWindow[0].totalFrames;
    mf.channels = perWindow[0].channels;
    mf.dbMin = tiling.render.dbMin;
    mf.dbMax = tiling.render.dbMax;
    mf.colormap = tiling.colormapName;
    mf.frequencyScale = tiling.render.freqScale == FreqScale::Log ? "log" : "linear";
    mf.tileWidth = tiling.tileWidth;
    mf.defaultWindow = defaultWindow;
    mf.windows = std::move(windows);
    const std::string manifestPath = (std::filesystem::path(outDir) / "manifest.json").string();
    std::string mErr;
    if (!writeManifestV2(mf, manifestPath, mErr)) {
        std::fprintf(stderr, "Error: %s\n", mErr.c_str());
        return 1;
    }

    // Plain metrics report: one block per window, totals, projected 2h disk.
    const std::string metrics = buildMetrics(inPath, mf.windows, perWindow);
    const std::string metricsPath = (std::filesystem::path(outDir) / "metrics.txt").string();
    std::ofstream metricsFile(metricsPath);
    if (metricsFile) metricsFile << metrics;
    std::printf("\n%s\n", metrics.c_str());
    std::printf("Wrote %s\n", manifestPath.c_str());
    std::printf("Output: %s/  (manifest.json, w<N>/, metrics.txt)\n", outDir.c_str());
    if (embedDiag) std::printf("(detailed diagnostics embedded in manifest.json)\n");
    return 0;
}
