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

#include <modsynth/Backend.hpp>
#include <modsynth/Config.hpp>
#include <modsynth/Format.hpp>
#include <modsynth/Math.hpp>

namespace modsynth {

struct DecodedOperand {
    u16 bank;
    u16 index;
};

struct DecodedStep {
    u8 op;
    u8 mode;
    u16 resource;  // For Noise, which has none, the step's position, because that is what seeds it
    u32 state;     // byte offset in the instance's state block
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
    struct ToneState {
        float v, d, k;
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
            case Op::Saw:
            case Op::Pulse:
            case Op::Triangle:
                return sizeof(OscState);
            case Op::Tone:
                return sizeof(ToneState);
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
            case Op::Saw:
                saw(s, c);
                break;
            case Op::Pulse:
                pulse(s, c);
                break;
            case Op::Triangle:
                triangle(s, c);
                break;
            case Op::Tone:
                tone(s, c);
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
        // Per voice and repeatable, per section 18. The seed must not depend on where this state happens to sit: a
        // pointer in DelayLine makes that differ between 32 and 64 bits, and a filter's state differs between backends.
        if (st.x == 0) st.x = (c.seed ^ (static_cast<u32>(s.resource) * 2654435761u)) | 1u;
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

    [[nodiscard]] static u32 phase_increment(const DecodedStep& s, const RunContext& c) {
        const float freq = clamp(scalar(c, s.in[0]), 0.0f, c.rate * 0.5f);
        return static_cast<u32>(freq * c.inverse_rate * 4294967040.0f);
    }

    static void osc(const DecodedStep& s, RunContext& c) {
        const BoundTable& t = c.resources[s.resource].table;
        auto& st = state<OscState>(c, s);
        const u32 inc = phase_increment(s, c);
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

    // Harmonics above half the sample rate fold back as tones out of tune with the note, and a jump has harmonics
    // without end. This is PolyBLEP: x is how far this sample is from a jump of 2, in samples from -1 to 1, and the
    // result is what those two samples need added to soften it. Only samples beside a jump pay for it.
    [[nodiscard]] static float blep(float x) { return x < 0.0f ? (1.0f + x) * (1.0f + x) : -(1.0f - x) * (1.0f - x); }
    // One sample's distance from a jump at phase 0, tested with one compare, because almost every sample is not near
    // one.
    [[nodiscard]] static bool near_jump(u32 from_jump, u32 inc) { return from_jump + inc < inc + inc; }
    [[nodiscard]] static float samples_from_jump(u32 from_jump, float inverse_inc) {
        return static_cast<float>(static_cast<std::int32_t>(from_jump)) * inverse_inc;
    }
    [[nodiscard]] static float inverse_of(u32 inc) { return inc == 0 ? 0.0f : 1.0f / static_cast<float>(inc); }

    // Rises from 0, so a note starts without a click, and jumps from 1 to -1 at half a turn.
    static void saw(const DecodedStep& s, RunContext& c) {
        auto& st = state<OscState>(c, s);
        const u32 inc = phase_increment(s, c);
        u32 phase = st.phase;
        float* out = buffer(c, s.out[0]);
        const auto ramp = [](u32 p) { return static_cast<float>(static_cast<std::int32_t>(p)) * 4.656612873e-10f; };
        if (s.mode == kNaive) {
            for (u32 i = 0; i < N; ++i) {
                out[i] = ramp(phase);
                phase += inc;
            }
        } else {
            const float inverse_inc = inverse_of(inc);
            for (u32 i = 0; i < N; ++i) {
                float v = ramp(phase);
                const u32 jump = phase + 0x80000000u;
                if (near_jump(jump, inc)) v -= blep(samples_from_jump(jump, inverse_inc));
                out[i] = v;
                phase += inc;
            }
        }
        st.phase = phase;
    }

    // 1 until `width` of a turn has passed, then -1, less the mean so that moving the width doesn't move the level.
    static void pulse(const DecodedStep& s, RunContext& c) {
        auto& st = state<OscState>(c, s);
        const u32 inc = phase_increment(s, c);
        const float width = clamp(scalar(c, s.in[1]), 0.0f, 1.0f);
        const u32 edge = static_cast<u32>(width * 4294967040.0f);
        const float mean = width + width - 1.0f;
        u32 phase = st.phase;
        float* out = buffer(c, s.out[0]);
        if (s.mode == kNaive) {
            for (u32 i = 0; i < N; ++i) {
                out[i] = (phase < edge ? 1.0f : -1.0f) - mean;
                phase += inc;
            }
        } else {
            const float inverse_inc = inverse_of(inc);
            for (u32 i = 0; i < N; ++i) {
                float v = (phase < edge ? 1.0f : -1.0f) - mean;
                if (near_jump(phase, inc)) v += blep(samples_from_jump(phase, inverse_inc));
                const u32 fall = phase - edge;
                if (near_jump(fall, inc)) v -= blep(samples_from_jump(fall, inverse_inc));
                out[i] = v;
                phase += inc;
            }
        }
        st.phase = phase;
    }

    // Rises from 0 to 1 at a quarter turn, as a sine does. It has no jump, and its harmonics fall by 1/n^2, so it
    // aliases little and has no band-limited form: correcting it costs twice as much for about 12 dB.
    static void triangle(const DecodedStep& s, RunContext& c) {
        auto& st = state<OscState>(c, s);
        const u32 inc = phase_increment(s, c);
        u32 phase = st.phase;
        float* out = buffer(c, s.out[0]);
        for (u32 i = 0; i < N; ++i) {
            const u32 p = phase + 0x40000000u;
            const u32 folded = p ^ static_cast<u32>(static_cast<std::int32_t>(p) >> 31);
            out[i] = static_cast<float>(static_cast<std::int32_t>(folded)) * 9.313225746e-10f - 1.0f;
            phase += inc;
        }
        st.phase = phase;
    }

    // A sine with no table, at half the cost of Osc, from s[n+1] = (2 - k) s[n] - s[n-1]. That is held here as the step
    // d = s[n] - s[n-1], because 2 - k has too few bits left for a low note. The level is carried by the size of that
    // step relative to k, so changing k changes the level, and quick changes can make it grow without limit. So k is
    // set once and never moves: state starts zeroed, and a note has this frequency until it ends. A frequency of 0
    // leaves k at 0, which is silence, and tries again next frame. The clamp is below rate / 2 because k rounds to 4
    // near it. It starts on the note's sample and not the frame's, so a note's phase doesn't depend on where it lands
    // in a frame.
    static void tone(const DecodedStep& s, RunContext& c) {
        auto& st = state<ToneState>(c, s);
        float* out = buffer(c, s.out[0]);
        u32 start = 0;
        if (st.k == 0.0f) {
            const float turns = clamp(scalar(c, s.in[0]), 0.0f, c.rate * 0.45f) * c.inverse_rate;
            const float half = sin_turns(turns * 0.5f);
            st.k = 4.0f * half * half;
            st.d = sin_turns(turns);
            start = c.gate.on < N ? c.gate.on : 0;
            std::fill(out, out + start, 0.0f);
        }
        const float k = st.k;
        float v = st.v;
        float d = st.d;
        for (u32 i = start; i < N; ++i) {
            out[i] = v;
            d -= k * v;
            v += d;
        }
        st.v = v;
        st.d = d;
    }

    static void biquad(const DecodedStep& s, RunContext& c) {
        auto& st = state<BiquadState>(c, s);
        const float cutoff = clamp(scalar(c, s.in[1]), 10.0f, c.rate * 0.45f);
        const float q = clamp(scalar(c, s.in[2]), 0.1f, 30.0f);
        if (cutoff != st.cutoff || q != st.q) {
            st.cutoff = cutoff;
            st.q = q;
            // 1 - cos(w) from a half angle, because cos(w) near 1 loses most of its bits and a low cutoff needs them.
            const float turns = cutoff * c.inverse_rate;
            const float half = sin_turns(turns * 0.5f);
            const float one_minus_cos = 2.0f * half * half;
            const float cosw = 1.0f - one_minus_cos;
            const float alpha = sin_turns(turns) / (2.0f * q);
            const float a0 = 1.0f / (1.0f + alpha);
            BiquadCoeffs k{};
            switch (static_cast<BiquadMode>(s.mode)) {
                case BiquadMode::HighPass: {
                    const float h = (2.0f - one_minus_cos) * 0.5f * a0;
                    k = {h, -2.0f * h, h, 0.0f, 0.0f};
                    break;
                }
                case BiquadMode::BandPass:
                    k = {alpha * a0, 0.0f, -alpha * a0, 0.0f, 0.0f};
                    break;
                default: {
                    const float l = one_minus_cos * 0.5f * a0;
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
            st.decay_coef = exp_minus(c.inverse_rate / decay);
        }
        if (release != st.release) {
            st.release = release;
            st.release_coef = exp_minus(c.inverse_rate / release);
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
        // A live swap carries position over from a Sample that may have played a longer asset.
        if (looping && st.position >= loop_end) st.position = static_cast<u64>(a.loop_start) << 32;

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
            st.coef = exp_minus(c.inverse_rate / release);
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
            st.out = 440.0f * pow2((in - 69.0f) / 12.0f);
        }
        set_scalar(c, s.out[0], st.out);
    }

    static void kratio(const DecodedStep& s, RunContext& c) {
        auto& st = state<CachedState>(c, s);
        const float in = clamp(scalar(c, s.in[0]), -48.0f, 200.0f);
        if (in != st.in || st.out == 0.0f) {
            st.in = in;
            st.out = pow2((in - static_cast<float>(s.mode)) / 12.0f);
        }
        set_scalar(c, s.out[0], st.out);
    }

    static void klfo(const DecodedStep& s, RunContext& c) {
        auto& st = state<LfoState>(c, s);
        const float rate = clamp(scalar(c, s.in[0]), 0.0f, 1000.0f);
        const float phase = static_cast<float>(st.phase) * 2.3283064e-10f;
        set_scalar(c, s.out[0], scalar(c, s.in[1]) * sin_turns(phase));
        st.phase += static_cast<u32>(clamp(rate * static_cast<float>(N) * c.inverse_rate, 0.0f, 0.5f) * 4294967040.0f);
    }
};

}  // namespace modsynth
