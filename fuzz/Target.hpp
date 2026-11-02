#pragma once

// What the fuzzer calls, and what a host gives it. Target.cpp is the only instrumented file, so it talks to the rest
// through this header alone.

#include <cstddef>

#include <modsynth/Format.hpp>

namespace modsynth::fuzz {

struct Stats {
    u64 execs = 0;
    u64 load_errors[16] = {};  // Indexed by LoadError, so entry 0 counts images the validator accepted
    u64 programs = 0;          // Programs that bound and played
    u64 finished = 0;          // Those that reached their end rather than the frame limit
    u64 refused_memory = 0;    // Programs too large for the fuzzer's own memory limit
    u64 frames = 0;
    u64 guard_trips = 0;
    u64 swaps = 0;         // Live swaps completed, each carrying state from one generation to the next
    u64 other_frames = 0;  // Images valid but for a frame size no engine here was built for, so not played
};

// One input: a mutated image, an intact image to swap from, and a seed for everything else. A failed oracle calls
// fail().
void run_target(ByteSpan image, ByteSpan base, u32 seed, Stats& stats);

// Given by the host. take_memory() returns exactly `size` bytes aligned to 16, and any access past them must be caught.
// rewind_memory() gives back everything taken since memory_mark().
void reset_memory();
[[nodiscard]] std::byte* take_memory(std::size_t size);
[[nodiscard]] std::size_t memory_mark();
void rewind_memory(std::size_t mark);
[[noreturn]] void fail(const char* what);

}  // namespace modsynth::fuzz
