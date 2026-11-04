#pragma once

// Authoring JSON to image bytes. Host-side only: it allocates and throws, and firmware never includes it.
//
// The rule that makes patch sharing work: a Patch chunk is a function of its graph alone. Nothing from a timeline,
// track or target reaches compile_patch(), so one library patch has one hash wherever it is used.

#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <map>
#include <nlohmann/json.hpp>
#include <optional>
#include <queue>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <tuple>
#include <vector>

#include <modsynth/Config.hpp>
#include <modsynth/Format.hpp>
#include <modsynth/Loader.hpp>
#include <modsynth/Peak.hpp>
#include <modsynth/Profile.hpp>
#include <modsynth/Synth.hpp>

namespace modsynth::compiler {

using json = nlohmann::json;

class CompileError : public std::runtime_error {
   public:
    CompileError(std::string where, const std::string& message)
        : std::runtime_error(message), where(std::move(where)) {}
    std::string where;
};

struct Chunk {
    ChunkKind kind{};
    std::vector<std::byte> payload;
    u64 hash = 0;
};

namespace detail {

class Writer {
   public:
    template <class T>
    void put(const T& value) {
        const auto* p = reinterpret_cast<const std::byte*>(&value);
        bytes.insert(bytes.end(), p, p + sizeof(T));
    }
    template <class T>
    void put_all(const std::vector<T>& values) {
        for (const T& v : values) put(v);
    }
    void align(std::size_t to) {
        while (bytes.size() % to != 0) bytes.push_back(std::byte{0});
    }
    std::vector<std::byte> bytes;
};

inline Chunk make_chunk(ChunkKind kind, std::vector<std::byte> payload) {
    Chunk c{kind, std::move(payload), 0};
    c.hash = hash_bytes(hash_seed(kind), c.payload.data(), c.payload.size());
    return c;
}

// libm differs between hosts, and these tables enter a hash. Only + and * here, which IEEE fixes, so a native host and
// wasm produce the same bytes. Building with -ffp-contract=off keeps FMA out of it.
inline double exact_sin_turns(double turns) {
    constexpr double pi = 3.14159265358979323846;
    double t = turns - static_cast<double>(static_cast<std::int64_t>(turns));
    if (t < 0) t += 1.0;
    if (t > 0.5) t -= 1.0;
    if (t > 0.25) t = 0.5 - t;
    if (t < -0.25) t = -0.5 - t;
    const double x = t * 2.0 * pi, x2 = x * x;
    double term = x, sum = x;
    for (int k = 1; k <= 9; ++k) {
        term = -term * x2 / static_cast<double>((2 * k) * (2 * k + 1));
        sum += term;
    }
    return sum;
}

inline Chunk make_sine_table() {
    constexpr u32 length = 2048;
    std::vector<float> samples(length);
    for (u32 i = 0; i < length; ++i) samples[i] = static_cast<float>(exact_sin_turns(static_cast<double>(i) / length));
    Writer w;
    w.put(TableHeader{length, 0});
    w.put_all(samples);
    w.put(samples[0]);  // guard
    return make_chunk(ChunkKind::Table, std::move(w.bytes));
}

inline std::vector<std::byte> decode_base64(const std::string& text, const std::string& where) {
    static constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    int table[256];
    std::fill(std::begin(table), std::end(table), -1);
    for (int i = 0; i < 64; ++i) table[static_cast<unsigned char>(alphabet[i])] = i;
    std::vector<std::byte> out;
    out.reserve(text.size() / 4 * 3);
    u32 buffer = 0;
    int bits = 0;
    for (const char c : text) {
        if (c == '=') break;
        const int v = table[static_cast<unsigned char>(c)];
        if (v < 0) throw CompileError(where, "asset data is not base64");
        buffer = (buffer << 6) | static_cast<u32>(v);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back(static_cast<std::byte>((buffer >> bits) & 0xFF));
        }
    }
    return out;
}

inline Chunk make_asset(const json& a, const std::string& where) {
    const std::string encoding = a.value("encoding", "i16");
    if (encoding != "i16" && encoding != "f32") throw CompileError(where, "unknown asset encoding '" + encoding + "'");
    const u32 channels = a.value("channels", 1u);
    const u32 frames = a.at("frames").get<u32>();
    const u32 sample_bytes = encoding == "i16" ? 2 : 4;
    if (channels != 1 && channels != 2) throw CompileError(where, "assets have 1 or 2 channels");
    AssetHeader h{};
    h.encoding = static_cast<u8>(encoding == "i16" ? AssetEncoding::I16 : AssetEncoding::F32);
    h.channels = static_cast<u8>(channels);
    h.root_key = static_cast<u8>(a.value("root_key", 60));
    h.native_rate = a.at("rate").get<float>();
    h.frames = frames;
    h.loop_start = a.value("loop_start", 0u);
    h.loop_end = a.value("loop_end", 0u);
    if (h.frames == 0) throw CompileError(where, "asset has no frames");
    if (h.loop_end != 0 && !(h.loop_start < h.loop_end && h.loop_end <= h.frames)) {
        throw CompileError(where, "asset loop is out of range");
    }
    const std::vector<std::byte> data = decode_base64(a.at("data").get<std::string>(), where);
    if (data.size() != static_cast<std::size_t>(frames) * channels * sample_bytes) {
        throw CompileError(where, "asset data does not match frames and channels");
    }
    Writer w;
    w.put(h);
    w.bytes.insert(w.bytes.end(), data.begin(), data.end());
    // The guard frame: the loop start for a loop, silence for a one-shot, so interpolation can always read idx + 1.
    const std::size_t frame_bytes = channels * sample_bytes;
    if (h.loop_end != 0) {
        const std::byte* from = data.data() + h.loop_start * frame_bytes;
        w.bytes.insert(w.bytes.end(), from, from + frame_bytes);
    } else {
        w.bytes.insert(w.bytes.end(), frame_bytes, std::byte{0});
    }
    return make_chunk(ChunkKind::Asset, std::move(w.bytes));
}

struct Value {
    Bank bank = Bank::None;
    int index = -1;
    [[nodiscard]] bool audio() const { return bank == Bank::Buffer; }
};

struct Ir {
    Op op{};
    u8 mode = 0;
    u16 resource = 0;
    u32 state_id = 0;
    bool control = false;
    Value out[2];
    Value in[4];
    int outs = 0;
    int ins = 0;
};

// A field that isn't one of these is refused, not ignored. A misspelt one would otherwise play as its default, and a
// newer document read by an older compiler would play without what it asked for.
inline void check_keys(const json& object, std::initializer_list<const char*> known, const std::string& where,
                       const std::string& what) {
    if (!object.is_object()) throw CompileError(where, what + " is an object");
    for (const auto& [name, value] : object.items()) {
        if (std::none_of(known.begin(), known.end(), [&](const char* k) { return name == k; })) {
            throw CompileError(where, what + " has no '" + name + "'");
        }
    }
}

struct InputSpec {
    const char* name;
    float def;
};

// A field of a node that isn't a wire, which the editor needs to offer. An empty list of choices means a number or a
// string, whichever `number` says.
struct OptionSpec {
    const char* name;
    std::vector<const char*> choices;
    bool number = false;
};

struct NodeSpec {
    const char* type;
    std::vector<InputSpec> inputs;
    std::vector<const char*> outputs;
    std::vector<OptionSpec> options = {};
};

inline const std::vector<NodeSpec>& node_specs() {
    static const std::vector<NodeSpec> specs = {
        {"note", {}, {"pitch", "velocity", "gate"}},
        {"param", {}, {"out"}, {{"param", {}, true}}},
        {"const", {}, {"out"}, {{"value", {}, true}}},
        {"osc",
         {{"freq", 440.0f}, {"width", 0.5f}, {"phase", 0.0f}, {"sync", 0.0f}, {"feedback", 0.0f}},
         {"out"},
         {{"wave", {"sine", "saw", "square", "triangle"}},
          {"mode", {"bandlimited", "naive", "fixed", "mod", "mod-naive"}}}},
        {"noise", {}, {"out"}},
        {"biquad",
         {{"in", 0.0f}, {"cutoff", 1000.0f}, {"q", 0.707f}},
         {"out"},
         {{"mode", {"lowpass", "highpass", "bandpass"}}}},
        {"env", {{"attack", 0.01f}, {"decay", 0.1f}, {"sustain", 0.7f}, {"release", 0.2f}}, {"out"}},
        {"sample",
         {{"ratio", 1.0f}, {"note", 60.0f}, {"start", 0.0f}},
         {"l", "r"},
         {{"mode", {"plain", "zones"}}, {"asset", {}}}},
        {"mul", {{"a", 1.0f}, {"b", 1.0f}}, {"out"}},
        {"add", {{"a", 0.0f}, {"b", 0.0f}}, {"out"}},
        {"mtof", {{"in", 69.0f}}, {"out"}},
        {"snap", {{"in", 0.0f}}, {"out"}},
        {"ratio", {{"in", 60.0f}}, {"out"}, {{"root", {}, true}}},
        {"pan", {{"in", 0.0f}, {"position", 0.0f}}, {"l", "r"}},
        // `line` is what the delay line holds: i16 takes half the memory, at about -96 dB of rounding.
        {"delay", {{"in", 0.0f}, {"time", 0.25f}}, {"out"}, {{"max", {}, true}, {"line", {"f32", "i16"}}}},
        {"comb",
         {{"in", 0.0f}, {"time", 0.03f}, {"feedback", 0.8f}, {"damp", 0.2f}},
         {"out"},
         {{"max", {}, true}, {"line", {"f32", "i16"}}}},
        {"allpass",
         {{"in", 0.0f}, {"time", 0.005f}, {"feedback", 0.5f}},
         {"out"},
         {{"max", {}, true}, {"line", {"f32", "i16"}}}},
        {"follow", {{"in", 0.0f}, {"release", 0.1f}}, {"out"}},
        {"lfo", {{"rate", 1.0f}, {"depth", 1.0f}}, {"out"}},
        {"math",
         {{"a", 0.0f}, {"b", 0.0f}, {"c", 0.0f}},
         {"out"},
         {{"mode", {"min", "max", "abs", "clip", "floor", "divide", "compare", "select"}}}},
        {"shape", {{"in", 0.0f}}, {"out"}},
        {"in", {}, {"l", "r"}, {{"index", {}, true}}},
        {"out", {{"l", 0.0f}, {"r", 0.0f}}, {}},
        // A graph's interface when it is used as a subpatch. Compiled by itself, an inlet is its default and nothing
        // reads an outlet.
        {"inlet", {}, {"out"}, {{"name", {}}, {"default", {}, true}}},
        {"outlet", {{"in", 0.0f}}, {}, {{"name", {}}}},
        // Stands where an inlet, an outlet or a subpatch's own in and out nodes were, once expanded. It writes no step.
        {"wire", {{"in", 0.0f}}, {"out"}},
    };
    return specs;
}

inline constexpr int kMaxSubpatchDepth = 8;

using PatchLookup = const json* (*)(const std::string& id, const void* context);

// Where one of a subpatch's outputs ended up, or an input, once it has been expanded away.
using PortMap = std::map<std::pair<int, std::string>, std::pair<int, std::string>>;

struct Expanded {
    json graph;
    PortMap outputs;  // for each subpatch in the graph given
};

// A subpatch's nodes need ids of their own that don't move when something else in either graph is edited, because a
// state id comes from an id, and a live swap carries state by it. So an id comes from the two ids it is made of, and a
// clash moves to the next free one, which depends only on ids because nodes are taken in id order. Hoisting them past
// 2^21 keeps them clear of what an editor hands out.
inline int fresh_id(int outer, int inner, int part, std::set<int>& used) {
    const int values[] = {outer, inner, part};
    const u64 hash = hash_bytes(kHashSeed, reinterpret_cast<const std::byte*>(values), sizeof values);
    int id = static_cast<int>(hash % (1u << 28)) + (1 << 21);
    while (!used.insert(id).second) ++id;
    return id;
}

// Replaces each subpatch node with a copy of its graph, so that no later pass knows they exist. What was an inlet, an
// outlet or the subpatch's own in or out node becomes a wire, which keeps ordering, dead-node removal and the rule that
// audio can't reach an input read once a frame working through a subpatch with nothing added. Parameters merge by id,
// because a timeline can only address one. A graph with no subpatch comes back unchanged.
inline Expanded expand_subpatches(const json& graph, const std::string& where, PatchLookup patches, const void* context,
                                  std::vector<std::string>& stack) {
    const json none = json::array();
    const json& listed = graph.contains("nodes") ? graph.at("nodes") : none;
    const auto is_subpatch = [](const json& n) { return n.value("type", std::string{}) == "subpatch"; };
    if (std::none_of(listed.begin(), listed.end(), is_subpatch)) return {graph, {}};

    std::map<int, const json*> ordered;
    std::set<int> used;
    for (const json& n : listed) {
        const int id = n.at("id").get<int>();
        if (!ordered.emplace(id, &n).second) {
            throw CompileError(where + "/node:" + std::to_string(id), "duplicate node id");
        }
        used.insert(id);
    }

    std::map<int, json> params;
    std::set<int> declared_here;
    for (const json& p : graph.value("params", json::array())) {
        const int id = p.at("id").get<int>();
        if (!params.emplace(id, p).second) throw CompileError(where, "duplicate param id " + std::to_string(id));
        declared_here.insert(id);
    }

    Expanded out;
    json nodes = json::array(), edges = json::array();
    PortMap inputs;
    for (const auto& [id, node] : ordered) {
        if (!is_subpatch(*node)) {
            nodes.push_back(*node);
            continue;
        }
        const std::string here = where + "/node:" + std::to_string(id);
        const std::string name = node->value("patch", std::string{});
        if (name.empty()) throw CompileError(here, "a subpatch needs a patch");
        if (std::find(stack.begin(), stack.end(), name) != stack.end()) {
            throw CompileError(here, "patch '" + name + "' contains itself");
        }
        if (stack.size() >= static_cast<std::size_t>(kMaxSubpatchDepth)) {
            throw CompileError(here, "subpatches nest too deeply");
        }
        const json* found = patches ? patches(name, context) : nullptr;
        if (!found) throw CompileError(here, "no patch '" + name + "' in the library");

        stack.push_back(name);
        const Expanded inner = expand_subpatches(*found, here, patches, context, stack);
        stack.pop_back();

        for (const json& p : inner.graph.value("params", json::array())) {
            const int pid = p.at("id").get<int>();
            const auto [at, added] = params.emplace(pid, p);
            if (!added && !declared_here.count(pid) && at->second != p) {
                throw CompileError(here, "two subpatches declare param " + std::to_string(pid) +
                                             " differently. Declare it in this graph to settle it");
            }
        }

        std::map<std::string, json> literals;
        const json typed_in = node->value("inputs", json::object());
        for (const auto& [input, value] : typed_in.items()) literals[input] = value;
        const auto add_wire = [&](int inner_id, int part, const std::string& input, std::optional<json> fallback) {
            const int wire = fresh_id(id, inner_id, part, used);
            json w = {{"id", wire}, {"type", "wire"}, {"_top", id}};
            w["_where"] = here + "/node:" + std::to_string(inner_id);
            const auto literal = literals.find(input);
            if (literal != literals.end()) {
                w["inputs"] = {{"in", literal->second}};
                literals.erase(literal);
            } else if (fallback) {
                w["inputs"] = {{"in", *fallback}};
            }
            nodes.push_back(std::move(w));
            return wire;
        };
        const auto add_input = [&](const std::string& port, int wire) {
            if (!inputs.try_emplace({id, port}, wire, "in").second) {
                throw CompileError(here, "two inputs are named '" + port + "'");
            }
        };
        const auto add_output = [&](const std::string& port, int wire) {
            if (!out.outputs.try_emplace({id, port}, wire, "out").second) {
                throw CompileError(here, "two outputs are named '" + port + "'");
            }
        };

        // Each inner node, in id order: where a wire to it now goes, and where a wire from it now comes from.
        std::map<int, const json*> inner_nodes;
        for (const json& n : inner.graph.at("nodes")) inner_nodes[n.at("id").get<int>()] = &n;
        std::map<int, int> renumbered;
        PortMap into, from;
        std::optional<std::array<int, 2>> inner_out;
        for (const auto& [inner_id, inner_node] : inner_nodes) {
            const std::string type = inner_node->at("type").get<std::string>();
            const std::string label = inner_node->value("name", std::string{});
            if ((type == "inlet" || type == "outlet") && label.empty()) {
                throw CompileError(here, "an " + type + " needs a name");
            }
            if (type == "inlet") {
                const int wire = add_wire(inner_id, 0, label, json(inner_node->value("default", 0.0f)));
                add_input(label, wire);
                from[{inner_id, "out"}] = {wire, "out"};
            } else if (type == "outlet") {
                const int wire = add_wire(inner_id, 0, "", std::nullopt);
                add_output(label, wire);
                into[{inner_id, "in"}] = {wire, "in"};
            } else if (type == "in") {
                if (inner_node->value("index", 0) != 0) throw CompileError(here, "a subpatch has no sidechain");
                const int left = add_wire(inner_id, 0, "l", std::nullopt),
                          right = add_wire(inner_id, 1, "r", std::nullopt);
                add_input("l", left);
                add_input("r", right);
                from[{inner_id, "l"}] = {left, "out"};
                from[{inner_id, "r"}] = {right, "out"};
            } else if (type == "out") {
                const int left = add_wire(inner_id, 0, "", std::nullopt),
                          right = add_wire(inner_id, 1, "", std::nullopt);
                add_output("l", left);
                add_output("r", right);
                into[{inner_id, "l"}] = {left, "in"};
                into[{inner_id, "r"}] = {right, "in"};
                inner_out = {left, right};
            } else {
                json copy = *inner_node;
                const int fresh = fresh_id(id, inner_id, 0, used);
                renumbered[inner_id] = fresh;
                copy["id"] = fresh;
                copy["_top"] = id;
                if (!copy.contains("_where")) copy["_where"] = here + "/node:" + std::to_string(inner_id);
                nodes.push_back(std::move(copy));
            }
        }
        if (!literals.empty()) throw CompileError(here, "no input '" + literals.begin()->first + "'");

        const auto rename = [&](const PortMap& ports, int inner_id,
                                const std::string& port) -> std::pair<int, std::string> {
            const auto moved = ports.find({inner_id, port});
            if (moved != ports.end()) return moved->second;
            const auto kept = renumbered.find(inner_id);
            if (kept == renumbered.end()) {
                throw CompileError(here, "edge at node " + std::to_string(inner_id) + " has nothing to reach");
            }
            return {kept->second, port};
        };
        std::map<std::string, json> reaching_out;  // what drives the inner out node's l and r, to mirror a lone one
        for (const json& e : inner.graph.value("edges", json::array())) {
            const auto [source, port] = rename(from, e.at("from").get<int>(), e.value("port", "out"));
            const auto [target, input] = rename(into, e.at("to").get<int>(), e.value("input", "in"));
            json edge = {{"from", source}, {"port", port}, {"to", target}, {"input", input}};
            if (inner_out && (target == (*inner_out)[0] || target == (*inner_out)[1])) {
                reaching_out[target == (*inner_out)[0] ? "l" : "r"] = edge;
            }
            edges.push_back(std::move(edge));
        }
        if (inner_out && reaching_out.size() == 1) {
            const bool only_left = reaching_out.count("l") != 0;
            json mirrored = reaching_out.begin()->second;
            mirrored["to"] = (*inner_out)[only_left ? 1 : 0];
            edges.push_back(std::move(mirrored));
        }
    }

    for (const json& e : graph.value("edges", json::array())) {
        json edge = e;
        const int source = e.at("from").get<int>(), target = e.at("to").get<int>();
        const std::string port = e.value("port", "out"), input = e.value("input", "in");
        const auto found_source = ordered.find(source), found_target = ordered.find(target);
        if (found_source != ordered.end() && is_subpatch(*found_source->second)) {
            const auto moved = out.outputs.find({source, port});
            if (moved == out.outputs.end()) {
                throw CompileError(where + "/node:" + std::to_string(source), "no output '" + port + "'");
            }
            edge["from"] = moved->second.first;
            edge["port"] = moved->second.second;
        }
        if (found_target != ordered.end() && is_subpatch(*found_target->second)) {
            const auto moved = inputs.find({target, input});
            if (moved == inputs.end()) {
                throw CompileError(where + "/node:" + std::to_string(target), "no input '" + input + "'");
            }
            edge["to"] = moved->second.first;
            edge["input"] = moved->second.second;
        }
        edges.push_back(std::move(edge));
    }

    out.graph = json::object();
    out.graph["nodes"] = std::move(nodes);
    out.graph["edges"] = std::move(edges);
    json merged = json::array();
    for (auto& [id, p] : params) merged.push_back(std::move(p));
    if (!merged.empty()) out.graph["params"] = std::move(merged);
    return out;
}

// What the graph editor is told about every node it can offer, from the table the compiler itself reads, so the two
// can't disagree. A subpatch's ports come from the graph it names, so it has none here.
inline json node_catalog() {
    json catalog = json::array();
    for (const NodeSpec& spec : node_specs()) {
        if (std::string_view(spec.type) == "wire") continue;
        json inputs = json::array();
        for (const InputSpec& input : spec.inputs) inputs.push_back({{"name", input.name}, {"default", input.def}});
        json options = json::array();
        for (const OptionSpec& option : spec.options) {
            options.push_back({{"name", option.name}, {"choices", option.choices}, {"number", option.number}});
        }
        catalog.push_back({{"type", spec.type}, {"inputs", inputs}, {"outputs", spec.outputs}, {"options", options}});
    }
    catalog.push_back({{"type", "subpatch"},
                       {"inputs", json::array()},
                       {"outputs", json::array()},
                       {"options", json::array({{{"name", "patch"}, {"choices", json::array()}, {"number", false}}})}});
    return catalog;
}

struct Node {
    int id = 0;
    std::string type;
    const NodeSpec* spec = nullptr;
    json config;
    struct Source {
        int node = -1;
        std::string port;
    };
    std::map<std::string, Source> edges;
    std::map<std::string, float> literals;
};

}  // namespace detail

using detail::node_catalog;

struct ParamInfo {
    u16 id = 0;
    std::string name;
    ParamScope scope = ParamScope::Track;
    float min = 0, max = 1, def = 0;
    u16 smooth_ms = 10;
};

struct CompiledPatch {
    Chunk chunk;
    std::vector<Chunk> resources;
    std::vector<ParamInfo> params;
    u32 inputs = 0;
    json nodes;  // The debug sidecar: for each graph node that survived, what its outputs became. It never enters the
                 // image.
};

using AssetLookup = const json* (*)(const std::string& id, const void* context);

// Compiles one graph. The result depends only on `source`, on the assets it names and on the graphs of its subpatches.
inline CompiledPatch compile_patch(const json& source, const std::string& where, AssetLookup assets = nullptr,
                                   const void* context = nullptr, detail::PatchLookup library = nullptr) {
    using namespace detail;
    std::vector<std::string> subpatch_stack;
    const Expanded expanded = expand_subpatches(source, where, library, context, subpatch_stack);
    const json& graph = expanded.graph;
    std::map<int, std::string> inner_where;
    std::map<int, int> top_node;  // for a node a subpatch brought in, the graph node it stands for
    for (const json& n : graph.at("nodes")) {
        if (n.contains("_where")) inner_where[n.at("id").get<int>()] = n.at("_where").get<std::string>();
        if (n.contains("_top")) top_node[n.at("id").get<int>()] = n.at("_top").get<int>();
    }
    const auto node_where = [&](int id) {
        const auto inner = inner_where.find(id);
        return inner != inner_where.end() ? inner->second : where + "/node:" + std::to_string(id);
    };

    std::map<int, Node> nodes;
    for (const json& n : graph.at("nodes")) {
        Node node;
        node.id = n.at("id").get<int>();
        node.type = n.at("type").get<std::string>();
        node.config = n;
        const auto& specs = node_specs();
        const auto it =
            std::find_if(specs.begin(), specs.end(), [&](const NodeSpec& s) { return node.type == s.type; });
        if (it == specs.end()) throw CompileError(node_where(node.id), "unknown node type '" + node.type + "'");
        node.spec = &*it;
        if (n.contains("inputs")) {
            for (const auto& [name, value] : n.at("inputs").items()) node.literals[name] = value.get<float>();
        }
        if (!nodes.emplace(node.id, std::move(node)).second) {
            throw CompileError(node_where(n.at("id").get<int>()), "duplicate node id");
        }
    }
    for (const json& e : graph.value("edges", json::array())) {
        const int from = e.at("from").get<int>(), to = e.at("to").get<int>();
        const std::string port = e.value("port", "out"), input = e.value("input", "in");
        const auto source = nodes.find(from);
        const auto target = nodes.find(to);
        if (source == nodes.end()) throw CompileError(where, "edge from unknown node " + std::to_string(from));
        if (target == nodes.end()) throw CompileError(where, "edge to unknown node " + std::to_string(to));
        const auto& outs = source->second.spec->outputs;
        if (std::find(outs.begin(), outs.end(), port) == outs.end()) {
            throw CompileError(node_where(from), "no output '" + port + "'");
        }
        const auto& ins = target->second.spec->inputs;
        if (std::none_of(ins.begin(), ins.end(), [&](const InputSpec& s) { return input == s.name; })) {
            throw CompileError(node_where(to), "no input '" + input + "'");
        }
        if (target->second.edges.count(input)) throw CompileError(node_where(to), "input '" + input + "' driven twice");
        target->second.edges[input] = {from, port};
    }

    int out_node = -1;
    for (const auto& [id, n] : nodes) {
        if (n.type != "out") continue;
        if (out_node != -1) throw CompileError(node_where(id), "a patch has one out node");
        out_node = id;
    }
    if (out_node == -1) throw CompileError(where, "patch has no out node");

    // Dead-node removal.
    std::set<int> live;
    {
        std::vector<int> stack{out_node};
        while (!stack.empty()) {
            const int id = stack.back();
            stack.pop_back();
            if (!live.insert(id).second) continue;
            for (const auto& [input, src] : nodes.at(id).edges) stack.push_back(src.node);
        }
    }

    // Delay splitting. A delay's read and write are separate items, so a loop through one has no cycle. Item ids sort
    // by node id, and within a delay the write comes first.
    const auto item = [](int id, int part) { return id * 2 + part; };
    std::map<int, std::set<int>> deps;  // item -> items it must follow
    const auto producer = [&](int id) { return item(id, nodes.at(id).type == "delay" ? 1 : 0); };
    for (const int id : live) {
        const Node& n = nodes.at(id);
        if (n.type == "delay") {
            deps[item(id, 0)];
            deps[item(id, 1)];
            for (const auto& [input, src] : n.edges) {
                deps[item(id, input == "time" ? 1 : 0)].insert(producer(src.node));
            }
        } else {
            deps[item(id, 0)];
            for (const auto& [input, src] : n.edges) deps[item(id, 0)].insert(producer(src.node));
        }
    }

    const auto reaches = [&](int from, int to) {  // does `to` depend, transitively, on `from`?
        std::set<int> seen;
        std::vector<int> stack{to};
        while (!stack.empty()) {
            const int current = stack.back();
            stack.pop_back();
            if (current == from) return true;
            if (!seen.insert(current).second) continue;
            for (const int d : deps[current]) stack.push_back(d);
        }
        return false;
    };
    // A feed-forward delay runs write-first, so a short Haas delay works. If that would close a loop, it is feedback.
    std::set<int> feedback;
    for (const int id : live) {
        if (nodes.at(id).type != "delay") continue;
        if (reaches(item(id, 1), item(id, 0))) {
            feedback.insert(id);
        } else {
            deps[item(id, 1)].insert(item(id, 0));
        }
    }

    // Kahn, smallest item first, so shuffled input gives identical bytes.
    std::vector<int> order;
    {
        std::map<int, int> pending;
        std::map<int, std::vector<int>> followers;
        for (const auto& [i, d] : deps) {
            pending[i] = static_cast<int>(d.size());
            for (const int p : d) followers[p].push_back(i);
        }
        std::priority_queue<int, std::vector<int>, std::greater<>> ready;
        for (const auto& [i, count] : pending) {
            if (count == 0) ready.push(i);
        }
        while (!ready.empty()) {
            const int i = ready.top();
            ready.pop();
            order.push_back(i);
            for (const int f : followers[i]) {
                if (--pending[f] == 0) ready.push(f);
            }
        }
        if (order.size() != deps.size()) {
            for (const auto& [i, count] : pending) {
                if (count > 0) throw CompileError(node_where(i / 2), "this node is in a cycle with no delay");
            }
        }
    }

    // Parameters are sorted by id, so declaration order does not reach the hash.
    std::vector<ParamInfo> params;
    int voice_scalars = kBuiltinVoiceScalars, track_scalars = 0;
    std::vector<ParamDesc> descs;
    {
        std::map<int, json> sorted;
        for (const json& p : graph.value("params", json::array())) {
            const int id = p.at("id").get<int>();
            if (id < 0 || id > 65535) throw CompileError(where, "param id out of range");
            if (!sorted.emplace(id, p).second) throw CompileError(where, "duplicate param id " + std::to_string(id));
        }
        for (const auto& [id, p] : sorted) {
            ParamInfo info;
            info.id = static_cast<u16>(id);
            info.name = p.value("name", std::string{});
            const std::string scope = p.value("scope", "track");
            info.scope = scope == "voice"    ? ParamScope::Voice
                         : scope == "global" ? ParamScope::Global
                                             : ParamScope::Track;
            info.min = p.value("min", 0.0f);
            info.max = p.value("max", 1.0f);
            info.def = p.value("default", info.min);
            info.smooth_ms = p.value("smooth_ms", static_cast<u16>(10));
            if (info.min > info.max) throw CompileError(where, "param " + std::to_string(id) + " has min above max");
            if (info.def < info.min || info.def > info.max) {
                throw CompileError(where, "param " + std::to_string(id) + " has its default outside min to max");
            }
            ParamDesc d{};
            d.id = info.id;
            d.scope = static_cast<u8>(info.scope);
            d.smooth_ms = info.smooth_ms;
            d.min = info.min;
            d.max = info.max;
            d.def = info.def;
            if (info.scope == ParamScope::Voice) {
                d.reg = static_cast<u16>(voice_scalars++);
            } else if (info.scope == ParamScope::Track) {
                d.reg = static_cast<u16>(track_scalars++);
            }
            descs.push_back(d);
            params.push_back(std::move(info));
        }
    }

    std::vector<float> consts;
    const auto constant = [&](float v) {
        for (std::size_t i = 0; i < consts.size(); ++i) {
            if (std::memcmp(&consts[i], &v, sizeof v) == 0) return Value{Bank::Const, static_cast<int>(i)};
        }
        consts.push_back(v);
        return Value{Bank::Const, static_cast<int>(consts.size() - 1)};
    };

    std::vector<Ir> steps;
    int virtual_buffers = 0;
    const auto new_buffer = [&] { return Value{Bank::Buffer, virtual_buffers++}; };
    std::map<std::pair<int, std::string>, Value> outputs;
    std::vector<Chunk> resources;
    std::vector<u64> refs;
    std::vector<float> delays;
    std::map<int, std::array<Value, 2>> in_ports;

    const auto add_ref = [&](Chunk chunk) {
        const u64 hash = chunk.hash;
        const auto it = std::find(refs.begin(), refs.end(), hash);
        if (it != refs.end()) return static_cast<u16>(it - refs.begin());
        refs.push_back(hash);
        resources.push_back(std::move(chunk));
        return static_cast<u16>(refs.size() - 1);
    };
    const auto is_hoistable = [](const Value& v) {
        return v.bank == Bank::Track || v.bank == Bank::Global || v.bank == Bank::Const;
    };
    // A control-rate step that depends on nothing per-voice runs once per track, in the control phase.
    const auto control_step = [&](Op op, std::initializer_list<Value> in, u32 state_id, u8 mode = 0) {
        Ir ir;
        ir.op = op;
        ir.mode = mode;
        ir.state_id = state_id;
        ir.ins = static_cast<int>(in.size());
        std::copy(in.begin(), in.end(), ir.in);
        const bool hoist = std::all_of(in.begin(), in.end(), is_hoistable) && op != Op::KSnap;
        if (hoist && op == Op::KLfo)
            ir.op = Op::KLfo2;  // It no longer belongs to a note, so it waits for the transport
        ir.control = hoist;
        ir.outs = 1;
        ir.out[0] = hoist ? Value{Bank::Track, track_scalars++} : Value{Bank::Voice, voice_scalars++};
        steps.push_back(ir);
        return ir.out[0];
    };
    const auto audio_step = [&](Op op, std::initializer_list<Value> in, int outs, u32 state_id, u8 mode = 0,
                                u16 resource = 0) {
        Ir ir;
        ir.op = op;
        ir.mode = mode;
        ir.state_id = state_id;
        ir.resource = resource;
        ir.ins = static_cast<int>(in.size());
        std::copy(in.begin(), in.end(), ir.in);
        ir.outs = outs;
        for (int i = 0; i < outs; ++i) ir.out[i] = new_buffer();
        steps.push_back(ir);
        return ir;
    };
    const auto to_buffer = [&](Value v) { return v.audio() ? v : audio_step(Op::Fill, {v}, 1, 0).out[0]; };

    const auto input = [&](const Node& n, const std::string& name) -> std::optional<Value> {
        const auto edge = n.edges.find(name);
        if (edge == n.edges.end()) return std::nullopt;
        return outputs.at({edge->second.node, edge->second.port});
    };
    const auto default_of = [&](const Node& n, const std::string& name) {
        const auto literal = n.literals.find(name);
        if (literal != n.literals.end()) return literal->second;
        for (const InputSpec& s : n.spec->inputs) {
            if (name == s.name) return s.def;
        }
        return 0.0f;
    };
    // An input read once a frame refuses audio, because reading one sample in a frame is right for an envelope and
    // silently wrong for anything fast, and only the patch's author knows which this is. A snap node says so.
    const auto scalar_in = [&](const Node& n, const std::string& name) {
        const auto v = input(n, name);
        if (!v) return constant(default_of(n, name));
        if (v->audio()) {
            throw CompileError(node_where(n.id), "input '" + name +
                                                     "' is read once a frame and cannot take audio. To read it "
                                                     "once a frame on purpose, put a snap node on the wire");
        }
        return *v;
    };
    const auto buffer_in = [&](const Node& n, const std::string& name) {
        const auto v = input(n, name);
        return to_buffer(v ? *v : constant(default_of(n, name)));
    };
    const auto add_delay = [&](const Node& n, float fallback) {
        const float seconds = n.config.value("max", fallback);
        if (!(seconds > 0.0f) || seconds > 60.0f) throw CompileError(node_where(n.id), "delay max must be 0 to 60 s");
        delays.push_back(seconds);
        return static_cast<u16>(delays.size() - 1);
    };
    // Whether a delay node's line holds 16-bit samples, which its ops' I16 forms use.
    const auto line_i16 = [&](const Node& n) {
        const std::string line = n.config.value("line", "f32");
        if (line != "f32" && line != "i16") throw CompileError(node_where(n.id), "unknown line '" + line + "'");
        return line == "i16";
    };

    std::map<int, u16> delay_lines;
    for (const int it : order) {
        const int id = it / 2;
        const bool second_part = it % 2 == 1;
        const Node& n = nodes.at(id);
        const u32 state = static_cast<u32>(id) * 8 + 1;
        const std::string& type = n.type;
        const auto set = [&](const char* port, Value v) { outputs[{id, port}] = v; };

        if (type == "note") {
            set("pitch", {Bank::Voice, kScalarNote});
            set("velocity", {Bank::Voice, kScalarVelocity});
            set("gate", {Bank::Voice, kScalarGate});
        } else if (type == "param") {
            const int pid = n.config.at("param").get<int>();
            const auto p = std::find_if(descs.begin(), descs.end(), [&](const ParamDesc& d) { return d.id == pid; });
            if (p == descs.end()) throw CompileError(node_where(id), "no param " + std::to_string(pid));
            const auto scope = static_cast<ParamScope>(p->scope);
            if (scope == ParamScope::Global) {
                set("out", {Bank::Global, static_cast<int>(p - descs.begin())});
            } else {
                set("out", {scope == ParamScope::Voice ? Bank::Voice : Bank::Track, p->reg});
            }
        } else if (type == "const") {
            set("out", constant(n.config.value("value", 0.0f)));
        } else if (type == "osc") {
            const std::string wave = n.config.value("wave", "sine");
            const std::string quality = n.config.value("mode", "bandlimited");
            const bool modulated = quality == "mod" || quality == "mod-naive";
            if (quality != "bandlimited" && quality != "naive" && quality != "fixed" && !modulated) {
                throw CompileError(node_where(id), "unknown osc mode '" + quality + "'");
            }
            if (quality == "fixed" && wave != "sine") throw CompileError(node_where(id), "only sine has a fixed mode");
            if (wave != "square" && input(n, "width")) throw CompileError(node_where(id), "only square has a width");
            if (wave != "sine" && input(n, "feedback")) throw CompileError(node_where(id), "only sine has feedback");
            for (const char* name : {"phase", "sync", "feedback"}) {
                if (!modulated && input(n, name)) {
                    throw CompileError(node_where(id), std::string("only an osc in mod mode has ") + name);
                }
            }
            const u8 mode = quality == "naive" ? kNaive : 0;
            if (modulated) {
                const bool naive = quality == "mod-naive";
                if (naive && wave != "saw" && wave != "square") {
                    throw CompileError(node_where(id), "only saw and square have a naive form");
                }
                const auto any_in = [&](const char* name) {
                    const auto v = input(n, name);
                    return v ? *v : constant(default_of(n, name));
                };
                const OscModMode form = wave == "sine"       ? OscModMode::Sine
                                        : wave == "triangle" ? OscModMode::Triangle
                                        : wave == "saw"      ? (naive ? OscModMode::NaiveSaw : OscModMode::Saw)
                                        : wave == "square"
                                            ? (naive ? OscModMode::NaivePulse : OscModMode::Pulse)
                                            : throw CompileError(node_where(id), "unknown wave '" + wave + "'");
                const Value fourth = wave == "sine"     ? any_in("feedback")
                                     : wave == "square" ? any_in("width")
                                                        : constant(0.0f);
                const Value freq = any_in("freq"), phase = any_in("phase"), sync = any_in("sync");
                set("out", audio_step(Op::OscMod, {freq, phase, sync, fourth}, 1, state, static_cast<u8>(form)).out[0]);
            } else if (quality == "fixed") {
                const Value freq = scalar_in(n, "freq");
                set("out", audio_step(Op::Tone, {freq}, 1, state).out[0]);
            } else if (wave == "sine") {
                const u16 table = add_ref(make_sine_table());
                const Value freq = scalar_in(n, "freq");
                set("out", audio_step(Op::Osc, {freq}, 1, state, 0, table).out[0]);
            } else if (wave == "saw") {
                const Value freq = scalar_in(n, "freq");
                set("out", audio_step(Op::Saw, {freq}, 1, state, mode).out[0]);
            } else if (wave == "square") {
                const Value freq = scalar_in(n, "freq"), width = scalar_in(n, "width");
                set("out", audio_step(Op::Pulse, {freq, width}, 1, state, mode).out[0]);
            } else if (wave == "triangle") {
                const Value freq = scalar_in(n, "freq");
                set("out", audio_step(Op::Triangle, {freq}, 1, state).out[0]);
            } else {
                throw CompileError(node_where(id), "unknown wave '" + wave + "'");
            }
        } else if (type == "noise") {
            set("out", audio_step(Op::Noise, {}, 1, state).out[0]);
        } else if (type == "biquad") {
            const std::string mode = n.config.value("mode", "lowpass");
            const BiquadMode m = mode == "highpass"   ? BiquadMode::HighPass
                                 : mode == "bandpass" ? BiquadMode::BandPass
                                 : mode == "lowpass"
                                     ? BiquadMode::LowPass
                                     : throw CompileError(node_where(id), "unknown mode '" + mode + "'");
            const Value in = buffer_in(n, "in"), cutoff = scalar_in(n, "cutoff"), q = scalar_in(n, "q");
            set("out", audio_step(Op::Biquad, {in, cutoff, q}, 1, state, static_cast<u8>(m)).out[0]);
        } else if (type == "env") {
            const Value a = scalar_in(n, "attack"), d = scalar_in(n, "decay"), s = scalar_in(n, "sustain"),
                        r = scalar_in(n, "release");
            set("out", audio_step(Op::Env, {a, d, s, r}, 1, state).out[0]);
        } else if (type == "sample") {
            const std::string mode = n.config.value("mode", "plain");
            const auto find_asset = [&](const std::string& asset) {
                const json* found = assets ? assets(asset, context) : nullptr;
                if (!found) throw CompileError(node_where(id), "no asset '" + asset + "'");
                return found;
            };
            if (mode == "plain") {
                for (const char* key : {"zones", "reverse", "tail", "release"}) {
                    if (n.config.contains(key)) {
                        throw CompileError(node_where(id), std::string("only a sample in zones mode has ") + key);
                    }
                }
                if (input(n, "note") || input(n, "start")) {
                    throw CompileError(node_where(id), "only a sample in zones mode has note and start");
                }
                const std::string asset = n.config.at("asset").get<std::string>();
                const u16 ref = add_ref(make_asset(*find_asset(asset), node_where(id)));
                const Value ratio = scalar_in(n, "ratio");
                const Ir ir = audio_step(Op::Sample, {ratio}, 2, state, 0, ref);
                set("l", ir.out[0]);
                set("r", ir.out[1]);
            } else if (mode == "zones") {
                if (input(n, "ratio"))
                    throw CompileError(node_where(id), "a sample in zones mode takes note, not ratio");
                if (n.config.contains("asset")) throw CompileError(node_where(id), "zones name their own assets");
                const json zones = n.config.value("zones", json::array());
                if (zones.empty() || zones.size() > kMaxZones) {
                    throw CompileError(node_where(id), "a sample has 1 to 256 zones");
                }
                // A round robin, a crossfade or a release needs Sample3's wider rows. Without them it is Sample2, so a
                // patch that uses none of them is the bytes it always was.
                const bool release = n.config.value("release", false);
                const bool wide = release || std::any_of(zones.begin(), zones.end(), [](const json& zone) {
                                      return zone.contains("round_robin") || zone.contains("fade");
                                  });
                const u32 fields = wide ? kZone3Fields : kZoneFields;
                std::vector<std::array<float, kZone3Fields>> rows;
                const auto range = [&](const json& zone, const char* key) {
                    const json pair = zone.value(key, json::array({0, 127}));
                    const int low = pair.at(0).get<int>(), high = pair.at(1).get<int>();
                    if (pair.size() != 2 || low < 0 || high > 127 || low > high) {
                        throw CompileError(node_where(id),
                                           std::string("zone ") + key + " must be two values, 0 to 127");
                    }
                    return std::pair(static_cast<float>(low), static_cast<float>(high));
                };
                for (const json& zone : zones) {
                    check_keys(zone, {"asset", "root", "keys", "velocities", "round_robin", "fade"}, node_where(id),
                               "a zone");
                    const std::string asset = zone.at("asset").get<std::string>();
                    const json* found = find_asset(asset);
                    const u16 ref = add_ref(make_asset(*found, node_where(id)));
                    const float root = zone.value("root", found->value("root_key", 60.0f));
                    if (!(root >= 0.0f && root <= 127.0f))
                        throw CompileError(node_where(id), "zone root must be 0 to 127");
                    const auto [low_key, high_key] = range(zone, "keys");
                    const auto [low_velocity, high_velocity] = range(zone, "velocities");
                    std::array<float, kZone3Fields> row{
                        low_key, high_key, low_velocity, high_velocity, static_cast<float>(ref), root};
                    if (zone.contains("round_robin")) {
                        // Which of how many, counting from 1: [2, 3] plays on the second note of every three.
                        const json rr = zone.at("round_robin");
                        const int position = rr.at(0).get<int>(), length = rr.at(1).get<int>();
                        if (rr.size() != 2 || length < 1 || length > static_cast<int>(kMaxZones) || position < 1 ||
                            position > length) {
                            throw CompileError(node_where(id), "a zone's round_robin is [which, of how many], from 1");
                        }
                        row[kZoneSeqPosition] = static_cast<float>(position - 1);
                        row[kZoneSeqLength] = static_cast<float>(length);
                    }
                    if (zone.contains("fade")) {
                        const json fade = zone.at("fade");
                        const float in = fade.at(0).get<float>(), out = fade.at(1).get<float>();
                        const float span = high_velocity - low_velocity;
                        if (fade.size() != 2 || !(in >= 0.0f && in <= span) || !(out >= 0.0f && out <= span)) {
                            throw CompileError(node_where(id),
                                               "a zone's fade is [in, out] in velocity, each within its velocities");
                        }
                        row[kZoneFadeIn] = in;
                        row[kZoneFadeOut] = out;
                    }
                    rows.push_back(row);
                }
                while (!std::has_single_bit(rows.size())) rows.push_back({1.0f});
                Writer table;
                table.put(TableHeader{static_cast<u32>(rows.size()) * fields, 0});
                for (const auto& row : rows) {
                    for (u32 f = 0; f < fields; ++f) table.put(row[f]);
                }
                table.put(0.0f);  // guard
                const u16 ref = add_ref(make_chunk(ChunkKind::Table, std::move(table.bytes)));
                const bool literal = n.literals.count("note") != 0;
                const Value note = input(n, "note") || literal ? scalar_in(n, "note") : Value{Bank::Voice, kScalarNote};
                const u8 flags =
                    static_cast<u8>((n.config.value("reverse", false) ? kSampleReverse : 0) |
                                    (n.config.value("tail", false) ? kSampleTail : 0) | (release ? kSampleRelease : 0));
                if (release && n.config.value("tail", false)) {
                    throw CompileError(node_where(id), "a release sample plays once through, so it has no tail");
                }
                const Ir ir =
                    audio_step(wide ? Op::Sample3 : Op::Sample2, {note, scalar_in(n, "start")}, 2, state, flags, ref);
                set("l", ir.out[0]);
                set("r", ir.out[1]);
            } else {
                throw CompileError(node_where(id), "unknown sample mode '" + mode + "'");
            }
        } else if (type == "mul" || type == "add") {
            const auto ca = input(n, "a"), cb = input(n, "b");
            const Value a = ca ? *ca : constant(default_of(n, "a")), b = cb ? *cb : constant(default_of(n, "b"));
            const bool mul = type == "mul";
            if (a.audio() && b.audio()) {
                set("out", audio_step(mul ? Op::Mul : Op::Add, {a, b}, 1, 0).out[0]);
            } else if (a.audio() || b.audio()) {
                set("out", audio_step(mul ? Op::MulS : Op::AddS, {a.audio() ? a : b, a.audio() ? b : a}, 1, 0).out[0]);
            } else {
                set("out", control_step(mul ? Op::KMul : Op::KAdd, {a, b}, 0));
            }
        } else if (type == "mtof") {
            set("out", control_step(Op::KMtoF, {scalar_in(n, "in")}, state));
        } else if (type == "snap") {
            const auto in = input(n, "in");
            set("out", in && in->audio() ? control_step(Op::KSnap, {*in}, 0)
                       : in              ? *in
                                         : constant(default_of(n, "in")));
        } else if (type == "ratio") {
            const int root = n.config.value("root", 60);
            if (root < 0 || root > 127) throw CompileError(node_where(id), "root must be 0 to 127");
            set("out", control_step(Op::KRatio, {scalar_in(n, "in")}, state, static_cast<u8>(root)));
        } else if (type == "pan") {
            const Value in = buffer_in(n, "in"), position = scalar_in(n, "position");
            const Ir ir = audio_step(Op::Pan, {in, position}, 2, 0);
            set("l", ir.out[0]);
            set("r", ir.out[1]);
        } else if (type == "delay") {
            if (!delay_lines.count(id)) delay_lines[id] = add_delay(n, 1.0f);
            const u16 line = delay_lines[id];
            const bool i16 = line_i16(n);
            if (second_part) {
                const Value time = scalar_in(n, "time");
                const u8 mode = feedback.count(id) ? kReadBeforeWrite : u8{0};
                set("out", audio_step(i16 ? Op::DelayReadI16 : Op::DelayRead, {time}, 1, state, mode, line).out[0]);
            } else {
                // A feedback delay's read may already have run, and this is where its input is finally known.
                audio_step(i16 ? Op::DelayWriteI16 : Op::DelayWrite, {buffer_in(n, "in")}, 0, state + 1, 0, line);
            }
        } else if (type == "comb") {
            const u16 line = add_delay(n, 0.1f);
            const Value in = buffer_in(n, "in"), time = scalar_in(n, "time"), fb = scalar_in(n, "feedback"),
                        damp = scalar_in(n, "damp");
            const Op op = line_i16(n) ? Op::CombI16 : Op::Comb;
            set("out", audio_step(op, {in, time, fb, damp}, 1, state, 0, line).out[0]);
        } else if (type == "allpass") {
            const u16 line = add_delay(n, 0.05f);
            const Value in = buffer_in(n, "in"), time = scalar_in(n, "time"), fb = scalar_in(n, "feedback");
            const Op op = line_i16(n) ? Op::AllpassI16 : Op::Allpass;
            set("out", audio_step(op, {in, time, fb}, 1, state, 0, line).out[0]);
        } else if (type == "follow") {
            const Value in = buffer_in(n, "in"), release = scalar_in(n, "release");
            set("out", audio_step(Op::Follow, {in, release}, 1, state).out[0]);
        } else if (type == "lfo") {
            const Value rate = scalar_in(n, "rate"), depth = scalar_in(n, "depth");
            set("out", control_step(Op::KLfo, {rate, depth}, state));
        } else if (type == "math") {
            struct Form {
                const char* name;
                MathMode mode;
                const char*
                    uses;    // the inputs it reads, because the rest read nothing and must not look as if they did
                float b, c;  // and what those two are if nothing says
            };
            static constexpr Form forms[] = {
                {"min", MathMode::Min, "ab", 0.0f, 0.0f},         {"max", MathMode::Max, "ab", 0.0f, 0.0f},
                {"abs", MathMode::Abs, "a", 0.0f, 0.0f},          {"clip", MathMode::Clip, "abc", -1.0f, 1.0f},
                {"floor", MathMode::Floor, "a", 0.0f, 0.0f},      {"divide", MathMode::Divide, "ab", 1.0f, 0.0f},
                {"compare", MathMode::Compare, "ab", 0.0f, 0.0f}, {"select", MathMode::Select, "abc", 1.0f, 0.0f},
            };
            const std::string mode = n.config.value("mode", "min");
            const auto form =
                std::find_if(std::begin(forms), std::end(forms), [&](const Form& f) { return mode == f.name; });
            if (form == std::end(forms)) throw CompileError(node_where(id), "unknown math mode '" + mode + "'");
            const std::string uses = form->uses;
            const auto operand_of = [&](const char* name, float fallback) {
                const bool used = uses.find(name) != std::string::npos;
                const auto v = input(n, name);
                if (!used) {
                    if (v) throw CompileError(node_where(id), mode + " has no input '" + name + "'");
                    return constant(0.0f);
                }
                if (v) return *v;
                const auto literal = n.literals.find(name);
                return constant(literal != n.literals.end() ? literal->second : fallback);
            };
            const Value a = operand_of("a", 0.0f), b = operand_of("b", form->b), c = operand_of("c", form->c);
            const u8 number = static_cast<u8>(form->mode);
            set("out", a.audio() || b.audio() || c.audio() ? audio_step(Op::Math, {a, b, c}, 1, 0, number).out[0]
                                                           : control_step(Op::KMath, {a, b, c}, 0, number));
        } else if (type == "shape") {
            const json curve = n.config.value("curve", json::array());
            if (curve.size() < 3 || curve.size() > (1u << 16) + 1 || !std::has_single_bit(curve.size() - 1)) {
                throw CompileError(node_where(id), "a curve has a power of two plus one points, from 3 to 65537");
            }
            Writer table;
            table.put(TableHeader{static_cast<u32>(curve.size() - 1), 0});
            for (const json& point : curve) {
                const float value = point.get<float>();
                if (!std::isfinite(value)) throw CompileError(node_where(id), "a curve's points must be finite");
                table.put(value);
            }
            const u16 ref = add_ref(make_chunk(ChunkKind::Table, std::move(table.bytes)));
            set("out", audio_step(Op::Shape, {buffer_in(n, "in")}, 1, 0, 0, ref).out[0]);
        } else if (type == "wire") {
            const auto in = input(n, "in");
            set("out", in ? *in : constant(default_of(n, "in")));
        } else if (type == "inlet") {
            set("out", constant(n.config.value("default", 0.0f)));
        } else if (type == "in") {
            const int index = n.config.value("index", 0);
            if (index < 0 || index > 1) throw CompileError(node_where(id), "in index must be 0 or 1");
            auto& ports = in_ports[index];
            if (ports[0].bank == Bank::None) ports = {new_buffer(), new_buffer()};
            set("l", ports[0]);
            set("r", ports[1]);
        }
    }

    const Node& out = nodes.at(out_node);
    const auto left_in = input(out, "l"), right_in = input(out, "r");
    if (!left_in && !right_in) throw CompileError(node_where(out_node), "out node has no input");
    const Value left = to_buffer(left_in ? *left_in : *right_in);
    const Value right = right_in && left_in ? to_buffer(*right_in) : left;

    // An insert with only a sidechain input still has a main pair, because RunInsert always fills it.
    const int input_pairs = in_ports.empty() ? 0 : in_ports.rbegin()->first + 1;
    for (int i = 0; i < input_pairs; ++i) {
        if (in_ports[i][0].bank == Bank::None) in_ports[i] = {new_buffer(), new_buffer()};
    }

    // Buffer allocation by last use. Control steps touch no buffers, so only the voice list matters.
    std::vector<Ir> control, voice;
    for (const Ir& ir : steps) (ir.control ? control : voice).push_back(ir);

    std::vector<int> last_use(virtual_buffers, -1);
    for (int i = 0; i < static_cast<int>(voice.size()); ++i) {
        for (int a = 0; a < voice[i].ins; ++a) {
            if (voice[i].in[a].audio()) last_use[voice[i].in[a].index] = i;
        }
    }
    const int forever = static_cast<int>(voice.size());
    last_use[left.index] = forever;
    last_use[right.index] = forever;

    std::map<int, int> assigned;
    std::set<int> free_list;
    int next_register = 0;
    const auto allocate = [&] {
        if (free_list.empty()) return next_register++;
        const int r = *free_list.begin();
        free_list.erase(free_list.begin());
        return r;
    };
    for (int i = 0; i < input_pairs; ++i) {
        assigned[in_ports[i][0].index] = allocate();
        assigned[in_ports[i][1].index] = allocate();
    }
    for (int i = 0; i < static_cast<int>(voice.size()); ++i) {
        Ir& ir = voice[i];
        const bool may_alias = ir.outs == 1;
        const auto release_inputs = [&] {
            for (int a = 0; a < ir.ins; ++a) {
                if (!ir.in[a].audio() || last_use[ir.in[a].index] != i) continue;
                const auto found = assigned.find(ir.in[a].index);
                if (found != assigned.end()) {
                    free_list.insert(found->second);
                    last_use[ir.in[a].index] = -2;  // once, even if an input appears twice
                }
            }
        };
        if (may_alias) release_inputs();
        for (int o = 0; o < ir.outs; ++o) {
            if (ir.out[o].audio()) assigned[ir.out[o].index] = allocate();
        }
        if (!may_alias) release_inputs();
        for (int o = 0; o < ir.outs; ++o) {
            if (ir.out[o].audio() && last_use[ir.out[o].index] < i && last_use[ir.out[o].index] != -2) {
                free_list.insert(assigned.at(ir.out[o].index));  // Written but never read
            }
        }
    }
    if (next_register > static_cast<int>(kMaxRegisters)) throw CompileError(where, "patch needs too many buffers");
    if (voice_scalars > static_cast<int>(kMaxRegisters) || track_scalars > static_cast<int>(kMaxRegisters)) {
        throw CompileError(where, "patch needs too many scalars");
    }

    const auto encode = [&](const Value& v) -> u16 {
        if (v.bank == Bank::None) return 0;
        if (v.audio()) return operand(Bank::Buffer, static_cast<u16>(assigned.at(v.index)));
        return operand(v.bank, static_cast<u16>(v.index));
    };
    const auto wire = [&](const Ir& ir) {
        WireStep s{};
        s.op = static_cast<u8>(ir.op);
        s.mode = ir.mode;
        s.resource = ir.resource;
        s.state_id = ir.state_id;
        for (int i = 0; i < ir.outs; ++i) s.out[i] = encode(ir.out[i]);
        for (int i = 0; i < ir.ins; ++i) s.in[i] = encode(ir.in[i]);
        return s;
    };

    PatchHeader h{};
    h.control_steps = static_cast<u16>(control.size());
    h.voice_steps = static_cast<u16>(voice.size());
    h.buffers = static_cast<u16>(next_register);
    h.voice_scalars = static_cast<u16>(voice_scalars);
    h.track_scalars = static_cast<u16>(track_scalars);
    h.params = static_cast<u16>(descs.size());
    h.refs = static_cast<u16>(refs.size());
    h.consts = static_cast<u16>(consts.size());
    h.delays = static_cast<u16>(delays.size());
    h.inputs = static_cast<u16>(input_pairs);
    h.out_left = encode(left);
    h.out_right = encode(right);

    Writer w;
    w.put(h);
    w.put_all(descs);
    w.put_all(refs);
    w.align(4);
    w.put_all(consts);
    w.put_all(delays);
    for (int i = 0; i < input_pairs; ++i) {
        w.put(static_cast<u16>(assigned.at(in_ports[i][0].index)));
        w.put(static_cast<u16>(assigned.at(in_ports[i][1].index)));
    }
    w.align(4);
    for (const Ir& ir : control) w.put(wire(ir));
    for (const Ir& ir : voice) w.put(wire(ir));

    // Buffers get reused, so a register holds a node's signal only just after the step that wrote it, and a probe has
    // to say which step. A scalar stays where it was put.
    std::map<int, int> written_at;
    for (int i = 0; i < static_cast<int>(voice.size()); ++i) {
        for (int o = 0; o < voice[i].outs; ++o) {
            if (voice[i].out[o].audio()) written_at[voice[i].out[o].index] = i;
        }
    }
    const auto describe = [&](const Value& v) {
        json port = {{"rate", v.audio() ? "audio" : "control"}};
        if (v.audio()) {
            const auto step = written_at.find(v.index);
            port["step"] = step != written_at.end() ? step->second : -1;  // An in port is filled before the first step
            port["operand"] = encode(v);
        } else if (v.bank == Bank::Voice || v.bank == Bank::Track) {
            port["step"] = static_cast<int>(voice.size()) - 1;  // By then whatever writes it this frame has
            port["operand"] = encode(v);
        }
        return port;
    };
    json sidecar = json::object();
    const auto note_port = [&](int id, const std::string& port, const Value& v) {
        sidecar[std::to_string(id)]["ports"][port] = describe(v);
    };
    for (const auto& [key, value] : outputs) {
        if (!top_node.count(key.first)) note_port(key.first, key.second, value);
    }
    for (const auto& [key, flat] : expanded.outputs) {
        const auto value = outputs.find(flat);
        if (value != outputs.end()) note_port(key.first, key.second, value->second);
    }
    for (const auto& [id, top] : top_node) {
        if (live.count(id) && !sidecar.contains(std::to_string(top)))
            sidecar[std::to_string(top)]["ports"] = json::object();
    }
    sidecar[std::to_string(out_node)]["ports"] = json::object();

    CompiledPatch result;
    result.nodes = std::move(sidecar);
    result.chunk = make_chunk(ChunkKind::Patch, std::move(w.bytes));
    result.resources = std::move(resources);
    result.params = std::move(params);
    result.inputs = static_cast<u32>(input_pairs);
    return result;
}

namespace detail {

inline std::string hex(u64 hash) {
    static constexpr char digits[] = "0123456789abcdef";
    std::string s(16, '0');
    for (int i = 15; i >= 0; --i) {
        s[static_cast<std::size_t>(i)] = digits[hash & 0xF];
        hash >>= 4;
    }
    return s;
}

// Everything an image can hold, gathered while Programs compile. Chunks are keyed by hash, so sharing is automatic.
struct ImageContext {
    const json* patches = nullptr;
    const json* assets = nullptr;
    std::map<std::string, CompiledPatch> compiled;  // by library id
    std::map<u64, Chunk> chunks;
    std::map<u64, std::set<std::size_t>> users;  // chunk hash -> programs reaching it
};

inline const json* find_asset(const std::string& id, const void* context) {
    const auto* c = static_cast<const ImageContext*>(context);
    if (!c->assets || !c->assets->contains(id)) return nullptr;
    return &c->assets->at(id);
}

inline const json* find_graph(const std::string& id, const void* context) {
    const auto* c = static_cast<const ImageContext*>(context);
    if (!c->patches->contains(id)) return nullptr;
    return &c->patches->at(id).at("graph");
}

inline const CompiledPatch& compiled_patch(ImageContext& image, const std::string& id, std::size_t program,
                                           const std::string& where) {
    if (!image.compiled.count(id)) {
        if (!image.patches->contains(id)) throw CompileError(where, "no patch '" + id + "' in the library");
        const json& entry = image.patches->at(id);
        image.compiled[id] = compile_patch(entry.at("graph"), "patch:" + id, find_asset, &image, find_graph);
    }
    const CompiledPatch& p = image.compiled.at(id);
    image.chunks.try_emplace(p.chunk.hash, p.chunk);
    image.users[p.chunk.hash].insert(program);
    for (const Chunk& r : p.resources) {
        image.chunks.try_emplace(r.hash, r);
        image.users[r.hash].insert(program);
    }
    return p;
}

constexpr u32 kDefaultPpq = 480;

inline float pan_left(float pan) { return static_cast<float>(exact_sin_turns((1.0 - pan) * 0.125)); }
inline float pan_right(float pan) { return static_cast<float>(exact_sin_turns((1.0 + pan) * 0.125)); }

// libm's log and exp differ between hosts too, and a curve's values enter a hash, so these also use only + * / and the
// exact operations frexp, ldexp and floor.
inline double exact_log(double x) {
    constexpr double ln2 = 0.69314718055994530942;
    int e = 0;
    double m = std::frexp(x, &e);
    if (m < 0.70710678118654752440) {
        m *= 2.0;
        --e;
    }
    const double z = (m - 1.0) / (m + 1.0), z2 = z * z;
    double term = z, sum = z;
    for (int k = 1; k <= 12; ++k) {
        term *= z2;
        sum += term / static_cast<double>(2 * k + 1);
    }
    return 2.0 * sum + static_cast<double>(e) * ln2;
}

inline double exact_exp(double y) {
    constexpr double ln2 = 0.69314718055994530942;
    const double k = std::floor(y / ln2 + 0.5);
    const double r = y - k * ln2;
    double term = 1.0, sum = 1.0;
    for (int n = 1; n <= 20; ++n) {
        term = term * r / static_cast<double>(n);
        sum += term;
    }
    return std::ldexp(sum, static_cast<int>(k));
}

// A lane's `"curve": "exp"` moves by equal ratios, which is even in decibels for a gain and in pitch for a frequency. 0
// has no ratio, so a curve to or from 0 runs to or from 60 dB below its other end, and lands on 0 at the end.
constexpr double kCurveFloor = 0.001;
constexpr u32 kMaxCurveSteps = 256;

inline double curve_at(double from, double to, double t) {
    if (t >= 1.0) return to;
    if (t <= 0.0) return from;
    const double a = from > 0.0 ? from : to * kCurveFloor;
    const double b = to > 0.0 ? to : from * kCurveFloor;
    if (!(a > 0.0 && b > 0.0)) return from + (to - from) * t;
    return a * exact_exp(t * exact_log(b / a));
}

// The engine ramps in straight lines, so a curve is compiled as one per decibel it spans. None strays from the curve
// by more than 0.015 dB.
inline u32 curve_steps(double from, double to) {
    const double a = from > 0.0 ? from : to * kCurveFloor;
    const double b = to > 0.0 ? to : from * kCurveFloor;
    if (!(a > 0.0 && b > 0.0) || a == b) return 1;
    const double decibels = std::abs(exact_log(b / a)) * (20.0 / 2.30258509299404568402);
    return static_cast<u32>(std::clamp(std::ceil(decibels), 1.0, static_cast<double>(kMaxCurveSteps)));
}

// What a lane's target is doing, in ticks from the start of the clip being compiled: holding `to`, or on its way there
// from `from`, in a straight line or along a curve.
struct LaneState {
    double from = 0.0, to = 0.0, begin = 0.0, end = 0.0;
    bool curved = false;
    [[nodiscard]] double at(double tick) const {
        if (tick >= end) return to;
        if (tick <= begin) return from;
        const double t = (tick - begin) / (end - begin);
        return curved ? curve_at(from, to, t) : from + (to - from) * t;
    }
    // Seen from `ticks` later. A target that has arrived is only its value, so a clip that leaves it alone sees the
    // same thing at every repeat.
    [[nodiscard]] LaneState later(double ticks) const {
        if (end - ticks <= 0.0) return {to, to, 0.0, 0.0, false};
        return {from, to, begin - ticks, end - ticks, curved};
    }
    // A start no lane has needed yet is NaN, which is the same as another.
    bool operator==(const LaneState& o) const {
        const auto same = [](double a, double b) { return a == b || (std::isnan(a) && std::isnan(b)); };
        return same(from, o.from) && same(to, o.to) && begin == o.begin && end == o.end && curved == o.curved;
    }
};
using LaneStates = std::map<std::string, LaneState>;

// What a mix register pair can hold. It holds their product, so a lane on one of them writes that product with the
// others' fixed values in it. A fader holds its chain's mute with it, and a pre-fader send holds the mute alone.
enum MixFactor : unsigned { kFaderFactor = 1, kMuteFactor = 2, kPanFactor = 4, kSendFactor = 8, kMasterFactor = 16 };

struct MixValues {
    float fader, mute, pan, send, master;
};

// Always in this order, so the bits never depend on which factor a lane moves, and are what they always were.
inline float gain_of(unsigned of, const MixValues& v, bool right) {
    float g = 1.0f;
    if (of & kFaderFactor) {
        g = v.fader * v.mute;
    } else if (of & kMuteFactor) {
        g = v.mute;
    }
    if (of & kPanFactor) g *= right ? pan_right(v.pan) : pan_left(v.pan);
    if (of & kSendFactor) g *= v.send;
    if (of & kMasterFactor) g *= v.master;
    return g;
}

inline json factor_names(unsigned of) {
    json names = json::array();
    for (const auto& [bit, name] :
         {std::pair{kFaderFactor, "fader"}, std::pair{kMuteFactor, "mute"}, std::pair{kPanFactor, "pan"},
          std::pair{kSendFactor, "send"}, std::pair{kMasterFactor, "master"}}) {
        if (of & bit) names.push_back(name);
    }
    return names;
}

struct Chain {
    enum Kind { TrackChain, BusChain, MasterChain } kind = TrackChain;
    std::string key;
    const json* doc = nullptr;
    bool has_notes = false;
    float fader = 1.0f, mute = 1.0f, pan = 0.0f;
    struct Output {
        std::string to;
        float send;  // 1 unless it is a send
        bool is_send, pre;
        unsigned of = 0;  // the factors its registers hold
        int reg = -1;     // its left gain's mix register, with the right one next, once the mixer has one for it
    };
    std::vector<Output> outputs;
    // Factors applied to the whole chain by a step of their own, so a lane can move one while another lane moves
    // something its outputs hold. A chain's come after its inserts, and master's before, where its fader always was.
    struct Stage {
        unsigned of;
        int reg = -1;  // its gain pair, as for an output
    };
    std::vector<Stage> stages;
    std::vector<std::string> keys;  // sidechain sources of its inserts
    bool live = false;
    int reg = -1;      // the bus its signal ends on, after any stages
    int pre_reg = -1;  // the bus before a track's or bus's stages, which a meter, a sidechain and a pre-fader send read
    int step = -1;     // the mix step that completes pre_reg, or for master its last
    json mix = json::array();
};

// Values by parameter id, as a track's, an insert's and the globals are.
inline void check_param_values(const json& values, const std::string& where, const std::string& what) {
    if (!values.is_object()) throw CompileError(where, what + " is an object");
    for (const auto& [key, value] : values.items()) {
        const bool digits = !key.empty() && key.size() <= 5 &&
                            std::all_of(key.begin(), key.end(), [](char c) { return c >= '0' && c <= '9'; });
        if (!digits || std::stoul(key) > 65535) {
            throw CompileError(where, what + " are by parameter id, and '" + key + "' isn't one");
        }
        if (!value.is_number()) throw CompileError(where, what + " are numbers");
    }
}

inline void check_list(const json& list, const std::string& where, const std::string& what) {
    if (!list.is_array()) throw CompileError(where, what + " is a list");
}

inline void check_timeline(const json& doc, const std::string& where) {
    // `meter`, `pickup` and `key` are the editor's: where bars fall and how notes are spelled, which change how a song
    // is drawn and never how it plays. They are checked for misspellings like the rest and otherwise ignored.
    check_keys(doc, {"ppq", "tempo", "meter", "pickup", "key", "clips", "tracks", "buses", "master", "globals"}, where,
               "a timeline");
    const auto list = [&](const json& d, const char* name, const std::string& at) -> const json& {
        static const json none = json::array();
        if (!d.contains(name)) return none;
        check_list(d.at(name), at, name);
        return d.at(name);
    };
    for (const json& t : list(doc, "tempo", where)) check_keys(t, {"tick", "bpm", "ramp"}, where, "a tempo change");
    for (const json& m : list(doc, "meter", where)) check_keys(m, {"tick", "beats", "unit"}, where, "a time signature");
    for (const json& k : list(doc, "key", where)) check_keys(k, {"tick", "fifths", "minor"}, where, "a key signature");
    for (const json& clip : list(doc, "clips", where)) {
        const std::string at = where + "/clip:" + (clip.is_object() ? clip.value("id", std::string{}) : "");
        check_keys(clip, {"id", "length", "notes", "automation", "play"}, at, "a clip");
        for (const json& n : list(clip, "notes", at))
            check_keys(n, {"tick", "note", "vel", "dur", "slot"}, at, "a note");
        for (const json& a : list(clip, "automation", at)) {
            check_keys(a, {"param", "target", "tick", "value", "ramp", "curve"}, at, "a lane");
        }
        for (const json& p : list(clip, "play", at)) {
            check_keys(p, {"tick", "mode", "priority", "glide", "slur_velocity"}, at, "a play change");
        }
    }
    const auto chain = [&](const json& d, const std::string& at) {
        for (const json& s : list(d, "sends", at)) check_keys(s, {"bus", "gain", "pre"}, at, "a send");
        for (const json& i : list(d, "inserts", at)) {
            check_keys(i, {"id", "patch", "params", "key"}, at, "an insert");
            if (i.contains("params")) check_param_values(i.at("params"), at, "an insert's params");
        }
    };
    for (const json& t : list(doc, "tracks", where)) {
        const std::string at = where + "/track:" + (t.is_object() && t.contains("id") ? t.at("id").dump() : "");
        check_keys(t,
                   {"id", "name", "voices", "slots", "params", "placements", "play", "steal", "gain", "pan", "mute",
                    "output", "sends", "inserts"},
                   at, "a track");
        for (const json& p : list(t, "placements", at)) {
            check_keys(p, {"clip", "tick", "repeat", "transpose", "velocity", "start", "length"}, at, "a placement");
        }
        if (t.contains("params")) check_param_values(t.at("params"), at, "a track's params");
        chain(t, at);
    }
    for (const json& b : list(doc, "buses", where)) {
        const std::string at = where + "/bus:" + (b.is_object() ? b.value("id", std::string{}) : "");
        check_keys(b, {"id", "gain", "pan", "mute", "output", "sends", "inserts"}, at, "a bus");
        chain(b, at);
    }
    if (doc.contains("master")) {
        check_keys(doc.at("master"), {"gain", "inserts"}, where + "/master", "master");
        chain(doc.at("master"), where + "/master");
    }
    if (doc.contains("globals")) check_param_values(doc.at("globals"), where, "globals");
}

// What a placement plays of its clip: a window of it, transposed and with its velocities scaled.
struct Placed {
    const json* clip;
    u32 tick, repeat;
    u32 start, length;  // the window, in the clip's ticks
    int transpose;
    double velocity;
    // Whether a note of the clip is in the window. One that starts before it doesn't play, as in most editors.
    [[nodiscard]] bool plays(u32 note_tick) const { return note_tick >= start && note_tick - start < length; }
    [[nodiscard]] u32 span() const { return repeat * length; }
};

inline Placed read_placement(const json& placed, const std::map<std::string, const json*>& clips,
                             const std::string& where) {
    const std::string id = placed.at("clip").get<std::string>();
    if (!clips.count(id)) throw CompileError(where, "no clip '" + id + "'");
    const json& clip = *clips.at(id);
    const u32 clip_length = clip.at("length").get<u32>();
    Placed p{&clip, placed.at("tick").get<u32>(), placed.value("repeat", 1u),   placed.value("start", 0u),
             0,     placed.value("transpose", 0), placed.value("velocity", 1.0)};
    if (p.repeat == 0) throw CompileError(where, "a placement repeats 0 times");
    if (clip_length != 0 && p.start >= clip_length) throw CompileError(where, "a placement starts after its clip ends");
    p.length = placed.value("length", clip_length - std::min(p.start, clip_length));
    if (p.length == 0) throw CompileError(where, "a placement has no length");
    if (p.transpose < -127 || p.transpose > 127) throw CompileError(where, "transpose must be -127 to 127");
    if (!(p.velocity >= 0.0 && p.velocity <= 4.0)) {
        throw CompileError(where, "a placement's velocity scales each note's, from 0 to 4");
    }
    if (static_cast<u64>(p.repeat) * p.length > kMaxTicks) throw CompileError(where, "a placement is too long");
    return p;
}

}  // namespace detail

// Compiles one timeline. Patches enter the image only by being reached from here.
inline json compile_program(detail::ImageContext& image, const json& entry, std::size_t program_index,
                            bool keep_unused) {
    using namespace detail;
    const json& doc = entry.at("timeline");
    const std::string name = entry.value("name", std::string{});
    const std::string where = "timeline:" + (entry.contains("id") ? entry.at("id").dump() : name);
    check_timeline(doc, where);

    const u32 ppq = doc.value("ppq", kDefaultPpq);
    if (ppq == 0 || ppq > 65535) throw CompileError(where, "ppq must be 1 to 65535");

    const json clips_doc = doc.value("clips", json::array());
    std::map<std::string, const json*> clips;
    for (const json& c : clips_doc) clips[c.at("id").get<std::string>()] = &c;

    // Step 1 and 2 of the walk: what do placed clips actually play?
    std::map<std::string, Chain> chains;
    std::vector<std::string> chain_order;
    const json empty_list = json::array();
    const json& tracks_doc = doc.contains("tracks") ? doc.at("tracks") : empty_list;
    const json& buses_doc = doc.contains("buses") ? doc.at("buses") : empty_list;

    const auto add_outputs = [&](Chain& c, const json& d) {
        c.fader = d.value("gain", 1.0f);
        c.pan = d.value("pan", 0.0f);
        if (!(c.pan >= -1.0f && c.pan <= 1.0f)) throw CompileError(where + "/" + c.key, "pan must be -1 to 1");
        c.mute = d.value("mute", false) ? 0.0f : 1.0f;
        c.outputs.push_back({d.value("output", "master"), 1.0f, false, false});
        for (const json& s : d.value("sends", json::array())) {
            c.outputs.push_back(
                {"bus:" + s.at("bus").get<std::string>(), s.value("gain", 1.0f), true, s.value("pre", false)});
        }
        for (const json& i : d.value("inserts", json::array())) {
            if (i.contains("key")) c.keys.push_back(i.at("key").get<std::string>());
        }
    };

    // Each track's placements, in the order they play.
    std::map<std::string, std::vector<Placed>> placements_of;
    for (std::size_t t = 0; t < tracks_doc.size(); ++t) {
        const json& d = tracks_doc[t];
        Chain c;
        c.kind = Chain::TrackChain;
        c.key = "track:" + d.at("id").dump();
        c.doc = &d;
        std::vector<Placed>& placed_list = placements_of[c.key];
        for (const json& placed : d.value("placements", json::array())) {
            placed_list.push_back(read_placement(placed, clips, where + "/" + c.key));
            if (!placed_list.back().clip->value("notes", json::array()).empty()) c.has_notes = true;
        }
        std::stable_sort(placed_list.begin(), placed_list.end(),
                         [](const Placed& a, const Placed& b) { return a.tick < b.tick; });
        add_outputs(c, d);
        chain_order.push_back(c.key);
        if (!chains.emplace(c.key, c).second) throw CompileError(where, "duplicate " + c.key);
    }
    for (const json& d : buses_doc) {
        Chain c;
        c.kind = Chain::BusChain;
        c.key = "bus:" + d.at("id").get<std::string>();
        c.doc = &d;
        add_outputs(c, d);
        chain_order.push_back(c.key);
        if (!chains.emplace(c.key, c).second) throw CompileError(where, "duplicate " + c.key);
    }
    {
        static const json no_master = json::object();
        Chain c;
        c.kind = Chain::MasterChain;
        c.key = "master";
        c.doc = doc.contains("master") ? &doc.at("master") : &no_master;
        for (const json& i : c.doc->value("inserts", json::array())) {
            if (i.contains("key")) c.keys.push_back(i.at("key").get<std::string>());
        }
        chain_order.push_back(c.key);
        chains.emplace(c.key, c);
    }

    // Step 3: a chain is live if it reaches master and is reached by something that plays.
    std::set<std::string> to_master{"master"}, from_source;
    for (const auto& key : chain_order) {
        const Chain& c = chains.at(key);
        for (const auto& o : c.outputs) {
            if (!chains.count(o.to)) throw CompileError(where + "/" + key, "routes to unknown '" + o.to + "'");
        }
        for (const auto& k : c.keys) {
            if (!chains.count(k)) throw CompileError(where + "/" + key, "sidechain from unknown '" + k + "'");
        }
    }
    for (bool changed = true; changed;) {
        changed = false;
        for (const auto& key : chain_order) {
            const Chain& c = chains.at(key);
            if (to_master.count(key)) {
                for (const auto& k : c.keys) changed |= to_master.insert(k).second;
                continue;
            }
            for (const auto& o : c.outputs) {
                if (to_master.count(o.to)) changed |= to_master.insert(key).second;
            }
        }
    }
    for (bool changed = true; changed;) {
        changed = false;
        for (const auto& key : chain_order) {
            const Chain& c = chains.at(key);
            const bool source = c.kind == Chain::TrackChain && (c.has_notes || keep_unused);
            if (source) changed |= from_source.insert(key).second;
            if (!from_source.count(key)) continue;
            for (const auto& o : c.outputs) changed |= from_source.insert(o.to).second;
        }
    }
    for (auto& [key, c] : chains) {
        c.live = (to_master.count(key) && from_source.count(key)) || key == "master";
    }

    // Processing order, by the same Kahn rule as graphs.
    std::map<std::string, std::set<std::string>> deps;
    for (const auto& key : chain_order) {
        const Chain& c = chains.at(key);
        if (!c.live) continue;
        deps[key];
        for (const auto& o : c.outputs) {
            if (chains.at(o.to).live) deps[o.to].insert(key);
        }
        for (const auto& k : c.keys) {
            if (chains.at(k).live) deps[key].insert(k);
        }
    }
    std::vector<std::string> order;
    {
        std::set<std::string> done;
        while (done.size() < deps.size()) {
            bool progressed = false;
            for (const auto& key : chain_order) {
                if (!deps.count(key) || done.count(key)) continue;
                const auto& need = deps.at(key);
                if (std::all_of(need.begin(), need.end(), [&](const std::string& d) { return done.count(d) != 0; })) {
                    order.push_back(key);
                    done.insert(key);
                    progressed = true;
                }
            }
            if (!progressed) throw CompileError(where, "the mixer routing has a cycle");
        }
    }

    // Patch table and tracks. Slots keep only what notes play, then renumber.
    std::vector<u64> patch_hashes;
    std::vector<std::string> patch_ids;
    const auto patch_index = [&](const std::string& id, const std::string& context) {
        const CompiledPatch& p = compiled_patch(image, id, program_index, context);
        const auto it = std::find(patch_hashes.begin(), patch_hashes.end(), p.chunk.hash);
        if (it != patch_hashes.end()) return static_cast<u16>(it - patch_hashes.begin());
        patch_hashes.push_back(p.chunk.hash);
        patch_ids.push_back(id);
        return static_cast<u16>(patch_hashes.size() - 1);
    };

    std::vector<Instruction> code;
    std::vector<ClipDesc> clip_table;
    std::map<std::vector<std::byte>, u16> clip_cache;
    std::vector<TrackDesc> track_table;
    std::vector<u16> slots;
    std::vector<InsertDesc> insert_table;
    std::vector<ParamInit> inits;
    std::map<u16, GlobalDesc> globals;
    std::vector<json> report_tracks, report_buses;
    u32 length_ticks = 0;

    const auto note_globals = [&](const CompiledPatch& p) {
        for (const ParamInfo& info : p.params) {
            if (info.scope != ParamScope::Global) continue;
            float value = info.def;
            const json g = doc.value("globals", json::object());
            const std::string key = std::to_string(info.id);
            if (g.contains(key)) value = g.at(key).get<float>();
            globals.try_emplace(info.id, GlobalDesc{info.id, 0, value});
        }
    };
    const auto add_inits = [&](const json& d, u16 kind, u16 target) {
        const json params = d.value("params", json::object());  // Named: GCC 14 ends a temporary before .items() runs
        for (const auto& [key, value] : params.items()) {
            inits.push_back({kind, target, static_cast<u16>(std::stoi(key)), 0, value.get<float>()});
        }
    };

    std::map<std::string, int> compiled_track_index;
    // A clip can name an insert or a mix register, and those exist only once the mixer has compiled. So tracks stop
    // here with what the mixer needs, and their clips and streams follow it, in this same order.
    struct TrackWork {
        std::string key, where;
        std::map<int, int> slot_map;
        std::vector<const CompiledPatch*> patches;
        std::size_t index;
    };
    std::vector<TrackWork> track_work;
    for (const std::string& key : order) {
        Chain& c = chains.at(key);
        if (c.kind != Chain::TrackChain) continue;
        const json& d = *c.doc;
        const std::string track_where = where + "/" + key;

        // Which slots do placed notes use?
        const json slot_ids = d.value("slots", json::array());
        std::set<int> used;
        if (keep_unused) {
            for (int s = 0; s < static_cast<int>(slot_ids.size()); ++s) used.insert(s);
        }
        for (const Placed& placed : placements_of.at(key)) {
            for (const json& note : placed.clip->value("notes", json::array())) {
                if (placed.plays(note.at("tick").get<u32>())) used.insert(note.value("slot", 0));
            }
        }
        std::map<int, int> slot_map;
        std::vector<const CompiledPatch*> track_patches;
        const u16 slot_begin = static_cast<u16>(slots.size());
        for (const int s : used) {
            if (s < 0 || s >= static_cast<int>(slot_ids.size())) {
                throw CompileError(track_where, "a note plays slot " + std::to_string(s) + ", which the track lacks");
            }
            const std::string id = slot_ids[static_cast<std::size_t>(s)].get<std::string>();
            const u16 index = patch_index(id, track_where);
            const CompiledPatch& p = image.compiled.at(id);
            if (p.inputs != 0) throw CompileError(track_where, "patch '" + id + "' has an in node, so it is an insert");
            note_globals(p);
            slot_map[s] = static_cast<int>(slots.size()) - slot_begin;
            slots.push_back(index);
            track_patches.push_back(&p);
        }
        if (used.empty()) continue;

        TrackDesc desc{};
        desc.id = static_cast<u16>(d.at("id").get<int>());
        desc.voices = static_cast<u16>(d.value("voices", 4));
        if (desc.voices == 0 || desc.voices > 256) throw CompileError(track_where, "voices must be 1 to 256");
        desc.slot_begin = slot_begin;
        desc.slot_count = static_cast<u16>(slots.size()) - slot_begin;
        compiled_track_index[key] = static_cast<int>(track_table.size());
        add_inits(d, 0, static_cast<u16>(track_table.size()));
        track_work.push_back({key, track_where, std::move(slot_map), std::move(track_patches), track_table.size()});
        track_table.push_back(desc);
    }

    // A live track may have lost every slot: its Program has nothing to run.
    for (const std::string& key : order) {
        Chain& c = chains.at(key);
        if (c.kind == Chain::TrackChain && !compiled_track_index.count(key)) c.live = false;
    }

    // Which mix controls a lane moves, anywhere in the song.
    struct Moves {
        bool fader = false, pan = false;
        std::set<std::string> sends;
    };
    std::map<std::string, Moves> moves;
    bool master_moves = false;
    for (const std::string& key : chain_order) {
        const Chain& c = chains.at(key);
        if (c.kind != Chain::TrackChain) continue;
        for (const Placed& placed : placements_of.at(key)) {
            for (const json& lane : placed.clip->value("automation", json::array())) {
                if (!lane.contains("target") || !lane.at("target").is_object()) continue;
                const json& t = lane.at("target");
                if (!t.contains("mix") || !t.at("mix").is_string()) continue;
                const std::string control = t.at("mix").get<std::string>();
                std::string owner;
                if (t.contains("master")) {
                    master_moves = master_moves || control == "fader";
                    continue;
                }
                if (t.contains("track")) {
                    owner = "track:" + t.at("track").dump();
                } else if (t.contains("bus") && t.at("bus").is_string()) {
                    owner = "bus:" + t.at("bus").get<std::string>();
                } else {
                    continue;
                }
                Moves& m = moves[owner];
                m.fader = m.fader || control == "fader";
                m.pan = m.pan || control == "pan";
                if (control == "send" && t.contains("to") && t.at("to").is_string()) {
                    m.sends.insert("bus:" + t.at("to").get<std::string>());
                }
            }
        }
    }

    // Where each factor is applied. A register pair holds the product of its factors, so it can follow a lane on only
    // one of them. Until two that move would share a pair, everything stays in the output registers, which is what
    // every Program compiled before stages existed has. Then the master fader takes a stage of its own, then a chain's
    // fader, then its pan, until no pair holds two that move. A send's gain is only ever in its own register. A
    // pre-fader send needs the chain before its fader and pan, so a chain with one applies those in a stage.
    struct Staged {
        bool fader = false, pan = false;
    };
    std::map<std::string, Staged> staged_alone;
    bool master_staged = false;
    const auto has_pre = [](const Chain& c) {
        return std::any_of(c.outputs.begin(), c.outputs.end(), [](const Chain::Output& o) { return o.pre; });
    };
    const auto staged_factors = [&](const Chain& c) {
        const Staged s = staged_alone.count(c.key) ? staged_alone.at(c.key) : Staged{};
        unsigned of = 0;
        if (has_pre(c) || s.fader) of |= kFaderFactor;
        if (has_pre(c) || s.pan) of |= kPanFactor;
        return of;
    };
    const auto stages_of = [&](const Chain& c) {
        const Staged s = staged_alone.count(c.key) ? staged_alone.at(c.key) : Staged{};
        std::vector<unsigned> list;
        if (s.fader) list.push_back(kFaderFactor);
        if (s.pan) list.push_back(kPanFactor);
        const unsigned rest =
            staged_factors(c) & ~((s.fader ? unsigned{kFaderFactor} : 0u) | (s.pan ? unsigned{kPanFactor} : 0u));
        if (rest) list.push_back(rest);
        return list;
    };
    const auto output_factors = [&](const Chain& c, const Chain::Output& o) -> unsigned {
        if (o.pre) return kMuteFactor | kSendFactor;
        unsigned of = (kFaderFactor | kPanFactor) & ~staged_factors(c);
        if (o.is_send) of |= kSendFactor;
        if (o.to == "master" && !master_staged) of |= kMasterFactor;
        return of;
    };
    const auto moving = [&](const Chain& c, unsigned of, const std::string& send_to) {
        const Moves m = moves.count(c.key) ? moves.at(c.key) : Moves{};
        unsigned out = 0;
        if ((of & kFaderFactor) && m.fader) out |= kFaderFactor;
        if ((of & kPanFactor) && m.pan) out |= kPanFactor;
        if ((of & kSendFactor) && m.sends.count(send_to)) out |= kSendFactor;
        if ((of & kMasterFactor) && master_moves) out |= kMasterFactor;
        return out;
    };
    for (bool settled = false; !settled;) {
        settled = true;
        for (const std::string& key : chain_order) {
            const Chain& c = chains.at(key);
            if (c.kind == Chain::MasterChain) continue;
            std::vector<unsigned> pairs;
            for (const auto& o : c.outputs) pairs.push_back(moving(c, output_factors(c, o), o.to));
            for (const unsigned s : stages_of(c)) pairs.push_back(moving(c, s, ""));
            for (const unsigned both : pairs) {
                if (std::popcount(both) < 2) continue;
                // Each of these was not yet staged, since a staged factor is in no output and alone in its stage.
                if (both & kMasterFactor) {
                    master_staged = true;
                } else if (both & kFaderFactor) {
                    staged_alone[key].fader = true;
                } else {
                    staged_alone[key].pan = true;
                }
                settled = false;
                break;
            }
            if (!settled) break;
        }
    }
    for (const std::string& key : chain_order) {
        Chain& c = chains.at(key);
        if (c.kind == Chain::MasterChain) {
            if (master_staged) c.stages.push_back({kMasterFactor});
            continue;
        }
        for (auto& o : c.outputs) o.of = output_factors(c, o);
        for (const unsigned of : stages_of(c)) c.stages.push_back({of});
    }

    // Mixer, with registers allocated by last use. Each bus register counts the steps still to read it.
    std::map<int, int> readers;
    std::vector<MixStep> mix;
    std::vector<GatherInput> gather_inputs;
    std::vector<float> mix_init;
    std::set<int> free_regs;
    int next_reg = 0;
    const auto new_reg = [&] {
        if (free_regs.empty()) return next_reg++;
        const int r = *free_regs.begin();
        free_regs.erase(free_regs.begin());
        return r;
    };
    const auto read_done = [&](int reg) {
        if (--readers[reg] == 0) free_regs.insert(reg);
    };
    const auto expect_readers = [&](int reg, int count) {
        readers[reg] = count;
        if (count == 0) free_regs.insert(reg);
    };
    const float master_gain = chains.at("master").doc->value("gain", 1.0f);
    const auto values_of = [&](const Chain& c, float send) {
        return MixValues{c.fader, c.mute, c.pan, send, master_gain};
    };

    const auto add_pair = [&](unsigned of, const MixValues& v) {
        const u16 left = static_cast<u16>(mix_init.size());
        mix_init.push_back(gain_of(of, v, false));
        mix_init.push_back(gain_of(of, v, true));
        return left;
    };

    struct CompiledInsert {
        u16 index;
        const CompiledPatch* patch;
        json params;  // A copy: the list it came from is a temporary
    };
    std::map<int, CompiledInsert> compiled_inserts;  // by id
    u16 task = 0;
    for (const std::string& key : order) {
        Chain& c = chains.at(key);
        if (!c.live) continue;
        const std::string chain_where = where + "/" + key;

        // A stage is a Gather of one input, the chain's own bus, scaled by its pair.
        const auto run_stage = [&](Chain::Stage& stage) {
            stage.reg = add_pair(stage.of, values_of(c, 1.0f));
            const u16 first = static_cast<u16>(gather_inputs.size());
            gather_inputs.push_back(
                {static_cast<u16>(c.reg), static_cast<u16>(stage.reg), static_cast<u16>(stage.reg + 1), 0});
            const int from = c.reg;
            c.reg = new_reg();
            mix.push_back({static_cast<u8>(MixOp::Gather), 0, task, first, static_cast<u16>(c.reg), 1, kNone});
            read_done(from);
        };

        std::vector<int> inputs_read;
        if (c.kind == Chain::TrackChain) {
            c.reg = new_reg();
            mix.push_back({static_cast<u8>(MixOp::RunVoices), 0, task, static_cast<u16>(compiled_track_index.at(key)),
                           static_cast<u16>(c.reg), 0, kNone});
        } else {
            const u16 first = static_cast<u16>(gather_inputs.size());
            for (const std::string& source_key : order) {
                Chain& source = chains.at(source_key);
                if (!source.live) continue;
                for (auto& o : source.outputs) {
                    if (o.to != key) continue;
                    o.reg = add_pair(o.of, values_of(source, o.send));
                    json route = {{"to", key}, {"left", o.reg}, {"right", o.reg + 1}, {"of", factor_names(o.of)}};
                    if (o.pre) route["pre"] = true;
                    source.mix.push_back(std::move(route));
                    const int from = o.pre ? source.pre_reg : source.reg;
                    gather_inputs.push_back(
                        {static_cast<u16>(from), static_cast<u16>(o.reg), static_cast<u16>(o.reg + 1), 0});
                    inputs_read.push_back(from);
                }
            }
            c.reg = new_reg();
            mix.push_back({static_cast<u8>(MixOp::Gather), 0, task, first, static_cast<u16>(c.reg),
                           static_cast<u16>(gather_inputs.size() - first), kNone});
        }
        for (const int source : inputs_read) read_done(source);
        if (c.kind == Chain::MasterChain) {
            for (Chain::Stage& stage : c.stages) {
                expect_readers(c.reg, 1);
                run_stage(stage);
            }
        }

        for (const json& i : c.doc->value("inserts", json::array())) {
            const std::string id = i.at("patch").get<std::string>();
            const u16 patch = patch_index(id, chain_where);
            const CompiledPatch& p = image.compiled.at(id);
            note_globals(p);
            if (p.inputs == 0) throw CompileError(chain_where, "insert patch '" + id + "' has no in node");
            InsertDesc desc{};
            desc.id = static_cast<u16>(i.value("id", static_cast<int>(insert_table.size()) + 1));
            desc.patch = patch;
            add_inits(i, 1, static_cast<u16>(insert_table.size()));
            u16 key_reg = kNone;
            int key_from = -1;
            if (i.contains("key") && chains.at(i.at("key").get<std::string>()).live) {
                if (p.inputs < 2) throw CompileError(chain_where, "insert patch '" + id + "' has no sidechain input");
                key_from = chains.at(i.at("key").get<std::string>()).pre_reg;
                key_reg = static_cast<u16>(key_from);
            }
            mix.push_back({static_cast<u8>(MixOp::RunInsert), 0, task, static_cast<u16>(insert_table.size()),
                           static_cast<u16>(c.reg), static_cast<u16>(c.reg), key_reg});
            compiled_inserts[desc.id] = {static_cast<u16>(insert_table.size()), &p, i.value("params", json::object())};
            insert_table.push_back(desc);
            if (key_from >= 0) read_done(key_from);
        }
        c.step = static_cast<int>(mix.size()) - 1;
        c.pre_reg = c.reg;
        if (c.kind != Chain::MasterChain) {
            // Who reads this chain: a sidechain and a pre-fader send read it before its stages, everything else after.
            int before = 0, after = 0;
            for (const auto& o : c.outputs) {
                if (chains.at(o.to).live) ++(o.pre ? before : after);
            }
            for (const std::string& other : order) {
                if (!chains.at(other).live) continue;
                for (const std::string& k : chains.at(other).keys) before += k == key;
            }
            if (c.stages.empty()) {
                expect_readers(c.reg, before + after);
            } else {
                expect_readers(c.reg, before + 1);
                for (std::size_t s = 0; s < c.stages.size(); ++s) {
                    run_stage(c.stages[s]);
                    expect_readers(c.reg, s + 1 == c.stages.size() ? after : 1);
                }
            }
        }
        ++task;
    }
    if (next_reg > static_cast<int>(kMaxRegisters)) throw CompileError(where, "the mixer needs too many buses");

    // A global belongs to the Program, so a lane on one reaches past its track as much as a lane with a target does.
    const auto names_global = [&](const json& track, int param) {
        for (const json& slot : track.value("slots", json::array())) {
            const std::string id = slot.get<std::string>();
            if (!image.patches->contains(id)) continue;
            for (const json& p : image.patches->at(id).at("graph").value("params", json::array())) {
                if (p.value("id", -1) == param && p.value("scope", "track") == "global") return true;
            }
        }
        return false;
    };

    // A track that doesn't compile doesn't run, and a lane that reaches past its own track would be lost without a
    // sound.
    for (const std::string& key : chain_order) {
        const Chain& c = chains.at(key);
        if (c.kind != Chain::TrackChain || compiled_track_index.count(key)) continue;
        for (const json& placed : c.doc->value("placements", json::array())) {
            for (const json& lane :
                 clips.at(placed.at("clip").get<std::string>())->value("automation", json::array())) {
                if (lane.contains("target") || names_global(*c.doc, lane.value("param", -1))) {
                    throw CompileError(where + "/" + key,
                                       "this track never plays, so its lanes would not run. Put the "
                                       "lane in a clip on a track that does");
                }
            }
        }
    }

    // Lanes that reach past their own track. A locate replays one track's stream and then the next, while playback
    // interleaves them by tick, so if two tracks set one target, which won would depend on where playback started.
    std::map<std::string, std::string> lane_owner;
    const auto claim = [&](const std::string& target, const std::string& track, const std::string& at) {
        const auto [it, added] = lane_owner.try_emplace(target, track);
        if (!added && it->second != track) {
            throw CompileError(at,
                               it->second + " and " + track + " both automate " + target + ". One track must own it");
        }
    };
    const auto global_name = [](u16 id) { return "global param " + std::to_string(id); };
    // A mix register holds the product of its factors, so a lane on one writes that product with the others' fixed
    // values in it, and only one of them may move.
    std::map<int, std::string> register_control;
    struct MixWrite {
        u16 reg;
        float value;
    };
    std::set<int> declared_inserts;
    for (const std::string& key : chain_order) {
        for (const json& i : chains.at(key).doc->value("inserts", json::array())) {
            if (i.contains("id")) declared_inserts.insert(i.at("id").get<int>());
        }
    }
    const auto mix_writes = [&](const json& target, float value, const std::string& at) {
        for (const auto& [name, field] : target.items()) {
            if (name != "mix" && name != "track" && name != "bus" && name != "master" && name != "to") {
                throw CompileError(at, "a mix lane has no '" + name + "'");
            }
        }
        const std::string control = target.at("mix").get<std::string>();
        if (control != "fader" && control != "pan" && control != "send") {
            throw CompileError(at, "unknown mix control '" + control + "'");
        }
        const int named = static_cast<int>(target.contains("track")) + static_cast<int>(target.contains("bus")) +
                          static_cast<int>(target.contains("master"));
        if (named != 1) throw CompileError(at, "a mix lane names one of track, bus or master");
        const bool on_master = target.contains("master");
        if (on_master && !target.at("master").get<bool>()) throw CompileError(at, "master can only be true");
        const std::string key = on_master                  ? "master"
                                : target.contains("track") ? "track:" + target.at("track").dump()
                                                           : "bus:" + target.at("bus").get<std::string>();
        if (!chains.count(key)) throw CompileError(at, "a lane reaches unknown '" + key + "'");
        if (on_master && control != "fader") throw CompileError(at, "master has only a fader");
        if (control == "pan" ? !(value >= -1.0f && value <= 1.0f) : !(value >= 0.0f && value <= 4.0f)) {
            throw CompileError(at, control + " is out of range");
        }
        std::string to;
        if (control == "send") to = "bus:" + target.at("to").get<std::string>();
        if (control != "send" && target.contains("to")) throw CompileError(at, "only a send lane has to");
        if (!to.empty() && !chains.count(to)) throw CompileError(at, "a lane reaches unknown '" + to + "'");

        std::vector<MixWrite> writes;
        const std::string name = control + " of " + key;
        const unsigned factor = on_master            ? kMasterFactor
                                : control == "fader" ? kFaderFactor
                                : control == "pan"   ? kPanFactor
                                                     : kSendFactor;
        const auto write = [&](const Chain& c, int reg, unsigned of, float send) {
            if (reg < 0 || !(of & factor)) return;  // Nothing plays through it, or it doesn't hold this control
            MixValues v = values_of(c, send);
            (factor == kFaderFactor  ? v.fader
             : factor == kPanFactor  ? v.pan
             : factor == kSendFactor ? v.send
                                     : v.master) = value;
            writes.push_back({static_cast<u16>(reg), gain_of(of, v, false)});
            writes.push_back({static_cast<u16>(reg + 1), gain_of(of, v, true)});
        };
        if (on_master) {
            for (const std::string& source : chain_order) {
                for (const auto& o : chains.at(source).outputs) {
                    if (o.to == "master") write(chains.at(source), o.reg, o.of, o.send);
                }
            }
        } else {
            const Chain& c = chains.at(key);
            if (control == "send" && std::none_of(c.outputs.begin(), c.outputs.end(),
                                                  [&](const Chain::Output& o) { return o.is_send && o.to == to; })) {
                throw CompileError(at, key + " has no send to " + to);
            }
            for (const auto& o : c.outputs) {
                if (control == "send" && (!o.is_send || o.to != to)) continue;
                write(c, o.reg, o.of, o.send);
            }
        }
        for (const auto& s : chains.at(key).stages) write(chains.at(key), s.reg, s.of, 1.0f);
        // Stages keep two controls that move out of one pair, so this would be the compiler's own mistake.
        for (const MixWrite& w : writes) {
            const auto [it, added] = register_control.try_emplace(w.reg, name);
            if (!added && it->second != name) {
                throw CompileError(at, name + " and " + it->second + " share a mix register");
            }
        }
        return writes;
    };

    // How many notes a track holds at once while it plays poly, which is how many voices it needs before the oldest is
    // cut short to make room, and the first tick it has too few. A release rings on after its note, so it can need
    // more.
    std::map<std::string, std::pair<u32, u64>> notes_at_once;
    constexpr u64 kNever = ~u64{0};
    const auto peak_notes = [&](const TrackWork& work, const json& d) -> std::pair<u32, u64> {
        struct Edge {
            u64 tick;
            int kind;  // ends before mode changes, and those before starts, as the engine takes them
            u32 note;
            bool poly;
        };
        std::vector<Edge> edges;
        u32 notes = 0;
        for (const Placed& placed : placements_of.at(work.key)) {
            const json clip_notes = placed.clip->value("notes", json::array());
            const json plays = placed.clip->value("play", json::array());
            for (u32 k = 0; k < placed.repeat; ++k) {
                const u64 base = placed.tick + static_cast<u64>(k) * placed.length;
                const json* chased = nullptr;
                for (const json& p : plays) {
                    const u32 t = p.at("tick").get<u32>();
                    const bool poly = p.value("mode", std::string{"poly"}) == "poly";
                    if (t < placed.start) {
                        if (!chased || chased->at("tick").get<u32>() <= t) chased = &p;
                    } else if (placed.plays(t)) {
                        edges.push_back({base + t - placed.start, 1, 0, poly});
                    }
                }
                if (chased) edges.push_back({base, 1, 0, chased->value("mode", std::string{"poly"}) == "poly"});
                for (const json& n : clip_notes) {
                    const u32 t = n.at("tick").get<u32>();
                    if (!placed.plays(t)) continue;
                    edges.push_back({base + t - placed.start, 2, notes, false});
                    edges.push_back({base + t - placed.start + n.at("dur").get<u32>(), 0, notes, false});
                    ++notes;
                }
                if (edges.size() > (1u << 21)) return {0, kNever};  // Too many to be worth counting
            }
        }
        std::stable_sort(edges.begin(), edges.end(), [](const Edge& a, const Edge& b) {
            return std::tie(a.tick, a.kind) < std::tie(b.tick, b.kind);
        });
        const u32 voices = d.value("voices", 4u);
        bool poly = !d.contains("play") || d.at("play").value("mode", std::string{"poly"}) == "poly";
        std::vector<bool> counted(notes, false);
        u32 held = 0, peak = 0;
        u64 first = kNever;
        for (const Edge& e : edges) {
            if (e.kind == 1) {
                poly = e.poly;
            } else if (e.kind == 2) {
                if (!poly) continue;
                counted[e.note] = true;
                peak = std::max(peak, ++held);
                if (held > voices && first == kNever) first = e.tick;
            } else if (counted[e.note]) {
                --held;
            }
        }
        return {peak, first};
    };

    // The clips and streams the track pass left. Their order is what it always was, so nothing that compiled before
    // moves.
    for (const TrackWork& work : track_work) {
        const std::string& track_where = work.where;
        const std::map<int, int>& slot_map = work.slot_map;
        const json& d = *chains.at(work.key).doc;
        std::set<u16> moved_registers;
        std::map<std::pair<u16, u16>, float> moved_inserts;  // insert and parameter, and the value each starts from
        // Whether a lane with no target sets its parameter outright at tick 0. Then the stream puts it back unaided, so
        // a Program that opens that way pays for nothing.
        std::map<u16, bool> moved_params;

        const auto has_param = [&](u16 id) {
            for (const CompiledPatch* p : work.patches) {
                for (const ParamInfo& info : p->params) {
                    if (info.id == id) return true;
                }
            }
            return false;
        };
        const auto is_global = [&](u16 id) {
            for (const CompiledPatch* p : work.patches) {
                for (const ParamInfo& info : p->params) {
                    if (info.id == id && info.scope == ParamScope::Global) return true;
                }
            }
            return false;
        };

        // Where a lane with no target starts from. A SetParam reaches every slot with that id, and each clamps it to
        // its own range, as it does an initial value, so one value has to do for them all.
        const auto param_start = [&](u16 id) {
            const json params = d.value("params", json::object());
            const std::string key = std::to_string(id);
            const auto start_on = [&](const ParamInfo& info) {
                if (info.scope == ParamScope::Global) return globals.at(id).value;
                return params.contains(key) ? params.at(key).get<float>() : info.def;
            };
            std::vector<const ParamInfo*> declared;
            for (const CompiledPatch* p : work.patches) {
                for (const ParamInfo& info : p->params) {
                    if (info.id == id) declared.push_back(&info);
                }
            }
            for (const ParamInfo* candidate : declared) {
                const float value = start_on(*candidate);
                const auto puts_back = [&](const ParamInfo* info) {
                    return std::clamp(value, info->min, info->max) == std::clamp(start_on(*info), info->min, info->max);
                };
                if (std::all_of(declared.begin(), declared.end(), puts_back)) return value;
            }
            throw CompileError(work.where, "param " + key +
                                               " starts from different values on this track's slots, so a lane can't "
                                               "put it back. Give the track a value for it, or set it at tick 0");
        };

        const auto play_instruction = [&](const json& play, const std::string& at) -> Instruction {
            for (const auto& [name, field] : play.items()) {
                if (name != "mode" && name != "priority" && name != "glide" && name != "tick" &&
                    name != "slur_velocity") {
                    throw CompileError(at, "play has no '" + name + "'");
                }
            }
            const std::string mode = play.value("mode", "poly"), priority = play.value("priority", "last");
            const float glide = play.value("glide", 0.0f);
            const PlayKind kind = mode == "poly"     ? PlayKind::Poly
                                  : mode == "mono"   ? PlayKind::Mono
                                  : mode == "legato" ? PlayKind::Legato
                                                     : throw CompileError(at, "unknown play mode '" + mode + "'");
            const NotePriority order = priority == "last"   ? NotePriority::Last
                                       : priority == "high" ? NotePriority::High
                                       : priority == "low"
                                           ? NotePriority::Low
                                           : throw CompileError(at, "unknown priority '" + priority + "'");
            if (kind == PlayKind::Poly && order != NotePriority::Last) {
                throw CompileError(at, "priority chooses among held notes, and poly plays them all");
            }
            if (!(glide >= 0.0f && glide <= kMaxGlideSeconds)) throw CompileError(at, "glide must be 0 to 60 seconds");
            // A slurred note brings its velocity, which only a legato line has notes slurring into.
            const bool slur_velocity = play.value("slur_velocity", false);
            if (slur_velocity && kind != PlayKind::Legato)
                throw CompileError(at, "only legato slurs, so only it has slur_velocity");
            const PlayKind played = slur_velocity ? PlayKind::LegatoVelocity : kind;
            return {static_cast<u8>(Instr::PlayMode), static_cast<u8>(played), static_cast<u16>(order),
                    std::bit_cast<u32>(glide)};
        };

        // Where a lane's target starts from, before any lane in the song has moved it.
        const auto lane_start = [&](const json& point) -> double {
            // A parameter whose slots start apart has no one start, which is only an error if something needs it.
            if (!point.contains("target")) {
                try {
                    return param_start(static_cast<u16>(point.at("param").get<int>()));
                } catch (const CompileError&) {
                    return std::numeric_limits<double>::quiet_NaN();
                }
            }
            const json& target = point.at("target");
            if (!target.is_object()) return 0.0;  // The lane itself says what is wrong with it
            if (target.contains("insert")) {
                if (!target.at("insert").is_number_integer() || !point.contains("param")) return 0.0;
                const auto found = compiled_inserts.find(target.at("insert").get<int>());
                if (found == compiled_inserts.end()) return 0.0;  // Nothing plays through it, so nothing reads this
                const int param = point.at("param").get<int>();
                const auto info = std::find_if(found->second.patch->params.begin(), found->second.patch->params.end(),
                                               [&](const ParamInfo& p) { return p.id == param; });
                if (info == found->second.patch->params.end()) return 0.0;
                if (info->scope == ParamScope::Global) return globals.at(static_cast<u16>(param)).value;
                const std::string key = std::to_string(param);
                return found->second.params.contains(key) ? found->second.params.at(key).get<float>() : info->def;
            }
            if (!target.contains("mix") || !target.at("mix").is_string()) return 0.0;
            const std::string control = target.at("mix").get<std::string>();
            if (target.contains("master")) return master_gain;
            const std::string owner = target.contains("track") ? "track:" + target.at("track").dump()
                                      : target.contains("bus") && target.at("bus").is_string()
                                          ? "bus:" + target.at("bus").get<std::string>()
                                          : std::string{};
            if (!chains.count(owner)) return 0.0;
            const Chain& c = chains.at(owner);
            if (control == "pan") return c.pan;
            if (control != "send") return c.fader;
            for (const auto& o : c.outputs) {
                if (o.is_send && target.contains("to") && target.at("to").is_string() &&
                    o.to == "bus:" + target.at("to").get<std::string>()) {
                    return o.send;
                }
            }
            return 0.0;
        };

        // Where a target stands, which a curve or a window starting part way through a clip needs to know.
        const auto needed = [&](double value, const json& point) {
            if (std::isnan(value)) (void)param_start(static_cast<u16>(point.at("param").get<int>()));  // throws
            return value;
        };

        // A clip's slots depend on the track, so a clip compiles per track and identical results merge. So does each
        // window a placement plays of it, at each repeat whose start differs: `lanes` is where each target stands at
        // the window's start, and it is left where they stand at its end.
        const auto compile_clip = [&](const Placed& placed, u32 window_at, LaneStates& lanes) {
            enum class ItemKind { Lane, Note, Play };
            // What a lane does at a tick: set its target, or ramp it in a straight line.
            struct LaneEvent {
                const json* point;
                float value;
                u32 ramp;
            };
            struct Item {
                u32 tick;
                int order;
                int key;
                const json* doc;
                ItemKind kind;
                LaneEvent lane = {};
                int note = 0, velocity = 0;
            };
            std::vector<Item> items;
            const json& clip = *placed.clip;
            const u32 length = clip.at("length").get<u32>();
            const std::string clip_where = track_where + "/clip:" + clip.at("id").get<std::string>();
            if (length == 0) throw CompileError(clip_where, "clip has no length");
            const u32 window = placed.length;
            const json notes = clip.value("notes", json::array());
            const json automation = clip.value("automation", json::array());
            const json plays = clip.value("play", json::array());
            for (const json& n : notes) {
                const u32 tick = n.at("tick").get<u32>();
                if (tick >= length) throw CompileError(clip_where, "a note starts after the clip ends");
                if (n.at("dur").get<u32>() == 0) throw CompileError(clip_where, "a note has no duration");
                if (!placed.plays(tick)) continue;
                const int note = n.at("note").get<int>() + placed.transpose;
                const int velocity = n.value("vel", 100);
                if (note < 0 || note > 127) {
                    throw CompileError(clip_where, placed.transpose ? "a placement transposes a note out of 0 to 127"
                                                                    : "note or velocity out of range");
                }
                if (velocity < 0 || velocity > 127) throw CompileError(clip_where, "note or velocity out of range");
                const int scaled =
                    placed.velocity == 1.0
                        ? velocity
                        : static_cast<int>(std::min(127.0, std::floor(velocity * placed.velocity + 0.5)));
                Item item{tick - placed.start, 1, note, &n, ItemKind::Note};
                item.note = note;
                item.velocity = scaled;
                items.push_back(item);
            }

            // Lanes, a target at a time, in the order they move it. A point before the window only moves where its
            // target stands when the window starts, which the window then sets, so it sounds as it would have.
            std::vector<std::string> keys;
            std::map<std::string, std::vector<std::size_t>> lane_points;
            for (std::size_t i = 0; i < automation.size(); ++i) {
                const json& a = automation[i];
                const u32 tick = a.at("tick").get<u32>();
                if (tick >= length) throw CompileError(clip_where, "automation starts after the clip ends");
                const std::string curve = a.value("curve", std::string{"linear"});
                if (curve != "linear" && curve != "exp") {
                    throw CompileError(clip_where, "a lane's curve is linear or exp, not '" + curve + "'");
                }
                if (!a.contains("target")) {
                    const int param = a.at("param").get<int>();
                    if (!has_param(static_cast<u16>(param))) {
                        throw CompileError(clip_where, "automates param " + std::to_string(param) +
                                                           ", which no patch on this track has");
                    }
                }
                const std::string key =
                    (a.contains("target") ? a.at("target").dump() : "") + "#" + std::to_string(a.value("param", -1));
                if (!lane_points.count(key)) keys.push_back(key);
                lane_points[key].push_back(i);
            }
            // Ordered as the clip lists its points, so a lane that only sets and ramps compiles as it always has.
            std::vector<std::tuple<long, std::size_t, Item>> lane_items;
            const auto add_lane = [&](long rank, u32 tick, const json& point, double value, u32 ramp) {
                Item item{tick, 0, point.contains("target") ? point.value("param", 0) : point.at("param").get<int>(),
                          &point, ItemKind::Lane};
                item.lane = {&point, static_cast<float>(value), ramp};
                lane_items.emplace_back(rank, lane_items.size(), item);
            };
            for (const std::string& key : keys) {
                std::vector<std::size_t> order_of = lane_points.at(key);
                std::stable_sort(order_of.begin(), order_of.end(), [&](std::size_t a, std::size_t b) {
                    return automation[a].at("tick").get<u32>() < automation[b].at("tick").get<u32>();
                });
                LaneState state;
                if (lanes.count(key)) {
                    state = lanes.at(key);
                } else {
                    const double start = lane_start(automation[order_of.front()]);
                    state = {start, start, 0.0, 0.0, false};
                }
                struct Move {
                    long rank;
                    const json* point;
                    double tick, from, to;
                    u32 ramp;
                    bool curved;
                };
                std::vector<Move> in_window;
                const json* chased = nullptr;
                for (const std::size_t i : order_of) {
                    const json& a = automation[i];
                    const double tick = static_cast<double>(a.at("tick").get<u32>()) - placed.start;
                    if (tick >= window) break;
                    const double from = state.at(tick), to = a.at("value").get<double>();
                    const u32 ramp = a.value("ramp", 0u);
                    const bool curved = a.value("curve", std::string{}) == "exp" && ramp > 0;
                    if (curved && (needed(from, a) < 0.0 || to < 0.0)) {
                        throw CompileError(clip_where, "an exp curve moves by ratios, so it needs values of 0 or more");
                    }
                    state =
                        ramp ? LaneState{from, to, tick, tick + ramp, curved} : LaneState{to, to, tick, tick, false};
                    if (tick < 0.0) {
                        chased = &a;
                        continue;
                    }
                    in_window.push_back({static_cast<long>(i), &a, tick, from, to, ramp, curved});
                }
                if (chased) {
                    // Where the target stood when the window started, and where it was going.
                    const LaneState at_start = [&] {
                        LaneState s = lanes.count(key) ? lanes.at(key) : LaneState{};
                        if (!lanes.count(key)) {
                            const double start = lane_start(*chased);
                            s = {start, start, 0.0, 0.0, false};
                        }
                        for (const std::size_t i : order_of) {
                            const json& a = automation[i];
                            const double tick = static_cast<double>(a.at("tick").get<u32>()) - placed.start;
                            if (tick >= 0.0) break;
                            const double from = s.at(tick), to = a.at("value").get<double>();
                            const u32 ramp = a.value("ramp", 0u);
                            const bool curved = a.value("curve", std::string{}) == "exp" && ramp > 0;
                            s = ramp ? LaneState{from, to, tick, tick + ramp, curved}
                                     : LaneState{to, to, tick, tick, false};
                        }
                        return s;
                    }();
                    const double now = needed(at_start.at(0.0), *chased);
                    std::vector<Move> head{{-1, chased, 0.0, now, now, 0, false}};
                    if (at_start.end > 0.0) {
                        head.push_back({-1, chased, 0.0, at_start.at(0.0), at_start.to, static_cast<u32>(at_start.end),
                                        at_start.curved});
                    }
                    in_window.insert(in_window.begin(), head.begin(), head.end());
                }
                for (std::size_t m = 0; m < in_window.size(); ++m) {
                    const Move& move = in_window[m];
                    const u32 tick = static_cast<u32>(move.tick);
                    if (!move.curved) {
                        add_lane(move.rank, tick, *move.point, move.to, move.ramp);
                        continue;
                    }
                    // A curve is straight segments, each heading where the curve is at its end. It stops at the next
                    // point, and one that runs past the window finishes in a straight line from the last segment it
                    // could start, since nothing after the window's end can be in it.
                    const double next = m + 1 < in_window.size() ? in_window[m + 1].tick : 1e18;
                    const double end = move.tick + move.ramp;
                    const u32 steps = std::min(curve_steps(move.from, move.to), move.ramp);
                    for (u32 k = 0; k < steps; ++k) {
                        const u32 at = tick + static_cast<u32>(static_cast<u64>(move.ramp) * k / steps);
                        const u32 to = tick + static_cast<u32>(static_cast<u64>(move.ramp) * (k + 1) / steps);
                        if (at >= next || at >= window) break;
                        if (to >= window && next >= window && to < end) {
                            add_lane(move.rank, at, *move.point, move.to, static_cast<u32>(end) - at);
                            if (m + 1 == in_window.size()) {
                                state = {curve_at(move.from, move.to, (at - move.tick) / move.ramp), move.to,
                                         static_cast<double>(at), end, false};
                            }
                            break;
                        }
                        add_lane(move.rank, at, *move.point, curve_at(move.from, move.to, (to - move.tick) / move.ramp),
                                 to - at);
                    }
                }
                lanes[key] = state;
            }
            std::stable_sort(lane_items.begin(), lane_items.end(), [](const auto& a, const auto& b) {
                return std::tie(std::get<0>(a), std::get<1>(a)) < std::tie(std::get<0>(b), std::get<1>(b));
            });
            for (const auto& entry : lane_items) items.push_back(std::get<2>(entry));

            const json* chased_play = nullptr;
            for (const json& p : plays) {
                const u32 tick = p.at("tick").get<u32>();
                if (tick >= length) throw CompileError(clip_where, "a play change comes after the clip ends");
                if (tick < placed.start) {
                    if (!chased_play || chased_play->at("tick").get<u32>() <= tick) chased_play = &p;
                    continue;
                }
                if (!placed.plays(tick)) continue;
                items.push_back({tick - placed.start, -1, 0, &p, ItemKind::Play});
            }
            if (chased_play) items.insert(items.begin(), Item{0, -1, 0, chased_play, ItemKind::Play});
            std::stable_sort(items.begin(), items.end(), [](const Item& a, const Item& b) {
                return std::tie(a.tick, a.order, a.key) < std::tie(b.tick, b.order, b.key);
            });
            std::vector<Instruction> body;
            const auto wait_to = [&](u32 from, u32 to) {
                if (to > from) body.push_back({static_cast<u8>(Instr::Wait), 0, 0, to - from});
            };
            // What a lane with a target does. Each one also notes what it moved, so the stream can put it back.
            const auto target_lane = [&](const json& a, float value, u32 ramp) {
                const json& target = a.at("target");
                if (!target.is_object()) throw CompileError(clip_where, "a lane's target is an object");
                if (target.contains("mix")) {
                    if (a.contains("param")) throw CompileError(clip_where, "a mix lane has no param");
                    for (const MixWrite& w : mix_writes(target, value, clip_where)) {
                        claim(register_control.at(w.reg), work.key, clip_where);
                        moved_registers.insert(w.reg);
                        const u32 bits = std::bit_cast<u32>(w.value);
                        if (ramp) {
                            body.push_back({static_cast<u8>(Instr::RampMix), 0, w.reg, bits});
                            body.push_back({static_cast<u8>(Instr::RampArg), 0, 0, ramp});
                        } else {
                            body.push_back({static_cast<u8>(Instr::SetMix), 0, w.reg, bits});
                        }
                    }
                    return;
                }
                if (!target.contains("insert"))
                    throw CompileError(clip_where, "a lane's target is an insert or a mix control");
                for (const auto& [name, field] : target.items()) {
                    if (name != "insert") throw CompileError(clip_where, "an insert lane has no '" + name + "'");
                }
                const int id = target.at("insert").get<int>();
                const auto found = compiled_inserts.find(id);
                if (found == compiled_inserts.end()) {
                    if (declared_inserts.count(id)) return;  // Nothing plays through it
                    throw CompileError(clip_where, "a lane reaches unknown insert " + std::to_string(id));
                }
                const CompiledInsert& insert = found->second;
                const int param = a.at("param").get<int>();
                const auto info = std::find_if(insert.patch->params.begin(), insert.patch->params.end(),
                                               [&](const ParamInfo& p) { return p.id == param; });
                if (info == insert.patch->params.end()) {
                    throw CompileError(clip_where, "automates param " + std::to_string(param) + ", which insert " +
                                                       std::to_string(id) + " does not have");
                }
                if (info->scope == ParamScope::Voice) {
                    throw CompileError(clip_where, "param " + std::to_string(param) + " of insert " +
                                                       std::to_string(id) +
                                                       " has voice scope, which an insert reads once, at load, so a "
                                                       "lane can't move it");
                }
                const bool global = info->scope == ParamScope::Global;
                claim(global ? global_name(static_cast<u16>(param))
                             : "param " + std::to_string(param) + " of insert " + std::to_string(id),
                      work.key, clip_where);
                const std::string key = std::to_string(param);
                const float start = global                        ? globals.at(static_cast<u16>(param)).value
                                    : insert.params.contains(key) ? insert.params.at(key).get<float>()
                                                                  : info->def;
                moved_inserts.try_emplace({insert.index, static_cast<u16>(param)}, start);
                const u32 bits = std::bit_cast<u32>(value);
                const u8 index = static_cast<u8>(insert.index);
                if (ramp) {
                    body.push_back({static_cast<u8>(Instr::RampInsert), index, static_cast<u16>(param), bits});
                    body.push_back({static_cast<u8>(Instr::RampArg), 0, 0, ramp});
                } else {
                    body.push_back({static_cast<u8>(Instr::SetInsert), index, static_cast<u16>(param), bits});
                }
            };
            u32 now = 0;
            int current_slot = -1;
            for (const Item& item : items) {
                wait_to(now, item.tick);
                now = item.tick;
                if (item.kind == ItemKind::Note) {
                    const json& n = *item.doc;
                    const int slot = slot_map.at(n.value("slot", 0));
                    if (slot != current_slot && slot_map.size() > 1) {
                        body.push_back({static_cast<u8>(Instr::SetPatch), static_cast<u8>(slot), 0, 0});
                    }
                    current_slot = slot;
                    body.push_back({static_cast<u8>(Instr::NoteOn), static_cast<u8>(item.note),
                                    static_cast<u16>(item.velocity), n.at("dur").get<u32>()});
                } else if (item.kind == ItemKind::Play) {
                    body.push_back(play_instruction(*item.doc, clip_where));
                } else if (item.doc->contains("target")) {
                    target_lane(*item.doc, item.lane.value, item.lane.ramp);
                } else {
                    const u32 value = std::bit_cast<u32>(item.lane.value);
                    const u16 param = static_cast<u16>(item.doc->at("param").get<int>());
                    const u32 ramp = item.lane.ramp;
                    if (is_global(param)) claim(global_name(param), work.key, clip_where);
                    moved_params.try_emplace(param, window_at == 0 && item.tick == 0 && ramp == 0);
                    if (ramp) {
                        body.push_back({static_cast<u8>(Instr::Ramp), 0, param, value});
                        body.push_back({static_cast<u8>(Instr::RampArg), 0, 0, ramp});
                    } else {
                        body.push_back({static_cast<u8>(Instr::SetParam), 0, param, value});
                    }
                }
            }
            wait_to(now, window);

            Writer key_bytes;
            key_bytes.put(window);
            key_bytes.put_all(body);
            const auto cached = clip_cache.find(key_bytes.bytes);
            if (cached != clip_cache.end()) return cached->second;
            const u16 index = static_cast<u16>(clip_table.size());
            u32 used_slots = 0;
            for (const Instruction& i : body) {
                if (i.op == static_cast<u8>(Instr::SetPatch)) used_slots = std::max<u32>(used_slots, i.a + 1u);
            }
            clip_table.push_back({static_cast<u32>(code.size()), static_cast<u32>(body.size()), window, used_slots});
            code.insert(code.end(), body.begin(), body.end());
            clip_cache.emplace(std::move(key_bytes.bytes), index);
            return index;
        };

        // A repeat compiles the same as the last once it starts with every target where the last one did, which is
        // usually the second. A curve still on its way when its window ends can keep that from ever being exact, so
        // after a few the rest take the last.
        constexpr u32 kMaxRepeatCompiles = 8;
        LaneStates lanes;
        u32 origin = 0;  // the tick `lanes` is seen from
        const auto move_to = [&](u32 tick) {
            for (auto& [key, state] : lanes) state = state.later(static_cast<double>(tick) - origin);
            origin = tick;
        };
        std::vector<Instruction> placed_stream;
        u32 cursor = 0;
        for (const Placed& placed : placements_of.at(work.key)) {
            if (placed.tick < cursor) throw CompileError(track_where, "clips overlap on this track");
            if (placed.tick > cursor)
                placed_stream.push_back({static_cast<u8>(Instr::Wait), 0, 0, placed.tick - cursor});
            std::vector<std::pair<u16, u32>> calls;
            for (u32 k = 0; k < placed.repeat;) {
                move_to(placed.tick + k * placed.length);
                const LaneStates before = lanes;
                const u16 index = compile_clip(placed, origin, lanes);
                ++k;
                if (!calls.empty() && calls.back().first == index) {
                    ++calls.back().second;
                } else {
                    calls.emplace_back(index, 1);
                }
                move_to(origin + placed.length);
                if (lanes == before || k >= kMaxRepeatCompiles) {
                    calls.back().second += placed.repeat - k;
                    origin = placed.tick + placed.span();
                    break;
                }
            }
            for (const auto& [index, count] : calls) {
                placed_stream.push_back({static_cast<u8>(Instr::Call), 0, index, count});
            }
            cursor = placed.tick + placed.span();
        }
        placed_stream.push_back({static_cast<u8>(Instr::End), 0, 0, 0});
        length_ticks = std::max(length_ticks, cursor);
        notes_at_once[work.key] = peak_notes(work, d);

        // The head of the stream. A locate replays from here, so every target a lane moved returns to where it started
        // and then chases forward, which is what lets a loop or a jump back sound the same as playing from the top.
        std::vector<Instruction> stream;
        // A stolen voice fades out when the track asks, which costs fade slots, so cutting it is the default that every
        // document before this had.
        const std::string steal = d.value("steal", std::string{"cut"});
        if (steal != "cut" && steal != "fade") throw CompileError(track_where, "steal is cut or fade");
        if (steal == "fade") stream.push_back({static_cast<u8>(Instr::Steal), 1, 0, 0});
        if (d.contains("play")) {
            const Instruction play = play_instruction(d.at("play"), track_where);
            const Instruction poly{static_cast<u8>(Instr::PlayMode), 0, 0, std::bit_cast<u32>(0.0f)};
            if (play.a != poly.a || play.b != poly.b || play.c != poly.c) stream.push_back(play);
        }
        for (const u16 reg : moved_registers) {
            stream.push_back({static_cast<u8>(Instr::SetMix), 0, reg, std::bit_cast<u32>(mix_init[reg])});
        }
        for (const auto& [where_at, start] : moved_inserts) {
            stream.push_back({static_cast<u8>(Instr::SetInsert), static_cast<u8>(where_at.first), where_at.second,
                              std::bit_cast<u32>(start)});
        }
        for (const auto& [param, opens_at_zero] : moved_params) {
            if (opens_at_zero) continue;
            stream.push_back({static_cast<u8>(Instr::SetParam), 0, param, std::bit_cast<u32>(param_start(param))});
        }
        stream.insert(stream.end(), placed_stream.begin(), placed_stream.end());

        TrackDesc& desc = track_table[work.index];
        desc.stream_begin = static_cast<u32>(code.size());
        desc.stream_length = static_cast<u32>(stream.size());
        code.insert(code.end(), stream.begin(), stream.end());
    }

    // A stage's pair, for an editor to write as a control moves by hand.
    const auto stages_report = [](const Chain& c) {
        json list = json::array();
        for (const Chain::Stage& stage : c.stages) {
            if (stage.reg >= 0) {
                list.push_back({{"left", stage.reg}, {"right", stage.reg + 1}, {"of", factor_names(stage.of)}});
            }
        }
        return list;
    };
    json warnings = json::array();
    for (const auto& [key, c] : chains) {
        if (c.kind == Chain::TrackChain && compiled_track_index.count(key)) {
            json t;
            t["id"] = c.doc->at("id");
            t["name"] = c.doc->value("name", std::string{});
            t["index"] = compiled_track_index.at(key);
            t["step"] = c.step;
            t["bus"] = c.pre_reg;
            t["mix"] = c.mix;
            t["stages"] = stages_report(c);
            const auto [peak, first] = notes_at_once.at(key);
            const u32 voices = track_table[static_cast<std::size_t>(compiled_track_index.at(key))].voices;
            t["notes_at_once"] = peak;
            if (first != kNever) {
                warnings.push_back(
                    {{"where", where + "/" + key},
                     {"tick", first},
                     {"message", "holds up to " + std::to_string(peak) + " notes at once with " +
                                     std::to_string(voices) + " voices, so the oldest are cut short to make room"}});
            }
            report_tracks.push_back(std::move(t));
        } else if (c.kind == Chain::BusChain && c.live) {
            json b;
            b["id"] = c.doc->at("id");
            b["step"] = c.step;
            b["bus"] = c.pre_reg;
            b["mix"] = c.mix;
            b["stages"] = stages_report(c);
            report_buses.push_back(std::move(b));
        }
    }
    std::sort(report_tracks.begin(), report_tracks.end(),
              [](const json& a, const json& b) { return a.at("index") < b.at("index"); });

    // The conductor. A change marked `ramp` glides to the next one, linearly in bpm over ticks. The engine has no ramp,
    // so it gets steps: one every 1/32 note, each at the tempo halfway through it, and longer ones for a ramp long
    // enough to need more than kMaxRampSteps. Each step rounds to its sample, as any change does.
    constexpr u32 kMaxRampSteps = 1024;  // 32 bars of 4/4 in 1/32 notes, and 16 KiB of conductor
    struct TempoChange {
        u32 tick;
        float bpm;
        bool ramp;
    };
    std::vector<TempoChange> tempo;
    for (const json& t : doc.value("tempo", json::array())) {
        tempo.push_back({t.at("tick").get<u32>(), t.at("bpm").get<float>(), t.value("ramp", false)});
    }
    std::stable_sort(tempo.begin(), tempo.end(), [](const auto& a, const auto& b) { return a.tick < b.tick; });
    const auto uspq_of = [&](float bpm) {
        if (!(bpm >= 1.0f && bpm <= 1000.0f)) throw CompileError(where, "tempo must be 1 to 1000 bpm");
        return static_cast<u32>(60000000.0f / bpm);
    };
    std::vector<std::pair<u32, u32>> changes;  // tick, microseconds per quarter
    for (std::size_t i = 0; i < tempo.size(); ++i) {
        const TempoChange& from = tempo[i];
        const u32 uspq = uspq_of(from.bpm);
        if (!from.ramp || (i + 1 < tempo.size() && tempo[i + 1].tick == from.tick)) {
            changes.emplace_back(from.tick, uspq);
            continue;
        }
        if (i + 1 == tempo.size()) throw CompileError(where, "a tempo ramp needs a later change to ramp to");
        const TempoChange& to = tempo[i + 1];
        const u32 span = to.tick - from.tick;
        const u32 step = std::max({1u, ppq / 8u, (span + kMaxRampSteps - 1) / kMaxRampSteps});
        u32 last = 0;
        for (u32 at = from.tick; at < to.tick;) {
            const u32 end = at + std::min(step, to.tick - at);
            const double middle = (static_cast<double>(at) + end) / 2.0 - from.tick;
            const u32 u = uspq_of(static_cast<float>(from.bpm + (to.bpm - from.bpm) * middle / span));
            if (u != last) changes.emplace_back(at, u);  // A ramp between equal tempos is one change
            last = u;
            at = end;
        }
    }
    u32 initial_uspq = 500000;
    std::vector<Instruction> conductor;
    {
        u32 now = 0;
        for (const auto& [tick, uspq] : changes) {
            if (tick == 0) {
                initial_uspq = uspq;
                continue;
            }
            if (tick > now) conductor.push_back({static_cast<u8>(Instr::Wait), 0, 0, tick - now});
            now = tick;
            conductor.push_back({static_cast<u8>(Instr::Tempo), 0, 0, uspq});
        }
        conductor.push_back({static_cast<u8>(Instr::End), 0, 0, 0});
    }

    ProgramHeader h{};
    h.ppq = ppq;
    h.uspq = initial_uspq;
    h.length_ticks = length_ticks;
    h.conductor_begin = static_cast<u32>(code.size());
    h.conductor_length = static_cast<u32>(conductor.size());
    code.insert(code.end(), conductor.begin(), conductor.end());
    h.code = static_cast<u32>(code.size());
    h.patches = static_cast<u16>(patch_hashes.size());
    h.tracks = static_cast<u16>(track_table.size());
    h.slots = static_cast<u16>(slots.size());
    h.clips = static_cast<u16>(clip_table.size());
    h.inserts = static_cast<u16>(insert_table.size());
    h.mix_steps = static_cast<u16>(mix.size());
    h.gather_inputs = static_cast<u16>(gather_inputs.size());
    h.buses = static_cast<u16>(next_reg);
    h.mix_regs = static_cast<u16>(mix_init.size());
    h.globals = static_cast<u16>(globals.size());
    h.inits = static_cast<u16>(inits.size());
    h.master = static_cast<u16>(chains.at("master").reg);
    for (const Instruction& i : code) {
        if (i.op == static_cast<u8>(Instr::RampMix)) h.features |= kFeatureMixRamps;
        if (i.op == static_cast<u8>(Instr::PlayMode)) h.features |= kFeaturePlayModes;
        if (i.op == static_cast<u8>(Instr::Steal)) h.features |= kFeatureStealFades;
    }

    Writer w;
    w.put(h);
    w.put_all(patch_hashes);
    w.put_all(track_table);
    w.put_all(slots);
    w.align(4);
    w.put_all(clip_table);
    w.put_all(insert_table);
    w.put_all(mix);
    w.put_all(gather_inputs);
    w.align(4);
    w.put_all(mix_init);
    for (const auto& [id, g] : globals) w.put(g);
    w.put_all(inits);
    w.align(4);
    w.put_all(code);

    Chunk chunk = make_chunk(ChunkKind::Program, std::move(w.bytes));
    json report;
    report["name"] = name;
    if (entry.contains("id")) report["id"] = entry.at("id");
    report["hash"] = hex(chunk.hash);
    report["ppq"] = ppq;
    report["length_ticks"] = length_ticks;
    report["tracks"] = report_tracks;
    report["buses"] = report_buses;
    report["inserts"] = json::array();
    for (const auto& [id, insert] : compiled_inserts) {
        report["inserts"].push_back({{"id", id}, {"index", insert.index}});
    }
    report["master"] = {{"step", chains.at("master").step},
                        {"bus", chains.at("master").reg},
                        {"stages", stages_report(chains.at("master"))}};
    report["warnings"] = std::move(warnings);
    json used_patches = json::array();
    for (std::size_t i = 0; i < patch_ids.size(); ++i) {
        used_patches.push_back({{"id", patch_ids[i]}, {"hash", hex(patch_hashes[i])}});
    }
    report["patches"] = std::move(used_patches);
    image.users[chunk.hash].insert(program_index);
    report["size"] = chunk.payload.size();
    const u64 program_hash = chunk.hash;
    image.chunks.try_emplace(program_hash, std::move(chunk));
    return report;
}

namespace detail {

// A manifest and then every chunk not in `omit`, in the order given.
inline std::vector<std::byte> write_image(const std::vector<const Chunk*>& ordered, const std::set<u64>& omit,
                                          u32 frame_size) {
    u32 programs = 0;
    Writer body;
    for (const Chunk* c : ordered) programs += c->kind == ChunkKind::Program;
    // Not kFormatRevision: an image needs only the revision of what it uses, so it keeps loading on older engines. This
    // covers omitted chunks too, as a receiver runs those just the same.
    u32 needs_revision = 0;
    for (const Chunk* c : ordered) {
        const ByteSpan payload{c->payload.data(), c->payload.size()};
        PatchView patch;
        ProgramView program;
        if (c->kind == ChunkKind::Patch && parse_patch(payload, patch)) {
            const u32 steps = static_cast<u32>(patch.h.control_steps) + patch.h.voice_steps;
            for (u32 i = 0; i < steps; ++i) {
                const u8 op = patch.step(i).op;
                if (op_known(op)) needs_revision = std::max(needs_revision, op_revision(static_cast<Op>(op)));
            }
        } else if (c->kind == ChunkKind::Program && parse_program(payload, program)) {
            for (u32 i = 0; i < program.h.code; ++i) {
                const u8 op = program.instruction(i).op;
                if (op < static_cast<u8>(Instr::kCount)) {
                    needs_revision = std::max(needs_revision, instr_revision(static_cast<Instr>(op)));
                }
                if (op == static_cast<u8>(Instr::PlayMode) &&
                    program.instruction(i).a == static_cast<u8>(PlayKind::LegatoVelocity)) {
                    needs_revision = std::max(needs_revision, kLegatoVelocityRevision);
                }
            }
        }
    }
    if (frame_size != kOriginalFrameSize) needs_revision = std::max(needs_revision, kFrameSizeRevision);
    body.put(ManifestHeader{static_cast<u32>(ordered.size()), programs, needs_revision,
                            frame_size == kOriginalFrameSize ? 0 : frame_size});
    for (const Chunk* c : ordered) {
        const bool present = !omit.count(c->hash);
        body.put(ManifestEntry{c->hash, static_cast<u32>(c->payload.size()), static_cast<u8>(c->kind),
                               static_cast<u8>(present), 0});
    }
    const Chunk manifest = make_chunk(ChunkKind::Manifest, std::move(body.bytes));

    Writer out;
    const auto put_chunk = [&](const Chunk& c) {
        ChunkHeader h{};
        h.magic = kChunkMagic;
        h.kind = static_cast<u8>(c.kind);
        h.version = kFormatVersion;
        h.size = static_cast<u32>(c.payload.size());
        h.hash = c.hash;
        out.put(h);
        out.bytes.insert(out.bytes.end(), c.payload.begin(), c.payload.end());
        out.align(kChunkAlign);
    };
    put_chunk(manifest);
    for (const Chunk* c : ordered) {
        if (!omit.count(c->hash)) put_chunk(*c);
    }
    return std::move(out.bytes);
}

// A limit or a rule the passes above did not catch is reported here, by the validator a device would run, rather than
// on that device. Thin images are checked in full, because their omitted chunks are what the rest refer to.
inline void check_loads(const std::vector<const Chunk*>& ordered, u32 frame_size) {
    const std::vector<std::byte> bytes = write_image(ordered, {}, frame_size);
    std::vector<u64> aligned((bytes.size() + 7) / 8);
    std::memcpy(aligned.data(), bytes.data(), bytes.size());
    std::vector<ChunkRef> storage(kMaxChunks);
    ChunkTable table{std::span(storage)};
    Loader loader(table);
    loader.begin({reinterpret_cast<const std::byte*>(aligned.data()), bytes.size()});
    while (loader.step(1u << 20) == LoadStatus::Working) {
    }
    if (loader.status() != LoadStatus::Ready) {
        throw CompileError("image", std::string("the compiled image would not load: ") + to_string(loader.error()));
    }
}

// A target's profile, read strictly: a missing or mistyped field fails, since a check against half a profile would pass
// what the device refuses.
struct Target {
    std::string name;
    u32 revision = 0, frame_size = 0, channels = 0, chunks = 0;
    float rate = 0.0f;
    u64 fast = 0, bulk = 0, image_bytes = 0;
    std::set<u8> opcodes;
    Layout layout;
    std::optional<Costs> cost;  // only a device that refuses what it can't keep up with has one
};

inline bool is_natural(const json& v) {
    return v.is_number_unsigned() || (v.is_number_integer() && v.get<std::int64_t>() >= 0);
}

inline Target read_target(const json& profile) {
    const auto field = [](const json& object, const char* key) -> const json& {
        if (!object.is_object() || !object.contains(key)) {
            throw CompileError("target", std::string("a profile needs \"") + key + "\"");
        }
        return object.at(key);
    };
    const auto whole = [&](const json& object, const char* key) -> u64 {
        const json& v = field(object, key);
        if (!is_natural(v)) throw CompileError("target", std::string("\"") + key + "\" must be a whole number");
        return v.get<u64>();
    };
    const auto small = [&](const json& object, const char* key) -> u32 {
        const u64 v = whole(object, key);
        if (v > 0xFFFFFFFFu) throw CompileError("target", std::string("\"") + key + "\" is too large");
        return static_cast<u32>(v);
    };
    Target t;
    const json& name = field(profile, "name");
    if (!name.is_string()) throw CompileError("target", "\"name\" must be a string");
    t.name = name.get<std::string>();
    t.revision = small(profile, "revision");
    t.frame_size = small(profile, "frame_size");
    t.channels = small(profile, "channels");
    t.chunks = small(profile, "chunks");
    t.image_bytes = whole(profile, "image_bytes");
    const json& rate = field(profile, "rate");
    if (!rate.is_number() || !(rate.get<double>() >= 1000.0 && rate.get<double>() <= 384000.0)) {
        throw CompileError("target", "\"rate\" must be from 1000 to 384000");
    }
    t.rate = rate.get<float>();
    const json& memory = field(profile, "memory");
    t.fast = whole(memory, "fast");
    t.bulk = whole(memory, "bulk");
    for (const json& op : field(profile, "opcodes")) {
        if (!is_natural(op) || op.get<u64>() > 255) throw CompileError("target", "an opcode must be 0 to 255");
        t.opcodes.insert(op.get<u8>());
    }

    const json& l = field(profile, "layout");
    Layout& out = t.layout;
    out.frame_size = t.frame_size;
    out.channels = t.channels;
    out.workers = small(l, "workers");
    const json& edges = field(l, "edges");
    if (!edges.is_boolean()) throw CompileError("target", "\"edges\" must be true or false");
    out.edges = edges.get<bool>();
    out.align = small(l, "align");
    out.region_align = small(l, "region_align");
    out.generation = small(l, "generation");
    out.delay_line = small(l, "delay_line");
    out.state_align = small(l, "state_align");
    const auto pow2 = [](u32 v) { return v != 0 && std::has_single_bit(v); };
    if (!pow2(out.align) || !pow2(out.region_align) || !pow2(out.state_align) || out.workers == 0) {
        throw CompileError("target", "a layout's alignments must be powers of two, and it needs a worker");
    }
    const auto size = [&](const char* key) {
        const json& v = field(l, key);
        if (!v.is_array() || v.size() != 2 || !is_natural(v[0]) || !is_natural(v[1]) || v[0].get<u64>() > 0xFFFFFFFFu ||
            v[1].get<u64>() > 0xFFFFFFFFu || !pow2(v[1].get<u32>())) {
            throw CompileError("target", std::string("\"") + key + "\" must be a size and a power-of-two alignment");
        }
        return Layout::Size{v[0].get<u32>(), v[1].get<u32>()};
    };
    out.binding = size("binding");
    out.track = size("track");
    out.insert = size("insert");
    out.decoded_step = size("decoded_step");
    out.bound_resource = size("bound_resource");
    out.param_state = size("param_state");
    out.slot = size("slot");
    out.voice = size("voice");
    out.held = size("held");
    out.glide = size("glide");
    out.fade = size("fade");
    out.mix_ramp = size("mix_ramp");
    out.task = size("task");
    const json& states = field(l, "state_size");
    if (!states.is_array()) throw CompileError("target", "\"state_size\" must be a list");
    for (std::size_t i = 0; i < states.size() && i < out.state_size.size(); ++i) {
        if (!is_natural(states[i]) || states[i].get<u64>() > 0xFFFFFFFFu) {
            throw CompileError("target", "a state size must be a whole number");
        }
        out.state_size[i] = states[i].get<u32>();
    }
    for (const u8 op : t.opcodes) {
        if (op >= states.size() && op < out.state_size.size()) {
            throw CompileError("target", "\"state_size\" has no size for an opcode the target runs");
        }
    }
    if (profile.contains("cost")) {
        const json& c = profile.at("cost");
        Costs k;
        each_cost(k, [&](const char* key, u32& v) { v = small(c, key); });
        const auto price = [](const json& v) {
            if (!is_natural(v) || v.get<u64>() > 0xFFFFFFFFu) {
                throw CompileError("target", "a step's cost must be a whole number");
            }
            return v.get<u32>();
        };
        for (const auto& [key, prices] :
             {std::pair{"step", &k.step}, std::pair{"still", &k.still}, std::pair{"first", &k.first}}) {
            const json& list = field(c, key);
            if (!list.is_array()) throw CompileError("target", std::string("\"") + key + "\" must be a list");
            for (std::size_t i = 0; i < list.size() && i < prices->size(); ++i) (*prices)[i] = price(list[i]);
            for (const u8 op : t.opcodes) {
                if (op >= list.size() && op < prices->size()) {
                    throw CompileError("target",
                                       std::string("\"") + key + "\" has no cost for an opcode the target runs");
                }
            }
        }
        const json& modes = field(c, "modes");
        if (!modes.is_array() || modes.size() > k.modes.size()) {
            throw CompileError("target", "\"modes\" must be a list of at most " + std::to_string(k.modes.size()));
        }
        for (std::size_t i = 0; i < modes.size(); ++i) {
            const json& m = modes[i];
            if (!m.is_array() || m.size() != 4 || price(m[0]) > 255 || price(m[1]) > 255) {
                throw CompileError("target", "a mode's cost is [op, mode, moving, still]");
            }
            k.modes[i] = {static_cast<u8>(price(m[0])), static_cast<u8>(price(m[1])), price(m[2]), price(m[3])};
        }
        t.cost = k;
    }
    return t;
}

// The most voices each track could have, the others staying as they are, for a frame within a target's budget. A
// frame costs more with each voice, so a search finds it.
inline std::vector<u32> voices_that_fit(const ChunkTable& table, u64 program, float rate, const Costs& k,
                                        const Layout& layout) {
    const ChunkRef* c = table.find(program, ChunkKind::Program);
    ProgramView p;
    (void)parse_program({c->data, c->size}, p);  // the loader checked it
    std::vector<u32> voices(p.h.tracks), fit(p.h.tracks);
    for (u32 t = 0; t < p.h.tracks; ++t) voices[t] = p.track(t).voices;
    for (u32 t = 0; t < p.h.tracks; ++t) {
        std::vector<u32> trial = voices;
        u32 low = 1, high = kMaxVoices;  // a track has at least one voice
        while (low < high) {
            trial[t] = (low + high + 1) / 2;
            if (Synth<>::frame_cost(table, program, rate, k, layout, nullptr, trial) <= k.budget) {
                low = trial[t];
            } else {
                high = trial[t] - 1;
            }
        }
        trial[t] = low;
        fit[t] = Synth<>::frame_cost(table, program, rate, k, layout, nullptr, trial) <= k.budget ? low : 0;
    }
    return fit;
}

// Why a Program is over a target's budget, and how many voices of each track would fit with the others as they are.
inline std::string over_budget(const ChunkTable& table, u64 program, u64 cycles, const Costs& k,
                               const std::vector<u32>& fit) {
    const ChunkRef* c = table.find(program, ChunkKind::Program);
    ProgramView p;
    (void)parse_program({c->data, c->size}, p);  // the loader checked it
    std::string text = "could need " + std::to_string(cycles) + " cycles in a frame, and this target has " +
                       std::to_string(k.budget) + ". Every voice sounding at once is counted.";
    for (u32 t = 0; t < p.h.tracks; ++t) {
        const u32 voices = p.track(t).voices;
        text += " Track " + std::to_string(p.track(t).id) + " has " + std::to_string(voices) +
                (voices == 1 ? " voice" : " voices");
        text += fit[t] > 0 ? ", and fits with " + std::to_string(fit[t]) + "." : ", and no number fits alone.";
    }
    return text;
}

// How far past full scale a Program goes, for its error.
inline std::string over_full_scale(const Peak& peak) {
    char text[160];
    std::snprintf(
        text, sizeof text,
        "reaches %.3f at %.2f s, %.1f dB over full scale, and this target plays up to 1. Turn it down: the master's "
        "gain, or a track's or a bus's.",
        static_cast<double>(peak.level), peak.seconds, 20.0 * std::log10(static_cast<double>(peak.level)));
    return text;
}

// Fails what a device would refuse, checked as it would load the image, and what it would play past full scale, which
// a device has no limiter to stop, found by playing each Program here as the device would. Otherwise says how much of
// the device the image takes. `names` names each Program, in the order a bank selects them.
inline json check_target(const Target& t, const std::vector<std::byte>& bytes, const std::vector<std::string>& names) {
    const auto fail = [&](const std::string& why) { throw CompileError("target", t.name + ": " + why); };
    const auto bytes_text = [](u64 n) { return std::to_string(n) + " bytes"; };
    if (bytes.size() >= sizeof(ChunkHeader) + sizeof(ManifestHeader)) {
        const ManifestHeader m = load<ManifestHeader>(bytes.data() + sizeof(ChunkHeader));
        if (m.revision > t.revision) {
            fail("the image needs format revision " + std::to_string(m.revision) + ", and this target reads up to " +
                 std::to_string(t.revision));
        }
    }
    if (bytes.size() > t.image_bytes) {
        fail("the image is " + bytes_text(bytes.size()) + ", and this target stores up to " +
             bytes_text(t.image_bytes));
    }

    std::vector<u64> aligned((bytes.size() + 7) / 8);
    std::memcpy(aligned.data(), bytes.data(), bytes.size());
    std::vector<ChunkRef> storage(kMaxChunks);
    ChunkTable table{std::span(storage)};
    Loader loader(table);
    loader.begin({reinterpret_cast<const std::byte*>(aligned.data()), bytes.size()}, t.frame_size);
    while (loader.step(1u << 20) == LoadStatus::Working) {
    }
    if (loader.status() != LoadStatus::Ready)
        fail(std::string("the image would not load: ") + to_string(loader.error()));
    if (table.size() > t.chunks) {
        fail("the image has " + std::to_string(table.size()) + " chunks, and this target holds " +
             std::to_string(t.chunks));
    }
    for (u32 i = 0; i < table.size(); ++i) {
        const ChunkRef& c = storage[i];
        if (c.kind != static_cast<u8>(ChunkKind::Patch)) continue;
        PatchView v;
        (void)parse_patch({c.data, c.size}, v);  // the loader checked it
        for (u32 s = 0; s < static_cast<u32>(v.h.control_steps) + v.h.voice_steps; ++s) {
            const u8 op = v.step(s).op;
            if (!t.opcodes.count(op)) fail("a patch uses opcode " + std::to_string(op) + ", which this target lacks");
        }
    }

    MemorySizes most;
    u64 most_cycles = 0;
    json programs = json::array();
    for (u32 i = 0; i < loader.programs(); ++i) {
        const MemorySizes need = Synth<>::bytes_required(table, loader.program_hash(i), t.rate, t.layout);
        const std::string name =
            i < names.size() && !names[i].empty() ? "Program \"" + names[i] + "\"" : "Program " + std::to_string(i);
        if (need.fast > t.fast || need.bulk > t.bulk) {
            const bool fast = need.fast > t.fast;
            fail(name + " needs " + bytes_text(fast ? need.fast : need.bulk) + " of " + (fast ? "fast" : "bulk") +
                 " memory, and this target has " + bytes_text(fast ? t.fast : t.bulk));
        }
        json entry = {{"fast", need.fast}, {"bulk", need.bulk}};
        if (t.cost) {
            const u64 program = loader.program_hash(i);
            CostParts parts;
            const u64 cycles = Synth<>::frame_cost(table, program, t.rate, *t.cost, t.layout, &parts);
            const std::vector<u32> fit = voices_that_fit(table, program, t.rate, *t.cost, t.layout);
            if (cycles > t.cost->budget) fail(name + " " + over_budget(table, program, cycles, *t.cost, fit));
            entry["cycles"] = cycles;
            entry["cycles_by"] = {{"fixed", parts.fixed},
                                  {"voices", parts.voices},
                                  {"events", parts.events},
                                  {"inserts", parts.inserts},
                                  {"mixer", parts.mixer}};
            const ChunkRef* chunk = table.find(program, ChunkKind::Program);
            ProgramView view;
            (void)parse_program({chunk->data, chunk->size}, view);
            json tracks = json::array();
            for (u32 n = 0; n < fit.size(); ++n) {
                tracks.push_back({{"id", view.track(n).id}, {"voices", view.track(n).voices}, {"fit", fit[n]}});
            }
            entry["voices"] = std::move(tracks);
            most_cycles = std::max(most_cycles, cycles);
        }
        const Peak peak = peak_of({reinterpret_cast<const std::byte*>(aligned.data()), bytes.size()}, i, t.rate,
                                  t.frame_size, t.channels);
        if (!peak.ok) fail(name + " can't be played here to find its peak");
        if (peak.level > 1.0f) fail(name + " " + over_full_scale(peak));
        entry["peak"] = peak.level;
        programs.push_back(std::move(entry));
        most.fast = std::max(most.fast, need.fast);
        most.bulk = std::max(most.bulk, need.bulk);
    }
    json report = {{"name", t.name},
                   {"image_bytes", {bytes.size(), t.image_bytes}},
                   {"chunks", {table.size(), t.chunks}},
                   {"fast", {most.fast, t.fast}},
                   {"bulk", {most.bulk, t.bulk}},
                   {"programs", std::move(programs)}};
    if (t.cost) report["cycles"] = {most_cycles, t.cost->budget};
    return report;
}

}  // namespace detail

struct ImageResult {
    std::vector<std::byte> image;
    json report;
};

// The one entry point: a single Program, a bundle, or a thin image are all this function.
//   { "patches": { id: { "name", "graph" } }, "assets": { id: { ... } }, "programs": [ { "id", "name", "timeline" } ],
//     "omit": [ "hex hash" ], "live": false, "target": { a profile, see Profile.hpp } }
inline ImageResult compile_image(const json& request) {
    using namespace detail;
    static const json no_entries = json::object();
    ImageContext context;
    context.patches = request.contains("patches") ? &request.at("patches") : &no_entries;
    context.assets = request.contains("assets") ? &request.at("assets") : nullptr;
    const bool keep_unused = request.value("live", false);
    std::optional<Target> target;
    if (request.contains("target")) target = read_target(request.at("target"));
    const json requested_frame =
        request.value("frame_size", json(target ? target->frame_size : SynthConfig{}.frame_size));
    const std::int64_t requested_size = requested_frame.is_number_integer() ? requested_frame.get<std::int64_t>() : 0;
    const u32 frame_size = static_cast<u32>(std::clamp<std::int64_t>(requested_size, 0, kMaxFrameSize + 1));
    if (!std::has_single_bit(frame_size) || frame_size < kMinFrameSize || frame_size > kMaxFrameSize) {
        throw CompileError("request", "frame_size must be a power of two from 8 to 1024");
    }
    if (target && frame_size != target->frame_size) {
        throw CompileError("target", target->name + " plays frames of " + std::to_string(target->frame_size) +
                                         ", and the request asks for " + std::to_string(frame_size));
    }

    json programs = json::array();
    const json& entries = request.at("programs");
    if (entries.empty()) {
        // A library, sent ahead of the Programs that will use it. Nothing chooses among its patches, so all of them go,
        // but for a graph with outlets and no out node, which can only ever be part of another.
        for (const auto& [id, patch] : context.patches->items()) {
            const json nodes = patch.at("graph").value("nodes", json::array());
            const auto is = [](const char* type) {
                return [type](const json& n) { return n.value("type", std::string{}) == type; };
            };
            if (std::none_of(nodes.begin(), nodes.end(), is("out")) &&
                std::any_of(nodes.begin(), nodes.end(), is("outlet"))) {
                continue;
            }
            (void)compiled_patch(context, id, 0, "patch:" + id);
        }
        context.users.clear();  // Nothing uses them yet
        if (context.chunks.empty()) throw CompileError("request", "an image needs a program or a patch");
    }
    std::vector<u64> program_hashes;
    std::vector<std::string> program_names;
    for (std::size_t i = 0; i < entries.size(); ++i) {
        json report = compile_program(context, entries[i], i, keep_unused);
        const u64 hash = std::stoull(report.at("hash").get<std::string>(), nullptr, 16);
        const auto found = std::find(program_hashes.begin(), program_hashes.end(), hash);
        report["index"] = found == program_hashes.end() ? program_hashes.size()
                                                        : static_cast<std::size_t>(found - program_hashes.begin());
        if (found == program_hashes.end()) {
            program_hashes.push_back(hash);
            program_names.push_back(entries[i].value("name", std::string{}));
        }
        programs.push_back(std::move(report));
    }

    std::set<u64> omit;
    for (const json& h : request.value("omit", json::array())) {
        omit.insert(std::stoull(h.get<std::string>(), nullptr, 16));
    }
    if (target && !omit.empty()) throw CompileError("target", "a target is checked with a whole image, not a thin one");

    // Assets, tables and patches sort by hash, so a set in any order gives identical bytes. Programs keep request
    // order, because their position is how a bank selects them.
    std::vector<const Chunk*> ordered;
    for (const ChunkKind kind : {ChunkKind::Asset, ChunkKind::Table, ChunkKind::Patch}) {
        for (const auto& [hash, chunk] : context.chunks) {
            if (chunk.kind == kind) ordered.push_back(&chunk);
        }
    }
    for (const u64 hash : program_hashes) ordered.push_back(&context.chunks.at(hash));

    check_loads(ordered, frame_size);
    std::vector<std::byte> bytes = write_image(ordered, omit, frame_size);

    json chunks = json::array();
    static constexpr const char* kind_names[] = {"manifest", "asset", "table", "patch", "program"};
    std::size_t chunk_bytes = 0, omitted_bytes = 0;
    for (const Chunk* c : ordered) {
        const bool present = !omit.count(c->hash);
        (present ? chunk_bytes : omitted_bytes) += c->payload.size();
        chunks.push_back({{"kind", kind_names[static_cast<u8>(c->kind)]},
                          {"hash", hex(c->hash)},
                          {"size", c->payload.size()},
                          {"present", present},
                          {"programs", context.users[c->hash].size()}});
    }

    json report;
    report["programs"] = std::move(programs);
    report["chunks"] = std::move(chunks);
    report["image_bytes"] = bytes.size();
    report["chunk_bytes"] = chunk_bytes;
    report["omitted_bytes"] = omitted_bytes;
    report["ok"] = true;
    report["library_patches"] = context.patches->size();
    report["compiled_patches"] = context.compiled.size();
    json sidecar = json::object();
    for (const auto& [id, patch] : context.compiled) sidecar[id] = patch.nodes;
    report["sidecar"] = std::move(sidecar);
    if (target) report["target"] = check_target(*target, bytes, program_names);
    return {std::move(bytes), std::move(report)};
}

// Keeps JSON and compile errors in one shape for the bindings: ok, report or errors.
inline ImageResult compile_image_checked(const std::string& text) {
    try {
        return compile_image(json::parse(text));
    } catch (const CompileError& e) {
        return {{}, json{{"ok", false}, {"errors", json::array({{{"where", e.where}, {"message", e.what()}}})}}};
    } catch (const std::exception& e) {
        return {{}, json{{"ok", false}, {"errors", json::array({{{"where", "request"}, {"message", e.what()}}})}}};
    }
}

}  // namespace modsynth::compiler
