#pragma once

// The parallel seam. Nothing here needs <thread> or <atomic>, so a bare-metal build compiles it as is.
// PoolExecutor lives in modsynth/Parallel.hpp, and core headers never include that.

#include <concepts>
#include <cstdint>

namespace modsynth {

// What an executor that honours dependencies schedules from. Serial builds never build one.
struct Schedule {
    std::uint32_t count;
    const std::uint16_t* deps;        // unresolved dependencies per task
    const std::uint16_t* succ_begin;  // count + 1 entries
    const std::uint16_t* succ;
};

template <class E>
concept Executor = requires {
    { E::max_workers } -> std::convertible_to<std::uint32_t>;
    { E::uses_edges } -> std::convertible_to<bool>;
    typename E::Plan;
};

struct SerialExecutor {
    static constexpr std::uint32_t max_workers = 1;
    static constexpr bool uses_edges = false;

    struct Plan {
        std::uint32_t count = 0;
    };

    template <class F>
    [[gnu::always_inline]] void run(const Plan& plan, F&& f) {
        for (std::uint32_t task = 0; task < plan.count; ++task) f(task, 0u);
    }
};

}  // namespace modsynth
