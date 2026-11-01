#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <modsynth/Compiler.hpp>

using emscripten::val;

// Takes the request as JSON text. Returns { report: string, image: Uint8Array }. The image is empty if compiling
// failed.
static val compile(const std::string& request) {
    const auto result = modsynth::compiler::compile_image_checked(request);
    val out = val::object();
    out.set("report", result.report.dump());
    const auto* bytes = reinterpret_cast<const unsigned char*>(result.image.data());
    const val view(emscripten::typed_memory_view(result.image.size(), bytes));
    out.set("image", val::global("Uint8Array").new_(view));  // A copy: `result` is about to go away
    return out;
}

EMSCRIPTEN_BINDINGS(modsynth_compiler) { emscripten::function("compile", &compile); }
