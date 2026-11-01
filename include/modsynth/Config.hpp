#pragma once

#include <cstdint>

namespace modsynth {

// Everything fixed at compile time. The sample rate is not here: it is a constructor argument on every target.
struct SynthConfig {
    std::uint32_t frame_size = 128;
    std::uint32_t channels = 2;     // 1 compiles stereo out: buses, right gains and pan law. Images still play.
    std::uint32_t tap_slots = 0;    // 0 compiles the oscilloscope out
    std::uint32_t generations = 1;  // 2 crossfades live edits; 1 stops audio for a swap, with no separate code path
};

}  // namespace modsynth
