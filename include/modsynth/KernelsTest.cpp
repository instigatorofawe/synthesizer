#include <cmath>
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
