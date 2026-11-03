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
#include <type_traits>

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
    float* data;  // 16-bit samples instead, for a line the I16 ops use
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
    u8 note = 0;  // what the voice was started with, which a glide doesn't move. 0 in an insert.
    u8 velocity = 0;
    u32 ordinal = 0;       // how many notes its track had started before this one, which a round robin counts
    bool busy = false;     // an Env or Sample is still sounding
    bool stopped = false;  // the transport is not playing, which only a control step is told
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
    struct OscModState {
        u32 phase;            // the accumulator, which the phase input is added to and never moves
        u32 read;             // where the wave was read last
        u32 edge;             // where a pulse last fell
        float sync;           // the sync input's last sample
        float earlier, last;  // a sine's last two samples, which feedback averages
        float pending;        // the sample owed, as a jump corrects the sample before it too
        u32 started;
    };
    struct NoiseState {
        u32 x;
    };
    struct SampleState {
        u64 position;  // 32.32
        u32 done;
        u32 reserved;
    };
    struct Sample2State {
        u64 position;            // 32.32
        float semitones, ratio;  // the last distance from the zone's root, and the ratio worked out from it
        u32 zone;
        u8 started, done, released, reserved;
    };
    struct Sample3Head {
        u64 position;  // 32.32
        float semitones, ratio;
        float gain;
        u32 zone;  // the row it plays, or the row count for none
        u32 done;
    };
    struct Sample3State {
        Sample3Head heads[kZone3Heads];
        u8 started, released, reserved[2];
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
            case Op::OscMod:
                return sizeof(OscModState);
            case Op::Biquad:
                return sizeof(BiquadState);
            case Op::Env:
                return sizeof(EnvState);
            case Op::Sample:
                return sizeof(SampleState);
            case Op::Sample2:
                return sizeof(Sample2State);
            case Op::Sample3:
                return sizeof(Sample3State);
            case Op::Comb:
            case Op::CombI16:
                return sizeof(CombState);
            case Op::Follow:
                return sizeof(FollowState);
            case Op::KMtoF:
            case Op::KRatio:
                return sizeof(CachedState);
            case Op::KLfo:
            case Op::KLfo2:
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
    // An Either input. A scalar holds for the frame, so a stride of 0 reads the same one every time.
    struct Signal {
        const float* at;
        u32 stride;
        [[nodiscard]] float operator[](u32 i) const { return at[i * stride]; }
    };
    [[nodiscard]] static Signal signal(const RunContext& c, DecodedOperand o) {
        if (o.bank == static_cast<u16>(Bank::Buffer)) return {buffer(c, o), 1};
        return {c.banks[o.bank] + o.index, 0};
    }
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
            case Op::Sample2:
                sample2(s, c);
                break;
            case Op::Sample3:
                sample3(s, c);
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
                delay_write<float>(s, c);
                break;
            case Op::DelayRead:
                delay_read<float>(s, c);
                break;
            case Op::Comb:
                comb<float>(s, c);
                break;
            case Op::Allpass:
                allpass<float>(s, c);
                break;
            case Op::DelayWriteI16:
                delay_write<std::int16_t>(s, c);
                break;
            case Op::DelayReadI16:
                delay_read<std::int16_t>(s, c);
                break;
            case Op::CombI16:
                comb<std::int16_t>(s, c);
                break;
            case Op::AllpassI16:
                allpass<std::int16_t>(s, c);
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
                klfo(s, c, true);
                break;
            case Op::KLfo2:
                klfo(s, c, !c.stopped);
                break;
            case Op::OscMod:
                osc_mod(s, c);
                break;
            case Op::Math:
                math(s, c);
                break;
            case Op::KMath:
                set_scalar(c, s.out[0], kmath(s, c));
                break;
            case Op::Shape:
                shape(s, c);
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

    [[nodiscard]] static float ramp(u32 p) {
        return static_cast<float>(static_cast<std::int32_t>(p)) * 4.656612873e-10f;
    }
    [[nodiscard]] static float folded(u32 phase) {
        const u32 p = phase + 0x40000000u;
        const u32 fold = p ^ static_cast<u32>(static_cast<std::int32_t>(p) >> 31);
        return static_cast<float>(static_cast<std::int32_t>(fold)) * 9.313225746e-10f - 1.0f;
    }

    // Rises from 0, so a note starts without a click, and jumps from 1 to -1 at half a turn.
    static void saw(const DecodedStep& s, RunContext& c) {
        auto& st = state<OscState>(c, s);
        const u32 inc = phase_increment(s, c);
        u32 phase = st.phase;
        float* out = buffer(c, s.out[0]);
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
            out[i] = folded(phase);
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

    // What a jump at `height` between two samples adds to each of them. Where the Saw and Pulse kernels correct a
    // sample only by where it lies, a jump here can come from a sync edge, between samples, in either direction, so
    // this holds the whole correction: `since` is how much of a sample ago it happened, and the sample before it is
    // part of it.
    struct Blep {
        float before = 0.0f, after = 0.0f;
        void add(float height, float since) {
            const float rest = 1.0f - since;
            before += 0.5f * height * since * since;
            after -= 0.5f * height * rest * rest;
        }
        // Adds a jump at one place in the wave, if reading it moved from `from` to `to` relative to that place. The
        // moved test tells this crossing from the one half a turn away, where the signs also differ.
        void cross(u32 from, u32 to, float height) {
            const auto was = static_cast<std::int32_t>(from), is = static_cast<std::int32_t>(to);
            const auto moved = static_cast<std::int32_t>(to - from);
            if ((was ^ is) >= 0 || (is ^ moved) < 0) return;
            add(moved > 0 ? height : -height, static_cast<float>(is) / static_cast<float>(moved));
        }
    };

    template <OscModMode M>
    [[nodiscard]] static float mod_wave(u32 read, u32 edge, float mean) {
        if constexpr (M == OscModMode::Sine) {
            return sin_turns(static_cast<float>(static_cast<std::int32_t>(read)) * 2.32830644e-10f);
        } else if constexpr (M == OscModMode::Triangle) {
            return folded(read);
        } else if constexpr (M == OscModMode::Saw || M == OscModMode::NaiveSaw) {
            return ramp(read);
        } else {
            return (read < edge ? 1.0f : -1.0f) - mean;
        }
    }

    // Frequency, phase and sync, any of them audio or a scalar, and a fourth input that is feedback on a sine and width
    // on a pulse. Frequency can go below zero, and the wave then runs backwards. A rising edge through zero on sync
    // restarts it, and that jump is smoothed as a saw's own jump is, whichever wave this is, which takes the sample
    // after it. So the band-limited forms are a sample late. Like Tone, it starts on the note's sample.
    template <OscModMode M>
    static void osc_mod_wave(const DecodedStep& s, RunContext& c) {
        static constexpr bool naive = M == OscModMode::NaiveSaw || M == OscModMode::NaivePulse;
        static constexpr bool sine = M == OscModMode::Sine;
        static constexpr bool saw = M == OscModMode::Saw || M == OscModMode::NaiveSaw;
        static constexpr bool pulse = M == OscModMode::Pulse || M == OscModMode::NaivePulse;
        auto& st = state<OscModState>(c, s);
        const Signal freq = signal(c, s.in[0]), offset = signal(c, s.in[1]), sync = signal(c, s.in[2]),
                     fourth = signal(c, s.in[3]);
        float* out = buffer(c, s.out[0]);
        const auto step_at = [&](u32 at) {
            const float turns = freq[at] * c.inverse_rate;
            if (turns != turns) return std::int32_t{0};  // As Saw does: clamp() would make NaN a tone at half the rate
            return static_cast<std::int32_t>(clamp(turns, -0.5f, 0.5f) * 4294967040.0f);
        };
        u32 i = 0;
        if (st.started == 0) {
            st.started = 1;
            i = c.gate.on < N ? c.gate.on : 0;
            std::fill(out, out + i, 0.0f);
            st.sync = sync[i];
            // A step back from where it starts, so a wave that starts on a jump, as a pulse does, softens it like any
            // other.
            st.read = turns_to_phase(offset[i]) - static_cast<u32>(step_at(i));
            if constexpr (pulse) st.edge = static_cast<u32>(clamp(fourth[i], 0.0f, 1.0f) * 4294967040.0f);
        }
        u32 phase = st.phase, last_read = st.read, last_edge = st.edge;
        float last_sync = st.sync, earlier = st.earlier, last = st.last, pending = st.pending;
        for (; i < N; ++i) {
            const std::int32_t step = step_at(i);
            const u32 moved = turns_to_phase(offset[i]);
            const float width = pulse ? clamp(fourth[i], 0.0f, 1.0f) : 0.0f;
            const u32 edge = pulse ? static_cast<u32>(width * 4294967040.0f) : 0u;
            const float mean = width + width - 1.0f;
            const u32 pushed = sine ? turns_to_phase(clamp(fourth[i], -1.0f, 1.0f) * (earlier + last) * 0.5f) : 0u;
            const float edge_in = sync[i];
            Blep blep;
            u32 read;
            if (last_sync <= 0.0f && edge_in > 0.0f) {
                const float since = clamp(edge_in / (edge_in - last_sync), 0.0f, 1.0f);
                const float reach = static_cast<float>(step);
                const u32 caught = last_read + static_cast<u32>(static_cast<std::int32_t>(reach * (1.0f - since)));
                if constexpr (!naive) {
                    blep.add(mod_wave<M>(moved + pushed, edge, mean) - mod_wave<M>(caught + pushed, edge, mean), since);
                }
                phase = static_cast<u32>(static_cast<std::int32_t>(reach * since));
                read = phase + moved;
            } else {
                read = phase + moved;
                if constexpr (saw && !naive) {
                    blep.cross(last_read + 0x80000000u, read + 0x80000000u, -2.0f);
                } else if constexpr (pulse && !naive) {
                    blep.cross(last_read, read, 2.0f);
                    blep.cross(last_read - last_edge, read - edge, -2.0f);
                }
            }
            last_sync = edge_in;
            const float value = mod_wave<M>(read + pushed, edge, mean);
            if constexpr (sine) {
                earlier = last;
                last = value;
            }
            if constexpr (naive) {
                out[i] = value;
            } else {
                out[i] = pending + blep.before;
                pending = value + blep.after;
            }
            last_read = read;
            last_edge = edge;
            phase += static_cast<u32>(step);
        }
        st.phase = phase;
        st.read = last_read;
        st.edge = last_edge;
        st.sync = last_sync;
        st.earlier = earlier;
        st.last = last;
        st.pending = pending;
    }

    static void osc_mod(const DecodedStep& s, RunContext& c) {
        switch (static_cast<OscModMode>(s.mode)) {
            case OscModMode::Sine:
                return osc_mod_wave<OscModMode::Sine>(s, c);
            case OscModMode::Triangle:
                return osc_mod_wave<OscModMode::Triangle>(s, c);
            case OscModMode::Saw:
                return osc_mod_wave<OscModMode::Saw>(s, c);
            case OscModMode::Pulse:
                return osc_mod_wave<OscModMode::Pulse>(s, c);
            case OscModMode::NaiveSaw:
                return osc_mod_wave<OscModMode::NaiveSaw>(s, c);
            case OscModMode::NaivePulse:
                return osc_mod_wave<OscModMode::NaivePulse>(s, c);
        }
    }

    // Division by zero gives 0. Compare gives 1 if a is above b, and select gives b if a is above 0.
    template <MathMode M>
    [[nodiscard]] static float math_of(float a, float b, float d) {
        if constexpr (M == MathMode::Min) {
            return a < b ? a : b;
        } else if constexpr (M == MathMode::Max) {
            return a > b ? a : b;
        } else if constexpr (M == MathMode::Abs) {
            return a < 0.0f ? -a : a;
        } else if constexpr (M == MathMode::Clip) {
            return clamp(a, b, d);
        } else if constexpr (M == MathMode::Floor) {
            return floor_of(a);
        } else if constexpr (M == MathMode::Divide) {
            return b == 0.0f ? 0.0f : a / b;
        } else if constexpr (M == MathMode::Compare) {
            return a > b ? 1.0f : 0.0f;
        } else {
            return a > 0.0f ? b : d;
        }
    }

    template <MathMode M>
    static void math_run(const DecodedStep& s, RunContext& c) {
        const Signal a = signal(c, s.in[0]), b = signal(c, s.in[1]), d = signal(c, s.in[2]);
        float* out = buffer(c, s.out[0]);
        for (u32 i = 0; i < N; ++i) out[i] = math_of<M>(a[i], b[i], d[i]);
    }

    static void math(const DecodedStep& s, RunContext& c) {
        switch (static_cast<MathMode>(s.mode)) {
            case MathMode::Min:
                return math_run<MathMode::Min>(s, c);
            case MathMode::Max:
                return math_run<MathMode::Max>(s, c);
            case MathMode::Abs:
                return math_run<MathMode::Abs>(s, c);
            case MathMode::Clip:
                return math_run<MathMode::Clip>(s, c);
            case MathMode::Floor:
                return math_run<MathMode::Floor>(s, c);
            case MathMode::Divide:
                return math_run<MathMode::Divide>(s, c);
            case MathMode::Compare:
                return math_run<MathMode::Compare>(s, c);
            case MathMode::Select:
                return math_run<MathMode::Select>(s, c);
        }
    }

    [[nodiscard]] static float kmath(const DecodedStep& s, const RunContext& c) {
        const float a = scalar(c, s.in[0]), b = scalar(c, s.in[1]), d = scalar(c, s.in[2]);
        switch (static_cast<MathMode>(s.mode)) {
            case MathMode::Min:
                return math_of<MathMode::Min>(a, b, d);
            case MathMode::Max:
                return math_of<MathMode::Max>(a, b, d);
            case MathMode::Abs:
                return math_of<MathMode::Abs>(a, b, d);
            case MathMode::Clip:
                return math_of<MathMode::Clip>(a, b, d);
            case MathMode::Floor:
                return math_of<MathMode::Floor>(a, b, d);
            case MathMode::Divide:
                return math_of<MathMode::Divide>(a, b, d);
            case MathMode::Compare:
                return math_of<MathMode::Compare>(a, b, d);
            case MathMode::Select:
                return math_of<MathMode::Select>(a, b, d);
        }
        return 0.0f;  // unreachable: the validator bounds the mode
    }

    // The input is a place along a table that runs from -1 to 1, so the guard is the curve's value at 1 and not a copy
    // of its start.
    static void shape(const DecodedStep& s, RunContext& c) {
        const BoundTable& t = c.resources[s.resource].table;
        const float half = static_cast<float>(t.length) * 0.5f;
        const float* in = buffer(c, s.in[0]);
        float* out = buffer(c, s.out[0]);
        for (u32 i = 0; i < N; ++i) {
            const float place = (clamp(in[i], -1.0f, 1.0f) + 1.0f) * half;
            const u32 idx = std::min(static_cast<u32>(place), t.length - 1u);
            const float a = t.data[idx];
            out[i] = a + (t.data[idx + 1] - a) * (place - static_cast<float>(idx));
        }
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
        // A loop for each stage, on a level and a place held in locals, so a sample costs its stage's arithmetic and
        // not a switch and a store. The sample a stage ends on is written as the stage leaves it, as before.
        const auto until = [&out, &st, sustain](u32 from, u32 end) {
            float level = st.level;
            u32 stage = st.stage, n = from;
            while (n < end) {
                switch (stage) {
                    case Attack: {
                        const float inc = st.attack_inc;
                        for (; n < end; ++n) {
                            level += inc;
                            if (level >= 1.0f) {
                                level = 1.0f;
                                stage = Decay;
                                out[n++] = level;
                                break;
                            }
                            out[n] = level;
                        }
                        break;
                    }
                    case Decay: {
                        const float coef = st.decay_coef;
                        for (; n < end; ++n) {
                            level = sustain + (level - sustain) * coef;
                            if (level - sustain < 1e-4f) {
                                level = sustain;
                                stage = Sustain;
                                out[n++] = level;
                                break;
                            }
                            out[n] = level;
                        }
                        break;
                    }
                    case Sustain:
                        level = sustain;
                        for (; n < end; ++n) out[n] = level;
                        break;
                    case Release: {
                        const float coef = st.release_coef;
                        for (; n < end; ++n) {
                            level *= coef;
                            if (level < 1e-4f) {
                                level = 0.0f;
                                stage = Idle;
                                out[n++] = level;
                                break;
                            }
                            out[n] = level;
                        }
                        break;
                    }
                    default:
                        level = 0.0f;
                        for (; n < end; ++n) out[n] = level;
                }
            }
            st.level = level;
            st.stage = stage;
            return n;
        };
        const u32 on = c.gate.on, off = c.gate.off;
        const bool on_first = on <= off;
        const u32 first = on_first ? on : off, second = on_first ? off : on;
        const auto apply = [&](u32 at) {
            if (at == on) st.stage = Attack;
            if (at == off && st.stage != Idle) st.stage = Release;
        };
        u32 i = 0;
        if (first < N) {
            i = until(i, first);
            apply(first);
            if (second < N && second != first) {
                i = until(i, second);
                apply(second);
            }
        }
        until(i, N);
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
        // A recording that ended stays ended, even if a live swap gives it a loop.
        if (!st.done)
            with_format(a, [&]<bool F32, bool Stereo>() {
                u64 position = st.position;
                u32 n = i;
                for (; n < N; ++n) {
                    const u32 idx = static_cast<u32>(position >> 32);
                    if (!looping && idx >= a.frames) {
                        st.done = 1;
                        break;
                    }
                    const float frac = static_cast<float>(static_cast<u32>(position)) * 2.3283064e-10f;
                    const float l0 = read_as<F32, Stereo>(a, idx, 0), l1 = read_as<F32, Stereo>(a, idx + 1, 0);
                    float value = l0 + (l1 - l0) * frac;
                    float other = value;
                    if constexpr (Stereo) {
                        const float r0 = read_as<F32, Stereo>(a, idx, 1), r1 = read_as<F32, Stereo>(a, idx + 1, 1);
                        other = r0 + (r1 - r0) * frac;
                    }
                    if constexpr (C.channels == 1) {
                        // A mono build folds here, so a stereo asset costs one extra read and no stereo buses.
                        value = other = (value + other) * 0.5f;
                    }
                    left[n] = value;
                    right[n] = other;
                    position += inc;
                    if (looping && position >= loop_end) position -= loop_length;
                }
                st.position = position;
                i = n;
            });
        std::fill(left + i, left + N, 0.0f);
        std::fill(right + i, right + N, 0.0f);
        if (!st.done) c.busy = true;
    }

    [[nodiscard]] static u32 pick_zone(const BoundTable& zones, u8 note, u8 velocity) {
        const u32 rows = zones.length / kZoneFields;
        const float key = static_cast<float>(note), level = static_cast<float>(velocity);
        for (u32 z = 0; z < rows; ++z) {
            const float* row = zones.data + z * kZoneFields;
            if (key >= row[kZoneLowKey] && key <= row[kZoneHighKey] && level >= row[kZoneLowVelocity] &&
                level <= row[kZoneHighVelocity]) {
                return z;
            }
        }
        return rows;
    }

    // Picks its recording at the start of a note, by the note and velocity that started the voice, and keeps it. Pitch
    // follows its input from then on, so a glide or a legato change slides the one recording. A zone doesn't change
    // mid-note, because a new recording would start from another place.
    //
    // A loop with no tail repeats until the voice ends, so it doesn't count as still sounding: a note ends with its
    // envelope, or on release if it has none. With a tail it leaves the loop at the release, on that sample, and the
    // voice lasts until the recording ends.
    static void sample2(const DecodedStep& s, RunContext& c) {
        const BoundTable& zones = c.resources[s.resource].table;
        auto& st = state<Sample2State>(c, s);
        float* left = buffer(c, s.out[0]);
        float* right = buffer(c, s.out[1]);
        const bool first_frame = !st.started;
        if (first_frame) {
            st.started = 1;
            st.zone = pick_zone(zones, c.note, c.velocity);
        }
        // A live swap carries state from a patch whose table may be shorter, or have padding here.
        const float* row = st.zone < zones.length / kZoneFields ? zones.data + st.zone * kZoneFields : nullptr;
        if (!row || row[kZoneLowKey] > row[kZoneHighKey]) st.done = 1;
        if (st.done) {
            std::fill(left, left + N, 0.0f);
            std::fill(right, right + N, 0.0f);
            return;
        }
        const BoundAsset& a = c.resources[static_cast<u32>(row[kZoneRef])].asset;
        const bool reverse = (s.mode & kSampleReverse) != 0;
        const bool tail = (s.mode & kSampleTail) != 0;
        const u64 frames = static_cast<u64>(a.frames) << 32;
        if (first_frame) {
            const float from = clamp(scalar(c, s.in[1]), 0.0f, 1.0f);
            const float last = static_cast<float>(a.frames - 1);
            st.position = static_cast<u64>((reverse ? 1.0f - from : from) * last * 4294967296.0f);
        }

        const float semitones = clamp(scalar(c, s.in[0]), -48.0f, 200.0f) - row[kZoneRoot];
        if (semitones != st.semitones || st.ratio == 0.0f) {
            st.semitones = semitones;
            st.ratio = pow2(semitones / 12.0f);
        }
        const float step = clamp(st.ratio, 0.0f, 256.0f) * a.native_rate * c.inverse_rate;
        u64 inc = static_cast<u64>(std::min(step, 65536.0f) * 4294967296.0f);
        const bool looping = a.loop_end != 0;
        const u64 loop_start = static_cast<u64>(a.loop_start) << 32;
        const u64 loop_end = static_cast<u64>(a.loop_end) << 32;
        const u64 loop_length = loop_end - loop_start;
        if (looping && inc >= loop_length) inc = loop_length - 1;  // so one step below is always enough
        if (reverse && st.position >= frames) st.position = frames - 1;

        u32 i = c.gate.on < N ? c.gate.on : 0;
        if (!first_frame) i = 0;
        std::fill(left, left + i, 0.0f);
        std::fill(right, right + i, 0.0f);
        const auto until = [&](u32 end) {
            const bool in_loop = looping && !(tail && st.released);
            // Only a start offset or a live swap can put a position outside a loop in the direction of travel.
            if (in_loop && !reverse && st.position >= loop_end) st.position = loop_start;
            if (in_loop && reverse && st.position < loop_start) st.position = loop_end - 1;
            const u64 floor = in_loop ? loop_start : 0;
            if (st.done) return;
            with_format(a, [&]<bool F32, bool Stereo>() {
                u64 position = st.position;
                u32 n = i;
                bool done = false;
                for (; n < end && !done; ++n) {
                    const u32 idx = static_cast<u32>(position >> 32);
                    if (idx >= a.frames) {
                        done = true;
                        break;
                    }
                    const float frac = static_cast<float>(static_cast<u32>(position)) * 2.3283064e-10f;
                    const float l0 = read_as<F32, Stereo>(a, idx, 0), l1 = read_as<F32, Stereo>(a, idx + 1, 0);
                    float value = l0 + (l1 - l0) * frac;
                    float other = value;
                    if constexpr (Stereo) {
                        const float r0 = read_as<F32, Stereo>(a, idx, 1), r1 = read_as<F32, Stereo>(a, idx + 1, 1);
                        other = r0 + (r1 - r0) * frac;
                    }
                    if constexpr (C.channels == 1) value = other = (value + other) * 0.5f;
                    left[n] = value;
                    right[n] = other;
                    if (!reverse) {
                        position += inc;
                        if (in_loop && position >= loop_end) position -= loop_length;
                    } else if (position - floor >= inc) {
                        position -= inc;
                    } else if (in_loop) {
                        position += loop_length - inc;
                    } else {
                        done = true;
                    }
                }
                st.position = position;
                if (done) st.done = 1;
                i = n;
            });
        };
        if (c.gate.off < N) {
            until(c.gate.off);
            st.released = 1;
        }
        until(N);
        std::fill(left + std::min(i, N), left + N, 0.0f);
        std::fill(right + std::min(i, N), right + N, 0.0f);
        if (!st.done && !(looping && !tail)) c.busy = true;
    }

    // The rows of a Sample3's table that sound for this note, at most two, in table order, and the gain of each.
    static void pick_zones3(const BoundTable& zones, u8 note, u8 velocity, u32 ordinal, Sample3State& st) {
        const u32 rows = zones.length / kZone3Fields;
        const float key = static_cast<float>(note), level = static_cast<float>(velocity);
        u32 found = 0;
        for (u32 z = 0; z < rows && found < kZone3Heads; ++z) {
            const float* row = zones.data + z * kZone3Fields;
            if (!(key >= row[kZoneLowKey] && key <= row[kZoneHighKey])) continue;
            if (!(level >= row[kZoneLowVelocity] && level <= row[kZoneHighVelocity])) continue;
            const u32 length = static_cast<u32>(row[kZoneSeqLength]);
            if (length != 0 && ordinal % length != static_cast<u32>(row[kZoneSeqPosition])) continue;
            float gain = 1.0f;
            if (row[kZoneFadeIn] > 0.0f) gain *= std::min(1.0f, (level - row[kZoneLowVelocity]) / row[kZoneFadeIn]);
            if (row[kZoneFadeOut] > 0.0f) gain *= std::min(1.0f, (row[kZoneHighVelocity] - level) / row[kZoneFadeOut]);
            if (!(gain > 0.0f)) continue;
            st.heads[found++] = {0, 0.0f, 0.0f, gain, z, 0};
        }
        for (u32 h = found; h < kZone3Heads; ++h) st.heads[h] = {0, 0.0f, 0.0f, 0.0f, rows, 1};
    }

    // Sample2's playback, for up to two recordings at once, each with its gain. A note picks them by its key and
    // velocity, as Sample2 does, and by its ordinal on the track for a round robin. In release mode it is silent while
    // its note is held, and when the note is released it picks its recordings and plays them once through from there,
    // loops and all ignored, which keeps its voice alive until they end.
    static void sample3(const DecodedStep& s, RunContext& c) {
        const BoundTable& zones = c.resources[s.resource].table;
        auto& st = state<Sample3State>(c, s);
        float* left = buffer(c, s.out[0]);
        float* right = buffer(c, s.out[1]);
        const bool on_release = (s.mode & kSampleRelease) != 0;
        const bool reverse = (s.mode & kSampleReverse) != 0;
        const bool tail = (s.mode & kSampleTail) != 0;
        std::fill(left, left + N, 0.0f);
        std::fill(right, right + N, 0.0f);

        u32 from = 0;  // where the recordings start in this frame, if they start in it
        bool starting = false;
        if (!on_release && !st.started) {
            st.started = 1;
            starting = true;
            from = c.gate.on < N ? c.gate.on : 0;
        }
        if (on_release && !st.started) {
            if (c.gate.off >= N) {
                c.busy = true;  // Its sound is still to come
                return;
            }
            st.started = 1;
            starting = true;
            from = c.gate.off;
        }
        if (starting) pick_zones3(zones, c.note, c.velocity, c.ordinal, st);

        const u32 rows = zones.length / kZone3Fields;
        const float pitch = clamp(scalar(c, s.in[0]), -48.0f, 200.0f);
        const float start = clamp(scalar(c, s.in[1]), 0.0f, 1.0f);
        bool busy = false;
        const bool was_released = st.released != 0;
        for (Sample3Head& head : st.heads) {
            // A live swap carries state from a patch whose table may be shorter, or have padding here.
            const float* row = head.zone < rows ? zones.data + head.zone * kZone3Fields : nullptr;
            if (!row || row[kZoneLowKey] > row[kZoneHighKey]) head.done = 1;
            if (head.done) continue;
            const BoundAsset& a = c.resources[static_cast<u32>(row[kZoneRef])].asset;
            const u64 frames = static_cast<u64>(a.frames) << 32;
            if (starting) {
                const float last = static_cast<float>(a.frames - 1);
                head.position = static_cast<u64>((reverse ? 1.0f - start : start) * last * 4294967296.0f);
            }
            const float semitones = pitch - row[kZoneRoot];
            if (semitones != head.semitones || head.ratio == 0.0f) {
                head.semitones = semitones;
                head.ratio = pow2(semitones / 12.0f);
            }
            const float step = clamp(head.ratio, 0.0f, 256.0f) * a.native_rate * c.inverse_rate;
            u64 inc = static_cast<u64>(std::min(step, 65536.0f) * 4294967296.0f);
            const bool looping = a.loop_end != 0 && !on_release;
            const u64 loop_start = static_cast<u64>(a.loop_start) << 32;
            const u64 loop_end = static_cast<u64>(a.loop_end) << 32;
            const u64 loop_length = loop_end - loop_start;
            if (looping && inc >= loop_length) inc = loop_length - 1;
            if (reverse && head.position >= frames) head.position = frames - 1;

            u32 i = from;
            bool released = was_released;
            const auto until = [&](u32 end) {
                const bool in_loop = looping && !(tail && released);
                if (in_loop && !reverse && head.position >= loop_end) head.position = loop_start;
                if (in_loop && reverse && head.position < loop_start) head.position = loop_end - 1;
                const u64 floor = in_loop ? loop_start : 0;
                if (head.done) return;
                with_format(a, [&]<bool F32, bool Stereo>() {
                    u64 position = head.position;
                    const float gain = head.gain;
                    u32 n = i;
                    bool done = false;
                    for (; n < end && !done; ++n) {
                        const u32 idx = static_cast<u32>(position >> 32);
                        if (idx >= a.frames) {
                            done = true;
                            break;
                        }
                        const float frac = static_cast<float>(static_cast<u32>(position)) * 2.3283064e-10f;
                        const float l0 = read_as<F32, Stereo>(a, idx, 0), l1 = read_as<F32, Stereo>(a, idx + 1, 0);
                        float value = l0 + (l1 - l0) * frac;
                        float other = value;
                        if constexpr (Stereo) {
                            const float r0 = read_as<F32, Stereo>(a, idx, 1), r1 = read_as<F32, Stereo>(a, idx + 1, 1);
                            other = r0 + (r1 - r0) * frac;
                        }
                        if constexpr (C.channels == 1) value = other = (value + other) * 0.5f;
                        left[n] += value * gain;
                        right[n] += other * gain;
                        if (!reverse) {
                            position += inc;
                            if (in_loop && position >= loop_end) position -= loop_length;
                        } else if (position - floor >= inc) {
                            position -= inc;
                        } else if (in_loop) {
                            position += loop_length - inc;
                        } else {
                            done = true;
                        }
                    }
                    head.position = position;
                    if (done) head.done = 1;
                    i = n;
                });
            };
            if (!on_release && c.gate.off < N && c.gate.off >= from) {
                until(c.gate.off);
                released = true;
            }
            until(N);
            if (!head.done && !(looping && !tail)) busy = true;
        }
        if (!on_release && c.gate.off < N) st.released = 1;
        if (busy) c.busy = true;
    }

    // A sample of a recording whose encoding and channels the caller knows, so a loop over it tests neither.
    template <bool F32, bool Stereo>
    [[nodiscard]] static float read_as(const BoundAsset& a, u32 frame, u32 channel) {
        const u32 index = frame * (Stereo ? 2u : 1u) + channel;
        if constexpr (F32) {
            return reinterpret_cast<const float*>(a.data)[index];
        } else {
            return static_cast<float>(reinterpret_cast<const std::int16_t*>(a.data)[index]) * 3.0517578e-5f;
        }
    }

    // Runs `f` with a recording's encoding and channels as constants. The validator allows only these four.
    template <class F>
    static void with_format(const BoundAsset& a, F&& f) {
        const bool f32 = a.encoding == static_cast<u8>(AssetEncoding::F32), stereo = a.channels == 2;
        if (f32 && stereo) {
            f.template operator()<true, true>();
        } else if (f32) {
            f.template operator()<true, false>();
        } else if (stereo) {
            f.template operator()<false, true>();
        } else {
            f.template operator()<false, false>();
        }
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

    // The most of a frame that reads or writes from `at` on before the line wraps.
    [[nodiscard]] static u32 before_wrap(const DelayLine& line, u32 at, u32 left) {
        return std::min(left, line.length - at);
    }

    // A line holds floats, or for the I16 ops 16-bit samples: x * 32768, held to the i16 range, so a NaN is -32768,
    // and truncated towards zero, which every target's conversion does in one instruction. Rounding to nearest would
    // keep a sample of 1 in a loop whose gain is above a half for ever, so a tail would never reach silence. Reading
    // one back is exact.
    template <class T>
    [[nodiscard]] static T* line_data(const DelayLine& line) {
        return reinterpret_cast<T*>(line.data);
    }
    [[nodiscard]] static float load_sample(float x) { return x; }
    [[nodiscard]] static float load_sample(std::int16_t x) { return static_cast<float>(x) * (1.0f / 32768.0f); }
    template <class T>
    [[nodiscard]] static T store_sample(float x) {
        if constexpr (std::is_same_v<T, float>) {
            return x;
        } else {
            return static_cast<T>(static_cast<std::int32_t>(clamp(x * 32768.0f, -32768.0f, 32767.0f)));
        }
    }

    template <class T>
    static void delay_write(const DecodedStep& s, RunContext& c) {
        DelayLine& line = c.lines[s.resource];
        const float* in = buffer(c, s.in[0]);
        T* data = line_data<T>(line);
        u32 w = line.write;
        for (u32 i = 0; i < N;) {
            const u32 run = before_wrap(line, w, N - i);
            if constexpr (std::is_same_v<T, float>) {
                std::memcpy(data + w, in + i, sizeof(float) * run);
            } else {
                for (u32 j = 0; j < run; ++j) data[w + j] = store_sample<T>(in[i + j]);
            }
            i += run;
            w += run;
            if (w == line.length) w = 0;
        }
        line.write = w;
        line.written = std::min(line.length, line.written + N);
    }

    template <class T>
    static void delay_read(const DecodedStep& s, RunContext& c) {
        const DelayLine& line = c.lines[s.resource];
        float* out = buffer(c, s.out[0]);
        const T* data = line_data<T>(line);
        const bool before_write = s.mode == kReadBeforeWrite;
        const u32 ceiling = line.length - N - 2;
        const float wanted = clamp(scalar(c, s.in[0]), 0.0f, 3600.0f) * c.rate;
        u32 d = wanted < static_cast<float>(ceiling) ? static_cast<u32>(wanted) : ceiling;
        if (before_write) d = std::max(d, N);  // Feedback cannot read what this frame has not written yet
        const u32 behind = before_write ? d : d + N;
        // A read further back than the line has been written gives silence, and those come first in a frame, as each
        // sample reads one nearer. The rest are at most two copies, either side of the wrap.
        const u32 zeros = behind > line.written ? std::min(N, behind - line.written) : 0;
        std::fill(out, out + zeros, 0.0f);
        const u32 first = behind - zeros;
        u32 r = line.write >= first ? line.write - first : line.write + line.length - first;
        for (u32 i = zeros; i < N;) {
            const u32 run = before_wrap(line, r, N - i);
            if constexpr (std::is_same_v<T, float>) {
                std::memcpy(out + i, data + r, sizeof(float) * run);
            } else {
                for (u32 j = 0; j < run; ++j) out[i + j] = load_sample(data[r + j]);
            }
            i += run;
            r += run;
            if (r == line.length) r = 0;
        }
    }

    [[nodiscard]] static u32 line_delay(const RunContext& c, const DelayLine& line, float seconds) {
        const float wanted = clamp(seconds, 0.0f, 3600.0f) * c.rate;
        const u32 ceiling = line.length - 1;
        const u32 d = wanted < static_cast<float>(ceiling) ? static_cast<u32>(wanted) : ceiling;
        return std::max<u32>(d, 1);
    }

    template <class T>
    static void comb(const DecodedStep& s, RunContext& c) {
        DelayLine& line = c.lines[s.resource];
        auto& st = state<CombState>(c, s);
        const float* in = buffer(c, s.in[0]);
        float* out = buffer(c, s.out[0]);
        T* data = line_data<T>(line);
        const u32 d = line_delay(c, line, scalar(c, s.in[1]));
        const float feedback = clamp(scalar(c, s.in[2]), -0.995f, 0.995f);
        const float damp = clamp(scalar(c, s.in[3]), 0.0f, 0.99f);
        float low = st.low;
        u32 w = line.write;
        const u32 written = line.written;
        // A delay further back than the line has been written reads silence, and those samples come first in a frame,
        // as the line fills by one a sample. Then each stretch to a wrap runs without testing for one.
        const u32 zeros = d > written ? std::min(N, d - written) : 0;
        for (u32 i = 0; i < zeros;) {
            const u32 run = before_wrap(line, w, zeros - i);
            T* to = data + w;
            for (u32 j = 0; j < run; ++j) {
                const float y = 0.0f;
                const float x = in[i + j];  // read first: out may alias in
                low = y * (1.0f - damp) + low * damp;
                to[j] = store_sample<T>(x + low * feedback);
                out[i + j] = y;
            }
            i += run;
            w += run;
            if (w == line.length) w = 0;
        }
        u32 r = w >= d ? w - d : w + line.length - d;
        for (u32 i = zeros; i < N;) {
            const u32 run = before_wrap(line, r, before_wrap(line, w, N - i));
            T* to = data + w;
            const T* from = data + r;
            for (u32 j = 0; j < run; ++j) {
                const float y = load_sample(from[j]);
                const float x = in[i + j];  // read first: out may alias in
                low = y * (1.0f - damp) + low * damp;
                to[j] = store_sample<T>(x + low * feedback);
                out[i + j] = y;
            }
            i += run;
            w += run;
            r += run;
            if (w == line.length) w = 0;
            if (r == line.length) r = 0;
        }
        line.write = w;
        line.written = std::min(line.length, written + N);
        st.low = flush(low);
    }

    template <class T>
    static void allpass(const DecodedStep& s, RunContext& c) {
        DelayLine& line = c.lines[s.resource];
        const float* in = buffer(c, s.in[0]);
        float* out = buffer(c, s.out[0]);
        T* data = line_data<T>(line);
        const u32 d = line_delay(c, line, scalar(c, s.in[1]));
        const float feedback = clamp(scalar(c, s.in[2]), -0.995f, 0.995f);
        u32 w = line.write;
        const u32 written = line.written;
        // As in comb()
        const u32 zeros = d > written ? std::min(N, d - written) : 0;
        for (u32 i = 0; i < zeros;) {
            const u32 run = before_wrap(line, w, zeros - i);
            T* to = data + w;
            for (u32 j = 0; j < run; ++j) {
                const float y = 0.0f;
                const float x = in[i + j];  // read first: out may alias in
                to[j] = store_sample<T>(x + y * feedback);
                out[i + j] = y - x;
            }
            i += run;
            w += run;
            if (w == line.length) w = 0;
        }
        u32 r = w >= d ? w - d : w + line.length - d;
        for (u32 i = zeros; i < N;) {
            const u32 run = before_wrap(line, r, before_wrap(line, w, N - i));
            T* to = data + w;
            const T* from = data + r;
            for (u32 j = 0; j < run; ++j) {
                const float y = load_sample(from[j]);
                const float x = in[i + j];  // read first: out may alias in
                to[j] = store_sample<T>(x + y * feedback);
                out[i + j] = y - x;
            }
            i += run;
            w += run;
            r += run;
            if (w == line.length) w = 0;
            if (r == line.length) r = 0;
        }
        line.write = w;
        line.written = std::min(line.length, written + N);
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

    static void klfo(const DecodedStep& s, RunContext& c, bool advance) {
        auto& st = state<LfoState>(c, s);
        const float rate = clamp(scalar(c, s.in[0]), 0.0f, 1000.0f);
        const float phase = static_cast<float>(st.phase) * 2.3283064e-10f;
        set_scalar(c, s.out[0], scalar(c, s.in[1]) * sin_turns(phase));
        if (!advance) return;
        st.phase += static_cast<u32>(clamp(rate * static_cast<float>(N) * c.inverse_rate, 0.0f, 0.5f) * 4294967040.0f);
    }
};

}  // namespace modsynth
