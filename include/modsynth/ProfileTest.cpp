#include <filesystem>
#include <fstream>
#include <gtest/gtest.h>
#include <sstream>
#include <string>

#include <modsynth/Compiler.hpp>
#include <modsynth/Profile.hpp>
#include <modsynth/TestSupport.hpp>

using namespace modsynth;
using compiler::compile_image;
using compiler::CompileError;
using compiler::json;
using modsynth_test::LoadedImage;

namespace {

json read_json(const std::string& path) {
    std::ifstream in(path);
    std::stringstream text;
    text << in.rdbuf();
    return json::parse(text.str());
}

json nucleo() { return read_json(MODSYNTH_PROFILES "/Nucleo.json"); }
// The board's profile without its costs, for checking what a Program needs in memory whatever its frames cost.
json nucleo_memory() {
    json p = nucleo();
    p.erase("cost");
    return p;
}
json recipe(const std::string& name) { return read_json(MODSYNTH_RECIPES "/" + name + ".json"); }
json golden(const std::string& name) { return read_json(MODSYNTH_GOLDEN "/" + name + ".json"); }

json with_target(json request, const json& profile) {
    request["target"] = profile;
    return request;
}

std::string error_of(const json& request) {
    try {
        (void)compile_image(request);
    } catch (const CompileError& e) {
        EXPECT_EQ(e.where, "target");
        return e.what();
    }
    ADD_FAILURE() << "compiled";
    return {};
}

template <class Engine>
json profile_of(u64 fast, u64 bulk) {
    static constexpr auto text = [] { return write_profile<Engine>({"Host", "scalar", 48'000'000, 1, 1, 1, 1}); }();
    json p = json::parse(std::string(text.text.data(), text.size));
    p["memory"] = {{"fast", fast}, {"bulk", bulk}};
    p["image_bytes"] = 1u << 30;
    p["chunks"] = kMaxChunks;
    return p;
}

}  // namespace

// A profile written in a constant expression reads back as the layout it was written from.
TEST(Profile, RoundTrips) {
    using Mono = Synth<SynthConfig{.frame_size = 128, .channels = 1}>;
    for (const json& p : {profile_of<Synth<>>(0, 0), profile_of<Mono>(0, 0)}) {
        const compiler::detail::Target t = compiler::detail::read_target(p);
        const Layout own = p.at("channels") == 1 ? Mono::layout() : Synth<>::layout();
        EXPECT_EQ(t.layout, own);
        EXPECT_EQ(t.name, "Host");
        EXPECT_EQ(t.rate, 48000.0f);
        EXPECT_EQ(t.opcodes.size(), std::size(kProfileOps));
    }
}

// Sized through a profile of this host, every recipe needs what the engine itself asks for.
TEST(Profile, HostSizesMatchTheEngine) {
    const json profile = profile_of<Synth<>>(1ull << 40, 1ull << 40);
    u32 checked = 0;
    for (const auto& entry : std::filesystem::directory_iterator(MODSYNTH_RECIPES)) {
        if (entry.path().extension() != ".json" || entry.path().stem() == "Index") continue;
        const json request = read_json(entry.path().string());
        const auto result = compile_image(with_target(request, profile));
        const LoadedImage loaded(result.image);
        const MemorySizes need = Synth<>::bytes_required(loaded.table, loaded.loader.program_hash(0), 48000.0f);
        EXPECT_EQ(result.report.at("target").at("fast")[0], need.fast) << entry.path();
        EXPECT_EQ(result.report.at("target").at("bulk")[0], need.bulk) << entry.path();
        ++checked;
    }
    EXPECT_GT(checked, 50u);
}

// The NUCLEO-L476RG reported these for itself, from its own layout, when these images were sent to it.
TEST(Profile, NucleoSizesMatchTheBoard) {
    const auto steals = compile_image(with_target(golden("Steals"), nucleo_memory()));
    EXPECT_EQ(steals.report.at("target").at("fast"), json::array({7104, 32768}));
    EXPECT_EQ(steals.report.at("target").at("bulk"), json::array({0, 65536}));
    const auto pad = compile_image(with_target(recipe("PwmPad"), nucleo_memory()));
    EXPECT_EQ(pad.report.at("target").at("fast")[0], 1568);

    const std::string reverb = error_of(with_target(recipe("Reverb"), nucleo_memory()));
    EXPECT_NE(reverb.find("needs 187680 bytes of bulk memory, and this target has 65536"), std::string::npos) << reverb;
    const std::string delay = error_of(with_target(recipe("PingPongDelay"), nucleo_memory()));
    EXPECT_NE(delay.find("230640 bytes of bulk"), std::string::npos) << delay;
}

TEST(Profile, FrameSizeComesFromTheTarget) {
    json request = with_target(recipe("PwmPad"), nucleo());
    EXPECT_NO_THROW(compile_image(request));
    request["frame_size"] = 128;
    EXPECT_NE(error_of(request).find("plays frames of 32"), std::string::npos);
}

TEST(Profile, RefusesWhatTheTargetLacks) {
    json old = nucleo_memory();
    old["revision"] = 6;
    EXPECT_NE(error_of(with_target(golden("Steals"), old)).find("needs format revision 7"), std::string::npos);

    json no_biquad = nucleo_memory();
    no_biquad["opcodes"].erase(
        std::find(no_biquad["opcodes"].begin(), no_biquad["opcodes"].end(), static_cast<int>(Op::Biquad)));
    EXPECT_NE(error_of(with_target(recipe("ResonantSawBass"), no_biquad)).find("lacks"), std::string::npos);

    json small = nucleo_memory();
    small["image_bytes"] = 1000;
    EXPECT_NE(error_of(with_target(golden("Steals"), small)).find("stores up to 1000 bytes"), std::string::npos);

    json few = nucleo_memory();
    few["chunks"] = 2;
    EXPECT_NE(error_of(with_target(golden("Steals"), few)).find("chunks"), std::string::npos);

    json thin = with_target(recipe("PwmPad"), nucleo());
    thin["omit"] = json::array({"0000000000000001"});
    EXPECT_NE(error_of(thin).find("whole image"), std::string::npos);
}

// A board's costs read back as the table its firmware was built with.
TEST(Profile, CostsRoundTrip) {
    Costs k;
    k.budget = 51944;
    k.frame = 776;
    k.note_block = 67;
    k.step[static_cast<u32>(Op::Saw)] = 1282;
    k.still[static_cast<u32>(Op::Saw)] = 1000;
    k.first[static_cast<u32>(Op::Env)] = 1500;
    k.modes[0] = {static_cast<u8>(Op::Saw), kNaive, 511, 500};
    static constexpr auto text = [] {
        Costs c;
        c.budget = 51944;
        c.frame = 776;
        c.note_block = 67;
        c.step[static_cast<u32>(Op::Saw)] = 1282;
        c.still[static_cast<u32>(Op::Saw)] = 1000;
        c.first[static_cast<u32>(Op::Env)] = 1500;
        c.modes[0] = {static_cast<u8>(Op::Saw), kNaive, 511, 500};
        return write_profile<Synth<>>({"Host", "scalar", 48'000'000, 1, 1, 1, 1, &c});
    }();
    const json p = json::parse(std::string(text.text.data(), text.size));
    const compiler::detail::Target t = compiler::detail::read_target(p);
    ASSERT_TRUE(t.cost.has_value());
    EXPECT_EQ(*t.cost, k);
    EXPECT_EQ(t.cost->of(static_cast<u8>(Op::Saw), kNaive, false), 511u);
    EXPECT_EQ(t.cost->of(static_cast<u8>(Op::Saw), 0, true), 1000u);
}

// The profile the board's build writes keeps its costs, and its budget is a frame's cycles less playing it out.
TEST(Profile, NucleoHasABudget) {
    const json p = nucleo();
    ASSERT_TRUE(p.contains("cost"));
    const double frame = 80e6 * 32 / p.at("rate").get<double>();
    EXPECT_LT(p.at("cost").at("budget").get<double>(), frame);
    EXPECT_GT(p.at("cost").at("budget").get<double>(), 0.95 * frame);
    for (const char* key : {"budget", "frame", "step", "still", "first", "modes"}) {
        json missing = nucleo();
        missing["cost"].erase(key);
        EXPECT_NE(error_of(with_target(recipe("PwmPad"), missing)).find(key), std::string::npos) << key;
    }
}

TEST(Profile, RefusesAProfileThatIsNotWhole) {
    for (const char* key : {"name", "revision", "frame_size", "rate", "memory", "opcodes", "layout", "chunks"}) {
        json p = nucleo();
        p.erase(key);
        EXPECT_NE(error_of(with_target(recipe("PwmPad"), p)).find(key), std::string::npos) << key;
    }
    json p = nucleo();
    p["layout"].erase("voice");
    EXPECT_NE(error_of(with_target(recipe("PwmPad"), p)).find("voice"), std::string::npos);
    p = nucleo();
    p["layout"]["align"] = 6;
    EXPECT_NE(error_of(with_target(recipe("PwmPad"), p)).find("powers of two"), std::string::npos);
    p = nucleo();
    p["memory"]["fast"] = -1;
    EXPECT_NE(error_of(with_target(recipe("PwmPad"), p)).find("whole number"), std::string::npos);
}
