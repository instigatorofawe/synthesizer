// modsynth_work list.txt out.json
// Plays images as firmware/Bench.cpp and a board's render do, from Play, for the frames each line of the list gives,
// on a mono engine that counts its work. Writes what an average frame did, for tools/Bench.py to fit a cost table to.
// Each line of the list is: name image frames.

#include <algorithm>
#include <fstream>
#include <iostream>
#include <iterator>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

#include <modsynth/Modsynth.hpp>

using namespace modsynth;

namespace {

constexpr SynthConfig kConfig{.frame_size = 32, .channels = 1, .tap_slots = 0, .generations = 1, .count_work = true};
using Engine = Synth<kConfig>;
constexpr float kRate = 48000.0f;

// Each count by name, in the order tools/Bench.py fits them.
template <class F>
void each(const Work& w, F&& f) {
    f("segments", w.segments);
    f("track_segments", w.track_segments);
    f("voice_slots", w.voice_slots);
    f("held", w.held);
    f("idle", w.idle);
    f("run", w.run);
    f("fades", w.fades);
    f("slots", w.slots);
    f("params", w.params);
    f("moving", w.moving);
    f("inserts", w.inserts);
    f("gathers", w.gathers);
    f("gather_inputs", w.gather_inputs);
    f("mix_registers", w.mix_registers);
    f("glides", w.glides);
    f("held_notes", w.held_notes);
    f("instructions", w.instructions);
    f("notes", w.notes);
    f("note_voices", w.note_voices);
    f("note_params", w.note_params);
    f("note_bytes", w.note_bytes);
    f("zone_rows", w.zone_rows);
    for (u32 op = 1; op < w.steps.size(); ++op) f(("op" + std::to_string(op)).c_str(), w.steps[op]);
}

nlohmann::json measure(const std::string& path, u32 frames) {
    std::ifstream in(path, std::ios::binary);
    std::vector<char> bytes((std::istreambuf_iterator<char>(in)), {});
    std::vector<u64> aligned((bytes.size() + 7) / 8);
    std::copy(bytes.begin(), bytes.end(), reinterpret_cast<char*>(aligned.data()));
    const ByteSpan image{reinterpret_cast<const std::byte*>(aligned.data()), bytes.size()};

    std::vector<ChunkRef> refs(kMaxChunks);
    ChunkTable chunks{std::span(refs)};
    std::vector<std::byte> fast(64u << 20), bulk(64u << 20);
    auto engine = std::make_unique<Engine>(Engine::Memory{fast, bulk, kRate});
    engine->load(chunks, image, 0);
    while (engine->pump(1u << 16)) {
    }
    if (engine->load_error() != LoadError::None) return {{"refused", to_string(engine->load_error())}};
    engine->send({.kind = EventKind::Play});

    float out[kConfig.frame_size];
    std::vector<double> sum;
    for (u32 f = 0; f < frames; ++f) {
        engine->render({out});
        u32 i = 0;
        each(engine->work(), [&](const char*, u32 v) {
            if (sum.size() <= i) sum.push_back(0.0);
            sum[i++] += v;
        });
    }
    nlohmann::json mean = nlohmann::json::object();
    u32 i = 0;
    each(Work{}, [&](const char* name, u32) {
        if (sum[i] != 0.0) mean[name] = sum[i] / frames;
        ++i;
    });
    return {{"frames", frames}, {"mean", mean}};
}

}  // namespace

int main(int argc, char** argv) {
    if (argc != 3) {
        std::cerr << "usage: modsynth_work list.txt out.json\n";
        return 2;
    }
    std::ifstream list(argv[1]);
    nlohmann::json out = nlohmann::json::object();
    std::string name, path;
    u32 frames = 0;
    while (list >> name >> path >> frames) out[name] = measure(path, frames);
    std::ofstream(argv[2]) << out.dump(1) << "\n";
    return 0;
}
