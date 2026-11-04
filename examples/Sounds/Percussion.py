"""The percussive programs, 112 to 119, and the sound effects, 120 to 127: metal struck and left to ring, drums tuned
by the key, a cymbal played backwards, and noises shaped into surf, rotors, crowds and shots.

GM plays all of these on ordinary channels, so each is pitched by its key and bent by the wheel: a file can play a tune
on the steel drums, or a lower helicopter. Where a noise has no pitch, the key moves its filters and its rhythm instead,
as transposing a recording would.
"""

from Graph import Graph, Ref
from Instrument import Instrument, Voice

PERCUSSIVE = "Percussive"
NOISES = "Sound effects"  # Not EFFECTS, which the generator reads as a module's list of effects
RATE = 48000.0  # The rate the applause's clap density is worked out at. At another rate the crowd is a little thinner.


# Helpers ------------------------------------------------------------------------------------------------------------


def clip(g: Graph, x, low: float, high: float) -> Ref:
    return g.node("math", {"a": x, "b": low, "c": high}, mode="clip")


def strength(g: Graph, velocity: Ref, floor: float) -> Ref:
    """How loud a velocity plays: `floor` at the softest, 1 at the hardest, on a square law, so velocity 64 is about
    10 dB under 127 and velocity 1 is never silent."""
    return g.add(g.mul(g.mul(velocity, velocity), 1.0 - floor), floor)


def audible(g: Graph, freq: Ref) -> Ref:
    """A partial's gain: 1 up to 15 kHz and 0 by 19 kHz. A high note's upper partials fade out before they reach half the
    sample rate, where an oscillator would hold them and they would fold back."""
    return clip(g, g.mul(g.add(freq, -19000.0), -1.0 / 4000.0), 0.0, 1.0)


def keyed(g: Graph, pitch: Ref, seconds: float, at: int) -> Ref:
    """`seconds` at note `at`, twice as long two octaves down and half as long two octaves up, as struck things ring."""
    return g.mul(
        g.node("ratio", {"in": g.add(g.mul(pitch, -0.5), 60.0 + 0.5 * at)}, root=60),
        seconds,
    )


def octaves(g: Graph, pitch: Ref, rate: float = 1.0) -> Ref:
    """2 to the power of the octaves the key is from middle C, times `rate`: a ratio to move a filter or a rhythm by."""
    return g.node(
        "ratio", {"in": g.add(g.mul(pitch, rate), 60.0 * (1.0 - rate))}, root=60
    )


def tracked(
    g: Graph,
    pitch: Ref,
    hz: float,
    low: float = 40.0,
    high: float = 16000.0,
    rate: float = 1.0,
) -> Ref:
    """`hz` at middle C, moved with the key and held between `low` and `high`: a noise's filter, so that a higher key
    plays it higher and no key takes it past what the filter can do."""
    return clip(g, g.mul(octaves(g, pitch, rate), hz), low, high)


def tilt(
    g: Graph, pitch: Ref, rate: float = -0.5, top: float = 96.0, bottom: float = 0.0
) -> Ref:
    """3 dB less for every octave the key is above middle C, and more below, within limits, or `rate` times 6 dB. Moving
    a noise's filters up lets more of it through, and the ear weighs the top more, so without this a high key is far
    louder than a low one. Above `top` the filters have reached their limits and move no further, so neither does this,
    and below `bottom` it would only make a click louder."""
    return clip(g, octaves(g, clip(g, pitch, bottom, top), rate), 0.1, 4.0)


def mix(g: Graph, parts: list[Ref]) -> Ref:
    total = parts[0]
    for part in parts[1:]:
        total = g.add(total, part)
    return total


# Percussive ---------------------------------------------------------------------------------------------------------

# Each is (its ratio to the key, its level, how much of that level velocity gives it).
Partials = list[tuple[float, float, float]]


def metal(
    groups: list[tuple[float, float, Partials]],
    at: int,
    release: float,
    beat: float,
    tick: float,
    tick_hz: float | None,
):
    """Struck metal: sines at the ratios of its modes, the high ones dying first, so the strike is bright and the ring
    mellow. Each group of partials shares an envelope, (attack, seconds it rings at note `at`, partials), and a hard
    strike rings the upper ones more, so a loud note is brighter as well as louder. A slow attack is a mode that blooms
    after the strike, as a pan's octave does. `beat` is a twin of the lowest a few Hz away, the slow shimmer of a bell
    whose round isn't quite true. `tick` is the hammer's click, noise high-passed at `tick_hz` at middle C, or left as it
    is, which suits a hard hammer on a small bell. It damps over `release` when the key comes up, as a hand on a bell
    does."""

    def build(v: Voice) -> Ref:
        g = v.g
        # Below the lowest C a bell's partials would be too low to hear at all, so the key's pitch stops there.
        f = g.mtof(g.node("math", {"a": v.pitch, "b": 24.0}, mode="max"))
        parts = []
        for attack, seconds, partials in groups:
            tones = []
            for ratio, level, bright in partials:
                freq = g.mul(f, ratio)
                gain = g.mul(
                    audible(g, freq),
                    g.add(g.mul(v.velocity, level * bright), level * (1.0 - bright)),
                )
                tones.append(g.mul(g.osc("sine", freq), gain))
                if beat and ratio == 1.0:
                    tones.append(
                        g.mul(g.osc("sine", g.add(freq, beat)), g.mul(gain, 0.3))
                    )
            ring = g.env(attack, keyed(g, v.key.pitch, seconds, at), 0.0, release)
            parts.append(g.mul(mix(g, tones), ring))
        click = g.node("noise")
        if tick_hz is not None:
            click = g.filter(
                "highpass", click, tracked(g, v.pitch, tick_hz, 500.0, 12000.0)
            )
        click = g.mul(click, g.env(0.0002, 0.003, 0.0, 0.003))
        parts.append(g.mul(click, g.mul(v.velocity, tick)))
        return g.mul(mix(g, parts), strength(g, v.velocity, 0.08))

    return build


def membrane(
    transpose: float,
    drop: float,
    fall: float,
    seconds: float,
    overtones: Partials,
    overtone_seconds: float,
    at: int,
    slap: float,
    slap_mode: str,
    slap_hz: float,
    slap_q: float,
    slap_seconds: float,
):
    """A tuned drum, struck and left to ring. The head is tighter the harder it is struck, so the note starts up to
    `drop` semitones sharp, more for a hard hit, and falls to its pitch over `fall` seconds. Its lowest mode rings for
    `seconds` at note `at`, and its overtones, sines at their ratios, die sooner together. The stick's slap is noise
    through a filter that follows the key. A drum isn't damped when the key comes up, so each release is its decay."""

    def build(v: Voice) -> Ref:
        g = v.g
        sweep = g.snap(g.env(0.0005, fall, 0.0, fall))
        sharp = g.mul(sweep, g.add(g.mul(v.velocity, drop * 0.5), drop * 0.5))
        # The pitch stops at the lowest C, below which a drum would only be felt, and at C8, above which it would only
        # be a click.
        f = g.mtof(g.add(clip(g, g.add(v.pitch, transpose), 24.0, 108.0), sharp))
        ringing = keyed(g, v.key.pitch, seconds, at)
        parts = [g.mul(g.osc("sine", f), g.env(0.0005, ringing, 0.0, ringing))]
        if overtones:
            tones = []
            for ratio, level, bright in overtones:
                freq = g.mul(f, ratio)
                gain = g.mul(
                    audible(g, freq),
                    g.add(g.mul(v.velocity, level * bright), level * (1.0 - bright)),
                )
                tones.append(g.mul(g.osc("sine", freq), gain))
            dying = keyed(g, v.key.pitch, overtone_seconds, at)
            parts.append(g.mul(mix(g, tones), g.env(0.0005, dying, 0.0, dying)))
        hit = g.filter(slap_mode, g.node("noise"), tracked(g, v.pitch, slap_hz), slap_q)
        hit = g.mul(hit, g.env(0.0003, slap_seconds, 0.0, slap_seconds))
        parts.append(g.mul(hit, g.add(g.mul(v.velocity, slap * 0.7), slap * 0.3)))
        return g.mul(mix(g, parts), strength(g, v.velocity, 0.08))

    return build


def reverse_cymbal(v: Voice) -> tuple[Ref, Ref]:
    """A crash played backwards: the cymbal's hiss swelling over 1.2 seconds, brighter as it grows, then still growing a
    little to three seconds, and cut off when the key comes up, as a reversed recording stops where the crash would have
    struck. A cymbal has no pitch to speak of, so the key moves its colour at half the rate a tuned sound would move."""
    g = v.g
    swell = g.env(1.2, 0.1, 1.0, 0.06)
    # Cubed, the swell keeps most of its growth for the end, as a crash's decay heard backwards does. A reversed crash
    # gains loudness so fast that a swell timed to a long note would leave a short one inaudible, and one timed to a
    # short note would make a long one far too loud. So the steep part is the first 1.2 seconds, and a longer note
    # keeps rising, by about 2 dB more, to three seconds.
    grow = g.mul(g.mul(swell, swell), swell)
    grow = g.mul(grow, g.add(g.mul(g.env(3.0, 0.1, 1.0, 0.06), 0.4), 0.6))
    hiss = g.filter(
        "highpass",
        g.node("noise"),
        tracked(g, v.pitch, 5000.0, 400.0, 9000.0, rate=0.5),
    )
    hiss = g.add(
        hiss,
        g.mul(
            g.filter("bandpass", hiss, tracked(g, v.pitch, 9000.0, rate=0.5), 0.6), 0.8
        ),
    )
    opening = g.add(g.mul(g.snap(g.mul(swell, swell)), 11000.0), 3000.0)
    cutoff = clip(g, g.mul(octaves(g, v.pitch, 0.5), opening), 800.0, 16000.0)
    tone = g.filter("lowpass", hiss, cutoff, 0.7)
    # The right side is the left a few milliseconds late: noise that far apart is unrelated, so the cymbal is wide.
    late = g.node("delay", {"in": tone, "time": 0.0071}, max=0.01)
    level = g.mul(
        grow, g.mul(strength(g, v.velocity, 0.08), tilt(g, v.pitch, -0.25, 72.0))
    )
    return g.mul(tone, level), g.mul(late, level)


# Sound effects ------------------------------------------------------------------------------------------------------


def fret_noise(v: Voice) -> Ref:
    """A finger sliding along a wound string: the windings buzz faster as the finger speeds up, so the squeak rises,
    through the narrow ring of the string and a little scrape."""
    g = v.g
    slide = g.snap(g.env(0.0005, 0.09, 0.0, 0.09))
    # Held below E7, so that the buzz's harmonics stay well under half the sample rate however high the key.
    rate = g.mtof(clip(g, g.add(g.add(v.pitch, 21.0), g.mul(slide, -31.0)), 0.0, 100.0))
    buzz = g.osc("saw", rate)
    squeal = g.filter("bandpass", buzz, tracked(g, v.pitch, 2600.0), 4.0)
    scrape = g.filter("bandpass", g.node("noise"), tracked(g, v.pitch, 3600.0), 1.5)
    sound = g.add(squeal, g.mul(scrape, 0.35))
    level = g.mul(strength(g, v.velocity, 0.1), tilt(g, v.pitch, -0.25, 92.0))
    return g.mul(g.mul(sound, g.env(0.012, 0.11, 0.0, 0.11)), level)


def seashore(v: Voice) -> tuple[Ref, Ref]:
    """Surf: noise whose level and brightness rise and fall with two slow swells that never line up, so no two waves
    are alike, and each side has its own. A short note is a single breath of it."""
    g = v.g
    sides = []
    for slow, fast in ((0.11, 0.19), (0.13, 0.23)):
        # Oscillators rather than LFOs, because an LFO that nothing in the voice moves is shared by the track and runs
        # on between notes, so each note would start somewhere else in its swell, and a breath could be anything from
        # loud to silent. An oscillator starts again with each note.
        swells = g.add(
            g.mul(g.snap(g.osc("sine", slow)), 0.25),
            g.mul(g.snap(g.osc("sine", fast)), 0.125),
        )
        surge = g.add(
            swells, 0.625
        )  # A quarter to 1, so that between waves the wash never quite stops
        cutoff = clip(
            g,
            g.mul(octaves(g, v.pitch), g.add(g.mul(surge, 3600.0), 450.0)),
            60.0,
            15000.0,
        )
        wash = g.filter("lowpass", g.node("noise"), cutoff, 0.6)
        wash = g.filter("highpass", wash, 90.0)
        sides.append(g.mul(wash, g.mul(surge, surge)))
    level = g.mul(
        g.env(0.12, 0.1, 1.0, 0.2),
        g.mul(strength(g, v.velocity, 0.1), tilt(g, v.pitch, top=84.0)),
    )
    return g.mul(sides[0], level), g.mul(sides[1], level)


def bird_tweet(v: Voice) -> Ref:
    """A small bird: quick chirps, each a sine sweeping up through most of an octave about three octaves above the key,
    in phrases with pauses between, their rate and height wandering so the song doesn't loop. The wheel adds a trill."""
    g = v.g
    rate = g.add(g.node("lfo", {"rate": 0.7, "depth": 2.0}), 7.5)
    chirp = g.osc("saw", rate, mode="naive")  # -1 to 1 in each chirp
    trill = g.node("lfo", {"rate": 31.0, "depth": g.add(g.mul(v.wheel, 1.5), 0.4)})
    wander = g.node("lfo", {"rate": 1.3, "depth": 2.0})
    pitch = g.add(
        g.add(v.pitch, 40.0), g.add(g.mul(g.snap(chirp), 14.0), g.add(trill, wander))
    )
    tone = g.osc("sine", g.mtof(clip(g, pitch, 0.0, 128.0)))
    # Each chirp is shaped by its own sweep: silent at the ends, where the sweep jumps back, and loudest in the middle
    # third, so that the chirps are short with gaps between them.
    window = g.add(g.mul(g.mul(chirp, chirp), -1.0), 1.0)
    window = g.mul(window, window)
    window = g.mul(g.mul(window, window), window)
    phrase = g.node(
        "math",
        {"a": g.osc("square", 0.45, mode="naive", width=0.72), "b": 0.0},
        mode="compare",
    )
    phrase = g.filter("lowpass", phrase, 25.0)
    level = g.mul(g.env(0.005, 0.1, 1.0, 0.08), strength(g, v.velocity, 0.1))
    return g.mul(g.mul(g.mul(tone, window), phrase), level)


def telephone_ring(v: Voice) -> Ref:
    """An old telephone's bell: a clapper swinging twenty times a second between two gongs a third apart, in bursts
    that repeat while the key is held."""
    g = v.g
    clapper = g.osc("triangle", 20.0)
    on = g.node(
        "math",
        {"a": g.osc("square", 0.75, mode="naive", width=0.65), "b": 0.0},
        mode="compare",
    )
    # Two octaves above the key, held between C2 and C8 so that the gongs are always heard.
    f = g.mtof(clip(g, g.add(v.pitch, 24.0), 36.0, 108.0))
    rings = []
    for side, ratio in ((1.0, 1.0), (-1.0, 1.26)):
        struck = g.node("math", {"a": g.mul(clapper, side), "b": 0.8}, mode="compare")
        # Softened a little, so a strike is a knock and not a click, then held and let die between strikes.
        struck = g.filter("lowpass", g.mul(struck, on), 700.0, 0.5)
        ring = g.node("follow", {"in": struck, "release": 0.06})
        gong = g.mul(f, ratio)
        overtone = g.mul(gong, 2.76)
        bell = g.add(
            g.mul(g.osc("sine", gong), audible(g, gong)),
            g.mul(g.osc("sine", overtone), g.mul(audible(g, overtone), 0.35)),
        )
        rings.append(g.mul(bell, ring))
    level = g.mul(g.env(0.001, 0.1, 1.0, 0.12), strength(g, v.velocity, 0.1))
    return g.mul(g.add(rings[0], rings[1]), level)


def helicopter(v: Voice) -> tuple[Ref, Ref]:
    """A helicopter going over: the rotor's whump, noise beaten eleven times a second at middle C as each blade passes,
    with the slap of the blade tips on top and the turbine's whine under it, swinging slowly across. The key sets the
    rotor's speed."""
    g = v.g
    rotor = g.osc(
        "saw", clip(g, g.mul(octaves(g, v.pitch), 11.0), 0.5, 400.0), mode="naive"
    )
    # Falls from 1 to 0 over each turn, so raised to a power it is a beat with a sharp front and a quick decay.
    fall = g.add(g.mul(rotor, -0.5), 0.5)
    fall2 = g.mul(fall, fall)
    fall4 = g.mul(fall2, fall2)
    noise = g.node("noise")
    whump = g.mul(noise, g.mul(fall2, fall))
    whump = g.filter("lowpass", whump, tracked(g, v.pitch, 320.0), 0.9)
    slap = g.mul(noise, g.mul(fall4, fall4))
    slap = g.filter("bandpass", slap, tracked(g, v.pitch, 1300.0), 1.2)
    whine = g.mul(g.osc("sine", tracked(g, v.pitch, 2400.0)), 0.006)
    sound = g.add(g.add(whump, g.mul(slap, 0.35)), whine)
    # Beaten noise has peaks far above its level, and a few of them would reach full scale. So it is brought to a level
    # of about a seventh of full scale, which the tilt keeps at every key, and the peaks are rounded off by a cubic that
    # runs flat into 1 at 1.5, as the CubicSaturation recipe's does. Fewer than one sample in a thousand is past 1.
    driven = clip(
        g, g.mul(sound, g.mul(tilt(g, v.pitch, top=127.0, bottom=36.0), 8.0)), -1.5, 1.5
    )
    rounded = g.add(driven, g.mul(g.mul(g.mul(driven, driven), driven), -1.0 / 6.75))
    level = g.mul(g.env(0.6, 0.1, 1.0, 0.2), strength(g, v.velocity, 0.1))
    swing = g.node(
        "pan",
        {
            "in": g.mul(rounded, level),
            "position": g.node("lfo", {"rate": 0.07, "depth": 0.5}),
        },
    )
    return swing.l, swing.r


def applause(v: Voice) -> tuple[Ref, Ref]:
    """A crowd clapping: three layers of claps at random moments, each a burst of noise through the ring of a pair of
    hands, at the left, the middle and the right of the room, over the wash of the rest."""
    g = v.g
    hands = g.node("noise")
    other = g.node("noise")
    # Noise passes a threshold about forty times a second, at random, and each time, by how far it passed, is a clap of
    # that strength, which the follower holds and lets die. One noise gives two layers, by its peaks and its troughs,
    # since the follower follows the size of what it is given whatever its sign.
    edge = 1.0 - 80.0 / RATE
    peaks = g.node("math", {"a": g.add(other, -edge), "b": 0.0}, mode="max")
    troughs = g.node("math", {"a": g.add(other, edge), "b": 0.0}, mode="min")
    others = g.node("math", {"a": g.add(hands, -edge), "b": 0.0}, mode="max")
    rings, claps = [], []
    for strikes, centre, seconds in (
        (peaks, 1100.0, 0.011),
        (others, 1700.0, 0.009),
        (troughs, 2500.0, 0.007),
    ):
        rings.append(g.filter("bandpass", hands, tracked(g, v.pitch, centre), 1.1))
        claps.append(
            g.mul(rings[-1], g.node("follow", {"in": strikes, "release": seconds}))
        )
    low, middle, high = claps
    # The rest of the room, too many and too far away to hear one by one. A clap is at most as strong as the threshold
    # is far from 1, and the level below brings that up to 1, so the wash is brought down by as much.
    centre = g.add(g.mul(middle, 0.5), g.mul(rings[1], 0.05 * (1.0 - edge)))
    left = mix(g, [low, centre, g.mul(high, 0.25)])
    right = mix(g, [high, centre, g.mul(low, 0.25)])
    loud = g.mul(
        g.mul(strength(g, v.velocity, 0.1), tilt(g, v.pitch)), 1.0 / (1.0 - edge)
    )
    level = g.mul(g.env(0.25, 0.1, 1.0, 0.2), loud)
    return g.mul(left, level), g.mul(right, level)


def gunshot(v: Voice) -> tuple[Ref, Ref]:
    """A shot: the crack of the muzzle, the thump of the blast as a falling sine, a burst of noise that darkens as it
    dies, and its echo off something far away over a low rumble. It rings out whatever the note's length."""
    g = v.g
    noise = g.node("noise")
    crack = g.filter("highpass", noise, tracked(g, v.pitch, 1800.0), 0.7)
    crack = g.mul(crack, g.env(0.0001, 0.004, 0.0, 0.004))
    drop = g.snap(g.env(0.0001, 0.025, 0.0, 0.025))
    thump = g.osc(
        "sine",
        g.mtof(g.add(clip(g, g.add(v.pitch, -24.0), 12.0, 96.0), g.mul(drop, 20.0))),
    )
    thump = g.mul(thump, g.env(0.0005, 0.14, 0.0, 0.14))
    burst = g.env(0.0003, 0.09, 0.0, 0.09)
    darkening = g.add(g.mul(g.snap(burst), 7000.0), 700.0)
    cutoff = clip(g, g.mul(octaves(g, v.pitch), darkening), 100.0, 15000.0)
    blast = g.mul(g.filter("lowpass", noise, cutoff, 0.7), burst)
    near = mix(g, [g.mul(crack, 0.9), g.mul(thump, 0.8), blast])
    rumble = g.filter("lowpass", noise, tracked(g, v.pitch, 900.0), 0.6)
    rumble = g.mul(rumble, g.env(0.02, 0.7, 0.0, 0.7))
    tail = g.add(
        g.mul(g.node("delay", {"in": blast, "time": 0.14}, max=0.2), 0.3),
        g.mul(rumble, 0.22),
    )
    # The tail comes back a little later on the right, as an echo does from somewhere off to one side.
    late = g.node("delay", {"in": tail, "time": 0.011}, max=0.02)
    level = g.mul(strength(g, v.velocity, 0.1), tilt(g, v.pitch, -0.25, bottom=24.0))
    return g.mul(g.add(near, tail), level), g.mul(g.add(near, late), level)


# The set ------------------------------------------------------------------------------------------------------------

TINKLE = [  # A small bell: inharmonic modes, the upper ones short and brought out by a hard strike
    (0.0004, 1.3, [(1.0, 1.0, 0.2)]),
    (0.0004, 0.6, [(2.43, 0.5, 0.5)]),
    (0.0004, 0.25, [(4.05, 0.32, 0.7), (5.97, 0.22, 0.8), (8.36, 0.14, 0.9)]),
]
# A pan's note: tuned near its octave and twelfth, a little stretched, over two modes that aren't tuned at all. The
# mallet is soft, and the octave takes a moment to bloom as the note's energy passes into it.
STEEL = [
    (0.0015, 1.4, [(1.0, 1.0, 0.15)]),
    (0.025, 0.55, [(2.005, 0.85, 0.4)]),
    (0.0015, 0.22, [(3.01, 0.4, 0.6), (4.16, 0.15, 0.8), (5.45, 0.08, 1.0)]),
]
# A round head's modes above its lowest, at the ratios a stretched membrane's take
TAIKO = [(1.594, 0.4, 0.4), (2.136, 0.25, 0.5), (2.296, 0.18, 0.6), (2.653, 0.1, 0.7)]
# A block's few modes above its knock, far apart and quickly gone, which is what makes it sound hollow and wooden
WOOD = [(2.65, 0.35, 0.5), (4.4, 0.12, 0.7)]

INSTRUMENTS = [
    Instrument(
        "TinkleBell",
        "Tinkle bell",
        PERCUSSIVE,
        metal(
            TINKLE,
            at=90,
            release=0.35,
            beat=3.1,
            tick=0.25,
            tick_hz=None,
        ),
        72,
        108,
        programs=[112, 113],
        phrase=[
            (0.0, 88, 100, 0.5),
            (0.5, 91, 90, 0.5),
            (1.0, 96, 105, 1.0),
            (2.0, 93, 90, 0.5),
            (2.5, 91, 85, 0.5),
            (3.0, 88, 100, 1.5),
            # Short and lower, as a file plays the agogo
            (5.0, 76, 110, 0.2),
            (5.5, 79, 90, 0.2),
            (6.0, 76, 110, 0.2),
            (6.75, 79, 90, 0.2),
            (7.25, 76, 100, 0.2),
            (7.5, 79, 95, 0.2),
        ],
        listen_for="A small bright bell with a slow shimmer that rings on, and short low notes that clink like an agogo.",
    ),
    Instrument(
        "SteelDrums",
        "Steel drums",
        PERCUSSIVE,
        metal(
            STEEL,
            at=73,
            release=0.45,
            beat=0.0,
            tick=0.12,
            tick_hz=1500.0,
        ),
        55,
        91,
        programs=[114],
        phrase=[
            (0.0, 72, 100, 0.4),
            (0.5, 76, 90, 0.4),
            (1.0, 79, 100, 0.4),
            (1.5, 76, 85, 0.4),
            (2.0, 74, 100, 0.4),
            (2.5, 77, 90, 0.4),
            (3.0, 81, 105, 0.9),
            (4.0, 79, 100, 0.4),
            (4.5, 77, 90, 0.4),
            (5.0, 76, 95, 0.4),
            (5.5, 74, 90, 0.4),
            (6.0, 72, 110, 1.5),
            (6.0, 64, 90, 1.5),
        ],
        listen_for="A calypso line on a steel pan: round, metallic notes that bloom and ring.",
    ),
    Instrument(
        "PitchedWoodblock",
        "Woodblock",
        PERCUSSIVE,
        membrane(
            transpose=24.0,
            drop=0.8,
            fall=0.008,
            seconds=0.06,
            overtones=WOOD,
            overtone_seconds=0.02,
            at=66,
            slap=0.6,
            slap_mode="bandpass",
            slap_hz=1046.0,
            slap_q=3.0,
            slap_seconds=0.006,
        ),
        48,
        84,
        programs=[115],
        gated=False,
        phrase=[
            (0.0, 66, 110, 0.2),
            (0.75, 66, 90, 0.2),
            (1.5, 71, 100, 0.2),
            (2.0, 66, 105, 0.2),
            (2.5, 71, 95, 0.2),
            (3.0, 71, 110, 0.2),
            (3.5, 66, 90, 0.2),
            (4.0, 60, 100, 0.2),
            (4.5, 64, 100, 0.2),
            (5.0, 67, 100, 0.2),
            (5.5, 72, 110, 0.2),
        ],
        listen_for="A short hollow knock at two pitches in a clave rhythm, then a little climb.",
    ),
    Instrument(
        "Taiko",
        "Taiko drum",
        PERCUSSIVE,
        membrane(
            transpose=0.0,
            drop=2.5,
            fall=0.05,
            seconds=0.7,
            overtones=TAIKO,
            overtone_seconds=0.25,
            at=44,
            slap=0.6,
            slap_mode="lowpass",
            slap_hz=1800.0,
            slap_q=0.7,
            slap_seconds=0.035,
        ),
        28,
        64,
        programs=[116, 117],
        gated=False,
        phrase=[
            (0.0, 36, 120, 0.25),
            (1.0, 36, 90, 0.25),
            (1.5, 36, 100, 0.25),
            (2.0, 43, 115, 0.25),
            (3.0, 36, 127, 0.25),
            # A fill on the melodic toms
            (4.0, 57, 105, 0.2),
            (4.25, 55, 95, 0.2),
            (4.5, 52, 100, 0.2),
            (4.75, 50, 95, 0.2),
            (5.0, 48, 105, 0.2),
            (5.25, 45, 100, 0.2),
            (5.5, 43, 110, 0.2),
            (6.0, 36, 120, 0.25),
        ],
        listen_for="Big low drum strokes that boom and settle, then a fill down the melodic toms.",
    ),
    Instrument(
        "SynthDrum",
        "Synth drum",
        PERCUSSIVE,
        membrane(
            transpose=0.0,
            drop=12.0,
            fall=0.13,
            seconds=0.4,
            overtones=[],
            overtone_seconds=0.0,
            at=54,
            slap=0.25,
            slap_mode="bandpass",
            slap_hz=2500.0,
            slap_q=0.8,
            slap_seconds=0.05,
        ),
        36,
        72,
        programs=[118],
        gated=False,
        phrase=[
            (0.0, 60, 110, 0.25),
            (0.5, 57, 100, 0.25),
            (1.0, 53, 105, 0.25),
            (1.5, 48, 110, 0.25),
            (2.0, 60, 100, 0.2),
            (2.25, 60, 90, 0.2),
            (2.5, 55, 100, 0.2),
            (2.75, 55, 90, 0.2),
            (3.0, 50, 110, 0.2),
            (3.25, 50, 95, 0.2),
            (3.5, 45, 120, 0.5),
        ],
        listen_for="A 1980s electronic tom fill: sine drums whose pitch dives as each one dies.",
    ),
    Instrument(
        "ReverseCymbal",
        "Reverse cymbal",
        PERCUSSIVE,
        reverse_cymbal,
        48,
        72,
        programs=[119],
        voices=2,
        phrase=[(0.0, 60, 100, 3.5), (5.0, 64, 110, 2.0)],
        listen_for="A cymbal sucked in backwards, swelling and brightening until it stops dead, twice.",
    ),
    Instrument(
        "FretNoise",
        "Guitar fret noise",
        NOISES,
        fret_noise,
        48,
        72,
        programs=[120],
        gated=False,
        phrase=[
            (0.0, 60, 100, 0.3),
            (1.0, 63, 90, 0.3),
            (2.0, 58, 110, 0.3),
            (3.0, 60, 80, 0.3),
            (3.5, 65, 100, 0.3),
        ],
        listen_for="The squeak of a finger sliding up a wound guitar string, a few times.",
    ),
    Instrument(
        "Seashore",
        "Seashore",
        NOISES,
        seashore,
        48,
        72,
        programs=[121, 122],
        voices=2,
        phrase=[
            (0.0, 60, 100, 10.0),
            # Short notes, as a file plays breath noise
            (12.0, 64, 90, 0.6),
            (13.0, 64, 100, 0.6),
            (14.0, 64, 90, 1.0),
        ],
        listen_for="Surf rolling in and out, wave after wave, then three short breaths of noise.",
    ),
    Instrument(
        "BirdTweet",
        "Bird tweet",
        NOISES,
        bird_tweet,
        48,
        72,
        programs=[123],
        voices=2,
        phrase=[(0.0, 60, 100, 5.0), (6.0, 65, 110, 3.0)],
        listen_for="A small bird chirping in quick bursts with pauses, then a higher one.",
    ),
    Instrument(
        "TelephoneRing",
        "Telephone ring",
        NOISES,
        telephone_ring,
        48,
        72,
        programs=[124],
        voices=2,
        phrase=[(0.0, 60, 100, 6.0)],
        listen_for="An old telephone's bell ringing in bursts while it is held.",
    ),
    Instrument(
        "Helicopter",
        "Helicopter",
        NOISES,
        helicopter,
        48,
        72,
        programs=[125],
        voices=2,
        phrase=[(0.0, 60, 100, 8.0)],
        listen_for="The beat of a helicopter's rotor, arriving, swinging across and leaving.",
    ),
    Instrument(
        "Applause",
        "Applause",
        NOISES,
        applause,
        48,
        72,
        programs=[126],
        voices=2,
        phrase=[(0.0, 60, 100, 8.0)],
        listen_for="A room of people clapping, building and dying away.",
    ),
    Instrument(
        "Gunshot",
        "Gunshot",
        NOISES,
        gunshot,
        48,
        72,
        programs=[127],
        voices=4,
        gated=False,
        phrase=[
            (0.0, 60, 120, 0.2),
            (2.0, 55, 100, 0.2),
            (3.0, 64, 127, 0.2),
            (3.5, 60, 90, 0.2),
        ],
        listen_for="Gunshots: a sharp crack, a thump and an echo, at a few sizes.",
    ),
]
