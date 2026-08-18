#pragma once
#include <cstdint>

namespace spectro {

// Maps a normalized value t in [0,1] to an RGB color using the perceptual
// "magma" colormap (dark -> purple -> red -> orange -> pale yellow). This is
// what makes the output read like a real spectrogram. Values are clamped.
void magmaColor(float t, uint8_t& r, uint8_t& g, uint8_t& b);

} // namespace spectro
