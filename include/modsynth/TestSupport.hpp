#pragma once

#include <DemoJson.hpp>
#include <cstddef>
#include <deque>
#include <memory>
#include <random>
#include <string>
#include <vector>

#include <modsynth/Compiler.hpp>
#include <modsynth/Modsynth.hpp>

namespace modsynth_test {

using namespace modsynth;
using compiler::json;

// One thread, a random valid order each frame. Finds an undeclared dependency with no threads at all.
struct ShuffledExecutor {
    static constexpr u32 max_workers = 1;
    static constexpr bool uses_edges = true;
    using Plan = Schedule;
    std::mt19937 rng{1234};

    template <class F>
    void run(const Schedule& s, F&& f) {
        std::vector<u32> ready;
        std::vector<u32> pending(s.deps, s.deps + s.count);
        for (u32 t = 0; t < s.count; ++t) {
            if (pending[t] == 0) ready.push_back(t);
        }
        while (!ready.empty()) {
            const std::size_t i = rng() % ready.size();
            const u32 t = ready[i];
            ready[i] = ready.back();
            ready.pop_back();
            f(t, 0u);
            for (u32 e = s.succ_begin[t]; e < s.succ_begin[t + 1]; ++e) {
                if (--pending[s.succ[e]] == 0) ready.push_back(s.succ[e]);
            }
        }
    }
};

inline constexpr SynthConfig kStereo{.frame_size = 128, .channels = 2, .tap_slots = 2, .generations = 2};
inline constexpr SynthConfig kMono{.frame_size = 128, .channels = 1, .tap_slots = 0, .generations = 1};
inline constexpr float kRate = 48000.0f;

inline json demo() { return json::parse(demo_json); }

// A loaded engine and everything it borrows, heap-allocated so its address is stable.
template <SynthConfig C, class E = SerialExecutor>
struct Rig {
    using Engine = Synth<C, ScalarBackend, E>;

    explicit Rig(std::vector<std::byte> bytes, u32 program = 0, std::byte fill = std::byte{0xCD},
                 std::size_t fast_size = 8 << 20, std::size_t bulk_size = 8 << 20)
        : image(aligned(bytes)),
          fast(fast_size, fill),
          bulk(bulk_size, fill),
          storage(kMaxChunks),
          chunks(storage),
          engine(typename Engine::Memory{fast, bulk, kRate}) {
        engine.load(chunks, {data(), bytes.size()}, program);
        while (engine.pump(1 << 16)) {
        }
    }

    [[nodiscard]] const std::byte* data() const { return reinterpret_cast<const std::byte*>(image.data()); }

    static std::vector<u64> aligned(const std::vector<std::byte>& bytes) {
        std::vector<u64> words((bytes.size() + 7) / 8);
        if (!bytes.empty()) std::memcpy(words.data(), bytes.data(), bytes.size());
        return words;
    }

    // Swaps to another image. Each stays alive for the whole test, as a generation may still be fading on one.
    void swap_to(const std::vector<std::byte>& bytes, u32 program = 0) {
        auto& next = swaps.emplace_back();
        next.image = aligned(bytes);
        next.storage.resize(kMaxChunks);
        next.chunks = ChunkTable(next.storage);
        engine.load(next.chunks, {reinterpret_cast<const std::byte*>(next.image.data()), bytes.size()}, program);
    }

    std::vector<u64> image;
    std::vector<std::byte> fast, bulk;
    std::vector<ChunkRef> storage;
    ChunkTable chunks;
    Engine engine;

    struct Swap {
        std::vector<u64> image;
        std::vector<ChunkRef> storage;
        ChunkTable chunks;
    };
    std::deque<Swap> swaps;
};

// Validates an image into a table, for tests that need its hashes.
struct LoadedImage {
    explicit LoadedImage(const std::vector<std::byte>& bytes)
        : words((bytes.size() + 7) / 8), storage(kMaxChunks), table(storage), loader(table) {
        std::memcpy(words.data(), bytes.data(), bytes.size());
        loader.begin({reinterpret_cast<const std::byte*>(words.data()), bytes.size()});
        while (loader.step(1 << 20) == LoadStatus::Working) {
        }
    }
    std::vector<u64> words;
    std::vector<ChunkRef> storage;
    ChunkTable table;
    Loader loader;
};

template <class R>
std::vector<float> render_stereo(R& rig, u32 frames) {
    std::vector<float> out(frames * 128 * 2);
    for (u32 f = 0; f < frames; ++f) {
        float* left = out.data() + f * 256;
        rig.engine.render({left, left + 128});
    }
    return out;
}

inline std::vector<std::byte> compile_demo() {
    json request = demo();
    return compiler::compile_image(request).image;
}

// Patches and Programs written field by field, so a test can state exactly what a hostile image contains.
struct HandPatch {
    PatchHeader header{};
    std::vector<ParamDesc> params;
    std::vector<u64> refs;
    std::vector<float> consts;
    std::vector<float> delays;
    std::vector<u16> in_ports;
    std::vector<WireStep> control;
    std::vector<WireStep> voice;

    [[nodiscard]] compiler::Chunk chunk() const {
        PatchHeader h = header;
        h.control_steps = static_cast<u16>(control.size());
        h.voice_steps = static_cast<u16>(voice.size());
        h.params = static_cast<u16>(params.size());
        h.refs = static_cast<u16>(refs.size());
        h.consts = static_cast<u16>(consts.size());
        h.delays = static_cast<u16>(delays.size());
        h.inputs = static_cast<u16>(in_ports.size() / 2);
        compiler::detail::Writer w;
        w.put(h);
        w.put_all(params);
        w.put_all(refs);
        w.align(4);
        w.put_all(consts);
        w.put_all(delays);
        w.put_all(in_ports);
        w.align(4);
        w.put_all(control);
        w.put_all(voice);
        return compiler::detail::make_chunk(ChunkKind::Patch, std::move(w.bytes));
    }
};

struct HandProgram {
    ProgramHeader header{};
    std::vector<u64> patches;
    std::vector<TrackDesc> tracks;
    std::vector<u16> slots;
    std::vector<ClipDesc> clips;
    std::vector<InsertDesc> inserts;
    std::vector<MixStep> mix;
    std::vector<GatherInput> gather;
    std::vector<float> mix_init;
    std::vector<GlobalDesc> globals;
    std::vector<ParamInit> inits;
    std::vector<Instruction> code;

    [[nodiscard]] compiler::Chunk chunk() const {
        ProgramHeader h = header;
        h.patches = static_cast<u16>(patches.size());
        h.tracks = static_cast<u16>(tracks.size());
        h.slots = static_cast<u16>(slots.size());
        h.clips = static_cast<u16>(clips.size());
        h.inserts = static_cast<u16>(inserts.size());
        h.mix_steps = static_cast<u16>(mix.size());
        h.gather_inputs = static_cast<u16>(gather.size());
        h.mix_regs = static_cast<u16>(mix_init.size());
        h.globals = static_cast<u16>(globals.size());
        h.inits = static_cast<u16>(inits.size());
        h.code = static_cast<u32>(code.size());
        compiler::detail::Writer w;
        w.put(h);
        w.put_all(patches);
        w.put_all(tracks);
        w.put_all(slots);
        w.align(4);
        w.put_all(clips);
        w.put_all(inserts);
        w.put_all(mix);
        w.put_all(gather);
        w.align(4);
        w.put_all(mix_init);
        w.put_all(globals);
        w.put_all(inits);
        w.align(4);
        w.put_all(code);
        return compiler::detail::make_chunk(ChunkKind::Program, std::move(w.bytes));
    }
};

// Fills buffer 0 with a constant, which is the least a patch can do.
inline HandPatch minimal_patch() {
    HandPatch p;
    p.header.buffers = 1;
    p.header.voice_scalars = kBuiltinVoiceScalars;
    p.header.out_left = p.header.out_right = operand(Bank::Buffer, 0);
    p.consts = {0.5f};
    WireStep fill{};
    fill.op = static_cast<u8>(Op::Fill);
    fill.out[0] = operand(Bank::Buffer, 0);
    fill.in[0] = operand(Bank::Const, 0);
    p.voice = {fill};
    return p;
}

// One track of one voice playing `patch`, straight to the master, with empty streams.
inline HandProgram minimal_program(u64 patch) {
    HandProgram p;
    p.header.ppq = 480;
    p.header.uspq = 500000;
    p.header.conductor_begin = 1;
    p.header.conductor_length = 1;
    p.header.buses = 1;
    p.header.master = 0;
    p.patches = {patch};
    p.tracks = {TrackDesc{1, 1, 0, 1, 0, 1}};
    p.slots = {0};
    p.mix = {MixStep{static_cast<u8>(MixOp::RunVoices), 0, 0, 0, 0, 0, kNone}};
    p.code = {Instruction{static_cast<u8>(Instr::End), 0, 0, 0}, Instruction{static_cast<u8>(Instr::End), 0, 0, 0}};
    return p;
}

// Every chunk of an image but its manifest, so a test can change one and assemble() can restore the sorted order.
inline std::vector<compiler::Chunk> disassemble(const std::vector<std::byte>& image) {
    std::vector<compiler::Chunk> chunks;
    for (std::size_t at = 0; at + sizeof(ChunkHeader) <= image.size();) {
        const ChunkHeader h = load<ChunkHeader>(image.data() + at);
        const std::byte* body = image.data() + at + sizeof(ChunkHeader);
        if (h.kind != static_cast<u8>(ChunkKind::Manifest)) {
            chunks.push_back({static_cast<ChunkKind>(h.kind), {body, body + h.size}, h.hash});
        }
        at += sizeof(ChunkHeader) + (h.size + kChunkAlign - 1) / kChunkAlign * kChunkAlign;
    }
    return chunks;
}

// The chunks in the order the format wants: assets, tables and patches by hash, then Programs as given.
inline std::vector<std::byte> assemble(const std::vector<compiler::Chunk>& chunks) {
    std::vector<const compiler::Chunk*> ordered;
    for (const compiler::Chunk& c : chunks) ordered.push_back(&c);
    std::stable_sort(ordered.begin(), ordered.end(), [](const compiler::Chunk* a, const compiler::Chunk* b) {
        if (a->kind != b->kind) return a->kind < b->kind;
        return a->kind != ChunkKind::Program && a->hash < b->hash;
    });
    return compiler::detail::write_image(ordered, {});
}

}  // namespace modsynth_test
