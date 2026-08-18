#pragma once
#include <string>

#include "Stft.h"

namespace spectro {

// How the frequency (vertical) axis is laid out when tiles are rendered.
//  - Linear: row r maps 1:1 to bin (numBins-1 - r); default, unchanged behavior.
//  - Log:    row r maps to a log-spaced frequency between bin 1 and Nyquist
//            (DC excluded), like Sonic Visualiser's log spectrogram.
enum class FreqScale { Linear, Log };

// Display range for the dB -> color mapping. Values at/below dbMin map to the
// colormap floor; values at/above dbMax map to the peak.
struct RenderParams {
    float dbMin = -100.0f;
    float dbMax = 0.0f;
    FreqScale freqScale = FreqScale::Linear;
};

// Renders a dB grid to an RGB PNG using the magma colormap.
// Image width = numFrames (time, left->right), height = numBins (frequency).
// Low frequencies are at the bottom, high frequencies at the top (standard
// spectrogram orientation). Returns false and fills `err` on failure.
bool writeSpectrogramPng(const DbGrid& grid, const RenderParams& params,
                         const std::string& path, std::string& err);

} // namespace spectro
