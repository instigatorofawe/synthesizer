"""The orchestra: GM's strings (programs 40 to 47) and ensembles (48 to 55).

The pizzicato, the string section and the timpani are the ones In the Hall of the Mountain King was written for in
MakePieces.py, ported as they were so the piece keeps its sound when it is rebuilt on the set. The rest are new: solo
strings with a body and a vibrato that arrives late, a tremolo section, a harp, string machines, formant choirs and a
stab.
"""

from Graph import Graph, Ref
from Instrument import Instrument, Phrase, Sound, Voice

WHEEL_VIBRATO = 0.4  # Semitones of vibrato the mod wheel adds at the top of its travel, on everything sustained


# Pieces every voice here is made of ----------------------------------------------------------------------------------


def clamp_cutoff(
    g: Graph, cutoff, highest: float = 14000.0, note: Ref | None = None
) -> Ref:
    """A cutoff held well below the top of the band, however high the note and however hard it is played. Given the
    `note`'s frequency, it is also kept half an octave above it, so a note played far above the range a fixed
    cutoff was written for keeps its fundamental."""
    if note is None:
        return g.node("math", {"a": cutoff, "b": highest}, mode="min")
    return g.node(
        "math", {"a": cutoff, "b": g.mul(note, 1.5), "c": highest}, mode="clip"
    )


def late(g: Graph, wait: float, grow: float) -> Ref:
    """0 for the first `wait` seconds of a note, then rising to 1 over `grow` more, as a player's vibrato arrives on a
    note held long enough for it. The envelope's attack is linear, so a line through it, clipped, starts late."""
    ramp = g.snap(g.env(wait + grow, 0.1, 1.0, 0.1))
    line = g.add(g.mul(ramp, (wait + grow) / grow), -wait / grow)
    return g.node("math", {"a": line, "b": 0.0, "c": 1.0}, mode="clip")


def vibrato(v: Voice, rate: float, depth, wheel: float = WHEEL_VIBRATO) -> Ref:
    """A pitch offset in semitones: `depth` of the player's own, and as much again as the mod wheel asks for."""
    g = v.g
    return g.node("lfo", {"rate": rate, "depth": g.add(g.mul(v.wheel, wheel), depth)})


def loudness(v: Voice, floor: float) -> Ref:
    """A level from velocity that falls about 10 dB from 127 to 64 and never to silence: `floor` at the softest."""
    g = v.g
    return g.add(g.mul(g.mul(v.velocity, v.velocity), 1.0 - floor), floor)


# Strings ------------------------------------------------------------------------------------------------------------


def solo(
    body: list[tuple[float, float, float]],
    bright: float,
    attack: float,
    release: float,
    rate: float,
    depth: float,
):
    """A solo bowed string: one saw, as the bow's stick and slip makes, a scratch of the hair as it bites, and the
    body's resonances, fixed in pitch whatever note is played, as a wooden box's are. Its vibrato waits for a note to
    be held. `body` is each resonance's frequency, q and level; `bright` the cutoff in Hz at full bow."""

    def build(v: Voice) -> Sound:
        g = v.g
        wobble = vibrato(v, rate, g.mul(late(g, 0.22, 0.5), depth))
        f = g.mtof(g.add(v.pitch, wobble))
        # The hair's scratch as it bites, and its hiss after, go through the body with the string.
        hair = g.mul(g.node("noise"), g.env(0.004, 0.07, 0.04, 0.05))
        string = g.add(g.osc("saw", f), g.mul(hair, 0.5))
        # More bow, or more weight on it, is brighter.
        weight = g.add(g.mul(v.velocity, 0.7), g.add(g.mul(v.pressure, 0.5), 0.3))
        cutoff = clamp_cutoff(g, g.mul(weight, bright), note=f)
        tone = g.filter("lowpass", string, cutoff, 0.7)
        sound = g.mul(tone, 0.5)
        for hz, q, level in body:
            sound = g.add(sound, g.mul(g.filter("bandpass", tone, hz, q), level))
        # A harder stroke speaks sooner.
        bow = g.env(
            g.mul(g.add(g.mul(v.velocity, -0.7), 1.2), attack), 0.25, 0.85, release
        )
        return g.mul(g.mul(sound, bow), loudness(v, 0.12))

    return build


def tremolo(v: Voice) -> Sound:
    """A section bowing as fast as it can: the section's three saws, with two desks' strokes, out of step with each
    other, as an amplitude flutter about thirteen times a second, one desk to each side."""
    g = v.g
    pitch = g.add(v.pitch, vibrato(v, 5.4, 0.06))
    low = g.osc("saw", g.mtof(g.add(pitch, -0.08)))
    high = g.osc("saw", g.mtof(g.add(pitch, 0.08)))
    middle = g.mul(g.osc("saw", g.mtof(pitch)), 0.5)

    def strokes(rate: float) -> Ref:
        # Each stroke swells and falls back, peaked rather than smooth, as a bow changing direction is.
        half = g.add(g.mul(g.osc("sine", rate), 0.5), 0.5)
        return g.add(g.mul(g.mul(half, half), 0.75), 0.25)

    cutoff = clamp_cutoff(g, g.add(g.mul(v.velocity, 4000.0), 1400.0), note=v.freq)
    level = g.mul(g.env(0.04, 0.15, 0.85, 0.2), loudness(v, 0.15))
    desks = []
    for saw, rate in ((low, 12.6), (high, 14.1)):
        desk = g.mul(g.add(saw, middle), strokes(rate))
        desks.append(g.mul(g.filter("lowpass", desk, cutoff, 0.6), level))
    return tuple(desks)


def pizzicato(v: Voice) -> Sound:
    """A plucked string: bright at the pluck, ringing longer the lower it is, through a wooden body. MakePieces.py's
    pizzicato, as the Mountain King's basses tiptoed on."""
    g, key, f = v.g, v.key, v.freq
    string = g.add(g.osc("saw", f), g.osc("triangle", f))
    pluck = g.snap(g.env(0.0005, 0.12, 0.0, 0.05))
    harmonics = g.mul(
        g.add(g.mul(pluck, 14.0), 2.0), g.add(g.mul(key.velocity, 0.8), 0.6)
    )
    tone = g.filter(
        "lowpass",
        string,
        g.node("math", {"a": g.mul(f, harmonics), "b": 12000.0}, mode="min"),
        0.9,
    )
    body = g.add(tone, g.mul(g.filter("bandpass", tone, 280.0, 1.5), 0.8))
    ring = g.env(0.001, g.keyed(key.pitch, 0.9), 0.0, 0.12)
    return g.mul(g.mul(body, ring), g.add(g.mul(key.velocity, 0.75), 0.25))


def harp(v: Voice) -> Sound:
    """A gut string plucked by a finger: a round fundamental that rings for seconds, longer in the bass, over a
    brighter pluck whose upper harmonics die away first."""
    g, f = v.g, v.freq
    pluck = g.snap(g.env(0.0008, g.keyed(v.key.pitch, 0.25), 0.0, 0.2))
    harmonics = g.mul(g.add(g.mul(pluck, 7.0), 1.6), g.add(g.mul(v.velocity, 0.7), 0.5))
    # The cutoff follows the note, and a bass string's wound core keeps a few hundred Hz of its harmonics as it rings.
    cutoff = clamp_cutoff(g, g.add(g.mul(f, harmonics), 400.0), 12000.0)
    bright = g.filter("lowpass", g.osc("saw", f), cutoff, 0.7)
    # Those harmonics are most of what is heard of a bass string, whose fundamental is too low to carry, and a treble
    # string is nearly a sine: the pluck is louder against the fundamental the lower the note.
    rich = g.node("math", {"a": g.keyed(v.key.pitch, 0.6), "b": 1.8}, mode="min")
    round_ = g.add(g.osc("sine", f), g.mul(g.osc("sine", g.mul(f, 2.0)), 0.25))
    ring = g.env(0.0015, g.keyed(v.key.pitch, 2.6), 0.0, 0.6)
    sound = g.mul(g.add(g.mul(bright, rich), round_), ring)
    return g.mul(sound, loudness(v, 0.15))


def timpani(v: Voice) -> Sound:
    """A kettledrum: a few inharmonic modes that start a little sharp and settle, over a felt thump. MakePieces.py's
    timpani, tuned to the Mountain King's B and F sharp."""
    g, key = v.g, v.key
    f = g.mtof(g.add(v.pitch, g.mul(g.snap(g.env(0.001, 0.08, 0.0, 0.01)), 0.4)))
    modes = g.osc("sine", f)
    for ratio, level in ((1.504, 0.5), (1.742, 0.25), (2.0, 0.2)):
        modes = g.add(modes, g.mul(g.osc("sine", g.mul(f, ratio)), level))
    ring = g.env(0.002, 2.2, 0.0, 0.6)
    thump = g.filter(
        "lowpass", g.node("noise"), g.add(g.mul(key.velocity, 1500.0), 300.0)
    )
    thump = g.mul(thump, g.env(0.0005, 0.06, 0.0, 0.03))
    sound = g.add(g.mul(modes, ring), g.mul(thump, 0.8))
    return g.mul(sound, g.add(g.mul(key.velocity, 0.8), 0.2))


# Ensembles ----------------------------------------------------------------------------------------------------------


def bowed(
    attack: float = 0.03,
    release: float = 0.22,
    wide: bool = False,
    steep: bool = False,
    floor: float = 110.0,
):
    """A string section: three saws a few cents apart, a vibrato they share, and a filter opened by the bow.
    MakePieces.py's strings as the Mountain King's violins, cellos and basses played them, with the mod wheel's
    vibrato added. `wide` sets the outer two players apart, left and right, for a section that fills the stage.
    `steep` gives velocity the set's 10 dB from 127 to 64, where the piece's strings, which it kept, move 5, and
    `floor` is where the low end is thinned."""

    def build(v: Voice) -> Sound:
        g, key = v.g, v.key
        pitch = g.add(v.pitch, vibrato(v, 5.4, 0.09))
        below = g.osc("saw", g.mtof(g.add(pitch, -0.08)))
        above = g.osc("saw", g.mtof(g.add(pitch, 0.08)))
        centre = g.mul(g.osc("saw", g.mtof(pitch)), 0.8)
        bow = g.env(attack, 0.15, 0.85, release)
        cutoff = g.add(g.mul(key.velocity, 4000.0), 1400.0)
        level = loudness(v, 0.15) if steep else g.add(g.mul(key.velocity, 0.8), 0.2)

        def section(saws: Ref) -> Ref:
            tone = g.filter("lowpass", saws, cutoff, 0.6)
            tone = g.filter("highpass", tone, floor)
            return g.mul(g.mul(tone, bow), level)

        if not wide:
            return section(g.add(g.add(below, above), centre))
        return section(g.add(below, centre)), section(g.add(above, centre))

    return build


def machine(v: Voice) -> Sound:
    """A string machine: four saws drifting slowly against each other, two to each side, the shimmer its ensemble
    chorus gave the organ-like tone inside one, through a gentle low-pass."""
    g = v.g
    pitch = g.add(v.pitch, vibrato(v, 5.6, 0.0))
    sides = []
    for pairs in (((-0.13, 0.63), (0.05, 1.07)), ((0.13, 0.81), (-0.05, 1.31))):
        side = None
        for detune, drift in pairs:
            wander = g.node("lfo", {"rate": drift, "depth": 0.05})
            saw = g.osc("saw", g.mtof(g.add(pitch, g.add(wander, detune))))
            side = saw if side is None else g.add(side, saw)
        sides.append(side)
    cutoff = clamp_cutoff(
        g,
        g.add(g.mul(v.velocity, 3500.0), g.add(g.mul(v.pressure, 2000.0), 2200.0)),
        note=v.freq,
    )
    swell = g.env(0.12, 0.3, 0.9, 0.3)
    level = g.mul(swell, loudness(v, 0.12))
    return tuple(g.mul(g.filter("lowpass", side, cutoff, 0.7), level) for side in sides)


def pwm(v: Voice) -> Sound:
    """A softer string machine: two pulses a few cents apart whose widths sweep slowly, out of step, which hollows
    and thickens the tone as the PwmPad recipe's does, one to each side."""
    g = v.g
    pitch = g.add(v.pitch, vibrato(v, 5.2, 0.0))
    swell = g.env(0.3, 0.4, 0.9, 0.3)
    level = g.mul(swell, loudness(v, 0.12))
    cutoff = clamp_cutoff(
        g,
        g.add(g.mul(v.velocity, 2400.0), g.add(g.mul(v.pressure, 1500.0), 1500.0)),
        note=v.freq,
    )
    sides = []
    for detune, rate in ((-0.07, 0.7), (0.07, 0.93)):
        width = g.add(g.node("lfo", {"rate": rate, "depth": 0.3}), 0.5)
        pulse = g.osc("square", g.mtof(g.add(pitch, detune)), width=width)
        sides.append(g.mul(g.filter("lowpass", pulse, cutoff, 0.6), level))
    return tuple(sides)


def voices(
    vowel: tuple[tuple[float, float, float], ...],
    singers: tuple[tuple[float, float], ...],
    attack: float,
    release: float,
    breath: float,
    depth: float,
    pulse: bool = False,
    sweep: float = 0.0,
):
    """Voices: each singer a saw, or with `pulse` a narrow pulse, with their own vibrato, a few cents from the others,
    through three formants that make the vowel. The lowest formant rises with the note once the note passes it, as a
    soprano opens her mouth for a high one, so a high note isn't left between the formants. `vowel` is each formant's
    Hz, q and level; `singers` each one's detune and vibrato rate; `sweep` how many Hz the second formant wanders,
    slowly, which no singer holding a vowel would do and a synthesiser's voice does."""

    def build(v: Voice) -> Sound:
        g = v.g
        # Every singer's vibrato arrives together, each at their own rate.
        arrives = g.mul(late(g, 0.1, 0.4), depth)
        source = None
        for detune, rate in singers:
            pitch = g.add(v.pitch, g.add(vibrato(v, rate, arrives), detune))
            if pulse:
                one = g.osc("square", g.mtof(pitch), width=0.3)
            else:
                one = g.osc("saw", g.mtof(pitch))
            source = one if source is None else g.add(source, one)
        if breath:
            source = g.add(source, g.mul(g.node("noise"), breath))
        sound = None
        for n, (hz, q, level) in enumerate(vowel):
            cutoff = hz
            if n == 0:
                cutoff = g.node("math", {"a": g.mul(v.freq, 1.1), "b": hz}, mode="max")
            elif n == 1 and sweep:
                cutoff = g.add(g.node("lfo", {"rate": 0.23, "depth": sweep}), hz)
            # A voice sung louder carries more of its upper formants.
            if n > 0:
                level = g.mul(g.add(g.mul(v.velocity, 0.8), 0.4), level)
            band = g.mul(g.filter("bandpass", source, cutoff, q), level)
            sound = band if sound is None else g.add(sound, band)
        swell = g.env(attack, 0.3, 0.9, release)
        # A high note finds its fundamental in the lowest formant and a low one only its upper harmonics, so the level
        # falls 3 dB an octave up the range to keep them even. Below two octaves under middle C it stops rising, as
        # the harmonics there are dense enough to fill every formant.
        tilt = g.node("ratio", {"in": g.add(g.mul(v.pitch, -0.5), 90.0)}, root=60)
        tilt = g.node("math", {"a": tilt, "b": 2.0}, mode="min")
        return g.mul(g.mul(sound, swell), g.mul(loudness(v, 0.15), tilt))

    return build


def hit(v: Voice) -> Sound:
    """An orchestra hit: a whole orchestra's chord, the note with its fifth and octave above and its octave below,
    struck at once and cut short, with a crash of noise at the front and the edge of brass driven hard. It has no
    third, so it fits a major key and a minor one alike."""
    g = v.g
    f = v.freq
    chord = g.add(g.osc("saw", f), g.osc("saw", g.mul(f, 1.4983)))
    chord = g.add(chord, g.mul(g.osc("saw", g.mul(f, 2.0)), 0.7))
    chord = g.add(chord, g.mul(g.osc("square", g.mul(f, 0.5)), 0.6))
    blast = g.snap(g.env(0.001, 0.12, 0.0, 0.05))
    cutoff = clamp_cutoff(
        g, g.add(g.mul(blast, g.add(g.mul(v.velocity, 6000.0), 2000.0)), 1200.0)
    )
    tone = g.filter("lowpass", chord, cutoff, 0.9)
    # Scaled so the chord's peaks stay under 1.05, where the soft clip below turns back on itself, and driven harder
    # the harder it is struck.
    driven = g.mul(tone, g.add(g.mul(v.velocity, 0.25), 0.2))
    edge = g.add(driven, g.mul(g.mul(g.mul(driven, driven), driven), -0.3))
    crash = g.mul(
        g.filter("bandpass", g.node("noise"), 3000.0, 0.7),
        g.env(0.0005, 0.08, 0.0, 0.05),
    )
    sound = g.mul(g.add(edge, g.mul(crash, 0.4)), g.env(0.002, 0.28, 0.0, 0.12))
    return g.filter("highpass", g.mul(sound, loudness(v, 0.15)), 50.0)


# Auditions ----------------------------------------------------------------------------------------------------------


def melody(root: int) -> Phrase:
    """A slow tune whose long notes are held long enough for a vibrato to arrive, a quicker run down, and a last
    long note."""
    steps = [(0, 1.9, 84), (2, 0.9, 92), (4, 0.9, 100), (7, 3.8, 112)]
    steps += [
        (9, 0.45, 100),
        (7, 0.45, 96),
        (5, 0.45, 92),
        (4, 0.45, 88),
        (2, 0.9, 84),
        (0, 4.0, 76),
    ]
    phrase, beat = [], 0.0
    for step, held, velocity in steps:
        phrase.append((beat, root + step, velocity, held))
        beat += 0.5 if held < 0.5 else round(held + 0.1)
    return phrase


def chords(root: int, held: float = 1.9, minor: bool = False) -> Phrase:
    """I, IV, V and I, or their minor, each with the root under it, getting louder to the V."""
    third = 3 if minor else 4
    shapes = [
        (0, 7, 12, 12 + third),
        (5, 12, 17, 17 + third),
        (7, 14, 19, 23),
        (0, 7, 12, 12 + third),
    ]
    phrase = []
    for n, (shape, velocity) in enumerate(zip(shapes, (80, 92, 108, 88))):
        beat = n * round(held + 0.1)
        phrase.append((beat, root - 12 + shape[0], velocity, held))
        phrase += [(beat, root + step, velocity - 6, held) for step in shape]
    return phrase


def trolls(root: int) -> Phrase:
    """The Mountain King's theme, plucked, as the pizzicato basses tiptoe through it."""
    bars = [
        [(0, 1), (2, 1), (3, 1), (5, 1), (7, 1), (3, 1), (7, 2)],
        [(6, 1), (2, 1), (6, 2), (5, 1), (1, 1), (5, 2)],
        [(0, 1), (2, 1), (3, 1), (5, 1), (7, 1), (3, 1), (7, 1), (12, 1)],
        [(10, 1), (7, 1), (3, 1), (7, 1), (10, 4)],
    ]
    phrase, beat = [], 0.0
    for bar in bars:
        for n, (step, eighths) in enumerate(bar):
            accent = 10 if n == 0 else 0
            phrase.append((beat, root + step, 76 + accent, 0.3 * eighths))
            beat += 0.5 * eighths
    return phrase


def arpeggio(root: int) -> Phrase:
    """Broken chords up two octaves and back, let go as soon as they are plucked, then a chord left to ring."""
    up = [0, 4, 7, 12, 16, 19, 24, 28, 31, 36]
    steps = up + up[-2::-1]
    phrase = [(i * 0.25, root + step, 70 + step, 0.2) for i, step in enumerate(steps)]
    end = len(steps) * 0.25 + 0.5
    return phrase + [
        (end + i * 0.08, root + step, 96, 3.0)
        for i, step in enumerate((-12, 0, 7, 16, 24))
    ]


def rolls(low: int, high: int) -> Phrase:
    """Tonic and dominant struck in turn, a roll that swells, and a last stroke left to ring."""
    phrase = [
        (beat, note, 110, 0.5)
        for beat, note in ((0, high), (1, low), (2, high), (3, low))
    ]
    phrase += [(4 + i * 0.125, high, 60 + i * 4, 0.1) for i in range(16)]
    return phrase + [(6.0, high, 127, 3.0), (6.0, low, 110, 3.0)]


def stabs(root: int) -> Phrase:
    """Hits on and off the beat, as a dance track would place them."""
    rhythm = [
        (0.0, 0),
        (1.5, 0),
        (2.0, 3),
        (3.0, 7),
        (4.0, -2),
        (5.5, -2),
        (6.0, 0),
        (7.0, 12),
    ]
    return [
        (beat, root + step, 116 if beat % 1 == 0 else 104, 0.3) for beat, step in rhythm
    ]


# The set ------------------------------------------------------------------------------------------------------------

AH = ((750.0, 4.0, 1.0), (1150.0, 6.0, 0.55), (2600.0, 8.0, 0.3))
OO = ((320.0, 3.0, 1.0), (870.0, 6.0, 0.3), (2250.0, 8.0, 0.1))
EH_OH = ((560.0, 3.5, 1.0), (1500.0, 5.0, 0.5), (2500.0, 6.0, 0.35))

INSTRUMENTS = [
    Instrument(
        "Violin",
        "Violin",
        "Strings",
        solo(
            [(280.0, 3.0, 0.9), (470.0, 4.0, 0.6), (2800.0, 1.4, 0.8)],
            6500.0,
            0.07,
            0.18,
            5.8,
            0.18,
        ),
        55,
        103,
        programs=[40],
        phrase=melody(67),
        listen_for="A solo violin, bowed: it speaks with a little scratch and sings with a vibrato on its long notes.",
    ),
    Instrument(
        "Viola",
        "Viola",
        "Strings",
        solo(
            [(230.0, 3.0, 0.9), (390.0, 4.0, 0.6), (2200.0, 1.4, 0.7)],
            5000.0,
            0.08,
            0.2,
            5.5,
            0.17,
        ),
        48,
        91,
        programs=[41],
        phrase=melody(60),
        listen_for="A solo viola: darker and more veiled than the violin, with the same late vibrato.",
    ),
    Instrument(
        "Cello",
        "Cello",
        "Strings",
        solo(
            [(110.0, 3.0, 0.8), (210.0, 3.0, 0.6), (1600.0, 1.3, 0.6)],
            3800.0,
            0.09,
            0.24,
            5.2,
            0.16,
        ),
        36,
        76,
        programs=[42],
        phrase=melody(48),
        listen_for="A solo cello: warm and full in the bass, singing in the tenor.",
    ),
    Instrument(
        "Contrabass",
        "Contrabass",
        "Strings",
        solo(
            [(62.0, 2.5, 0.8), (115.0, 3.0, 0.6), (900.0, 1.2, 0.5)],
            2600.0,
            0.12,
            0.28,
            4.8,
            0.14,
        ),
        28,
        60,
        programs=[43],
        phrase=melody(36),
        listen_for="A solo double bass, bowed: a deep growl with a slow, wide vibrato.",
    ),
    Instrument(
        "TremoloStrings",
        "Tremolo strings",
        "Strings",
        tremolo,
        36,
        96,
        programs=[44],
        voices=12,
        phrase=chords(57, 3.9, minor=True),
        listen_for="A string section bowing a fast, shivering tremolo, the desks not quite together.",
    ),
    Instrument(
        "PizzicatoStrings",
        "Pizzicato strings",
        "Strings",
        pizzicato,
        28,
        91,
        programs=[45],
        phrase=trolls(47),
        listen_for="Plucked strings, bright at the pluck and woody, ringing longer in the bass.",
    ),
    Instrument(
        "OrchestralHarp",
        "Orchestral harp",
        "Strings",
        harp,
        23,
        103,
        programs=[46],
        voices=16,
        gated=False,
        phrase=arpeggio(55),
        listen_for="A concert harp: round, plucked notes that ring on, longest in the bass.",
    ),
    Instrument(
        "Timpani",
        "Timpani",
        "Strings",
        timpani,
        40,
        57,
        programs=[47],
        voices=16,
        gated=False,
        phrase=rolls(40, 45),
        listen_for="Kettledrums: a felt thump and a tuned boom that settles onto its pitch and rings.",
    ),
    Instrument(
        "StringEnsemble",
        "String ensemble",
        "Ensemble",
        bowed(),
        28,
        96,
        programs=[48],
        voices=12,
        phrase=chords(60),
        listen_for="A string section, bowed: three players a few cents apart with a shared vibrato, brighter played harder.",
    ),
    Instrument(
        "SlowStrings",
        "Slow strings",
        "Ensemble",
        bowed(attack=0.35, release=0.3, wide=True, steep=True, floor=60.0),
        28,
        96,
        programs=[49],
        voices=12,
        phrase=chords(60, 3.9),
        listen_for="The string section swelling in slowly, spread across the stage, for long chords.",
    ),
    Instrument(
        "SynthStrings",
        "Synth strings",
        "Ensemble",
        machine,
        36,
        96,
        programs=[50],
        voices=12,
        phrase=chords(60),
        listen_for="A string machine: bright, shimmering saws drifting against each other, wide in stereo.",
    ),
    Instrument(
        "SoftSynthStrings",
        "Soft synth strings",
        "Ensemble",
        pwm,
        36,
        96,
        programs=[51],
        voices=12,
        phrase=chords(60, 3.9),
        listen_for="A softer string machine whose pulse tone hollows and thickens slowly, swelling in.",
    ),
    Instrument(
        "ChoirAahs",
        "Choir aahs",
        "Ensemble",
        voices(AH, ((-0.1, 5.1), (0.0, 5.6), (0.11, 6.0)), 0.18, 0.3, 0.03, 0.15),
        43,
        81,
        programs=[52],
        voices=12,
        phrase=chords(55, 2.9),
        listen_for="A choir singing ah, several voices a little apart, breathy and warm.",
    ),
    Instrument(
        "VoiceOohs",
        "Voice oohs",
        "Ensemble",
        voices(OO, ((-0.06, 5.3), (0.06, 5.8)), 0.12, 0.25, 0.02, 0.12),
        48,
        79,
        programs=[53],
        voices=12,
        phrase=chords(55, 2.9),
        listen_for="Soft voices on oo, dark and close.",
    ),
    Instrument(
        "SynthVoice",
        "Synth voice",
        "Ensemble",
        voices(
            EH_OH,
            ((-0.05, 5.0), (0.05, 5.0)),
            0.15,
            0.3,
            0.0,
            0.06,
            pulse=True,
            sweep=350.0,
        ),
        48,
        84,
        programs=[54],
        voices=12,
        phrase=chords(55, 2.9),
        listen_for="A synthesised voice: a smooth, glassy vowel with no breath in it.",
    ),
    Instrument(
        "OrchestraHit",
        "Orchestra hit",
        "Ensemble",
        hit,
        48,
        84,
        programs=[55],
        voices=4,
        level=2.0,
        phrase=stabs(60),
        listen_for="The orchestra striking one short, loud chord on every note.",
    ),
]
