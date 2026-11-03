// The pieces and the demo on a thread pool, against the same engine run serially, at both frame sizes. Section 18 of
// docs/Design.md says the pool pays only where tasks are long, and that worst frames wait for Milestone 7, so each
// frame is timed as in RecipeBench.cpp. Each runs the first 20 s of its Program, or the whole of a shorter one.

#include <algorithm>
#include <array>
#include <benchmark/benchmark.h>
#include <chrono>
#include <cstddef>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include <modsynth/Compiler.hpp>
#include <modsynth/Modsynth.hpp>
#include <modsynth/Parallel.hpp>

namespace {

using namespace modsynth;
using Clock = std::chrono::steady_clock;

constexpr float kRate = 48000.0f;
constexpr u32 kSeconds = 20;
constexpr std::size_t kArena = 64u << 20;

std::string read(const std::filesystem::path& path) {
    std::ifstream in(path);
    std::stringstream text;
    text << in.rdbuf();
    return text.str();
}

// A pool's tasks must not share a cache line, which holds only if the memory they are in starts on one.
struct Aligned {
    explicit Aligned(std::size_t n) : data(static_cast<std::byte*>(std::aligned_alloc(64, n))), size(n) {}
    ~Aligned() { std::free(data); }
    std::byte* data;
    std::size_t size;
};

template <u32 Frame, class E>
void play(benchmark::State& state, const std::filesystem::path& path, u32 workers) {
    compiler::json request = compiler::json::parse(read(path));
    request["frame_size"] = Frame;
    const auto compiled = compiler::compile_image_checked(request.dump());
    if (!compiled.report.value("ok", false)) {
        state.SkipWithError(compiled.report.dump());
        return;
    }
    std::vector<u64> image((compiled.image.size() + 7) / 8);
    std::memcpy(image.data(), compiled.image.data(), compiled.image.size());
    const ByteSpan bytes{reinterpret_cast<const std::byte*>(image.data()), compiled.image.size()};
    constexpr SynthConfig kConfig{.frame_size = Frame, .channels = 2, .tap_slots = 0, .generations = 1};
    using Engine = Synth<kConfig, ScalarBackend, E>;

    Aligned fast(kArena), bulk(kArena);
    std::vector<ChunkRef> refs(kMaxChunks);
    alignas(64) float left[Frame], right[Frame];
    const std::array<float*, 2> outputs{left, right};
    std::unique_ptr<ThreadPool> pool;
    if constexpr (!std::is_same_v<E, SerialExecutor>) pool = std::make_unique<ThreadPool>(workers);

    std::vector<std::uint32_t> times;
    for (auto _ : state) {
        ChunkTable chunks{std::span(refs)};
        std::unique_ptr<Engine> engine;
        if constexpr (std::is_same_v<E, SerialExecutor>) {
            engine = std::make_unique<Engine>(
                typename Engine::Memory{{fast.data, fast.size}, {bulk.data, bulk.size}, kRate});
        } else {
            engine = std::make_unique<Engine>(
                typename Engine::Memory{{fast.data, fast.size}, {bulk.data, bulk.size}, kRate}, E{pool.get()});
        }
        engine->load(chunks, bytes, 0);
        while (engine->pump(1 << 20)) {
        }
        engine->send({.kind = EventKind::Play});
        std::uint64_t total = 0;
        const u32 frames = static_cast<u32>(kSeconds * kRate) / Frame;
        for (u32 f = 0; f < frames; ++f) {
            const auto from = Clock::now();
            engine->render(outputs);
            const auto took = std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now() - from).count();
            total += static_cast<std::uint64_t>(took);
            times.push_back(static_cast<std::uint32_t>(took));
        }
        benchmark::DoNotOptimize(left[0]);
        state.SetIterationTime(static_cast<double>(total) * 1e-9);
        state.counters["frame_ns"] = static_cast<double>(total) / frames;
    }
    if (times.empty()) return;
    const auto rank = times.begin() + static_cast<std::ptrdiff_t>(times.size() * 999 / 1000);
    std::nth_element(times.begin(), rank, times.end());
    state.counters["p999_frame_ns"] = *rank;
    state.counters["worst_frame_ns"] = *std::max_element(times.begin(), times.end());
    state.counters["workers"] = workers;
}

const bool g_registered = [] {
    std::vector<std::filesystem::path> programs;
    for (const auto& entry : std::filesystem::directory_iterator(MODSYNTH_PIECES)) {
        if (entry.path().extension() == ".json" && entry.path().stem() != "Index") programs.push_back(entry.path());
    }
    std::sort(programs.begin(), programs.end());
    programs.push_back(std::filesystem::path(MODSYNTH_RECIPES).parent_path() / "Demo.json");
    for (const auto& path : programs) {
        const std::string name = "Parallel/" + path.stem().string();
        benchmark::RegisterBenchmark(name + "/32/serial", play<32, SerialExecutor>, path, 1)->UseManualTime();
        benchmark::RegisterBenchmark(name + "/128/serial", play<128, SerialExecutor>, path, 1)->UseManualTime();
        for (const u32 workers : {2u, 4u, 8u}) {
            const std::string count = std::to_string(workers);
            benchmark::RegisterBenchmark(name + "/32/" + count, play<32, PoolExecutor<>>, path, workers)
                ->UseManualTime();
            benchmark::RegisterBenchmark(name + "/128/" + count, play<128, PoolExecutor<>>, path, workers)
                ->UseManualTime();
        }
    }
    return true;
}();

}  // namespace
