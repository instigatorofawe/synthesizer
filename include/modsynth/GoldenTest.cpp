// The format's contract, in executable form. docs/Format.md section 10 says what these files promise. They were written
// once, by golden/Make.sh, and CI refuses a pull request that edits one. If a test here fails, an old image no longer
// means what it did, so the fix is almost never to change this file.

#include <algorithm>
#include <cmath>
#include <fstream>
#include <gtest/gtest.h>
#include <iterator>
#include <string>

#include <modsynth/TestSupport.hpp>

using namespace modsynth_test;
using compiler::compile_image;

namespace {

template <u32 Frame>
constexpr SynthConfig kGoldenStereo{.frame_size = Frame, .channels = 2, .tap_slots = 0, .generations = 1};
template <u32 Frame>
constexpr SynthConfig kGoldenMono{.frame_size = Frame, .channels = 1, .tap_slots = 0, .generations = 1};

struct Golden {
    const char* name;
    u32 frames;
    u64 compiled;  // What the compiler writes today, from the json beside the image
    u32 frame_size = kOriginalFrameSize;
};

// A change here means a project compiles to different chunks than it used to. Old images still play, but a thin image
// from a new compiler no longer matches chunks a device got from an old one. That can be fine, and it must be a
// decision. Revision 1 made one: saw, square and triangle left their tables for opcodes that fix their aliasing, which
// moved Demo and AllOps. Refusing audio at inputs read once a frame made another. It moved them again, because a snap
// node has its own place among the steps. They render as they did. Revision 5 made a third: a shared LFO became KLfo2,
// which moved every project that has one, and those now need revision 5.
constexpr Golden kGoldens[] = {
    {"Minimal", 8, 0x1b3153f13f3ea109ull},         {"Demo", 480, 0xbc90aab7da78bf30ull},
    {"AllOps", 400, 0xebbd17e22a3a5a90ull},        {"Waves", 200, 0xe37a8aae4c59c4e1ull},
    {"Tones", 200, 0x4c4f7b21767ecfeaull},         {"Demo32", 1920, 0x0cd1b564c1f05560ull, 32},
    {"AllOps32", 1600, 0x3d10ba76abc6ad78ull, 32}, {"Waves32", 800, 0xe6016cf15bab3260ull, 32},
    {"Tones32", 800, 0x76ac201dd55fe56bull, 32},   {"Lanes", 1920, 0x60d243046489eb9eull, 32},
    {"Zones", 1920, 0xed2b4ca7c30b9bb3ull, 32},    {"Hold", 1920, 0xfb0025e9e989fe1full, 32},
    {"Mods", 1920, 0x46f84404be93fbffull, 32},     {"Steals", 1920, 0x6b2f7262a90e47fcull, 32},
};

std::vector<std::byte> read_file(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    EXPECT_TRUE(in.good()) << path;
    const std::vector<char> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    const auto* first = reinterpret_cast<const std::byte*>(bytes.data());
    return {first, first + bytes.size()};
}

std::vector<float> read_audio(const std::string& path) {
    const auto bytes = read_file(path);
    std::vector<float> samples(bytes.size() / sizeof(float));
    std::memcpy(samples.data(), bytes.data(), samples.size() * sizeof(float));
    return samples;
}

std::string golden_path(const std::string& name) { return std::string(MODSYNTH_GOLDEN "/") + name; }

// The worst difference, in dB below the reference's peak.
double difference_db(const std::vector<float>& reference, const std::vector<float>& candidate) {
    EXPECT_EQ(reference.size(), candidate.size());
    float peak = 0.0f, worst = 0.0f;
    for (std::size_t i = 0; i < reference.size() && i < candidate.size(); ++i) {
        peak = std::max(peak, std::fabs(reference[i]));
        worst = std::max(worst, std::fabs(reference[i] - candidate[i]));
    }
    EXPECT_GT(peak, 0.0f) << "a silent golden render proves nothing";
    return worst == 0.0f ? -300.0 : 20.0 * std::log10(static_cast<double>(worst / peak));
}

// `waited` is how many frames the engine renders before Play.
template <SynthConfig C>
std::vector<float> render(const std::vector<std::byte>& image, u32 frames, u32 waited = 0) {
    Rig<C> rig(image);
    EXPECT_EQ(rig.engine.load_error(), LoadError::None);
    std::vector<float> out(frames * C.frame_size * C.channels);
    std::array<float*, C.channels> outputs;
    for (u32 ch = 0; ch < C.channels; ++ch) outputs[ch] = out.data() + ch * C.frame_size;
    for (u32 f = 0; f < waited; ++f) rig.engine.render(outputs);
    EXPECT_TRUE(rig.engine.send({.kind = EventKind::Play}));
    for (u32 f = 0; f < frames; ++f) {
        for (u32 ch = 0; ch < C.channels; ++ch) outputs[ch] = out.data() + (f * C.channels + ch) * C.frame_size;
        rig.engine.render(outputs);
    }
    EXPECT_EQ(rig.engine.guard_trips(), 0u);
    return out;
}

}  // namespace

TEST(Golden, EveryImageSoundsAsItDidAtTheFreeze) {
    for (const Golden& g : kGoldens) {
        SCOPED_TRACE(g.name);
        const std::string base = golden_path(g.name);
        const auto image = read_file(base + ".image");
        const bool original = g.frame_size == kOriginalFrameSize;
        const auto stereo =
            original ? render<kGoldenStereo<128>>(image, g.frames) : render<kGoldenStereo<32>>(image, g.frames);
        const auto mono =
            original ? render<kGoldenMono<128>>(image, g.frames) : render<kGoldenMono<32>>(image, g.frames);
        EXPECT_LE(difference_db(read_audio(base + ".stereo.f32"), stereo), -100.0);
        EXPECT_LE(difference_db(read_audio(base + ".mono.f32"), mono), -100.0);
    }
}

TEST(Golden, AKLfo2SoundsTheSameHoweverLongTheEngineWaitedForPlay) {
    const auto image = read_file(golden_path("Hold.image"));
    const auto prompt = render<kGoldenStereo<32>>(image, 1920);
    for (const u32 waited : {1u, 37u, 1001u})
        EXPECT_TRUE(render<kGoldenStereo<32>>(image, 1920, waited) == prompt) << waited;
}

// Revision 5 didn't change what an older image means, and in one a shared KLfo runs from load.
TEST(Golden, AnOlderImageKeepsItsFreeRunningKLfo) {
    const auto image = read_file(golden_path("Tones32.image"));
    EXPECT_FALSE(render<kGoldenStereo<32>>(image, 800, 37) == render<kGoldenStereo<32>>(image, 800));
}

// Demo and AllOps predate the rule that audio cannot reach an input read once a frame, and golden JSON never changes,
// so the snap nodes they would need now go in here. On a wire that is already frame-rate, a snap does nothing.
void add_snaps(json& request) {
    if (!request.contains("patches")) return;
    json& patches = request["patches"];
    for (auto& [id, patch] : patches.items()) {
        json& graph = patch["graph"];
        int next = 0;
        for (const json& node : graph["nodes"]) next = std::max(next, node.at("id").get<int>());
        json added = json::array();
        for (json& edge : graph["edges"]) {
            if (edge.at("input") != "cutoff") continue;
            ++next;
            graph["nodes"].push_back({{"id", next}, {"type", "snap"}});
            json into = edge;
            into["to"] = next;
            into["input"] = "in";
            added.push_back(into);
            edge = json{{"from", next}, {"to", edge.at("to")}, {"input", "cutoff"}};
        }
        for (json& edge : added) graph["edges"].push_back(edge);
    }
}

TEST(Golden, TheCompilerStillWritesTheseBytes) {
    for (const Golden& g : kGoldens) {
        SCOPED_TRACE(g.name);
        const auto bytes = read_file(golden_path(std::string(g.name) + ".json"));
        json request = json::parse(reinterpret_cast<const char*>(bytes.data()),
                                   reinterpret_cast<const char*>(bytes.data()) + bytes.size());
        if (g.frame_size == kOriginalFrameSize) {
            add_snaps(request);
            request["frame_size"] = kOriginalFrameSize;  // The default moved, and frozen JSON can't say so itself
        }
        const auto image = compile_image(request).image;
        EXPECT_EQ(hash_bytes(kHashSeed, image.data(), image.size()), g.compiled);
    }
}

// A new opcode with no golden image fails here, so nothing can reach main without a pinned meaning. It goes through
// enums rather than a list, so it cannot fall out of step with the registry.
TEST(Golden, BetweenThemTheImagesUseEverything) {
    std::vector<bool> ops(static_cast<u32>(Op::kCount)), instructions(static_cast<u32>(Instr::kCount)), mix(8);
    std::vector<bool> biquad(3), delay_read(2), saw(2), pulse(2), sample2(4), osc_mod(6), math(8), kmath(8), sample3(8);
    std::vector<bool> plays(4);
    bool i16 = false, f32 = false, mono = false, stereo = false, looped = false, one_shot = false;

    for (const Golden& g : kGoldens) {
        const LoadedImage loaded(read_file(golden_path(std::string(g.name) + ".image")));
        ASSERT_EQ(loaded.loader.status(), LoadStatus::Ready);
        for (u32 i = 0; i < loaded.table.size(); ++i) {
            const ChunkRef& c = loaded.storage[i];
            if (c.kind == static_cast<u8>(ChunkKind::Patch)) {
                PatchView v;
                ASSERT_TRUE(parse_patch({c.data, c.size}, v));
                for (u32 s = 0; s < static_cast<u32>(v.h.control_steps) + v.h.voice_steps; ++s) {
                    const WireStep step = v.step(s);
                    ops[step.op] = true;
                    if (step.op == static_cast<u8>(Op::Biquad)) biquad[step.mode] = true;
                    if (step.op == static_cast<u8>(Op::DelayRead)) delay_read[step.mode] = true;
                    if (step.op == static_cast<u8>(Op::Saw)) saw[step.mode] = true;
                    if (step.op == static_cast<u8>(Op::Pulse)) pulse[step.mode] = true;
                    if (step.op == static_cast<u8>(Op::Sample2)) sample2[step.mode] = true;
                    if (step.op == static_cast<u8>(Op::Sample3)) sample3[step.mode] = true;
                    if (step.op == static_cast<u8>(Op::OscMod)) osc_mod[step.mode] = true;
                    if (step.op == static_cast<u8>(Op::Math)) math[step.mode] = true;
                    if (step.op == static_cast<u8>(Op::KMath)) kmath[step.mode] = true;
                }
            } else if (c.kind == static_cast<u8>(ChunkKind::Program)) {
                ProgramView v;
                ASSERT_TRUE(parse_program({c.data, c.size}, v));
                for (u32 k = 0; k < v.h.code; ++k) {
                    const Instruction in = v.instruction(k);
                    instructions[in.op] = true;
                    if (in.op == static_cast<u8>(Instr::PlayMode)) plays[in.a] = true;
                }
                for (u32 k = 0; k < v.h.mix_steps; ++k) mix[v.mix_step(k).op] = true;
            } else if (c.kind == static_cast<u8>(ChunkKind::Asset)) {
                AssetHeader h;
                ASSERT_TRUE(asset_shape_ok({c.data, c.size}, h));
                (h.encoding == static_cast<u8>(AssetEncoding::I16) ? i16 : f32) = true;
                (h.channels == 1 ? mono : stereo) = true;
                (h.loop_end != 0 ? looped : one_shot) = true;
            }
        }
    }

    for (u32 i = 1; i < ops.size(); ++i) EXPECT_TRUE(ops[i]) << "no golden image uses opcode " << i;
    for (u32 i = 0; i < instructions.size(); ++i)
        EXPECT_TRUE(instructions[i]) << "no golden image uses instruction " << i;
    EXPECT_TRUE(mix[static_cast<u32>(MixOp::RunVoices)] && mix[static_cast<u32>(MixOp::RunInsert)] &&
                mix[static_cast<u32>(MixOp::Gather)]);
    for (u32 i = 0; i < biquad.size(); ++i) EXPECT_TRUE(biquad[i]) << "biquad mode " << i;
    for (u32 i = 0; i < delay_read.size(); ++i) EXPECT_TRUE(delay_read[i]) << "delay read mode " << i;
    for (u32 i = 0; i < saw.size(); ++i) EXPECT_TRUE(saw[i]) << "saw mode " << i;
    for (u32 i = 0; i < pulse.size(); ++i) EXPECT_TRUE(pulse[i]) << "pulse mode " << i;
    for (u32 i = 0; i < sample2.size(); ++i) EXPECT_TRUE(sample2[i]) << "sample2 mode " << i;
    for (u32 i = 0; i < osc_mod.size(); ++i) EXPECT_TRUE(osc_mod[i]) << "osc mod mode " << i;
    for (u32 i = 0; i < math.size(); ++i) EXPECT_TRUE(math[i]) << "math mode " << i;
    for (u32 i = 0; i < kmath.size(); ++i) EXPECT_TRUE(kmath[i]) << "kmath mode " << i;
    // A release sample plays once through, so it has no tail, and the compiler writes neither 6 nor 7.
    for (const u32 i : {0u, 1u, 2u, 3u, 4u, 5u}) EXPECT_TRUE(sample3[i]) << "sample3 mode " << i;
    for (u32 i = 1; i < plays.size(); ++i) EXPECT_TRUE(plays[i]) << "play kind " << i;
    EXPECT_TRUE(i16 && f32 && mono && stereo && looped && one_shot);
}

// An image from before a revision must go on declaring the old one, or it would stop loading on old engines.
TEST(Golden, EachImageDeclaresTheRevisionItNeeds) {
    const auto revision = [](const char* name) {
        const auto bytes = read_file(golden_path(name));
        return load<ManifestHeader>(bytes.data() + sizeof(ChunkHeader)).revision;
    };
    for (const char* name : {"Minimal.image", "Demo.image", "AllOps.image", "Demo.thin.image"}) {
        EXPECT_EQ(revision(name), 0u) << name;
    }
    EXPECT_EQ(revision("Waves.image"), 1u);
    EXPECT_EQ(revision("Tones.image"), 2u);
    for (const char* name : {"Demo32.image", "AllOps32.image", "Waves32.image", "Tones32.image"}) {
        EXPECT_EQ(revision(name), 3u) << name;
    }
    for (const char* name : {"Lanes.image", "Zones.image"}) EXPECT_EQ(revision(name), 4u) << name;
    EXPECT_EQ(revision("Hold.image"), 5u);
    EXPECT_EQ(revision("Mods.image"), 6u);
    EXPECT_EQ(revision("Steals.image"), 7u);
}

// A frozen image must never quietly change its sound by landing on an engine of another size.
TEST(Golden, AnEngineRefusesAnImageOfAnotherFrameSize) {
    for (const Golden& g : kGoldens) {
        SCOPED_TRACE(g.name);
        const auto image = read_file(golden_path(std::string(g.name) + ".image"));
        if (g.frame_size == kOriginalFrameSize) {
            EXPECT_EQ(Rig<kGoldenStereo<32>>(image).engine.load_error(), LoadError::WrongFrameSize);
            EXPECT_EQ(Rig<kGoldenMono<32>>(image).engine.load_error(), LoadError::WrongFrameSize);
        } else {
            EXPECT_EQ(Rig<kGoldenStereo<128>>(image).engine.load_error(), LoadError::WrongFrameSize);
            EXPECT_EQ(Rig<kGoldenMono<128>>(image).engine.load_error(), LoadError::WrongFrameSize);
        }
    }
}

TEST(Golden, AThinImageFromTheFreezePlaysOnChunksFromTheFreeze) {
    const auto full = read_file(golden_path("Demo.image"));
    const auto thin = read_file(golden_path("Demo.thin.image"));
    EXPECT_LT(thin.size(), full.size() / 2);

    LoadedImage receiver(full);
    ASSERT_EQ(receiver.loader.status(), LoadStatus::Ready);
    const u32 before = receiver.table.size();
    std::vector<u64> words((thin.size() + 7) / 8);
    std::memcpy(words.data(), thin.data(), thin.size());
    Loader loader(receiver.table);
    loader.begin({reinterpret_cast<const std::byte*>(words.data()), thin.size()});
    while (loader.step(1u << 20) == LoadStatus::Working) {
    }
    EXPECT_EQ(loader.status(), LoadStatus::Ready) << to_string(loader.error());
    EXPECT_EQ(receiver.table.size(), before) << "it must carry nothing the receiver lacks";
}

// Demo and AllOps have nothing in common but parameter ids, so Demo's values reach AllOps' patches. They arrive as
// values AllOps could have been set to, not as Demo's: a value in hertz once reached a gain, at +67 dB with no guard
// tripped.
TEST(Golden, ASwapBetweenUnrelatedImagesStaysAtTheirLevel) {
    const auto peak = [](const std::vector<float>& audio) {
        float p = 0;
        for (const float s : audio) p = std::max(p, std::fabs(s));
        return p;
    };
    const auto demo32 = read_file(golden_path("Demo32.image"));
    const auto all_ops = read_file(golden_path("AllOps32.image"));
    for (const u32 at : {20u, 150u, 300u}) {
        Rig<kStereo> rig(demo32);
        rig.engine.send({.kind = EventKind::Play});
        (void)render_stereo(rig, at);
        rig.swap_to(all_ops);
        const auto heard = render_stereo(rig, 400);
        ASSERT_EQ(rig.engine.load_error(), LoadError::None);
        ASSERT_EQ(rig.engine.generation(), 2u);
        EXPECT_LT(peak(heard), 2.0f) << "swapped at block " << at;
    }
}
