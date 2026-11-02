// The engine for an AudioWorklet. Plain exports rather than embind, so the audio thread allocates no binding objects.
//
// Everything is static: memory growth stays off, so views of the heap taken once stay valid forever.

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <emscripten/emscripten.h>
#include <new>

#include <modsynth/Modsynth.hpp>

using namespace modsynth;

namespace {

template <u32 Frame>
constexpr SynthConfig kConfig{.frame_size = Frame, .channels = 2, .tap_slots = 8, .generations = 2};
template <u32 Frame>
using Engine = Synth<kConfig<Frame>>;

// An engine plays one frame size. Projects compile to the default, and frozen images declare the original.
constexpr u32 kDefaultFrame = SynthConfig{}.frame_size;
using DefaultEngine = Engine<kDefaultFrame>;
using OriginalEngine = Engine<kOriginalFrameSize>;

constexpr u32 kQuantum = 128;  // Web Audio's render quantum, which nothing here can change
constexpr std::size_t kFast = 24u << 20;
constexpr std::size_t kBulk = 32u << 20;
constexpr std::size_t kImage = 16u << 20;
constexpr u32 kImageSlots = 3;  // Live, fading, and the one being loaded

alignas(16) std::byte g_fast[kFast];
alignas(16) std::byte g_bulk[kBulk];
alignas(16) std::byte g_images[kImageSlots][kImage];
ChunkRef g_refs[kImageSlots][kMaxChunks];
ChunkTable g_tables[kImageSlots];
alignas(16) float g_out[2][kQuantum];
alignas(DefaultEngine) alignas(
    OriginalEngine) std::byte g_engine[std::max(sizeof(DefaultEngine), sizeof(OriginalEngine))];

// Exactly one of these is set, and both share g_engine.
DefaultEngine* g_default = nullptr;
OriginalEngine* g_original = nullptr;
float g_rate = 0.0f;
u32 g_live_slot = kImageSlots - 1;
u32 g_seen_generation = 0;
u32 g_earlier_generations = 0;  // From engines since replaced, so the count the worklet follows only ever rises
TapBlock g_tap;

template <class F>
auto with_engine(F&& f) {
    return g_default ? f(*g_default) : f(*g_original);
}

[[nodiscard]] u32 generation() {
    return g_earlier_generations + with_engine([](auto& synth) { return synth.generation(); });
}

// The slot after the live one cannot be in use: only the live image and the previous one can still be sounding.
[[nodiscard]] u32 next_slot() { return (g_live_slot + 1) % kImageSlots; }

void start_default() {
    g_original = nullptr;
    g_default = new (g_engine) DefaultEngine({std::span(g_fast), std::span(g_bulk), g_rate});
}

void start_original() {
    g_default = nullptr;
    g_original = new (g_engine) OriginalEngine({std::span(g_fast), std::span(g_bulk), g_rate});
}

// Nothing can cross between two engines, so this stops what is playing at once, with no fade. Taps and transport go
// with it, and a frame size neither engine has stays with the current one, which refuses the image and says why.
void match_frame_size(u32 frame) {
    const bool change = g_default ? frame == kOriginalFrameSize : frame == kDefaultFrame;
    if (!change) return;
    g_earlier_generations = generation();
    if (g_default) {
        start_original();
    } else {
        start_default();
    }
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE void ms_init(float rate) {
    for (u32 i = 0; i < kImageSlots; ++i) g_tables[i] = ChunkTable(g_refs[i]);
    g_rate = rate;
    start_default();
}

EMSCRIPTEN_KEEPALIVE std::uint32_t ms_image_capacity() { return kImage; }
EMSCRIPTEN_KEEPALIVE std::byte* ms_image_buffer() { return g_images[next_slot()]; }

// Returns 0 if a load is already running, in which case the worklet holds on to this request and retries.
EMSCRIPTEN_KEEPALIVE int ms_load(std::uint32_t size, std::uint32_t program) {
    if (size > kImage || with_engine([](auto& synth) { return synth.loading(); })) return 0;
    const u32 slot = next_slot();
    const ByteSpan image{g_images[slot], size};
    match_frame_size(image_frame_size(image));
    g_tables[slot].clear();
    with_engine([&](auto& synth) { synth.load(g_tables[slot], image, program); });
    return 1;
}

EMSCRIPTEN_KEEPALIVE int ms_loading() {
    return with_engine([](auto& synth) { return synth.loading(); });
}
EMSCRIPTEN_KEEPALIVE int ms_error() {
    return with_engine([](auto& synth) { return static_cast<int>(synth.load_error()); });
}
EMSCRIPTEN_KEEPALIVE float* ms_out(std::uint32_t channel) { return g_out[channel]; }

// One render quantum, however many frames that takes, so nothing above this has to know the frame size.
EMSCRIPTEN_KEEPALIVE void ms_render() {
    with_engine([](auto& synth) {
        for (u32 at = 0; at < kQuantum; at += synth.frame_size) synth.render({g_out[0] + at, g_out[1] + at});
    });
    if (const u32 now = generation(); now != g_seen_generation) {
        g_seen_generation = now;
        g_live_slot = next_slot();
    }
}

EMSCRIPTEN_KEEPALIVE int ms_send(std::uint32_t kind, std::uint32_t note, std::uint32_t velocity, std::uint32_t channel,
                                 std::uint32_t target, std::uint32_t param, float value, std::uint32_t tick,
                                 std::uint32_t tick_end) {
    if (kind > static_cast<u32>(EventKind::SetProbe)) return 0;
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
    return with_engine([&](auto& synth) { return synth.send(e); });
}

EMSCRIPTEN_KEEPALIVE std::uint32_t ms_tick() {
    return with_engine([](auto& synth) { return synth.tick(); });
}
EMSCRIPTEN_KEEPALIVE int ms_playing() {
    return with_engine([](auto& synth) { return synth.playing(); });
}
EMSCRIPTEN_KEEPALIVE std::uint32_t ms_generation() { return generation(); }
EMSCRIPTEN_KEEPALIVE std::uint32_t ms_voices() {
    return with_engine([](auto& synth) { return synth.active_voices(); });
}
EMSCRIPTEN_KEEPALIVE std::uint32_t ms_guard_trips() {
    return with_engine([](auto& synth) { return synth.guard_trips(); });
}

// A pointer to a finished block for this tap, or null. The details of that block are read with the calls below.
EMSCRIPTEN_KEEPALIVE const float* ms_tap_take(std::uint32_t slot) {
    return with_engine([&](auto& synth) { return synth.tap_take(slot, g_tap); }) ? g_tap.data : nullptr;
}
EMSCRIPTEN_KEEPALIVE std::uint32_t ms_tap_block_samples() {
    static_assert(DefaultEngine::tap_block == OriginalEngine::tap_block);  // The worklet sizes its pool once
    return DefaultEngine::tap_block;
}
EMSCRIPTEN_KEEPALIVE double ms_tap_start() { return static_cast<double>(g_tap.start_sample); }
EMSCRIPTEN_KEEPALIVE std::uint32_t ms_tap_dropped() { return g_tap.dropped; }
}
