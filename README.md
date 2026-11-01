# modsynth

A synthesizer engine that runs the same compiled patches and programs on Cortex-M, in the browser, on the desktop and from
Python, with a SvelteKit app for writing them. The design is in [docs/Design.md](docs/Design.md), and the image format, frozen
at version 1, is specified in [docs/Format.md](docs/Format.md).

An image written today plays on every future engine. The scalar backend gives identical bits on every target, and that is
checked against committed renders in [golden](golden).

## Layout

| Path | What it is |
|---|---|
| `include/modsynth` | The header-only engine and, in `Compiler.hpp`, the authoring compiler. Tests sit beside what they test, as `FooTest.cpp`. |
| `bindings` | wasm and Python bindings |
| `firmware` | Cortex-M4 firmware, run on QEMU's STM32L475 model |
| `fuzz` | The coverage-guided fuzzer, one source on desktop, wasm32 and Cortex-M4 |
| `golden` | Images from the freeze and their renders. They never change. |
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

    firmware/Check.sh

That builds stereo, mono and CMSIS-DSP firmware, runs each on QEMU's L475 model, compares its audio with the golden renders,
and then fuzzes on a Cortex-M4. `FUZZ_SECONDS` and `FUZZ_RANDOM` set how long, and from what seed.

## Fuzzing

    cmake -B build/fuzz -DMODSYNTH_BUILD_FUZZ=ON -DMODSYNTH_BUILD_TESTS=OFF -DMODSYNTH_BUILD_COMPILER=OFF -DMODSYNTH_INSTALL=OFF
    cmake --build build/fuzz --target modsynth_fuzz
    build/fuzz/modsynth_fuzz 60 1 golden/AllOps.image golden/Demo.image golden/Waves.image

The arguments are seconds, a random seed, and the images to start from. Use `emcmake cmake` for wasm32 and run the result with
`node`. A failure prints a recipe, and `--replay` runs it again on any target, with the same image, under whatever sanitizers
that target has:

    build/fuzz/modsynth_fuzz --replay 0:3219687050,256226439 1 golden/AllOps.image golden/Demo.image golden/Waves.image

Fuzz with `AllOps.image` as well as `Demo.image`. The demo's tasks all depend on each other and it has no globals, so on its own it
cannot exercise the rules that make task order irrelevant. Section 23 of the design says what each oracle catches.

## The format

Before changing anything in `Format.hpp`, `Opcodes.def` or a kernel, read section 2 of [docs/Format.md](docs/Format.md). Opcodes and golden
files are append-only, and CI enforces that against the base branch. `tools/ReadImage.py` reads images from the specification alone, and
fails if the document and the code disagree:

    python3 tools/ReadImage.py --coverage golden/Minimal.image golden/Demo.image golden/AllOps.image golden/Waves.image
    python3 tools/ReadImage.py --example golden/Minimal.image
    python3 tools/CheckAppendOnly.py origin/main

## Workflow

Work goes to a branch as it happens. A finished milestone lands as one squashed pull request into `main`, and only those
pull requests run CI, so run the checks above before pushing.
