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
        const auto out = Oscillator<>(s.op, s.mode, 100.0f).render(1);
        EXPECT_EQ(out[0], 0.0f);
    }
    EXPECT_EQ(Oscillator<>(Op::Pulse, kNaive, 100.0f).render(1)[0], 1.0f);
}

TEST(Oscillators, NaiveSawAndTriangleAreTheDocumentedFormulas) {
    constexpr float kFrequency = 440.0f;
    const u32 inc = static_cast<u32>(kFrequency * (1.0f / kRate) * 4294967040.0f);
    const auto saw = Oscillator<>(Op::Saw, kNaive, kFrequency).render(4);
    const auto triangle = Oscillator<>(Op::Triangle, 0, kFrequency).render(4);
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
    const auto low = [](Op op, u8 mode) { return Oscillator<>(op, mode, 100.0f).render(64); };
    for (const Shape s : kShapes) {
        SCOPED_TRACE(static_cast<int>(s.op));
        const auto [lowest, highest] = extremes(low(s.op, s.mode));
        EXPECT_NEAR(lowest, -1.0f, 0.02f);
        EXPECT_NEAR(highest, 1.0f, 0.02f);
    }

    // A quarter of a turn after starting, a triangle is at its peak and a saw is halfway up.
    constexpr u32 kPeriod = 480;
    const auto triangle = Oscillator<>(Op::Triangle, 0, kRate / kPeriod).render(4);
    const auto saw = Oscillator<>(Op::Saw, kNaive, kRate / kPeriod).render(4);
    EXPECT_NEAR(triangle[kPeriod / 4], 1.0f, 0.01f);
    EXPECT_NEAR(triangle[3 * kPeriod / 4], -1.0f, 0.01f);
    EXPECT_NEAR(saw[kPeriod / 4], 0.5f, 0.01f);
}

// A frame boundary must be inaudible, which only holds if all the state lives in the state block.
TEST(Oscillators, AFrameBoundaryChangesNothing) {
    static constexpr SynthConfig kShortFrames{.frame_size = 32, .channels = 1, .tap_slots = 0, .generations = 1};
    for (const Shape s : kShapes) {
        SCOPED_TRACE(static_cast<int>(s.op));
        EXPECT_EQ(Oscillator<>(s.op, s.mode, 4186.0f, 0.3f).render(4),
                  Oscillator<kShortFrames>(s.op, s.mode, 4186.0f, 0.3f).render(16));
    }
}

TEST(Oscillators, StayFiniteAndInRangeForAnyInput) {
    for (const Shape s : kShapes) {
        for (const float frequency :
             {0.0f, -1.0f, 1.0f, 20.0f, 440.0f, 4186.0f, 20000.0f, 24000.0f, 1e9f, kNan, kInfinity, -kInfinity}) {
            for (const float width : {-1.0f, 0.0f, 1e-9f, 0.25f, 0.5f, 0.999f, 1.0f, 2.0f, kNan, kInfinity}) {
                SCOPED_TRACE(testing::Message()
                             << static_cast<int>(s.op) << " at " << frequency << ", width " << width);
                for (const float sample : Oscillator<>(s.op, s.mode, frequency, width).render(4)) {
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
        const auto out = Oscillator<>(s.op, s.mode, 0.0f).render(2);
        for (const float sample : out) EXPECT_EQ(sample, out[0]);
    }
}

TEST(Oscillators, PulseWidthSetsTheDutyCycleAndLeavesTheLevelAlone) {
    constexpr float kFrequency = 480.0f;  // 100 samples, so 12.8 periods a frame and 128 of them in 10 frames
    for (const float width : {0.1f, 0.25f, 0.5f, 0.75f, 0.9f}) {
        SCOPED_TRACE(width);
        const auto naive = Oscillator<>(Op::Pulse, kNaive, kFrequency, width).render(10);
        const auto high = std::count_if(naive.begin(), naive.end(), [](float s) { return s > 0.0f; });
        EXPECT_NEAR(static_cast<float>(high) / static_cast<float>(naive.size()), width, 0.015f);
        EXPECT_NEAR(mean(naive), 0.0f, 0.03f);
        EXPECT_NEAR(mean(Oscillator<>(Op::Pulse, 0, kFrequency, width).render(10)), 0.0f, 0.03f);
    }
}

TEST(Oscillators, AWidthOfZeroIsSilence) {
    for (const u8 mode : {u8{0}, kNaive}) {
        for (const float sample : Oscillator<>(Op::Pulse, mode, 4186.0f, 0.0f).render(4)) EXPECT_EQ(sample, 0.0f);
    }
}

// Harmonic 11 of 4186 Hz is at 46046 Hz, which folds down to 1954 Hz: below the note, and on no harmonic of it.
TEST(Oscillators, BandLimitingRemovesAliasesAndKeepsTheNote) {
    constexpr float kFrequency = 4186.0f;
    constexpr double kAlias = 48000.0 - 11.0 * 4186.0;
    for (const Op op : {Op::Saw, Op::Pulse}) {
        SCOPED_TRACE(static_cast<int>(op));
        const auto limited = Oscillator<>(op, 0, kFrequency).render(256);
        const auto naive = Oscillator<>(op, kNaive, kFrequency).render(256);
        EXPECT_LT(level_db(limited, kAlias), level_db(naive, kAlias) - 12.0);
        EXPECT_NEAR(level_db(limited, kFrequency), level_db(naive, kFrequency), 1.0);
    }
}

TEST(Oscillators, TheAliasIsWhereTheTestAboveLooksForIt) {
    constexpr double kAlias = 48000.0 - 11.0 * 4186.0;
    const auto naive = Oscillator<>(Op::Saw, kNaive, 4186.0f).render(256);
    const double fundamental = level_db(naive, 4186.0);
    EXPECT_NEAR(level_db(naive, kAlias) - fundamental, 20.0 * std::log10(1.0 / 11.0), 1.0);
    EXPECT_LT(level_db(naive, kAlias + 100.0) - fundamental, -60.0);
}
