#pragma once

// Authoring JSON to image bytes. Host-side only: it allocates and throws, and firmware never includes it.
//
// The rule that makes patch sharing work: a Patch chunk is a function of its graph alone. Nothing from a timeline,
// track or target reaches compile_patch(), so one library patch has one hash wherever it is used.

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <map>
#include <nlohmann/json.hpp>
#include <optional>
#include <queue>
#include <set>
#include <stdexcept>
#include <string>
#include <tuple>
#include <vector>

#include <modsynth/Config.hpp>
#include <modsynth/Format.hpp>
#include <modsynth/Loader.hpp>

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

struct InputSpec {
    const char* name;
    float def;
};

struct NodeSpec {
    const char* type;
    std::vector<InputSpec> inputs;
    std::vector<const char*> outputs;
};

inline const std::vector<NodeSpec>& node_specs() {
    static const std::vector<NodeSpec> specs = {
        {"note", {}, {"pitch", "velocity", "gate"}},
        {"param", {}, {"out"}},
        {"const", {}, {"out"}},
        {"osc", {{"freq", 440.0f}, {"width", 0.5f}}, {"out"}},
        {"noise", {}, {"out"}},
        {"biquad", {{"in", 0.0f}, {"cutoff", 1000.0f}, {"q", 0.707f}}, {"out"}},
        {"env", {{"attack", 0.01f}, {"decay", 0.1f}, {"sustain", 0.7f}, {"release", 0.2f}}, {"out"}},
        {"sample", {{"ratio", 1.0f}, {"note", 60.0f}, {"start", 0.0f}}, {"l", "r"}},
        {"mul", {{"a", 1.0f}, {"b", 1.0f}}, {"out"}},
        {"add", {{"a", 0.0f}, {"b", 0.0f}}, {"out"}},
        {"mtof", {{"in", 69.0f}}, {"out"}},
        {"snap", {{"in", 0.0f}}, {"out"}},
        {"ratio", {{"in", 60.0f}}, {"out"}},
        {"pan", {{"in", 0.0f}, {"position", 0.0f}}, {"l", "r"}},
        {"delay", {{"in", 0.0f}, {"time", 0.25f}}, {"out"}},
        {"comb", {{"in", 0.0f}, {"time", 0.03f}, {"feedback", 0.8f}, {"damp", 0.2f}}, {"out"}},
        {"allpass", {{"in", 0.0f}, {"time", 0.005f}, {"feedback", 0.5f}}, {"out"}},
        {"follow", {{"in", 0.0f}, {"release", 0.1f}}, {"out"}},
        {"lfo", {{"rate", 1.0f}, {"depth", 1.0f}}, {"out"}},
        {"in", {}, {"l", "r"}},
        {"out", {{"l", 0.0f}, {"r", 0.0f}}, {}},
    };
    return specs;
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
};

using AssetLookup = const json* (*)(const std::string& id, const void* context);

// Compiles one graph. The result depends only on `graph` and on the assets it names.
inline CompiledPatch compile_patch(const json& graph, const std::string& where, AssetLookup assets = nullptr,
                                   const void* context = nullptr) {
    using namespace detail;
    const auto node_where = [&](int id) { return where + "/node:" + std::to_string(id); };

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
    // An input read once a frame refuses audio, because reading one sample in every 128 is right for an envelope and
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
            if (quality != "bandlimited" && quality != "naive" && quality != "fixed") {
                throw CompileError(node_where(id), "unknown osc mode '" + quality + "'");
            }
            if (quality == "fixed" && wave != "sine") throw CompileError(node_where(id), "only sine has a fixed mode");
            if (wave != "square" && input(n, "width")) throw CompileError(node_where(id), "only square has a width");
            const u8 mode = quality == "naive" ? kNaive : 0;
            if (quality == "fixed") {
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
                for (const char* key : {"zones", "reverse", "tail"}) {
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
                std::vector<std::array<float, kZoneFields>> rows;
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
                    const std::string asset = zone.at("asset").get<std::string>();
                    const json* found = find_asset(asset);
                    const u16 ref = add_ref(make_asset(*found, node_where(id)));
                    const float root = zone.value("root", found->value("root_key", 60.0f));
                    if (!(root >= 0.0f && root <= 127.0f))
                        throw CompileError(node_where(id), "zone root must be 0 to 127");
                    const auto [low_key, high_key] = range(zone, "keys");
                    const auto [low_velocity, high_velocity] = range(zone, "velocities");
                    rows.push_back({low_key, high_key, low_velocity, high_velocity, static_cast<float>(ref), root});
                }
                while (!std::has_single_bit(rows.size())) rows.push_back({1.0f});
                Writer table;
                table.put(TableHeader{static_cast<u32>(rows.size()) * kZoneFields, 0});
                for (const auto& row : rows) {
                    for (const float value : row) table.put(value);
                }
                table.put(0.0f);  // guard
                const u16 ref = add_ref(make_chunk(ChunkKind::Table, std::move(table.bytes)));
                const bool literal = n.literals.count("note") != 0;
                const Value note = input(n, "note") || literal ? scalar_in(n, "note") : Value{Bank::Voice, kScalarNote};
                const u8 flags = static_cast<u8>((n.config.value("reverse", false) ? kSampleReverse : 0) |
                                                 (n.config.value("tail", false) ? kSampleTail : 0));
                const Ir ir = audio_step(Op::Sample2, {note, scalar_in(n, "start")}, 2, state, flags, ref);
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
            if (second_part) {
                const Value time = scalar_in(n, "time");
                const u8 mode = feedback.count(id) ? kReadBeforeWrite : u8{0};
                set("out", audio_step(Op::DelayRead, {time}, 1, state, mode, line).out[0]);
            } else {
                // A feedback delay's read may already have run, and this is where its input is finally known.
                audio_step(Op::DelayWrite, {buffer_in(n, "in")}, 0, state + 1, 0, line);
            }
        } else if (type == "comb") {
            const u16 line = add_delay(n, 0.1f);
            const Value in = buffer_in(n, "in"), time = scalar_in(n, "time"), fb = scalar_in(n, "feedback"),
                        damp = scalar_in(n, "damp");
            set("out", audio_step(Op::Comb, {in, time, fb, damp}, 1, state, 0, line).out[0]);
        } else if (type == "allpass") {
            const u16 line = add_delay(n, 0.05f);
            const Value in = buffer_in(n, "in"), time = scalar_in(n, "time"), fb = scalar_in(n, "feedback");
            set("out", audio_step(Op::Allpass, {in, time, fb}, 1, state, 0, line).out[0]);
        } else if (type == "follow") {
            const Value in = buffer_in(n, "in"), release = scalar_in(n, "release");
            set("out", audio_step(Op::Follow, {in, release}, 1, state).out[0]);
        } else if (type == "lfo") {
            const Value rate = scalar_in(n, "rate"), depth = scalar_in(n, "depth");
            set("out", control_step(Op::KLfo, {rate, depth}, state));
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

    CompiledPatch result;
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

inline const CompiledPatch& compiled_patch(ImageContext& image, const std::string& id, std::size_t program,
                                           const std::string& where) {
    if (!image.compiled.count(id)) {
        if (!image.patches->contains(id)) throw CompileError(where, "no patch '" + id + "' in the library");
        const json& entry = image.patches->at(id);
        image.compiled[id] = compile_patch(entry.at("graph"), "patch:" + id, find_asset, &image);
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

struct Chain {
    enum Kind { TrackChain, BusChain, MasterChain } kind = TrackChain;
    std::string key;
    const json* doc = nullptr;
    bool has_notes = false;
    struct Output {
        std::string to;
        float gain_left, gain_right;
        // What those two are the product of, so that a lane can move one of them.
        float fader, mute, pan, send;
        bool is_send;
        int reg = -1;  // its left gain's mix register, with the right one next, once the mixer has one for it
    };
    std::vector<Output> outputs;
    std::vector<std::string> keys;  // sidechain sources of its inserts
    bool live = false;
    int reg = -1;
    int step = -1;  // last mix step, where its output is complete
    json mix = json::array();
};

}  // namespace detail

// Compiles one timeline. Patches enter the image only by being reached from here.
inline json compile_program(detail::ImageContext& image, const json& entry, std::size_t program_index,
                            bool keep_unused) {
    using namespace detail;
    const json& doc = entry.at("timeline");
    const std::string name = entry.value("name", std::string{});
    const std::string where = "timeline:" + (entry.contains("id") ? entry.at("id").dump() : name);

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
        const float gain = d.value("gain", 1.0f);
        const float pan = d.value("pan", 0.0f);
        if (!(pan >= -1.0f && pan <= 1.0f)) throw CompileError(where + "/" + c.key, "pan must be -1 to 1");
        const float mute = d.value("mute", false) ? 0.0f : 1.0f;
        const float left = gain * mute * pan_left(pan), right = gain * mute * pan_right(pan);
        const std::string to = d.value("output", "master");
        c.outputs.push_back({to, left, right, gain, mute, pan, 1.0f, false});
        for (const json& s : d.value("sends", json::array())) {
            const float send = s.value("gain", 1.0f);
            c.outputs.push_back(
                {"bus:" + s.at("bus").get<std::string>(), left * send, right * send, gain, mute, pan, send, true});
        }
        for (const json& i : d.value("inserts", json::array())) {
            if (i.contains("key")) c.keys.push_back(i.at("key").get<std::string>());
        }
    };

    for (std::size_t t = 0; t < tracks_doc.size(); ++t) {
        const json& d = tracks_doc[t];
        Chain c;
        c.kind = Chain::TrackChain;
        c.key = "track:" + d.at("id").dump();
        c.doc = &d;
        for (const json& placed : d.value("placements", json::array())) {
            const std::string id = placed.at("clip").get<std::string>();
            if (!clips.count(id)) throw CompileError(where + "/" + c.key, "no clip '" + id + "'");
            if (!clips.at(id)->value("notes", json::array()).empty()) c.has_notes = true;
        }
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
        std::vector<json> placements;
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
        std::vector<json> placements = d.value("placements", json::array()).get<std::vector<json>>();
        std::stable_sort(placements.begin(), placements.end(), [](const json& a, const json& b) {
            return a.at("tick").get<u32>() < b.at("tick").get<u32>();
        });
        for (const json& placed : placements) {
            for (const json& note : clips.at(placed.at("clip").get<std::string>())->value("notes", json::array())) {
                used.insert(note.value("slot", 0));
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
        track_work.push_back({key, track_where, std::move(slot_map), std::move(track_patches), std::move(placements),
                              track_table.size()});
        track_table.push_back(desc);
    }

    // A live track may have lost every slot: its Program has nothing to run.
    for (const std::string& key : order) {
        Chain& c = chains.at(key);
        if (c.kind == Chain::TrackChain && !compiled_track_index.count(key)) c.live = false;
    }

    // Mixer, with registers allocated by last use.
    std::map<std::string, int> readers;
    for (const std::string& key : order) {
        const Chain& c = chains.at(key);
        if (!c.live) continue;
        for (const auto& o : c.outputs) {
            if (chains.at(o.to).live) ++readers[key];
        }
    }
    for (const std::string& key : order) {
        const Chain& c = chains.at(key);
        if (!c.live) continue;
        for (const auto& k : c.keys) {
            if (chains.at(k).live) ++readers[k];
        }
    }

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
    const auto read_done = [&](const std::string& key) {
        if (--readers[key] == 0) free_regs.insert(chains.at(key).reg);
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

        std::vector<std::string> inputs_read;
        if (c.kind == Chain::TrackChain) {
            c.reg = new_reg();
            mix.push_back({static_cast<u8>(MixOp::RunVoices), 0, task, static_cast<u16>(compiled_track_index.at(key)),
                           static_cast<u16>(c.reg), 0, kNone});
        } else {
            const u16 first = static_cast<u16>(gather_inputs.size());
            const float scale = c.kind == Chain::MasterChain ? c.doc->value("gain", 1.0f) : 1.0f;
            for (const std::string& source_key : order) {
                Chain& source = chains.at(source_key);
                if (!source.live) continue;
                for (auto& o : source.outputs) {
                    if (o.to != key) continue;
                    const u16 gain_left = static_cast<u16>(mix_init.size());
                    o.reg = gain_left;
                    mix_init.push_back(o.gain_left * scale);
                    mix_init.push_back(o.gain_right * scale);
                    source.mix.push_back({{"to", key}, {"left", gain_left}, {"right", gain_left + 1}});
                    gather_inputs.push_back(
                        {static_cast<u16>(source.reg), gain_left, static_cast<u16>(gain_left + 1), 0});
                    inputs_read.push_back(source_key);
                }
            }
            c.reg = new_reg();
            mix.push_back({static_cast<u8>(MixOp::Gather), 0, task, first, static_cast<u16>(c.reg),
                           static_cast<u16>(gather_inputs.size() - first), kNone});
        }
        for (const std::string& source : inputs_read) read_done(source);

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
            std::string key_source;
            if (i.contains("key") && chains.at(i.at("key").get<std::string>()).live) {
                if (p.inputs < 2) throw CompileError(chain_where, "insert patch '" + id + "' has no sidechain input");
                key_source = i.at("key").get<std::string>();
                key_reg = static_cast<u16>(chains.at(key_source).reg);
            }
            mix.push_back({static_cast<u8>(MixOp::RunInsert), 0, task, static_cast<u16>(insert_table.size()),
                           static_cast<u16>(c.reg), static_cast<u16>(c.reg), key_reg});
            compiled_inserts[desc.id] = {static_cast<u16>(insert_table.size()), &p, i.value("params", json::object())};
            insert_table.push_back(desc);
            if (!key_source.empty()) read_done(key_source);
        }
        c.step = static_cast<int>(mix.size()) - 1;
        ++task;
    }
    if (next_reg > static_cast<int>(kMaxRegisters)) throw CompileError(where, "the mixer needs too many buses");

    // A track that doesn't compile doesn't run, and a lane that reaches past its own track would be lost without a
    // sound.
    for (const std::string& key : chain_order) {
        const Chain& c = chains.at(key);
        if (c.kind != Chain::TrackChain || compiled_track_index.count(key)) continue;
        for (const json& placed : c.doc->value("placements", json::array())) {
            for (const json& lane :
                 clips.at(placed.at("clip").get<std::string>())->value("automation", json::array())) {
                if (lane.contains("target")) {
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
    // A mix register holds fader, pan and send multiplied together, so a lane on one has to use the others' values, and
    // those can only be the fixed ones. Two controls in one register therefore can't both move.
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
    const float master_gain = chains.at("master").doc->value("gain", 1.0f);
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
        const auto write = [&](const Chain::Output& o) {
            if (o.reg < 0) return;  // Nothing plays through it
            const float scale = on_master ? value : o.to == "master" ? master_gain : 1.0f;
            const float fader = !on_master && control == "fader" ? value : o.fader;
            const float pan = control == "pan" ? value : o.pan;
            const float send = control == "send" ? value : o.send;
            const float base = fader * o.mute;
            writes.push_back({static_cast<u16>(o.reg), base * pan_left(pan) * send * scale});
            writes.push_back({static_cast<u16>(o.reg + 1), base * pan_right(pan) * send * scale});
        };
        if (on_master) {
            for (const std::string& source : chain_order) {
                for (const auto& o : chains.at(source).outputs) {
                    if (o.to == "master") write(o);
                }
            }
        } else {
            bool found = false;
            for (const auto& o : chains.at(key).outputs) {
                if (control == "send" && (!o.is_send || o.to != to)) continue;
                found = true;
                write(o);
            }
            if (!found) throw CompileError(at, key + " has no send to " + to);
        }
        for (const MixWrite& w : writes) {
            const auto [it, added] = register_control.try_emplace(w.reg, name);
            if (!added && it->second != name) {
                throw CompileError(at, name + " and " + it->second +
                                           " share a mix register, so only one can move here. "
                                           "Automate the other with a gain or pan insert");
            }
        }
        return writes;
    };

    // The clips and streams the track pass left. Their order is what it always was, so nothing that compiled before
    // moves.
    for (const TrackWork& work : track_work) {
        const std::string& track_where = work.where;
        const std::map<int, int>& slot_map = work.slot_map;
        const json& d = *chains.at(work.key).doc;
        std::set<u16> moved_registers;
        std::map<std::pair<u16, u16>, float> moved_inserts;  // insert and parameter, and the value each starts from

        const auto has_param = [&](u16 id) {
            for (const CompiledPatch* p : work.patches) {
                for (const ParamInfo& info : p->params) {
                    if (info.id == id) return true;
                }
            }
            return false;
        };

        const auto play_instruction = [&](const json& play, const std::string& at) -> Instruction {
            for (const auto& [name, field] : play.items()) {
                if (name != "mode" && name != "priority" && name != "glide" && name != "tick") {
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
            return {static_cast<u8>(Instr::PlayMode), static_cast<u8>(kind), static_cast<u16>(order),
                    std::bit_cast<u32>(glide)};
        };

        // A clip's slots depend on the track, so a clip compiles per track and identical results merge.
        const auto compile_clip = [&](const json& clip) {
            enum class ItemKind { Lane, Note, Play };
            struct Item {
                u32 tick;
                int order;
                int key;
                const json* doc;
                ItemKind kind;
            };
            std::vector<Item> items;
            const u32 length = clip.at("length").get<u32>();
            const std::string clip_where = track_where + "/clip:" + clip.at("id").get<std::string>();
            if (length == 0) throw CompileError(clip_where, "clip has no length");
            const json notes = clip.value("notes", json::array());
            const json automation = clip.value("automation", json::array());
            const json plays = clip.value("play", json::array());
            for (const json& n : notes) {
                const u32 tick = n.at("tick").get<u32>();
                if (tick >= length) throw CompileError(clip_where, "a note starts after the clip ends");
                if (n.at("dur").get<u32>() == 0) throw CompileError(clip_where, "a note has no duration");
                items.push_back({tick, 1, n.at("note").get<int>(), &n, ItemKind::Note});
            }
            for (const json& a : automation) {
                const u32 tick = a.at("tick").get<u32>();
                if (tick >= length) throw CompileError(clip_where, "automation starts after the clip ends");
                if (a.contains("target")) {
                    items.push_back({tick, 0, a.value("param", 0), &a, ItemKind::Lane});
                    continue;
                }
                const int param = a.at("param").get<int>();
                if (!has_param(static_cast<u16>(param))) {
                    throw CompileError(
                        clip_where, "automates param " + std::to_string(param) + ", which no patch on this track has");
                }
                items.push_back({tick, 0, param, &a, ItemKind::Lane});
            }
            for (const json& p : plays) {
                const u32 tick = p.at("tick").get<u32>();
                if (tick >= length) throw CompileError(clip_where, "a play change comes after the clip ends");
                items.push_back({tick, -1, 0, &p, ItemKind::Play});
            }
            std::stable_sort(items.begin(), items.end(), [](const Item& a, const Item& b) {
                return std::tie(a.tick, a.order, a.key) < std::tie(b.tick, b.order, b.key);
            });
            std::vector<Instruction> body;
            const auto wait_to = [&](u32 from, u32 to) {
                if (to > from) body.push_back({static_cast<u8>(Instr::Wait), 0, 0, to - from});
            };
            // What a lane with a target does. Each one also notes what it moved, so the stream can put it back.
            const auto target_lane = [&](const json& a) {
                const json& target = a.at("target");
                const u32 ramp = a.value("ramp", 0u);
                const float value = a.at("value").get<float>();
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
                                                       " has voice scope, which only reaches a new note, and an insert "
                                                       "never starts one");
                }
                claim("param " + std::to_string(param) + " of insert " + std::to_string(id), work.key, clip_where);
                const std::string key = std::to_string(param);
                const float start = insert.params.contains(key) ? insert.params.at(key).get<float>() : info->def;
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
                    const int note = n.at("note").get<int>(), velocity = n.value("vel", 100);
                    if (note < 0 || note > 127 || velocity < 0 || velocity > 127) {
                        throw CompileError(clip_where, "note or velocity out of range");
                    }
                    const int slot = slot_map.at(n.value("slot", 0));
                    if (slot != current_slot && slot_map.size() > 1) {
                        body.push_back({static_cast<u8>(Instr::SetPatch), static_cast<u8>(slot), 0, 0});
                    }
                    current_slot = slot;
                    body.push_back({static_cast<u8>(Instr::NoteOn), static_cast<u8>(note), static_cast<u16>(velocity),
                                    n.at("dur").get<u32>()});
                } else if (item.kind == ItemKind::Play) {
                    body.push_back(play_instruction(*item.doc, clip_where));
                } else if (item.doc->contains("target")) {
                    target_lane(*item.doc);
                } else {
                    const json& a = *item.doc;
                    const u32 value = std::bit_cast<u32>(a.at("value").get<float>());
                    const u16 param = static_cast<u16>(a.at("param").get<int>());
                    const u32 ramp = a.value("ramp", 0u);
                    if (ramp) {
                        body.push_back({static_cast<u8>(Instr::Ramp), 0, param, value});
                        body.push_back({static_cast<u8>(Instr::RampArg), 0, 0, ramp});
                    } else {
                        body.push_back({static_cast<u8>(Instr::SetParam), 0, param, value});
                    }
                }
            }
            wait_to(now, length);

            Writer key_bytes;
            key_bytes.put(length);
            key_bytes.put_all(body);
            const auto cached = clip_cache.find(key_bytes.bytes);
            if (cached != clip_cache.end()) return cached->second;
            const u16 index = static_cast<u16>(clip_table.size());
            u32 used_slots = 0;
            for (const Instruction& i : body) {
                if (i.op == static_cast<u8>(Instr::SetPatch)) used_slots = std::max<u32>(used_slots, i.a + 1u);
            }
            clip_table.push_back({static_cast<u32>(code.size()), static_cast<u32>(body.size()), length, used_slots});
            code.insert(code.end(), body.begin(), body.end());
            clip_cache.emplace(std::move(key_bytes.bytes), index);
            return index;
        };

        std::vector<Instruction> placed_stream;
        u32 cursor = 0;
        for (const json& placed : work.placements) {
            const json& clip = *clips.at(placed.at("clip").get<std::string>());
            const u32 tick = placed.at("tick").get<u32>();
            const u32 repeat = placed.value("repeat", 1u);
            if (repeat == 0) throw CompileError(track_where, "a placement repeats 0 times");
            if (tick < cursor) throw CompileError(track_where, "clips overlap on this track");
            const u16 index = compile_clip(clip);
            if (tick > cursor) placed_stream.push_back({static_cast<u8>(Instr::Wait), 0, 0, tick - cursor});
            placed_stream.push_back({static_cast<u8>(Instr::Call), 0, index, repeat});
            cursor = tick + repeat * clip.at("length").get<u32>();
        }
        placed_stream.push_back({static_cast<u8>(Instr::End), 0, 0, 0});
        length_ticks = std::max(length_ticks, cursor);

        // The head of the stream. A locate replays from here, so every target a lane moved returns to where it started
        // and then chases forward, which is what lets a loop or a jump back sound the same as playing from the top.
        std::vector<Instruction> stream;
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
        stream.insert(stream.end(), placed_stream.begin(), placed_stream.end());

        TrackDesc& desc = track_table[work.index];
        desc.stream_begin = static_cast<u32>(code.size());
        desc.stream_length = static_cast<u32>(stream.size());
        code.insert(code.end(), stream.begin(), stream.end());
    }

    for (const auto& [key, c] : chains) {
        if (c.kind == Chain::TrackChain && compiled_track_index.count(key)) {
            json t;
            t["id"] = c.doc->at("id");
            t["name"] = c.doc->value("name", std::string{});
            t["index"] = compiled_track_index.at(key);
            t["step"] = c.step;
            t["bus"] = c.reg;
            t["mix"] = c.mix;
            report_tracks.push_back(std::move(t));
        } else if (c.kind == Chain::BusChain && c.live) {
            json b;
            b["id"] = c.doc->at("id");
            b["step"] = c.step;
            b["bus"] = c.reg;
            b["mix"] = c.mix;
            report_buses.push_back(std::move(b));
        }
    }
    std::sort(report_tracks.begin(), report_tracks.end(),
              [](const json& a, const json& b) { return a.at("index") < b.at("index"); });

    // The conductor.
    std::vector<std::pair<u32, float>> tempo;
    for (const json& t : doc.value("tempo", json::array())) {
        tempo.emplace_back(t.at("tick").get<u32>(), t.at("bpm").get<float>());
    }
    std::stable_sort(tempo.begin(), tempo.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
    const auto uspq_of = [&](float bpm) {
        if (!(bpm >= 1.0f && bpm <= 1000.0f)) throw CompileError(where, "tempo must be 1 to 1000 bpm");
        return static_cast<u32>(60000000.0f / bpm);
    };
    u32 initial_uspq = 500000;
    std::vector<Instruction> conductor;
    {
        u32 now = 0;
        for (const auto& [tick, bpm] : tempo) {
            if (tick == 0) {
                initial_uspq = uspq_of(bpm);
                continue;
            }
            if (tick > now) conductor.push_back({static_cast<u8>(Instr::Wait), 0, 0, tick - now});
            now = tick;
            conductor.push_back({static_cast<u8>(Instr::Tempo), 0, 0, uspq_of(bpm)});
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
    report["master"] = {{"step", chains.at("master").step}, {"bus", chains.at("master").reg}};
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

}  // namespace detail

struct ImageResult {
    std::vector<std::byte> image;
    json report;
};

// The one entry point: a single Program, a bundle, or a thin image are all this function.
//   { "patches": { id: { "name", "graph" } }, "assets": { id: { ... } }, "programs": [ { "id", "name", "timeline" } ],
//     "omit": [ "hex hash" ], "live": false }
inline ImageResult compile_image(const json& request) {
    using namespace detail;
    static const json no_entries = json::object();
    ImageContext context;
    context.patches = request.contains("patches") ? &request.at("patches") : &no_entries;
    context.assets = request.contains("assets") ? &request.at("assets") : nullptr;
    const bool keep_unused = request.value("live", false);
    const json requested_frame = request.value("frame_size", json(SynthConfig{}.frame_size));
    const std::int64_t requested_size = requested_frame.is_number_integer() ? requested_frame.get<std::int64_t>() : 0;
    const u32 frame_size = static_cast<u32>(std::clamp<std::int64_t>(requested_size, 0, kMaxFrameSize + 1));
    if (!std::has_single_bit(frame_size) || frame_size < kMinFrameSize || frame_size > kMaxFrameSize) {
        throw CompileError("request", "frame_size must be a power of two from 8 to 1024");
    }

    json programs = json::array();
    const json& entries = request.at("programs");
    if (entries.empty()) throw CompileError("request", "an image needs at least one program");
    std::vector<u64> program_hashes;
    for (std::size_t i = 0; i < entries.size(); ++i) {
        json report = compile_program(context, entries[i], i, keep_unused);
        const u64 hash = std::stoull(report.at("hash").get<std::string>(), nullptr, 16);
        const auto found = std::find(program_hashes.begin(), program_hashes.end(), hash);
        report["index"] = found == program_hashes.end() ? program_hashes.size()
                                                        : static_cast<std::size_t>(found - program_hashes.begin());
        if (found == program_hashes.end()) program_hashes.push_back(hash);
        programs.push_back(std::move(report));
    }

    std::set<u64> omit;
    for (const json& h : request.value("omit", json::array())) {
        omit.insert(std::stoull(h.get<std::string>(), nullptr, 16));
    }

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
