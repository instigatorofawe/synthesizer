# modsynth

A synthesizer engine that runs the same compiled patches and programs on Cortex-M, in the browser, on the desktop and from
Python, with a SvelteKit app for writing them. The design is in [docs/Design.md](docs/Design.md).

The wire format is unstable until Milestone 2.

## Layout

| Path | What it is |
|---|---|
| `include/modsynth` | The header-only engine and, in `Compiler.hpp`, the authoring compiler. Tests sit beside what they test, as `FooTest.cpp`. |
| `bindings` | wasm and Python bindings |
| `firmware` | Cortex-M4 firmware, run on QEMU's STM32L475 model |
| `web` | The SvelteKit app, with Drizzle over SQLite |
| `examples/Demo.json` | The project every target renders. `MakeDemo.py` regenerates it. |

## Native

    cmake -B build/native
    cmake --build build/native
    ctest --test-dir build/native

Every `*Test.cpp` is found by a glob and becomes its own GoogleTest target.

## Web

    emcmake cmake -B build/wasm -DMODSYNTH_BUILD_TESTS=OFF
    cmake --build build/wasm --target modsynth_wasm modsynth_compiler_wasm
    cd web
    pnpm install
    pnpm wasm      # copies the wasm build into the app
    pnpm build
    pnpm start     # http://127.0.0.1:5321

An empty database fills itself with the demo project on first start. `pnpm test` runs the unit tests and `pnpm e2e` drives
the built app in Chromium. There is no authentication, so keep it on loopback.

## Firmware

This needs `arm-none-eabi-gcc` with newlib, and QEMU. Homebrew's toolchain has no C library, so on a Mac use a Debian
container.

    cmake -B build/tools -DMODSYNTH_BUILD_TESTS=OFF -DMODSYNTH_BUILD_COMPILER=ON -DMODSYNTH_INSTALL=OFF
    cmake --build build/tools --target modsynth_compile modsynth_render
    firmware/Check.sh

That builds stereo, mono and CMSIS-DSP firmware, runs each on QEMU, and compares its audio with a native render.

## Workflow

Work goes to a branch as it happens. A finished milestone lands as one squashed pull request into `main`, and only those
pull requests run CI, so run the checks above before pushing.
