#include <algorithm>
#include <cmath>
#include <cstddef>
#include <vector>

#include <modsynth/Loader.hpp>
#include <modsynth/Peak.hpp>
#include <modsynth/Synth.hpp>

namespace modsynth {
namespace {

template <u32 Frame, u32 Channels>
Peak peak_on(ByteSpan image, u32 program, float rate) {
    static constexpr SynthConfig kConfig{.frame_size = Frame, .channels = Channels, .tap_slots = 0, .generations = 1};
    using Engine = Synth<kConfig>;

    std::vector<ChunkRef> sizing_refs(kMaxChunks);
    ChunkTable sizing{std::span(sizing_refs)};
    Loader loader(sizing);
    loader.begin(image, Frame);
    while (loader.step(1u << 20) == LoadStatus::Working) {
    }
    if (loader.status() != LoadStatus::Ready || program >= loader.programs()) return {.ok = false};
    const MemorySizes need = Engine::bytes_required(sizing, loader.program_hash(program), rate);

    std::vector<ChunkRef> refs(kMaxChunks);
    ChunkTable table{std::span(refs)};
    std::vector<std::byte> fast(need.fast + 256), bulk(need.bulk + 256);  // room to align either start
    Engine engine({fast, bulk, rate});
    engine.load(table, image, program);
    while (engine.pump(1u << 20)) {
    }
    if (engine.load_error() != LoadError::None) return {.ok = false};
    engine.send({.kind = EventKind::Play});

    Peak peak;
    std::vector<float> out(Channels * Frame);
    u64 sample = 0;
    const auto frame = [&] {
        if constexpr (Channels == 2) {
            engine.render({out.data(), out.data() + Frame});
        } else {
            engine.render({out.data()});
        }
        float loudest = 0.0f;
        for (u32 i = 0; i < Frame; ++i) {
            for (u32 c = 0; c < Channels; ++c) {
                const float level = std::fabs(out[c * Frame + i]);
                if (level > peak.level) {
                    peak.level = level;
                    peak.seconds = static_cast<double>(sample + i) / rate;
                }
                loudest = std::max(loudest, level);
            }
        }
        sample += Frame;
        return loudest;
    };
    while (engine.tick() < engine.length()) frame();
    const auto tenth = static_cast<u32>(std::ceil(rate / 10 / Frame));
    const auto most = static_cast<u64>(std::ceil(kPeakTailSeconds * rate / Frame));
    for (u64 frames = 0; frames < most;) {
        float loudest = 0.0f;
        for (u32 i = 0; i < tenth; ++i, ++frames) loudest = std::max(loudest, frame());
        if (engine.active_voices() == 0 && loudest < kSilence) break;
    }
    return peak;
}

template <u32 Channels>
Peak peak_on(ByteSpan image, u32 program, float rate, u32 frame_size) {
    switch (frame_size) {
        case 8:
            return peak_on<8, Channels>(image, program, rate);
        case 16:
            return peak_on<16, Channels>(image, program, rate);
        case 32:
            return peak_on<32, Channels>(image, program, rate);
        case 64:
            return peak_on<64, Channels>(image, program, rate);
        case 128:
            return peak_on<128, Channels>(image, program, rate);
        case 256:
            return peak_on<256, Channels>(image, program, rate);
        case 512:
            return peak_on<512, Channels>(image, program, rate);
        case 1024:
            return peak_on<1024, Channels>(image, program, rate);
        default:
            return {.ok = false};
    }
}

}  // namespace

Peak peak_of(ByteSpan image, u32 program, float rate, u32 frame_size, u32 channels) {
    if (channels == 1) return peak_on<1>(image, program, rate, frame_size);
    if (channels == 2) return peak_on<2>(image, program, rate, frame_size);
    return {.ok = false};
}

}  // namespace modsynth
