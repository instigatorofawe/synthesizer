#pragma once

// The wire format, frozen at version 1. docs/Format.md is the specification, and this header must agree with it.
//
// What may change without a new version: new lines in Opcodes.def, a higher limit below, and a reserved field gaining a
// meaning, each with a higher kFormatRevision. Everything else here is permanent. Every field a reader does not use
// must be zero, and the validator refuses anything else, because a field that was ever ignored can never be given a
// meaning.
//
// Everything is little-endian, offsets are bytes, and fields are read with load<T>(), so a struct's own alignment never
// matters. Tables and assets are used in place, so an image must start on an 8-byte boundary.

#include <bit>
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

static_assert(std::endian::native == std::endian::little, "images are little-endian and are used in place");

template <class T>
[[nodiscard]] inline T load(const std::byte* p) {
    T value;
    std::memcpy(&value, p, sizeof(T));
    return value;
}

inline constexpr u32 kChunkMagic = 0x4B43534D;  // "MSCK"
inline constexpr u8 kFormatVersion = 1;         // Changes only if an old engine must not even try to read an image
inline constexpr u32 kFormatRevision = 8;       // The newest additions this engine understands
inline constexpr u32 kChunkAlign = 8;
inline constexpr u16 kNone = 0xFFFF;

// Limits, which keep validation free of allocation and bound every sum in sizing and timing. They may rise in a later
// revision but never fall, because an image that fit once must keep fitting. The validator enforces all of them.
inline constexpr u32 kMaxChunks = 1024;
inline constexpr u32 kMaxRegisters = 256;  // buffers, each scalar bank, buses
inline constexpr u32 kMaxPatchSteps = 4096;
inline constexpr u32 kMaxPatchParams = 256;
inline constexpr u32 kMaxPatchRefs = 256;
inline constexpr u32 kMaxPatchDelays = 256;
inline constexpr u32 kMaxPatchConsts = 8192;  // All of what an operand can index
inline constexpr float kMaxDelaySeconds = 60.0f;
inline constexpr u32 kMaxTracks = 256;
inline constexpr u32 kMaxInserts = 256;
inline constexpr u32 kMaxVoices = 256;  // per track
inline constexpr u32 kMaxSlots = 1024;  // across a Program
inline constexpr u32 kMaxTrackSlots = 256;
inline constexpr u32 kMaxClips = 4096;
inline constexpr u32 kMaxMixSteps = 1024;
inline constexpr u32 kMaxTasks = 256;
inline constexpr u32 kMaxGatherInputs = 4096;
inline constexpr u32 kMaxMixRegisters = 8192;
inline constexpr u32 kMaxGlobals = 256;
inline constexpr u32 kMaxInits = 4096;
inline constexpr u32 kMaxTicks = 0x7FFFFFFF;   // Any tick plus any duration fits a u32, and kNoTick stays unreachable
inline constexpr u32 kMaxExpanded = 1u << 24;  // Instructions a Program runs with every repeat unrolled
inline constexpr u32 kMaxZones = 256;          // in one Sample2's table
inline constexpr u32 kMaxHeldNotes = 16;       // a track in mono or legato remembers this many held notes
inline constexpr float kMaxGlideSeconds = 60.0f;

enum class ChunkKind : u8 { Manifest = 0, Asset = 1, Table = 2, Patch = 3, Program = 4 };

struct ChunkHeader {
    u32 magic;
    u8 kind;
    u8 version;
    u16 reserved;
    u32 size;  // payload bytes, not counting padding
    u32 reserved2;
    u64 hash;  // over the version byte, the kind byte and the payload
};
static_assert(sizeof(ChunkHeader) == 24);

// FNV-1a 64, settled at the freeze. It is identity and corruption detection, not authentication: anyone can make a
// collision, so a product that must refuse forged images signs the image bytes around this format. docs/Format.md says
// why that was enough, and what would change the choice.
inline constexpr u64 kHashSeed = 14695981039346656037ull;
[[nodiscard]] inline u64 hash_bytes(u64 h, const std::byte* p, std::size_t n) {
    for (std::size_t i = 0; i < n; ++i) h = (h ^ static_cast<u8>(p[i])) * 1099511628211ull;
    return h;
}
[[nodiscard]] inline u64 hash_seed(ChunkKind kind, u8 version = kFormatVersion) {
    const std::byte prefix[2] = {static_cast<std::byte>(version), static_cast<std::byte>(kind)};
    return hash_bytes(kHashSeed, prefix, sizeof prefix);
}

struct ManifestHeader {
    u32 entries;
    u32 programs;
    u32 revision;    // the oldest kFormatRevision that can read this image
    u32 frame_size;  // samples per frame this image was compiled for, with 0 meaning kOriginalFrameSize
};
static_assert(sizeof(ManifestHeader) == 16);

// Frame size is part of how an image sounds: it sets the control rate, what a snap can follow and how short a feedback
// loop can be. So an image states it, and an engine of another size refuses the image rather than playing it
// differently. Every image before revision 3 was written at 128, which is why 0 means that and 128 is never written.
inline constexpr u32 kOriginalFrameSize = 128;
inline constexpr u32 kFrameSizeRevision = 3;
inline constexpr u32 kMinFrameSize = 8;
inline constexpr u32 kMaxFrameSize = 1024;
[[nodiscard]] constexpr u32 frame_size_of(const ManifestHeader& h) {
    return h.frame_size == 0 ? kOriginalFrameSize : h.frame_size;
}
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
    u8 flags;  // reserved for streaming and compression, 0 until a revision defines them
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
#define MODSYNTH_OP(name, id, ...) name = id,
#include <modsynth/Opcodes.def>
    kCount
};

enum class BiquadMode : u8 { LowPass = 0, HighPass = 1, BandPass = 2 };
inline constexpr u8 kReadBeforeWrite = 1;
inline constexpr u8 kNaive = 1;          // Saw and Pulse with no anti-aliasing
inline constexpr u8 kSampleReverse = 1;  // Sample2 plays towards the start
inline constexpr u8 kSampleTail = 2;     // Sample2 leaves its loop on release and plays on to the end
enum class OscModMode : u8 { Sine, Triangle, Saw, Pulse, NaiveSaw, NaivePulse };
enum class MathMode : u8 { Min, Max, Abs, Clip, Floor, Divide, Compare, Select };

// A Sample2's Table is rows of this many f32, in this order, so a row is a key range, a velocity range, an index into
// the patch's refs, and the key the recording sounds at, which may be fractional. A row whose low key is above its high
// key matches nothing and is {1, 0, 0, 0, 0, 0, 0, 0}, which is how a table reaches a power of two.
enum ZoneField : u32 { kZoneLowKey, kZoneHighKey, kZoneLowVelocity, kZoneHighVelocity, kZoneRef, kZoneRoot };
inline constexpr u32 kZoneFields = 8;
// A Sample3's rows are twice as wide. They add a place in a round robin: a row plays only on the notes whose ordinal
// on the track, counted from 0, is `position` modulo `length`, with a length of 0 meaning always. And they add
// crossfades in velocity: a row's gain rises from 0 at its low velocity to 1 at low + fade in, and falls from 1 at
// high - fade out to 0 at its high velocity. A width of 0 is a hard edge. At most two rows sound at once.
enum Zone3Field : u32 { kZoneSeqPosition = 6, kZoneSeqLength, kZoneFadeIn, kZoneFadeOut };
inline constexpr u32 kZone3Fields = 16;
inline constexpr u32 kZone3Heads = 2;
inline constexpr u8 kSampleRelease = 4;  // Sample3 is silent until its note is released, and then plays its zone

enum class Arg : u8 { None, Buffer, Scalar, Either };  // Either takes a buffer or any scalar
enum class Resource : u8 { None, Table, Asset, Delay };

struct OpSignature {
    u8 outs;
    Arg out_kind;
    u8 ins;
    Arg in[4];
    Resource resource;
    u8 max_mode;
    bool control;
    bool ends;
};

[[nodiscard]] constexpr OpSignature op_signature(Op op) {
    switch (op) {
#define MODSYNTH_OP(name, id, outs, out_kind, ins, a, b, c, d, resource, max_mode, control, ends)   \
    case Op::name:                                                                                  \
        return {outs,     Arg::out_kind, ins, {Arg::a, Arg::b, Arg::c, Arg::d}, Resource::resource, \
                max_mode, control,       ends};
#include <modsynth/Opcodes.def>
        default:
            return {0, Arg::None, 0, {}, Resource::None, 0, false, false};
    }
}
[[nodiscard]] constexpr bool op_known(u8 op) { return op >= 1 && op < static_cast<u8>(Op::kCount); }

// The ops whose delay line holds 16-bit samples. Every step on one line must agree, and the line takes half the memory.
[[nodiscard]] constexpr bool op_line_i16(u8 op) {
    return op >= static_cast<u8>(Op::DelayWriteI16) && op <= static_cast<u8>(Op::AllpassI16);
}
// A delay line's samples, in floats of bulk memory, which is how the engine lays it out.
[[nodiscard]] constexpr u32 line_floats(u32 samples, bool i16) { return i16 ? (samples + 1) / 2 : samples; }

// The revision that added an opcode. An image must declare it, so an older engine reports "needs a newer engine" and
// not "damaged". Lines in Opcodes.def can't carry this, as they never change. A revision adding an opcode adds a line.
[[nodiscard]] constexpr u32 op_revision(Op op) {
    return op >= Op::DelayWriteI16 ? 8
           : op >= Op::Sample3     ? 7
           : op >= Op::OscMod      ? 6
           : op >= Op::KLfo2       ? 5
           : op >= Op::Sample2     ? 4
           : op >= Op::Tone        ? 2
           : op >= Op::Saw         ? 1
                                   : 0;
}

struct WireStep {
    u8 op;
    u8 mode;
    u16 resource;  // index into the patch's refs, or into its delay lines
    u32 state_id;  // stable across edits, so state can carry over a swap. 0 for none.
    u16 out[2];
    u16 in[4];
};
static_assert(sizeof(WireStep) == 20);

enum class ParamScope : u8 { Voice = 0, Track = 1, Global = 2 };

struct ParamDesc {
    u16 id;  // stable, and what Instructions address
    u8 scope;
    u8 reserved;
    u16 reg;  // in the bank for its scope. 0 for Global, whose operand index is this desc's position.
    u16 smooth_ms;
    float min;
    float max;
    float def;
};
static_assert(sizeof(ParamDesc) == 20);

// The body after this header, in order: ParamDesc[params] with ids ascending, u64 refs[refs], f32 consts[consts],
// f32 delays[delays] (maximum seconds), u16 in_ports[inputs * 2], WireStep[control_steps + voice_steps].
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
    u32 reserved;
};
static_assert(sizeof(PatchHeader) == 28);

enum class Instr : u8 {
#define MODSYNTH_INSTR(name, id, a, b, c) name = id,
#include <modsynth/Opcodes.def>
    kCount
};

struct InstrFields {
    bool a, b, c;
};

[[nodiscard]] constexpr InstrFields instr_fields(Instr instr) {
    switch (instr) {
#define MODSYNTH_INSTR(name, id, a, b, c) \
    case Instr::name:                     \
        return {a != 0, b != 0, c != 0};
#include <modsynth/Opcodes.def>
        default:
            return {false, false, false};
    }
}

// The same rule for instructions.
[[nodiscard]] constexpr u32 instr_revision(Instr instr) {
    return instr >= Instr::Steal ? 7 : instr >= Instr::SetInsert ? 4 : 0;
}

// Wait: c ticks. NoteOn: a note, b velocity 0..127, c duration in ticks. SetPatch: a slot. SetParam: b param id, c
// value bits. Ramp: b param id, c value bits, followed by RampArg. RampArg: c ticks. Call: b clip, c repeats. Tempo: c
// microseconds per quarter, conductor stream only. SetInsert and RampInsert: a insert, then as SetParam and Ramp.
// SetMix and RampMix: b mix register, c value bits, RampMix followed by RampArg. PlayMode: a PlayKind, b NotePriority,
// c glide seconds bits. Steal: a 1 to fade a stolen voice out, 0 to cut it.
struct Instruction {
    u8 op;
    u8 a;
    u16 b;
    u32 c;
};
static_assert(sizeof(Instruction) == 8);

// LegatoVelocity is legato in which a note that takes over brings its velocity too, since revision 7.
enum class PlayKind : u8 { Poly = 0, Mono = 1, Legato = 2, LegatoVelocity = 3 };
inline constexpr u32 kLegatoVelocityRevision = 7;
// Steal: a 0 cuts a stolen voice off, 1 fades it out over kStealFadeSeconds.
inline constexpr float kStealFadeSeconds = 0.002f;
// A legato note brings its velocity over its glide, or over this if the glide is shorter.
inline constexpr float kVelocityGlideSeconds = 0.005f;
enum class NotePriority : u8 { Last = 0, High = 1, Low = 2 };

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
    u32 slots;  // one more than the highest slot its SetPatch names, so a caller needs no walk over the clip
};
static_assert(sizeof(ClipDesc) == 16);

struct InsertDesc {
    u16 id;  // stable across edits
    u16 patch;
};

enum class MixOp : u8 {
#define MODSYNTH_MIX(name, id) name = id,
#include <modsynth/Opcodes.def>
};

struct MixStep {
    u8 op;
    u8 reserved;
    u16 task;  // steps sharing a task run together, in order
    u16 a;     // track, insert, or first GatherInput
    u16 dst;   // bus register
    u16 src;   // RunInsert: input register. Gather: input count. RunVoices: 0.
    u16 key;   // RunInsert: sidechain register, or kNone. Otherwise kNone.
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

// What a Program's streams use that costs memory at run time, so a Program that uses neither pays for neither. These
// are exactly what its code uses, and the validator refuses anything else.
inline constexpr u32 kFeatureMixRamps = 1;    // a RampMix
inline constexpr u32 kFeaturePlayModes = 2;   // a PlayMode
inline constexpr u32 kFeatureStealFades = 4;  // a Steal, since revision 7. Each track gets fade slots.
inline constexpr u32 kKnownFeatures = kFeatureMixRamps | kFeaturePlayModes | kFeatureStealFades;
// The voices a track with fading steals sets aside to fade in, which a stolen voice's sound moves to.
[[nodiscard]] constexpr u32 fade_slots(u32 voices) { return voices / 4 > 1 ? voices / 4 : 1; }

// The body after this header, in order: u64 patches[patches], TrackDesc[tracks], u16 slots[slots], ClipDesc[clips],
// InsertDesc[inserts], MixStep[mix_steps], GatherInput[gather_inputs], f32 mix_init[mix_regs], GlobalDesc[globals] with
// ids ascending, ParamInit[inits], Instruction[code].
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
    u32 features;
};
static_assert(sizeof(ProgramHeader) == 52);

}  // namespace modsynth
