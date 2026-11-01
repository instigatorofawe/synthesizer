#pragma once

// The step interpreter: one switch over decoded steps, run once per frame.
//
// Nothing here uses double, which Cortex-M4 has no FPU for. Every float that reaches an integer conversion or a filter
// coefficient is clamped first, and clamp() sends NaN to the low bound, so kernels are total for any input.

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <numbers>

#include <modsynth/Backend.hpp>
#include <modsynth/Config.hpp>
#include <modsynth/Format.hpp>

namespace modsynth {

[[nodiscard]] inline float clamp(float x, float lo, float hi) {
    x = x >= lo ? x : lo;
    return x <= hi ? x : hi;
}

struct DecodedOperand {
    u16 bank;
    u16 index;
};

struct DecodedStep {
    u8 op;
    u8 mode;
    u16 resource;
    u32 state;  // byte offset in the instance's state block
    DecodedOperand out[2];
    DecodedOperand in[4];
};

struct BoundTable {
    const float* data;
    u32 length;
    u32 shift;  // 32 - log2(length)
};

struct BoundAsset {
    const std::byte* data;
    float native_rate;
    u32 frames;
    u32 loop_start;
    u32 loop_end;
    u8 channels;
    u8 encoding;
};

union BoundResource {
    BoundTable table;
    BoundAsset asset;
};

struct DelayLine {
    float* data;
    u32 length;
    u32 write;
    u32 written;  // saturates at length. Reads older than this return 0, so lines never need clearing.
};

// Offsets of gate changes within this frame, or kNone. Env honours them, so a one-tick note still sounds.
struct GateEvents {
    u16 on = kNone;
    u16 off = kNone;
};

struct RunContext {
    float* buffers = nullptr;
    const float* banks[6] = {};  // indexed by Bank. Voice and Track are also in `voice` and `track`, writable.
    float* voice = nullptr;
    float* track = nullptr;
    std::byte* state = nullptr;
    DelayLine* lines = nullptr;
    const BoundResource* resources = nullptr;
    float rate = 48000.0f;
    float inverse_rate = 1.0f / 48000.0f;
    GateEvents gate;
    u32 seed = 1;
    bool busy = false;  // an Env or Sample is still sounding
};

template <SynthConfig C, Backend B>
struct Kernels {
    static constexpr u32 N = C.frame_size;

    struct EnvState {
        float level;
        float attack, decay, release;  // clamped inputs the coefficients below were computed from
        float attack_inc, decay_coef, release_coef;
        u32 stage;
    };
    enum Stage : u32 { Idle = 0, Attack, Decay, Sustain, Release };

    struct BiquadState {
        typename B::Biquad filter;
        float cutoff, q;
    };
    struct OscState {
        u32 phase;
    };
    struct NoiseState {
        u32 x;
    };
    struct SampleState {
        u64 position;  // 32.32
        u32 done;
        u32 reserved;
    };
    struct CombState {
        float low;
    };
    struct FollowState {
        float level, release, coef;
    };
    struct CachedState {
        float in, out;
    };
    struct LfoState {
        u32 phase;
    };

    [[nodiscard]] static constexpr u32 state_size(Op op) {
        switch (op) {
            case Op::Noise:
                return sizeof(NoiseState);
            case Op::Osc:
                return sizeof(OscState);
            case Op::Biquad:
                return sizeof(BiquadState);
            case Op::Env:
                return sizeof(EnvState);
            case Op::Sample:
                return sizeof(SampleState);
            case Op::Comb:
                return sizeof(CombState);
            case Op::Follow:
                return sizeof(FollowState);
            case Op::KMtoF:
            case Op::KRatio:
                return sizeof(CachedState);
            case Op::KLfo:
                return sizeof(LfoState);
            default:
                return 0;
        }
    }
    static constexpr u32 state_align = 8;

    template <class T>
    [[nodiscard]] static T& state(const RunContext& c, const DecodedStep& s) {
        return *reinterpret_cast<T*>(c.state + s.state);
    }
    [[nodiscard]] static float scalar(const RunContext& c, DecodedOperand o) { return c.banks[o.bank][o.index]; }
    [[nodiscard]] static float* buffer(const RunContext& c, DecodedOperand o) { return c.buffers + o.index * N; }
    static void set_scalar(RunContext& c, DecodedOperand o, float value) {
        (o.bank == static_cast<u16>(Bank::Track) ? c.track : c.voice)[o.index] = value;
    }

    static void run(const DecodedStep* steps, u32 count, RunContext& c) {
        for (u32 i = 0; i < count; ++i) run_step(steps[i], c);
    }

    static void run_step(const DecodedStep& s, RunContext& c) {
        switch (static_cast<Op>(s.op)) {
            case Op::Fill:
                B::fill(scalar(c, s.in[0]), buffer(c, s.out[0]), N);
                break;
            case Op::Noise:
                noise(s, c);
                break;
            case Op::Osc:
                osc(s, c);
                break;
            case Op::Biquad:
                biquad(s, c);
                break;
            case Op::Env:
                env(s, c);
                break;
            case Op::Sample:
                sample(s, c);
                break;
            case Op::Mul:
                B::mul(buffer(c, s.in[0]), buffer(c, s.in[1]), buffer(c, s.out[0]), N);
                break;
            case Op::MulS:
                B::scale(buffer(c, s.in[0]), scalar(c, s.in[1]), buffer(c, s.out[0]), N);
                break;
            case Op::Add:
                B::add(buffer(c, s.in[0]), buffer(c, s.in[1]), buffer(c, s.out[0]), N);
                break;
            case Op::AddS:
                B::offset(buffer(c, s.in[0]), scalar(c, s.in[1]), buffer(c, s.out[0]), N);
                break;
            case Op::Pan:
                pan(s, c);
                break;
            case Op::DelayWrite:
                delay_write(s, c);
                break;
            case Op::DelayRead:
                delay_read(s, c);
                break;
            case Op::Comb:
                comb(s, c);
                break;
            case Op::Allpass:
                allpass(s, c);
                break;
            case Op::Follow:
                follow(s, c);
                break;
            case Op::KMul:
                set_scalar(c, s.out[0], scalar(c, s.in[0]) * scalar(c, s.in[1]));
                break;
            case Op::KAdd:
                set_scalar(c, s.out[0], scalar(c, s.in[0]) + scalar(c, s.in[1]));
                break;
            case Op::KMtoF:
                kmtof(s, c);
                break;
            case Op::KRatio:
                kratio(s, c);
                break;
            case Op::KSnap:
                set_scalar(c, s.out[0], buffer(c, s.in[0])[N - 1]);
                break;
            case Op::KLfo:
                klfo(s, c);
                break;
            default:
                break;  // unreachable: the validator rejects unknown ops
        }
    }

    // Non-finite output kills the instance rather than poisoning a bus. x * 0 is 0 for finite x and NaN otherwise.
    [[nodiscard]] static bool finite(const float* x) {
        float probe = 0.0f;
        for (u32 i = 0; i < N; ++i) probe += x[i] * 0.0f;
        return probe == 0.0f;
    }

   private:
    [[nodiscard]] static float flush(float x) { return (x > -1e-20f && x < 1e-20f) ? 0.0f : x; }

    static void noise(const DecodedStep& s, RunContext& c) {
        auto& st = state<NoiseState>(c, s);
        if (st.x == 0) st.x = (c.seed ^ (s.state * 2654435761u)) | 1u;  // per voice and repeatable, per section 18
        u32 x = st.x;
        float* out = buffer(c, s.out[0]);
        for (u32 i = 0; i < N; ++i) {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            out[i] = static_cast<float>(static_cast<std::int32_t>(x)) * 4.656612873e-10f;
        }
        st.x = x;
    }

    static void osc(const DecodedStep& s, RunContext& c) {
        const BoundTable& t = c.resources[s.resource].table;
        auto& st = state<OscState>(c, s);
        const float freq = clamp(scalar(c, s.in[0]), 0.0f, c.rate * 0.5f);
        const u32 inc = static_cast<u32>(freq * c.inverse_rate * 4294967040.0f);
        const u32 shift = t.shift;
        const u32 frac_mask = (1u << shift) - 1u;
        const float frac_scale = 1.0f / static_cast<float>(1u << shift);
        const float* table = t.data;
        u32 phase = st.phase;
        float* out = buffer(c, s.out[0]);
        for (u32 i = 0; i < N; ++i) {
            const u32 idx = phase >> shift;
            const float frac = static_cast<float>(phase & frac_mask) * frac_scale;
            const float a = table[idx];
            out[i] = a + (table[idx + 1] - a) * frac;
            phase += inc;
        }
        st.phase = phase;
    }

    static void biquad(const DecodedStep& s, RunContext& c) {
        auto& st = state<BiquadState>(c, s);
        const float cutoff = clamp(scalar(c, s.in[1]), 10.0f, c.rate * 0.45f);
        const float q = clamp(scalar(c, s.in[2]), 0.1f, 30.0f);
        if (cutoff != st.cutoff || q != st.q) {
            st.cutoff = cutoff;
            st.q = q;
            const float w = 2.0f * std::numbers::pi_v<float> * cutoff * c.inverse_rate;
            const float cosw = std::cos(w), alpha = std::sin(w) / (2.0f * q);
            const float a0 = 1.0f / (1.0f + alpha);
            BiquadCoeffs k{};
            switch (static_cast<BiquadMode>(s.mode)) {
                case BiquadMode::HighPass: {
                    const float h = (1.0f + cosw) * 0.5f * a0;
                    k = {h, -2.0f * h, h, 0.0f, 0.0f};
                    break;
                }
                case BiquadMode::BandPass:
                    k = {alpha * a0, 0.0f, -alpha * a0, 0.0f, 0.0f};
                    break;
                default: {
                    const float l = (1.0f - cosw) * 0.5f * a0;
                    k = {l, 2.0f * l, l, 0.0f, 0.0f};
                }
            }
            k.a1 = -2.0f * cosw * a0;
            k.a2 = (1.0f - alpha) * a0;
            B::biquad_set(st.filter, k);
        }
        B::biquad(st.filter, buffer(c, s.in[0]), buffer(c, s.out[0]), N);
    }

    static void env(const DecodedStep& s, RunContext& c) {
        auto& st = state<EnvState>(c, s);
        const float attack = clamp(scalar(c, s.in[0]), 1e-4f, 60.0f);
        const float decay = clamp(scalar(c, s.in[1]), 1e-4f, 60.0f);
        const float sustain = clamp(scalar(c, s.in[2]), 0.0f, 1.0f);
        const float release = clamp(scalar(c, s.in[3]), 1e-4f, 60.0f);
        if (attack != st.attack) {
            st.attack = attack;
            st.attack_inc = c.inverse_rate / attack;
        }
        if (decay != st.decay) {
            st.decay = decay;
            st.decay_coef = std::exp(-c.inverse_rate / decay);
        }
        if (release != st.release) {
            st.release = release;
            st.release_coef = std::exp(-c.inverse_rate / release);
        }

        float* out = buffer(c, s.out[0]);
        u32 i = 0;
        const auto until = [&](u32 end) {
            while (i < end) {
                switch (st.stage) {
                    case Attack:
                        st.level += st.attack_inc;
                        if (st.level >= 1.0f) {
                            st.level = 1.0f;
                            st.stage = Decay;
                        }
                        break;
                    case Decay:
                        st.level = sustain + (st.level - sustain) * st.decay_coef;
                        if (st.level - sustain < 1e-4f) {
                            st.level = sustain;
                            st.stage = Sustain;
                        }
                        break;
                    case Sustain:
                        st.level = sustain;
                        break;
                    case Release:
                        st.level *= st.release_coef;
                        if (st.level < 1e-4f) {
                            st.level = 0.0f;
                            st.stage = Idle;
                        }
                        break;
                    default:
                        st.level = 0.0f;
                }
                out[i++] = st.level;
            }
        };
        const u32 on = c.gate.on, off = c.gate.off;
        const bool on_first = on <= off;
        const u32 first = on_first ? on : off, second = on_first ? off : on;
        const auto apply = [&](u32 at) {
            if (at == on) st.stage = Attack;
            if (at == off && st.stage != Idle) st.stage = Release;
        };
        if (first < N) {
            until(first);
            apply(first);
            if (second < N && second != first) {
                until(second);
                apply(second);
            }
        }
        until(N);
        if (st.stage != Idle) c.busy = true;
    }

    static void sample(const DecodedStep& s, RunContext& c) {
        const BoundAsset& a = c.resources[s.resource].asset;
        auto& st = state<SampleState>(c, s);
        float* left = buffer(c, s.out[0]);
        float* right = buffer(c, s.out[1]);
        const float step = clamp(scalar(c, s.in[0]), 0.0f, 256.0f) * a.native_rate * c.inverse_rate;
        u64 inc = static_cast<u64>(std::min(step, 65536.0f) * 4294967296.0f);
        const bool looping = a.loop_end != 0;
        const u64 loop_length = looping ? static_cast<u64>(a.loop_end - a.loop_start) << 32 : 0;
        const u64 loop_end = static_cast<u64>(a.loop_end) << 32;
        if (looping && inc >= loop_length) inc = loop_length - 1;  // so one subtraction below is always enough

        const u32 start = c.gate.on < N ? c.gate.on : 0;
        std::fill(left, left + start, 0.0f);
        std::fill(right, right + start, 0.0f);
        u32 i = start;
        const u32 ch = a.channels;
        for (; i < N && !st.done; ++i) {
            const u32 idx = static_cast<u32>(st.position >> 32);
            if (!looping && idx >= a.frames) {
                st.done = 1;
                break;
            }
            const float frac = static_cast<float>(static_cast<u32>(st.position)) * 2.3283064e-10f;
            const float l0 = read(a, idx, 0), l1 = read(a, idx + 1, 0);
            float value = l0 + (l1 - l0) * frac;
            float other = value;
            if (ch == 2) {
                const float r0 = read(a, idx, 1), r1 = read(a, idx + 1, 1);
                other = r0 + (r1 - r0) * frac;
            }
            if constexpr (C.channels == 1) {
                // A mono build folds here, so a stereo asset costs one extra read and no stereo buses.
                value = other = (value + other) * 0.5f;
            }
            left[i] = value;
            right[i] = other;
            st.position += inc;
            if (looping && st.position >= loop_end) st.position -= loop_length;
        }
        std::fill(left + i, left + N, 0.0f);
        std::fill(right + i, right + N, 0.0f);
        if (!st.done) c.busy = true;
    }

    [[nodiscard]] static float read(const BoundAsset& a, u32 frame, u32 channel) {
        const u32 index = frame * a.channels + channel;
        if (a.encoding == static_cast<u8>(AssetEncoding::I16)) {
            return static_cast<float>(reinterpret_cast<const std::int16_t*>(a.data)[index]) * 3.0517578e-5f;
        }
        return reinterpret_cast<const float*>(a.data)[index];
    }

    // A linear law, so left + right is always `in`. A mono build can therefore output in / 2 for any position, which is
    // exactly (left + right) / 2, with no position read and no pan math in the binary.
    static void pan(const DecodedStep& s, RunContext& c) {
        const float* in = buffer(c, s.in[0]);
        float* left = buffer(c, s.out[0]);
        float* right = buffer(c, s.out[1]);
        if constexpr (C.channels == 1) {
            B::scale(in, 0.5f, left, N);
            std::memcpy(right, left, sizeof(float) * N);
        } else {
            const float p = clamp(scalar(c, s.in[1]), -1.0f, 1.0f);
            B::scale(in, (1.0f - p) * 0.5f, left, N);
            B::scale(in, (1.0f + p) * 0.5f, right, N);
        }
    }

    static void delay_write(const DecodedStep& s, RunContext& c) {
        DelayLine& line = c.lines[s.resource];
        const float* in = buffer(c, s.in[0]);
        u32 w = line.write;
        for (u32 i = 0; i < N; ++i) {
            line.data[w] = in[i];
            if (++w == line.length) w = 0;
        }
        line.write = w;
        line.written = std::min(line.length, line.written + N);
    }

    static void delay_read(const DecodedStep& s, RunContext& c) {
        const DelayLine& line = c.lines[s.resource];
        float* out = buffer(c, s.out[0]);
        const bool before_write = s.mode == kReadBeforeWrite;
        const u32 ceiling = line.length - N - 2;
        const float wanted = clamp(scalar(c, s.in[0]), 0.0f, 3600.0f) * c.rate;
        u32 d = wanted < static_cast<float>(ceiling) ? static_cast<u32>(wanted) : ceiling;
        if (before_write) d = std::max(d, N);  // Feedback cannot read what this frame has not written yet
        const u32 behind = before_write ? d : d + N;
        for (u32 i = 0; i < N; ++i) {
            const u32 distance = behind - i;
            if (distance > line.written) {
                out[i] = 0.0f;
                continue;
            }
            const u32 r = line.write >= distance ? line.write - distance : line.write + line.length - distance;
            out[i] = line.data[r];
        }
    }

    [[nodiscard]] static u32 line_delay(const RunContext& c, const DelayLine& line, float seconds) {
        const float wanted = clamp(seconds, 0.0f, 3600.0f) * c.rate;
        const u32 ceiling = line.length - 1;
        const u32 d = wanted < static_cast<float>(ceiling) ? static_cast<u32>(wanted) : ceiling;
        return std::max<u32>(d, 1);
    }

    static void comb(const DecodedStep& s, RunContext& c) {
        DelayLine& line = c.lines[s.resource];
        auto& st = state<CombState>(c, s);
        const float* in = buffer(c, s.in[0]);
        float* out = buffer(c, s.out[0]);
        const u32 d = line_delay(c, line, scalar(c, s.in[1]));
        const float feedback = clamp(scalar(c, s.in[2]), -0.995f, 0.995f);
        const float damp = clamp(scalar(c, s.in[3]), 0.0f, 0.99f);
        float low = st.low;
        u32 w = line.write, written = line.written;
        for (u32 i = 0; i < N; ++i) {
            const u32 r = w >= d ? w - d : w + line.length - d;
            const float y = d <= written ? line.data[r] : 0.0f;
            const float x = in[i];  // read first: out may alias in
            low = y * (1.0f - damp) + low * damp;
            line.data[w] = x + low * feedback;
            out[i] = y;
            if (++w == line.length) w = 0;
            if (written < line.length) ++written;
        }
        st.low = flush(low);
        line.write = w;
        line.written = written;
    }

    static void allpass(const DecodedStep& s, RunContext& c) {
        DelayLine& line = c.lines[s.resource];
        const float* in = buffer(c, s.in[0]);
        float* out = buffer(c, s.out[0]);
        const u32 d = line_delay(c, line, scalar(c, s.in[1]));
        const float feedback = clamp(scalar(c, s.in[2]), -0.995f, 0.995f);
        u32 w = line.write, written = line.written;
        for (u32 i = 0; i < N; ++i) {
            const u32 r = w >= d ? w - d : w + line.length - d;
            const float y = d <= written ? line.data[r] : 0.0f;
            const float x = in[i];  // read first: out may alias in
            line.data[w] = x + y * feedback;
            out[i] = y - x;
            if (++w == line.length) w = 0;
            if (written < line.length) ++written;
        }
        line.write = w;
        line.written = written;
    }

    static void follow(const DecodedStep& s, RunContext& c) {
        auto& st = state<FollowState>(c, s);
        const float release = clamp(scalar(c, s.in[1]), 1e-4f, 60.0f);
        if (release != st.release) {
            st.release = release;
            st.coef = std::exp(-c.inverse_rate / release);
        }
        const float* in = buffer(c, s.in[0]);
        float* out = buffer(c, s.out[0]);
        float level = st.level;
        for (u32 i = 0; i < N; ++i) {
            const float x = std::fabs(in[i]);
            level = std::max(x, level * st.coef);
            out[i] = level;
        }
        st.level = flush(level);
    }

    static void kmtof(const DecodedStep& s, RunContext& c) {
        auto& st = state<CachedState>(c, s);
        const float in = clamp(scalar(c, s.in[0]), -48.0f, 200.0f);
        if (in != st.in || st.out == 0.0f) {
            st.in = in;
            st.out = 440.0f * std::pow(2.0f, (in - 69.0f) / 12.0f);
        }
        set_scalar(c, s.out[0], st.out);
    }

    static void kratio(const DecodedStep& s, RunContext& c) {
        auto& st = state<CachedState>(c, s);
        const float in = clamp(scalar(c, s.in[0]), -48.0f, 200.0f);
        if (in != st.in || st.out == 0.0f) {
            st.in = in;
            st.out = std::pow(2.0f, (in - static_cast<float>(s.mode)) / 12.0f);
        }
        set_scalar(c, s.out[0], st.out);
    }

    static void klfo(const DecodedStep& s, RunContext& c) {
        auto& st = state<LfoState>(c, s);
        const float rate = clamp(scalar(c, s.in[0]), 0.0f, 1000.0f);
        const float phase = static_cast<float>(st.phase) * 2.3283064e-10f;
        set_scalar(c, s.out[0], scalar(c, s.in[1]) * std::sin(phase * 2.0f * std::numbers::pi_v<float>));
        st.phase += static_cast<u32>(clamp(rate * static_cast<float>(N) * c.inverse_rate, 0.0f, 0.5f) * 4294967040.0f);
    }
};

}  // namespace modsynth
