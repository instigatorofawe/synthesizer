// Renders a linked image and writes the audio to a host file over semihosting, so it can be compared with the desktop.
// It runs on QEMU's b-l475e-iot01a. Real audio output belongs to Milestone 5.

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>

#include <modsynth/Modsynth.hpp>
#ifdef MODSYNTH_CMSIS
#include <modsynth/CmsisBackend.hpp>
#endif

using namespace modsynth;

#ifdef MODSYNTH_CMSIS
using Dsp = CmsisBackend;
#else
using Dsp = ScalarBackend;
#endif

namespace {

constexpr SynthConfig kConfig{.frame_size = 128, .channels = MODSYNTH_CHANNELS, .tap_slots = 0, .generations = 1};
using Engine = Synth<kConfig, Dsp>;

constexpr u32 kFrames = 1400;  // About three seconds

[[gnu::section(".sram2")]] alignas(16) std::byte g_fast[28 * 1024];
alignas(16) std::byte g_bulk[60 * 1024];
ChunkRef g_refs[32];
alignas(16) float g_out[MODSYNTH_CHANNELS][Engine::frame_size];
alignas(Engine) std::byte g_engine[sizeof(Engine)];

int semihost(int op, const void* argument) {
    register int r0 __asm("r0") = op;
    register const void* r1 __asm("r1") = argument;
    __asm volatile("bkpt 0xAB" : "+r"(r0) : "r"(r1) : "memory");
    return r0;
}

void print(const char* text) { semihost(0x04, text); }

void print_number(u32 value) {
    char digits[11];
    int at = 10;
    digits[at] = 0;
    do {
        digits[--at] = static_cast<char>('0' + value % 10);
        value /= 10;
    } while (value != 0);
    print(digits + at);
}

[[noreturn]] void finish(bool ok) {
    const std::uintptr_t reason = ok ? 0x20026 : 0x20023;  // ApplicationExit, or RunTimeErrorUnknown
    semihost(0x18, reinterpret_cast<const void*>(reason));
    for (;;) {
    }
}

int open_output(const char* path) {
    const std::uintptr_t arguments[3] = {reinterpret_cast<std::uintptr_t>(path), 5 /* wb */, std::strlen(path)};
    return semihost(0x01, arguments);
}

void write_output(int file, const void* data, std::size_t size) {
    const std::uintptr_t arguments[3] = {static_cast<std::uintptr_t>(file), reinterpret_cast<std::uintptr_t>(data),
                                         size};
    semihost(0x05, arguments);
}

}  // namespace

// Linked into flash, so it is validated and used in place.
__asm(
    ".section .rodata.image,\"a\"\n"
    ".balign 8\n"
    ".global g_image\n"
    "g_image:\n"
    ".incbin \"" MODSYNTH_IMAGE_PATH
    "\"\n"
    ".global g_image_end\n"
    "g_image_end:\n"
    ".text\n");
extern const std::byte g_image[];
extern const std::byte g_image_end[];

int main() {
    ChunkTable table{std::span(g_refs)};
    auto* engine = new (g_engine) Engine({std::span(g_fast), std::span(g_bulk), 48000.0f});
    engine->load(table, {g_image, static_cast<std::size_t>(g_image_end - g_image)}, 0);
    while (engine->pump(4096)) {
    }
    if (engine->load_error() != LoadError::None) {
        print("load failed: ");
        print(to_string(engine->load_error()));
        print("\n");
        finish(false);
    }

    print("flash image ");
    print_number(static_cast<u32>(g_image_end - g_image));
    print(" bytes, fast ");
    print_number(sizeof(g_fast));
    print(", bulk ");
    print_number(sizeof(g_bulk));
    print("\n");

    const int file = open_output(MODSYNTH_OUTPUT);
    if (file < 0) finish(false);

    engine->send({.kind = EventKind::Play});
    std::array<float*, kConfig.channels> outputs;
    for (u32 channel = 0; channel < kConfig.channels; ++channel) outputs[channel] = g_out[channel];
    for (u32 f = 0; f < kFrames; ++f) {
        engine->render(outputs);
        write_output(file, g_out, sizeof(g_out));
    }
    semihost(0x02, &file);
    print("guard trips ");
    print_number(engine->guard_trips());
    print("\n");
    finish(engine->guard_trips() == 0);
}

extern "C" {
extern std::uint32_t __data_load, __data_start, __data_end, __bss_start, __bss_end, __stack_top;

[[noreturn]] void reset() {
    volatile auto* const cpacr = reinterpret_cast<std::uint32_t*>(0xE000ED88);
    *cpacr = *cpacr | (0xFu << 20);  // CP10 and CP11: the FPU
    __asm volatile("dsb\nisb");
    std::uint32_t* from = &__data_load;
    for (std::uint32_t* to = &__data_start; to < &__data_end;) *to++ = *from++;
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
