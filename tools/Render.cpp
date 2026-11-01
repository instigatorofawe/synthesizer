// modsynth_render image out.f32 frames channels
// Renders program 0 to raw 32-bit floats, one frame of each channel at a time, the same layout firmware writes.

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <iterator>
#include <vector>

#include <modsynth/Modsynth.hpp>

using namespace modsynth;

template <u32 Channels>
static int render(ByteSpan image, const char* path, u32 frames) {
    static constexpr SynthConfig config{.frame_size = 128, .channels = Channels, .tap_slots = 0, .generations = 1};
    using Engine = Synth<config>;
    std::vector<ChunkRef> refs(kMaxChunks);
    ChunkTable table{std::span(refs)};
    std::vector<std::byte> fast(16 << 20), bulk(64 << 20);
    Engine engine({fast, bulk, 48000.0f});
    engine.load(table, image, 0);
    while (engine.pump(1 << 20)) {
    }
    if (engine.load_error() != LoadError::None) {
        std::cerr << to_string(engine.load_error()) << "\n";
        return 1;
    }
    engine.send({.kind = EventKind::Play});
    std::vector<float> out(Channels * 128);
    std::ofstream file(path, std::ios::binary);
    for (u32 f = 0; f < frames; ++f) {
        if constexpr (Channels == 2) {
            engine.render({out.data(), out.data() + 128});
        } else {
            engine.render({out.data()});
        }
        file.write(reinterpret_cast<const char*>(out.data()), static_cast<std::streamsize>(out.size() * sizeof(float)));
    }
    return 0;
}

int main(int argc, char** argv) {
    if (argc != 5) {
        std::cerr << "usage: render image out.f32 frames channels\n";
        return 2;
    }
    std::ifstream in(argv[1], std::ios::binary);
    const std::vector<char> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    std::vector<u64> words((bytes.size() + 7) / 8);
    std::memcpy(words.data(), bytes.data(), bytes.size());
    const ByteSpan image{reinterpret_cast<const std::byte*>(words.data()), bytes.size()};
    const u32 frames = static_cast<u32>(std::atoi(argv[3]));
    return std::atoi(argv[4]) == 1 ? render<1>(image, argv[2], frames) : render<2>(image, argv[2], frames);
}
