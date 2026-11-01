#pragma once

// A test double: one thread, a random valid order each frame. If two orders the Plan allows sound different, a
// dependency is missing, and this finds that with no threads at all, on every target. It allocates nothing, so firmware
// can use it.

#include <cstdint>

#include <modsynth/Executor.hpp>
#include <modsynth/Format.hpp>

namespace modsynth {

struct ShuffledExecutor {
    static constexpr u32 max_workers = 1;
    static constexpr bool uses_edges = true;
    using Plan = Schedule;
    u32 state = 1234;

    template <class F>
    void run(const Schedule& s, F&& f) {
        u16 pending[kMaxTasks];
        u16 ready[kMaxTasks];
        u32 count = 0;
        for (u32 t = 0; t < s.count; ++t) {
            pending[t] = s.deps[t];
            if (pending[t] == 0) ready[count++] = static_cast<u16>(t);
        }
        while (count != 0) {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            const u32 i = state % count;
            const u32 t = ready[i];
            ready[i] = ready[--count];
            f(t, 0u);
            for (u32 e = s.succ_begin[t]; e < s.succ_begin[t + 1]; ++e) {
                if (--pending[s.succ[e]] == 0) ready[count++] = s.succ[e];
            }
        }
    }
};

}  // namespace modsynth
