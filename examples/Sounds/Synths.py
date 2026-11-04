"""The synths: GM's synth leads, pads and effects, programs 80 to 103, from the recipes' oscillators, filters and modulation.

Each family has four instruments, and each of GM's eight programs in it plays the one nearest it. Every sound is made here,
from oscillators and noise: none plays a recording.
"""

import math

from Graph import Ref
from Instrument import Instrument, Phrase, Voice

LEAD, PAD, FX = "Synth lead", "Synth pad", "Synth effects"

# How far the mod wheel, all the way up, swings a sustained sound's pitch either way, in semitones. Pressure adds less.
WHEEL_VIBRATO = 0.45
PRESSURE_VIBRATO = 0.25

# Where every filter's cutoff stops, well below the top of the band, so that no note's filter is asked for more than it can do.
TOP = 14000.0


# Pieces every synth shares -------------------------------------------------------------------------------------------
#
# A voice's cost is mostly its audio-rate steps, each about what an oscillator costs, and a filter whose cutoff moves costs
# more than twice one whose cutoff stays put, since its coefficients are worked out again each frame. So gains are worked
# out at control rate and applied once, and filters follow the key's pitch without the vibrato, which only the oscillators
# need, so that a held note's filter stays still.


def vibrato(v: Voice, rate: float, depth: float = 0.0, onset: float = 0.0) -> Ref:
    """The pitch with vibrato: the wheel's and pressure's at once, and the sound's own `depth` arriving over `onset`
    seconds, as a player's does on a long note."""
    g = v.g
    amount = g.add(g.mul(v.wheel, WHEEL_VIBRATO), g.mul(v.pressure, PRESSURE_VIBRATO))
    if depth:
        own = g.mul(g.snap(g.env(onset, 0.1, 1.0, 0.1)), depth) if onset else depth
        amount = g.add(amount, own)
    return g.add(v.pitch, g.node("lfo", {"rate": rate, "depth": amount}))


def loudness(v: Voice, floor: float = 0.06) -> Ref:
    """How loud velocity makes a note: velocity squared above a floor, so velocity 64 is about 10 dB under 127 and velocity 1
    is quiet but not silent."""
    g = v.g
    return g.add(g.mul(g.mul(v.velocity, v.velocity), 1.0 - floor), floor)


def hardness(v: Voice, floor: float) -> Ref:
    """How hard a note is played, for its brightness: `floor` at velocity 0, rising to 1 at 127."""
    return v.g.add(v.g.mul(v.velocity, 1.0 - floor), floor)


def tracked(v: Voice, harmonics, floor: float, top: float = TOP) -> Ref:
    """A cutoff `harmonics` times the key's pitch above `floor` Hz, so every note is as bright as the next, clamped below
    `top`. It follows the bend but not the vibrato."""
    g = v.g
    return g.node(
        "math", {"a": g.add(g.mul(v.freq, harmonics), floor), "b": top}, mode="min"
    )


def detuned(v: Voice, f: Ref, cents: float) -> Ref:
    return v.g.mul(f, 2 ** (cents / 1200))


def curve(fn) -> list[float]:
    """A shape node's 257 points, for `fn` over -1 to 1."""
    return [round(fn(2 * i / 256 - 1), 6) for i in range(257)]


def soft_clip(v: Voice, signal: Ref, drive: float) -> Ref:
    """A tanh curve, steeper as `drive` rises, which keeps a peak of 1 at 1 and rounds what comes near it."""
    shape = curve(lambda x: math.tanh(drive * x) / math.tanh(drive))
    return v.g.node("shape", {"in": signal}, curve=shape)


def below(v: Voice, highest: float) -> Ref:
    """1 up to `highest` Hz and falling away above it, for a partial at a multiple of the pitch that would otherwise pass
    the top of the band and fold back, so a ring modulator's or a bell's upper partials leave as the note climbs."""
    g = v.g
    over = g.node("math", {"a": g.mul(v.freq, 1.0 / highest), "b": 1.0}, mode="max")
    return g.node("math", {"a": g.mul(over, over), "b": 0.0}, mode="divide")


# Leads ----------------------------------------------------------------------------------------------------------------


def square_lead(v: Voice) -> Ref:
    """Two square waves a few cents apart, which beat slowly, through a low-pass that opens at the attack and follows the
    pitch. Pressure brightens it."""
    g = v.g
    f = g.mtof(vibrato(v, 5.6))
    tone = g.add(
        g.osc("square", f, width=0.5),
        g.mul(g.osc("square", detuned(v, f, 7.0), width=0.5), 0.45),
    )
    bite = g.mul(g.snap(g.env(0.002, 0.25, 0.45, 0.06)), hardness(v, 0.4))
    harmonics = g.add(g.add(g.mul(bite, 9.0), 3.0), g.mul(v.pressure, 4.0))
    tone = g.filter("lowpass", tone, tracked(v, harmonics, 400.0), 1.0)
    return g.mul(tone, g.mul(g.env(0.003, 0.2, 0.85, 0.06), loudness(v)))


def saw_lead(v: Voice) -> Ref:
    """Two saws a few cents apart over a square an octave down, as the SubOscillator recipe has, through a resonant
    low-pass with MonoLead's envelope, and then a soft clip that velocity drives harder. Saw, charang's overdriven saw,
    fifths and bass and lead all come here: each is a saw lead with more of something."""
    g = v.g
    f = g.mtof(vibrato(v, 5.4))
    saws = g.add(g.osc("saw", detuned(v, f, -6.0)), g.osc("saw", detuned(v, f, 6.0)))
    tone = g.add(saws, g.mul(g.osc("square", g.mul(f, 0.5)), 0.6))
    bite = g.mul(g.snap(g.env(0.001, 0.3, 0.35, 0.06)), hardness(v, 0.3))
    harmonics = g.add(g.add(g.mul(bite, 12.0), 2.5), g.mul(v.pressure, 5.0))
    tone = g.filter("lowpass", tone, tracked(v, harmonics, 300.0), 1.4)
    driven = soft_clip(v, g.mul(tone, g.add(g.mul(v.velocity, 0.25), 0.18)), 2.0)
    return g.mul(driven, g.mul(g.env(0.004, 0.25, 0.8, 0.06), loudness(v)))


def calliope_lead(v: Voice) -> Ref:
    """A pipe of a steam organ: a triangle and its octave, breath tuned to the pipe, the pipe's tremulant arriving as the
    note is held, and a chiff of noise at the attack, as a flue pipe speaks. Calliope and chiff both come here."""
    g = v.g
    f = g.mtof(vibrato(v, 6.2, 0.12, 0.25))
    octave = g.mul(g.osc("sine", g.mul(f, 2.0)), g.add(g.mul(v.velocity, 0.2), 0.12))
    hiss = g.node("noise")
    breath = g.filter("bandpass", hiss, tracked(v, 1.0, 0.0, 9000.0), 4.0)
    breath = g.mul(breath, g.env(0.02, 0.25, 0.35, 0.06))
    chiff = g.filter("bandpass", hiss, tracked(v, 3.0, 600.0, 12000.0), 1.5)
    chiff = g.mul(chiff, g.env(0.001, 0.035, 0.0, 0.02))
    pipe = g.add(g.add(g.osc("triangle", f), octave), g.mul(breath, 0.5))
    sound = g.add(pipe, g.mul(chiff, g.add(g.mul(v.velocity, 0.9), 0.2)))
    return g.mul(sound, g.mul(g.env(0.03, 0.1, 0.9, 0.06), loudness(v)))


def voice_lead(v: Voice) -> Ref:
    """A sung "ah": a saw with a little breath through three formants, as the FormantVowels recipe has. The first formant
    rises with a high note, as a singer's does, so a high note keeps its fundamental, and a low note is lifted to match,
    since fewer of its harmonics reach the formants."""
    g = v.g
    f = g.mtof(vibrato(v, 5.2, 0.18, 0.3))
    source = g.add(g.osc("saw", f), g.mul(g.node("noise"), 0.12))
    first = g.node("math", {"a": g.mul(v.freq, 1.1), "b": 750.0}, mode="max")
    sound = g.filter("bandpass", source, first, 5.0)
    sound = g.add(sound, g.mul(g.filter("bandpass", source, 1150.0, 8.0), 0.6))
    upper = g.mul(g.filter("bandpass", source, 2700.0, 10.0), hardness(v, 0.3))
    sound = g.add(sound, g.mul(upper, 0.4))
    level = g.mul(loudness(v), g.keyed(v.key.pitch, 1.0))
    return g.mul(sound, g.mul(g.env(0.04, 0.2, 0.9, 0.06), level))


# Pads -----------------------------------------------------------------------------------------------------------------


def new_age_pad(v: Voice) -> tuple[Ref, Ref]:
    """A bell struck over a pad: a sine ring-modulated by one at three and a half times its pitch, whose clang fades faster
    than the sine does, over two triangles a few cents apart, one each side, and a soft saw, which swell in. Metallic comes
    here too."""
    g = v.g
    f = g.mtof(vibrato(v, 4.5))
    sine = g.osc("sine", f)
    clang = g.mul(
        g.mul(sine, g.osc("sine", g.mul(f, 3.5))), g.mul(below(v, 4000.0), 0.8)
    )
    ring = g.env(0.001, g.keyed(v.pitch, 1.6), 0.0, 0.24)
    shimmer = g.env(0.001, g.keyed(v.pitch, 0.5), 0.0, 0.24)
    struck = g.mul(hardness(v, 0.4), 0.9)
    bell = g.mul(g.add(g.mul(sine, ring), g.mul(clang, shimmer)), struck)
    body = g.filter("lowpass", g.osc("saw", f), tracked(v, 2.0, 300.0, 6000.0), 0.7)
    body = g.add(bell, g.mul(body, g.mul(g.env(0.5, 1.0, 0.85, 0.24), 0.3)))
    swell = g.mul(g.env(0.6, 1.0, 0.85, 0.24), 0.8)
    level = loudness(v)
    out = []
    for cents in (-7.0, 7.0):
        side = g.add(body, g.mul(g.osc("triangle", detuned(v, f, cents)), swell))
        out.append(g.mul(side, level))
    return out[0], out[1]


def warm_pad(v: Voice) -> tuple[Ref, Ref]:
    """Four saws a few cents apart, two each side, through low-passes that open slowly as the note swells, as a bow
    settles into a string. Bowed comes here too."""
    g = v.g
    f = g.mtof(vibrato(v, 4.8, 0.05, 0.6))
    swell = g.snap(g.env(0.8, 1.5, 0.6, 0.24))
    harmonics = g.add(g.mul(swell, g.add(g.mul(v.velocity, 2.0), 1.0)), 1.6)
    cutoff = tracked(v, harmonics, 500.0, 9000.0)
    level = g.mul(g.env(0.35, 1.0, 0.85, 0.24), loudness(v))
    out = []
    for a, b in ((-10.0, 4.0), (10.0, -4.0)):
        saws = g.add(g.osc("saw", detuned(v, f, a)), g.osc("saw", detuned(v, f, b)))
        out.append(g.mul(g.filter("lowpass", saws, cutoff, 0.7), level))
    return out[0], out[1]


def polysynth_pad(v: Voice) -> tuple[Ref, Ref]:
    """A brassy polysynth: a saw and a pulse each side through a resonant low-pass whose envelope blares at the attack and
    settles, with a slow sweep of the cutoff on a long chord. Sweep comes here too."""
    g = v.g
    f = g.mtof(vibrato(v, 5.0))
    blare = g.mul(g.snap(g.env(0.06, 0.7, 0.35, 0.24)), hardness(v, 0.4))
    sweep = g.add(g.node("lfo", {"rate": 0.15, "depth": 0.35}), 1.0)
    harmonics = g.mul(g.add(g.mul(blare, 9.0), 1.5), sweep)
    cutoff = tracked(v, harmonics, 250.0, 12000.0)
    level = g.mul(g.env(0.03, 0.4, 0.85, 0.22), loudness(v))
    out = []
    for cents, width in ((-5.0, 0.3), (5.0, 0.7)):
        tone = g.add(
            g.osc("saw", detuned(v, f, cents)),
            g.mul(g.osc("square", detuned(v, f, -cents), width=width), 0.6),
        )
        out.append(g.mul(g.filter("lowpass", tone, cutoff, 2.0), level))
    return out[0], out[1]


def choir_pad(v: Voice) -> tuple[Ref, Ref]:
    """A choir: three saws a few cents apart, as three singers are, with breath, through the formants of an "ah" and a band
    of air above them, drifting from side to side. Halo comes here too."""
    g = v.g
    f = g.mtof(vibrato(v, 5.0, 0.08, 0.4))
    source = g.add(
        g.add(g.osc("saw", detuned(v, f, -9.0)), g.osc("saw", detuned(v, f, 9.0))),
        g.add(g.osc("saw", f), g.mul(g.node("noise"), 0.25)),
    )
    first = g.node("math", {"a": g.mul(v.freq, 1.1), "b": 650.0}, mode="max")
    sound = g.filter("bandpass", source, first, 4.0)
    sound = g.add(sound, g.mul(g.filter("bandpass", source, 1080.0, 7.0), 0.55))
    sound = g.add(sound, g.mul(g.filter("bandpass", source, 2600.0, 9.0), 0.25))
    sound = g.add(sound, g.mul(g.filter("bandpass", source, 4200.0, 2.0), 0.12))
    level = g.mul(
        g.env(0.45, 1.0, 0.9, 0.24), g.mul(loudness(v), g.keyed(v.key.pitch, 1.0))
    )
    drift = g.node("lfo", {"rate": 0.23, "depth": 0.4})
    sides = g.node("pan", {"in": g.mul(sound, level), "position": drift})
    return sides.l, sides.r


# Effects ---------------------------------------------------------------------------------------------------------------


def crystal(v: Voice) -> tuple[Ref, Ref]:
    """Glass struck over a soft tone: the inharmonic partials of a free bar, the upper ones dying faster, and sparkles that
    fall again and again and fade, a high partial and a drop of noise each time, wandering from side to side. Rain comes
    here too."""
    g = v.g
    f = g.mtof(vibrato(v, 5.0))
    struck = hardness(v, 0.5)
    fundamental = g.mul(
        g.osc("sine", f), g.env(0.001, g.keyed(v.pitch, 2.0), 0.0, 0.24)
    )
    upper = g.add(
        g.osc("sine", g.mul(f, 2.756)), g.mul(g.osc("sine", g.mul(f, 5.404)), 0.55)
    )
    upper = g.mul(
        upper,
        g.mul(
            g.env(0.001, g.keyed(v.pitch, 0.6), 0.0, 0.24),
            g.mul(below(v, 3500.0), 0.45),
        ),
    )
    tone = g.mul(g.osc("triangle", f), g.mul(g.env(0.3, 1.0, 0.6, 0.24), 0.35))
    centre = g.add(g.mul(g.add(fundamental, upper), struck), tone)
    # A falling ramp, curved into a drop, at a rate that rises with the pitch so a chord's sparkles don't fall together.
    rate = g.mtof(g.add(g.mul(v.key.pitch, 0.25), -20.4))
    drop = g.node(
        "shape", {"in": g.osc("saw", rate)}, curve=curve(lambda x: ((1 - x) / 2) ** 3)
    )
    noise = g.filter("bandpass", g.node("noise"), tracked(v, 6.0, 2000.0), 3.0)
    sparkle = g.add(g.osc("sine", g.mul(f, 4.0)), g.mul(noise, 0.6))
    fade = g.mul(g.env(0.05, 1.8, 0.15, 0.24), g.mul(below(v, 4000.0), 0.5))
    sparkle = g.mul(g.mul(sparkle, drop), fade)
    sides = g.node(
        "pan", {"in": sparkle, "position": g.node("lfo", {"rate": 0.7, "depth": 0.7})}
    )
    level = loudness(v)
    return g.mul(g.add(centre, sides.l), level), g.mul(g.add(centre, sides.r), level)


def atmosphere(v: Voice) -> tuple[Ref, Ref]:
    """An airy guitar pad: two saws a few cents apart, plucked bright through a low-pass that closes as the pluck rings and
    then swelling into a pad, under sines an octave up, one each side, a few cents apart, which shimmer, and air above.
    Brightness comes here too."""
    g = v.g
    f = g.mtof(vibrato(v, 4.6))
    pluck = g.env(0.001, g.keyed(v.pitch, 0.5), 0.0, 0.1)
    swell = g.env(0.4, 1.0, 0.7, 0.24)
    shine = g.mul(g.snap(pluck), g.mul(hardness(v, 0.4), 12.0))
    saws = g.add(g.osc("saw", detuned(v, f, -8.0)), g.osc("saw", detuned(v, f, 8.0)))
    strings = g.filter("lowpass", saws, tracked(v, g.add(shine, 3.0), 600.0), 0.8)
    strings = g.mul(strings, g.add(pluck, g.mul(swell, 0.45)))
    air = g.mul(g.filter("highpass", g.node("noise"), 6000.0), g.mul(swell, 0.25))
    centre = g.add(strings, air)
    level = loudness(v)
    out = []
    for cents in (-6.0, 6.0):
        shimmer = g.mul(g.osc("sine", detuned(v, f, 1200.0 + cents)), g.mul(swell, 0.3))
        out.append(g.mul(g.add(centre, shimmer), level))
    return out[0], out[1]


def soundtrack(v: Voice) -> tuple[Ref, Ref]:
    """A dark, slow pad that won't settle: two saws through a resonant low-pass that wanders, and a sine ring-modulated by
    one whose pitch drifts, so its overtones slide out of tune and back, coming in slowly, and a pitch that wobbles.
    Goblins and sci-fi come here too."""
    g = v.g
    pitch = g.add(vibrato(v, 4.0), g.node("lfo", {"rate": 0.27, "depth": 0.08}))
    f = g.mtof(pitch)
    wander = g.add(g.node("lfo", {"rate": 0.19, "depth": 0.6}), 1.4)
    saws = g.add(g.osc("saw", detuned(v, f, -6.0)), g.osc("saw", detuned(v, f, 6.0)))
    dark = g.filter("lowpass", saws, tracked(v, wander, 250.0, 6000.0), 3.0)
    drift = g.add(g.node("lfo", {"rate": 0.13, "depth": 0.1}), 1.5)
    eerie = g.mul(g.osc("sine", f), g.osc("sine", g.mul(f, drift)))
    creep = g.mul(
        g.env(1.5, 2.0, 0.7, 0.24),
        g.mul(below(v, 5000.0), g.mul(hardness(v, 0.3), 1.6)),
    )
    sound = g.add(
        g.mul(dark, g.mul(g.env(0.8, 1.5, 0.85, 0.24), 0.6)), g.mul(eerie, creep)
    )
    sides = g.node(
        "pan",
        {
            "in": g.mul(sound, loudness(v)),
            "position": g.node("lfo", {"rate": 0.11, "depth": 0.5}),
        },
    )
    return sides.l, sides.r


def echoes(v: Voice) -> tuple[Ref, Ref]:
    """A soft tone and its echoes, repeating as they fade and darken, from two combs inside the patch, one each side at its
    own time, so the repeats fall left and right. They stop soon after the note does."""
    g = v.g
    f = g.mtof(vibrato(v, 5.0))
    tone = g.add(g.osc("square", f, width=0.4), g.mul(g.osc("saw", f), 0.5))
    bright = g.mul(g.snap(g.env(0.005, 0.5, 0.25, 0.2)), hardness(v, 0.4))
    tone = g.filter(
        "lowpass", tone, tracked(v, g.add(g.mul(bright, 8.0), 2.0), 300.0, 9000.0), 0.8
    )
    dry = g.mul(tone, g.mul(g.env(0.008, 0.9, 0.35, 0.24), loudness(v)))
    hold = g.mul(g.env(0.001, 0.1, 1.0, 0.22), 0.7)
    out = []
    for seconds in (0.32, 0.24):
        echo = g.node(
            "comb",
            {"in": dry, "time": seconds, "feedback": 0.5, "damp": 0.35},
            max=seconds,
        )
        out.append(g.add(dry, g.mul(echo, hold)))
    return out[0], out[1]


# Auditions ------------------------------------------------------------------------------------------------------------


def line(root: int) -> Phrase:
    """A lead's audition: a phrase that climbs to a long note, so its attack, its vibrato and its release are all heard."""
    steps = [
        (0.0, 0, 100, 0.5),
        (0.5, 2, 90, 0.5),
        (1.0, 4, 100, 0.5),
        (1.5, 7, 95, 0.5),
        (2.0, 9, 110, 1.5),
        (4.0, 7, 90, 0.25),
        (4.5, 4, 85, 0.25),
        (5.0, 2, 95, 0.5),
        (5.5, 0, 90, 0.5),
        (6.0, 2, 105, 2.0),
    ]
    return [(beat, root + step, velocity, held) for beat, step, velocity, held in steps]


def chords(root: int) -> Phrase:
    """A pad's audition: three chords held long enough to hear each swell in, and their release before the next."""
    phrase = []
    for at, chord, held in (
        (0.0, (0, 7, 12, 16), 3.5),
        (4.0, (5, 9, 12, 17), 3.5),
        (8.0, (7, 11, 14, 19), 6.0),
    ):
        phrase += [(at, root + step, 90, held) for step in chord]
    return phrase


def sparse(root: int) -> Phrase:
    """An effect's audition: short notes far enough apart to hear what follows each, then a chord held."""
    phrase = [
        (0.0, root + 12, 100, 0.5),
        (2.0, root + 19, 95, 0.5),
        (4.0, root + 16, 105, 0.5),
    ]
    return phrase + [(6.0, root + step, 90, 5.0) for step in (0, 7, 12, 16)]


INSTRUMENTS = [
    Instrument(
        "SquareLead",
        "Square lead",
        LEAD,
        square_lead,
        48,
        96,
        programs=[80],
        voices=4,
        phrase=line(72),
        listen_for="A hollow square-wave lead that brightens at each attack and beats slowly against itself.",
    ),
    Instrument(
        "SawLead",
        "Saw lead",
        LEAD,
        saw_lead,
        40,
        96,
        programs=[81, 84, 86, 87],
        voices=4,
        phrase=line(67),
        listen_for="A fat, buzzy saw lead with weight an octave below, a filter that bites at the attack, and grit as it is played harder.",
    ),
    Instrument(
        "CalliopeLead",
        "Calliope lead",
        LEAD,
        calliope_lead,
        55,
        96,
        programs=[82, 83],
        voices=4,
        phrase=line(72),
        listen_for="A breathy pipe of a steam organ that speaks with a puff of noise and wavers as it is held.",
    ),
    Instrument(
        "VoiceLead",
        "Voice lead",
        LEAD,
        voice_lead,
        48,
        84,
        programs=[85],
        voices=4,
        phrase=line(64),
        listen_for='A synthetic voice singing "ah", with breath and a singer\'s vibrato that arrives on the long notes.',
    ),
    Instrument(
        "NewAgePad",
        "New age pad",
        PAD,
        new_age_pad,
        36,
        96,
        programs=[88, 93],
        phrase=chords(48),
        listen_for="A soft bell struck at each chord, whose shimmer fades as a wide, warm pad swells in under it.",
    ),
    Instrument(
        "WarmPad",
        "Warm pad",
        PAD,
        warm_pad,
        36,
        88,
        programs=[89, 92],
        phrase=chords(48),
        listen_for="Slow, wide, mellow saws that swell in and open a little as they are held, as a string section's bows settle.",
    ),
    Instrument(
        "PolysynthPad",
        "Polysynth pad",
        PAD,
        polysynth_pad,
        36,
        96,
        programs=[90, 95],
        phrase=chords(48),
        listen_for="A brassy synth chord that blares at the attack and settles, its brightness sweeping slowly on a long chord.",
    ),
    Instrument(
        "ChoirPad",
        "Choir pad",
        PAD,
        choir_pad,
        40,
        84,
        programs=[91, 94],
        phrase=chords(48),
        listen_for='A breathy synthetic choir singing "ah" that swells in slowly and drifts from side to side.',
    ),
    Instrument(
        "Crystal",
        "Crystal",
        FX,
        crystal,
        48,
        103,
        programs=[96, 98],
        phrase=sparse(60),
        listen_for="Glassy bells over a soft tone, with sparkles that fall again and again, wandering side to side as they fade.",
    ),
    Instrument(
        "Atmosphere",
        "Atmosphere",
        FX,
        atmosphere,
        40,
        96,
        programs=[99, 100],
        phrase=sparse(55),
        listen_for="A bright plucked guitar note that rings into a wide, airy pad with a shimmer an octave up.",
    ),
    Instrument(
        "Soundtrack",
        "Soundtrack",
        FX,
        soundtrack,
        36,
        88,
        programs=[97, 101, 103],
        phrase=chords(48),
        listen_for="A dark, slow pad with a resonant filter that wanders and metallic overtones that slide out of tune, eerily.",
    ),
    Instrument(
        "Echoes",
        "Echoes",
        FX,
        echoes,
        40,
        96,
        programs=[102],
        phrase=sparse(60),
        listen_for="A soft synth tone whose echoes repeat and darken, falling left and right, and fade soon after the note ends.",
    ),
]
