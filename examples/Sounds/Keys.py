"""The standard set's keyboards: GM's pianos, its chromatic percussion and its organs.

The harpsichord, the tine piano and the old upright are MakePieces.py's, ported into the set's contract with their numbers
unchanged, so that the pieces rebuilt on them keep their sound. The tine piano's modulated sine is made more cheaply, as
`sine` says, and renders within -75 dB of the piece's. The rest are built here: a grand piano and its variants, an FM
piano and a clavinet, struck bars and bells, a hammered dulcimer, tonewheel and pipe organs, and free reeds.
"""

import math

from Graph import Graph, Ref
from Instrument import Instrument, Voice

# A cent as a fraction of a frequency, near enough for a few of them.
CENT = 2 ** (1 / 1200) - 1

# Half a sine, from its trough to its peak, for a shape node to bend a triangle into a sine. An osc in mod mode makes a
# sine whose phase moves a sample at a time, but at about seven times the cost of a triangle bent this way, which sounds
# the same to -70 dB.
SINE = [round(math.sin(math.pi / 2 * (-1 + i / 32)), 6) for i in range(65)]


def lowest(g: Graph, a, b) -> Ref:
    return g.node("math", {"a": a, "b": b}, mode="min")


def clamped(g: Graph, x, low: float, high: float) -> Ref:
    return g.node("math", {"a": x, "b": low, "c": high}, mode="clip")


def keyed(g: Graph, pitch, seconds: float, octaves: float = 2.0) -> Ref:
    """`seconds` at C4, twice as long `octaves` octaves down and half as long `octaves` up, or the other way round when
    `octaves` is negative. Graph.keyed is this with 2."""
    return g.mul(
        g.node(
            "ratio",
            {"in": g.add(g.mul(pitch, -1 / octaves), 60 + 60 / octaves)},
            root=60,
        ),
        seconds,
    )


def loudness(g: Graph, velocity, floor: float = 0.1) -> Ref:
    """A level from velocity, as its square: velocity 64 plays about 10 dB under 127, and velocity 1 is still heard."""
    return g.add(g.mul(g.mul(velocity, velocity), 1 - floor), floor)


def tilt(g: Graph, pitch, below: float = 0.0, above: float = 0.0) -> Ref:
    """A level that rises by `below` dB an octave going down from C4 and by `above` dB an octave going up, to even out
    an instrument's notes where its sound alone would leave one end quieter."""
    down = g.node("math", {"a": g.add(pitch, -60.0), "b": 0.0}, mode="min")
    up = g.node("math", {"a": g.add(pitch, -60.0), "b": 0.0}, mode="max")
    shift = g.add(g.add(g.mul(down, -below / 6.0206), g.mul(up, above / 6.0206)), 60.0)
    return g.node("ratio", {"in": shift}, root=60)


def sine(g: Graph, freq, phase) -> Ref:
    """A sine at `freq` whose phase, in turns, moves with `phase` a sample at a time: the carrier of phase modulation."""
    return g.node(
        "shape", {"in": g.osc("triangle", freq, mode="mod", phase=phase)}, curve=SINE
    )


def vibrato(v: Voice, rate: float, depth: float) -> Ref:
    """`v.freq` with the mod wheel's vibrato, up to `depth` semitones either way."""
    g = v.g
    return g.mtof(
        g.add(v.pitch, g.node("lfo", {"rate": rate, "depth": g.mul(v.wheel, depth)}))
    )


def spread(g: Graph, sound, key, width: float):
    """A note placed by its key, the bass to the left and the treble to the right, as the player hears it."""
    position = clamped(g, g.mul(g.add(key.pitch, -64.0), width / 40), -width, width)
    placed = g.node("pan", {"in": sound, "position": position})
    return placed.l, placed.r


# Pianos -------------------------------------------------------------------------------------------------------------


def grand(
    v: Voice,
    *,
    bright: float = 1.0,
    floor: float = 2.0,
    detune: float = 1.0,
    prompt: float = 0.7,
    after: float = 3.4,
    thump: float = 1.0,
    damp: float = 0.09,
    unisons: int = 3,
    thin: float = 0.0,
    width: float = 0.5,
):
    """A grand piano: three strings a note, struck where the hammer leaves a notch in their harmonics, a cent or so
    apart so they beat slowly. Two of them die fast and one rings on, which is a piano's prompt sound and aftersound.
    A harder blow is louder and brighter, and the brightness fades with the prompt sound, faster in the treble. The
    hammer knocks, the damper stops the note when the key comes up, and the top keys have no damper.

    The variants change how bright a blow is and how much of the tone is left when it has faded, the unisons' detuning
    in cents and how many there are, the prompt sound's and aftersound's decay and the damper's, in seconds at C4, the
    hammer's knock, a highpass for a thinner sound, and how far the keys spread across the stereo field."""
    g, key, f = v.g, v.key, v.freq
    vel = key.velocity
    # The hammer strikes an eighth of the way along the bass and middle strings and nearer the end in the treble, which
    # takes out the harmonics at multiples of eight there, and fewer of them higher up.
    strike = clamped(g, g.add(g.mul(key.pitch, -0.0016), 0.221), 0.05, 0.125)
    centre = g.osc("square", f, width=strike)
    sharp = g.osc("square", g.mul(f, 1 + 1.1 * detune * CENT), width=strike)
    if unisons > 2:
        sharp = g.add(
            sharp, g.osc("square", g.mul(f, 1 - 0.8 * detune * CENT), width=strike)
        )
    # The damper: every envelope takes its release from here, and the keys above F#6 ring on, as they have none.
    damper = g.node(
        "math",
        {
            "a": g.add(key.pitch, -89.5),
            "b": keyed(g, key.pitch, after, 1.5),
            "c": keyed(g, key.pitch, damp, 3.0),
        },
        mode="select",
    )
    # A soft blow leaves the hammer on the strings longer, so the note takes a few milliseconds to sound.
    contact = g.add(g.mul(vel, -0.0028), 0.0034)
    fast = g.env(contact, keyed(g, key.pitch, prompt, 1.5), 0.0, damper)
    slow = g.env(contact, keyed(g, key.pitch, after, 1.5), 0.0, damper)
    strings = g.add(g.mul(sharp, fast), g.mul(centre, slow))
    # The hammer's felt on the strings, a burst of noise that goes through the strings' filter, so it is as bright as
    # the blow, and the knock the hammer gives the soundboard, both louder for a harder blow.
    noise = g.node("noise")
    felt = g.mul(noise, g.mul(g.env(0.0003, 0.005, 0.0, 0.01), g.mul(vel, 0.8 * thump)))
    knock = g.mul(
        g.filter("bandpass", noise, 140.0, 1.4),
        g.mul(g.env(0.0006, 0.045, 0.0, 0.03), g.mul(vel, 3.0 * thump)),
    )
    # The highest harmonic that gets through, in Hz: a harder blow reaches higher, as do the treble's lighter hammers,
    # and it falls back as the note rings until only the lowest few are left.
    blow = g.mul(
        g.add(g.mul(g.mul(g.mul(vel, vel), vel), 8000.0 * bright), 300.0),
        keyed(g, key.pitch, 1.0, -2.0),
    )
    cutoff = lowest(
        g, g.add(g.mul(f, floor), g.add(g.mul(g.snap(fast), blow), 100.0)), 15000.0
    )
    tone = g.filter("lowpass", g.add(strings, felt), cutoff, 0.6)
    # A narrower pulse is quieter, by about as much as it is narrower, so the treble is made up by as much.
    level = g.mul(
        loudness(g, vel), g.node("math", {"a": 0.125, "b": strike}, mode="divide")
    )
    sound = g.mul(g.add(tone, knock), level)
    if thin:
        # Pickups, or a small box, that hear little of the bass.
        sound = g.filter("highpass", sound, thin, 0.6)
    return spread(g, sound, key, width)


def upright(v: Voice):
    """An old upright piano: two strings a few cents apart for each note, which beat as a tired one's unisons do, struck
    bright and mellowing as they ring, longer in the bass."""
    g, key, f = v.g, v.key, v.freq
    strings = g.add(g.osc("saw", g.mul(f, 1.0032)), g.osc("saw", g.mul(f, 0.9968)))
    strike = g.snap(g.env(0.0005, 0.3, 0.0, 0.1))
    harmonics = g.mul(
        g.add(g.mul(strike, 9.0), 2.2), g.add(g.mul(key.velocity, 0.9), 0.35)
    )
    cutoff = g.node(
        "math", {"a": g.add(g.mul(f, harmonics), 250.0), "b": 14000.0}, mode="min"
    )
    tone = g.filter("lowpass", strings, cutoff, 0.6)
    ring = g.env(0.001, g.keyed(key.pitch, 2.0), 0.0, 0.16)
    level = g.mul(g.add(g.mul(g.mul(key.velocity, key.velocity), 0.8), 0.2), 0.16)
    return g.filter("highpass", g.mul(g.mul(tone, ring), level), 50.0)


def electric_piano(v: Voice):
    """A tine piano: a sine phase-modulated by another at its own pitch, whose bark fades into a bell as it rings."""
    g, key, f = v.g, v.key, v.freq
    bark = g.env(0.0005, 0.5, 0.12, 0.3)
    # Turns of phase at the strike: a harder key barks more.
    depth = g.add(g.mul(key.velocity, 0.55), 0.08)
    modulator = g.mul(g.mul(g.osc("sine", f), bark), depth)
    tine = sine(g, f, modulator)
    # The metal of the tine, briefly.
    ping = g.mul(g.osc("sine", g.mul(f, 7.0)), g.env(0.0002, 0.05, 0.0, 0.03))
    sound = g.add(tine, g.mul(ping, g.mul(key.velocity, 0.15)))
    ring = g.env(0.001, g.keyed(key.pitch, 3.0), 0.0, 0.3)
    level = g.mul(g.add(g.mul(g.mul(key.velocity, key.velocity), 0.8), 0.2), 0.3)
    # Modulating a sine at its own pitch leaves a DC offset that depends on where the two start, so it is filtered out.
    return g.filter("highpass", g.mul(g.mul(sound, ring), level), 40.0)


def fm_piano(v: Voice):
    """GM's second electric piano, the FM one: two sines at the note's pitch, a hair apart. A modulator at the same pitch
    gives one its body, and one fourteen times higher gives the other the glassy tine of its strike, which a harder key
    makes louder and which is gone in a moment, so what rings on is two sines that beat slowly."""
    g, key, f = v.g, v.key, v.freq
    vel = key.velocity
    # The body's modulation goes deeper down the keyboard, which gives the bass its growl.
    growl = keyed(g, key.pitch, 1.0, 3.0)
    body = g.mul(
        g.osc("sine", f),
        g.mul(
            g.env(0.001, keyed(g, key.pitch, 1.2), 0.0, 0.2),
            g.mul(g.add(g.mul(vel, 0.16), 0.03), growl),
        ),
    )
    # Above G5 the tine is out of hearing, and higher still it would alias, so it fades out by G7.
    reach = clamped(g, g.mul(g.add(key.pitch, -103.0), -1 / 24), 0.0, 1.0)
    tine = g.mul(
        g.osc("sine", g.mul(f, 14.0)),
        g.mul(
            g.env(0.0005, 0.08, 0.0, 0.05), g.mul(g.mul(g.mul(vel, vel), 0.35), reach)
        ),
    )
    ring = g.env(0.001, keyed(g, key.pitch, 2.4), 0.0, 0.25)
    sound = g.add(sine(g, f, body), g.mul(sine(g, g.mul(f, 1 + 2.5 * CENT), tine), 0.8))
    level = g.mul(loudness(g, vel, 0.07), tilt(g, key.pitch, below=2.2))
    return g.filter("highpass", g.mul(g.mul(sound, ring), level), 40.0)


def harpsichord(v: Voice):
    """Two choirs of strings, one an octave up, plucked bright and dying away faster in the treble, as a quill does."""
    g, key, f = v.g, v.key, v.freq
    eight = g.osc("square", f, width=0.16)  # A narrow pulse for the nasal 8' choir
    four = g.osc("saw", g.mul(f, 2.003))  # The 4' choir, a hair sharp of the octave
    strings = g.add(eight, g.mul(four, 0.32))
    # The cutoff follows the pitch, as a multiple of it, so every note is as bright and none aliases. It opens at the
    # pluck and settles, and a harder key plucks brighter.
    pluck = g.snap(g.env(0.0005, 0.35, 0.0, 0.1))
    harmonics = g.mul(
        g.add(g.mul(pluck, 22.0), 7.0), g.add(g.mul(key.velocity, 0.6), 0.7)
    )
    cutoff = g.node("math", {"a": g.mul(f, harmonics), "b": 16000.0}, mode="min")
    tone = g.filter("lowpass", strings, cutoff, 0.8)
    quill = g.mul(
        g.filter("highpass", g.node("noise"), 3200.0), g.env(0.0002, 0.006, 0.0, 0.004)
    )
    # The damper falls quickly when the key comes up, and a harpsichord barely gets louder.
    ring = g.env(0.0008, g.keyed(key.pitch, 2.4), 0.0, 0.07)
    sound = g.mul(g.add(tone, g.mul(quill, 0.25)), ring)
    level = g.mul(g.add(g.mul(key.velocity, 0.35), 0.45), 0.22)
    return g.filter("highpass", g.mul(sound, level), 70.0)


def clavinet(v: Voice):
    """A clavinet: a string struck against an anvil and heard through pickups near its end, so it is thin and bright,
    with a resonant snap that a harder key opens wider, and it stops dead when the key comes up."""
    g, key, f = v.g, v.key, v.freq
    vel = key.velocity
    # Two pickups at different places along the string, each a pulse as narrow as its place.
    string = g.add(
        g.osc("square", f, width=0.09), g.mul(g.osc("square", f, width=0.27), 0.6)
    )
    snap = g.snap(g.env(0.0004, keyed(g, key.pitch, 0.18), 0.0, 0.02))
    harmonics = g.add(g.mul(snap, g.add(g.mul(vel, 22.0), 4.0)), 3.5)
    cutoff = lowest(g, g.add(g.mul(f, harmonics), 300.0), 14000.0)
    tone = g.filter(
        "highpass", g.filter("lowpass", string, cutoff, 1.3), lowest(g, f, 400.0), 0.7
    )
    tangent = g.mul(
        g.filter("highpass", g.node("noise"), 2500.0), g.env(0.0002, 0.003, 0.0, 0.003)
    )
    ring = g.env(0.0005, keyed(g, key.pitch, 0.9), 0.0, 0.025)
    sound = g.mul(g.add(tone, g.mul(tangent, g.mul(vel, 0.3))), ring)
    return g.mul(sound, loudness(g, vel))


# Chromatic percussion -----------------------------------------------------------------------------------------------


def bar(
    v: Voice,
    modes: list[tuple[float, float, float]],
    *,
    ring: float,
    octaves: float = 2.0,
    hard: float = 0.5,
    click: float = 0.2,
    damp: float = 0.12,
    tremolo: tuple[float, float] = (0.0, 0.0),
    beat: float = 0.0,
    width: float = 0.3,
):
    """A struck bar, plate, tine or tube: a sine for each of its modes, at its ratio to the note, its level and its
    share of `ring`, the seconds the lowest mode takes to fall by e at C4. A harder blow brings out the upper modes
    more. A mallet's click, the bar's damper when the key comes up, and a vibraphone's tremolo are arguments."""
    g, key, f = v.g, v.key, v.freq
    vel = key.velocity
    decay = keyed(g, key.pitch, ring, octaves)
    # Modes that fall away together share an envelope.
    groups: dict[float, Ref] = {}
    for n, (ratio, level, share) in enumerate(modes):
        # Above the first mode a harder blow is brighter, and a mode past what the rate can hold is left out.
        weight = (
            level if n == 0 else g.add(g.mul(vel, hard * level), (1 - hard) * level)
        )
        if ratio > 1:
            weight = g.mul(
                weight, clamped(g, g.add(g.mul(f, -ratio / 2000), 11.0), 0.0, 1.0)
            )
        partial = g.osc("sine", f if ratio == 1 else g.mul(f, ratio))
        if weight != 1.0:
            partial = g.mul(partial, weight)
        if n == 0 and beat:
            # A second tine or bar tuned a few cents away, which beats with the first.
            twin = g.osc("sine", g.mul(f, 1 + beat * CENT))
            partial = g.add(partial, g.mul(twin, level * 0.6))
        groups[share] = (
            partial if share not in groups else g.add(groups[share], partial)
        )
    sound = None
    for share, partials in groups.items():
        partials = g.mul(partials, g.env(0.0008, g.mul(decay, share), 0.0, damp))
        sound = partials if sound is None else g.add(sound, partials)
    if click:
        mallet = g.filter(
            "bandpass", g.node("noise"), lowest(g, g.mul(f, 3.0), 9000.0), 1.2
        )
        sound = g.add(
            sound,
            g.mul(mallet, g.mul(g.env(0.0003, 0.008, 0.0, 0.01), g.mul(vel, click))),
        )
    if tremolo[1]:
        rate, depth = tremolo
        # The vibraphone's fans turn in the tubes and swell every note; the wheel makes them go deeper. An lfo would
        # step the level once a frame, which a bar's pure tone lets through as a buzz, so this is an oscillator.
        swing = g.mul(g.osc("sine", rate), g.add(g.mul(v.wheel, 0.4), depth))
        sound = g.mul(sound, g.add(swing, 1.0))
    return spread(g, g.mul(sound, loudness(g, vel)), key, width)


# The modes of a free bar with even ends, as ratios to its first: what a glockenspiel's steel bars ring with, untuned.
STEEL_BAR = [
    (1.0, 1.0, 1.0),
    (2.756, 0.45, 0.45),
    (5.404, 0.25, 0.16),
    (8.933, 0.12, 0.16),
]
# A celesta's plates over wooden resonators, which keep the first mode and leave little of the rest.
CELESTA = [(1.0, 1.0, 1.0), (2.756, 0.14, 0.28), (4.0, 0.12, 0.28), (5.404, 0.05, 0.12)]
# A music box's comb: tines clamped at one end, whose upper modes are far from the first, and short.
COMB = [(1.0, 1.0, 1.0), (5.93, 0.35, 0.18), (16.6, 0.12, 0.06)]
# A vibraphone's aluminium bars are cut so that the second mode is two octaves up and the third a third above that.
VIBES = [(1.0, 1.0, 1.0), (3.98, 0.22, 0.28), (9.86, 0.05, 0.1)]
# A marimba's rosewood bars are tuned like the vibraphone's, but the wood damps the upper modes in an instant.
MARIMBA = [(1.0, 1.0, 1.0), (3.96, 0.32, 0.22), (9.9, 0.12, 0.06)]
# A xylophone's are tuned to the twelfth, and struck with hard mallets.
XYLOPHONE = [(1.0, 1.0, 1.0), (3.0, 0.5, 0.4), (6.1, 0.22, 0.11), (9.4, 0.08, 0.11)]
# A tubular bell: its strike note is heard where the fourth, fifth and sixth modes of the tube stand nearly as 2, 3
# and 4, which a chime maker tunes them towards, with the third mode's minor third above the note and a little of the
# note itself.
CHIME = [
    (1.0, 0.35, 1.0),
    (1.21, 0.5, 1.0),
    (2.0, 1.0, 0.7),
    (2.98, 0.7, 0.42),
    (4.07, 0.45, 0.42),
]


def dulcimer(v: Voice):
    """A hammered dulcimer: courses of thin wire strings a few cents out with one another, struck with light hammers,
    bright and jangling, which ring on after the hammer leaves them."""
    return grand(
        v,
        bright=2.2,
        floor=5.0,
        detune=4.0,
        prompt=0.9,
        after=2.2,
        thump=0.25,
        damp=0.5,
        thin=220.0,
        unisons=2,
        width=0.3,
    )


# Organs -------------------------------------------------------------------------------------------------------------

# A tonewheel organ's drawbars, as the ratio of each to the note, in the order they sit: 16', 5 1/3', 8', 4', 2 2/3',
# 2', 1 3/5', 1 1/3' and 1'.
FOOTAGES = [0.5, 1.5, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 8.0]


def drawbar(
    v: Voice,
    stops: str,
    *,
    percussion: float = 0.0,
    third: bool = True,
    drive: float = 0.0,
    click: float = 0.25,
):
    """A tonewheel organ: a sine for each drawbar pulled out, `stops` giving each one's setting from 0 to 8 as the
    nine digits an organist writes, each step 3 dB. It speaks the instant a key goes down and stops as it comes up,
    with a click from the key's contacts. Percussion adds a decaying second or third harmonic, and drive a valve
    amplifier pushed into clipping."""
    g, key = v.g, v.key
    f = vibrato(v, 6.8, 0.3)
    sound = None
    for ratio, setting in zip(FOOTAGES, stops):
        if setting == "0":
            continue
        wheel = g.osc("sine", f if ratio == 1 else g.mul(f, ratio))
        wheel = g.mul(wheel, 10 ** ((int(setting) - 8) * 3 / 20))
        sound = wheel if sound is None else g.add(sound, wheel)
    held = g.env(0.003, 0.01, 1.0, 0.012)
    sound = g.mul(sound, held)
    if percussion:
        harmonic = g.osc("sine", g.mul(f, 3.0 if third else 2.0))
        sound = g.add(
            sound, g.mul(harmonic, g.mul(g.env(0.0006, 0.22, 0.0, 0.01), percussion))
        )
    contacts = g.filter("bandpass", g.node("noise"), 2800.0, 0.7)
    sound = g.add(
        sound, g.mul(contacts, g.mul(g.env(0.0002, 0.003, 0.0, 0.003), click))
    )
    if drive:
        # A soft clip, x - x^3 / 3, which a louder note drives harder. `drive` is how far past full the sum of the
        # drawbars goes at full velocity, however many are out.
        full = sum(10 ** ((int(setting) - 8) * 3 / 20) for setting in stops)
        push = g.mul(g.add(g.mul(key.velocity, 0.6), 0.4), drive / full)
        hot = clamped(g, g.mul(sound, push), -1.0, 1.0)
        sound = g.add(hot, g.mul(g.mul(g.mul(hot, hot), hot), -1 / 3))
    return g.mul(sound, loudness(g, key.velocity))


def pipes(v: Voice):
    """A church organ's full chorus: an open diapason at 8', a stopped bourdon an octave below, and an octave, a
    twelfth and a fifteenth above, each rank a little out with the others. The pipes speak slowly, the bass slowest,
    with a chiff of wind at the mouth, and stop when the key comes up, leaving the church to ring."""
    g, key = v.g, v.key
    f = vibrato(v, 5.5, 0.2)
    speech = keyed(g, key.pitch, 0.05, 3.0)
    principal = g.filter(
        "lowpass", g.osc("saw", f), lowest(g, g.add(g.mul(f, 5.0), 300.0), 14000.0), 0.6
    )
    bourdon = g.osc("triangle", g.mul(f, 0.5 * (1 + 1.2 * CENT)))
    octave = g.filter(
        "lowpass",
        g.osc("saw", g.mul(f, 2 * (1 - 1.6 * CENT))),
        lowest(g, g.mul(f, 7.0), 14000.0),
        0.6,
    )
    twelfth = g.osc("sine", g.mul(f, 3 * (1 - 0.7 * CENT)))
    fifteenth = g.osc("sine", g.mul(f, 4 * (1 + 2.2 * CENT)))
    ranks = g.add(
        g.add(principal, g.mul(bourdon, 0.7)),
        g.add(g.mul(octave, 0.5), g.add(g.mul(twelfth, 0.15), g.mul(fifteenth, 0.22))),
    )
    chiff = g.mul(
        g.filter("bandpass", g.node("noise"), lowest(g, g.mul(f, 4.0), 9000.0), 2.0),
        g.env(0.002, g.mul(speech, 0.8), 0.0, 0.05),
    )
    wind = g.env(speech, 0.2, 1.0, keyed(g, key.pitch, 0.07, 3.0))
    sound = g.add(g.mul(ranks, wind), g.mul(chiff, 0.35))
    return g.mul(sound, g.mul(loudness(g, key.velocity), tilt(g, key.pitch, below=1.5)))


def free_reed(
    v: Voice,
    reeds: list[tuple[float, float, float]],
    *,
    width: float = 0.32,
    bright: float = 5.0,
    formant: float = 1200.0,
    breath: float = 0.0,
    tremulant: tuple[float, float] = (0.0, 0.0),
    attack: float = 0.03,
    scoop: float = 0.0,
    top: float = 12000.0,
    even: tuple[float, float] = (0.0, 0.0),
):
    """Free reeds, as a reed organ, an accordion or a harmonica has: for each reed, its octave above the note, its
    detuning in cents and its level, a narrow pulse each. The bellows or the breath open the tone as they push harder,
    with the key's velocity and the channel's pressure; the reed chamber gives it a formant; and a tremulant, or reeds
    tuned apart as an accordion's musette, make it beat."""
    g, key = v.g, v.key
    vel = key.velocity
    pitch = g.add(v.pitch, g.node("lfo", {"rate": 5.6, "depth": g.mul(v.wheel, 0.3)}))
    if scoop:
        # Bent up into the note from a little below, as a player's mouth does.
        pitch = g.add(pitch, g.mul(g.snap(g.env(0.001, 0.06, 0.0, 0.01)), -scoop))
    f = g.mtof(pitch)
    sound = None
    for octave, cents, level in reeds:
        reed = g.osc("square", g.mul(f, 2**octave * (1 + cents * CENT)), width=width)
        reed = g.mul(reed, level)
        sound = reed if sound is None else g.add(sound, reed)
    push = g.add(g.mul(vel, 0.6), g.add(g.mul(v.pressure, 0.5), 0.4))
    # However dark the reed's chamber, a note above `top` keeps its fundamental.
    ceiling = g.node("math", {"a": g.mul(f, 2.0), "b": top}, mode="max")
    cutoff = lowest(g, g.add(g.mul(g.mul(f, bright), push), 300.0), ceiling)
    tone = g.filter("lowpass", sound, cutoff, 0.7)
    tone = g.add(tone, g.mul(g.filter("bandpass", tone, formant, 1.6), 0.8))
    if breath:
        air = g.filter(
            "bandpass", g.node("noise"), lowest(g, g.mul(f, 3.0), 6000.0), 1.0
        )
        tone = g.add(tone, g.mul(air, breath))
    bellows = g.env(attack, 0.1, 0.9, 0.06)
    sound = g.mul(tone, bellows)
    if tremulant[1]:
        rate, depth = tremulant
        sound = g.mul(sound, g.add(g.node("lfo", {"rate": rate, "depth": depth}), 1.0))
    return g.mul(sound, g.mul(loudness(g, vel), tilt(g, key.pitch, *even)))


# The set ------------------------------------------------------------------------------------------------------------

# Soft to loud up the keyboard, then a chord held, one struck and let go at once, and the top keys, which have no damper.
PIANO_PHRASE = [
    *[
        (i * 0.5, 36 + 12 * (i // 4) + (0, 4, 7, 12)[i % 4], 30 + i * 6, 0.45)
        for i in range(16)
    ],
    (8.0, 48, 70, 3.5),
    (8.0, 55, 70, 3.5),
    (8.0, 64, 80, 3.5),
    (8.0, 72, 90, 3.5),
    (12.0, 36, 110, 0.3),
    (12.0, 60, 110, 0.3),
    (12.0, 67, 110, 0.3),
    (12.0, 76, 110, 0.3),
    (13.0, 96, 100, 0.2),
    (13.5, 100, 100, 0.2),
    (14.0, 103, 100, 0.2),
]


def keys_phrase(root: int) -> list[tuple[float, int, int, float]]:
    """A scale at rising velocity, then a chord held for two bars."""
    scale = [
        (i * 0.5, root + s, 40 + i * 11, 0.45)
        for i, s in enumerate([0, 2, 4, 5, 7, 9, 11, 12])
    ]
    return scale + [(4.0, root + c, 96, 7.5) for c in (0, 4, 7, 12)]


INSTRUMENTS = [
    Instrument(
        "GrandPiano",
        "Grand piano",
        "Piano",
        grand,
        21,
        108,
        programs=[0],
        voices=16,
        phrase=PIANO_PHRASE,
        listen_for="A concert grand: bright and knocking when played hard, round when soft, mellowing as it rings.",
    ),
    Instrument(
        "BrightPiano",
        "Bright piano",
        "Piano",
        lambda v: grand(v, bright=1.7, floor=3.2, prompt=0.85, thump=0.8),
        21,
        108,
        programs=[1],
        voices=16,
        phrase=PIANO_PHRASE,
        listen_for="The grand with harder hammers, its treble ringing and its attack cutting through a band.",
    ),
    Instrument(
        "ElectricGrand",
        "Electric grand",
        "Piano",
        lambda v: grand(
            v,
            bright=1.3,
            floor=3.5,
            detune=3.5,
            prompt=0.45,
            after=1.8,
            thump=0.3,
            thin=160.0,
            unisons=2,
        ),
        21,
        108,
        programs=[2],
        voices=16,
        phrase=PIANO_PHRASE,
        listen_for="A stage piano's short strings through pickups: thin, bright, a little chorused, and short.",
    ),
    Instrument(
        "HonkyTonkPiano",
        "Honky-tonk piano",
        "Piano",
        upright,
        21,
        108,
        programs=[3],
        voices=16,
        listen_for="An old upright whose two strings a note have drifted apart and beat, bright at the strike.",
    ),
    Instrument(
        "ElectricPiano",
        "Electric piano",
        "Piano",
        electric_piano,
        28,
        100,
        programs=[4],
        voices=12,
        listen_for="A tine piano that barks when struck hard and rings on as a bell.",
    ),
    Instrument(
        "FmPiano",
        "FM electric piano",
        "Piano",
        fm_piano,
        28,
        100,
        programs=[5],
        voices=12,
        listen_for="A glassy FM piano: a tine that chimes at the strike, harder notes more, and a soft, beating ring.",
    ),
    Instrument(
        "Harpsichord",
        "Harpsichord",
        "Piano",
        harpsichord,
        29,
        89,
        programs=[6],
        voices=12,
        listen_for="Two choirs of plucked strings, bright and nasal, dying faster in the treble.",
    ),
    Instrument(
        "Clavinet",
        "Clavinet",
        "Piano",
        clavinet,
        29,
        89,
        programs=[7],
        listen_for="A funky clavinet: thin, bright and snapping, and stopped dead as each key comes up.",
    ),
    Instrument(
        "Celesta",
        "Celesta",
        "Chromatic percussion",
        lambda v: bar(v, CELESTA, ring=0.9, hard=0.5, click=0.08, damp=0.15),
        60,
        108,
        programs=[8],
        listen_for="A celesta: soft, sweet bell tones from felt hammers on steel plates.",
    ),
    Instrument(
        "Glockenspiel",
        "Glockenspiel",
        "Chromatic percussion",
        lambda v: bar(
            v, STEEL_BAR, ring=1.6, octaves=3.0, hard=0.7, click=0.3, damp=0.35
        ),
        79,
        108,
        programs=[9],
        listen_for="Steel bars struck with hard mallets, bright and ringing, with their clanging upper modes.",
    ),
    Instrument(
        "MusicBox",
        "Music box",
        "Chromatic percussion",
        lambda v: bar(v, COMB, ring=0.7, hard=0.6, click=0.15, damp=0.4, beat=3.0),
        60,
        103,
        programs=[10],
        listen_for="A music box's comb: tiny plucked tines, tinkling, shimmering and short.",
    ),
    Instrument(
        "Vibraphone",
        "Vibraphone",
        "Chromatic percussion",
        lambda v: bar(
            v,
            VIBES,
            ring=2.2,
            octaves=3.0,
            hard=0.5,
            click=0.1,
            damp=0.12,
            tremolo=(5.2, 0.3),
        ),
        53,
        89,
        programs=[11],
        phrase=keys_phrase(60),
        listen_for="A vibraphone with its motor on: soft mallets, a long ring, and a swell that pulses.",
    ),
    Instrument(
        "Marimba",
        "Marimba",
        "Chromatic percussion",
        lambda v: bar(
            v, MARIMBA, ring=0.32, octaves=1.5, hard=0.7, click=0.35, damp=0.2
        ),
        36,
        96,
        programs=[12],
        listen_for="A marimba: warm, woody and short, the bass blooming from its resonators.",
    ),
    Instrument(
        "Xylophone",
        "Xylophone",
        "Chromatic percussion",
        lambda v: bar(
            v, XYLOPHONE, ring=0.16, octaves=2.0, hard=0.8, click=0.6, damp=0.1
        ),
        65,
        108,
        programs=[13],
        listen_for="A xylophone: hard, dry and bright, each note a short knock.",
    ),
    Instrument(
        "TubularBells",
        "Tubular bells",
        "Chromatic percussion",
        lambda v: bar(v, CHIME, ring=2.4, octaves=2.0, hard=0.6, click=0.0, damp=0.35),
        60,
        77,
        programs=[14],
        phrase=keys_phrase(60),
        listen_for="Orchestral chimes: a clanging strike and a long, shimmering bell tone.",
    ),
    Instrument(
        "Dulcimer",
        "Dulcimer",
        "Chromatic percussion",
        dulcimer,
        48,
        96,
        programs=[15],
        voices=12,
        listen_for="A hammered dulcimer: bright courses of wire strings, a little out with one another, ringing on.",
    ),
    Instrument(
        "DrawbarOrgan",
        "Drawbar organ",
        "Organ",
        lambda v: drawbar(v, "888600000"),
        36,
        96,
        programs=[16],
        phrase=keys_phrase(60),
        listen_for="A tonewheel organ, round and full, speaking at once with a click and stopping as the key lifts.",
    ),
    Instrument(
        "PercussiveOrgan",
        "Percussive organ",
        "Organ",
        lambda v: drawbar(v, "888000000", percussion=0.6),
        36,
        96,
        programs=[17],
        phrase=keys_phrase(60),
        listen_for="A jazz organ whose third harmonic pings at the start of every note and dies away.",
    ),
    Instrument(
        "RockOrgan",
        "Rock organ",
        "Organ",
        lambda v: drawbar(v, "888808008", drive=2.2, click=0.5),
        36,
        96,
        programs=[18],
        phrase=keys_phrase(60),
        listen_for="A tonewheel organ with every low drawbar out, driven into a growl.",
    ),
    Instrument(
        "ChurchOrgan",
        "Church organ",
        "Organ",
        pipes,
        24,
        96,
        programs=[19],
        phrase=keys_phrase(48),
        listen_for="A pipe organ's chorus of ranks, slow to speak with a chiff, and stopping when the key lifts.",
    ),
    Instrument(
        "ReedOrgan",
        "Reed organ",
        "Organ",
        lambda v: free_reed(
            v,
            [(0, 0.0, 1.0), (1, 1.5, 0.35)],
            bright=3.5,
            formant=900.0,
            tremulant=(5.4, 0.18),
        ),
        36,
        96,
        programs=[20],
        phrase=keys_phrase(60),
        listen_for="A harmonium: soft, reedy and a little slow to speak, swaying with its tremulant.",
    ),
    Instrument(
        "Accordion",
        "Accordion",
        "Organ",
        lambda v: free_reed(
            v,
            [(0, -13.0, 0.8), (0, 0.0, 1.0), (0, 13.0, 0.8)],
            bright=6.0,
            formant=1500.0,
            top=6000.0,
            even=(0.0, -2.0),
        ),
        41,
        89,
        programs=[21],
        phrase=keys_phrase(60),
        listen_for="A musette accordion: three reeds a note, tuned apart so that they beat in a fast shimmer.",
    ),
    Instrument(
        "Harmonica",
        "Harmonica",
        "Organ",
        lambda v: free_reed(
            v,
            [(0, 0.0, 1.0)],
            width=0.42,
            bright=7.0,
            formant=1300.0,
            breath=0.12,
            attack=0.05,
            scoop=0.15,
        ),
        60,
        96,
        programs=[22],
        phrase=keys_phrase(72),
        listen_for="A blues harp: one reed, breathy, bent up into each note, its vibrato on the wheel.",
    ),
    Instrument(
        "TangoAccordion",
        "Tango accordion",
        "Organ",
        lambda v: free_reed(
            v,
            [(0, 0.0, 1.0), (1, 1.0, 0.55), (-1, -1.0, 0.4)],
            width=0.25,
            bright=4.5,
            formant=1000.0,
        ),
        36,
        89,
        programs=[23],
        phrase=keys_phrase(57),
        listen_for="A bandoneon: reeds in octaves tuned dry, dark and reedy, with no musette.",
    ),
]
