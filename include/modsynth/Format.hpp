#pragma once

// The wire format. Unstable until Milestone 2: nothing here promises to read old images.
//
// Everything is little-endian, offsets are bytes, and fields are read with load<T>() because images may sit at any
// alignment in flash. Tables and assets are the exception: chunks are 8-byte aligned so samples can be used in place.

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <span>

namespace modsynth {

using u8 = std::uint8_t;
using u16 = std::uint16_t;
using u32 = std::uint32_t;
using u64 = std::uint64_t;
using ByteSpan = std::span<const std::byte>;

template <class T>
[[nodiscard]] inline T load(const std::byte* p) {
    T value;
    std::memcpy(&value, p, sizeof(T));
    return value;
}

inline constexpr u32 kChunkMagic = 0x4B43534D;  // "MSCK"
inline constexpr u8 kFormatVersion = 0;
inline constexpr u32 kChunkAlign = 8;
inline constexpr u16 kNone = 0xFFFF;

// Limits that keep validation free of allocation. The compiler enforces the same numbers.
inline constexpr u32 kMaxRegisters = 256;
inline constexpr u32 kMaxChunks = 1024;

enum class ChunkKind : u8 { Manifest = 0, Asset = 1, Table = 2, Patch = 3, Program = 4 };

struct ChunkHeader {
    u32 magic;
    u8 kind;
    u8 version;
    u16 reserved;
    u32 size;  // payload bytes, not counting padding
    u32 reserved2;
    u64 hash;  // over the kind byte and the payload
};
static_assert(sizeof(ChunkHeader) == 24);

// FNV-1a 64. Identity and corruption detection, not authentication. Milestone 2 settles the final choice.
inline constexpr u64 kHashSeed = 14695981039346656037ull;
[[nodiscard]] inline u64 hash_bytes(u64 h, const std::byte* p, std::size_t n) {
    for (std::size_t i = 0; i < n; ++i) h = (h ^ static_cast<u8>(p[i])) * 1099511628211ull;
    return h;
}
[[nodiscard]] inline u64 hash_seed(ChunkKind kind) {
    const auto k = static_cast<std::byte>(kind);
    return hash_bytes(kHashSeed, &k, 1);
}

struct ManifestHeader {
    u32 entries;
    u32 programs;
};
struct ManifestEntry {
    u64 hash;
    u32 size;
    u8 kind;
    u8 present;  // 0 in a thin image: the receiver must already hold this chunk
    u16 reserved;
};
static_assert(sizeof(ManifestEntry) == 16);

// Followed by (length + 1) f32. The extra entry is the guard, so interpolation can always read idx + 1.
struct TableHeader {
    u32 length;  // power of two
    u32 reserved;
};

enum class AssetEncoding : u8 { I16 = 0, F32 = 1 };
// Followed by (frames + 1) * channels samples. The extra frame is the guard.
struct AssetHeader {
    u8 encoding;
    u8 channels;  // 1 or 2
    u8 root_key;
    u8 flags;  // reserved for streaming and compression
    float native_rate;
    u32 frames;
    u32 loop_start;
    u32 loop_end;  // 0 means one-shot
};
static_assert(sizeof(AssetHeader) == 20);

// An operand is a register bank and an index. Which banks an op accepts is in op_signature().
enum class Bank : u8 { None = 0, Buffer = 1, Voice = 2, Track = 3, Global = 4, Const = 5 };
[[nodiscard]] constexpr u16 operand(Bank bank, u16 index) {
    return static_cast<u16>(static_cast<u16>(bank) << 13 | index);
}
[[nodiscard]] constexpr Bank operand_bank(u16 o) { return static_cast<Bank>(o >> 13); }
[[nodiscard]] constexpr u16 operand_index(u16 o) { return o & 0x1FFF; }

// Voice scalars every patch has. They are zero in an insert instance.
inline constexpr u16 kScalarNote = 0;
inline constexpr u16 kScalarVelocity = 1;
inline constexpr u16 kScalarGate = 2;
inline constexpr u16 kBuiltinVoiceScalars = 3;

enum class Op : u8 {
    Fill = 1,    // out = in0
    Noise,       // out
    Osc,         // out, freq; resource: table
    Biquad,      // out, in, cutoff, q; mode: BiquadMode
    Env,         // out, attack, decay, sustain, release
    Sample,      // left, right, ratio; resource: asset
    Mul,         // out, a, b
    MulS,        // out, a, scalar b
    Add,         // out, a, b
    AddS,        // out, a, scalar b
    Pan,         // left, right, in, position
    DelayWrite,  // in; resource: delay line
    DelayRead,   // out, time; resource: delay line; mode: kReadBeforeWrite for feedback
    Comb,        // out, in, time, feedback, damp; resource: delay line
    Allpass,     // out, in, time, feedback; resource: delay line
    Follow,      // out, in, release
    KMul,        // out, a, b
    KAdd,        // out, a, b
    KMtoF,       // out, in
    KRatio,      // out, in; mode: root key
    KSnap,       // out, buffer
    KLfo,        // out, rate, depth
    kCount
};

enum class BiquadMode : u8 { LowPass = 0, HighPass = 1, BandPass = 2 };
inline constexpr u8 kReadBeforeWrite = 1;

enum class Arg : u8 { None, Buffer, Scalar };
enum class Resource : u8 { None, Table, Asset, Delay };

struct OpSignature {
    u8 outs;
    Arg out_kind;
    u8 ins;
    Arg in[4];
    Resource resource;
    bool control;  // writes a scalar, so it may be hoisted to the control phase
    bool ends;     // a voice stays alive until this step reports done
};

[[nodiscard]] constexpr OpSignature op_signature(Op op) {
    using A = Arg;
    using R = Resource;
    switch (op) {
        case Op::Fill:
            return {1, A::Buffer, 1, {A::Scalar}, R::None, false, false};
        case Op::Noise:
            return {1, A::Buffer, 0, {}, R::None, false, false};
        case Op::Osc:
            return {1, A::Buffer, 1, {A::Scalar}, R::Table, false, false};
        case Op::Biquad:
            return {1, A::Buffer, 3, {A::Buffer, A::Scalar, A::Scalar}, R::None, false, false};
        case Op::Env:
            return {1, A::Buffer, 4, {A::Scalar, A::Scalar, A::Scalar, A::Scalar}, R::None, false, true};
        case Op::Sample:
            return {2, A::Buffer, 1, {A::Scalar}, R::Asset, false, true};
        case Op::Mul:
        case Op::Add:
            return {1, A::Buffer, 2, {A::Buffer, A::Buffer}, R::None, false, false};
        case Op::MulS:
        case Op::AddS:
            return {1, A::Buffer, 2, {A::Buffer, A::Scalar}, R::None, false, false};
        case Op::Pan:
            return {2, A::Buffer, 2, {A::Buffer, A::Scalar}, R::None, false, false};
        case Op::DelayWrite:
            return {0, A::None, 1, {A::Buffer}, R::Delay, false, false};
        case Op::DelayRead:
            return {1, A::Buffer, 1, {A::Scalar}, R::Delay, false, false};
        case Op::Comb:
            return {1, A::Buffer, 4, {A::Buffer, A::Scalar, A::Scalar, A::Scalar}, R::Delay, false, false};
        case Op::Allpass:
            return {1, A::Buffer, 3, {A::Buffer, A::Scalar, A::Scalar}, R::Delay, false, false};
        case Op::Follow:
            return {1, A::Buffer, 2, {A::Buffer, A::Scalar}, R::None, false, false};
        case Op::KMul:
        case Op::KAdd:
            return {1, A::Scalar, 2, {A::Scalar, A::Scalar}, R::None, true, false};
        case Op::KMtoF:
        case Op::KRatio:
            return {1, A::Scalar, 1, {A::Scalar}, R::None, true, false};
        case Op::KSnap:
            return {1, A::Scalar, 1, {A::Buffer}, R::None, true, false};
        case Op::KLfo:
            return {1, A::Scalar, 2, {A::Scalar, A::Scalar}, R::None, true, false};
        default:
            return {0, A::None, 0, {}, R::None, false, false};
    }
}
[[nodiscard]] constexpr bool op_known(u8 op) { return op >= 1 && op < static_cast<u8>(Op::kCount); }

struct WireStep {
    u8 op;
    u8 mode;
    u16 resource;  // index into the patch's refs, or into its delay lines
    u32 state_id;  // stable across edits, so state can carry over a swap. 0 if stateless.
    u16 out[2];
    u16 in[4];
};
static_assert(sizeof(WireStep) == 20);

enum class ParamScope : u8 { Voice = 0, Track = 1, Global = 2 };

struct ParamDesc {
    u16 id;  // stable, and what Instructions address
    u8 scope;
    u8 reserved;
    u16 reg;  // in the bank for its scope; for Global, the operand index is this desc's position
    u16 smooth_ms;
    float min;
    float max;
    float def;
};
static_assert(sizeof(ParamDesc) == 20);

// The body after this header, in order: ParamDesc[params], u64 refs[refs], f32 consts[consts], f32 delays[delays]
// (maximum seconds), u16 in_ports[inputs * 2], WireStep[control_steps + voice_steps].
struct PatchHeader {
    u16 control_steps;  // run once per track or insert, in the control phase
    u16 voice_steps;    // run per voice or insert, in the audio phase
    u16 buffers;
    u16 voice_scalars;
    u16 track_scalars;
    u16 params;
    u16 refs;
    u16 consts;
    u16 delays;
    u16 inputs;  // stereo input pairs, 0 for an instrument
    u16 out_left;
    u16 out_right;
};
static_assert(sizeof(PatchHeader) == 24);

enum class Instr : u8 {
    End = 0,
    Wait,      // c: ticks
    NoteOn,    // a: note, b: velocity 0..127, c: duration in ticks
    SetPatch,  // a: slot
    SetParam,  // b: param id, c: value bits
    Ramp,      // b: param id, c: value bits, followed by RampArg
    RampArg,   // c: ticks
    Call,      // b: clip, c: repeats
    Tempo,     // c: microseconds per quarter. Conductor stream only.
    kCount
};

struct Instruction {
    u8 op;
    u8 a;
    u16 b;
    u32 c;
};
static_assert(sizeof(Instruction) == 8);

struct TrackDesc {
    u16 id;  // stable across edits
    u16 voices;
    u16 slot_begin;
    u16 slot_count;
    u32 stream_begin;
    u32 stream_length;
};
static_assert(sizeof(TrackDesc) == 16);

struct ClipDesc {
    u32 begin;
    u32 length;
    u32 ticks;
};

struct InsertDesc {
    u16 id;  // stable across edits
    u16 patch;
};

enum class MixOp : u8 { RunVoices = 1, RunInsert = 2, Gather = 3 };
struct MixStep {
    u8 op;
    u8 reserved;
    u16 task;  // steps sharing a task run together, in order
    u16 a;     // track, insert, or first GatherInput
    u16 dst;   // bus register
    u16 src;   // RunInsert: input register. Gather: input count.
    u16 key;   // RunInsert: sidechain register, or kNone
};
static_assert(sizeof(MixStep) == 12);

struct GatherInput {
    u16 src;
    u16 gain_left;  // mix registers, so a fader move changes nothing in the image
    u16 gain_right;
    u16 reserved;
};

struct ParamInit {
    u16 target_kind;  // 0: track, 1: insert
    u16 target;
    u16 id;
    u16 reserved;
    float value;
};

struct GlobalDesc {
    u16 id;
    u16 reserved;
    float value;
};

// The body after this header, in order: u64 patches[patches], TrackDesc[tracks], u16 slots[slots], ClipDesc[clips],
// InsertDesc[inserts], MixStep[mix_steps], GatherInput[gather_inputs], f32 mix_init[mix_regs], GlobalDesc[globals],
// ParamInit[inits], Instruction[code].
struct ProgramHeader {
    u32 ppq;
    u32 uspq;  // initial tempo
    u32 length_ticks;
    u32 conductor_begin;
    u32 conductor_length;
    u32 code;
    u16 patches;
    u16 tracks;
    u16 slots;
    u16 clips;
    u16 inserts;
    u16 mix_steps;
    u16 gather_inputs;
    u16 buses;
    u16 mix_regs;
    u16 globals;
    u16 inits;
    u16 master;
};
static_assert(sizeof(ProgramHeader) == 48);

}  // namespace modsynth
