#pragma once

// Edge coverage, with AFL's trick: an edge is this block XOR the previous one, so A then B differs from B then A.

#include "Engine.hpp"

namespace modsynth::fuzz {

inline u32 g_previous_block = 0;

[[gnu::always_inline]] inline void record_block(u32 block) {
    const u32 slot = (block ^ g_previous_block) & (kCoverageSize - 1);
    if (g_coverage[slot] != 255) ++g_coverage[slot];
    g_previous_block = block >> 1;
}

}  // namespace modsynth::fuzz
