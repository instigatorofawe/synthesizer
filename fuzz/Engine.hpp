#pragma once

// A small coverage-guided loop, because libFuzzer runs on neither wasm nor bare metal, and fuzzing on 32 bits is the
// point. An input is never stored. It is a recipe: a seed image and the chain of mutation seeds that led to it. That
// makes a corpus entry 12 bytes, so a bare-metal target can hold thousands, and any finding replays on any target.

#include <cstddef>
#include <cstring>
#include <span>

#include <modsynth/Format.hpp>

#include "Mutator.hpp"
#include "Rng.hpp"
#include "Target.hpp"

namespace modsynth::fuzz {

inline constexpr u32 kChainLimit = 12;

struct Recipe {
    u32 seed_image = 0;
    u32 depth = 0;
    u32 chain[kChainLimit] = {};
};

// One edge counter per slot, written by the coverage callbacks.
inline constexpr u32 kCoverageSize = 1u << 14;
inline u8 g_coverage[kCoverageSize];

// Counts collapse to powers of two, so a loop running ten more times is not news, but a loop running at all is.
[[nodiscard]] inline u8 coverage_bucket(u8 count) {
    if (count == 0) return 0;
    if (count < 4) return static_cast<u8>(1u << (count - 1));
    if (count < 8) return 8;
    if (count < 16) return 16;
    if (count < 32) return 32;
    if (count < 128) return 64;
    return 128;
}

template <u32 CorpusSize>
class Fuzzer {
   public:
    struct Entry {
        u32 parent;
        u32 mutation;
        u32 seed_image;
    };

    Fuzzer(std::span<const ByteSpan> seeds, std::span<std::byte> arena, std::span<std::byte> image, u64 seed)
        : seeds_(seeds), work_(arena), image_(image), rng_(seed) {}

    // Runs every seed once, so what they already cover does not count as a discovery.
    void start() {
        for (u32 i = 0; i < seeds_.size(); ++i) {
            current_ = {};
            current_.seed_image = i;
            std::memset(g_coverage, 0, sizeof g_coverage);
            run_target(seeds_[i], seeds_[0], rng_.next(), stats_);
            (void)keep_if_new({kNoParent, 0, i});
        }
    }

    // One mutated input. Returns true if it reached anything new.
    bool step() {
        const u32 parent = pick();
        const u32 mutation = rng_.next();
        const Entry fresh{parent, mutation, corpus_[parent].seed_image};
        const std::size_t size = build(fresh);
        if (size == 0) return false;
        std::memset(g_coverage, 0, sizeof g_coverage);
        run_target({image_.data(), size}, seeds_[0], mutation, stats_);
        return keep_if_new(fresh);
    }

    // Replays a recipe printed by a failure.
    void replay(const Recipe& recipe) {
        current_ = recipe;
        const std::size_t size = rebuild(recipe);
        const u32 last = recipe.depth ? recipe.chain[recipe.depth - 1] : 0;
        std::memset(g_coverage, 0, sizeof g_coverage);
        run_target({image_.data(), size}, seeds_[0], last, stats_);
    }

    [[nodiscard]] const Stats& stats() const { return stats_; }
    [[nodiscard]] u32 corpus() const { return corpus_size_; }
    [[nodiscard]] u32 edges() const { return edges_; }
    [[nodiscard]] const Recipe& current() const { return current_; }

   private:
    static constexpr u32 kNoParent = 0xFFFFFFFF;

    [[nodiscard]] bool keep_if_new(const Entry& e) {
        bool fresh = false;
        for (u32 i = 0; i < kCoverageSize; ++i) {
            if (g_coverage[i] == 0) continue;
            const u8 bucket = coverage_bucket(g_coverage[i]);
            if ((bucket & ~virgin_[i]) != 0) {
                fresh = true;
                edges_ += virgin_[i] == 0;
                virgin_[i] |= bucket;
            }
        }
        if (fresh && corpus_size_ < CorpusSize) corpus_[corpus_size_++] = e;
        return fresh;
    }

    // Half the time something recent, because that is where new coverage tends to be.
    [[nodiscard]] u32 pick() {
        if (rng_.chance(50) && corpus_size_ > 32) return corpus_size_ - 1 - rng_.below(32);
        return rng_.below(corpus_size_);
    }

    // Walks an entry back to its seed image, so its chain can be replayed forwards.
    [[nodiscard]] std::size_t build(const Entry& e) {
        Recipe r;
        u32 reversed[kChainLimit];
        u32 depth = 0;
        reversed[depth++] = e.mutation;
        for (u32 at = e.parent; at != kNoParent && corpus_[at].parent != kNoParent; at = corpus_[at].parent) {
            if (depth == kChainLimit) {
                // Long chains lose their oldest ancestors' place: it restarts from this seed image, still reproducibly.
                depth = kChainLimit - 1;
                break;
            }
            reversed[depth++] = corpus_[at].mutation;
        }
        r.seed_image = e.seed_image;
        r.depth = depth;
        for (u32 i = 0; i < depth; ++i) r.chain[i] = reversed[depth - 1 - i];
        current_ = r;
        return rebuild(r);
    }

    [[nodiscard]] std::size_t rebuild(const Recipe& recipe) {
        const ByteSpan seed = seeds_[recipe.seed_image];
        if (!work_.parse(seed)) return 0;
        const ByteSpan donor = seeds_[(recipe.seed_image + 1) % seeds_.size()];
        for (u32 i = 0; i < recipe.depth; ++i) {
            Rng r(recipe.chain[i]);
            work_.mutate(r, donor);
        }
        std::size_t size = work_.seal(image_);
        // Damage belongs to the last link only, because a parent with a broken container teaches its children nothing.
        if (recipe.depth != 0) {
            Rng r(recipe.chain[recipe.depth - 1] ^ 0x5F5F5F5Fu);
            if (r.chance(8)) size = Workspace::damage(image_, size, r);
        }
        return size;
    }

    std::span<const ByteSpan> seeds_;
    Workspace work_;
    std::span<std::byte> image_;
    Rng rng_;
    Stats stats_;
    Recipe current_;
    Entry corpus_[CorpusSize];
    u32 corpus_size_ = 0;
    u32 edges_ = 0;
    u8 virgin_[kCoverageSize] = {};
};

}  // namespace modsynth::fuzz
