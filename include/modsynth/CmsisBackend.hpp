#pragma once

// CMSIS-DSP on Cortex-M. Include this only where arm_math.h exists: nothing in the core headers refers to it.
//
// Build CMSIS-DSP with ARM_MATH_LOOPUNROLL, as its own CMake does. Without it the gain mostly disappears on Cortex-M4.

#include <arm_math.h>
#include <cstdint>

#include <modsynth/Backend.hpp>

namespace modsynth {

struct CmsisBackend : ScalarBackend {
    // No pointers, so state survives a memcpy. The CMSIS instance that does hold pointers is built per call.
    struct Biquad {
        float coeffs[5];
        float state[2];
    };

    static void biquad_set(Biquad& s, const BiquadCoeffs& c) {
        s.coeffs[0] = c.b0;
        s.coeffs[1] = c.b1;
        s.coeffs[2] = c.b2;
        s.coeffs[3] = -c.a1;  // CMSIS adds the feedback terms
        s.coeffs[4] = -c.a2;
    }
    static void biquad_clear(Biquad& s) { s.state[0] = s.state[1] = 0.0f; }

    static void biquad(Biquad& s, const float* in, float* out, std::uint32_t n) {
        arm_biquad_cascade_df2T_instance_f32 instance{1, s.state, s.coeffs};
        arm_biquad_cascade_df2T_f32(&instance, in, out, n);
        s.state[0] = flush(s.state[0]);
        s.state[1] = flush(s.state[1]);
    }

    static void mul(const float* a, const float* b, float* out, std::uint32_t n) { arm_mult_f32(a, b, out, n); }
    static void scale(const float* a, float k, float* out, std::uint32_t n) { arm_scale_f32(a, k, out, n); }
    static void add(const float* a, const float* b, float* out, std::uint32_t n) { arm_add_f32(a, b, out, n); }
    static void offset(const float* a, float k, float* out, std::uint32_t n) { arm_offset_f32(a, k, out, n); }
    static void fill(float k, float* out, std::uint32_t n) { arm_fill_f32(k, out, n); }
};

static_assert(Backend<CmsisBackend>);

}  // namespace modsynth
