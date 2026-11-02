# modsynth design, revision 16

Status: Milestones 1 to 4 and 6 are implemented, along with the harnesses of Milestone 7. Milestone 5 waits for the board.
The wire format is frozen at version 1, now at revision 6. `docs/Format.md` is its specification, and where this document and that one differ, that
one is right. This document replaces all earlier revisions, and everything needed from them is included here. Sections about later milestones are
still proposals. Section 24 lists what is agreed but not built, and what is still undecided.

Evidence tags:
- [measured]: run in a throwaway prototype, numbers quoted.
- [model]: instruction counts are exact, but the cycles are those counts priced with a Cortex-M4 timing table.
- [not prototyped]: reasoned, never run.

## 1. Requirements

From the author:

1. Programs are lists of Instructions, interpreted and executed.
2. Patches are lists of steps run per frame: noise, biquads, oscillators, wavetable lookups, filling constants.
3. Buffers hold per-sample values. Scalar registers hold frame-constant values.
4. Templated on a SynthConfig NTTP for samples per frame. The sample rate is supplied at run time.
5. Generic over backends and allocation. CMSIS-DSP is a supported backend. Arena on embedded, heap on desktop.
6. Targets: native C++ (header-only), wasm via Emscripten, Python via nanobind.
7. A DAW-style web GUI creates programs and patches.
8. Patches are PureData-style graphs that compile to topologically sorted steps.
9. A wire format using byte offsets, not pointers.
10. Patches come before programs, so programs can be sent without re-sending patches.
11. Multi-channel, multi-voice like a DAW on desktop, from one codebase that also runs on embedded.
12. Embedded targets are the STM32L4 and faster STM32 parts.
13. Timelines compile to Programs. Graphs compile to Patches, which timelines can use.
14. Sample and asset playback is in scope.
15. Hardware never talks to the GUI. It receives compiled images in the wire format.
16. Browser playback has an oscilloscope-type display.
17. Parallel execution on desktop is an opt-in feature. Without it, execution is serial and no threading code is compiled.
18. The GUI is a SvelteKit app using server-side actions, with Drizzle and SQLite persisting timelines and patches.
19. Patches are globally available. A compiled Program contains only the patches it actually uses.
20. A set of Programs can be compiled together with one shared set of patches.
21. Stereo is a compile-time feature. A mono-only embedded build excludes it.
22. Behaviour is never conditioned on target. An engine plays an image exactly or refuses it, and not every program has to run on a device.
    Cheaper, less precise features exist for embedded, and the full versions for desktop, but an author picks between them.
23. Events are not tied to frame boundaries. Embedded can opt out, and this costs nothing at run time where it isn't used.
24. A device receives the whole image over BLE or a serial link.

## 2. Pipeline

    Web GUI: SvelteKit pages, server actions, SQLite: global patch library, timelines, assets
        | compiler (C++, wasm in a browser worker for preview, wasm in Node for exports)
        | reads a target profile when compiling for hardware
    Image: Asset, Table, Patch and Program chunks, portable read-only bytes
        | AudioWorklet message, file, or a BLE or serial link to a device
    Loader and validator: runs on every target, the trust boundary
        | binds the image to target-specific runtime memory at the run-time sample rate
    Engine: Synth<Config, Backend, Executor>: tracks, voices, interpreter, compiled mixer
        | kernels
    Backends: scalar, CMSIS-DSP, later Accelerate and Highway

A Graph is an editable patch. A Patch is its compiled form, a list of Steps. A Timeline is the editable arrangement. A
Program is its compiled form, one Instruction stream per track. An Image is a set of chunks. The library holds every
Graph; an Image holds only what its Programs reach, per section 19.

## 3. Wire format

Definition data goes on the wire. Runtime state never does, because its layout depends on backend and frame size.
Sending raw arena bytes works for the definition half only.

- Byte offsets, little-endian, IEEE 754 floats, no pointers.
- Every asset, table, patch and program is a chunk with its own header and 64-bit hash. References are by hash: a Patch
  names tables and assets, and a Program names patches. The hash is identity and corruption detection, not
  authentication.
- An image is a manifest followed by chunks in the order assets, tables, patches, programs. This keeps requirement 10's
  layout and extends it with assets. Adding a patch invalidates nothing already stored.
- A receiver works one-way. The manifest lists the hash and size of everything needed, the receiver discards the bytes of
  any chunk it already has, and it commits only once every chunk is present and verified. A failed image leaves the old
  set intact. A two-way "what do you have" exchange can be added later as an optimisation, and nothing depends on it.
- A heap image is a `std::vector<std::byte>`. An arena image is the same bytes in a static block or memory-mapped flash.

## 4. Memory

The `Synth` constructor takes memory, and `bytes_required()` sizes it. Arena or heap is only a question of who owns the bytes.

Revision 3 said one runtime span. That is wrong for the named targets. The STM32L476's 128 KB is split into 96 KB and
32 KB blocks. QEMU's L475 model faulted exactly at the end of the 96 KB block [measured]. Other parts have similar splits,
such as CCM on the G4 and TCM on the H7. The constructor therefore takes:

- `fast`: scratch buffers, voice state, decoded steps.
- `bulk`: delay lines. It may be the same memory as `fast`, and on desktop it usually is.

Read-only data stays where it is: patches and programs are validated in place and tables and assets are used in place,
so they can live in memory-mapped flash [measured: the benchmark image ran from flash]. Only decoded steps cost RAM, and
only for patches a Program uses. Uploads go through a chunk store, whose only job is to map a hash to read-only bytes.

## 5. Patches and the graph compiler

- Compiler passes: dead-node removal, delay splitting, Kahn with smallest id first, buffer allocation by last use.
  [measured: 11 nodes used 3 buffers, 200 shuffles gave identical bytes, a delay-free cycle was rejected.]
- Every Patch declares a parameter table: stable id, scope (voice, track, global), range, smoothing. Operands name a
  buffer, a scalar in one of those scopes, or a constant. Patches gain control-rate Steps that write scalars.
- Initial values live in the Program, so a knob move changes no Patch hash.
- Patches have an I/O port table, with stereo as ordinary ports.
- A Step writes only scalars of its own instance, and instances share no mutable state. Section 18 explains why, and the
  validator enforces it on every target.
- Delay time is in seconds with a declared maximum, sized at bind time. Only feedback needs a delay of at least one frame.
  Feed-forward delays are ordered write-first, so short Haas and flanger delays work. Sub-frame feedback, if it is wanted (open 10), would be a step
  range run at a smaller n, arriving as new opcodes, which an older engine refuses cleanly. Nothing needed to be reserved for it.
- An input read once a frame refuses audio, and that is a compile error. Reading one sample in a frame is right for an envelope and silently
  wrong for anything above half the frame rate, 187.5 Hz at frame 128 and 750 Hz at 32: a 1 kHz modulator on a cutoff gave sidebands at +-125 Hz. Only a
  patch's author knows which case this is, so a `snap` node says so, and every wire has one rate. Env is audio, so a filter or pitch
  envelope goes through one. `Demo` and `AllOps` predate the rule, so `GoldenTest` adds their snaps to the JSON it compiles. A snap has its
  own place among the steps, which moved their bytes, and they render bit for bit as they did [measured]. It can also move a Noise step, whose seed
  comes from its position, so adding one to a patch with noise can change the noise sequence, at the same level. Of 11 recipes that needed
  snaps, 2 did, and with noise taken out they too matched to the bit [measured].
- The loader lowers wire Steps into a private decoded array, so run time never re-reads validated bytes.
- Kernels are total: safe for every input value. Wrapped oscillators use u32 phase and power-of-two tables.
- An `Either` operand takes audio or a scalar on a single input, for new ops only, rather than a twin op for each rate. `OscMod` takes frequency, phase and
  sync, and its fourth input is feedback on a sine and width on a pulse, because a step has 4 inputs. Sync's jump is smoothed the way a saw's own is, on every wave,
  which costs a sample of delay. Its sine comes from `sin_turns`, which is more accurate than the table and needs none, so an image using only `OscMod` carries no
  8 KB table [measured: -134 dB against -118 dB]. All that costs far more than `Osc` on a Cortex-M4, 128 instructions a sample against 17 for a sine and 64 against
  13 for a saw [measured], so it's for a voice that needs the modulation. `Math` has min, max, abs, clip, floor, divide, compare and select, and is `KMath` when no input is audio, so its result
  can drive an input read once a frame with no snap. `Shape` reads a curve from a Table, because it needs a table resource. An op's mode list can't
  grow once it is on `main`, since `max_mode` sits in an append-only line, so its modes are settled before it merges. A graph selects a new op with an
  explicit `"mode"`, as `Tone` and `Sample2` do, so a saved graph keeps its meaning.
- A subpatch node names another library patch and expands into its parent before any other pass runs, so ordering, dead-node removal and the rate rule work through
  one with nothing added. Its ports are the inner graph's `inlet` and `outlet` nodes, and `l` and `r` if it has `in` or `out`. An inlet compiled alone is its default. Inner
  parameters merge into the parent by id, because a timeline can address only one, and two that disagree are an error unless the parent declares that id. An
  inner node's id comes from its own id and its subpatch's, so editing something else in either graph moves no state id, and a live swap carries its state. A
  patch used only as a subpatch never becomes a chunk, and nesting stops at 8.

## 6. Programs and timelines

A Timeline compiles to a Program, and a Program is a table of tracks.

- Each track has its own Instruction stream, cursor, Wait, and Call into a clip table.
- There is no general Jump. Repeats are structural with nonzero length, so a loop with no time in it cannot be written.
- A track holds a list of patch slots. `SetPatch` applies to the next note, so a timeline can change instrument while
  held notes finish on the old patch. Voices on a track are sized for its largest slot. A patch also works as a mixer
  insert, per section 8.
- `SetParam` and `Ramp` address (track, param id), and a lane with no target compiles to these. A lane's `target` reaches past its
  own track: `{"insert": id}` moves an insert's parameter, and `{"mix": "fader" | "pan" | "send", ...}` moves the mixer, naming a `track`,
  a `bus` or `"master": true`, and for a send the bus it goes `to`. Unknown keys are errors, so a target can gain a `channel` for per-note
  control without an old document changing meaning. The stream head puts everything a lane moved back to its starting value,
  which is what makes a locate or a loop sound the same as playing from the top. A lane with no target that opens with a plain value at tick 0 already does
  that, so it adds nothing to the stream. A `SetParam` reaches every slot of a track, so where a parameter has to go back and its slots start from
  different values, the compiler refuses it and asks for a track value or a value at tick 0.
- A mix register holds fader, pan and send multiplied together, and a lane has to work out what to write from the others' fixed values. So
  two controls that share a register can't both move, and the compiler refuses that and points to a gain or pan insert, whose
  parameter can. One track owns a target, because a locate replays one stream after another and playback interleaves them. A global parameter is a
  target too, however a lane reaches it, because it belongs to the Program and not to a track. A lane on a track that never plays is an error if it reaches
  past that track, which a target or a global does, because it would otherwise vanish without a sound. A lane on an insert or chain that nothing plays
  through is dropped, because nothing can hear it.
- Play modes are per track and carried in the stream, so a song can change them midway: poly, mono or legato, with note priority and a glide
  time. A patch can't do this itself, because it is one voice and can't see the others. Glide moves the voice's note scalar a step per frame, so
  every patch follows it with no new op. `Tone` latches its pitch at note start and does not. Format.md section 7 has the rules, and a Program
  that uses no play mode sets aside nothing for them.
- All tracks share one tick clock. A conductor stream carries tempo changes, and ticks convert to samples through an
  exact rational accumulator at the run-time rate [measured: no drift over 10 minutes].
- A tempo change can ramp to the next one, linearly in bpm over ticks. The engine has no ramp: the compiler writes one as
  a change every 1/32 note, at the tempo halfway through it, and in longer steps for a ramp that would need more than 1,024.
  So a ramp needs no new instruction and plays the same on every target. Each step rounds to its sample, as any change does
  [measured: a four-bar ramp from 120 to 60 bpm ended 79 samples, 1.6 ms, after the exact curve, counting to the end of a
  32-sample frame]. A parameter or mix ramp converts its length in ticks to time at the tempo where it starts, so one that
  overlaps a tempo ramp ends a little early or late, as one already does across an ordinary change.
- Transport (play, stop, locate, loop range) is engine state, so dragging a loop brace does not recompile. A locate replays
  the streams silently from the start, which chases held notes and parameters. That costs time proportional to the Program
  in the frame it happens, so a tick-to-offset index will replace it when a real Program makes it too slow.
- Events carry a sample offset, and Env honours gate changes at that offset. [measured: without this, 122 of 200 one-tick
  notes made no sound.]
- Events are not tied to frame boundaries. A Program's notes already land on their samples, and `Tone` and `OscMod` start on their note's sample. Live notes and the
  other oscillators do not yet, and a parameter changes only at the start of a frame. The finer forms must cost an embedded build nothing, so like
  `channels` they are a compile-time choice, and a build without them has none of their code. The target rule means such a build can't round to the
  frame instead: an image that needs them declares it, and a build without them refuses it. On the one kernel tried, writing it over a range fixed at
  compile time to a whole frame gave identical Cortex-M4 assembly to today's [measured]. How far this goes is open 11.

## 7. Sample and asset playback

An Asset is a new chunk kind, separate from power-of-two wavetables.

- Header: encoding (i16 first, f32 allowed), channels, native rate, frame count, root key, loop start and end.
- The compiler appends one guard frame, so interpolation can always read `idx + 1`.
- `Sample` is a Step with a 32.32 position. Validation requires `loop_start < loop_end <= frames`. The increment is clamped
  below the loop length at control rate, so one wrap subtraction is always enough and the kernel stays total.
- On Cortex-M4 this costs 52.8 instructions per sample for mono i16 and 46.8 for f32, against 16.6 for a wavetable oscillator [measured:
  `docs/Benchmarks.md`]. Interpolation is always linear. A form without it was modelled at first, and no such mode exists.
- Native rate over engine rate enters the increment at run time, so an asset plays correctly at any engine rate.
- A one-shot reaching its end marks that source done. A voice is free when its envelopes and sources are all done.
- On a device, assets go straight to flash and are not staged in RAM. They stay unreferenced until their
  hash checks out, so a bad upload is still harmless. Hashing costs about 12 cycles per byte, or roughly 160 ms per MB at
  80 MHz [model]. It runs on receipt, not at every boot.
- On wasm the fixed heap must hold assets, because memory growth stays off. An image slot is 16 MiB, about 2.9 minutes of mono i16 at 48 kHz, and an image over it is refused on load with the reason
  shown on the page. Its size becomes a start-up setting. What a large heap costs in the browser is measured in Milestone 7.
- `Sample2`, from revision 4, is the op asset import writes. A Table of zones maps key and velocity ranges to recordings, each with its own root
  key, and the note picks one at its start. It takes `note` rather than a ratio, because the root is only known then, and that is what lets a
  glide or a legato change slide one recording. It adds a start offset, reverse, and a tail, where a loop runs while the note is held and plays
  on to the end after release. A loop with no tail does not hold a voice open, so a note ends with its envelope. `Sample` is frozen and stays as it
  was, and in a graph `"mode": "zones"` on a `sample` node selects `Sample2`.
- In-memory playback is in scope now. Disk streaming and compressed assets are deferred, and the header reserves a flag.
  An L476 with about 900 KB of flash spare holds about 9.6 seconds of mono i16 at 48 kHz, or twice that at 24 kHz.

## 8. Mixer

Routing compiles, with the same compiler, into a validated step list over bus registers: RunVoices, RunInsert, Gather.
Gather reads a list of inputs with gains into one bus, so a send is a Gather input and every Sum into a bus is one task,
as section 18 needs. Sends, sidechains and processing order come from the same topological sort, and section 18's task
graph derives from that structure. Voice count belongs to each track.

**Channels.** `SynthConfig::channels` is 1 or 2, and it defaults to 2. A build with 1 has one-channel bus registers, no
right gains in Gather, and no pan calculation. Like the executor, this is a compile-time choice with no macro.

The image does not change. Patches and Programs are channel-agnostic, and a mono build folds them as it runs, so a Patch
hash never depends on the target and one image plays on both builds. Compiling a mono variant of a patch would make its
bytes depend on the target and break section 20's sharing.

- A patch with one output, where `out_left == out_right`, costs a mono build nothing extra.
- A stereo patch folds to (L + R) / 2 at the voice or insert output. Its right-only steps still run, so a mono product wants
  mono patches, and the fit check shows this.
- Gather uses (left gain + right gain) / 2.
- `Pan` uses a linear law, left = (1 − p) / 2 and right = (1 + p) / 2, so left + right is constant. A mono build can then
  output in / 2 with no position read and no pan math, which is exactly the fold. Track pan is still equal-power, because
  the compiler turns it into two gains.
- `Sample` folds a stereo asset as it reads, and writes the same signal to both outputs.

The fold is not an identity for everything. It equals (L + R) / 2 of a stereo render for centred, channel-symmetric mixes
[measured: the demo project with pans at 0 agrees within −100 dB], but a panned stereo source or a channel-asymmetric insert
differs. The target profile records `channels`.

## 9. Sample rate

`SynthConfig` carries no sample rate. The rate is a constructor argument on every target, so there is one code path.

Requirement 4 originally put the rate in the NTTP, and revision 3 proposed 0 to mean run time. A single runtime path is
simpler, and parameters are physical units anyway. Hardware gains an option from it: running at 32 kHz gives 50% more
cycles per sample and a third less delay memory with no change to the image's bytes. How it sounds does move, because control rate and the shortest
feedback loop follow the rate, which open 21 covers.

Delay lengths, phase increments, envelope and filter coefficients, and tick conversion are all derived at bind time. A
rate change is a rebind through the same path as a generation swap, and it can fail on a device if the result no longer
fits.

Frame size stays compile-time in an engine, and an image declares the size it was compiled for, because frame size changes sound: every
golden with sound missed the −100 dB contract when rendered at 32 instead of 128 [measured]. An engine refuses an image of another size,
so a project sounds the same wherever it plays. The default is 32, on firmware too. At 48 kHz that is a 1500 Hz control rate, which carries modulation
up to 750 Hz, a shortest graph feedback loop of 1500 Hz, at most 31 samples of parameter timing error, about 10% more CPU than 128 [model], and a
quarter of the buffer RAM. Images from before
revision 3 declare nothing and mean 128, so they keep their sound and an engine at 128 still plays them. Desktop devices can use
varying block sizes, so a host adapter reblocks through a FIFO. The browser's render quantum stays 128, so there 32 gains control rate
but no latency, and the binding runs one engine at each size and renders whole quanta. Moving between them stops the sound, with no fade.

## 10. Hardware path

Hardware never talks to the GUI. That removes capability negotiation, the live device protocol, and live editing on
embedded. It adds one requirement.

**Behaviour is never conditioned on target.** An engine plays an image exactly or refuses it. Not every program has to run on a device: a
feature a target lacks is unavailable when compiling for it, so the compile fails, and the loader refusing is the backstop, because
delivery is one-way. Cheaper, less precise features exist, such as `Tone` or `"mode": "naive"`, but an author picks them and they sound the
same everywhere. Nothing is rounded, substituted or lowered by target. A mono build folds at run time, which is the one exception, and
it is treated as an output format, a position open 20 still has to confirm.

**Target profile.** Revision 3 had devices report their state sizes, which cannot work without a link. Instead the
firmware build generates a profile: sample rate, frame size, memory regions, supported opcodes, per-backend state sizes,
and a per-op cost table. The sizes come from the cross-compiled binary, so they are correct for that target. The
compiler uses the profile to check a project against that device while offline. The GUI shows fit and CPU, and previews
with the device's voice limit, so stealing sounds the same as on hardware.

**Delivery.** A device receives the whole image over BLE or a serial link, and a small host tool sends an exported image file. The format needs no
change for this. It uses byte offsets and no pointers, its manifest comes first, so a wrong revision or frame size can be refused from the first
packet, and each chunk's hash and the image's exact size catch damage. Framing, retransmission and acknowledgement belong to the transport, because
a hash only finds damage once a whole chunk has arrived. They stay inside the transport, so a sender still learns nothing about a device, and delivery
is one-way as far as the image goes.

`Loader::begin` takes a complete image as one 8-aligned span, which suits this: the receiver writes the image to memory-mapped flash, then loads it from
there. Its bytes are used in place, so they have to outlive every generation that plays them. A `Loader::feed(span)` taking bytes as they arrive was
proposed here earlier and doesn't exist. Only a store that places chunks separately would need it.

**Storage.** How a device stores what it receives is open 22. Whatever it stores, a failed transfer or a loss of power must leave the previous image
playable. Because bytes are used in place, writing over the only copy would break that. The L476's two read-while-write flash banks could allow writing
while running, but at first audio stops for an update.

Milestone 1 needs none of this, because the image is linked into the firmware.

## 11. Live editing, desktop and browser only

A generation is an image reference and a runtime block, capped at 2 live. A third edit force-fades the
oldest. The compiler emits a stable state id per stateful step, so state of matching type and size carries across a swap.
Parameters carry by id, clamped to the new patch's range, and a global to the range of every patch that declares it. Mix registers have no ids, so they
carry only between Programs with the same mixer, down to its tracks and inserts, and a register whose starting value the edit changed takes the new value.
Any other edit to the mixer returns its registers to the document's values. Inserts crossfade. Embedded builds use a limit of 1, with no separate code path.

The engine can't tell a value moved by hand from one a lane left behind, and carrying is right for both while a lane is still there: a fader automated down would otherwise jump back up on every edit.
So the editor settles after each swap to a song's image, writing the document's value to every mix register, parameter and global that no placed lane moves. Without that, a deleted lane's last value stays until
the page reloads, even across a locate, and a value changed in the document is ignored because the old one carries over it. The engine's rule stays as it is, and only an editor that holds a document can do this.

## 12. Browser load path

The wasm build deliberately has no SharedArrayBuffer and no memory growth. The compiler runs in a separate wasm instance
on a worker and transfers image bytes to the worklet, which loads them in slices across render quanta. The loader is
resumable on every target, and device delivery uses the same mechanism. The worst quantum during a load is measured in
Milestone 7.

## 13. Oscilloscope

The browser shows live waveforms during playback, starting with the master and track buses and later any graph node.
This is engine and host state only. Nothing about it enters the image, so it does not affect hashes or the format freeze.
Scopes on the master, track and mixer buses and probes on graph nodes are built, and tested in a browser. There are eight tap slots, so the master comes first, then tracks, then buses, and a probe takes what
is left. A probe follows a voice, on whichever track and patch slot plays it, so it can't reach an insert.

**Tap.** The engine has a fixed number of tap slots, set by `SynthConfig`. Hardware builds use 0, which compiles the
feature out. `set_tap(slot, target)` arrives through the event queue and is validated there like any live event.

A target names a compiled step and output register, not a graph node. Buffer reuse means a register holds a given signal
only just after its step runs, so the copy happens at that point. The compiler writes a debug sidecar mapping graph nodes
and buses to steps and registers. The sidecar stays with the GUI, never enters the image, and also supplies "errors shown
on nodes". A tap inside a Patch follows the newest active voice on that track.

Only the voice being watched runs a step at a time, and every other voice runs as usual, so a build with taps pays a scan of its tap slots per track and the copy.
A build with no tap slots has none of this code.

**Transport.** Taps use the existing path, with no SharedArrayBuffer:

- The worklet copies from the wasm heap into preallocated ArrayBuffers and transfers each block over its MessagePort. The
  main thread transfers the buffer back for reuse.
- Blocks are about 1024 samples, so a tap sends about 47 messages per second. Copying happens only when a block fills.
- Each block carries tap slot, generation, starting sample index and a dropped-block count. The sample index lines traces
  up with each other and with the playhead.
- If no buffer is free, the block is dropped and counted. The display can never hold up audio.
- Heap views are created once, which is safe because memory growth is off, so the audio thread allocates no views.
- After a generation swap, the GUI re-sends tap targets from the new sidecar. The generation field marks the break.

A Web Audio `AnalyserNode` on the master would be less work, but it cannot reach tracks or graph nodes and has no sample
index. One path serves every case.

**Display.** The GUI keeps about a second per tap in a ring and draws on animation frames:

- Rising-edge trigger with hysteresis and an adjustable level, searching back from the newest sample, so periodic
  waveforms hold still.
- Auto mode free-runs when no edge arrives, so silence and noise still draw.
- Timebase from about 1 ms to 1 s per sweep. Wide timebases draw min and max per pixel, so peaks do not vanish.
- Clipping is shown.
- Latency of about one block plus one animation frame is acceptable for a display.

## 14. Trust and validation

- Uploads are staged and committed at a frame boundary only after validation, except assets, per section 7.
- Bounds use subtraction form. [measured: a sealed program claiming 0x20000000 instructions wraps the check on 32-bit.
  On QEMU's L475 the validator read about 57 KB past its section and faulted at 0x20018004. A 64-bit build rejects it.]
- Scalars are zeroed at voice start and def-use is validated. [measured: one image gave 0.0 or 0.75 by old memory.]
- Live events are validated at queue ingress and fuzzed. [measured: `note_on(200, ...)` crashed.]
- Table contents are checked for non-finite values, sliced.
- Each voice has an output guard, because about 14% of accepted fuzz images produced NaN or infinity [measured]. A guard trips only on values that
  aren't finite, so a finite blow-up still reaches the output. Open 9 covers that.
- Delay lines clear lazily, because a hostile image took 5.8 ms of a 2.67 ms frame [measured]. A per-op cost table sets a
  compile-time and load-time limit alongside the memory limit.
- Denormals: no target sets a flush-to-zero mode, because wasm has none. Kernels flush their own state every frame, the same way on every target, as
  `docs/Format.md` says under Arithmetic.

Revision 2's fuzz run did not exercise header rejection or most of each Program, and it ran only on 64-bit. Section 23 describes
its replacement.

## 15. Embedded performance

These figures are early estimates. Measurement and tuning wait for Milestone 7.

Target floor: the STM32L476 class, a Cortex-M4F at 80 MHz with 128 KB SRAM and 1 MB flash. It has no double-precision FPU
and no float SIMD, so `double` is banned from the run path.

All figures below are [model]: exact instruction counts priced with a simple M4 timing table, assuming zero wait states.
They leave out flash wait states, cache misses, DMA contention, FP stalls and load pipelining, and have not been
checked against a board. Treat them as within about 30%.

Cycles per sample, frame 64:

| Kernel | Scalar | CMSIS-DSP |
|---|---|---|
| Biquad | 17.6 | 14.6 |
| Mul or add | 11.3 | 9.4 |
| Wavetable oscillator | 21.8 | none |
| Noise | 13.3 | none |
| Envelope | 9.3 | none |
| Sample | 31.9 | none |
| Reverb comb, f32 line | 25.8 | none |
| Reverb allpass | 20.5 | none |

`docs/Benchmarks.md` now has measured instruction counts for every kernel, and they replace this table where the two differ. Sample is the largest miss,
at 52.8 instructions against 31.9 cycles, which is outside the 30% above. Comb at 29.6 and Allpass at 26.8 are also above their modelled cycles. This
table has no engine cost in it either, and each voice adds 28.6 instructions a sample whatever it plays [measured].

The native oscillators came later, from a pass that prices the wavetable oscillator at 19.5, so compare them with that. Their band-limited forms
pay only beside a jump, so they cost more at high notes, and the ranges run from 110 Hz to 4186 Hz:

| Oscillator | Cycles per sample |
|---|---|
| Wavetable, now only sine | 19.5 |
| Saw, band-limited / naive | 14.0 to 15.6 / 9.4 |
| Pulse, band-limited / naive | 19.3 to 22.7 / 10.7 |
| Triangle | 11.4 |
| Tone, a sine that holds one frequency | 9.2 |

Cycles were not the reason for them. Saw, square and triangle used to be one table each, with 48 harmonics at every pitch. Above 500 Hz those
fold back, and at 1760 Hz the saw's aliases were at −15 dB, about as bad as no anti-aliasing at all. Below it the table runs out, so a 110 Hz saw
stopped at 5.3 kHz. PolyBLEP gives −29 dB at 1760 Hz and keeps the top end, at the price of −36 dB where the table had −85 dB at 440 Hz, and about
3 dB of droop at 15 kHz [measured]. One table per octave would beat both, at the table's cycle cost, but an image would hold roughly 80 KB per wave
and the format would need a table with levels [estimate]. Naive stays available as mode 1, because it is half the cost, is fine for a low note, and
is sometimes the sound that is wanted. Triangle has only the naive form: PolyBLAMP doubled its cost and gained about 12 dB. In a graph, `"mode": "naive"` on an `osc` node
selects it, and a square takes a `width` input.

Tone is the recursive sine, for tones that need no table and do not move. A later pass priced it at 9.2 against 21.3 for the wavetable [model], and an
image of only these holds no 8 KB table. A recursion keeps its level in the step between samples, so moving its frequency moves the level, by 1/sqrt(f)
on a glide: −8.5 dB from 110 to 880 Hz and +20.7 dB from 4 kHz to 40 Hz, and past 1e12 within a minute when the frequency changes at random every
frame, even below 6 kHz [measured]. The magic circle is the same oscillator with its second variable scaled. It survives the glide and not the random
frequency. So Tone reads its frequency at the start of a note and holds it, which takes all of that away. Its tuning stays within 0.001 cents over an
hour on every MIDI note, and its peak within 0.01% of 1 over 24 hours at both ends of its range [measured]. It also starts on the note's sample, where
the other oscillators start on the frame's, so its phase at a note does not depend on where that note lands in a frame. It is written as the step `d`, because in `2 cos(w) * s[n] - s[n-1]` the
coefficient rounds badly near 2, which put a 20 Hz note 6 cents flat. In a graph, `"mode": "fixed"` on a sine `osc` node selects it, and sine stays
Osc otherwise, as only Osc can follow its input. If a table-free sine ever has to move, a rotation renormalised once a frame holds its level through
all of the above, at 12.4 cycles [model].

Whole voice (2 oscillators, noise, 2 filters, envelope), per voice with 4 held:

| Build | Cycles per sample |
|---|---|
| Scalar as in the prototype | 207 |
| Scalar, FMA contraction off | 196 |
| Scalar, FMA off, coefficients in locals | 176 |
| CMSIS-DSP, no loop unrolling | 191 |
| CMSIS-DSP, as its CMake builds it, loop unrolling on | 165 |
| CMSIS-DSP, unrolling on, FMA contraction off | 157 |

Findings to apply in Milestone 7:

- Build CMSIS-DSP with `ARM_MATH_LOOPUNROLL`, or the modelled gain mostly disappears. With it the table above models 10.8% for one voice, but over whole
  recipes the median saving at peak is 0.95% of instructions and the most is 2.3% [measured: `docs/Benchmarks.md`]. Those aren't like for like, since one
  is modelled cycles at frame 64 and the other instructions at frame 32. Open 25 needs cycles on a board.
- `-ffp-contract=off` is now set on every target, for a different reason: section 16. On M4 it also saves time, since `vfma` costs 3
  cycles where `vmul` plus `vadd` cost 2. That part rests on the timing table, not on a board.
- Hold coefficients in locals in scalar kernels. The prototype's reload per sample cost 56% on the biquad.
- Kernels no longer call libm, which also drops it from the firmware. Section 16 says why. Its replacements run at control rate, and have not
  been measured.
- Per-frame filter modulation is affordable: a coefficient update costs 245 to 285 cycles, about 2% of a voice per filter
  at frame 64.
- Frame 32 costs about 10% more than frame 128, and is the default for its control rate. Section 9 has why the size is part of the image.
- Wavetables in flash add about 9 to 12% to a voice at 80 MHz if every read misses.

Voices, at 48 kHz with 30% of the core held back for I/O and error in this estimate, at 160 to 200 cycles per voice:

| Clock | Example | Voices | With mono reverb (288 cycles per sample) |
|---|---|---|---|
| 80 MHz | STM32L476 | 5 to 7 | 4 to 5 |
| 120 MHz | STM32L4R5 | 8 to 10 | 7 to 9 |
| 170 MHz | STM32G474 | 12 to 15 | 11 to 13 |

Cortex-M7 parts are not modelled, because the M4 table does not apply to a dual-issue core.

RAM limits reverb before CPU does. Voice state is about 270 bytes per voice, but Freeverb-sized lines take 55 KB mono at
48 kHz in f32. Stereo f32 will not fit an L476 alongside anything else. Mono i16 takes 27 KB, or mono f32 at 32 kHz takes
37 KB. Lines are f32 today. An i16 line sounds different, so by section 10's rule it can't be a backend's choice: it would be an author's, through a new
op or mode.

## 16. Testing without a board

QEMU runs the real firmware on an STM32L4-family machine model with no board.

    qemu-system-arm -machine b-l475e-iot01a -cpu cortex-m4 -nographic -monitor none -serial null \
      -semihosting-config enable=on,target=native -icount shift=8,sleep=off -kernel firmware.elf

- Firmware brackets a region with SysTick reads and reports over semihosting. Under `-icount`, SysTick follows
  instructions, so the result is an instruction count. Repeat runs gave identical counts [measured].
- An independent per-instruction emulator run agreed to about 0.1% on most regions. Kernels with IT-block wraps differ by
  one instruction per sample because that hook misses skipped instructions; QEMU's count is the right one [measured].
- Three full runs took 0.06 s [measured], so the run itself adds nothing noticeable to CI. Installing the toolchain will.
- The model boots on the 4 MHz MSI clock, which makes one instruction 1.024 SysTick ticks at `shift=8`. Semihosting
  output goes to stderr.

Use it for:

- Unit tests and golden audio on the real target ABI and word size.
- 32-bit bugs: section 14's overflow is invisible on 64-bit and faults here.
- From Milestone 7, an instruction-count gate. Counts are exact, so CI can fail on a small regression with no timing noise.
- From Milestone 7, generating the op cost table for the target profile.

It cannot tell you about real time: wait states, caches, DMA, I2S output, or bus contention. The author has a board for
that, and any promise about voice counts waits for it.

Golden audio compares within a tolerance of −100 dB relative to peak, and audio is not required to be bit-identical across
targets. The reference is committed: `golden/` holds images written at the freeze, with their renders, and they never change.

Measured against those references, which a macOS arm64 build wrote. `Demo` is 122,880 stereo samples, `AllOps` 102,400 and `Waves`, from revision 1,
51,200. Each mono render has half as many. `Tones` from revision 2, the frame 32 forms from revision 3, `Lanes` and `Zones` from revision 4 and `Hold` from
revision 5 came after the table below, and CI holds them to the same comparison. Zero means exactly that: every sample's bits match.

| Target | Compiler | Stereo samples that differ | Mono samples that differ |
|---|---|---|---|
| macOS arm64 | Clang | 0 of all | 0 of all |
| Linux arm64 | GCC 14.2 | 0 of all | 0 of all |
| Linux x86-64, emulated | GCC 14.2 | 0 of all | 0 of all |
| wasm32 under Node | Emscripten 6.0 | 0 of all | within −100 dB, per `GoldenTest` |
| Cortex-M4 on the L475 model, scalar | arm-none-eabi-gcc 14.2 | 0 of all | 0 of all |
| Cortex-M4 on the L475 model, CMSIS-DSP | arm-none-eabi-gcc 14.2 | Demo at most −123.9 dB, AllOps at most −108.0 dB, Waves 0 | no mono build |

The scalar results come from `Math.hpp` and `-ffp-contract=off`: nothing in the signal path reaches libm or merges a multiply into an add. The
CMSIS kernels trade that for speed, which is why the tolerance exists and why they are the one row that needs it.

Note: Homebrew's `arm-none-eabi-gcc` has no C library. Use Arm's toolchain or a Debian container.

## 17. Benchmark rules

Benchmarks record worst frame and p99.9, use modulated patches, and include wasm on x86. The native cost per sample rose
from 3.5 to 10 ns between frames 8 and 512 for unknown reasons, so native ratios are not carried to Cortex-M. Use the
instruction counts above instead.

`tools/Bench.py` runs both sides and writes `docs/Benchmarks.md`: Google Benchmark on a host, and `firmware/Bench.cpp` for exact instruction
counts on QEMU, over one list of kernel cases and every recipe. wasm on x86 is not measured yet. CI runs both harnesses once, so they keep
working, and does not compare their figures: the instruction-count gate is still Milestone 7's. Cycles on a board need a harness that reads
`DWT_CYCCNT` instead of SysTick, and Google Benchmark can't run there, which is why the case list has no dependency on it.

Desktop figure so far [measured]: about 8.4 ns per voice-sample, flat from 1 to 2,048 voices on one M4 Pro core, scalar,
one patch, no effects.

## 18. Parallel execution

Parallel execution is opt-in and desktop-only. Without it the engine runs serially, and no threading code, scheduling data
or synchronisation is compiled.

**The flag is a template argument with a serial default.**

    template <SynthConfig C, Backend B, Executor E = SerialExecutor>
    class Synth;

- `SerialExecutor` is in the core headers. It is an empty type whose `run()` is a loop over tasks in compiled order.
- `PoolExecutor` is in `modsynth/Parallel.hpp`, the only header allowed to include `<thread>` or `<atomic>`. Core headers
  never include it.
- The CMake option `MODSYNTH_PARALLEL` adds `modsynth::parallel`, an interface target that links `Threads::Threads`. It is
  on for native builds, and off and unavailable for Emscripten and bare-metal builds. Firmware and wasm name no executor,
  so they get the default.
- There is no preprocessor macro. In a header-only library, a macro that changes the engine could give two translation
  units different definitions of one type. A template argument gives two types, so both can exist in one binary.

**What the executor owns.** `E::max_workers` sizes per-worker scratch, so serial builds have one array. `E::Plan` is
whatever it needs to schedule: a task count for serial, and dependency tables for the pool. Those tables and their setup
exist only when `E::uses_edges` is true, and they are built during the sliced load, so `bytes_required()` charges for them
only on parallel builds. Parallel builds also start every array on its own cache line, while serial builds stay packed. That holds only if
the host's memory is aligned to 64 bytes, which the Python binding's is.

**A frame has two phases.**

1. Control, always on the calling thread: Program cursors, events, transport, voice allocation, tap commands, generation
   commits, and control-rate Steps of global and track scope.
2. Audio: tasks from the compiled mixer list. One task is a track's voices and inserts, or one bus. Dependencies come from
   the mixer's sort.

Serial builds run the same two phases, so splitting the frame is not a parallel-only code path. With `PoolExecutor`, the
calling thread also works rather than only waiting, and tasks are claimed with atomic counters and no locks. Flush-to-zero and rounding are
per thread, so a worker in another mode than the caller would change the output depending on which thread ran a task. Each worker therefore
takes the caller's floating-point environment for every frame. Nothing sets flush-to-zero, as section 14 says, so this only matters to a host
that set it itself.

**The pool.** `ThreadPool` holds the threads, and `PoolExecutor<MaxWorkers>` points at one, so two engines can share a pool and their frames
take turns. `MaxWorkers`, 16 by default, sizes per-worker scratch. Each frame publishes the tasks with no dependencies, a worker claims ready
slots in order and runs them, and the task that ends a dependency publishes the task waiting on it. The frame counter and how many threads take
part share one atomic word, so a thread late to one frame can't take another's count, and the frame ends when every thread taking part has checked
in. Threads spin for 200 µs between frames and then sleep. A Schedule that is one chain, as a one-track Program is, runs on the calling thread,
because nothing in it can run alongside anything else, and so do frames for which a pool has one worker.

**Rules the format keeps, enforced since the Milestone 2 freeze.** They cost nothing on embedded, but relaxing them later would
be impossible, because images relying on the looser rules would then exist.

- A voice writes only voice scalars and an insert writes only scalars of its own track. Global scalars change only in the
  control phase. A shared LFO becomes a track-scope control Step, which runs before the voices. From revision 5 that Step is `KLfo2`, which
  holds its phase while the transport is stopped, so how long the engine sat before Play does not move it. One in a voice stays `KLfo`, because it
  belongs to its note. An oscillator or Noise in an insert still runs while stopped, because an insert has to, for its tail. No recipe has one.
- Instances share no mutable state. Noise generator state is per voice and seeded deterministically, and delay lines
  belong to one instance. Tables and assets are read-only.
- Sums run in compiled order, because float addition is not associative. A bus's inputs are gathered by one task. The format makes
  this structural: every mixer step overwrites its destination, so the only sums are inside one step.
- Output guards and counters are per instance, and the control phase collects them.

**Bus registers.** Allocating registers by last use saves serial RAM and can hide parallelism, since two tasks that reuse a register look
dependent. Renaming them at load was proposed here, and measured before it was built: on all 61 recipes the longest chain of tasks is the same
with and without it [measured]. The compiler places tracks before buses, so tracks get registers before any is freed, unless a sidechain from
a bus makes a track wait for it. Reuse falls on buses that could have run side by side, and no recipe has two with inserts. It isn't built, and waits for a Program it would help. A hostile image
can also give two Gathers one range of inputs, so a renaming has to be kept per step and not per input.

**Output does not depend on worker count.** A given build produces identical bits with any number of workers, and with
`SerialExecutor`. Across targets, the tolerance in section 16 still applies.

**Evidence** [measured], from a small model engine with the real seam, not the real interpreter:

- Built with GCC 16 for Cortex-M4 at `-O2`, `-O3` and `-Os`, the engine through the seam disassembles identically to a
  hand-written loop over a run-time task count. At `-Og` the size matches and the code differs. A serial object has no
  threading symbols, no undefined symbols, and no barrier or exclusive instructions, and `parallel.hpp` is not among its
  dependencies.
- Moving the dependency tables behind the executor removes them from the serial type.
- 16 tracks of 8 voices at frame 128, 20,000 frames: serial, shuffled, and pool at 1, 2, 4, 8 and 12 threads gave the same
  hash of the output bits. ThreadSanitizer reported nothing over 2,000 frames.
- With a Step deliberately writing a shared global scalar, the shuffled executor changed the output on one thread, and
  pool output varied with thread count, with ThreadSanitizer reporting the race. This is what the first rule above prevents.

First figures from the real engine [measured], on an M4 Pro with 8 performance cores, through the Python binding, which is the first user:

| Program | Frame | 2 workers | 4 workers | 8 workers |
|---|---|---|---|---|
| 8 tracks, each the `AdditiveBell` recipe | 32 | 1.80x | 1.91x | 2.42x |
| The same | 128 | 1.90x | 2.80x | 3.20x |
| 12 tracks from the demo, into 2 reverb buses | 32 | 1.40x | 1.12x | 1.03x |
| The same | 128 | 1.54x | 1.71x | 1.98x |

The pool costs about 1.3 µs a frame with 8 workers and 15 tasks that do nothing, and 0.3 µs with 2, so it pays only where tasks are long. The
12-track case shows that limit. Serially its frame at 32 takes 8.0 µs, of which the reverbs take 0.55 µs, so each track is about 0.6 µs, and
at that size more workers add more cost than they save. Worst frames and real-time use still wait for Milestone 7.

**Checks in CI.**

- `ShuffledExecutor` is a test double that runs a random valid task order on one thread each frame and compares the
  output. It needs no threads, so it runs on every target, including wasm and QEMU, and it catches a missing dependency
  deterministically. The fuzzer asserts this on every image the validator accepts.
- A ThreadSanitizer job runs `PoolExecutor` on native.
- A firmware check fails if the linked ELF has threading symbols. It must be explicit: a bare-metal toolchain with a full
  C++ library would compile `parallel.hpp` without complaint. Homebrew's fails only because it has no `<atomic>`.

**Limits of this scope.**

- The browser stays serial. Wasm threads need SharedArrayBuffer and cross-origin isolation, which section 12 rejects, so
  GUI playback does not gain from this work.
- The first user is offline render through Python, in Milestone 6. It has no deadline, so throughput is the only goal. The
  binding releases the GIL during render, and workers never touch Python objects. Separate songs on separate Python threads scale further
  than workers in one engine, because a song splits only as far as its tracks do: `AdditiveBell` looped on 2, 4 and 8 threads gave 1.92, 3.79
  and 7.35 times the throughput of one [measured, same machine].
- Real-time use is not covered. No milestone builds a native audio host, and it needs worker priority (on macOS, joining the
  audio workgroup) and worst-frame measurement. A worker preempted mid-task stalls the calling thread until it resumes, so
  nothing is promised until that is measured.
- The unit of work is a track, so one very heavy track does not speed up. The scalar rules keep voice-level splitting
  possible later.
- During a generation crossfade, the two generations run one after the other.

## 19. Web application and persistence

The GUI is a SvelteKit app with Drizzle over SQLite. This replaces the project file in earlier revisions, and it adds a
server to a design that had none. The engine and the image do not change: a server is one more place the compiler runs,
and hardware still only ever sees image bytes.

**Who does what.**

- Server actions own persistence: create, save, rename and delete patches, timelines and assets, and validate every document on the way in. Pages load through `load` functions.
- Audio never touches the server. Playback, the worklet and the oscilloscope are browser-only, as sections 12 and 13 say.
- The compiler is one wasm module with two hosts. In a browser worker it compiles the open document on each edit, including
  edits not yet saved, so preview needs no round trip. In a server action it compiles exports from saved rows. Both give
  the same bytes, because the input is the same JSON and the compiler is the same build.
- `better-sqlite3` is synchronous, so one action runs in one transaction, and an export reads all its rows from a single
  snapshot.

**Tables.**

    patches(id, name, graph JSON, revision, created_at, updated_at)
    timelines(id, name, doc JSON, revision, created_at, updated_at)
    timeline_patches(timeline_id, patch_id)      -- ON DELETE RESTRICT on patch_id
    patch_subpatches(patch_id, subpatch_id)      -- ON DELETE RESTRICT on subpatch_id
    assets(id, name, encoding, channels, rate, frames, root_key, loop_start, loop_end, bytes BLOB)
    patch_assets(patch_id, asset_id)             -- ON DELETE RESTRICT on asset_id
    bundles(id, name, revision, created_at, updated_at)
    bundle_timelines(bundle_id, timeline_id, position)

- Graphs and timeline documents are JSON columns, validated by one shared schema on save. Notes are never queried
  individually, so normalising them would add joins and no capability.
- `timeline_patches` is derived from the document on every save, inside the same transaction. It exists so that the
  database can refuse to delete a patch that is in use, and so that the patch editor can say which timelines an edit
  affects. It is never the source of truth for compilation: section 20 walks the document.
- `patch_subpatches` is derived the same way, from a graph on every save. It stops a patch being deleted while another expands it, tells the patch editor about timelines
  that reach it through another patch, and tells an export what to carry along. A graph can name itself, which only the compiler refuses, so walking these links
  keeps track of what it has seen.
- `revision` is optimistic concurrency. A save names the revision it started from, and a stale save is refused rather
  than overwriting another tab.
- A timeline refers to a patch by `id` and follows its latest graph. Editing a shared patch therefore changes every
  timeline using it, which is what "global" means here, and the editor shows the affected timelines. Pinning a timeline
  to an older revision is deferred, and adding it needs only a revision history table.
- Migrations are generated by `drizzle-kit`, committed, and applied at server start.
- There is no authentication in this revision. The app is a local tool, and `pnpm start` binds to 127.0.0.1 on port 5321.
  `adapter-node` assumes HTTPS unless a proxy says otherwise, so a loopback server would fail SvelteKit's same-origin check
  on every form. The config trusts exactly the two loopback origins on that port, and a form posted from any other site is
  still refused. Serving it anywhere else needs authentication and a proxy that sets `PROTOCOL_HEADER`.

**The editor.** The GUI is one page laid out like a DAW: a transport along the top, the patch editor above, the timeline
below, both resizable, and a browser down the side, which folds away, for the library and the examples. Its address says
what is open: `?timeline=` or `?recipe=` below, and `?patch=` above, which otherwise shows the chosen track's patch, so
choosing a track shows its patch. Only the lower panel's parameters reach the server: a load reruns for the parameters it
reads, so choosing a patch costs no round trip, and the library, which carries every sample, loads only when an action
changes it. A fresh visit opens the timeline saved last, and the old addresses redirect to the same views.

- Edits to any number of patches and timelines are kept as drafts while other things are opened, and Save writes them all
  in one transaction, patches first, so a timeline is never saved against a patch edit that was refused. Each draft names
  the revision it started from, so a stale one refuses the whole save and loses nothing. A draft edited back to what was
  saved stops being one, and leaving with drafts asks first.
- One engine plays one image: the song, compiled from the drafts, or the patch on screen on its own. A patch a track plays
  is heard in the song, through that track's mix and inserts, so a patch edit is heard in context as it is made. A voice no
  track plays is compiled on its own as above, and its keys switch the engine to it. Play, a locate, or a note from the
  timeline switches back, to where the song was. The two compile on separate channels, so neither cancels the other, and a
  request that hasn't changed isn't compiled again, so opening something new swaps nothing. An insert has no keys and is
  compiled on its own only for its errors and dead nodes.
- The status bar says Compiling from an edit until the image made from it is playing, so what is heard is known to be the
  newest edit. An image the engine fails while loading ends that too, with the engine's reason, as one too large for the
  image slot does, and the image before it plays on.
- Keys belong to the panel used last, so Delete and undo act on the graph or the timeline, not both.

**The graph editor.** A graph's document is still what is saved and compiled. The editor adds `x` and `y` to its nodes, which the compiler ignores, so moving a node
changes no hash. It takes its node table from the compiler's catalog, the table the compiler reads, so the two can't disagree. The compiler's report carries the debug sidecar
from section 13, which colours wires by rate, dims nodes that compiled away and places probes. An error's `where` names its node, and an error inside a subpatch lands on
the subpatch. The compiler stops at the first error, so an editor shows one at a time. The JSON stays on the page, and text that doesn't parse leaves the last drawing alone.

**The timeline editor.** Arrangement, piano roll, lanes and mixer are views of one document, which stays on the page as JSON. Every edit is a pure function from a document to a document, so undo is a list of
old ones, and as in the graph editor these decide little about what is legal: overlapping clips can be drawn, and the compiler says what is wrong and marks the track. What an edit does take care of is references, so
deleting a bus takes its sends, outputs, sidechains and lanes with it. Placements stay in tick order, because the compiler takes one that goes backwards for an overlap. The grid is 4/4, and nothing stores that:
a document holds ticks, so a time signature would change how it is drawn and not how it plays.

A fader moves the mix registers as it is dragged and compiles when it is let go, so the sound follows the hand and the document takes only the value settled on. A register holds fader, mute, pan, send and, on
the way into master, the master fader multiplied together, and the page works that product out the way the compiler does. Parameters and insert parameters move the same way. A compile error's `where` marks its track and clip.

Preview compiles what an export compiles, with no `live`, so a track with no notes isn't in the image and its keys are silent until it has one. `live` keeps unused tracks, so it could pass a document
that an export refuses, and an editor that previews one thing and exports another is worse than a silent key. The page says so when it happens.

**Asset import.** WAV files become one instrument: an asset for each file and a patch with a `sample` node in zones mode, whose inspector edits zones, roots and ranges. 16-bit and narrower stay i16, and anything wider stays exact in f32.
A file's sampler chunk gives its root and loop, and failing that a name like `Piano_C4.wav` gives the root, and failing that it is 60. Keys split halfway between recordings, and several at one key become velocity layers, quietest first by peak, because
only their levels say which is which. A bad file refuses the whole import, and one larger than an image can hold is refused there rather than failing on load. An asset can't be deleted while a patch names it.

**Recipes.** `examples/Recipes` ships with the app as the read-only examples in the editor's browser, where any of them plays as it is and shows how it is made, in the same editors with nothing that changes anything: its arrangement, notes, lanes, mix and each patch's graph, which
a probe can look inside. Adding one copies its patches, assets and timeline into the library under ids made from its name, and they are then ordinary rows. They are copies so that an edit can't change what ships. A recipe isn't seeded,
because together they hold about 600 KB of samples and the editor loads the library. Adding one twice changes nothing, so an edited copy survives. A test holds every
recipe to compiling to the same bytes from the library as from its file, which is what shows the schema dropped nothing.

**Pieces.** `examples/Pieces` holds four public-domain pieces arranged for the engine, two to three minutes each, and the browser lists them
first among the examples. In every other way they are recipes. `MakePieces.py` writes them from the Mutopia Project's public-domain
editions: the notes are the score's, and the instruments, rubato, dynamics, pedalling and mix are a performance written in code. They sit
outside `examples/Recipes` because the benchmarks render every recipe in full, three times over on QEMU, and the pieces are 9 minutes of
music against 3.8 for all 61 recipes. Writing them tested what a timeline can say, and what it couldn't is in section 24, opens 26 to 31.

## 20. Choosing what goes into an image

The library is global and an image is not. Compiling starts from Programs and walks outward, so patches enter an image
only by being reached.

**The walk.** For each timeline:

1. Clips placed on a track contribute their notes. A clip that is defined but not placed contributes nothing.
2. A patch slot is used if a placed note plays it. Unused slots are dropped, and the rest are renumbered.
3. Mixer inserts are used if they reach the master bus, using the same dead-node removal as the graph compiler.
4. Each used patch adds the tables and assets it references.

Muted tracks stay in, because mute is a mixer parameter that can change during playback. A browser preview passes `live`,
which keeps every slot and track, so an empty track can still be played from the keyboard. A patch heard on its own is compiled with it, as one track
with no notes, and the editor starts the transport for it, because a shared LFO waits for it. Exports never set it.

Unused library patches cannot affect an image: changing them leaves its bytes identical, and CI asserts this.

**A Patch's bytes depend only on its graph**, and on the graphs of its subpatches. Voice count, track number, initial values and the target stay out of the Patch
chunk. This is what makes sharing work: two Programs using one library patch reach one hash, and two library patches with
the same compiled bytes merge into one chunk. A patch chunk that embedded anything from a timeline would quietly defeat
both.

**Three shapes of compile, one function.**

    compile_image({ programs: [a, b, c], omit: [hash, ...] })

- *Single.* One timeline. The image holds its reachable set.
- *Bundle.* Several timelines. The patch set is the union of what each reaches, and each chunk appears once. A bundle row
  in the database lists its timelines, and a bundle snapshot compiles all of them from one transaction, so a patch cannot
  change partway through.
- *Thin.* `omit` lists chunks the receiver already has. They stay in the manifest and their bytes are left out, which is
  requirement 10's "programs can be sent without re-sending patches". If the receiver lacks a chunk, the manifest check
  fails and the old set keeps playing. If a shared patch has been edited since, its hash differs, so the same check fails
  rather than playing a wrong sound.

Assets, tables and patches are sorted by kind and then hash, so the same set in any order gives identical bytes. Programs
keep request order, because their position is how a bank selects one. [measured: the native and wasm compilers gave a
byte-identical image for the demo project, whose library has 5 patches and whose image holds 4.]

**One Program is bound at a time.** A bundle shares image bytes, not RAM. `bind(image, program)` decodes only the patches
that Program uses, so a bank of songs on flash costs RAM for one. It follows that fit is two numbers: flash is the sum of
unique chunks, and RAM is the largest single Program. On hardware, changing Program stops audio and rebinds, as a swap does
in section 11.

**Automation against a shared patch.** If a patch drops a parameter that a timeline automates, compiling that timeline
fails and names the track and the parameter, rather than dropping the automation.

## 21. Deferred

Real-time parallel playback on a native host, voice-level parallelism, Highway, deadline shedding, two-way device sync,
disk streaming, compressed assets, live editing on embedded, patch revision pinning, authentication, a tick-to-offset seek
index, persisting knob moves made during playback, and validating a Patch or Program in slices. Each waits for a real need or a measured budget failure.

## 22. Milestones

Each milestone lands as one squashed pull request into `main`. Work reaches a branch as it goes, and only those pull
requests run CI, so checks run locally before a push. One that changes only Markdown skips CI, unless it changes `docs/Format.md`, which
`tools/ReadImage.py` reads.

1. **Vertical slice, format explicitly unstable.** A stereo voice with filter envelope and knob, one sampled voice, a send
   reverb with one sidechain, a two-track Program with seek, one edit during playback, and an oscilloscope on the master
   and track buses. It runs in an AudioWorklet, and on QEMU's L475 in CI with scalar and CMSIS-DSP backends, checked by
   golden audio within tolerance. Includes the sliced load, staging, decoded steps, sample offsets, and `fast` and `bulk`
   memory. The image is linked into the firmware. It also includes the `Executor` parameter with `SerialExecutor`, the
   two-phase frame, `ShuffledExecutor` tests, the firmware check for threading symbols, the SvelteKit app with its SQLite
   schema and server actions, and the patch selection, bundles and thin images from section 20.
2. **Format freeze.** Written spec, golden images, append-only opcodes, coverage-guided fuzzing on wasm32 and 32-bit ARM,
   and validator enforcement of the rules in section 18. Hash choice is settled here: FNV-1a 64, for the reasons in `docs/Format.md`.
3. **Browser graph editor and full compiler.** Subpatches, rate conversion, which `snap` settled, errors shown on nodes, oscilloscope probes on
   graph nodes, and the ops section 5 lists.
4. **DAW views.** Timeline, piano roll, mixer with per-track scopes, full Program compiler, asset import. Asset import writes only `Sample2`
   zones, so a saved instrument has one shape and never needs migrating. Recipes are shown in these views, read only.
5. **Device delivery.** Board bring-up with real audio output, target profile generation, receiving a whole image over BLE or serial into flash,
   storage per open 22, host send tool. The board is a NUCLEO-L476RG, and serial comes first.
6. **Python engine binding and offline render.** `PoolExecutor`, `MODSYNTH_PARALLEL`, and a ThreadSanitizer CI job. The module compiles a request
   and plays any image, at every frame size from 8 to 1024, mono or stereo, either frame by frame with live events or to the end of its Program
   and its tail. `PythonTest.py` holds it to the golden renders and to the same bits on any number of workers, and `Listen.py` now uses it.
7. **Measurement and optimization.** Board calibration of the cost model, voice counts, op cost table and limits,
   instruction-count CI gate, size budget, kernel tuning from section 15, browser load and heap costs, audio-thread
   allocation from the scope, and parallel speedup. Accelerate and Highway follow only if a measured budget fails.

Until Milestone 7 sets real limits, there is no op cost limit, so a hostile image can still overrun a frame, and a load can still take
longer than a frame: the format's limits bound that cost but do not make it small, and Patch and Program validation run whole rather than
in slices. Lazy delay clearing is not deferred.

## 23. Fuzzing

Fuzzing runs on what a device actually is. An image that wraps a bounds check on 32 bits is fine on 64, and only an M-profile FPU faults on
an unaligned `VLDR`, so a desktop run cannot stand in for the rest. libFuzzer runs on neither wasm nor bare metal, so `fuzz/` is a small
coverage-guided engine of its own, one source on every target.

| Target | Word size | Detection | Coverage |
|---|---|---|---|
| Desktop | 64 | ASan, UBSan, float-cast-overflow | `trace-pc-guard` |
| wasm32 under Node | 32 | ASan, UBSan, float-cast-overflow | `trace-pc-guard` |
| Cortex-M4 on QEMU's `mps2-an386` | 32 | MPU guards, canaries, CPU faults | `trace-pc` |

The L475 model's 128 KB cannot hold two generations and a mutated image, so this one target uses a machine with the same core and more
memory. The L475 remains what golden audio runs on.

**Mutation is structure-aware.** Flipping bytes teaches a fuzzer about hashes and nothing else. The mutator holds a list of chunks, changes
what is in them, repairs the totals the validator recomputes, and seals the result: new hashes, references that follow them, and the sorted
order a manifest demands. A small share of inputs is damaged on purpose, to cover the shallow checks.

**An input is a recipe,** a seed image and a chain of mutation seeds, 12 bytes in the corpus. So a corpus fits on a device, and a finding on
Cortex-M replays on a desktop under sanitizers with the same bytes. The mutator uses no floats, which is what makes that exact.

**Oracles catch what a crash would not.** Each accepted image plays on an engine given exactly what `bytes_required()` asked for, so a short
sum is caught where it is used, then:

- A second time with memory filled differently. The output must be identical, or something read old memory.
- With `ShuffledExecutor`. The output must be identical, or section 18 has a hole.
- With less memory than it asked for, which must be refused.
- On a mono engine, which folds through different code.

Half of them first play an intact image and then swap to the mutated one, because state carried across a swap is its own trust boundary. Output
must always be finite, a refused image must leave nothing behind, and events carry wild values throughout.

A Program plays to its end, at a low sample rate so that this takes few frames, or to a limit of 256 frames.

**The fuzzer is tested too.** A run that finds nothing says nothing unless it could have found something, so bugs were planted in scratch copies,
one per oracle. All of them were found:

| Planted bug | Caught by | How soon |
|---|---|---|
| Sample position not guarded across a swap | ASan, reading poisoned memory | about 20 s |
| Voice state not cleared | "output depends on old memory" | under 10 s |
| Memory sum one line short | ASan, reading poisoned memory | under 10 s |
| A read of an unwritten buffer allowed | "output depends on old memory" | under 10 s |
| A track run by two mixer steps | "output depends on task order" | about 10 s |
| A Step allowed to write a shared global | "output depends on task order" | under 10 s |
| A `size_t` wrap in `Bump` | wasm32 and Cortex-M4 | not on desktop, where it cannot wrap |

Some survived the first runs, for 150 s and more, and the misses became changes: the `AllOps` seed, a shared global on an independent track, a step mutator
aimed at forbidden banks, a size mutator, and an independent recomputation of delay memory. The 32-bit bug is why the matrix has more than one word
size. A recipe found on Cortex-M4, `0:3219687050,256226439`, failed the same way when replayed on wasm32.

CI runs each target for a short time on a new seed. That is a smoke test, and the soak figures in the pull request are what a long run found.

## 24. Agreed work and open decisions

Opens keep the numbers they had in review. Opens 1 to 8 are closed: 1 to 4 in section 5, 5 and 6 in section 6, 7 in section 7 and 8 in section 9. Opens
17 and 18 went with the target rule, so there is no per-tier golden contract and no patch form chosen by target.

**Agreed, not built.**

- Events off the frame boundary, section 6.
- Whole-image delivery to a device, section 10.

**Still undecided.** A recommendation here is only that.

| # | Question | Position so far |
|---|---|---|
| 9 | What stops a finite blow-up reaching speakers? | A direction, not final: a volume limiter on desktop, and on embedded a render that validates the image when it is built on a desktop. To keep the target rule, the limiter would sit in the host after the engine, the validation ceiling at or below its threshold, and the NaN guards stay on every target. |
| 10 | Should graphs get feedback shorter than a frame? | Recommended no. Keep it inside ops such as `OscMod`. Frame 32 already raises the limit to 1500 Hz. |
| 11 | How far do events go off the frame boundary? | Recommended: live notes on their sample, and new ops that start on it. Changing a parameter within a frame would mean splitting frames, and frame 32 may make that unnecessary. |
| 12 | MPE, polyphonic aftertouch and per-note bend? | Nothing prevents them. A voice would remember its NoteOn's channel, and events would address that. Held voices would need per-voice smoothing. Recommended: leave out unless MPE is a goal. The pieces found a need short of MPE: a brass or string note can't swell once it starts, so the chorale shapes its phrases by velocity, and the Grieg's crescendo moves each section's fader in ramps of four to eight bars. |
| 13 | Microtuning? | Recommended later. It needs a key-map Table and a new op. Without it the harpsichord in `BachPreludeInC` plays Bach in equal temperament. |
| 14 | Envelope curves and looping envelopes? | Recommended later, as an `Env2` with a Table, because curves don't fit in 4 inputs. |
| 15 | A live arpeggiator? | Recommended: leave it to the host, so the engine holds no keys. |
| 16 | Clap, wavetable scanning, granular and shared LFO shapes? | Recommended: keep the workarounds until a real patch needs more. |
| 19 | When does the compiler check a target profile, and what is unavailable on embedded? | Nothing is unavailable today. Recommended: add the check in Milestone 5, and keep planned ops on embedded unless a measured budget fails. |
| 20 | Are mono builds an exception to the target rule? | Recommended yes, as section 10 has it, with channel count as an output format. Folding was chosen before the rule existed and hasn't been confirmed since. |
| 21 | Does sample rate need the same treatment as frame size? | Recommended no: leave it at run time and document it. Frequencies stay correct, and only frame-timed behaviour shifts, such as control rate and the shortest feedback loop. |
| 22 | How does a device store what it receives? | Recommended: two flash slots. Write the inactive one, verify and load it, then switch. That halves the roughly 900 KB spare on an L476, which still holds the largest recipe at 263 KB. The log-structured chunk store proposed earlier, with a commit record written last, is only needed for thin images, and 56 of the 61 recipes are 10.4 KB or less. |
| 23 | What authenticates an image over BLE? | A hash doesn't, and anyone in range can connect. Validation protects memory, but a valid image can still be very loud or overload the CPU. Recommended: BLE bonding, or signed images. |
| 24 | Is a set of embedded-friendly recipes wanted? | Floated, not decided. 8 of the 61 recipes don't fit an L476 today, per `docs/Benchmarks.md`. `Tone` alone doesn't rescue them, so a set would also need fewer voices or partials. |
| 25 | Does CMSIS-DSP save enough on this chip? | Section 15 models 10.8% for one voice. Measured over whole recipes the median saving at peak is under 1% of instructions. It stays a supported backend, and the answer needs cycles on a board. |
| 26 | Time signatures and pickups? | The editor draws every timeline in 4/4 from tick 0. Für Elise, in 3/8 after an eighth's pickup, is in its third bar where the ruler shows bar 2, and the chorale's pickup puts every bar line a beat early. Recommended: a meter map and a pickup in the timeline document, which the editor draws, snaps and numbers bars by and the compiler ignores, as it ignores where a node is drawn. No format change. |
| 27 | A sustain pedal? | A timeline has none, so `MakePieces.py` writes Für Elise's pedalling into how long its notes are. The piano roll then shows the pedal's notes rather than the player's, and moving a pedal change means rewriting durations. Recommended: a pedal lane per track that the compiler applies to note lengths, as it writes a tempo ramp as steps, so the format and engine stay as they are. A key played live under the pedal would still need the engine to hold its voice. |
| 28 | Importing MIDI files? | Every piece began as a MIDI file or LilyPond source, and the app imports only WAV. A Standard MIDI File reader is 45 lines of `MakePieces.py`. Recommended: import a file as a new timeline, a track for each of its tracks, with its tempo map, and its pedal once open 27 gives it somewhere to go. |
| 29 | Should a comb's delay be fractional? | A comb rounds its delay down to a whole sample, so a Karplus-Strong string is out of tune by up to half a sample of its period, by a different amount at each run rate [measured: the PluckedString recipe at A5 is 10.7 cents flat at 44.1 kHz and 3.8 cents sharp at 48 kHz, and within 2 cents at A3]. That breaks open 21's premise that frequencies stay correct at any rate. The pieces pluck with oscillators instead. Recommended: an interpolated read, as a new op, since `Comb` has no modes to add one to. |
| 30 | Can a ramp end on one tempo and the next change start another? | No. A ramp ends on the next change's tempo, so slowing into a fermata that holds slower still means ramping toward the fermata's own tempo, as the chorale's eight fermatas do. Recommended: an optional end tempo on a ramped change, compiled as steps like any ramp. |
| 31 | Should the benchmarks cover the pieces? | They aren't measured on Cortex-M4, so whether they fit an L476 is unknown. On a host they render 41 to 168 times faster than real time, from images of 10.6 to 93.3 KB [measured: Apple M4 Pro, Python binding]. Recommended: measure a window of each, such as its loudest 20 seconds, rather than all of it. |
