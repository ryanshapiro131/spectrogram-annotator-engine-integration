#include "Manifest.h"

#include "nlohmann/json.hpp"

#include <fstream>

namespace spectro {

bool writeManifestV2(const ManifestV2& m, const std::string& path, std::string& err) {
    using nlohmann::json;

    const double durationSeconds =
        m.sampleRate > 0 ? static_cast<double>(m.totalSamples) / m.sampleRate : 0.0;
    const bool isLog = (m.frequencyScale == "log");

    json root;
    root["version"] = 2;
    root["generator"] = "spectrogram-engine";

    // ---- global (window-independent) ----
    root["sampleRate"] = m.sampleRate;
    root["totalSamples"] = m.totalSamples;
    root["durationSeconds"] = durationSeconds;
    root["channels"] = m.channels;
    root["colormap"] = m.colormap;
    root["dbRange"] = {{"min", m.dbMin}, {"max", m.dbMax}};
    root["frequencyScale"] = m.frequencyScale;
    root["tileWidth"] = m.tileWidth;
    root["tilePathPattern"] = "w{window}/L{level}/{tile}.png";
    root["lastTileMayBePartial"] = true;
    root["columnTimeConvention"] =
        "timeSeconds = columnIndex * secondsPerColumn (column = window starting at columnIndex*hopSize)";
    root["defaultWindow"] = m.defaultWindow;

    // ---- per window size ----
    json jwindows = json::array();
    for (const auto& w : m.windows) {
        const double hzPerBin =
            w.fftSize > 0 ? static_cast<double>(m.sampleRate) / w.fftSize : 0.0;
        json jw;
        jw["fftSize"] = w.fftSize;
        jw["hopSize"] = w.hopSize;
        jw["windowType"] = "hann";
        jw["numFrequencyBins"] = w.numBins;
        jw["tileHeight"] = w.numBins;
        jw["hzPerBin"] = hzPerBin;
        jw["secondsPerColumn"] = w.secondsPerColumn;          // level-0 native
        jw["minFrequencyHz"] = isLog ? hzPerBin : 0.0;        // per-window on a log axis
        jw["maxFrequencyHz"] = m.sampleRate / 2.0;

        json jlevels = json::array();
        for (const auto& L : w.levels) {
            jlevels.push_back({
                {"level", L.level},
                {"numColumns", L.numColumns},
                {"secondsPerColumn", L.secondsPerColumn},
                {"numTiles", L.numTiles},
                {"widthPixels", L.numColumns},
                {"heightPixels", w.numBins},
            });
        }
        jw["levels"] = jlevels;

        if (!w.diagnosticsJson.empty()) {
            jw["diagnostics"] = json::parse(w.diagnosticsJson, nullptr, /*allow_exceptions=*/false);
        }
        jwindows.push_back(jw);
    }
    root["windows"] = jwindows;

    std::ofstream ofs(path);
    if (!ofs) {
        err = "could not open manifest for writing: " + path;
        return false;
    }
    ofs << root.dump(2) << "\n";
    return true;
}

} // namespace spectro
