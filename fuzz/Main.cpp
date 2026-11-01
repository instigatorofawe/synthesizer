// The hosted fuzzer, for a desktop and for wasm32 under Node, both with sanitizers.
//
//   modsynth_fuzz seconds seed image...
//   modsynth_fuzz --replay image_index:chain,chain,... seed image...

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iterator>
#include <memory>
#include <sanitizer/common_interface_defs.h>
#include <string>
#include <vector>

#if __has_feature(address_sanitizer) || defined(__SANITIZE_ADDRESS__)
#include <sanitizer/asan_interface.h>
#define POISON(p, n) ASAN_POISON_MEMORY_REGION(p, n)
#define UNPOISON(p, n) ASAN_UNPOISON_MEMORY_REGION(p, n)
#else
#define POISON(p, n)
#define UNPOISON(p, n)
#endif

#include <modsynth/Loader.hpp>

#include "Coverage.hpp"
#include "Engine.hpp"

using namespace modsynth;
using namespace modsynth::fuzz;

namespace {

constexpr std::size_t kMemory = 128u << 20;
constexpr std::size_t kRedZone = 64;
constexpr u32 kCorpus = 1u << 15;

std::byte* g_memory = nullptr;
std::size_t g_used = 0;
const Recipe* g_recipe = nullptr;

void print_recipe() {
    if (!g_recipe) return;
    std::fprintf(stderr, "recipe: %u:", g_recipe->seed_image);
    for (u32 i = 0; i < g_recipe->depth; ++i) std::fprintf(stderr, "%s%u", i ? "," : "", g_recipe->chain[i]);
    std::fprintf(stderr, "\n");
}

}  // namespace

namespace modsynth::fuzz {

void reset_memory() {
    POISON(g_memory, kMemory);
    g_used = 0;
}

// The tail of each allocation lines up with poison, so a one-byte overrun is caught. Poison has 8-byte granules, so the
// start of an allocation is the only thing a sub-granule size can move.
std::byte* take_memory(std::size_t size) {
    const std::size_t start = (g_used + 15) / 16 * 16;
    if (start + size + kRedZone > kMemory) fail("the fuzzer's own memory ran out");
    UNPOISON(g_memory + start, size);
    g_used = start + size + kRedZone;
    return g_memory + start;
}

std::size_t memory_mark() { return g_used; }

void rewind_memory(std::size_t mark) {
    POISON(g_memory + mark, g_used - mark);
    g_used = mark;
}

void fail(const char* what) {
    std::fprintf(stderr, "FAILED: %s\n", what);
    print_recipe();
    std::abort();
}

}  // namespace modsynth::fuzz

extern "C" void __sanitizer_cov_trace_pc_guard_init(u32* start, u32* stop) {
    static u32 next = 0;
    if (start == stop || *start != 0) return;
    for (u32* g = start; g < stop; ++g) *g = ++next * 2654435761u >> 8 | 1;
}
extern "C" void __sanitizer_cov_trace_pc_guard(u32* guard) { record_block(*guard); }

int main(int argc, char** argv) {
    if (argc < 4) {
        std::fprintf(stderr, "usage: modsynth_fuzz seconds|--replay recipe seed image...\n");
        return 2;
    }
    const bool replay = std::strcmp(argv[1], "--replay") == 0;
    const int first = replay ? 4 : 3;
    const char* const seed_text = argv[first - 1];

    std::vector<std::vector<u64>> words;
    std::vector<ByteSpan> seeds;
    words.reserve(static_cast<std::size_t>(argc));
    for (int i = first; i < argc; ++i) {
        std::ifstream in(argv[i], std::ios::binary);
        const std::vector<char> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
        if (bytes.empty()) {
            std::fprintf(stderr, "cannot read %s\n", argv[i]);
            return 2;
        }
        auto& w = words.emplace_back((bytes.size() + 7) / 8);
        std::memcpy(w.data(), bytes.data(), bytes.size());
        seeds.push_back({reinterpret_cast<const std::byte*>(w.data()), bytes.size()});
    }

    g_memory = static_cast<std::byte*>(std::aligned_alloc(4096, kMemory));
    auto arena = std::make_unique<std::byte[]>(1u << 22);
    auto image = std::make_unique<std::byte[]>(1u << 22);
    using Engine = Fuzzer<kCorpus>;
    auto engine = std::make_unique<Engine>(seeds, std::span(arena.get(), 1u << 22), std::span(image.get(), 1u << 22),
                                           std::strtoull(seed_text, nullptr, 10));
    g_recipe = &engine->current();
    __sanitizer_set_death_callback(print_recipe);

    if (replay) {
        Recipe r;
        char* text = argv[2];
        r.seed_image = static_cast<u32>(std::strtoul(text, &text, 10));
        while (*text == ':' || *text == ',') r.chain[r.depth++] = static_cast<u32>(std::strtoul(text + 1, &text, 10));
        engine->replay(r);
        std::fprintf(stderr, "replay finished without a failure\n");
        return 0;
    }

    engine->start();
    const auto begin = std::chrono::steady_clock::now();
    const double seconds = std::atof(argv[1]);
    const auto elapsed = [&] {
        return std::chrono::duration<double>(std::chrono::steady_clock::now() - begin).count();
    };
    double slowest = 0.0, next_report = 10.0;
    for (u64 i = 0;; ++i) {
        const double before = elapsed();
        if (before >= seconds) break;
        (void)engine->step();
        slowest = std::max(slowest, elapsed() - before);
        if (before >= next_report) {
            std::fprintf(stderr, "%6.0fs %10llu execs, corpus %u, edges %u\n", before,
                         static_cast<unsigned long long>(engine->stats().execs), engine->corpus(), engine->edges());
            next_report += 10.0;
        }
    }

    const Stats& s = engine->stats();
    std::fprintf(stderr, "\n%llu execs in %.0f s, %.0f per second, slowest %.3f s\n",
                 static_cast<unsigned long long>(s.execs), seconds, static_cast<double>(s.execs) / seconds, slowest);
    std::fprintf(stderr, "corpus %u, edges %u\n", engine->corpus(), engine->edges());
    for (u32 i = 0; i < std::size(s.load_errors); ++i) {
        if (s.load_errors[i] == 0) continue;
        std::fprintf(stderr, "  %-46s %10llu\n", i == 0 ? "accepted" : to_string(static_cast<LoadError>(i)),
                     static_cast<unsigned long long>(s.load_errors[i]));
    }
    std::fprintf(stderr,
                 "programs played %llu, finished %llu, too large %llu, swaps %llu, frames %llu, guard trips %llu\n",
                 static_cast<unsigned long long>(s.programs), static_cast<unsigned long long>(s.finished),
                 static_cast<unsigned long long>(s.refused_memory), static_cast<unsigned long long>(s.swaps),
                 static_cast<unsigned long long>(s.frames), static_cast<unsigned long long>(s.guard_trips));
    return 0;
}
