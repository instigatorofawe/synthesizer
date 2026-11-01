#include <benchmark/benchmark.h>

static void BM_Noop(benchmark::State& state) {
    for (auto _ : state) {
        benchmark::ClobberMemory();
    }
}
BENCHMARK(BM_Noop);
