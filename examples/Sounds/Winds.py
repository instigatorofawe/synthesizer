"""The set's winds: brass (programs 56 to 63), reeds (64 to 71) and pipes (72 to 79).

Every wind takes velocity as breath, which is brightness as much as loudness, the mod wheel as vibrato, and channel
pressure as more breath on a held note. The trumpet, horn and trombone are MakePieces' brass() and the oboe and bassoon
its reed(), with the numbers the chorale and the Grieg give them, so those pieces keep their sound when they are rebuilt
on the set.
"""

import math

from Graph import Ref
from Instrument import Instrument, Phrase, Sound, Voice

WHEEL_VIBRATO = (
    0.5  # Semitones of vibrato at full wheel: GM2's default modulation depth, 50 cents
)
TOP = 16000.0  # Where a cutoff that follows the pitch stops, well below the 24 kHz the engine runs at
# A soft clip, tanh(6x) scaled to reach 1, which a reed is pushed into as it is blown harder. A wave driven into it stays
# inside -1 to 1, where the curve bends smoothly, since the shaper clamps what is beyond that, which would be a hard clip.
SATURATE = [
    round(math.tanh(6.0 * (k / 128 - 1)) / math.tanh(6.0), 6) for k in range(257)
]


def vibrato(v: Voice, rate: float, depth: Ref | float) -> Ref:
    """An LFO in semitones: the instrument's own `depth`, and as much again as the wheel asks for. The wheel's share goes
    through the note's gate, which makes the LFO the voice's own, as a player's vibrato is: an LFO that only a track's
    parameters drive is the track's, shared by every note and still while the transport is stopped."""
    g = v.g
    wheel = g.mul(g.mul(v.wheel, WHEEL_VIBRATO), v.key.gate)
    return g.node("lfo", {"rate": rate, "depth": g.add(depth, wheel)})


def capped(v: Voice, hz: Ref) -> Ref:
    """A cutoff that follows the pitch, held below TOP."""
    return v.g.node("math", {"a": hz, "b": TOP}, mode="min")


def above(v: Voice, knee: float) -> Ref:
    """How far the note is above `knee` Hz, and 0 below it. A fixed filter that adds this, times a few, opens for notes
    above where it was written for and is exactly what it was below, where the pieces play."""
    return v.g.node("math", {"a": v.g.add(v.freq, -knee), "b": 0.0}, mode="max")


# Brass --------------------------------------------------------------------------------------------------------------


def brass(
    bright: float,
    floor: float,
    formant: float,
    vibrato_depth: float,
    breath: float,
    attack: float,
    clean: bool = False,
    mute: bool = False,
    players: tuple[float, ...] = (0.0,),
):
    """MakePieces' brass(): a saw through a filter that opens as it is blown harder, a soft clip that adds the brassy
    edge, a formant and breath, with its colour as arguments. `mute` puts a straight mute in the bell, and `players`
    detunes several saws, in semitones, for a section."""

    def build(v: Voice) -> Ref:
        g = v.g
        # Lips start a little flat, and vibrato arrives late, on long notes only, unless the wheel asks for it.
        scoop = g.mul(g.snap(g.env(0.001, 0.05, 0.0, 0.01)), -0.3)
        swell = g.env(0.5, 0.1, 1.0, 0.1)
        wobble = vibrato(v, 5.2, g.mul(g.snap(swell), vibrato_depth))
        pitch = g.add(v.pitch, g.add(scoop, wobble))
        saw = None
        for cents in players:
            one = g.osc("saw", g.mtof(pitch if cents == 0 else g.add(pitch, cents)))
            saw = one if saw is None else g.add(saw, one)
        if len(players) > 1:
            # The players' saws start together, so for a moment they add up in phase, and they are scaled so that
            # even then they drive the clip no harder than one does.
            saw = g.mul(saw, 1.0 / len(players))
        blow = g.env(attack, 0.15, 0.8, 0.09)
        effort = g.mul(v.velocity, g.snap(blow))
        # Pressure on a held note blows it brighter, as more velocity would, without the louder attack.
        opening = g.add(effort, g.mul(v.pressure, 0.5))
        # Above the notes it is written for, the filters follow the pitch, so a high note isn't filtered away.
        knee = above(v, bright * 0.6)
        over = g.mul(knee, 2.5)
        cutoff = capped(v, g.add(g.add(g.mul(opening, bright), floor), over))
        tone = g.filter(
            "lowpass",
            g.filter("lowpass", saw, cutoff, 0.7),
            capped(v, g.add(over, bright * 1.2)),
            0.7,
        )
        driven = g.mul(tone, g.add(g.mul(effort, 1.3), 0.4))
        shaped = g.add(driven, g.mul(g.mul(g.mul(driven, driven), driven), -0.33))
        # A mute makes its own formant, so a muted horn goes without the bell's.
        horn = (
            shaped
            if mute
            else g.add(shaped, g.mul(g.filter("bandpass", shaped, formant, 1.1), 1.1))
        )
        if clean:
            horn = g.filter(
                "lowpass",
                g.filter("highpass", horn, 420.0),
                capped(v, g.add(over, 4200.0)),
            )
        if mute:
            # A straight mute stops the bell's low end and rings at its own resonance, about 1.4 kHz, which is what
            # makes it nasal: a resonant high-pass. Above that the horn gets out as it was.
            horn = g.filter("highpass", horn, capped(v, g.add(knee, 1400.0)), 2.5)
        if breath:
            air = g.mul(
                g.filter("bandpass", g.node("noise"), 2600.0, 0.8),
                g.env(0.002, 0.08, 0.03, 0.05),
            )
            horn = g.add(horn, g.mul(air, breath))
        sound = g.mul(horn, blow)
        level = g.mul(g.add(v.velocity, 0.45), 0.42)
        if mute:
            # A note high enough to get through the mute whole would be louder than the stopped ones below it, so a
            # note above 1 kHz is turned down, by half at 3 kHz.
            level = g.mul(
                level,
                g.node(
                    "math",
                    {"a": 2000.0, "b": g.add(above(v, 1000.0), 2000.0)},
                    mode="divide",
                ),
            )
        return g.mul(sound, level)

    return build


def synth_brass(v: Voice) -> Sound:
    """An analogue synth's brass: two detuned saws, one to each side, through four-pole low-passes whose envelope swells
    open and settles, further the harder the key, over a cutoff that follows the pitch."""
    g = v.g
    pitch = g.add(v.pitch, vibrato(v, 5.5, 0.0))
    sweep = g.snap(g.env(0.06, 0.4, 0.35, 0.25))
    opening = g.add(
        g.mul(v.velocity, g.add(g.mul(sweep, 4200.0), 900.0)),
        g.mul(v.pressure, 2000.0),
    )
    cutoff = capped(v, g.add(g.add(g.mul(v.freq, 1.5), 250.0), opening))
    amp = g.mul(
        g.env(0.01, 0.3, 0.85, 0.18),
        g.add(g.mul(g.mul(v.velocity, v.velocity), 0.9), 0.1),
    )
    sides = []
    for cents in (-0.07, 0.07):
        saw = g.osc("saw", g.mtof(g.add(pitch, cents)))
        tone = g.filter("lowpass", g.filter("lowpass", saw, cutoff, 1.1), cutoff, 0.7)
        sides.append(g.mul(tone, amp))
    # Each saw leans to its own side, so the pair is wide and still sums to the same sound in mono.
    left, right = sides
    return (
        g.add(g.mul(left, 0.8), g.mul(right, 0.2)),
        g.add(g.mul(left, 0.2), g.mul(right, 0.8)),
    )


# Reeds --------------------------------------------------------------------------------------------------------------


def reed(low: float, high: float, width: float):
    """MakePieces' reed(): a double reed, a narrow pulse through two formants, brighter as it is blown harder."""

    def build(v: Voice) -> Ref:
        g = v.g
        wobble = vibrato(v, 5.0, g.mul(g.snap(g.env(0.35, 0.1, 1.0, 0.1)), 0.06))
        buzz = g.osc("square", g.mtof(g.add(v.pitch, wobble)), width=width)
        blow = g.env(0.02, 0.1, 0.75, 0.06)
        open_by = g.add(g.mul(g.snap(blow), v.velocity), g.mul(v.pressure, 0.5))
        # Above the notes it is written for, the low-pass follows the pitch, so a high note isn't filtered away.
        over = g.mul(above(v, high * 0.6), 2.5)
        cutoff = capped(v, g.add(g.add(g.mul(open_by, 2600.0), 900.0), over))
        body = g.mul(g.filter("lowpass", buzz, cutoff, 0.7), 0.5)
        body = g.add(body, g.mul(g.filter("bandpass", buzz, low, 2.0), 1.2))
        body = g.add(body, g.mul(g.filter("bandpass", buzz, high, 3.0), 0.7))
        return g.mul(g.mul(body, blow), g.mul(g.add(g.mul(v.velocity, 0.7), 0.3), 0.8))

    return build


def sax(low: float, high: float, bright: float, air: float, growl_hz: float):
    """A saxophone: a conical bore, so every harmonic and not only the odd ones, through two formants, with breath on
    top. It is lipped up into each note, and a hard note growls, rough with the hum of the player's throat, at
    `growl_hz`. `bright` is how far breath opens it, in Hz, and `air` how breathy it is."""

    def build(v: Voice) -> Ref:
        g = v.g
        # The tongue's envelope both lips the pitch up into the note and puffs air at its start.
        tongue = g.snap(g.env(0.001, 0.08, 0.0, 0.01))
        wobble = vibrato(v, 5.0, g.mul(g.snap(g.env(0.6, 0.1, 1.0, 0.1)), 0.1))
        f = g.mtof(g.add(v.pitch, g.add(g.mul(tongue, -0.45), wobble)))
        blow = g.env(0.015, 0.2, 0.85, 0.08)
        breath = g.add(g.mul(v.velocity, g.snap(blow)), g.mul(v.pressure, 0.4))
        # Breath goes in with the reed's buzz, so the bore colours it as it does the tone, and puffs at the tongue.
        puff = g.mul(g.add(g.mul(tongue, 0.2), air), g.add(breath, 0.3))
        reed_ = g.add(g.osc("saw", f), g.mul(g.node("noise"), puff))
        # The cutoff follows the pitch, so every note has its harmonics, and breath opens it further.
        cutoff = capped(
            v,
            g.add(g.mul(v.freq, g.add(g.mul(breath, 5.0), 2.0)), g.mul(breath, bright)),
        )
        tone = g.filter("lowpass", reed_, cutoff, 0.8)
        body = g.add(tone, g.mul(g.filter("bandpass", tone, low, 1.4), 1.2))
        body = g.add(body, g.mul(g.filter("bandpass", tone, high, 2.5), 0.8))
        # Growl only above velocity 90: the hum of the player's throat rides on the tone, and pushes it into a soft clip.
        hard = g.node("math", {"a": g.add(v.velocity, -0.71), "b": 0.0}, mode="max")
        hum = g.add(g.mul(g.osc("sine", growl_hz), g.mul(hard, 1.2)), 1.0)
        driven = g.mul(g.mul(body, hum), g.add(g.mul(hard, 0.5), 0.09))
        edge = g.node("shape", {"in": driven}, curve=SATURATE)
        level = g.add(g.mul(g.mul(v.velocity, v.velocity), 0.75), 0.25)
        # The clip bends an uneven wave, which leaves an offset.
        return g.filter("highpass", g.mul(g.mul(edge, blow), level), 35.0)

    return build


def clarinet(v: Voice) -> Ref:
    """A clarinet: a cylindrical bore closed at the reed, so a square wave's odd harmonics, darker in the low register
    and opened by breath, with no vibrato of its own, as classical players use none."""
    g = v.g
    f = g.mtof(g.add(v.pitch, vibrato(v, 5.0, 0.0)))
    reed_ = g.osc("square", f)
    blow = g.env(0.03, 0.2, 0.9, 0.07)
    breath = g.add(g.mul(v.velocity, g.snap(blow)), g.mul(v.pressure, 0.4))
    cutoff = capped(
        v, g.add(g.mul(v.freq, g.add(g.mul(breath, 4.0), 1.6)), g.mul(breath, 900.0))
    )
    tone = g.filter("lowpass", reed_, cutoff, 0.7)
    tone = g.add(tone, g.mul(g.filter("bandpass", tone, 1500.0, 1.5), 0.4))
    air = g.mul(g.filter("bandpass", g.node("noise"), 2400.0, 1.0), 0.05)
    sound = g.mul(g.add(tone, g.mul(air, g.add(breath, 0.3))), blow)
    level = g.add(g.mul(g.mul(v.velocity, v.velocity), 0.88), 0.12)
    return g.mul(sound, level)


# Pipes --------------------------------------------------------------------------------------------------------------


def pipe(
    second: float,
    third: float,
    breath: float,
    focus: float,
    chiff: float,
    scoop: float,
    scoop_time: float,
    vibrato_depth: float,
    vibrato_rate: float,
    attack: float,
):
    """A flute, or anything blown across an edge: a near sine with a little of its second and third harmonics, which
    breath brings out, air pitched at the note (`focus` is how narrow), a chiff of noise as each note speaks, and a scoop
    of `scoop` semitones up into the pitch over `scoop_time`. Its vibrato swells in, in pitch and in level, as players'
    does."""

    def build(v: Voice) -> Ref:
        g = v.g
        # One quick envelope is both the puff that makes a note speak and the scoop up into its pitch.
        puff = g.env(0.001, scoop_time, 0.0, 0.01)
        swell = g.snap(g.env(0.45, 0.1, 1.0, 0.1))
        wobble = vibrato(v, vibrato_rate, g.mul(swell, vibrato_depth))
        f = g.mtof(g.add(v.pitch, g.add(g.mul(g.snap(puff), -scoop), wobble)))
        blow = g.env(attack, 0.15, 0.9, 0.1)
        effort = g.add(g.mul(v.velocity, g.snap(blow)), g.mul(v.pressure, 0.4))
        # The upper harmonics fade out as they near the top of what the engine can play, rather than fold.
        fade = g.node(
            "math",
            {
                "a": g.mul(g.add(g.mul(v.freq, -3.0), 20000.0), 1.0 / 6000.0),
                "b": 0.0,
                "c": 1.0,
            },
            mode="clip",
        )
        # Below the range any pipe is made for, a sine alone would be too low to hear, so the harmonics come in instead.
        deep = g.node(
            "math",
            {"a": g.add(g.mul(v.freq, -1.0 / 250.0), 1.0), "b": 0.0, "c": 1.0},
            mode="clip",
        )
        overtones = g.add(
            g.mul(
                g.osc("sine", g.mul(f, 2.0)),
                g.mul(
                    g.add(g.add(g.mul(effort, second), second * 0.3), g.mul(deep, 0.6)),
                    fade,
                ),
            ),
            g.mul(
                g.osc("sine", g.mul(f, 3.0)),
                g.mul(g.add(g.mul(effort, third), g.mul(deep, 0.4)), fade),
            ),
        )
        tone = g.add(g.osc("sine", f), overtones)
        # The air is a band of noise at the note, which is wider for a higher note, so it is turned down as the pitch
        # rises, to keep the breath about as loud against the tone across the range. Its band stays on the key, since a
        # vibrato or a scoop inside it would change nothing anyone hears.
        noise = g.node("noise")
        narrow = g.add(
            g.node(
                "math",
                {
                    "a": g.node("math", {"a": 300.0, "b": v.freq}, mode="divide"),
                    "b": 2.0,
                },
                mode="min",
            ),
            0.5,
        )
        air = g.filter("bandpass", noise, capped(v, v.freq), focus)
        speak = g.filter("bandpass", noise, capped(v, g.mul(v.freq, 3.0)), 1.2)
        level = g.add(g.mul(g.mul(v.velocity, v.velocity), 0.88), 0.12)
        # Vibrato moves the level too, as a flautist's does, by a few percent at the instrument's own depth.
        tremolo = g.add(g.mul(wobble, 0.5), 1.0)
        held = g.add(
            tone, g.mul(air, g.mul(narrow, g.add(g.mul(effort, breath), breath * 0.5)))
        )
        chiffed = g.mul(
            speak, g.mul(puff, g.mul(narrow, g.mul(g.add(v.velocity, 0.3), chiff)))
        )
        return g.add(
            g.mul(held, g.mul(blow, g.mul(tremolo, level))),
            g.mul(chiffed, level),
        )

    return build


# The set ------------------------------------------------------------------------------------------------------------


def tune(low: int, high: int, chord: bool = False) -> Phrase:
    """A wind's audition: a legato rise from soft to loud, tongued notes at full breath, a long note for the vibrato,
    and then a soft one, or a chord for the ones that are sections."""
    centre = (low + high) // 2
    root = centre - centre % 12
    if root < low:
        root += 12
    if root + 12 > high:
        root = max(low, high - 12)
    phrase = [
        (0.0, root, 56, 0.95),
        (1.0, root + 2, 72, 0.95),
        (2.0, root + 4, 88, 0.95),
        (3.0, root + 7, 104, 0.95),
        (4.0, root + 12, 127, 0.2),
        (4.5, root + 11, 120, 0.2),
        (5.0, root + 9, 120, 0.2),
        (5.5, root + 7, 116, 0.2),
        (6.0, root + 4, 100, 3.5),
    ]
    if chord:
        return phrase + [(10.0, root + c, 100, 2.0) for c in (0, 4, 7, 12)]
    return phrase + [(10.0, root, 40, 2.0)]


def wind(name, title, family, build, low, high, programs, listen_for, chord=False):
    """An instrument of these families, auditioned on a wind's phrase."""
    return Instrument(
        name,
        title,
        family,
        build,
        low,
        high,
        programs=programs,
        phrase=tune(low, high, chord),
        listen_for=listen_for,
    )


INSTRUMENTS = [
    # Brass. The trumpet is the chorale's: the Grieg's differs only in a little less vibrato and a quicker attack. The
    # horn is the chorale's too, whose attack is slower than the Grieg's. Both synth brass programs play one.
    wind(
        "Trumpet",
        "Trumpet",
        "Brass",
        brass(2600, 650, 1300, 0.08, 0.1, 0.03, clean=True),
        54,
        84,
        [56],
        "A bright trumpet that scoops up to each note, opens out as it is blown harder, and takes vibrato late on a long note.",
    ),
    wind(
        "Trombone",
        "Trombone",
        "Brass",
        brass(1700, 300, 600, 0.03, 0.05, 0.05),
        40,
        72,
        [57],
        "A broad trombone, darker than the trumpet, that blares when it is played hard.",
    ),
    wind(
        "Tuba",
        "Tuba",
        "Brass",
        brass(900, 110, 260, 0.02, 0.0, 0.06),
        28,
        65,
        [58],
        "A deep, round tuba whose low notes stay soft-edged, getting a little brassier only when it is played hard.",
    ),
    wind(
        "MutedTrumpet",
        "Muted trumpet",
        "Brass",
        brass(3200, 700, 1300, 0.05, 0.06, 0.02, mute=True),
        54,
        84,
        [59],
        "A trumpet through a straight mute: thin, nasal and buzzing, with its low end stopped.",
    ),
    wind(
        "FrenchHorn",
        "French horn",
        "Brass",
        brass(1250, 260, 480, 0.04, 0.03, 0.07),
        41,
        77,
        [60],
        "A warm, covered horn with a soft swell on each attack.",
    ),
    wind(
        "BrassSection",
        "Brass section",
        "Brass",
        brass(2300, 450, 1000, 0.03, 0.0, 0.04, players=(-0.09, 0.0, 0.11)),
        41,
        84,
        [61],
        "Several brass players on each note, a few cents apart, so it is thick and slowly beating.",
        chord=True,
    ),
    wind(
        "SynthBrass",
        "Synth brass",
        "Brass",
        synth_brass,
        36,
        84,
        [62, 63],
        "An analogue synth brass: detuned saws whose filter swells open on each note and settles, brighter the harder it is struck.",
        chord=True,
    ),
    # Reeds. The soprano sax plays the alto, and the baritone the tenor.
    wind(
        "AltoSax",
        "Alto sax",
        "Reed",
        sax(700, 1750, 2500.0, 0.09, 95.0),
        49,
        84,
        [64, 65],
        "A bright, breathy alto sax that lips up into its notes and growls when it is played hard.",
    ),
    wind(
        "TenorSax",
        "Tenor sax",
        "Reed",
        sax(480, 1350, 1300.0, 0.12, 80.0),
        40,
        76,
        [66, 67],
        "A husky tenor sax, darker than the alto, that growls when it is played hard.",
    ),
    wind(
        "Oboe",
        "Oboe",
        "Reed",
        reed(1100, 2900, 0.18),
        58,
        91,
        [68],
        "A thin, nasal oboe with a gentle vibrato that arrives on long notes.",
    ),
    wind(
        "EnglishHorn",
        "English horn",
        "Reed",
        reed(800, 2200, 0.22),
        52,
        81,
        [69],
        "A darker, more veiled oboe, a fifth lower.",
    ),
    wind(
        "Bassoon",
        "Bassoon",
        "Reed",
        reed(480, 1150, 0.28),
        34,
        75,
        [70],
        "A reedy, woody bassoon, buzzing in its low notes.",
    ),
    wind(
        "Clarinet",
        "Clarinet",
        "Reed",
        clarinet,
        50,
        91,
        [71],
        "A hollow clarinet of odd harmonics, woody in its low register and brighter as it is blown harder, with no vibrato.",
    ),
    # Pipes. The piccolo plays the flute, and the whistle the ocarina.
    wind(
        "Flute",
        "Flute",
        "Pipe",
        pipe(
            second=0.15,
            third=0.06,
            breath=0.38,
            focus=4.0,
            chiff=0.5,
            scoop=0.1,
            scoop_time=0.04,
            vibrato_depth=0.07,
            vibrato_rate=5.0,
            attack=0.05,
        ),
        60,
        98,
        [72, 73],
        "A soft, airy flute that speaks with a little chiff and takes vibrato on long notes.",
    ),
    wind(
        "Recorder",
        "Recorder",
        "Pipe",
        pipe(
            second=0.05,
            third=0.08,
            breath=0.16,
            focus=6.0,
            chiff=0.7,
            scoop=0.0,
            scoop_time=0.03,
            vibrato_depth=0.02,
            vibrato_rate=5.5,
            attack=0.025,
        ),
        60,
        96,
        [74],
        "A pure, plain recorder with a clean chiff at the start of each note and almost no vibrato.",
    ),
    wind(
        "PanFlute",
        "Pan flute",
        "Pipe",
        pipe(
            second=0.08,
            third=0.0,
            breath=0.9,
            focus=3.0,
            chiff=1.2,
            scoop=0.35,
            scoop_time=0.06,
            vibrato_depth=0.05,
            vibrato_rate=5.0,
            attack=0.03,
        ),
        55,
        91,
        [75],
        "A breathy pan flute that puffs into each note, sliding up to it.",
    ),
    wind(
        "BlownBottle",
        "Blown bottle",
        "Pipe",
        pipe(
            second=0.0,
            third=0.0,
            breath=4.0,
            focus=12.0,
            chiff=0.3,
            scoop=0.25,
            scoop_time=0.1,
            vibrato_depth=0.03,
            vibrato_rate=4.5,
            attack=0.08,
        ),
        55,
        84,
        [76],
        "A hollow hoot of air across a bottle's mouth, mostly breath, sliding up into each note.",
    ),
    wind(
        "Shakuhachi",
        "Shakuhachi",
        "Pipe",
        pipe(
            second=0.1,
            third=0.06,
            breath=1.15,
            focus=2.0,
            chiff=1.4,
            scoop=0.9,
            scoop_time=0.16,
            vibrato_depth=0.09,
            vibrato_rate=4.5,
            attack=0.06,
        ),
        55,
        86,
        [77],
        "A rough, breathy shakuhachi that bends up from well below each note and swells into a slow vibrato.",
    ),
    wind(
        "Ocarina",
        "Ocarina",
        "Pipe",
        pipe(
            second=0.02,
            third=0.03,
            breath=0.15,
            focus=8.0,
            chiff=0.2,
            scoop=0.05,
            scoop_time=0.03,
            vibrato_depth=0.05,
            vibrato_rate=5.5,
            attack=0.03,
        ),
        60,
        91,
        [78, 79],
        "An almost pure, round tone, as an ocarina or a whistle makes, with a little vibrato.",
    ),
]
