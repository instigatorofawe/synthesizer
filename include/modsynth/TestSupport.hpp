#pragma once

#include <DemoJson.hpp>
#include <cstddef>
#include <deque>
#include <memory>
#include <random>
#include <string>
#include <vector>

#include <modsynth/Compiler.hpp>
#include <modsynth/Modsynth.hpp>

namespace modsynth_test {

using namespace modsynth;
using compiler::json;

// One thread, a random valid order each frame. Finds an undeclared dependency with no threads at all.
struct ShuffledExecutor {
    static constexpr u32 max_workers = 1;
    static constexpr bool uses_edges = true;
    using Plan = Schedule;
    std::mt19937 rng{1234};

    template <class F>
    void run(const Schedule& s, F&& f) {
        std::vector<u32> ready;
        std::vector<u32> pending(s.deps, s.deps + s.count);
        for (u32 t = 0; t < s.count; ++t) {
            if (pending[t] == 0) ready.push_back(t);
        }
        while (!ready.empty()) {
            const std::size_t i = rng() % ready.size();
            const u32 t = ready[i];
            ready[i] = ready.back();
            ready.pop_back();
            f(t, 0u);
            for (u32 e = s.succ_begin[t]; e < s.succ_begin[t + 1]; ++e) {
                if (--pending[s.succ[e]] == 0) ready.push_back(s.succ[e]);
            }
        }
    }
};

inline constexpr SynthConfig kStereo{.frame_size = 128, .channels = 2, .tap_slots = 2, .generations = 2};
inline constexpr SynthConfig kMono{.frame_size = 128, .channels = 1, .tap_slots = 0, .generations = 1};
inline constexpr float kRate = 48000.0f;

inline json demo() { return json::parse(demo_json); }

// A loaded engine and everything it borrows, heap-allocated so its address is stable.
template <SynthConfig C, class E = SerialExecutor>
struct Rig {
    using Engine = Synth<C, ScalarBackend, E>;

    explicit Rig(std::vector<std::byte> bytes, u32 program = 0, std::byte fill = std::byte{0xCD},
                 std::size_t fast_size = 8 << 20, std::size_t bulk_size = 8 << 20)
        : image(aligned(bytes)),
          fast(fast_size, fill),
          bulk(bulk_size, fill),
          storage(kMaxChunks),
          chunks(storage),
          engine(typename Engine::Memory{fast, bulk, kRate}) {
        engine.load(chunks, {data(), bytes.size()}, program);
        while (engine.pump(1 << 16)) {
        }
    }

    [[nodiscard]] const std::byte* data() const { return reinterpret_cast<const std::byte*>(image.data()); }

    static std::vector<u64> aligned(const std::vector<std::byte>& bytes) {
        std::vector<u64> words((bytes.size() + 7) / 8);
        if (!bytes.empty()) std::memcpy(words.data(), bytes.data(), bytes.size());
        return words;
    }

    // Swaps to another image. Each stays alive for the whole test, as a generation may still be fading on one.
    void swap_to(const std::vector<std::byte>& bytes, u32 program = 0) {
        auto& next = swaps.emplace_back();
        next.image = aligned(bytes);
        next.storage.resize(kMaxChunks);
        next.chunks = ChunkTable(next.storage);
        engine.load(next.chunks, {reinterpret_cast<const std::byte*>(next.image.data()), bytes.size()}, program);
    }

    std::vector<u64> image;
    std::vector<std::byte> fast, bulk;
    std::vector<ChunkRef> storage;
    ChunkTable chunks;
    Engine engine;

    struct Swap {
        std::vector<u64> image;
        std::vector<ChunkRef> storage;
        ChunkTable chunks;
    };
    std::deque<Swap> swaps;
};

// Validates an image into a table, for tests that need its hashes.
struct LoadedImage {
    explicit LoadedImage(const std::vector<std::byte>& bytes)
        : words((bytes.size() + 7) / 8), storage(kMaxChunks), table(storage), loader(table) {
        std::memcpy(words.data(), bytes.data(), bytes.size());
        loader.begin({reinterpret_cast<const std::byte*>(words.data()), bytes.size()});
        while (loader.step(1 << 20) == LoadStatus::Working) {
        }
    }
    std::vector<u64> words;
    std::vector<ChunkRef> storage;
    ChunkTable table;
    Loader loader;
};

template <class R>
[[nodiscard]] std::vector<float> render_stereo(R& rig, u32 frames) {
    std::vector<float> out(frames * 128 * 2);
    for (u32 f = 0; f < frames; ++f) {
        float* left = out.data() + f * 256;
        rig.engine.render({left, left + 128});
    }
    return out;
}

inline std::vector<std::byte> compile_demo() {
    json request = demo();
    return compiler::compile_image(request).image;
}

}  // namespace modsynth_test
