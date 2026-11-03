#pragma once

// What a frame can cost a device, so that a Program that could overrun one is refused rather than played. A device's
// profile carries a Costs table, and Synth::frame_cost() adds it up for a Program's dearest possible frame: every voice
// sounding, every step on its dearest path, and the busiest stretch of each stream. Section 15 of docs/Design.md has
// how the figures are measured and checked.

#include <algorithm>
#include <array>
#include <utility>

#include <modsynth/Format.hpp>
#include <modsynth/Loader.hpp>

namespace modsynth {

// A sampler's mode with this added is that mode playing only mono recordings, which costs less than stereo, and a
// Sample3's with kOneZone added is one whose table never has two zones sound for one note. No op's modes reach them.
inline constexpr u8 kMonoAssets = 0x80;
inline constexpr u8 kOneZone = 0x40;

// What one mode of an op costs, where it differs from the op's dearest: a naive oscillator is far cheaper than a
// band-limited one at half the rate.
struct ModeCost {
    u8 op = 0;  // 0 for an unused entry
    u8 mode = 0;
    u32 moving = 0;
    u32 still = 0;
    constexpr bool operator==(const ModeCost&) const = default;
};

// One target's cost of each kind of work in a frame, in that target's cycles. tools/Bench.py writes a board's: its
// build's instructions on QEMU, each kind priced at what it took a cycle on the board.
struct Costs {
    u32 budget = 0;        // what a frame may cost: the core's cycles in a frame, less what playing it out takes
    u32 frame = 0;         // a frame with nothing in it
    u32 segment = 0;       // each further piece a tempo change cuts a frame into
    u32 track = 0;         // each track, for each piece of the frame
    u32 voice = 0;         // each voice a track has, held, for each piece of the frame
    u32 run = 0;           // each voice or fade sounding, besides its steps
    u32 fade = 0;          // each fade sounding, besides `run`
    u32 slot = 0;          // each patch slot and insert, besides its control steps
    u32 param = 0;         // each parameter of one, moving
    u32 insert = 0;        // each insert, besides its steps and `slot`
    u32 gather = 0;        // each Gather
    u32 gather_input = 0;  // each input of one
    u32 mix_register = 0;  // each mix register, if the Program ramps them
    u32 glide = 0;         // each voice, if the Program has play modes
    u32 held = 0;          // each note a track can hold, if it has play modes, for each piece and instruction
    u32 instruction = 0;   // each instruction a stream runs in the frame
    u32 note = 0;          // each note one starts
    u32 note_voice = 0;    // and for each voice and fade its track has
    u32 note_param = 0;    // and for each parameter of its track's slots
    u32 note_block = 0;    // and for each 64 bytes of voice memory it clears
    u32 zone_row = 0;      // each zone row a sampler looks at when its note starts
    std::array<u32, static_cast<u32>(Op::kCount)> step{};   // each step, on its dearest path
    std::array<u32, static_cast<u32>(Op::kCount)> still{};  // each step whose scalar inputs are all constants
    std::array<u32, static_cast<u32>(Op::kCount)> first{};  // each step in the frame its note starts
    std::array<ModeCost, 16> modes{};                       // modes cheaper than their op's dearest
    constexpr bool operator==(const Costs&) const = default;

    // A step's price, from its op and mode, and whether anything it reads once a frame can change.
    [[nodiscard]] constexpr u32 of(u8 op, u8 mode, bool constant) const {
        for (const ModeCost& m : modes) {
            if (m.op != 0 && m.op == op && m.mode == mode) return constant ? m.still : m.moving;
        }
        if (op >= step.size()) return 0;
        return constant ? still[op] : step[op];
    }
};

// Where a Program's dearest frame goes, in cycles, for telling an author what to cut.
struct CostParts {
    u64 fixed = 0;   // the frame, its tracks and their slots
    u64 voices = 0;  // voices and fades sounding, their steps included
    u64 events = 0;  // what the streams run
    u64 inserts = 0;
    u64 mixer = 0;
    [[nodiscard]] u64 total() const { return fixed + voices + events + inserts + mixer; }
};

namespace detail {

// True if a Sample3's validated zone table can have two zones sound for one note: their keys, velocities and turns in
// a round robin all meet.
[[nodiscard]] inline bool zones_meet(const std::byte* table) {
    const u32 rows = load<TableHeader>(table).length / kZone3Fields;
    const auto field = [&](u32 row, u32 f) {
        return load<float>(table + sizeof(TableHeader) + (row * kZone3Fields + f) * sizeof(float));
    };
    const auto gcd = [](u32 a, u32 b) {
        while (b != 0) a = std::exchange(b, a % b);
        return a;
    };
    for (u32 a = 0; a < rows; ++a) {
        if (field(a, kZoneLowKey) > field(a, kZoneHighKey)) continue;  // padding
        for (u32 b = a + 1; b < rows; ++b) {
            if (field(b, kZoneLowKey) > field(b, kZoneHighKey)) continue;
            const bool keys =
                field(a, kZoneLowKey) <= field(b, kZoneHighKey) && field(b, kZoneLowKey) <= field(a, kZoneHighKey);
            const bool velocities = field(a, kZoneLowVelocity) <= field(b, kZoneHighVelocity) &&
                                    field(b, kZoneLowVelocity) <= field(a, kZoneHighVelocity);
            const u32 la = static_cast<u32>(field(a, kZoneSeqLength)), lb = static_cast<u32>(field(b, kZoneSeqLength));
            const u32 pa = static_cast<u32>(field(a, kZoneSeqPosition)),
                      pb = static_cast<u32>(field(b, kZoneSeqPosition));
            // Two turns of round robins meet on some note if they agree modulo what their lengths share.
            const bool turns = la == 0 || lb == 0 || pa % gcd(la, lb) == pb % gcd(la, lb);
            if (keys && velocities && turns) return true;
        }
    }
    return false;
}

// How many ticks a frame of `frame` samples can reach past the one it starts on, at a Program's fastest tempo and
// `rate`, as the clock counts them. Instructions run in a frame are all within this many ticks of each other.
[[nodiscard]] inline u64 frame_ticks(const ProgramView& p, float rate, u32 frame) {
    u64 uspq = p.h.uspq;
    for (u32 i = 0; i < p.h.conductor_length; ++i) {
        const Instruction in = p.instruction(p.h.conductor_begin + i);
        if (in.op == static_cast<u8>(Instr::Tempo)) uspq = std::min<u64>(uspq, in.c);
    }
    const u64 per_tick = static_cast<u64>(rate + 0.5f) * uspq, per_frame = 1000000ull * p.h.ppq * frame;
    return (per_frame + per_tick - 1) / per_tick;
}

// What a stretch of a stream runs: its instructions, of them the NoteOns, and of them those that set a parameter, which
// look through every parameter their track's patches have.
struct Run {
    u64 instructions = 0;
    u64 notes = 0;
    u64 params = 0;
    Run& operator+=(const Run& r) {
        instructions += r.instructions;
        notes += r.notes;
        params += r.params;
        return *this;
    }
    Run& operator-=(const Run& r) {
        instructions -= r.instructions;
        notes -= r.notes;
        params -= r.params;
        return *this;
    }
};

// One instruction of a stream, or a clip's repeats as one, with the tick it starts on and how many ticks it spans.
struct StreamItem {
    u64 start = 0;
    u64 span = 0;
    Run run;  // what it runs, at most what any window of the walk's width can catch of it
};

// The most a validated stream can run in any `window` ticks, and of them the most NoteOns, each the most on its own.
[[nodiscard]] inline Run densest(const ProgramView& p, u32 begin, u32 length, u64 window, u32 laps = 1,
                                 u32 lap_ticks = 0);

class StreamWalk {
   public:
    // `laps` walks the stretch that many times over, as a clip's repeats run it, each followed by the step that ends
    // a repeat.
    StreamWalk(const ProgramView& p, u32 begin, u32 length, u64 window, u32 laps, u32 lap_ticks)
        : p_(p), begin_(begin), at_(begin), end_(begin + length), laps_(laps), lap_ticks_(lap_ticks), window_(window) {}

    bool next(StreamItem& out) {
        if (at_ >= end_) {
            if (laps_ == 1 || lap_ + 1 >= laps_) return false;
            ++lap_;
            at_ = begin_;
            tick_ = static_cast<u64>(lap_) * lap_ticks_;
            out = {tick_, 0, {1, 0, 0}};  // the step that ended the lap before
            return true;
        }
        const Instruction in = p_.instruction(at_);
        out = {tick_, 0, {1, 0, 0}};
        u32 used = 1;
        switch (static_cast<Instr>(in.op)) {
            case Instr::Wait:
                out.span = in.c;
                break;
            case Instr::NoteOn:
                out.run.notes = 1;
                break;
            case Instr::SetParam:
            case Instr::SetInsert:
                out.run.params = 1;
                break;
            case Instr::Ramp:
            case Instr::RampInsert:
                out.run.params = 1;
                used = 2;  // and its RampArg, which runs with it
                break;
            case Instr::RampMix:
                used = 2;
                break;
            case Instr::Call: {
                const ClipDesc clip = p_.clip(in.b);
                out.span = static_cast<u64>(clip.ticks) * in.c;
                // A window reaches at most this many of the repeats, which are walked if that is cheap. Otherwise
                // each of them counts in full.
                const u64 laps = std::min<u64>(in.c, window_ / clip.ticks + 2);
                if (laps * (static_cast<u64>(clip.length) + 1) <= kWalkLimit) {
                    out.run += densest(p_, clip.begin, clip.length, window_, static_cast<u32>(laps), clip.ticks);
                } else {
                    // Every instruction might be either, which is far more than the truth but only for a Program
                    // no device would play anyway.
                    const u64 all = laps * (static_cast<u64>(clip.length) + 1);
                    out.run += {all, all, all};
                }
                break;
            }
            default:
                break;
        }
        at_ += used;
        tick_ += out.span;
        return true;
    }

   private:
    static constexpr u64 kWalkLimit = 1u << 16;
    const ProgramView& p_;
    u32 begin_, at_, end_;
    u32 laps_, lap_ = 0, lap_ticks_;
    u64 window_;
    u64 tick_ = 0;
};

inline Run densest(const ProgramView& p, u32 begin, u32 length, u64 window, u32 laps, u32 lap_ticks) {
    StreamWalk left(p, begin, length, window, laps, lap_ticks), right(p, begin, length, window, laps, lap_ticks);
    StreamItem first, last, before;
    bool more = right.next(last), has_before = false;
    // Items come in tick order, and each starts where the one before it ends, or with it, so the window from each
    // item's start covers every other window, with what straddles its start.
    Run sum, most;
    while (left.next(first)) {
        while (more && last.start <= first.start + window) {
            sum += last.run;
            more = right.next(last);
        }
        // A window can also start inside what came before, and have some of a clip's repeats from there.
        Run here = sum;
        if (has_before && before.span > 0) here += before.run;
        most.instructions = std::max(most.instructions, here.instructions);
        most.notes = std::max(most.notes, here.notes);
        most.params = std::max(most.params, here.params);
        sum -= first.run;
        before = first;
        has_before = true;
    }
    return most;
}

}  // namespace detail

}  // namespace modsynth
