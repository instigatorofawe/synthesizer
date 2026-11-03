#include <cmath>
#include <gtest/gtest.h>
#include <limits>
#include <vector>

#include <modsynth/Limiter.hpp>

using modsynth::Limiter;

namespace {

constexpr float kRate = 48000.0f;

std::vector<float> sine(std::size_t samples, float level, float hz = 440.0f) {
    std::vector<float> x(samples);
    for (std::size_t i = 0; i < samples; ++i) {
        x[i] = level * static_cast<float>(std::sin(2.0 * 3.14159265358979 * hz * static_cast<double>(i) / kRate));
    }
    return x;
}

}  // namespace

TEST(Limiter, PassesWhatIsBelowFullScaleBitForBit) {
    auto left = sine(48000, 0.99f), right = sine(48000, -0.7f, 330.0f);
    const auto l = left, r = right;
    Limiter limiter(kRate);
    limiter.process(left.data(), right.data(), left.size());
    EXPECT_EQ(left, l);
    EXPECT_EQ(right, r);
    EXPECT_EQ(limiter.take_lowest(), 1.0f);
}

TEST(Limiter, NothingItPassesIsAboveFullScale) {
    for (const float level : {1.0001f, 1.5f, 10.0f, 1e6f, std::numeric_limits<float>::max()}) {
        auto left = sine(24000, level), right = sine(24000, level * 0.5f, 97.0f);
        Limiter limiter(kRate);
        limiter.process(left.data(), right.data(), left.size());
        for (std::size_t i = 0; i < left.size(); ++i) {
            ASSERT_LE(std::fabs(left[i]), 1.0f) << level << " at " << i;
            ASSERT_LE(std::fabs(right[i]), 1.0f) << level << " at " << i;
        }
        EXPECT_LT(limiter.take_lowest(), 1.0f);
        EXPECT_EQ(limiter.take_lowest(), 1.0f) << "taking it starts again";
    }
}

TEST(Limiter, MovesBothChannelsTogether) {
    std::vector<float> left = {2.0f, 0.5f}, right = {0.5f, 2.0f};
    Limiter limiter(kRate);
    limiter.process(left.data(), right.data(), 2);
    EXPECT_FLOAT_EQ(left[0], 1.0f);
    EXPECT_FLOAT_EQ(right[0], 0.25f);
    EXPECT_FLOAT_EQ(right[1], 1.0f);
    EXPECT_FLOAT_EQ(left[1], 0.25f);
}

TEST(Limiter, ComesBackUpOverItsRelease) {
    Limiter limiter(kRate, 0.1f);
    std::vector<float> burst = {4.0f};
    limiter.process(burst.data(), nullptr, 1);
    EXPECT_FLOAT_EQ(burst[0], 1.0f);
    // A quiet signal afterwards is turned down at first, and after a time constant is 1 - 0.75 / e of itself.
    auto quiet = std::vector<float>(4800, 0.1f);
    limiter.process(quiet.data(), nullptr, quiet.size());
    EXPECT_NEAR(quiet.front(), 0.025f, 1e-4f);
    EXPECT_NEAR(quiet.back(), 0.1f * (1.0f - 0.75f / std::exp(1.0f)), 1e-4f);
    auto later = std::vector<float>(48000 * 2, 0.1f);
    limiter.process(later.data(), nullptr, later.size());
    EXPECT_EQ(later.back(), 0.1f) << "and in the end exactly 1";
}

TEST(Limiter, SilencesWhatIsntFinite) {
    std::vector<float> left = {std::numeric_limits<float>::quiet_NaN(), std::numeric_limits<float>::infinity(), 0.5f};
    std::vector<float> right = {0.5f, 0.5f, 0.5f};
    Limiter limiter(kRate);
    limiter.process(left.data(), right.data(), 3);
    EXPECT_EQ(left[0], 0.0f);
    EXPECT_EQ(right[0], 0.0f);
    EXPECT_EQ(left[1], 0.0f);
    EXPECT_EQ(left[2], 0.5f);
}
