// A ceiling on what a desktop or a browser plays, applied by the host after the engine, so that a finite blow-up can't
// reach speakers at more than full scale (section 24 of the design, open 9). It belongs to the host and not the engine:
// an engine plays an image the same everywhere, and a device has no limiter, which is why a compile for one refuses an
// image that would pass full scale there instead.
//
// It looks at no sample ahead, so it adds no latency. Its gain drops at once to what keeps a sample at the ceiling, and
// comes back up towards 1 with a time constant of `release` seconds, never above what the sample in hand allows. Both
// channels take the same gain, so it moves nothing in the stereo image. Below the ceiling, with its gain back at 1, it
// multiplies by exactly 1, so what it passes is bit for bit what the engine made.
#pragma once

#include <cmath>
#include <cstddef>

namespace modsynth {

class Limiter {
   public:
    explicit Limiter(float rate, float release = 0.1f, float ceiling = 1.0f)
        : ceiling_(ceiling), recover_(std::exp(-1.0f / (release * rate))) {}

    // In place. `right` may be null, for one channel.
    void process(float* left, float* right, std::size_t samples) {
        for (std::size_t i = 0; i < samples; ++i) {
            float l = left[i], r = right ? right[i] : 0.0f;
            if (!std::isfinite(l) || !std::isfinite(r)) l = r = 0.0f;  // An engine's guards make this unreachable
            const float peak = std::fmax(std::fabs(l), std::fabs(r));
            // What the gain is short of 1 decays, rather than the gain rising, since near 1 a step too small for a
            // float to take would leave it there. Within a millionth it is 1, so the engine's bits come back.
            cut_ *= recover_;
            if (cut_ < 1e-6f) cut_ = 0.0f;
            if (peak > ceiling_) cut_ = std::fmax(cut_, 1.0f - ceiling_ / peak);
            const float gain = 1.0f - cut_;
            lowest_ = std::fmin(lowest_, gain);
            // ceiling / peak can round up, so a product is held to the ceiling, which changes nothing below it.
            left[i] = std::fmin(std::fmax(l * gain, -ceiling_), ceiling_);
            if (right) right[i] = std::fmin(std::fmax(r * gain, -ceiling_), ceiling_);
        }
    }

    // The lowest gain since the last call, or 1 if nothing was turned down, so a host can say that it limited.
    [[nodiscard]] float take_lowest() {
        const float lowest = lowest_;
        lowest_ = 1.0f;
        return lowest;
    }

    void reset() {
        cut_ = 0.0f;
        lowest_ = 1.0f;
    }

   private:
    float ceiling_;
    float recover_;
    float cut_ = 0.0f;  // 1 less the gain
    float lowest_ = 1.0f;
};

}  // namespace modsynth
