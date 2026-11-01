#pragma once

// The same numbers on every target, so an input found on Cortex-M replays on a desktop under sanitizers.

#include <modsynth/Format.hpp>

namespace modsynth::fuzz {

class Rng {
   public:
    explicit Rng(u64 seed) : state_(seed * 0x9E3779B97F4A7C15ull + 0x1234567ull) {
        if (state_ == 0) state_ = 1;
        next();
        next();
    }
    u32 next() {
        state_ ^= state_ << 13;
        state_ ^= state_ >> 7;
        state_ ^= state_ << 17;
        return static_cast<u32>((state_ * 0x2545F4914F6CDD1Dull) >> 32);
    }
    u32 below(u32 n) { return n == 0 ? 0 : next() % n; }
    bool chance(u32 percent) { return below(100) < percent; }

   private:
    u64 state_;
};

}  // namespace modsynth::fuzz
