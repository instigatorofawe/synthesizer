// A target profile: what a device plays and how much room it has, written by the device's own build, so every size in
// it is the target's. A request names one as "target", and the compiler then fails anything that device would refuse:
// see compile_image. Section 10 of docs/Design.md has why, and firmware/Profiles holds the profiles of the boards.
#pragma once

#include <array>

#include <modsynth/Config.hpp>
#include <modsynth/Format.hpp>
#include <modsynth/Synth.hpp>

namespace modsynth {

struct ProfileInfo {
    const char* name;
    const char* backend;
    u64 rate_millihertz;  // integers only, since this is written in a constant expression
    u64 fast;             // what one generation has
    u64 bulk;
    u64 image_bytes;  // the largest image it stores
    u32 chunks;       // how many chunks its table holds
};

// JSON written in a constant expression, so a firmware carries it in a section that its build extracts.
struct ProfileText {
    std::array<char, 4096> text{};
    u32 size = 0;

    constexpr ProfileText& raw(const char* s) {
        while (*s) text[size++] = *s++;
        return *this;
    }
    constexpr ProfileText& number(u64 v) {
        char digits[20];
        u32 n = 0;
        do {
            digits[n++] = static_cast<char>('0' + v % 10);
            v /= 10;
        } while (v != 0);
        while (n) text[size++] = digits[--n];
        return *this;
    }
    constexpr ProfileText& millis(u64 v) {
        number(v / 1000).raw(".");
        for (u64 unit = 100; unit; unit /= 10) text[size++] = static_cast<char>('0' + v / unit % 10);
        return *this;
    }
    constexpr ProfileText& pair(const char* key, u64 v) { return raw(",\"").raw(key).raw("\":").number(v); }
    constexpr ProfileText& size_pair(const char* key, Layout::Size s) {
        return raw(",\"").raw(key).raw("\":[").number(s.size).raw(",").number(s.align).raw("]");
    }
};

inline constexpr u8 kProfileOps[] = {
#define MODSYNTH_OP(name, id, ...) id,
#include <modsynth/Opcodes.def>
};

template <class Engine>
constexpr ProfileText write_profile(const ProfileInfo& info) {
    const Layout l = Engine::layout();
    ProfileText t;
    t.raw("{\"name\":\"").raw(info.name).raw("\",\"backend\":\"").raw(info.backend).raw("\"");
    t.pair("revision", kFormatRevision).pair("frame_size", l.frame_size).pair("channels", l.channels);
    t.raw(",\"rate\":").millis(info.rate_millihertz);
    t.raw(",\"memory\":{\"fast\":").number(info.fast).raw(",\"bulk\":").number(info.bulk).raw("}");
    t.pair("image_bytes", info.image_bytes).pair("chunks", info.chunks);
    t.raw(",\"opcodes\":[");
    for (u32 i = 0; i < std::size(kProfileOps); ++i) t.raw(i ? "," : "").number(kProfileOps[i]);
    t.raw("],\"layout\":{\"workers\":").number(l.workers).raw(",\"edges\":").raw(l.edges ? "true" : "false");
    t.pair("align", l.align).pair("region_align", l.region_align).pair("generation", l.generation);
    t.pair("delay_line", l.delay_line).pair("state_align", l.state_align);
    t.size_pair("binding", l.binding).size_pair("track", l.track).size_pair("insert", l.insert);
    t.size_pair("decoded_step", l.decoded_step).size_pair("bound_resource", l.bound_resource);
    t.size_pair("param_state", l.param_state).size_pair("slot", l.slot).size_pair("voice", l.voice);
    t.size_pair("held", l.held).size_pair("glide", l.glide).size_pair("fade", l.fade);
    t.size_pair("mix_ramp", l.mix_ramp).size_pair("task", l.task);
    t.raw(",\"state_size\":[");
    for (u32 i = 0; i < l.state_size.size(); ++i) t.raw(i ? "," : "").number(l.state_size[i]);
    t.raw("]}}\n");
    return t;
}

}  // namespace modsynth
