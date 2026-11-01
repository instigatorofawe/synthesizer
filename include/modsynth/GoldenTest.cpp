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

constexpr SynthConfig kGoldenStereo{.frame_size = 128, .channels = 2, .tap_slots = 0, .generations = 1};

struct Golden {
    const char* name;
    u32 frames;
    u64 compiled;  // What the compiler writes today, from the json beside the image
};

// A change here means a project compiles to different chunks than it used to. Old images still play, but a thin image
// from a new compiler no longer matches chunks a device got from an old one. That can be fine, and it must be a
// decision. Revision 1 made one: saw, square and triangle left their tables for opcodes that fix their aliasing, which
// moved Demo and AllOps. Refusing audio at inputs read once a frame made another. It moved them again, because a snap
// node has its own place among the steps. They render as they did.
constexpr Golden kGoldens[] = {
    {"Minimal", 8, 0x1b3153f13f3ea109ull},
    {"Demo", 480, 0xbc90aab7da78bf30ull},
    {"AllOps", 400, 0xed4a0c10d266d7aeull},
    {"Waves", 200, 0xf4c0e84598e9134eull},
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

template <SynthConfig C>
std::vector<float> render(const std::vector<std::byte>& image, u32 frames) {
    Rig<C> rig(image);
    EXPECT_EQ(rig.engine.load_error(), LoadError::None);
    EXPECT_TRUE(rig.engine.send({.kind = EventKind::Play}));
    std::vector<float> out(frames * C.frame_size * C.channels);
    std::array<float*, C.channels> outputs;
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
        EXPECT_LE(difference_db(read_audio(base + ".stereo.f32"), render<kGoldenStereo>(image, g.frames)), -100.0);
        EXPECT_LE(difference_db(read_audio(base + ".mono.f32"), render<kMono>(image, g.frames)), -100.0);
    }
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
        add_snaps(request);
        const auto image = compile_image(request).image;
        EXPECT_EQ(hash_bytes(kHashSeed, image.data(), image.size()), g.compiled);
    }
}

// A new opcode with no golden image fails here, so nothing can reach main without a pinned meaning. It goes through
// enums rather than a list, so it cannot fall out of step with the registry.
TEST(Golden, BetweenThemTheImagesUseEverything) {
    std::vector<bool> ops(static_cast<u32>(Op::kCount)), instructions(static_cast<u32>(Instr::kCount)), mix(8);
    std::vector<bool> biquad(3), delay_read(2), saw(2), pulse(2);
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
                }
            } else if (c.kind == static_cast<u8>(ChunkKind::Program)) {
                ProgramView v;
                ASSERT_TRUE(parse_program({c.data, c.size}, v));
                for (u32 k = 0; k < v.h.code; ++k) instructions[v.instruction(k).op] = true;
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
