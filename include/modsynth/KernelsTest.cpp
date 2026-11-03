#include <cmath>
#include <functional>
#include <gtest/gtest.h>
#include <limits>

#include <modsynth/TestSupport.hpp>

using namespace modsynth_test;

namespace {

constexpr float kNan = std::numeric_limits<float>::quiet_NaN();
constexpr float kInfinity = std::numeric_limits<float>::infinity();
constexpr double kPi = 3.14159265358979323846;

// One step run directly, on state it owns, so a test can give it inputs no compiler would.
template <SynthConfig C = kMono>
struct Oscillator {
    Oscillator(Op op, u8 mode, float frequency, float width = 0.5f) : scalars{frequency, width}, buffer(C.frame_size) {
        const auto constant = static_cast<u16>(Bank::Const);
        step.op = static_cast<u8>(op);
        step.mode = mode;
        step.out[0] = {static_cast<u16>(Bank::Buffer), 0};
        step.in[0] = {constant, 0};
        step.in[1] = {constant, 1};
        context.buffers = buffer.data();
        context.banks[constant] = scalars;
        context.state = reinterpret_cast<std::byte*>(state);
    }

    // In blocks of 128 samples, so a test lasts as long at any frame size.
    std::vector<float> blocks(u32 count) { return render(count * 128 / C.frame_size); }

    std::vector<float> render(u32 frames) {
        std::vector<float> out;
        for (u32 f = 0; f < frames; ++f) {
            Kernels<C, ScalarBackend>::run_step(step, context);
            out.insert(out.end(), buffer.begin(), buffer.end());
        }
        return out;
    }

    float scalars[2];
    std::vector<float> buffer;
    u64 state[8] = {};
    DecodedStep step{};
    RunContext context{};
};

struct Shape {
    Op op;
    u8 mode;
};
constexpr Shape kShapes[] = {{Op::Saw, 0}, {Op::Saw, kNaive}, {Op::Pulse, 0}, {Op::Pulse, kNaive}, {Op::Triangle, 0}};

// One frequency's level, windowed so its neighbours don't leak in.
double level_db(const std::vector<float>& audio, double hz) {
    double re = 0.0, im = 0.0;
    const auto n = static_cast<double>(audio.size());
    for (std::size_t i = 0; i < audio.size(); ++i) {
        const double t = static_cast<double>(i);
        const double window = 0.5 - 0.5 * std::cos(2.0 * kPi * t / n);
        const double angle = 2.0 * kPi * hz * t / static_cast<double>(kRate);
        re += static_cast<double>(audio[i]) * window * std::cos(angle);
        im += static_cast<double>(audio[i]) * window * std::sin(angle);
    }
    return 20.0 * std::log10(4.0 * std::hypot(re, im) / n + 1e-30);
}

float mean(const std::vector<float>& audio) {
    double sum = 0.0;
    for (const float s : audio) sum += static_cast<double>(s);
    return static_cast<float>(sum / static_cast<double>(audio.size()));
}

// An OscMod whose inputs are scalars until a test hands one a signal, which then runs per sample.
template <SynthConfig C = kMono>
struct Modulated {
    using Source = std::function<float(u64)>;

    explicit Modulated(OscModMode mode, float frequency, float fourth = 0.0f)
        : scalars{frequency, 0.0f, 0.0f, fourth}, buffers(5 * C.frame_size) {
        const auto constant = static_cast<u16>(Bank::Const);
        step.op = static_cast<u8>(Op::OscMod);
        step.mode = static_cast<u8>(mode);
        step.out[0] = {static_cast<u16>(Bank::Buffer), 0};
        for (u16 i = 0; i < 4; ++i) step.in[i] = {constant, i};
        context.buffers = buffers.data();
        context.banks[constant] = scalars;
        context.state = reinterpret_cast<std::byte*>(state);
    }

    Modulated& drive(u16 input, Source source) {
        step.in[input] = {static_cast<u16>(Bank::Buffer), static_cast<u16>(input + 1)};
        sources[input] = std::move(source);
        return *this;
    }

    std::vector<float> render(u32 samples) {
        std::vector<float> out;
        while (out.size() < samples) {
            for (u32 i = 0; i < 4; ++i) {
                if (!sources[i]) continue;
                for (u32 k = 0; k < C.frame_size; ++k) {
                    buffers[(i + 1) * C.frame_size + k] = sources[i](clock + k);
                }
            }
            Kernels<C, ScalarBackend>::run_step(step, context);
            clock += C.frame_size;
            out.insert(out.end(), buffers.begin(), buffers.begin() + C.frame_size);
        }
        out.resize(samples);
        return out;
    }

    float scalars[4];
    std::vector<float> buffers;
    Source sources[4];
    u64 clock = 0;
    u64 state[8] = {};
    DecodedStep step{};
    RunContext context{};
};

constexpr OscModMode kModes[] = {OscModMode::Sine,  OscModMode::Triangle, OscModMode::Saw,
                                 OscModMode::Pulse, OscModMode::NaiveSaw, OscModMode::NaivePulse};

double sine(double hz, u64 sample) { return std::sin(2.0 * kPi * hz * static_cast<double>(sample) / kRate); }

}  // namespace

TEST(Oscillators, ANoteStartsFromZeroSoItDoesNotClick) {
    for (const Shape s : kShapes) {
        if (s.op == Op::Pulse && s.mode == kNaive) continue;  // It has only 1 and -1 to start from
        SCOPED_TRACE(static_cast<int>(s.op));
        const auto out = Oscillator<>(s.op, s.mode, 100.0f).blocks(1);
        EXPECT_EQ(out[0], 0.0f);
    }
    EXPECT_EQ(Oscillator<>(Op::Pulse, kNaive, 100.0f).blocks(1)[0], 1.0f);
}

TEST(Tone, IsASineStartingFromZero) {
    for (const float hz : {20.0f, 440.0f, 4186.0f, 12000.0f}) {
        const auto audio = Oscillator<>(Op::Tone, 0, hz).blocks(32);
        EXPECT_EQ(audio[0], 0.0f);
        for (std::size_t i = 0; i < audio.size(); ++i) {
            const double exact = std::sin(2.0 * kPi * static_cast<double>(hz) * static_cast<double>(i) / kRate);
            ASSERT_NEAR(audio[i], exact, 1e-3) << hz << " Hz, sample " << i;
        }
    }
}

// 2 cos(w) has few bits left at a low note, which would put 20 Hz 6 cents flat.
TEST(Tone, IsInTuneFromBottomToTop) {
    for (const float hz : {20.0f, 110.0f, 4186.0f, 12000.0f}) {
        const auto audio = Oscillator<>(Op::Tone, 0, hz).blocks(22500);  // A minute
        double first = -1.0, last = -1.0;
        double rises = 0.0;
        for (std::size_t i = 1; i < audio.size(); ++i) {
            if (audio[i - 1] > 0.0f || audio[i] <= 0.0f) continue;
            const double at = static_cast<double>(i) - static_cast<double>(audio[i]) / (audio[i] - audio[i - 1]);
            if (first < 0.0) {
                first = at;
            } else {
                last = at;
                rises += 1.0;
            }
        }
        const double measured = rises * static_cast<double>(kRate) / (last - first);
        EXPECT_NEAR(1200.0 * std::log2(measured / static_cast<double>(hz)), 0.0, 0.01) << hz;
    }
}

TEST(Tone, HoldsItsFirstFrequencyWhateverTheInputDoes) {
    Oscillator<> moved(Op::Tone, 0, 440.0f);
    Oscillator<> held(Op::Tone, 0, 440.0f);
    for (u32 frame = 0; frame < 64 * kFramesPerBlock; ++frame) {
        const auto a = moved.render(1);
        const auto b = held.render(1);
        EXPECT_EQ(a, b) << "frame " << frame;
        moved.scalars[0] = frame % 2 == 0 ? 12000.0f : kNan;
    }
}

// The input a recursive sine fears most is a frequency that keeps moving, and this one never hears it.
TEST(Tone, KeepsItsLevelForAnHour) {
    Oscillator<> tone(Op::Tone, 0, 110.0f);
    constexpr u32 kFramesPerSecond = static_cast<u32>(kRate) / kMono.frame_size;
    float first = 0.0f;
    for (const float v : tone.render(kFramesPerSecond)) first = std::max(first, std::abs(v));
    for (u32 second = 1; second < 3600; ++second) tone.render(kFramesPerSecond);
    float last = 0.0f;
    for (const float v : tone.render(kFramesPerSecond)) last = std::max(last, std::abs(v));
    EXPECT_NEAR(last, first, 1e-3f);
}

TEST(Tone, StaysInRangeForAnyInput) {
    for (const float hz : {0.001f, 0.5f, 22000.0f, 23999.0f, 24000.0f, 1e9f, kInfinity}) {
        float peak = 0.0f;
        for (const float v : Oscillator<>(Op::Tone, 0, hz).blocks(4096)) peak = std::max(peak, std::abs(v));
        EXPECT_LE(peak, 1.001f) << hz;
    }
    for (const float hz : {0.0f, -440.0f, -kInfinity, kNan}) {
        for (const float v : Oscillator<>(Op::Tone, 0, hz).blocks(4)) EXPECT_EQ(v, 0.0f) << hz;
    }
}

TEST(Tone, StartsOnTheNoteAndNotTheFrame) {
    constexpr u32 kOffset = 20;  // Inside a frame, as a gate's offset always is
    Oscillator<> late(Op::Tone, 0, 440.0f);
    late.context.gate.on = kOffset;
    const auto delayed = late.blocks(4);
    const auto exact = Oscillator<>(Op::Tone, 0, 440.0f).blocks(4);
    for (u32 i = 0; i < kOffset; ++i) EXPECT_EQ(delayed[i], 0.0f);
    for (u32 i = kOffset; i < delayed.size(); ++i) ASSERT_EQ(delayed[i], exact[i - kOffset]) << "sample " << i;
}

TEST(Tone, StartsWhenItFirstHasAFrequency) {
    Oscillator<> late(Op::Tone, 0, 0.0f);
    for (const float v : late.blocks(2)) EXPECT_EQ(v, 0.0f);
    late.scalars[0] = 440.0f;
    EXPECT_EQ(late.blocks(4), Oscillator<>(Op::Tone, 0, 440.0f).blocks(4));
}

TEST(Oscillators, NaiveSawAndTriangleAreTheDocumentedFormulas) {
    constexpr float kFrequency = 440.0f;
    const u32 inc = static_cast<u32>(kFrequency * (1.0f / kRate) * 4294967040.0f);
    const auto saw = Oscillator<>(Op::Saw, kNaive, kFrequency).blocks(4);
    const auto triangle = Oscillator<>(Op::Triangle, 0, kFrequency).blocks(4);
    u32 phase = 0;
    for (std::size_t i = 0; i < saw.size(); ++i, phase += inc) {
        EXPECT_EQ(saw[i], static_cast<float>(static_cast<std::int32_t>(phase)) * 4.656612873e-10f);
        const u32 p = phase + 0x40000000u;
        const u32 folded = p ^ static_cast<u32>(static_cast<std::int32_t>(p) >> 31);
        EXPECT_EQ(triangle[i], static_cast<float>(static_cast<std::int32_t>(folded)) * 9.313225746e-10f - 1.0f);
    }
}

TEST(Oscillators, HaveTheShapesTheirNamesPromise) {
    const auto extremes = [](const std::vector<float>& x) {
        return std::pair(*std::min_element(x.begin(), x.end()), *std::max_element(x.begin(), x.end()));
    };
    const auto low = [](Op op, u8 mode) { return Oscillator<>(op, mode, 100.0f).blocks(64); };
    for (const Shape s : kShapes) {
        SCOPED_TRACE(static_cast<int>(s.op));
        const auto [lowest, highest] = extremes(low(s.op, s.mode));
        EXPECT_NEAR(lowest, -1.0f, 0.02f);
        EXPECT_NEAR(highest, 1.0f, 0.02f);
    }

    // A quarter of a turn after starting, a triangle is at its peak and a saw is halfway up.
    constexpr u32 kPeriod = 480;
    const auto triangle = Oscillator<>(Op::Triangle, 0, kRate / kPeriod).blocks(4);
    const auto saw = Oscillator<>(Op::Saw, kNaive, kRate / kPeriod).blocks(4);
    EXPECT_NEAR(triangle[kPeriod / 4], 1.0f, 0.01f);
    EXPECT_NEAR(triangle[3 * kPeriod / 4], -1.0f, 0.01f);
    EXPECT_NEAR(saw[kPeriod / 4], 0.5f, 0.01f);
}

// A frame boundary must be inaudible, which only holds if all the state lives in the state block.
TEST(Oscillators, AFrameBoundaryChangesNothing) {
    static constexpr SynthConfig kLongFrames{.frame_size = 128, .channels = 1, .tap_slots = 0, .generations = 1};
    for (const Shape s : kShapes) {
        SCOPED_TRACE(static_cast<int>(s.op));
        EXPECT_EQ(Oscillator<kLongFrames>(s.op, s.mode, 4186.0f, 0.3f).render(4),
                  Oscillator<>(s.op, s.mode, 4186.0f, 0.3f).render(16));
    }
}

TEST(Oscillators, StayFiniteAndInRangeForAnyInput) {
    for (const Shape s : kShapes) {
        for (const float frequency :
             {0.0f, -1.0f, 1.0f, 20.0f, 440.0f, 4186.0f, 20000.0f, 24000.0f, 1e9f, kNan, kInfinity, -kInfinity}) {
            for (const float width : {-1.0f, 0.0f, 1e-9f, 0.25f, 0.5f, 0.999f, 1.0f, 2.0f, kNan, kInfinity}) {
                SCOPED_TRACE(testing::Message()
                             << static_cast<int>(s.op) << " at " << frequency << ", width " << width);
                for (const float sample : Oscillator<>(s.op, s.mode, frequency, width).blocks(4)) {
                    ASSERT_TRUE(std::isfinite(sample));
                    ASSERT_LE(std::fabs(sample), 4.0f);
                }
            }
        }
    }
}

TEST(Oscillators, HoldStillAtZeroHertz) {
    for (const Shape s : kShapes) {
        SCOPED_TRACE(static_cast<int>(s.op));
        const auto out = Oscillator<>(s.op, s.mode, 0.0f).blocks(2);
        for (const float sample : out) EXPECT_EQ(sample, out[0]);
    }
}

TEST(Oscillators, PulseWidthSetsTheDutyCycleAndLeavesTheLevelAlone) {
    constexpr float kFrequency = 480.0f;  // 100 samples, so 1.28 periods a block and 12.8 of them in 10 blocks
    for (const float width : {0.1f, 0.25f, 0.5f, 0.75f, 0.9f}) {
        SCOPED_TRACE(width);
        const auto naive = Oscillator<>(Op::Pulse, kNaive, kFrequency, width).blocks(10);
        const auto high = std::count_if(naive.begin(), naive.end(), [](float s) { return s > 0.0f; });
        EXPECT_NEAR(static_cast<float>(high) / static_cast<float>(naive.size()), width, 0.015f);
        EXPECT_NEAR(mean(naive), 0.0f, 0.03f);
        EXPECT_NEAR(mean(Oscillator<>(Op::Pulse, 0, kFrequency, width).blocks(10)), 0.0f, 0.03f);
    }
}

TEST(Oscillators, AWidthOfZeroIsSilence) {
    for (const u8 mode : {u8{0}, kNaive}) {
        for (const float sample : Oscillator<>(Op::Pulse, mode, 4186.0f, 0.0f).blocks(4)) EXPECT_EQ(sample, 0.0f);
    }
}

// Harmonic 11 of 4186 Hz is at 46046 Hz, which folds down to 1954 Hz: below the note, and on no harmonic of it.
TEST(Oscillators, BandLimitingRemovesAliasesAndKeepsTheNote) {
    constexpr float kFrequency = 4186.0f;
    constexpr double kAlias = 48000.0 - 11.0 * 4186.0;
    for (const Op op : {Op::Saw, Op::Pulse}) {
        SCOPED_TRACE(static_cast<int>(op));
        const auto limited = Oscillator<>(op, 0, kFrequency).blocks(256);
        const auto naive = Oscillator<>(op, kNaive, kFrequency).blocks(256);
        EXPECT_LT(level_db(limited, kAlias), level_db(naive, kAlias) - 12.0);
        EXPECT_NEAR(level_db(limited, kFrequency), level_db(naive, kFrequency), 1.0);
    }
}

TEST(Oscillators, TheAliasIsWhereTheTestAboveLooksForIt) {
    constexpr double kAlias = 48000.0 - 11.0 * 4186.0;
    const auto naive = Oscillator<>(Op::Saw, kNaive, 4186.0f).blocks(256);
    const double fundamental = level_db(naive, 4186.0);
    EXPECT_NEAR(level_db(naive, kAlias) - fundamental, 20.0 * std::log10(1.0 / 11.0), 1.0);
    EXPECT_LT(level_db(naive, kAlias + 100.0) - fundamental, -60.0);
}

TEST(OscMod, ASineIsTheSineAskedForASampleLate) {
    const auto audio = Modulated<>(OscModMode::Sine, 997.0f).render(4800);
    EXPECT_EQ(audio[0], 0.0f);
    for (u64 i = 1; i < audio.size(); ++i) ASSERT_NEAR(audio[i], sine(997.0, i - 1), 1e-3) << i;
}

TEST(OscMod, ANaiveWaveIsTheOpItExtends) {
    const auto saw = Modulated<>(OscModMode::NaiveSaw, 997.0f).render(4800);
    const auto pulse = Modulated<>(OscModMode::NaivePulse, 997.0f, 0.3f).render(4800);
    const u32 blocks = 4800 / 128;
    const auto old_saw = Oscillator<>(Op::Saw, kNaive, 997.0f).blocks(blocks);
    const auto old_pulse = Oscillator<>(Op::Pulse, kNaive, 997.0f, 0.3f).blocks(blocks);
    for (std::size_t i = 0; i < old_saw.size(); ++i) {
        ASSERT_EQ(saw[i], old_saw[i]) << i;
        ASSERT_EQ(pulse[i], old_pulse[i]) << i;
    }
}

TEST(OscMod, ABandLimitedWaveIsTheOpItExtendsASampleLate) {
    const auto saw = Modulated<>(OscModMode::Saw, 4186.0f).render(4801);
    const auto pulse = Modulated<>(OscModMode::Pulse, 4186.0f, 0.3f).render(4801);
    const auto triangle = Modulated<>(OscModMode::Triangle, 4186.0f).render(4801);
    const u32 blocks = 4800 / 128;
    const auto old_saw = Oscillator<>(Op::Saw, 0, 4186.0f).blocks(blocks);
    const auto old_pulse = Oscillator<>(Op::Pulse, 0, 4186.0f, 0.3f).blocks(blocks);
    const auto old_triangle = Oscillator<>(Op::Triangle, 0, 4186.0f).blocks(blocks);
    for (std::size_t i = 0; i < old_saw.size(); ++i) {
        ASSERT_NEAR(saw[i + 1], old_saw[i], 2e-3) << i;
        ASSERT_NEAR(pulse[i + 1], old_pulse[i], 2e-3) << i;
        ASSERT_EQ(triangle[i + 1], old_triangle[i]) << i;
    }
}

// J1(1) / J0(1) is 0.575, and no plain sine has any level at either sideband.
TEST(OscMod, FrequencyMovesAtAudioRate) {
    constexpr double kCarrier = 6000.0, kModulator = 1500.0, kIndex = 1.0;
    Modulated<> fm(OscModMode::Sine, 0.0f);
    fm.drive(0, [&](u64 n) { return static_cast<float>(kCarrier + kIndex * kModulator * sine(kModulator, n)); });
    const auto audio = fm.render(48000);
    const double carrier = level_db(audio, kCarrier);
    EXPECT_NEAR(carrier, 20.0 * std::log10(0.7652), 0.1);
    EXPECT_NEAR(level_db(audio, kCarrier + kModulator) - carrier, 20.0 * std::log10(0.5751), 0.2);
    EXPECT_NEAR(level_db(audio, kCarrier - kModulator) - carrier, 20.0 * std::log10(0.5751), 0.2);
}

TEST(OscMod, PhaseMovesAtAudioRateAndLeavesThePitchAlone) {
    Modulated<> pm(OscModMode::Sine, 6000.0f);
    pm.drive(1, [](u64 n) { return static_cast<float>(sine(1500.0, n) / (2.0 * kPi)); });
    const auto audio = pm.render(48000);
    const double carrier = level_db(audio, 6000.0);
    EXPECT_NEAR(carrier, 20.0 * std::log10(0.7652), 0.1);
    EXPECT_NEAR(level_db(audio, 7500.0) - carrier, 20.0 * std::log10(0.5751), 0.2);
}

TEST(OscMod, AQuarterTurnOfPhaseStartsASineAtItsTop) {
    Modulated<> shifted(OscModMode::Sine, 100.0f);
    shifted.scalars[1] = 0.25f;
    EXPECT_NEAR(shifted.render(2)[1], 1.0f, 1e-6f);
}

TEST(OscMod, BelowZeroAWaveRunsBackwards) {
    const auto forward = Modulated<>(OscModMode::Sine, 997.0f).render(4800);
    const auto backward = Modulated<>(OscModMode::Sine, -997.0f).render(4800);
    for (std::size_t i = 0; i < forward.size(); ++i) ASSERT_NEAR(backward[i], -forward[i], 1e-5f) << i;
}

// A jump that's approached from either side still needs softening: backwards, these jumps go the other way.
TEST(OscMod, BandLimitingWorksBackwardsToo) {
    constexpr double kAlias = 48000.0 - 11.0 * 4186.0;
    for (const auto& [limited_mode, naive_mode] :
         {std::pair(OscModMode::Saw, OscModMode::NaiveSaw), std::pair(OscModMode::Pulse, OscModMode::NaivePulse)}) {
        const auto limited = Modulated<>(limited_mode, -4186.0f, 0.5f).render(32768);
        const auto naive = Modulated<>(naive_mode, -4186.0f, 0.5f).render(32768);
        EXPECT_LT(level_db(limited, kAlias), level_db(naive, kAlias) - 12.0);
        EXPECT_NEAR(level_db(limited, 4186.0), level_db(naive, 4186.0), 1.0);
    }
}

TEST(OscMod, SyncRestartsTheWaveOnARisingEdge) {
    Modulated<> slave(OscModMode::NaiveSaw, 700.0f);
    slave.drive(2, [](u64 n) { return n % 480 == 0 ? 1.0f : -1.0f; });
    const auto audio = slave.render(2400);
    for (u64 i = 480; i + 480 < audio.size(); ++i) ASSERT_NEAR(audio[i + 480], audio[i], 1e-3f) << i;
}

TEST(OscMod, SyncIgnoresALevelThatStaysUp) {
    Modulated<> held(OscModMode::NaiveSaw, 700.0f);
    held.scalars[2] = 1.0f;
    EXPECT_EQ(held.render(4800), Modulated<>(OscModMode::NaiveSaw, 700.0f).render(4800));
}

// A sine sync at 997 Hz, which is no whole number of samples, so the restarts fall between samples and aliases land off
// the harmonics.
TEST(OscMod, SyncIsBandLimited) {
    constexpr double kMaster = 997.0, kSlave = 3203.0;
    const auto gaps = [&](const std::vector<float>& audio) {
        double power = 0.0;
        for (int k = 4; k < 19; ++k) power += std::pow(10.0, level_db(audio, kMaster * (k + 0.5)) / 10.0);
        return 10.0 * std::log10(power);
    };
    const auto synced = [&](OscModMode mode) {
        Modulated<> slave(mode, static_cast<float>(kSlave), 0.3f);
        slave.drive(2, [&](u64 n) { return static_cast<float>(sine(kMaster, n)); });
        return gaps(slave.render(1 << 16));
    };
    EXPECT_LT(synced(OscModMode::Saw), synced(OscModMode::NaiveSaw) - 6.0);
    EXPECT_LT(synced(OscModMode::Pulse), synced(OscModMode::NaivePulse) - 6.0);
}

// Neither has a naive form to compare with. What sync does to them is a jump, and that shows as one large step.
TEST(OscMod, SyncSoftensTheJumpOnASineAndATriangle) {
    for (const OscModMode mode : {OscModMode::Sine, OscModMode::Triangle}) {
        SCOPED_TRACE(static_cast<int>(mode));
        Modulated<> slave(mode, 997.0f);
        // Each restart catches the wave near its top, a jump of 1, a third of the way between two samples.
        slave.drive(2, [](u64 n) { return n % 12 == 0 ? 2.0f : -1.0f; });
        const auto audio = slave.render(4800);
        float largest = 0.0f;
        for (std::size_t i = 1; i < audio.size(); ++i) largest = std::max(largest, std::fabs(audio[i] - audio[i - 1]));
        EXPECT_LT(largest, 0.9f);
        EXPECT_GT(largest, 0.1f);
    }
}

TEST(OscMod, ANanFrequencyIsSilenceAndNotATone) {
    for (const float sample : Modulated<>(OscModMode::Sine, kNan).render(256)) ASSERT_EQ(sample, 0.0f);
}

TEST(OscMod, FeedbackBrightensASineWithoutBlowingUp) {
    const auto plain = Modulated<>(OscModMode::Sine, 997.0f).render(32768);
    const auto fed = Modulated<>(OscModMode::Sine, 997.0f, 0.2f).render(32768);
    EXPECT_LT(level_db(plain, 1994.0), -100.0);
    EXPECT_GT(level_db(fed, 1994.0), -30.0);
    for (const float sample : fed) ASSERT_LE(std::fabs(sample), 1.0001f);
}

// Format.md's arithmetic, step by step. Averaging the last two samples is what keeps strong feedback from hunting.
TEST(OscMod, FeedbackIsTheDocumentedSum) {
    constexpr float kFeedback = 0.8f;
    const auto audio = Modulated<>(OscModMode::Sine, 997.0f, kFeedback).render(4801);
    const auto step = static_cast<std::int32_t>(clamp(997.0f * (1.0f / kRate), -0.5f, 0.5f) * 4294967040.0f);
    float earlier = 0.0f, last = 0.0f;
    u32 phase = 0;
    for (std::size_t i = 1; i < audio.size(); ++i) {
        const u32 push = turns_to_phase(kFeedback * (earlier + last) * 0.5f);
        const float value = sin_turns(static_cast<float>(static_cast<std::int32_t>(phase + push)) * 2.32830644e-10f);
        ASSERT_EQ(audio[i], value) << i;
        earlier = last;
        last = value;
        phase += static_cast<u32>(step);
    }
}

TEST(OscMod, WidthMovesAtAudioRateAndTheLevelStaysPut) {
    Modulated<> pulse(OscModMode::Pulse, 997.0f);
    pulse.drive(3, [](u64 n) { return static_cast<float>(0.5 + 0.4 * sine(1231.0, n)); });
    const auto audio = pulse.render(48000);
    for (const float sample : audio) ASSERT_LE(std::fabs(sample), 2.5f);
    EXPECT_NEAR(mean(audio), 0.0f, 0.05f);
}

TEST(OscMod, StartsOnTheNoteAndNotTheFrame) {
    for (const OscModMode mode : kModes) {
        SCOPED_TRACE(static_cast<int>(mode));
        Modulated<> late(mode, 997.0f, 0.5f);
        late.context.gate.on = 10;
        const auto shifted = late.render(1000);
        const auto plain = Modulated<>(mode, 997.0f, 0.5f).render(990);
        for (u32 i = 0; i < 10; ++i) ASSERT_EQ(shifted[i], 0.0f) << i;
        for (u32 i = 0; i < 990; ++i) ASSERT_EQ(shifted[i + 10], plain[i]) << i;
    }
}

TEST(OscMod, AFrameBoundaryChangesNothing) {
    for (const OscModMode mode : kModes) {
        SCOPED_TRACE(static_cast<int>(mode));
        const auto input = [](u64 n) { return static_cast<float>(sine(731.0, n)); };
        Modulated<SynthConfig{.frame_size = 8}> small(mode, 997.0f, 0.5f);
        Modulated<SynthConfig{.frame_size = 128}> large(mode, 997.0f, 0.5f);
        small.drive(1, input).drive(2, input);
        large.drive(1, input).drive(2, input);
        EXPECT_EQ(small.render(2048), large.render(2048));
    }
}

TEST(OscMod, TheOutputMayShareABufferWithAnyInput) {
    for (u16 input = 0; input < 4; ++input) {
        SCOPED_TRACE(input);
        const auto source = [](u64 n) { return static_cast<float>(0.25 + 0.2 * sine(731.0, n)); };
        Modulated<> apart(OscModMode::Pulse, 997.0f, 0.5f);
        Modulated<> shared(OscModMode::Pulse, 997.0f, 0.5f);
        apart.drive(input, source);
        shared.drive(input, source);
        shared.step.out[0] = shared.step.in[input];
        std::vector<float> a, b;
        for (u32 frame = 0; frame < 16; ++frame) {
            const u32 n = 128;  // kMono's frame size has no bearing: each render is one frame's worth
            for (float s : apart.render(n)) a.push_back(s);
            for (u32 k = 0; k < n; k += kMono.frame_size) {
                for (u32 f = 0; f < kMono.frame_size; ++f) {
                    shared.buffers[(input + 1) * kMono.frame_size + f] = source(shared.clock + f);
                }
                Kernels<kMono, ScalarBackend>::run_step(shared.step, shared.context);
                shared.clock += kMono.frame_size;
                const float* out = shared.buffers.data() + (input + 1) * kMono.frame_size;
                b.insert(b.end(), out, out + kMono.frame_size);
            }
        }
        EXPECT_EQ(a, b);
    }
}

TEST(OscMod, StaysFiniteAndInRangeForAnyInput) {
    const float values[] = {0.0f, 1.0f, -1.0f, 24000.0f, 1e9f, -1e9f, kNan, kInfinity, -kInfinity};
    for (const OscModMode mode : kModes) {
        for (const float a : values) {
            for (const float b : values) {
                for (const float c : values) {
                    for (const float d : values) {
                        SCOPED_TRACE(testing::Message()
                                     << static_cast<int>(mode) << ": " << a << " " << b << " " << c << " " << d);
                        Modulated<> osc(mode, a, d);
                        osc.scalars[1] = b;
                        osc.scalars[2] = c;
                        for (const float sample : osc.render(64)) {
                            ASSERT_TRUE(std::isfinite(sample));
                            ASSERT_LE(std::fabs(sample), 6.0f);
                        }
                    }
                }
            }
        }
    }
}

TEST(OscMod, AnAudioInputOfAnyValueStaysFinite) {
    const float values[] = {0.0f, 1.0f, -1.0f, 1e9f, -1e9f, kNan, kInfinity, -kInfinity};
    const auto wild = [&](u64 n) { return values[(n * n + 3 * n) % 8]; };
    for (const OscModMode mode : kModes) {
        SCOPED_TRACE(static_cast<int>(mode));
        Modulated<> osc(mode, 440.0f);
        for (u16 input = 0; input < 4; ++input) osc.drive(input, wild);
        for (const float sample : osc.render(32768)) {
            ASSERT_TRUE(std::isfinite(sample));
            ASSERT_LE(std::fabs(sample), 6.0f);
        }
    }
}

TEST(Math, TurnsBecomePhases) {
    EXPECT_EQ(turns_to_phase(0.0f), 0u);
    EXPECT_EQ(turns_to_phase(0.25f), 0x40000000u);
    EXPECT_EQ(turns_to_phase(-0.25f), 0xC0000000u);
    EXPECT_EQ(turns_to_phase(3.25f), 0x40000000u);
    EXPECT_EQ(turns_to_phase(kInfinity), turns_to_phase(64.0f));
    EXPECT_EQ(turns_to_phase(kNan), turns_to_phase(-64.0f));
}

TEST(Math, FloorGoesDown) {
    EXPECT_EQ(floor_of(0.5f), 0.0f);
    EXPECT_EQ(floor_of(-0.5f), -1.0f);
    EXPECT_EQ(floor_of(-1.0f), -1.0f);
    EXPECT_EQ(floor_of(2.0f), 2.0f);
    EXPECT_EQ(floor_of(8388607.5f), 8388607.0f);
    EXPECT_EQ(floor_of(1e10f), 1e10f);
    EXPECT_EQ(floor_of(-1e10f), -1e10f);
    EXPECT_EQ(floor_of(kInfinity), kInfinity);
    EXPECT_TRUE(std::isnan(floor_of(kNan)));
}

namespace {

// One Math on three frames' worth of inputs, and the KMath that should agree with it.
struct MathRun {
    static constexpr u32 N = kMono.frame_size;
    using K = Kernels<kMono, ScalarBackend>;

    float operator()(MathMode mode, float a, float b, float c) {
        float scalars[3] = {a, b, c};
        std::vector<float> buffer(4 * N);
        float voice[1] = {};
        DecodedStep step{};
        RunContext context;
        context.buffers = buffer.data();
        context.banks[static_cast<u32>(Bank::Const)] = scalars;
        context.voice = voice;
        step.mode = static_cast<u8>(mode);
        for (u16 i = 0; i < 3; ++i) step.in[i] = {static_cast<u16>(Bank::Const), i};

        step.op = static_cast<u8>(Op::KMath);
        step.out[0] = {static_cast<u16>(Bank::Voice), 0};
        K::run_step(step, context);
        const float control = voice[0];

        step.op = static_cast<u8>(Op::Math);
        step.out[0] = {static_cast<u16>(Bank::Buffer), 0};
        K::run_step(step, context);
        const float scalar_in = buffer[N - 1];

        for (u16 i = 0; i < 3; ++i) {
            std::fill_n(buffer.begin() + (i + 1) * N, N, scalars[i]);
            step.in[i] = {static_cast<u16>(Bank::Buffer), static_cast<u16>(i + 1)};
        }
        K::run_step(step, context);
        const float audio_in = buffer[N - 1];

        EXPECT_EQ(std::bit_cast<u32>(control), std::bit_cast<u32>(scalar_in));
        EXPECT_EQ(std::bit_cast<u32>(control), std::bit_cast<u32>(audio_in));
        return control;
    }
};

}  // namespace

TEST(Math, EachModeDoesWhatItsNameSays) {
    MathRun math;
    EXPECT_EQ(math(MathMode::Min, 1.0f, 2.0f, 9.0f), 1.0f);
    EXPECT_EQ(math(MathMode::Max, 1.0f, 2.0f, 9.0f), 2.0f);
    EXPECT_EQ(math(MathMode::Abs, -3.0f, 9.0f, 9.0f), 3.0f);
    EXPECT_EQ(math(MathMode::Clip, 5.0f, -1.0f, 1.0f), 1.0f);
    EXPECT_EQ(math(MathMode::Clip, -5.0f, -1.0f, 1.0f), -1.0f);
    EXPECT_EQ(math(MathMode::Clip, 0.5f, -1.0f, 1.0f), 0.5f);
    EXPECT_EQ(math(MathMode::Floor, 1.5f, 9.0f, 9.0f), 1.0f);
    EXPECT_EQ(math(MathMode::Divide, 1.0f, 4.0f, 9.0f), 0.25f);
    EXPECT_EQ(math(MathMode::Compare, 2.0f, 1.0f, 9.0f), 1.0f);
    EXPECT_EQ(math(MathMode::Compare, 1.0f, 2.0f, 9.0f), 0.0f);
    EXPECT_EQ(math(MathMode::Compare, 1.0f, 1.0f, 9.0f), 0.0f);
    EXPECT_EQ(math(MathMode::Select, 1.0f, 2.0f, 3.0f), 2.0f);
    EXPECT_EQ(math(MathMode::Select, 0.0f, 2.0f, 3.0f), 3.0f);
}

TEST(Math, DividingByZeroGivesZero) {
    MathRun math;
    EXPECT_EQ(math(MathMode::Divide, 1.0f, 0.0f, 0.0f), 0.0f);
    EXPECT_EQ(math(MathMode::Divide, 1.0f, -0.0f, 0.0f), 0.0f);
}

TEST(Math, AnyInputGivesTheSameAnswerAtEitherRate) {
    MathRun math;
    const float values[] = {0.0f, -0.0f, 1.0f, -1.5f, 1e30f, kNan, kInfinity, -kInfinity};
    for (const MathMode mode : {MathMode::Min, MathMode::Max, MathMode::Abs, MathMode::Clip, MathMode::Floor,
                                MathMode::Divide, MathMode::Compare, MathMode::Select}) {
        for (const float a : values) {
            for (const float b : values) {
                for (const float c : values) (void)math(mode, a, b, c);  // Each run compares the rates
            }
        }
    }
}

namespace {

std::vector<float> shaped(const std::vector<float>& curve, const std::vector<float>& input) {
    constexpr u32 N = kMono.frame_size;
    using K = Kernels<kMono, ScalarBackend>;
    std::vector<float> buffer(2 * N);
    BoundResource resource{};
    resource.table = {curve.data(), static_cast<u32>(curve.size() - 1), 0};
    DecodedStep step{};
    step.op = static_cast<u8>(Op::Shape);
    step.in[0] = {static_cast<u16>(Bank::Buffer), 1};
    step.out[0] = {static_cast<u16>(Bank::Buffer), 0};
    RunContext context;
    context.buffers = buffer.data();
    context.resources = &resource;
    std::vector<float> out;
    for (std::size_t i = 0; i < input.size(); i += N) {
        std::fill_n(buffer.begin() + N, N, 0.0f);
        std::copy_n(input.begin() + static_cast<std::ptrdiff_t>(i), std::min<std::size_t>(N, input.size() - i),
                    buffer.begin() + N);
        K::run_step(step, context);
        out.insert(out.end(), buffer.begin(), buffer.begin() + N);
    }
    out.resize(input.size());
    return out;
}

}  // namespace

TEST(Shape, AStraightCurveChangesNothing) {
    const auto out = shaped({-1.0f, 0.0f, 1.0f}, {-1.0f, -0.25f, 0.0f, 0.75f, 1.0f});
    EXPECT_EQ(out, (std::vector<float>{-1.0f, -0.25f, 0.0f, 0.75f, 1.0f}));
}

TEST(Shape, ReadsBetweenItsPoints) {
    const auto out = shaped({0.0f, 1.0f, 0.0f, 0.5f, 2.0f}, {-1.0f, -0.75f, -0.625f, 0.0f, 0.75f});
    EXPECT_EQ(out, (std::vector<float>{0.0f, 0.5f, 0.75f, 0.0f, 1.25f}));
}

TEST(Shape, ReachesItsLastPointAndStopsThere) {
    const auto out = shaped({0.0f, 0.5f, 2.0f}, {1.0f, 3.0f, kInfinity});
    for (const float sample : out) EXPECT_EQ(sample, 2.0f);
}

TEST(Shape, StaysOnTheCurveForAnyInput) {
    const auto out = shaped({0.25f, 0.5f, 0.75f}, {-3.0f, kNan, -kInfinity});
    for (const float sample : out) EXPECT_EQ(sample, 0.25f);
}

namespace {

// One step on a delay line it owns, fed a signal a frame at a time. A write and a read share the line, as a delay
// node's two steps do.
template <SynthConfig C = kMono>
struct Line {
    Line(std::initializer_list<Op> ops, u8 mode, std::initializer_list<float> inputs, float seconds = 0.05f)
        : scalars(inputs), buffers(2 * C.frame_size) {
        const auto length = static_cast<u32>(seconds * kRate) + C.frame_size + 4;
        storage.resize(length);
        line = {storage.data(), length, 0, 0};
        context.lines = &line;
        context.buffers = buffers.data();
        context.banks[static_cast<u16>(Bank::Const)] = scalars.data();
        context.state = reinterpret_cast<std::byte*>(state);
        context.rate = kRate;
        context.inverse_rate = 1.0f / kRate;
        for (const Op op : ops) {
            DecodedStep s{};
            s.op = static_cast<u8>(op);
            s.mode = mode;
            const OpSignature sig = op_signature(op);
            if (sig.outs) s.out[0] = {static_cast<u16>(Bank::Buffer), 1};
            for (u16 i = 0; i < sig.ins; ++i) {
                s.in[i] = sig.in[i] == Arg::Buffer ? DecodedOperand{static_cast<u16>(Bank::Buffer), 0}
                                                   : DecodedOperand{static_cast<u16>(Bank::Const), i};
            }
            steps.push_back(s);
        }
    }

    std::vector<float> run(const std::vector<float>& in) {
        std::vector<float> out;
        for (std::size_t at = 0; at < in.size(); at += C.frame_size) {
            std::copy_n(in.begin() + static_cast<std::ptrdiff_t>(at), C.frame_size, buffers.begin());
            for (const DecodedStep& s : steps) Kernels<C, ScalarBackend>::run_step(s, context);
            out.insert(out.end(), buffers.begin() + C.frame_size, buffers.end());
        }
        return out;
    }

    std::vector<float> scalars;
    std::vector<float> buffers;
    std::vector<float> storage;  // twice what an i16 line needs, which is harmless
    DelayLine line{};
    u64 state[8] = {};
    std::vector<DecodedStep> steps;
    RunContext context{};
};

std::vector<float> wobble(u32 samples, float level) {
    std::vector<float> x(samples);
    for (u32 i = 0; i < samples; ++i) {
        x[i] = level * static_cast<float>(std::sin(0.031 * i) * 0.7 + std::sin(0.173 * i + 1.0) * 0.3);
    }
    return x;
}

float rounded(float x) { return static_cast<float>(round_to_int(x * 32768.0f)) / 32768.0f; }

}  // namespace

TEST(I16Lines, ADelayGivesBackWhatWentInRoundedToSixteenBits) {
    const auto in = wobble(4096, 0.9f);
    for (const u8 mode : {u8{0}, kReadBeforeWrite}) {
        Line<> f32({Op::DelayWrite, Op::DelayRead}, mode, {0.01f});
        Line<> i16({Op::DelayWriteI16, Op::DelayReadI16}, mode, {0.01f});
        if (mode == kReadBeforeWrite) {  // A feedback read comes before its write
            std::swap(f32.steps[0], f32.steps[1]);
            std::swap(i16.steps[0], i16.steps[1]);
        }
        const auto exact = f32.run(in), narrow = i16.run(in);
        ASSERT_EQ(exact.size(), narrow.size());
        u32 delayed = 0;
        for (std::size_t i = 0; i < exact.size(); ++i) {
            ASSERT_EQ(narrow[i], rounded(exact[i])) << "mode " << int(mode) << " at " << i;
            delayed += exact[i] != 0.0f;
        }
        EXPECT_GT(delayed, 3000u);
    }
}

TEST(I16Lines, HoldFullScaleRoundHalfAwayFromZeroAndSendANanToTheBottom) {
    const float lsb = 1.0f / 32768.0f;
    std::vector<float> in(kFrame * 4, 0.0f);
    const std::vector<std::pair<float, float>> cases = {
        {2.0f, 32767 * lsb},   {-2.0f, -1.0f},      {kNan, -1.0f},       {kInfinity, 32767 * lsb},
        {1.0f, 32767 * lsb},   {-1.0f, -1.0f},      {0.5f * lsb, lsb},   {-0.5f * lsb, -lsb},
        {1.5f * lsb, 2 * lsb}, {0.49f * lsb, 0.0f}, {-kInfinity, -1.0f}, {0.25f, 0.25f},
    };
    for (std::size_t i = 0; i < cases.size(); ++i) in[i] = cases[i].first;
    Line<> line({Op::DelayWriteI16, Op::DelayReadI16}, 0, {0.0f}, 0.01f);
    const auto out = line.run(in);
    for (std::size_t i = 0; i < cases.size(); ++i) EXPECT_EQ(out[i], cases[i].second) << i;
}

TEST(I16Lines, ACombAndAnAllpassStayNearTheirF32Forms) {
    const auto in = wobble(48000, 0.1f);  // A comb at this feedback gains up to 6.25 times, and stays below full scale
    const struct {
        Op exact, narrow;
        std::initializer_list<float> inputs;
    } kinds[] = {{Op::Comb, Op::CombI16, {0.0f, 0.0297f, 0.84f, 0.2f}},
                 {Op::Allpass, Op::AllpassI16, {0.0f, 0.0051f, 0.5f}}};
    for (const auto& k : kinds) {
        Line<> f32({k.exact}, 0, k.inputs), i16({k.narrow}, 0, k.inputs);
        const auto a = f32.run(in), b = i16.run(in);
        float peak = 0.0f, worst = 0.0f;
        for (std::size_t i = 0; i < a.size(); ++i) {
            peak = std::max(peak, std::fabs(a[i]));
            worst = std::max(worst, std::fabs(a[i] - b[i]));
        }
        EXPECT_GT(peak, 0.05f);
        EXPECT_LT(20.0f * std::log10(worst / peak), -75.0f) << static_cast<int>(k.exact);
    }
}

TEST(I16Lines, ACombDrivenPastFullScaleStaysFinite) {
    const auto in = wobble(48000, 4.0f);
    Line<> line({Op::CombI16}, 0, {0.0f, 0.0061f, 0.995f, 0.0f});
    for (const float s : line.run(in)) {
        ASSERT_TRUE(std::isfinite(s));
        ASSERT_LE(std::fabs(s), 1.0f);
    }
}
