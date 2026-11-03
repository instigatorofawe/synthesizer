# The NUCLEO-L476RG

`firmware/Nucleo.cpp` runs the engine on a NUCLEO-L476RG: an STM32L476 at 80 MHz, with 1 MB of flash and 128 KB of RAM. It receives images
over the ST-LINK's USB serial port, stores them in flash, and plays the newest through the 12-bit DAC. `tools/Board.py` is the host side.
Section 10 of the design says why delivery is one-way and how storage was chosen.

## Audio out

The board is for checking the firmware and measuring it, so nothing has to be connected to it. `loopback` checks the audio output by reading
it back with the ADC.

The audio is mono, on **PA4**, which is pin **A2** of the Arduino header (CN8). It swings from 0 to 3.3 V around 1.65 V, DC-coupled and
hotter than line level. To listen anyway:
- Into a line input or a powered speaker, put a capacitor of 10 µF or more in series.
- Don't drive headphones from it. The DAC's buffer is specified into 5 kΩ or more.

The board plays its stored image when it starts. The blue button plays it again from the start, and the green LED is on while audio runs.

## Building and flashing

The firmware builds with the same toolchain as the QEMU firmware: `arm-none-eabi-gcc` with newlib, in a Debian container on a Mac.

    cmake -S firmware -B build/board -G Ninja --toolchain "$PWD/firmware/ArmNoneEabi.cmake" -DCMAKE_BUILD_TYPE=Release
    cmake --build build/board --target Nucleo NucleoCmsis
    probe-rs download --chip STM32L476RGTx --connect-under-reset build/board/Nucleo.elf
    probe-rs reset --chip STM32L476RGTx

`Nucleo` uses the scalar backend and `NucleoCmsis` uses CMSIS-DSP. Run one probe tool at a time: two at once wedged the ST-LINK, and only a USB
reset brought it back.

`-DMODSYNTH_COST_LIMIT=OFF` builds firmware that refuses no Program for what its frames cost, for measuring the cost table below. Its `info`
says `budget=0`, and `tools/Board.py` then compiles requests without the cost table, so a Program over budget reaches the board and plays late.
`firmware/Check.sh` fails either build over 112 KB of flash: the scalar one takes 94.8 KB and the CMSIS one 96.7 KB.

## Talking to it

`tools/Board.py` finds the port by itself, and `uv run` installs pyserial for it. A request is compiled against the board's profile first,
which needs the Python module: add `--with dist/modsynth-*.whl` after `uv build`.

| Command | What it does |
|---|---|
| `info` | The build, the room it has, its budget a frame, and the image it stores with what it could cost a frame |
| `send IMAGE [--play]` | Sends an image, or compiles a request and sends that |
| `play`, `stop` | Plays from the start, or stops the transport |
| `stats` | Cycles per frame while playing, what playing a frame out took besides, underruns, and the most voices that sounded at once |
| `render [--frames N] [--out FILE]` | Renders the stored image away from the DAC, at 48 kHz unless `--rate` says otherwise, and times every frame |
| `check` | Sends each golden image, renders it, and compares the audio with its mono golden render |
| `test` | Damages and cuts transfers on purpose, and checks that the board keeps the image it had |
| `loopback` | Reads PA4 back with the ADC while something plays, and fits it to what the DAC was given |
| `time PATH... [--bench]` | Sends each image or request in turn and reports its cycles per frame, with `--bench` for as many frames as `tools/Bench.py` gives it |

## Storage

Bank 1 holds the firmware in its first 128 KB and slot A in the rest. Bank 2 holds slot B. Each slot is 384 KB, and its first 2 KB page
is a header, so an image can be up to 382 KB. The largest recipe is 263 KB.

A transfer always writes the slot that isn't playing. It erases that slot's header first, so from then on the slot doesn't count. When the
last byte is in, the board loads the image from flash exactly as it will play it. Only if that succeeds does it write the header, and the
header's last double-word, written last of all, is what makes the slot count. At start the board loads the committed slot with the higher
sequence number, and falls back to the other one if that fails.

So a transfer cut short, a damaged image, or one that doesn't fit leaves the image that was playing in place. A double-word that loses power
while being written can read back with two ECC errors, which raises an NMI. The handler notes it, and the slot reads as uncommitted.

Audio stops while a transfer writes flash, because flash writes stall reads from their bank.

## Protocol

Serial runs at 921,600 baud, 8N1. Every frame is COBS-encoded and ends with a zero byte. Decoded, a frame is a type byte, a payload, and a
CRC-32 (as zlib computes it) of the type and payload, little-endian. Numbers in payloads are little-endian.

The host sends one command and waits for its reply, so nothing is in flight while the board writes flash.

| Type | Payload | Reply |
|---|---|---|
| `I` | none | `i` |
| `B` | u32 image size, a non-zero multiple of 8 | `k` with the u32 capacity, or `e` |
| `D` | u32 offset, then up to 1024 bytes, a multiple of 8 | `k` with the u32 offset the board expects next, or `e` |
| `E` | none | `k`, or `e` with why the image was refused |
| `P`, `S` | none | `k` |
| `T` | none | `i` |
| `R` | u32 frames, f32 rate, u8 1 to send the audio | an `a` per frame if asked for, then `i` |
| `C` | none | two `c` frames for the ADC and two for the DAC, then `k` |
| `Z` | none | `k`, then the board resets |

The board replies with these types:

- **`k` and `i`:** `k` means done. `i` is space-separated `key=value` text.
- **`e`:** an error, as text.
- **`l`:** a log line, which the board sends unprompted when it starts.
- **`a`:** a frame of audio, as a u32 frame index and then 32 f32 samples.
- **`c`:** a u8 saying which capture it is (0 for the ADC, 1 for the DAC), a u16 offset, and 512 u16 samples.

**Lost and refused frames.**
- **A `D` frame out of order:** the board writes nothing and replies with the offset it expects. A frame whose reply was lost is sent again
  the same way.
- **The manifest:** it comes first, so the board checks it once those bytes arrive. An image for another frame size or a newer revision is
  refused on its first frame.
- **Any command but `D` or `E` during a transfer** abandons the transfer.

## Profile

The firmware's build writes its target profile, as JSON in a section of the ELF that never reaches the board, and
`firmware/Profiles/Nucleo.json` is a copy. `firmware/Check.sh` fails if the two differ. A request with the profile as `"target"` compiles
only if the board would play it:
- Its revision and opcodes are ones the board has.
- Its frame size is the board's.
- Its image and chunk count fit what the board stores.
- Each Program fits in the board's memory, laid out with the board's own struct sizes.
- No Program plays a sample past full scale on the board, which has no limiter. The compiler plays each one as the board would, mono at
  its rate, to find out.

The report's `target` says how much of each it uses.

| Field | What it is |
|---|---|
| `name`, `backend` | The target, and the kernels it was built with |
| `revision` | The newest format revision it reads |
| `frame_size`, `channels`, `rate` | What its engine renders, and the rate the DAC really runs at |
| `memory` | Fast and bulk bytes for one generation |
| `image_bytes`, `chunks` | The largest image a slot stores, and the chunks its table holds |
| `opcodes` | The opcodes it runs |
| `layout` | The sizes and alignments its engine lays memory out with, and each opcode's state size |
| `cost` | What each kind of work costs a frame in its cycles, and its budget, below |

The rate is 80 MHz over 1,667 timer ticks, which is 47,990.4 Hz. 48 kHz isn't a whole number of ticks. Telling the engine the true rate keeps
pitch right, and only frame-timed behaviour moves, by 0.02%. The clock is MSI locked to the board's 32.768 kHz crystal.

## The cost limit

A request compiled for the board fails if a Program's dearest frame could take more than its budget, and the board's loader refuses the same
images, so whatever it plays fits every frame. The dearest frame counts every voice of every track sounding. Section 15 of the design says
what else it counts and how it was checked. The budget is 51,944 cycles: the 53,344 of a frame at 47,990.4 Hz, less 1,400 for playing the frame
out, the most `stats` measured with a heavy load. `info` gives the stored image's `need_cycles`.

`firmware/NucleoCosts.hpp` holds both builds' tables, which `tools/Bench.py costs` writes from two sources:
- `bench/M4.json`, every calibration Program's instructions on QEMU, which CI holds the code to.
- `firmware/Profiles/Calibration.json`, what each kind of work took a cycle on this board.

A change in the code reprices itself from QEMU. To measure the board's ratios again, after changing what a kernel does to memory or flash:

    tools/Bench.py m4                              # in the firmware container, then copy build/bench back
    tools/Bench.py baseline
    cmake -S firmware -B build/board-uncapped ... -DMODSYNTH_COST_LIMIT=OFF   # flash its Nucleo.elf, then
    uv run --no-project --with dist/modsynth-*.whl --with pyserial tools/Board.py time --bench build/bench/Calibration --json scalar.json
    # the same with NucleoCmsis.elf into cmsis.json
    tools/Bench.py calibrate scalar.json cmsis.json --output 1400 --date YYYY-MM-DD
    tools/Bench.py costs

Then build both firmwares as usual, copy their profiles into `firmware/Profiles`, and time the recipes with the limit on: none may exceed its
budget.

## Measured on the board

All of this was measured on one board, on 2026-11-02. Milestone 7 measured the cost table and the cycles below, after its tuning, and Milestone
5 the rest.

**Golden audio.** `check` renders every frame-32 golden image on the board:
- **Scalar build:** every sample's bits match the mono golden renders.
- **CMSIS-DSP build:**
  - `Waves32`, `Tones32`, `Lanes`, `Zones` and `Steals` match exactly.
  - The rest differ at most by −109.0 dB (`AllOps32`), −120.9 dB (`Hold`), −128.8 dB (`Demo32`) and −138.2 dB (`Mods`), within the
    −100 dB tolerance.

**The DAC.** With a pad playing, `loopback` read PA4 back as what the DAC was given:
- Correlation 1.00000, gain 1.002, and 0.7 LSB rms left over, one sample late.
- At silence the pin reads 2047 ± 2, against 2048 sent.

**Delivery.** `test` passes:
- An image for frame 128 is refused on its first frame.
- An image with one flipped bit is refused at the end, with a hash mismatch.
- After a reset halfway through a transfer, the board boots the image it had.
- The next image commits to the other slot.

A 21 KB image takes 0.8 s to send.

**Cycles.** These are cycles per 32-sample frame at 48 kHz, with images in flash, 4 wait states, and the ART caches on. Each recipe was
rendered to its end and its tail, with the limit on. The budget is 51,944 cycles a frame.

| Recipes | How they fit |
|---|---|
| 48 | Compile, and every frame within budget on both builds. The dearest are Chorus (worst frame 70%), StereoUnison (64%), PluckedString (63%), WavetableMorph and Phaser (59%). The median takes 22% of the core on average. |
| AdditiveBell, DetunedSupersaw, DrawbarOrgan, DrumLoop, PhaseModElectricPiano, Vocoder | Refused. They ran over budget in Milestone 5, at 113% to 208% in their worst frame. |
| FrenchHorn, LoopedSample, PrecutGrainCloud, SidechainDucking, Trumpet | Refused. They ran within budget in Milestone 5, at 25% to 75%, but could exceed it with every voice sounding. |
| Reverb, PingPongDelay | Refused. They need 188 KB and 231 KB of bulk memory, and the board has 64 KB. |

The 48 cost 5.8% fewer cycles than in Milestone 5 at the median, and up to 13% fewer. Their bounds were 1.20 to 2.39 times their worst frames.
`docs/Benchmarks.md` says how many voices each track of every recipe could have.

- **One voice:** a naive saw's voice takes 1,276 cycles a frame on average, 40 a sample, mixer included, against 1,717 before this milestone's tuning. The
  bound allows 27 of them.
- **The demo:** refused, at 173% of a frame. It ran at 106% on average and 128% in its worst frame in Milestone 5.
- **The four pieces:** refused. Each sends to a stereo reverb that needs 188 KB of bulk memory, more than the chip's 128 KB of RAM.
  - **Without the reverb** they load, but they're too slow. In Milestone 5, over their first 30 s, the share of the core each took on average
    was:
    - BachPreludeInC: 164%, with 8 voices at most.
    - HallOfTheMountainKing: 191%, with 14.
    - PassionChorale: 195%, with 10.
    - FurElise: 469%, with 20.
  - **So a reverb that fits wouldn't be enough.** Their bounds without it are 4 to 20 times the budget.

**Playing out.** Converting a frame for the DAC and the interrupts during it took 904 cycles a frame with a light Program and 1,338 with a
heavy one, which is why 1,400 are held back.

**Live playback.** The DMA plays one half of its buffer while the main loop fills the other. A half is 16 frames, 10.7 ms. Over 6 s of each, in
Milestone 5:
- LoopedSample and Vocoder never ran late.
- DrumLoop ran late 4 times and DetunedSupersaw 14 times. Those are stretches of 16 frames that cost more than 16 frame periods.

**CMSIS-DSP.** Over the first 4 s of the same 60 programs, the median change in mean cycles was 0.0%. Some ran 9.9% slower (Vocoder) and some 8.4% faster
(PhaseModElectricPiano).

The full tables come from `uv run --no-project --with dist/modsynth-*.whl --with pyserial tools/Board.py time examples/Recipes --json FILE`.

**Calibration.** On the scalar build, steps took 1.36 (Shape) to 2.11 (Math) cycles an instruction, a frame's own work 2.54, and a note start
4.64. On the CMSIS build, steps took 1.33 (MulS) to 2.23 (Biquad). `docs/Benchmarks.md` has every term's price.
