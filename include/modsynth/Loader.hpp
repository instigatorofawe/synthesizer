#pragma once

// The trust boundary. Everything an image claims is checked here, on every target, before any of it reaches run time.
// Bounds checks use subtraction, because a sum wraps on 32-bit and a sealed image once read 57 KB past its section.

#include <algorithm>
#include <bit>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <span>

#include <modsynth/Format.hpp>

namespace modsynth {

struct ChunkRef {
    u64 hash;
    const std::byte* data;  // payload
    u32 size;
    u8 kind;
};

// Maps a hash to read-only bytes. The caller owns the storage and the bytes it points at.
class ChunkTable {
   public:
    ChunkTable() = default;
    explicit ChunkTable(std::span<ChunkRef> storage) : storage_(storage) {}

    [[nodiscard]] const ChunkRef* find(u64 hash) const {
        for (u32 i = 0; i < count_; ++i) {
            if (storage_[i].hash == hash) return &storage_[i];
        }
        return nullptr;
    }
    [[nodiscard]] const ChunkRef* find(u64 hash, ChunkKind kind) const {
        const ChunkRef* c = find(hash);
        return c && c->kind == static_cast<u8>(kind) ? c : nullptr;
    }
    [[nodiscard]] bool add(const ChunkRef& ref) {
        if (count_ == storage_.size()) return false;
        storage_[count_++] = ref;
        return true;
    }
    [[nodiscard]] u32 size() const { return count_; }
    void truncate(u32 count) { count_ = std::min(count, count_); }
    void clear() {
        count_ = 0;
        frame_size_ = 0;
    }
    // What the images loaded here were compiled for, or 0 if none has been. One table holds one frame size, so a
    // Program bound from it later is held to the same rule as an image.
    [[nodiscard]] u32 frame_size() const { return frame_size_; }
    void set_frame_size(u32 frame_size) { frame_size_ = frame_size; }

   private:
    std::span<ChunkRef> storage_;
    u32 count_ = 0;
    u32 frame_size_ = 0;
};

// A patch chunk with its sections located. Parsing checks only that the sections fit.
struct PatchView {
    const std::byte* base = nullptr;
    PatchHeader h{};
    u32 params = 0, refs = 0, consts = 0, delays = 0, in_ports = 0, steps = 0;

    [[nodiscard]] ParamDesc param(u32 i) const { return load<ParamDesc>(base + params + i * sizeof(ParamDesc)); }
    [[nodiscard]] u64 ref(u32 i) const { return load<u64>(base + refs + i * sizeof(u64)); }
    [[nodiscard]] float constant(u32 i) const { return load<float>(base + consts + i * sizeof(float)); }
    [[nodiscard]] float delay(u32 i) const { return load<float>(base + delays + i * sizeof(float)); }
    [[nodiscard]] u16 in_port(u32 i) const { return load<u16>(base + in_ports + i * sizeof(u16)); }
    [[nodiscard]] WireStep step(u32 i) const { return load<WireStep>(base + steps + i * sizeof(WireStep)); }
};

namespace detail {
class Sections {
   public:
    Sections(u32 size, u32 start) : remaining_(size - start), offset_(start) {}
    // Records where a section of `count` elements starts, or fails if it does not fit in what is left.
    bool take(u32& where, u32 count, u32 element, u32 align = 1) {
        const u32 pad = (align - offset_ % align) % align;
        if (pad > remaining_) return false;
        offset_ += pad;
        remaining_ -= pad;
        if (count > remaining_ / element) return false;
        where = offset_;
        offset_ += count * element;
        remaining_ -= count * element;
        return true;
    }
    [[nodiscard]] u32 remaining() const { return remaining_; }

   private:
    u32 remaining_;
    u32 offset_;
};

class Bits {
   public:
    void set(u32 i) { words_[i / 32] |= 1u << (i % 32); }
    [[nodiscard]] bool get(u32 i) const { return (words_[i / 32] >> (i % 32)) & 1u; }

   private:
    u32 words_[kMaxRegisters / 32] = {};
};

// True if a Sample2 can use this table. It is the table's job to be finite, and that was checked before any patch.
[[nodiscard]] inline bool zones_ok(const ChunkRef& table, const Bits& asset_refs, u32 refs) {
    const auto whole_in = [](float x, float low, float high) {
        return x >= low && x <= high && x == static_cast<float>(static_cast<std::int32_t>(x));
    };
    const u32 length = load<TableHeader>(table.data).length;
    if (length % kZoneFields != 0 || length / kZoneFields > kMaxZones) return false;
    for (u32 row = 0; row < length / kZoneFields; ++row) {
        float f[kZoneFields];
        for (u32 i = 0; i < kZoneFields; ++i) {
            f[i] = load<float>(table.data + sizeof(TableHeader) + (row * kZoneFields + i) * sizeof(float));
        }
        if (f[kZoneLowKey] > f[kZoneHighKey]) {  // Padding, and only in its one form
            if (f[kZoneLowKey] != 1.0f || f[kZoneHighKey] != 0.0f) return false;
            for (u32 i = kZoneLowVelocity; i < kZoneFields; ++i) {
                if (f[i] != 0.0f) return false;
            }
            continue;
        }
        if (!whole_in(f[kZoneLowKey], 0.0f, 127.0f) || !whole_in(f[kZoneHighKey], 0.0f, 127.0f)) return false;
        if (!whole_in(f[kZoneLowVelocity], 0.0f, 127.0f) || !whole_in(f[kZoneHighVelocity], 0.0f, 127.0f)) return false;
        if (f[kZoneLowVelocity] > f[kZoneHighVelocity]) return false;
        if (!(f[kZoneRoot] >= 0.0f && f[kZoneRoot] <= 127.0f)) return false;
        if (!whole_in(f[kZoneRef], 0.0f, static_cast<float>(refs) - 1.0f)) return false;
        if (!asset_refs.get(static_cast<u32>(f[kZoneRef]))) return false;
        for (u32 i = kZoneRoot + 1; i < kZoneFields; ++i) {
            if (f[i] != 0.0f) return false;
        }
    }
    return true;
}
}  // namespace detail

[[nodiscard]] inline bool parse_patch(ByteSpan bytes, PatchView& v) {
    if (bytes.size() < sizeof(PatchHeader)) return false;
    v.base = bytes.data();
    v.h = load<PatchHeader>(bytes.data());
    const u32 size = static_cast<u32>(bytes.size());
    detail::Sections s(size, sizeof(PatchHeader));
    const u32 steps = static_cast<u32>(v.h.control_steps) + v.h.voice_steps;
    return s.take(v.params, v.h.params, sizeof(ParamDesc)) && s.take(v.refs, v.h.refs, sizeof(u64)) &&
           s.take(v.consts, v.h.consts, sizeof(float), 4) && s.take(v.delays, v.h.delays, sizeof(float), 4) &&
           s.take(v.in_ports, static_cast<u32>(v.h.inputs) * 2, sizeof(u16)) &&
           s.take(v.steps, steps, sizeof(WireStep), 4) && s.remaining() == 0;
}

// True if every step reads only what is defined, writes only where section 18 of the design allows, and names real
// resources. Whatever a chunk does not use must be zero, so a later revision can give it a meaning.
[[nodiscard]] inline bool validate_patch(const PatchView& p, const ChunkTable& chunks, u32 revision) {
    using detail::Bits;
    const PatchHeader& h = p.h;
    if (h.reserved != 0 || static_cast<u32>(h.control_steps) + h.voice_steps > kMaxPatchSteps) return false;
    if (h.buffers > kMaxRegisters || h.voice_scalars > kMaxRegisters || h.track_scalars > kMaxRegisters ||
        h.params > kMaxPatchParams || h.refs > kMaxPatchRefs || h.delays > kMaxPatchDelays ||
        h.consts > kMaxPatchConsts || h.voice_scalars < kBuiltinVoiceScalars || h.inputs > 2) {
        return false;
    }

    // What is defined, and which scalars belong to the engine: the note, velocity and gate, and every parameter.
    Bits buffers, voice, track, engine_voice, engine_track;
    for (u32 i = 0; i < kBuiltinVoiceScalars; ++i) {
        voice.set(i);
        engine_voice.set(i);
    }
    for (u32 i = 0; i < h.params; ++i) {
        const ParamDesc d = p.param(i);
        if (d.reserved != 0 || (i > 0 && d.id <= p.param(i - 1).id)) return false;
        if (!std::isfinite(d.min) || !std::isfinite(d.max) || !std::isfinite(d.def)) return false;
        if (d.min > d.max || d.def < d.min || d.def > d.max) return false;
        if (d.scope == static_cast<u8>(ParamScope::Voice)) {
            if (d.reg >= h.voice_scalars || d.reg < kBuiltinVoiceScalars || engine_voice.get(d.reg)) return false;
            voice.set(d.reg);
            engine_voice.set(d.reg);
        } else if (d.scope == static_cast<u8>(ParamScope::Track)) {
            if (d.reg >= h.track_scalars || engine_track.get(d.reg)) return false;
            track.set(d.reg);
            engine_track.set(d.reg);
        } else if (d.scope != static_cast<u8>(ParamScope::Global) || d.reg != 0) {
            return false;
        }
    }
    for (u32 i = 0; i < h.inputs * 2u; ++i) {
        const u16 port = p.in_port(i);
        if (port >= h.buffers) return false;
        buffers.set(port);
    }
    Bits asset_refs, zones_checked;
    for (u32 i = 0; i < h.refs; ++i) {
        const u64 hash = p.ref(i);
        if (chunks.find(hash, ChunkKind::Asset)) {
            asset_refs.set(i);
        } else if (!chunks.find(hash, ChunkKind::Table)) {
            return false;
        }
    }
    for (u32 i = 0; i < h.consts; ++i) {
        if (!std::isfinite(p.constant(i))) return false;
    }
    for (u32 i = 0; i < h.delays; ++i) {
        const float seconds = p.delay(i);
        if (!(seconds > 0.0f) || seconds > kMaxDelaySeconds) return false;
    }

    const auto readable = [&](u16 o, Arg kind, bool control) {
        const u16 i = operand_index(o);
        const bool takes_buffer = kind == Arg::Buffer || kind == Arg::Either;
        const bool takes_scalar = kind == Arg::Scalar || kind == Arg::Either;
        switch (operand_bank(o)) {
            case Bank::Buffer:
                return takes_buffer && !control && i < h.buffers && buffers.get(i);
            case Bank::Voice:
                return takes_scalar && !control && i < h.voice_scalars && voice.get(i);
            case Bank::Track:
                return takes_scalar && i < h.track_scalars && track.get(i);
            case Bank::Global:
                return takes_scalar && i < h.params && p.param(i).scope == static_cast<u8>(ParamScope::Global);
            case Bank::Const:
                return takes_scalar && i < h.consts;
            default:
                return false;
        }
    };
    // Section 18: a voice writes only its own voice scalars, control steps write only track scalars, and nothing writes
    // a global. A Step leaves the engine's own scalars alone too, or a ramp and a Step would fight over one value.
    const auto write = [&](u16 o, Arg kind, bool control) {
        const u16 i = operand_index(o);
        switch (operand_bank(o)) {
            case Bank::Buffer:
                if (kind != Arg::Buffer || control || i >= h.buffers) return false;
                buffers.set(i);
                return true;
            case Bank::Voice:
                if (kind != Arg::Scalar || control || i >= h.voice_scalars || engine_voice.get(i)) return false;
                voice.set(i);
                return true;
            case Bank::Track:
                if (kind != Arg::Scalar || !control || i >= h.track_scalars || engine_track.get(i)) return false;
                track.set(i);
                return true;
            default:
                return false;
        }
    };

    const u32 total = static_cast<u32>(h.control_steps) + h.voice_steps;
    for (u32 i = 0; i < total; ++i) {
        const bool control = i < h.control_steps;
        const WireStep s = p.step(i);
        if (!op_known(s.op) || op_revision(static_cast<Op>(s.op)) > revision) return false;
        const OpSignature sig = op_signature(static_cast<Op>(s.op));
        if ((control && !sig.control) || s.mode > sig.max_mode) return false;
        for (u32 a = sig.ins; a < 4; ++a) {
            if (s.in[a] != 0) return false;
        }
        for (u32 a = sig.outs; a < 2; ++a) {
            if (s.out[a] != 0) return false;
        }
        for (u32 a = 0; a < sig.ins; ++a) {
            if (!readable(s.in[a], sig.in[a], control)) return false;
        }
        // Two outputs are written one after the other, so sharing a register would make the result depend on the
        // kernel.
        if (sig.outs == 2) {
            if (s.out[0] == s.out[1]) return false;
            for (u32 a = 0; a < sig.ins; ++a) {
                if (s.in[a] == s.out[0] || s.in[a] == s.out[1]) return false;
            }
        }
        for (u32 a = 0; a < sig.outs; ++a) {
            if (!write(s.out[a], sig.out_kind, control)) return false;
        }
        switch (sig.resource) {
            case Resource::Table: {
                if (s.resource >= h.refs) return false;
                const ChunkRef* table = chunks.find(p.ref(s.resource), ChunkKind::Table);
                if (!table) return false;
                // Once for each table, so many steps sharing one can't multiply the work.
                if (static_cast<Op>(s.op) == Op::Sample2 && !zones_checked.get(s.resource)) {
                    if (!detail::zones_ok(*table, asset_refs, h.refs)) return false;
                    zones_checked.set(s.resource);
                }
                break;
            }
            case Resource::Asset:
                if (s.resource >= h.refs || !chunks.find(p.ref(s.resource), ChunkKind::Asset)) return false;
                break;
            case Resource::Delay:
                if (s.resource >= h.delays) return false;
                break;
            case Resource::None:
                if (s.resource != 0) return false;
                break;
        }
    }
    if (operand_bank(h.out_left) != Bank::Buffer || operand_bank(h.out_right) != Bank::Buffer) return false;
    const u16 left = operand_index(h.out_left), right = operand_index(h.out_right);
    return left < h.buffers && right < h.buffers && buffers.get(left) && buffers.get(right);
}

// True if a table's samples are usable. Pass one in slices, since it scans every sample.
[[nodiscard]] inline bool table_shape_ok(ByteSpan bytes, TableHeader& h) {
    if (bytes.size() < sizeof(TableHeader)) return false;
    h = load<TableHeader>(bytes.data());
    if (h.reserved != 0 || h.length < 2 || h.length > (1u << 24) || !std::has_single_bit(h.length)) return false;
    return (bytes.size() - sizeof(TableHeader)) / sizeof(float) == static_cast<std::size_t>(h.length) + 1;
}

[[nodiscard]] inline bool asset_shape_ok(ByteSpan bytes, AssetHeader& h) {
    if (bytes.size() < sizeof(AssetHeader)) return false;
    h = load<AssetHeader>(bytes.data());
    if (h.flags != 0 || (h.channels != 1 && h.channels != 2)) return false;
    if (h.encoding > static_cast<u8>(AssetEncoding::F32) || h.root_key > 127) return false;
    if (!(h.native_rate >= 1.0f) || h.native_rate > 1e6f) return false;
    if (h.frames == 0 || h.frames > (1u << 30)) return false;
    if (h.loop_end != 0 && !(h.loop_start < h.loop_end && h.loop_end <= h.frames)) return false;
    const std::size_t sample = h.encoding == static_cast<u8>(AssetEncoding::I16) ? 2 : 4;
    const std::size_t body = bytes.size() - sizeof(AssetHeader);
    return body % (sample * h.channels) == 0 && body / (sample * h.channels) == static_cast<std::size_t>(h.frames) + 1;
}

struct ProgramView {
    const std::byte* base = nullptr;
    ProgramHeader h{};
    u32 patches = 0, tracks = 0, slots = 0, clips = 0, inserts = 0, mix = 0, gather = 0, mix_init = 0, globals = 0,
        inits = 0, code = 0;

    [[nodiscard]] u64 patch(u32 i) const { return load<u64>(base + patches + i * sizeof(u64)); }
    [[nodiscard]] TrackDesc track(u32 i) const { return load<TrackDesc>(base + tracks + i * sizeof(TrackDesc)); }
    [[nodiscard]] u16 slot(u32 i) const { return load<u16>(base + slots + i * sizeof(u16)); }
    [[nodiscard]] ClipDesc clip(u32 i) const { return load<ClipDesc>(base + clips + i * sizeof(ClipDesc)); }
    [[nodiscard]] InsertDesc insert(u32 i) const { return load<InsertDesc>(base + inserts + i * sizeof(InsertDesc)); }
    [[nodiscard]] MixStep mix_step(u32 i) const { return load<MixStep>(base + mix + i * sizeof(MixStep)); }
    [[nodiscard]] GatherInput gather_input(u32 i) const {
        return load<GatherInput>(base + gather + i * sizeof(GatherInput));
    }
    [[nodiscard]] float mix_value(u32 i) const { return load<float>(base + mix_init + i * sizeof(float)); }
    [[nodiscard]] GlobalDesc global(u32 i) const { return load<GlobalDesc>(base + globals + i * sizeof(GlobalDesc)); }
    [[nodiscard]] ParamInit init(u32 i) const { return load<ParamInit>(base + inits + i * sizeof(ParamInit)); }
    [[nodiscard]] Instruction instruction(u32 i) const {
        return load<Instruction>(base + code + i * sizeof(Instruction));
    }
};

[[nodiscard]] inline bool parse_program(ByteSpan bytes, ProgramView& v) {
    if (bytes.size() < sizeof(ProgramHeader)) return false;
    v.base = bytes.data();
    v.h = load<ProgramHeader>(bytes.data());
    const ProgramHeader& h = v.h;
    detail::Sections s(static_cast<u32>(bytes.size()), sizeof(ProgramHeader));
    return s.take(v.patches, h.patches, sizeof(u64)) && s.take(v.tracks, h.tracks, sizeof(TrackDesc)) &&
           s.take(v.slots, h.slots, sizeof(u16)) && s.take(v.clips, h.clips, sizeof(ClipDesc), 4) &&
           s.take(v.inserts, h.inserts, sizeof(InsertDesc)) && s.take(v.mix, h.mix_steps, sizeof(MixStep)) &&
           s.take(v.gather, h.gather_inputs, sizeof(GatherInput)) && s.take(v.mix_init, h.mix_regs, sizeof(float), 4) &&
           s.take(v.globals, h.globals, sizeof(GlobalDesc)) && s.take(v.inits, h.inits, sizeof(ParamInit)) &&
           s.take(v.code, h.code, sizeof(Instruction), 4) && s.remaining() == 0;
}

namespace detail {

enum class Stream : u8 { Track, Clip, Conductor };

struct StreamTotals {
    u64 ticks = 0;     // the sum of its Waits and Calls
    u64 expanded = 0;  // instructions run, with every repeat unrolled
    u32 slots = 0;     // one more than the highest slot its SetPatch names
    u32 features = 0;  // what its code uses, from the kFeature list
};

// Each addition is checked at once, and each addend fits well inside a u64, so neither total can wrap.
[[nodiscard]] inline bool validate_stream(const ProgramView& p, u32 begin, u32 length, Stream kind, u32 track_slots,
                                          u32 revision, StreamTotals& t) {
    if (begin > p.h.code || length > p.h.code - begin) return false;
    t = {};
    const bool conductor = kind == Stream::Conductor;
    for (u32 i = 0; i < length; ++i) {
        const Instruction in = p.instruction(begin + i);
        if (in.op >= static_cast<u8>(Instr::kCount) || instr_revision(static_cast<Instr>(in.op)) > revision)
            return false;
        const InstrFields used = instr_fields(static_cast<Instr>(in.op));
        if ((!used.a && in.a != 0) || (!used.b && in.b != 0) || (!used.c && in.c != 0)) return false;
        ++t.expanded;
        switch (static_cast<Instr>(in.op)) {
            case Instr::End:
                break;
            case Instr::Wait:
                t.ticks += in.c;
                break;
            case Instr::NoteOn:
                if (conductor || in.a > 127 || in.b > 127 || in.c == 0 || in.c > kMaxTicks) return false;
                break;
            case Instr::SetPatch:
                if (conductor) return false;
                t.slots = std::max<u32>(t.slots, in.a + 1u);
                break;
            case Instr::SetParam:
                if (conductor || !std::isfinite(std::bit_cast<float>(in.c))) return false;
                break;
            case Instr::SetInsert:
                if (conductor || in.a >= p.h.inserts || !std::isfinite(std::bit_cast<float>(in.c))) return false;
                break;
            case Instr::SetMix:
                if (conductor || in.b >= p.h.mix_regs || !std::isfinite(std::bit_cast<float>(in.c))) return false;
                break;
            case Instr::Ramp:
            case Instr::RampInsert:
            case Instr::RampMix: {
                if (conductor || !std::isfinite(std::bit_cast<float>(in.c)) || i + 1 >= length) return false;
                if (static_cast<Instr>(in.op) == Instr::RampInsert && in.a >= p.h.inserts) return false;
                if (static_cast<Instr>(in.op) == Instr::RampMix) {
                    if (in.b >= p.h.mix_regs) return false;
                    t.features |= kFeatureMixRamps;
                }
                const Instruction arg = p.instruction(begin + i + 1);
                if (arg.op != static_cast<u8>(Instr::RampArg) || arg.a != 0 || arg.b != 0) return false;
                if (arg.c == 0 || arg.c > kMaxTicks) return false;
                ++i;
                ++t.expanded;
                break;
            }
            case Instr::PlayMode: {
                const float glide = std::bit_cast<float>(in.c);
                if (conductor || in.a > static_cast<u8>(PlayKind::Legato)) return false;
                if (in.b > static_cast<u16>(NotePriority::Low) || !(glide >= 0.0f && glide <= kMaxGlideSeconds))
                    return false;
                if (in.a == static_cast<u8>(PlayKind::Poly) && in.b != 0)
                    return false;  // One voice per note has no choice
                t.features |= kFeaturePlayModes;
                break;
            }
            case Instr::Call: {
                // Clips cannot nest, and a repeat must spend time, so no stream can spin without a Wait.
                if (kind != Stream::Track || in.b >= p.h.clips || in.c == 0) return false;
                const ClipDesc clip = p.clip(in.b);
                if (clip.slots > track_slots) return false;
                t.ticks += static_cast<u64>(clip.ticks) * in.c;
                t.expanded += (static_cast<u64>(clip.length) + 1) * in.c;
                break;
            }
            case Instr::Tempo:
                if (!conductor || in.c < 1000 || in.c > 60000000) return false;
                break;
            default:
                return false;
        }
        if (t.ticks > kMaxTicks || t.expanded > kMaxExpanded) return false;
    }
    // A track and the conductor end with End, and only there. A clip returns to its caller, so it has none.
    for (u32 i = 0; i + 1 < length; ++i) {
        if (p.instruction(begin + i).op == static_cast<u8>(Instr::End)) return false;
    }
    if (kind == Stream::Clip) return length == 0 || p.instruction(begin + length - 1).op != static_cast<u8>(Instr::End);
    return length != 0 && p.instruction(begin + length - 1).op == static_cast<u8>(Instr::End);
}

}  // namespace detail

[[nodiscard]] inline bool validate_program(const ProgramView& p, const ChunkTable& chunks, u32 revision) {
    using detail::Bits;
    using detail::Stream;
    using detail::StreamTotals;
    const ProgramHeader& h = p.h;
    if ((h.features & ~kKnownFeatures) != 0) return false;
    if (h.ppq == 0 || h.ppq > 65535 || h.uspq < 1000 || h.uspq > 60000000) return false;
    if (h.buses == 0 || h.buses > kMaxRegisters || h.tracks > kMaxTracks || h.inserts > kMaxInserts) return false;
    if (h.patches > kMaxChunks || h.slots > kMaxSlots || h.clips > kMaxClips || h.mix_steps > kMaxMixSteps ||
        h.gather_inputs > kMaxGatherInputs || h.mix_regs > kMaxMixRegisters || h.globals > kMaxGlobals ||
        h.inits > kMaxInits) {
        return false;
    }

    for (u32 i = 0; i < h.patches; ++i) {
        if (!chunks.find(p.patch(i), ChunkKind::Patch)) return false;
    }
    for (u32 i = 0; i < h.slots; ++i) {
        if (p.slot(i) >= h.patches) return false;
        // Nothing fills an instrument's input ports, so they would read whatever the last patch left in scratch.
        const ChunkRef* c = chunks.find(p.patch(p.slot(i)), ChunkKind::Patch);
        PatchView v;
        if (!parse_patch({c->data, c->size}, v) || v.h.inputs != 0) return false;
    }
    StreamTotals totals;
    u32 features = 0;
    for (u32 i = 0; i < h.clips; ++i) {
        const ClipDesc c = p.clip(i);
        if (c.ticks == 0) return false;
        if (!detail::validate_stream(p, c.begin, c.length, Stream::Clip, 0, revision, totals)) return false;
        if (totals.ticks != c.ticks || totals.slots != c.slots) return false;
        features |= totals.features;
    }

    // Every track's slots follow the last's, so their sum is the table's size and no two tracks can share one.
    u32 next_slot = 0;
    u64 expanded = 0, length_ticks = 0;
    for (u32 i = 0; i < h.tracks; ++i) {
        const TrackDesc t = p.track(i);
        if (t.voices == 0 || t.voices > kMaxVoices || t.slot_count == 0 || t.slot_count > kMaxTrackSlots) return false;
        if (t.slot_begin != next_slot || t.slot_count > h.slots - next_slot) return false;
        next_slot += t.slot_count;
        for (u32 k = 0; k < i; ++k) {
            if (p.track(k).id == t.id) return false;
        }
        if (!detail::validate_stream(p, t.stream_begin, t.stream_length, Stream::Track, t.slot_count, revision,
                                     totals)) {
            return false;
        }
        if (totals.slots > t.slot_count) return false;
        features |= totals.features;
        expanded += totals.expanded;
        length_ticks = std::max(length_ticks, totals.ticks);
    }
    if (next_slot != h.slots || length_ticks != h.length_ticks || features != h.features) return false;
    if (!detail::validate_stream(p, h.conductor_begin, h.conductor_length, Stream::Conductor, 0, revision, totals)) {
        return false;
    }
    if (expanded + totals.expanded > kMaxExpanded) return false;

    for (u32 i = 0; i < h.inserts; ++i) {
        const InsertDesc in = p.insert(i);
        if (in.patch >= h.patches) return false;
        for (u32 k = 0; k < i; ++k) {
            if (p.insert(k).id == in.id) return false;
        }
    }
    for (u32 i = 0; i < h.mix_regs; ++i) {
        if (!std::isfinite(p.mix_value(i))) return false;
    }
    for (u32 i = 0; i < h.globals; ++i) {
        const GlobalDesc g = p.global(i);
        if (g.reserved != 0 || !std::isfinite(g.value) || (i > 0 && g.id <= p.global(i - 1).id)) return false;
    }
    for (u32 i = 0; i < h.inits; ++i) {
        const ParamInit in = p.init(i);
        if (in.reserved != 0 || in.target_kind > 1) return false;
        if (in.target >= (in.target_kind == 0 ? h.tracks : h.inserts) || !std::isfinite(in.value)) return false;
    }

    // Every global a patch reads must exist in this Program. Both lists are sorted, so a binary search is enough.
    const auto has_global = [&](u16 id) {
        u32 low = 0, high = h.globals;
        while (low < high) {
            const u32 middle = low + (high - low) / 2;
            const u16 found = p.global(middle).id;
            if (found == id) return true;
            if (found < id) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        return false;
    };
    for (u32 i = 0; i < h.patches; ++i) {
        const ChunkRef* c = chunks.find(p.patch(i), ChunkKind::Patch);
        PatchView v;
        if (!parse_patch({c->data, c->size}, v)) return false;
        for (u32 k = 0; k < v.h.params; ++k) {
            const ParamDesc d = v.param(k);
            if (d.scope == static_cast<u8>(ParamScope::Global) && !has_global(d.id)) return false;
        }
    }

    // The mixer. Every step overwrites its destination, so the only sums in a frame are inside a Gather or a RunVoices,
    // which are one step each. That is section 18's rule that a bus is gathered by one task.
    Bits defined, ran_track, ran_insert;
    u32 last_task = 0;
    for (u32 i = 0; i < h.mix_steps; ++i) {
        const MixStep m = p.mix_step(i);
        if (m.reserved != 0 || m.dst >= h.buses || m.task >= kMaxTasks) return false;
        if (m.task != last_task && m.task != last_task + 1) return false;
        if (i == 0 && m.task != 0) return false;
        last_task = m.task;
        switch (static_cast<MixOp>(m.op)) {
            case MixOp::RunVoices:
                if (m.a >= h.tracks || ran_track.get(m.a) || m.src != 0 || m.key != kNone) return false;
                ran_track.set(m.a);
                break;
            case MixOp::RunInsert: {
                if (m.a >= h.inserts || ran_insert.get(m.a)) return false;
                ran_insert.set(m.a);
                if (m.src >= h.buses || !defined.get(m.src)) return false;
                if (m.key != kNone && (m.key >= h.buses || !defined.get(m.key))) return false;
                const ChunkRef* c = chunks.find(p.patch(p.insert(m.a).patch), ChunkKind::Patch);
                PatchView v;
                if (!parse_patch({c->data, c->size}, v) || v.h.inputs == 0) return false;
                if (m.key != kNone && v.h.inputs < 2) return false;
                break;
            }
            case MixOp::Gather: {
                if (m.key != kNone || m.a > h.gather_inputs || m.src > h.gather_inputs - m.a) return false;
                for (u32 k = 0; k < m.src; ++k) {
                    const GatherInput in = p.gather_input(m.a + k);
                    if (in.reserved != 0 || in.src >= h.buses || !defined.get(in.src) || in.src == m.dst) return false;
                    if (in.gain_left >= h.mix_regs || in.gain_right >= h.mix_regs) return false;
                }
                break;
            }
            default:
                return false;
        }
        defined.set(m.dst);
    }
    return h.master < h.buses && defined.get(h.master);
}

enum class LoadStatus : u8 { Idle, Working, Ready, Failed };
enum class LoadError : u8 {
    None,
    BadManifest,
    BadChunk,
    BadHash,
    MissingChunk,
    TooManyChunks,
    BadTable,
    BadAsset,
    BadPatch,
    BadProgram,
    OutOfMemory,
    TooNew,
    WrongFrameSize,
};

[[nodiscard]] inline const char* to_string(LoadError e) {
    switch (e) {
        case LoadError::None:
            return "none";
        case LoadError::BadManifest:
            return "bad manifest";
        case LoadError::BadChunk:
            return "bad chunk header";
        case LoadError::BadHash:
            return "chunk hash mismatch";
        case LoadError::MissingChunk:
            return "image needs a chunk the receiver does not have";
        case LoadError::TooManyChunks:
            return "too many chunks";
        case LoadError::BadTable:
            return "bad table";
        case LoadError::BadAsset:
            return "bad asset";
        case LoadError::BadPatch:
            return "bad patch";
        case LoadError::BadProgram:
            return "bad program";
        case LoadError::OutOfMemory:
            return "not enough memory for this program";
        case LoadError::TooNew:
            return "image needs a newer engine";
        case LoadError::WrongFrameSize:
            return "image was compiled for another frame size";
    }
    return "unknown";
}

// The frame size an image says it was compiled for, or 0 if it is too short to say. A host with engines at several
// sizes uses this to pick one. It proves nothing about the image, which the chosen engine then validates.
[[nodiscard]] inline u32 image_frame_size(ByteSpan image) {
    if (image.size() < sizeof(ChunkHeader) + sizeof(ManifestHeader)) return 0;
    return frame_size_of(load<ManifestHeader>(image.data() + sizeof(ChunkHeader)));
}

// Validates an image in slices. Chunks join the table as they verify, and all of them leave again if anything fails,
// so a bad image leaves the previous set intact.
class Loader {
   public:
    Loader() = default;
    explicit Loader(ChunkTable& table) : table_(&table) {}

    // With a non-zero `frame_size`, an image compiled for another size fails with WrongFrameSize. Zero is for tools
    // that read any image. The table's frame size applies either way.
    void begin(ByteSpan image, u32 frame_size = 0) {
        image_ = image;
        expected_frame_size_ = frame_size;
        status_ = LoadStatus::Working;
        error_ = LoadError::None;
        phase_ = Phase::Manifest;
        committed_ = table_->size();
        entry_ = 0;
        cursor_ = 0;
        scan_ = 0;
    }

    // Does roughly `budget` units of work, where a unit is a byte hashed or a sample, step or section checked.
    LoadStatus step(u32 budget) {
        while (status_ == LoadStatus::Working && budget > 0) {
            switch (phase_) {
                case Phase::Manifest:
                    budget -= std::min(budget, parse_manifest());
                    break;
                case Phase::Hash:
                    budget -= std::min(budget, verify_chunk(budget));
                    break;
                case Phase::Resolve:
                    budget -= std::min(budget, resolve_entry());
                    break;
                case Phase::Contents:
                    budget -= std::min(budget, check_contents(budget));
                    break;
                case Phase::Patches:
                    budget -= std::min(budget, check_definition(ChunkKind::Patch));
                    break;
                case Phase::Programs:
                    budget -= std::min(budget, check_definition(ChunkKind::Program));
                    break;
            }
        }
        return status_;
    }

    [[nodiscard]] LoadStatus status() const { return status_; }
    [[nodiscard]] LoadError error() const { return error_; }
    [[nodiscard]] u32 programs() const { return programs_; }
    [[nodiscard]] u32 frame_size() const { return frame_size_of(manifest_); }

    // The hash of the nth Program in the manifest. Valid once Ready.
    [[nodiscard]] u64 program_hash(u32 index) const {
        u32 seen = 0;
        for (u32 i = 0; i < manifest_.entries; ++i) {
            const ManifestEntry e = entry(i);
            if (e.kind != static_cast<u8>(ChunkKind::Program)) continue;
            if (seen++ == index) return e.hash;
        }
        return 0;
    }

   private:
    enum class Phase : u8 { Manifest, Hash, Resolve, Contents, Patches, Programs };

    [[nodiscard]] ManifestEntry entry(u32 i) const { return load<ManifestEntry>(entries_ + i * sizeof(ManifestEntry)); }

    void fail(LoadError e) {
        table_->truncate(committed_);
        error_ = e;
        status_ = LoadStatus::Failed;
    }

    // Reads the chunk header at `at`, returning false if it does not fit in the image.
    [[nodiscard]] bool read_header(std::size_t at, ChunkHeader& out) const {
        if (at > image_.size() || image_.size() - at < sizeof(ChunkHeader)) return false;
        out = load<ChunkHeader>(image_.data() + at);
        if (out.magic != kChunkMagic || out.version != kFormatVersion) return false;
        if (out.reserved != 0 || out.reserved2 != 0) return false;  // Outside the hash, so checked here
        return out.size <= image_.size() - at - sizeof(ChunkHeader);
    }

    [[nodiscard]] static std::size_t padded(std::size_t n) { return (n + kChunkAlign - 1) / kChunkAlign * kChunkAlign; }

    // True if the bytes after a chunk's payload are all there, and are zero.
    [[nodiscard]] bool padding_ok(std::size_t end, u32 size) const {
        const std::size_t pad = padded(size) - size;
        if (pad > image_.size() - end) return false;
        for (std::size_t i = 0; i < pad; ++i) {
            if (image_[end + i] != std::byte{0}) return false;
        }
        return true;
    }

    // True if the list is the one layout an image may have: assets, tables, patches and Programs, in that order, with
    // the first three each sorted by hash. Sorting also makes a repeat impossible.
    [[nodiscard]] bool entries_ok() const {
        u32 programs = 0;
        for (u32 i = 0; i < manifest_.entries; ++i) {
            const ManifestEntry e = entry(i);
            if (e.reserved != 0 || e.present > 1) return false;
            if (e.kind < static_cast<u8>(ChunkKind::Asset) || e.kind > static_cast<u8>(ChunkKind::Program))
                return false;
            programs += e.kind == static_cast<u8>(ChunkKind::Program);
            if (i == 0) continue;
            const ManifestEntry previous = entry(i - 1);
            if (e.kind < previous.kind) return false;
            if (e.kind == previous.kind && e.kind != static_cast<u8>(ChunkKind::Program) && e.hash <= previous.hash) {
                return false;
            }
        }
        return programs == manifest_.programs;
    }

    // One encoding for each size, and a size other than the original needs an engine that knows to look at this field.
    [[nodiscard]] bool frame_size_ok() const {
        const u32 size = manifest_.frame_size;
        return size == 0 || (size != kOriginalFrameSize && std::has_single_bit(size) && size >= kMinFrameSize &&
                             size <= kMaxFrameSize && manifest_.revision >= kFrameSizeRevision);
    }

    u32 parse_manifest() {
        if (reinterpret_cast<std::uintptr_t>(image_.data()) % kChunkAlign != 0) {
            fail(LoadError::BadManifest);  // samples are used in place, so they must be aligned
            return 1;
        }
        // A version from the future is the one failure a user can act on, so it gets its own error.
        if (image_.size() >= sizeof(ChunkHeader)) {
            const ChunkHeader first = load<ChunkHeader>(image_.data());
            if (first.magic == kChunkMagic && first.version > kFormatVersion) {
                fail(LoadError::TooNew);
                return 1;
            }
        }
        ChunkHeader ch;
        if (!read_header(0, ch) || ch.kind != static_cast<u8>(ChunkKind::Manifest) ||
            ch.size < sizeof(ManifestHeader)) {
            fail(LoadError::BadManifest);
            return 1;
        }
        const std::byte* body = image_.data() + sizeof(ChunkHeader);
        if (hash_bytes(hash_seed(ChunkKind::Manifest), body, ch.size) != ch.hash) {
            fail(LoadError::BadHash);
            return 1;
        }
        manifest_ = load<ManifestHeader>(body);
        if (manifest_.revision > kFormatRevision) {
            fail(LoadError::TooNew);
            return 1;
        }
        entries_ = body + sizeof(ManifestHeader);
        // Exactly the header and its entries, which is a multiple of the chunk alignment, so a manifest has no padding.
        const bool sized = manifest_.entries <= kMaxChunks &&
                           (ch.size - sizeof(ManifestHeader)) / sizeof(ManifestEntry) == manifest_.entries &&
                           (ch.size - sizeof(ManifestHeader)) % sizeof(ManifestEntry) == 0;
        if (!frame_size_ok() || !sized || !entries_ok()) {
            fail(LoadError::BadManifest);
            return 1;
        }
        const u32 frame_size = frame_size_of(manifest_);
        if ((expected_frame_size_ != 0 && frame_size != expected_frame_size_) ||
            (table_->size() != 0 && frame_size != table_->frame_size())) {
            fail(LoadError::WrongFrameSize);
            return 1;
        }
        programs_ = manifest_.programs;
        cursor_ = sizeof(ChunkHeader) + padded(ch.size);
        phase_ = Phase::Hash;
        entry_ = 0;
        scan_ = 0;
        hash_ = 0;
        return ch.size;
    }

    u32 verify_chunk(u32 budget) {
        if (entry_ == manifest_.entries) {
            if (cursor_ != image_.size()) {
                fail(LoadError::BadChunk);  // Nothing may follow the last chunk
                return 1;
            }
            phase_ = Phase::Resolve;
            entry_ = 0;
            return 1;
        }
        const ManifestEntry e = entry(entry_);
        if (!e.present) {
            ++entry_;
            return 1;
        }
        ChunkHeader ch;
        if (!read_header(cursor_, ch) || ch.hash != e.hash || ch.size != e.size || ch.kind != e.kind) {
            fail(LoadError::BadChunk);
            return 1;
        }
        const std::byte* body = image_.data() + cursor_ + sizeof(ChunkHeader);
        if (scan_ == 0) hash_ = hash_seed(static_cast<ChunkKind>(ch.kind));
        const u32 take = std::min(budget, ch.size - scan_);
        hash_ = hash_bytes(hash_, body + scan_, take);
        scan_ += take;
        if (scan_ < ch.size) return take;

        if (hash_ != ch.hash) {
            fail(LoadError::BadHash);
            return take;
        }
        if (!padding_ok(cursor_ + sizeof(ChunkHeader) + ch.size, ch.size)) {
            fail(LoadError::BadChunk);
            return take;
        }
        // A chunk the table already holds is discarded here: same hash, same bytes.
        if (!table_->find(ch.hash) && !table_->add({ch.hash, body, ch.size, ch.kind})) {
            fail(LoadError::TooManyChunks);
            return take;
        }
        cursor_ += sizeof(ChunkHeader) + padded(ch.size);
        ++entry_;
        scan_ = 0;
        return std::max<u32>(take, 1);
    }

    u32 resolve_entry() {
        if (entry_ == manifest_.entries) {
            phase_ = Phase::Contents;
            entry_ = 0;
            scan_ = 0;
            return 1;
        }
        const ManifestEntry e = entry(entry_++);
        const ChunkRef* c = table_->find(e.hash);
        if (!c || c->kind != e.kind || c->size != e.size) fail(LoadError::MissingChunk);
        return 1;
    }

    u32 check_contents(u32 budget) {
        if (entry_ == manifest_.entries) {
            phase_ = Phase::Patches;
            entry_ = 0;
            return 1;
        }
        const ManifestEntry e = entry(entry_);
        const ChunkRef* c = table_->find(e.hash);
        if (e.kind == static_cast<u8>(ChunkKind::Table)) {
            TableHeader h;
            if (!table_shape_ok({c->data, c->size}, h)) {
                fail(LoadError::BadTable);
                return 1;
            }
            const u32 count = h.length + 1;
            const u32 take = std::min(budget, count - scan_);
            for (u32 i = 0; i < take; ++i) {
                if (!std::isfinite(load<float>(c->data + sizeof(TableHeader) + (scan_ + i) * sizeof(float)))) {
                    fail(LoadError::BadTable);
                    return take;
                }
            }
            scan_ += take;
            if (scan_ == count) {
                scan_ = 0;
                ++entry_;
            }
            return std::max<u32>(take, 1);
        }
        if (e.kind == static_cast<u8>(ChunkKind::Asset)) {
            AssetHeader h;
            if (!asset_shape_ok({c->data, c->size}, h)) {
                fail(LoadError::BadAsset);
                return 1;
            }
            if (h.encoding == static_cast<u8>(AssetEncoding::F32)) {
                const u32 count = (h.frames + 1) * h.channels;
                const u32 take = std::min(budget, count - scan_);
                for (u32 i = 0; i < take; ++i) {
                    if (!std::isfinite(load<float>(c->data + sizeof(AssetHeader) + (scan_ + i) * sizeof(float)))) {
                        fail(LoadError::BadAsset);
                        return take;
                    }
                }
                scan_ += take;
                if (scan_ == count) {
                    scan_ = 0;
                    ++entry_;
                }
                return std::max<u32>(take, 1);
            }
        }
        ++entry_;
        return 1;
    }

    u32 check_definition(ChunkKind kind) {
        if (entry_ == manifest_.entries) {
            if (kind == ChunkKind::Patch) {
                phase_ = Phase::Programs;
                entry_ = 0;
            } else {
                status_ = LoadStatus::Ready;
                committed_ = table_->size();
                table_->set_frame_size(frame_size_of(manifest_));
            }
            return 1;
        }
        const ManifestEntry e = entry(entry_++);
        if (e.kind != static_cast<u8>(kind)) return 1;
        const ChunkRef* c = table_->find(e.hash);
        if (kind == ChunkKind::Patch) {
            PatchView v;
            if (!parse_patch({c->data, c->size}, v) || !validate_patch(v, *table_, manifest_.revision)) {
                fail(LoadError::BadPatch);
            }
            return c->size;
        }
        ProgramView v;
        if (!parse_program({c->data, c->size}, v) || !validate_program(v, *table_, manifest_.revision)) {
            fail(LoadError::BadProgram);
        }
        return c->size;
    }

    ChunkTable* table_ = nullptr;
    ByteSpan image_;
    ManifestHeader manifest_{};
    const std::byte* entries_ = nullptr;
    LoadStatus status_ = LoadStatus::Idle;
    LoadError error_ = LoadError::None;
    Phase phase_ = Phase::Manifest;
    u32 committed_ = 0;
    u32 expected_frame_size_ = 0;
    u32 entry_ = 0;
    u32 programs_ = 0;
    u32 scan_ = 0;
    u64 hash_ = 0;
    std::size_t cursor_ = 0;
};

}  // namespace modsynth
