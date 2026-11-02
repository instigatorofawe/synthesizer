// Counts instructions on a Cortex-M4: every case in bench/KernelCases.hpp, then every recipe linked in, frame by frame.
// On QEMU's mps2-an386 with -icount, SysTick follows instructions, so the counts are exact and repeat from run to run.
// They say nothing about wait states or real time, which need a board. tools/Bench.py builds and runs this.

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>

#include <modsynth/Modsynth.hpp>
#ifdef MODSYNTH_CMSIS
#include <modsynth/CmsisBackend.hpp>
#endif

#include "KernelCases.hpp"

using namespace modsynth;
using namespace modsynth_bench;

#ifdef MODSYNTH_CMSIS
using Dsp = CmsisBackend;
#else
using Dsp = ScalarBackend;
#endif

namespace {

constexpr SynthConfig kConfig{.frame_size = 32, .channels = MODSYNTH_CHANNELS, .tap_slots = 0, .generations = 1};
constexpr float kRate = 48000.0f;
constexpr u32 kKernelFrames = 256;
using Engine = Synth<kConfig, Dsp>;

ChunkRef g_sizing[64], g_chunks[64];
alignas(16) float g_out[kConfig.channels][kConfig.frame_size];
alignas(Engine) std::byte g_engine[sizeof(Engine)];
std::uint32_t g_ticks[1 << 15];  // Per frame, as many as the longest recipe has
KernelRig<kConfig, Dsp> g_rig;

int semihost(int op, const void* argument) {
    register int r0 __asm("r0") = op;
    register const void* r1 __asm("r1") = argument;
    __asm volatile("bkpt 0xAB" : "+r"(r0) : "r"(r1) : "memory");
    return r0;
}

void print(const char* text) { semihost(0x04, text); }

void print_number(u64 value) {
    char digits[21];
    int at = 20;
    digits[at] = 0;
    do {
        digits[--at] = static_cast<char>('0' + value % 10);
        value /= 10;
    } while (value != 0);
    print(digits + at);
}

void print_row(const char* kind, const char* name, std::initializer_list<u64> values) {
    print(kind);
    print(",");
    print(name);
    for (const u64 value : values) {
        print(",");
        print_number(value);
    }
    print("\n");
}

[[noreturn]] void finish(bool ok) {
    const std::uintptr_t reason = ok ? 0x20026 : 0x20023;
    semihost(0x18, reinterpret_cast<const void*>(reason));
    for (;;) {
    }
}

volatile std::uint32_t* const kSysTickControl = reinterpret_cast<std::uint32_t*>(0xE000E010);
volatile std::uint32_t* const kSysTickReload = reinterpret_cast<std::uint32_t*>(0xE000E014);
volatile std::uint32_t* const kSysTickValue = reinterpret_cast<std::uint32_t*>(0xE000E018);
constexpr std::uint32_t kSysTickMask = 0xFFFFFF;

std::uint32_t ticks() { return *kSysTickValue; }
std::uint32_t since(std::uint32_t from) { return (from - ticks()) & kSysTickMask; }

// This machine's SysTick doesn't tick once an instruction, so a loop of known length says how many it does.
u64 g_calibration_ticks = 1, g_calibration_instructions = 1;

void calibrate() {
    constexpr std::uint32_t kLoops = 100000;
    std::uint32_t left = kLoops;
    const std::uint32_t from = ticks();
    __asm volatile("1: subs %0, #1\n bne 1b\n" : "+r"(left) : : "cc");
    g_calibration_ticks = since(from);
    g_calibration_instructions = 2 * kLoops;
}

u64 instructions(u64 elapsed) { return elapsed * g_calibration_instructions / g_calibration_ticks; }

struct Recipe {
    const char* name;
    const std::byte* begin;
    const std::byte* end;
    u32 frames;
};

}  // namespace

#define MODSYNTH_LINK_IMAGE(name, path)  \
    __asm(                               \
        ".section .rodata.image,\"a\"\n" \
        ".balign 8\n"                    \
        ".global " #name "\n" #name      \
        ":\n"                            \
        ".incbin \"" path                \
        "\"\n"                           \
        ".global " #name "_end\n" #name  \
        "_end:\n"                        \
        ".text\n");                      \
    extern const std::byte name[];       \
    extern const std::byte name##_end[];

#include MODSYNTH_BENCH_RECIPES

extern std::byte __arena_start[], __arena_end[];

namespace {

void measure_kernels() {
    float keep = 0.0f;
    for (const KernelCase& k : kKernelCases) {
        g_rig.begin(k);
        const std::uint32_t from = ticks();
        for (u32 f = 0; f < kKernelFrames; ++f) g_rig.frame();
        const std::uint32_t elapsed = since(from);
        keep += g_rig.result();
        print_row("kernel", k.name, {instructions(u64{elapsed} * 100) / kKernelFrames});  // Hundredths, per frame
    }
    if (keep != keep) print("a kernel made a NaN\n");  // Reading the results is what keeps GCC from deleting the work
}

bool measure(const Recipe& r) {
    const ByteSpan image{r.begin, static_cast<std::size_t>(r.end - r.begin)};
    ChunkTable sizing{std::span(g_sizing)};
    Loader loader(sizing);
    loader.begin(image, kConfig.frame_size);
    while (loader.step(1u << 16) == LoadStatus::Working) {
    }
    if (loader.status() != LoadStatus::Ready) {
        print_row("refused", r.name, {});
        return false;
    }
    const MemorySizes need = Engine::bytes_required(sizing, loader.program_hash(0), kRate);

    const std::size_t half = static_cast<std::size_t>(__arena_end - __arena_start) / 2;
    ChunkTable chunks{std::span(g_chunks)};
    auto* engine = new (g_engine) Engine({{__arena_start, half}, {__arena_start + half, half}, kRate});
    u64 load = 0;
    engine->load(chunks, image, 0);
    for (bool busy = true; busy;) {
        const std::uint32_t from = ticks();
        busy = engine->pump(4096);
        load += since(from);
    }
    if (engine->load_error() != LoadError::None) {
        print_row("refused", r.name, {});
        return false;
    }
    engine->send({.kind = EventKind::Play});

    std::array<float*, kConfig.channels> outputs;
    for (u32 c = 0; c < kConfig.channels; ++c) outputs[c] = g_out[c];
    u64 total = 0;
    u32 voices = 0;
    for (u32 f = 0; f < r.frames; ++f) {
        const std::uint32_t from = ticks();
        engine->render(outputs);
        g_ticks[f] = since(from);
        total += g_ticks[f];
        voices = std::max(voices, engine->active_voices());
    }
    const u64 peak = *std::max_element(g_ticks, g_ticks + r.frames);
    auto* const rank = g_ticks + r.frames * 999 / 1000;
    std::nth_element(g_ticks, rank, g_ticks + r.frames);
    const u64 per_sample = u64{r.frames} * kConfig.frame_size;
    print_row("recipe", r.name,
              {static_cast<u64>(r.end - r.begin), need.fast, need.bulk, voices, r.frames,
               instructions(total * 100) / per_sample, instructions(u64{*rank} * 100) / kConfig.frame_size,
               instructions(peak * 100) / kConfig.frame_size, instructions(load), engine->guard_trips()});
    return true;
}

}  // namespace

int main() {
    *kSysTickReload = kSysTickMask;
    *kSysTickValue = 0;
    *kSysTickControl = 5;
    calibrate();
    print_row("engine", "bytes", {sizeof(Engine)});
    measure_kernels();
    bool ok = true;
    for (const Recipe& r : kRecipes) ok = measure(r) && ok;
    finish(ok);
}

extern "C" {
extern std::uint32_t __bss_start, __bss_end, __stack_top;

[[noreturn]] void reset() {
    volatile auto* const cpacr = reinterpret_cast<std::uint32_t*>(0xE000ED88);
    *cpacr = *cpacr | (0xFu << 20);
    __asm volatile("dsb\nisb");
    for (std::uint32_t* to = &__bss_start; to < &__bss_end;) *to++ = 0;
    main();
    finish(false);
}

[[noreturn]] void fault() {
    print("fault\n");
    finish(false);
}

[[gnu::section(".vectors"), gnu::used]] const void* const g_vectors[16] = {
    &__stack_top,
    reinterpret_cast<const void*>(&reset),
    reinterpret_cast<const void*>(&fault),
    reinterpret_cast<const void*>(&fault),
    reinterpret_cast<const void*>(&fault),
    reinterpret_cast<const void*>(&fault),
    reinterpret_cast<const void*>(&fault),
};
}
