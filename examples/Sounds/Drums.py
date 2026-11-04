"""The drum kit: every GM percussion key, 35 to 81, from 23 sounds.

A drum is struck, so most of these ring out whatever their note's length, which in a GM file is often a few ticks: their
envelopes never sustain, and release as they decay. The exceptions are the long sounds of GM's choke groups (the open
hi-hat, long whistle, long guiro, open cuica and open triangle), which stop soon after their notes end, so that the next
note of their group can cut them off as a player's hand does. Pitched drums that serve several keys (the toms, bongos,
congas, timbales, agogo bells and wood blocks) are tuned by the key itself and never by the bend. Each sound's level puts
it where a real kit sits: kick and snare loudest, then the toms, the hats and cymbals a few dB under, and the small
percussion lower still. The pan places each piece as the drummer sees the kit, hats on the left and the floor tom on the
right.
"""

from GeneralMidi import DRUM_KIT
from Graph import Graph, Ref
from Instrument import Instrument, Voice

# The TR-808's six square oscillators, whose clangorous sum is the metal of its hats and cymbals.
METAL = (205.3, 304.4, 369.6, 522.7, 540.0, 800.0)


# Shared shapes --------------------------------------------------------------------------------------------------------


def strike(g: Graph, decay, attack: float = 0.0002) -> Ref:
    """An envelope that sounds the same however long its note is held: it never sustains, and its release is its decay."""
    return g.env(attack, decay, 0.0, decay)


def onset(g: Graph, rise, decay) -> Ref:
    """A strike that takes about `rise` to swell, as a shaker or a scrape does. An envelope's attack ends when its note
    does, which a note of a few ticks would cut short, so the swell is a quicker strike taken away from this one."""
    return g.mul(strike(g, decay), g.add(g.mul(strike(g, rise), -1.0), 1.0))


def force(v: Voice, floor: float = 0.08) -> Ref:
    """Velocity as a level: about 10 dB down at velocity 64 and 22 dB at 1, as a drum is struck softer."""
    g = v.g
    return g.add(g.mul(g.mul(v.velocity, v.velocity), 1.0 - floor), floor)


def times(g: Graph, a, b: float):
    """a times b, as a number when a is one, so that a fixed tuning needs no node."""
    return a * b if isinstance(a, (int, float)) else g.mul(a, b)


def keyed(g: Graph, key: Ref, first: int, at, per_key) -> Ref:
    """A value that is `at` on the key `first` and moves by `per_key` for each key from it."""
    return g.add(g.mul(g.add(key, -float(first)), per_key), at)


def held(g: Graph, v: Voice, low: int, high: int) -> Ref:
    """The key, kept to the keys a drum is written for, so that a keyboard playing it anywhere gets the nearest of its
    drums rather than a tone above hearing, or a ring too short to hear."""
    return g.node(
        "math", {"a": v.key.pitch, "b": float(low), "c": float(high)}, mode="clip"
    )


def is_key(g: Graph, key: Ref, note: int) -> Ref:
    """1 on one key and 0 on every other."""
    above = g.node("math", {"a": key, "b": note - 0.5}, mode="compare")
    past = g.node("math", {"a": key, "b": note + 0.5}, mode="compare")
    return g.add(above, g.mul(past, -1.0))


def pick(g: Graph, flag: Ref, yes, no) -> Ref:
    """`yes` where the flag is 1 and `no` where it is 0."""
    return g.node("math", {"a": flag, "b": yes, "c": no}, mode="select")


def bright(g: Graph, v: Voice, soft: float, hard: float, top: float = 16000.0) -> Ref:
    """A cutoff that moves from `soft` to `hard` as the drum is struck harder, kept well below the top of the band."""
    return g.node(
        "math", {"a": g.add(g.mul(v.velocity, hard - soft), soft), "b": top}, mode="min"
    )


def placed(g: Graph, sound: Ref, position) -> tuple[Ref, Ref]:
    """A mono sound placed in the kit. Pan halves a centred sound, which the generator's gain makes up."""
    p = g.node("pan", {"in": sound, "position": position})
    return p.l, p.r


def metal(g: Graph, scale=1.0, freqs=METAL) -> Ref:
    """Band-limited squares at inharmonic ratios, the clang a hat or cymbal is filtered from."""
    total = None
    for f in freqs:
        wave = g.osc("square", times(g, scale, f))
        total = wave if total is None else g.add(total, wave)
    return g.mul(total, 1.0 / len(freqs))


def tones(g: Graph, f, ratios) -> Ref:
    """Sines at fixed ratios to f, at their levels: a bar's or a bell's modes. A fixed sine holds the frequency its note
    started with, which a struck drum's modes do, and starts on the note's own sample, so every strike starts alike."""
    total = None
    for ratio, level in ratios:
        tone = g.osc("sine", times(g, f, ratio), mode="fixed")
        tone = tone if level == 1.0 else g.mul(tone, level)
        total = tone if total is None else g.add(total, tone)
    return total


def membrane(g: Graph, f: Ref, ring, ratio: float, level: float, fade: float) -> Ref:
    """A drumhead: its fundamental, and the next mode up, which dies `fade` times sooner."""
    head = g.mul(g.osc("sine", f), strike(g, ring, 0.0005))
    upper = g.mul(g.osc("sine", g.mul(f, ratio)), strike(g, times(g, ring, 1.0 / fade)))
    return g.add(head, g.mul(upper, level))


# The kit --------------------------------------------------------------------------------------------------------------


def kick(v: Voice) -> Ref:
    """A bass drum: a sine whose pitch falls from the beater's slap to the shell's boom, a felt click, and a little
    drive. The acoustic bass drum, key 35, is tuned three semitones down and booms longer."""
    g = v.g
    k = held(g, v, 35, 36)
    settle = g.mtof(keyed(g, k, 36, 31.0, 3.0))  # 49 Hz on key 36
    fall = g.snap(strike(g, 0.028))
    sweep = g.add(g.mul(fall, g.add(g.mul(v.velocity, 1.0), 1.4)), 1.0)
    body = g.mul(
        g.osc("sine", g.mul(settle, sweep)),
        strike(g, keyed(g, k, 36, 0.12, -0.05), 0.0004),
    )
    body = g.add(g.mul(body, 1.25), g.mul(g.mul(g.mul(body, body), body), -0.4))
    click = g.filter("bandpass", g.node("noise"), bright(g, v, 1800.0, 4500.0), 0.9)
    click = g.mul(click, g.mul(strike(g, 0.004), g.add(g.mul(v.velocity, 0.5), 0.12)))
    return g.filter("highpass", g.mul(g.add(body, click), force(v)), 24.0)


def snare(v: Voice) -> Ref:
    """A snare: a shell whose pitch drops as it is struck, and the wires' hiss, brighter the harder it is hit. The
    electric snare, key 40, is tuned higher, tighter and brighter, as a drum machine's is."""
    g = v.g
    k = held(g, v, 38, 40)
    f = g.mtof(keyed(g, k, 38, 53.0, 2.0))  # 175 Hz on key 38
    shell_f = g.mul(f, g.add(g.mul(g.snap(strike(g, 0.012)), 0.6), 1.0))
    shell = g.add(
        g.osc("triangle", shell_f), g.mul(g.osc("sine", g.mul(shell_f, 1.58)), 0.5)
    )
    shell = g.mul(shell, strike(g, keyed(g, k, 38, 0.055, -0.008), 0.0004))
    hiss = g.filter("highpass", g.node("noise"), keyed(g, k, 38, 900.0, 350.0))
    hiss = g.filter("lowpass", hiss, bright(g, v, 3500.0, 11000.0), 0.6)
    hiss = g.add(hiss, g.mul(g.filter("bandpass", hiss, 5200.0, 1.2), 0.6))
    wires = strike(g, keyed(g, k, 38, 0.14, -0.02), 0.0008)
    sound = g.add(g.mul(shell, 0.9), g.mul(g.mul(hiss, wires), 1.4))
    return g.filter("highpass", g.mul(sound, force(v)), 60.0)


def side_stick(v: Voice) -> Ref:
    """The stick laid across the snare and its rim struck: a hollow wooden knock and a click, with no wires."""
    g = v.g
    knock = g.add(
        g.mul(tones(g, 410.0, ((1.0, 1.0), (2.43, 0.55))), strike(g, 0.032)),
        g.mul(tones(g, 410.0, ((4.1, 0.3),)), strike(g, 0.016)),
    )
    click = g.filter("bandpass", g.node("noise"), bright(g, v, 2200.0, 4200.0), 1.4)
    sound = g.add(knock, g.mul(g.mul(click, strike(g, 0.005)), 0.6))
    return g.filter("highpass", g.mul(sound, force(v)), 120.0)


def clap(v: Voice) -> Ref:
    """Hands clapped: three quick bursts of noise as the hands meet unevenly, then the room's short tail. The Clap
    recipe's shape, its band opening a little with a harder clap."""
    g = v.g
    burst = strike(g, 0.006, 0.0003)
    second = g.node("delay", {"in": burst, "time": 0.0105}, max=0.012)
    third = g.node("delay", {"in": burst, "time": 0.0215}, max=0.025)
    tail = g.node("delay", {"in": strike(g, 0.1, 0.0003), "time": 0.032}, max=0.04)
    shape = g.add(g.add(g.add(burst, g.mul(second, 0.8)), g.mul(third, 0.7)), tail)
    band = g.filter("bandpass", g.node("noise"), bright(g, v, 1100.0, 1700.0), 1.2)
    band = g.add(band, g.mul(g.filter("highpass", band, 2500.0), 0.6))
    return g.mul(g.mul(band, shape), force(v))


def toms(v: Voice) -> tuple[Ref, Ref]:
    """A tom, tuned by its key from the low floor tom, 41, up to the high tom, 50: a membrane whose pitch sags as it
    rings, a mode a fifth and a bit above that dies first, and the stick. The shape of timpani(), on a smaller shell."""
    g = v.g
    k = held(g, v, 38, 53)
    pitch = keyed(g, k, 41, 40.0, 1.5)  # 82 Hz on key 41 to 175 Hz on key 50
    sag = g.mul(g.snap(strike(g, 0.07)), g.add(g.mul(v.velocity, 1.4), 1.0))
    f = g.mtof(g.add(pitch, sag))
    ring = keyed(g, k, 41, 0.32, -0.017)  # The floor tom rings longest
    head = g.add(
        membrane(g, f, ring, 1.59, 0.35, 3.0),
        g.mul(g.osc("sine", g.mul(f, 2.14)), strike(g, 0.05)),
    )
    stick = g.filter("lowpass", g.node("noise"), bright(g, v, 1200.0, 4000.0))
    sound = g.add(head, g.mul(g.mul(stick, strike(g, 0.012)), 0.35))
    sound = g.filter("highpass", g.mul(sound, force(v)), 30.0)
    # The high toms on the left and the floor tom on the right.
    return placed(g, sound, keyed(g, k, 41, 0.3, -0.067))


def hi_hat(v: Voice) -> tuple[Ref, Ref]:
    """A hi-hat: the 808's metal and some noise, high-passed. Closed, 42, it is a tick, the pedal, 44, a softer chick,
    and open, 46, it rings until its note ends, when it stops as the hats close."""
    g = v.g
    k = held(g, v, 42, 46)
    opened = g.node("math", {"a": k, "b": 45.0}, mode="compare")
    pedal = is_key(g, k, 44)
    decay = g.add(g.add(g.mul(opened, 0.42), g.mul(pedal, -0.008)), 0.032)
    # Closed and pedal hats ring their own short way out. An open one closes within 20 ms of its note's end.
    shut = g.env(0.0003, decay, 0.0, pick(g, opened, 0.02, decay))
    noise = g.node("noise")
    # The metal and the noise about equal, the metal's clang over the noise's hiss.
    clang = g.add(
        g.mul(g.filter("bandpass", metal(g), 9000.0, 1.0), 4.0), g.mul(noise, 0.35)
    )
    hat = g.filter("highpass", clang, g.add(g.mul(pedal, -1500.0), 6000.0))
    hat = g.filter("lowpass", hat, bright(g, v, 9000.0, 18000.0, 17000.0))
    chick = g.mul(g.filter("bandpass", noise, 3200.0, 1.5), pedal)
    sound = g.mul(g.add(hat, g.mul(chick, 0.4)), shut)
    level = g.mul(force(v), g.add(g.mul(pedal, -0.35), 1.0))
    return placed(g, g.mul(sound, level), -0.3)


def crash(v: Voice) -> Ref:
    """The Grieg's cymbal(), from MakePieces.py, as it was: high noise that takes seconds to die, whatever key plays it.
    Its release is a long one, so a note of a few ticks still rings, and its velocity is the original's straight line,
    6 dB down at 64 where the rest of the kit is 10, so that the Hall of the Mountain King keeps its crashes."""
    g = v.g
    hiss = g.filter("highpass", g.node("noise"), 5000.0)
    hiss = g.add(hiss, g.mul(g.filter("bandpass", hiss, 9000.0, 0.6), 0.8))
    return g.mul(g.mul(hiss, g.env(0.001, 3.0, 0.0, 1.5)), g.mul(v.key.velocity, 0.25))


def ride(v: Voice) -> tuple[Ref, Ref]:
    """A ride: the stick's ping on the bow over a wash that builds and lasts. The ride bell, 53, is the cup struck: the
    same three partials tuned down to a clear bell, and little wash. Ride cymbal 2, 59, is a smaller ride, a tone up."""
    g = v.g
    k = held(g, v, 51, 59)
    bell = is_key(g, k, 53)
    # The bow's partials from 1.9 kHz, a quarter tone higher a key, so ride 2 is a tone up; the bell's from 720 Hz.
    f = g.mtof(pick(g, bell, 77.5, keyed(g, k, 51, 94.3, 0.25)))
    ring = pick(g, bell, 1.1, 0.45)
    ping = g.add(
        g.mul(tones(g, f, ((1.0, 0.7), (1.47, 1.0))), strike(g, ring)),
        g.mul(g.osc("sine", g.mul(f, 2.09), mode="fixed"), strike(g, g.mul(ring, 0.6))),
    )
    # The wash is four of the 808's squares and noise through one band, about equal.
    raw = g.add(metal(g, 1.7, METAL[:4]), g.mul(g.node("noise"), 0.3))
    wash = g.mul(g.filter("bandpass", raw, 7500.0, 0.9), 2.0)
    # The wash swells over a few milliseconds, as onset() does, and the stick's tick is what it swells from.
    tick = strike(g, 0.004)
    swell = g.mul(strike(g, 1.0), g.add(g.mul(tick, -1.0), 1.0))
    sheen = g.add(g.mul(swell, g.add(g.mul(bell, -0.3), 0.45)), g.mul(tick, 0.25))
    sound = g.add(g.mul(ping, g.add(g.mul(bell, 0.25), 0.6)), g.mul(wash, sheen))
    return placed(g, g.mul(sound, force(v)), 0.35)


def china(v: Voice) -> tuple[Ref, Ref]:
    """A Chinese cymbal: a trashy, mid-heavy crash with an upturned edge's growl, that dies sooner than a crash."""
    g = v.g
    clang = g.filter("highpass", metal(g, 1.35), 1800.0)
    hiss = g.filter("bandpass", g.node("noise"), bright(g, v, 3000.0, 4500.0), 0.7)
    raw = g.add(g.mul(clang, 1.6), hiss)
    trash = g.add(g.mul(raw, 1.5), g.mul(g.mul(g.mul(raw, raw), raw), -0.5))
    sound = g.mul(g.filter("highpass", trash, 1500.0), strike(g, 0.75, 0.0005))
    return placed(g, g.mul(sound, force(v)), 0.45)


def splash(v: Voice) -> tuple[Ref, Ref]:
    """A second cymbal, of metal rather than the crash's noise: crash cymbal 2, 57, a darker crash for the other side of
    the kit, and the splash, 55, a small bright one that is gone in a second or two."""
    g = v.g
    k = held(g, v, 55, 57)
    # 0 on the crash and 1 on the splash.
    small = g.mul(g.add(g.mul(k, -1.0), 57.0), 0.5)
    clang = metal(g, g.add(g.mul(small, 0.35), 1.0))
    sound = g.filter("bandpass", clang, g.add(g.mul(small, 3500.0), 6500.0), 0.7)
    sound = g.add(g.mul(sound, 3.0), g.mul(g.node("noise"), 0.25))
    sound = g.filter("highpass", sound, g.add(g.mul(small, 1500.0), 3500.0))
    sound = g.filter("lowpass", sound, bright(g, v, 9000.0, 16000.0))
    sound = g.mul(sound, strike(g, g.add(g.mul(small, -1.0), 1.3), 0.0008))
    return placed(g, g.mul(sound, force(v)), 0.4)


def tambourine(v: Voice) -> Ref:
    """A tambourine shaken and struck: high jingles, and a second rattle as they fall back."""
    g = v.g
    jingles = g.filter("bandpass", g.node("noise"), 8200.0, 1.6)
    jingles = g.add(
        jingles, g.mul(g.filter("bandpass", metal(g, 2.5), 10500.0, 2.0), 4.0)
    )
    back = g.node("delay", {"in": strike(g, 0.09, 0.0005), "time": 0.028}, max=0.03)
    sound = g.mul(jingles, g.add(strike(g, 0.07, 0.0005), g.mul(back, 0.6)))
    sound = g.filter("highpass", sound, bright(g, v, 6500.0, 4500.0))
    return g.mul(sound, force(v))


def cowbell(v: Voice) -> Ref:
    """A cowbell: two square tones a fifth and a bit apart through the bell's band, a clank that falls quickly to a
    short ring."""
    g = v.g
    pair = g.add(g.osc("square", 562.0), g.mul(g.osc("square", 845.0), 0.8))
    bell = g.add(
        g.filter("bandpass", pair, 900.0, 1.8),
        g.mul(g.filter("bandpass", pair, 2600.0, 2.0), 0.6),
    )
    shape = g.add(
        g.mul(strike(g, 0.025, 0.0003), 0.65), g.mul(strike(g, 0.2, 0.0003), 0.35)
    )
    return g.mul(g.mul(bell, shape), force(v))


def vibraslap(v: Voice) -> Ref:
    """A vibraslap: the ball struck, and the teeth rattling in their wooden box, slowing as they settle."""
    g = v.g
    settle = strike(g, 0.25, 0.001)
    teeth = g.osc("square", g.add(g.mul(g.snap(settle), 9.0), 21.0), width=0.06)
    rattle = g.add(
        g.filter("bandpass", teeth, 2900.0, 7.0),
        g.mul(g.filter("bandpass", teeth, 1350.0, 5.0), 0.7),
    )
    slap = g.mul(g.filter("bandpass", g.node("noise"), 900.0, 1.0), strike(g, 0.01))
    sound = g.add(g.mul(rattle, settle), g.mul(slap, 0.5))
    return g.filter("highpass", g.mul(sound, force(v)), 300.0)


def bongos(v: Voice) -> tuple[Ref, Ref]:
    """A pair of bongos, the high one, 60, and the low, 61: small tight heads, a short ring and a finger's slap."""
    g = v.g
    k = held(g, v, 60, 61)
    pitch = keyed(g, k, 60, 67.0, -5.0)  # 392 Hz high and 294 Hz low
    f = g.mtof(g.add(pitch, g.mul(g.snap(strike(g, 0.02)), 1.2)))
    head = membrane(g, f, keyed(g, k, 60, 0.085, 0.02), 1.52, 0.3, 2.5)
    slap = g.filter("bandpass", g.node("noise"), bright(g, v, 1500.0, 3200.0), 1.0)
    sound = g.add(head, g.mul(g.mul(slap, strike(g, 0.007)), 0.45))
    sound = g.filter("highpass", g.mul(sound, force(v)), 80.0)
    return placed(g, sound, keyed(g, k, 60, -0.25, 0.1))


def congas(v: Voice) -> tuple[Ref, Ref]:
    """Congas: the high drum open, 63, and muted with the other hand, 62, a short high slap, and the low tumba, 64."""
    g = v.g
    k = held(g, v, 62, 64)
    muted = is_key(g, k, 62)
    # 226 Hz open, 262 Hz muted and 165 Hz low. The muted drum's hand stops it in a third of the time.
    pitch = g.add(keyed(g, k, 63, 57.5, -5.0), g.mul(muted, -2.5))
    f = g.mtof(g.add(pitch, g.snap(strike(g, 0.03))))
    ring = g.mul(keyed(g, k, 63, 0.17, 0.07), g.add(g.mul(muted, -0.65), 1.0))
    head = membrane(g, f, ring, 1.47, 0.3, 2.2)
    slap = g.filter("bandpass", g.node("noise"), bright(g, v, 1200.0, 2600.0), 1.0)
    slap = g.mul(slap, g.mul(strike(g, 0.009), g.add(g.mul(muted, 0.6), 0.35)))
    sound = g.filter("highpass", g.mul(g.add(head, slap), force(v)), 60.0)
    return placed(g, sound, keyed(g, k, 63, 0.2, 0.08))


def timbales(v: Voice) -> tuple[Ref, Ref]:
    """Timbales, high, 65, and low, 66: thin heads on metal shells, struck with sticks, bright and ringing."""
    g = v.g
    k = held(g, v, 65, 66)
    # 415 Hz high and 311 Hz low, a little sharp at the strike.
    f = g.mtof(g.add(keyed(g, k, 65, 68.0, -5.0), g.mul(g.snap(strike(g, 0.015)), 0.8)))
    head = g.add(
        membrane(g, f, 0.3, 1.59, 0.55, 2.0),
        g.mul(g.osc("sine", g.mul(f, 2.14)), g.mul(strike(g, 0.1), 0.4)),
    )
    noise = g.node("noise")
    shell = g.mul(g.filter("bandpass", noise, 3400.0, 3.0), strike(g, 0.12))
    stick = g.mul(
        g.filter("highpass", noise, bright(g, v, 2000.0, 5000.0)), strike(g, 0.004)
    )
    sound = g.add(head, g.add(g.mul(shell, 0.6), g.mul(stick, 0.4)))
    sound = g.filter("highpass", g.mul(sound, force(v)), 120.0)
    return placed(g, sound, keyed(g, k, 65, -0.15, 0.1))


def agogo(v: Voice) -> tuple[Ref, Ref]:
    """Agogo bells, high, 67, and low, 68: two small cones struck with a stick, clear and a little clangy."""
    g = v.g
    k = held(g, v, 67, 68)
    f = g.mtof(keyed(g, k, 67, 83.0, -5.0))  # 988 Hz high and 740 Hz low
    bell = g.add(
        g.mul(tones(g, f, ((1.0, 1.0), (2.76, 0.35))), strike(g, 0.22)),
        g.mul(tones(g, f, ((5.4, 0.15), (8.9, 0.06))), strike(g, 0.06)),
    )
    stick = g.mul(g.filter("highpass", g.node("noise"), 3500.0), strike(g, 0.003))
    sound = g.add(bell, g.mul(stick, bright(g, v, 0.15, 0.4)))
    return placed(g, g.mul(sound, force(v)), keyed(g, k, 67, -0.1, 0.15))


def shaker(v: Voice) -> Ref:
    """Beads and seeds shaken: the cabasa, 69, a scrape of metal beads that swells and is gone, and the maracas, 70,
    shorter and higher."""
    g = v.g
    # 0 on the cabasa and 1 on the maracas.
    seeds = g.add(held(g, v, 69, 70), -69.0)
    noise = g.node("noise")
    band = g.filter("bandpass", noise, g.add(g.mul(seeds, 1800.0), 6200.0), 1.3)
    band = g.add(
        band,
        g.mul(g.filter("bandpass", noise, 9500.0, 3.0), g.add(g.mul(seeds, -0.5), 0.6)),
    )
    sound = g.filter("highpass", band, g.add(g.mul(seeds, 1500.0), 3000.0))
    shape = onset(
        g, g.add(g.mul(seeds, -0.003), 0.0045), g.add(g.mul(seeds, -0.016), 0.045)
    )
    return g.mul(g.mul(sound, shape), force(v))


def whistle(v: Voice) -> Ref:
    """A samba whistle, its pea rattling the tone: a short blast, 71, and a long one, 72, that stops when its note
    ends."""
    g = v.g
    # 1 on the long whistle, 0 on the short. The pea's trill wobbles its pitch, 2.6 kHz short and 2.5 kHz long.
    long = g.add(held(g, v, 71, 72), -71.0)
    trill = g.node("lfo", {"rate": 46.0, "depth": 0.45})
    f = g.mtof(g.add(g.add(g.mul(long, -1.5), 100.0), trill))
    tone = g.add(g.osc("sine", f), g.mul(g.osc("sine", g.mul(f, 2.0)), 0.06))
    breath = g.mul(g.filter("bandpass", g.node("noise"), f, 5.0), 0.35)
    blow = g.env(0.0001, pick(g, long, 0.9, 0.07), 0.0, pick(g, long, 0.03, 0.07))
    swell = g.add(g.mul(strike(g, 0.005), -1.0), 1.0)
    # The trill moves the level too. An LFO is read once a frame, so this is kept shallow, where its steps don't buzz.
    flutter = g.add(g.mul(trill, 0.3), 1.0)
    sound = g.mul(g.mul(g.add(tone, breath), g.mul(blow, swell)), flutter)
    return g.mul(sound, force(v))


def guiro(v: Voice) -> Ref:
    """A guiro, its ridges scraped with a stick: a quick flick, 73, and a long scrape, 74, that stops when its note
    ends."""
    g = v.g
    # 1 on the long scrape, slower over the ridges, and 0 on the flick. The stick slows as the scrape goes on.
    long = g.add(held(g, v, 73, 74), -73.0)
    speed = g.add(g.mul(g.snap(strike(g, 0.12)), 0.4), 1.0)
    ridges = g.osc("square", g.mul(pick(g, long, 52.0, 85.0), speed), width=0.12)
    rasp = g.add(
        g.mul(ridges, 0.7), g.mul(g.node("noise"), g.add(g.mul(ridges, 0.5), 0.5))
    )
    gourd = g.add(
        g.filter("bandpass", rasp, 3100.0, 2.5),
        g.mul(g.filter("bandpass", rasp, 1250.0, 2.0), 0.5),
    )
    scrape = g.env(0.0001, pick(g, long, 0.4, 0.05), 0.0, pick(g, long, 0.035, 0.05))
    swell = g.add(g.mul(strike(g, 0.012), -1.0), 1.0)
    sound = g.mul(gourd, g.mul(scrape, swell))
    return g.filter("highpass", g.mul(sound, force(v)), 400.0)


def wood_block(v: Voice) -> tuple[Ref, Ref]:
    """Wood blocks, high, 76, and low, 77, a hollow knock, and the claves, 75, two hardwood sticks, higher and purer."""
    g = v.g
    k = held(g, v, 75, 77)
    claves = g.node("math", {"a": 75.5, "b": k}, mode="compare")
    # 1175 Hz high, 740 Hz low and 1865 Hz on the claves, which ring longer and click less.
    f = g.mtof(keyed(g, k, 76, 86.0, -8.0))
    ring = g.add(g.mul(claves, 0.02), 0.05)
    knock = g.add(
        g.mul(g.osc("sine", f, mode="fixed"), strike(g, ring)),
        g.mul(g.osc("sine", g.mul(f, 2.68), mode="fixed"), strike(g, g.mul(ring, 0.4))),
    )
    click = g.mul(g.filter("bandpass", g.node("noise"), 3500.0, 1.0), strike(g, 0.003))
    sound = g.add(knock, g.mul(click, g.add(g.mul(claves, -0.24), 0.36)))
    sound = g.filter("highpass", g.mul(sound, force(v)), 200.0)
    return placed(g, sound, keyed(g, k, 76, -0.2, 0.15))


def cuica(v: Voice) -> Ref:
    """A cuica, the stick inside rubbed: a muted squeak, 78, and the open whoop, 79, that stops when its note ends."""
    g = v.g
    # 1 on the open cuica, an octave below the muted one: 831 Hz muted and 415 Hz open. Its pitch rises and falls back
    # as the rubbing hand pulls, which the difference of a slow and a quick strike draws.
    opened = g.add(held(g, v, 78, 79), -78.0)
    hump = g.add(strike(g, 0.09), g.mul(strike(g, 0.025), -1.0))
    pitch = g.add(g.mul(opened, -12.0), 80.0)
    f = g.mtof(g.add(pitch, g.mul(g.snap(hump), g.add(g.mul(opened, 3.0), 2.0))))
    voice = g.add(g.osc("sine", f), g.mul(g.osc("triangle", g.mul(f, 2.0)), 0.25))
    voice = g.filter("bandpass", voice, g.mul(f, 1.5), 0.9)
    rub = g.env(0.0001, pick(g, opened, 0.3, 0.06), 0.0, pick(g, opened, 0.04, 0.06))
    swell = g.add(g.mul(strike(g, 0.008), -1.0), 1.0)
    return g.mul(g.mul(voice, g.mul(rub, swell)), force(v))


def triangle(v: Voice) -> tuple[Ref, Ref]:
    """A triangle: a steel bar's high, inharmonic ring. Muted by the hand, 80, it is a tink. Open, 81, it rings until its
    note ends."""
    g = v.g
    # 1 on the open triangle. Its upper partials die first, and muted, or let go when open, all of it stops.
    opened = g.add(held(g, v, 80, 81), -80.0)
    ring = pick(g, opened, 1.6, 0.06)
    upper = g.mul(ring, 0.55)
    low = g.env(0.0002, ring, 0.0, pick(g, opened, 0.04, ring))
    high = g.env(0.0002, upper, 0.0, pick(g, opened, 0.04, upper))
    bar = g.add(
        g.mul(tones(g, 1180.0, ((1.0, 0.4), (2.71, 1.0))), low),
        g.mul(tones(g, 1180.0, ((4.57, 0.8), (6.34, 0.6), (7.95, 0.4))), high),
    )
    tick = g.mul(g.filter("highpass", g.node("noise"), 4000.0), strike(g, 0.002))
    sound = g.add(bar, g.mul(tick, 0.3))
    return placed(g, g.mul(sound, force(v)), -0.2)


def drum(name, title, build, keys, level, listen_for, gated=False) -> Instrument:
    """A sound of the kit, written for its keys and no others."""
    return Instrument(
        name=name,
        title=title,
        family=DRUM_KIT,
        build=build,
        low=min(keys),
        high=max(keys),
        keys=keys,
        level=level,
        gated=gated,
        listen_for=listen_for,
    )


# The kit track's slots, in this order, the kick first. A drum is measured at its first key.
INSTRUMENTS = [
    drum(
        "KitKick",
        "Kick drum",
        kick,
        [36, 35],
        0.0,
        "A punchy kick whose pitch falls into a short boom, with a felt click.",
    ),
    drum(
        "KitSnare",
        "Snare drum",
        snare,
        [38, 40],
        0.0,
        "A snare's crack and the hiss of its wires; key 40 tighter and brighter.",
    ),
    drum(
        "KitSideStick",
        "Side stick",
        side_stick,
        [37],
        -7.0,
        "A hollow wooden click of the stick across the rim.",
    ),
    drum(
        "KitClap",
        "Hand clap",
        clap,
        [39],
        -3.0,
        "Three quick bursts of a clap and a short tail.",
    ),
    drum(
        "KitToms",
        "Toms",
        toms,
        [45, 41, 43, 47, 48, 50],
        -2.0,
        "Six toms from a deep floor tom to a high rack tom, each sagging in pitch as it rings.",
    ),
    drum(
        "KitHiHat",
        "Hi-hat",
        hi_hat,
        [42, 44, 46],
        -5.0,
        "A tight closed hat, a soft pedal chick, and an open hat that rings until the next closes it.",
        gated=True,
    ),
    drum(
        "KitCrash",
        "Crash cymbal",
        crash,
        [49],
        -3.0,
        "A wash of high noise that takes seconds to die.",
    ),
    drum(
        "KitRide",
        "Ride cymbal",
        ride,
        [51, 59, 53],
        -6.0,
        "A ping on a sustained wash, and the bell's clear ring.",
    ),
    drum(
        "KitChina",
        "Chinese cymbal",
        china,
        [52],
        -6.0,
        "A trashy, growling crash that dies sooner.",
    ),
    drum(
        "KitSplash",
        "Splash and second crash",
        splash,
        [57, 55],
        -4.0,
        "A darker metallic crash, and a small bright splash.",
    ),
    drum(
        "KitTambourine",
        "Tambourine",
        tambourine,
        [54],
        -9.0,
        "A bright jingle and its rattle.",
    ),
    drum("KitCowbell", "Cowbell", cowbell, [56], -8.0, "A clanking cowbell."),
    drum(
        "KitVibraslap",
        "Vibraslap",
        vibraslap,
        [58],
        -10.0,
        "A rattle that slows as it settles.",
    ),
    drum("KitBongos", "Bongos", bongos, [60, 61], -7.0, "Two small, tight hand drums."),
    drum(
        "KitCongas",
        "Congas",
        congas,
        [63, 62, 64],
        -6.0,
        "An open conga, its muted slap, and the low tumba.",
    ),
    drum(
        "KitTimbales",
        "Timbales",
        timbales,
        [65, 66],
        -7.0,
        "Two bright, ringing metal-shelled drums.",
    ),
    drum(
        "KitAgogo",
        "Agogo bells",
        agogo,
        [67, 68],
        -9.0,
        "Two clear, slightly clangy bells a fourth apart.",
    ),
    drum(
        "KitShaker",
        "Cabasa and maracas",
        shaker,
        [69, 70],
        -11.0,
        "A scrape of beads, and a shorter shake of seeds.",
    ),
    drum(
        "KitWhistle",
        "Samba whistle",
        whistle,
        [71, 72],
        -10.0,
        "A trilling whistle, short or held.",
        gated=True,
    ),
    drum(
        "KitGuiro",
        "Guiro",
        guiro,
        [73, 74],
        -10.0,
        "A scraped gourd, a flick or a long scrape.",
        gated=True,
    ),
    drum(
        "KitWoodBlock",
        "Wood blocks and claves",
        wood_block,
        [76, 77, 75],
        -8.0,
        "Two hollow knocks and a higher, purer click.",
    ),
    drum(
        "KitCuica",
        "Cuica",
        cuica,
        [78, 79],
        -10.0,
        "A squeak, and a whoop that rises and falls.",
        gated=True,
    ),
    drum(
        "KitTriangle",
        "Triangle",
        triangle,
        [80, 81],
        -11.0,
        "A tink, and a long high ring.",
        gated=True,
    ),
]
