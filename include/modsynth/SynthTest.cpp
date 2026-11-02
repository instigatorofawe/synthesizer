#include <algorithm>
#include <cmath>
#include <gtest/gtest.h>

#include <modsynth/TestSupport.hpp>

using namespace modsynth_test;
using compiler::compile_image;
using compiler::json;

namespace {

float peak(std::span<const float> audio) {
    float p = 0;
    for (const float s : audio) p = std::max(p, std::fabs(s));
    return p;
}

float rms(std::span<const float> audio) {
    double sum = 0;
    for (const float s : audio) sum += static_cast<double>(s) * s;
    return static_cast<float>(std::sqrt(sum / static_cast<double>(audio.size())));
}

template <class R>
void play(R& rig) {
    rig.engine.send({.kind = EventKind::Play});
}

// A one-track project built from one library patch, for tests about timing.
json single_track(const json& notes) {
    json request = demo();
    json timeline = json::parse(R"({"ppq": 480, "tempo": [{"tick": 0, "bpm": 120}],
        "clips": [{"id": "c", "length": 1920}],
        "tracks": [{"id": 1, "voices": 8, "slots": ["lead"], "placements": [{"clip": "c", "tick": 0}]}]})");
    timeline["clips"][0]["notes"] = notes;
    request["programs"] = {{{"id", "t"}, {"name", "t"}, {"timeline", timeline}}};
    return request;
}

}  // namespace

TEST(Synth, TheDemoProjectMakesSound) {
    Rig<kStereo> rig(compile_demo());
    ASSERT_EQ(rig.engine.load_error(), LoadError::None);
    ASSERT_FALSE(rig.engine.loading());
    play(rig);
    const auto audio = render_stereo(rig, 400);
    EXPECT_GT(peak(audio), 0.01f);
    EXPECT_LT(peak(audio), 2.0f);
    EXPECT_EQ(rig.engine.guard_trips(), 0u);
}

TEST(Synth, RenderingIsDeterministic) {
    const auto image = compile_demo();
    Rig<kStereo> a(image), b(image);
    play(a);
    play(b);
    EXPECT_EQ(render_stereo(a, 600), render_stereo(b, 600));
}

TEST(Synth, OutputDoesNotDependOnOldMemoryContents) {
    const auto image = compile_demo();
    Rig<kStereo> a(image, 0, std::byte{0x00}), b(image, 0, std::byte{0xFF});
    play(a);
    play(b);
    EXPECT_EQ(render_stereo(a, 600), render_stereo(b, 600));
}

TEST(Synth, TaskOrderDoesNotChangeTheOutput) {
    const auto image = compile_demo();
    Rig<kStereo> serial(image);
    Rig<kStereo, ShuffledExecutor> shuffled(image);
    play(serial);
    play(shuffled);
    EXPECT_EQ(render_stereo(serial, 600), render_stereo(shuffled, 600));
}

TEST(Synth, OnlyExecutorsThatUseEdgesPayForThem) {
    LoadedImage loaded(compile_demo());
    const u64 program = loaded.loader.program_hash(0);
    const auto serial = Synth<kStereo>::bytes_required(loaded.table, program, kRate);
    const auto shuffled = Synth<kStereo, ScalarBackend, ShuffledExecutor>::bytes_required(loaded.table, program, kRate);
    EXPECT_LT(serial.fast, shuffled.fast);
    EXPECT_EQ(serial.bulk, shuffled.bulk);
}

TEST(Synth, AOneTickNoteStillSounds) {
    json notes = json::array();
    for (int i = 0; i < 40; ++i) notes.push_back({{"tick", i * 48}, {"note", 60}, {"vel", 127}, {"dur", 1}});
    Rig<kStereo> rig(compile_image(single_track(notes)).image);
    play(rig);
    const auto audio = render_stereo(rig, 760);
    for (u32 i = 0; i < 40; ++i) {
        const u32 block = i * 2400 / 128;  // 48 ticks at 50 samples each
        EXPECT_GT(peak({audio.data() + block * 256, 256 * 8}), 1e-4f) << "note " << i;
    }
}

TEST(Synth, EventsLandOnTheirSampleOffset) {
    // At 120 bpm and 480 ppq a tick is 50 samples at 48 kHz, so tick 9 is sample 450: frame 14, offset 2.
    const json notes = json::array({{{"tick", 9}, {"note", 69}, {"vel", 127}, {"dur", 960}}});
    Rig<kStereo> rig(compile_image(single_track(notes)).image);
    play(rig);
    const auto audio = render_stereo(rig, 8);
    std::size_t first = 0;
    for (std::size_t sample = 0; sample < 8 * 128 && first == 0; ++sample) {
        if (audio[sample / kFrame * 2 * kFrame + sample % kFrame] != 0.0f) first = sample;
    }
    EXPECT_GE(first, 450u);
    EXPECT_LE(first, 451u);
}

TEST(Synth, TempoDoesNotDriftOverALongRun) {
    json request = single_track(json::array({{{"tick", 0}, {"note", 60}, {"vel", 100}, {"dur", 10}}}));
    request["programs"][0]["timeline"]["tempo"] = json::array({{{"tick", 0}, {"bpm", 137}}});
    Rig<kStereo> rig(compile_image(request).image);
    play(rig);
    float l[kFrame], r[kFrame];
    constexpr u32 frames = 20000 * kFramesPerBlock;  // about 53 seconds
    for (u32 f = 0; f < frames; ++f) rig.engine.render({l, r});
    const double seconds = frames * static_cast<double>(kFrame) / 48000.0;
    const u32 uspq = static_cast<u32>(60000000.0f / 137.0f);
    const double expected = seconds * 1e6 / uspq * 480.0;
    EXPECT_NEAR(rig.engine.tick(), expected, 1.0);
}

TEST(Synth, LocateChasesHeldNotes) {
    const json notes = json::array({{{"tick", 0}, {"note", 60}, {"vel", 100}, {"dur", 1800}}});
    Rig<kStereo> rig(compile_image(single_track(notes)).image);
    rig.engine.send({.kind = EventKind::Locate, .tick = 960});
    play(rig);
    const auto audio = render_stereo(rig, 20);
    EXPECT_GT(peak(audio), 1e-3f);
    EXPECT_EQ(rig.engine.active_voices(), 1u);
}

TEST(Synth, LocatePastANoteLeavesSilence) {
    const json notes = json::array({{{"tick", 0}, {"note", 60}, {"vel", 100}, {"dur", 100}}});
    Rig<kStereo> rig(compile_image(single_track(notes)).image);
    rig.engine.send({.kind = EventKind::Locate, .tick = 960});
    play(rig);
    EXPECT_EQ(peak(render_stereo(rig, 20)), 0.0f);
    EXPECT_EQ(rig.engine.active_voices(), 0u);
}

TEST(Synth, LoopBraceWrapsWithoutRecompiling) {
    Rig<kStereo> rig(compile_demo());
    rig.engine.send({.kind = EventKind::SetLoop, .tick = 0, .tick_end = 480});
    play(rig);
    render_stereo(rig, 2000);
    EXPECT_LT(rig.engine.tick(), 480u);
    EXPECT_GT(rig.engine.active_voices(), 0u);
}

TEST(Synth, AKnobMoveGlidesInsteadOfJumping) {
    const json notes = json::array({{{"tick", 0}, {"note", 45}, {"vel", 110}, {"dur", 1900}}});
    const auto image = compile_image(single_track(notes)).image;
    Rig<kStereo> moved(image), still(image);
    play(moved);
    play(still);
    render_stereo(moved, 40);
    render_stereo(still, 40);
    moved.engine.send({.kind = EventKind::SetParam, .target = 0, .param = 1, .value = 9000.0f});

    const auto difference = [&](u32 frames) {
        const auto a = render_stereo(moved, frames), b = render_stereo(still, frames);
        std::vector<float> d(a.size());
        for (std::size_t i = 0; i < a.size(); ++i) d[i] = a[i] - b[i];
        return rms(d);
    };
    const float first = difference(1);   // cutoff has barely moved
    const float later = difference(30);  // the 15 ms ramp has finished
    EXPECT_GT(later, 0.001f);
    EXPECT_LT(first, later * 0.5f);
}

TEST(Synth, StolenVoicesNeverExceedTheTrackLimit) {
    json notes = json::array();
    for (int i = 0; i < 64; ++i) notes.push_back({{"tick", i}, {"note", 40 + i}, {"vel", 100}, {"dur", 1800}});
    Rig<kStereo> rig(compile_image(single_track(notes)).image);
    play(rig);
    render_stereo(rig, 40);
    EXPECT_EQ(rig.engine.active_voices(), 8u);
}

TEST(Synth, BadEventsAreRefusedOrIgnored) {
    Rig<kStereo> rig(compile_demo());
    EXPECT_FALSE(rig.engine.send({.kind = EventKind::NoteOn, .note = 200}));
    EXPECT_FALSE(rig.engine.send({.kind = EventKind::SetParam, .value = std::nanf("")}));
    EXPECT_FALSE(rig.engine.send({.kind = EventKind::SetLoop, .tick = 10, .tick_end = 5}));
    EXPECT_TRUE(rig.engine.send({.kind = EventKind::NoteOn, .note = 60, .target = 999}));
    EXPECT_TRUE(rig.engine.send({.kind = EventKind::SetMix, .param = 9999, .value = 1.0f}));
    EXPECT_TRUE(rig.engine.send({.kind = EventKind::SetTap, .note = 200, .target = 999, .param = 0}));
    render_stereo(rig, 4);
    EXPECT_EQ(rig.engine.active_voices(), 0u);
}

TEST(Synth, BytesRequiredIsExact) {
    using Engine = Rig<kStereo>::Engine;
    const auto image = compile_demo();
    LoadedImage loaded(image);
    ASSERT_EQ(loaded.loader.status(), LoadStatus::Ready);
    const MemorySizes need = Engine::bytes_required(loaded.table, loaded.loader.program_hash(0), kRate);
    ASSERT_GT(need.fast, 0u);
    ASSERT_GT(need.bulk, 0u);

    const std::size_t fast = need.fast * 2 + Engine::tap_bytes(), bulk = need.bulk * 2;
    Rig<kStereo> exact(image, 0, std::byte{0xCD}, fast, bulk), roomy(image);
    EXPECT_EQ(exact.engine.load_error(), LoadError::None);
    play(exact);
    play(roomy);
    EXPECT_EQ(render_stereo(exact, 100), render_stereo(roomy, 100));

    Rig<kStereo> short_fast(image, 0, std::byte{0xCD}, fast - 64, bulk);
    EXPECT_EQ(short_fast.engine.load_error(), LoadError::OutOfMemory);
    Rig<kStereo> short_bulk(image, 0, std::byte{0xCD}, fast, bulk - 64);
    EXPECT_EQ(short_bulk.engine.load_error(), LoadError::OutOfMemory);
}

TEST(Synth, ASidechainDucksTheTrackItIsOn) {
    const auto render_with_depth = [](float depth) {
        json request = demo();
        request["programs"].erase(1);
        json& timeline = request["programs"][0]["timeline"];
        timeline["tracks"][0]["inserts"][0]["params"] = {{"1", depth}};
        timeline["tracks"][0]["sends"] = json::array();
        timeline["tracks"][1]["gain"] = 0.0;  // the pluck keys the ducker but is not heard
        timeline["tracks"][1]["sends"] = json::array();
        timeline["tracks"][1]["output"] = "bus:room";
        Rig<kStereo> rig(compile_image(request).image);
        play(rig);
        const auto audio = render_stereo(rig, 300);
        return rms(audio);
    };
    EXPECT_LT(render_with_depth(1.0f), render_with_depth(0.0f) * 0.9f);
}

TEST(Synth, ASendReachesTheBus) {
    json request = demo();
    request["programs"].erase(1);
    json& timeline = request["programs"][0]["timeline"];
    timeline["tracks"][0]["gain"] = 1.0;
    timeline["tracks"][0]["inserts"] = json::array();
    timeline["tracks"].erase(1);
    timeline["tracks"][0]["output"] = "bus:room";  // only path to master is through the reverb
    timeline["tracks"][0]["sends"] = json::array();
    Rig<kStereo> rig(compile_image(request).image);
    play(rig);
    const auto audio = render_stereo(rig, 300);
    EXPECT_GT(peak(audio), 1e-3f);
}

TEST(Synth, SetPatchLetsHeldNotesFinishOnTheOldPatch) {
    json request = demo();
    json timeline = json::parse(R"({"clips": [{"id": "c", "length": 1920, "notes": [
          {"tick": 0, "note": 60, "dur": 1800, "slot": 0}, {"tick": 480, "note": 64, "dur": 400, "slot": 1}]}],
        "tracks": [{"id": 1, "voices": 4, "slots": ["lead", "pluck"], "placements": [{"clip": "c", "tick": 0}]}]})");
    request["programs"] = {{{"id", "t"}, {"name", "t"}, {"timeline", timeline}}};
    const auto result = compile_image(request);
    EXPECT_EQ(result.report.at("programs")[0].at("patches").size(), 2u);
    Rig<kStereo> rig(result.image);
    play(rig);
    render_stereo(rig, 300);  // past tick 480, at about sample 24000
    EXPECT_EQ(rig.engine.active_voices(), 2u);
}

TEST(Synth, ASecondProgramBindsFromTheSameBundle) {
    const auto image = compile_demo();
    Rig<kStereo> song(image, 0), ballad(image, 1);
    ASSERT_EQ(ballad.engine.load_error(), LoadError::None);
    play(song);
    play(ballad);
    EXPECT_NE(render_stereo(song, 100), render_stereo(ballad, 100));
}

// Binding reaches no manifest, so the table has to carry the rule, or a Program could play at the wrong frame size.
TEST(Synth, BindRefusesATableOfAnotherFrameSize) {
    constexpr SynthConfig other{.frame_size = 128, .channels = 2, .tap_slots = 0, .generations = 1};
    LoadedImage loaded(compile_demo());
    ASSERT_EQ(loaded.table.frame_size(), kFrame);
    const u64 program = loaded.loader.program_hash(0);
    std::vector<std::byte> fast(8 << 20), bulk(8 << 20);

    Synth<other> wrong({fast, bulk, kRate});
    wrong.bind(loaded.table, program);
    EXPECT_EQ(wrong.load_error(), LoadError::WrongFrameSize);
    EXPECT_FALSE(wrong.loading());

    Synth<kStereo> right({fast, bulk, kRate});
    right.bind(loaded.table, program);
    while (right.pump(1 << 16)) {
    }
    EXPECT_EQ(right.load_error(), LoadError::None);
}

TEST(Synth, BindRefusesATableNoLoaderFilled) {
    const LoadedImage loaded(compile_demo());
    std::vector<ChunkRef> storage(kMaxChunks);
    ChunkTable bare(storage);
    for (u32 i = 0; i < loaded.table.size(); ++i) ASSERT_TRUE(bare.add(loaded.storage[i]));
    ASSERT_NE(bare.find(loaded.loader.program_hash(0)), nullptr);

    std::vector<std::byte> fast(8 << 20), bulk(8 << 20);
    Synth<kStereo> engine({fast, bulk, kRate});
    engine.bind(bare, loaded.loader.program_hash(0));
    EXPECT_EQ(engine.load_error(), LoadError::WrongFrameSize);
    EXPECT_FALSE(engine.loading());
}

TEST(Synth, ABadUploadLeavesTheOldImagePlaying) {
    const auto image = compile_demo();
    Rig<kStereo> rig(image), reference(image);
    play(rig);
    play(reference);
    auto bad = image;
    bad[bad.size() / 2] ^= std::byte{1};
    rig.swap_to(bad);
    EXPECT_EQ(render_stereo(rig, 300), render_stereo(reference, 300));
    EXPECT_NE(rig.engine.load_error(), LoadError::None);
    EXPECT_EQ(rig.engine.generation(), 1u);
}

TEST(Synth, SwappingToTheSameImageIsInaudible) {
    const auto image = compile_demo();
    Rig<kStereo> rig(image), reference(image);
    play(rig);
    play(reference);
    render_stereo(rig, 150);
    render_stereo(reference, 150);
    rig.swap_to(image);
    const auto after = render_stereo(rig, 300);
    const auto expected = render_stereo(reference, 300);
    EXPECT_EQ(rig.engine.generation(), 2u);
    EXPECT_EQ(rig.engine.load_error(), LoadError::None);
    float worst = 0;
    for (std::size_t i = 0; i < after.size(); ++i) worst = std::max(worst, std::fabs(after[i] - expected[i]));
    EXPECT_LT(worst, 1e-5f);
}

TEST(Synth, AnEditDuringPlaybackIsNoisyOnlyInTheWayItShouldBe) {
    json request = demo();
    const auto image = compile_image(request).image;
    // The same graph with a different filter Q: same state ids, so voices carry over.
    for (json& n : request["patches"]["lead"]["graph"]["nodes"]) {
        if (n.at("type") == "biquad") n["inputs"]["q"] = 4.0;
    }
    const auto edited = compile_image(request).image;
    ASSERT_NE(image, edited);

    Rig<kStereo> rig(image);
    play(rig);
    render_stereo(rig, 150);
    const u32 voices = rig.engine.active_voices();
    const u32 tick = rig.engine.tick();
    rig.swap_to(edited);
    float previous = 0;
    float largest_step = 0;
    float left[kFrame], right[kFrame];
    u32 frames = 0;
    while (rig.engine.generation() < 2 && frames < 2000 * kFramesPerBlock) {
        rig.engine.render({left, right});
        ++frames;
    }
    ASSERT_EQ(rig.engine.generation(), 2u);
    EXPECT_GE(rig.engine.active_voices(), voices > 0 ? 1u : 0u);
    EXPECT_GE(rig.engine.tick(), tick);
    for (u32 f = 0; f < 60 * kFramesPerBlock; ++f) {
        rig.engine.render({left, right});
        for (const float s : left) {
            largest_step = std::max(largest_step, std::fabs(s - previous));
            previous = s;
        }
    }
    EXPECT_LT(largest_step, 0.5f);
    EXPECT_EQ(rig.engine.guard_trips(), 0u);
}

TEST(Synth, ThreeQuickEditsAllLand) {
    const auto image = compile_demo();
    Rig<kStereo> rig(image);
    play(rig);
    render_stereo(rig, 20);
    for (u32 edit = 0; edit < 3; ++edit) {
        rig.swap_to(image);
        render_stereo(rig, 200);
    }
    EXPECT_EQ(rig.engine.generation(), 4u);
    EXPECT_EQ(rig.engine.load_error(), LoadError::None);
}

TEST(Synth, TapsDeliverBlocksAndCountDrops) {
    const auto result = compile_image(demo());
    Rig<kStereo> rig(result.image);
    const json& master = result.report.at("programs")[0].at("master");
    Event tap{.kind = EventKind::SetTap, .note = master.at("bus").get<u8>(), .channel = 0};
    tap.target = master.at("step").get<u16>();
    tap.param = 0;
    rig.engine.send(tap);
    play(rig);

    float left[kFrame], right[kFrame];
    std::vector<float> rendered, captured;
    for (u32 f = 0; f < 80 * kFramesPerBlock; ++f) {
        rig.engine.render({left, right});
        rendered.insert(rendered.end(), left, left + kFrame);
        TapBlock block;
        if (rig.engine.tap_take(0, block)) {
            EXPECT_EQ(block.length, 1024u);
            EXPECT_EQ(block.dropped, 0u);
            EXPECT_EQ(block.start_sample, captured.size());
            captured.insert(captured.end(), block.data, block.data + block.length);
        }
    }
    ASSERT_GT(captured.size(), 8000u);
    for (std::size_t i = 0; i < captured.size(); ++i) ASSERT_EQ(captured[i], rendered[i]) << i;

    for (u32 f = 0; f < 40 * kFramesPerBlock; ++f) rig.engine.render({left, right});  // Nobody reads, so blocks drop
    TapBlock block;
    ASSERT_TRUE(rig.engine.tap_take(0, block));
    EXPECT_GT(block.dropped, 0u);
}

TEST(Synth, EnginesWithoutTapsCarryNoTapStorage) {
    constexpr SynthConfig tapped{.frame_size = kFrame, .channels = 2, .tap_slots = 8, .generations = 1};
    constexpr SynthConfig plain{.frame_size = kFrame, .channels = 2, .tap_slots = 0, .generations = 1};
    EXPECT_GT(sizeof(Synth<tapped>), sizeof(Synth<plain>));
    EXPECT_EQ(Synth<plain>::tap_bytes(), 0u);
}

TEST(SynthMono, FoldsACentredStereoProjectToTheSameSignal) {
    json request = demo();
    for (json& t : request["programs"][0]["timeline"]["tracks"]) t["pan"] = 0;
    const auto image = compile_image(request).image;

    Rig<kStereo> stereo(image);
    Rig<kMono> mono(image);
    ASSERT_EQ(mono.engine.load_error(), LoadError::None);
    play(stereo);
    play(mono);
    const auto both = render_stereo(stereo, 400);
    constexpr u32 frames = 400 * kFramesPerBlock;
    std::vector<float> folded(frames * kFrame);
    for (u32 f = 0; f < frames; ++f) mono.engine.render({folded.data() + f * kFrame});

    float worst = 0, loudest = 0;
    for (u32 f = 0; f < frames; ++f) {
        for (u32 i = 0; i < kFrame; ++i) {
            const float* left = both.data() + f * 2 * kFrame;
            const float expected = (left[i] + left[kFrame + i]) * 0.5f;
            worst = std::max(worst, std::fabs(expected - folded[f * kFrame + i]));
            loudest = std::max(loudest, std::fabs(expected));
        }
    }
    ASSERT_GT(loudest, 0.01f);
    EXPECT_LT(worst / loudest, std::pow(10.0f, -100.0f / 20.0f));
}

TEST(SynthMono, PanMovesNothingButStereoDoes) {
    const auto image_at = [](float position) {
        json request = demo();
        json graph = json::parse(R"({
          "nodes": [{"id": 1, "type": "noise"}, {"id": 2, "type": "pan"}, {"id": 3, "type": "out"},
                    {"id": 4, "type": "env"}, {"id": 5, "type": "mul"}],
          "edges": [{"from": 1, "to": 5, "input": "a"}, {"from": 4, "to": 5, "input": "b"},
                    {"from": 5, "to": 2, "input": "in"},
                    {"from": 2, "port": "l", "to": 3, "input": "l"}, {"from": 2, "port": "r", "to": 3, "input": "r"}]})");
        graph["nodes"][1]["inputs"] = {{"position", position}};
        request["patches"]["panned"] = {{"graph", graph}};
        json notes = json::array({{{"tick", 0}, {"note", 60}, {"vel", 100}, {"dur", 1800}}});
        json timeline = json::parse(R"({"clips": [{"id": "c", "length": 1920}],
            "tracks": [{"id": 1, "slots": ["panned"], "placements": [{"clip": "c", "tick": 0}]}]})");
        timeline["clips"][0]["notes"] = notes;
        request["programs"] = {{{"id", "t"}, {"name", "t"}, {"timeline", timeline}}};
        return compile_image(request).image;
    };
    const auto mono_render = [](const std::vector<std::byte>& image) {
        Rig<kMono> rig(image);
        play(rig);
        constexpr u32 frames = 100 * kFramesPerBlock;
        std::vector<float> out(frames * kFrame);
        for (u32 f = 0; f < frames; ++f) rig.engine.render({out.data() + f * kFrame});
        return out;
    };
    const auto left = image_at(-1.0f), right = image_at(1.0f);
    ASSERT_NE(left, right);
    const auto heard = mono_render(left);
    EXPECT_GT(peak(heard), 0.01f);
    EXPECT_EQ(heard, mono_render(right));

    Rig<kStereo> stereo_left(left), stereo_right(right);
    play(stereo_left);
    play(stereo_right);
    EXPECT_NE(render_stereo(stereo_left, 100), render_stereo(stereo_right, 100));
}

TEST(SynthMono, UsesLessMemoryThanStereo) {
    LoadedImage loaded(compile_demo());
    const u64 program = loaded.loader.program_hash(0);
    EXPECT_LT(Synth<kMono>::bytes_required(loaded.table, program, kRate).fast,
              Synth<kStereo>::bytes_required(loaded.table, program, kRate).fast);
}

TEST(SynthMono, TheSameImageRunsOnBothBuilds) {
    const auto image = compile_demo();
    Rig<kMono> mono(image);
    EXPECT_EQ(mono.engine.load_error(), LoadError::None);
}

namespace {

// A looping f32 asset of one constant value, played by a voice with a stable state id.
std::vector<std::byte> sample_image(u32 frames) {
    compiler::detail::Writer asset;
    AssetHeader a{};
    a.encoding = static_cast<u8>(AssetEncoding::F32);
    a.channels = 1;
    a.root_key = 60;
    a.native_rate = kRate;
    a.frames = frames;
    a.loop_end = frames;
    asset.put(a);
    asset.put_all(std::vector<float>(frames + 1, 0.25f));
    const compiler::Chunk asset_chunk = compiler::detail::make_chunk(ChunkKind::Asset, std::move(asset.bytes));

    HandPatch patch;
    patch.header.buffers = 2;
    patch.header.voice_scalars = kBuiltinVoiceScalars;
    patch.header.out_left = operand(Bank::Buffer, 0);
    patch.header.out_right = operand(Bank::Buffer, 1);
    patch.refs = {asset_chunk.hash};
    patch.consts = {1.0f};
    WireStep step{};
    step.op = static_cast<u8>(Op::Sample);
    step.state_id = 1;
    step.out[0] = operand(Bank::Buffer, 0);
    step.out[1] = operand(Bank::Buffer, 1);
    step.in[0] = operand(Bank::Const, 0);
    patch.voice = {step};
    const compiler::Chunk patch_chunk = patch.chunk();

    return assemble({asset_chunk, patch_chunk, minimal_program(patch_chunk.hash).chunk()});
}

}  // namespace

TEST(Swap, ASampleCarriedToAShorterAssetStaysInsideIt) {
    Rig<kStereo> rig(sample_image(4096));
    ASSERT_EQ(rig.engine.load_error(), LoadError::None);
    ASSERT_TRUE(rig.engine.send({.kind = EventKind::NoteOn, .note = 60, .velocity = 100}));
    (void)render_stereo(rig, 16);  // 2048 samples into the long asset

    rig.swap_to(sample_image(16));
    (void)render_stereo(rig, 64);
    ASSERT_EQ(rig.engine.load_error(), LoadError::None);
    ASSERT_EQ(rig.engine.generation(), 2u);

    // Past the end of the short asset is the rest of the image, so any stray read changes this value.
    for (const float x : render_stereo(rig, 4)) ASSERT_EQ(x, 0.25f);
}

TEST(Math, ComesCloseToTheRealFunctions) {
    for (int i = -2000; i <= 2000; ++i) {
        const float turns = static_cast<float>(i) * 0.001f;
        EXPECT_NEAR(sin_turns(turns), std::sin(static_cast<double>(turns) * 2.0 * M_PI), 4e-7) << turns;
    }
    for (int i = -1200; i <= 1200; ++i) {
        const float x = static_cast<float>(i) * 0.1f;
        const double exact = std::pow(2.0, static_cast<double>(x));
        EXPECT_NEAR(pow2(x) / exact, 1.0, 3e-7) << x;
    }
    for (int i = 0; i <= 1000; ++i) {
        const float x = static_cast<float>(i) * 0.01f;
        EXPECT_NEAR(exp_minus(x) / std::exp(-static_cast<double>(x)), 1.0, 1e-6) << x;
    }
    EXPECT_EQ(pow2(0.0f), 1.0f);
    EXPECT_EQ(sin_turns(0.0f), 0.0f);
}

TEST(Noise, DoesNotDependOnWhereItsStateSits) {
    // Two patches that differ only in how much state comes before their Noise step, by way of a delay line. The first
    // block of noise must match, or an opcode's output would depend on a struct's size, and so on the target.
    const auto image = [](bool with_delay) {
        HandPatch p;
        p.header.buffers = 1;
        p.header.voice_scalars = kBuiltinVoiceScalars;
        p.header.out_left = p.header.out_right = operand(Bank::Buffer, 0);
        if (with_delay) p.delays = {0.01f};
        WireStep noise{};
        noise.op = static_cast<u8>(Op::Noise);
        noise.out[0] = operand(Bank::Buffer, 0);
        p.voice = {noise};
        const compiler::Chunk patch = p.chunk();
        return assemble({patch, minimal_program(patch.hash).chunk()});
    };
    Rig<kStereo> a(image(false)), b(image(true));
    ASSERT_EQ(a.engine.load_error(), LoadError::None);
    ASSERT_EQ(b.engine.load_error(), LoadError::None);
    for (auto* rig : {&a, &b}) ASSERT_TRUE(rig->engine.send({.kind = EventKind::NoteOn, .note = 60, .velocity = 100}));
    EXPECT_EQ(render_stereo(a, 8), render_stereo(b, 8));
}
