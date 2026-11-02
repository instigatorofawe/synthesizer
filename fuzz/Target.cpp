// The code under test, and the oracles that decide whether it behaved. Reaching this file means the mutator produced an
// input. A crash is one finding, but each oracle below catches something that would otherwise pass in silence.

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <limits>
#include <new>
#include <type_traits>

#include <modsynth/Modsynth.hpp>
#include <modsynth/ShuffledExecutor.hpp>

#include "Rng.hpp"
#include "Target.hpp"

namespace modsynth::fuzz {
namespace {

template <u32 Frame>
constexpr SynthConfig kStereo{.frame_size = Frame, .channels = 2, .tap_slots = 2, .generations = 2};
template <u32 Frame>
constexpr SynthConfig kMono{.frame_size = Frame, .channels = 1, .tap_slots = 0, .generations = 1};
constexpr u64 kMemoryLimit = 12u << 20;  // A Program over this is refused here, not by the engine
constexpr u32 kFrameLimit = 256;
constexpr u32 kPrograms = 2;  // Per image, to keep an execution short
constexpr float kRates[] = {1000.0f, 2000.0f, 2000.0f, 8000.0f, 48000.0f, 192000.0f};

struct Loaded {
    std::array<ChunkRef, kMaxChunks> storage;
    ChunkTable table;
    u32 programs = 0;
};

// Whatever a host could send, with wild values mixed in, because events are a trust boundary of their own.
template <class Engine>
void send_event(Engine& engine, Rng& r, const ProgramHeader& h) {
    const auto wild_float = [&] {
        switch (r.below(8)) {
            case 0:
                return std::numeric_limits<float>::quiet_NaN();
            case 1:
                return std::numeric_limits<float>::infinity();
            case 2:
                return 1e30f;
            case 3:
                return 1e-44f;
            default:
                return static_cast<float>(r.below(2000)) * 0.01f - 10.0f;
        }
    };
    const auto wild_tick = [&] { return r.chance(10) ? r.next() : r.below(std::max<u32>(h.length_ticks, 1) + 2); };
    Event e;
    e.kind = static_cast<EventKind>(r.below(11));
    e.note = static_cast<u8>(r.below(r.chance(90) ? 128 : 256));
    e.velocity = static_cast<u8>(r.below(128));
    e.channel = static_cast<u8>(r.below(3));
    e.target = static_cast<u16>(r.below(std::max<u32>(h.tracks, h.mix_steps) + 2));
    e.param = static_cast<u16>(r.below(16));
    e.value = wild_float();
    e.tick = wild_tick();
    e.tick_end = r.chance(30) ? 0 : e.tick + 1 + r.below(1024);
    if (e.kind == EventKind::Stop && r.chance(80)) e.kind = EventKind::NoteOn;  // A stopped Program covers little
    (void)engine.send(e);
}

// What a Program's delay lines take, counted here in 64 bits and apart from the engine's own sum. A total that wrapped
// at 4 GB lands somewhere arbitrary, and would usually still be refused as too large, so comparing the two catches a
// wrap wherever it lands, rather than only when it lands somewhere small enough to run.
[[nodiscard]] u64 delay_line_bytes(const ChunkTable& table, const ProgramView& p, float rate, u32 frame) {
    const auto floats_for = [&](u32 patch) {
        const ChunkRef* c = table.find(p.patch(patch), ChunkKind::Patch);
        PatchView v;
        if (!c || !parse_patch({c->data, c->size}, v)) fail("a validated patch no longer parses");
        u64 floats = 0;
        for (u32 i = 0; i < v.h.delays; ++i) floats += static_cast<u64>(v.delay(i) * rate) + frame + 4;
        return floats;
    };
    u64 total = 0;
    for (u32 t = 0; t < p.h.tracks; ++t) {
        const TrackDesc d = p.track(t);
        u64 largest = 0;
        for (u32 s = 0; s < d.slot_count; ++s) largest = std::max(largest, floats_for(p.slot(d.slot_begin + s)));
        total += largest * d.voices;
    }
    for (u32 i = 0; i < p.h.inserts; ++i) total += floats_for(p.insert(i).patch);
    return total * sizeof(float);
}

// Plays one Program from the start to its end, or to the frame limit. Returns a hash of every output sample, so two
// runs can be compared bit for bit.
template <SynthConfig C, class E>
u64 play(ChunkTable& table, u64 program, ChunkTable* from, u64 from_program, float rate, std::byte fill, u32 seed,
         bool tight, Stats& stats, bool& refused) {
    using Engine = Synth<C, ScalarBackend, E>;
    const std::size_t mark = memory_mark();
    const ChunkRef* c = table.find(program, ChunkKind::Program);
    ProgramView view;
    if (!c || !parse_program({c->data, c->size}, view)) fail("a validated Program no longer parses");

    MemorySizes need = Engine::bytes_required(table, program, rate);
    if (need.bulk < delay_line_bytes(table, view, rate, C.frame_size))
        fail("bytes_required() is short of the delay lines");
    if (from) {
        const MemorySizes old = Engine::bytes_required(*from, from_program, rate);
        need = {std::max(need.fast, old.fast), std::max(need.bulk, old.bulk)};
    }
    const u64 fast_size = need.fast * C.generations + Engine::tap_bytes();
    const u64 bulk_size = need.bulk * C.generations;
    if (fast_size + bulk_size > kMemoryLimit) {
        refused = true;
        return 0;
    }

    // Exactly what bytes_required() said, so one byte too few in that sum is caught where it is used. The tight run
    // gives a little less, which must be refused rather than overrun.
    const std::size_t short_by = tight ? 16 : 0;
    const std::size_t fast_bytes = static_cast<std::size_t>(fast_size) - std::min<std::size_t>(fast_size, short_by);
    std::byte* const fast = take_memory(fast_bytes);
    std::byte* const bulk = take_memory(static_cast<std::size_t>(bulk_size));
    std::memset(fast, static_cast<int>(fill), fast_bytes);
    std::memset(bulk, static_cast<int>(fill), static_cast<std::size_t>(bulk_size));

    E executor{};
    if constexpr (std::is_same_v<E, ShuffledExecutor>) executor.state = seed | 1;
    auto* engine = new (take_memory(sizeof(Engine))) Engine(
        typename Engine::Memory{{fast, fast_bytes}, {bulk, static_cast<std::size_t>(bulk_size)}, rate}, executor);

    Rng r(seed);
    std::array<std::array<float, C.frame_size>, C.channels> out;
    std::array<float*, C.channels> outputs;
    for (u32 ch = 0; ch < C.channels; ++ch) outputs[ch] = out[ch].data();

    u64 hash = kHashSeed;
    const auto render = [&] {
        engine->render(outputs);
        for (u32 ch = 0; ch < C.channels; ++ch) {
            for (const float x : out[ch]) {
                if (!std::isfinite(x)) fail("the engine gave a host a non-finite sample");
            }
            hash = hash_bytes(hash, reinterpret_cast<const std::byte*>(out[ch].data()), sizeof(out[ch]));
        }
        ++stats.frames;
    };
    const auto settle = [&] {
        for (u32 i = 0; i < 4096 && engine->loading(); ++i) {
            (void)engine->pump(1 + r.below(1u << 14));
            if (r.chance(5)) render();
        }
        if (engine->loading()) fail("a bind never finished");
    };

    // A swap: start on the intact image, with notes held, and let the mutated one take over and carry state across.
    if (from) {
        engine->bind(*from, from_program);
        settle();
        if (engine->load_error() != LoadError::None) fail("the intact image did not bind");
        (void)engine->send({.kind = EventKind::Play});
        for (u32 i = 0; i < 8; ++i) {
            if (r.chance(50)) send_event(*engine, r, view.h);
            render();
        }
    }

    const u32 before = engine->generation();
    engine->bind(table, program);
    settle();
    if (tight) {
        if (engine->load_error() != LoadError::OutOfMemory)
            fail("a Program ran on less than bytes_required() asked for");
        rewind_memory(mark);
        return 0;
    }
    if (engine->load_error() != LoadError::None) fail("a validated Program did not bind");
    if (C.generations > 1) {
        render();  // A swap commits at the next frame boundary
        render();
    }
    if (engine->generation() == before) fail("a bound Program never went live");
    if (from) ++stats.swaps;

    (void)engine->send({.kind = EventKind::Play});
    u32 tail = 0;
    bool finished = false;
    for (u32 frame = 0; frame < kFrameLimit; ++frame) {
        if (r.chance(15)) send_event(*engine, r, view.h);
        render();
        if (engine->tick() >= view.h.length_ticks && engine->active_voices() == 0 && ++tail >= 2) {
            finished = true;
            break;
        }
    }
    stats.finished += finished;
    stats.guard_trips += engine->guard_trips();
    rewind_memory(mark);
    return hash;
}

// Every oracle, for one frame size. An engine refuses any other size, so the image chooses which of these it reaches.
template <u32 Frame>
void check_programs(ChunkTable& table, const Loader& loader, ChunkTable& intact, const Loader& base, Rng& r,
                    Stats& stats) {
    const u32 programs = std::min(loader.programs(), kPrograms);
    for (u32 p = 0; p < programs; ++p) {
        const u64 program = loader.program_hash(p);
        const float rate = kRates[r.below(std::size(kRates))];
        const u32 script = r.next();
        const bool swap = r.chance(50) && base.frame_size() == Frame;  // An engine plays one size
        ChunkTable* from = swap ? &intact : nullptr;
        const u64 from_program = swap ? base.program_hash(0) : 0;
        bool refused = false;

        // Two different fills of memory, so anything read before it was written changes the output.
        const u64 first = play<kStereo<Frame>, SerialExecutor>(table, program, from, from_program, rate,
                                                               std::byte{0x00}, script, false, stats, refused);
        if (refused) {
            ++stats.refused_memory;
            continue;
        }
        const u64 second = play<kStereo<Frame>, SerialExecutor>(table, program, from, from_program, rate,
                                                                std::byte{0xFF}, script, false, stats, refused);
        if (first != second) fail("a Program's output depends on old memory");

        // Any order the Plan allows must give identical bits, which is what section 18's rules exist to guarantee.
        const u64 shuffled = play<kStereo<Frame>, ShuffledExecutor>(table, program, from, from_program, rate,
                                                                    std::byte{0x5A}, script, false, stats, refused);
        if (first != shuffled) fail("a Program's output depends on task order");

        // A mono build folds everything differently, so it goes through its own code. Then too little memory.
        (void)play<kMono<Frame>, SerialExecutor>(table, program, nullptr, 0, rate, std::byte{0xCD}, script, false,
                                                 stats, refused);
        (void)play<kMono<Frame>, SerialExecutor>(table, program, nullptr, 0, rate, std::byte{0xCD}, script, true, stats,
                                                 refused);
        ++stats.programs;
    }
}

}  // namespace

void run_target(ByteSpan image, ByteSpan base, u32 seed, Stats& stats) {
    ++stats.execs;
    reset_memory();
    Rng r(seed);

    // The image sits at the very end of its allocation, so a read past it is caught.
    std::byte* const copy = take_memory(image.size());
    if (!image.empty()) std::memcpy(copy, image.data(), image.size());

    auto* loaded = new (take_memory(sizeof(Loaded))) Loaded{};
    loaded->table = ChunkTable(std::span(loaded->storage));
    Loader loader(loaded->table);
    loader.begin({copy, image.size()});
    while (loader.step(r.chance(50) ? 1 + r.below(64) : 1 + r.below(1u << 16)) == LoadStatus::Working) {
    }
    ++stats.load_errors[static_cast<u32>(loader.error())];
    if (loader.status() != LoadStatus::Ready) {
        if (loaded->table.size() != 0) fail("a refused image left chunks behind");
        return;
    }

    auto* intact = new (take_memory(sizeof(Loaded))) Loaded{};
    intact->table = ChunkTable(std::span(intact->storage));
    Loader base_loader(intact->table);
    std::byte* const base_copy = take_memory(base.size());
    std::memcpy(base_copy, base.data(), base.size());
    base_loader.begin({base_copy, base.size()});
    while (base_loader.step(1u << 20) == LoadStatus::Working) {
    }
    if (base_loader.status() != LoadStatus::Ready) fail("the intact image did not load");

    switch (loader.frame_size()) {
        case 32:
            check_programs<32>(loaded->table, loader, intact->table, base_loader, r, stats);
            break;
        case 128:
            check_programs<128>(loaded->table, loader, intact->table, base_loader, r, stats);
            break;
        default:
            ++stats.other_frames;  // A legal size, but no engine here was built for it
    }
}

}  // namespace modsynth::fuzz
