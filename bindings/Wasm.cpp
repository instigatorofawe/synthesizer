// The engine for an AudioWorklet. Plain exports rather than embind, so the audio thread allocates no binding objects.
//
// Everything is static: memory growth stays off, so views of the heap taken once stay valid forever.

#include <cstddef>
#include <cstdint>
#include <emscripten/emscripten.h>
#include <new>

#include <modsynth/Modsynth.hpp>

using namespace modsynth;

namespace {

constexpr SynthConfig kConfig{.frame_size = 128, .channels = 2, .tap_slots = 8, .generations = 2};
using Engine = Synth<kConfig>;

constexpr std::size_t kFast = 24u << 20;
constexpr std::size_t kBulk = 32u << 20;
constexpr std::size_t kImage = 16u << 20;
constexpr u32 kImageSlots = 3;  // Live, fading, and the one being loaded

alignas(16) std::byte g_fast[kFast];
alignas(16) std::byte g_bulk[kBulk];
alignas(16) std::byte g_images[kImageSlots][kImage];
ChunkRef g_refs[kImageSlots][kMaxChunks];
ChunkTable g_tables[kImageSlots];
alignas(16) float g_out[2][Engine::frame_size];
alignas(Engine) std::byte g_engine[sizeof(Engine)];

Engine* g_synth = nullptr;
u32 g_live_slot = kImageSlots - 1;
u32 g_seen_generation = 0;
TapBlock g_tap;

// The slot after the live one cannot be in use: only the live image and the previous one can still be sounding.
[[nodiscard]] u32 next_slot() { return (g_live_slot + 1) % kImageSlots; }

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE void ms_init(float rate) {
    for (u32 i = 0; i < kImageSlots; ++i) g_tables[i] = ChunkTable(g_refs[i]);
    g_synth = new (g_engine) Engine({std::span(g_fast), std::span(g_bulk), rate});
}

EMSCRIPTEN_KEEPALIVE std::uint32_t ms_image_capacity() { return kImage; }
EMSCRIPTEN_KEEPALIVE std::byte* ms_image_buffer() { return g_images[next_slot()]; }

// Returns 0 if a load is already running, in which case the worklet holds on to this request and retries.
EMSCRIPTEN_KEEPALIVE int ms_load(std::uint32_t size, std::uint32_t program) {
    if (g_synth->loading() || size > kImage) return 0;
    const u32 slot = next_slot();
    g_tables[slot].clear();
    g_synth->load(g_tables[slot], {g_images[slot], size}, program);
    return 1;
}

EMSCRIPTEN_KEEPALIVE int ms_loading() { return g_synth->loading(); }
EMSCRIPTEN_KEEPALIVE int ms_error() { return static_cast<int>(g_synth->load_error()); }
EMSCRIPTEN_KEEPALIVE float* ms_out(std::uint32_t channel) { return g_out[channel]; }

EMSCRIPTEN_KEEPALIVE void ms_render() {
    g_synth->render({g_out[0], g_out[1]});
    if (const u32 generation = g_synth->generation(); generation != g_seen_generation) {
        g_seen_generation = generation;
        g_live_slot = next_slot();
    }
}

EMSCRIPTEN_KEEPALIVE int ms_send(std::uint32_t kind, std::uint32_t note, std::uint32_t velocity, std::uint32_t channel,
                                 std::uint32_t target, std::uint32_t param, float value, std::uint32_t tick,
                                 std::uint32_t tick_end) {
    if (kind > static_cast<u32>(EventKind::SetLoop)) return 0;
    Event e;
    e.kind = static_cast<EventKind>(kind);
    e.note = static_cast<u8>(note);
    e.velocity = static_cast<u8>(velocity);
    e.channel = static_cast<u8>(channel);
    e.target = static_cast<u16>(target);
    e.param = static_cast<u16>(param);
    e.value = value;
    e.tick = tick;
    e.tick_end = tick_end;
    return g_synth->send(e);
}

EMSCRIPTEN_KEEPALIVE std::uint32_t ms_tick() { return g_synth->tick(); }
EMSCRIPTEN_KEEPALIVE int ms_playing() { return g_synth->playing(); }
EMSCRIPTEN_KEEPALIVE std::uint32_t ms_generation() { return g_synth->generation(); }
EMSCRIPTEN_KEEPALIVE std::uint32_t ms_voices() { return g_synth->active_voices(); }
EMSCRIPTEN_KEEPALIVE std::uint32_t ms_guard_trips() { return g_synth->guard_trips(); }

// A pointer to a finished block for this tap, or null. The details of that block are read with the calls below.
EMSCRIPTEN_KEEPALIVE const float* ms_tap_take(std::uint32_t slot) {
    return g_synth->tap_take(slot, g_tap) ? g_tap.data : nullptr;
}
EMSCRIPTEN_KEEPALIVE std::uint32_t ms_tap_block_samples() { return Engine::tap_block; }
EMSCRIPTEN_KEEPALIVE double ms_tap_start() { return static_cast<double>(g_tap.start_sample); }
EMSCRIPTEN_KEEPALIVE std::uint32_t ms_tap_dropped() { return g_tap.dropped; }
}
