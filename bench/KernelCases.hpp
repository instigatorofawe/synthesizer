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

enum class Recording : u8 { None, MonoI16, StereoI16, MonoF32 };

struct KernelCase {
    const char* name;
    Op op;
    u8 mode = 0;
    float in[4] = {};  // Each Scalar input's value. A Buffer input holds noise, whatever this says.
    int moving = -1;   // An input that changes every frame, as a modulated one does
    float to = 0.0f;   // and the value it alternates with
    u32 stage = 0;     // The stage an Env is held in
    Recording recording = Recording::None;
};

inline constexpr u8 kLowPass = static_cast<u8>(BiquadMode::LowPass);
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
    {.name = "Triangle", .op = Op::Triangle, .in = {440.0f}},
    {.name = "Tone", .op = Op::Tone, .in = {440.0f}},
    {.name = "Biquad, still", .op = Op::Biquad, .mode = kLowPass, .in = {0.0f, 1200.0f, 0.7f}},
    {.name = "Biquad, moving",
     .op = Op::Biquad,
     .mode = kLowPass,
     .in = {0.0f, 1200.0f, 0.7f},
     .moving = 1,
     .to = 1300.0f},
    {.name = "Env, attack", .op = Op::Env, .in = {1.0f, 1.0f, 0.2f, 1.0f}, .stage = 1},
    {.name = "Env, decay", .op = Op::Env, .in = {1.0f, 1.0f, 0.2f, 1.0f}, .stage = 2},
    {.name = "Env, sustain", .op = Op::Env, .in = {1.0f, 1.0f, 0.2f, 1.0f}, .stage = 3},
    {.name = "Env, release", .op = Op::Env, .in = {1.0f, 1.0f, 0.2f, 1.0f}, .stage = 4},
    {.name = "Sample, mono i16", .op = Op::Sample, .in = {1.19f}, .recording = Recording::MonoI16},
    {.name = "Sample, mono f32", .op = Op::Sample, .in = {1.19f}, .recording = Recording::MonoF32},
    {.name = "Sample, stereo i16", .op = Op::Sample, .in = {1.19f}, .recording = Recording::StereoI16},
    {.name = "Sample2, mono i16", .op = Op::Sample2, .in = {64.0f, 0.0f}, .recording = Recording::MonoI16},
    {.name = "Sample2, stereo i16", .op = Op::Sample2, .in = {64.0f, 0.0f}, .recording = Recording::StereoI16},
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
    {.name = "Follow", .op = Op::Follow, .in = {0.0f, 0.1f}},
    {.name = "KMul", .op = Op::KMul, .in = {2.0f, 3.0f}},
    {.name = "KAdd", .op = Op::KAdd, .in = {2.0f, 3.0f}},
    {.name = "KMtoF, still", .op = Op::KMtoF, .in = {69.0f}},
    {.name = "KMtoF, moving", .op = Op::KMtoF, .in = {69.0f}, .moving = 0, .to = 70.0f},
    {.name = "KRatio, still", .op = Op::KRatio, .mode = 60, .in = {69.0f}},
    {.name = "KRatio, moving", .op = Op::KRatio, .mode = 60, .in = {69.0f}, .moving = 0, .to = 70.0f},
    {.name = "KSnap", .op = Op::KSnap},
    {.name = "KLfo", .op = Op::KLfo, .in = {2.0f, 1.0f}},
    {.name = "KLfo2", .op = Op::KLfo2, .in = {2.0f, 1.0f}},
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

    void begin(const KernelCase& k) {
        *this = KernelRig{};
        case_ = &k;
        std::memcpy(constants_, k.in, sizeof(constants_));
        u32 random = 1;
        for (float& x : buffers_) {
            random = random * 1664525u + 1013904223u;
            x = static_cast<float>(random >> 8) * 1.1920929e-7f - 1.0f;
        }
        for (u32 i = 0; i < kTable; ++i) table_[i] = sin_turns(static_cast<float>(i) / static_cast<float>(kTable));
        table_[kTable] = table_[0];
        for (u32 i = 0; i < 2 * (kRecording + 1); ++i) {
            whole_[i] = static_cast<std::int16_t>(table_[i % kTable] * 16000.0f);
            floats_[i] = table_[i % kTable];
        }
        bind(op_signature(k.op));
        for (u32 f = 0; f < kWarmup; ++f)
            frame();  // A one-off cost, such as Sample2 choosing its zone, isn't what's measured
    }

    void frame() {
        const KernelCase& k = *case_;
        if (k.moving >= 0) {
            constants_[k.moving] = odd_ ? k.in[k.moving] : k.to;
            odd_ = !odd_;
        }
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
            step_.in[i] = signature.in[i] == Arg::Buffer
                              ? DecodedOperand{static_cast<u16>(Bank::Buffer), static_cast<u16>(kFirstInput + i)}
                              : DecodedOperand{static_cast<u16>(Bank::Const), i};
        }
        const auto asset = [&]() {
            const bool f32 = k.recording == Recording::MonoF32;
            return BoundAsset{
                .data = f32 ? reinterpret_cast<const std::byte*>(floats_) : reinterpret_cast<const std::byte*>(whole_),
                .native_rate = 48000.0f,
                .frames = kRecording,
                .loop_start = 0,
                .loop_end = kRecording,
                .channels = static_cast<u8>(k.recording == Recording::StereoI16 ? 2 : 1),
                .encoding = static_cast<u8>(f32 ? AssetEncoding::F32 : AssetEncoding::I16)};
        };
        if (k.op == Op::Osc) resources_[0].table = {table_, kTable, 32 - 11};
        if (k.op == Op::Sample) resources_[0].asset = asset();
        if (k.op == Op::Sample2) {
            zones_[kZoneHighKey] = 127.0f;
            zones_[kZoneHighVelocity] = 127.0f;
            zones_[kZoneRef] = 1.0f;
            zones_[kZoneRoot] = 60.0f;
            resources_[0].table = {zones_, kZoneFields, 0};
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
    float zones_[kZoneFields] = {};
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
