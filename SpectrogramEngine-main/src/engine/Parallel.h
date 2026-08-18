#pragma once
#include <cstdint>
#include <functional>

namespace spectro {

// Resolve a requested thread count: 0 means "use hardware concurrency". The
// result is always >= 1 (falls back to 1 if hardware_concurrency() is unknown).
unsigned resolveThreadCount(int requested);

// Partition the half-open range [begin, end) into up to `numThreads` contiguous
// blocks and run `body(blockBegin, blockEnd, threadIndex)` for each block in
// parallel (block 0 runs on the calling thread). Blocks are disjoint, so `body`
// may write to per-index outputs with no locking. Runs inline with no extra
// threads when numThreads <= 1 or the range has a single element.
//
// Uses std::thread only (no OpenMP). Threads are created per call; for the POC's
// handful of parallel regions that overhead is negligible next to the work.
void parallelBlocks(int64_t begin, int64_t end, unsigned numThreads,
                    const std::function<void(int64_t, int64_t, unsigned)>& body);

} // namespace spectro
