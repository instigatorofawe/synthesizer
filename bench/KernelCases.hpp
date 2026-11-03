#pragma once

// Every kernel on its own, on the inputs a recipe gives it. Google Benchmark runs this list on a host and
// firmware/Bench.cpp runs it on a Cortex-M, so docs/Benchmarks.md has one row per case and neither side can measure
// something else. A case exists for each opcode, and for each way an opcode's cost differs by more than its inputs'
// values.

#include <cstddef>
#include <cstdint>
#include <cstring>

#include <modsynth/Kernels.hpp>

namespace modsynth_bench {

using namespace modsynth;

enum class Recording : u8 { None, MonoI16, StereoI16, MonoF32, StereoF32 };

struct KernelCase {
    const char* name;
    Op op;
    u8 mode = 0;
    float in[4] = {};  // Each Scalar input's value. A Buffer input holds noise, whatever this says.
    u8 audio = 0;      // Which Either inputs are buffers, by bit. The rest read `in`.
    int moving = -1;   // An input that changes every frame, as a modulated one does
    float to = 0.0f;   // and the value it alternates with
    u8 wobble = 0;     // Scalar inputs, by bit, that each move by half their value every frame
    u8 square = 0;     // Buffer inputs, by bit, that hold -1 and 1 in turn rather than noise
    u32 stage = 0;     // The stage an Env is held in
    Recording recording = Recording::None;
    u32 rows = 1;     // How many recordings a Sample3 plays at once: two for a velocity crossfade
    u32 written = 0;  // How much of its delay line has been written, each frame, or 0 for all of it
};

inline constexpr u8 kLowPass = static_cast<u8>(BiquadMode::LowPass);
[[nodiscard]] consteval u8 wave(OscModMode mode) { return static_cast<u8>(mode); }
[[nodiscard]] consteval u8 math(MathMode mode) { return static_cast<u8>(mode); }
inline constexpr KernelCase kKernelCases[] = {
    {.name = "Dispatch only", .op = static_cast<Op>(0)},
    {.name = "Fill", .op = Op::Fill, .in = {0.5f}},
    {.name = "Noise", .op = Op::Noise},
    {.name = "Osc", .op = Op::Osc, .in = {440.0f}},
    {.name = "Saw, naive", .op = Op::Saw, .mode = kNaive, .in = {440.0f}},
    {.name = "Saw, 110 Hz", .op = Op::Saw, .in = {110.0f}},
    {.name = "Saw, 4186 Hz", .op = Op::Saw, .in = {4186.0f}},
    {.name = "Pulse, naive", .op = Op::Pulse, .mode = kNaive, .in = {440.0f, 0.5f}},
    {.name = "Pulse, 110 Hz", .op = Op::Pulse, .in = {110.0f, 0.5f}},
    {.name = "Pulse, 4186 Hz", .op = Op::Pulse, .in = {4186.0f, 0.5f}},
    // At half the rate every sample is beside a jump, which is the most a band-limited wave pays.
    {.name = "Saw, Nyquist", .op = Op::Saw, .in = {24000.0f}},
    {.name = "Pulse, Nyquist", .op = Op::Pulse, .in = {24000.0f, 0.5f}},
    {.name = "Triangle", .op = Op::Triangle, .in = {440.0f}},
    {.name = "Tone", .op = Op::Tone, .in = {440.0f}},
    {.name = "Tone, at 0 Hz", .op = Op::Tone},  // It has no step to hold, so it works one out again every frame
    {.name = "Biquad, still", .op = Op::Biquad, .mode = kLowPass, .in = {0.0f, 1200.0f, 0.7f}},
    {.name = "Biquad, moving",
     .op = Op::Biquad,
     .mode = kLowPass,
     .in = {0.0f, 1200.0f, 0.7f},
     .moving = 1,
     .to = 1300.0f},
    {.name = "Biquad, high pass, moving",
     .op = Op::Biquad,
     .mode = static_cast<u8>(BiquadMode::HighPass),
     .in = {0.0f, 1200.0f, 0.7f},
     .moving = 1,
     .to = 1300.0f},
    {.name = "Biquad, band pass, moving",
     .op = Op::Biquad,
     .mode = static_cast<u8>(BiquadMode::BandPass),
     .in = {0.0f, 1200.0f, 0.7f},
     .moving = 1,
     .to = 1300.0f},
    {.name = "Env, attack", .op = Op::Env, .in = {1.0f, 1.0f, 0.2f, 1.0f}, .stage = 1},
    {.name = "Env, decay", .op = Op::Env, .in = {1.0f, 1.0f, 0.2f, 1.0f}, .stage = 2},
    {.name = "Env, sustain", .op = Op::Env, .in = {1.0f, 1.0f, 0.2f, 1.0f}, .stage = 3},
    {.name = "Env, release", .op = Op::Env, .in = {1.0f, 1.0f, 0.2f, 1.0f}, .stage = 4},
    {.name = "Env, decay, moving", .op = Op::Env, .in = {1.0f, 1.0f, 0.2f, 1.0f}, .wobble = 0b1011, .stage = 2},
    {.name = "Sample, mono i16", .op = Op::Sample, .in = {1.19f}, .recording = Recording::MonoI16},
    {.name = "Sample, mono f32", .op = Op::Sample, .in = {1.19f}, .recording = Recording::MonoF32},
    {.name = "Sample, stereo i16", .op = Op::Sample, .in = {1.19f}, .recording = Recording::StereoI16},
    {.name = "Sample, stereo f32", .op = Op::Sample, .in = {1.19f}, .recording = Recording::StereoF32},
    {.name = "Sample, mono f32, moving",
     .op = Op::Sample,
     .in = {1.19f},
     .wobble = 0b1,
     .recording = Recording::MonoF32},
    {.name = "Sample2, mono i16", .op = Op::Sample2, .in = {64.0f, 0.0f}, .recording = Recording::MonoI16},
    {.name = "Sample2, stereo i16", .op = Op::Sample2, .in = {64.0f, 0.0f}, .recording = Recording::StereoI16},
    {.name = "Sample2, stereo i16, moving",
     .op = Op::Sample2,
     .in = {64.0f, 0.0f},
     .wobble = 0b01,
     .recording = Recording::StereoI16},
    {.name = "Sample2, stereo i16, reverse, moving",
     .op = Op::Sample2,
     .mode = kSampleReverse,
     .in = {64.0f, 0.0f},
     .wobble = 0b01,
     .recording = Recording::StereoI16},
    {.name = "Sample2, stereo i16, tail, moving",
     .op = Op::Sample2,
     .mode = kSampleTail,
     .in = {64.0f, 0.0f},
     .wobble = 0b01,
     .recording = Recording::StereoI16},
    {.name = "Sample2, mono f32, moving",
     .op = Op::Sample2,
     .in = {64.0f, 0.0f},
     .wobble = 0b01,
     .recording = Recording::MonoF32},
    {.name = "Sample3, mono i16", .op = Op::Sample3, .in = {64.0f, 0.0f}, .recording = Recording::MonoI16},
    {.name = "Sample3, stereo i16, moving",
     .op = Op::Sample3,
     .in = {64.0f, 0.0f},
     .wobble = 0b01,
     .recording = Recording::StereoI16},
    {.name = "Sample3, stereo i16, reverse, moving",
     .op = Op::Sample3,
     .mode = kSampleReverse,
     .in = {64.0f, 0.0f},
     .wobble = 0b01,
     .recording = Recording::StereoI16},
    {.name = "Sample3, mono f32, moving",
     .op = Op::Sample3,
     .in = {64.0f, 0.0f},
     .wobble = 0b01,
     .recording = Recording::MonoF32},
    {.name = "Sample3, crossfade, mono i16",
     .op = Op::Sample3,
     .in = {64.0f, 0.0f},
     .recording = Recording::MonoI16,
     .rows = 2},
    {.name = "Sample3, crossfade, stereo i16, moving",
     .op = Op::Sample3,
     .in = {64.0f, 0.0f},
     .wobble = 0b01,
     .recording = Recording::StereoI16,
     .rows = 2},
    {.name = "Sample3, crossfade, stereo i16, reverse, moving",
     .op = Op::Sample3,
     .mode = kSampleReverse,
     .in = {64.0f, 0.0f},
     .wobble = 0b01,
     .recording = Recording::StereoI16,
     .rows = 2},
    {.name = "Sample3, crossfade, mono f32, moving",
     .op = Op::Sample3,
     .in = {64.0f, 0.0f},
     .wobble = 0b01,
     .recording = Recording::MonoF32,
     .rows = 2},
    {.name = "Mul", .op = Op::Mul},
    {.name = "MulS", .op = Op::MulS, .in = {0.0f, 0.5f}},
    {.name = "Add", .op = Op::Add},
    {.name = "AddS", .op = Op::AddS, .in = {0.0f, 0.5f}},
    {.name = "Pan", .op = Op::Pan, .in = {0.0f, 0.25f}},
    {.name = "DelayWrite", .op = Op::DelayWrite},
    {.name = "DelayRead", .op = Op::DelayRead, .in = {0.05f}},
    {.name = "DelayRead, feedback", .op = Op::DelayRead, .mode = kReadBeforeWrite, .in = {0.05f}},
    {.name = "Comb", .op = Op::Comb, .in = {0.0f, 0.05f, 0.8f, 0.2f}},
    {.name = "Allpass", .op = Op::Allpass, .in = {0.0f, 0.05f, 0.5f}},
    // A line still filling, as one is in a note's first frames: half the frame reads silence and half the line.
    {.name = "Comb, filling", .op = Op::Comb, .in = {0.0f, 0.05f, 0.8f, 0.2f}, .written = 2400 - 16},
    {.name = "Allpass, filling", .op = Op::Allpass, .in = {0.0f, 0.05f, 0.5f}, .written = 2400 - 16},
    {.name = "DelayRead, filling", .op = Op::DelayRead, .in = {0.05f}, .written = 2400 + 16},
    {.name = "Follow", .op = Op::Follow, .in = {0.0f, 0.1f}},
    {.name = "Follow, moving", .op = Op::Follow, .in = {0.0f, 0.1f}, .wobble = 0b10},
    {.name = "KMul", .op = Op::KMul, .in = {2.0f, 3.0f}},
    {.name = "KAdd", .op = Op::KAdd, .in = {2.0f, 3.0f}},
    {.name = "KMtoF, still", .op = Op::KMtoF, .in = {69.0f}},
    {.name = "KMtoF, moving", .op = Op::KMtoF, .in = {69.0f}, .moving = 0, .to = 70.0f},
    {.name = "KRatio, still", .op = Op::KRatio, .mode = 60, .in = {69.0f}},
    {.name = "KRatio, moving", .op = Op::KRatio, .mode = 60, .in = {69.0f}, .moving = 0, .to = 70.0f},
    {.name = "KSnap", .op = Op::KSnap},
    {.name = "KLfo", .op = Op::KLfo, .in = {2.0f, 1.0f}},
    {.name = "KLfo2", .op = Op::KLfo2, .in = {2.0f, 1.0f}},
    {.name = "OscMod, sine", .op = Op::OscMod, .mode = wave(OscModMode::Sine), .in = {440.0f}},
    {.name = "OscMod, sine, phase audio",
     .op = Op::OscMod,
     .mode = wave(OscModMode::Sine),
     .in = {440.0f},
     .audio = 0b0010},
    {.name = "OscMod, sine, feedback", .op = Op::OscMod, .mode = wave(OscModMode::Sine), .in = {440.0f, 0, 0, 0.2f}},
    {.name = "OscMod, triangle", .op = Op::OscMod, .mode = wave(OscModMode::Triangle), .in = {440.0f}},
    {.name = "OscMod, saw, 110 Hz", .op = Op::OscMod, .mode = wave(OscModMode::Saw), .in = {110.0f}},
    {.name = "OscMod, saw, 4186 Hz", .op = Op::OscMod, .mode = wave(OscModMode::Saw), .in = {4186.0f}},
    {.name = "OscMod, saw, sync audio",
     .op = Op::OscMod,
     .mode = wave(OscModMode::Saw),
     .in = {4186.0f},
     .audio = 0b0100},
    // A rising edge on sync every other sample, which has a sine read its wave three times a sample there.
    {.name = "OscMod, sine, sync every other sample",
     .op = Op::OscMod,
     .mode = wave(OscModMode::Sine),
     .in = {440.0f, 0, 0, 0.2f},
     .audio = 0b0110,
     .square = 0b0100},
    {.name = "OscMod, pulse, 4186 Hz", .op = Op::OscMod, .mode = wave(OscModMode::Pulse), .in = {4186.0f, 0, 0, 0.5f}},
    {.name = "OscMod, saw, naive", .op = Op::OscMod, .mode = wave(OscModMode::NaiveSaw), .in = {440.0f}},
    {.name = "OscMod, pulse, naive",
     .op = Op::OscMod,
     .mode = wave(OscModMode::NaivePulse),
     .in = {440.0f, 0, 0, 0.5f}},
    {.name = "Math, min, audio and scalar",
     .op = Op::Math,
     .mode = math(MathMode::Min),
     .in = {0, 0.5f},
     .audio = 0b001},
    {.name = "Math, clip, audio", .op = Op::Math, .mode = math(MathMode::Clip), .in = {0, -0.5f, 0.5f}, .audio = 0b001},
    {.name = "Math, floor, audio", .op = Op::Math, .mode = math(MathMode::Floor), .audio = 0b001},
    {.name = "Math, divide, audio", .op = Op::Math, .mode = math(MathMode::Divide), .audio = 0b011},
    {.name = "Math, select, audio", .op = Op::Math, .mode = math(MathMode::Select), .audio = 0b111},
    {.name = "KMath, divide", .op = Op::KMath, .mode = math(MathMode::Divide), .in = {2.0f, 3.0f}},
    {.name = "Shape", .op = Op::Shape},
};

[[nodiscard]] consteval bool every_opcode_has_a_case() {
    for (u8 op = 1; op < static_cast<u8>(Op::kCount); ++op) {
        bool found = false;
        for (const KernelCase& k : kKernelCases) found = found || k.op == static_cast<Op>(op);
        if (!found) return false;
    }
    return true;
}
static_assert(every_opcode_has_a_case(), "A new opcode needs a row in kKernelCases");

// One step run directly, on memory it owns. Large, so a host puts it on the heap and firmware makes it static.
template <SynthConfig C, Backend B>
class KernelRig {
   public:
    using K = Kernels<C, B>;

    // With `warm`, the first frames run before anything is measured, since a step's first frame of a note does work
    // the rest don't, and that is measured on its own.
    void begin(const KernelCase& k, bool warm = true) {
        *this = KernelRig{};
        case_ = &k;
        std::memcpy(constants_, k.in, sizeof(constants_));
        u32 random = 1;
        for (float& x : buffers_) {
            random = random * 1664525u + 1013904223u;
            x = static_cast<float>(random >> 8) * 1.1920929e-7f - 1.0f;
        }
        for (u32 i = 0; i < 4; ++i) {
            if (!(k.square >> i & 1)) continue;
            for (u32 n = 0; n < N; ++n) buffers_[(kFirstInput + i) * N + n] = n % 2 == 0 ? -1.0f : 1.0f;
        }
        for (u32 i = 0; i < kTable; ++i) table_[i] = sin_turns(static_cast<float>(i) / static_cast<float>(kTable));
        table_[kTable] = table_[0];
        for (u32 i = 0; i < 2 * (kRecording + 1); ++i) {
            whole_[i] = static_cast<std::int16_t>(table_[i % kTable] * 16000.0f);
            floats_[i] = table_[i % kTable];
        }
        bind(op_signature(k.op));
        if (!warm) return;
        for (u32 f = 0; f < kWarmup; ++f)
            frame();  // A one-off cost, such as a sampler choosing its zone, isn't what's measured
    }

    void frame() {
        const KernelCase& k = *case_;
        if (k.moving >= 0) constants_[k.moving] = odd_ ? k.in[k.moving] : k.to;
        for (u32 i = 0; k.wobble != 0 && i < 4; ++i) {
            if (k.wobble >> i & 1) constants_[i] = odd_ ? k.in[i] : k.in[i] * 1.5f;
        }
        odd_ = !odd_;
        if (k.written != 0) line_.written = k.written;
        if (k.op == Op::Env) {
            auto& st = *reinterpret_cast<typename K::EnvState*>(state_);
            st.stage = k.stage;
            st.level = k.stage == K::Decay ? 0.9f : 0.5f;
        }
        K::run_step(step_, context_);
    }

    // Every case writes one of these, and reading them keeps a compiler from deleting the work.
    [[nodiscard]] float result() const { return buffers_[0] + voice_[0]; }

   private:
    static constexpr u32 N = C.frame_size;
    static constexpr u32 kWarmup = 8;
    static constexpr u32 kBuffers = 6;
    static constexpr u32 kFirstInput = 2;  // Below it are the two outputs
    static constexpr u32 kTable = 2048;
    static constexpr u32 kRecording = 4096;
    static constexpr u32 kLine = 4096;

    void bind(const OpSignature& signature) {
        const KernelCase& k = *case_;
        step_.op = static_cast<u8>(k.op);
        step_.mode = k.mode;
        for (u16 o = 0; o < signature.outs; ++o) {
            step_.out[o] = {static_cast<u16>(signature.out_kind == Arg::Buffer ? Bank::Buffer : Bank::Voice), o};
        }
        for (u16 i = 0; i < signature.ins; ++i) {
            const bool audio =
                signature.in[i] == Arg::Buffer || (signature.in[i] == Arg::Either && (k.audio >> i & 1) != 0);
            step_.in[i] = audio ? DecodedOperand{static_cast<u16>(Bank::Buffer), static_cast<u16>(kFirstInput + i)}
                                : DecodedOperand{static_cast<u16>(Bank::Const), i};
        }
        const auto asset = [&]() {
            const bool f32 = k.recording == Recording::MonoF32 || k.recording == Recording::StereoF32;
            return BoundAsset{
                .data = f32 ? reinterpret_cast<const std::byte*>(floats_) : reinterpret_cast<const std::byte*>(whole_),
                .native_rate = 48000.0f,
                .frames = kRecording,
                .loop_start = 0,
                .loop_end = kRecording,
                .channels =
                    static_cast<u8>(k.recording == Recording::StereoI16 || k.recording == Recording::StereoF32 ? 2 : 1),
                .encoding = static_cast<u8>(f32 ? AssetEncoding::F32 : AssetEncoding::I16)};
        };
        if (k.op == Op::Osc || k.op == Op::Shape) resources_[0].table = {table_, kTable, 32 - 11};
        if (k.op == Op::Sample) resources_[0].asset = asset();
        if (k.op == Op::Sample2) {
            zones_[kZoneHighKey] = 127.0f;
            zones_[kZoneHighVelocity] = 127.0f;
            zones_[kZoneRef] = 1.0f;
            zones_[kZoneRoot] = 60.0f;
            resources_[0].table = {zones_, kZoneFields, 0};
            resources_[1].asset = asset();
        }
        if (k.op == Op::Sample3) {
            // Rows that each cover everything, and with two they cross over, so both sound at velocity 100.
            for (u32 r = 0; r < k.rows; ++r) {
                float* row = zones_ + r * kZone3Fields;
                row[kZoneHighKey] = 127.0f;
                row[kZoneHighVelocity] = 127.0f;
                row[kZoneRef] = 1.0f;
                row[kZoneRoot] = 60.0f;
                if (k.rows > 1) row[r == 0 ? kZoneFadeOut : kZoneFadeIn] = 127.0f;
            }
            resources_[0].table = {zones_, k.rows * kZone3Fields, 0};
            resources_[1].asset = asset();
        }
        line_ = {line_data_, kLine, 0, kLine};  // Full, so reads do their work rather than returning silence
        context_.buffers = buffers_;
        context_.banks[static_cast<u32>(Bank::Const)] = constants_;
        context_.banks[static_cast<u32>(Bank::Voice)] = voice_;
        context_.voice = voice_;
        context_.track = track_;
        context_.state = reinterpret_cast<std::byte*>(state_);
        context_.lines = &line_;
        context_.resources = resources_;
        context_.rate = 48000.0f;
        context_.inverse_rate = 1.0f / 48000.0f;
        context_.note = 60;
        context_.velocity = 100;
    }

    alignas(16) float buffers_[kBuffers * N] = {};
    float constants_[4] = {};
    float voice_[2] = {};
    float track_[2] = {};
    float zones_[2 * kZone3Fields] = {};
    float table_[kTable + 1] = {};
    float floats_[2 * (kRecording + 1)] = {};
    std::int16_t whole_[2 * (kRecording + 1)] = {};
    float line_data_[kLine] = {};
    alignas(8) std::byte state_[256] = {};
    DelayLine line_{};
    BoundResource resources_[2] = {};
    DecodedStep step_{};
    RunContext context_{};
    const KernelCase* case_ = nullptr;
    bool odd_ = false;
};

}  // namespace modsynth_bench
