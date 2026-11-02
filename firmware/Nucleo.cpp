// Firmware for the NUCLEO-L476RG. It receives images over the ST-LINK's serial port into two flash slots, plays the
// newest one that loads through the DAC on PA4, and renders on request so a host can check its audio and time it.
// docs/Board.md has the wiring and the protocol, and tools/Board.py is the host side.

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <new>
#include <stm32l4xx.h>

#include <modsynth/Modsynth.hpp>
#include <modsynth/Profile.hpp>
#ifdef MODSYNTH_CMSIS
#include <modsynth/CmsisBackend.hpp>
#endif

using namespace modsynth;

#ifdef MODSYNTH_CMSIS
using Dsp = CmsisBackend;
constexpr const char* kBackend = "cmsis";
#else
using Dsp = ScalarBackend;
constexpr const char* kBackend = "scalar";
#endif

namespace {

// Clocks and rates -------------------------------------------------------------------------------------------------

constexpr u32 kCoreHz = 80'000'000;
// TIM6 counts the core clock, so 48 kHz isn't a whole period. The engine is told the rate the DAC really runs at, so
// pitch stays right, and only frame-timed behaviour moves, by 0.02%.
constexpr u32 kTimerPeriod = 1667;
constexpr float kPlayRate = static_cast<float>(kCoreHz) / kTimerPeriod;
constexpr u32 kBaud = 921'600;

constexpr SynthConfig kConfig{.frame_size = MODSYNTH_FRAME, .channels = 1, .tap_slots = 0, .generations = 1};
using Engine = Synth<kConfig, Dsp>;
constexpr u32 N = Engine::frame_size;

// Memory -----------------------------------------------------------------------------------------------------------

[[gnu::section(".sram2")]] alignas(16) std::byte g_fast[32 * 1024];
alignas(16) std::byte g_bulk[MODSYNTH_BULK_KB * 1024];
ChunkRef g_refs[128];
ChunkTable g_table;
alignas(Engine) std::byte g_engine_storage[sizeof(Engine)];
Engine* g_engine = nullptr;
alignas(16) float g_out[N];

// Flash slots ------------------------------------------------------------------------------------------------------

// Bank 1 holds this firmware and slot A, bank 2 slot B. A slot's first page is its header, which is written last, so a
// transfer cut short leaves the slot uncommitted and the other one playing. Nucleo.ld fails a firmware that would run
// into slot A.
constexpr std::uintptr_t kFlashBase = 0x08000000;
constexpr std::uintptr_t kBankSize = 512 * 1024;
constexpr std::uintptr_t kPageSize = 2048;
constexpr std::uintptr_t kSlotSize = MODSYNTH_SLOT_KB * 1024;
constexpr std::array<std::uintptr_t, 2> kSlots = {kFlashBase + kBankSize - kSlotSize, kFlashBase + kBankSize};
constexpr u32 kCapacity = kSlotSize - kPageSize;
constexpr u32 kSlotMagic = 0x544F4C53;  // "SLOT"
constexpr u32 kCommitted = 0x454E4F44;  // "DONE"

// What this build plays and has room for, which its build extracts as firmware/Profiles/<name>.json. It is in a section
// that never reaches the board, and the build drops the zeros after the JSON.
constexpr ProfileText kProfileText = write_profile<Engine>({
    .name = "NUCLEO-L476RG",
    .backend = kBackend,
    .rate_millihertz = u64{kCoreHz} * 1000 / kTimerPeriod,
    .fast = sizeof g_fast,
    .bulk = sizeof g_bulk,
    .image_bytes = kCapacity,
    .chunks = std::size(g_refs),
});
[[gnu::section(".profile"), gnu::used]] constexpr auto kProfile = kProfileText.text;

struct SlotHeader {
    u32 magic, sequence;    // first double-word
    u32 size, size_check;   // second
    u32 commit, commit_ok;  // third, and last to be written
};

const std::byte* slot_image(u32 slot) { return reinterpret_cast<const std::byte*>(kSlots[slot] + kPageSize); }

volatile bool g_ecc_fault = false;

// A double-word that lost power while being written can read back with two ECC errors, which raises an NMI. The handler
// notes it, and this treats the slot as uncommitted.
bool read_slot(u32 slot, SlotHeader& out) {
    g_ecc_fault = false;
    std::memcpy(&out, reinterpret_cast<const void*>(kSlots[slot]), sizeof out);
    __DSB();
    return !g_ecc_fault && out.magic == kSlotMagic && out.size_check == ~out.size && out.commit == kCommitted &&
           out.commit_ok == ~kCommitted && out.size != 0 && out.size <= kCapacity && out.size % 8 == 0;
}

constexpr u32 kFlashErrors = FLASH_SR_OPERR | FLASH_SR_PROGERR | FLASH_SR_WRPERR | FLASH_SR_PGAERR | FLASH_SR_SIZERR |
                             FLASH_SR_PGSERR | FLASH_SR_MISERR | FLASH_SR_FASTERR | FLASH_SR_RDERR | FLASH_SR_OPTVERR;

void flash_wait() {
    while (FLASH->SR & FLASH_SR_BSY) {
    }
}

void flash_unlock() {
    if (FLASH->CR & FLASH_CR_LOCK) {
        FLASH->KEYR = 0x45670123;
        FLASH->KEYR = 0xCDEF89AB;
    }
}

void flash_lock() {
    flash_wait();
    FLASH->CR |= FLASH_CR_LOCK;
}

// The data cache can hold what a page read before it was written.
void flash_flush() {
    FLASH->ACR &= ~FLASH_ACR_DCEN;
    FLASH->ACR |= FLASH_ACR_DCRST;
    FLASH->ACR &= ~FLASH_ACR_DCRST;
    FLASH->ACR |= FLASH_ACR_DCEN;
}

bool erase_page(std::uintptr_t address) {
    const std::uintptr_t offset = address - kFlashBase;
    flash_unlock();
    flash_wait();
    FLASH->SR = kFlashErrors;
    u32 cr = FLASH->CR & ~(FLASH_CR_PNB | FLASH_CR_BKER);
    cr |= FLASH_CR_PER | static_cast<u32>(offset % kBankSize / kPageSize) << FLASH_CR_PNB_Pos;
    if (offset >= kBankSize) cr |= FLASH_CR_BKER;
    FLASH->CR = cr;
    FLASH->CR = cr | FLASH_CR_STRT;
    flash_wait();
    FLASH->CR &= ~(FLASH_CR_PER | FLASH_CR_PNB | FLASH_CR_BKER);
    return (FLASH->SR & kFlashErrors) == 0;
}

bool program(std::uintptr_t address, const void* eight) {
    u32 words[2];
    std::memcpy(words, eight, sizeof words);
    flash_unlock();
    flash_wait();
    FLASH->SR = kFlashErrors;
    FLASH->CR |= FLASH_CR_PG;
    reinterpret_cast<volatile u32*>(address)[0] = words[0];
    reinterpret_cast<volatile u32*>(address)[1] = words[1];
    flash_wait();
    FLASH->CR &= ~FLASH_CR_PG;
    return (FLASH->SR & kFlashErrors) == 0;
}

// Serial -----------------------------------------------------------------------------------------------------------

// Frames are COBS-encoded and end with a zero. Decoded, a frame is a type byte, a payload, and a CRC-32 of both.
constexpr u32 kMaxPayload = 1100;
constexpr u32 kMaxFrame = 1 + kMaxPayload + 4;
constexpr u32 kMaxEncoded = kMaxFrame + kMaxFrame / 254 + 2;

std::array<volatile u8, 4096> g_rx;
volatile u32 g_rx_head = 0;  // written by the interrupt
u32 g_rx_tail = 0;
volatile u32 g_serial_errors = 0;

u8 g_raw[kMaxEncoded];
u32 g_raw_size = 0;
bool g_raw_overflow = false;
u8 g_frame[kMaxFrame];
u8 g_tx[kMaxEncoded];

constexpr std::array<u32, 256> kCrcTable = [] {
    std::array<u32, 256> t{};
    for (u32 i = 0; i < 256; ++i) {
        u32 c = i;
        for (int k = 0; k < 8; ++k) c = c & 1 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
        t[i] = c;
    }
    return t;
}();

u32 crc32(const u8* p, u32 n, u32 crc = 0) {
    crc = ~crc;
    for (u32 i = 0; i < n; ++i) crc = kCrcTable[(crc ^ p[i]) & 0xFF] ^ (crc >> 8);
    return ~crc;
}

void put_byte(u8 b) {
    while (!(USART2->ISR & USART_ISR_TXE)) {
    }
    USART2->TDR = b;
}

// Sends a frame built from a type and up to two parts of payload.
void send_frame(u8 type, const void* a, u32 a_size, const void* b = nullptr, u32 b_size = 0) {
    u8 body[kMaxFrame];
    u32 n = 0;
    body[n++] = type;
    if (a_size) std::memcpy(body + n, a, a_size), n += a_size;
    if (b_size) std::memcpy(body + n, b, b_size), n += b_size;
    const u32 crc = crc32(body, n);
    std::memcpy(body + n, &crc, 4);
    n += 4;

    u32 out = 0, code_at = out++;
    u8 code = 1;
    for (u32 i = 0; i < n; ++i) {
        if (body[i] == 0) {
            g_tx[code_at] = code;
            code_at = out++;
            code = 1;
        } else {
            g_tx[out++] = body[i];
            if (++code == 0xFF) {
                g_tx[code_at] = code;
                code_at = out++;
                code = 1;
            }
        }
    }
    g_tx[code_at] = code;
    g_tx[out++] = 0;
    for (u32 i = 0; i < out; ++i) put_byte(g_tx[i]);
}

void send_text(u8 type, const char* text) { send_frame(type, text, static_cast<u32>(std::strlen(text))); }

// Decodes in place. Returns the decoded size, or 0 if the frame is malformed.
u32 cobs_decode(const u8* in, u32 n, u8* out) {
    u32 i = 0, o = 0;
    while (i < n) {
        const u8 code = in[i++];
        if (code == 0 || i + code - 1 > n) return 0;
        for (u32 k = 1; k < code; ++k) out[o++] = in[i++];
        if (code != 0xFF && i < n) out[o++] = 0;
    }
    return o;
}

// The next complete frame with a good CRC, without its CRC, or 0.
u32 poll_frame() {
    while (g_rx_tail != g_rx_head) {
        const u8 b = g_rx[g_rx_tail];
        g_rx_tail = (g_rx_tail + 1) % g_rx.size();
        if (b != 0) {
            if (g_raw_size < sizeof g_raw) {
                g_raw[g_raw_size++] = b;
            } else {
                g_raw_overflow = true;
            }
            continue;
        }
        const u32 raw = g_raw_size;
        const bool overflow = g_raw_overflow;
        g_raw_size = 0;
        g_raw_overflow = false;
        if (overflow || raw == 0) continue;
        const u32 n = cobs_decode(g_raw, raw, g_frame);
        if (n < 5) continue;
        u32 crc;
        std::memcpy(&crc, g_frame + n - 4, 4);
        if (crc32(g_frame, n - 4) != crc) {
            g_serial_errors = g_serial_errors + 1;
            continue;
        }
        return n - 4;
    }
    return 0;
}

// Text -------------------------------------------------------------------------------------------------------------

struct Text {
    char data[512];
    u32 size = 0;

    Text& add(const char* s) {
        while (*s && size + 1 < sizeof data) data[size++] = *s++;
        data[size] = 0;
        return *this;
    }
    Text& add(u64 v) {
        char digits[21];
        int at = 20;
        digits[at] = 0;
        do {
            digits[--at] = static_cast<char>('0' + v % 10);
            v /= 10;
        } while (v != 0);
        return add(digits + at);
    }
    Text& hex(u64 v) {
        char digits[17];
        for (int i = 15; i >= 0; --i, v >>= 4) digits[i] = "0123456789abcdef"[v & 0xF];
        digits[16] = 0;
        return add(digits);
    }
    Text& pair(const char* key, u64 v) { return add(size ? " " : "").add(key).add("=").add(v); }
    Text& pair(const char* key, const char* v) { return add(size ? " " : "").add(key).add("=").add(v); }
};

// Timing -----------------------------------------------------------------------------------------------------------

// Cycles a frame took, in buckets of 256 up to 128K, so a long run still gives a p99.9.
struct Timing {
    std::array<u32, 512> buckets{};
    u64 frames = 0, total = 0;
    u32 worst = 0;

    void add(u32 cycles) {
        ++buckets[std::min<u32>(cycles / 256, buckets.size() - 1)];
        ++frames;
        total += cycles;
        worst = std::max(worst, cycles);
    }
    [[nodiscard]] u32 percentile(u32 per_mille_tenths) const {  // 999 is p99.9
        const u64 want = (frames * per_mille_tenths + 999) / 1000;
        u64 seen = 0;
        for (u32 i = 0; i < buckets.size(); ++i) {
            seen += buckets[i];
            if (seen >= want) return std::min((i + 1) * 256, worst);  // the bucket's top, but never past the worst
        }
        return worst;
    }
    void write(Text& t, float rate) const {
        t.pair("frames", frames).pair("mean", frames ? total / frames : 0).pair("p999", percentile(999));
        t.pair("worst", worst).pair("budget", static_cast<u64>(static_cast<float>(N) * kCoreHz / rate));
    }
};

Timing g_play_timing;
u32 cycles() { return DWT->CYCCNT; }

// Audio ------------------------------------------------------------------------------------------------------------

// DMA reads one half while the main loop fills the other. A half of 16 frames has 10.7 ms to render in, so a frame that
// costs more than its own period is fine as long as the 16 around it don't. Nothing plays live, so latency is free.
constexpr u32 kHalfFrames = 16;
constexpr u32 kHalfSamples = kHalfFrames * N;
alignas(4) u16 g_dac[2 * kHalfSamples];
volatile bool g_due[2] = {false, false};
volatile u32 g_underruns = 0;
bool g_audio = false;
u32 g_peak_voices = 0;

u16 to_dac(float x) {
    x = std::clamp(x, -1.0f, 1.0f);  // a NaN never arrives: render() guards the master
    return static_cast<u16>(x * 2047.0f + 2048.5f);
}

void render_frame(Timing& timing) {
    const u32 start = cycles();
    g_engine->render({g_out});
    timing.add(cycles() - start);
}

void fill(u32 half) {
    u16* dst = g_dac + half * kHalfSamples;
    for (u32 f = 0; f < kHalfFrames; ++f) {
        if (g_engine) {
            render_frame(g_play_timing);
            g_peak_voices = std::max(g_peak_voices, g_engine->active_voices());
        } else {
            std::fill(g_out, g_out + N, 0.0f);
        }
        for (u32 i = 0; i < N; ++i) dst[f * N + i] = to_dac(g_out[i]);
    }
}

void led(bool on) { GPIOA->BSRR = on ? GPIO_BSRR_BS5 : GPIO_BSRR_BR5; }

void start_audio() {
    if (g_audio) return;
    fill(0);
    fill(1);
    g_due[0] = false;
    g_due[1] = false;
    DMA1_Channel3->CCR &= ~DMA_CCR_EN;
    DMA1->IFCR = DMA_IFCR_CGIF3;
    DMA1_Channel3->CNDTR = 2 * kHalfSamples;
    DMA1_Channel3->CCR |= DMA_CCR_EN;
    TIM6->CNT = 0;
    TIM6->CR1 |= TIM_CR1_CEN;
    g_audio = true;
    led(true);
}

// Flash writes stall reads of their bank, so audio stops for them.
void stop_audio() {
    if (!g_audio) return;
    TIM6->CR1 &= ~TIM_CR1_CEN;
    DMA1_Channel3->CCR &= ~DMA_CCR_EN;
    g_audio = false;
    led(false);
}

void serve_audio() {
    for (u32 half = 0; half < 2; ++half) {
        if (!g_due[half]) continue;
        fill(half);
        g_due[half] = false;
    }
}

// Loopback ---------------------------------------------------------------------------------------------------------

// The ADC samples PA4 on the DAC's own trigger while the DMA interrupt logs what the DAC was given, so a host can see
// that the audio reaches the pin.
constexpr u32 kCapture = 1024;
alignas(4) u16 g_adc[kCapture];
alignas(4) u16 g_sent[kCapture + kHalfSamples];
volatile u32 g_sent_count = 0;
volatile u32 g_capture = 0;  // 0 idle, 1 waiting for a half to begin, 2 running

void init_adc() {
    RCC->AHB2ENR |= RCC_AHB2ENR_ADCEN;
    RCC->CCIPR |= RCC_CCIPR_ADCSEL;  // the system clock
    ADC123_COMMON->CCR =
        (ADC123_COMMON->CCR & ~(ADC_CCR_CKMODE | ADC_CCR_PRESC)) | (2u << ADC_CCR_PRESC_Pos);  // 20 MHz
    GPIOA->ASCR |= GPIO_ASCR_ASC4;                                                             // PA4 to the ADC too
    ADC1->CR &= ~ADC_CR_DEEPPWD;
    ADC1->CR |= ADC_CR_ADVREGEN;
    for (const u32 start = cycles(); cycles() - start < kCoreHz / 40'000;) {  // 25 us for the regulator
    }
    ADC1->CR &= ~ADC_CR_ADCALDIF;
    ADC1->CR |= ADC_CR_ADCAL;
    while (ADC1->CR & ADC_CR_ADCAL) {
    }
    for (const u32 start = cycles(); cycles() - start < 100;) {
    }
    ADC1->ISR = ADC_ISR_ADRDY;
    ADC1->CR |= ADC_CR_ADEN;
    while (!(ADC1->ISR & ADC_ISR_ADRDY)) {
    }
    ADC1->SQR1 = 9u << ADC_SQR1_SQ1_Pos;  // one conversion, of channel 9, which is PA4
    ADC1->SMPR1 = (ADC1->SMPR1 & ~ADC_SMPR1_SMP9) | (4u << ADC_SMPR1_SMP9_Pos);                       // 47.5 cycles
    ADC1->CFGR = ADC_CFGR_DMAEN | ADC_CFGR_OVRMOD | ADC_CFGR_EXTEN_0 | (13u << ADC_CFGR_EXTSEL_Pos);  // TIM6's TRGO
    DMA1_CSELR->CSELR &= ~DMA_CSELR_C1S;                                                              // ADC1
    DMA1_Channel1->CPAR = reinterpret_cast<std::uintptr_t>(&ADC1->DR);
    DMA1_Channel1->CMAR = reinterpret_cast<std::uintptr_t>(g_adc);
    DMA1_Channel1->CCR = DMA_CCR_MINC | DMA_CCR_PSIZE_0 | DMA_CCR_MSIZE_0;
}

void capture() {
    if (!g_audio) return send_text('e', "audio is not running");
    DMA1_Channel1->CCR &= ~DMA_CCR_EN;
    DMA1->IFCR = DMA_IFCR_CGIF1;
    DMA1_Channel1->CNDTR = kCapture;
    DMA1_Channel1->CCR |= DMA_CCR_EN;
    g_sent_count = 0;
    g_capture = 1;
    const u32 start = cycles();
    bool done = false;
    while (!done && cycles() - start < kCoreHz / 10) {
        serve_audio();
        done = (DMA1->ISR & DMA_ISR_TCIF1) != 0 && g_sent_count >= kCapture;
    }
    g_capture = 0;
    ADC1->CR |= ADC_CR_ADSTP;
    while (ADC1->CR & ADC_CR_ADSTART) {
    }
    DMA1_Channel1->CCR &= ~DMA_CCR_EN;
    if (!done) return send_text('e', "the capture did not finish");
    for (u8 which = 0; which < 2; ++which) {
        const u16* from = which == 0 ? g_adc : g_sent;
        for (u16 at = 0; at < kCapture; at += 512) {
            const u8 head[3] = {which, static_cast<u8>(at), static_cast<u8>(at >> 8)};
            send_frame('c', head, 3, from + at, 512 * 2);
        }
    }
    send_text('k', "");
}

// Loading ----------------------------------------------------------------------------------------------------------

int g_active = -1;  // the slot that is committed and loaded, or -1
u32 g_sequence = 0;
MemorySizes g_need{};

// Builds an engine from nothing and loads an image into it. On failure, `why` says what went wrong.
bool load_image(const std::byte* image, u32 size, float rate, Text& why) {
    g_engine = nullptr;
    g_table = ChunkTable(std::span(g_refs));
    Loader loader(g_table);
    loader.begin({image, size}, N);
    while (loader.step(1u << 16) == LoadStatus::Working) {
    }
    if (loader.status() == LoadStatus::Failed) {
        why.add(to_string(loader.error()));
        return false;
    }
    if (loader.programs() == 0) {
        why.add("the image has no Program");
        return false;
    }
    const u64 program = loader.program_hash(0);
    g_need = Engine::bytes_required(g_table, program, rate);
    auto* engine = new (g_engine_storage) Engine({std::span(g_fast), std::span(g_bulk), rate});
    engine->bind(g_table, program);
    while (engine->pump(1u << 16)) {
    }
    if (engine->load_error() != LoadError::None) {
        why.add(to_string(engine->load_error()));
        if (engine->load_error() == LoadError::OutOfMemory) {
            why.add(": needs fast ").add(g_need.fast).add(" of ").add(sizeof g_fast);
            why.add(", bulk ").add(g_need.bulk).add(" of ").add(sizeof g_bulk);
        }
        return false;
    }
    g_engine = engine;
    return true;
}

// Loads the newest committed slot that loads, or the other one.
void load_active(float rate) {
    SlotHeader h[2];
    const bool ok[2] = {read_slot(0, h[0]), read_slot(1, h[1])};
    const u32 first = ok[1] && (!ok[0] || h[1].sequence > h[0].sequence) ? 1 : 0;
    g_active = -1;
    g_engine = nullptr;
    for (u32 slot : {first, 1 - first}) {
        Text why;
        if (ok[slot] && load_image(slot_image(slot), h[slot].size, rate, why)) {
            g_active = static_cast<int>(slot);
            g_sequence = h[slot].sequence;
            return;
        }
    }
}

u32 next_sequence() {
    SlotHeader h;
    u32 sequence = 0;
    for (u32 slot = 0; slot < 2; ++slot) {
        if (read_slot(slot, h)) sequence = std::max(sequence, h.sequence);
    }
    return sequence + 1;
}

// Receiving --------------------------------------------------------------------------------------------------------

struct Receive {
    bool active = false;
    u32 slot = 0;
    u32 size = 0;
    u32 next = 0;
    std::uintptr_t erased = 0;  // flash below this address in the slot is erased
    bool manifest = false;
};
Receive g_receive;

// The slot written to stays uncommitted, so the image that was playing comes back.
void abandon_receive() {
    g_receive.active = false;
    flash_lock();
    load_active(kPlayRate);
    start_audio();
}

void fail_receive(const char* what, const char* detail = nullptr) {
    Text t;
    t.add(what);
    if (detail) t.add(": ").add(detail);
    send_text('e', t.data);
    abandon_receive();
}

void begin_receive(u32 size) {
    if (size == 0 || size % 8 != 0 || size > kCapacity) {
        Text t;
        t.add("an image must be a non-zero multiple of 8 bytes, at most ").add(kCapacity);
        send_text('e', t.data);
        return;
    }
    stop_audio();
    g_engine = nullptr;
    const u32 slot = g_active == 0 ? 1 : 0;  // never the one playing
    // The header page goes first, so the slot reads as uncommitted from here on.
    if (!erase_page(kSlots[slot])) return fail_receive("flash erase failed");
    g_receive = {true, slot, size, 0, kSlots[slot] + kPageSize, false};
    flash_flush();
    const u32 capacity = kCapacity;
    send_frame('k', &capacity, 4);
}

// The manifest comes first, so an image for another revision or frame size is refused before the rest is sent.
bool check_manifest(Text& why) {
    const std::byte* image = slot_image(g_receive.slot);
    if (g_receive.next < sizeof(ChunkHeader)) return true;
    const ChunkHeader h = load<ChunkHeader>(image);
    const u64 need = sizeof(ChunkHeader) + static_cast<u64>(h.size);
    if (g_receive.next < std::min<u64>(need, g_receive.size)) return true;
    ChunkRef none[1];
    ChunkTable table{std::span(none)};
    Loader loader(table);
    loader.begin({image, g_receive.next}, N);
    if (loader.step(1) == LoadStatus::Failed) {
        why.add(to_string(loader.error()));
        return false;
    }
    g_receive.manifest = true;
    return true;
}

void receive_data(const u8* payload, u32 n) {
    if (!g_receive.active) return send_text('e', "no transfer is open");
    if (n < 4) return send_text('e', "short data frame");
    u32 offset;
    std::memcpy(&offset, payload, 4);
    const u8* data = payload + 4;
    const u32 size = n - 4;
    // A repeat of a frame whose reply was lost, or one out of order: the reply says where to carry on.
    if (offset != g_receive.next) return send_frame('k', &g_receive.next, 4);
    if (size > g_receive.size - offset || (size % 8 != 0)) return fail_receive("bad data frame");

    const std::uintptr_t base = kSlots[g_receive.slot] + kPageSize + offset;
    while (g_receive.erased < base + size) {
        if (!erase_page(g_receive.erased)) return fail_receive("flash erase failed");
        g_receive.erased += kPageSize;
    }
    for (u32 i = 0; i < size; i += 8) {
        if (!program(base + i, data + i)) return fail_receive("flash write failed");
    }
    flash_flush();
    if (std::memcmp(reinterpret_cast<const void*>(base), data, size) != 0)
        return fail_receive("flash readback differs");
    g_receive.next += size;
    Text why;
    if (!g_receive.manifest && !check_manifest(why)) return fail_receive("refused", why.data);
    send_frame('k', &g_receive.next, 4);
}

void end_receive() {
    if (!g_receive.active) return send_text('e', "no transfer is open");
    if (g_receive.next != g_receive.size) return fail_receive("the transfer is incomplete");
    g_receive.active = false;
    const u32 slot = g_receive.slot;
    Text why;
    if (!load_image(slot_image(slot), g_receive.size, kPlayRate, why)) return fail_receive("refused", why.data);

    // Verified and loaded, so it is committed: the header's last double-word is what makes it count.
    const SlotHeader h{kSlotMagic, next_sequence(), g_receive.size, ~g_receive.size, kCommitted, ~kCommitted};
    const auto* words = reinterpret_cast<const std::byte*>(&h);
    for (u32 i = 0; i < sizeof h; i += 8) {
        if (!program(kSlots[slot] + i, words + i)) return fail_receive("flash write failed");
    }
    flash_flush();
    flash_lock();
    SlotHeader check;
    if (!read_slot(slot, check)) return fail_receive("the slot header did not read back");
    g_active = static_cast<int>(slot);
    g_sequence = h.sequence;
    g_play_timing = {};
    g_peak_voices = 0;
    Text t;
    t.pair("slot", slot == 0 ? "A" : "B").pair("sequence", h.sequence).pair("image", g_receive.size);
    t.pair("fast", g_need.fast).pair("bulk", g_need.bulk);
    send_text('k', t.data);
    start_audio();
}

// Commands ---------------------------------------------------------------------------------------------------------

void info() {
    Text t;
    t.pair("board", "NUCLEO-L476RG").pair("backend", kBackend).pair("frame", N).pair("channels", 1);
    t.pair("core_hz", kCoreHz).pair("rate_millihertz", static_cast<u64>(kPlayRate * 1000.0f));
    t.pair("fast", sizeof g_fast).pair("bulk", sizeof g_bulk).pair("chunks", std::size(g_refs));
    t.pair("slot_capacity", kCapacity).pair("revision", kFormatRevision);
    t.pair("slot", g_active < 0 ? "none" : g_active == 0 ? "A" : "B");
    if (g_active >= 0) {
        SlotHeader h;
        (void)read_slot(static_cast<u32>(g_active), h);
        t.pair("sequence", h.sequence).pair("image", h.size).pair("need_fast", g_need.fast);
        t.pair("need_bulk", g_need.bulk);
    }
    send_text('i', t.data);
}

void stats() {
    Text t;
    g_play_timing.write(t, kPlayRate);
    t.pair("underruns", g_underruns).pair("serial_errors", g_serial_errors).pair("peak_voices", g_peak_voices);
    t.pair("playing", g_engine && g_engine->playing() ? 1 : 0);
    t.pair("guard_trips", g_engine ? g_engine->guard_trips() : 0);
    send_text('i', t.data);
}

void play() {
    if (!g_engine) return send_text('e', "nothing is loaded");
    g_engine->send({.kind = EventKind::Locate, .tick = 0});
    g_engine->send({.kind = EventKind::Play});
    g_play_timing = {};
    g_underruns = 0;
    g_peak_voices = 0;
    start_audio();
    send_text('k', "");
}

void stop() {
    if (g_engine) g_engine->send({.kind = EventKind::Stop});
    send_text('k', "");
}

// Renders the active image from its start at `rate`, away from the DAC, and optionally sends every frame. The frames
// a host compares with golden renders, and the timing is cycles on this board.
void render(const u8* payload, u32 n) {
    if (n < 9) return send_text('e', "short render frame");
    u32 frames;
    float rate;
    std::memcpy(&frames, payload, 4);
    std::memcpy(&rate, payload + 4, 4);
    const bool stream = payload[8] != 0;
    if (g_active < 0) return send_text('e', "nothing is loaded");
    if (!(rate >= 1000.0f && rate <= 384000.0f)) return send_text('e', "bad rate");
    stop_audio();
    SlotHeader h;
    (void)read_slot(static_cast<u32>(g_active), h);
    Text why;
    if (!load_image(slot_image(static_cast<u32>(g_active)), h.size, rate, why)) {
        send_text('e', why.data);
    } else {
        g_engine->send({.kind = EventKind::Play});
        static Timing timing;
        timing = {};
        u64 hash = kHashSeed;
        u32 voices = 0;
        for (u32 f = 0; f < frames; ++f) {
            render_frame(timing);
            voices = std::max(voices, g_engine->active_voices());
            hash = hash_bytes(hash, reinterpret_cast<const std::byte*>(g_out), sizeof g_out);
            if (stream) send_frame('a', &f, 4, g_out, sizeof g_out);
        }
        Text t;
        timing.write(t, rate);
        t.pair("peak_voices", voices).pair("guard_trips", g_engine->guard_trips()).add(" hash=").hex(hash);
        send_text('i', t.data);
    }
    load_active(kPlayRate);
    start_audio();
}

void handle(u32 n) {
    const u8 type = g_frame[0];
    const u8* payload = g_frame + 1;
    const u32 size = n - 1;
    if (g_receive.active && type != 'D' && type != 'E' && type != 'B') abandon_receive();
    switch (type) {
        case 'I':
            return info();
        case 'B': {
            if (size < 4) return send_text('e', "short begin frame");
            u32 bytes;
            std::memcpy(&bytes, payload, 4);
            return begin_receive(bytes);
        }
        case 'D':
            return receive_data(payload, size);
        case 'E':
            return end_receive();
        case 'P':
            return play();
        case 'S':
            return stop();
        case 'T':
            return stats();
        case 'R':
            return render(payload, size);
        case 'C':
            return capture();
        case 'Z':  // a reset, which is how a host tests a transfer cut short
            send_text('k', "");
            while (!(USART2->ISR & USART_ISR_TC)) {
            }
            NVIC_SystemReset();
        default:
            return send_text('e', "unknown command");
    }
}

// The blue button plays from the start.
void poll_button() {
    static bool was_down = false;
    static u32 since = 0;
    const bool down = (GPIOC->IDR & GPIO_IDR_ID13) == 0;
    if (down == was_down) return;
    if (cycles() - since < kCoreHz / 20) return;  // 50 ms of debounce
    since = cycles();
    was_down = down;
    if (down && g_engine) {
        g_engine->send({.kind = EventKind::Locate, .tick = 0});
        g_engine->send({.kind = EventKind::Play});
    }
}

// Bring-up ---------------------------------------------------------------------------------------------------------

// MSI at 4 MHz, locked to the 32.768 kHz crystal when it starts, into the PLL for 80 MHz.
bool init_clocks() {
    RCC->APB1ENR1 |= RCC_APB1ENR1_PWREN;
    (void)RCC->APB1ENR1;
    FLASH->ACR =
        (FLASH->ACR & ~FLASH_ACR_LATENCY) | FLASH_ACR_LATENCY_4WS | FLASH_ACR_PRFTEN | FLASH_ACR_ICEN | FLASH_ACR_DCEN;
    while ((FLASH->ACR & FLASH_ACR_LATENCY) != FLASH_ACR_LATENCY_4WS) {
    }

    PWR->CR1 |= PWR_CR1_DBP;
    RCC->BDCR |= RCC_BDCR_LSEON;
    bool lse = false;
    for (u32 i = 0; i < 4'000'000 && !lse; ++i) lse = (RCC->BDCR & RCC_BDCR_LSERDY) != 0;  // about 2 s at 4 MHz
    if (lse) RCC->CR |= RCC_CR_MSIPLLEN;

    RCC->PLLCFGR = RCC_PLLCFGR_PLLSRC_MSI | (0u << RCC_PLLCFGR_PLLM_Pos) | (40u << RCC_PLLCFGR_PLLN_Pos) |
                   (0u << RCC_PLLCFGR_PLLR_Pos) | RCC_PLLCFGR_PLLREN;
    RCC->CR |= RCC_CR_PLLON;
    while (!(RCC->CR & RCC_CR_PLLRDY)) {
    }
    RCC->CFGR = (RCC->CFGR & ~RCC_CFGR_SW) | RCC_CFGR_SW_PLL;
    while ((RCC->CFGR & RCC_CFGR_SWS) != RCC_CFGR_SWS_PLL) {
    }
    return lse;
}

void init_peripherals() {
    RCC->AHB1ENR |= RCC_AHB1ENR_DMA1EN;
    RCC->AHB2ENR |= RCC_AHB2ENR_GPIOAEN | RCC_AHB2ENR_GPIOCEN;
    RCC->APB1ENR1 |= RCC_APB1ENR1_USART2EN | RCC_APB1ENR1_DAC1EN | RCC_APB1ENR1_TIM6EN;
    (void)RCC->APB1ENR1;

    // PA2 and PA3 to USART2, which the ST-LINK carries to USB. PA4 stays analog for the DAC. PA5 is the green LED.
    GPIOA->MODER = (GPIOA->MODER & ~(GPIO_MODER_MODE2 | GPIO_MODER_MODE3 | GPIO_MODER_MODE5)) | GPIO_MODER_MODE2_1 |
                   GPIO_MODER_MODE3_1 | GPIO_MODER_MODE5_0;
    GPIOA->AFR[0] = (GPIOA->AFR[0] & ~(GPIO_AFRL_AFSEL2 | GPIO_AFRL_AFSEL3)) | (7u << GPIO_AFRL_AFSEL2_Pos) |
                    (7u << GPIO_AFRL_AFSEL3_Pos);
    GPIOC->MODER &= ~GPIO_MODER_MODE13;  // the blue button, an input

    USART2->BRR = (kCoreHz + kBaud / 2) / kBaud;
    USART2->CR1 = USART_CR1_TE | USART_CR1_RE | USART_CR1_RXNEIE | USART_CR1_UE;
    NVIC_SetPriority(USART2_IRQn, 0);  // above audio, so no byte is lost while a frame renders
    NVIC_EnableIRQ(USART2_IRQn);

    // TIM6 triggers the DAC once a sample, and the DAC asks DMA for the next.
    TIM6->PSC = 0;
    TIM6->ARR = kTimerPeriod - 1;
    TIM6->CR2 = TIM_CR2_MMS_1;  // update as TRGO
    TIM6->EGR = TIM_EGR_UG;

    DAC1->MCR &= ~DAC_MCR_MODE1;  // buffered, to the pin
    DAC1->DHR12R1 = 2048;
    DAC1->CR = DAC_CR_TEN1 | DAC_CR_DMAEN1;  // TSEL1 0 is TIM6
    DAC1->CR |= DAC_CR_EN1;

    DMA1_CSELR->CSELR = (DMA1_CSELR->CSELR & ~DMA_CSELR_C3S) | (6u << DMA_CSELR_C3S_Pos);  // DAC channel 1
    DMA1_Channel3->CPAR = reinterpret_cast<std::uintptr_t>(&DAC1->DHR12R1);
    DMA1_Channel3->CMAR = reinterpret_cast<std::uintptr_t>(g_dac);
    DMA1_Channel3->CCR = DMA_CCR_PL_1 | DMA_CCR_MSIZE_0 | DMA_CCR_PSIZE_1 | DMA_CCR_MINC | DMA_CCR_CIRC | DMA_CCR_DIR |
                         DMA_CCR_HTIE | DMA_CCR_TCIE;
    NVIC_SetPriority(DMA1_Channel3_IRQn, 1);
    NVIC_EnableIRQ(DMA1_Channel3_IRQn);

    DCB->DEMCR |= DCB_DEMCR_TRCENA_Msk;
    DWT->CYCCNT = 0;
    DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
    init_adc();
}

}  // namespace

int main() {
    const bool lse = init_clocks();
    init_peripherals();
    __enable_irq();
    load_active(kPlayRate);
    {
        Text t;
        t.add("modsynth on NUCLEO-L476RG, ").add(lse ? "MSI locked to LSE" : "MSI free-running, no LSE");
        t.add(", slot ").add(g_active < 0 ? "none" : g_active == 0 ? "A" : "B");
        send_text('l', t.data);
    }
    if (g_engine) g_engine->send({.kind = EventKind::Play});
    start_audio();
    for (;;) {
        serve_audio();
        if (const u32 n = poll_frame()) handle(n);
        poll_button();
    }
}

extern "C" {
extern std::uint32_t __data_load, __data_start, __data_end, __bss_start, __bss_end, __stack_top;

[[noreturn]] void reset() {
    SCB->CPACR |= 0xFu << 20;  // CP10 and CP11: the FPU
    __DSB();
    __ISB();
    std::uint32_t* from = &__data_load;
    for (std::uint32_t* to = &__data_start; to < &__data_end;) *to++ = *from++;
    for (std::uint32_t* to = &__bss_start; to < &__bss_end;) *to++ = 0;
    SCB->VTOR = kFlashBase;
    main();
    for (;;) {
    }
}

[[noreturn]] void fault() {
    __disable_irq();
    for (;;) {  // the LED blinks fast
        GPIOA->ODR ^= GPIO_ODR_OD5;
        for (u32 i = 0; i < 400'000; ++i) __NOP();
    }
}

void nmi() {
    if (FLASH->ECCR & FLASH_ECCR_ECCD) {
        FLASH->ECCR |= FLASH_ECCR_ECCD;
        g_ecc_fault = true;
        return;
    }
    fault();
}

void usart2() {
    const u32 isr = USART2->ISR;
    if (isr & (USART_ISR_ORE | USART_ISR_FE | USART_ISR_NE)) {
        USART2->ICR = USART_ICR_ORECF | USART_ICR_FECF | USART_ICR_NECF;
        g_serial_errors = g_serial_errors + 1;
    }
    if (isr & USART_ISR_RXNE) {
        const u8 b = static_cast<u8>(USART2->RDR);
        const u32 next = (g_rx_head + 1) % g_rx.size();
        if (next != g_rx_tail) {
            g_rx[g_rx_head] = b;
            g_rx_head = next;
        } else {
            g_serial_errors = g_serial_errors + 1;
        }
    }
}

void dma1_channel3() {
    const u32 isr = DMA1->ISR;
    DMA1->IFCR = DMA_IFCR_CGIF3;
    for (u32 half = 0; half < 2; ++half) {
        if (!(isr & (half == 0 ? DMA_ISR_HTIF3 : DMA_ISR_TCIF3))) continue;
        if (g_due[half]) g_underruns = g_underruns + 1;  // the DMA came round before the main loop refilled it
        g_due[half] = true;
        // The DMA starts on the other half now. A capture begins with a half, and logs each one as it starts.
        if (g_capture == 1 && half == 0) {
            ADC1->CR |= ADC_CR_ADSTART;
            g_capture = 2;
        }
        if (g_capture == 2 && g_sent_count < kCapture) {
            std::memcpy(g_sent + g_sent_count, g_dac + (1 - half) * kHalfSamples, sizeof(u16) * kHalfSamples);
            g_sent_count = g_sent_count + kHalfSamples;
        }
    }
}

void unused() { fault(); }

using Handler = void (*)();
constexpr u32 kVectors = 16 + 82;

struct VectorTable {
    const void* stack;
    std::array<Handler, kVectors - 1> handlers;
};

constexpr std::array<Handler, kVectors - 1> make_handlers() {
    std::array<Handler, kVectors - 1> h{};
    h.fill(&unused);
    h[0] = &reset;
    h[1] = &nmi;
    for (u32 i = 2; i < 6; ++i) h[i] = &fault;  // HardFault, MemManage, BusFault, UsageFault
    h[16 + DMA1_Channel3_IRQn - 1] = &dma1_channel3;
    h[16 + USART2_IRQn - 1] = &usart2;
    return h;
}

[[gnu::section(".vectors"), gnu::used]] const VectorTable g_vectors = {&__stack_top, make_handlers()};
}
