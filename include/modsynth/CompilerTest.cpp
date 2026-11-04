#include <algorithm>
#include <gtest/gtest.h>
#include <random>
#include <set>
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

namespace {

json voice_of(json extra_nodes, json extra_edges) {
    json graph = json::parse(R"({
      "nodes": [{"id": 1, "type": "note"}, {"id": 2, "type": "out"}, {"id": 3, "type": "noise"}],
      "edges": [{"from": 3, "to": 2, "input": "l"}]})");
    for (const json& n : extra_nodes) graph["nodes"].push_back(n);
    for (const json& e : extra_edges) graph["edges"].push_back(e);
    return graph;
}

std::vector<u8> ops_of(const json& graph, const char* where = "p") {
    const auto patch = compile_patch(graph, where);
    PatchView v;
    EXPECT_TRUE(parse_patch({patch.chunk.payload.data(), patch.chunk.payload.size()}, v));
    std::vector<u8> ops;
    for (u32 i = 0; i < static_cast<u32>(v.h.control_steps) + v.h.voice_steps; ++i) ops.push_back(v.step(i).op);
    return ops;
}

bool has_op(const std::vector<u8>& ops, Op op) {
    return std::find(ops.begin(), ops.end(), static_cast<u8>(op)) != ops.end();
}

std::string error_of(const json& graph) {
    try {
        compile_patch(graph, "p");
    } catch (const CompileError& e) {
        return e.what();
    }
    return "";
}

}  // namespace

TEST(CompilePatch, AnOscInModModeTakesAudioOnEveryInput) {
    for (const char* input : {"freq", "phase", "sync", "feedback"}) {
        SCOPED_TRACE(input);
        const json graph = voice_of(
            json::array({{{"id", 4}, {"type", "osc"}, {"mode", "mod"}}}),
            json::array({{{"from", 3}, {"to", 4}, {"input", input}}, {{"from", 4}, {"to", 2}, {"input", "r"}}}));
        EXPECT_TRUE(has_op(ops_of(graph), Op::OscMod));
    }
    const json pulse =
        voice_of(json::array({{{"id", 4}, {"type", "osc"}, {"wave", "square"}, {"mode", "mod"}}}),
                 json::array({{{"from", 3}, {"to", 4}, {"input", "width"}}, {{"from", 4}, {"to", 2}, {"input", "r"}}}));
    EXPECT_TRUE(has_op(ops_of(pulse), Op::OscMod));
}

TEST(CompilePatch, EveryWaveAndFormReachesItsMode) {
    const struct {
        const char* wave;
        const char* mode;
        OscModMode expected;
    } forms[] = {
        {"sine", "mod", OscModMode::Sine},
        {"triangle", "mod", OscModMode::Triangle},
        {"saw", "mod", OscModMode::Saw},
        {"square", "mod", OscModMode::Pulse},
        {"saw", "mod-naive", OscModMode::NaiveSaw},
        {"square", "mod-naive", OscModMode::NaivePulse},
    };
    for (const auto& f : forms) {
        SCOPED_TRACE(std::string(f.wave) + " " + f.mode);
        const json graph = voice_of(json::array({{{"id", 4}, {"type", "osc"}, {"wave", f.wave}, {"mode", f.mode}}}),
                                    json::array({{{"from", 4}, {"to", 2}, {"input", "r"}}}));
        const auto patch = compile_patch(graph, "p");
        PatchView v;
        ASSERT_TRUE(parse_patch({patch.chunk.payload.data(), patch.chunk.payload.size()}, v));
        bool found = false;
        for (u32 i = 0; i < v.h.voice_steps; ++i) {
            const WireStep s = v.step(v.h.control_steps + i);
            if (s.op == static_cast<u8>(Op::OscMod)) {
                found = true;
                EXPECT_EQ(s.mode, static_cast<u8>(f.expected));
            }
        }
        EXPECT_TRUE(found);
    }
}

TEST(CompilePatch, AnOscNotInModModeRefusesItsInputs) {
    for (const char* input : {"phase", "sync", "feedback"}) {
        SCOPED_TRACE(input);
        const json graph = voice_of(
            json::array({{{"id", 4}, {"type", "osc"}}}),
            json::array({{{"from", 3}, {"to", 4}, {"input", input}}, {{"from", 4}, {"to", 2}, {"input", "r"}}}));
        EXPECT_EQ(error_of(graph), std::string("only an osc in mod mode has ") + input);
    }
}

TEST(CompilePatch, AnOscInModModeRefusesWhatItsWaveLacks) {
    const auto with = [](const char* wave, const char* mode, const char* input) {
        json edges = json::array({{{"from", 4}, {"to", 2}, {"input", "r"}}});
        if (input[0] != 0) edges.push_back({{"from", 3}, {"to", 4}, {"input", input}});
        return voice_of(json::array({{{"id", 4}, {"type", "osc"}, {"wave", wave}, {"mode", mode}}}), edges);
    };
    EXPECT_EQ(error_of(with("saw", "mod", "feedback")), "only sine has feedback");
    EXPECT_EQ(error_of(with("saw", "mod", "width")), "only square has a width");
    EXPECT_EQ(error_of(with("sine", "mod-naive", "")), "only saw and square have a naive form");
    EXPECT_EQ(error_of(with("triangle", "mod-naive", "")), "only saw and square have a naive form");
    EXPECT_EQ(error_of(with("sine", "fm", "")), "unknown osc mode 'fm'");
    EXPECT_EQ(error_of(with("noise", "mod", "")), "unknown wave 'noise'");
}

TEST(CompilePatch, MathRunsAtTheRateOfItsInputs) {
    const json control =
        voice_of(json::array({{{"id", 4}, {"type", "math"}, {"mode", "max"}}, {{"id", 5}, {"type", "osc"}}}),
                 json::array({{{"from", 1}, {"port", "velocity"}, {"to", 4}, {"input", "a"}},
                              {{"from", 4}, {"to", 5}, {"input", "freq"}},
                              {{"from", 5}, {"to", 2}, {"input", "r"}}}));
    const auto scalar = ops_of(control);
    EXPECT_TRUE(has_op(scalar, Op::KMath));  // So it can drive an input read once a frame with no snap
    EXPECT_FALSE(has_op(scalar, Op::Math));

    const json audio =
        voice_of(json::array({{{"id", 4}, {"type", "math"}, {"mode", "max"}}, {{"id", 5}, {"type", "osc"}}}),
                 json::array({{{"from", 3}, {"to", 4}, {"input", "a"}},
                              {{"from", 4}, {"to", 5}, {"input", "freq"}},
                              {{"from", 5}, {"to", 2}, {"input", "r"}}}));
    EXPECT_NE(error_of(audio).find("put a snap node on the wire"), std::string::npos);
}

TEST(CompilePatch, MathRefusesAWireOnAnInputItsModeDoesNotRead) {
    for (const char* mode : {"abs", "floor"}) {
        const json graph =
            voice_of(json::array({{{"id", 4}, {"type", "math"}, {"mode", mode}}}),
                     json::array({{{"from", 3}, {"to", 4}, {"input", "b"}}, {{"from", 4}, {"to", 2}, {"input", "r"}}}));
        EXPECT_EQ(error_of(graph), std::string(mode) + " has no input 'b'");
    }
    const json graph =
        voice_of(json::array({{{"id", 4}, {"type", "math"}, {"mode", "min"}}}),
                 json::array({{{"from", 3}, {"to", 4}, {"input", "c"}}, {{"from", 4}, {"to", 2}, {"input", "r"}}}));
    EXPECT_EQ(error_of(graph), "min has no input 'c'");
}

TEST(CompilePatch, MathRefusesAModeItDoesNotHave) {
    const json graph = voice_of(json::array({{{"id", 4}, {"type", "math"}, {"mode", "tanh"}}}),
                                json::array({{{"from", 4}, {"to", 2}, {"input", "r"}}}));
    EXPECT_EQ(error_of(graph), "unknown math mode 'tanh'");
}

TEST(CompilePatch, ACurveIsAPowerOfTwoPlusOnePoints) {
    const auto with = [](json curve) {
        return voice_of(json::array({{{"id", 4}, {"type", "shape"}, {"curve", std::move(curve)}}}),
                        json::array({{{"from", 3}, {"to", 4}}, {{"from", 4}, {"to", 2}, {"input", "r"}}}));
    };
    EXPECT_TRUE(has_op(ops_of(with(json::array({-1.0, 0.0, 1.0}))), Op::Shape));
    EXPECT_TRUE(has_op(ops_of(with(json::array({-1.0, -0.5, 0.0, 0.5, 1.0}))), Op::Shape));
    for (const json& bad : {json::array(), json::array({1.0, 2.0}), json::array({1.0, 2.0, 3.0, 4.0})}) {
        EXPECT_NE(error_of(with(bad)).find("power of two plus one"), std::string::npos) << bad;
    }
}

TEST(CompilePatch, ACurvesPointsReachTheHash) {
    const auto hash = [](double middle) {
        return compile_patch(
                   voice_of(json::array({{{"id", 4}, {"type", "shape"}, {"curve", {-1.0, middle, 1.0}}}}),
                            json::array({{{"from", 3}, {"to", 4}}, {{"from", 4}, {"to", 2}, {"input", "r"}}})),
                   "p")
            .resources.at(0)
            .hash;
    };
    EXPECT_NE(hash(0.0), hash(0.1));
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

// `"line": "i16"` asks for the I16 form of each op on that node's line, and only that node's.
TEST(CompilePatch, AnI16LineCompilesToTheI16Ops) {
    json graph = json::parse(R"({
      "nodes": [
        {"id": 1, "type": "noise"}, {"id": 2, "type": "add"}, {"id": 3, "type": "delay", "max": 0.1, "line": "i16"},
        {"id": 4, "type": "mul", "inputs": {"b": 0.5}}, {"id": 5, "type": "comb", "line": "i16"},
        {"id": 6, "type": "allpass", "line": "i16"}, {"id": 7, "type": "allpass"}, {"id": 8, "type": "out"}
      ],
      "edges": [
        {"from": 1, "to": 2, "input": "a"}, {"from": 4, "to": 2, "input": "b"}, {"from": 2, "to": 3, "input": "in"},
        {"from": 3, "to": 4, "input": "a"}, {"from": 4, "to": 5, "input": "in"}, {"from": 5, "to": 6, "input": "in"},
        {"from": 6, "to": 7, "input": "in"}, {"from": 7, "to": 8, "input": "l"}
      ]})");
    const auto patch = compile_patch(graph, "p");
    PatchView v;
    ASSERT_TRUE(parse_patch(patch.chunk.payload, v));
    std::multiset<int> ops;
    for (u32 i = 0; i < v.h.voice_steps; ++i) {
        const WireStep s = v.step(v.h.control_steps + i);
        if (op_signature(static_cast<Op>(s.op)).resource == Resource::Delay) ops.insert(s.op);
        if (s.op == static_cast<u8>(Op::DelayReadI16)) EXPECT_EQ(s.mode, kReadBeforeWrite);
    }
    EXPECT_EQ(ops, (std::multiset<int>{static_cast<int>(Op::Allpass), static_cast<int>(Op::DelayWriteI16),
                                       static_cast<int>(Op::DelayReadI16), static_cast<int>(Op::CombI16),
                                       static_cast<int>(Op::AllpassI16)}));

    const auto declared = [](const std::vector<std::byte>& image) {
        return load<ManifestHeader>(image.data() + sizeof(ChunkHeader)).revision;
    };
    EXPECT_EQ(declared(compile_image({{"patches", {{"p", {{"graph", graph}}}}}, {"programs", json::array()}}).image),
              8u);
    for (json& n : graph["nodes"]) n.erase("line");
    EXPECT_LT(declared(compile_image({{"patches", {{"p", {{"graph", graph}}}}}, {"programs", json::array()}}).image),
              8u)
        << "an image with no I16 op keeps loading on older engines";

    graph["nodes"][4]["line"] = "i8";
    try {
        compile_patch(graph, "p");
        ADD_FAILURE() << "compiled";
    } catch (const CompileError& e) {
        EXPECT_NE(std::string(e.what()).find("unknown line 'i8'"), std::string::npos) << e.what();
    }
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

TEST(CompileImage, OnlyASharedLfoIsAKLfo2) {
    const auto check = [](bool per_voice, Op op, u32 revision) {
        json graph =
            json::parse(R"({"nodes": [{"id": 1, "type": "note"}, {"id": 2, "type": "lfo"}, {"id": 3, "type": "out"}],
            "edges": [{"from": 2, "to": 3, "input": "l"}]})");
        if (per_voice) graph["edges"].push_back({{"from", 1}, {"port", "velocity"}, {"to", 2}, {"input", "depth"}});
        json request = request_with({"sine"}, {program("a", one_note_timeline("sine"))});
        request["frame_size"] = kOriginalFrameSize;  // Any other size needs a revision of its own
        request["patches"]["sine"]["graph"] = graph;
        const auto image = compile_image(request).image;
        EXPECT_EQ(load<ManifestHeader>(image.data() + sizeof(ChunkHeader)).revision, revision);
        bool found = false;
        for (const auto& chunk : disassemble(image)) {
            if (chunk.kind != ChunkKind::Patch) continue;
            PatchView v;
            ASSERT_TRUE(parse_patch(chunk.payload, v));
            for (u32 s = 0; s < static_cast<u32>(v.h.control_steps) + v.h.voice_steps; ++s) {
                if (v.step(s).op != static_cast<u8>(op)) continue;
                found = true;
                EXPECT_EQ(s < v.h.control_steps, !per_voice);
            }
        }
        EXPECT_TRUE(found);
    };
    check(false, Op::KLfo2, 5);
    check(true, Op::KLfo, 0);
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

TEST(CompileImage, ReportsWhereEachInsertIsInTheImage) {
    // A document names an insert by its id, and a live change addresses it by its place in the Program.
    const auto result = compile_image(demo());
    const json& inserts = result.report.at("programs")[0].at("inserts");
    std::map<int, int> index_of;
    for (const json& insert : inserts) index_of[insert.at("id").get<int>()] = insert.at("index").get<int>();
    EXPECT_EQ(index_of.size(), 2u);
    EXPECT_NE(index_of.at(1), index_of.at(2));
    EXPECT_LT(index_of.at(1), 2);
    EXPECT_LT(index_of.at(2), 2);
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

namespace {

// One track of a plain patch and a bus, each with an insert that has a parameter, for lanes to reach.
json lane_project(const json& automation) {
    json request = json::parse(R"({"patches": {
        "tone": {"name": "tone", "graph": {"nodes": [{"id": 1, "type": "note"}, {"id": 2, "type": "mul",
            "inputs": {"b": 0.01}}, {"id": 3, "type": "out"}], "edges": [{"from": 1, "port": "pitch", "to": 2, "input": "a"},
            {"from": 2, "to": 3, "input": "l"}]}},
        "gain": {"name": "gain", "graph": {"params": [{"id": 1, "min": 0, "max": 1, "default": 1},
            {"id": 2, "scope": "voice", "min": 0, "max": 1, "default": 1}],
            "nodes": [{"id": 1, "type": "in"}, {"id": 2, "type": "param", "param": 1}, {"id": 3, "type": "mul"},
            {"id": 5, "type": "param", "param": 2}, {"id": 6, "type": "mul"}, {"id": 4, "type": "out"}],
            "edges": [{"from": 1, "port": "l", "to": 3, "input": "a"}, {"from": 2, "to": 3, "input": "b"},
            {"from": 3, "to": 6, "input": "a"}, {"from": 5, "to": 6, "input": "b"}, {"from": 6, "to": 4, "input": "l"}]}}},
      "programs": [{"id": "a", "name": "a", "timeline": {"ppq": 480,
        "clips": [{"id": "c", "length": 960, "notes": [{"tick": 0, "note": 60, "dur": 960}]},
                  {"id": "other", "length": 960, "notes": [{"tick": 0, "note": 64, "dur": 960}]}],
        "tracks": [{"id": 1, "slots": ["tone"], "placements": [{"clip": "c", "tick": 0}],
                    "sends": [{"bus": "wet", "gain": 0.5}], "inserts": [{"id": 1, "patch": "gain"}]},
                   {"id": 2, "slots": ["tone"], "placements": [{"clip": "other", "tick": 0}]}],
        "buses": [{"id": "wet", "inserts": [{"id": 2, "patch": "gain"}]},
                  {"id": "unused", "inserts": [{"id": 3, "patch": "gain"}]}]}}]})");
    request["programs"][0]["timeline"]["clips"][0]["automation"] = automation;
    return request;
}

std::string lane_error(const json& request) {
    try {
        (void)compile_image(request);
    } catch (const CompileError& e) {
        return e.what();
    }
    return "";
}

std::string error_of_lane(const char* lane) { return lane_error(lane_project(json::array({json::parse(lane)}))); }

}  // namespace

TEST(CompileImage, ALibraryHoldsEveryPatchAndNoProgram) {
    json request = lane_project(json::array());
    request["programs"] = json::array();
    const auto result = compile_image(request);

    const LoadedImage loaded(result.image);
    ASSERT_EQ(loaded.loader.status(), LoadStatus::Ready);
    EXPECT_EQ(loaded.loader.programs(), 0u);
    EXPECT_EQ(result.report.at("programs").size(), 0u);
    u32 patches = 0;
    for (const json& chunk : result.report.at("chunks")) {
        patches += chunk.at("kind") == "patch";
        EXPECT_EQ(chunk.at("programs"), 0);
    }
    EXPECT_EQ(patches, 2u);
}

TEST(CompileImage, AThinImageRunsOnWhatALibrarySentAhead) {
    json library = lane_project(json::array());
    library["programs"] = json::array();
    const auto sent = Rig<kStereo>::aligned(compile_image(library).image);
    const std::size_t sent_size = compile_image(library).image.size();

    json thin = lane_project(json::array());
    json omit = json::array();
    for (const json& chunk : compile_image(thin).report.at("chunks")) {
        if (chunk.at("kind") == "patch") omit.push_back(chunk.at("hash"));
    }
    thin["omit"] = omit;
    const auto program = Rig<kStereo>::aligned(compile_image(thin).image);
    const std::size_t program_size = compile_image(thin).image.size();

    std::vector<std::byte> fast(8 << 20), bulk(8 << 20);
    std::vector<ChunkRef> storage(kMaxChunks);
    ChunkTable table{std::span(storage)};
    Rig<kStereo>::Engine engine({fast, bulk, kRate});
    engine.load(table, {reinterpret_cast<const std::byte*>(sent.data()), sent_size});
    while (engine.pump(1 << 16)) {
    }
    EXPECT_EQ(engine.load_error(), LoadError::None) << "a library has nothing to bind, which is no error";
    EXPECT_EQ(engine.generation(), 0u);

    engine.load(table, {reinterpret_cast<const std::byte*>(program.data()), program_size});
    float left[kFrame], right[kFrame];
    for (u32 i = 0; i < 64 && engine.generation() == 0; ++i) {
        while (engine.pump(1 << 16) && engine.generation() == 0 && engine.load_error() == LoadError::None) {
            engine.render({left, right});
        }
    }
    EXPECT_EQ(engine.load_error(), LoadError::None);
    EXPECT_EQ(engine.generation(), 1u);
}

TEST(CompileImage, AnImageNeedsSomethingInIt) {
    json request = lane_project(json::array());
    request["programs"] = json::array();
    request["patches"] = json::object();
    EXPECT_NE(lane_error(request).find("a program or a patch"), std::string::npos);
}

namespace {

struct Conductor {
    u32 initial_uspq;
    std::vector<std::pair<u32, u32>> changes;  // tick, microseconds per quarter, after the first
};

Conductor conductor_of(const json& tempo, u32 ppq = 480) {
    json timeline = one_note_timeline("saw");
    timeline["ppq"] = ppq;
    timeline["tempo"] = tempo;
    const auto image = compile_image(request_with({"saw"}, {program("a", timeline)})).image;
    const LoadedImage loaded(image);
    EXPECT_EQ(loaded.loader.status(), LoadStatus::Ready);
    ProgramView v;
    const ChunkRef* c = loaded.table.find(loaded.loader.program_hash(0));
    EXPECT_TRUE(parse_program({c->data, c->size}, v));
    Conductor out{v.h.uspq, {}};
    u32 tick = 0;
    for (u32 i = 0; i < v.h.conductor_length; ++i) {
        const Instruction in = v.instruction(v.h.conductor_begin + i);
        if (in.op == static_cast<u8>(Instr::Wait)) tick += in.c;
        if (in.op == static_cast<u8>(Instr::Tempo)) out.changes.emplace_back(tick, in.c);
    }
    return out;
}

u32 uspq(float bpm) { return static_cast<u32>(60000000.0f / bpm); }

}  // namespace

TEST(Tempo, ARampIsAStepEveryThirtySecondNoteAtTheTempoHalfwayThroughIt) {
    const Conductor c =
        conductor_of(json::parse(R"([{"tick": 0, "bpm": 120, "ramp": true}, {"tick": 1920, "bpm": 60}])"));
    // The first step, from tick 0 to 60, is at the tempo of tick 30.
    EXPECT_EQ(c.initial_uspq, uspq(120.0f - 60.0f * 30.0f / 1920.0f));
    ASSERT_EQ(c.changes.size(), 32u);  // 31 more steps, then the change the ramp arrives at
    for (u32 i = 0; i + 1 < c.changes.size(); ++i) {
        EXPECT_EQ(c.changes[i].first, 60 * (i + 1));
        EXPECT_EQ(c.changes[i].second, uspq(120.0f - 60.0f * (60.0f * (i + 1) + 30.0f) / 1920.0f));
    }
    EXPECT_EQ(c.changes.back(), std::make_pair(1920u, uspq(60.0f)));
}

TEST(Tempo, AStepIsWhatItWasAndARampStartsWhereItIs) {
    const Conductor steps = conductor_of(json::parse(R"([{"tick": 0, "bpm": 90}, {"tick": 960, "bpm": 140}])"));
    EXPECT_EQ(steps.initial_uspq, uspq(90.0f));
    EXPECT_EQ(steps.changes, (std::vector<std::pair<u32, u32>>{{960, uspq(140.0f)}}));
    // A ramp later in the song: the tempo holds until it starts, and the change after it still applies.
    const Conductor later = conductor_of(json::parse(R"([{"tick": 0, "bpm": 100}, {"tick": 480, "bpm": 100,
        "ramp": true}, {"tick": 600, "bpm": 160}, {"tick": 960, "bpm": 80}])"));
    EXPECT_EQ(later.initial_uspq, uspq(100.0f));
    EXPECT_EQ(later.changes, (std::vector<std::pair<u32, u32>>{
                                 {480, uspq(115.0f)}, {540, uspq(145.0f)}, {600, uspq(160.0f)}, {960, uspq(80.0f)}}));
}

TEST(Tempo, ALongRampTakesLongerStepsAndAFlatOneIsOneChange) {
    // 64 bars would be 2048 steps of a 1/32 note, which is twice as many as a ramp is allowed.
    const Conductor longer = conductor_of(json::parse(R"([{"tick": 0, "bpm": 60, "ramp": true}, {"tick": 122880,
        "bpm": 180}])"));
    ASSERT_EQ(longer.changes.size(), 1024u);
    EXPECT_EQ(longer.changes[0].first, 120u);
    EXPECT_EQ(longer.changes.back(), std::make_pair(122880u, uspq(180.0f)));
    const Conductor flat = conductor_of(json::parse(R"([{"tick": 0, "bpm": 120, "ramp": true}, {"tick": 1920,
        "bpm": 120}])"));
    EXPECT_EQ(flat.initial_uspq, uspq(120.0f));
    EXPECT_EQ(flat.changes, (std::vector<std::pair<u32, u32>>{{1920, uspq(120.0f)}}));
    // A short ppq still steps at least a tick at a time.
    EXPECT_EQ(conductor_of(json::parse(R"([{"tick": 0, "bpm": 100, "ramp": true}, {"tick": 4, "bpm": 140}])"), 4)
                  .changes.size(),
              4u);
}

TEST(Tempo, ARampNeedsAChangeToRampTo) {
    json timeline = one_note_timeline("saw");
    timeline["tempo"] = json::parse(R"([{"tick": 0, "bpm": 120}, {"tick": 960, "bpm": 90, "ramp": true}])");
    const auto result = compiler::compile_image_checked(request_with({"saw"}, {program("a", timeline)}).dump());
    EXPECT_FALSE(result.report.value("ok", true));
    EXPECT_NE(result.report.at("errors")[0].at("message").get<std::string>().find("a tempo ramp needs a later change"),
              std::string::npos);
}

TEST(Lanes, EveryTargetTheFormatCanReachCompilesAndLoads) {
    for (const char* lane : {R"({"target": {"insert": 1}, "param": 1, "tick": 0, "value": 0.5, "ramp": 10})",
                             R"({"target": {"insert": 2}, "param": 1, "tick": 0, "value": 0.5})",
                             R"({"target": {"mix": "fader", "track": 1}, "tick": 0, "value": 1, "ramp": 10})",
                             R"({"target": {"mix": "fader", "bus": "wet"}, "tick": 0, "value": 1})",
                             R"({"target": {"mix": "pan", "track": 1}, "tick": 0, "value": -1})",
                             R"({"target": {"mix": "send", "track": 1, "to": "wet"}, "tick": 0, "value": 1})",
                             R"({"target": {"mix": "fader", "master": true}, "tick": 0, "value": 1})"}) {
        SCOPED_TRACE(lane);
        EXPECT_EQ(error_of_lane(lane), "");
    }
}

TEST(Lanes, ALaneNeedsARevisionAndAnOrdinaryOneDoesNot) {
    const auto revision = [](const json& automation) {
        const auto image = compile_image(lane_project(automation)).image;
        return load<ManifestHeader>(image.data() + sizeof(ChunkHeader)).revision;
    };
    EXPECT_EQ(revision(json::array()), kFrameSizeRevision);
    EXPECT_EQ(revision(json::parse(R"([{"target": {"insert": 1}, "param": 1, "tick": 0, "value": 0.5}])")), 4u);
}

TEST(Lanes, AnInsertNothingPlaysThroughDropsItsLane) {
    EXPECT_EQ(error_of_lane(R"({"target": {"insert": 3}, "param": 1, "tick": 0, "value": 0.5})"), "");
}

TEST(Lanes, WhatALaneCannotReachIsAnError) {
    const std::pair<const char*, const char*> cases[] = {
        {R"({"target": {"insert": 9}, "param": 1, "tick": 0, "value": 0})", "unknown insert"},
        {R"({"target": {"insert": 1}, "param": 7, "tick": 0, "value": 0})", "does not have"},
        {R"({"target": {"insert": 1}, "param": 2, "tick": 0, "value": 0})", "voice scope"},
        {R"({"target": {"insert": 1, "channel": 3}, "param": 1, "tick": 0, "value": 0})", "no 'channel'"},
        {R"({"target": {"channel": 3}, "param": 1, "tick": 0, "value": 0})", "an insert or a mix control"},
        {R"({"target": 3, "tick": 0, "value": 0})", "is an object"},
        {R"({"target": {"mix": "volume", "track": 1}, "tick": 0, "value": 0})", "unknown mix control"},
        {R"({"target": {"mix": "fader"}, "tick": 0, "value": 0})", "one of track, bus or master"},
        {R"({"target": {"mix": "fader", "track": 1, "bus": "wet"}, "tick": 0, "value": 0})", "one of track"},
        {R"({"target": {"mix": "fader", "track": 8}, "tick": 0, "value": 0})", "unknown"},
        {R"({"target": {"mix": "fader", "master": false}, "tick": 0, "value": 0})", "only be true"},
        {R"({"target": {"mix": "pan", "master": true}, "tick": 0, "value": 0})", "only a fader"},
        {R"({"target": {"mix": "fader", "track": 1}, "tick": 0, "value": -1})", "out of range"},
        {R"({"target": {"mix": "pan", "track": 1}, "tick": 0, "value": 2})", "out of range"},
        {R"({"target": {"mix": "send", "track": 1, "to": "nowhere"}, "tick": 0, "value": 0})", "unknown"},
        {R"({"target": {"mix": "send", "track": 2, "to": "wet"}, "tick": 0, "value": 0})", "no send"},
        {R"({"target": {"mix": "fader", "track": 1, "to": "wet"}, "tick": 0, "value": 0})", "only a send lane"},
        {R"({"target": {"mix": "fader", "track": 1, "colour": 1}, "tick": 0, "value": 0})", "no 'colour'"},
        {R"({"target": {"mix": "fader", "track": 1}, "param": 1, "tick": 0, "value": 0})", "no param"},
    };
    for (const auto& [lane, wanted] : cases) {
        SCOPED_TRACE(lane);
        EXPECT_NE(error_of_lane(lane).find(wanted), std::string::npos) << error_of_lane(lane);
    }
}

namespace {

// A Program's tables and code, copied out of its image.
struct Decoded {
    ProgramHeader h{};
    std::vector<ClipDesc> clips;
    std::vector<TrackDesc> tracks;
    std::vector<Instruction> code;
    std::vector<float> mix;
    [[nodiscard]] std::vector<Instruction> clip(u32 i) const {
        return {code.begin() + clips[i].begin, code.begin() + clips[i].begin + clips[i].length};
    }
    [[nodiscard]] std::vector<Instruction> stream(u32 t) const {
        return {code.begin() + tracks[t].stream_begin, code.begin() + tracks[t].stream_begin + tracks[t].stream_length};
    }
};

Decoded decode(const std::vector<std::byte>& image) {
    const LoadedImage loaded(image);
    EXPECT_EQ(loaded.loader.status(), LoadStatus::Ready);
    ProgramView v;
    const ChunkRef* c = loaded.table.find(loaded.loader.program_hash(0));
    EXPECT_TRUE(parse_program({c->data, c->size}, v));
    Decoded d;
    d.h = v.h;
    for (u32 i = 0; i < v.h.clips; ++i) d.clips.push_back(v.clip(i));
    for (u32 i = 0; i < v.h.tracks; ++i) d.tracks.push_back(v.track(i));
    for (u32 i = 0; i < v.h.code; ++i) d.code.push_back(v.instruction(i));
    for (u32 i = 0; i < v.h.mix_regs; ++i) d.mix.push_back(v.mix_value(i));
    return d;
}

const json& reported_track(const json& report, int id) {
    for (const json& t : report.at("programs")[0].at("tracks")) {
        if (t.at("id") == id) return t;
    }
    throw std::runtime_error("no track " + std::to_string(id));
}

std::vector<json> stage_factors(const json& chain) {
    std::vector<json> out;
    for (const json& s : chain.at("stages")) out.push_back(s.at("of"));
    return out;
}

}  // namespace

TEST(Stages, NothingMovesToAStageUntilTwoMovingControlsWouldShareARegister) {
    const json report = compile_image(lane_project(json::parse(R"([
        {"target": {"mix": "fader", "track": 1}, "tick": 0, "value": 1},
        {"target": {"mix": "fader", "track": 2}, "tick": 10, "value": 0},
        {"target": {"mix": "fader", "bus": "wet"}, "tick": 10, "value": 0}])")))
                            .report;
    EXPECT_TRUE(reported_track(report, 1).at("stages").empty());
    EXPECT_TRUE(report.at("programs")[0].at("master").at("stages").empty());
    for (const json& route : reported_track(report, 1).at("mix")) {
        const bool to_master = route.at("to") == "master";
        EXPECT_EQ(route.at("of"), to_master ? json::parse(R"(["fader", "pan", "master"])")
                                            : json::parse(R"(["fader", "pan", "send"])"));
    }
}

TEST(Stages, AFaderThatSharesWithAPanThatMovesTakesAStepOfItsOwn) {
    const json report = compile_image(lane_project(json::parse(R"([
        {"target": {"mix": "fader", "track": 1}, "tick": 0, "value": 1},
        {"target": {"mix": "pan", "track": 1}, "tick": 10, "value": 0}])")))
                            .report;
    const json& track = reported_track(report, 1);
    EXPECT_EQ(stage_factors(track), (std::vector<json>{json::parse(R"(["fader"])")}));
    for (const json& route : track.at("mix")) {
        EXPECT_EQ(std::count(route.at("of").begin(), route.at("of").end(), "fader"), 0) << route;
    }
}

TEST(Stages, TheMasterFaderTakesAStepWhenAFaderIntoItMovesToo) {
    const json report = compile_image(lane_project(json::parse(R"([
        {"target": {"mix": "fader", "track": 2}, "tick": 0, "value": 1},
        {"target": {"mix": "fader", "master": true}, "tick": 10, "value": 0}])")))
                            .report;
    EXPECT_EQ(stage_factors(report.at("programs")[0].at("master")), (std::vector<json>{json::parse(R"(["master"])")}));
    EXPECT_TRUE(reported_track(report, 2).at("stages").empty());
    EXPECT_EQ(reported_track(report, 2).at("mix")[0].at("of"), json::parse(R"(["fader", "pan"])"));
}

TEST(Stages, EveryControlCanMoveAtOnce) {
    const json report = compile_image(lane_project(json::parse(R"([
        {"target": {"mix": "fader", "track": 1}, "tick": 0, "value": 1},
        {"target": {"mix": "pan", "track": 1}, "tick": 10, "value": 0},
        {"target": {"mix": "send", "track": 1, "to": "wet"}, "tick": 20, "value": 0},
        {"target": {"mix": "fader", "bus": "wet"}, "tick": 30, "value": 0.5},
        {"target": {"mix": "pan", "bus": "wet"}, "tick": 40, "value": 0.5},
        {"target": {"mix": "fader", "master": true}, "tick": 50, "value": 0.5}])")))
                            .report;
    EXPECT_EQ(stage_factors(reported_track(report, 1)),
              (std::vector<json>{json::parse(R"(["fader"])"), json::parse(R"(["pan"])")}));
    EXPECT_EQ(stage_factors(report.at("programs")[0].at("master")), (std::vector<json>{json::parse(R"(["master"])")}));
}

TEST(Stages, APreFaderSendReadsTheChainBeforeItsFaderAndPan) {
    json request = lane_project(json::array());
    request["programs"][0]["timeline"]["tracks"][0]["sends"][0]["pre"] = true;
    const json report = compile_image(request).report;
    const json& track = reported_track(report, 1);
    EXPECT_EQ(stage_factors(track), (std::vector<json>{json::parse(R"(["fader", "pan"])")}));
    for (const json& route : track.at("mix")) {
        if (route.at("to") == "bus:wet") {
            EXPECT_TRUE(route.value("pre", false));
            EXPECT_EQ(route.at("of"), json::parse(R"(["mute", "send"])"));
        } else {
            EXPECT_EQ(route.at("of"), json::parse(R"(["master"])"));
        }
    }
}

TEST(Lanes, OneTrackOwnsATarget) {
    json request = lane_project(json::parse(R"([{"target": {"insert": 2}, "param": 1, "tick": 0, "value": 1}])"));
    json& clips = request["programs"][0]["timeline"]["clips"];
    clips[1]["automation"] = clips[0]["automation"];
    const std::string error = lane_error(request);
    EXPECT_NE(error.find("both automate"), std::string::npos) << error;
}

TEST(Lanes, ATrackThatNeverPlaysCannotCarryALane) {
    json request = lane_project(json::parse(R"([{"target": {"insert": 2}, "param": 1, "tick": 0, "value": 1}])"));
    request["programs"][0]["timeline"]["clips"][0]["notes"] = json::array();
    const std::string error = lane_error(request);
    EXPECT_NE(error.find("never plays"), std::string::npos) << error;
}

namespace {

// A track of two patches that share parameter 1, which a test gives whatever scope and starting values it wants.
json shared_param_project(const json& first, const json& second, const json& automation) {
    const auto graph = [](const json& param) {
        json g = json::parse(R"({"nodes": [{"id": 1, "type": "param", "param": 1}, {"id": 2, "type": "out"}],
            "edges": [{"from": 1, "to": 2, "input": "l"}]})");
        g["params"] = json::array({param});
        return g;
    };
    json request = json::parse(R"({"programs": [{"id": "a", "name": "a", "timeline": {"ppq": 480,
        "clips": [{"id": "c", "length": 960, "notes": [{"tick": 0, "note": 60, "dur": 480, "slot": 0},
                                                       {"tick": 480, "note": 60, "dur": 480, "slot": 1}]},
                  {"id": "plain", "length": 960, "notes": [{"tick": 0, "note": 60, "dur": 480}]}],
        "tracks": [{"id": 1, "slots": ["one", "two"], "placements": [{"clip": "c", "tick": 0}]}]}}]})");
    request["patches"]["one"] = {{"name", "one"}, {"graph", graph(first)}};
    request["patches"]["two"] = {{"name", "two"}, {"graph", graph(second)}};
    request["programs"][0]["timeline"]["clips"][0]["automation"] = automation;
    return request;
}

// The instructions before a stream's first Call, which is where it puts back what its lanes moved.
std::vector<Instruction> stream_head(const std::vector<std::byte>& image) {
    const LoadedImage loaded(image);
    EXPECT_EQ(loaded.loader.status(), LoadStatus::Ready);
    ProgramView v;
    const ChunkRef* c = loaded.table.find(loaded.loader.program_hash(0));
    EXPECT_TRUE(parse_program({c->data, c->size}, v));
    const TrackDesc track = v.track(0);
    std::vector<Instruction> head;
    for (u32 i = 0; i < track.stream_length; ++i) {
        const Instruction in = v.instruction(track.stream_begin + i);
        if (in.op == static_cast<u8>(Instr::Call) || in.op == static_cast<u8>(Instr::Wait)) break;
        head.push_back(in);
    }
    return head;
}

}  // namespace

TEST(Lanes, TheStreamPutsBackALaneWithNoTarget) {
    const json param = json::parse(R"({"id": 1, "min": 0, "max": 1, "default": 0.25})");
    const auto head = [&](const char* automation, const json& track = json::object(), const json& globals = {}) {
        json request = shared_param_project(param, param, json::parse(automation));
        json& timeline = request["programs"][0]["timeline"];
        timeline["tracks"][0].update(track);
        if (!globals.is_null()) timeline["globals"] = globals;
        return stream_head(compile_image(request).image);
    };
    const auto expect_restores = [](const std::vector<Instruction>& instructions, float value) {
        ASSERT_EQ(instructions.size(), 1u);
        EXPECT_EQ(instructions[0].op, static_cast<u8>(Instr::SetParam));
        EXPECT_EQ(instructions[0].b, 1u);
        EXPECT_EQ(std::bit_cast<float>(instructions[0].c), value);
    };

    expect_restores(head(R"([{"param": 1, "tick": 10, "value": 1}])"), 0.25f);
    expect_restores(head(R"([{"param": 1, "tick": 0, "value": 1, "ramp": 10}])"), 0.25f);
    expect_restores(head(R"([{"param": 1, "tick": 10, "value": 1}])", {{"params", {{"1", 0.5}}}}), 0.5f);
    EXPECT_TRUE(head(R"([{"param": 1, "tick": 0, "value": 1}, {"param": 1, "tick": 10, "value": 0}])").empty())
        << "it opens with a value, so the stream already puts it back";

    json placed_later = shared_param_project(param, param, json::parse(R"([{"param": 1, "tick": 0, "value": 1}])"));
    placed_later["programs"][0]["timeline"]["tracks"][0]["placements"] = json::parse(R"([{"clip": "plain", "tick": 0},
        {"clip": "c", "tick": 960}])");
    expect_restores(stream_head(compile_image(placed_later).image), 0.25f);
}

TEST(Lanes, AGlobalStartsFromTheProgramsValue) {
    const json param = json::parse(R"({"id": 1, "scope": "global", "min": 0, "max": 1, "default": 0.25})");
    json request = shared_param_project(param, param, json::parse(R"([{"param": 1, "tick": 10, "value": 1}])"));
    request["programs"][0]["timeline"]["globals"] = {{"1", 0.75}};
    const auto head = stream_head(compile_image(request).image);
    ASSERT_EQ(head.size(), 1u);
    EXPECT_EQ(std::bit_cast<float>(head[0].c), 0.75f);
}

TEST(Lanes, SlotsThatStartApartNeedAValueToReturnTo) {
    const json low = json::parse(R"({"id": 1, "min": 0, "max": 1, "default": 0.25})");
    const json high = json::parse(R"({"id": 1, "min": 0, "max": 1, "default": 0.75})");
    const json moved = json::parse(R"([{"param": 1, "tick": 10, "value": 1}])");

    EXPECT_NE(lane_error(shared_param_project(low, high, moved)).find("different values"), std::string::npos);

    json named = shared_param_project(low, high, moved);
    named["programs"][0]["timeline"]["tracks"][0]["params"] = {{"1", 0.5}};
    EXPECT_EQ(lane_error(named), "");
    EXPECT_EQ(lane_error(shared_param_project(low, high, json::parse(R"([{"param": 1, "tick": 0, "value": 1}])"))), "");

    // A SetParam clamps on each slot, so a value past one slot's range can still be right for both.
    const json narrow = json::parse(R"({"id": 1, "min": 0, "max": 0.25, "default": 0.25})");
    EXPECT_EQ(lane_error(shared_param_project(narrow, high, moved)), "");
    EXPECT_EQ(lane_error(shared_param_project(high, narrow, moved)), "");
}

TEST(Lanes, OneTrackOwnsAGlobal) {
    const json param = json::parse(R"({"id": 1, "scope": "global", "min": 0, "max": 1, "default": 0.25})");
    json request = shared_param_project(param, param, json::parse(R"([{"param": 1, "tick": 0, "value": 1}])"));
    json& timeline = request["programs"][0]["timeline"];
    timeline["tracks"].push_back(
        json::parse(R"({"id": 2, "slots": ["one"], "placements": [{"clip": "c", "tick": 0}]})"));
    timeline["clips"][0]["notes"] = json::parse(R"([{"tick": 0, "note": 60, "dur": 480}])");
    const std::string error = lane_error(request);
    EXPECT_NE(error.find("both automate global param 1"), std::string::npos) << error;
}

TEST(Lanes, AGlobalHasOneOwnerHoweverALaneReachesIt) {
    const json param = json::parse(R"({"id": 1, "scope": "global", "min": 0, "max": 1, "default": 0.25})");
    json request = shared_param_project(param, param, json::parse(R"([{"param": 1, "tick": 0, "value": 1}])"));
    json graph = request["patches"]["one"]["graph"];
    graph["nodes"] = json::parse(R"([{"id": 1, "type": "in"}, {"id": 2, "type": "param", "param": 1},
        {"id": 3, "type": "mul"}, {"id": 4, "type": "out"}])");
    graph["edges"] =
        json::parse(R"([{"from": 1, "port": "l", "to": 3, "input": "a"}, {"from": 2, "to": 3, "input": "b"},
        {"from": 3, "to": 4, "input": "l"}])");
    request["patches"]["gain"] = {{"name", "gain"}, {"graph", graph}};
    json& timeline = request["programs"][0]["timeline"];
    timeline["clips"].push_back(
        json::parse(R"({"id": "other", "length": 960, "notes": [{"tick": 0, "note": 60, "dur": 9}],
        "automation": [{"target": {"insert": 5}, "param": 1, "tick": 0, "value": 0}]})"));
    timeline["clips"][0]["notes"] = json::parse(R"([{"tick": 0, "note": 60, "dur": 480}])");
    timeline["tracks"].push_back(
        json::parse(R"({"id": 2, "slots": ["one"], "placements": [{"clip": "other", "tick": 0}],
        "inserts": [{"id": 5, "patch": "gain"}]})"));
    const std::string error = lane_error(request);
    EXPECT_NE(error.find("both automate global param 1"), std::string::npos) << error;
}

TEST(Lanes, ATrackThatNeverPlaysCannotMoveAGlobal) {
    const json scoped = json::parse(R"({"id": 1, "scope": "global", "min": 0, "max": 1, "default": 0.25})");
    json global = shared_param_project(scoped, scoped, json::parse(R"([{"param": 1, "tick": 0, "value": 1}])"));
    global["programs"][0]["timeline"]["tracks"].push_back(
        json::parse(R"({"id": 2, "slots": ["one"], "placements": [{"clip": "plain", "tick": 0}]})"));
    global["programs"][0]["timeline"]["clips"][0]["notes"] = json::array();
    EXPECT_NE(lane_error(global).find("never plays"), std::string::npos);

    // A track's own parameter reaches nothing past it, so a silent track's lane on one is only silent.
    const json plain = json::parse(R"({"id": 1, "min": 0, "max": 1, "default": 0.25})");
    json own = shared_param_project(plain, plain, json::parse(R"([{"param": 1, "tick": 0, "value": 1}])"));
    own["programs"][0]["timeline"]["tracks"].push_back(
        json::parse(R"({"id": 2, "slots": ["one"], "placements": [{"clip": "plain", "tick": 0}]})"));
    own["programs"][0]["timeline"]["clips"][0]["notes"] = json::array();
    EXPECT_EQ(lane_error(own), "");
}

TEST(Lanes, ALaneComesBeforeANoteAtItsTickAndAPlayChangeBeforeBoth) {
    json request = lane_project(json::parse(R"([{"target": {"insert": 1}, "param": 1, "tick": 0, "value": 0.5}])"));
    request["programs"][0]["timeline"]["clips"][0]["play"] = json::parse(R"([{"tick": 0, "mode": "mono"}])");
    const auto image = compile_image(request).image;
    const LoadedImage loaded(image);
    ASSERT_EQ(loaded.loader.status(), LoadStatus::Ready);
    ProgramView v;
    const ChunkRef* c = loaded.table.find(loaded.loader.program_hash(0));
    ASSERT_TRUE(parse_program({c->data, c->size}, v));
    EXPECT_EQ(v.h.features, kFeaturePlayModes);
    const ClipDesc clip = v.clip(0);
    EXPECT_EQ(v.instruction(clip.begin).op, static_cast<u8>(Instr::PlayMode));
    EXPECT_EQ(v.instruction(clip.begin + 1).op, static_cast<u8>(Instr::SetInsert));
    EXPECT_EQ(v.instruction(clip.begin + 2).op, static_cast<u8>(Instr::NoteOn));
}

TEST(Play, WhatAPlaySettingRefuses) {
    const auto error = [](const char* play) {
        json request = lane_project(json::array());
        request["programs"][0]["timeline"]["tracks"][0]["play"] = json::parse(play);
        return lane_error(request);
    };
    EXPECT_EQ(error(R"({"mode": "legato", "priority": "low", "glide": 0.1})"), "");
    EXPECT_NE(error(R"({"mode": "solo"})").find("unknown play mode"), std::string::npos);
    EXPECT_NE(error(R"({"mode": "mono", "priority": "first"})").find("unknown priority"), std::string::npos);
    EXPECT_NE(error(R"({"mode": "poly", "priority": "high"})").find("poly plays them all"), std::string::npos);
    EXPECT_NE(error(R"({"mode": "mono", "glide": -1})").find("0 to 60"), std::string::npos);
    EXPECT_NE(error(R"({"mode": "mono", "glide": 61})").find("0 to 60"), std::string::npos);
    EXPECT_NE(error(R"({"mode": "mono", "bend": 2})").find("no 'bend'"), std::string::npos);
}

TEST(Play, TheDefaultWritesNothing) {
    json plain = lane_project(json::array());
    json stated = plain;
    stated["programs"][0]["timeline"]["tracks"][0]["play"] = json::parse(R"({"mode": "poly"})");
    EXPECT_EQ(compile_image(plain).image, compile_image(stated).image);
}

TEST(Timeline, AFieldTheCompilerDoesNotKnowIsRefused) {
    const std::pair<const char*, const char*> cases[] = {
        {"/swing", "a timeline has no 'swing'"},
        {"/tempo/0/curve", "a tempo change has no 'curve'"},
        {"/clips/0/colour", "a clip has no 'colour'"},
        {"/clips/0/notes/0/velocity", "a note has no 'velocity'"},
        {"/clips/0/notes/0/legato", "a note has no 'legato'"},
        {"/clips/0/automation/0/shape", "a lane has no 'shape'"},
        {"/tracks/0/transpose", "a track has no 'transpose'"},
        {"/tracks/0/placements/0/loop_start", "a placement has no 'loop_start'"},
        {"/tracks/0/sends/0/post", "a send has no 'post'"},
        {"/tracks/0/inserts/0/bypass", "an insert has no 'bypass'"},
        {"/buses/0/name", "a bus has no 'name'"},
        {"/master/pan", "master has no 'pan'"},
        {"/tracks/0/params/cutoff", "by parameter id, and 'cutoff' isn't one"},
        {"/globals/70000", "by parameter id"},
    };
    for (const auto& [pointer, wanted] : cases) {
        SCOPED_TRACE(pointer);
        json request = lane_project(json::parse(R"([{"target": {"insert": 1}, "param": 1, "tick": 0, "value": 0.5}])"));
        json& timeline = request["programs"][0]["timeline"];
        timeline["tempo"] = json::parse(R"([{"tick": 0, "bpm": 120}])");
        timeline["globals"] = json::object();
        EXPECT_EQ(lane_error(request), "");
        timeline[json::json_pointer(pointer)] = 30;
        EXPECT_NE(lane_error(request).find(wanted), std::string::npos) << lane_error(request);
    }
}

// Time signatures, a pickup and key signatures are the editor's: they change where it draws bars and how it spells
// notes, and the same song compiles to the same bytes with them or without. Misspelt fields in them are refused like
// any other.
TEST(Timeline, MetersAndKeysAreTheEditorsAndChangeNoByte) {
    const json plain = lane_project(json::parse(R"([{"target": {"insert": 1}, "param": 1, "tick": 0, "value": 0.5}])"));
    json signed_ = plain;
    json& timeline = signed_["programs"][0]["timeline"];
    timeline["meter"] = json::parse(R"([{"tick": 0, "beats": 3, "unit": 8}, {"tick": 2160, "beats": 6, "unit": 8}])");
    timeline["pickup"] = 240;
    timeline["key"] = json::parse(R"([{"tick": 0, "fifths": 0, "minor": true}, {"tick": 2160, "fifths": -3}])");
    EXPECT_EQ(lane_error(signed_), "");
    EXPECT_EQ(compile_image(plain).image, compile_image(signed_).image);
    for (const auto& [pointer, wanted] : std::initializer_list<std::pair<const char*, const char*>>{
             {"/meter/0/bar", "a time signature has no 'bar'"},
             {"/key/1/mode", "a key signature has no 'mode'"},
         }) {
        SCOPED_TRACE(pointer);
        json bad = signed_;
        bad["programs"][0]["timeline"][json::json_pointer(pointer)] = 1;
        EXPECT_NE(lane_error(bad).find(wanted), std::string::npos) << lane_error(bad);
    }
}

TEST(Timeline, AKitIsTheEditorsAndChangesNoByte) {
    const json plain = lane_project(json::parse(R"([{"target": {"insert": 1}, "param": 1, "tick": 0, "value": 0.5}])"));
    json kitted = plain;
    kitted["programs"][0]["timeline"]["tracks"][0]["kit"] = json::parse(
        R"([{"note": 36, "name": "Bass Drum 1", "slot": 0}, {"note": 38, "name": "Acoustic Snare", "slot": 0}])");
    EXPECT_EQ(lane_error(kitted), "");
    EXPECT_EQ(compile_image(plain).image, compile_image(kitted).image);
    json bad = kitted;
    bad["programs"][0]["timeline"]["tracks"][0]["kit"][1]["key"] = 38;
    EXPECT_NE(lane_error(bad).find("a kit key has no 'key'"), std::string::npos) << lane_error(bad);
}

namespace {

// One track playing one clip through a placement the test describes.
json placed_project(const json& placement, const json& clip_extra = json::object()) {
    json request = lane_project(json::array());
    json& timeline = request["programs"][0]["timeline"];
    timeline["clips"][0] = json::parse(R"({"id": "c", "length": 960, "notes": [
        {"tick": 0, "note": 60, "vel": 101, "dur": 100}, {"tick": 480, "note": 64, "vel": 127, "dur": 100},
        {"tick": 720, "note": 67, "vel": 1, "dur": 100}]})");
    timeline["clips"][0].update(clip_extra);
    json placed = {{"clip", "c"}, {"tick", 0}};
    placed.update(placement);
    timeline["tracks"][0]["placements"] = json::array({placed});
    timeline["tracks"][0].erase("sends");
    timeline["tracks"][0].erase("inserts");
    timeline["tracks"].erase(1);
    return request;
}

struct Played {
    u32 tick, note, velocity;
    bool operator==(const Played&) const = default;
};

std::vector<Played> notes_of(const std::vector<Instruction>& code) {
    std::vector<Played> out;
    u32 tick = 0;
    for (const Instruction& i : code) {
        if (i.op == static_cast<u8>(Instr::Wait)) tick += i.c;
        if (i.op == static_cast<u8>(Instr::NoteOn)) out.push_back({tick, i.a, i.b});
    }
    return out;
}

}  // namespace

TEST(Placement, TransposesAndScalesWhatItPlays) {
    const Decoded d = decode(compile_image(placed_project({{"transpose", -12}, {"velocity", 0.5}})).image);
    ASSERT_EQ(d.clips.size(), 1u);
    // 101 / 2 rounds up, and 1 / 2 rounds to 1.
    EXPECT_EQ(notes_of(d.clip(0)), (std::vector<Played>{{0, 48, 51}, {480, 52, 64}, {720, 55, 1}}));
    const Decoded loud = decode(compile_image(placed_project({{"velocity", 2}})).image);
    EXPECT_EQ(notes_of(loud.clip(0)), (std::vector<Played>{{0, 60, 127}, {480, 64, 127}, {720, 67, 2}}));
}

TEST(Placement, PlaysAWindowOfItsClip) {
    const Decoded d = decode(compile_image(placed_project({{"start", 480}, {"length", 200}, {"repeat", 3}})).image);
    ASSERT_EQ(d.clips.size(), 1u);
    EXPECT_EQ(d.clips[0].ticks, 200u);
    EXPECT_EQ(notes_of(d.clip(0)), (std::vector<Played>{{0, 64, 127}}));  // The note at 720 is past the window
    EXPECT_EQ(d.h.length_ticks, 600u);
    const std::vector<Instruction> stream = d.stream(0);
    ASSERT_EQ(stream.size(), 2u);
    EXPECT_EQ(stream[0].op, static_cast<u8>(Instr::Call));
    EXPECT_EQ(stream[0].c, 3u);

    // Longer than what is left of the clip, it plays silence to its end.
    const Decoded longer = decode(compile_image(placed_project({{"start", 480}, {"length", 960}})).image);
    EXPECT_EQ(longer.clips[0].ticks, 960u);
    EXPECT_EQ(notes_of(longer.clip(0)), (std::vector<Played>{{0, 64, 127}, {240, 67, 1}}));
}

TEST(Placement, AnUntransformedPlacementIsTheSameBytes) {
    EXPECT_EQ(compile_image(placed_project(json::object())).image,
              compile_image(placed_project({{"transpose", 0}, {"velocity", 1}, {"start", 0}, {"length", 960}})).image);
}

TEST(Placement, WhatAPlacementRefuses) {
    const std::pair<json, const char*> cases[] = {
        {{{"transpose", 64}}, "transposes a note out of 0 to 127"},
        {{{"transpose", 200}}, "-127 to 127"},
        {{{"velocity", 100}}, "scales each note's, from 0 to 4"},
        {{{"start", 960}}, "starts after its clip ends"},
        {{{"length", 0}}, "has no length"},
        {{{"repeat", 0}}, "repeats 0 times"},
    };
    for (const auto& [placement, wanted] : cases) {
        SCOPED_TRACE(placement.dump());
        EXPECT_NE(lane_error(placed_project(placement)).find(wanted), std::string::npos)
            << lane_error(placed_project(placement));
    }
}

TEST(Placement, AWindowStartsWithEveryTargetWhereItsClipHadItThere) {
    const json lanes = json::parse(R"({"automation": [
        {"target": {"mix": "fader", "track": 1}, "tick": 0, "value": 0},
        {"target": {"mix": "fader", "track": 1}, "tick": 240, "value": 1, "ramp": 480},
        {"target": {"mix": "pan", "track": 1}, "tick": 100, "value": 0.5}],
        "play": [{"tick": 100, "mode": "mono"}]})");
    const json request = placed_project({{"start", 480}}, lanes);
    const Decoded d = decode(compile_image(request).image);
    const json report = compile_image(request).report;
    const json& track = reported_track(report, 1);
    const u16 fader = track.at("stages")[0].at("left"), pan = track.at("mix")[0].at("left");
    const std::vector<Instruction> body = d.clip(0);
    // The play change, then the fader halfway up its ramp and the rest of the ramp, then the pan where it stood.
    const auto op = [](Instr i) { return static_cast<u8>(i); };
    ASSERT_GE(body.size(), 9u);
    EXPECT_EQ(body[0].op, op(Instr::PlayMode));
    EXPECT_EQ(std::tie(body[1].op, body[1].b), std::make_tuple(op(Instr::SetMix), fader));
    EXPECT_EQ(std::bit_cast<float>(body[1].c), 0.5f);
    EXPECT_EQ(std::tie(body[3].op, body[3].b), std::make_tuple(op(Instr::RampMix), fader));
    EXPECT_EQ(std::bit_cast<float>(body[3].c), 1.0f);
    EXPECT_EQ(body[4].op, op(Instr::RampArg));
    EXPECT_EQ(body[4].c, 240u);
    EXPECT_EQ(std::tie(body[7].op, body[7].b), std::make_tuple(op(Instr::SetMix), pan));
    EXPECT_EQ(std::bit_cast<float>(body[7].c), compiler::detail::pan_left(0.5f));
}

TEST(Curve, ExactLogAndExpAgreeWithLibm) {
    for (const double x : {1e-6, 0.001, 0.37, 0.5, 0.70710678, 1.0, 1.5, 2.0, 10.0, 1234.5, 1e9}) {
        EXPECT_NEAR(compiler::detail::exact_log(x), std::log(x), 1e-14 * std::max(1.0, std::abs(std::log(x)))) << x;
    }
    for (const double y : {-20.0, -6.9, -1.0, -0.3, 0.0, 0.3, 1.0, 5.5, 20.0}) {
        EXPECT_NEAR(compiler::detail::exact_exp(y), std::exp(y), 1e-14 * std::exp(y)) << y;
    }
}

namespace {

// The values a lane's register on track 1, left, is ramped through, with the tick each segment starts at.
std::vector<std::pair<u32, float>> ramps_of(const std::vector<Instruction>& body, u16 reg) {
    std::vector<std::pair<u32, float>> out;
    u32 tick = 0;
    for (const Instruction& i : body) {
        if (i.op == static_cast<u8>(Instr::Wait)) tick += i.c;
        if ((i.op == static_cast<u8>(Instr::RampMix) || i.op == static_cast<u8>(Instr::SetMix)) && i.b == reg) {
            out.emplace_back(tick, std::bit_cast<float>(i.c));
        }
    }
    return out;
}

}  // namespace

TEST(Curve, AnExpRampIsASegmentPerDecibelThatLandsOnItsValue) {
    // 1 to 0.001 is 60 dB, so 60 segments, each 1 dB down from the last, after the point that sets 1.
    json request = placed_project(json::object(), json::parse(R"({"length": 3840, "automation": [
        {"target": {"mix": "fader", "track": 1}, "tick": 0, "value": 1},
        {"target": {"mix": "fader", "track": 1}, "tick": 0, "value": 0.001, "ramp": 1920, "curve": "exp"}]})"));
    const Decoded d = decode(compile_image(request).image);
    const json report = compile_image(request).report;
    const u16 reg = reported_track(report, 1).at("mix")[0].at("left");
    const auto ramps = ramps_of(d.clip(0), reg);
    ASSERT_EQ(ramps.size(), 61u);
    const float pan = compiler::detail::pan_left(0.0f);
    for (std::size_t k = 1; k < ramps.size(); ++k) {
        EXPECT_EQ(ramps[k].first, 1920 * (k - 1) / 60);
        EXPECT_NEAR(ramps[k].second / pan, std::pow(10.0, -static_cast<double>(k) / 20.0), 1e-6) << k;
    }
    EXPECT_EQ(ramps.back().second, 0.001f * pan);
}

TEST(Curve, ACurveToZeroFallsSixtyDecibelsAndLandsOnZero) {
    json request = placed_project(json::object(), json::parse(R"({"length": 3840, "automation": [
        {"target": {"mix": "fader", "track": 1}, "tick": 0, "value": 0, "ramp": 1920, "curve": "exp"}]})"));
    const Decoded d = decode(compile_image(request).image);
    const u16 reg = reported_track(compile_image(request).report, 1).at("mix")[0].at("left");
    const auto ramps = ramps_of(d.clip(0), reg);
    ASSERT_EQ(ramps.size(), 60u);  // From the track's fader of 1, which nothing set in the clip
    EXPECT_NEAR(ramps[29].second / compiler::detail::pan_left(0.0f), 0.001 * std::pow(10.0, 30.0 / 20.0), 1e-6);
    EXPECT_EQ(ramps.back().second, 0.0f);
}

TEST(Curve, ACurveStopsAtTheNextPointAndFinishesStraightPastItsClip) {
    json stopped = placed_project(json::object(), json::parse(R"({"length": 3840, "automation": [
        {"target": {"mix": "fader", "track": 1}, "tick": 0, "value": 0.001, "ramp": 1920, "curve": "exp"},
        {"target": {"mix": "fader", "track": 1}, "tick": 960, "value": 1}]})"));
    const u16 reg = reported_track(compile_image(stopped).report, 1).at("mix")[0].at("left");
    const auto heard = ramps_of(decode(compile_image(stopped).image).clip(0), reg);
    ASSERT_EQ(heard.size(), 31u);  // 30 segments start before 960, then the point there
    EXPECT_EQ(heard.back().first, 960u);

    json past = placed_project(json::object(), json::parse(R"({"length": 960, "automation": [
        {"target": {"mix": "fader", "track": 1}, "tick": 0, "value": 0.001, "ramp": 1920, "curve": "exp"}]})"));
    const auto body = decode(compile_image(past).image).clip(0);
    const auto ramps = ramps_of(body, reg);
    ASSERT_EQ(ramps.size(), 30u);
    EXPECT_EQ(ramps.back().first, 928u);
    EXPECT_EQ(ramps.back().second, 0.001f * compiler::detail::pan_left(0.0f));  // the last runs straight there
}

TEST(Curve, IsTheSameBitsOnEveryHost) {
    // libm differs between hosts, and these values enter a Program's hash, so wasm has to get these bits too.
    u64 hash = 14695981039346656037ull;
    for (const double from : {1.0, 0.0, 0.25, 3.0}) {
        for (const double to : {0.0, 0.001, 0.5, 2.0}) {
            for (const double t : {0.1, 0.37, 0.5, 0.9}) {
                const float value = static_cast<float>(compiler::detail::curve_at(from, to, t));
                hash = (hash ^ std::bit_cast<u32>(value)) * 1099511628211ull;
            }
            hash = (hash ^ compiler::detail::curve_steps(from, to)) * 1099511628211ull;
        }
    }
    EXPECT_EQ(hash, 5005548298328956064ull);
}

TEST(Curve, WhatACurveRefuses) {
    const auto error = [](const char* lane) {
        return lane_error(placed_project(json::object(), {{"automation", json::array({json::parse(lane)})}}));
    };
    EXPECT_NE(error(R"({"target": {"mix": "pan", "track": 1}, "tick": 0, "value": -1, "ramp": 9, "curve": "exp"})")
                  .find("needs values of 0 or more"),
              std::string::npos);
    EXPECT_NE(
        error(R"({"target": {"mix": "fader", "track": 1}, "tick": 0, "value": 1, "curve": "s"})").find("linear or exp"),
        std::string::npos);
    EXPECT_EQ(error(R"({"target": {"mix": "fader", "track": 1}, "tick": 0, "value": 1, "ramp": 9, "curve": "exp"})"),
              "");
}

TEST(Voices, AReportSaysHowManyNotesATrackHoldsAndWarnsWhenItHasTooFewVoices) {
    json request = placed_project(json::object(), json::parse(R"({"notes": [
        {"tick": 0, "note": 60, "dur": 480}, {"tick": 0, "note": 64, "dur": 480}, {"tick": 100, "note": 67, "dur": 480},
        {"tick": 480, "note": 72, "dur": 100}]})"));
    json& track = request["programs"][0]["timeline"]["tracks"][0];
    track["voices"] = 2;
    const json report = compile_image(request).report;
    EXPECT_EQ(reported_track(report, 1).at("notes_at_once"), 3);
    const json& warnings = report.at("programs")[0].at("warnings");
    ASSERT_EQ(warnings.size(), 1u);
    EXPECT_EQ(warnings[0].at("tick"), 100);
    EXPECT_NE(warnings[0].at("message").get<std::string>().find("3 notes at once with 2 voices"), std::string::npos);

    track["voices"] = 3;  // A note ending at 480 makes room for the one that starts there
    EXPECT_TRUE(compile_image(request).report.at("programs")[0].at("warnings").empty());
    track["voices"] = 1;
    track["play"] = {{"mode", "mono"}};
    EXPECT_TRUE(compile_image(request).report.at("programs")[0].at("warnings").empty());
}

namespace {

json zone_project(const json& node) {
    json request = json::parse(R"({"patches": {"p": {"name": "p", "graph": {
        "nodes": [{"id": 2, "type": "out"}], "edges": [{"from": 1, "port": "l", "to": 2, "input": "l"}]}}},
      "assets": {"a": {"frames": 2, "rate": 48000, "root_key": 40, "data": "AAAAAA=="}},
      "programs": [{"id": "a", "name": "a", "timeline": {"ppq": 480,
        "clips": [{"id": "c", "length": 960, "notes": [{"tick": 0, "note": 60, "dur": 960}]}],
        "tracks": [{"id": 1, "slots": ["p"], "placements": [{"clip": "c", "tick": 0}]}]}}]})");
    json sample = node;
    sample["id"] = 1;
    sample["type"] = "sample";
    request["patches"]["p"]["graph"]["nodes"].push_back(sample);
    return request;
}

std::string zone_error(const char* node) { return lane_error(zone_project(json::parse(node))); }

}  // namespace

TEST(Revision7, AStealThatFadesAndASlurThatBringsItsVelocityNeedRevisionSeven) {
    const auto compiled = [](const json& track) {
        json request = lane_project(json::array());
        request["programs"][0]["timeline"]["tracks"][0].update(track);
        return compile_image(request).image;
    };
    const auto revision = [](const std::vector<std::byte>& image) {
        return load<ManifestHeader>(image.data() + sizeof(ChunkHeader)).revision;
    };
    EXPECT_EQ(revision(compiled({{"steal", "cut"}})), kFrameSizeRevision) << "cut is what every track always did";
    const auto fading = compiled({{"steal", "fade"}});
    EXPECT_EQ(revision(fading), 7u);
    const Decoded d = decode(fading);
    EXPECT_EQ(d.h.features, kFeatureStealFades);
    EXPECT_EQ(d.stream(0)[0].op, static_cast<u8>(Instr::Steal));
    EXPECT_EQ(d.stream(0)[0].a, 1u);

    const auto slurred = compiled({{"play", {{"mode", "legato"}, {"slur_velocity", true}}}});
    EXPECT_EQ(revision(slurred), 7u);
    EXPECT_EQ(decode(slurred).stream(0)[0].a, static_cast<u8>(PlayKind::LegatoVelocity));
    EXPECT_EQ(revision(compiled({{"play", {{"mode", "legato"}}}})), 4u);

    json bad = lane_project(json::array());
    bad["programs"][0]["timeline"]["tracks"][0]["play"] = {{"mode", "mono"}, {"slur_velocity", true}};
    EXPECT_NE(lane_error(bad).find("only legato slurs"), std::string::npos);
    bad["programs"][0]["timeline"]["tracks"][0]["play"] = {{"mode", "poly"}};
    bad["programs"][0]["timeline"]["tracks"][0]["steal"] = "soft";
    EXPECT_NE(lane_error(bad).find("cut or fade"), std::string::npos);
}

TEST(Revision7, ZonesWithARoundRobinAFadeOrARelease) {
    const auto op_of = [](const char* node) {
        const LoadedImage loaded(compile_image(zone_project(json::parse(node))).image);
        EXPECT_EQ(loaded.loader.status(), LoadStatus::Ready);
        for (u32 i = 0; i < loaded.table.size(); ++i) {
            const ChunkRef& c = loaded.storage[i];
            if (c.kind != static_cast<u8>(ChunkKind::Patch)) continue;
            PatchView v;
            EXPECT_TRUE(parse_patch({c.data, c.size}, v));
            for (u32 s = 0; s < v.h.voice_steps; ++s) {
                const WireStep step = v.step(v.h.control_steps + s);
                if (step.op == static_cast<u8>(Op::Sample2) || step.op == static_cast<u8>(Op::Sample3)) {
                    return std::pair<int, int>(step.op, step.mode);
                }
            }
        }
        return std::pair<int, int>(0, 0);
    };
    EXPECT_EQ(op_of(R"({"mode": "zones", "zones": [{"asset": "a"}]})").first, static_cast<int>(Op::Sample2));
    EXPECT_EQ(op_of(R"({"mode": "zones", "zones": [{"asset": "a", "round_robin": [1, 2]}]})").first,
              static_cast<int>(Op::Sample3));
    EXPECT_EQ(op_of(R"({"mode": "zones", "zones": [{"asset": "a", "velocities": [0, 100], "fade": [0, 30]}]})").first,
              static_cast<int>(Op::Sample3));
    EXPECT_EQ(op_of(R"({"mode": "zones", "release": true, "zones": [{"asset": "a"}]})"),
              std::make_pair(static_cast<int>(Op::Sample3), static_cast<int>(kSampleRelease)));

    EXPECT_NE(zone_error(R"({"mode": "zones", "zones": [{"asset": "a", "round_robin": [3, 2]}]})").find("which, of"),
              std::string::npos);
    EXPECT_NE(zone_error(R"({"mode": "zones", "zones": [{"asset": "a", "velocities": [0, 10], "fade": [0, 30]}]})")
                  .find("within its velocities"),
              std::string::npos);
    EXPECT_NE(
        zone_error(R"({"mode": "zones", "release": true, "tail": true, "zones": [{"asset": "a"}]})").find("no tail"),
        std::string::npos);
    EXPECT_NE(zone_error(R"({"mode": "zones", "zones": [{"asset": "a", "volume": 2}]})").find("no 'volume'"),
              std::string::npos);
    EXPECT_NE(zone_error(R"({"asset": "a", "release": true})").find("only a sample in zones mode"), std::string::npos);
}

TEST(Sample2, TheModesKeepTheirOwnInputs) {
    EXPECT_EQ(zone_error(R"({"mode": "zones", "zones": [{"asset": "a"}], "reverse": true, "tail": true})"), "");
    EXPECT_EQ(zone_error(R"({"asset": "a"})"), "");
    EXPECT_NE(zone_error(R"({"asset": "a", "reverse": true})").find("zones mode"), std::string::npos);
    EXPECT_NE(zone_error(R"({"asset": "a", "zones": []})").find("zones mode"), std::string::npos);
    EXPECT_NE(zone_error(R"({"mode": "zones", "asset": "a", "zones": [{"asset": "a"}]})").find("their own"),
              std::string::npos);
    EXPECT_NE(zone_error(R"({"mode": "granular", "asset": "a"})").find("unknown sample mode"), std::string::npos);
    EXPECT_NE(zone_error(R"({"mode": "zones"})").find("1 to 256"), std::string::npos);
    EXPECT_NE(zone_error(R"({"mode": "zones", "zones": [{"asset": "b"}]})").find("no asset"), std::string::npos);
    EXPECT_NE(zone_error(R"({"mode": "zones", "zones": [{"asset": "a", "keys": [9, 8]}]})").find("keys"),
              std::string::npos);
    EXPECT_NE(zone_error(R"({"mode": "zones", "zones": [{"asset": "a", "velocities": [0, 128]}]})").find("velocities"),
              std::string::npos);
    EXPECT_NE(zone_error(R"({"mode": "zones", "zones": [{"asset": "a", "root": 200}]})").find("root"),
              std::string::npos);
}

TEST(Sample2, ARootDefaultsToTheAssetsAndRowsPadToAPowerOfTwo) {
    const auto compiled = compile_image(zone_project(json::parse(R"({"mode": "zones", "zones": [
        {"asset": "a", "keys": [0, 10]}, {"asset": "a", "keys": [11, 20], "root": 72.5},
        {"asset": "a", "keys": [21, 127]}]})")));
    const LoadedImage loaded(compiled.image);
    ASSERT_EQ(loaded.loader.status(), LoadStatus::Ready);
    bool found = false;
    for (u32 i = 0; i < loaded.table.size(); ++i) {
        const ChunkRef& c = loaded.storage[i];
        if (c.kind != static_cast<u8>(ChunkKind::Table)) continue;
        found = true;
        EXPECT_EQ(load<TableHeader>(c.data).length, 4 * kZoneFields);
        const auto field = [&](u32 row, u32 at) {
            return load<float>(c.data + sizeof(TableHeader) + (row * kZoneFields + at) * sizeof(float));
        };
        EXPECT_EQ(field(0, kZoneRoot), 40.0f);
        EXPECT_EQ(field(1, kZoneRoot), 72.5f);
        EXPECT_EQ(field(3, kZoneLowKey), 1.0f);
        EXPECT_EQ(field(3, kZoneHighKey), 0.0f);
    }
    EXPECT_TRUE(found);
}

namespace {

// A saw through a filter: what a subpatch is for. Its inlet cutoff sets the filter, and it has an outlet as well as
// out.
json filter_voice() {
    return json::parse(R"({
      "nodes": [
        {"id": 1, "type": "inlet", "name": "pitch", "default": 440},
        {"id": 2, "type": "inlet", "name": "cutoff", "default": 800},
        {"id": 3, "type": "osc", "wave": "saw"},
        {"id": 4, "type": "biquad"},
        {"id": 5, "type": "out"},
        {"id": 6, "type": "outlet", "name": "raw"}
      ],
      "edges": [
        {"from": 1, "to": 3, "input": "freq"},
        {"from": 3, "to": 4, "input": "in"},
        {"from": 2, "to": 4, "input": "cutoff"},
        {"from": 4, "to": 5, "input": "l"},
        {"from": 3, "to": 6, "input": "in"}
      ]})");
}

// The same voice by hand, so a subpatch can be heard against what it should have been.
json filter_voice_inline() {
    return json::parse(R"({
      "nodes": [
        {"id": 1, "type": "note"}, {"id": 2, "type": "mtof"}, {"id": 3, "type": "env"},
        {"id": 4, "type": "osc", "wave": "saw"}, {"id": 5, "type": "biquad", "inputs": {"cutoff": 1200}},
        {"id": 6, "type": "mul"}, {"id": 7, "type": "out"}
      ],
      "edges": [
        {"from": 1, "port": "pitch", "to": 2, "input": "in"},
        {"from": 2, "to": 4, "input": "freq"},
        {"from": 4, "to": 5, "input": "in"},
        {"from": 5, "to": 6, "input": "a"},
        {"from": 3, "to": 6, "input": "b"},
        {"from": 6, "to": 7, "input": "l"}
      ]})");
}

json filter_voice_user() {
    return json::parse(R"({
      "nodes": [
        {"id": 1, "type": "note"}, {"id": 2, "type": "mtof"}, {"id": 3, "type": "env"},
        {"id": 4, "type": "subpatch", "patch": "voice", "inputs": {"cutoff": 1200}},
        {"id": 6, "type": "mul"}, {"id": 7, "type": "out"}
      ],
      "edges": [
        {"from": 1, "port": "pitch", "to": 2, "input": "in"},
        {"from": 2, "to": 4, "input": "pitch"},
        {"from": 4, "port": "l", "to": 6, "input": "a"},
        {"from": 3, "to": 6, "input": "b"},
        {"from": 6, "to": 7, "input": "l"}
      ]})");
}

json library_request(json patches, const char* played = "user") {
    json r;
    r["patches"] = json::object();
    for (auto& [id, graph] : patches.items()) r["patches"][id] = {{"name", id}, {"graph", graph}};
    r["programs"] = json::array({program("p", one_note_timeline(played))});
    return r;
}

std::string subpatch_error(json patches, const char* played = "user") {
    try {
        (void)compile_image(library_request(std::move(patches), played));
    } catch (const CompileError& e) {
        return e.what();
    }
    return "";
}

std::vector<float> heard(const json& request) {
    Rig<kStereo> rig(compile_image(request).image);
    Event play{};
    play.kind = EventKind::Play;
    EXPECT_TRUE(rig.engine.send(play));
    return render_stereo(rig, 40);
}

}  // namespace

TEST(Subpatch, SoundsLikeTheSameNodesInline) {
    const auto by_hand = heard(library_request({{"user", filter_voice_inline()}}));
    const auto expanded = heard(library_request({{"user", filter_voice_user()}, {"voice", filter_voice()}}));
    ASSERT_GT(*std::max_element(by_hand.begin(), by_hand.end()), 0.01f);
    EXPECT_EQ(by_hand, expanded);
}

TEST(Subpatch, EntersAnImageOnlyInsideWhatUsesIt) {
    const auto result = compile_image(library_request({{"user", filter_voice_user()}, {"voice", filter_voice()}}));
    EXPECT_EQ(count_kind(result.report, "patch"), 1);
    EXPECT_EQ(result.report.at("compiled_patches"), 1);
}

TEST(Subpatch, IsTheSameBytesInAnyNodeOrder) {
    const json request = library_request({{"user", filter_voice_user()}, {"voice", filter_voice()}});
    const auto base = compile_image(request).image;
    std::mt19937 random(7);
    for (int i = 0; i < 20; ++i) {
        json shuffled = request;
        for (const char* id : {"user", "voice"}) {
            auto& nodes = shuffled["patches"][id]["graph"]["nodes"];
            auto& edges = shuffled["patches"][id]["graph"]["edges"];
            std::shuffle(nodes.begin(), nodes.end(), random);
            std::shuffle(edges.begin(), edges.end(), random);
        }
        EXPECT_EQ(compile_image(shuffled).image, base);
    }
}

// A state id carries a voice across a live swap, so it mustn't move because something else in the graph did.
TEST(Subpatch, AnEditElsewhereLeavesItsStateIdsAlone) {
    const auto state_ids = [](const json& request) {
        const auto result = compile_image(request);
        std::map<u8, std::set<u32>> ids;
        LoadedImage loaded(result.image);
        for (u32 i = 0; i < loaded.table.size(); ++i) {
            const ChunkRef& c = loaded.storage[i];
            if (c.kind != static_cast<u8>(ChunkKind::Patch)) continue;
            PatchView v;
            EXPECT_TRUE(parse_patch({c.data, c.size}, v));
            for (u32 s = 0; s < static_cast<u32>(v.h.control_steps) + v.h.voice_steps; ++s) {
                if (v.step(s).state_id != 0) ids[v.step(s).op].insert(v.step(s).state_id);
            }
        }
        return ids;
    };
    json request = library_request({{"user", filter_voice_user()}, {"voice", filter_voice()}});
    const auto before = state_ids(request);
    request["patches"]["user"]["graph"]["nodes"].push_back({{"id", 50}, {"type", "noise"}});
    request["patches"]["user"]["graph"]["nodes"].push_back({{"id", 51}, {"type", "add"}});
    auto& edges = request["patches"]["user"]["graph"]["edges"];
    edges.back()["from"] = 51;
    edges.push_back({{"from", 50}, {"to", 51}, {"input", "a"}});
    edges.push_back({{"from", 6}, {"to", 51}, {"input", "b"}});
    const auto after = state_ids(request);
    EXPECT_EQ(before.at(static_cast<u8>(Op::Saw)), after.at(static_cast<u8>(Op::Saw)));
    EXPECT_EQ(before.at(static_cast<u8>(Op::Biquad)), after.at(static_cast<u8>(Op::Biquad)));
}

TEST(Subpatch, TwoOfThemKeepTheirOwnState) {
    json user = filter_voice_user();
    user["nodes"].push_back({{"id", 8}, {"type", "subpatch"}, {"patch", "voice"}, {"inputs", {{"cutoff", 300}}}});
    user["nodes"].push_back({{"id", 9}, {"type", "add"}});
    user["edges"].push_back({{"from", 2}, {"to", 8}, {"input", "pitch"}});
    user["edges"].push_back({{"from", 4}, {"port", "l"}, {"to", 9}, {"input", "a"}});
    user["edges"].push_back({{"from", 8}, {"port", "l"}, {"to", 9}, {"input", "b"}});
    user["edges"][3]["from"] = 9;
    user["edges"][3].erase("port");
    const auto ops = compile_image(library_request({{"user", user}, {"voice", filter_voice()}}));
    LoadedImage loaded(ops.image);
    std::set<u32> saws;
    for (u32 i = 0; i < loaded.table.size(); ++i) {
        const ChunkRef& c = loaded.storage[i];
        if (c.kind != static_cast<u8>(ChunkKind::Patch)) continue;
        PatchView v;
        ASSERT_TRUE(parse_patch({c.data, c.size}, v));
        for (u32 s = 0; s < static_cast<u32>(v.h.control_steps) + v.h.voice_steps; ++s) {
            if (v.step(s).op == static_cast<u8>(Op::Saw)) saws.insert(v.step(s).state_id);
        }
    }
    EXPECT_EQ(saws.size(), 2u);
}

TEST(Subpatch, CanReachAnOutletAndARightOutputThatMirrorsALeftOne) {
    json user = filter_voice_user();
    user["edges"][2]["port"] = "raw";
    EXPECT_EQ(subpatch_error({{"user", user}, {"voice", filter_voice()}}), "");
    user["edges"][2]["port"] = "r";
    const auto right = heard(library_request({{"user", user}, {"voice", filter_voice()}}));
    const auto left = heard(library_request({{"user", filter_voice_user()}, {"voice", filter_voice()}}));
    EXPECT_EQ(left, right);
}

TEST(Subpatch, InAndOutMakeAnInsertAFilterInAVoice) {
    const json effect = json::parse(R"({
      "nodes": [{"id": 1, "type": "in"}, {"id": 2, "type": "mul", "inputs": {"b": 0.5}}, {"id": 3, "type": "out"}],
      "edges": [{"from": 1, "port": "l", "to": 2, "input": "a"}, {"from": 2, "to": 3, "input": "l"}]})");
    const json user = json::parse(R"({
      "nodes": [{"id": 1, "type": "noise"}, {"id": 2, "type": "env"}, {"id": 3, "type": "mul"},
                {"id": 4, "type": "subpatch", "patch": "half"}, {"id": 5, "type": "out"}],
      "edges": [{"from": 1, "to": 3, "input": "a"}, {"from": 2, "to": 3, "input": "b"},
                {"from": 3, "to": 4, "input": "l"}, {"from": 4, "port": "l", "to": 5, "input": "l"}]})");
    const auto result = compile_image(library_request({{"user", user}, {"half", effect}}));
    EXPECT_FALSE(result.image.empty());
    const auto audio = heard(library_request({{"user", user}, {"half", effect}}));
    EXPECT_GT(*std::max_element(audio.begin(), audio.end()), 0.01f);
}

TEST(Subpatch, AudioThroughAnInletStillCannotReachAnInputReadOnceAFrame) {
    json user = filter_voice_user();
    user["nodes"].push_back({{"id", 8}, {"type", "noise"}});
    user["edges"].push_back({{"from", 8}, {"to", 4}, {"input", "cutoff"}});
    user["nodes"][3]["inputs"].erase("cutoff");
    try {
        (void)compile_image(library_request({{"user", user}, {"voice", filter_voice()}}));
        FAIL() << "compiled";
    } catch (const CompileError& e) {
        EXPECT_NE(std::string(e.what()).find("put a snap node on the wire"), std::string::npos) << e.what();
        EXPECT_EQ(e.where.rfind("patch:user/node:4/node:", 0), 0u) << e.where;
    }
}

TEST(Subpatch, RefusesWhatItCannotBe) {
    const json voice = filter_voice();
    EXPECT_EQ(subpatch_error({{"user", json::parse(R"({"nodes": [{"id": 1, "type": "subpatch", "patch": "user"},
        {"id": 2, "type": "out"}], "edges": [{"from": 1, "port": "l", "to": 2, "input": "l"}]})")}}),
              "patch 'user' contains itself");
    json missing = filter_voice_user();
    missing["nodes"][3]["patch"] = "nothing";
    EXPECT_EQ(subpatch_error({{"user", missing}}), "no patch 'nothing' in the library");
    json unnamed = filter_voice_user();
    unnamed["nodes"][3].erase("patch");
    EXPECT_EQ(subpatch_error({{"user", unnamed}}), "a subpatch needs a patch");
    json no_input = filter_voice_user();
    no_input["edges"][1]["input"] = "volume";
    EXPECT_EQ(subpatch_error({{"user", no_input}, {"voice", voice}}), "no input 'volume'");
    json no_output = filter_voice_user();
    no_output["edges"][2]["port"] = "wet";
    EXPECT_EQ(subpatch_error({{"user", no_output}, {"voice", voice}}), "no output 'wet'");
    json no_literal = filter_voice_user();
    no_literal["nodes"][3]["inputs"]["volume"] = 1;
    EXPECT_EQ(subpatch_error({{"user", no_literal}, {"voice", voice}}), "no input 'volume'");
    json twins = voice;
    twins["nodes"][1]["name"] = "pitch";
    EXPECT_EQ(subpatch_error({{"user", filter_voice_user()}, {"voice", twins}}), "two inputs are named 'pitch'");
    json nameless = voice;
    nameless["nodes"][1].erase("name");
    EXPECT_EQ(subpatch_error({{"user", filter_voice_user()}, {"voice", nameless}}), "an inlet needs a name");
}

TEST(Subpatch, RefusesACycleThroughTwoPatches) {
    const auto wrapping = [](const char* inner) {
        json g = json::parse(R"({"nodes": [{"id": 1, "type": "subpatch"}, {"id": 2, "type": "out"}],
                                 "edges": [{"from": 1, "port": "l", "to": 2, "input": "l"}]})");
        g["nodes"][0]["patch"] = inner;
        return g;
    };
    EXPECT_NE(subpatch_error({{"a", wrapping("b")}, {"b", wrapping("a")}}, "a").find("contains itself"),
              std::string::npos);
}

TEST(Subpatch, RefusesNestingPastTheLimit) {
    json patches = json::object();
    for (int i = 0; i < 12; ++i) {
        json g = json::parse(R"({"nodes": [{"id": 1, "type": "subpatch"}, {"id": 2, "type": "out"}],
                                 "edges": [{"from": 1, "port": "l", "to": 2, "input": "l"}]})");
        g["nodes"][0]["patch"] = "p" + std::to_string(i + 1);
        patches["p" + std::to_string(i)] = g;
    }
    patches["p12"] = filter_voice();
    EXPECT_EQ(subpatch_error(patches, "p0"), "subpatches nest too deeply");
}

TEST(Subpatch, ACycleThroughOneNeedsADelayLikeAnyOther) {
    const json through = json::parse(R"({
      "nodes": [{"id": 1, "type": "inlet", "name": "in"}, {"id": 2, "type": "outlet", "name": "out"}],
      "edges": [{"from": 1, "to": 2, "input": "in"}]})");
    const json loop = json::parse(R"({
      "nodes": [{"id": 1, "type": "subpatch", "patch": "through"}, {"id": 2, "type": "add"}, {"id": 3, "type": "out"}],
      "edges": [{"from": 1, "port": "out", "to": 2, "input": "a"}, {"from": 2, "to": 1, "input": "in"},
                {"from": 2, "to": 3, "input": "l"}]})");
    EXPECT_NE(subpatch_error({{"user", loop}, {"through", through}}).find("in a cycle with no delay"),
              std::string::npos);
    json delayed = loop;
    delayed["nodes"].push_back({{"id", 4}, {"type", "delay"}, {"max", 0.5}});
    delayed["edges"][1] = {{"from", 2}, {"to", 4}, {"input", "in"}};
    delayed["edges"].push_back({{"from", 4}, {"to", 1}, {"input", "in"}});
    EXPECT_EQ(subpatch_error({{"user", delayed}, {"through", through}}), "");
}

TEST(Subpatch, ParametersMergeByIdAndTheGraphAboveSettlesAClash) {
    const auto with_param = [](double max) {
        json g = json::parse(R"({
          "params": [{"id": 3, "name": "drive", "min": 0}],
          "nodes": [{"id": 1, "type": "param", "param": 3}, {"id": 2, "type": "outlet", "name": "out"}],
          "edges": [{"from": 1, "to": 2, "input": "in"}]})");
        g["params"][0]["max"] = max;
        return g;
    };
    json user = json::parse(R"({
      "nodes": [{"id": 1, "type": "subpatch", "patch": "a"}, {"id": 2, "type": "subpatch", "patch": "b"},
                {"id": 3, "type": "noise"}, {"id": 4, "type": "mul"}, {"id": 5, "type": "mul"}, {"id": 6, "type": "out"}],
      "edges": [{"from": 3, "to": 4, "input": "a"}, {"from": 1, "port": "out", "to": 4, "input": "b"},
                {"from": 4, "to": 5, "input": "a"}, {"from": 2, "port": "out", "to": 5, "input": "b"},
                {"from": 5, "to": 6, "input": "l"}]})");
    EXPECT_EQ(subpatch_error({{"user", user}, {"a", with_param(2)}, {"b", with_param(2)}}), "");
    EXPECT_NE(subpatch_error({{"user", user}, {"a", with_param(2)}, {"b", with_param(9)}})
                  .find("declare param 3 differently"),
              std::string::npos);
    user["params"] = json::array({{{"id", 3}, {"name", "drive"}, {"min", 0}, {"max", 5}, {"default", 1}}});
    EXPECT_EQ(subpatch_error({{"user", user}, {"a", with_param(2)}, {"b", with_param(9)}}), "");
}

TEST(Subpatch, ALibraryKeepsOutWhatCanOnlyBePartOfAnother) {
    const json part = json::parse(R"({"nodes": [{"id": 1, "type": "noise"}, {"id": 2, "type": "outlet", "name": "out"}],
                                      "edges": [{"from": 1, "to": 2, "input": "in"}]})");
    json request = library_request({{"part", part}, {"user", simple_graph("saw")}});
    request["programs"] = json::array();
    EXPECT_EQ(count_kind(compile_image(request).report, "patch"), 1);
}

TEST(Sidecar, SaysWhatEachNodeOutputBecame) {
    const auto result = compile_image(library_request({{"user", filter_voice_inline()}}));
    const json& nodes = result.report.at("sidecar").at("user");
    EXPECT_EQ(nodes.at("1").at("ports").at("pitch").at("rate"), "control");
    EXPECT_EQ(nodes.at("2").at("ports").at("out").at("rate"), "control");
    EXPECT_EQ(nodes.at("4").at("ports").at("out").at("rate"), "audio");
    EXPECT_TRUE(nodes.contains("7"));  // The out node, which has no ports but is alive

    LoadedImage loaded(result.image);
    for (u32 i = 0; i < loaded.table.size(); ++i) {
        const ChunkRef& c = loaded.storage[i];
        if (c.kind != static_cast<u8>(ChunkKind::Patch)) continue;
        PatchView v;
        ASSERT_TRUE(parse_patch({c.data, c.size}, v));
        const json& saw = nodes.at("4").at("ports").at("out");
        const WireStep step = v.step(v.h.control_steps + saw.at("step").get<u32>());
        EXPECT_EQ(step.op, static_cast<u8>(Op::Saw));
        EXPECT_EQ(step.out[0], saw.at("operand").get<u16>());
    }
}

TEST(Sidecar, LeavesOutDeadNodes) {
    json graph = filter_voice_inline();
    graph["nodes"].push_back({{"id", 20}, {"type", "noise"}});
    const auto result = compile_image(library_request({{"user", graph}}));
    EXPECT_FALSE(result.report.at("sidecar").at("user").contains("20"));
}

TEST(Sidecar, ShowsASubpatchAsTheNodeTheAuthorPlaced) {
    const auto result = compile_image(library_request({{"user", filter_voice_user()}, {"voice", filter_voice()}}));
    const json& nodes = result.report.at("sidecar").at("user");
    EXPECT_EQ(nodes.at("4").at("ports").at("l").at("rate"), "audio");
    for (const auto& [id, node] : nodes.items()) EXPECT_LT(std::stoi(id), 100) << "an inner node leaked: " << id;
}

TEST(Sidecar, NeverReachesTheImage) {
    const json request = library_request({{"user", filter_voice_inline()}});
    json renamed = request;
    renamed["patches"]["user"]["graph"]["nodes"][0]["x"] = 40;
    EXPECT_EQ(compile_image(request).image, compile_image(renamed).image);
}

TEST(Catalog, ListsEveryNodeAnAuthorCanPlaceAndNoOthers) {
    const json catalog = compiler::node_catalog();
    std::set<std::string> types;
    for (const json& entry : catalog) types.insert(entry.at("type"));
    EXPECT_TRUE(types.count("osc") && types.count("math") && types.count("shape") && types.count("subpatch"));
    EXPECT_TRUE(types.count("inlet") && types.count("outlet"));
    EXPECT_FALSE(types.count("wire"));
    for (const json& entry : catalog) {
        if (entry.at("type") != "math") continue;
        EXPECT_EQ(entry.at("options").at(0).at("choices").size(), 8u);
    }
}
