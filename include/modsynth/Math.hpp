#pragma once

// sin, cos and 2^x built from + and * alone, because IEEE 754 fixes those exactly and fixes nothing about libm. Each
// libm rounds differently, and a one-bit change in a filter coefficient can reach -90 dB, so an opcode's meaning cannot
// depend on which C library it was linked with. These run at control rate, so they do not need to be fast.
//
// docs/Format.md gives this arithmetic exactly. Changing a coefficient here changes what every image sounds like.

#include <bit>
#include <cstdint>

namespace modsynth {

[[nodiscard]] inline float clamp(float x, float lo, float hi) {
    x = x >= lo ? x : lo;
    return x <= hi ? x : hi;
}

[[nodiscard]] inline std::int32_t round_to_int(float x) {
    return static_cast<std::int32_t>(x + (x < 0.0f ? -0.5f : 0.5f));
}

// 2^x, for x clamped to -126 to 127. A Taylor series on the fractional part, which is at most a half.
[[nodiscard]] inline float pow2(float x) {
    x = clamp(x, -126.0f, 127.0f);
    const std::int32_t whole = round_to_int(x);
    const float f = x - static_cast<float>(whole);
    float p = 1.52527338e-5f;
    p = p * f + 1.54035304e-4f;
    p = p * f + 1.33335581e-3f;
    p = p * f + 9.61812911e-3f;
    p = p * f + 5.55041087e-2f;
    p = p * f + 2.40226507e-1f;
    p = p * f + 6.93147181e-1f;
    p = p * f + 1.0f;
    return p * std::bit_cast<float>(static_cast<std::uint32_t>(whole + 127) << 23);
}

// e^-x, for x at least 0.
[[nodiscard]] inline float exp_minus(float x) { return pow2(x * -1.44269504f); }

// sin(2 pi turns), reduced to a quarter turn either side of zero, where its Taylor series is enough.
[[nodiscard]] inline float sin_turns(float turns) {
    float t = turns - static_cast<float>(round_to_int(turns));
    if (t > 0.25f) {
        t = 0.5f - t;
    } else if (t < -0.25f) {
        t = -0.5f - t;
    }
    const float x = t * 6.28318531f;
    const float x2 = x * x;
    float p = -2.50521084e-8f;
    p = p * x2 + 2.75573192e-6f;
    p = p * x2 - 1.98412698e-4f;
    p = p * x2 + 8.33333333e-3f;
    p = p * x2 - 1.66666667e-1f;
    p = p * x2 + 1.0f;
    return p * x;
}

}  // namespace modsynth
