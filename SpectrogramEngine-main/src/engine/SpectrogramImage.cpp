#include "SpectrogramImage.h"

#include "Colormap.h"
#include "stb_image_write.h"  // declarations only; impl in third_party_impl.cpp

#include <vector>

namespace spectro {

bool writeSpectrogramPng(const DbGrid& grid, const RenderParams& params,
                         const std::string& path, std::string& err) {
    if (grid.numFrames <= 0 || grid.numBins <= 0 || grid.db.empty()) {
        err = "empty spectrogram grid.";
        return false;
    }

    const int W = grid.numFrames;
    const int H = grid.numBins;
    const float range = (params.dbMax > params.dbMin) ? (params.dbMax - params.dbMin) : 1.0f;

    std::vector<unsigned char> img(static_cast<size_t>(W) * H * 3);
    for (int y = 0; y < H; ++y) {
        // Row 0 is the top of the image = highest frequency bin.
        const int bin = (H - 1) - y;
        for (int x = 0; x < W; ++x) {
            const float db = grid.db[static_cast<size_t>(x) * grid.numBins + bin];
            float t = (db - params.dbMin) / range;
            if (t < 0.0f) t = 0.0f;
            if (t > 1.0f) t = 1.0f;
            uint8_t r, g, b;
            magmaColor(t, r, g, b);
            const size_t o = (static_cast<size_t>(y) * W + x) * 3;
            img[o + 0] = r;
            img[o + 1] = g;
            img[o + 2] = b;
        }
    }

    const int ok = stbi_write_png(path.c_str(), W, H, 3, img.data(), W * 3);
    if (!ok) {
        err = "stbi_write_png failed for " + path;
        return false;
    }
    return true;
}

} // namespace spectro
