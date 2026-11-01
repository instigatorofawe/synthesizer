#pragma once

// Structure-aware mutation. Flipping bytes in an image teaches a fuzzer about hashes and nothing else, so this keeps a
// list of chunks, changes what is inside them, and seals the result: new hashes, references that follow them, the
// sorted order the manifest demands. Most inputs therefore reach the validator's deepest rules, and a small share of
// them, whose counts or container are damaged on purpose, cover the shallow ones.
//
// It allocates nothing and uses no floats, so it runs and gives the same bytes on every target.

#include <algorithm>
#include <bit>
#include <cstddef>
#include <cstring>
#include <limits>
#include <span>

#include <modsynth/Format.hpp>
#include <modsynth/Loader.hpp>

#include "Rng.hpp"

namespace modsynth::fuzz {

inline constexpr u32 kMaxPieces = 48;

template <class T>
void store(std::byte* at, const T& value) {
    std::memcpy(at, &value, sizeof(T));
}

class Workspace {
   public:
    explicit Workspace(std::span<std::byte> arena) : arena_(arena) {}

    // Takes a well-formed image apart. Returns false if it does not fit.
    [[nodiscard]] bool parse(ByteSpan image) {
        count_ = 0;
        used_ = 0;
        const auto header = load<ChunkHeader>(image.data());
        const std::byte* entries = image.data() + sizeof(ChunkHeader) + sizeof(ManifestHeader);
        const u32 total = load<ManifestHeader>(image.data() + sizeof(ChunkHeader)).entries;
        std::size_t cursor = sizeof(ChunkHeader) + aligned(header.size);
        for (u32 i = 0; i < total; ++i) {
            const ManifestEntry e = load<ManifestEntry>(entries + i * sizeof(ManifestEntry));
            if (count_ == kMaxPieces) return false;
            Piece& p = pieces_[count_];
            p = {used_, 0, e.hash, e.hash, e.kind, e.present != 0};
            if (e.present) {
                if (used_ + e.size > arena_.size()) return false;
                std::memcpy(arena_.data() + used_, image.data() + cursor + sizeof(ChunkHeader), e.size);
                p.size = e.size;
                used_ += e.size;
                cursor += sizeof(ChunkHeader) + aligned(e.size);
            }
            ++count_;
        }
        return true;
    }

    // One to a few changes, chosen by `r`. `donor` is another well-formed image to borrow chunks from.
    void mutate(Rng& r, ByteSpan donor) {
        const u32 changes = 1 + r.below(4);
        for (u32 i = 0; i < changes; ++i) mutate_once(r, donor);
    }

    // Writes the image these chunks make, and returns its size, or 0 if it does not fit in `out`.
    [[nodiscard]] std::size_t seal(std::span<std::byte> out) {
        follow_hashes();
        sort();

        const std::size_t manifest_size = sizeof(ManifestHeader) + count_ * sizeof(ManifestEntry);
        std::size_t total = sizeof(ChunkHeader) + aligned(manifest_size);
        for (u32 i = 0; i < count_; ++i) {
            if (pieces_[i].present) total += sizeof(ChunkHeader) + aligned(pieces_[i].size);
        }
        if (total > out.size()) return 0;
        std::memset(out.data(), 0, total);

        u32 programs = 0;
        std::byte* entry = out.data() + sizeof(ChunkHeader) + sizeof(ManifestHeader);
        for (u32 i = 0; i < count_; ++i) {
            const Piece& p = pieces_[i];
            programs += p.kind == static_cast<u8>(ChunkKind::Program);
            store(entry + i * sizeof(ManifestEntry),
                  ManifestEntry{p.hash, p.size, p.kind, static_cast<u8>(p.present), 0});
        }
        store(out.data() + sizeof(ChunkHeader), ManifestHeader{count_, programs, kFormatRevision, 0});
        write_header(out.data(), ChunkKind::Manifest, static_cast<u32>(manifest_size),
                     hash_bytes(hash_seed(ChunkKind::Manifest), out.data() + sizeof(ChunkHeader), manifest_size));

        std::size_t cursor = sizeof(ChunkHeader) + aligned(manifest_size);
        for (u32 i = 0; i < count_; ++i) {
            const Piece& p = pieces_[i];
            if (!p.present) continue;
            write_header(out.data() + cursor, static_cast<ChunkKind>(p.kind), p.size, p.hash);
            if (p.size != 0) std::memcpy(out.data() + cursor + sizeof(ChunkHeader), arena_.data() + p.at, p.size);
            cursor += sizeof(ChunkHeader) + aligned(p.size);
        }
        return total;
    }

    // Damages the container of a sealed image, which only the first checks in the loader can then see. Sometimes it
    // reseals the manifest, so the damage gets past the manifest's own hash.
    static std::size_t damage(std::span<std::byte> image, std::size_t size, Rng& r) {
        if (size < sizeof(ChunkHeader) + sizeof(ManifestHeader)) return size;
        const u32 manifest_size = load<ChunkHeader>(image.data()).size;
        switch (r.below(6)) {
            case 0:
                return r.below(static_cast<u32>(size));  // Truncate
            case 1:
                if (size + 8 <= image.size()) {
                    std::memset(image.data() + size, r.chance(50) ? 0 : 0xFF, 8);
                    return size + 8;
                }
                return size;
            case 2: {  // A header field anywhere, usually a size or a magic
                const std::size_t at = r.below(static_cast<u32>(size) / 8) * 8;
                store(image.data() + at + r.below(6) * 4, interesting(r));
                return size;
            }
            case 3:
                image[r.below(static_cast<u32>(size))] ^= static_cast<std::byte>(1u << r.below(8));
                return size;
            default: {  // Inside the manifest, then reseal it
                if (manifest_size < sizeof(ManifestHeader) || manifest_size > size - sizeof(ChunkHeader)) {
                    return size;
                }
                const u32 at = sizeof(ChunkHeader) + r.below(manifest_size / 4) * 4;
                store(image.data() + at, interesting(r));
                store(image.data() + offsetof(ChunkHeader, hash),
                      hash_bytes(hash_seed(ChunkKind::Manifest), image.data() + sizeof(ChunkHeader), manifest_size));
                return size;
            }
        }
    }

   private:
    struct Piece {
        u32 at;
        u32 size;
        u64 hash;       // as of the last seal, which is what other chunks still call it
        u64 next_hash;  // what it is called from this seal on
        u8 kind;
        bool present;
    };

    [[nodiscard]] static std::size_t aligned(std::size_t n) {
        return (n + kChunkAlign - 1) / kChunkAlign * kChunkAlign;
    }

    static void write_header(std::byte* at, ChunkKind kind, u32 size, u64 hash) {
        ChunkHeader h{};
        h.magic = kChunkMagic;
        h.kind = static_cast<u8>(kind);
        h.version = kFormatVersion;
        h.size = size;
        h.hash = hash;
        store(at, h);
    }

    // Values that have broken bounds checks before, or sit exactly on a limit.
    [[nodiscard]] static u32 interesting(Rng& r) {
        static constexpr u32 values[] = {0,          1,          2,         3,          7,          8,
                                         0x7F,       0x80,       0xFF,      0x100,      0x400,      0x1000,
                                         0x2000,     0x7FFF,     0x8000,    0xFFFF,     0x10000,    kMaxExpanded,
                                         0x20000000, 0x40000000, kMaxTicks, 0x80000000, 0xFFFFFFF8, 0xFFFFFFFF};
        return values[r.below(std::size(values))];
    }

    [[nodiscard]] static u32 odd_float(Rng& r) {
        static constexpr u32 values[] = {0x7FC00000, 0x7F800000, 0xFF800000, 0x7F7FFFFF, 0xFF7FFFFF, 0x00000001,
                                         0x80000000, 0x3F800000, 0xBF800000, 0x42F00000, 0x47000000, 0x5F000000,
                                         0x4F800000, 0x4F000000, 0x00800000, 0x42700000};
        return values[r.below(std::size(values))];
    }

    [[nodiscard]] std::byte* base(const Piece& p) { return arena_.data() + p.at; }
    [[nodiscard]] ByteSpan bytes(const Piece& p) const { return {arena_.data() + p.at, p.size}; }

    // Opens `delta` bytes at `offset` in a chunk, or closes them. Returns false if there is no room.
    bool resize(Piece& p, u32 offset, std::int32_t delta) {
        if (delta < 0 && static_cast<u32>(-delta) > p.size - std::min(p.size, offset)) return false;
        if (delta > 0 && used_ + static_cast<u32>(delta) > arena_.size()) return false;
        const u32 from = p.at + offset + (delta < 0 ? static_cast<u32>(-delta) : 0);
        const u32 to = p.at + offset + (delta > 0 ? static_cast<u32>(delta) : 0);
        std::memmove(arena_.data() + to, arena_.data() + from, used_ - from);
        if (delta > 0) std::memset(arena_.data() + from, 0, static_cast<u32>(delta));
        const u32 mine = p.at;
        for (u32 i = 0; i < count_; ++i) {
            if (&pieces_[i] != &p && pieces_[i].at > mine) pieces_[i].at += static_cast<u32>(delta);
        }
        p.size += static_cast<u32>(delta);
        used_ += static_cast<u32>(delta);
        return true;
    }

    void mutate_once(Rng& r, ByteSpan donor) {
        if (count_ == 0) return;
        const u32 roll = r.below(100);
        if (roll < 40) {
            if (Piece* p = pick(r, ChunkKind::Patch)) mutate_patch(*p, r);
        } else if (roll < 75) {
            if (Piece* p = pick(r, ChunkKind::Program)) mutate_program(*p, r);
        } else if (roll < 82) {
            if (Piece* p = pick(r, ChunkKind::Asset)) mutate_asset(*p, r);
        } else if (roll < 87) {
            if (Piece* p = pick(r, ChunkKind::Table)) mutate_table(*p, r);
        } else if (roll < 95) {
            mutate_set(r, donor);
        } else {
            Piece& p = pieces_[r.below(count_)];
            if (p.size >= 4) store(base(p) + r.below(p.size / 4) * 4, interesting(r));
        }
    }

    [[nodiscard]] Piece* pick(Rng& r, ChunkKind kind) {
        u32 matching = 0;
        for (u32 i = 0; i < count_; ++i) matching += pieces_[i].kind == static_cast<u8>(kind) && pieces_[i].present;
        if (matching == 0) return nullptr;
        u32 chosen = r.below(matching);
        for (u32 i = 0; i < count_; ++i) {
            if (pieces_[i].kind != static_cast<u8>(kind) || !pieces_[i].present) continue;
            if (chosen-- == 0) return &pieces_[i];
        }
        return nullptr;
    }

    // Which chunks there are: drop one, leave one out as a thin image does, or borrow one from another image.
    void mutate_set(Rng& r, ByteSpan donor) {
        Piece& p = pieces_[r.below(count_)];
        switch (r.below(4)) {
            case 0:
                p.present = false;
                break;
            case 1:
                if (count_ > 1) {
                    resize(p, 0, -static_cast<std::int32_t>(p.size));
                    p = pieces_[--count_];
                }
                break;
            case 2:
                p.kind = static_cast<u8>(1 + r.below(4));  // Same bytes under another kind's rules
                break;
            default:
                borrow(r, donor);
        }
    }

    void borrow(Rng& r, ByteSpan donor) {
        if (count_ == kMaxPieces || donor.size() < sizeof(ChunkHeader) + sizeof(ManifestHeader)) return;
        std::size_t cursor = sizeof(ChunkHeader) + aligned(load<ChunkHeader>(donor.data()).size);
        const u32 entries = load<ManifestHeader>(donor.data() + sizeof(ChunkHeader)).entries;
        u32 skip = r.below(std::max<u32>(entries, 1));
        while (cursor + sizeof(ChunkHeader) <= donor.size()) {
            const ChunkHeader h = load<ChunkHeader>(donor.data() + cursor);
            if (skip-- == 0) {
                if (used_ + h.size > arena_.size()) return;
                for (u32 i = 0; i < count_; ++i) {
                    if (pieces_[i].hash == h.hash) return;
                }
                pieces_[count_++] = {used_, h.size, h.hash, h.hash, h.kind, true};
                std::memcpy(arena_.data() + used_, donor.data() + cursor + sizeof(ChunkHeader), h.size);
                used_ += h.size;
                return;
            }
            cursor += sizeof(ChunkHeader) + aligned(h.size);
        }
    }

    // Patches -------------------------------------------------------------------------------------------------------

    [[nodiscard]] static u16 buffer_operand(Rng& r, const PatchView& v) {
        return operand(Bank::Buffer, static_cast<u16>(r.below(std::max<u32>(v.h.buffers, 1))));
    }

    [[nodiscard]] static u16 scalar_operand(Rng& r, const PatchView& v, bool control) {
        switch (r.below(control ? 3 : 4)) {
            case 0:
                if (v.h.consts) return operand(Bank::Const, static_cast<u16>(r.below(v.h.consts)));
                return operand(Bank::Const, 0);
            case 1:
                return operand(Bank::Track, static_cast<u16>(r.below(std::max<u32>(v.h.track_scalars, 1))));
            case 2:
                return operand(Bank::Global, static_cast<u16>(r.below(std::max<u32>(v.h.params, 1))));
            default:
                return operand(Bank::Voice, static_cast<u16>(r.below(std::max<u32>(v.h.voice_scalars, 1))));
        }
    }

    // A step that could be valid, so a change of op reaches its kernel and not only the operand checks.
    [[nodiscard]] static WireStep plausible_step(Rng& r, const PatchView& v, bool control, u32 state_id) {
        static constexpr Op scalar_ops[] = {Op::KMul, Op::KAdd, Op::KMtoF, Op::KRatio, Op::KLfo};
        WireStep s{};
        const Op op = control ? scalar_ops[r.below(std::size(scalar_ops))]
                              : static_cast<Op>(1 + r.below(static_cast<u32>(Op::kCount) - 1));
        const OpSignature sig = op_signature(op);
        s.op = static_cast<u8>(op);
        s.state_id = state_id;
        s.mode = static_cast<u8>(r.below(sig.max_mode + 1u));
        if (sig.resource == Resource::Delay) s.resource = static_cast<u16>(r.below(std::max<u32>(v.h.delays, 1)));
        if (sig.resource == Resource::Table || sig.resource == Resource::Asset) {
            s.resource = static_cast<u16>(r.below(std::max<u32>(v.h.refs, 1)));
        }
        for (u32 a = 0; a < sig.ins; ++a) {
            s.in[a] = sig.in[a] == Arg::Buffer ? buffer_operand(r, v) : scalar_operand(r, v, control);
        }
        for (u32 a = 0; a < sig.outs; ++a) {
            if (sig.out_kind == Arg::Buffer) {
                s.out[a] = buffer_operand(r, v);
            } else if (r.chance(20)) {
                // Aimed at a scalar this step does not own, because that is what section 18's rules exist to refuse.
                s.out[a] = operand(r.chance(70) ? Bank::Global : Bank::Track,
                                   static_cast<u16>(r.below(std::max<u32>(v.h.params, 1))));
            } else {
                const u32 limit = control ? v.h.track_scalars : v.h.voice_scalars;
                const Bank bank = control ? Bank::Track : Bank::Voice;
                s.out[a] = operand(bank, static_cast<u16>(r.below(std::max<u32>(limit, 1))));
            }
        }
        return s;
    }

    void mutate_patch(Piece& p, Rng& r) {
        PatchView v;
        if (!parse_patch(bytes(p), v)) {
            if (p.size >= 4) store(base(p) + r.below(p.size / 4) * 4, interesting(r));
            return;
        }
        const u32 steps = static_cast<u32>(v.h.control_steps) + v.h.voice_steps;
        switch (r.below(14)) {
            case 0:
            case 1:
            case 2:
            case 3: {  // A new step, which may well be valid
                if (steps == 0) break;
                const u32 i = r.below(steps);
                const WireStep old = v.step(i);
                store(base(p) + v.steps + i * sizeof(WireStep),
                      plausible_step(r, v, i < v.h.control_steps, old.state_id));
                break;
            }
            case 4: {  // One field of a step
                if (steps == 0) break;
                const u32 at = v.steps + r.below(steps) * sizeof(WireStep);
                const u16 value = r.chance(50) ? scalar_operand(r, v, false) : static_cast<u16>(interesting(r));
                store(base(p) + at + 8 + r.below(6) * 2, value);
                break;
            }
            case 5: {  // Add a step
                const bool control = r.chance(25);
                const u32 at = v.steps + (control ? 0 : v.h.control_steps * sizeof(WireStep));
                if (!resize(p, at, sizeof(WireStep))) break;
                store(base(p) + at, plausible_step(r, v, control, r.below(16)));
                store(base(p) + (control ? offsetof(PatchHeader, control_steps) : offsetof(PatchHeader, voice_steps)),
                      static_cast<u16>((control ? v.h.control_steps : v.h.voice_steps) + 1));
                break;
            }
            case 6: {  // Remove a step
                if (steps == 0) break;
                const u32 i = r.below(steps);
                const bool control = i < v.h.control_steps;
                if (!resize(p, v.steps + i * sizeof(WireStep), -static_cast<std::int32_t>(sizeof(WireStep)))) break;
                store(base(p) + (control ? offsetof(PatchHeader, control_steps) : offsetof(PatchHeader, voice_steps)),
                      static_cast<u16>((control ? v.h.control_steps : v.h.voice_steps) - 1));
                break;
            }
            case 7: {  // A const, a delay time, or a parameter's range
                if (v.h.consts) store(base(p) + v.consts + r.below(v.h.consts) * 4, odd_float(r));
                break;
            }
            case 8: {
                if (v.h.delays) store(base(p) + v.delays + r.below(v.h.delays) * 4, odd_float(r));
                break;
            }
            case 9: {  // A delay line more or fewer, which is what memory sizing has to get right
                const u32 at = v.delays + v.h.delays * 4u;
                const std::int32_t delta = r.chance(70) ? 4 : -4;
                if (delta < 0 && v.h.delays == 0) break;
                if (!resize(p, delta > 0 ? at : at - 4, delta)) break;
                if (delta > 0) store(base(p) + at, odd_float(r));
                store(base(p) + offsetof(PatchHeader, delays), static_cast<u16>(v.h.delays + (delta > 0 ? 1 : -1)));
                break;
            }
            case 10: {  // A parameter field
                if (!v.h.params) break;
                const u32 at = v.params + r.below(v.h.params) * sizeof(ParamDesc);
                if (r.chance(50)) {
                    store(base(p) + at + r.below(3) * 2, static_cast<u16>(interesting(r)));
                } else {
                    store(base(p) + at + 8 + r.below(3) * 4, odd_float(r));
                }
                break;
            }
            case 11: {  // A reference to something else in the image
                if (!v.h.refs) break;
                store(base(p) + v.refs + r.below(v.h.refs) * 8u, pieces_[r.below(count_)].hash);
                break;
            }
            case 12: {  // Resident counts, without a matching size
                const u32 field = r.below(sizeof(PatchHeader) / 2);
                store(base(p) + field * 2, static_cast<u16>(interesting(r)));
                break;
            }
            default: {  // A count of registers, which is always safe to move and changes what later rules see
                const u32 offsets[] = {offsetof(PatchHeader, buffers), offsetof(PatchHeader, voice_scalars),
                                       offsetof(PatchHeader, track_scalars), offsetof(PatchHeader, out_left),
                                       offsetof(PatchHeader, out_right)};
                const u32 at = offsets[r.below(std::size(offsets))];
                const u16 value =
                    at >= offsetof(PatchHeader, out_left) ? buffer_operand(r, v) : static_cast<u16>(1 + r.below(32));
                store(base(p) + at, value);
            }
        }
    }

    // Programs ------------------------------------------------------------------------------------------------------

    [[nodiscard]] static Instruction plausible_instruction(Rng& r, const ProgramView& v) {
        Instruction in{};
        const u32 roll = r.below(100);
        const u32 small = 1 + r.below(r.chance(90) ? 960 : 100000);
        if (roll < 30) {
            in = {static_cast<u8>(Instr::Wait), 0, 0, small};
        } else if (roll < 60) {
            in = {static_cast<u8>(Instr::NoteOn), static_cast<u8>(r.below(128)), static_cast<u16>(r.below(128)), small};
        } else if (roll < 70) {
            in = {static_cast<u8>(Instr::SetParam), 0, static_cast<u16>(r.below(16)), odd_float(r)};
        } else if (roll < 80) {
            in = {static_cast<u8>(Instr::SetPatch), static_cast<u8>(r.below(3)), 0, 0};
        } else if (roll < 95) {
            in = {static_cast<u8>(Instr::Call), 0, static_cast<u16>(r.below(std::max<u32>(v.h.clips, 1))),
                  1 + r.below(4)};
        } else {
            in = {static_cast<u8>(r.below(12)), static_cast<u8>(r.next()), static_cast<u16>(r.next()), interesting(r)};
        }
        return in;
    }

    // Puts the sums the validator recomputes back in line with the streams, so a change to the code is judged on its
    // merits and not refused for a stale total.
    void repair_totals(Piece& p) {
        ProgramView v;
        if (!parse_program(bytes(p), v)) return;
        for (u32 i = 0; i < v.h.clips; ++i) {
            ClipDesc c = v.clip(i);
            if (c.begin > v.h.code || c.length > v.h.code - c.begin) continue;
            u64 ticks = 0;
            u32 slots = 0;
            for (u32 k = 0; k < c.length; ++k) {
                const Instruction in = v.instruction(c.begin + k);
                if (in.op == static_cast<u8>(Instr::Wait)) ticks += in.c;
                if (in.op == static_cast<u8>(Instr::SetPatch)) slots = std::max<u32>(slots, in.a + 1u);
            }
            c.ticks = static_cast<u32>(std::min<u64>(ticks, 0xFFFFFFFFu));
            c.slots = slots;
            store(base(p) + v.clips + i * sizeof(ClipDesc), c);
        }
        u64 longest = 0;
        for (u32 i = 0; i < v.h.tracks; ++i) {
            const TrackDesc t = v.track(i);
            if (t.stream_begin > v.h.code || t.stream_length > v.h.code - t.stream_begin) continue;
            u64 ticks = 0;
            for (u32 k = 0; k < t.stream_length; ++k) {
                const Instruction in = v.instruction(t.stream_begin + k);
                if (in.op == static_cast<u8>(Instr::Wait)) ticks += in.c;
                if (in.op == static_cast<u8>(Instr::Call) && in.b < v.h.clips) {
                    ticks += static_cast<u64>(v.clip(in.b).ticks) * in.c;
                }
            }
            longest = std::max(longest, ticks);
        }
        store(base(p) + offsetof(ProgramHeader, length_ticks), static_cast<u32>(std::min<u64>(longest, 0xFFFFFFFFu)));
    }

    // Moves every stream that starts after `at` along by one instruction, and lengthens the one holding it.
    void shift_streams(Piece& p, const ProgramView& v, u32 at, u32 delta) {
        const auto shifted = [&](u32& begin, u32& length) {
            if (begin >= at && begin != 0) {
                begin += delta;
            } else if (at < begin + length) {
                length += delta;
            }
        };
        for (u32 i = 0; i < v.h.tracks; ++i) {
            TrackDesc t = v.track(i);
            shifted(t.stream_begin, t.stream_length);
            store(base(p) + v.tracks + i * sizeof(TrackDesc), t);
        }
        for (u32 i = 0; i < v.h.clips; ++i) {
            ClipDesc c = v.clip(i);
            shifted(c.begin, c.length);
            store(base(p) + v.clips + i * sizeof(ClipDesc), c);
        }
        u32 begin = v.h.conductor_begin, length = v.h.conductor_length;
        shifted(begin, length);
        store(base(p) + offsetof(ProgramHeader, conductor_begin), begin);
        store(base(p) + offsetof(ProgramHeader, conductor_length), length);
    }

    void mutate_program(Piece& p, Rng& r) {
        ProgramView v;
        if (!parse_program(bytes(p), v)) {
            if (p.size >= 4) store(base(p) + r.below(p.size / 4) * 4, interesting(r));
            return;
        }
        switch (r.below(13)) {
            case 0:
            case 1:
            case 2: {  // A new instruction
                if (!v.h.code) break;
                const u32 i = r.below(v.h.code);
                if (v.instruction(i).op == static_cast<u8>(Instr::End)) break;  // Losing a track is rarely interesting
                store(base(p) + v.code + i * sizeof(Instruction), plausible_instruction(r, v));
                break;
            }
            case 3:
            case 4: {  // An inserted instruction, or a Ramp and its argument
                const u32 i = r.below(v.h.code);
                const u32 extra = r.chance(30) ? 2 : 1;
                if (!resize(p, v.code + i * sizeof(Instruction),
                            static_cast<std::int32_t>(extra * sizeof(Instruction)))) {
                    break;
                }
                if (extra == 2) {
                    store(base(p) + v.code + i * sizeof(Instruction),
                          Instruction{static_cast<u8>(Instr::Ramp), 0, static_cast<u16>(r.below(16)), odd_float(r)});
                    store(base(p) + v.code + (i + 1) * sizeof(Instruction),
                          Instruction{static_cast<u8>(Instr::RampArg), 0, 0, 1 + r.below(4096)});
                } else {
                    store(base(p) + v.code + i * sizeof(Instruction), plausible_instruction(r, v));
                }
                store(base(p) + offsetof(ProgramHeader, code), v.h.code + extra);
                ProgramView after;
                if (parse_program(bytes(p), after)) shift_streams(p, after, i, extra);
                break;
            }
            case 5: {  // A Wait a long way off, or repeats, which is what tick sums have to get right
                if (!v.h.code) break;
                const u32 i = r.below(v.h.code);
                const Instruction old = v.instruction(i);
                if (old.op == static_cast<u8>(Instr::Wait) || old.op == static_cast<u8>(Instr::Call)) {
                    store(base(p) + v.code + i * sizeof(Instruction) + offsetof(Instruction, c), interesting(r));
                }
                break;
            }
            case 6: {  // A field of a track
                if (!v.h.tracks) break;
                const u32 at = v.tracks + r.below(v.h.tracks) * sizeof(TrackDesc);
                static constexpr u32 values[] = {1, 2, 8, 255, 256, 257, 1024};
                if (r.chance(60)) {
                    store(base(p) + at + offsetof(TrackDesc, voices),
                          static_cast<u16>(values[r.below(std::size(values))]));
                } else {
                    store(base(p) + at + r.below(4) * 2, static_cast<u16>(interesting(r)));
                }
                break;
            }
            case 7: {  // A mixer step
                if (!v.h.mix_steps) break;
                const u32 at = v.mix + r.below(v.h.mix_steps) * sizeof(MixStep);
                MixStep m = v.mix_step((at - v.mix) / sizeof(MixStep));
                switch (r.below(5)) {
                    case 0:
                        m.dst = static_cast<u16>(r.below(v.h.buses + 1u));
                        break;
                    case 1:
                        m.src = static_cast<u16>(r.below(v.h.buses + 1u));
                        break;
                    case 2:
                        m.key = r.chance(50) ? kNone : static_cast<u16>(r.below(v.h.buses));
                        break;
                    case 3:
                        m.a = static_cast<u16>(r.below(v.h.inserts + v.h.tracks + 1u));
                        break;
                    default:
                        m.op = static_cast<u8>(1 + r.below(3));
                }
                store(base(p) + at, m);
                break;
            }
            case 8: {  // A gather input
                if (!v.h.gather_inputs) break;
                const u32 at = v.gather + r.below(v.h.gather_inputs) * sizeof(GatherInput);
                store(base(p) + at + r.below(3) * 2, static_cast<u16>(r.below(v.h.buses + 2u)));
                break;
            }
            case 9: {  // A gain, an initial value, or a global
                if (v.h.mix_regs) store(base(p) + v.mix_init + r.below(v.h.mix_regs) * 4, odd_float(r));
                if (v.h.globals) {
                    store(base(p) + v.globals + r.below(v.h.globals) * sizeof(GlobalDesc) + 4, odd_float(r));
                }
                break;
            }
            case 10: {  // Point a slot or an insert at another patch
                if (v.h.slots)
                    store(base(p) + v.slots + r.below(v.h.slots) * 2, static_cast<u16>(r.below(v.h.patches + 1u)));
                if (v.h.inserts) {
                    store(base(p) + v.inserts + r.below(v.h.inserts) * sizeof(InsertDesc) + 2,
                          static_cast<u16>(r.below(v.h.patches + 1u)));
                }
                break;
            }
            case 11: {  // Tempo and time
                const u32 at = r.below(4) * 4;
                store(base(p) + at, r.chance(50) ? interesting(r) : 1000 + r.below(1000000));
                break;
            }
            default: {  // A header count without the matching size
                const u32 field = offsetof(ProgramHeader, patches) + r.below(12) * 2;
                store(base(p) + field, static_cast<u16>(interesting(r)));
            }
        }
        if (r.chance(90)) repair_totals(p);
    }

    // Tables and assets ---------------------------------------------------------------------------------------------

    void mutate_table(Piece& p, Rng& r) {
        if (p.size < sizeof(TableHeader) + 4) return;
        const u32 samples = (p.size - sizeof(TableHeader)) / 4;
        switch (r.below(3)) {
            case 0:
                store(base(p) + sizeof(TableHeader) + r.below(samples) * 4, odd_float(r));
                break;
            case 1: {  // A different length, and the size to match it
                const u32 length = 1u << (1 + r.below(10));
                const std::int32_t delta =
                    static_cast<std::int32_t>((length + 1) * 4) - static_cast<std::int32_t>(samples * 4);
                if (resize(p, p.size - (delta < 0 ? static_cast<u32>(-delta) : 0), delta)) {
                    store(base(p), TableHeader{length, 0});
                }
                break;
            }
            default:
                store(base(p), TableHeader{interesting(r), 0});
        }
    }

    void mutate_asset(Piece& p, Rng& r) {
        if (p.size < sizeof(AssetHeader)) return;
        AssetHeader h = load<AssetHeader>(base(p));
        switch (r.below(7)) {
            case 0:
                h.loop_start = r.below(h.frames + 2);
                h.loop_end = r.below(h.frames + 2);
                break;
            case 1:
                h.loop_start = r.chance(50) ? h.frames - 1 : 0;
                h.loop_end = h.frames;  // The shortest loop, where the increment clamp matters
                break;
            case 2:
                h.loop_end = 0;  // One-shot
                break;
            case 3:
                h.native_rate = std::bit_cast<float>(odd_float(r));
                break;
            case 4:
                h.root_key = static_cast<u8>(r.next());
                break;
            case 5: {  // A different shape, and the size to match it
                h.channels = static_cast<u8>(1 + r.below(2));
                h.encoding = static_cast<u8>(r.below(2));
                h.frames = 1 + r.below(r.chance(50) ? 16 : 2048);
                h.loop_start = 0;
                h.loop_end = r.chance(50) ? h.frames : 0;
                const u32 sample = h.encoding == static_cast<u8>(AssetEncoding::I16) ? 2 : 4;
                const std::int64_t wanted = static_cast<std::int64_t>(h.frames + 1) * h.channels * sample;
                const std::int64_t have = p.size - sizeof(AssetHeader);
                const auto delta = static_cast<std::int32_t>(wanted - have);
                if (!resize(p, p.size - (delta < 0 ? static_cast<u32>(-delta) : 0), delta)) return;
                break;
            }
            default:
                h.frames = interesting(r);
        }
        store(base(p), h);
        if (r.chance(10) && p.size >= sizeof(AssetHeader) + 4) {
            store(base(p) + sizeof(AssetHeader) + r.below((p.size - sizeof(AssetHeader)) / 4) * 4, odd_float(r));
        }
    }

    // Sealing -------------------------------------------------------------------------------------------------------

    // Hashes in dependency order, and points each reference at what its target is called now. The references a mutation
    // redirected follow too, so a redirected patch still names a chunk that exists.
    void follow_hashes() {
        const auto rename = [&](u64 old) {
            for (u32 i = 0; i < count_; ++i) {
                if (pieces_[i].hash == old) return pieces_[i].next_hash;
            }
            return old;
        };
        const auto hash_piece = [&](Piece& p) {
            if (p.present) p.next_hash = hash_bytes(hash_seed(static_cast<ChunkKind>(p.kind)), base(p), p.size);
        };
        for (u32 i = 0; i < count_; ++i) {
            if (pieces_[i].kind != static_cast<u8>(ChunkKind::Patch) &&
                pieces_[i].kind != static_cast<u8>(ChunkKind::Program)) {
                hash_piece(pieces_[i]);
            }
        }
        for (u32 i = 0; i < count_; ++i) {
            Piece& p = pieces_[i];
            if (p.kind != static_cast<u8>(ChunkKind::Patch)) continue;
            PatchView v;
            if (p.present && parse_patch(bytes(p), v)) {
                for (u32 k = 0; k < v.h.refs; ++k) store(base(p) + v.refs + k * 8u, rename(v.ref(k)));
            }
            hash_piece(p);
        }
        for (u32 i = 0; i < count_; ++i) {
            Piece& p = pieces_[i];
            if (p.kind != static_cast<u8>(ChunkKind::Program)) continue;
            ProgramView v;
            if (p.present && parse_program(bytes(p), v)) {
                for (u32 k = 0; k < v.h.patches; ++k) store(base(p) + v.patches + k * 8u, rename(v.patch(k)));
            }
            hash_piece(p);
        }
        for (u32 i = 0; i < count_; ++i) pieces_[i].hash = pieces_[i].next_hash;
    }

    // The order a manifest must have. Two chunks that came out identical become one, which is what a compiler would do.
    void sort() {
        const auto before = [](const Piece& a, const Piece& b) {
            if (a.kind != b.kind) return a.kind < b.kind;
            return a.kind != static_cast<u8>(ChunkKind::Program) && a.hash < b.hash;
        };
        // An insertion sort, because std::stable_sort asks for a heap that firmware does not have.
        for (u32 i = 1; i < count_; ++i) {
            const Piece moving = pieces_[i];
            u32 k = i;
            for (; k > 0 && before(moving, pieces_[k - 1]); --k) pieces_[k] = pieces_[k - 1];
            pieces_[k] = moving;
        }
        u32 kept = 0;
        for (u32 i = 0; i < count_; ++i) {
            bool repeat = false;
            for (u32 k = 0; k < kept; ++k) repeat = repeat || pieces_[k].hash == pieces_[i].hash;
            if (!repeat) pieces_[kept++] = pieces_[i];
        }
        count_ = kept;
    }

    std::span<std::byte> arena_;
    Piece pieces_[kMaxPieces];
    u32 count_ = 0;
    u32 used_ = 0;
};

}  // namespace modsynth::fuzz
