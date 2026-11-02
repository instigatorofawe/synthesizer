#include <algorithm>
#include <gtest/gtest.h>
#include <random>
#include <string>

#include <modsynth/TestSupport.hpp>

using namespace modsynth_test;
using compiler::compile_image;
using compiler::compile_patch;
using compiler::CompileError;
using compiler::json;

namespace {

json simple_graph(const char* wave) {
    return json::parse(std::string(R"({
      "nodes": [
        {"id": 1, "type": "note"}, {"id": 2, "type": "mtof"},
        {"id": 3, "type": "osc", "wave": ")") +
                       wave + R"("}, {"id": 4, "type": "out"}
      ],
      "edges": [
        {"from": 1, "port": "pitch", "to": 2, "input": "in"},
        {"from": 2, "to": 3, "input": "freq"},
        {"from": 3, "to": 4, "input": "l"}
      ]})");
}

json one_note_timeline(const char* patch, const char* clip_note = "60") {
    return json::parse(std::string(R"({
      "clips": [{"id": "c", "length": 480, "notes": [{"tick": 0, "note": )") +
                       clip_note + R"(, "dur": 100}]}],
      "tracks": [{"id": 1, "slots": [")" +
                       patch + R"("], "placements": [{"clip": "c", "tick": 0}]}]
    })");
}

// A vector, not json: whether `{one_element}` makes a json array or a copy of that element depends on the compiler.
json request_with(std::initializer_list<const char*> patches, const std::vector<json>& programs) {
    json r;
    r["patches"] = json::object();
    for (const char* id : patches) r["patches"][id] = {{"graph", simple_graph(id)}};
    r["programs"] = programs;
    return r;
}

json program(const char* id, json timeline) { return {{"id", id}, {"name", id}, {"timeline", std::move(timeline)}}; }

std::vector<std::string> patch_ids(const json& report, std::size_t program_index) {
    std::vector<std::string> ids;
    for (const json& p : report.at("programs").at(program_index).at("patches")) ids.push_back(p.at("id"));
    return ids;
}

int count_kind(const json& report, const char* kind) {
    int n = 0;
    for (const json& c : report.at("chunks")) n += c.at("kind") == kind;
    return n;
}

}  // namespace

TEST(CompilePatch, ShuffledGraphsGiveIdenticalBytes) {
    const json demo_project = demo();
    for (const char* id : {"lead", "reverb", "ducker"}) {
        const json& graph = demo_project.at("patches").at(id).at("graph");
        const auto base = compile_patch(graph, id).chunk;
        std::mt19937 rng(7);
        for (int i = 0; i < 50; ++i) {
            json shuffled = graph;
            std::shuffle(shuffled["nodes"].begin(), shuffled["nodes"].end(), rng);
            std::shuffle(shuffled["edges"].begin(), shuffled["edges"].end(), rng);
            EXPECT_EQ(compile_patch(shuffled, id).chunk.hash, base.hash) << id;
        }
    }
}

TEST(CompilePatch, DeadNodesLeaveNoTrace) {
    json graph = simple_graph("saw");
    const u64 base = compile_patch(graph, "p").chunk.hash;
    graph["nodes"].push_back({{"id", 9}, {"type", "noise"}});
    EXPECT_EQ(compile_patch(graph, "p").chunk.hash, base);
}

// Noise into one input of a node, and that node into the output.
json wired_to(const std::string& type, const std::string& input, const std::string& port = "") {
    json consumer = {{"id", 2}, {"type", type}};
    if (type == "osc") consumer["wave"] = "square";
    json edge_out = {{"from", 2}, {"to", 3}, {"input", "l"}};
    if (!port.empty()) edge_out["port"] = port;
    json graph;
    graph["nodes"] = json::array({json{{"id", 1}, {"type", "noise"}}, consumer, json{{"id", 3}, {"type", "out"}}});
    graph["edges"] = json::array({json{{"from", 1}, {"to", 2}, {"input", input}}, edge_out});
    return graph;
}

struct FrameInput {
    const char* type;
    const char* input;
    const char* port;
};
constexpr FrameInput kFrameInputs[] = {
    {"osc", "freq", ""},         {"osc", "width", ""},      {"biquad", "cutoff", ""}, {"biquad", "q", ""},
    {"env", "attack", ""},       {"env", "decay", ""},      {"env", "sustain", ""},   {"env", "release", ""},
    {"mtof", "in", ""},          {"ratio", "in", ""},       {"pan", "position", "l"}, {"delay", "time", ""},
    {"comb", "time", ""},        {"comb", "feedback", ""},  {"comb", "damp", ""},     {"allpass", "time", ""},
    {"allpass", "feedback", ""}, {"follow", "release", ""}, {"lfo", "rate", ""},      {"lfo", "depth", ""},
};

TEST(CompilePatch, AudioCannotReachAnInputReadOnceAFrame) {
    for (const FrameInput& f : kFrameInputs) {
        SCOPED_TRACE(std::string(f.type) + "." + f.input);
        try {
            compile_patch(wired_to(f.type, f.input, f.port), "p");
            ADD_FAILURE() << "compiled";
        } catch (const CompileError& e) {
            EXPECT_NE(std::string(e.what()).find("put a snap node on the wire"), std::string::npos) << e.what();
        }
    }
}

TEST(CompilePatch, ASnapNodeLetsAudioThrough) {
    for (const FrameInput& f : kFrameInputs) {
        SCOPED_TRACE(std::string(f.type) + "." + f.input);
        json graph = wired_to(f.type, f.input, f.port);
        graph["nodes"].push_back({{"id", 4}, {"type", "snap"}});
        graph["edges"][0]["from"] = 4;
        graph["edges"].push_back({{"from", 1}, {"to", 4}, {"input", "in"}});
        EXPECT_NO_THROW(compile_patch(graph, "p"));
    }
}

TEST(CompilePatch, AnEnvelopeIsAudio) {
    const json direct = json::parse(R"({
      "nodes": [{"id": 1, "type": "env"}, {"id": 2, "type": "biquad"}, {"id": 3, "type": "out"}],
      "edges": [{"from": 1, "to": 2, "input": "cutoff"}, {"from": 2, "to": 3, "input": "l"}]})");
    EXPECT_THROW(compile_patch(direct, "p"), CompileError);

    const json scaled = json::parse(R"({
      "nodes": [{"id": 1, "type": "env"}, {"id": 2, "type": "biquad"}, {"id": 3, "type": "out"},
                {"id": 4, "type": "mul", "inputs": {"b": 3000.0}}],
      "edges": [{"from": 1, "to": 4, "input": "a"}, {"from": 4, "to": 2, "input": "cutoff"},
                {"from": 2, "to": 3, "input": "l"}]})");
    EXPECT_THROW(compile_patch(scaled, "p"), CompileError);
}

TEST(CompilePatch, ASumOfFrameRateValuesIsNotAudio) {
    const json graph = json::parse(R"({
      "nodes": [{"id": 1, "type": "note"}, {"id": 2, "type": "lfo"}, {"id": 3, "type": "add"},
                {"id": 4, "type": "mtof"}, {"id": 5, "type": "osc", "wave": "saw"}, {"id": 6, "type": "out"}],
      "edges": [{"from": 1, "port": "pitch", "to": 3, "input": "a"}, {"from": 2, "to": 3, "input": "b"},
                {"from": 3, "to": 4, "input": "in"}, {"from": 4, "to": 5, "input": "freq"},
                {"from": 5, "to": 6, "input": "l"}]})");
    EXPECT_NO_THROW(compile_patch(graph, "p"));
}

TEST(CompilePatch, ASnapOnAFrameRateWireDoesNothing) {
    json graph = simple_graph("saw");
    const u64 base = compile_patch(graph, "p").chunk.hash;
    graph["nodes"].push_back({{"id", 5}, {"type", "snap"}});
    graph["edges"][1]["from"] = 5;
    graph["edges"].push_back({{"from", 2}, {"to", 5}, {"input", "in"}});
    EXPECT_EQ(compile_patch(graph, "p").chunk.hash, base);
}

TEST(CompilePatch, RejectsACycleWithNoDelay) {
    const json graph = json::parse(R"({
      "nodes": [{"id": 1, "type": "add"}, {"id": 2, "type": "biquad"}, {"id": 3, "type": "out"}],
      "edges": [
        {"from": 1, "to": 2, "input": "in"}, {"from": 2, "to": 1, "input": "a"}, {"from": 2, "to": 3, "input": "l"}
      ]})");
    EXPECT_THROW(compile_patch(graph, "p"), CompileError);
}

TEST(CompilePatch, AcceptsFeedbackThroughADelay) {
    const json graph = json::parse(R"({
      "nodes": [
        {"id": 1, "type": "noise"}, {"id": 2, "type": "add"}, {"id": 3, "type": "delay", "max": 0.1},
        {"id": 4, "type": "mul", "inputs": {"b": 0.5}}, {"id": 5, "type": "out"}
      ],
      "edges": [
        {"from": 1, "to": 2, "input": "a"}, {"from": 4, "to": 2, "input": "b"}, {"from": 2, "to": 3, "input": "in"},
        {"from": 3, "to": 4, "input": "a"}, {"from": 4, "to": 5, "input": "l"}
      ]})");
    const auto patch = compile_patch(graph, "p");
    PatchView v;
    ASSERT_TRUE(parse_patch(patch.chunk.payload, v));
    bool read_first = false;
    for (u32 i = 0; i < v.h.voice_steps; ++i) {
        const WireStep s = v.step(v.h.control_steps + i);
        if (s.op == static_cast<u8>(Op::DelayRead)) read_first = s.mode == kReadBeforeWrite;
    }
    EXPECT_TRUE(read_first);
}

TEST(CompilePatch, FeedForwardDelayRunsWriteFirst) {
    const json graph = json::parse(R"({
      "nodes": [{"id": 1, "type": "noise"}, {"id": 2, "type": "delay", "max": 0.1}, {"id": 3, "type": "out"}],
      "edges": [{"from": 1, "to": 2, "input": "in"}, {"from": 2, "to": 3, "input": "l"}]})");
    const auto patch = compile_patch(graph, "p");
    PatchView v;
    ASSERT_TRUE(parse_patch(patch.chunk.payload, v));
    int write = -1, read = -1;
    for (u32 i = 0; i < v.h.voice_steps; ++i) {
        const WireStep s = v.step(v.h.control_steps + i);
        if (s.op == static_cast<u8>(Op::DelayWrite)) write = static_cast<int>(i);
        if (s.op == static_cast<u8>(Op::DelayRead)) {
            read = static_cast<int>(i);
            EXPECT_EQ(s.mode, 0);
        }
    }
    EXPECT_LT(write, read);
}

TEST(CompilePatch, WavetablesUseNoHostMath) {
    for (int i = 0; i <= 1000; ++i) {
        const double t = i / 1000.0;
        EXPECT_NEAR(compiler::detail::exact_sin_turns(t), std::sin(t * 2.0 * 3.14159265358979323846), 1e-9);
    }
}

TEST(CompilePatch, ReusesBuffersByLastUse) {
    const auto patch = compile_patch(demo().at("patches").at("reverb").at("graph"), "reverb");
    PatchView v;
    ASSERT_TRUE(parse_patch(patch.chunk.payload, v));
    EXPECT_LT(v.h.buffers, v.h.voice_steps);
}

TEST(CompilePatch, OscillatorModesAndWidthsAreChecked) {
    json graph = simple_graph("saw");
    graph["nodes"][2]["mode"] = "fancy";
    EXPECT_THROW(compile_patch(graph, "p"), CompileError);

    graph = simple_graph("wobble");
    EXPECT_THROW(compile_patch(graph, "p"), CompileError);

    // Silently ignoring a wire would be worse than refusing it.
    for (const char* wave : {"saw", "triangle", "sine"}) {
        graph = simple_graph(wave);
        graph["nodes"].push_back({{"id", 5}, {"type", "const"}, {"value", 0.3}});
        graph["edges"].push_back({{"from", 5}, {"to", 3}, {"input", "width"}});
        EXPECT_THROW(compile_patch(graph, "p"), CompileError) << wave;
    }
    graph = simple_graph("square");
    graph["nodes"].push_back({{"id", 5}, {"type", "const"}, {"value", 0.3}});
    graph["edges"].push_back({{"from", 5}, {"to", 3}, {"input", "width"}});
    EXPECT_NO_THROW(compile_patch(graph, "p"));
}

TEST(CompileImage, OscillatorsCompileToTheirOwnOpcodes) {
    const auto compiled = [](const char* wave, const char* mode) {
        json request = request_with({wave}, {program("a", one_note_timeline(wave))});
        if (*mode) request["patches"][wave]["graph"]["nodes"][2]["mode"] = mode;
        const LoadedImage loaded(compile_image(request).image);
        EXPECT_EQ(loaded.loader.status(), LoadStatus::Ready) << to_string(loaded.loader.error());
        for (u32 i = 0; i < loaded.table.size(); ++i) {
            const ChunkRef& c = loaded.storage[i];
            PatchView v;
            if (c.kind != static_cast<u8>(ChunkKind::Patch) || !parse_patch({c.data, c.size}, v)) continue;
            for (u32 s = 0; s < static_cast<u32>(v.h.control_steps) + v.h.voice_steps; ++s) {
                const WireStep step = v.step(s);
                const Op op = static_cast<Op>(step.op);
                if (op == Op::Osc || op == Op::Saw || op == Op::Pulse || op == Op::Triangle || op == Op::Tone) {
                    return std::pair(op, step.mode);
                }
            }
        }
        ADD_FAILURE() << "no oscillator";
        return std::pair(Op::Fill, u8{0});
    };
    EXPECT_EQ(compiled("sine", ""), std::pair(Op::Osc, u8{0}));
    EXPECT_EQ(compiled("sine", "fixed"), std::pair(Op::Tone, u8{0}));
    EXPECT_EQ(compiled("saw", ""), std::pair(Op::Saw, u8{0}));
    EXPECT_EQ(compiled("saw", "naive"), std::pair(Op::Saw, kNaive));
    EXPECT_EQ(compiled("square", ""), std::pair(Op::Pulse, u8{0}));
    EXPECT_EQ(compiled("square", "naive"), std::pair(Op::Pulse, kNaive));
    EXPECT_EQ(compiled("triangle", ""), std::pair(Op::Triangle, u8{0}));
    EXPECT_EQ(compiled("triangle", "naive"), std::pair(Op::Triangle, u8{0}));
}

TEST(CompileImage, OnlySineCarriesATable) {
    const auto tables = [](const char* wave) {
        return count_kind(compile_image(request_with({wave}, {program("a", one_note_timeline(wave))})).report, "table");
    };
    EXPECT_EQ(tables("sine"), 1);
    for (const char* wave : {"saw", "square", "triangle"}) EXPECT_EQ(tables(wave), 0) << wave;
    json fixed = request_with({"sine"}, {program("a", one_note_timeline("sine"))});
    fixed["patches"]["sine"]["graph"]["nodes"][2]["mode"] = "fixed";
    EXPECT_EQ(count_kind(compile_image(fixed).report, "table"), 0);
}

TEST(CompileImage, ANewProjectIsAtTheDefaultFrameSize) {
    const auto image = compile_image(request_with({"sine"}, {program("a", one_note_timeline("sine"))})).image;
    const auto h = load<ManifestHeader>(image.data() + sizeof(ChunkHeader));
    EXPECT_EQ(h.frame_size, 32u);
    EXPECT_EQ(frame_size_of(h), SynthConfig{}.frame_size);
    EXPECT_EQ(h.revision, kFrameSizeRevision);
}

TEST(CompileImage, FrameSize128KeepsTheEncodingOfEveryOlderImage) {
    json request = request_with({"sine"}, {program("a", one_note_timeline("sine"))});
    request["frame_size"] = 128;
    const auto image = compile_image(request).image;
    const auto h = load<ManifestHeader>(image.data() + sizeof(ChunkHeader));
    EXPECT_EQ(h.frame_size, 0u);
    EXPECT_EQ(frame_size_of(h), 128u);
    EXPECT_EQ(h.revision, 0u);  // Only what its opcodes need, so it still loads on the oldest engine
}

TEST(CompileImage, RefusesAFrameSizeNoEngineCanHave) {
    for (const int size : {-32, 0, 3, 4, 48, 2048}) {
        json request = request_with({"sine"}, {program("a", one_note_timeline("sine"))});
        request["frame_size"] = size;
        EXPECT_THROW(compile_image(request), CompileError) << size;
    }
    for (const int size : {8, 1024}) {
        json request = request_with({"sine"}, {program("a", one_note_timeline("sine"))});
        request["frame_size"] = size;
        EXPECT_NO_THROW(compile_image(request)) << size;
    }
    for (const json& size : {json(32.5), json("32"), json(nullptr), json(4294967328.0)}) {
        json request = request_with({"sine"}, {program("a", one_note_timeline("sine"))});
        request["frame_size"] = size;
        EXPECT_THROW(compile_image(request), CompileError) << size;
    }
    json request = request_with({"sine"}, {program("a", one_note_timeline("sine"))});
    request["frame_size"] = 4294967328ll;  // 2^32 + 32, which must not wrap round to a size that looks valid
    EXPECT_THROW(compile_image(request), CompileError);
}

TEST(CompileImage, OnlySineHasAFixedMode) {
    for (const char* wave : {"saw", "square", "triangle"}) {
        json request = request_with({wave}, {program("a", one_note_timeline(wave))});
        request["patches"][wave]["graph"]["nodes"][2]["mode"] = "fixed";
        EXPECT_THROW(compile_image(request), CompileError) << wave;
    }
}

TEST(CompileImage, DeclaresOnlyTheRevisionItUses) {
    const auto revision_of = [](const std::vector<std::byte>& image) {
        return load<ManifestHeader>(image.data() + sizeof(ChunkHeader)).revision;
    };
    const auto request_for = [](const char* wave) {
        json request = request_with({wave}, {program("a", one_note_timeline(wave))});
        request["frame_size"] = kOriginalFrameSize;  // Any other size needs a revision of its own
        return request;
    };
    const auto compile = [&](const char* wave) { return compile_image(request_for(wave)); };
    EXPECT_EQ(revision_of(compile("sine").image), 0u);
    for (const char* wave : {"saw", "square", "triangle"}) EXPECT_EQ(revision_of(compile(wave).image), 1u) << wave;
    json fixed = request_for("sine");
    fixed["patches"]["sine"]["graph"]["nodes"][2]["mode"] = "fixed";
    EXPECT_EQ(revision_of(compile_image(fixed).image), 2u);

    // A thin image omits the patch, and a receiver still has to run it.
    json request = request_for("saw");
    json omit = json::array();
    for (const json& c : compile("saw").report.at("chunks")) {
        if (c.at("kind") == "patch") omit.push_back(c.at("hash"));
    }
    request["omit"] = omit;
    EXPECT_EQ(revision_of(compile_image(request).image), 1u);
}

TEST(CompileImage, HoldsOnlyPatchesTheProgramReaches) {
    const auto result =
        compile_image(request_with({"saw", "sine", "square"}, {program("a", one_note_timeline("saw"))}));
    EXPECT_EQ(patch_ids(result.report, 0), std::vector<std::string>{"saw"});
    EXPECT_EQ(count_kind(result.report, "patch"), 1);
    EXPECT_EQ(count_kind(result.report, "table"), 0);
    EXPECT_EQ(result.report.at("library_patches"), 3);
    EXPECT_EQ(result.report.at("compiled_patches"), 1);
}

TEST(CompileImage, UnusedLibraryPatchesCannotChangeTheBytes) {
    json small = request_with({"saw"}, {program("a", one_note_timeline("saw"))});
    json large = request_with({"saw", "sine", "square"}, {program("a", one_note_timeline("saw"))});
    EXPECT_EQ(compile_image(small).image, compile_image(large).image);

    // Even a broken one, because it never compiles.
    large["patches"]["sine"]["graph"]["nodes"].push_back({{"id", 1}, {"type", "nonsense"}});
    EXPECT_EQ(compile_image(small).image, compile_image(large).image);
}

TEST(CompileImage, AnUnplacedClipContributesNothing) {
    json timeline = one_note_timeline("saw");
    timeline["clips"].push_back(json::parse(R"({"id": "x", "length": 480,
        "notes": [{"tick": 0, "note": 60, "dur": 10, "slot": 1}]})"));
    timeline["tracks"][0]["slots"].push_back("sine");
    const auto result = compile_image(request_with({"saw", "sine"}, {program("a", timeline)}));
    EXPECT_EQ(patch_ids(result.report, 0), std::vector<std::string>{"saw"});
}

TEST(CompileImage, UnusedSlotsDropAndRenumber) {
    json timeline = one_note_timeline("saw");
    timeline["tracks"][0]["slots"] = {"sine", "saw"};
    timeline["clips"][0]["notes"][0]["slot"] = 1;
    const auto result = compile_image(request_with({"saw", "sine"}, {program("a", timeline)}));
    EXPECT_EQ(patch_ids(result.report, 0), std::vector<std::string>{"saw"});
}

TEST(CompileImage, InsertsOnADeadBusAreLeftOut) {
    json project = demo();
    json request;
    request["patches"] = project["patches"];
    request["assets"] = project["assets"];
    json timeline = one_note_timeline("lead");
    timeline["buses"] = json::parse(R"([{"id": "orphan", "inserts": [{"id": 1, "patch": "reverb"}]}])");
    request["programs"] = json::array({program("a", timeline)});
    EXPECT_EQ(patch_ids(compile_image(request).report, 0), std::vector<std::string>{"lead"});

    // A bus with a send reaches it.
    timeline["tracks"][0]["sends"] = json::parse(R"([{"bus": "orphan", "gain": 0.5}])");
    request["programs"] = json::array({program("a", timeline)});
    auto ids = patch_ids(compile_image(request).report, 0);
    std::sort(ids.begin(), ids.end());
    EXPECT_EQ(ids, (std::vector<std::string>{"lead", "reverb"}));
}

TEST(CompileImage, AMutedTrackStaysIn) {
    json timeline = one_note_timeline("saw");
    timeline["tracks"][0]["mute"] = true;
    const auto result = compile_image(request_with({"saw"}, {program("a", timeline)}));
    EXPECT_EQ(patch_ids(result.report, 0), std::vector<std::string>{"saw"});
}

TEST(CompileImage, PatchBytesDoNotDependOnTheTimeline) {
    json a = one_note_timeline("saw"), b = one_note_timeline("saw", "72");
    b["tracks"][0]["voices"] = 16;
    b["tracks"][0]["params"] = {{"1", 0.5}};
    b["tracks"][0]["pan"] = 0.5;
    b["ppq"] = 960;
    const auto one = compile_image(request_with({"saw"}, {program("a", a)}));
    const auto two = compile_image(request_with({"saw"}, {program("b", b)}));
    EXPECT_EQ(one.report.at("programs")[0].at("patches")[0].at("hash"),
              two.report.at("programs")[0].at("patches")[0].at("hash"));
}

TEST(CompileImage, ABundleSharesEachChunkOnce) {
    const auto result = compile_image(request_with(
        {"saw", "sine"}, {program("a", one_note_timeline("sine")), program("b", one_note_timeline("sine", "72")),
                          program("c", one_note_timeline("saw"))}));
    EXPECT_EQ(count_kind(result.report, "patch"), 2);
    EXPECT_EQ(count_kind(result.report, "program"), 3);
    for (const json& c : result.report.at("chunks")) {
        if (c.at("kind") == "patch") {
            EXPECT_GE(c.at("programs").get<int>(), 1);
        }
    }
    int shared = 0;
    for (const json& c : result.report.at("chunks")) shared += c.at("programs") == 2;
    EXPECT_GE(shared, 2);  // sine's patch and its table
}

TEST(CompileImage, TwoLibraryPatchesWithTheSameBytesMerge) {
    json request =
        request_with({"saw"}, {program("a", one_note_timeline("saw")), program("b", one_note_timeline("twin"))});
    request["patches"]["twin"] = request["patches"]["saw"];
    EXPECT_EQ(count_kind(compile_image(request).report, "patch"), 1);
}

TEST(CompileImage, LibraryOrderDoesNotChangeTheBytes) {
    json request = demo();
    const auto base = compile_image(request).image;
    json reordered = json::object();
    std::vector<std::string> keys;
    for (const auto& [key, value] : request["patches"].items()) keys.push_back(key);
    std::reverse(keys.begin(), keys.end());
    for (const auto& key : keys) reordered[key] = request["patches"][key];
    request["patches"] = reordered;
    EXPECT_EQ(compile_image(request).image, base);
}

TEST(CompileImage, ProgramsKeepRequestOrder) {
    json request = request_with({"saw", "sine"},
                                {program("a", one_note_timeline("saw")), program("b", one_note_timeline("sine"))});
    const auto result = compile_image(request);
    EXPECT_EQ(result.report.at("programs")[0].at("index"), 0);
    EXPECT_EQ(result.report.at("programs")[1].at("index"), 1);
}

TEST(CompileImage, NamesATimelineThatAutomatesAMissingParameter) {
    json timeline = one_note_timeline("saw");
    timeline["clips"][0]["automation"] = json::parse(R"([{"param": 42, "tick": 0, "value": 1}])");
    try {
        compile_image(request_with({"saw"}, {program("a", timeline)}));
        FAIL() << "should not compile";
    } catch (const CompileError& e) {
        EXPECT_NE(std::string(e.what()).find("param 42"), std::string::npos);
        EXPECT_NE(e.where.find("track:1"), std::string::npos);
    }
}

TEST(CompileImage, RejectsAnInsertPatchOnAnInstrumentSlot) {
    json request = demo();
    json timeline = one_note_timeline("reverb");
    request["programs"] = json::array({program("a", timeline)});
    EXPECT_THROW(compile_image(request), CompileError);
}

TEST(CompileImage, ReportsWhichMixRegistersBelongToWhichRoute) {
    const auto result = compile_image(demo());
    const json& lead = result.report.at("programs")[0].at("tracks")[0];
    std::set<std::string> routes;
    for (const json& edge : lead.at("mix")) routes.insert(edge.at("to").get<std::string>());
    EXPECT_EQ(routes, (std::set<std::string>{"master", "bus:room"}));
}

TEST(CompileImage, RejectsOverlappingClips) {
    json timeline = one_note_timeline("saw");
    timeline["tracks"][0]["placements"].push_back({{"clip", "c"}, {"tick", 100}});
    EXPECT_THROW(compile_image(request_with({"saw"}, {program("a", timeline)})), CompileError);
}

TEST(CompileImage, RejectsARoutingCycle) {
    json request = request_with({"saw"}, json::array());
    json timeline = one_note_timeline("saw");
    timeline["tracks"][0]["output"] = "bus:a";
    timeline["buses"] = json::parse(R"([{"id": "a", "output": "bus:b"}, {"id": "b", "output": "bus:a",
        "sends": [{"bus": "c"}]}, {"id": "c"}])");
    request["programs"] = json::array({program("a", timeline)});
    EXPECT_THROW(compile_image(request), CompileError);
}

TEST(CompileImage, CheckedEntryPointReportsErrorsAsData) {
    const auto bad = compiler::compile_image_checked("{ not json");
    EXPECT_FALSE(bad.report.value("ok", true));
    EXPECT_TRUE(bad.image.empty());
    const auto missing = compiler::compile_image_checked(R"({"programs": [{"name": "x", "timeline":
        {"clips": [{"id": "c", "length": 10, "notes": [{"tick": 0, "note": 60, "dur": 1}]}],
         "tracks": [{"id": 1, "slots": ["gone"], "placements": [{"clip": "c", "tick": 0}]}]}}]})");
    EXPECT_FALSE(missing.report.value("ok", true));
    EXPECT_NE(missing.report.at("errors")[0].at("message").get<std::string>().find("gone"), std::string::npos);
}
