// Every recipe played from start to end, on a host. docs/Design.md section 17 asks for the worst frame and p99.9, so
// each frame is timed by hand. A clock read costs tens of nanoseconds, and on a Mac ticks every 41.7 ns, which matters
// to a small frame and not to a worst one.

#include <algorithm>
#include <array>
#include <benchmark/benchmark.h>
#include <chrono>
#include <cstddef>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include <modsynth/Compiler.hpp>
#include <modsynth/Modsynth.hpp>

namespace {

using namespace modsynth;
using Clock = std::chrono::steady_clock;

constexpr SynthConfig kConfig{.frame_size = 32, .channels = 2, .tap_slots = 0, .generations = 1};
using Engine = Synth<kConfig, ScalarBackend>;
constexpr float kRate = 48000.0f;
constexpr std::size_t kArena = 8 << 20;

const std::filesystem::path kRecipes = MODSYNTH_RECIPES;

std::string read(const std::filesystem::path& path) {
    std::ifstream in(path);
    std::stringstream text;
    text << in.rdbuf();
    return text.str();
}

void recipe(benchmark::State& state, const std::string& file, u32 frames) {
    const auto compiled = compiler::compile_image_checked(read(kRecipes / file));
    if (!compiled.report.value("ok", false)) {
        state.SkipWithError(compiled.report.dump());
        return;
    }
    std::vector<u64> image((compiled.image.size() + 7) / 8);
    std::memcpy(image.data(), compiled.image.data(), compiled.image.size());
    const ByteSpan bytes{reinterpret_cast<const std::byte*>(image.data()), compiled.image.size()};

    std::vector<std::byte> fast(kArena), bulk(kArena);
    std::vector<ChunkRef> refs(kMaxChunks);
    alignas(16) float left[kConfig.frame_size], right[kConfig.frame_size];
    const std::array<float*, kConfig.channels> outputs{left, right};

    std::vector<std::uint32_t> times;
    for (auto _ : state) {
        ChunkTable chunks{std::span(refs)};
        const auto engine = std::make_unique<Engine>(typename Engine::Memory{fast, bulk, kRate});
        engine->load(chunks, bytes, 0);
        while (engine->pump(1 << 16)) {
        }
        engine->send({.kind = EventKind::Play});
        std::uint64_t total = 0;
        for (u32 f = 0; f < frames; ++f) {
            const auto from = Clock::now();
            engine->render(outputs);
            const auto took = std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now() - from).count();
            total += static_cast<std::uint64_t>(took);
            times.push_back(static_cast<std::uint32_t>(took));
        }
        benchmark::DoNotOptimize(left[0]);
        state.SetIterationTime(static_cast<double>(total) * 1e-9);
    }
    if (times.empty()) return;
    const auto rank = times.begin() + static_cast<std::ptrdiff_t>(times.size() * 999 / 1000);
    std::nth_element(times.begin(), rank, times.end());
    state.counters["p999_frame_ns"] = *rank;
    state.counters["worst_frame_ns"] = *std::max_element(times.begin(), times.end());
    state.SetItemsProcessed(state.iterations() * frames * kConfig.frame_size);
}

const bool g_registered = [] {
    for (const auto& entry : compiler::json::parse(read(kRecipes / "Index.json"))) {
        const auto seconds = entry.at("seconds").get<float>();
        const auto frames = static_cast<u32>(seconds * kRate / static_cast<float>(kConfig.frame_size));
        benchmark::RegisterBenchmark("Recipe/" + entry.at("name").get<std::string>(), recipe,
                                     entry.at("file").get<std::string>(), frames)
            ->UseManualTime();
    }
    return true;
}();

}  // namespace
