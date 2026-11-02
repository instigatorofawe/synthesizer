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

TEST(Synth, ATempoRampTakesAsLongAsItsCurve) {
    // 120 down to 60 bpm across four bars, linear in bpm over ticks. A curve like that lasts
    // 60 / ppq · T / (b1 − b0) · ln(b1 / b0) seconds.
    json request = single_track(json::array({{{"tick", 0}, {"note", 60}, {"vel", 100}, {"dur", 10}}}));
    request["programs"][0]["timeline"]["tempo"] =
        json::parse(R"([{"tick": 0, "bpm": 120, "ramp": true}, {"tick": 7680, "bpm": 60}])");
    Rig<kStereo> rig(compile_image(request).image);
    play(rig);
    float l[kFrame], r[kFrame];
    u32 frames = 0;
    while (rig.engine.tick() < 7680) {
        rig.engine.render({l, r});
        ++frames;
    }
    const double exact = 60.0 / 480.0 * 7680.0 / (60.0 - 120.0) * std::log(60.0 / 120.0) * 48000.0;
    // Each of its 128 steps rounds up to a sample, and the count stops at the end of a frame. The step at the start of
    // each 1/32 note instead of its middle would be 1500 samples out.
    EXPECT_NEAR(frames * static_cast<double>(kFrame), exact, 128.0 + kFrame + 2.0);
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

// Lanes, play modes and Sample2. The patches here put what a voice is doing straight on its output, so a test reads it
// from the samples. A track panned hard left has a left gain of exactly 1.
namespace {

constexpr char kFlat[] = R"({"nodes": [{"id": 1, "type": "const", "value": 0.5}, {"id": 2, "type": "out"}],
    "edges": [{"from": 1, "to": 2, "input": "l"}]})";
constexpr char kPitch[] = R"({"nodes": [{"id": 1, "type": "note"}, {"id": 2, "type": "mul", "inputs": {"b": 0.01}},
    {"id": 3, "type": "out"}],
    "edges": [{"from": 1, "port": "pitch", "to": 2, "input": "a"}, {"from": 2, "to": 3, "input": "l"}]})";
constexpr char kSwell[] = R"({"nodes": [
    {"id": 1, "type": "env", "inputs": {"attack": 1.0, "decay": 0.1, "sustain": 1.0, "release": 0.001}},
    {"id": 2, "type": "out"}], "edges": [{"from": 1, "to": 2, "input": "l"}]})";
constexpr char kGain[] = R"({"params": [{"id": 1, "min": 0, "max": 1, "default": 1, "smooth_ms": 0}],
    "nodes": [{"id": 1, "type": "in"}, {"id": 2, "type": "param", "param": 1}, {"id": 3, "type": "mul"},
    {"id": 4, "type": "out"}],
    "edges": [{"from": 1, "port": "l", "to": 3, "input": "a"}, {"from": 2, "to": 3, "input": "b"},
    {"from": 3, "to": 4, "input": "l"}]})";

// Plays a parameter, so what a test hears is the parameter itself.
std::string knob(const char* scope = "track", float low = 0.0f, float high = 1.0f, float start = 0.25f) {
    json graph = json::parse(R"({"nodes": [{"id": 1, "type": "param", "param": 1}, {"id": 2, "type": "out"}],
        "edges": [{"from": 1, "to": 2, "input": "l"}]})");
    const json param = {{"id", 1}, {"min", low}, {"max", high}, {"default", start}, {"scope", scope}, {"smooth_ms", 0}};
    graph["params"] = json::array({param});
    return graph.dump();
}

json song(const json& patches, const json& tracks, const json& clips, const json& extra = json::object()) {
    json timeline = {
        {"ppq", 480}, {"tempo", json::parse(R"([{"tick": 0, "bpm": 120}])")}, {"clips", clips}, {"tracks", tracks}};
    timeline.update(extra);
    json request;
    request["patches"] = json::object();
    for (const auto& [id, graph] : patches.items()) request["patches"][id] = {{"name", id}, {"graph", graph}};
    request["programs"] = {{{"id", "t"}, {"name", "t"}, {"timeline", timeline}}};
    return request;
}

// One track, panned left, playing one clip of a patch.
json one_track(const char* patch, const json& clip, const json& track_extra = json::object(),
               const json& extra = json::object()) {
    json track = {{"id", 1}, {"voices", 4}, {"pan", -1.0}, {"slots", {"p"}}};
    track["placements"] = {{{"clip", "c"}, {"tick", 0}}};
    track.update(track_extra);
    json c = clip;
    c["id"] = "c";
    if (!c.contains("length")) c["length"] = 3840;
    return song({{"p", json::parse(patch)}}, json::array({track}), json::array({c}), extra);
}

// A frame lasts this many ticks: 50 samples to a tick at 120 bpm, 480 ppq and 48 kHz.
constexpr u32 frame_at(u32 tick) { return tick * 50 / kFrame; }

template <class R>
std::vector<float> first_samples(R& rig, u32 frames, u32 channel = 0) {
    std::vector<float> out(frames);
    float left[kFrame], right[kFrame];
    for (u32 f = 0; f < frames; ++f) {
        rig.engine.render({left, right});
        out[f] = (channel == 0 ? left : right)[0];
    }
    return out;
}

template <class R>
float level_at_tick(R& rig, std::vector<float>& heard, u32 tick) {
    const u32 frame = frame_at(tick);
    if (heard.size() <= frame) {
        const auto more = first_samples(rig, frame + 1 - static_cast<u32>(heard.size()));
        heard.insert(heard.end(), more.begin(), more.end());
    }
    return heard[frame];
}

// What the engine plays, read at ticks. A little after a tick, so an event on it has landed.
template <class R>
std::vector<float> levels(R& rig, std::initializer_list<u32> ticks) {
    std::vector<float> heard, out;
    for (const u32 tick : ticks) out.push_back(level_at_tick(rig, heard, tick));
    return out;
}

void expect_near(const std::vector<float>& actual, const std::vector<float>& expected, float tolerance = 1e-4f) {
    ASSERT_EQ(actual.size(), expected.size());
    for (std::size_t i = 0; i < actual.size(); ++i) EXPECT_NEAR(actual[i], expected[i], tolerance) << "at " << i;
}

json one_note(u32 dur = 3840) { return json::array({{{"tick", 0}, {"note", 60}, {"dur", dur}}}); }

}  // namespace

TEST(Lanes, AFaderLaneRampsTheMixer) {
    json clip = {{"notes", one_note()}};
    clip["automation"] =
        json::parse(R"([{"target": {"mix": "fader", "track": 1}, "tick": 480, "value": 0, "ramp": 480}])");
    Rig<kStereo> rig(compile_image(one_track(kFlat, clip)).image);
    ASSERT_EQ(rig.engine.load_error(), LoadError::None);
    play(rig);
    expect_near(levels(rig, {100, 479, 720, 959, 1200}), {0.5f, 0.5f, 0.25f, 0.0f, 0.0f}, 0.002f);
}

TEST(Lanes, APanLaneMovesTheSoundAcross) {
    json clip = {{"notes", one_note()}};
    clip["automation"] = json::parse(R"([{"target": {"mix": "pan", "track": 1}, "tick": 480, "value": 1}])");
    Rig<kStereo> rig(compile_image(one_track(kFlat, clip)).image);
    play(rig);
    const auto left = first_samples(rig, frame_at(600));
    EXPECT_NEAR(left[frame_at(400)], 0.5f, 1e-5f);
    EXPECT_NEAR(left.back(), 0.0f, 1e-5f);
    const auto right = first_samples(rig, 1, 1);
    EXPECT_NEAR(right[0], 0.5f, 1e-5f);
}

TEST(Lanes, ASendLaneOpensTheSend) {
    json clip = {{"notes", one_note()}};
    clip["automation"] =
        json::parse(R"([{"target": {"mix": "send", "track": 1, "to": "wet"}, "tick": 480, "value": 1}])");
    json track = {{"sends", json::parse(R"([{"bus": "wet", "gain": 0}])")}};
    json buses = {{"buses", json::parse(R"([{"id": "wet", "pan": -1}])")}};
    Rig<kStereo> rig(compile_image(one_track(kFlat, clip, track, buses)).image);
    play(rig);
    expect_near(levels(rig, {100, 600}), {0.5f, 1.0f});
}

TEST(Lanes, AMasterFaderReachesEverythingIntoTheMaster) {
    json clip = {{"notes", one_note()}};
    clip["automation"] = json::parse(R"([{"target": {"mix": "fader", "master": true}, "tick": 480, "value": 0.5}])");
    json master = {{"master", {{"gain", 0.8}}}};
    Rig<kStereo> rig(compile_image(one_track(kFlat, clip, json::object(), master)).image);
    play(rig);
    expect_near(levels(rig, {100, 600}), {0.4f, 0.25f});
}

TEST(Lanes, AnInsertLaneMovesItsParameter) {
    json clip = {{"notes", one_note()}};
    clip["automation"] = json::parse(R"([
        {"target": {"insert": 7}, "param": 1, "tick": 480, "value": 0.2},
        {"target": {"insert": 7}, "param": 1, "tick": 960, "value": 1, "ramp": 480}])");
    json track = {{"inserts", json::parse(R"([{"id": 7, "patch": "gain", "params": {"1": 0.6}}])")}};
    json request = one_track(kFlat, clip, track);
    request["patches"]["gain"] = {{"name", "gain"}, {"graph", json::parse(kGain)}};
    Rig<kStereo> rig(compile_image(request).image);
    ASSERT_EQ(rig.engine.load_error(), LoadError::None);
    play(rig);
    expect_near(levels(rig, {100, 600, 1200, 1500}), {0.3f, 0.1f, 0.3f, 0.5f}, 0.002f);
}

TEST(Lanes, ALocateSoundsTheSameAsPlayingThere) {
    json clip = {{"notes", one_note()}};
    clip["automation"] = json::parse(R"([
        {"target": {"mix": "fader", "track": 1}, "tick": 480, "value": 0, "ramp": 480},
        {"target": {"insert": 7}, "param": 1, "tick": 1440, "value": 0.5, "ramp": 480}])");
    json track = {{"inserts", json::parse(R"([{"id": 7, "patch": "gain"}])")}};
    json request = one_track(kFlat, clip, track);
    request["patches"]["gain"] = {{"name", "gain"}, {"graph", json::parse(kGain)}};
    const auto image = compile_image(request).image;

    Rig<kStereo> through(image);
    play(through);
    const auto heard = first_samples(through, frame_at(3000));

    for (const u32 tick : {u32{0}, u32{300}, u32{720}, u32{1200}, u32{1680}, u32{2400}}) {
        SCOPED_TRACE(tick);
        Rig<kStereo> rig(image);
        play(rig);
        (void)first_samples(rig, frame_at(2800));  // Past every lane, so nothing is left where a locate would want it
        rig.engine.send({.kind = EventKind::Locate, .tick = tick});
        const auto jumped = first_samples(rig, frame_at(300));
        for (const u32 at : {u32{0}, u32{100}, u32{250}}) {
            EXPECT_NEAR(jumped[frame_at(at) + 1], heard[frame_at(tick + at) + 1], 0.003f) << "at " << at;
        }
    }
}

TEST(Lanes, ALoopStartsFromWhereTheLaneStarted) {
    json clip = {{"notes", json::array({{{"tick", 0}, {"note", 60}, {"dur", 960}}})}, {"length", 960}};
    clip["automation"] =
        json::parse(R"([{"target": {"mix": "fader", "track": 1}, "tick": 240, "value": 0, "ramp": 240}])");
    Rig<kStereo> rig(compile_image(one_track(kFlat, clip)).image);
    rig.engine.send({.kind = EventKind::SetLoop, .tick = 0, .tick_end = 960});
    play(rig);
    const auto heard = first_samples(rig, frame_at(1000));
    EXPECT_NEAR(heard[frame_at(800)], 0.0f, 1e-5f);
    EXPECT_NEAR(heard[frame_at(960) + 8], 0.5f, 1e-5f);
}

TEST(Lanes, ALaneWithNoTargetStartsAgainOnALoop) {
    for (const char* scope : {"track", "voice", "global"}) {
        SCOPED_TRACE(scope);
        json clip = {{"notes", json::array({{{"tick", 0}, {"note", 60}, {"dur", 960}}})}, {"length", 960}};
        clip["automation"] = json::parse(R"([{"param": 1, "tick": 240, "value": 1}])");
        Rig<kStereo> rig(compile_image(one_track(knob(scope).c_str(), clip)).image);
        rig.engine.send({.kind = EventKind::SetLoop, .tick = 0, .tick_end = 960});
        play(rig);
        const auto heard = first_samples(rig, frame_at(1400));
        EXPECT_EQ(heard[frame_at(100)], 0.25f);
        EXPECT_EQ(heard[frame_at(800)], 1.0f);
        EXPECT_EQ(heard[frame_at(960 + 100)], 0.25f);
        EXPECT_EQ(heard[frame_at(960 + 300)], 1.0f);
    }
}

TEST(Lanes, ALocateSoundsTheSameAsPlayingThereWithNoTarget) {
    json clip = {{"notes", one_note()}};
    clip["automation"] = json::parse(R"([{"param": 1, "tick": 0, "value": 0.5, "ramp": 480},
        {"param": 1, "tick": 960, "value": 1, "ramp": 480}])");
    const auto image = compile_image(one_track(knob().c_str(), clip)).image;

    Rig<kStereo> through(image);
    play(through);
    const auto heard = first_samples(through, frame_at(2000));

    for (const u32 tick : {u32{0}, u32{240}, u32{720}, u32{1200}, u32{1600}}) {
        SCOPED_TRACE(tick);
        Rig<kStereo> rig(image);
        play(rig);
        (void)first_samples(rig, frame_at(1900));  // Past every lane, so nothing is left where a locate would want it
        rig.engine.send({.kind = EventKind::Locate, .tick = tick});
        const auto jumped = first_samples(rig, frame_at(300));
        for (const u32 at : {u32{0}, u32{100}, u32{250}}) {
            EXPECT_NEAR(jumped[frame_at(at) + 1], heard[frame_at(tick + at) + 1], 0.003f) << "at " << at;
        }
    }
}

TEST(Lanes, AnInsertLaneOnAGlobalReturnsToTheProgramsValue) {
    json gain = json::parse(kGain);
    gain["params"][0]["scope"] = "global";
    json clip = {{"notes", json::array({{{"tick", 0}, {"note", 60}, {"dur", 960}}})}, {"length", 960}};
    clip["automation"] = json::parse(R"([{"target": {"insert": 7}, "param": 1, "tick": 240, "value": 0.2}])");
    json track = {{"inserts", json::parse(R"([{"id": 7, "patch": "gain"}])")}};
    json request = one_track(kFlat, clip, track, {{"globals", {{"1", 0.6}}}});
    request["patches"]["gain"] = {{"name", "gain"}, {"graph", gain}};
    Rig<kStereo> rig(compile_image(request).image);
    rig.engine.send({.kind = EventKind::SetLoop, .tick = 0, .tick_end = 960});
    play(rig);
    const auto heard = first_samples(rig, frame_at(1100));
    EXPECT_NEAR(heard[frame_at(100)], 0.3f, 1e-5f);
    EXPECT_NEAR(heard[frame_at(800)], 0.1f, 1e-5f);
    EXPECT_NEAR(heard[frame_at(960 + 100)], 0.3f, 1e-5f);
}

TEST(Lanes, AProgramPaysOnlyForTheRampsItUses) {
    const auto required = [](const json& automation) {
        json clip = {{"notes", one_note()}, {"automation", automation}};
        LoadedImage loaded(compile_image(one_track(kFlat, clip)).image);
        return Rig<kStereo>::Engine::bytes_required(loaded.table, loaded.loader.program_hash(0), kRate).fast;
    };
    const u64 none = required(json::array());
    EXPECT_EQ(required(json::parse(R"([{"target": {"mix": "fader", "track": 1}, "tick": 0, "value": 1}])")), none);
    EXPECT_GT(required(json::parse(R"([{"target": {"mix": "fader", "track": 1}, "tick": 0, "value": 1, "ramp": 9}])")),
              none);
}

TEST(Lanes, TwoControlsInOneRegisterBothMove) {
    json clip = {{"notes", one_note()}};
    clip["automation"] = json::parse(R"([
        {"target": {"mix": "fader", "track": 1}, "tick": 480, "value": 0.5},
        {"target": {"mix": "fader", "master": true}, "tick": 960, "value": 0.5},
        {"target": {"mix": "pan", "track": 1}, "tick": 1440, "value": 0}])");
    Rig<kStereo> rig(compile_image(one_track(kFlat, clip)).image);
    ASSERT_EQ(rig.engine.load_error(), LoadError::None);
    play(rig);
    expect_near(levels(rig, {100, 600, 1200, 1600}), {0.5f, 0.25f, 0.125f, 0.125f * 0.70710678f});
}

TEST(Lanes, AStageSoundsLikeTheRegisterItTakesOver) {
    // The same settings, once in the document and once from lanes at tick 0 that need stages.
    json still =
        one_track(kSwell, {{"notes", one_note(1920)}}, {{"gain", 0.7}, {"pan", 0.3}}, {{"master", {{"gain", 0.6}}}});
    json clip = {{"notes", one_note(1920)}};
    clip["automation"] = json::parse(R"([
        {"target": {"mix": "fader", "track": 1}, "tick": 0, "value": 0.7},
        {"target": {"mix": "pan", "track": 1}, "tick": 0, "value": 0.3},
        {"target": {"mix": "fader", "master": true}, "tick": 0, "value": 0.6}])");
    json moved = one_track(kSwell, clip, {{"gain", 0.2}, {"pan", -0.5}}, {{"master", {{"gain", 0.1}}}});
    Rig<kStereo> a(compile_image(still).image), b(compile_image(moved).image);
    play(a);
    play(b);
    const auto heard = render_stereo(a, 64), stages = render_stereo(b, 64);
    float worst = 0.0f;
    for (std::size_t i = 0; i < heard.size(); ++i) worst = std::max(worst, std::abs(heard[i] - stages[i]));
    EXPECT_LT(worst, 1e-6f);
    EXPECT_GT(*std::max_element(heard.begin(), heard.end()), 0.05f);
}

TEST(Lanes, APreFaderSendIgnoresTheFaderAndPanButNotTheMute) {
    const auto heard = [](bool mute) {
        json track = {
            {"gain", 0.0}, {"mute", mute}, {"sends", json::parse(R"([{"bus": "wet", "gain": 1, "pre": true}])")}};
        Rig<kStereo> rig(compile_image(one_track(kFlat, {{"notes", one_note()}}, track,
                                                 {{"buses", json::parse(R"([{"id": "wet", "pan": -1}])")}}))
                             .image);
        play(rig);
        return levels(rig, {100});
    };
    expect_near(heard(false), {0.5f});
    expect_near(heard(true), {0.0f});
}

TEST(Lanes, AnExpCurveFallsEvenlyInDecibels) {
    json clip = {{"notes", one_note()}};
    clip["automation"] = json::parse(R"([
        {"target": {"mix": "fader", "track": 1}, "tick": 480, "value": 0.01, "ramp": 960, "curve": "exp"}])");
    Rig<kStereo> rig(compile_image(one_track(kFlat, clip)).image);
    play(rig);
    const auto heard = levels(rig, {400, 720, 960, 1200, 1440, 1600});
    const std::vector<double> decibels = {0, -10, -20, -30, -40, -40};
    for (std::size_t i = 0; i < heard.size(); ++i) {
        EXPECT_NEAR(20.0 * std::log10(heard[i] / 0.5), decibels[i], 0.25) << "at " << i;
    }
}

TEST(Lanes, ALocateIntoACurveSoundsTheSameAsPlayingThere) {
    json clip = {{"notes", one_note()}};
    clip["automation"] = json::parse(R"([
        {"target": {"mix": "fader", "track": 1}, "tick": 240, "value": 0, "ramp": 1440, "curve": "exp"}])");
    const auto image = compile_image(one_track(kFlat, clip)).image;
    Rig<kStereo> through(image);
    play(through);
    const auto heard = first_samples(through, frame_at(2400));
    for (const u32 tick : {u32{0}, u32{600}, u32{1100}, u32{1500}}) {
        SCOPED_TRACE(tick);
        Rig<kStereo> rig(image);
        play(rig);
        (void)first_samples(rig, frame_at(2000));
        rig.engine.send({.kind = EventKind::Locate, .tick = tick});
        const auto jumped = first_samples(rig, frame_at(300));
        for (const u32 at : {u32{0}, u32{100}, u32{250}}) {
            EXPECT_NEAR(jumped[frame_at(at) + 1], heard[frame_at(tick + at) + 1], 0.003f) << "at " << at;
        }
    }
}

namespace {

// Plays a note's velocity, as a fraction of 127.
constexpr char kVelocity[] = R"({"nodes": [{"id": 1, "type": "note"}, {"id": 2, "type": "out"}],
    "edges": [{"from": 1, "port": "velocity", "to": 2, "input": "l"}]})";

}  // namespace

TEST(Placement, PlaysItsClipTransposedAndWithItsVelocitiesScaled) {
    const json notes = json::parse(R"([{"tick": 0, "note": 60, "vel": 100, "dur": 480}])");
    const auto heard = [&](const char* patch, const json& placement) {
        json track = {{"placements", json::array({json{{"clip", "c"}, {"tick", 0}}})}};
        track["placements"][0].update(placement);
        Rig<kStereo> rig(compile_image(one_track(patch, {{"notes", notes}, {"length", 480}}, track)).image);
        play(rig);
        return levels(rig, {100});
    };
    expect_near(heard(kPitch, {{"transpose", 12}}), {0.72f});
    expect_near(heard(kVelocity, {{"velocity", 0.5}}), {50.0f / 127.0f});
}

TEST(Placement, AWindowSoundsLikeThatPartOfItsClip) {
    json clip = {{"notes", json::parse(R"([{"tick": 0, "note": 60, "dur": 480}, {"tick": 960, "note": 60,
        "dur": 960}])")},
                 {"length", 1920}};
    clip["automation"] =
        json::parse(R"([{"target": {"mix": "fader", "track": 1}, "tick": 0, "value": 0.2, "ramp": 1920}])");
    const auto full = compile_image(one_track(kFlat, clip)).image;
    json track = {{"placements", json::parse(R"([{"clip": "c", "tick": 0, "start": 960}])")}};
    const auto window = compile_image(one_track(kFlat, clip, track)).image;
    Rig<kStereo> a(full), b(window);
    play(a);
    play(b);
    const auto whole = first_samples(a, frame_at(1900));
    const auto part = first_samples(b, frame_at(900));
    for (const u32 at : {u32{10}, u32{200}, u32{500}, u32{850}}) {
        EXPECT_NEAR(part[frame_at(at)], whole[frame_at(960 + at)], 0.002f) << "at " << at;
    }
}

TEST(Play, PolyOverlapsAndMonoDoesNot) {
    const json notes = json::parse(R"([{"tick": 0, "note": 60, "dur": 960}, {"tick": 480, "note": 64, "dur": 960}])");
    Rig<kStereo> poly(compile_image(one_track(kPitch, {{"notes", notes}})).image);
    play(poly);
    expect_near(levels(poly, {100, 700, 1200, 1600}), {0.60f, 1.24f, 0.64f, 0.0f});

    json track = {{"play", {{"mode", "mono"}}}};
    Rig<kStereo> mono(compile_image(one_track(kPitch, {{"notes", notes}}, track)).image);
    ASSERT_EQ(mono.engine.load_error(), LoadError::None);
    play(mono);
    expect_near(levels(mono, {100, 700, 1200, 1600}), {0.60f, 0.64f, 0.64f, 0.0f});
}

TEST(Play, ANoteComesBackWhenTheOneOverItEnds) {
    const json notes = json::parse(R"([{"tick": 0, "note": 60, "dur": 1440}, {"tick": 480, "note": 64, "dur": 480}])");
    for (const char* mode : {"mono", "legato"}) {
        SCOPED_TRACE(mode);
        json track = {{"play", {{"mode", mode}}}};
        Rig<kStereo> rig(compile_image(one_track(kPitch, {{"notes", notes}}, track)).image);
        play(rig);
        expect_near(levels(rig, {100, 700, 1200, 1600}), {0.60f, 0.64f, 0.60f, 0.0f});
    }
}

TEST(Play, LegatoKeepsTheEnvelopeAndMonoStartsItAgain) {
    const json notes = json::parse(R"([{"tick": 0, "note": 60, "dur": 960}, {"tick": 480, "note": 64, "dur": 960}])");
    const auto swell = [&](const char* mode) {
        json track = {{"play", {{"mode", mode}}}};
        Rig<kStereo> rig(compile_image(one_track(kSwell, {{"notes", notes}}, track)).image);
        play(rig);
        return levels(rig, {479, 490});
    };
    const auto legato = swell("legato"), mono = swell("mono");
    EXPECT_NEAR(legato[1], legato[0] + 0.0104f, 0.002f);
    EXPECT_LT(mono[1], 0.05f + 0.5f * mono[0]);  // The old note's release is short, and only the new attack is left
}

TEST(Play, NotesThatOnlyTouchAreNotLegato) {
    const json notes = json::parse(R"([{"tick": 0, "note": 60, "dur": 480}, {"tick": 480, "note": 64, "dur": 480}])");
    json track = {{"play", {{"mode", "legato"}}}};
    Rig<kStereo> rig(compile_image(one_track(kSwell, {{"notes", notes}}, track)).image);
    play(rig);
    const auto heard = levels(rig, {479, 490});
    EXPECT_GT(heard[0], 0.45f);
    EXPECT_LT(heard[1], 0.05f);
}

TEST(Play, PriorityChoosesAmongHeldNotes) {
    const json notes = json::parse(R"([{"tick": 0, "note": 60, "dur": 1920}, {"tick": 240, "note": 72, "dur": 720},
        {"tick": 480, "note": 64, "dur": 960}])");
    const auto heard = [&](const char* priority) {
        json track = {{"play", {{"mode", "mono"}, {"priority", priority}}}};
        Rig<kStereo> rig(compile_image(one_track(kPitch, {{"notes", notes}}, track)).image);
        play(rig);
        return levels(rig, {100, 300, 600, 1100, 1600, 2000});
    };
    expect_near(heard("last"), {0.60f, 0.72f, 0.64f, 0.64f, 0.60f, 0.0f});
    expect_near(heard("high"), {0.60f, 0.72f, 0.72f, 0.64f, 0.60f, 0.0f});
    expect_near(heard("low"), {0.60f, 0.60f, 0.60f, 0.60f, 0.60f, 0.0f});
}

TEST(Play, GlideSlidesInSemitonesAndLandsExactly) {
    const json notes = json::parse(R"([{"tick": 0, "note": 60, "dur": 960}, {"tick": 480, "note": 72, "dur": 960}])");
    for (const char* mode : {"mono", "legato"}) {
        SCOPED_TRACE(mode);
        json track = {{"play", {{"mode", mode}, {"glide", 0.1}}}};
        Rig<kStereo> rig(compile_image(one_track(kPitch, {{"notes", notes}}, track)).image);
        play(rig);
        // A tenth of a second is 96 ticks.
        expect_near(levels(rig, {479, 528, 600, 1200}), {0.60f, 0.66f, 0.72f, 0.72f}, 0.002f);
    }
}

TEST(Play, GlideAcrossAGapIsMonoOnly) {
    const json notes = json::parse(R"([{"tick": 0, "note": 60, "dur": 240}, {"tick": 480, "note": 72, "dur": 960}])");
    const auto after_gap = [&](const char* mode) {
        json track = {{"play", {{"mode", mode}, {"glide", 0.1}}}};
        Rig<kStereo> rig(compile_image(one_track(kPitch, {{"notes", notes}}, track)).image);
        play(rig);
        return levels(rig, {484})[0];
    };
    EXPECT_NEAR(after_gap("legato"), 0.72f, 1e-4f);
    EXPECT_LT(after_gap("mono"), 0.62f);
}

TEST(Play, PolyGlideSlidesEachNewVoice) {
    const json notes = json::parse(R"([{"tick": 0, "note": 60, "dur": 1440}, {"tick": 480, "note": 72, "dur": 960}])");
    json track = {{"play", {{"mode", "poly"}, {"glide", 0.1}}}};
    Rig<kStereo> rig(compile_image(one_track(kPitch, {{"notes", notes}}, track)).image);
    play(rig);
    expect_near(levels(rig, {100, 528, 600}), {0.60f, 1.26f, 1.32f}, 0.002f);
}

TEST(Play, AClipCanChangeTheModeAndHeldNotesFinishAsTheyStarted) {
    json clip;
    clip["notes"] = json::parse(R"([{"tick": 0, "note": 60, "dur": 1200}, {"tick": 240, "note": 64, "dur": 960},
        {"tick": 960, "note": 67, "dur": 960}, {"tick": 1440, "note": 72, "dur": 240}])");
    clip["play"] = json::parse(R"([{"tick": 480, "mode": "mono"}])");
    Rig<kStereo> rig(compile_image(one_track(kPitch, clip)).image);
    ASSERT_EQ(rig.engine.load_error(), LoadError::None);
    play(rig);
    // The two poly notes keep sounding under the first mono note, and the second mono note replaces it.
    expect_near(levels(rig, {300, 1000, 1500, 1800}), {1.24f, 1.91f, 0.72f, 0.67f});
}

TEST(Play, ALocateKeepsTheModeAndTheLastNote) {
    const json notes = json::parse(R"([{"tick": 0, "note": 60, "dur": 240}, {"tick": 480, "note": 72, "dur": 960}])");
    json track = {{"play", {{"mode", "mono"}, {"glide", 0.1}}}};
    Rig<kStereo> rig(compile_image(one_track(kPitch, {{"notes", notes}}, track)).image);
    play(rig);
    (void)first_samples(rig, 4);
    rig.engine.send({.kind = EventKind::Locate, .tick = 300});
    const auto heard = first_samples(rig, frame_at(250));
    EXPECT_LT(heard[frame_at(184)], 0.62f) << "the glide starts from a note that played before the locate";
}

TEST(Play, LiveNotesFollowTheModeBeforeTheTransportStarts) {
    json request = one_track(kPitch, {{"notes", one_note(1)}}, {{"play", {{"mode", "legato"}}}});
    request["live"] = true;
    Rig<kStereo> rig(compile_image(request).image);
    ASSERT_EQ(rig.engine.load_error(), LoadError::None);
    const auto note = [&](EventKind kind, u8 pitch) {
        rig.engine.send({.kind = kind, .note = pitch, .velocity = 100});
    };
    note(EventKind::NoteOn, 60);
    EXPECT_NEAR(first_samples(rig, 2)[1], 0.60f, 1e-5f);
    note(EventKind::NoteOn, 64);
    EXPECT_NEAR(first_samples(rig, 2)[1], 0.64f, 1e-5f);
    EXPECT_EQ(rig.engine.active_voices(), 1u);
    note(EventKind::NoteOff, 64);
    EXPECT_NEAR(first_samples(rig, 2)[1], 0.60f, 1e-5f);
    note(EventKind::NoteOff, 60);
    EXPECT_NEAR(first_samples(rig, 2)[1], 0.0f, 1e-5f);
    EXPECT_EQ(rig.engine.active_voices(), 0u);
}

TEST(Play, MoreHeldNotesThanItRemembersDropTheOldestSilently) {
    json notes = json::array();
    for (u32 i = 0; i < 2 * kMaxHeldNotes; ++i) {
        notes.push_back({{"tick", i * 10}, {"note", 40 + i}, {"dur", 1000 - i * 10}});
    }
    json track = {{"play", {{"mode", "mono"}, {"priority", "low"}}}};
    Rig<kStereo> rig(compile_image(one_track(kPitch, {{"notes", notes}}, track)).image);
    play(rig);
    const auto heard = levels(rig, {50, 990, 1100});
    EXPECT_NEAR(heard[0], 0.40f, 1e-5f);
    EXPECT_NEAR(heard[2], 0.0f, 1e-5f);
    EXPECT_EQ(rig.engine.active_voices(), 0u);
    EXPECT_EQ(rig.engine.guard_trips(), 0u);
}

TEST(Play, StoppingLeavesNothingHeld) {
    const json notes = json::parse(R"([{"tick": 0, "note": 60, "dur": 960}, {"tick": 100, "note": 64, "dur": 960}])");
    Rig<kStereo> rig(compile_image(one_track(kPitch, {{"notes", notes}}, {{"play", {{"mode", "mono"}}}})).image);
    play(rig);
    (void)first_samples(rig, frame_at(300));
    rig.engine.send({.kind = EventKind::Stop});
    (void)first_samples(rig, 4);
    EXPECT_EQ(rig.engine.active_voices(), 0u);
    rig.engine.send({.kind = EventKind::Play});
    (void)first_samples(rig, frame_at(1200));
    EXPECT_EQ(rig.engine.active_voices(), 0u) << "the rest of the stream runs, and nothing is left sounding";
}

TEST(Play, ASwapToAPolyProgramLetsTheLineEndAtItsTick) {
    const json notes = json::parse(R"([{"tick": 0, "note": 60, "dur": 960}, {"tick": 480, "note": 64, "dur": 960}])");
    const auto mono = compile_image(one_track(kPitch, {{"notes", notes}}, {{"play", {{"mode", "mono"}}}})).image;
    const auto poly = compile_image(one_track(kPitch, {{"notes", notes}})).image;
    Rig<kStereo> rig(mono);
    play(rig);
    (void)first_samples(rig, frame_at(600));
    EXPECT_EQ(rig.engine.active_voices(), 1u);
    rig.swap_to(poly);
    (void)first_samples(rig, frame_at(1600));
    EXPECT_EQ(rig.engine.generation(), 2u);
    EXPECT_EQ(rig.engine.active_voices(), 0u) << "a line voice must not be left held by a Program with no line";
}

TEST(Play, ASwapBetweenMonoProgramsKeepsTheLine) {
    const json notes = json::parse(R"([{"tick": 0, "note": 60, "dur": 1440}, {"tick": 480, "note": 64, "dur": 480}])");
    const auto first = compile_image(one_track(kPitch, {{"notes", notes}}, {{"play", {{"mode", "legato"}}}})).image;
    json track = {{"play", {{"mode", "legato"}}}, {"gain", 1.0001}};
    const auto second = compile_image(one_track(kPitch, {{"notes", notes}}, track)).image;
    Rig<kStereo> rig(first);
    play(rig);
    (void)first_samples(rig, frame_at(600));
    rig.swap_to(second);
    const auto heard = first_samples(rig, frame_at(1000));
    EXPECT_NEAR(heard[frame_at(100)], 0.64f, 2e-3f);
    EXPECT_NEAR(heard[frame_at(600)], 0.60f, 2e-3f) << "the held note comes back after the swap";
    EXPECT_NEAR(heard[frame_at(950)], 0.0f, 1e-5f);
}

namespace {

std::string base64(const std::vector<float>& samples) {
    static constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::vector<unsigned char> bytes(samples.size() * sizeof(float));
    std::memcpy(bytes.data(), samples.data(), bytes.size());
    std::string out;
    for (std::size_t i = 0; i < bytes.size(); i += 3) {
        const u32 left = bytes.size() - i;
        const u32 word = static_cast<u32>(bytes[i]) << 16 | (left > 1 ? static_cast<u32>(bytes[i + 1]) << 8 : 0) |
                         (left > 2 ? bytes[i + 2] : 0);
        out += alphabet[word >> 18 & 63];
        out += alphabet[word >> 12 & 63];
        out += left > 1 ? alphabet[word >> 6 & 63] : '=';
        out += left > 2 ? alphabet[word & 63] : '=';
    }
    return out;
}

json asset(const std::vector<float>& samples, u32 loop_start = 0, u32 loop_end = 0) {
    return {{"encoding", "f32"},        {"channels", 1},        {"frames", samples.size()}, {"rate", 48000.0},
            {"loop_start", loop_start}, {"loop_end", loop_end}, {"root_key", 60},           {"data", base64(samples)}};
}

// 0, 0.001, 0.002 and on, so a sample says where in the recording it came from.
std::vector<float> ramp_samples() {
    std::vector<float> out(1000);
    for (u32 i = 0; i < out.size(); ++i) out[i] = static_cast<float>(i) * 0.001f;
    return out;
}

json sampler(const json& sample) {
    json graph = json::parse(R"({"nodes": [{"id": 2, "type": "out"}],
        "edges": [{"from": 1, "port": "l", "to": 2, "input": "l"}]})");
    json node = sample;
    node["id"] = 1;
    node["type"] = "sample";
    node["mode"] = "zones";
    graph["nodes"].push_back(node);
    return graph;
}

json sampled(const json& sample, const json& assets, const json& notes, const json& track = json::object()) {
    json request = one_track(kFlat, {{"notes", notes}}, track);
    request["patches"]["p"]["graph"] = sampler(sample);
    request["assets"] = assets;
    return request;
}

// Every sample, left channel, as the voice goes.
template <class R>
std::vector<float> samples_of(R& rig, u32 frames) {
    std::vector<float> out(frames * kFrame);
    float right[kFrame];
    for (u32 f = 0; f < frames; ++f) rig.engine.render({out.data() + f * kFrame, right});
    return out;
}

const json kRampZone = json::parse(R"({"zones": [{"asset": "ramp"}]})");

}  // namespace

TEST(Sample2, ZonesPickByKeyAndVelocity) {
    json assets = {{"low", asset(std::vector<float>(64, 0.1f))},
                   {"soft", asset(std::vector<float>(64, 0.2f))},
                   {"hard", asset(std::vector<float>(64, 0.3f))}};
    json sample;
    sample["zones"] = json::parse(R"([{"asset": "low", "keys": [0, 59]},
        {"asset": "soft", "keys": [60, 127], "velocities": [0, 100]},
        {"asset": "hard", "keys": [60, 127], "velocities": [101, 127]}])");
    const auto level = [&](int note, int velocity) {
        json notes = json::array({{{"tick", 0}, {"note", note}, {"vel", velocity}, {"dur", 960}}});
        Rig<kStereo> rig(compile_image(sampled(sample, assets, notes)).image);
        EXPECT_EQ(rig.engine.load_error(), LoadError::None);
        play(rig);
        return first_samples(rig, 2)[0];
    };
    EXPECT_NEAR(level(48, 100), 0.1f, 1e-6f);
    EXPECT_NEAR(level(60, 100), 0.2f, 1e-6f);
    EXPECT_NEAR(level(60, 101), 0.3f, 1e-6f);
}

TEST(Sample2, ANoteNoZoneCoversIsSilentAndEnds) {
    json assets = {{"a", asset(std::vector<float>(64, 0.5f))}};
    json sample;
    sample["zones"] = json::parse(R"([{"asset": "a", "keys": [70, 80]}])");
    Rig<kStereo> rig(compile_image(sampled(sample, assets, one_note(10))).image);
    play(rig);
    const auto audio = samples_of(rig, frame_at(40));
    EXPECT_EQ(peak(audio), 0.0f);
    EXPECT_EQ(rig.engine.active_voices(), 0u);
}

TEST(Sample2, EachZoneHasItsOwnRoot) {
    json assets = {{"ramp", asset(ramp_samples())}};
    json sample;
    sample["zones"] = json::parse(R"([{"asset": "ramp", "root": 48}])");
    Rig<kStereo> rig(compile_image(sampled(sample, assets, one_note())).image);
    play(rig);
    const auto audio = samples_of(rig, 4);
    EXPECT_NEAR(audio[10] - audio[9], 0.002f, 1e-4f) << "an octave above its root plays at twice the speed";
}

TEST(Sample2, StartAndReverseCountFromWherePlaybackBegins) {
    json assets = {{"ramp", asset(ramp_samples())}};
    json sample = kRampZone;
    sample["inputs"] = {{"start", 0.5}};
    Rig<kStereo> forward(compile_image(sampled(sample, assets, one_note())).image);
    play(forward);
    EXPECT_NEAR(samples_of(forward, 1)[1], 0.5005f, 2e-3f);

    json reversed = kRampZone;
    reversed["reverse"] = true;
    Rig<kStereo> backward(compile_image(sampled(reversed, assets, one_note())).image);
    play(backward);
    const auto audio = samples_of(backward, 1);
    EXPECT_NEAR(audio[0], 0.999f, 1e-5f);
    EXPECT_NEAR(audio[1], 0.998f, 1e-5f);

    reversed["inputs"] = {{"start", 0.25}};
    Rig<kStereo> offset(compile_image(sampled(reversed, assets, one_note())).image);
    play(offset);
    EXPECT_NEAR(samples_of(offset, 1)[0], 0.74925f, 2e-3f);
}

TEST(Sample2, AOneShotOutlivesItsNoteAndThenEnds) {
    for (const bool reverse : {false, true}) {
        SCOPED_TRACE(reverse);
        json sample = kRampZone;
        sample["reverse"] = reverse;
        Rig<kStereo> rig(compile_image(sampled(sample, {{"ramp", asset(ramp_samples())}}, one_note(2))).image);
        play(rig);
        (void)samples_of(rig, 10);  // Past the note, which is 100 samples
        EXPECT_EQ(rig.engine.active_voices(), 1u);
        (void)samples_of(rig, 25);  // Past the recording, which is 1000
        EXPECT_EQ(rig.engine.active_voices(), 0u);
    }
}

TEST(Sample2, ALoopWithoutATailEndsWithTheVoice) {
    json assets = {{"ramp", asset(ramp_samples(), 100, 200)}};
    Rig<kStereo> rig(compile_image(sampled(kRampZone, assets, one_note(100))).image);
    play(rig);
    const auto audio = samples_of(rig, frame_at(80));
    for (u32 i = 300; i < 4000; ++i) EXPECT_LE(audio[i], 0.2f) << i;
    EXPECT_GT(peak(audio), 0.19f);
    (void)samples_of(rig, frame_at(40));
    EXPECT_EQ(rig.engine.active_voices(), 0u) << "with no envelope it ends on release, and a loop can't hold it open";
}

TEST(Sample2, ALoopWithATailPlaysOnFromTheReleaseToTheEnd) {
    json assets = {{"ramp", asset(ramp_samples(), 100, 200)}};
    json sample = kRampZone;
    sample["tail"] = true;
    Rig<kStereo> rig(compile_image(sampled(sample, assets, one_note(20))).image);
    play(rig);
    const auto audio = samples_of(rig, frame_at(20) + 2);
    EXPECT_LE(peak({audio.data(), 900}), 0.2f) << "held, it stays in the loop";
    EXPECT_EQ(rig.engine.active_voices(), 1u);
    const auto rest = samples_of(rig, 40);
    EXPECT_GT(peak(rest), 0.95f) << "released, it runs on to the last frame";
    EXPECT_EQ(rig.engine.active_voices(), 0u);
}

TEST(Sample2, ReverseLoopsBackwardsAndLeavesForTheStart) {
    json assets = {{"ramp", asset(ramp_samples(), 100, 200)}};
    json sample = kRampZone;
    sample["reverse"] = true;
    sample["tail"] = true;
    Rig<kStereo> rig(compile_image(sampled(sample, assets, one_note(40))).image);
    play(rig);
    const auto audio = samples_of(rig, frame_at(40) - 2);
    EXPECT_GT(audio[0], 0.9f) << "it starts at the end of the recording";
    for (u32 i = 1000; i < audio.size(); ++i) {
        EXPECT_GE(audio[i], 0.1f) << i;
        EXPECT_LE(audio[i], 0.2f) << i;
    }
    float lowest = 1.0f;
    for (const float x : samples_of(rig, 12)) lowest = std::min(lowest, x);
    EXPECT_LT(lowest, 0.01f) << "after the release it runs back to the first frame";
    (void)samples_of(rig, 2);
    EXPECT_EQ(rig.engine.active_voices(), 0u);
}

TEST(Sample2, ANoteStartsOnItsSample) {
    json assets = {{"a", asset(std::vector<float>(4096, 0.5f))}};
    json sample;
    sample["zones"] = json::parse(R"([{"asset": "a"}])");
    json notes = json::array({{{"tick", 1}, {"note", 60}, {"dur", 100}}});
    Rig<kStereo> rig(compile_image(sampled(sample, assets, notes)).image);
    play(rig);
    const auto audio = samples_of(rig, 3);
    EXPECT_EQ(audio[49], 0.0f);
    EXPECT_EQ(audio[50], 0.5f);
}

TEST(Sample2, LegatoKeepsTheZoneAndMovesThePitch) {
    json assets = {{"ramp", asset(ramp_samples())}, {"other", asset(std::vector<float>(1000, 1.0f))}};
    json sample;
    sample["zones"] = json::parse(R"([{"asset": "ramp", "keys": [0, 60], "root": 60},
        {"asset": "other", "keys": [61, 127]}])");
    const json notes = json::parse(R"([{"tick": 0, "note": 60, "dur": 12}, {"tick": 4, "note": 72, "dur": 12}])");
    Rig<kStereo> rig(compile_image(sampled(sample, assets, notes, {{"play", {{"mode", "legato"}}}})).image);
    play(rig);
    const auto audio = samples_of(rig, 16);
    EXPECT_NEAR(audio[100] - audio[99], 0.001f, 1e-4f);
    EXPECT_NEAR(audio[400] - audio[399], 0.002f, 1e-4f) << "the note moved the pitch";
    EXPECT_LT(peak(audio), 0.9f) << "and not the recording";
}

TEST(Sample2, GlideDoesNotChooseAZoneFromWhereItStarted) {
    json assets = {{"low", asset(std::vector<float>(4096, 0.25f))}, {"high", asset(std::vector<float>(4096, 0.75f))}};
    json sample;
    sample["zones"] =
        json::parse(R"([{"asset": "low", "keys": [0, 60], "root": 40}, {"asset": "high", "keys": [61, 127]}])");
    const json notes = json::parse(R"([{"tick": 0, "note": 40, "dur": 100}, {"tick": 200, "note": 80, "dur": 100}])");
    json track = {{"play", {{"mode", "mono"}, {"glide", 0.05}}}};
    Rig<kStereo> rig(compile_image(sampled(sample, assets, notes, track)).image);
    play(rig);
    EXPECT_NEAR(levels(rig, {50, 205})[1], 0.75f, 1e-5f);
}

TEST(Sample2, ALiveSwapToAShorterTableStopsTheVoice) {
    json many = {{"a", asset(std::vector<float>(4096, 0.5f))}};
    json four, three;
    four["zones"] = json::parse(R"([{"asset": "a", "keys": [0, 1]}, {"asset": "a", "keys": [2, 3]},
        {"asset": "a", "keys": [4, 5]}, {"asset": "a", "keys": [6, 127]}])");
    three["zones"] = json::parse(R"([{"asset": "a", "keys": [0, 1]}, {"asset": "a", "keys": [2, 3]},
        {"asset": "a", "keys": [4, 5]}])");
    json one = three;
    one["zones"].erase(1);
    one["zones"].erase(1);
    for (const json& shorter : {three, one}) {
        Rig<kStereo> rig(compile_image(sampled(four, many, one_note())).image);
        play(rig);
        (void)samples_of(rig, 10);
        rig.swap_to(compile_image(sampled(shorter, many, one_note())).image);
        (void)samples_of(rig, 200);
        EXPECT_EQ(rig.engine.guard_trips(), 0u);
    }
}

TEST(Sample2, AMonoEngineFoldsAStereoAsset) {
    json stereo = asset(std::vector<float>(64, 0.0f));
    std::vector<float> samples;
    for (u32 i = 0; i < 64; ++i) {
        samples.push_back(0.2f);
        samples.push_back(0.6f);
    }
    stereo["channels"] = 2;
    stereo["data"] = base64(samples);
    json sample;
    sample["zones"] = json::parse(R"([{"asset": "s"}])");
    const auto image = compile_image(sampled(sample, {{"s", stereo}}, one_note())).image;
    Rig<kMono> rig(image);
    ASSERT_EQ(rig.engine.load_error(), LoadError::None);
    play(rig);
    float out[kMono.frame_size];
    rig.engine.render({out});
    EXPECT_NEAR(out[0], 0.2f, 1e-6f) << "(0.2 + 0.6) / 2, and the track's hard left pan halves that again";
}

namespace {

constexpr u32 kFadeFrames = 2048 / kFrame + 1;  // Until then the old generation is still heard, at its own legal values
constexpr u32 kRampFrames = static_cast<u32>(kRate) / kFrame;

// A patch that plays one parameter, so what a test hears is the parameter itself. A set takes `smooth_ms` to arrive.
std::vector<std::byte> carried(float low, float high, float initial, const char* scope = "track", u32 smooth_ms = 0) {
    json graph = json::parse(R"({"nodes": [{"id": 1, "type": "param", "param": 1}, {"id": 2, "type": "out"}],
        "edges": [{"from": 1, "to": 2, "input": "l"}]})");
    const json param = {
        {"id", 1}, {"min", low}, {"max", high}, {"default", initial}, {"scope", scope}, {"smooth_ms", smooth_ms}};
    graph["params"] = json::array({param});
    const json held = json::parse(R"([{"tick": 0, "note": 60, "dur": 3840}])");
    return compile_image(one_track(graph.dump().c_str(), {{"notes", held}})).image;
}

// Starts a one second ramp to `value`, and leaves it `done` frames along.
template <class R>
void start_ramp(R& rig, float value, u32 done) {
    ASSERT_EQ(rig.engine.load_error(), LoadError::None);
    play(rig);
    (void)first_samples(rig, 2);
    rig.engine.send({.kind = EventKind::SetParam, .target = 0, .param = 1, .value = value});
    (void)first_samples(rig, done);
}

// Rendering binds a load a step at a time, with the old generation still running. This does all of that before the next
// frame, which commits it, so a test knows the frame its fade began. pump() stays true until then, so it can't be the
// test.
template <class R>
void swap_now(R& rig, const std::vector<std::byte>& image) {
    rig.swap_to(image);
    for (u32 i = 0; i < 4096; ++i) (void)rig.engine.pump(1 << 16);
    (void)first_samples(rig, 1);
    ASSERT_EQ(rig.engine.load_error(), LoadError::None);
    ASSERT_EQ(rig.engine.generation(), 2u);
}

}  // namespace

TEST(Swap, ACarriedValueStaysInsideTheNewRange) {
    struct Case {
        const char* scope;
        float from, heard;
    };
    for (const Case c : {Case{"track", 8.0f, 1.0f}, Case{"track", -8.0f, 0.0f}, Case{"voice", 8.0f, 1.0f},
                         Case{"voice", -8.0f, 0.0f}, Case{"global", 8.0f, 1.0f}, Case{"global", -8.0f, 0.0f}}) {
        Rig<kStereo> rig(carried(-8.0f, 8.0f, c.from, c.scope));
        ASSERT_EQ(rig.engine.load_error(), LoadError::None);
        play(rig);
        EXPECT_EQ(first_samples(rig, 4)[3], c.from);
        swap_now(rig, carried(0.0f, 1.0f, 0.5f, c.scope));
        EXPECT_EQ(first_samples(rig, kFadeFrames).back(), c.heard) << c.scope << " from " << c.from;
    }
}

TEST(Swap, ACarriedRampHeadingPastTheRangeEndsAtItsLimitOnTime) {
    constexpr u32 done = 100;
    Rig<kStereo> rig(carried(0.0f, 8.0f, 0.0f, "track", 1000));
    start_ramp(rig, 8.0f, done);
    const float from = 8.0f * done / kRampFrames;
    ASSERT_LT(from, 1.0f) << "the ramp must still be inside the new range for this to test its target";

    swap_now(rig, carried(0.0f, 1.0f, 0.0f, "track", 1000));
    const u32 left = kRampFrames - done;
    const auto heard = first_samples(rig, left + 16);
    EXPECT_LE(peak(heard), 1.0f);
    EXPECT_NEAR(heard[left / 2], (from + 1.0f) / 2, 0.01f) << "it must take the time it had left, at a new slope";
    EXPECT_LT(heard[left - 8], 1.0f);
    EXPECT_EQ(heard[left + 8], 1.0f);
}

TEST(Swap, ACarriedRampFromPastTheRangeDoesNotOvershootItsTarget) {
    constexpr u32 done = 100;
    Rig<kStereo> rig(carried(0.0f, 8.0f, 8.0f, "track", 1000));
    start_ramp(rig, 0.0f, done);
    swap_now(rig, carried(0.0f, 1.0f, 0.5f, "track", 1000));

    const u32 left = kRampFrames - done;
    const auto heard = first_samples(rig, left + 16);
    for (u32 f = kFadeFrames; f < heard.size(); ++f) {
        ASSERT_GE(heard[f], 0.0f) << f;
        ASSERT_LE(heard[f], 1.0f) << f;
    }
    EXPECT_NEAR(heard[left / 2], 0.5f, 0.01f) << "it must start at the limit and take the time it had left";
    EXPECT_GT(heard[left - 8], 0.0f);
    EXPECT_EQ(heard[left + 8], 0.0f);
}

TEST(Swap, ACarriedRampInsideTheRangeIsNotDisturbed) {
    const auto image = carried(0.0f, 8.0f, 0.0f, "track", 1000);
    Rig<kStereo> rig(image), reference(image);
    start_ramp(rig, 3.3f, 100);  // A step that rounds differently if it is worked out again from here, as most don't
    start_ramp(reference, 3.3f, 100);
    swap_now(rig, image);
    (void)first_samples(reference, 1);  // The frame that committed it
    auto heard = first_samples(rig, kRampFrames);
    auto expected = first_samples(reference, kRampFrames);
    heard.erase(heard.begin(), heard.begin() + kFadeFrames);
    expected.erase(expected.begin(), expected.begin() + kFadeFrames);
    EXPECT_EQ(heard, expected) << "the same image and the same range, so not one bit may move";
}

TEST(Swap, ALiveGlobalCarries) {
    const auto image = carried(0.0f, 1.0f, 0.25f, "global");
    Rig<kStereo> rig(image);
    ASSERT_EQ(rig.engine.load_error(), LoadError::None);
    play(rig);
    rig.engine.send({.kind = EventKind::SetParam, .target = 0, .param = 1, .value = 0.75f});
    EXPECT_EQ(first_samples(rig, 4)[3], 0.75f);
    swap_now(rig, image);
    EXPECT_EQ(first_samples(rig, kFadeFrames).back(), 0.75f);
}

TEST(Swap, ACarriedGlobalFitsEveryPatchThatDeclaresIt) {
    const auto with_second = [](float high) {
        json clip = {{"notes", one_note()}};
        json request = one_track(knob("global", 0.0f, 8.0f, 0.25f).c_str(), clip, {{"slots", {"p", "narrow"}}});
        request["patches"]["narrow"] = {{"name", "narrow"}, {"graph", json::parse(knob("global", 0.0f, high, 0.25f))}};
        request["programs"][0]["timeline"]["clips"][0]["notes"] =
            json::parse(R"([{"tick": 0, "note": 60, "dur": 3840}, {"tick": 3000, "note": 61, "dur": 9, "slot": 1}])");
        return compile_image(request).image;
    };
    Rig<kStereo> rig(with_second(8.0f));
    ASSERT_EQ(rig.engine.load_error(), LoadError::None);
    play(rig);
    rig.engine.send({.kind = EventKind::SetParam, .target = 0, .param = 1, .value = 6.0f});
    EXPECT_EQ(first_samples(rig, 4)[3], 6.0f);
    swap_now(rig, with_second(2.0f));
    EXPECT_EQ(first_samples(rig, kFadeFrames).back(), 2.0f);
}

namespace {

// Register 0 is a hard left track's gain to master, so a test hears it through a constant.
constexpr char kQuiet[] = R"({"nodes": [{"id": 1, "type": "const", "value": 0.25}, {"id": 2, "type": "out"}],
    "edges": [{"from": 1, "to": 2, "input": "l"}]})";

template <class R>
void move_fader(R& rig, float gain) {
    ASSERT_EQ(rig.engine.load_error(), LoadError::None);
    play(rig);
    rig.engine.send({.kind = EventKind::SetMix, .param = 0, .value = gain});
    EXPECT_EQ(first_samples(rig, 4)[3], 0.5f * gain);
}

json held_note() { return {{"notes", one_note()}}; }

}  // namespace

TEST(Swap, ALiveFaderCarriesToTheSameMixer) {
    Rig<kStereo> rig(compile_image(one_track(kFlat, held_note())).image);
    move_fader(rig, 0.5f);
    swap_now(rig, compile_image(one_track(kQuiet, held_note())).image);
    EXPECT_EQ(first_samples(rig, kFadeFrames).back(), 0.125f) << "the patch changed and the mixer did not";
}

TEST(Swap, AFaderTheEditMovedTakesTheNewValue) {
    Rig<kStereo> rig(compile_image(one_track(kFlat, held_note())).image);
    move_fader(rig, 0.5f);
    swap_now(rig, compile_image(one_track(kFlat, held_note(), {{"gain", 0.5}})).image);
    EXPECT_EQ(first_samples(rig, kFadeFrames).back(), 0.25f);
    Rig<kStereo> louder(compile_image(one_track(kFlat, held_note())).image);
    move_fader(louder, 0.5f);
    swap_now(louder, compile_image(one_track(kFlat, held_note(), {{"gain", 0.75}})).image);
    EXPECT_EQ(first_samples(louder, kFadeFrames).back(), 0.375f) << "the new document, not the old live value";
}

TEST(Swap, ARegisterMeansNothingToAnotherMixer) {
    Rig<kStereo> rig(compile_image(one_track(kFlat, held_note())).image);
    move_fader(rig, 0.5f);
    const json send = {{"sends", json::parse(R"([{"bus": "wet", "gain": 0}])")}};
    const json bus = {{"buses", json::parse(R"([{"id": "wet", "pan": -1}])")}};
    swap_now(rig, compile_image(one_track(kFlat, held_note(), send, bus)).image);
    EXPECT_EQ(first_samples(rig, kFadeFrames).back(), 0.5f) << "its registers are not these, so it starts as written";
}

TEST(Swap, AMixRampCarries) {
    json clip = {{"notes", one_note(96000)}, {"length", 96000}};
    clip["automation"] =
        json::parse(R"([{"target": {"mix": "fader", "track": 1}, "tick": 0, "value": 0, "ramp": 9600}])");
    const auto image = compile_image(one_track(kFlat, clip)).image;
    Rig<kStereo> rig(image), reference(image);
    ASSERT_EQ(rig.engine.load_error(), LoadError::None);
    play(rig);
    play(reference);
    (void)first_samples(rig, 100);
    (void)first_samples(reference, 100);
    swap_now(rig, image);
    (void)first_samples(reference, 1);  // The frame that committed it
    auto heard = first_samples(rig, 400);
    auto expected = first_samples(reference, 400);
    heard.erase(heard.begin(), heard.begin() + kFadeFrames);
    expected.erase(expected.begin(), expected.begin() + kFadeFrames);
    EXPECT_EQ(heard, expected);
}

TEST(Swap, AMixRampLandsWhereTheNewProgramCannotFinishIt) {
    json clip = {{"notes", one_note()}};
    clip["automation"] =
        json::parse(R"([{"target": {"mix": "fader", "track": 1}, "tick": 0, "value": 0.5, "ramp": 2400}])");
    Rig<kStereo> rig(compile_image(one_track(kFlat, clip)).image);
    ASSERT_EQ(rig.engine.load_error(), LoadError::None);
    play(rig);
    (void)first_samples(rig, 100);
    swap_now(rig, compile_image(one_track(kFlat, held_note())).image);
    EXPECT_EQ(first_samples(rig, kFadeFrames).back(), 0.25f);
}

namespace {

// Patches that sound an LFO as it is, so a test hears its phase. It runs through about 1/37 of a turn in a frame.
constexpr char kSharedLfo[] = R"({"nodes": [{"id": 1, "type": "lfo", "inputs": {"rate": 40, "depth": 0.5}},
    {"id": 2, "type": "out"}], "edges": [{"from": 1, "to": 2, "input": "l"}]})";
constexpr char kLfoWithDepth[] = R"({"params": [{"id": 1, "min": 0, "max": 1, "default": 1, "smooth_ms": 0}],
    "nodes": [{"id": 1, "type": "param", "param": 1}, {"id": 2, "type": "lfo", "inputs": {"rate": 40}},
    {"id": 3, "type": "out"}],
    "edges": [{"from": 1, "to": 2, "input": "depth"}, {"from": 2, "to": 3, "input": "l"}]})";
constexpr char kVoiceLfo[] = R"({"nodes": [{"id": 1, "type": "note"}, {"id": 2, "type": "lfo", "inputs": {"rate": 40}},
    {"id": 3, "type": "out"}],
    "edges": [{"from": 1, "port": "velocity", "to": 2, "input": "depth"}, {"from": 2, "to": 3, "input": "l"}]})";

// A track with no notes, as the patch page has, so every note a test wants it plays live.
std::vector<std::byte> live_image(const char* patch) {
    json request = one_track(patch, {{"notes", json::array()}});
    request["live"] = true;
    return compile_image(request).image;
}

template <class R>
void hold_note(R& rig) {
    rig.engine.send({.kind = EventKind::NoteOn, .note = 60, .velocity = 100});
}

// Stop ends a held note, so this plays another to go on hearing the LFO. For the frame the two share they are both
// heard.
template <class R>
void stop_and_hold_note(R& rig) {
    rig.engine.send({.kind = EventKind::Stop});
    hold_note(rig);
    (void)first_samples(rig, 1);
}

template <class R>
void play_and_hold_note(R& rig) {
    ASSERT_EQ(rig.engine.load_error(), LoadError::None);
    play(rig);
    hold_note(rig);
}

std::vector<float> slice(const std::vector<float>& from, u32 first, u32 count) {
    return {from.begin() + first, from.begin() + first + count};
}

}  // namespace

TEST(Lfo, ASharedOneWaitsForPlay) {
    Rig<kStereo> rig(live_image(kSharedLfo));
    ASSERT_EQ(rig.engine.load_error(), LoadError::None);
    hold_note(rig);
    for (const float heard : first_samples(rig, 100)) EXPECT_EQ(heard, 0.0f);
    play(rig);
    const auto moving = first_samples(rig, 20);
    EXPECT_EQ(moving[0], 0.0f);
    EXPECT_GT(moving[9], moving[1]);
}

TEST(Lfo, FramesBeforePlayChangeNothing) {
    const auto image = live_image(kSharedLfo);
    Rig<kStereo> prompt(image), late(image);
    (void)first_samples(late, 37);
    play_and_hold_note(prompt);
    play_and_hold_note(late);
    EXPECT_EQ(first_samples(late, 200), first_samples(prompt, 200));
}

TEST(Lfo, ASharedOneStopsWithTheTransportAndCarriesOnFromThere) {
    const auto image = live_image(kSharedLfo);
    Rig<kStereo> rig(image), never_stopped(image);
    play_and_hold_note(rig);
    play_and_hold_note(never_stopped);
    const auto ahead = first_samples(never_stopped, 150);
    (void)first_samples(rig, 50);
    ASSERT_NE(ahead[50], 0.0f);

    stop_and_hold_note(rig);
    for (const float heard : first_samples(rig, 20)) EXPECT_EQ(heard, ahead[50]);
    play(rig);
    EXPECT_EQ(first_samples(rig, 100), slice(ahead, 50, 100));
}

TEST(Lfo, ADepthChangeIsHeardWhileItHolds) {
    Rig<kStereo> rig(live_image(kLfoWithDepth));
    play_and_hold_note(rig);
    (void)first_samples(rig, 50);
    stop_and_hold_note(rig);
    const float full = first_samples(rig, 1).back();
    ASSERT_NE(full, 0.0f);
    rig.engine.send({.kind = EventKind::SetParam, .target = 0, .param = 1, .value = 0.25f});
    EXPECT_FLOAT_EQ(first_samples(rig, 1).back(), full * 0.25f);
}

// A voice starts with its note, so nothing before that can reach it, and a release outlasts a Stop.
TEST(Lfo, OneInAVoiceBelongsToItsNote) {
    Rig<kStereo> rig(live_image(kVoiceLfo));
    ASSERT_EQ(rig.engine.load_error(), LoadError::None);
    ASSERT_FALSE(rig.engine.playing());
    hold_note(rig);
    const auto heard = first_samples(rig, 20);
    EXPECT_GT(heard[9], heard[1]);
}

TEST(Lfo, ASwapWhileStoppedLeavesItHeld) {
    const auto image = live_image(kSharedLfo);
    Rig<kStereo> rig(image), never_stopped(image);
    play_and_hold_note(rig);
    play_and_hold_note(never_stopped);
    const auto ahead = first_samples(never_stopped, 150);
    (void)first_samples(rig, 50);
    stop_and_hold_note(rig);

    swap_now(rig, image);
    for (const float heard : first_samples(rig, kFadeFrames + 8)) EXPECT_FLOAT_EQ(heard, ahead[50]);
    play(rig);
    EXPECT_EQ(first_samples(rig, 100), slice(ahead, 50, 100));
}

TEST(Lfo, ASwapWhilePlayingLeavesItMoving) {
    const auto image = live_image(kSharedLfo);
    Rig<kStereo> rig(image), never_swapped(image);
    play_and_hold_note(rig);
    play_and_hold_note(never_swapped);
    const auto ahead = first_samples(never_swapped, kFadeFrames + 200);
    (void)first_samples(rig, 50);

    swap_now(rig, image);
    const u32 faded = 51 + kFadeFrames;
    (void)first_samples(rig, kFadeFrames);
    EXPECT_EQ(first_samples(rig, 100), slice(ahead, faded, 100));
}

namespace {

// A sine, muted by a mul before it reaches the output, so what a probe sees can't be the output.
compiler::json probed_request() {
    return compiler::json::parse(R"({
      "patches": {"p": {"name": "p", "graph": {
        "nodes": [
          {"id": 1, "type": "note"}, {"id": 2, "type": "mtof"}, {"id": 3, "type": "osc"},
          {"id": 4, "type": "mul", "inputs": {"b": 0.0}}, {"id": 5, "type": "noise"},
          {"id": 6, "type": "mul", "inputs": {"b": 0.25}}, {"id": 7, "type": "add"}, {"id": 8, "type": "out"}
        ],
        "edges": [
          {"from": 1, "port": "pitch", "to": 2, "input": "in"}, {"from": 2, "to": 3, "input": "freq"},
          {"from": 3, "to": 4, "input": "a"}, {"from": 5, "to": 6, "input": "a"},
          {"from": 4, "to": 7, "input": "a"}, {"from": 6, "to": 7, "input": "b"}, {"from": 7, "to": 8, "input": "l"}
        ]}}},
      "programs": [{"id": "p", "name": "p", "timeline": {"tracks": [{"id": 1, "voices": 4, "slots": ["p"]}]}}],
      "live": true})");
}

template <class R>
void set_probe(R& rig, const compiler::json& port, u16 slot = 0) {
    Event probe{.kind = EventKind::SetProbe, .target = 0, .param = slot};
    probe.tick = port.at("step").get<u32>();
    probe.tick_end = port.at("operand").get<u32>();
    EXPECT_TRUE(rig.engine.send(probe));
}

template <class R>
std::vector<float> next_block(R& rig, u32 slot = 0) {
    std::vector<float> left(kFrame), right(kFrame);
    for (u32 frame = 0; frame < 4 * R::Engine::tap_block / kFrame; ++frame) {
        rig.engine.render({left.data(), right.data()});
        TapBlock block;
        if (rig.engine.tap_take(slot, block)) return {block.data, block.data + block.length};
    }
    return {};
}

}  // namespace

TEST(Probes, SeeANodeWhoseSignalNeverReachesTheOutput) {
    const auto result = compiler::compile_image(probed_request());
    Rig<kStereo> rig(result.image);
    set_probe(rig, result.report.at("sidecar").at("p").at("3").at("ports").at("out"));
    rig.engine.send({.kind = EventKind::NoteOn, .note = 69, .velocity = 100, .target = 0});
    (void)next_block(rig);
    const auto block = next_block(rig);
    ASSERT_FALSE(block.empty());
    float peak = 0.0f;
    for (const float sample : block) peak = std::max(peak, std::fabs(sample));
    EXPECT_NEAR(peak, 1.0f, 0.01f);  // A full sine, which the output has none of
}

TEST(Probes, ReadAScalarAsAFlatLine) {
    const auto result = compiler::compile_image(probed_request());
    Rig<kStereo> rig(result.image);
    set_probe(rig, result.report.at("sidecar").at("p").at("1").at("ports").at("pitch"));
    rig.engine.send({.kind = EventKind::NoteOn, .note = 69, .velocity = 100, .target = 0});
    (void)next_block(rig);
    for (const float sample : next_block(rig)) EXPECT_EQ(sample, 69.0f);
}

TEST(Probes, FollowTheNewestVoice) {
    const auto result = compiler::compile_image(probed_request());
    Rig<kStereo> rig(result.image);
    set_probe(rig, result.report.at("sidecar").at("p").at("1").at("ports").at("pitch"));
    rig.engine.send({.kind = EventKind::NoteOn, .note = 60, .velocity = 100, .target = 0});
    (void)next_block(rig);
    const auto last_of = [&] {
        const auto block = next_block(rig);
        EXPECT_FALSE(block.empty());
        return block.empty() ? 0.0f : block.back();
    };
    EXPECT_EQ(last_of(), 60.0f);
    rig.engine.send({.kind = EventKind::NoteOn, .note = 72, .velocity = 100, .target = 0});
    (void)next_block(rig);
    EXPECT_EQ(last_of(), 72.0f);
    rig.engine.send({.kind = EventKind::NoteOff, .note = 72, .target = 0});
    (void)next_block(rig);
    EXPECT_EQ(last_of(), 60.0f);
}

TEST(Probes, ReadSilenceWithNoVoiceAndKeepCounting) {
    const auto result = compiler::compile_image(probed_request());
    Rig<kStereo> rig(result.image);
    set_probe(rig, result.report.at("sidecar").at("p").at("3").at("ports").at("out"));
    const auto block = next_block(rig);
    ASSERT_EQ(block.size(), Rig<kStereo>::Engine::tap_block);
    for (const float sample : block) EXPECT_EQ(sample, 0.0f);
}

TEST(Probes, LeaveTheSoundAlone) {
    const auto result = compiler::compile_image(probed_request());
    const auto play = [&](bool probed) {
        Rig<kStereo> rig(result.image);
        if (probed) {
            set_probe(rig, result.report.at("sidecar").at("p").at("3").at("ports").at("out"));
            set_probe(rig, result.report.at("sidecar").at("p").at("1").at("ports").at("pitch"), 1);
        }
        rig.engine.send({.kind = EventKind::NoteOn, .note = 69, .velocity = 100, .target = 0});
        return render_stereo(rig, 64);
    };
    EXPECT_EQ(play(true), play(false));
}

TEST(Probes, AWrongTargetIsRefusedAndDeliversNothing) {
    const auto result = compiler::compile_image(probed_request());
    const compiler::json port = result.report.at("sidecar").at("p").at("3").at("ports").at("out");
    const u32 step = port.at("step"), operand_value = port.at("operand");
    const Event bad[] = {
        {.kind = EventKind::SetProbe, .target = 9, .param = 0, .tick = step, .tick_end = operand_value},
        {.kind = EventKind::SetProbe, .channel = 9, .target = 0, .param = 0, .tick = step, .tick_end = operand_value},
        {.kind = EventKind::SetProbe, .target = 0, .param = 0, .tick = 9999, .tick_end = operand_value},
        {.kind = EventKind::SetProbe, .target = 0, .param = 0, .tick = step, .tick_end = 0x10000},
        {.kind = EventKind::SetProbe, .target = 0, .param = 0, .tick = step, .tick_end = operand(Bank::Buffer, 200)},
        {.kind = EventKind::SetProbe, .target = 0, .param = 0, .tick = step, .tick_end = operand(Bank::Voice, 200)},
        {.kind = EventKind::SetProbe, .target = 0, .param = 0, .tick = step, .tick_end = operand(Bank::Track, 200)},
        {.kind = EventKind::SetProbe, .target = 0, .param = 0, .tick = step, .tick_end = operand(Bank::Global, 0)},
        {.kind = EventKind::SetProbe, .target = 0, .param = 0, .tick = step, .tick_end = operand(Bank::Const, 0)},
        {.kind = EventKind::SetProbe, .target = 0, .param = 99, .tick = step, .tick_end = operand_value},
    };
    for (const Event& e : bad) {
        Rig<kStereo> rig(result.image);
        rig.engine.send({.kind = EventKind::NoteOn, .note = 69, .velocity = 100, .target = 0});
        EXPECT_TRUE(rig.engine.send(e));
        EXPECT_TRUE(next_block(rig).empty());
    }
}

TEST(Probes, EndWithTheProgramTheyNamed) {
    const auto result = compiler::compile_image(probed_request());
    Rig<kStereo> rig(result.image);
    set_probe(rig, result.report.at("sidecar").at("p").at("3").at("ports").at("out"));
    EXPECT_FALSE(next_block(rig).empty());
    compiler::json louder = probed_request();
    louder["patches"]["p"]["graph"]["nodes"][5]["inputs"]["b"] = 0.5;
    rig.swap_to(compiler::compile_image(louder).image);
    std::vector<float> left(kFrame), right(kFrame);
    for (u32 frame = 0; frame < 512; ++frame) rig.engine.render({left.data(), right.data()});
    (void)next_block(rig);
    EXPECT_TRUE(next_block(rig).empty());
}

TEST(Probes, ABusTapReplacesOne) {
    const auto result = compiler::compile_image(probed_request());
    const compiler::json master = result.report.at("programs").at(0).at("master");
    Rig<kStereo> rig(result.image);
    set_probe(rig, result.report.at("sidecar").at("p").at("1").at("ports").at("pitch"));
    Event tap{.kind = EventKind::SetTap, .note = master.at("bus").get<u8>(), .target = master.at("step").get<u16>()};
    rig.engine.send(tap);
    rig.engine.send({.kind = EventKind::NoteOn, .note = 69, .velocity = 100, .target = 0});
    (void)next_block(rig);
    for (const float sample : next_block(rig)) EXPECT_NE(sample, 69.0f);
}

// Revision 7: a stolen voice can fade, a legato line can bring its notes' velocities, and Sample3.

TEST(Steal, AFadingStealPlaysTheOldNoteOnAndOutWhileTheNewOneStarts) {
    const json notes = json::parse(R"([{"tick": 0, "note": 60, "dur": 1920}, {"tick": 480, "note": 64, "dur": 960}])");
    const auto heard = [&](const char* steal) {
        Rig<kStereo> rig(compile_image(one_track(kPitch, {{"notes", notes}}, {{"voices", 1}, {"steal", steal}})).image);
        EXPECT_EQ(rig.engine.load_error(), LoadError::None);
        play(rig);
        return samples_of(rig, frame_at(700));
    };
    const auto cut = heard("cut"), faded = heard("fade");
    const u32 at = 480 * 50;  // The sample the second note starts on
    EXPECT_NEAR(cut[at - 1], 0.60f, 1e-5f);
    EXPECT_NEAR(cut[at], 0.64f, 1e-5f) << "cut, the old note stops on the sample the new one starts";
    EXPECT_NEAR(faded[at - 1], 0.60f, 1e-5f);
    EXPECT_NEAR(faded[at], 0.64f + 0.60f * (1.0f - 1.0f / 96.0f), 1e-4f) << "faded, both sound";
    EXPECT_NEAR(faded[at + 48], 0.64f + 0.60f * (1.0f - 49.0f / 96.0f), 1e-4f);
    EXPECT_NEAR(faded[at + 96], 0.64f, 1e-5f) << "2 ms later the old note is gone";
    EXPECT_NEAR(faded[at + 200], cut[at + 200], 1e-6f);
}

TEST(Steal, ATrackFadesInAQuarterOfItsVoicesAndAChordOfStealsTakesThemAll) {
    // Eight held notes on eight voices, then four more at once: two fade slots, so two fade and two are cut.
    json notes = json::array();
    for (int i = 0; i < 8; ++i) notes.push_back({{"tick", 0}, {"note", 40 + i}, {"dur", 1920}});
    for (int i = 0; i < 4; ++i) notes.push_back({{"tick", 480}, {"note", 80 + i}, {"dur", 960}});
    Rig<kStereo> rig(compile_image(one_track(kPitch, {{"notes", notes}}, {{"voices", 8}, {"steal", "fade"}})).image);
    play(rig);
    (void)samples_of(rig, frame_at(480) + 1);
    EXPECT_EQ(rig.engine.active_voices(), 10u);
    (void)samples_of(rig, 8);
    EXPECT_EQ(rig.engine.active_voices(), 8u);
}

TEST(Steal, ALocateSilencesWhatIsFading) {
    const json notes = json::parse(R"([{"tick": 0, "note": 60, "dur": 1920}, {"tick": 480, "note": 64, "dur": 960}])");
    Rig<kStereo> rig(compile_image(one_track(kPitch, {{"notes", notes}}, {{"voices", 1}, {"steal", "fade"}})).image);
    play(rig);
    (void)samples_of(rig, frame_at(480) + 1);
    rig.engine.send({.kind = EventKind::Locate, .tick = 0});
    (void)samples_of(rig, 1);
    EXPECT_EQ(rig.engine.active_voices(), 1u);
}

TEST(Play, ASlurBringsItsVelocityWhenAsked) {
    constexpr char kVelocityOut[] = R"({"nodes": [{"id": 1, "type": "note"}, {"id": 2, "type": "out"}],
        "edges": [{"from": 1, "port": "velocity", "to": 2, "input": "l"}]})";
    const json notes = json::parse(R"([{"tick": 0, "note": 60, "vel": 20, "dur": 960},
        {"tick": 480, "note": 64, "vel": 127, "dur": 960}])");
    const auto heard = [&](bool bring) {
        json play_mode = {{"mode", "legato"}};
        if (bring) play_mode["slur_velocity"] = true;
        Rig<kStereo> rig(compile_image(one_track(kVelocityOut, {{"notes", notes}}, {{"play", play_mode}})).image);
        EXPECT_EQ(rig.engine.load_error(), LoadError::None);
        play(rig);
        return levels(rig, {100, 482, 720});
    };
    expect_near(heard(false), {20.0f / 127.0f, 20.0f / 127.0f, 20.0f / 127.0f});
    const auto brought = heard(true);
    EXPECT_NEAR(brought[0], 20.0f / 127.0f, 1e-6f);
    EXPECT_GT(brought[1], 20.0f / 127.0f) << "on its way";
    EXPECT_LT(brought[1], 1.0f);
    EXPECT_NEAR(brought[2], 1.0f, 1e-6f) << "and there after 5 ms";
}

TEST(Sample3, ARoundRobinTakesTurnsByTheTracksNotes) {
    json assets = {{"a", asset(std::vector<float>(64, 0.1f))},
                   {"b", asset(std::vector<float>(64, 0.2f))},
                   {"c", asset(std::vector<float>(64, 0.3f))}};
    json sample;
    sample["zones"] = json::parse(R"([{"asset": "a", "round_robin": [1, 3]}, {"asset": "b", "round_robin": [2, 3]},
        {"asset": "c", "round_robin": [3, 3]}])");
    json notes = json::array();
    for (int i = 0; i < 4; ++i) notes.push_back({{"tick", i * 240}, {"note", 60}, {"dur", 10}});
    const auto image = compile_image(sampled(sample, assets, notes)).image;
    Rig<kStereo> rig(image);
    ASSERT_EQ(rig.engine.load_error(), LoadError::None);
    play(rig);
    expect_near(levels(rig, {1, 241, 481, 721}), {0.1f, 0.2f, 0.3f, 0.1f}, 1e-6f);

    // A locate counts the notes it passes, so it picks what playing through would have.
    Rig<kStereo> jumped(image);
    play(jumped);
    jumped.engine.send({.kind = EventKind::Locate, .tick = 400});
    expect_near(levels(jumped, {81, 321}), {0.3f, 0.1f}, 1e-6f);
}

TEST(Sample3, LayersCrossfadeInVelocity) {
    json assets = {{"soft", asset(std::vector<float>(64, 0.2f))}, {"loud", asset(std::vector<float>(64, 0.6f))}};
    json sample;
    sample["zones"] = json::parse(R"([{"asset": "soft", "velocities": [0, 100], "fade": [0, 40]},
        {"asset": "loud", "velocities": [60, 127], "fade": [40, 0]}])");
    const auto level = [&](int velocity) {
        json notes = json::array({{{"tick", 0}, {"note", 60}, {"vel", velocity}, {"dur", 960}}});
        Rig<kStereo> rig(compile_image(sampled(sample, assets, notes)).image);
        EXPECT_EQ(rig.engine.load_error(), LoadError::None);
        play(rig);
        return first_samples(rig, 2)[0];
    };
    EXPECT_NEAR(level(40), 0.2f, 1e-6f);
    EXPECT_NEAR(level(70), 0.2f * 0.75f + 0.6f * 0.25f, 1e-6f);
    EXPECT_NEAR(level(80), 0.4f, 1e-6f);
    EXPECT_NEAR(level(120), 0.6f, 1e-6f);
}

TEST(Sample3, AReleaseSamplePlaysWhenItsNoteIsLetGoAndKeepsItsVoiceUntilItEnds) {
    json assets = {{"thud", asset(std::vector<float>(4800, 0.5f))}};
    json sample = {{"release", true}, {"zones", json::parse(R"([{"asset": "thud"}])")}};
    Rig<kStereo> rig(compile_image(sampled(sample, assets, one_note(480))).image);
    ASSERT_EQ(rig.engine.load_error(), LoadError::None);
    play(rig);
    const auto audio = samples_of(rig, frame_at(800));
    EXPECT_EQ(audio[480 * 50 - 1], 0.0f) << "silent while held";
    EXPECT_NEAR(audio[480 * 50], 0.5f, 1e-6f) << "from the sample it is released on";
    EXPECT_NEAR(audio[480 * 50 + 4799], 0.5f, 1e-6f);
    EXPECT_EQ(audio[480 * 50 + 4800], 0.0f);
    (void)samples_of(rig, 4);
    EXPECT_EQ(rig.engine.active_voices(), 0u);
}
