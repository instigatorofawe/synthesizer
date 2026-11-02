# The NUCLEO-L476RG

`firmware/Nucleo.cpp` runs the engine on a NUCLEO-L476RG: an STM32L476 at 80 MHz, with 1 MB of flash and 128 KB of RAM. It receives images
over the ST-LINK's USB serial port, stores them in flash, and plays the newest through the 12-bit DAC. `tools/Board.py` is the host side.
Section 10 of the design says why delivery is one-way and how storage was chosen.

## Listening

The audio is mono, on **PA4**, which is pin **A2** of the Arduino header (CN8), with ground on any GND pin. It swings from 0 to 3.3 V
around 1.65 V, so it is DC-coupled and hotter than line level.

- Into a line input or a powered speaker, put a capacitor of 10 µF or more in series, and turn the volume down before the first note.
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

## Talking to it

`tools/Board.py` finds the port by itself, and `uv run` installs pyserial for it. A request is compiled against the board's profile first,
which needs the Python module: add `--with dist/modsynth-*.whl` after `uv build`.

| Command | What it does |
|---|---|
| `info` | The build, the room it has, and the image it stores |
| `send IMAGE [--play]` | Sends an image, or compiles a request and sends that |
| `play`, `stop` | Plays from the start, or stops the transport |
| `stats` | Cycles per frame while playing, underruns, and the most voices that sounded at once |
| `render [--frames N] [--out FILE]` | Renders the stored image away from the DAC, at 48 kHz unless `--rate` says otherwise, and times every frame |
| `check` | Sends each golden image, renders it, and compares the audio with its mono golden render |
| `test` | Damages and cuts transfers on purpose, and checks that the board keeps the image it had |
| `loopback` | Reads PA4 back with the ADC while something plays, and fits it to what the DAC was given |
| `time PATH...` | Sends each image or request in turn and reports its cycles per frame |

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

The rate is 80 MHz over 1,667 timer ticks, which is 47,990.4 Hz. 48 kHz isn't a whole number of ticks. Telling the engine the true rate keeps
pitch right, and only frame-timed behaviour moves, by 0.02%. The clock is MSI locked to the board's 32.768 kHz crystal.

## Measured on the board

All of this was measured on one board, on 2026-11-02.

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

**Cycles.** These are cycles per 32-sample frame at 48 kHz, with images in flash, 4 wait states, and the ART caches on. The budget is 53,333
cycles a frame.
- **What fits:**
  - 59 of the 61 recipes load. Reverb and PingPongDelay need 188 KB and 231 KB of bulk memory, and the board has 64 KB.
  - Of the 59, 56 stay within budget on average and 53 in their worst frame. The median takes 25% of the core.
- **Over budget on average:**
  - AdditiveBell at 162%, PhaseModElectricPiano at 146%, and DrawbarOrgan at 113%.
  - The demo, at 109%.
- **One voice:** a patch playing a single voice costs 196 to 407 cycles a sample, including the mixer. Section 15's model gave 160 to 200 for
  the voice alone.
- **The four pieces:** none fits. Each sends to a stereo reverb that needs 188 KB of bulk memory.

**Live playback.** The DMA plays one half of its buffer while the main loop fills the other. A half is 16 frames, 10.7 ms. Over 6 s of each:
- LoopedSample and Vocoder never ran late.
- DrumLoop ran late 4 times and DetunedSupersaw 14 times. Those are stretches of 16 frames that cost more than 16 frame periods.

**CMSIS-DSP.** Over the same 60 programs, the median change in mean cycles was 0.0%. Some ran 9.9% slower (Vocoder) and some 8.4% faster
(PhaseModElectricPiano).

The full tables come from `uv run tools/Board.py time examples/Recipes --json FILE`.
