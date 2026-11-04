# modsynth

A synthesizer engine that runs the same compiled patches and programs on Cortex-M, in the browser, on the desktop and from
Python, with a SvelteKit app for writing them. The design is in [docs/Design.md](docs/Design.md), and the image format, frozen
at version 1, is specified in [docs/Format.md](docs/Format.md).

An image written today plays on every future engine built for its frame size. The scalar backend gives identical bits on every target, and that is
checked against committed renders in [golden](golden).

## Layout

| Path | What it is |
|---|---|
| `include/modsynth` | The header-only engine and, in `Compiler.hpp`, the authoring compiler, whose one source file, `Peak.cpp`, holds the engines its peak check plays. Tests sit beside what they test, as `FooTest.cpp`. |
| `bindings` | wasm and Python bindings, and the Python tests in `PythonTest.py` |
| `firmware` | Cortex-M4 firmware, run on QEMU's STM32L475 model, and on a NUCLEO-L476RG as [docs/Board.md](docs/Board.md) describes |
| `fuzz` | The coverage-guided fuzzer, one source on desktop, wasm32 and Cortex-M4 |
| `golden` | Images from the freeze and their renders. They never change. |
| `web` | The SvelteKit app, with Drizzle over SQLite |
| `examples/Demo.json` | The project every target renders. `MakeDemo.py` regenerates it. |
| `examples/Listen.py` | Plays each oscillator and mode through the sound card, with `uv run examples/Listen.py`. `--list` shows the recipes and pieces. |
| `examples/Recipes` | 74 standalone projects, from a supersaw to a drum loop, that `Listen.py` plays. |
| `examples/Instruments` | The standard set: 104 instruments for General MIDI's 128 programs, a 23-sound drum kit and GM2's effects, one example per family. `MakeInstruments.py` writes them from the modules in `examples/Sounds`, sets each one's level, and writes `GeneralMidi.json`, which program and key each plays. |
| `examples/Pieces` | Six public-domain pieces arranged for the engine, from a Bach prelude on harpsichord to Grieg's trolls for orchestra. `MakePieces.py` writes them from the scores in `Scores`. |

## Native

    cmake -B build/native
    cmake --build build/native
    ctest --test-dir build/native

Every `*Test.cpp` is found by a glob and becomes its own GoogleTest target. Native builds also have `modsynth::parallel`, which
renders a frame's tracks on a thread pool with the same output, and `ParallelTest` holds it to that. To run it under ThreadSanitizer, as CI does:

    cmake -B build/tsan -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_CXX_FLAGS=-fsanitize=thread -DCMAKE_EXE_LINKER_FLAGS=-fsanitize=thread
    cmake --build build/tsan --target ParallelTest && build/tsan/ParallelTest

## Python

    uv build
    uv run --isolated --no-project --with dist/*.whl --with pytest pytest bindings/PythonTest.py

The module compiles a request and renders it offline to NumPy:

    import json, modsynth
    image = modsynth.compile_image(json.load(open("examples/Recipes/DrumLoop.json")))
    audio = modsynth.render(image)                      # float32, (frames, channels), 48 kHz, to the end and its tail
    audio = modsynth.render(image, 30.0, workers=4)     # the same bits, with the tracks on four threads

`modsynth.Engine` plays a Program frame by frame and takes notes, parameters and transport events, as the browser does. A render releases
the GIL, so engines on separate threads render at once.

## Web

### Building and running

    emcmake cmake -B build/wasm -DMODSYNTH_BUILD_TESTS=OFF
    cmake --build build/wasm --target modsynth_wasm modsynth_compiler_wasm
    cd web
    pnpm install
    pnpm wasm      # copies the wasm build into the app
    pnpm build
    pnpm start     # http://127.0.0.1:5321
    pnpm test      # the unit tests
    pnpm e2e       # the browser tests, in Chromium, on a server of their own at 5331, or E2E_PORT

- An empty database fills itself with the demo project on first start.
- There is no authentication, so keep it on loopback.
- `pnpm format` formats the app with Prettier, and `pnpm lint` checks it with Prettier and ESLint. The pre-commit hooks run both
  with the versions the lockfile pins, so run `pnpm install` in `web/` before committing there.

### The editor

It is laid out like a DAW, as two views under one top bar: **Song**, the arrangement with the notes of the chosen clip below it,
and **Patch**, a patch's graph at full height.

- **The top bar** holds the transport and a loop button, the position and the tempo as fields, one Undo and Redo for the view on
  screen, the keys, the master meter with a limiting light, a compile light that lists any problems with links to them, and Save.
- **The browser** down the side, which folds to a rail, holds the library and the examples.
- **The address** holds the view, track, clip, tab, Expand, the chosen node and the JSON tab, so a reload or a link lands where you
  were.
- **Audio** starts with the first click or key. A new song starts with a track playing an electric piano and an empty clip open in
  the roll.
- **Shortcuts** are written here as Mod+K and so on: Mod is ⌘ on a Mac and Ctrl elsewhere, and no shortcut uses Alt.

### Songs

- **Tracks:** + Track makes a track with a clip of its own. Track heads have mute and solo, a volume fader and a pan knob, and drag
  up or down to move the track.
- **A track's patch** is chosen from one searchable list, or dragged from the browser onto its track, or below the tracks for a new
  one. The built-in patches are the standard set, under its General MIDI families, and then the recipes' and pieces' own under
  Techniques. Its name in the track head opens it in the Patch view. An effect dragged onto a track or a Mixer strip joins its inserts, and
  WAV files dropped on the song become an instrument on a track.
- **Drum tracks:** Use the standard kit, on a track's menu, makes it a kit: each key plays its own drum, which the roll names.
- **Clips** snap to bars, apart from the notes' Snap. A clip's menu splits it at the pointer or the playhead, as Mod+E does, into two
  clips that play as it did. ⤢ or a double-click on a clip gives the notes the whole view, and each clip keeps its zoom.
- **The arrangement** is only as tall as its tracks until the tab strip under it is dragged. I folds the inspector.
- **The Time & key lane** above the tracks marks where the time signature and the key change. Its menu adds changes, which the
  inspector sets, with a pickup before bar 1. Bars, Snap, positions and the click all follow them, and the compiler ignores them.
- **The Tempo lane** unfolds into the song's tempo as a curve, where a click adds a change, a drag sets it and a click on a segment
  makes it glide.
- **Lanes** can move any input inside a track's patch, which gets a parameter for it, and a lane's points join in lines.
- **Playing:** a song stops at its end unless a loop is on, and the timeline follows the playhead.

### Notes

- **The roll:** a click adds a note, and a clip grows to hold one placed past its end. Velocity stems are as wide as their notes,
  and a drag across them paints.
- **The score:** Score, beside Roll in the Notes toolbar, shows a clip as a score in the song's time and key signatures, drawn with
  VexFlow. A click on a line or a space adds that note, and the arrows move what is chosen.
- **Step entry:** R turns it on. The keys write notes and chords at a cursor, in the roll or on the staff, → rests and Backspace
  steps back, and C and V set the velocity of new notes.
- **Recording:** ● or Shift+R counts in a bar with a click, and what the keys play while the song plays is written into the chosen
  track, each note's start snapped to the grid and its length as played, adding to the clip on each pass round a loop.
- **Fields** read in bars and beats, note names and note values, and a bare number in a length is bars, as in Live and Logic. Snap
  and Draw have triplets.

### Patches

- **The graph:** wires are dragged between nodes. A click chooses a node and Delete removes it, a Shift-drag box chooses several, and
  N or a double-click searches for a node to add. Errors show on the nodes they belong to, any node can show a scope, and the
  patch's JSON is in a tab beside it.
- **Nodes** show their values, which a drag across changes. Fit pressed again shows the whole patch.
- **Modulate this input,** on an input's right-click menu, puts an envelope or another source on it, through a snap and a new
  Control, in one step.
- **A Control** shows its value, on a log scale where its range is wide, and saves the track's value with the song. Make default
  writes it into the patch.
- **A built-in or an example's patch** is changed with Edit a copy, which puts the copy where the original played.

### Playing and keys

- **The computer keyboard** from A to ', with Z and X for the octave, plays the chosen track, or in the Patch view the patch, on its
  own when no track plays it. It plays at the Vel beside the keys, which new notes take too, and Latch holds what it plays. Keys in
  the Patch view puts the keys across its foot, bigger.
- **Space** plays and stops, and Home, or Stop pressed twice, goes back to the start.
- **?** shows every key, and Mod+K opens a song, an example or a patch by name.
- **Menus:** Shift+F10 or a right-click opens the menu of whatever is edited by pointing, from a clip, a note or a lane to the ruler,
  a node or a wire. In an example or a built-in patch it greys out what would change it and says why.
- **Mod+C, Mod+V and Mod+D** copy, paste and duplicate notes, clips and nodes.

### Saving and examples

- Edits to any number of patches and timelines stay, each with its own undo, while other things are opened, and Save writes them
  all at once.
- An example plays as it is, and adding one copies it into the library.

## Firmware

This needs `arm-none-eabi-gcc` with newlib, and QEMU. Homebrew's toolchain has no C library, so on a Mac use a Debian
container.

    firmware/Check.sh

That builds stereo, mono and CMSIS-DSP firmware at frames 32 and 128, runs each on QEMU's L475 model, compares its audio with the golden renders,
and then fuzzes on a Cortex-M4. `FUZZ_SECONDS` and `FUZZ_RANDOM` set how long, and from what seed. It also builds the NUCLEO-L476RG's
firmware, and checks that the profile in `firmware/Profiles` is the one that build writes.

With the board plugged in, flash it and talk to it with `tools/Board.py`:

    probe-rs download --chip STM32L476RGTx --connect-under-reset build/firmware/Nucleo.elf
    uv run --with dist/modsynth-*.whl tools/Board.py send examples/Recipes/Arpeggio.json --play
    uv run tools/Board.py check      # every golden image, rendered on the board

A request is compiled against the board's profile, so one that won't fit, in memory or in a frame's cycles, fails before it is sent, and
the board refuses it too. [docs/Board.md](docs/Board.md) has the protocol, the audio pin, the cost limit, and what was measured, including
which recipes fit.

## Instruction counts

Kernels and recipes have exact instruction counts on QEMU, and CI fails if one moves more than 1% from `bench/M4.json`. In the same
Debian container as above:

    tools/Bench.py m4         # every kernel case, recipe and calibration Program, into build/bench
    tools/Bench.py check      # what CI runs: the counts, the board's cost table, and every Program within its bound
    tools/Bench.py baseline   # if a change is meant to move counts, make them the new baseline, and rewrite the cost table

`tools/Bench.py host` times the same cases, the recipes and the pieces on this machine, and `tools/Bench.py table` writes
[docs/Benchmarks.md](docs/Benchmarks.md) from both.

## Fuzzing

    cmake -B build/fuzz -DMODSYNTH_BUILD_FUZZ=ON -DMODSYNTH_BUILD_TESTS=OFF -DMODSYNTH_BUILD_COMPILER=OFF -DMODSYNTH_INSTALL=OFF
    cmake --build build/fuzz --target modsynth_fuzz
    build/fuzz/modsynth_fuzz 60 1 golden/AllOps.image golden/Demo.image golden/Waves.image golden/Tones.image \
        golden/AllOps32.image golden/Demo32.image golden/Waves32.image golden/Tones32.image golden/Lanes.image golden/Zones.image golden/Hold.image

The arguments are seconds, a random seed, and the images to start from. Use `emcmake cmake` for wasm32 and run the result with
`node`. A failure prints a recipe, and `--replay` runs it again on any target, with the same image, under whatever sanitizers
that target has:

    build/fuzz/modsynth_fuzz --replay 0:3219687050,256226439 1 golden/AllOps.image golden/Demo.image golden/Waves.image golden/Tones.image \
        golden/AllOps32.image golden/Demo32.image golden/Waves32.image golden/Tones32.image golden/Lanes.image golden/Zones.image golden/Hold.image

Fuzz with `AllOps.image` as well as `Demo.image`. The demo's tasks all depend on each other and it has no globals, so on its own it
cannot exercise the rules that make task order irrelevant. The frozen images play at frame 128 and the others at 32, and an image reaches
only the engine for its own size, so fuzz from both sets. Section 23 of the design says what each oracle catches.

## The format

Before changing anything in `Format.hpp`, `Opcodes.def` or a kernel, read section 2 of [docs/Format.md](docs/Format.md). Opcodes and golden
files are append-only, and CI enforces that against the base branch. `tools/ReadImage.py` reads images from the specification alone, and
fails if the document and the code disagree:

    python3 tools/ReadImage.py --coverage golden/Minimal.image golden/Demo.image golden/AllOps.image golden/Waves.image golden/Tones.image \
        golden/AllOps32.image golden/Demo32.image golden/Waves32.image golden/Tones32.image golden/Lanes.image golden/Zones.image golden/Hold.image
    python3 tools/ReadImage.py --example golden/Minimal.image
    python3 tools/CheckAppendOnly.py origin/main

## Workflow

Work goes to a branch as it happens. A finished milestone lands as one squashed pull request into `main`, and only those
pull requests run CI, so run the checks above before pushing. One that changes only Markdown skips CI, unless it changes
`docs/Format.md`, which `tools/ReadImage.py` reads.

## License

modsynth is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). You may use, change and share it for
any noncommercial purpose. That includes personal study, research, hobby projects, and use by charities, schools, public research
bodies and governments. Commercial use needs a separate license from the author.

The libraries the build fetches or installs, such as nlohmann/json, GoogleTest, Google Benchmark, nanobind and CMSIS, keep their own
licenses. The scores in [examples/Pieces/Scores](examples/Pieces/Scores) are Mutopia Project editions in the public domain.
