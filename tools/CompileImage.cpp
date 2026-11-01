// compile_image request.json out.image [out.report.json] [--program i]
// Compiles a request on a native host, with the same code the browser and server run as wasm.

#include <fstream>
#include <iostream>
#include <sstream>

#include <modsynth/Compiler.hpp>

int main(int argc, char** argv) {
    if (argc < 3) {
        std::cerr << "usage: compile_image request.json out.image [report.json]\n";
        return 2;
    }
    std::ifstream in(argv[1]);
    if (!in) {
        std::cerr << "cannot read " << argv[1] << "\n";
        return 2;
    }
    std::stringstream text;
    text << in.rdbuf();
    const auto result = modsynth::compiler::compile_image_checked(text.str());
    if (argc > 3) std::ofstream(argv[3]) << result.report.dump(1) << "\n";
    if (!result.report.value("ok", false)) {
        std::cerr << result.report.dump(1) << "\n";
        return 1;
    }
    std::ofstream(argv[2], std::ios::binary)
        .write(reinterpret_cast<const char*>(result.image.data()), static_cast<std::streamsize>(result.image.size()));
    return 0;
}
