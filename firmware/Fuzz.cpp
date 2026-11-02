// The fuzzer on real Cortex-M4 code, under QEMU: 32-bit size_t, u32 as unsigned long, and an FPU that faults on an
// unaligned VLDR, none of which a desktop can show. There is no sanitizer here, so the MPU stands in: every allocation
// ends against a no-access region, and any fault prints a recipe that replays on a desktop under ASan.

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <new>

#include <modsynth/Loader.hpp>

#include "../fuzz/Coverage.hpp"
#include "../fuzz/Engine.hpp"

using namespace modsynth;
using namespace modsynth::fuzz;

#define MODSYNTH_LINK_SEED(name, path)   \
    __asm(                               \
        ".section .rodata.seeds,\"a\"\n" \
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

MODSYNTH_LINK_SEED(g_seed_a, MODSYNTH_FUZZ_SEED_A)
MODSYNTH_LINK_SEED(g_seed_b, MODSYNTH_FUZZ_SEED_B)
MODSYNTH_LINK_SEED(g_seed_c, MODSYNTH_FUZZ_SEED_C)
MODSYNTH_LINK_SEED(g_seed_d, MODSYNTH_FUZZ_SEED_D)
MODSYNTH_LINK_SEED(g_seed_e, MODSYNTH_FUZZ_SEED_E)
MODSYNTH_LINK_SEED(g_seed_f, MODSYNTH_FUZZ_SEED_F)
MODSYNTH_LINK_SEED(g_seed_g, MODSYNTH_FUZZ_SEED_G)
MODSYNTH_LINK_SEED(g_seed_h, MODSYNTH_FUZZ_SEED_H)
MODSYNTH_LINK_SEED(g_seed_i, MODSYNTH_FUZZ_SEED_I)
MODSYNTH_LINK_SEED(g_seed_j, MODSYNTH_FUZZ_SEED_J)
MODSYNTH_LINK_SEED(g_seed_k, MODSYNTH_FUZZ_SEED_K)
MODSYNTH_LINK_SEED(g_seed_l, MODSYNTH_FUZZ_SEED_L)

extern "C" std::byte __arena_start[], __arena_end[];

namespace {

constexpr u32 kCorpus = 1u << 14;
constexpr std::size_t kWorkspace = 1u << 20;
constexpr std::size_t kImage = 1u << 20;
constexpr std::size_t kGuard = 64;
constexpr u32 kRegions = 8;  // An M4 has eight, and the newest allocations hold them

using Engine = Fuzzer<kCorpus>;
alignas(Engine) std::byte g_engine[sizeof(Engine)];
const Recipe* g_recipe = nullptr;

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

[[noreturn]] void finish(bool ok) {
    const std::uintptr_t reason = ok ? 0x20026 : 0x20023;  // ApplicationExit, or RunTimeErrorUnknown
    semihost(0x18, reinterpret_cast<const void*>(reason));
    for (;;) {
    }
}

void print_recipe() {
    if (!g_recipe) return;
    print("recipe: ");
    print_number(g_recipe->seed_image);
    print(":");
    for (u32 i = 0; i < g_recipe->depth; ++i) {
        if (i) print(",");
        print_number(g_recipe->chain[i]);
    }
    print("\n");
}

auto& reg(std::uintptr_t address) { return *reinterpret_cast<volatile std::uint32_t*>(address); }

constexpr std::uintptr_t kShcsr = 0xE000ED24, kCfsr = 0xE000ED28, kMmfar = 0xE000ED34, kBfar = 0xE000ED38;
constexpr std::uintptr_t kMpuCtrl = 0xE000ED94, kMpuRnr = 0xE000ED98, kMpuRbar = 0xE000ED9C, kMpuRasr = 0xE000EDA0;

// Where each guard sits, so that giving memory back can lift the ones it covers.
std::byte* g_guards[kRegions];
u32 g_next_region = 0;

void set_guard(u32 region, std::byte* at) {
    g_guards[region] = at;
    reg(kMpuRnr) = region;
    reg(kMpuRasr) = 0;
    if (at) {
        reg(kMpuRbar) = static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(at));
        reg(kMpuRasr) = (5u << 1) | 1u;  // 2^(5+1) = 64 bytes, enabled, no access for anyone
    }
    __asm volatile("dsb\nisb");
}

// Allocations, so their tails can be checked: the MPU cannot see less than 64 bytes, and a tail can be up to 15.
struct Tail {
    std::byte* begin;
    std::byte* end;
};
Tail g_tails[32];
u32 g_tail_count = 0;
constexpr std::byte kCanary{0xC5};

void check_tails(u32 from) {
    for (u32 i = from; i < g_tail_count; ++i) {
        for (std::byte* p = g_tails[i].begin; p < g_tails[i].end; ++p) {
            if (*p != kCanary) fail("a write ran past the end of an allocation");
        }
    }
}

std::byte* g_used = nullptr;

}  // namespace

namespace modsynth::fuzz {

void reset_memory() {
    check_tails(0);
    g_tail_count = 0;
    for (u32 i = 0; i < kRegions; ++i) {
        if (g_guards[i]) set_guard(i, nullptr);
    }
    g_used = __arena_start;
}

std::byte* take_memory(std::size_t size) {
    // The allocation ends just before a guard: at most 15 bytes short of it, since it must start on 16.
    const auto used = reinterpret_cast<std::uintptr_t>(g_used);
    const std::uintptr_t guard = (used + size + 16 + kGuard - 1) / kGuard * kGuard;
    if (guard + kGuard > reinterpret_cast<std::uintptr_t>(__arena_end) - kWorkspace - kImage) {
        fail("the fuzzer's own memory ran out");
    }
    const std::uintptr_t start = (guard - size) / 16 * 16;
    auto* const out = reinterpret_cast<std::byte*>(start);
    auto* const end = out + size;
    if (end != reinterpret_cast<std::byte*>(guard) && g_tail_count < std::size(g_tails)) {
        std::memset(end, static_cast<int>(kCanary), guard - (start + size));
        g_tails[g_tail_count++] = {end, reinterpret_cast<std::byte*>(guard)};
    }
    set_guard(g_next_region, reinterpret_cast<std::byte*>(guard));
    g_next_region = (g_next_region + 1) % kRegions;
    g_used = reinterpret_cast<std::byte*>(guard + kGuard);
    return out;
}

std::size_t memory_mark() { return static_cast<std::size_t>(g_used - __arena_start) << 6 | g_tail_count; }

void rewind_memory(std::size_t mark) {
    const u32 tails = static_cast<u32>(mark & 63);
    std::byte* const target = __arena_start + (mark >> 6);
    check_tails(tails);
    g_tail_count = tails;
    for (u32 i = 0; i < kRegions; ++i) {
        if (g_guards[i] >= target) set_guard(i, nullptr);
    }
    g_used = target;
}

void fail(const char* what) {
    print("FAILED: ");
    print(what);
    print("\n");
    print_recipe();
    finish(false);
}

}  // namespace modsynth::fuzz

// Instruments Target.cpp only. A return address names a block, and the shift drops the Thumb bit.
extern "C" void __sanitizer_cov_trace_pc() {
    const auto pc = reinterpret_cast<std::uintptr_t>(__builtin_return_address(0));
    record_block(static_cast<u32>(pc >> 1) * 2654435761u >> 8);
}

extern "C" {
extern std::uint32_t __bss_start, __bss_end, __stack_top;

[[noreturn, gnu::used]] void fault_report(const std::uint32_t* frame) {
    print("FAILED: fault at pc ");
    print_number(frame[6]);
    print(", cfsr ");
    print_number(reg(kCfsr));
    print(", mmfar ");
    print_number(reg(kMmfar));
    print(", bfar ");
    print_number(reg(kBfar));
    print("\n");
    print_recipe();
    finish(false);
}

[[gnu::naked]] void fault() { __asm("mrs r0, msp\nb fault_report\n"); }

[[noreturn]] void reset() {
    reg(0xE000ED88) = reg(0xE000ED88) | (0xFu << 20);  // CP10 and CP11: the FPU
    __asm volatile("dsb\nisb");
    for (std::uint32_t* to = &__bss_start; to < &__bss_end;) *to++ = 0;

    reg(kShcsr) = reg(kShcsr) | (1u << 16) | (1u << 17) | (1u << 18);  // Report faults as themselves
    reg(kMpuCtrl) = (1u << 2) | 1u;                                    // On, with the default map behind the guards
    __asm volatile("dsb\nisb");

    static const ByteSpan seeds[] = {{g_seed_a, static_cast<std::size_t>(g_seed_a_end - g_seed_a)},
                                     {g_seed_b, static_cast<std::size_t>(g_seed_b_end - g_seed_b)},
                                     {g_seed_c, static_cast<std::size_t>(g_seed_c_end - g_seed_c)},
                                     {g_seed_d, static_cast<std::size_t>(g_seed_d_end - g_seed_d)},
                                     {g_seed_e, static_cast<std::size_t>(g_seed_e_end - g_seed_e)},
                                     {g_seed_f, static_cast<std::size_t>(g_seed_f_end - g_seed_f)},
                                     {g_seed_g, static_cast<std::size_t>(g_seed_g_end - g_seed_g)},
                                     {g_seed_h, static_cast<std::size_t>(g_seed_h_end - g_seed_h)},
                                     {g_seed_i, static_cast<std::size_t>(g_seed_i_end - g_seed_i)},
                                     {g_seed_j, static_cast<std::size_t>(g_seed_j_end - g_seed_j)},
                                     {g_seed_k, static_cast<std::size_t>(g_seed_k_end - g_seed_k)},
                                     {g_seed_l, static_cast<std::size_t>(g_seed_l_end - g_seed_l)}};
    // The top of the arena, out of take_memory()'s reach. As integers, because __arena_end is one past an unknown
    // array.
    const auto top = reinterpret_cast<std::uintptr_t>(__arena_end);
    auto* const workspace = reinterpret_cast<std::byte*>(top - kWorkspace);
    auto* const image = reinterpret_cast<std::byte*>(top - kWorkspace - kImage);
    auto* engine = new (g_engine)
        Engine(std::span(seeds), std::span(workspace, kWorkspace), std::span(image, kImage), MODSYNTH_FUZZ_RANDOM);
    g_recipe = &engine->current();
    g_used = __arena_start;

    const int begin = semihost(0x11, nullptr);  // SYS_TIME, in whole seconds
    engine->start();
    int reported = begin;
    for (;;) {
        for (u32 i = 0; i < 16; ++i) (void)engine->step();
        const int now = semihost(0x11, nullptr);
        if (now - begin >= MODSYNTH_FUZZ_SECONDS) break;
        if (now - reported >= 10) {
            reported = now;
            print_number(static_cast<u64>(now - begin));
            print("s ");
            print_number(engine->stats().execs);
            print(" execs, corpus ");
            print_number(engine->corpus());
            print(", edges ");
            print_number(engine->edges());
            print("\n");
        }
    }

    const Stats& s = engine->stats();
    print("\n");
    print_number(s.execs);
    print(" execs, corpus ");
    print_number(engine->corpus());
    print(", edges ");
    print_number(engine->edges());
    print("\n");
    for (u32 i = 0; i < std::size(s.load_errors); ++i) {
        if (s.load_errors[i] == 0) continue;
        print("  ");
        print(i == 0 ? "accepted" : to_string(static_cast<LoadError>(i)));
        print(": ");
        print_number(s.load_errors[i]);
        print("\n");
    }
    print("programs played ");
    print_number(s.programs);
    print(", finished ");
    print_number(s.finished);
    print(", swaps ");
    print_number(s.swaps);
    print(", frames ");
    print_number(s.frames);
    print(", guard trips ");
    print_number(s.guard_trips);
    print(", other frame sizes ");
    print_number(s.other_frames);
    print("\n");
    finish(true);
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
