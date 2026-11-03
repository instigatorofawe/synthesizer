#pragma once

// The engine. A frame has two phases: control on the calling thread, then audio as tasks handed to the executor.
// Serial builds run the same two phases, so splitting the frame is not a parallel-only code path.

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <new>
#include <span>
#include <type_traits>

#include <modsynth/Backend.hpp>
#include <modsynth/Config.hpp>
#include <modsynth/Cost.hpp>
#include <modsynth/Executor.hpp>
#include <modsynth/Format.hpp>
#include <modsynth/Kernels.hpp>
#include <modsynth/Loader.hpp>

namespace modsynth {

enum class EventKind : u8 {
    NoteOn,          // target: track, note, velocity
    NoteOff,         // target: track, note
    SetParam,        // target: track, param, value
    SetInsertParam,  // target: insert, param, value
    SetMix,          // param: mix register, value
    SetTap,          // param: tap slot, target: mix step, note: bus register, channel
    Play,
    Stop,
    Locate,   // tick
    SetLoop,  // tick, tick_end. tick_end of 0 clears the loop.
    // A tap on a graph node: param: tap slot, target: track, channel: its patch slot, tick: voice step, tick_end:
    // operand
    SetProbe,
};

struct Event {
    EventKind kind{};
    u8 note = 0;
    u8 velocity = 0;
    u8 channel = 0;
    u16 target = 0;
    u16 param = 0;
    float value = 0.0f;
    u32 tick = 0;
    u32 tick_end = 0;
};

// 64-bit on every target: a hostile Program's total must not wrap on the way to being refused.
struct MemorySizes {
    u64 fast = 0;
    u64 bulk = 0;
};

// The sizes an engine lays its memory out with. They differ between targets, as pointers do, so a target's profile
// carries its own, and bytes_required() given those sizes a Program as that target would. Profile.hpp writes them.
struct Layout {
    struct Size {
        u32 size = 0;
        u32 align = 0;
        constexpr bool operator==(const Size&) const = default;
    };
    u32 frame_size = 0;
    u32 channels = 0;
    u32 workers = 0;     // scratch is per worker
    bool edges = false;  // whether a parallel plan is stored
    u32 align = 0;       // every array is aligned to at least this
    u32 region_align = 0;
    u32 generation = 0;  // a Generation, rounded to `align`
    u32 delay_line = 0;
    u32 state_align = 0;
    Size binding, track, insert, decoded_step, bound_resource, param_state, slot, voice, held, glide, fade, mix_ramp,
        task;
    std::array<u32, static_cast<u32>(Op::kCount)> state_size{};  // per op, and 0 where an op holds no state
    constexpr bool operator==(const Layout&) const = default;
};

template <class T>
[[nodiscard]] constexpr Layout::Size size_of() {
    return {static_cast<u32>(sizeof(T)), static_cast<u32>(alignof(T))};
}

// What one frame did, which only an engine built with SynthConfig::count_work counts. tools/Bench.py fits what each
// of these costs on a device, for its Costs table.
struct Work {
    u32 segments = 0;        // pieces of the frame dispatched
    u32 track_segments = 0;  // tracks dispatched, in all of them
    u32 voice_slots = 0;     // voices looked at, likewise
    u32 held = 0;            // of those, held voices whose end was looked for
    u32 idle = 0;            // voices passed over in the audio phase
    u32 run = 0;             // voices and fades run
    u32 fades = 0;           // of those, fades
    u32 slots = 0;           // slots and inserts updated
    u32 params = 0;          // their parameters looked at
    u32 moving = 0;          // of those, ones moving
    u32 inserts = 0;
    u32 gathers = 0;
    u32 gather_inputs = 0;
    u32 mix_registers = 0;                                  // looked at for a ramp
    u32 glides = 0;                                         // voices looked at for a glide
    u32 held_notes = 0;                                     // notes a mono or legato track looked at
    u32 instructions = 0;                                   // instructions the streams ran
    u32 notes = 0;                                          // notes started
    u32 note_voices = 0;                                    // voices and fades their tracks have
    u32 note_params = 0;                                    // parameters their slots have
    u32 note_bytes = 0;                                     // bytes cleared for them
    u32 zone_rows = 0;                                      // zone rows their samplers may read
    std::array<u32, static_cast<u32>(Op::kCount)> steps{};  // steps run, by opcode
};

struct TapBlock {
    const float* data = nullptr;
    u32 length = 0;
    u64 start_sample = 0;
    u32 dropped = 0;
    u32 generation = 0;
};

template <SynthConfig C = SynthConfig{}, Backend B = ScalarBackend, Executor E = SerialExecutor>
class Synth {
    static_assert(C.channels == 1 || C.channels == 2, "SynthConfig::channels must be 1 or 2");
    static_assert(C.generations == 1 || C.generations == 2, "SynthConfig::generations must be 1 or 2");
    static_assert(std::has_single_bit(C.frame_size) && C.frame_size >= kMinFrameSize && C.frame_size <= kMaxFrameSize,
                  "SynthConfig::frame_size must be a power of two from 8 to 1024, or no image could name it");
    static_assert(!C.count_work || E::max_workers == 1,
                  "Work is counted by one thread, so only a serial engine counts it");

   public:
    static constexpr u32 frame_size = C.frame_size;
    static constexpr u32 channels = C.channels;
    static constexpr u32 tap_block = C.frame_size * (1024 / C.frame_size);

    struct Memory {
        std::span<std::byte> fast;
        std::span<std::byte> bulk;
        float rate = 48000.0f;
    };

    explicit Synth(Memory memory, E exec = E{}) : exec_(static_cast<E&&>(exec)) {
        rate_ = clamp(memory.rate, 1000.0f, 384000.0f);
        inverse_rate_ = 1.0f / rate_;
        fade_length_ = std::max<u32>(static_cast<u32>(kStealFadeSeconds * rate_), 1);
        int_rate_ = static_cast<u32>(rate_ + 0.5f);

        std::byte* fast = memory.fast.data();
        std::size_t fast_size = memory.fast.size();
        if constexpr (C.tap_slots > 0) {
            const std::size_t taps = std::min<std::size_t>(sizeof(float) * tap_block * C.tap_slots, fast_size);
            for (u32 i = 0; i < C.tap_slots; ++i) {
                taps_[i].data = reinterpret_cast<float*>(fast) + i * tap_block;
            }
            fast += taps;
            fast_size -= taps;  // Too little memory leaves regions empty, so every load reports OutOfMemory
        }
        const std::size_t fast_each = fast_size / C.generations / kRegionAlign * kRegionAlign;
        const std::size_t bulk_each = memory.bulk.size() / C.generations / kRegionAlign * kRegionAlign;
        for (u32 i = 0; i < C.generations; ++i) {
            regions_[i].fast = fast + i * fast_each;
            regions_[i].fast_size = fast_each;
            regions_[i].bulk = memory.bulk.data() + i * bulk_each;
            regions_[i].bulk_size = bulk_each;
        }
    }

    Synth(const Synth&) = delete;
    Synth& operator=(const Synth&) = delete;

    // What one generation of this Program needs, at this rate. Multiply by C.generations for what the constructor must
    // be given, and add tap_bytes() to fast. Given another target's layout, what that target's engine would need.
    [[nodiscard]] static MemorySizes bytes_required(const ChunkTable& chunks, u64 program, float rate,
                                                    const Layout& layout = Synth::layout()) {
        const ChunkRef* c = chunks.find(program, ChunkKind::Program);
        ProgramView p;
        if (!c || !parse_program({c->data, c->size}, p)) return {};
        Bump fast(nullptr, layout), bulk(nullptr, layout);
        Generation g;
        g.program = p;
        reserve<true>(g, chunks, fast, bulk, rate, layout);
        const u64 align = layout.region_align;
        const auto rounded = [align](u64 n) { return (n + align - 1) / align * align; };  // As the constructor splits
        return {rounded(layout.generation + fast.used()), rounded(bulk.used())};
    }

    // The most one frame of this Program can cost a target with these costs and this layout, in its cycles: every voice
    // and fade slot sounding, each step on its dearest path, and each stream's busiest frame. A device refuses a
    // Program over its budget, so whatever it plays fits every frame. `parts` gets where the cycles go, and `voices`,
    // if given, is how many voices each track has in place of the Program's own, for finding how many would fit.
    [[nodiscard]] static u64 frame_cost(const ChunkTable& chunks, u64 program, float rate, const Costs& k,
                                        const Layout& layout = Synth::layout(), CostParts* parts = nullptr,
                                        std::span<const u32> voices_instead = {}) {
        const ChunkRef* c = chunks.find(program, ChunkKind::Program);
        ProgramView p;
        if (!c || !parse_program({c->data, c->size}, p)) return ~u64{0};
        const ProgramHeader& h = p.h;
        const u64 window = detail::frame_ticks(p, rate, layout.frame_size);
        const detail::Run conductor = detail::densest(p, h.conductor_begin, h.conductor_length, window);
        const u64 segments = 1 + conductor.instructions;
        const bool plays = (h.features & kFeaturePlayModes) != 0, steals = (h.features & kFeatureStealFades) != 0;

        // What a patch's steps cost each frame, and what more they cost in the frame a note starts, when nothing they
        // worked out from their inputs is kept yet. A sampler reads its zones then too, or at the release in release
        // mode, which every voice can reach in the same frame.
        struct Steps {
            u64 each = 0, starting = 0;
        };
        const auto steps = [&](const PatchView& v, u32 first, u32 count) {
            Steps s;
            for (u32 i = first; i < first + count; ++i) {
                const WireStep w = v.step(i);
                const OpSignature sig = op_signature(static_cast<Op>(w.op));
                bool constant = true;
                for (u32 a = 0; a < sig.ins; ++a) {
                    const Bank bank = operand_bank(w.in[a]);
                    constant = constant && (bank == Bank::Buffer || bank == Bank::Const);
                }
                u8 mode = w.mode;
                if (w.op == static_cast<u8>(Op::Sample) || w.op == static_cast<u8>(Op::Sample2) ||
                    w.op == static_cast<u8>(Op::Sample3)) {
                    // Priced as mono if every recording the patch has is, as any of them can be a zone's
                    bool mono = true;
                    for (u32 r = 0; r < v.h.refs; ++r) {
                        const ChunkRef* a = chunks.find(v.ref(r), ChunkKind::Asset);
                        mono = mono && (!a || modsynth::load<AssetHeader>(a->data).channels == 1);
                    }
                    if (mono) mode |= kMonoAssets;
                    if (w.op == static_cast<u8>(Op::Sample3) && w.resource < v.h.refs) {
                        const ChunkRef* zones = chunks.find(v.ref(w.resource), ChunkKind::Table);
                        if (zones && !detail::zones_meet(zones->data)) mode |= kOneZone;
                    }
                }
                const u64 price = k.of(w.op, mode, constant);
                const u64 first = w.op < k.first.size() ? k.first[w.op] : 0;
                s.each += price;
                s.starting += std::max<u64>(first, k.of(w.op, mode, false)) - price;
                const bool zones = w.op == static_cast<u8>(Op::Sample2) || w.op == static_cast<u8>(Op::Sample3);
                if (zones && w.resource < v.h.refs) {
                    const ChunkRef* t = chunks.find(v.ref(w.resource), ChunkKind::Table);
                    const u32 fields = w.op == static_cast<u8>(Op::Sample3) ? kZone3Fields : kZoneFields;
                    const u64 rows = t ? modsynth::load<TableHeader>(t->data).length / fields * u64{k.zone_row} : 0;
                    const bool on_release = w.op == static_cast<u8>(Op::Sample3) && (w.mode & kSampleRelease) != 0;
                    (on_release ? s.each : s.starting) += rows;
                }
            }
            return s;
        };
        const auto slot = [&](const PatchView& v) {
            return k.slot + static_cast<u64>(v.h.params) * k.param + steps(v, 0, v.h.control_steps).each;
        };

        CostParts out;
        out.fixed = k.frame + (segments - 1) * k.segment;
        out.events = conductor.instructions * k.instruction;
        // An instruction that sets an insert's parameter looks through that insert's, and one that sets a global
        // through the Program's globals.
        u64 insert_params = 0;
        for (u32 i = 0; i < h.inserts; ++i) {
            insert_params = std::max<u64>(insert_params, patch_view(chunks, p.patch(p.insert(i).patch)).h.params);
        }
        for (u32 t = 0; t < h.tracks; ++t) {
            const TrackDesc d = p.track(t);
            const u32 count = t < voices_instead.size() ? voices_instead[t] : d.voices;
            const u64 voices = count, fades = steals ? fade_slots(count) : 0, held = plays ? kMaxHeldNotes : 0;
            u64 voice_steps = 0, starting = 0, params = 0, bytes = 0;
            for (u32 s = 0; s < d.slot_count; ++s) {
                const PatchView v = patch_view(chunks, p.patch(p.slot(d.slot_begin + s)));
                out.fixed += slot(v);
                const Steps each = steps(v, v.h.control_steps, v.h.voice_steps);
                voice_steps = std::max(voice_steps, each.each);
                starting = std::max(starting, each.starting);
                params += v.h.params;
                bytes = std::max<u64>(bytes, measure_patch(v, rate, layout).voice_state + 4ull * v.h.voice_scalars);
            }
            const u64 sounding = k.run + voice_steps;
            out.fixed += segments * (k.track + held * k.held);
            out.voices += segments * voices * k.voice + (voices + fades) * sounding + fades * k.fade +
                          (plays ? voices * k.glide : 0);
            const detail::Run run = detail::densest(p, d.stream_begin, d.stream_length, window);
            out.events += run.instructions * (k.instruction + held * k.held);
            out.events += run.notes * (k.note + (voices + fades) * k.note_voice + params * k.note_param +
                                       (bytes + 63) / 64 * k.note_block + starting);
            out.events += run.params * ((params + insert_params + h.globals) * k.note_param + voices * k.note_voice);
        }
        for (u32 i = 0; i < h.inserts; ++i) {
            const PatchView v = patch_view(chunks, p.patch(p.insert(i).patch));
            const Steps each = steps(v, v.h.control_steps, v.h.voice_steps);
            out.inserts += k.insert + slot(v) + each.each + each.starting;  // An insert starts with the Program
        }
        for (u32 i = 0; i < h.mix_steps; ++i) {
            const MixStep m = p.mix_step(i);
            if (m.op == static_cast<u8>(MixOp::Gather))
                out.mixer += k.gather + static_cast<u64>(m.src) * k.gather_input;
        }
        if ((h.features & kFeatureMixRamps) != 0) out.mixer += static_cast<u64>(h.mix_regs) * k.mix_register;
        if (parts) *parts = out;
        return out.total();
    }

    // This engine's own sizes.
    [[nodiscard]] static constexpr Layout layout() {
        Layout l;
        l.frame_size = N;
        l.channels = Ch;
        l.workers = E::max_workers;
        l.edges = E::uses_edges;
        l.align = kAlign;
        l.region_align = kRegionAlign;
        l.generation = kGenerationBytes;
        l.delay_line = sizeof(DelayLine);
        l.state_align = K::state_align;
        l.binding = size_of<Binding>();
        l.track = size_of<Track>();
        l.insert = size_of<Insert>();
        l.decoded_step = size_of<DecodedStep>();
        l.bound_resource = size_of<BoundResource>();
        l.param_state = size_of<ParamState>();
        l.slot = size_of<Slot>();
        l.voice = size_of<Voice>();
        l.held = size_of<Held>();
        l.glide = size_of<Glide>();
        l.fade = size_of<Fade>();
        l.mix_ramp = size_of<MixRamp>();
        l.task = size_of<Task>();
        for (u32 op = 0; op < l.state_size.size(); ++op) l.state_size[op] = K::state_size(static_cast<Op>(op));
        return l;
    }
    [[nodiscard]] static constexpr std::size_t tap_bytes() { return sizeof(float) * tap_block * C.tap_slots; }

    // Starts loading. The image and the table must outlive every generation that uses them. Work happens in pump(),
    // which render() also calls, and the new generation commits at a frame boundary.
    void load(ChunkTable& chunks, ByteSpan image, u32 program = 0) {
        loader_ = Loader(chunks);
        loader_.begin(image, C.frame_size);
        chunks_ = &chunks;
        program_index_ = program;
        load_phase_ = LoadPhase::Validating;
        error_ = LoadError::None;
    }

    // Binds a Program whose chunks a table already holds, which is how a bank switches songs.
    void bind(ChunkTable& chunks, u64 program) {
        chunks_ = &chunks;
        program_hash_ = program;
        const bool playable = chunks.frame_size() == C.frame_size;
        load_phase_ = playable ? LoadPhase::Waiting : LoadPhase::Idle;
        error_ = playable ? LoadError::None : LoadError::WrongFrameSize;
    }

    // Does up to about `budget` units of loading. Returns true while a load is in progress.
    bool pump(u32 budget) {
        switch (load_phase_) {
            case LoadPhase::Validating: {
                const LoadStatus status = loader_.step(budget);
                if (status == LoadStatus::Failed) {
                    error_ = loader_.error();
                    load_phase_ = LoadPhase::Idle;
                } else if (status == LoadStatus::Ready) {
                    if (loader_.programs() == 0) {
                        load_phase_ =
                            LoadPhase::Idle;  // A library: its chunks are in the table, and nothing is to bind
                    } else if (program_index_ >= loader_.programs()) {
                        error_ = LoadError::BadProgram;
                        load_phase_ = LoadPhase::Idle;
                    } else {
                        program_hash_ = loader_.program_hash(program_index_);
                        load_phase_ = LoadPhase::Waiting;
                    }
                }
                break;
            }
            case LoadPhase::Waiting:
                if (old_) {
                    fade_step_ = std::max(fade_step_, 4.0f / kFadeSamples);  // force-fade the oldest, per section 11
                } else {
                    begin_bind();
                }
                break;
            case LoadPhase::Binding:
                bind_step();
                break;
            default:
                break;
        }
        return loading();
    }

    [[nodiscard]] bool loading() const { return load_phase_ != LoadPhase::Idle; }
    [[nodiscard]] LoadError load_error() const { return error_; }
    [[nodiscard]] u32 generation() const { return generation_; }

    // Events are checked here, because a host can send anything. Whatever depends on the bound image is checked again
    // when the event is applied.
    bool send(const Event& e) {
        if (static_cast<u8>(e.kind) > static_cast<u8>(EventKind::SetProbe)) return false;
        if ((e.kind == EventKind::NoteOn || e.kind == EventKind::NoteOff) && (e.note > 127 || e.velocity > 127)) {
            return false;
        }
        if ((e.kind == EventKind::SetParam || e.kind == EventKind::SetInsertParam || e.kind == EventKind::SetMix) &&
            !(e.value >= -1e12f && e.value <= 1e12f)) {
            return false;
        }
        if (e.kind == EventKind::SetLoop && e.tick_end != 0 && e.tick >= e.tick_end) return false;
        const u32 next = (queue_write_ + 1) % kQueueSize;
        if (next == queue_read_) return false;
        queue_[queue_write_] = e;
        queue_write_ = next;
        return true;
    }

    void render(const std::array<float*, C.channels>& out) {
        count([](Work& w) { w = {}; });
        if (load_phase_ == LoadPhase::Ready) commit();

        Generation* g = live_;
        if (!g) {
            drain_events(nullptr);
            for (float* channel : out) B::fill(0.0f, channel, N);
        } else {
            control_phase(*g);
            audio_phase(*g, true);
            for (u32 ch = 0; ch < C.channels; ++ch) {
                std::memcpy(out[ch], bus(*g, g->program.h.master, ch), sizeof(float) * N);
            }
            if (old_) {
                run_control(*old_);  // Without this a note ending mid-fade would ring on in the old generation
                audio_phase(*old_, false);
                crossfade(out);
            }
            // Voices and inserts are guarded, but a Gather's gains are not, and huge finite values can still sum to
            // infinity. A host must never receive that, so this is the last guard.
            for (u32 ch = 0; ch < C.channels; ++ch) {
                if (K::finite(out[ch])) continue;
                B::fill(0.0f, out[ch], N);
                ++master_guard_trips_;
            }
        }
        sample_index_ += N;
        if constexpr (C.tap_slots > 0) finish_taps();
        if (load_phase_ != LoadPhase::Idle) pump(kBudgetPerFrame);
    }

    [[nodiscard]] u32 tick() const { return live_ ? live_->clock.tick : 0; }
    // Where the Program's last note ends, so an offline render knows when the song is over.
    [[nodiscard]] u32 length() const { return live_ ? live_->program.h.length_ticks : 0; }
    [[nodiscard]] bool playing() const { return live_ && live_->clock.playing; }
    [[nodiscard]] u32 active_voices() const {
        if (!live_) return 0;
        u32 n = 0;
        for (u32 t = 0; t < live_->program.h.tracks; ++t) {
            const Track& track = live_->tracks[t];
            for (u32 v = 0; v < track.desc.voices; ++v) n += track.voices[v].active;
            for (u32 v = 0; v < track.fade_count; ++v) n += track.fades[v].active;
        }
        return n;
    }
    [[nodiscard]] u32 guard_trips() const {
        if (!live_) return 0;
        u32 n = master_guard_trips_;
        for (u32 t = 0; t < live_->program.h.tracks; ++t) n += live_->tracks[t].guard_trips;
        for (u32 i = 0; i < live_->program.h.inserts; ++i) n += live_->inserts[i].guard_trips;
        return n;
    }

    // What the last frame did. Only an engine built to count it has this.
    [[nodiscard]] const Work& work() const
        requires(C.count_work)
    {
        return work_;
    }

    // A completed block for this tap, if one is waiting. It stays valid until the next render().
    [[nodiscard]] bool tap_take(u32 slot, TapBlock& out) {
        if constexpr (C.tap_slots > 0) {
            if (slot >= C.tap_slots) return false;
            Tap& t = taps_[slot];
            if (!t.ready) return false;
            out = {t.data, tap_block, t.start_sample, t.dropped, generation_};
            t.ready = false;
            t.dropped = 0;
            return true;
        } else {
            return false;
        }
    }

   private:
    static constexpr u32 N = C.frame_size;
    static constexpr u32 Ch = C.channels;
    static constexpr u32 kNoTick = 0xFFFFFFFFu;
    static constexpr u32 kQueueSize = 64;
    static constexpr u32 kBudgetPerFrame = 64 * C.frame_size;  // The same share of the CPU at any frame size
    static constexpr float kFadeSamples = 2048.0f;
    using K = Kernels<C, B>;
    // Parallel builds start every array on its own cache line, so tasks on different threads don't share one. Serial
    // builds stay packed, as section 18 says. It holds only if the host's memory is aligned to 64 bytes too.
    static constexpr u64 kAlign = E::max_workers > 1 ? 64 : 8;
    static constexpr u64 kRegionAlign = kAlign > 16 ? kAlign : 16;

    // Counts in 64 bits on every target. Format limits keep the largest possible total far below 2^64, so it cannot
    // wrap even on the dry run that decides whether a Program fits. Only a total that fit is ever turned into a
    // pointer.
    // The engine's own types take their sizes from a layout. Floats and integers are the same on every target.
    template <class T>
    [[nodiscard]] static constexpr Layout::Size size_in(const Layout& l) {
        if constexpr (std::is_same_v<T, Binding>)
            return l.binding;
        else if constexpr (std::is_same_v<T, Track>)
            return l.track;
        else if constexpr (std::is_same_v<T, Insert>)
            return l.insert;
        else if constexpr (std::is_same_v<T, DecodedStep>)
            return l.decoded_step;
        else if constexpr (std::is_same_v<T, BoundResource>)
            return l.bound_resource;
        else if constexpr (std::is_same_v<T, ParamState>)
            return l.param_state;
        else if constexpr (std::is_same_v<T, Slot>)
            return l.slot;
        else if constexpr (std::is_same_v<T, Voice>)
            return l.voice;
        else if constexpr (std::is_same_v<T, Held>)
            return l.held;
        else if constexpr (std::is_same_v<T, Glide>)
            return l.glide;
        else if constexpr (std::is_same_v<T, Fade>)
            return l.fade;
        else if constexpr (std::is_same_v<T, MixRamp>)
            return l.mix_ramp;
        else if constexpr (std::is_same_v<T, Task>)
            return l.task;
        else {
            static_assert(std::is_arithmetic_v<T> || std::is_same_v<T, std::byte>, "a type the layout must carry");
            return size_of<T>();
        }
    }

    // Places arrays, at the sizes a layout gives. Only a count, with no base, may use another target's layout.
    class Bump {
       public:
        Bump(std::byte* base, const Layout& layout) : base_(base), layout_(layout) {}
        template <class T>
        [[nodiscard]] T* array(u64 count) {
            const Layout::Size s = size_in<T>(layout_);
            const u64 align = std::max<u64>(s.align, layout_.align);
            const u64 start = (used_ + align - 1) / align * align;
            used_ = start + count * s.size;
            return base_ ? reinterpret_cast<T*>(base_ + static_cast<std::size_t>(start)) : nullptr;
        }
        [[nodiscard]] u64 used() const { return used_; }

       private:
        std::byte* base_;
        const Layout& layout_;
        u64 used_ = 0;
    };

    struct Region {
        std::byte* fast = nullptr;
        std::size_t fast_size = 0;
        std::byte* bulk = nullptr;
        std::size_t bulk_size = 0;
    };

    // A compiled patch bound to this engine. Shared by every instance of it.
    struct Binding {
        PatchView view;
        DecodedStep* control;
        DecodedStep* voice;
        BoundResource* resources;
        u32* line_lengths;  // in samples, with kLineI16 set on a line of 16-bit ones
        u32 voice_state;
        u32 control_state;
        bool ends;
    };

    struct PatchSizes {
        u32 voice_state = 0;  // including the DelayLine array at its start
        u32 control_state = 0;
        u64 bulk_floats = 0;
    };

    struct ParamState {
        float value;
        float target;
        float step;
        u32 frames;
    };

    struct Slot {
        const Binding* binding;
        float* track;
        std::byte* state;
        ParamState* params;
    };

    struct Voice {
        float* scalars;
        std::byte* state;
        float* bulk;
        u32 age;
        u32 off_tick;
        u32 ordinal;  // how many notes its track had started before this one, for a round robin
        GateEvents gate;
        u8 note;
        u8 velocity;
        u8 slot;
        bool active;
        bool held;
    };

    struct Cursor {
        u32 pc;
        u32 end;
        u32 ret_pc;
        u32 ret_end;
        u32 clip_begin;
        u32 repeats;
        u32 tick;
    };

    // A note a mono or legato track is holding. Only one of them sounds, and the rest wait for it to end.
    struct Held {
        u32 off_tick;  // kNoTick for a live note, which waits for its NoteOff
        u32 ordinal;
        u8 note;
        u8 velocity;
        bool sounding;
    };

    // A voice's pitch on its way to a note, moved once a frame.
    struct Glide {
        float target;
        float step;
        u32 frames;
        // A legato note bringing its velocity, which moves the velocity scalar the same way.
        float velocity_target;
        float velocity_step;
        u32 velocity_frames;
    };

    // A stolen voice's sound, playing on in a fade slot of its own while the voice plays its new note.
    struct Fade {
        u32 index;  // the voice it came from, whose seed it keeps
        u32 from;   // where in its first frame the fade begins
        u32 done;   // samples faded so far
    };

    struct MixRamp {
        float target;
        float step;
        u32 frames;
    };

    struct Track {
        TrackDesc desc;
        Slot* slots;
        Voice* voices;
        Held* held;     // kMaxHeldNotes, or null in a Program with no PlayMode
        Glide* glides;  // one for each voice, likewise
        Voice* fades;   // fade_slots(voices) of them, or none in a Program with no Steal
        Fade* fading;
        u32 fade_count;
        Cursor cursor;
        u32 age;
        u32 notes;
        u32 guard_trips;
        u32 slot;
        float glide;      // seconds
        float last_note;  // what the next glide starts from, or negative if no note has played
        u16 line;         // the voice sounding a mono or legato line, or kNone
        u8 held_count;
        u8 play;      // PlayKind
        u8 priority;  // NotePriority
        u8 steal;     // 1 if a stolen voice fades out
        u32 ordinal;  // NoteOns its stream has passed, played or chased, and live notes
    };

    struct Insert {
        InsertDesc desc;
        Slot slot;
        Voice instance;
        u32 guard_trips;
    };

    struct Clock {
        u32 tick;
        u64 remainder;  // in units of 1 / (rate * uspq) ticks. Exact, so tempo maps do not drift.
        u32 uspq;
        u32 loop_start;
        u32 loop_end;
        bool playing;
    };

    struct Task {
        u16 first;
        u16 count;
    };

    struct Generation {
        ProgramView program;
        const ChunkTable* chunks = nullptr;
        Binding* bindings = nullptr;
        Track* tracks = nullptr;
        Insert* inserts = nullptr;
        float* buses = nullptr;
        float* mix = nullptr;
        MixRamp* mix_ramps = nullptr;  // one for each register, or null in a Program with no RampMix
        float* globals = nullptr;
        float* scratch = nullptr;
        Task* tasks = nullptr;
        u32 task_count = 0;
        u32 region = 0;
        Clock clock{};
        Cursor conductor{};
        typename E::Plan plan{};
    };

    struct Tap {
        float* data = nullptr;
        u64 start_sample = 0;
        u32 filled = 0;
        u32 dropped = 0;
        u16 step = kNone;
        u16 reg = 0;
        u8 channel = 0;
        bool ready = false;
        // A probe watches the newest voice on a track rather than a bus, so these replace step, reg and channel.
        u16 track = kNone;
        u16 voice_step = 0;
        u16 operand = 0;
        u8 slot = 0;
        bool caught = false;
    };

    // The Generation itself lives at the start of its region.
    static constexpr std::size_t kGenerationBytes = (sizeof(Generation) + kAlign - 1) / kAlign * kAlign;

    enum class LoadPhase : u8 { Idle, Validating, Waiting, Binding, Ready };
    enum class BindPhase : u8 { Patches, Instances, Done };

    // Sizing ------------------------------------------------------------------------------------------------------

    [[nodiscard]] static u32 line_length(float seconds, float rate, u32 frame = N) {
        return static_cast<u32>(seconds * rate) + frame + 4;
    }

    // A line's length is at most 60 s at a few hundred kHz, so its top bit is free to say what it holds.
    static constexpr u32 kLineI16 = 0x80000000u;

    // Which of a patch's delay lines hold 16-bit samples, marked from its voice steps. The validator made every step on
    // a line agree. Sizing also runs on patches it hasn't passed, where a line out of range is f32, the larger, so
    // nothing is undercounted.
    class LineKinds {
       public:
        void mark(u8 op, u16 line) {
            if (op_line_i16(op) && line < kMaxPatchDelays) words_[line / 32] |= 1u << (line % 32);
        }
        [[nodiscard]] bool i16(u32 line) const {
            return line < kMaxPatchDelays && ((words_[line / 32] >> (line % 32)) & 1u) != 0;
        }

       private:
        u32 words_[kMaxPatchDelays / 32] = {};
    };

    // A patch's delay lines, in floats of bulk memory. On its own so that measure_patch, which reserve runs for every
    // slot, stays small enough to inline as it did before a line could hold 16-bit samples.
    [[gnu::noinline]] static u64 line_floats_of(const PatchView& v, float rate, u32 frame) {
        LineKinds kinds;
        for (u32 i = v.h.control_steps; i < static_cast<u32>(v.h.control_steps) + v.h.voice_steps; ++i) {
            kinds.mark(v.step_op(i), v.step_resource(i));
        }
        u64 floats = 0;
        for (u32 i = 0; i < v.h.delays; ++i) floats += line_floats(line_length(v.delay(i), rate, frame), kinds.i16(i));
        return floats;
    }

    [[nodiscard]] static PatchSizes measure_patch(const PatchView& v, float rate, const Layout& l) {
        PatchSizes s;
        const auto aligned = [&l](u32 n) { return (n + l.state_align - 1) / l.state_align * l.state_align; };
        const auto state = [&l](u8 op) { return op < l.state_size.size() ? l.state_size[op] : 0; };
        s.voice_state = aligned(v.h.delays * l.delay_line);
        for (u32 i = 0; i < v.h.control_steps; ++i) s.control_state += aligned(state(v.step(i).op));
        for (u32 i = 0; i < v.h.voice_steps; ++i) s.voice_state += aligned(state(v.step(v.h.control_steps + i).op));
        if (v.h.delays) s.bulk_floats = line_floats_of(v, rate, l.frame_size);
        return s;
    }

    [[nodiscard]] static PatchView patch_view(const ChunkTable& chunks, u64 hash) {
        const ChunkRef* c = chunks.find(hash, ChunkKind::Patch);
        PatchView v;
        (void)parse_patch({c->data, c->size}, v);  // Validated before anything reaches here
        return v;
    }

    // The one place that decides layout. With Dry it only counts, so bytes_required() cannot disagree with bind.
    template <bool Dry>
    static void reserve(Generation& g, const ChunkTable& chunks, Bump& fast, Bump& bulk, float rate, const Layout& l) {
        const ProgramView& p = g.program;
        const ProgramHeader& h = p.h;
        auto* bindings = fast.template array<Binding>(h.patches);
        auto* tracks = fast.template array<Track>(h.tracks);
        auto* inserts = fast.template array<Insert>(h.inserts);
        if constexpr (!Dry) {
            g.bindings = bindings;
            g.tracks = tracks;
            g.inserts = inserts;
        }

        u32 max_buffers = 0;
        for (u32 i = 0; i < h.patches; ++i) {
            const PatchView v = patch_view(chunks, p.patch(i));
            max_buffers = std::max<u32>(max_buffers, v.h.buffers);
            auto* control = fast.template array<DecodedStep>(v.h.control_steps);
            auto* voice = fast.template array<DecodedStep>(v.h.voice_steps);
            auto* resources = fast.template array<BoundResource>(v.h.refs);
            auto* lines = fast.template array<u32>(v.h.delays);
            if constexpr (!Dry) {
                bindings[i].view = v;
                bindings[i].control = control;
                bindings[i].voice = voice;
                bindings[i].resources = resources;
                bindings[i].line_lengths = lines;
            }
        }

        const auto reserve_slot = [&](u32 patch, Slot* slot) {
            const PatchView v = patch_view(chunks, p.patch(patch));
            const PatchSizes sizes = measure_patch(v, rate, l);
            auto* track = fast.template array<float>(v.h.track_scalars);
            auto* state = fast.template array<std::byte>(sizes.control_state);
            auto* params = fast.template array<ParamState>(v.h.params);
            if constexpr (!Dry) {
                slot->binding = &g.bindings[patch];
                slot->track = track;
                slot->state = state;
                slot->params = params;
            }
        };
        const auto reserve_voice = [&](Voice* voice, u32 scalars, u32 state, u64 floats) {
            auto* s = fast.template array<float>(scalars);
            auto* st = fast.template array<std::byte>(state);
            auto* b = bulk.template array<float>(floats);
            if constexpr (!Dry) {
                voice->scalars = s;
                voice->state = st;
                voice->bulk = b;
            }
        };

        for (u32 t = 0; t < h.tracks; ++t) {
            const TrackDesc d = p.track(t);
            auto* slots = fast.template array<Slot>(d.slot_count);
            auto* voices = fast.template array<Voice>(d.voices);
            const bool plays = (h.features & kFeaturePlayModes) != 0;
            auto* held = fast.template array<Held>(plays ? kMaxHeldNotes : 0);
            auto* glides = fast.template array<Glide>(plays ? d.voices : 0);
            const u32 fade_count = (h.features & kFeatureStealFades) != 0 ? fade_slots(d.voices) : 0;
            auto* fades = fast.template array<Voice>(fade_count);
            auto* fading = fast.template array<Fade>(fade_count);
            if constexpr (!Dry) {
                tracks[t].desc = d;
                tracks[t].slots = slots;
                tracks[t].voices = voices;
                tracks[t].held = plays ? held : nullptr;
                tracks[t].glides = plays ? glides : nullptr;
                tracks[t].fades = fades;
                tracks[t].fading = fading;
                tracks[t].fade_count = fade_count;
            }
            u32 scalars = 0, state = 0;  // sized for the largest slot, per section 6
            u64 floats = 0;
            for (u32 s = 0; s < d.slot_count; ++s) {
                const u32 patch = p.slot(d.slot_begin + s);
                const PatchView v = patch_view(chunks, p.patch(patch));
                const PatchSizes sizes = measure_patch(v, rate, l);
                scalars = std::max<u32>(scalars, v.h.voice_scalars);
                state = std::max(state, sizes.voice_state);
                floats = std::max(floats, sizes.bulk_floats);
                reserve_slot(patch, Dry ? nullptr : &slots[s]);
            }
            for (u32 i = 0; i < d.voices; ++i) reserve_voice(Dry ? nullptr : &voices[i], scalars, state, floats);
            for (u32 i = 0; i < fade_count; ++i) reserve_voice(Dry ? nullptr : &fades[i], scalars, state, floats);
        }
        for (u32 i = 0; i < h.inserts; ++i) {
            const InsertDesc d = p.insert(i);
            const PatchView v = patch_view(chunks, p.patch(d.patch));
            const PatchSizes sizes = measure_patch(v, rate, l);
            if constexpr (!Dry) inserts[i].desc = d;
            reserve_slot(d.patch, Dry ? nullptr : &inserts[i].slot);
            reserve_voice(Dry ? nullptr : &inserts[i].instance, v.h.voice_scalars, sizes.voice_state,
                          sizes.bulk_floats);
        }

        auto* buses = fast.template array<float>(static_cast<u64>(h.buses) * l.channels * l.frame_size);
        auto* mix = fast.template array<float>(h.mix_regs);
        const bool mix_ramps = (h.features & kFeatureMixRamps) != 0;
        auto* ramps = fast.template array<MixRamp>(mix_ramps ? h.mix_regs : 0);
        auto* globals = fast.template array<float>(h.globals);
        auto* scratch = fast.template array<float>(static_cast<u64>(max_buffers) * l.frame_size * l.workers);
        u32 task_count = 0;
        for (u32 i = 0; i < h.mix_steps; ++i) {
            if (i == 0 || p.mix_step(i).task != p.mix_step(i - 1).task) ++task_count;
        }
        auto* tasks = fast.template array<Task>(task_count);
        if constexpr (!Dry) {
            g.buses = buses;
            g.mix = mix;
            g.mix_ramps = mix_ramps ? ramps : nullptr;
            g.globals = globals;
            g.scratch = scratch;
            g.tasks = tasks;
            g.task_count = task_count;
        }
        if (l.edges) {
            // Worst case, every pair of tasks conflicts.
            auto* deps = fast.template array<u16>(task_count);
            auto* begin = fast.template array<u16>(task_count + 1);
            auto* succ = fast.template array<u16>(static_cast<u64>(task_count) * task_count);
            if constexpr (!Dry && E::uses_edges) {
                g.plan.deps = deps;
                g.plan.succ_begin = begin;
                g.plan.succ = succ;
            }
        }
        if constexpr (!Dry) g.plan.count = task_count;
    }

    // Binding ---------------------------------------------------------------------------------------------------

    [[nodiscard]] u32 free_region() const {
        if (C.generations == 1 || !live_) return 0;
        return live_->region == 0 ? 1 : 0;
    }

    void begin_bind() {
        const ChunkRef* c = chunks_->find(program_hash_, ChunkKind::Program);
        ProgramView p;
        if (!c || !parse_program({c->data, c->size}, p)) {
            error_ = LoadError::MissingChunk;
            load_phase_ = LoadPhase::Idle;
            return;
        }
        const MemorySizes need = bytes_required(*chunks_, program_hash_, rate_);
        const u32 region = free_region();
        const Region& r = regions_[region];
        if (need.fast > r.fast_size || need.bulk > r.bulk_size) {
            error_ = LoadError::OutOfMemory;
            load_phase_ = LoadPhase::Idle;
            return;
        }
        if (C.generations == 1) live_ = nullptr;  // One region: audio stops for a swap

        Generation* g = new (r.fast) Generation();
        g->program = p;
        g->chunks = chunks_;
        g->region = region;
        static constexpr Layout own = layout();
        Bump fast(r.fast + kGenerationBytes, own), bulk(r.bulk, own);
        reserve<false>(*g, *chunks_, fast, bulk, rate_, own);
        pending_ = g;
        bind_phase_ = BindPhase::Patches;
        bind_index_ = 0;
        load_phase_ = LoadPhase::Binding;
    }

    void bind_step() {
        Generation& g = *pending_;
        const ProgramHeader& h = g.program.h;
        switch (bind_phase_) {
            case BindPhase::Patches:
                if (bind_index_ < h.patches) {
                    decode_patch(g, g.bindings[bind_index_++]);
                } else {
                    bind_phase_ = BindPhase::Instances;
                    bind_index_ = 0;
                }
                break;
            case BindPhase::Instances:
                if (bind_index_ < h.tracks) {
                    init_track(g, g.tracks[bind_index_++]);
                } else if (bind_index_ < static_cast<u32>(h.tracks) + h.inserts) {
                    init_insert(g, g.inserts[bind_index_++ - h.tracks]);
                } else {
                    finish_bind(g);
                    bind_phase_ = BindPhase::Done;
                }
                break;
            case BindPhase::Done:
                load_phase_ = LoadPhase::Ready;
                if (C.generations == 1 || !live_) commit();
                break;
        }
    }

    [[nodiscard]] static DecodedOperand decode_operand(u16 o, const Generation& g, const PatchView& v) {
        const Bank bank = operand_bank(o);
        u16 index = operand_index(o);
        if (bank == Bank::Global) {
            const u16 id = v.param(index).id;
            for (u16 i = 0; i < g.program.h.globals; ++i) {
                if (g.program.global(i).id == id) index = i;
            }
        }
        return {static_cast<u16>(bank), index};
    }

    void decode_patch(Generation& g, Binding& b) {
        const PatchView& v = b.view;
        const u32 line_bytes = v.h.delays * sizeof(DelayLine);
        const auto aligned = [](u32 n) { return (n + K::state_align - 1) / K::state_align * K::state_align; };
        u32 control_state = 0, voice_state = aligned(line_bytes);
        b.ends = false;
        LineKinds kinds;
        const u32 total = static_cast<u32>(v.h.control_steps) + v.h.voice_steps;
        for (u32 i = 0; i < total; ++i) {
            const bool control = i < v.h.control_steps;
            const WireStep w = v.step(i);
            const Op op = static_cast<Op>(w.op);
            const OpSignature sig = op_signature(op);
            DecodedStep& d = control ? b.control[i] : b.voice[i - v.h.control_steps];
            d.op = w.op;
            d.mode = w.mode;
            d.resource = op == Op::Noise ? static_cast<u16>(i) : w.resource;
            u32& cursor = control ? control_state : voice_state;
            d.state = cursor;
            cursor += aligned(K::state_size(op));
            for (u32 a = 0; a < sig.outs; ++a) d.out[a] = decode_operand(w.out[a], g, v);
            for (u32 a = 0; a < sig.ins; ++a) d.in[a] = decode_operand(w.in[a], g, v);
            if (sig.ends) b.ends = true;
            if (v.h.delays && !control) kinds.mark(w.op, w.resource);
        }
        b.control_state = control_state;
        b.voice_state = voice_state;
        for (u32 i = 0; i < v.h.delays; ++i) {
            b.line_lengths[i] = line_length(v.delay(i), rate_) | (kinds.i16(i) ? kLineI16 : 0u);
        }
        for (u32 i = 0; i < v.h.refs; ++i) {
            const ChunkRef* c = g.chunks->find(v.ref(i));
            if (c->kind == static_cast<u8>(ChunkKind::Table)) {
                const TableHeader t = modsynth::load<TableHeader>(c->data);
                b.resources[i].table = {reinterpret_cast<const float*>(c->data + sizeof(TableHeader)), t.length,
                                        32u - static_cast<u32>(std::countr_zero(t.length))};
            } else {
                const AssetHeader a = modsynth::load<AssetHeader>(c->data);
                b.resources[i].asset = {c->data + sizeof(AssetHeader),
                                        a.native_rate,
                                        a.frames,
                                        a.loop_start,
                                        a.loop_end,
                                        a.channels,
                                        a.encoding};
            }
        }
    }

    void init_slot(Slot& slot) {
        const PatchView& v = slot.binding->view;
        std::memset(slot.track, 0, sizeof(float) * v.h.track_scalars);
        std::memset(slot.state, 0, slot.binding->control_state);
        for (u32 i = 0; i < v.h.params; ++i) {
            const ParamDesc d = v.param(i);
            slot.params[i] = {d.def, d.def, 0.0f, 0};
            if (d.scope == static_cast<u8>(ParamScope::Track)) slot.track[d.reg] = d.def;
        }
    }

    void init_track(Generation& g, Track& t) {
        t.cursor = {};
        t.age = t.notes = t.guard_trips = t.slot = 0;
        reset_play(t);
        t.held_count = 0;
        t.line = kNone;
        for (u32 s = 0; s < t.desc.slot_count; ++s) {
            init_slot(t.slots[s]);
            apply_inits(g, 0, static_cast<u16>(&t - g.tracks), t.slots[s]);
        }
        for (u32 v = 0; v < t.desc.voices; ++v) {
            t.voices[v].active = false;
            t.voices[v].held = false;
            t.voices[v].gate = {};
            if (t.glides) t.glides[v] = {};
        }
        for (u32 v = 0; v < t.fade_count; ++v) t.fades[v].active = false;
    }

    void init_insert(Generation& g, Insert& i) {
        i.guard_trips = 0;
        init_slot(i.slot);
        apply_inits(g, 1, static_cast<u16>(&i - g.inserts), i.slot);
        init_instance(*i.slot.binding, i.slot, i.instance, 0);
        i.instance.active = true;
    }

    void apply_inits(Generation& g, u16 kind, u16 target, Slot& slot) {
        const PatchView& v = slot.binding->view;
        for (u32 n = 0; n < g.program.h.inits; ++n) {
            const ParamInit in = g.program.init(n);
            if (in.target_kind != kind || in.target != target) continue;
            for (u32 i = 0; i < v.h.params; ++i) {
                const ParamDesc d = v.param(i);
                if (d.id != in.id) continue;
                const float value = clamp(in.value, d.min, d.max);
                slot.params[i] = {value, value, 0.0f, 0};
                if (d.scope == static_cast<u8>(ParamScope::Track)) slot.track[d.reg] = value;
            }
        }
    }

    void finish_bind(Generation& g) {
        const ProgramHeader& h = g.program.h;
        for (u32 i = 0; i < h.mix_regs; ++i) {
            g.mix[i] = g.program.mix_value(i);
            if (g.mix_ramps) g.mix_ramps[i] = {};
        }
        for (u32 i = 0; i < h.globals; ++i) g.globals[i] = g.program.global(i).value;
        u32 task = 0;
        for (u32 i = 0; i < h.mix_steps; ++i) {
            if (i != 0 && g.program.mix_step(i).task == g.program.mix_step(i - 1).task) {
                ++g.tasks[task - 1].count;
            } else {
                g.tasks[task++] = {static_cast<u16>(i), 1};
            }
        }
        if constexpr (E::uses_edges) build_edges(g);
        g.clock = {0, 0, h.uspq, 0, 0, false};
        locate(g, 0, false, false);
    }

    // Two tasks conflict if either writes a register the other touches. Reused registers make that a dependency even
    // with no data flow between them, which is why parallel builds will rename them. Serial builds never run this.
    void build_edges(Generation& g)
        requires(E::uses_edges)
    {
        const u32 count = g.task_count;
        struct Use {
            detail::Bits reads, writes;
        };
        const auto task_use = [&](u32 task) {
            Use u;
            for (u32 i = 0; i < g.tasks[task].count; ++i) {
                const MixStep m = g.program.mix_step(g.tasks[task].first + i);
                u.writes.set(m.dst);
                if (m.op == static_cast<u8>(MixOp::RunInsert)) {
                    u.reads.set(m.src);
                    if (m.key != kNone) u.reads.set(m.key);
                } else if (m.op == static_cast<u8>(MixOp::Gather)) {
                    for (u32 k = 0; k < m.src; ++k) u.reads.set(g.program.gather_input(m.a + k).src);
                }
            }
            return u;
        };
        auto* deps = const_cast<u16*>(g.plan.deps);
        auto* begin = const_cast<u16*>(g.plan.succ_begin);
        auto* succ = const_cast<u16*>(g.plan.succ);
        std::fill(deps, deps + count, u16{0});
        u32 edges = 0;
        for (u32 a = 0; a < count; ++a) {
            begin[a] = static_cast<u16>(edges);
            const Use ua = task_use(a);
            for (u32 b = a + 1; b < count; ++b) {
                const Use ub = task_use(b);
                bool conflict = false;
                for (u32 r = 0; r < kMaxRegisters && !conflict; ++r) {
                    conflict = (ua.writes.get(r) && (ub.reads.get(r) || ub.writes.get(r))) ||
                               (ua.reads.get(r) && ub.writes.get(r));
                }
                if (conflict) {
                    succ[edges++] = static_cast<u16>(b);
                    ++deps[b];
                }
            }
        }
        begin[count] = static_cast<u16>(edges);
    }

    void init_instance(const Binding& b, const Slot& slot, Voice& v, u32 /*seed*/) {
        const PatchView& view = b.view;
        std::memset(v.scalars, 0, sizeof(float) * view.h.voice_scalars);
        std::memset(v.state, 0, b.voice_state);
        auto* lines = reinterpret_cast<DelayLine*>(v.state);
        float* bulk = v.bulk;
        for (u32 i = 0; i < view.h.delays; ++i) {
            const u32 length = b.line_lengths[i] & ~kLineI16;
            lines[i] = {bulk, length, 0, 0};  // Never cleared: `written` makes old contents unreachable
            bulk += line_floats(length, (b.line_lengths[i] & kLineI16) != 0);
        }
        for (u32 i = 0; i < view.h.params; ++i) {
            const ParamDesc d = view.param(i);
            if (d.scope == static_cast<u8>(ParamScope::Voice)) v.scalars[d.reg] = slot.params[i].value;
        }
    }

    // Live edits --------------------------------------------------------------------------------------------------

    void commit() {
        Generation* next = pending_;
        pending_ = nullptr;
        load_phase_ = LoadPhase::Idle;
        if (live_ && C.generations > 1) {
            transfer(*live_, *next);
            old_ = live_;
            fade_ = 0.0f;
            fade_step_ = 1.0f / kFadeSamples;
        }
        live_ = next;
        ++generation_;
        if constexpr (C.tap_slots > 0) {
            for (Tap& t : taps_) {
                t.step = kNone;  // The next program's registers differ, so the host re-sends targets
                t.track = kNone;
                t.filled = 0;
                t.ready = false;
            }
        }
    }

    // State carries across a swap wherever a stateful step's stable id, op and size all match.
    void copy_state(const Binding& from, std::byte* from_state, const Binding& to, std::byte* to_state, bool control) {
        const u32 from_first = control ? 0 : from.view.h.control_steps;
        const u32 from_count = control ? from.view.h.control_steps : from.view.h.voice_steps;
        const u32 to_first = control ? 0 : to.view.h.control_steps;
        const u32 to_count = control ? to.view.h.control_steps : to.view.h.voice_steps;
        const DecodedStep* from_steps = control ? from.control : from.voice;
        const DecodedStep* to_steps = control ? to.control : to.voice;
        for (u32 i = 0; i < to_count; ++i) {
            const WireStep t = to.view.step(to_first + i);
            if (t.state_id == 0) continue;
            for (u32 k = 0; k < from_count; ++k) {
                const WireStep f = from.view.step(from_first + k);
                if (f.state_id != t.state_id || f.op != t.op) continue;
                const u32 size = K::state_size(Op(t.op));
                if (size) std::memcpy(to_state + to_steps[i].state, from_state + from_steps[k].state, size);
                if (op_signature(Op(t.op)).resource == Resource::Delay && !control) {
                    const auto* a = reinterpret_cast<const DelayLine*>(from_state) + f.resource;
                    auto* b = reinterpret_cast<DelayLine*>(to_state) + t.resource;
                    if (a->length == b->length) {  // The same op, so the same kind of sample
                        std::memcpy(b->data, a->data, sizeof(float) * line_floats(a->length, op_line_i16(t.op)));
                        b->write = a->write;
                        b->written = a->written;
                    }
                }
                break;
            }
        }
    }

    // An id says which parameter this is, not what its numbers mean, so a value crosses a swap only as one the new
    // patch allows. A ramp keeps the time it had left. Nothing changes inside the range, so a swap to the same image is
    // exact.
    [[nodiscard]] static ParamState carried(ParamState p, const ParamDesc& d) {
        const float value = clamp(p.value, d.min, d.max);
        const float target = clamp(p.target, d.min, d.max);
        if (value == p.value && target == p.target) return p;
        const float step = p.frames == 0 ? 0.0f : (target - value) / static_cast<float>(p.frames);
        return {value, target, step, p.frames};
    }

    void copy_slot(const Slot& from, Slot& to) {
        const PatchView& a = from.binding->view;
        const PatchView& b = to.binding->view;
        for (u32 i = 0; i < b.h.params; ++i) {
            const ParamDesc d = b.param(i);
            for (u32 k = 0; k < a.h.params; ++k) {
                if (a.param(k).id != d.id) continue;
                to.params[i] = carried(from.params[k], d);
                if (d.scope == static_cast<u8>(ParamScope::Track)) to.track[d.reg] = to.params[i].value;
                break;
            }
        }
        copy_state(*from.binding, from.state, *to.binding, to.state, true);
    }

    void copy_voice(const Voice& from, const Slot& from_slot, Voice& to, const Slot& to_slot) {
        init_instance(*to_slot.binding, to_slot, to, 0);
        for (u32 i = 0; i < kBuiltinVoiceScalars; ++i) to.scalars[i] = from.scalars[i];
        to.age = from.age;
        to.off_tick = from.off_tick;
        to.gate = from.gate;
        to.note = from.note;
        to.velocity = from.velocity;
        to.slot = from.slot;
        to.active = from.active;
        to.held = from.held;
        copy_state(*from_slot.binding, from.state, *to_slot.binding, to.state, false);
    }

    void transfer(const Generation& from, Generation& to) {
        // Cursors come from the new Program at the old position. Live values then overwrite what the chase set.
        to.clock = from.clock;
        const u64 remainder = from.clock.remainder;
        // An instruction at the current tick has already run if the clock is past it, so it must not run again.
        locate(to, from.clock.tick, false, false, remainder > 0 ? from.clock.tick + 1 : from.clock.tick);
        to.clock.tick = from.clock.tick;
        to.clock.remainder = remainder;
        to.clock.playing = from.clock.playing;
        to.clock.loop_start = from.clock.loop_start;
        to.clock.loop_end = from.clock.loop_end;

        for (u32 t = 0; t < to.program.h.tracks; ++t) {
            Track& nt = to.tracks[t];
            const Track* ot = nullptr;
            for (u32 k = 0; k < from.program.h.tracks && !ot; ++k) {
                if (from.tracks[k].desc.id == nt.desc.id) ot = &from.tracks[k];
            }
            if (!ot) continue;
            nt.age = ot->age;
            nt.notes = ot->notes;
            nt.last_note = ot->last_note;
            const u32 slots = std::min<u32>(nt.desc.slot_count, ot->desc.slot_count);
            for (u32 s = 0; s < slots; ++s) copy_slot(ot->slots[s], nt.slots[s]);
            const u32 voices = std::min<u32>(nt.desc.voices, ot->desc.voices);
            for (u32 v = 0; v < voices; ++v) {
                const Voice& ov = ot->voices[v];
                if (ov.active && ov.slot < slots) {
                    copy_voice(ov, ot->slots[ov.slot], nt.voices[v], nt.slots[ov.slot]);
                    if (ot->glides && nt.glides) {
                        nt.glides[v] = ot->glides[v];
                    } else if (ot->glides && ot->glides[v].frames != 0) {
                        nt.voices[v].scalars[kScalarNote] = ot->glides[v].target;  // Nothing here can finish the slide
                    }
                }
            }
            // A line carries over if the new Program still plays one at this tick. Otherwise its voice ends at its own
            // off tick, as any other note does.
            if (ot->line != kNone && ot->line < voices && nt.voices[ot->line].active && nt.held &&
                nt.play != static_cast<u8>(PlayKind::Poly)) {
                std::copy(ot->held, ot->held + ot->held_count, nt.held);
                nt.held_count = ot->held_count;
                nt.line = ot->line;
            }
        }
        for (u32 i = 0; i < to.program.h.inserts; ++i) {
            Insert& n = to.inserts[i];
            for (u32 k = 0; k < from.program.h.inserts; ++k) {
                const Insert& o = from.inserts[k];
                if (o.desc.id != n.desc.id) continue;
                copy_slot(o.slot, n.slot);
                copy_state(*o.slot.binding, o.instance.state, *n.slot.binding, n.instance.state, false);
                break;
            }
        }
        carry_globals(from, to);
        if (same_mixer(from.program, to.program)) carry_mix(from, to);
    }

    // A global lives in the Program and not in a slot, so it doesn't carry with one. Every patch that declares it has
    // its own range, and the value has to fit them all, as it would have to if it had been set here.
    static void carry_globals(const Generation& from, Generation& to) {
        for (u32 n = 0; n < to.program.h.globals; ++n) {
            const u16 id = to.program.global(n).id;
            for (u32 k = 0; k < from.program.h.globals; ++k) {
                if (from.program.global(k).id != id) continue;
                float value = from.globals[k];
                for (u32 p = 0; p < to.program.h.patches; ++p) {
                    const PatchView& v = to.bindings[p].view;
                    for (u32 i = 0; i < v.h.params; ++i) {
                        const ParamDesc d = v.param(i);
                        if (d.id == id && d.scope == static_cast<u8>(ParamScope::Global)) {
                            value = clamp(value, d.min, d.max);
                        }
                    }
                }
                to.globals[n] = value;
                break;
            }
        }
    }

    // A mix register has no id. What it means is where the mixer reads it, so two Programs' registers line up only if
    // their mixers are the same, down to the tracks and inserts they run.
    [[nodiscard]] static bool same_mixer(const ProgramView& a, const ProgramView& b) {
        const ProgramHeader& x = a.h;
        const ProgramHeader& y = b.h;
        if (x.mix_regs != y.mix_regs || x.mix_steps != y.mix_steps || x.gather_inputs != y.gather_inputs ||
            x.tracks != y.tracks || x.inserts != y.inserts || x.master != y.master) {
            return false;
        }
        for (u32 i = 0; i < x.tracks; ++i) {
            if (a.track(i).id != b.track(i).id) return false;
        }
        for (u32 i = 0; i < x.inserts; ++i) {
            if (a.insert(i).id != b.insert(i).id) return false;
        }
        for (u32 i = 0; i < x.mix_steps; ++i) {
            const MixStep s = a.mix_step(i), t = b.mix_step(i);
            if (std::memcmp(&s, &t, sizeof(MixStep)) != 0) return false;
        }
        for (u32 i = 0; i < x.gather_inputs; ++i) {
            const GatherInput s = a.gather_input(i), t = b.gather_input(i);
            if (std::memcmp(&s, &t, sizeof(GatherInput)) != 0) return false;
        }
        return true;
    }

    // An edit that changes where a register starts has moved that fader, and the new value is what it asked for.
    static void carry_mix(const Generation& from, Generation& to) {
        for (u32 i = 0; i < to.program.h.mix_regs; ++i) {
            if (from.program.mix_value(i) != to.program.mix_value(i)) continue;
            to.mix[i] = from.mix[i];
            if (!from.mix_ramps || from.mix_ramps[i].frames == 0) continue;
            if (to.mix_ramps) {
                to.mix_ramps[i] = from.mix_ramps[i];
            } else {
                to.mix[i] = from.mix_ramps[i].target;  // Nothing here can finish the slide
            }
        }
    }

    void crossfade(const std::array<float*, C.channels>& out) {
        for (u32 ch = 0; ch < C.channels; ++ch) {
            const float* previous = bus(*old_, old_->program.h.master, ch);
            float* mixed = out[ch];
            float gain = fade_;
            for (u32 i = 0; i < N; ++i) {
                mixed[i] = mixed[i] * gain + previous[i] * (1.0f - gain);
                gain = std::min(gain + fade_step_, 1.0f);
            }
        }
        fade_ = std::min(fade_ + fade_step_ * static_cast<float>(N), 1.0f);
        if (fade_ >= 1.0f) old_ = nullptr;
    }

    // Control phase -----------------------------------------------------------------------------------------------

    void control_phase(Generation& g) {
        drain_events(&g);
        run_control(g);
    }

    void run_control(Generation& g) {
        transport(g);
        if (g.mix_ramps) {
            update_mix_ramps(g);
            count([&](Work& w) { w.mix_registers += g.program.h.mix_regs; });
        }
        for (u32 t = 0; t < g.program.h.tracks; ++t) {
            Track& track = g.tracks[t];
            if (track.glides) {
                update_glides(track);
                count([&](Work& w) { w.glides += track.desc.voices; });
            }
            for (u32 s = 0; s < track.desc.slot_count; ++s) update_slot(g, track.slots[s]);
        }
        for (u32 i = 0; i < g.program.h.inserts; ++i) update_slot(g, g.inserts[i].slot);
    }

    static void update_mix_ramps(Generation& g) {
        for (u32 i = 0; i < g.program.h.mix_regs; ++i) {
            MixRamp& r = g.mix_ramps[i];
            if (r.frames == 0) continue;
            g.mix[i] = --r.frames == 0 ? r.target : g.mix[i] + r.step;
        }
    }

    static void update_glides(Track& t) {
        for (u32 v = 0; v < t.desc.voices; ++v) {
            Glide& glide = t.glides[v];
            if (glide.frames != 0) {
                float& note = t.voices[v].scalars[kScalarNote];
                note = --glide.frames == 0 ? glide.target : note + glide.step;
            }
            if (glide.velocity_frames != 0) {
                float& velocity = t.voices[v].scalars[kScalarVelocity];
                velocity = --glide.velocity_frames == 0 ? glide.velocity_target : velocity + glide.velocity_step;
            }
        }
    }

    void update_slot(Generation& g, Slot& slot) {
        const PatchView& v = slot.binding->view;
        count([&](Work& w) {
            ++w.slots;
            w.params += v.h.params;
        });
        for (u32 i = 0; i < v.h.params; ++i) {
            ParamState& p = slot.params[i];
            if (p.frames == 0) continue;
            count([](Work& w) { ++w.moving; });
            p.value = --p.frames == 0 ? p.target : p.value + p.step;
            const ParamDesc d = v.param(i);
            if (d.scope == static_cast<u8>(ParamScope::Track)) slot.track[d.reg] = p.value;
        }
        if (v.h.control_steps == 0) return;
        RunContext c = context(g, *slot.binding, slot, nullptr, g.scratch);
        c.state = slot.state;
        c.stopped = !g.clock.playing;
        K::run(slot.binding->control, v.h.control_steps, c);
        count_steps(slot.binding->control, v.h.control_steps);
    }

    void drain_events(Generation* g) {
        while (queue_read_ != queue_write_) {
            const Event e = queue_[queue_read_];
            queue_read_ = (queue_read_ + 1) % kQueueSize;
            if (g) apply_event(*g, e);
        }
    }

    void apply_event(Generation& g, const Event& e) {
        const ProgramHeader& h = g.program.h;
        switch (e.kind) {
            case EventKind::NoteOn:
                if (e.target < h.tracks) {
                    Track& t = g.tracks[e.target];
                    note_on(g, t, e.note, e.velocity, 0, kNoTick, t.ordinal++);
                }
                break;
            case EventKind::NoteOff:
                if (e.target < h.tracks) {
                    Track& t = g.tracks[e.target];
                    if (live_note_off(g, t, e.note)) break;
                    for (u32 v = 0; v < t.desc.voices; ++v) {
                        Voice& voice = t.voices[v];
                        if (v != t.line && voice.active && voice.held && voice.note == e.note) release(voice, 0);
                    }
                }
                break;
            case EventKind::SetParam:
                if (e.target < h.tracks) set_track_param(g, g.tracks[e.target], e.param, e.value, 0);
                break;
            case EventKind::SetInsertParam:
                if (e.target < h.inserts) {
                    Insert& i = g.inserts[e.target];
                    set_slot_param(g, nullptr, i.slot, e.param, e.value, 0);
                }
                break;
            case EventKind::SetMix:
                if (e.param < h.mix_regs) set_mix(g, e.param, e.value);
                break;
            case EventKind::SetTap:
                if constexpr (C.tap_slots > 0) {
                    if (e.param < C.tap_slots) {
                        Tap& t = taps_[e.param];
                        const bool valid = e.target < h.mix_steps && e.note < h.buses && e.channel < Ch;
                        t.step = valid ? e.target : kNone;
                        t.reg = e.note;
                        t.channel = e.channel;
                        t.track = kNone;
                        t.filled = 0;
                    }
                }
                break;
            case EventKind::SetProbe:
                if constexpr (C.tap_slots > 0) {
                    if (e.param < C.tap_slots) {
                        Tap& t = taps_[e.param];
                        t.step = kNone;
                        t.track = probe_valid(g, e) ? e.target : kNone;
                        t.slot = e.channel;
                        t.voice_step = static_cast<u16>(e.tick);
                        t.operand = static_cast<u16>(e.tick_end);
                        t.filled = 0;
                        t.caught = false;
                    }
                }
                break;
            case EventKind::Play:
                g.clock.playing = true;
                break;
            case EventKind::Stop:
                g.clock.playing = false;
                release_all(g, 0);
                break;
            case EventKind::Locate:
                locate(g, e.tick, true, true);
                break;
            case EventKind::SetLoop:
                g.clock.loop_start = e.tick;
                g.clock.loop_end = e.tick_end;
                break;
        }
    }

    // Program interpreter -----------------------------------------------------------------------------------------

    [[nodiscard]] u64 ticks_denominator(const Clock& k) const { return static_cast<u64>(int_rate_) * k.uspq; }
    [[nodiscard]] static u64 samples_unit(const Generation& g) { return 1000000ull * g.program.h.ppq; }

    // How many ticks past the clock a target can be and still come within `limit` samples. A loop over many targets
    // works this out once, which saves a 64-bit division for each.
    [[nodiscard]] u64 horizon(const Generation& g, u32 limit) const {
        return (samples_unit(g) * limit) / ticks_denominator(g.clock) + 2;
    }

    // Samples until tick T, rounded up. Returns at least `limit` when T is that far away or further.
    [[nodiscard]] u32 samples_to(const Generation& g, u32 target, u32 limit) const {
        return samples_to(g, target, limit, horizon(g, limit));
    }
    [[nodiscard]] u32 samples_to(const Generation& g, u32 target, u32 limit, u64 reach) const {
        const Clock& k = g.clock;
        if (target <= k.tick) return 0;
        if (target - k.tick > reach) return limit;
        const u64 d = ticks_denominator(k), unit = samples_unit(g);
        const u64 units = static_cast<u64>(target - k.tick) * d - k.remainder;
        const u64 samples = (units + unit - 1) / unit;
        return samples >= limit ? limit : static_cast<u32>(samples);
    }

    void advance_clock(Generation& g, u32 samples) {
        Clock& k = g.clock;
        const u64 d = ticks_denominator(k);
        const u64 total = k.remainder + samples_unit(g) * samples;
        k.tick += static_cast<u32>(total / d);
        k.remainder = total % d;
    }

    void transport(Generation& g) {
        Clock& k = g.clock;
        if (!k.playing) return;
        u32 position = 0;
        bool wrapped = false;  // At most once per frame, so a tiny loop cannot spin
        while (position < N) {
            u32 segment = N - position;
            if (g.conductor.tick != kNoTick) segment = samples_to(g, g.conductor.tick, segment);
            if (k.loop_end != 0 && !wrapped) segment = samples_to(g, k.loop_end, segment);
            dispatch(g, position, segment);
            advance_clock(g, segment);
            position += segment;
            while (g.conductor.tick <= k.tick && g.conductor.tick != kNoTick) {
                step_conductor(g);
                count([](Work& w) { ++w.instructions; });
            }
            if (k.loop_end != 0 && !wrapped && k.tick >= k.loop_end) {
                wrapped = true;
                release_all(g, position < N ? position : N - 1);
                locate(g, k.loop_start, true, false);
            }
        }
    }

    void dispatch(Generation& g, u32 base, u32 segment) {
        if (segment == 0) return;
        // Worked out once, the first time a target needs it. Nothing here moves the clock.
        u64 reach = 0;
        bool reached = false;
        const auto ticks_within = [&] {
            if (!reached) reach = horizon(g, segment);
            reached = true;
            return reach;
        };
        count([&](Work& w) {
            ++w.segments;
            w.track_segments += g.program.h.tracks;
        });
        for (u32 t = 0; t < g.program.h.tracks; ++t) {
            Track& track = g.tracks[t];
            count([&](Work& w) { w.voice_slots += track.desc.voices; });
            for (u32 v = 0; v < track.desc.voices; ++v) {
                Voice& voice = track.voices[v];
                if (v == track.line || !voice.active || !voice.held || voice.off_tick == kNoTick) continue;
                count([](Work& w) { ++w.held; });
                const u32 s = samples_to(g, voice.off_tick, segment, ticks_within());
                if (s < segment) release(voice, base + s);
            }
            // In time order, because on a line what a note does depends on what is held when it starts. At the same
            // sample the end goes first, so a note that only touches the next one is not an overlap.
            for (;;) {
                u32 first_off = 0, off = segment;
                count([&](Work& w) { w.held_notes += track.held_count; });
                for (u32 i = 0; i < track.held_count; ++i) {
                    if (track.held[i].off_tick == kNoTick) continue;
                    const u32 s = samples_to(g, track.held[i].off_tick, segment, ticks_within());
                    if (s < off) {
                        off = s;
                        first_off = i;
                    }
                }
                const u32 next =
                    track.cursor.tick == kNoTick ? segment : samples_to(g, track.cursor.tick, segment, ticks_within());
                if (off < segment && off <= next) {
                    held_note_off(g, track, first_off, base + off);
                } else if (next < segment) {
                    step_track(g, track, base + next, false, 0);
                    count([](Work& w) { ++w.instructions; });
                } else {
                    break;
                }
            }
        }
    }

    [[nodiscard]] static Cursor make_cursor(u32 begin, u32 length) { return {begin, begin + length, 0, 0, 0, 0, 0}; }

    void step_conductor(Generation& g) {
        Cursor& c = g.conductor;
        if (c.pc >= c.end) {
            c.tick = kNoTick;
            return;
        }
        const Instruction in = g.program.instruction(c.pc++);
        if (in.op == static_cast<u8>(Instr::Wait)) {
            c.tick += in.c;
        } else if (in.op == static_cast<u8>(Instr::Tempo)) {
            g.clock.uspq = in.c;
            g.clock.remainder = 0;  // Rounds to the sample at each change, and only then
        } else {
            c.tick = kNoTick;
        }
    }

    // Executes the instruction at the cursor. With `chase`, nothing sounds and `target` is the tick being located to.
    void step_track(Generation& g, Track& t, u32 offset, bool chase, u32 target, bool start_notes = false) {
        Cursor& c = t.cursor;
        if (c.pc >= c.end) {
            if (c.repeats > 1) {
                --c.repeats;
                c.pc = c.clip_begin;
            } else if (c.repeats == 1) {
                c.repeats = 0;
                c.pc = c.ret_pc;
                c.end = c.ret_end;
            } else {
                c.tick = kNoTick;
            }
            return;
        }
        const Instruction in = g.program.instruction(c.pc++);
        switch (static_cast<Instr>(in.op)) {
            case Instr::Wait:
                c.tick += in.c;
                break;
            case Instr::NoteOn: {
                // Counted whether or not it plays, so a round robin after a locate picks what it would have.
                const u32 ordinal = t.ordinal++;
                if (!chase ||
                    (start_notes && c.tick + in.c > target)) {  // Chasing, that is a note held across the point
                    note_on(g, t, in.a, static_cast<u8>(in.b), offset, c.tick + in.c, ordinal);
                } else {
                    t.last_note = static_cast<float>(in.a);  // So a glide after a locate starts where it would have
                }
                break;
            }
            case Instr::Steal:
                t.steal = in.a;
                break;
            case Instr::SetPatch:
                t.slot = in.a;
                break;
            case Instr::SetParam:
                set_track_param(g, t, in.b, std::bit_cast<float>(in.c), 0, true);
                break;
            case Instr::Ramp: {
                const Instruction arg = g.program.instruction(c.pc++);
                const float value = std::bit_cast<float>(in.c);
                if (!chase) {
                    set_track_param(g, t, in.b, value, ticks_to_frames(g, arg.c));
                } else if (c.tick + arg.c <= target) {
                    set_track_param(g, t, in.b, value, 0, true);
                } else {
                    // Part way through: resume from where the ramp would be now.
                    const float done = static_cast<float>(target - c.tick) / static_cast<float>(arg.c);
                    chase_ramp(g, t, in.b, value, done, ticks_to_frames(g, c.tick + arg.c - target));
                }
                break;
            }
            case Instr::SetInsert:
                set_slot_param(g, nullptr, g.inserts[in.a].slot, in.b, std::bit_cast<float>(in.c), 0, true);
                break;
            case Instr::RampInsert: {
                const Instruction arg = g.program.instruction(c.pc++);
                const float value = std::bit_cast<float>(in.c);
                Slot& slot = g.inserts[in.a].slot;
                if (!chase) {
                    set_slot_param(g, nullptr, slot, in.b, value, ticks_to_frames(g, arg.c));
                } else if (c.tick + arg.c <= target) {
                    set_slot_param(g, nullptr, slot, in.b, value, 0, true);
                } else {
                    const float done = static_cast<float>(target - c.tick) / static_cast<float>(arg.c);
                    chase_slot_ramp(g, nullptr, slot, in.b, value, done, ticks_to_frames(g, c.tick + arg.c - target),
                                    0);
                }
                break;
            }
            case Instr::SetMix:
                set_mix(g, in.b, std::bit_cast<float>(in.c));
                break;
            case Instr::RampMix: {
                const Instruction arg = g.program.instruction(c.pc++);
                const float value = std::bit_cast<float>(in.c);
                if (!chase) {
                    ramp_mix(g, in.b, value, ticks_to_frames(g, arg.c));
                } else if (c.tick + arg.c <= target) {
                    set_mix(g, in.b, value);
                } else {
                    const float current = g.mix[in.b];
                    const float done = static_cast<float>(target - c.tick) / static_cast<float>(arg.c);
                    set_mix(g, in.b, current + (value - current) * done);
                    ramp_mix(g, in.b, value, ticks_to_frames(g, c.tick + arg.c - target));
                }
                break;
            }
            case Instr::PlayMode:
                set_play(t, in.a, static_cast<u8>(in.b), std::bit_cast<float>(in.c));
                break;
            case Instr::Call: {
                const ClipDesc clip = g.program.clip(in.b);
                c.ret_pc = c.pc;
                c.ret_end = c.end;
                c.clip_begin = clip.begin;
                c.pc = clip.begin;
                c.end = clip.begin + clip.length;
                c.repeats = in.c;
                break;
            }
            default:
                c.tick = kNoTick;
        }
    }

    [[nodiscard]] u32 ticks_to_frames(const Generation& g, u32 ticks) const {
        const float seconds =
            static_cast<float>(ticks) * static_cast<float>(g.clock.uspq) * 1e-6f / static_cast<float>(g.program.h.ppq);
        const float frames = seconds * rate_ / static_cast<float>(N);
        return frames < 4e9f ? static_cast<u32>(frames) + 1 : 0xFFFFFFFFu;
    }

    // Moves a generation to a tick by replaying its streams silently, which chases parameters and, if asked, held
    // notes.
    void locate(Generation& g, u32 tick, bool start_notes, bool kill, u32 chase_until = kNoTick) {
        if (chase_until == kNoTick) chase_until = tick;
        const ProgramHeader& h = g.program.h;
        if (kill) {
            for (u32 t = 0; t < h.tracks; ++t) {
                for (u32 v = 0; v < g.tracks[t].desc.voices; ++v) g.tracks[t].voices[v].active = false;
                for (u32 v = 0; v < g.tracks[t].fade_count; ++v) g.tracks[t].fades[v].active = false;
            }
        }
        g.clock.tick = tick;
        g.clock.remainder = 0;
        g.clock.uspq = h.uspq;
        g.conductor = make_cursor(h.conductor_begin, h.conductor_length);
        while (g.conductor.tick <= tick && g.conductor.tick != kNoTick) step_conductor(g);
        for (u32 t = 0; t < h.tracks; ++t) {
            Track& track = g.tracks[t];
            track.cursor = make_cursor(track.desc.stream_begin, track.desc.stream_length);
            track.slot = 0;
            reset_play(track);
            track.held_count = 0;
            track.line = kNone;
            while (track.cursor.tick < chase_until) step_track(g, track, 0, true, tick, start_notes);
            // A track's mode is in force before its first note, even one played live with the transport stopped.
            while (track.cursor.tick == chase_until && track.cursor.pc < track.cursor.end &&
                   g.program.instruction(track.cursor.pc).op == static_cast<u8>(Instr::PlayMode)) {
                step_track(g, track, 0, true, tick, start_notes);
            }
        }
    }

    // Voices and parameters ---------------------------------------------------------------------------------------

    static void release(Voice& v, u32 offset) {
        v.held = false;
        v.gate.off = static_cast<u16>(offset);
        v.scalars[kScalarGate] = 0.0f;
    }

    static void release_all(Generation& g, u32 offset) {
        for (u32 t = 0; t < g.program.h.tracks; ++t) {
            Track& track = g.tracks[t];
            track.held_count = 0;
            track.line = kNone;
            for (u32 v = 0; v < track.desc.voices; ++v) {
                if (track.voices[v].active && track.voices[v].held) release(track.voices[v], offset);
            }
        }
    }

    [[nodiscard]] static Voice& pick_voice(Track& t) {
        Voice* oldest = &t.voices[0];
        Voice* oldest_released = nullptr;
        for (u32 v = 0; v < t.desc.voices; ++v) {
            Voice& voice = t.voices[v];
            if (!voice.active) return voice;
            if (static_cast<std::int32_t>(voice.age - oldest->age) < 0) oldest = &voice;
            if (!voice.held && (!oldest_released || static_cast<std::int32_t>(voice.age - oldest_released->age) < 0)) {
                oldest_released = &voice;
            }
        }
        return oldest_released ? *oldest_released : *oldest;
    }

    // What a stream sets up from its start, which a locate replays.
    static void reset_play(Track& t) {
        t.play = static_cast<u8>(PlayKind::Poly);
        t.priority = static_cast<u8>(NotePriority::Last);
        t.glide = 0.0f;
        t.last_note = -1.0f;
        t.steal = 0;
        t.ordinal = 0;
    }

    // Applies to the next note, as SetPatch does. Going back to poly leaves the voice sounding to end at its own tick.
    static void set_play(Track& t, u8 play, u8 priority, float glide) {
        if (play == static_cast<u8>(PlayKind::Poly)) {
            t.held_count = 0;
            t.line = kNone;
        }
        t.play = play;
        t.priority = priority;
        t.glide = glide;
    }

    void begin_glide(Track& t, Voice& v, float from, float to) {
        Glide& glide = t.glides[&v - t.voices];
        glide.frames = 0;
        if (!(t.glide > 0.0f) || from < 0.0f || from == to) {
            v.scalars[kScalarNote] = to;
            return;
        }
        glide.frames = std::max<u32>(static_cast<u32>(t.glide * rate_ / static_cast<float>(N)), 1);
        glide.target = to;
        glide.step = (to - from) / static_cast<float>(glide.frames);
        v.scalars[kScalarNote] = from;
    }

    void note_on(Generation& g, Track& t, u8 note, u8 velocity, u32 offset, u32 off_tick, u32 ordinal) {
        if (!t.held) {
            start_note(g, t, note, velocity, offset, off_tick, ordinal);
        } else if (t.play == static_cast<u8>(PlayKind::Poly)) {
            const float from = t.last_note;
            begin_glide(t, start_note(g, t, note, velocity, offset, off_tick, ordinal), from, static_cast<float>(note));
            t.last_note = static_cast<float>(note);
        } else {
            if (t.held_count == kMaxHeldNotes) remove_held(t, t.held[0].sounding ? 1 : 0);
            t.held[t.held_count++] = {off_tick, ordinal, note, velocity, false};
            choose_line(g, t, offset);
        }
    }

    static void remove_held(Track& t, u32 index) {
        std::copy(t.held + index + 1, t.held + t.held_count, t.held + index);
        --t.held_count;
    }

    // Puts the note that priority chooses on the line, if it is not there already. Ties go to the newest note.
    void choose_line(Generation& g, Track& t, u32 offset) {
        u32 best = 0;
        for (u32 i = 1; i < t.held_count; ++i) {
            const u8 note = t.held[i].note, other = t.held[best].note;
            const bool wins = t.priority == static_cast<u8>(NotePriority::High)  ? note >= other
                              : t.priority == static_cast<u8>(NotePriority::Low) ? note <= other
                                                                                 : true;
            if (wins) best = i;
        }
        if (t.held[best].sounding) return;
        for (u32 i = 0; i < t.held_count; ++i) t.held[i].sounding = i == best;
        const Held next = t.held[best];

        Voice* line = t.line != kNone && t.voices[t.line].active && t.voices[t.line].held ? &t.voices[t.line] : nullptr;
        const bool legato =
            t.play == static_cast<u8>(PlayKind::Legato) || t.play == static_cast<u8>(PlayKind::LegatoVelocity);
        // Legato slides only across an overlap. Mono slides from the last note even over a gap.
        const float from = line ? line->scalars[kScalarNote] : legato ? -1.0f : t.last_note;
        const float pitch = static_cast<float>(next.note);
        t.last_note = pitch;
        const u32 slot = t.slot < t.desc.slot_count ? t.slot : 0;
        if (legato && line && line->slot == slot) {
            line->note = next.note;
            line->off_tick = next.off_tick;
            begin_glide(t, *line, from, pitch);
            if (t.play == static_cast<u8>(PlayKind::LegatoVelocity)) bring_velocity(t, *line, next.velocity);
            return;
        }
        if (line) release(*line, offset);
        Voice& v = start_note(g, t, next.note, next.velocity, offset, next.off_tick, next.ordinal);
        t.line = static_cast<u16>(&v - t.voices);
        begin_glide(t, v, from, pitch);
    }

    void held_note_off(Generation& g, Track& t, u32 index, u32 offset) {
        const bool sounding = t.held[index].sounding;
        remove_held(t, index);
        if (!sounding) return;
        if (t.held_count != 0) {
            choose_line(g, t, offset);
            return;
        }
        if (t.line != kNone && t.voices[t.line].active && t.voices[t.line].held) release(t.voices[t.line], offset);
        t.line = kNone;
    }

    // True if a held note took this NoteOff. A stream's notes end at their own ticks, so only a live one can.
    bool live_note_off(Generation& g, Track& t, u8 note) {
        for (u32 i = t.held_count; i-- > 0;) {
            if (t.held[i].note != note || t.held[i].off_tick != kNoTick) continue;
            held_note_off(g, t, i, 0);
            return true;
        }
        return false;
    }

    // Moves a legato line's velocity to a new note's, over its glide or kVelocityGlideSeconds, whichever is longer, so
    // a patch reading it doesn't jump.
    void bring_velocity(Track& t, Voice& v, u8 velocity) {
        Glide& glide = t.glides[&v - t.voices];
        v.velocity = velocity;
        glide.velocity_frames = std::max<u32>(
            static_cast<u32>(std::max(t.glide, kVelocityGlideSeconds) * rate_ / static_cast<float>(N)), 1);
        glide.velocity_target = static_cast<float>(velocity) / 127.0f;
        glide.velocity_step =
            (glide.velocity_target - v.scalars[kScalarVelocity]) / static_cast<float>(glide.velocity_frames);
    }

    // Moves a stolen voice's sound to a fade slot, where it plays on and fades out from the sample the new note starts
    // on. Its memory goes with it, so nothing is copied: the voice takes the slot's, and the new note starts there.
    // With every slot fading, the one furthest through is cut short.
    void fade_out(Track& t, Voice& v, u32 offset) {
        u32 pick = 0;
        for (u32 i = 0; i < t.fade_count; ++i) {
            if (!t.fades[i].active) {
                pick = i;
                break;
            }
            if (t.fading[i].done > t.fading[pick].done) pick = i;
        }
        Voice& f = t.fades[pick];
        std::swap(f.scalars, v.scalars);
        std::swap(f.state, v.state);
        std::swap(f.bulk, v.bulk);
        f.age = v.age;
        f.off_tick = v.off_tick;
        f.ordinal = v.ordinal;
        f.gate = v.gate;
        f.note = v.note;
        f.velocity = v.velocity;
        f.slot = v.slot;
        f.active = true;
        f.held = false;
        t.fading[pick] = {static_cast<u32>(&v - t.voices), offset, 0};
    }

    Voice& start_note(Generation& g, Track& t, u8 note, u8 velocity, u32 offset, u32 off_tick, u32 ordinal) {
        Voice& v = pick_voice(t);
        if (v.active && t.steal && t.fade_count) fade_out(t, v, offset);
        if (t.glides) t.glides[&v - t.voices].velocity_frames = 0;
        v.ordinal = ordinal;
        const u32 slot = t.slot < t.desc.slot_count ? t.slot : 0;
        init_instance(*t.slots[slot].binding, t.slots[slot], v, 0);
        count([&](Work& w) {
            const Binding& b = *t.slots[slot].binding;
            ++w.notes;
            w.note_voices += t.desc.voices + t.fade_count;
            w.note_params += b.view.h.params;
            w.note_bytes += 4 * b.view.h.voice_scalars + b.voice_state;
            for (u32 i = 0; i < b.view.h.voice_steps; ++i) {
                const DecodedStep& s = b.voice[i];
                if (s.op == static_cast<u8>(Op::Sample2))
                    w.zone_rows += b.resources[s.resource].table.length / kZoneFields;
                if (s.op == static_cast<u8>(Op::Sample3))
                    w.zone_rows += b.resources[s.resource].table.length / kZone3Fields;
            }
        });
        v.scalars[kScalarNote] = static_cast<float>(note);
        v.scalars[kScalarVelocity] = static_cast<float>(velocity) / 127.0f;
        v.scalars[kScalarGate] = 1.0f;
        v.age = ++t.age;
        v.off_tick = off_tick;
        v.gate = {static_cast<u16>(offset), kNone};
        v.note = note;
        v.velocity = velocity;
        v.slot = static_cast<u8>(slot);
        v.active = true;
        v.held = true;
        ++t.notes;
        (void)g;
        return v;
    }

    void set_mix(Generation& g, u16 reg, float value) {
        g.mix[reg] = value;
        if (g.mix_ramps) g.mix_ramps[reg].frames = 0;
    }

    static void ramp_mix(Generation& g, u16 reg, float value, u32 frames) {
        g.mix_ramps[reg] = {value, (value - g.mix[reg]) / static_cast<float>(frames), frames};
    }

    void set_track_param(Generation& g, Track& t, u16 id, float value, u32 frames, bool immediate = false) {
        for (u32 s = 0; s < t.desc.slot_count; ++s) set_slot_param(g, &t, t.slots[s], id, value, frames, immediate, s);
    }

    void chase_ramp(Generation& g, Track& t, u16 id, float value, float done, u32 frames) {
        for (u32 s = 0; s < t.desc.slot_count; ++s) chase_slot_ramp(g, &t, t.slots[s], id, value, done, frames, s);
    }

    void chase_slot_ramp(Generation& g, Track* t, Slot& slot, u16 id, float value, float done, u32 frames, u32 s) {
        const PatchView& v = slot.binding->view;
        for (u32 i = 0; i < v.h.params; ++i) {
            if (v.param(i).id != id) continue;
            const float current = slot.params[i].value;
            set_slot_param(g, t, slot, id, current + (value - current) * done, 0, true, s);
            set_slot_param(g, t, slot, id, value, frames, false, s);
        }
    }

    void set_slot_param(Generation& g, Track* track, Slot& slot, u16 id, float value, u32 frames,
                        bool immediate = false, u32 slot_index = 0) {
        const PatchView& v = slot.binding->view;
        for (u32 i = 0; i < v.h.params; ++i) {
            const ParamDesc d = v.param(i);
            if (d.id != id) continue;
            ParamState& p = slot.params[i];
            const float target = clamp(value, d.min, d.max);
            if (d.scope == static_cast<u8>(ParamScope::Track)) {
                if (frames == 0 && !immediate) {
                    frames = static_cast<u32>(static_cast<float>(d.smooth_ms) * 0.001f * rate_ / static_cast<float>(N));
                }
                if (frames == 0) {
                    p = {target, target, 0.0f, 0};
                    slot.track[d.reg] = target;
                } else {
                    p.target = target;
                    p.step = (target - p.value) / static_cast<float>(frames);
                    p.frames = frames;
                }
            } else if (d.scope == static_cast<u8>(ParamScope::Voice)) {
                p = {target, target, 0.0f, 0};
                if (track) {
                    for (u32 n = 0; n < track->desc.voices; ++n) {
                        Voice& voice = track->voices[n];
                        if (voice.active && voice.slot == slot_index) voice.scalars[d.reg] = target;
                    }
                }
            } else {
                p = {target, target, 0.0f, 0};
                for (u32 n = 0; n < g.program.h.globals; ++n) {
                    if (g.program.global(n).id == id) g.globals[n] = target;  // Control phase only, per section 18
                }
            }
        }
    }

    // Audio phase -------------------------------------------------------------------------------------------------

    void audio_phase(Generation& g, bool tapping) {
        exec_.run(g.plan, [this, &g, tapping](u32 task, u32 worker) { run_task(g, task, worker, tapping); });
    }

    [[nodiscard]] static float* bus(const Generation& g, u32 reg, u32 channel) {
        return g.buses + (reg * Ch + channel) * N;
    }

    [[nodiscard]] RunContext context(Generation& g, const Binding& b, const Slot& slot, Voice* voice,
                                     float* scratch) const {
        RunContext c;
        c.buffers = scratch;
        c.track = slot.track;
        c.voice = voice ? voice->scalars : nullptr;
        c.banks[static_cast<u32>(Bank::Voice)] = c.voice;
        c.banks[static_cast<u32>(Bank::Track)] = c.track;
        c.banks[static_cast<u32>(Bank::Global)] = g.globals;
        c.banks[static_cast<u32>(Bank::Const)] = reinterpret_cast<const float*>(b.view.base + b.view.consts);
        c.resources = b.resources;
        c.rate = rate_;
        c.inverse_rate = inverse_rate_;
        return c;
    }

    void run_task(Generation& g, u32 task, u32 worker, bool tapping) {
        float* scratch = g.scratch;
        if constexpr (E::max_workers > 1) {
            std::size_t max_buffers = 0;
            for (u32 i = 0; i < g.program.h.patches; ++i) {
                max_buffers = std::max<std::size_t>(max_buffers, g.bindings[i].view.h.buffers);
            }
            scratch += max_buffers * N * worker;
        }
        const Task t = g.tasks[task];
        for (u32 i = 0; i < t.count; ++i) {
            const u32 index = t.first + i;
            const MixStep m = g.program.mix_step(index);
            switch (static_cast<MixOp>(m.op)) {
                case MixOp::RunVoices:
                    run_voices(g, g.tracks[m.a], m.dst, scratch, tapping);
                    break;
                case MixOp::RunInsert:
                    run_insert(g, g.inserts[m.a], m, scratch);
                    break;
                case MixOp::Gather:
                    gather(g, m);
                    break;
            }
            if constexpr (C.tap_slots > 0) {
                if (tapping) capture_taps(g, index);
            }
        }
    }

    void run_voices(Generation& g, Track& t, u32 dst, float* scratch, bool tapping) {
        for (u32 ch = 0; ch < Ch; ++ch) B::fill(0.0f, bus(g, dst, ch), N);
        [[maybe_unused]] u32 followed = t.desc.voices;
        if constexpr (C.tap_slots > 0) {
            if (tapping) followed = followed_voice(g, t);
        }
        for (u32 n = 0; n < t.desc.voices; ++n) {
            Voice& v = t.voices[n];
            if (!v.active) {
                count([](Work& w) { ++w.idle; });
                continue;
            }
            const Slot& slot = t.slots[v.slot];
            const Binding& b = *slot.binding;
            RunContext c = context(g, b, slot, &v, scratch);
            c.state = v.state;
            c.lines = reinterpret_cast<DelayLine*>(v.state);
            c.gate = v.gate;
            c.note = v.note;
            c.velocity = v.velocity;
            c.ordinal = v.ordinal;
            c.seed = (static_cast<u32>(t.desc.id) << 16) ^ (n << 8) ^ v.age;
            if constexpr (C.tap_slots > 0) {
                if (n == followed) {
                    run_probed(g, t, b, c, v.slot, scratch);
                } else {
                    K::run(b.voice, b.view.h.voice_steps, c);
                }
            } else {
                K::run(b.voice, b.view.h.voice_steps, c);
            }
            count([](Work& w) { ++w.run; });
            count_steps(b.voice, b.view.h.voice_steps);

            const float* left = scratch + operand_index(b.view.h.out_left) * N;
            const float* right = scratch + operand_index(b.view.h.out_right) * N;
            const bool same = b.view.h.out_left == b.view.h.out_right;
            v.gate = {};
            if (!finite(left, right, same)) {
                v.active = false;
                ++t.guard_trips;
                continue;
            }
            mix_output(g, dst, left, right, same);
            if (!v.held && (!b.ends || !c.busy)) v.active = false;
        }
        for (u32 n = 0; n < t.fade_count; ++n) run_fade(g, t, n, dst, scratch);
        if constexpr (C.tap_slots > 0) {
            if (tapping) finish_probes(g, t);
        }
    }

    // A stolen voice's sound, at full level up to the sample its voice was taken on and then falling in a straight line
    // to nothing over fade_length_ samples. It also ends if its own sound does.
    void run_fade(Generation& g, Track& t, u32 n, u32 dst, float* scratch) {
        Voice& v = t.fades[n];
        if (!v.active) return;
        Fade& f = t.fading[n];
        const Slot& slot = t.slots[v.slot];
        const Binding& b = *slot.binding;
        RunContext c = context(g, b, slot, &v, scratch);
        c.state = v.state;
        c.lines = reinterpret_cast<DelayLine*>(v.state);
        c.gate = v.gate;
        c.note = v.note;
        c.velocity = v.velocity;
        c.ordinal = v.ordinal;
        c.seed = (static_cast<u32>(t.desc.id) << 16) ^ (f.index << 8) ^ v.age;
        K::run(b.voice, b.view.h.voice_steps, c);
        count([](Work& w) {
            ++w.run;
            ++w.fades;
        });
        count_steps(b.voice, b.view.h.voice_steps);
        v.gate = {};
        float* left = scratch + operand_index(b.view.h.out_left) * N;
        float* right = scratch + operand_index(b.view.h.out_right) * N;
        const bool same = b.view.h.out_left == b.view.h.out_right;
        if (!finite(left, right, same)) {
            v.active = false;
            ++t.guard_trips;
            return;
        }
        for (u32 i = f.from; i < N; ++i) {
            const float gain =
                f.done < fade_length_ ? 1.0f - static_cast<float>(f.done + 1) / static_cast<float>(fade_length_) : 0.0f;
            ++f.done;
            left[i] *= gain;
            if (!same) right[i] *= gain;
        }
        f.from = 0;
        mix_output(g, dst, left, right, same);
        if (f.done >= fade_length_ || (b.ends && !c.busy)) v.active = false;
    }

    // An output's guard. One buffer on both sides is checked once.
    [[nodiscard]] static bool finite(const float* left, const float* right, bool same) {
        return K::finite(left) && (same || K::finite(right));
    }

    // A stereo source on a mono build folds to (L + R) / 2. A patch with one output pays nothing for this. Adding at a
    // gain of 1 is an add, which rounds the same.
    void mix_output(Generation& g, u32 dst, const float* left, const float* right, bool same) {
        if constexpr (Ch == 2) {
            (void)same;
            B::add(bus(g, dst, 0), left, bus(g, dst, 0), N);
            B::add(bus(g, dst, 1), right, bus(g, dst, 1), N);
        } else if (same) {
            B::add(bus(g, dst, 0), left, bus(g, dst, 0), N);
        } else {
            B::accumulate(left, 0.5f, bus(g, dst, 0), N);
            B::accumulate(right, 0.5f, bus(g, dst, 0), N);
        }
    }

    void run_insert(Generation& g, Insert& i, const MixStep& m, float* scratch) {
        const Binding& b = *i.slot.binding;
        const PatchView& v = b.view;
        const auto fill_port = [&](u32 port, u32 reg, u32 channel) {
            float* to = scratch + v.in_port(port) * N;
            if (reg == kNone) {
                B::fill(0.0f, to, N);
            } else {
                std::memcpy(to, bus(g, reg, channel), sizeof(float) * N);
            }
        };
        fill_port(0, m.src, 0);
        fill_port(1, m.src, Ch - 1);
        if (v.h.inputs > 1) {
            fill_port(2, m.key, 0);
            fill_port(3, m.key, Ch - 1);
        }
        RunContext c = context(g, b, i.slot, &i.instance, scratch);
        c.state = i.instance.state;
        c.lines = reinterpret_cast<DelayLine*>(i.instance.state);
        K::run(b.voice, v.h.voice_steps, c);
        count([](Work& w) { ++w.inserts; });
        count_steps(b.voice, v.h.voice_steps);

        const float* left = scratch + operand_index(v.h.out_left) * N;
        const float* right = scratch + operand_index(v.h.out_right) * N;
        if (!finite(left, right, v.h.out_left == v.h.out_right)) {
            // Feedback can hold a non-finite value forever, so a tripped insert restarts empty.
            ++i.guard_trips;
            init_instance(b, i.slot, i.instance, 0);
            for (u32 ch = 0; ch < Ch; ++ch) B::fill(0.0f, bus(g, m.dst, ch), N);
            return;
        }
        for (u32 ch = 0; ch < Ch; ++ch) B::fill(0.0f, bus(g, m.dst, ch), N);
        mix_output(g, m.dst, left, right, v.h.out_left == v.h.out_right);
    }

    void gather(Generation& g, const MixStep& m) {
        count([&](Work& w) {
            ++w.gathers;
            w.gather_inputs += m.src;
        });
        for (u32 ch = 0; ch < Ch; ++ch) B::fill(0.0f, bus(g, m.dst, ch), N);
        for (u32 k = 0; k < m.src; ++k) {
            const GatherInput in = g.program.gather_input(m.a + k);
            const float left = g.mix[in.gain_left], right = g.mix[in.gain_right];
            if constexpr (Ch == 2) {
                B::accumulate(bus(g, in.src, 0), left, bus(g, m.dst, 0), N);
                B::accumulate(bus(g, in.src, 1), right, bus(g, m.dst, 1), N);
            } else {
                B::accumulate(bus(g, in.src, 0), (left + right) * 0.5f, bus(g, m.dst, 0), N);
            }
        }
    }

    // Taps --------------------------------------------------------------------------------------------------------

    // Sent by the host, so every field is checked here. A probe names one patch's registers, so it holds only while
    // that patch's slot is what the voice plays.
    [[nodiscard]] static bool probe_valid(const Generation& g, const Event& e) {
        if (e.target >= g.program.h.tracks) return false;
        const Track& t = g.tracks[e.target];
        if (e.channel >= t.desc.slot_count || e.tick_end > 0xFFFFu) return false;
        const PatchHeader& h = t.slots[e.channel].binding->view.h;
        if (e.tick >= h.voice_steps) return false;
        const u16 operand_value = static_cast<u16>(e.tick_end), index = operand_index(operand_value);
        switch (operand_bank(operand_value)) {
            case Bank::Buffer:
                return index < h.buffers;
            case Bank::Voice:
                return index < h.voice_scalars;
            case Bank::Track:
                return index < h.track_scalars;
            default:
                return false;
        }
    }

    // The voice probes on this track follow, which is the one started last, or none if no probe looks at this track.
    [[nodiscard]] u32 followed_voice(const Generation& g, const Track& t) const {
        const u16 index = static_cast<u16>(&t - g.tracks);
        const bool probed = std::any_of(taps_.begin(), taps_.end(), [&](const Tap& tap) { return tap.track == index; });
        u32 newest = t.desc.voices;
        if (!probed) return newest;
        for (u32 n = 0; n < t.desc.voices; ++n) {
            if (!t.voices[n].active) continue;
            if (newest == t.desc.voices || t.voices[n].age - t.voices[newest].age < 0x80000000u) newest = n;
        }
        return newest;
    }

    // Only the voice being watched runs a step at a time, because a register holds a given signal only until a later
    // step reuses it.
    void run_probed(const Generation& g, const Track& t, const Binding& b, RunContext& c, u32 slot, float* scratch) {
        const u16 index = static_cast<u16>(&t - g.tracks);
        for (u32 step = 0; step < b.view.h.voice_steps; ++step) {
            K::run_step(b.voice[step], c);
            for (Tap& tap : taps_) {
                if (tap.track != index || tap.slot != slot || tap.voice_step != step) continue;
                if (tap.filled == 0) tap.start_sample = sample_index_;
                const u16 reg = operand_index(tap.operand);
                float* into = tap.data + tap.filled;
                switch (operand_bank(tap.operand)) {
                    case Bank::Buffer:
                        std::memcpy(into, scratch + reg * N, sizeof(float) * N);
                        break;
                    case Bank::Voice:
                        B::fill(c.voice[reg], into, N);
                        break;
                    default:
                        B::fill(c.track[reg], into, N);
                        break;
                }
                tap.filled += N;
                tap.caught = true;
            }
        }
    }

    // A probe with no voice to watch reads silence, so that the display and its sample counts keep moving.
    void finish_probes(const Generation& g, const Track& t) {
        const u16 index = static_cast<u16>(&t - g.tracks);
        for (Tap& tap : taps_) {
            if (tap.track != index) continue;
            if (!tap.caught) {
                if (tap.filled == 0) tap.start_sample = sample_index_;
                B::fill(0.0f, tap.data + tap.filled, N);
                tap.filled += N;
            }
            tap.caught = false;
        }
    }

    void capture_taps(const Generation& g, u32 step) {
        if constexpr (C.tap_slots > 0) {
            for (Tap& t : taps_) {
                if (t.step != step) continue;
                if (t.filled == 0) t.start_sample = sample_index_;
                std::memcpy(t.data + t.filled, bus(g, t.reg, t.channel), sizeof(float) * N);
                t.filled += N;
            }
        }
    }

    void finish_taps() {
        if constexpr (C.tap_slots > 0) {
            for (Tap& t : taps_) {
                if (t.filled < tap_block) continue;
                if (t.ready) ++t.dropped;  // The display can never hold up audio
                t.ready = true;
                t.filled = 0;
            }
        }
    }

    [[no_unique_address]] E exec_;
    float rate_ = 48000.0f;
    float inverse_rate_ = 1.0f / 48000.0f;
    u32 fade_length_ = 96;  // samples a stolen voice takes to fade out
    u32 int_rate_ = 48000;
    u64 sample_index_ = 0;
    Region regions_[C.generations];
    Generation* live_ = nullptr;
    Generation* old_ = nullptr;
    Generation* pending_ = nullptr;
    float fade_ = 0.0f;
    float fade_step_ = 0.0f;
    u32 generation_ = 0;
    u32 master_guard_trips_ = 0;

    Loader loader_;
    ChunkTable* chunks_ = nullptr;
    u32 program_index_ = 0;
    u64 program_hash_ = 0;
    LoadPhase load_phase_ = LoadPhase::Idle;
    LoadError error_ = LoadError::None;
    BindPhase bind_phase_ = BindPhase::Patches;
    u32 bind_index_ = 0;

    Event queue_[kQueueSize];
    u32 queue_read_ = 0;
    u32 queue_write_ = 0;

    struct NoTaps {};
    [[no_unique_address]] std::conditional_t<(C.tap_slots > 0), std::array<Tap, C.tap_slots>, NoTaps> taps_{};
    struct NoWork {};
    [[no_unique_address]] std::conditional_t<C.count_work, Work, NoWork> work_{};

    // Runs `f` on the counts, in an engine that keeps them, and compiles to nothing in any other.
    template <class F>
    void count(F&& f) {
        if constexpr (C.count_work) f(work_);
    }
    void count_steps(const DecodedStep* steps, u32 n) {
        if constexpr (C.count_work) {
            for (u32 i = 0; i < n; ++i) ++work_.steps[steps[i].op];
        }
    }
};

}  // namespace modsynth
