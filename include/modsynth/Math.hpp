#pragma once

// sin, cos and 2^x built from + and * alone, because IEEE 754 fixes those exactly and fixes nothing about libm. Each
// libm rounds differently, and a one-bit change in a filter coefficient can reach -90 dB, so an opcode's meaning cannot
// depend on which C library it was linked with. Most of these run at control rate. OscMod reads sin_turns per sample,
// and it is more accurate than the table Osc reads: -134 dB at worst against -118 dB.
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

// A 16-bit sample of a delay line, docs/Format.md: x * 32768 truncated towards zero and held to -32768 to 32767, with a
// NaN as 0. A Cortex-M4's fixed-point conversion is exactly that in one instruction, where the portable form takes
// about ten, and both give the same bits for every float. Reading one back is exact either way.
#if defined(__arm__) && defined(__ARM_FP) && (__ARM_FP & 4) && __ARM_ARCH >= 7
#define MODSYNTH_Q15_CONVERT 1
#endif

[[nodiscard]] inline std::int16_t to_q15(float x) {
#ifdef MODSYNTH_Q15_CONVERT
    asm("vcvt.s16.f32 %0, %0, #15" : "+t"(x));
    return static_cast<std::int16_t>(std::bit_cast<std::int32_t>(x));
#else
    const float v = x * 32768.0f;  // A power of two, so exact unless it overflows, and then held like any other
    if (!(v == v)) return 0;
    return static_cast<std::int16_t>(static_cast<std::int32_t>(clamp(v, -32768.0f, 32767.0f)));
#endif
}

[[nodiscard]] inline float from_q15(std::int16_t s) {
#ifdef MODSYNTH_Q15_CONVERT
    float x = std::bit_cast<float>(static_cast<std::int32_t>(s));
    asm("vcvt.f32.s16 %0, %0, #15" : "+t"(x));
    return x;
#else
    return static_cast<float>(s) * (1.0f / 32768.0f);
#endif
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

// The next whole number down. A float this big has no fraction left, and NaN fails both tests, so the cast sees only
// what fits in an int. NaN comes back out, for the guard to find.
[[nodiscard]] inline float floor_of(float x) {
    if (!(x > -8388608.0f && x < 8388608.0f)) return x;
    const float whole = static_cast<float>(static_cast<std::int32_t>(x));
    return whole > x ? whole - 1.0f : whole;
}

// A distance in turns as a phase. 24 bits of fraction are all a float near 1 holds, which leaves room for 64 whole
// turns either way, and those are thrown away by the shift, which is what a phase does with whole turns.
[[nodiscard]] inline std::uint32_t turns_to_phase(float turns) {
    return static_cast<std::uint32_t>(static_cast<std::int32_t>(clamp(turns, -64.0f, 64.0f) * 16777216.0f)) << 8;
}

}  // namespace modsynth
