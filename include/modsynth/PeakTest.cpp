#include <cmath>
#include <cstring>
#include <fstream>
#include <gtest/gtest.h>
#include <sstream>
#include <string>
#include <vector>

#include <modsynth/Compiler.hpp>
#include <modsynth/Peak.hpp>
#include <modsynth/TestSupport.hpp>

using namespace modsynth;
using compiler::compile_image;
using compiler::json;

namespace {

json read_json(const std::string& path) {
    std::ifstream in(path);
    std::stringstream text;
    text << in.rdbuf();
    return json::parse(text.str());
}

// A sine at `level` on the left, and `right` times it on the right, for one note half a second in.
json tone(double level, double right = 1.0) {
    json request = json::parse(R"({
      "patches": {"p": {"name": "p", "graph": {"nodes": [
        {"id": 1, "type": "note"}, {"id": 2, "type": "mtof"}, {"id": 3, "type": "osc", "wave": "sine"},
        {"id": 4, "type": "env", "inputs": {"attack": 0.001, "decay": 0.1, "sustain": 1, "release": 0.05}},
        {"id": 5, "type": "mul"}, {"id": 6, "type": "mul"}, {"id": 7, "type": "mul"}, {"id": 8, "type": "out"}],
        "edges": [{"from": 1, "port": "pitch", "to": 2, "input": "in"}, {"from": 2, "to": 3, "input": "freq"},
                  {"from": 3, "to": 5, "input": "a"}, {"from": 4, "to": 5, "input": "b"}, {"from": 5, "to": 6, "input": "a"},
                  {"from": 6, "to": 8, "input": "l"}, {"from": 6, "to": 7, "input": "a"}, {"from": 7, "to": 8, "input": "r"}]}}},
      "programs": [{"id": "p", "name": "loud", "timeline": {"ppq": 480, "tempo": [{"tick": 0, "bpm": 120}],
        "clips": [{"id": "c", "length": 960, "notes": [{"tick": 480, "note": 69, "vel": 127, "dur": 240}]}],
        "tracks": [{"id": 1, "voices": 1, "slots": ["p"], "placements": [{"clip": "c", "tick": 0}]}]}}]})");
    for (json& n : request["patches"]["p"]["graph"]["nodes"]) {
        if (n.at("id") == 6) n["inputs"] = {{"b", level}};
        if (n.at("id") == 7) n["inputs"] = {{"b", right}};
    }
    return request;
}

Peak peak_of_request(const json& request, float rate, u32 channels) {
    const auto image = compile_image(request).image;
    std::vector<u64> words((image.size() + 7) / 8);
    std::memcpy(words.data(), image.data(), image.size());
    return peak_of({reinterpret_cast<const std::byte*>(words.data()), image.size()}, 0, rate, 32, channels);
}

}  // namespace

// A track's pan is equal-power, so in the middle each side gets this of it.
constexpr float kCentre = 0.70710678f;

TEST(Peak, FindsTheLoudestSampleAndWhenItIs) {
    const Peak peak = peak_of_request(tone(0.8), 48000.0f, 2);
    ASSERT_TRUE(peak.ok);
    EXPECT_NEAR(peak.level, 0.8f * kCentre, 0.01f);
    EXPECT_GT(peak.seconds, 0.5);  // The note starts half a second in
    EXPECT_LT(peak.seconds, 0.51);
}

TEST(Peak, PlaysTheProgramAsAnEngineWithThoseChannelsWould) {
    // Something on the left and silence on the right: a mono engine folds them to half.
    const Peak stereo = peak_of_request(tone(1.6, 0.0), 48000.0f, 2);
    const Peak mono = peak_of_request(tone(1.6, 0.0), 48000.0f, 1);
    EXPECT_NEAR(stereo.level, 1.6f * kCentre, 0.02f);
    EXPECT_NEAR(mono.level, 0.8f * kCentre, 0.01f);
}

TEST(Peak, AnEngineNobodyBuiltIsNotOk) {
    const auto image = compile_image(tone(0.5)).image;
    std::vector<u64> words((image.size() + 7) / 8);
    std::memcpy(words.data(), image.data(), image.size());
    const ByteSpan span{reinterpret_cast<const std::byte*>(words.data()), image.size()};
    EXPECT_FALSE(peak_of(span, 0, 48000.0f, 32, 3).ok);
    EXPECT_FALSE(peak_of(span, 0, 48000.0f, 48, 1).ok);
    EXPECT_FALSE(peak_of(span, 0, 48000.0f, 128, 1).ok) << "an image for frames of 32 doesn't load at 128";
    EXPECT_FALSE(peak_of(span, 1, 48000.0f, 32, 1).ok) << "there is no Program 1";
}

// A device has no limiter, so its compile refuses what would play past full scale there, and says where and by how
// much.
TEST(Peak, ATargetRefusesWhatItWouldPlayPastFullScale) {
    const json profile = read_json(MODSYNTH_PROFILES "/Nucleo.json");
    json loud = tone(2.0);  // 1.414 at the board
    loud["target"] = profile;
    std::string why;
    try {
        (void)compile_image(loud);
    } catch (const compiler::CompileError& e) {
        EXPECT_EQ(e.where, "target");
        why = e.what();
    }
    EXPECT_NE(why.find("Program \"loud\" reaches 1.41"), std::string::npos) << why;
    EXPECT_NE(why.find(" s, 3.0 dB over full scale"), std::string::npos) << why;

    json quieter = tone(1.2);
    quieter["target"] = profile;
    const json target = compile_image(quieter).report.at("target");
    EXPECT_NEAR(target.at("programs")[0].at("peak").get<double>(), 1.2 * kCentre, 0.01);

    // The board is mono, so what plays on one side only, which a stereo engine would play past full scale, reaches it
    // at half.
    json one_side = tone(2.4, 0.0);
    one_side["target"] = profile;
    EXPECT_NEAR(compile_image(one_side).report.at("target").at("programs")[0].at("peak").get<double>(), 1.2 * kCentre,
                0.01);
}
