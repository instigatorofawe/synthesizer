#include <algorithm>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <gtest/gtest.h>
#include <iterator>
#include <sstream>
#include <string>

#include <modsynth/Compiler.hpp>
#include <modsynth/TestSupport.hpp>

using namespace modsynth;
using compiler::compile_image;
using compiler::json;
using modsynth_test::LoadedImage;

namespace {

json read_json(const std::filesystem::path& path) {
    std::ifstream in(path);
    std::stringstream text;
    text << in.rdbuf();
    return json::parse(text.str());
}

// Every Program the repository ships, compiled: recipes, pieces and the demo from their requests, and the goldens as
// they were frozen.
std::vector<std::pair<std::string, std::vector<std::byte>>> images() {
    std::vector<std::pair<std::string, std::vector<std::byte>>> out;
    for (const char* folder : {MODSYNTH_RECIPES, MODSYNTH_PIECES}) {
        for (const auto& entry : std::filesystem::directory_iterator(folder)) {
            const auto& p = entry.path();
            if (p.extension() == ".json" && p.stem() != "Index")
                out.emplace_back(p.stem(), compile_image(read_json(p)).image);
        }
    }
    const auto demo = std::filesystem::path(MODSYNTH_RECIPES).parent_path() / "Demo.json";
    out.emplace_back("Demo", compile_image(read_json(demo)).image);
    for (const auto& entry : std::filesystem::directory_iterator(MODSYNTH_GOLDEN)) {
        if (entry.path().extension() != ".image") continue;
        std::ifstream in(entry.path(), std::ios::binary);
        std::vector<char> bytes((std::istreambuf_iterator<char>(in)), {});
        std::vector<std::byte> image(bytes.size());
        std::memcpy(image.data(), bytes.data(), bytes.size());
        out.emplace_back(entry.path().stem(), std::move(image));
    }
    std::sort(out.begin(), out.end());
    return out;
}

ProgramView program_of(const LoadedImage& image, u32 index = 0) {
    const ChunkRef* c = image.table.find(image.loader.program_hash(index), ChunkKind::Program);
    ProgramView p;
    EXPECT_TRUE(parse_program({c->data, c->size}, p));
    return p;
}

// A clip of one note on each tick, played `repeat` times, at 750 bpm, which is 4 ticks a frame at 48 kHz.
json every_tick(u32 repeat, u32 dur = 1) {
    return json::parse(R"({
      "patches": {"p": {"name": "p", "graph": {"nodes": [{"id": 1, "type": "note"}, {"id": 2, "type": "mtof"},
        {"id": 3, "type": "osc", "wave": "saw", "mode": "naive"}, {"id": 4, "type": "out"}],
        "edges": [{"from": 1, "port": "pitch", "to": 2, "input": "in"}, {"from": 2, "to": 3, "input": "freq"},
                  {"from": 3, "to": 4, "input": "l"}]}}},
      "programs": [{"id": "p", "timeline": {"ppq": 480, "tempo": [{"tick": 0, "bpm": 750}],
        "clips": [{"id": "c", "length": 1, "notes": [{"tick": 0, "note": 60, "vel": 100, "dur": )" +
                       std::to_string(dur) + R"(}]}],
        "tracks": [{"id": 1, "voices": 4, "slots": ["p"], "placements": [{"clip": "c", "tick": 0, "repeat": )" +
                       std::to_string(repeat) + R"(}]}],
        "master": {"gain": 0.1}}}]})");  // Saws in step reach 2.9, which a target would refuse as too loud
}

}  // namespace

// A frame at 750 bpm covers 4 ticks, so one starts on its first tick and reaches 4 more.
TEST(Cost, AFrameCoversTheTicksItCanReach) {
    const LoadedImage image(compile_image(every_tick(100)).image);
    EXPECT_EQ(detail::frame_ticks(program_of(image), 48000.0f, 32), 4u);
    EXPECT_EQ(detail::frame_ticks(program_of(image), 24000.0f, 32), 8u);
}

// A note on every tick runs a NoteOn, a Wait and the clip's end on each, and 5 ticks can fall in one frame.
TEST(Cost, ARepeatedClipCountsWhatOneFrameCanCatch) {
    for (const u32 repeat : {1u, 2u, 3u, 100u, 10000u}) {
        const LoadedImage image(compile_image(every_tick(repeat)).image);
        const ProgramView p = program_of(image);
        const TrackDesc d = p.track(0);
        const detail::Run run = detail::densest(p, d.stream_begin, d.stream_length, 4);
        EXPECT_EQ(run.notes, std::min(repeat, 5u)) << repeat;
        EXPECT_LE(run.instructions, 3 * std::min(repeat, 6u) + 2) << repeat;
        EXPECT_GE(run.instructions, 3 * std::min(repeat, 5u)) << repeat;
    }
}

// Twice the voices cost more, and a frame that can start more notes costs more.
TEST(Cost, MoreWorkCostsMore) {
    const json profile = read_json(MODSYNTH_PROFILES "/Nucleo.json");
    const auto cycles = [&](json request) {
        request["target"] = profile;
        return compile_image(request).report.at("target").at("cycles")[0].get<u64>();
    };
    json more = every_tick(100);
    more["programs"][0]["timeline"]["tracks"][0]["voices"] = 8;
    EXPECT_GT(cycles(more), cycles(every_tick(100)));
    EXPECT_GT(cycles(every_tick(100)), cycles(every_tick(1)));
}

// A board refuses what could overrun a frame, and says how many voices would fit.
TEST(Cost, ATargetRefusesWhatCouldOverrunAFrame) {
    const json profile = read_json(MODSYNTH_PROFILES "/Nucleo.json");
    json request = every_tick(100);
    request["programs"][0]["timeline"]["tracks"][0]["voices"] = 64;
    request["target"] = profile;
    std::string why;
    try {
        (void)compile_image(request);
    } catch (const compiler::CompileError& e) {
        EXPECT_EQ(e.where, "target");
        why = e.what();
    }
    ASSERT_NE(why.find("cycles in a frame, and this target has"), std::string::npos) << why;
    const auto at = why.find("fits with ");
    ASSERT_NE(at, std::string::npos) << why;
    const int fits = std::stoi(why.substr(at + 10));
    request["programs"][0]["timeline"]["tracks"][0]["voices"] = fits;
    const json target = compile_image(request).report.at("target");
    EXPECT_LE(target.at("cycles")[0].get<u64>(), target.at("cycles")[1].get<u64>());
    EXPECT_GE(fits, 1);
}

// What a frame does, counted by the engine itself, is never more than frame_cost() assumes of any frame: voices and
// fades sounding, notes, instructions, and the pieces a frame is cut into. Prices are checked against QEMU and the
// board by tools/Bench.py; this checks the counting, frame by frame, on everything the repository ships.
TEST(Cost, NoFrameDoesMoreThanTheBoundAssumes) {
    constexpr SynthConfig kCounted{.frame_size = 32, .channels = 1, .count_work = true};
    using Engine = Synth<kCounted>;
    u32 checked = 0;
    for (const auto& [path, bytes] : images()) {
        const LoadedImage image(bytes);
        if (image.loader.status() != LoadStatus::Ready || image.loader.programs() == 0) continue;
        if (image.table.frame_size() != 32) continue;
        const ProgramView p = program_of(image);
        const u64 window = detail::frame_ticks(p, 48000.0f, 32);
        const detail::Run conductor = detail::densest(p, p.h.conductor_begin, p.h.conductor_length, window);
        u64 voices = 0, notes = 0, instructions = conductor.instructions;
        for (u32 t = 0; t < p.h.tracks; ++t) {
            const TrackDesc d = p.track(t);
            voices += d.voices + ((p.h.features & kFeatureStealFades) != 0 ? fade_slots(d.voices) : 0);
            const detail::Run run = detail::densest(p, d.stream_begin, d.stream_length, window);
            notes += run.notes;
            instructions += run.instructions;
        }

        std::vector<ChunkRef> refs(kMaxChunks);
        ChunkTable chunks{std::span(refs)};
        std::vector<std::byte> fast(64u << 20), bulk(64u << 20);
        auto engine = std::make_unique<Engine>(Engine::Memory{fast, bulk, 48000.0f});
        engine->load(chunks, {reinterpret_cast<const std::byte*>(image.words.data()), bytes.size()});
        while (engine->pump(1u << 16)) {
        }
        ASSERT_EQ(engine->load_error(), LoadError::None) << path;
        engine->send({.kind = EventKind::Play});
        float out[32];
        // To its end and a second more, or the first 90 seconds of a piece
        for (u32 f = 0, after = 0; f < 48000 * 90 / 32 && after < 1500; ++f) {
            if (engine->tick() >= engine->length()) ++after;
            engine->render({out});
            const Work& w = engine->work();
            ASSERT_LE(w.run, voices) << path << " frame " << f;
            ASSERT_LE(w.notes, notes) << path << " frame " << f;
            ASSERT_LE(w.instructions, instructions) << path << " frame " << f;
            ASSERT_LE(w.segments, 1 + conductor.instructions) << path << " frame " << f;
        }
        ++checked;
    }
    EXPECT_GT(checked, 65u);
}
