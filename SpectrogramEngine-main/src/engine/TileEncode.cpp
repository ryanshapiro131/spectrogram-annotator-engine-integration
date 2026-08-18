#include "TileEncode.h"

#include "Colormap.h"
#include "stb_image_write.h"  // declarations only; impl in third_party_impl.cpp

#include <cmath>
#include <cstdint>
#include <vector>

namespace spectro {

void buildRowToBin(int numBins, double hzPerBin, FreqScale scale,
                   std::vector<int>& rowToBin) {
    rowToBin.resize(numBins);  // output height == numBins (unchanged)
    if (scale == FreqScale::Linear) {
        for (int y = 0; y < numBins; ++y) rowToBin[y] = (numBins - 1) - y;
        return;
    }
    // Log axis: top row = Nyquist, bottom row = bin 1 (DC excluded, log(0) undefined).
    const int H = numBins;
    const double fMax = (numBins - 1) * hzPerBin;  // Nyquist
    const double fMin = hzPerBin;                  // first bin above DC
    for (int y = 0; y < H; ++y) {
        const double frac = (H > 1) ? static_cast<double>(y) / (H - 1) : 0.0;
        const double v = 1.0 - frac;  // 1 at top .. 0 at bottom
        const double f = fMin * std::pow(fMax / fMin, v);
        int bin = static_cast<int>(std::lround(f / hzPerBin));
        if (bin < 0) bin = 0;
        if (bin > numBins - 1) bin = numBins - 1;
        rowToBin[y] = bin;
    }
}

bool writeTilePng(const float* db, int numBins, int colStart, int width,
                  const RenderParams& rp, const int* rowToBin,
                  const std::string& path, std::string& err) {
    const float range = (rp.dbMax > rp.dbMin) ? (rp.dbMax - rp.dbMin) : 1.0f;
    std::vector<unsigned char> img(static_cast<size_t>(width) * numBins * 3);
    for (int y = 0; y < numBins; ++y) {
        const int bin = rowToBin[y];  // row 0 = top; mapping set by frequency scale
        for (int x = 0; x < width; ++x) {
            const int col = colStart + x;
            const float dbv = db[static_cast<size_t>(col) * numBins + bin];
            float t = (dbv - rp.dbMin) / range;
            if (t < 0.0f) t = 0.0f;
            if (t > 1.0f) t = 1.0f;
            uint8_t r, g, b;
            magmaColor(t, r, g, b);
            const size_t o = (static_cast<size_t>(y) * width + x) * 3;
            img[o + 0] = r;
            img[o + 1] = g;
            img[o + 2] = b;
        }
    }
    if (!stbi_write_png(path.c_str(), width, numBins, 3, img.data(), width * 3)) {
        err = "stbi_write_png failed for " + path;
        return false;
    }
    return true;
}

} // namespace spectro
