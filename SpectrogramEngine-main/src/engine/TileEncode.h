#pragma once
#include <string>
#include <vector>

#include "SpectrogramImage.h"  // RenderParams, FreqScale

namespace spectro {

// Precompute the output-row -> source-bin mapping for a given frequency scale.
// The result has `numBins` entries (tile height is unchanged); rowToBin[y] is the
// dB bin sampled for output row y (row 0 = top = highest frequency). This is the
// same for every tile, so callers build it once. Linear reproduces the previous
// 1:1 mapping exactly, so linear output is byte-identical to before.
void buildRowToBin(int numBins, double hzPerBin, FreqScale scale,
                   std::vector<int>& rowToBin);

// Encodes columns [colStart, colStart+width) of a column-major dB buffer
// (db[col*numBins + bin]) to an RGB PNG tile using the magma colormap, sampling
// bins via `rowToBin` (see buildRowToBin). Shared by the whole-file pyramid and
// the streaming engine so tile bytes are identical. Fills `err` on failure.
bool writeTilePng(const float* db, int numBins, int colStart, int width,
                  const RenderParams& rp, const int* rowToBin,
                  const std::string& path, std::string& err);

} // namespace spectro
