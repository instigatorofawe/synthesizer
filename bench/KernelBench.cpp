// One kernel at a time, on a host. These rank kernels on this machine only: docs/Design.md section 17 says why a host's
// figures aren't carried to Cortex-M, and firmware/Bench.cpp counts the same cases there.

#include <benchmark/benchmark.h>
#include <memory>

#include "KernelCases.hpp"

namespace {

using namespace modsynth_bench;

constexpr SynthConfig kConfig{.frame_size = 32, .channels = 2, .tap_slots = 0, .generations = 1};
using Rig = KernelRig<kConfig, ScalarBackend>;

void kernel(benchmark::State& state, const KernelCase& k) {
    const auto rig = std::make_unique<Rig>();
    rig->begin(k);
    for (auto _ : state) {
        rig->frame();
        benchmark::ClobberMemory();
    }
    benchmark::DoNotOptimize(rig->result());
    state.SetItemsProcessed(state.iterations() * kConfig.frame_size);
}

const bool g_registered = [] {
    for (const KernelCase& k : kKernelCases) benchmark::RegisterBenchmark(std::string("Kernel/") + k.name, kernel, k);
    return true;
}();

}  // namespace
