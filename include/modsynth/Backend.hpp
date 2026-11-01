#pragma once

// Backends provide the buffer kernels and own their filter state types. A backend inherits from ScalarBackend and
// replaces only what it does better.
//
// Kernels are total: safe for every input value, including NaN. The callers in kernels.hpp clamp what they pass here.

#include <concepts>
#include <cstdint>
#include <type_traits>

namespace modsynth {

struct BiquadCoeffs {
    float b0, b1, b2, a1, a2;
};

template <class B>
concept Backend =
    requires(typename B::Biquad& s, const BiquadCoeffs& c, const float* in, float* out, float k, std::uint32_t n) {
        requires std::is_trivially_copyable_v<typename B::Biquad>;  // state is memcpy'd across a live edit
        B::biquad_set(s, c);
        B::biquad_clear(s);
        B::biquad(s, in, out, n);
        B::mul(in, in, out, n);
        B::scale(in, k, out, n);
        B::add(in, in, out, n);
        B::offset(in, k, out, n);
        B::fill(k, out, n);
        B::accumulate(in, k, out, n);
    };

struct ScalarBackend {
    struct Biquad {
        BiquadCoeffs c;
        float z1, z2;
    };

    static void biquad_set(Biquad& s, const BiquadCoeffs& c) { s.c = c; }
    static void biquad_clear(Biquad& s) { s.z1 = s.z2 = 0.0f; }

    static void biquad(Biquad& s, const float* in, float* out, std::uint32_t n) {
        const BiquadCoeffs c = s.c;  // Reloading these per sample costs 56% on Cortex-M4 [model]
        float z1 = s.z1, z2 = s.z2;
        for (std::uint32_t i = 0; i < n; ++i) {
            const float x = in[i];
            const float y = c.b0 * x + z1;
            z1 = c.b1 * x - c.a1 * y + z2;
            z2 = c.b2 * x - c.a2 * y;
            out[i] = y;
        }
        // wasm has no FTZ, so flush here and every target behaves the same.
        s.z1 = flush(z1);
        s.z2 = flush(z2);
    }

    static void mul(const float* a, const float* b, float* out, std::uint32_t n) {
        for (std::uint32_t i = 0; i < n; ++i) out[i] = a[i] * b[i];
    }
    static void scale(const float* a, float k, float* out, std::uint32_t n) {
        for (std::uint32_t i = 0; i < n; ++i) out[i] = a[i] * k;
    }
    static void add(const float* a, const float* b, float* out, std::uint32_t n) {
        for (std::uint32_t i = 0; i < n; ++i) out[i] = a[i] + b[i];
    }
    static void offset(const float* a, float k, float* out, std::uint32_t n) {
        for (std::uint32_t i = 0; i < n; ++i) out[i] = a[i] + k;
    }
    static void fill(float k, float* out, std::uint32_t n) {
        for (std::uint32_t i = 0; i < n; ++i) out[i] = k;
    }
    static void accumulate(const float* in, float k, float* out, std::uint32_t n) {
        for (std::uint32_t i = 0; i < n; ++i) out[i] += in[i] * k;
    }

   protected:
    [[nodiscard]] static float flush(float x) { return (x > -1e-20f && x < 1e-20f) ? 0.0f : x; }
};

static_assert(Backend<ScalarBackend>);

}  // namespace modsynth
