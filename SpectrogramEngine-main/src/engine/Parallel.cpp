#include "Parallel.h"

#include <algorithm>
#include <thread>
#include <vector>

namespace spectro {

unsigned resolveThreadCount(int requested) {
    if (requested > 0) return static_cast<unsigned>(requested);
    unsigned hc = std::thread::hardware_concurrency();
    return hc == 0 ? 1u : hc;
}

void parallelBlocks(int64_t begin, int64_t end, unsigned numThreads,
                    const std::function<void(int64_t, int64_t, unsigned)>& body) {
    const int64_t n = end - begin;
    if (n <= 0) return;

    unsigned threads = numThreads == 0 ? 1u : numThreads;
    if (threads <= 1 || n == 1) {
        body(begin, end, 0);
        return;
    }
    if (static_cast<int64_t>(threads) > n) threads = static_cast<unsigned>(n);

    const int64_t chunk = (n + threads - 1) / threads;
    std::vector<std::thread> pool;
    pool.reserve(threads - 1);
    // Blocks 1..threads-1 run on spawned threads; block 0 on the caller.
    for (unsigned t = 1; t < threads; ++t) {
        const int64_t b = begin + static_cast<int64_t>(t) * chunk;
        if (b >= end) break;
        const int64_t e = std::min(end, b + chunk);
        pool.emplace_back([&body, b, e, t]() { body(b, e, t); });
    }
    const int64_t e0 = std::min(end, begin + chunk);
    body(begin, e0, 0);
    for (auto& th : pool) th.join();
}

} // namespace spectro
