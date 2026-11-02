// PoolExecutor, section 18: the same bits as SerialExecutor with any number of workers, on everything the repo ships,
// and a pool that keeps its own promises when driven directly. CI's ThreadSanitizer job runs this file.

#include <algorithm>
#include <atomic>
#include <cfenv>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <gtest/gtest.h>
#include <random>
#include <sstream>
#include <thread>

#include <modsynth/Parallel.hpp>
#include <modsynth/TestSupport.hpp>

using namespace modsynth_test;
using compiler::compile_image;
using compiler::json;

namespace {

// One pool for each worker count, kept for the whole run, so that Rig can make the executor itself.
template <u32 Workers>
struct Pooled : PoolExecutor<> {
    Pooled() { pool = &shared(); }
    static ThreadPool& shared() {
        static ThreadPool p(Workers);
        return p;
    }
};

constexpr SynthConfig k32{.frame_size = 32, .channels = 2, .tap_slots = 0, .generations = 1};
constexpr SynthConfig k128{.frame_size = 128, .channels = 2, .tap_slots = 0, .generations = 1};
constexpr SynthConfig kMono32{.frame_size = 32, .channels = 1, .tap_slots = 0, .generations = 1};

std::string read(const std::filesystem::path& path) {
    std::ifstream in(path, std::ios::binary);
    std::stringstream text;
    text << in.rdbuf();
    return text.str();
}

std::vector<std::byte> read_image(const std::filesystem::path& path) {
    const std::string text = read(path);
    std::vector<std::byte> bytes(text.size());
    std::memcpy(bytes.data(), text.data(), text.size());
    return bytes;
}

bool same_bits(const std::vector<float>& a, const std::vector<float>& b) {
    return a.size() == b.size() && std::memcmp(a.data(), b.data(), a.size() * sizeof(float)) == 0;
}

template <SynthConfig C, class E>
std::vector<float> render(const std::vector<std::byte>& image, u32 blocks) {
    Rig<C, E> rig(image);
    EXPECT_EQ(rig.engine.load_error(), LoadError::None);
    rig.engine.send({.kind = EventKind::Play});
    std::vector<float> out(blocks * 128 * C.channels);
    for (u32 f = 0; f < blocks * 128 / C.frame_size; ++f) {
        float* left = out.data() + f * C.channels * C.frame_size;
        if constexpr (C.channels == 2) {
            rig.engine.render({left, left + C.frame_size});
        } else {
            rig.engine.render({left});
        }
    }
    return out;
}

// Serial against a pool of 1, which runs inline, and of 2, 3 and 8, which run on threads.
template <SynthConfig C>
void expect_same_on_any_pool(const std::vector<std::byte>& image, u32 blocks, const std::string& name) {
    const auto serial = render<C, SerialExecutor>(image, blocks);
    EXPECT_TRUE(same_bits(serial, render<C, Pooled<1>>(image, blocks))) << name << " on 1 worker";
    EXPECT_TRUE(same_bits(serial, render<C, Pooled<2>>(image, blocks))) << name << " on 2 workers";
    EXPECT_TRUE(same_bits(serial, render<C, Pooled<3>>(image, blocks))) << name << " on 3 workers";
    EXPECT_TRUE(same_bits(serial, render<C, Pooled<8>>(image, blocks))) << name << " on 8 workers";
}

// Twelve tracks, two buses with reverbs, sends, and a ducker keyed on another track, so many tasks can run at once.
json wide_request() {
    json request = demo();
    json& timeline = request["programs"][0]["timeline"];
    const json lead = timeline["tracks"][0];
    const json pluck = timeline["tracks"][1];
    timeline["tracks"] = json::array();
    for (int i = 0; i < 12; ++i) {
        json t = i % 2 == 0 ? lead : pluck;
        t["id"] = i + 1;
        t["voices"] = 2 + i % 5;
        t["pan"] = -0.9 + 0.15 * i;
        t["params"] = json::object();
        t.erase("inserts");
        t["sends"] = {{{"bus", i % 3 == 0 ? "hall" : "room"}, {"gain", 0.2 + 0.05 * i}}};
        if (i == 4) t["inserts"] = {{{"id", 10}, {"patch", "ducker"}, {"key", "track:2"}}};
        timeline["tracks"].push_back(t);
    }
    timeline["buses"] = {{{"id", "room"}, {"inserts", {{{"id", 1}, {"patch", "reverb"}}}}},
                         {{"id", "hall"}, {"inserts", {{{"id", 2}, {"patch", "reverb"}}}}}};
    return request;
}

}  // namespace

TEST(Parallel, EveryRecipeSoundsTheSameOnAnyNumberOfWorkers) {
    u32 recipes = 0;
    for (const auto& entry : std::filesystem::directory_iterator(MODSYNTH_RECIPES)) {
        if (entry.path().filename() == "Index.json") continue;
        const auto compiled = compiler::compile_image_checked(read(entry.path()));
        ASSERT_TRUE(compiled.report.value("ok", false)) << entry.path();
        expect_same_on_any_pool<k32>(compiled.image, 400, entry.path().stem().string());
        ++recipes;
    }
    EXPECT_GE(recipes, 61u);
}

TEST(Parallel, EveryGoldenImageSoundsTheSameOnAnyNumberOfWorkers) {
    for (const auto& name : {"Demo", "AllOps", "Waves", "Tones", "Minimal"}) {
        expect_same_on_any_pool<k128>(
            read_image(std::filesystem::path(MODSYNTH_GOLDEN) / (std::string(name) + ".image")), 400, name);
    }
    for (const auto& name : {"Demo32", "AllOps32", "Waves32", "Tones32", "Lanes", "Zones", "Hold", "Mods"}) {
        expect_same_on_any_pool<k32>(
            read_image(std::filesystem::path(MODSYNTH_GOLDEN) / (std::string(name) + ".image")), 400, name);
    }
}

TEST(Parallel, ManyTracksAndBusesSoundTheSame) {
    const auto compiled = compile_image(wide_request());
    LoadedImage loaded(compiled.image);
    ProgramView p;
    const ChunkRef* c = loaded.table.find(loaded.loader.program_hash(0), ChunkKind::Program);
    ASSERT_TRUE(parse_program({c->data, c->size}, p));
    ASSERT_EQ(p.h.tracks, 12u);  // so that there is something to run side by side
    expect_same_on_any_pool<k32>(compiled.image, 800, "wide");
    expect_same_on_any_pool<kMono32>(compiled.image, 200, "wide, mono");

    const auto audio = render<k32, Pooled<8>>(compiled.image, 800);
    EXPECT_GT(*std::max_element(audio.begin(), audio.end()), 0.01f);
}

// A swap crossfades two generations, and taps copy from inside tasks, so both run on threads here.
TEST(Parallel, ASwapAndTapsSoundTheSame) {
    const auto first = compile_image(wide_request()).image;
    json edited = wide_request();
    edited["programs"][0]["timeline"]["tracks"][3]["gain"] = 0.3;
    edited["programs"][0]["timeline"]["tracks"].erase(5);
    const auto second = compile_image(edited).image;

    // Taps on the master and on the first track's right channel, sent again after a swap, as the browser does.
    const auto tap_events = [](const std::vector<std::byte>& image) {
        LoadedImage loaded(image);
        const ChunkRef* c = loaded.table.find(loaded.loader.program_hash(0), ChunkKind::Program);
        ProgramView p;
        EXPECT_TRUE(parse_program({c->data, c->size}, p));
        return std::array{Event{.kind = EventKind::SetTap,
                                .note = static_cast<u8>(p.h.master),
                                .target = static_cast<u16>(p.h.mix_steps - 1),
                                .param = 0},
                          Event{.kind = EventKind::SetTap,
                                .note = static_cast<u8>(p.mix_step(0).dst),
                                .channel = 1,
                                .target = 0,
                                .param = 1}};
    };
    const auto run = [&]<class E>(E) {
        Rig<kStereo, E> rig(first);
        rig.engine.send({.kind = EventKind::Play});
        for (const Event& e : tap_events(first)) rig.engine.send(e);
        std::vector<float> out, taps;
        u32 generation = rig.engine.generation();
        for (u32 f = 0; f < 1200 * kFramesPerBlock; ++f) {
            if (f == 300 * kFramesPerBlock) rig.swap_to(second);
            float frame[2 * kFrame];
            rig.engine.render({frame, frame + kFrame});
            out.insert(out.end(), frame, frame + 2 * kFrame);
            if (rig.engine.generation() != generation) {
                generation = rig.engine.generation();
                for (const Event& e : tap_events(second)) rig.engine.send(e);
            }
            TapBlock block;
            for (u32 slot = 0; slot < 2; ++slot) {
                if (rig.engine.tap_take(slot, block)) taps.insert(taps.end(), block.data, block.data + block.length);
            }
        }
        EXPECT_EQ(rig.engine.generation(), 2u);
        return std::pair{out, taps};
    };
    const auto serial = run(SerialExecutor{});
    const auto pooled = run(Pooled<4>{});
    EXPECT_TRUE(same_bits(serial.first, pooled.first));
    EXPECT_TRUE(same_bits(serial.second, pooled.second));
    EXPECT_GT(serial.second.size(), 20u * 1024u);
}

TEST(Parallel, TwoEnginesCanShareAPoolFromTwoThreads) {
    const auto image = compile_image(wide_request()).image;
    const auto serial = render<k32, SerialExecutor>(image, 300);
    std::vector<float> a, b;
    std::thread one([&] { a = render<k32, Pooled<4>>(image, 300); });
    std::thread two([&] { b = render<k32, Pooled<4>>(image, 300); });
    one.join();
    two.join();
    EXPECT_TRUE(same_bits(serial, a));
    EXPECT_TRUE(same_bits(serial, b));
}

TEST(Parallel, ExactlyTheMemoryAskedForIsEnough) {
    using Engine = Synth<k32, ScalarBackend, PoolExecutor<>>;
    const auto image = compile_image(wide_request()).image;
    LoadedImage loaded(image);
    const MemorySizes need = Engine::bytes_required(loaded.table, loaded.loader.program_hash(0), kRate);
    const MemorySizes serial = Synth<k32>::bytes_required(loaded.table, loaded.loader.program_hash(0), kRate);
    EXPECT_GT(need.fast, serial.fast);  // edges, per-worker scratch and cache lines
    for (const u64 trim : {0, 64}) {
        alignas(64) static std::byte fast[8 << 20], bulk[8 << 20];
        ASSERT_LE(need.fast, sizeof(fast));
        std::vector<ChunkRef> storage(kMaxChunks);
        ChunkTable chunks(storage);
        ThreadPool pool(3);
        Engine engine({std::span(fast, need.fast - trim), std::span(bulk, need.bulk), kRate}, PoolExecutor<>{&pool});
        const auto words = Rig<k32>::aligned(image);
        engine.load(chunks, {reinterpret_cast<const std::byte*>(words.data()), image.size()});
        while (engine.pump(1 << 16)) {
        }
        EXPECT_EQ(engine.load_error(), trim == 0 ? LoadError::None : LoadError::OutOfMemory);
    }
}

namespace {

// A random graph of tasks with edges only forward, as the engine builds them.
struct Graph {
    std::vector<u16> deps, begin, succ;
    std::vector<std::vector<u32>> preds;
    Schedule schedule() const { return {static_cast<u32>(deps.size()), deps.data(), begin.data(), succ.data()}; }
};

Graph random_graph(std::mt19937& random, u32 count, u32 percent) {
    Graph g;
    g.deps.assign(count, 0);
    g.preds.resize(count);
    for (u32 a = 0; a < count; ++a) {
        g.begin.push_back(static_cast<u16>(g.succ.size()));
        for (u32 b = a + 1; b < count; ++b) {
            if (random() % 100 >= percent) continue;
            g.succ.push_back(static_cast<u16>(b));
            ++g.deps[b];
            g.preds[b].push_back(a);
        }
    }
    g.begin.push_back(static_cast<u16>(g.succ.size()));
    return g;
}

}  // namespace

// Each task reads what its dependencies wrote into plain memory, which ThreadSanitizer checks is ordered.
TEST(Parallel, APoolRunsEachTaskOnceAfterItsDependencies) {
    ThreadPool pool(6);
    std::mt19937 random(7);
    for (u32 round = 0; round < 3000; ++round) {
        const u32 count = 1 + random() % (round % 10 == 0 ? kMaxTasks : 40);
        const Graph g = random_graph(random, count, random() % 30);
        std::vector<u64> value(count, 0);
        std::vector<u32> stamp(count, 0);
        std::vector<std::atomic<u32>> runs(count);
        std::atomic<u32> clock{0}, bad_worker{0};
        auto task = [&](u32 t, u32 worker) {
            u64 sum = t + 1;
            for (const u32 p : g.preds[t]) sum += value[p] * 3;
            value[t] = sum;
            stamp[t] = clock.fetch_add(1) + 1;
            runs[t].fetch_add(1);
            if (worker >= 4) bad_worker.store(1);
        };
        pool.run(g.schedule(), 4, task);  // 4 of the 6 take part

        for (u32 t = 0; t < count; ++t) {
            ASSERT_EQ(runs[t].load(), 1u) << "round " << round << " task " << t;
            u64 expected = t + 1;
            for (const u32 p : g.preds[t]) {
                ASSERT_LT(stamp[p], stamp[t]) << "round " << round;
                expected += value[p] * 3;
            }
            ASSERT_EQ(value[t], expected);
        }
        ASSERT_EQ(bad_worker.load(), 0u);
    }
}

// Rounding and flush-to-zero are per thread, so a worker running with another mode would change the output.
TEST(Parallel, WorkersTakeTheCallersFloatingPointMode) {
    ThreadPool pool(4);
    std::mt19937 random(3);
    const Graph g = random_graph(random, 64, 0);
    std::vector<int> modes(64, 0);
    std::vector<u32> workers(64, 0);
    std::atomic<bool> others{false};
    auto task = [&](u32 t, u32 worker) {
        // Waits a little for another worker, so that the check is about threads other than the caller.
        const auto until = std::chrono::steady_clock::now() + std::chrono::seconds(2);
        if (worker != 0) others.store(true);
        while (!others.load() && std::chrono::steady_clock::now() < until) std::this_thread::yield();
        modes[t] = std::fegetround();
        workers[t] = worker;
    };
    const int before = std::fegetround();
    for (const int mode : {FE_DOWNWARD, FE_TONEAREST, FE_UPWARD}) {
        others.store(false);
        ASSERT_EQ(std::fesetround(mode), 0);
        pool.run(g.schedule(), 16, task);
        ASSERT_EQ(std::fesetround(before), 0);
        EXPECT_TRUE(others.load());
        for (u32 t = 0; t < 64; ++t) EXPECT_EQ(modes[t], mode) << "task " << t << " on worker " << workers[t];
    }
}

TEST(Parallel, APoolCanBeMadeAndDroppedAtAnyPoint) {
    std::mt19937 random(11);
    const Graph g = random_graph(random, 32, 10);
    std::atomic<u32> ran{0};
    auto task = [&](u32, u32) { ran.fetch_add(1); };
    for (u32 i = 0; i < 100; ++i) {
        ThreadPool pool(1 + i % 6);
        for (u32 r = 0; r < i % 3; ++r) pool.run(g.schedule(), 16, task);
        if (i % 4 == 0)
            std::this_thread::sleep_for(std::chrono::microseconds(300));  // long enough for workers to sleep
    }
    u32 expected = 0;
    for (u32 i = 0; i < 100; ++i) expected += 32 * (i % 3);
    EXPECT_EQ(ran.load(), expected);
}

TEST(Parallel, WithNoPoolEveryTaskRunsOnTheCallingThread) {
    const auto image = compile_image(wide_request()).image;
    EXPECT_TRUE(same_bits(render<k32, SerialExecutor>(image, 200), render<k32, PoolExecutor<>>(image, 200)));
}
