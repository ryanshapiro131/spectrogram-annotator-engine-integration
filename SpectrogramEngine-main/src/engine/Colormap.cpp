#include "Colormap.h"

namespace spectro {

// 16 evenly-spaced anchor points sampled from matplotlib's "magma" colormap
// (RGB, 0-255). We linearly interpolate between anchors at lookup time. This
// keeps the source compact while still looking like a proper spectrogram.
namespace {
constexpr int kNumAnchors = 16;
constexpr uint8_t kMagma[kNumAnchors][3] = {
    {  0,   0,   4},  // t = 0/15  (floor: near-black)
    { 10,   7,  35},
    { 28,  16,  70},
    { 54,  15, 107},
    { 81,  18, 124},
    {109,  24, 130},
    {135,  33, 130},
    {163,  40, 123},
    {190,  50, 110},
    {216,  66,  93},
    {237,  90,  74},
    {250, 120,  68},
    {254, 155,  78},
    {254, 189,  98},
    {253, 222, 131},
    {252, 253, 191},  // t = 15/15 (peak: pale yellow)
};
} // namespace

void magmaColor(float t, uint8_t& r, uint8_t& g, uint8_t& b) {
    if (t < 0.0f) t = 0.0f;
    if (t > 1.0f) t = 1.0f;
    // Position within the anchor table.
    float scaled = t * (kNumAnchors - 1);
    int i0 = static_cast<int>(scaled);
    if (i0 >= kNumAnchors - 1) i0 = kNumAnchors - 2;
    int i1 = i0 + 1;
    float f = scaled - static_cast<float>(i0);
    r = static_cast<uint8_t>(kMagma[i0][0] + f * (kMagma[i1][0] - kMagma[i0][0]) + 0.5f);
    g = static_cast<uint8_t>(kMagma[i0][1] + f * (kMagma[i1][1] - kMagma[i0][1]) + 0.5f);
    b = static_cast<uint8_t>(kMagma[i0][2] + f * (kMagma[i1][2] - kMagma[i0][2]) + 0.5f);
}

} // namespace spectro
