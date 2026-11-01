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
    static_assert(C.frame_size >= 8 && C.frame_size <= 4096);

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
        int_rate_ = static_cast<u32>(rate_ + 0.5f);

        std::byte* fast = memory.fast.data();
        std::size_t fast_size = memory.fast.size();
        if constexpr (C.tap_slots > 0) {
            const std::size_t taps = std::min(sizeof(float) * tap_block * C.tap_slots, fast_size);
            for (u32 i = 0; i < C.tap_slots; ++i) {
                taps_[i].data = reinterpret_cast<float*>(fast) + i * tap_block;
            }
            fast += taps;
            fast_size -= taps;  // Too little memory leaves regions empty, so every load reports OutOfMemory
        }
        const std::size_t fast_each = fast_size / C.generations / 16 * 16;
        const std::size_t bulk_each = memory.bulk.size() / C.generations / 16 * 16;
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
    // be given, and add tap_bytes() to fast.
    [[nodiscard]] static MemorySizes bytes_required(const ChunkTable& chunks, u64 program, float rate) {
        const ChunkRef* c = chunks.find(program, ChunkKind::Program);
        ProgramView p;
        if (!c || !parse_program({c->data, c->size}, p)) return {};
        Bump fast(nullptr), bulk(nullptr);
        Generation g;
        g.program = p;
        reserve<true>(g, chunks, fast, bulk, rate);
        const auto rounded = [](u64 n) { return (n + 15) / 16 * 16; };  // The constructor keeps regions 16-aligned
        return {rounded(kGenerationBytes + fast.used()), rounded(bulk.used())};
    }
    [[nodiscard]] static constexpr std::size_t tap_bytes() { return sizeof(float) * tap_block * C.tap_slots; }

    // Starts loading. The image and the table must outlive every generation that uses them. Work happens in pump(),
    // which render() also calls, and the new generation commits at a frame boundary.
    void load(ChunkTable& chunks, ByteSpan image, u32 program = 0) {
        loader_ = Loader(chunks);
        loader_.begin(image);
        chunks_ = &chunks;
        program_index_ = program;
        load_phase_ = LoadPhase::Validating;
        error_ = LoadError::None;
    }

    // Binds a Program whose chunks a table already holds, which is how a bank switches songs.
    void bind(ChunkTable& chunks, u64 program) {
        chunks_ = &chunks;
        program_hash_ = program;
        load_phase_ = LoadPhase::Waiting;
        error_ = LoadError::None;
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
                    if (program_index_ >= loader_.programs()) {
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
        if (static_cast<u8>(e.kind) > static_cast<u8>(EventKind::SetLoop)) return false;
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
        }
        sample_index_ += N;
        if constexpr (C.tap_slots > 0) finish_taps();
        if (load_phase_ != LoadPhase::Idle) pump(kBudgetPerFrame);
    }

    [[nodiscard]] u32 tick() const { return live_ ? live_->clock.tick : 0; }
    [[nodiscard]] bool playing() const { return live_ && live_->clock.playing; }
    [[nodiscard]] u32 active_voices() const {
        if (!live_) return 0;
        u32 n = 0;
        for (u32 t = 0; t < live_->program.h.tracks; ++t) {
            const Track& track = live_->tracks[t];
            for (u32 v = 0; v < track.desc.voices; ++v) n += track.voices[v].active;
        }
        return n;
    }
    [[nodiscard]] u32 guard_trips() const {
        if (!live_) return 0;
        u32 n = 0;
        for (u32 t = 0; t < live_->program.h.tracks; ++t) n += live_->tracks[t].guard_trips;
        for (u32 i = 0; i < live_->program.h.inserts; ++i) n += live_->inserts[i].guard_trips;
        return n;
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
    static constexpr u32 kBudgetPerFrame = 8192;
    static constexpr float kFadeSamples = 2048.0f;
    using K = Kernels<C, B>;

    // Counts in 64 bits on every target. Format limits keep the largest possible total far below 2^64, so it cannot
    // wrap even on the dry run that decides whether a Program fits. Only a total that fit is ever turned into a
    // pointer.
    class Bump {
       public:
        explicit Bump(std::byte* base) : base_(base) {}
        template <class T>
        [[nodiscard]] T* array(u64 count) {
            const u64 align = std::max<std::size_t>(alignof(T), 8);
            const u64 start = (used_ + align - 1) / align * align;
            used_ = start + count * sizeof(T);
            return base_ ? reinterpret_cast<T*>(base_ + static_cast<std::size_t>(start)) : nullptr;
        }
        [[nodiscard]] u64 used() const { return used_; }

       private:
        std::byte* base_;
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
        u32* line_lengths;
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

    struct Track {
        TrackDesc desc;
        Slot* slots;
        Voice* voices;
        Cursor cursor;
        u32 age;
        u32 notes;
        u32 guard_trips;
        u32 slot;
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
    };

    // The Generation itself lives at the start of its region.
    static constexpr std::size_t kGenerationBytes = (sizeof(Generation) + 7) / 8 * 8;

    enum class LoadPhase : u8 { Idle, Validating, Waiting, Binding, Ready };
    enum class BindPhase : u8 { Patches, Instances, Done };

    // Sizing ------------------------------------------------------------------------------------------------------

    [[nodiscard]] static u32 line_length(float seconds, float rate) { return static_cast<u32>(seconds * rate) + N + 4; }

    [[nodiscard]] static PatchSizes measure_patch(const PatchView& v, float rate) {
        PatchSizes s;
        const auto aligned = [](u32 n) { return (n + K::state_align - 1) / K::state_align * K::state_align; };
        s.voice_state = aligned(v.h.delays * sizeof(DelayLine));
        for (u32 i = 0; i < v.h.control_steps; ++i) s.control_state += aligned(K::state_size(Op(v.step(i).op)));
        for (u32 i = 0; i < v.h.voice_steps; ++i) {
            s.voice_state += aligned(K::state_size(Op(v.step(v.h.control_steps + i).op)));
        }
        for (u32 i = 0; i < v.h.delays; ++i) s.bulk_floats += line_length(v.delay(i), rate);
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
    static void reserve(Generation& g, const ChunkTable& chunks, Bump& fast, Bump& bulk, float rate) {
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
            const PatchSizes sizes = measure_patch(v, rate);
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
            if constexpr (!Dry) {
                tracks[t].desc = d;
                tracks[t].slots = slots;
                tracks[t].voices = voices;
            }
            u32 scalars = 0, state = 0;  // sized for the largest slot, per section 6
            u64 floats = 0;
            for (u32 s = 0; s < d.slot_count; ++s) {
                const u32 patch = p.slot(d.slot_begin + s);
                const PatchView v = patch_view(chunks, p.patch(patch));
                const PatchSizes sizes = measure_patch(v, rate);
                scalars = std::max<u32>(scalars, v.h.voice_scalars);
                state = std::max(state, sizes.voice_state);
                floats = std::max(floats, sizes.bulk_floats);
                reserve_slot(patch, Dry ? nullptr : &slots[s]);
            }
            for (u32 i = 0; i < d.voices; ++i) reserve_voice(Dry ? nullptr : &voices[i], scalars, state, floats);
        }
        for (u32 i = 0; i < h.inserts; ++i) {
            const InsertDesc d = p.insert(i);
            const PatchView v = patch_view(chunks, p.patch(d.patch));
            const PatchSizes sizes = measure_patch(v, rate);
            if constexpr (!Dry) inserts[i].desc = d;
            reserve_slot(d.patch, Dry ? nullptr : &inserts[i].slot);
            reserve_voice(Dry ? nullptr : &inserts[i].instance, v.h.voice_scalars, sizes.voice_state,
                          sizes.bulk_floats);
        }

        auto* buses = fast.template array<float>(static_cast<u64>(h.buses) * Ch * N);
        auto* mix = fast.template array<float>(h.mix_regs);
        auto* globals = fast.template array<float>(h.globals);
        auto* scratch = fast.template array<float>(static_cast<u64>(max_buffers) * N * E::max_workers);
        u32 task_count = 0;
        for (u32 i = 0; i < h.mix_steps; ++i) {
            if (i == 0 || p.mix_step(i).task != p.mix_step(i - 1).task) ++task_count;
        }
        auto* tasks = fast.template array<Task>(task_count);
        if constexpr (!Dry) {
            g.buses = buses;
            g.mix = mix;
            g.globals = globals;
            g.scratch = scratch;
            g.tasks = tasks;
            g.task_count = task_count;
        }
        if constexpr (E::uses_edges) {
            // Worst case, every pair of tasks conflicts.
            auto* deps = fast.template array<u16>(task_count);
            auto* begin = fast.template array<u16>(task_count + 1);
            auto* succ = fast.template array<u16>(static_cast<u64>(task_count) * task_count);
            if constexpr (!Dry) {
                g.plan.count = task_count;
                g.plan.deps = deps;
                g.plan.succ_begin = begin;
                g.plan.succ = succ;
            }
        } else if constexpr (!Dry) {
            g.plan.count = task_count;
        }
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
        Bump fast(r.fast + kGenerationBytes), bulk(r.bulk);
        reserve<false>(*g, *chunks_, fast, bulk, rate_);
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
        const u32 total = static_cast<u32>(v.h.control_steps) + v.h.voice_steps;
        for (u32 i = 0; i < total; ++i) {
            const bool control = i < v.h.control_steps;
            const WireStep w = v.step(i);
            const Op op = static_cast<Op>(w.op);
            const OpSignature sig = op_signature(op);
            DecodedStep& d = control ? b.control[i] : b.voice[i - v.h.control_steps];
            d.op = w.op;
            d.mode = w.mode;
            d.resource = w.resource;
            u32& cursor = control ? control_state : voice_state;
            d.state = cursor;
            cursor += aligned(K::state_size(op));
            for (u32 a = 0; a < sig.outs; ++a) d.out[a] = decode_operand(w.out[a], g, v);
            for (u32 a = 0; a < sig.ins; ++a) d.in[a] = decode_operand(w.in[a], g, v);
            if (sig.ends) b.ends = true;
        }
        b.control_state = control_state;
        b.voice_state = voice_state;
        for (u32 i = 0; i < v.h.delays; ++i) b.line_lengths[i] = line_length(v.delay(i), rate_);
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
        for (u32 s = 0; s < t.desc.slot_count; ++s) {
            init_slot(t.slots[s]);
            apply_inits(g, 0, static_cast<u16>(&t - g.tracks), t.slots[s]);
        }
        for (u32 v = 0; v < t.desc.voices; ++v) {
            t.voices[v].active = false;
            t.voices[v].held = false;
            t.voices[v].gate = {};
        }
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
        for (u32 i = 0; i < h.mix_regs; ++i) g.mix[i] = g.program.mix_value(i);
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
            lines[i] = {bulk, b.line_lengths[i], 0, 0};  // Never cleared: `written` makes old contents unreachable
            bulk += b.line_lengths[i];
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
                    if (a->length == b->length) {
                        std::memcpy(b->data, a->data, sizeof(float) * a->length);
                        b->write = a->write;
                        b->written = a->written;
                    }
                }
                break;
            }
        }
    }

    void copy_slot(const Slot& from, Slot& to) {
        const PatchView& a = from.binding->view;
        const PatchView& b = to.binding->view;
        for (u32 i = 0; i < b.h.params; ++i) {
            const ParamDesc d = b.param(i);
            for (u32 k = 0; k < a.h.params; ++k) {
                if (a.param(k).id != d.id) continue;
                to.params[i] = from.params[k];
                if (d.scope == static_cast<u8>(ParamScope::Track)) to.track[d.reg] = from.params[k].value;
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
            const u32 slots = std::min<u32>(nt.desc.slot_count, ot->desc.slot_count);
            for (u32 s = 0; s < slots; ++s) copy_slot(ot->slots[s], nt.slots[s]);
            const u32 voices = std::min<u32>(nt.desc.voices, ot->desc.voices);
            for (u32 v = 0; v < voices; ++v) {
                const Voice& ov = ot->voices[v];
                if (ov.active && ov.slot < slots) {
                    copy_voice(ov, ot->slots[ov.slot], nt.voices[v], nt.slots[ov.slot]);
                }
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
        for (u32 t = 0; t < g.program.h.tracks; ++t) {
            Track& track = g.tracks[t];
            for (u32 s = 0; s < track.desc.slot_count; ++s) update_slot(g, track.slots[s]);
        }
        for (u32 i = 0; i < g.program.h.inserts; ++i) update_slot(g, g.inserts[i].slot);
    }

    void update_slot(Generation& g, Slot& slot) {
        const PatchView& v = slot.binding->view;
        for (u32 i = 0; i < v.h.params; ++i) {
            ParamState& p = slot.params[i];
            if (p.frames == 0) continue;
            p.value = --p.frames == 0 ? p.target : p.value + p.step;
            const ParamDesc d = v.param(i);
            if (d.scope == static_cast<u8>(ParamScope::Track)) slot.track[d.reg] = p.value;
        }
        if (v.h.control_steps == 0) return;
        RunContext c = context(g, *slot.binding, slot, nullptr, g.scratch);
        c.state = slot.state;
        K::run(slot.binding->control, v.h.control_steps, c);
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
                if (e.target < h.tracks) start_note(g, g.tracks[e.target], e.note, e.velocity, 0, kNoTick);
                break;
            case EventKind::NoteOff:
                if (e.target < h.tracks) {
                    Track& t = g.tracks[e.target];
                    for (u32 v = 0; v < t.desc.voices; ++v) {
                        Voice& voice = t.voices[v];
                        if (voice.active && voice.held && voice.note == e.note) release(voice, 0);
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
                if (e.param < h.mix_regs) g.mix[e.param] = e.value;
                break;
            case EventKind::SetTap:
                if constexpr (C.tap_slots > 0) {
                    if (e.param < C.tap_slots) {
                        Tap& t = taps_[e.param];
                        const bool valid = e.target < h.mix_steps && e.note < h.buses && e.channel < Ch;
                        t.step = valid ? e.target : kNone;
                        t.reg = e.note;
                        t.channel = e.channel;
                        t.filled = 0;
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

    // Samples until tick T, rounded up. Returns at least `limit` when T is that far away or further.
    [[nodiscard]] u32 samples_to(const Generation& g, u32 target, u32 limit) const {
        const Clock& k = g.clock;
        if (target <= k.tick) return 0;
        const u64 d = ticks_denominator(k), unit = samples_unit(g);
        const u64 horizon = (unit * limit) / d + 2;
        if (target - k.tick > horizon) return limit;
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
            while (g.conductor.tick <= k.tick && g.conductor.tick != kNoTick) step_conductor(g);
            if (k.loop_end != 0 && !wrapped && k.tick >= k.loop_end) {
                wrapped = true;
                release_all(g, position < N ? position : N - 1);
                locate(g, k.loop_start, true, false);
            }
        }
    }

    void dispatch(Generation& g, u32 base, u32 segment) {
        if (segment == 0) return;
        for (u32 t = 0; t < g.program.h.tracks; ++t) {
            Track& track = g.tracks[t];
            for (u32 v = 0; v < track.desc.voices; ++v) {
                Voice& voice = track.voices[v];
                if (!voice.active || !voice.held || voice.off_tick == kNoTick) continue;
                const u32 s = samples_to(g, voice.off_tick, segment);
                if (s < segment) release(voice, base + s);
            }
            while (track.cursor.tick != kNoTick) {
                const u32 s = samples_to(g, track.cursor.tick, segment);
                if (s >= segment) break;
                step_track(g, track, base + s, false, 0);
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
            case Instr::NoteOn:
                if (!chase) {
                    start_note(g, t, in.a, in.b, offset, c.tick + in.c);
                } else if (start_notes && c.tick + in.c > target) {
                    start_note(g, t, in.a, in.b, offset, c.tick + in.c);  // Held across the locate point
                }
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
            while (track.cursor.tick < chase_until) step_track(g, track, 0, true, tick, start_notes);
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

    void start_note(Generation& g, Track& t, u8 note, u8 velocity, u32 offset, u32 off_tick) {
        Voice& v = pick_voice(t);
        const u32 slot = t.slot < t.desc.slot_count ? t.slot : 0;
        init_instance(*t.slots[slot].binding, t.slots[slot], v, 0);
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
    }

    void set_track_param(Generation& g, Track& t, u16 id, float value, u32 frames, bool immediate = false) {
        for (u32 s = 0; s < t.desc.slot_count; ++s) set_slot_param(g, &t, t.slots[s], id, value, frames, immediate, s);
    }

    void chase_ramp(Generation& g, Track& t, u16 id, float value, float done, u32 frames) {
        for (u32 s = 0; s < t.desc.slot_count; ++s) {
            Slot& slot = t.slots[s];
            const PatchView& v = slot.binding->view;
            for (u32 i = 0; i < v.h.params; ++i) {
                if (v.param(i).id != id) continue;
                const float current = slot.params[i].value;
                set_slot_param(g, &t, slot, id, current + (value - current) * done, 0, true, s);
                set_slot_param(g, &t, slot, id, value, frames, false, s);
            }
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
                    run_voices(g, g.tracks[m.a], m.dst, scratch);
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

    void run_voices(Generation& g, Track& t, u32 dst, float* scratch) {
        for (u32 ch = 0; ch < Ch; ++ch) B::fill(0.0f, bus(g, dst, ch), N);
        for (u32 n = 0; n < t.desc.voices; ++n) {
            Voice& v = t.voices[n];
            if (!v.active) continue;
            const Slot& slot = t.slots[v.slot];
            const Binding& b = *slot.binding;
            RunContext c = context(g, b, slot, &v, scratch);
            c.state = v.state;
            c.lines = reinterpret_cast<DelayLine*>(v.state);
            c.gate = v.gate;
            c.seed = (static_cast<u32>(t.desc.id) << 16) ^ (n << 8) ^ v.age;
            K::run(b.voice, b.view.h.voice_steps, c);

            const float* left = scratch + operand_index(b.view.h.out_left) * N;
            const float* right = scratch + operand_index(b.view.h.out_right) * N;
            v.gate = {};
            if (!K::finite(left) || !K::finite(right)) {
                v.active = false;
                ++t.guard_trips;
                continue;
            }
            mix_output(g, dst, left, right, b.view.h.out_left == b.view.h.out_right);
            if (!v.held && (!b.ends || !c.busy)) v.active = false;
        }
    }

    // A stereo source on a mono build folds to (L + R) / 2. A patch with one output pays nothing for this.
    void mix_output(Generation& g, u32 dst, const float* left, const float* right, bool same) {
        if constexpr (Ch == 2) {
            (void)same;
            B::accumulate(left, 1.0f, bus(g, dst, 0), N);
            B::accumulate(right, 1.0f, bus(g, dst, 1), N);
        } else if (same) {
            B::accumulate(left, 1.0f, bus(g, dst, 0), N);
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

        const float* left = scratch + operand_index(v.h.out_left) * N;
        const float* right = scratch + operand_index(v.h.out_right) * N;
        if (!K::finite(left) || !K::finite(right)) {
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
    u32 int_rate_ = 48000;
    u64 sample_index_ = 0;
    Region regions_[C.generations];
    Generation* live_ = nullptr;
    Generation* old_ = nullptr;
    Generation* pending_ = nullptr;
    float fade_ = 0.0f;
    float fade_step_ = 0.0f;
    u32 generation_ = 0;

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
};

}  // namespace modsynth
