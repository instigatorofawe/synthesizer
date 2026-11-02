// The Python module: compile requests, and play images offline. A render releases the GIL, so engines on several Python
// threads render at once, and an engine given workers also splits each frame across a thread pool, per section 18.

#include <algorithm>
#include <cstring>
#include <memory>
#include <mutex>
#include <nanobind/nanobind.h>
#include <nanobind/ndarray.h>
#include <nanobind/stl/string.h>
#include <new>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include <modsynth/Compiler.hpp>
#include <modsynth/Modsynth.hpp>
#include <modsynth/Parallel.hpp>

namespace nb = nanobind;
using namespace nb::literals;
using namespace modsynth;

namespace {

// More workers than this sit out: each has its own scratch, sized when the engine is compiled.
constexpr u32 kMostWorkers = 16;
using Executor = PoolExecutor<kMostWorkers>;

nb::object json_module() { return nb::module_::import_("json"); }

PyObject* compile_error = nullptr;  // modsynth.CompileError, which the module keeps alive

std::string request_text(nb::handle request) {
    if (nb::isinstance<nb::str>(request)) return nb::cast<std::string>(request);
    return nb::cast<std::string>(json_module().attr("dumps")(request));
}

// Memory on a cache line, which a parallel engine's layout counts on.
struct Block {
    explicit Block(std::size_t size)
        : size(size),
          data(static_cast<std::byte*>(::operator new(std::max<std::size_t>(size, 64), std::align_val_t{64}))) {}
    ~Block() { ::operator delete(data, std::align_val_t{64}); }
    Block(const Block&) = delete;
    Block& operator=(const Block&) = delete;
    std::size_t size;
    std::byte* data;
};

// One engine at one frame size and channel count, behind an interface, so Python sees a single type.
class Player {
   public:
    virtual ~Player() = default;
    virtual LoadError error() const = 0;
    virtual void render(float* interleaved, std::size_t frames) = 0;
    virtual bool send(const Event& e) = 0;
    virtual u32 tick() const = 0;
    virtual u32 length() const = 0;
    virtual bool playing() const = 0;
    virtual u32 active_voices() const = 0;
    virtual u32 guard_trips() const = 0;
};

template <u32 Frame, u32 Channels>
class PlayerAt final : public Player {
    static constexpr SynthConfig kConfig{.frame_size = Frame, .channels = Channels, .tap_slots = 0, .generations = 1};
    using Engine = Synth<kConfig, ScalarBackend, Executor>;

   public:
    PlayerAt(ChunkTable& chunks, u64 program, float rate, ThreadPool* pool)
        : need_(Engine::bytes_required(chunks, program, rate)), fast_(need_.fast), bulk_(need_.bulk) {
        engine_.emplace(typename Engine::Memory{{fast_.data, fast_.size}, {bulk_.data, bulk_.size}, rate},
                        Executor{pool});
        engine_->bind(chunks, program);
        while (engine_->pump(1u << 20)) {
        }
    }

    LoadError error() const override { return engine_->load_error(); }

    // Hands out any samples left from the last frame first, so a render of any length continues the one before.
    void render(float* interleaved, std::size_t frames) override {
        for (std::size_t done = 0; done < frames;) {
            if (used_ == Frame) {
                if constexpr (Channels == 2) {
                    engine_->render({planar_, planar_ + Frame});
                } else {
                    engine_->render({planar_});
                }
                used_ = 0;
            }
            const std::size_t n = std::min<std::size_t>(frames - done, Frame - used_);
            for (std::size_t i = 0; i < n; ++i) {
                for (u32 ch = 0; ch < Channels; ++ch)
                    interleaved[(done + i) * Channels + ch] = planar_[ch * Frame + used_ + i];
            }
            used_ += static_cast<u32>(n);
            done += n;
        }
    }

    bool send(const Event& e) override { return engine_->send(e); }
    u32 tick() const override { return engine_->tick(); }
    u32 length() const override { return engine_->length(); }
    bool playing() const override { return engine_->playing(); }
    u32 active_voices() const override { return engine_->active_voices(); }
    u32 guard_trips() const override { return engine_->guard_trips(); }

   private:
    MemorySizes need_;
    Block fast_, bulk_;
    std::optional<Engine> engine_;
    float planar_[Channels * Frame] = {};
    u32 used_ = Frame;
};

template <u32 Channels>
std::unique_ptr<Player> make_player(u32 frame, ChunkTable& chunks, u64 program, float rate, ThreadPool* pool) {
    switch (frame) {
        case 8:
            return std::make_unique<PlayerAt<8, Channels>>(chunks, program, rate, pool);
        case 16:
            return std::make_unique<PlayerAt<16, Channels>>(chunks, program, rate, pool);
        case 32:
            return std::make_unique<PlayerAt<32, Channels>>(chunks, program, rate, pool);
        case 64:
            return std::make_unique<PlayerAt<64, Channels>>(chunks, program, rate, pool);
        case 128:
            return std::make_unique<PlayerAt<128, Channels>>(chunks, program, rate, pool);
        case 256:
            return std::make_unique<PlayerAt<256, Channels>>(chunks, program, rate, pool);
        case 512:
            return std::make_unique<PlayerAt<512, Channels>>(chunks, program, rate, pool);
        case 1024:
            return std::make_unique<PlayerAt<1024, Channels>>(chunks, program, rate, pool);
        default:
            return nullptr;
    }
}

class Engine {
   public:
    Engine(nb::bytes image, u32 program, float rate, u32 channels, u32 workers)
        : words_((image.size() + 7) / 8), refs_(kMaxChunks), chunks_(refs_) {
        if (channels != 1 && channels != 2) throw nb::value_error("channels must be 1 or 2");
        if (!(rate >= 1000.0f && rate <= 384000.0f)) throw nb::value_error("rate must be from 1000 to 384000");
        if (workers < 1) throw nb::value_error("workers must be at least 1");
        std::memcpy(words_.data(), image.c_str(), image.size());  // 8-aligned, as the loader requires
        const ByteSpan bytes{reinterpret_cast<const std::byte*>(words_.data()), image.size()};

        Loader loader(chunks_);
        loader.begin(bytes);
        while (loader.step(1u << 20) == LoadStatus::Working) {
        }
        if (loader.error() != LoadError::None) throw nb::value_error(to_string(loader.error()));
        if (program >= loader.programs()) {
            throw nb::index_error(("the image has " + std::to_string(loader.programs()) + " programs").c_str());
        }
        frame_size_ = chunks_.frame_size();
        channels_ = channels;
        rate_ = rate;
        workers_ = std::min(workers, kMostWorkers);
        if (workers_ > 1) pool_ = std::make_unique<ThreadPool>(workers_);
        const u64 hash = loader.program_hash(program);
        player_ = channels == 2 ? make_player<2>(frame_size_, chunks_, hash, rate, pool_.get())
                                : make_player<1>(frame_size_, chunks_, hash, rate, pool_.get());
        if (!player_) throw nb::value_error(to_string(LoadError::WrongFrameSize));
        if (player_->error() != LoadError::None) throw nb::value_error(to_string(player_->error()));
    }

    nb::ndarray<nb::numpy, float, nb::ndim<2>> render(std::size_t frames) {
        auto* data = new float[std::max<std::size_t>(frames * channels_, 1)];
        nb::capsule owner(data, [](void* p) noexcept { delete[] static_cast<float*>(p); });
        {
            nb::gil_scoped_release release;
            const std::lock_guard<std::mutex> lock(mutex_);
            player_->render(data, frames);
        }
        return nb::ndarray<nb::numpy, float, nb::ndim<2>>(data, {frames, channels_}, owner);
    }

    void send(const Event& e) {
        const std::lock_guard<std::mutex> lock(mutex_);
        if (!player_->send(e)) throw std::runtime_error("the event queue is full: render before sending more");
    }

    void note_on(u16 track, u32 note, u32 velocity) {
        if (note > 127 || velocity > 127) throw nb::value_error("note and velocity must be from 0 to 127");
        send({.kind = EventKind::NoteOn,
              .note = static_cast<u8>(note),
              .velocity = static_cast<u8>(velocity),
              .target = track});
    }
    void note_off(u16 track, u32 note) {
        if (note > 127) throw nb::value_error("note must be from 0 to 127");
        send({.kind = EventKind::NoteOff, .note = static_cast<u8>(note), .target = track});
    }
    static void check(float value) {
        if (!(value >= -1e12f && value <= 1e12f)) throw nb::value_error("value must be finite and within 1e12");
    }
    void set_param(u16 track, u16 param, float value) {
        check(value);
        send({.kind = EventKind::SetParam, .target = track, .param = param, .value = value});
    }
    void set_insert_param(u16 insert, u16 param, float value) {
        check(value);
        send({.kind = EventKind::SetInsertParam, .target = insert, .param = param, .value = value});
    }
    void set_mix(u16 reg, float value) {
        check(value);
        send({.kind = EventKind::SetMix, .param = reg, .value = value});
    }
    void play() { send({.kind = EventKind::Play}); }
    void stop() { send({.kind = EventKind::Stop}); }
    void locate(u32 tick) { send({.kind = EventKind::Locate, .tick = tick}); }
    void set_loop(u32 start, u32 end) {
        if (end != 0 && start >= end) throw nb::value_error("a loop must end after it starts");
        send({.kind = EventKind::SetLoop, .tick = start, .tick_end = end});
    }

    template <class F>
    auto read(F f) {
        const std::lock_guard<std::mutex> lock(mutex_);
        return f(*player_);
    }

    u32 frame_size_ = 0, channels_ = 0, workers_ = 1;
    float rate_ = 0;

   private:
    std::vector<u64> words_;  // the image, which the engine reads in place for as long as it plays
    std::vector<ChunkRef> refs_;
    ChunkTable chunks_;
    std::unique_ptr<ThreadPool> pool_;
    std::unique_ptr<Player> player_;
    std::mutex mutex_;
};

}  // namespace

NB_MODULE(_core, m) {
    m.doc() = "modsynth native bindings";

    compile_error = PyErr_NewException("modsynth.CompileError", PyExc_ValueError, nullptr);
    m.attr("CompileError") = nb::steal(compile_error);

    m.def(
        "compile_report",
        [](nb::handle request) {
            const std::string text = request_text(request);
            compiler::ImageResult result;
            {
                nb::gil_scoped_release release;
                result = compiler::compile_image_checked(text);
            }
            if (!result.report.value("ok", false)) {
                const auto& first = result.report["errors"][0];
                const std::string message = first.value("where", "") + ": " + first.value("message", "");
                nb::object error = nb::handle(compile_error)(message);
                error.attr("where") = first.value("where", "");
                error.attr("errors") = json_module().attr("loads")(result.report["errors"].dump());
                PyErr_SetObject(compile_error, error.ptr());
                throw nb::python_error();
            }
            nb::bytes image(result.image.data(), result.image.size());
            return nb::make_tuple(image, json_module().attr("loads")(result.report.dump()));
        },
        "request"_a,
        "Compiles a request, a dict or its JSON, to an image. Returns the image's bytes and the compiler's report, or "
        "raises CompileError, whose `where` says what failed.");

    nb::class_<Engine>(m, "Engine",
                       "Plays one Program of an image. Events take effect at the start of the next frame rendered.")
        .def(nb::init<nb::bytes, u32, float, u32, u32>(), "image"_a, nb::kw_only(), "program"_a = 0,
             "rate"_a = 48000.0f, "channels"_a = 2, "workers"_a = 1,
             "Validates the image and binds one Program. `workers` above 1 runs a frame's tracks on that many threads, "
             "with the same output, and above 16 is 16. Raises ValueError if the image is refused.")
        .def("render", &Engine::render, "frames"_a,
             "Renders this many frames as float32 of shape (frames, channels). Each call continues the last.")
        .def("play", &Engine::play)
        .def("stop", &Engine::stop, "Stops the transport and releases every voice.")
        .def("locate", &Engine::locate, "tick"_a)
        .def("set_loop", &Engine::set_loop, "start"_a, "end"_a, "An end of 0 clears the loop.")
        .def("note_on", &Engine::note_on, "track"_a, "note"_a, "velocity"_a = 100,
             "`track` is the Program's track index, which the compile report lists.")
        .def("note_off", &Engine::note_off, "track"_a, "note"_a)
        .def("set_param", &Engine::set_param, "track"_a, "param"_a, "value"_a)
        .def("set_insert_param", &Engine::set_insert_param, "insert"_a, "param"_a, "value"_a)
        .def("set_mix", &Engine::set_mix, "register"_a, "value"_a)
        .def_prop_ro("tick", [](Engine& e) { return e.read([](Player& p) { return p.tick(); }); })
        .def_prop_ro(
            "length", [](Engine& e) { return e.read([](Player& p) { return p.length(); }); },
            "The tick where the Program's last note ends.")
        .def_prop_ro("playing", [](Engine& e) { return e.read([](Player& p) { return p.playing(); }); })
        .def_prop_ro("active_voices", [](Engine& e) { return e.read([](Player& p) { return p.active_voices(); }); })
        .def_prop_ro(
            "guard_trips", [](Engine& e) { return e.read([](Player& p) { return p.guard_trips(); }); },
            "How many times a voice, insert or the master produced a value that isn't finite.")
        .def_ro("frame_size", &Engine::frame_size_)
        .def_ro("channels", &Engine::channels_)
        .def_ro("rate", &Engine::rate_)
        .def_ro("workers", &Engine::workers_);
}
