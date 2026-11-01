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
    void clear() { count_ = 0; }

   private:
    std::span<ChunkRef> storage_;
    u32 count_ = 0;
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

// True if every step reads only what is defined, writes only where section 18 allows, and names real resources.
[[nodiscard]] inline bool validate_patch(const PatchView& p, const ChunkTable& chunks) {
    using detail::Bits;
    const PatchHeader& h = p.h;
    if (h.buffers > kMaxRegisters || h.voice_scalars > kMaxRegisters || h.track_scalars > kMaxRegisters ||
        h.params > kMaxRegisters || h.voice_scalars < kBuiltinVoiceScalars || h.inputs > 2) {
        return false;
    }

    Bits buffers, voice, track;
    for (u32 i = 0; i < kBuiltinVoiceScalars; ++i) voice.set(i);
    for (u32 i = 0; i < h.params; ++i) {
        const ParamDesc d = p.param(i);
        if (!std::isfinite(d.min) || !std::isfinite(d.max) || !std::isfinite(d.def) || d.min > d.max) return false;
        if (d.scope == static_cast<u8>(ParamScope::Voice)) {
            if (d.reg >= h.voice_scalars || d.reg < kBuiltinVoiceScalars) return false;
            voice.set(d.reg);
        } else if (d.scope == static_cast<u8>(ParamScope::Track)) {
            if (d.reg >= h.track_scalars) return false;
            track.set(d.reg);
        } else if (d.scope != static_cast<u8>(ParamScope::Global)) {
            return false;
        }
    }
    for (u32 i = 0; i < h.inputs * 2u; ++i) {
        const u16 port = p.in_port(i);
        if (port >= h.buffers) return false;
        buffers.set(port);
    }
    for (u32 i = 0; i < h.refs; ++i) {
        const u64 hash = p.ref(i);
        if (!chunks.find(hash, ChunkKind::Table) && !chunks.find(hash, ChunkKind::Asset)) return false;
    }
    for (u32 i = 0; i < h.consts; ++i) {
        if (!std::isfinite(p.constant(i))) return false;
    }
    for (u32 i = 0; i < h.delays; ++i) {
        const float seconds = p.delay(i);
        if (!(seconds > 0.0f) || seconds > 60.0f) return false;
    }

    const auto readable = [&](u16 o, Arg kind, bool control) {
        const u16 i = operand_index(o);
        switch (operand_bank(o)) {
            case Bank::Buffer:
                return kind == Arg::Buffer && !control && i < h.buffers && buffers.get(i);
            case Bank::Voice:
                return kind == Arg::Scalar && !control && i < h.voice_scalars && voice.get(i);
            case Bank::Track:
                return kind == Arg::Scalar && i < h.track_scalars && track.get(i);
            case Bank::Global:
                return kind == Arg::Scalar && i < h.params && p.param(i).scope == static_cast<u8>(ParamScope::Global);
            case Bank::Const:
                return kind == Arg::Scalar && i < h.consts;
            default:
                return false;
        }
    };
    // Section 18: a voice writes only voice scalars, control steps write only track scalars, nothing writes a global.
    const auto write = [&](u16 o, Arg kind, bool control) {
        const u16 i = operand_index(o);
        switch (operand_bank(o)) {
            case Bank::Buffer:
                if (kind != Arg::Buffer || control || i >= h.buffers) return false;
                buffers.set(i);
                return true;
            case Bank::Voice:
                if (kind != Arg::Scalar || control || i >= h.voice_scalars) return false;
                voice.set(i);
                return true;
            case Bank::Track:
                if (kind != Arg::Scalar || !control || i >= h.track_scalars) return false;
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
        if (!op_known(s.op)) return false;
        const Op op = static_cast<Op>(s.op);
        const OpSignature sig = op_signature(op);
        if (control && !sig.control) return false;
        for (u32 a = 0; a < sig.ins; ++a) {
            if (!readable(s.in[a], sig.in[a], control)) return false;
        }
        for (u32 a = 0; a < sig.outs; ++a) {
            if (!write(s.out[a], sig.out_kind, control)) return false;
        }
        switch (sig.resource) {
            case Resource::Table: {
                if (s.resource >= h.refs || !chunks.find(p.ref(s.resource), ChunkKind::Table)) return false;
                break;
            }
            case Resource::Asset: {
                if (s.resource >= h.refs || !chunks.find(p.ref(s.resource), ChunkKind::Asset)) return false;
                break;
            }
            case Resource::Delay:
                if (s.resource >= h.delays) return false;
                break;
            default:
                break;
        }
        if (op == Op::Biquad && s.mode > static_cast<u8>(BiquadMode::BandPass)) return false;
        if (op == Op::DelayRead && s.mode > kReadBeforeWrite) return false;
    }
    if (operand_bank(h.out_left) != Bank::Buffer || operand_bank(h.out_right) != Bank::Buffer) return false;
    const u16 left = operand_index(h.out_left), right = operand_index(h.out_right);
    return left < h.buffers && right < h.buffers && buffers.get(left) && buffers.get(right);
}

// True if a table's samples are usable. Pass one in slices, since it scans every sample.
[[nodiscard]] inline bool table_shape_ok(ByteSpan bytes, TableHeader& h) {
    if (bytes.size() < sizeof(TableHeader)) return false;
    h = load<TableHeader>(bytes.data());
    if (h.length < 2 || h.length > (1u << 24) || !std::has_single_bit(h.length)) return false;
    return (bytes.size() - sizeof(TableHeader)) / sizeof(float) == static_cast<std::size_t>(h.length) + 1;
}

[[nodiscard]] inline bool asset_shape_ok(ByteSpan bytes, AssetHeader& h) {
    if (bytes.size() < sizeof(AssetHeader)) return false;
    h = load<AssetHeader>(bytes.data());
    if (h.channels != 1 && h.channels != 2) return false;
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
// Walks a stream's instructions. `ticks` receives the sum of its Waits, which never wraps: it saturates.
[[nodiscard]] inline bool validate_stream(const ProgramView& p, u32 begin, u32 length, bool clip, bool conductor,
                                          u32 slots, u64& ticks) {
    if (begin > p.h.code || length > p.h.code - begin) return false;
    ticks = 0;
    for (u32 i = 0; i < length; ++i) {
        const Instruction in = p.instruction(begin + i);
        if (in.op >= static_cast<u8>(Instr::kCount)) return false;
        switch (static_cast<Instr>(in.op)) {
            case Instr::End:
                if (i + 1 != length) return false;
                break;
            case Instr::Wait:
                ticks += in.c;
                break;
            case Instr::NoteOn:
                if (conductor || in.a > 127 || in.b > 127 || in.c == 0) return false;
                break;
            case Instr::SetPatch:
                if (conductor || in.a >= slots) return false;
                break;
            case Instr::SetParam:
                if (conductor || !std::isfinite(std::bit_cast<float>(in.c))) return false;
                break;
            case Instr::Ramp: {
                if (conductor || !std::isfinite(std::bit_cast<float>(in.c)) || i + 1 >= length) return false;
                const Instruction arg = p.instruction(begin + i + 1);
                if (arg.op != static_cast<u8>(Instr::RampArg)) return false;
                ++i;
                break;
            }
            case Instr::Call:
                // Clips cannot nest, and a repeat must spend time, so no stream can spin without a Wait.
                if (conductor || clip || in.b >= p.h.clips || in.c == 0) return false;
                ticks += static_cast<u64>(p.clip(in.b).ticks) * in.c;
                break;
            case Instr::Tempo:
                if (!conductor || in.c < 1000 || in.c > 60000000) return false;
                break;
            default:
                return false;
        }
    }
    return true;
}
}  // namespace detail

[[nodiscard]] inline bool validate_program(const ProgramView& p, const ChunkTable& chunks) {
    using detail::Bits;
    const ProgramHeader& h = p.h;
    if (h.ppq == 0 || h.ppq > 65535 || h.uspq < 1000 || h.uspq > 60000000) return false;
    if (h.buses == 0 || h.buses > kMaxRegisters || h.tracks > kMaxRegisters || h.inserts > kMaxRegisters) return false;

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
    u64 ticks = 0;
    for (u32 i = 0; i < h.clips; ++i) {
        const ClipDesc c = p.clip(i);
        if (c.ticks == 0) return false;
        if (!detail::validate_stream(p, c.begin, c.length, true, false, 256, ticks)) return false;
        if (ticks != c.ticks) return false;
    }
    for (u32 i = 0; i < h.tracks; ++i) {
        const TrackDesc t = p.track(i);
        if (t.voices == 0 || t.voices > 256 || t.slot_count == 0) return false;
        if (t.slot_begin > h.slots || t.slot_count > h.slots - t.slot_begin) return false;
        if (!detail::validate_stream(p, t.stream_begin, t.stream_length, false, false, t.slot_count, ticks)) {
            return false;
        }
        // A clip can be called from tracks with different slot counts, so its SetPatch is checked per caller.
        for (u32 k = 0; k < t.stream_length; ++k) {
            const Instruction in = p.instruction(t.stream_begin + k);
            if (in.op == static_cast<u8>(Instr::Ramp)) ++k;
            if (in.op != static_cast<u8>(Instr::Call)) continue;
            const ClipDesc c = p.clip(in.b);
            for (u32 n = 0; n < c.length; ++n) {
                const Instruction ci = p.instruction(c.begin + n);
                if (ci.op == static_cast<u8>(Instr::Ramp)) ++n;
                if (ci.op == static_cast<u8>(Instr::SetPatch) && ci.a >= t.slot_count) return false;
            }
        }
    }
    if (!detail::validate_stream(p, h.conductor_begin, h.conductor_length, false, true, 0, ticks)) return false;

    for (u32 i = 0; i < h.inserts; ++i) {
        if (p.insert(i).patch >= h.patches) return false;
    }
    for (u32 i = 0; i < h.mix_regs; ++i) {
        if (!std::isfinite(p.mix_value(i))) return false;
    }
    for (u32 i = 0; i < h.globals; ++i) {
        if (!std::isfinite(p.global(i).value)) return false;
    }
    for (u32 i = 0; i < h.inits; ++i) {
        const ParamInit in = p.init(i);
        if (in.target_kind > 1 || in.target >= (in.target_kind == 0 ? h.tracks : h.inserts)) return false;
        if (!std::isfinite(in.value)) return false;
    }

    // Every global a patch reads must exist in this Program.
    for (u32 i = 0; i < h.patches; ++i) {
        const ChunkRef* c = chunks.find(p.patch(i), ChunkKind::Patch);
        PatchView v;
        if (!parse_patch({c->data, c->size}, v)) return false;
        for (u32 k = 0; k < v.h.params; ++k) {
            const ParamDesc d = v.param(k);
            if (d.scope != static_cast<u8>(ParamScope::Global)) continue;
            bool found = false;
            for (u32 g = 0; g < h.globals && !found; ++g) found = p.global(g).id == d.id;
            if (!found) return false;
        }
    }

    Bits defined, ran_track, ran_insert;
    u32 last_task = 0;
    for (u32 i = 0; i < h.mix_steps; ++i) {
        const MixStep m = p.mix_step(i);
        if (m.dst >= h.buses || m.task < last_task || m.task >= kMaxRegisters) return false;
        last_task = m.task;
        switch (static_cast<MixOp>(m.op)) {
            case MixOp::RunVoices:
                if (m.a >= h.tracks || ran_track.get(m.a)) return false;
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
                if (m.a > h.gather_inputs || m.src > h.gather_inputs - m.a) return false;
                for (u32 k = 0; k < m.src; ++k) {
                    const GatherInput in = p.gather_input(m.a + k);
                    if (in.src >= h.buses || !defined.get(in.src) || in.src == m.dst) return false;
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
    }
    return "unknown";
}

// Validates an image in slices. Chunks join the table as they verify, and all of them leave again if anything fails,
// so a bad image leaves the previous set intact.
class Loader {
   public:
    explicit Loader(ChunkTable& table) : table_(&table) {}

    void begin(ByteSpan image) {
        image_ = image;
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

    u32 parse_manifest() {
        if (reinterpret_cast<std::uintptr_t>(image_.data()) % kChunkAlign != 0) {
            fail(LoadError::BadManifest);  // samples are used in place, so they must be aligned
            return 1;
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
        if (manifest_.entries > kMaxChunks ||
            manifest_.entries > (ch.size - sizeof(ManifestHeader)) / sizeof(ManifestEntry)) {
            fail(LoadError::BadManifest);
            return 1;
        }
        entries_ = body + sizeof(ManifestHeader);
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
        if (!read_header(cursor_, ch) || ch.hash != e.hash || ch.size != e.size || ch.kind != e.kind ||
            ch.kind == static_cast<u8>(ChunkKind::Manifest) || ch.kind > static_cast<u8>(ChunkKind::Program)) {
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
        // A chunk the table already holds is discarded here: same hash, same bytes.
        if (!table_->find(ch.hash) && !table_->add({ch.hash, body, ch.size, ch.kind})) {
            fail(LoadError::TooManyChunks);
            return take;
        }
        cursor_ += sizeof(ChunkHeader) + padded(ch.size);
        ++entry_;
        scan_ = 0;
        return std::max(take, 1u);
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
            return std::max(take, 1u);
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
                return std::max(take, 1u);
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
            }
            return 1;
        }
        const ManifestEntry e = entry(entry_++);
        if (e.kind != static_cast<u8>(kind)) return 1;
        const ChunkRef* c = table_->find(e.hash);
        if (kind == ChunkKind::Patch) {
            PatchView v;
            if (!parse_patch({c->data, c->size}, v) || !validate_patch(v, *table_)) fail(LoadError::BadPatch);
            return c->size;
        }
        ProgramView v;
        if (!parse_program({c->data, c->size}, v) || !validate_program(v, *table_)) fail(LoadError::BadProgram);
        return c->size;
    }

    ChunkTable* table_;
    ByteSpan image_;
    ManifestHeader manifest_{};
    const std::byte* entries_ = nullptr;
    LoadStatus status_ = LoadStatus::Idle;
    LoadError error_ = LoadError::None;
    Phase phase_ = Phase::Manifest;
    u32 committed_ = 0;
    u32 entry_ = 0;
    u32 programs_ = 0;
    u32 scan_ = 0;
    u64 hash_ = 0;
    std::size_t cursor_ = 0;
};

}  // namespace modsynth
