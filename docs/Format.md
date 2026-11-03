# modsynth image format, version 1

This is the specification of the bytes a compiler writes and an engine loads. An image written to this document plays on
every engine of its frame size that claims to read it, forever. An engine plays an image exactly or refuses it, and no target plays one differently. `include/modsynth/Format.hpp` and `Opcodes.def` must agree with it, and
`tools/ReadImage.py`, written from this document alone, checks that they do.

Words: **must** is a rule that a reader enforces by refusing the image. Everything refused is listed in the sections
below, so an image either loads or fails one named rule.

## 1. Conventions

- All integers are unsigned and little-endian unless a field says otherwise. Floats are IEEE 754 binary32, little-endian.
- Offsets and sizes count bytes. A count named after a table counts its elements.
- Fields have no alignment of their own: a reader copies each field out, so any field may sit at any offset.
- Samples are used in place, so an image must start on an 8-byte boundary. Everything that needs alignment follows from
  that: chunks are 8-aligned, and each chunk places its float data on a 4-byte boundary within it.
- A field named `reserved` must be 0. So must anything a rule below calls unused. A field that was ever ignored could
  never be given a meaning, because images with junk in it would already exist.

## 2. Compatibility

Three kinds of change are possible after this freeze, and nothing else is.

1. **A new opcode.** Lines in `Opcodes.def` are append-only: a number once used never changes meaning, and a line on
   `main` never changes or moves. CI fails a pull request that breaks this.
2. **A higher limit.** The limits in section 9 may rise and may never fall, because an image that fit once must keep fitting.
3. **A reserved field gaining a meaning.** A new value in a reserved field or flag.

Each of these raises the **revision**. An engine has a `kFormatRevision`, and a manifest states the lowest revision that
can read it. An engine refuses a higher one with "image needs a newer engine", which is different from an image being
damaged. A compiler writes the lowest revision that covers what it actually used, so an image that uses nothing new keeps
loading on old engines. This document describes revision 8. The opcode table says which revision added each opcode.

The **version** byte in each chunk header is for a change that an old engine must not attempt. Version 1 is the only
version so far, and no such change is planned. A version above the engine's in the manifest, which comes first, gets the same refusal. In any later chunk
it is refused as a damaged chunk.

Old images keep their sound as well as their shape. Sound within −100 dB of peak of the golden renders, on every target,
is part of this contract: see section 10.

## 3. Image

    Manifest chunk
    chunk 0
    chunk 1
    ...

A chunk is a 24-byte header and its payload. If the payload is not a multiple of 8, zero bytes pad it to one. Padding must
be zero, and it is not counted in `size`. Each chunk follows the last with nothing between them, and nothing may follow the
last chunk, so the image's size is exact.

### Chunk header, 24 bytes

| Offset | Type | Field | Meaning |
|---|---|---|---|
| 0 | u32 | `magic` | `0x4B43534D`, which is the ASCII `MSCK` |
| 4 | u8 | `kind` | 0 Manifest, 1 Asset, 2 Table, 3 Patch, 4 Program |
| 5 | u8 | `version` | 1 |
| 6 | u16 | `reserved` | |
| 8 | u32 | `size` | payload bytes, without padding |
| 12 | u32 | `reserved` | |
| 16 | u64 | `hash` | see below |

### Hash

    h = 14695981039346656037
    for each byte b of [version, kind, payload...]:
        h = ((h xor b) * 1099511628211) mod 2^64

This is FNV-1a 64 over the version byte, the kind byte and the payload. The hash is a chunk's identity: a Patch names a
Table by its hash, and two chunks with one hash are one chunk. A reader that already holds a hash discards the arriving
bytes. Every byte of an image is therefore covered: the payload and two header bytes by the hash, the magic and reserved
fields by fixed values, `size` by the hashed manifest, and padding by the rule that it is zero.

**The choice is settled, for these reasons.** A hash here does two jobs, and neither needs a cryptographic one:

- *Corruption.* Each step is a bijection, so one changed byte can never collide, and the multiplier spreads a second
  changed neighbour too far to cancel it. Beyond that a random corruption collides about once in 2^64. Stored images are
  also length-checked by the manifest.
- *Identity.* An image holds at most `kMaxChunks`, 1024, chunks. The chance of an accidental collision among them is about
  2^-45.

It costs about 12 cycles per byte on a Cortex-M4, or about 160 ms per MB at 80 MHz, and it is four lines of code. That cost
is paid once, on receipt.

**It is not authentication.** Anyone can construct a collision. A hostile image is handled by validation, which assumes
nothing about where the bytes came from, so a collision can at worst substitute one valid chunk for another. A product
that must refuse images from an unknown source should sign the image's bytes, around this format. A move to a stronger hash
would be a new version, and the need for one would be a new requirement rather than a defect in this one.

### Manifest

The first chunk, and the only one of kind 0. Its payload is exactly a 16-byte header and `entries` entries of 16 bytes, so it
never has padding.

| Offset | Type | Field | Meaning |
|---|---|---|---|
| 0 | u32 | `entries` | |
| 4 | u32 | `programs` | how many entries are Programs |
| 8 | u32 | `revision` | the lowest engine revision that can read this image |
| 12 | u32 | `frame_size` | samples per frame this image was compiled for, with 0 meaning 128 |

`frame_size` is part of how an image sounds. It sets how often scalars are read, so it decides what a KSnap can follow, how fast a KLfo can
run and how short a feedback loop can be. So an engine plays only images of its own frame size, and refuses any other with "image was
compiled for another frame size". A host that wants to play several builds an engine for each. It is 0 or a power of two from 8 to 1024,
never 128, which has the one encoding 0, and anything but 0 needs a `revision` of at least 3, so that an engine from before this field
says it needs updating and not that the image is damaged. Chunks loaded together must agree, so one chunk store holds one frame size.

Each entry:

| Offset | Type | Field | Meaning |
|---|---|---|---|
| 0 | u64 | `hash` | |
| 8 | u32 | `size` | |
| 12 | u8 | `kind` | 1 to 4 |
| 13 | u8 | `present` | 1 if the bytes follow in this image, 0 if the receiver must already hold them |
| 14 | u16 | `reserved` | |

Entries must be in one order: every Asset, then every Table, then every Patch, then every Program. Assets, Tables and Patches
must each be in strictly ascending `hash` order, which also forbids a repeat. Programs keep their order, because a Program's
position is how a host selects it. The same set of chunks therefore always gives the same bytes.

Chunks follow in manifest order, skipping those with `present` 0. A chunk's header must match its entry in `hash`, `size` and
`kind`. An entry with `present` 0 must be satisfied by a chunk the receiver holds, matching `hash`, `size` and `kind`.

An image with `present` 0 entries is **thin**: it carries a Program and leaves out what the receiver already has. An image may
have no Programs at all, which is how a library of patches is sent ahead of them. A compiler puts every patch of its library in one, and an engine that
loads one keeps its chunks, binds nothing and goes on playing what it was playing.

A reader verifies everything before it commits anything. An image that fails at any point leaves the receiver as it was.

## 4. Asset chunk (kind 1)

A 20-byte header, then `(frames + 1) * channels` samples, interleaved.

| Offset | Type | Field | Meaning |
|---|---|---|---|
| 0 | u8 | `encoding` | 0 i16, 1 f32 |
| 1 | u8 | `channels` | 1 or 2 |
| 2 | u8 | `root_key` | MIDI note, at most 127 |
| 3 | u8 | `flags` | must be 0. Reserved for streaming and compression. |
| 4 | f32 | `native_rate` | 1 to 1,000,000 Hz |
| 8 | u32 | `frames` | 1 to 2^30 |
| 12 | u32 | `loop_start` | |
| 16 | u32 | `loop_end` | 0 means a one-shot |

The extra frame is a guard, so interpolation can always read the next frame. A compiler writes the frame at `loop_start` there
for a looping asset, and silence for a one-shot. If `loop_end` is not 0, then `loop_start < loop_end <= frames` must hold. The
payload size must match exactly. f32 samples must be finite.

## 5. Table chunk (kind 2)

An 8-byte header, then `length + 1` f32 samples, all finite. The extra sample is a guard.

| Offset | Type | Field | Meaning |
|---|---|---|---|
| 0 | u32 | `length` | a power of two, from 2 to 2^24 |
| 4 | u32 | `reserved` | |

The payload size must match exactly.

A table that a Sample2 uses is a **zone table**: rows of 8 f32, and at most 256 of them, so `length` is a multiple of 8. A Sample3's is a
**wide zone table**, whose rows are 16 f32 and are described after these.

| Field | Name | Meaning |
|---|---|---|
| 0 | `low_key` | a whole number, 0 to 127 |
| 1 | `high_key` | likewise, and at least `low_key` |
| 2 | `low_velocity` | a whole number, 0 to 127 |
| 3 | `high_velocity` | likewise, and at least `low_velocity` |
| 4 | `ref` | an index into the Patch's references, which must name an Asset |
| 5 | `root` | the key the recording sounds at, 0 to 127, which may have a fraction |
| 6, 7 | | must be 0 |

The first row whose ranges hold a note and its velocity is that note's zone. A row of `1, 0, 0, 0, 0, 0, 0, 0` matches nothing, which is how a
table reaches a power of two, and no other row may have `low_key` above `high_key`. `ref` is an index and not a hash, so a zone table means
something only with its Patch. The validator checks it once for each Patch that uses it, and once more for each kind of step that does.

A wide zone table, since revision 7, has fields 0 to 5 as above, then:

| Field | Name | Meaning |
|---|---|---|
| 6 | `seq_position` | a whole number below `seq_length`, or 0 when that is 0 |
| 7 | `seq_length` | a whole number, 0 to 256. 0 is no round robin. |
| 8 | `fade_in` | 0 to `high_velocity - low_velocity` |
| 9 | `fade_out` | likewise |
| 10 to 15 | | must be 0 |

A row with a round robin plays only on a note whose ordinal on its track, modulo `seq_length`, is `seq_position`. A row's gain is 1, times
`min(1, (velocity - low_velocity) / fade_in)` if `fade_in` is above 0, times `min(1, (high_velocity - velocity) / fade_out)` if `fade_out` is
above 0, all in f32, so two rows that overlap can cross over in velocity. Padding is `1` followed by fifteen `0`.

## 6. Patch chunk (kind 3)

A Patch is a list of steps. Its bytes depend on its graph alone: nothing about a track, a target or a Program is in it. That is
what lets two Programs share one hash.

### Header, 28 bytes

All u16 but the last.

| Offset | Field | Meaning |
|---|---|---|
| 0 | `control_steps` | steps run once per frame per track or insert, in the control phase |
| 2 | `voice_steps` | steps run once per frame per voice or insert, in the audio phase |
| 4 | `buffers` | scratch buffers, each one frame long |
| 6 | `voice_scalars` | at least 3 |
| 8 | `track_scalars` | |
| 10 | `params` | |
| 12 | `refs` | |
| 14 | `consts` | |
| 16 | `delays` | |
| 18 | `inputs` | stereo input pairs: 0 for an instrument, 1 for an insert, 2 for one with a sidechain |
| 20 | `out_left` | an operand naming a buffer |
| 22 | `out_right` | an operand naming a buffer. Equal to `out_left` for a mono patch. |
| 24 | u32 `reserved` | |

### Body

In this order, with no padding, since every section's size is a multiple of 4 and the header's size is too. The payload must end
exactly at the end of the last section.

| Section | Element | Count |
|---|---|---|
| Parameters | 20 bytes | `params` |
| References | u64 hash of a Table or Asset | `refs` |
| Constants | f32, finite | `consts` |
| Delay lines | f32 maximum seconds, above 0 and at most 60. What a line holds is up to the steps that use it, below. | `delays` |
| Input ports | u16 left, u16 right, each a buffer index | `inputs` |
| Control steps, then voice steps | 20 bytes | `control_steps + voice_steps` |

### Parameter, 20 bytes

| Offset | Type | Field | Meaning |
|---|---|---|---|
| 0 | u16 | `id` | stable, and what Instructions address. Strictly ascending within a Patch. |
| 2 | u8 | `scope` | 0 voice, 1 track, 2 global |
| 3 | u8 | `reserved` | |
| 4 | u16 | `reg` | its register in that scope's bank, or 0 for global. Two parameters must not share one. |
| 6 | u16 | `smooth_ms` | how long a live change to a track-scope parameter glides. A SetParam in a stream applies at once, and a Ramp takes its own time. |
| 8 | f32 | `min` | |
| 12 | f32 | `max` | |
| 16 | f32 | `default` | `min <= default <= max`, all finite |

A global parameter has no register. An operand reads it by the parameter's position in this table, and the value comes from the
Program's global with the same `id`.

### Operands

An operand is a u16: a bank in the top 3 bits, and an index in the low 13.

| Bank | Name | Index is | Lives |
|---|---|---|---|
| 0 | none | | |
| 1 | Buffer | scratch buffer | for one step's worth of a frame |
| 2 | Voice | voice scalar | one per voice |
| 3 | Track | track scalar | one per track slot or insert |
| 4 | Global | position in the parameter table | one per Program |
| 5 | Const | position in the constant table | in the image |

Bank 6 and 7 are invalid. Voice scalars 0, 1 and 2 are always the note (0 to 127), the velocity (0 to 1) and the gate (0 or 1).
In an insert all three are 0.

### Step, 20 bytes

| Offset | Type | Field | Meaning |
|---|---|---|---|
| 0 | u8 | `op` | see below |
| 1 | u8 | `mode` | must not exceed the op's maximum |
| 2 | u16 | `resource` | see below, or 0 if the op takes none |
| 4 | u32 | `state_id` | identifies this step's state across a live edit, or 0 |
| 8 | u16[2] | `out` | operands. Those past the op's count must be 0. |
| 12 | u16[4] | `in` | operands. Those past the op's count must be 0. |

`state_id` never changes what a Program sounds like when played once. When an edit replaces one generation with another, state
is carried from a step to the step with the same non-zero `state_id` and the same `op`. A step's resource is a position in the
reference table, for a Table or an Asset, or in the delay line table, for a Delay. A step using a reference must find the kind it
needs there.

A track or voice parameter's value is carried to the parameter with the same `id`, which need not mean the same thing, so it is
clamped to the new `min` and `max` first. A change under way keeps the time it had left and ends at its target, clamped the same
way. A value already inside the range is carried exactly.

### Opcodes

`B` is an operand naming a buffer. `S` is one naming a scalar, in any bank that can be read. `E` takes either, and a scalar is then the same for
every sample of the frame. In the formulas below, `N` is the
frame size, `rate` is the sample rate in Hz, and `clamp(x, lo, hi)` sends NaN to `lo`. All outputs are written for all `N`
samples.

| Op | Name | Out | In | Mode | Resource | Runs in | Since |
|---|---|---|---|---|---|---|---|
| 1 | Fill | B | S value | | | voice | 0 |
| 2 | Noise | B | | | | voice | 0 |
| 3 | Osc | B | S frequency | | Table | voice | 0 |
| 4 | Biquad | B | B in, S cutoff, S q | 0 low, 1 high, 2 band | | voice | 0 |
| 5 | Env | B | S attack, S decay, S sustain, S release | | | voice | 0 |
| 6 | Sample | B left, B right | S ratio | | Asset | voice | 0 |
| 7 | Mul | B | B a, B b | | | voice | 0 |
| 8 | MulS | B | B a, S b | | | voice | 0 |
| 9 | Add | B | B a, B b | | | voice | 0 |
| 10 | AddS | B | B a, S b | | | voice | 0 |
| 11 | Pan | B left, B right | B in, S position | | | voice | 0 |
| 12 | DelayWrite | | B in | | Delay | voice | 0 |
| 13 | DelayRead | B | S seconds | 0 after the write, 1 before it | Delay | voice | 0 |
| 14 | Comb | B | B in, S seconds, S feedback, S damp | | Delay | voice | 0 |
| 15 | Allpass | B | B in, S seconds, S feedback | | Delay | voice | 0 |
| 16 | Follow | B | B in, S release | | | voice | 0 |
| 17 | KMul | S | S a, S b | | | either | 0 |
| 18 | KAdd | S | S a, S b | | | either | 0 |
| 19 | KMtoF | S | S note | | | either | 0 |
| 20 | KRatio | S | S note | root key, at most 127 | | either | 0 |
| 21 | KSnap | S | B in | | | voice | 0 |
| 22 | KLfo | S | S rate, S depth | | | either | 0 |
| 23 | Saw | B | S frequency | 0 band-limited, 1 naive | | voice | 1 |
| 24 | Pulse | B | S frequency, S width | 0 band-limited, 1 naive | | voice | 1 |
| 25 | Triangle | B | S frequency | | | voice | 1 |
| 26 | Tone | B | S frequency | | | voice | 2 |
| 27 | Sample2 | B left, B right | S note, S start | bit 0 reverse, bit 1 tail | Table | voice | 4 |
| 28 | KLfo2 | S | S rate, S depth | | | either | 5 |
| 29 | OscMod | B | E frequency, E phase, E sync, E fourth | 0 sine, 1 triangle, 2 saw, 3 pulse, 4 naive saw, 5 naive pulse | | voice | 6 |
| 30 | Math | B | E a, E b, E c | 0 min, 1 max, 2 abs, 3 clip, 4 floor, 5 divide, 6 compare, 7 select | | voice | 6 |
| 31 | KMath | S | S a, S b, S c | 0 min, 1 max, 2 abs, 3 clip, 4 floor, 5 divide, 6 compare, 7 select | | either | 6 |
| 32 | Shape | B | B in | | Table | voice | 6 |
| 33 | Sample3 | B left, B right | S note, S start | bit 0 reverse, bit 1 tail, bit 2 release | Table | voice | 7 |
| 34 | DelayWriteI16 | | B in | | Delay | voice | 8 |
| 35 | DelayReadI16 | B | S seconds | 0 after the write, 1 before it | Delay | voice | 8 |
| 36 | CombI16 | B | B in, S seconds, S feedback, S damp | | Delay | voice | 8 |
| 37 | AllpassI16 | B | B in, S seconds, S feedback | | Delay | voice | 8 |

What each one does:

- **Fill.** Every sample is the value.
- **Noise.** A 32-bit xorshift: `x ^= x << 13`, `x ^= x >> 17`, `x ^= x << 5`, with each sample `x` as a signed integer times
  `4.656612873e-10`. It starts from `(seed xor (step * 2654435761)) or 1`, where `step` is this step's position in the Patch counting control
  steps, and in 32 bits. For a voice, `seed` is `(track id << 16) xor (voice index << 8) xor age`, and `age` counts the notes the track has
  started, this one included. For an insert it is 1. So noise is repeatable, and depends on nothing about where its state is stored.
- **Osc.** A 32-bit phase, incremented per sample by `clamp(frequency, 0, rate / 2) * (1 / rate) * 4294967040`, truncated to an integer. The
  top bits index the table, and the output interpolates linearly to the next entry, which is why a table has a guard. It wraps because the
  phase does.
- **Saw, Pulse, Triangle.** A 32-bit `phase` starting at 0, advanced per sample by `inc`, worked out as for Osc. No table, and each is
  written for one sample below. `ramp(p)` is `p` as a signed integer times `4.656612873e-10`. Conversions to float round to nearest.
  - `blep(x)` is `(1 + x) * (1 + x)` if `x < 0`, and otherwise `-(1 - x) * (1 - x)`. `near(p)` is `p + inc < inc + inc` in 32 bits, which holds
    within `inc` of a jump on either side. `from(p)` is `p` as a signed integer times `iv`, where `iv` is `1 / inc`, or 0 if `inc` is 0.
    Mode 0 of Saw and Pulse uses these, and only on samples beside a jump, so that harmonics above `rate / 2` mostly do not fold back. Mode 1 does
    not, so the ones it leaves are audible, more so at high notes. It is about half the cost, and it is the right choice for a low note or
    for the sound of aliasing.
  - **Saw.** Starts at 0, rises to 1 at half a turn and jumps to −1. With `j = phase + 0x80000000`, mode 1 writes `ramp(phase)`. Mode 0 writes that,
    less `blep(from(j))` if `near(j)`.
  - **Pulse.** `w` is `clamp(width, 0, 1)`, read once per frame, and `edge` is `w * 4294967040` truncated to an integer. Let `v` be 1 if
    `phase < edge` and −1 otherwise, less the mean `w + w - 1`, so moving the width does not move the level and a width of 0 or 1 is silence.
    Mode 1 writes `v`. Mode 0 adds `blep(from(phase))` if `near(phase)`, then subtracts `blep(from(f))` if `near(f)`, where `f = phase - edge`.
  - **Triangle.** Starts at 0, rises to 1 at a quarter turn and falls to −1 at three quarters. With `p = phase + 0x40000000`, it writes
    `p xor (p as a signed integer >> 31)`, as a signed integer times `9.313225746e-10`, less 1. It has no mode: having no jump, it aliases
    little.
- **Tone.** A sine with no table, at about half the cost of Osc, whose frequency is read once. `v`, `d` and `k` start at 0. At the start of a frame,
  if `k` is 0, it sets `t = clamp(frequency, 0, 0.45 * rate) * (1 / rate)`, `h = sin_turns(t * 0.5)`, `k = 4 * h * h` and `d = sin_turns(t)`, and in
  that frame it writes 0 before a note's sample offset and starts there. Then for each sample it writes `v`, sets `d` to `d - k * v`, and sets `v` to
  `v + d`. So a note starts from 0 on its own sample and keeps the frequency it started with to its end, whatever the input does later, and until
  there is a frequency above 0 it is silent. State carried across a live edit carries the
  frequency too, so an edit reaches the next note. This is `s[n + 1] = (2 - k) * s[n] - s[n - 1]`, kept as the step `d = s[n] - s[n - 1]` because
  `2 - k` has few bits left at a low note. Its level is in that state, so a `k` that moved would move the level, which is why it does not.
- **Biquad.** A transposed direct form II biquad with RBJ cookbook coefficients. Cutoff is clamped to 10 Hz to `0.45 * rate`, and q to 0.1 to
  30. With `t = cutoff / rate`, `1 - cos(w)` is `2 * sin_turns(t / 2)^2`, which keeps its bits at a low cutoff, and `alpha` is
  `sin_turns(t) / (2 * q)`. A band-pass has constant 0 dB peak gain. A coefficient is worked out again only when cutoff or q changes.
- **Env.** Attack, decay and release are in seconds, clamped to 0.0001 to 60. Sustain is clamped to 0 to 1. Attack is linear to 1.
  Decay is exponential towards sustain with coefficient `exp_minus(1 / (decay * rate))`, and is done within 0.0001 of it. Release is
  exponential towards 0, likewise, and is done below 0.0001. A gate change takes effect at its sample offset within the frame.
- **Sample.** A 32.32 position, advanced by `clamp(ratio, 0, 256) * native_rate / rate` per sample, capped at 65536 and held below
  the loop length so one wrap is always enough. The output interpolates linearly. A one-shot writes 0 once its position passes its last
  frame, and is done. A looping Sample whose position is past `loop_end`, which only a live edit can cause, restarts at `loop_start`. A mono
  asset writes one signal to both outputs. A note starting at an offset within a frame writes 0 before it.
- **Sample2.** Plays one recording of a zone table, chosen at the start of a note by the note and velocity that started the voice, and kept to
  the note's end. A note no zone holds is silent, and is done. In an insert both are 0. The position is 32.32, set once to
  `s * (frames - 1)`, or `(1 - s) * (frames - 1)` in reverse, with `s = clamp(start, 0, 1)`, truncated to an integer. So `start` always
  counts from where playback begins. Each sample writes as Sample does, then moves by `inc`, forwards or in reverse, where `inc` is
  `clamp(r, 0, 256) * native_rate / rate`, capped at 65536 and held below the loop length, and
  `r = pow2((clamp(note, -48, 200) - root) / 12)`, worked out again only when that distance changes. So pitch follows `note` for the whole note,
  and a glide or a legato change slides the one recording. A note starting at an offset within a frame writes 0 before it.
  - With no loop in the asset it plays to the end and is done: forwards when `idx >= frames`, and in reverse when it cannot move by `inc` and stay
    at or above 0, after writing that sample.
  - With a loop it stays in it. Going forwards past `loop_end` subtracts the loop length. Going in reverse, a move that would go below
    `loop_start` adds the loop length less `inc`. A position that starts beyond the loop in the direction of travel plays into it, and one that
    starts past it goes to `loop_start`, or in reverse to just below `loop_end`.
  - With no tail bit a loop never ends, so it does not hold a voice open: a note ends with its Env, or on release if it has none. With the tail
    bit it leaves the loop at the sample of the release and plays to the end of the recording in its direction, and the voice lasts until then.
  - A live edit can carry a position or a zone that no longer fits. A zone past the table's end or on a padding row is done. In reverse a position
    past the last frame goes to just below it.
- **Sample3.** Sample2 for up to two recordings at once, from a wide zone table. A note's rows are the first two, in table order, that hold its
  key and velocity, that its ordinal plays if they have a round robin, and whose gain is above 0. A key or velocity here is the one that started
  the voice, and the **ordinal** is how many NoteOns its track had reached before it, counting every one a stream passes, played or chased, and
  every live note, from 0 when the stream starts. Each row plays as Sample2's one recording does, with its own position, root and loop, and its
  samples times its gain are added. It is done when both are, and it holds a voice open while either would hold Sample2's.
  - With the release bit it writes 0 while its note is held. On the sample the note is released it picks its rows, by the note, velocity and
    ordinal that started the voice, and plays them from there once through: loops and the tail bit play no part, and it is done when both
    rows end. Until it is released it holds its voice open.
- **Mul, MulS, Add, AddS.** Per sample. An output may be the same register as an input.
- **Pan.** `left = in * (1 - p) / 2` and `right = in * (1 + p) / 2`, with `p` clamped to −1 to 1. This law is linear, so `left + right`
  is always `in`, whatever `p` is.
- **DelayWrite.** Writes the frame to the delay line.
- **DelayRead.** Reads the line `seconds` behind the write position, clamped to what the line can hold. Mode 0 reads after this frame's
  write, so short delays work. Mode 1 reads before it, for feedback, and so reads at least one frame back. Anything older than what
  has been written reads as 0.
- **Comb.** A feedback comb with a one-pole low-pass in the loop: `low = y * (1 - damp) + low * damp`, then the line takes
  `in + low * feedback` and the output is `y`, the delayed sample. Feedback is clamped to ±0.995 and damp to 0 to 0.99.
- **Allpass.** The line takes `in + y * feedback`, and the output is `y - in`. Feedback is clamped to ±0.995.
- **DelayWriteI16, DelayReadI16, CombI16, AllpassI16.** DelayWrite, DelayRead, Comb and Allpass on a line of 16-bit samples, which takes half
  the memory. A value `x` goes into the line as `clamp(x * 32768, -32768, 32767)` truncated towards zero, so anything past full scale is
  held there, and a NaN goes in as 0. A sample `s` comes out as `s * (1 / 32768)`, which is exact. Everything else is as their f32 forms.
- **Follow.** A peak follower: `level = max(|in|, level * exp_minus(1 / (release * rate)))`. Release is clamped to 0.0001 to 60.
- **KMul, KAdd.** One scalar operation.
- **KMtoF.** `440 * pow2((note - 69) / 12)`, with `note` clamped to −48 to 200.
- **KRatio.** `pow2((note - mode) / 12)`, with `note` clamped the same way. This is what plays an asset at pitch.
- **KSnap.** Writes the last sample of a buffer to a scalar, so audio can drive a control input.
- **KLfo.** `sin_turns(phase / 2^32) * depth`, with a 32-bit phase advanced once a frame by `clamp(rate * N / sample rate, 0, 0.5) * 4294967040`,
  truncated to an integer, for `rate` clamped to 0 to 1000 Hz.
- **KLfo2.** A KLfo, except that as a control step its phase does not advance in a frame in which the transport is stopped. That frame still writes
  the output, so a change of `depth` is heard, and Play carries on from the same phase. A control step runs whether or not a note does, so
  without this every frame rendered before Play would move what follows. As a voice step it is a KLfo, since a voice has its own start and
  outlives a Stop in its release. A compiler writes KLfo2 for a control step and KLfo for a voice step.
- **OscMod.** An oscillator all of whose inputs can move per sample. Each sample `n`, in this order:
  - `step` is `clamp(frequency / rate, -0.5, 0.5) * 4294967040`, truncated to a signed integer, or 0 if that division gives NaN. A negative
    `step` runs the wave backwards.
  - `offset` is `turns_to_phase(phase)`.
  - On a pulse, `width` is `fourth` clamped to 0 to 1, `edge` is `width * 4294967040` truncated to an integer, and `mean` is `2 * width - 1`.
  - On a sine, `push` is `turns_to_phase(clamp(fourth, -1, 1) * (y[n-1] + y[n-2]) / 2)`, where `y` is the sine this step has made, starting at 0.
    Otherwise `push` is 0, and `fourth` isn't read.
  - If the last sync sample was at most 0 and this one is above 0, a sync edge has passed. `since` is `sync[n] / (sync[n] - sync[n-1])`, clamped
    to 0 to 1, how far back it was. `reach` is `step` as a float. `phase` becomes `reach * since`, and the wave was caught at
    `read[n-1] + reach * (1 - since)`, each of those products truncated to a signed integer.
  - `read` is `phase + offset`, in 32 bits, and the sample is `value(read + push)`, then `phase` advances by `step`.

  `value(p)` reads `p` as a 32-bit phase. A sine is `sin_turns(p as signed * 2.32830644e-10)`. A triangle and a saw are as Triangle and Saw read
  it. A pulse is `(p < edge ? 1 : -1) - mean`. A naive wave is that sample, and that is all.

  The others are one sample late, because a jump between samples `n - 1` and `n` corrects both. The output is
  `y'[n-1] + before`, then `y'[n]` is `value + after`, starting from `y'` of 0, with `before` and `after` summing every jump that sample crossed:
  for a jump of `height`, `since` of a sample ago, `before` gains `height * since^2 / 2` and `after` loses `height * (1 - since)^2 / 2`.

  A sync edge is one jump, of `value(offset + push) - value(caught + push)`, in place of any other that sample. Otherwise a saw has one
  of -2 at phase 0x80000000. A pulse has one of 2 at 0 and one of -2 at `edge`, and the place it fell from is last sample's `edge`. A sine
  and a triangle have none. A jump at `place` is crossed when `from = read[n-1] - place` and `to = read - place`, each as a signed integer,
  have different signs, and `to` has the sign of `to - from`, in 32 bits. Then `since` is `to / (to - from)`, and `height` is negated if `to - from` is
  negative. `sync[n-1]` and `read[n-1]` before a voice's first sample are its `sync` and `offset - step`.

  It starts on the note's sample, and the samples before that in its first frame are 0.
- **Math, KMath.** One operation for each sample, or once. Min is `a < b ? a : b`, and max `a > b ? a : b`. Abs is `a < 0 ? -a : a`. Clip is `clamp(a, b, c)`.
  Floor is the next whole number down, and a value at or beyond 2^23 either way, or NaN, is itself. Divide is `a / b`, and 0 if `b` is 0. Compare is
  `a > b ? 1 : 0`. Select is `a > 0 ? b : c`. Inputs a mode doesn't name are read and not used. A compiler writes KMath when no input is a buffer.
- **Shape.** A curve, in a Table whose `length + 1` points run evenly from -1 to 1, so that the guard is the point at 1. `place` is
  `(clamp(in, -1, 1) + 1) * length / 2`, `index` is `place` truncated to an integer, and at most `length - 1`. The output is
  `t[index] + (t[index + 1] - t[index]) * (place - index)`.

### Arithmetic

A kernel uses only IEEE 754 `+`, `-`, `*`, `/` and conversions, in binary32, without fused multiply-add, so its result is defined to the bit.
The three functions a C library would normally supply are defined here instead, in binary32, because each library rounds differently, and in a
filter coefficient that alone reaches −90 dB. `round(x)` is `x + 0.5`, or `x - 0.5` if `x` is negative, truncated towards zero.

    turns_to_phase(x):          (clamp(x, -64, 64) * 16777216, truncated to a signed integer) << 8, in 32 bits
    pow2(x):                    x clamped to -126 to 127
        n = round(x), f = x - n
        p = 1.52527338e-5
        for k in 1.54035304e-4, 1.33335581e-3, 9.61812911e-3, 5.55041087e-2, 2.40226507e-1, 6.93147181e-1, 1:
            p = p * f + k
        return p * 2^n

    exp_minus(x):
        return pow2(x * -1.44269504)

    sin_turns(t):               sin(2 pi t)
        t = t - round(t)
        if t > 0.25: t = 0.5 - t
        if t < -0.25: t = -0.5 - t
        x = t * 6.28318531, y = x * x
        p = -2.50521084e-8
        for k in 2.75573192e-6, -1.98412698e-4, 8.33333333e-3, -1.66666667e-1, 1:
            p = p * y + k
        return p * x

At the end of each frame a kernel flushes state that would otherwise decay into denormals. `flush(x)` is 0 if `-1e-20 < x < 1e-20`, and otherwise `x`. Biquad
does this to both of its state variables, Comb to `low` and Follow to `level`. It is part of the kernel on every target, because wasm has no flush-to-zero
mode, and no target sets one.

Every kernel is total: any finite or non-finite input gives defined behaviour, with no out-of-range read. A voice whose output is not
finite is stopped, and an insert whose output is not finite restarts empty. The final output is checked as well and replaced with
silence if it is not finite.

### What the validator requires of a Patch

- `control_steps + voice_steps`, `params`, `refs`, `consts`, `delays`, `buffers` and both scalar counts are within section 9, and
  `voice_scalars` is at least 3 and `inputs` at most 2.
- **Every read follows a write.** Walking the steps in order, a buffer may be read only if a step or input port has written it.
  A scalar may be read only if it is a built-in, a parameter, or a step has written it. Reading happens before writing within a step.
- **A step writes only what it owns**, which is the rule that makes Programs order-independent:
  - A voice step writes buffers and voice scalars. A control step writes track scalars only.
  - Nothing writes a global or a constant.
  - No step writes a built-in or a parameter's register. Those belong to the engine.
  - A control step reads no voice scalar and no buffer, because no voice exists at that time.
- A control step's op is one marked "either" above.
- An op with two outputs names two different registers, and neither may be one of its inputs, because the outputs are written one
  after the other.
- `out_left` and `out_right` name buffers that have been written.
- No step uses an opcode added after the manifest's revision.
- Each reference names a Table or an Asset that exists, and each step's resource is in range and of the right kind.
- The steps on one delay line agree on what it holds: all of them are I16 ops, or none is.
- A Sample2's Table is a zone table, and a Sample3's a wide zone table, as section 5 describes.

## 7. Program chunk (kind 4)

A Program is the compiled form of a timeline. Each track has an Instruction stream, and a mixer list routes the results.

### Header, 52 bytes

| Offset | Type | Field | Meaning |
|---|---|---|---|
| 0 | u32 | `ppq` | ticks per quarter note, 1 to 65535 |
| 4 | u32 | `uspq` | initial microseconds per quarter, 1000 to 60,000,000 |
| 8 | u32 | `length_ticks` | must equal the longest track's tick total |
| 12 | u32 | `conductor_begin` | first instruction of the conductor stream |
| 16 | u32 | `conductor_length` | |
| 20 | u32 | `code` | |
| 24 | u16 | `patches` | |
| 26 | u16 | `tracks` | |
| 28 | u16 | `slots` | |
| 30 | u16 | `clips` | |
| 32 | u16 | `inserts` | |
| 34 | u16 | `mix_steps` | |
| 36 | u16 | `gather_inputs` | |
| 38 | u16 | `buses` | at least 1 |
| 40 | u16 | `mix_regs` | |
| 42 | u16 | `globals` | |
| 44 | u16 | `inits` | |
| 46 | u16 | `master` | the bus register that is the output |
| 48 | u32 | `features` | bit 0 if any stream has a RampMix, bit 1 if any has a PlayMode, bit 2 if any has a Steal, and no other bits. It must say exactly that, and it decides what an engine sets aside for them, so a Program pays for none of them unless it uses it. |

### Body

In this order. The only padding is after the slots, to bring the clips to a 4-byte boundary, which is zero or two bytes. A compiler writes zeros there, and
an engine does not check them, so these bytes can never be given a meaning. The payload must end exactly at the end of the last section.

| Section | Element | Count |
|---|---|---|
| Patches | u64 hash | `patches` |
| Tracks | 16 bytes | `tracks` |
| Slots | u16 index into Patches | `slots` |
| Clips | 16 bytes | `clips` |
| Inserts | 4 bytes | `inserts` |
| Mixer steps | 12 bytes | `mix_steps` |
| Gather inputs | 8 bytes | `gather_inputs` |
| Mix registers | f32 initial value, finite | `mix_regs` |
| Globals | 8 bytes, `id` strictly ascending | `globals` |
| Initial values | 12 bytes | `inits` |
| Code | 8 bytes | `code` |

### Tables

Track, 16 bytes:

| Offset | Type | Field | Meaning |
|---|---|---|---|
| 0 | u16 | `id` | stable across edits, unique in a Program |
| 2 | u16 | `voices` | 1 to 256 |
| 4 | u16 | `slot_begin` | must equal the sum of the previous tracks' `slot_count`, so tracks own slots in order and share none |
| 6 | u16 | `slot_count` | 1 to 256. The sum over all tracks must equal `slots`. |
| 8 | u32 | `stream_begin` | |
| 12 | u32 | `stream_length` | |

A slot is a patch a track can play, and each slot must have no input ports.

Clip, 16 bytes:

| Offset | Type | Field | Meaning |
|---|---|---|---|
| 0 | u32 | `begin` | |
| 4 | u32 | `length` | |
| 8 | u32 | `ticks` | at least 1, and must equal the sum of the clip's Waits |
| 12 | u32 | `slots` | must equal one more than the highest slot its SetPatch names, or 0 if it has none |

Insert, 4 bytes: u16 `id`, stable and unique in a Program, and u16 `patch`, an index into Patches.

Global, 8 bytes: u16 `id`, u16 `reserved`, f32 `value`, which is finite. Every global parameter of every Patch in the Program must
have a Global with its `id`.

Initial value, 12 bytes:

| Offset | Type | Field | Meaning |
|---|---|---|---|
| 0 | u16 | `target_kind` | 0 track, 1 insert |
| 2 | u16 | `target` | an index into that table |
| 4 | u16 | `id` | a parameter id |
| 6 | u16 | `reserved` | |
| 8 | f32 | `value` | finite |

Applied at load, then clamped to the parameter's range. An `id` no patch has does nothing.

### Instructions, 8 bytes

| Offset | Type | Field |
|---|---|---|
| 0 | u8 | `op` |
| 1 | u8 | `a` |
| 2 | u16 | `b` |
| 4 | u32 | `c` |

| Op | Name | a | b | c | Where | Since |
|---|---|---|---|---|---|---|
| 0 | End | | | | Tracks and the conductor | 0 |
| 1 | Wait | | | ticks | Anywhere | 0 |
| 2 | NoteOn | note, 0 to 127 | velocity, 0 to 127 | duration, 1 to `kMaxTicks` | Tracks and clips | 0 |
| 3 | SetPatch | slot | | | Tracks and clips | 0 |
| 4 | SetParam | | param id | value, f32 bits, finite | Tracks and clips | 0 |
| 5 | Ramp | | param id | target, f32 bits, finite | Tracks and clips, then RampArg | 0 |
| 6 | RampArg | | | ticks, 1 to `kMaxTicks` | Only straight after a ramp | 0 |
| 7 | Call | | clip | repeats, at least 1 | Tracks only | 0 |
| 8 | Tempo | | | microseconds per quarter, 1000 to 60,000,000 | The conductor only | 0 |
| 9 | SetInsert | insert | param id | value, f32 bits, finite | Tracks and clips | 4 |
| 10 | RampInsert | insert | param id | target, f32 bits, finite | Tracks and clips, then RampArg | 4 |
| 11 | SetMix | | mix register | value, f32 bits, finite | Tracks and clips | 4 |
| 12 | RampMix | | mix register | target, f32 bits, finite | Tracks and clips, then RampArg | 4 |
| 13 | PlayMode | 0 poly, 1 mono, 2 legato, 3 legato with velocity | 0 last, 1 high, 2 low. 0 with poly. | glide seconds, f32 bits, 0 to 60 | Tracks and clips | 4 |
| 14 | Steal | 0 cut, 1 fade | | | Tracks and clips | 7 |

A field left blank must be 0. A track's stream and the conductor's must each end in one End, and contain no other. A clip must not
contain an End, because it returns to its caller. Calls do not nest, and a clip's `ticks` is at least 1, so a stream cannot run
forever without time passing.

A track's `SetPatch` applies to the next note, so held notes finish on the old patch. It must name a slot the track has. For a clip,
that is what `slots` declares, and a track may only call a clip whose `slots` is at most its `slot_count`. An unknown parameter id in
SetParam or Ramp does nothing, and a parameter of a slot that is not selected still changes. A parameter of voice or global scope has no glide: a SetParam
or a Ramp on one moves it to its value at once, and for voice scope that includes every voice sounding that slot, as well as later notes.

SetInsert and RampInsert do to an insert's parameter what SetParam and Ramp do to a slot's, and `insert` must be an index into the Inserts. A
parameter of voice scope does nothing there, because an insert's instance reads those once, at load. SetMix writes a mix register, and RampMix
moves one in a straight line, a step per frame, over as many frames as a Ramp of those ticks takes. `register` must be below `mix_regs`. A later SetMix
or RampMix on that register ends a ramp, as does a live change to it. These two reach the mixer from any track's stream, so two streams
naming one target would interleave by tick as they play and run one after the other in a locate. A compiler refuses that, and for the same reason it
refuses two streams moving one global parameter, by any of these instructions, since a global belongs to the Program and not to a track.

A stream's **tick total** is the sum of its Waits, plus `clip.ticks * repeats` for each Call. Every stream's total must be at most
`kMaxTicks`. The **expanded size** of a stream counts its instructions, with `clip.length + 1` for each repeat of each Call, and the
sum for all streams must be at most `kMaxExpanded`. These two limits are why a tick and a locate are always bounded.

### Play modes

A track starts in poly, with priority last and no glide. PlayMode changes all three for the next note, and notes already sounding finish as they
started. One at the head of a stream, before any Wait or Call, is in force from load, so a live note before Play follows it too.

- **Poly.** Each note takes a voice. Nothing below about held notes applies. Going to poly from another mode empties the held list, and any
  voice still sounding ends at its own tick.
- **Mono.** One note sounds. When another note takes over, the old one is released at that sample and the new one takes a voice of its own, so
  with `voices` above 1 a release tail rings under it.
- **Legato.** One note sounds. When another note takes over from a note still sounding, on the same slot, it keeps that voice: its note scalar
  changes, and its gate, velocity and state do not. Otherwise it starts as in mono.
- **Legato with velocity**, since revision 7. Legato, except that a note taking over a voice brings its velocity too. The voice's velocity
  becomes the note's, and its velocity scalar moves to `velocity / 127` in `n = max(trunc(max(glide, 0.005) * rate / N), 1)` equal steps, one
  each frame, the first in the frame the note takes over, landing exactly on it. A note that starts a voice of its own starts with its own
  velocity, as in any mode.

A track in mono or legato keeps a list of the notes it is holding, of at most 16, in the order they started. Whenever one starts or ends, priority
chooses one of them: the newest for last, the highest for high and the lowest for low, with ties going to the newest. If that is not the note
sounding, it takes over at that sample, with its own velocity if it starts a voice. A note that is not chosen waits and can still sound if it
outlasts the others. With the list full, a new note pushes out the oldest that is not sounding. If the note sounding ends and the list is
empty, its voice is released. Within a segment these run in time order, and at one sample an end comes before a start, so a note that only touches
the next one is not an overlap.

With a glide above 0, a note that takes over starts at the pitch `from` and moves in `n = max(trunc(glide * rate / N), 1)` equal steps, one each
frame, the first in the frame it starts, and lands exactly on its note. The steps move the voice's note scalar, so whatever reads it follows.
`from` is:

- in legato, or in mono with a note sounding, that note's pitch at that moment, part way through a slide if it is in one;
- in mono with nothing sounding, the last note the track started;
- in poly, the last note the track started, while earlier voices stay where they are;
- in legato with nothing sounding, nothing, so it starts on its note.

The first note a track plays has nothing to slide from. A locate replays the stream, so it restores the mode and the last note as well.

### Stolen voices

A note that finds every voice of its track busy takes one: the oldest released voice, or the oldest if none is released. Steal says what
becomes of the sound that voice was making, from the next note on, and a track starts with 0. A locate replays it with the stream.

- **0, cut.** It stops on the frame the new note starts, before the new note's first sample.
- **1, fade**, since revision 7. It moves to a **fade slot**, where it plays on unchanged up to the sample the new note starts on, and then
  falls in a straight line: its `k`th sample from there is multiplied by `1 - (k + 1) / L`, and by 0 from `L` on, with `L = max(trunc(0.002 *
  rate), 1)`. It is added to the track's bus after the track's voices, in slot order, and its slot is free again after the frame in which its
  fade ends, or in which its own sound ends. The voice starts its new note on that note's sample as usual.

A Program with a Steal gives every track `max(voices / 4, 1)` fade slots, rounded down, each the size of one of its voices. A steal into a
track whose slots are all fading cuts short the one furthest through its fade. Nothing in a fade slot is carried across a live edit.

### Time

All tracks share one tick clock. At sample rate `rate`, one tick lasts `uspq / (1,000,000 * ppq)` seconds, kept as an exact
rational so a tempo map does not drift. An event lands on the first sample at or after its tick, which gives it a sample offset within
the frame. Each Tempo applies at its tick, and rounds to that sample.

Transport (play, stop, locate, loop range) is the engine's state, not the image's. A locate replays the streams silently from the
start, which chases held notes and parameters, and that is why the expanded size is limited.

### Mixer

A list of steps over bus registers, each one a stereo pair of frames, run in order.

Mixer step, 12 bytes:

| Offset | Type | Field | Meaning |
|---|---|---|---|
| 0 | u8 | `op` | 1 RunVoices, 2 RunInsert, 3 Gather |
| 1 | u8 | `reserved` | |
| 2 | u16 | `task` | steps with one task run together, in order |
| 4 | u16 | `a` | the track, the insert, or the first gather input |
| 6 | u16 | `dst` | the bus it writes |
| 8 | u16 | `src` | RunInsert: the input bus. Gather: how many inputs. RunVoices: 0. |
| 10 | u16 | `key` | RunInsert: the sidechain bus, or `0xFFFF`. Otherwise `0xFFFF`. |

- **RunVoices** renders a track's active voices, summed in voice order, into `dst`.
- **RunInsert** fills the patch's input ports from `src`, and from `key` if it has a second pair, runs its voice steps once, and writes
  its output to `dst`. It requires a patch with an input port, and with two if `key` is used. A `dst` may equal `src`.
- **Gather** sums its inputs into `dst`, in order. Each input is scaled by its two gain registers.

Gather input, 8 bytes: u16 `src`, u16 `gain_left`, u16 `gain_right`, u16 `reserved`. The gains are mix registers, so a fader move changes
nothing in the image.

The validator requires:

- `task` starts at 0, and each step's is the same as the last or one more.
- A bus may be read only after a step has written it. A step's own `dst` does not count, except that a RunInsert may overwrite its
  input. A Gather must not read its own `dst`.
- Each track and each insert is run by at most one step. Each step overwrites its `dst` without reading it.

Those rules make a mixer list order-independent. An instance's state is touched by exactly one step, so two tasks can only interact
through a bus register, and every read or write of one is stated in the list. An engine may therefore run tasks in any order that keeps
each register's reads and writes in sequence, on any number of threads, and it gets identical bits. All summing happens inside one step,
so no rounding depends on which task got there first.

### Output on a mono engine

An image has no channel count: an engine is built mono or stereo, and one image plays on both. A mono engine folds as it runs. A
stereo patch or insert output becomes `(left + right) / 2`, a Gather input's gain becomes `(left gain + right gain) / 2`, Pan writes `in / 2`
to both outputs, and Sample folds a stereo asset as it reads it. Mono output equals `(L + R) / 2` of a stereo render only for centred,
channel-symmetric mixes.

## 8. An example

The smallest project that makes a sound: one patch holding a constant, played by one track for one note. It is `golden/Minimal.image`,
and `tools/ReadImage.py --example` fails if these bytes stop being that file.

    4d 53 43 4b 00 01 00 00 30 00 00 00 00 00 00 00
    b2 e2 17 50 3e af ee 79 02 00 00 00 01 00 00 00
    00 00 00 00 00 00 00 00 97 17 55 00 e2 ed d8 8f
    34 00 00 00 03 01 00 00 85 47 11 7d 73 06 ec aa
    b0 00 00 00 04 01 00 00 4d 53 43 4b 03 01 00 00
    34 00 00 00 00 00 00 00 97 17 55 00 e2 ed d8 8f
    00 00 01 00 01 00 03 00 00 00 00 00 00 00 01 00
    00 00 00 00 00 20 00 20 00 00 00 00 00 00 00 3f
    01 00 00 00 00 00 00 00 00 20 00 00 00 a0 00 00
    00 00 00 00 00 00 00 00 4d 53 43 4b 04 01 00 00
    b0 00 00 00 00 00 00 00 85 47 11 7d 73 06 ec aa
    e0 01 00 00 20 a1 07 00 e0 01 00 00 04 00 00 00
    01 00 00 00 05 00 00 00 01 00 01 00 01 00 01 00
    00 00 02 00 01 00 02 00 02 00 00 00 00 00 01 00
    00 00 00 00 97 17 55 00 e2 ed d8 8f 01 00 01 00
    00 00 01 00 02 00 00 00 02 00 00 00 00 00 00 00
    00 00 00 00 02 00 00 00 e0 01 00 00 00 00 00 00
    01 00 00 00 00 00 00 00 00 00 ff ff 03 00 01 00
    00 00 01 00 01 00 ff ff 00 00 00 00 01 00 00 00
    f3 04 35 3f f3 04 35 3f 02 3c 64 00 f0 00 00 00
    01 00 00 00 e0 01 00 00 07 00 00 00 01 00 00 00
    00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00

Reading it:

- Bytes 0 to 23 are the manifest's header: the magic `MSCK`, kind 0, version 1, size `0x30`, and its hash. Bytes 24 to 39 are the
  manifest's header proper: 2 entries, 1 Program, revision 0. Then two entries of 16 bytes each.
- Byte 72 starts the Patch chunk, whose payload is 52 bytes: a 28-byte header with one voice step, one buffer, three voice scalars, one
  constant and both outputs `0x2000` (bank 1, buffer 0), then the constant `0x3F000000`, which is 0.5, and a Fill step. It is padded to 56
  bytes.
- Byte 152 starts the Program chunk. Its 52-byte header gives 480 ppq, 500,000 microseconds per quarter, a length of 480 ticks and a
  conductor at instruction 4, 1 long, within 5 instructions of code. The tables follow in section 7's order. The two mix registers hold
  `0x3F3504F3`, which is √½, because a centred track is equal-power. The code is a NoteOn and a Wait in the clip, then a Call and an End for
  the track, then the conductor's End.

## 9. Limits

| Name | Value | Applies to |
|---|---|---|
| `kMaxChunks` | 1024 | entries in a manifest, and patches in a Program |
| `kMaxRegisters` | 256 | buffers, voice scalars, track scalars and buses |
| `kMaxPatchSteps` | 4096 | control and voice steps together |
| `kMaxPatchParams` | 256 | |
| `kMaxPatchRefs` | 256 | |
| `kMaxPatchDelays` | 256 | |
| `kMaxPatchConsts` | 8192 | |
| `kMaxDelaySeconds` | 60 | one delay line |
| `kMaxTracks` | 256 | |
| `kMaxInserts` | 256 | |
| `kMaxVoices` | 256 | per track |
| `kMaxSlots` | 1024 | across a Program |
| `kMaxTrackSlots` | 256 | on one track |
| `kMaxClips` | 4096 | |
| `kMaxMixSteps` | 1024 | |
| `kMaxTasks` | 256 | |
| `kMaxGatherInputs` | 4096 | |
| `kMaxMixRegisters` | 8192 | |
| `kMaxGlobals` | 256 | |
| `kMaxInits` | 4096 | |
| `kMaxTicks` | 2^31 − 1 | a stream's total, a note, and a ramp |
| `kMaxExpanded` | 2^24 | a Program's instructions with every repeat unrolled |
| `kMaxZones` | 256 | rows in a zone table |
| `kMaxHeldNotes` | 16 | notes a track in mono or legato remembers |
| `kMaxGlideSeconds` | 60 | one glide |

These bound validation and sizing. The engine computes what a Program needs in 64 bits on every target, and the largest total these
limits allow cannot wrap. They do not bound what a frame costs: an image can pass all of them and still be too much for a device. A device
refuses that image by its own cost table, which its profile carries, as section 10 of `docs/Design.md` says. That is the device's check and not
the format's, so the same image still loads on an engine with no table.

## 10. Golden images

`golden/` holds images written at this freeze, `Waves` from revision 1, `Tones` from revision 2, frame 32 forms of four of them from revision 3, `Lanes` and `Zones` from revision 4, `Hold` from revision 5, `Mods` from revision 6, `Steals` from revision 7, and `Lines16` from revision 8, each with its render on a stereo and a mono engine. They are the
contract in executable form.

- A golden image and its render never change, and CI fails a pull request that edits or removes one.
- Every engine of an image's frame size, on every target, must load it and match its render within −100 dB of peak. An engine of another
  frame size must refuse it.
- Between them they must use every opcode, instruction and mixer step, and `GoldenTest` fails if a new one lacks a golden. A new
  revision adds new files alongside the old.
- A kernel may change only within that tolerance. A larger change is a different op with a new number.

An engine must be built without fused multiply-add contraction, which is `-ffp-contract=off`. Contraction changes rounding, and in a
resonant filter that alone reaches −100 dB. The CMake target `modsynth` sets it for you. With that, the arithmetic above and the scalar backend,
every target gives identical bits. −100 dB is what a backend such as CMSIS-DSP is allowed, whose kernels may order their sums differently.
