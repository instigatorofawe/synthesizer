// The loudest sample a Program plays on an engine of a given frame size and channel count, from its start to its end
// and on until every voice has stopped and a tenth of a second has stayed below -100 dB, for at most 10 s more, which
// is how the Python binding's render ends too. A device plays what it holds from its start, so this is the most it can
// put out, and a target's compile refuses an image whose peak passes full scale (section 24 of the design, open 9).
//
// It needs an engine for every frame size and channel count a target can have, sixteen of them, so they're built once,
// in Peak.cpp, which modsynth::compiler compiles. Built in every file that includes the compiler, they took GCC four
// times as long and as much memory again.
#pragma once

#include <modsynth/Config.hpp>
#include <modsynth/Format.hpp>

namespace modsynth {

struct Peak {
    float level = 0.0f;    // the largest magnitude of any sample on any channel
    double seconds = 0.0;  // where the first sample that loud is
    bool ok = true;        // false if the engine refused the image, which the loader has already said why
};

inline constexpr float kSilence = 1e-5f;  // -100 dB, below which a tail counts as over
inline constexpr double kPeakTailSeconds = 10.0;

// `image` must be 8-aligned, as an engine takes it. A frame size or channel count no engine is built for, or an image
// that doesn't load, gives a Peak that isn't ok.
Peak peak_of(ByteSpan image, u32 program, float rate, u32 frame_size, u32 channels);

}  // namespace modsynth
