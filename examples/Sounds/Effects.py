"""The standard set's effects: GM2's reverb types, a chorus, and the pieces' stereo tremolo.

The reverbs are the pieces' hall, the Reverb recipe's Freeverb-style room of two banks of eight damped combs and four
all-passes, with what GM2's types differ in as arguments: the size of the room (its delay lengths) and how much each trip
round it keeps (the combs' feedback), how much treble each trip loses (their damping), the gap before the first
reflection, and the early reflections themselves. The right bank's lines are a little longer than the left's, so the two
sides are decorrelated. On a bus an effect returns only its effect, so each one's level is set for a send of 0.31, CC 91
at GM's default of 40: the halls and the plate come back about 13.5 dB under the dry sound, and the rooms, whose tails
are short enough to pass unheard any quieter, about 11.5.
"""

from Graph import Graph, Ref
from Instrument import Effect

# The comb and all-pass lengths of the Reverb recipe and the pieces' hall, and how much longer the right side's are.
COMBS = (0.0297, 0.0371, 0.0411, 0.0437, 0.0253, 0.0269, 0.0290, 0.0307)
ALLPASSES = (0.0126, 0.0100, 0.0077, 0.0051)
SPREAD = 0.0005


def longest(seconds: float) -> float:
    """A line just long enough for a delay, so a bigger room doesn't hold memory it never reads."""
    return round(seconds + 0.0005, 4)


def reflections(g: Graph, signal: Ref, taps: list[tuple[float, float]]) -> Ref:
    """Early reflections as taps on one chain of delays, each line only as long as the gap since the tap before it."""
    total, at, last = None, signal, 0.0
    for seconds, gain in taps:
        if seconds > last:
            at = g.node(
                "delay", {"in": at, "time": seconds - last}, max=longest(seconds - last)
            )
        last = seconds
        tap = g.mul(at, gain)
        total = tap if total is None else g.add(total, tap)
    return total


def diffuser(g: Graph, signal: Ref, seconds: float, gain: float) -> Ref:
    """A true all-pass, which smears a signal without colouring it, made from the engine's. That one is Freeverb's: it
    returns its line's output less its input, which rings at its delay's harmonics when its feedback is high. Its line's
    output is that plus the input, and (1 - g²) of it less g of the input is flat at every frequency."""
    smeared = g.node(
        "allpass",
        {"in": signal, "time": seconds, "feedback": gain},
        max=longest(seconds),
    )
    return g.add(
        g.mul(smeared, 1.0 - gain * gain), g.mul(signal, 1.0 - gain * gain - gain)
    )


def room(
    g: Graph,
    source: Ref,
    feedback: float,
    damp: float,
    wet: float,
    size: float = 1.0,
    predelay: float = 0.0,
    early: tuple[list, list] | None = None,
    early_gain: float = 0.0,
    diffusers: list[tuple[float, float]] | None = None,
    low_cut: float = 0.0,
) -> tuple[Ref, Ref]:
    """The pieces' hall, sized and coloured. `size` scales every line; `predelay` holds the whole sound back;
    `diffusers` (seconds, gain) smear the sound before anything else hears it; `early` is each side's reflections of
    that, as (seconds after the predelay, gain), mixed in at `early_gain`. `low_cut` takes the bass off what the room
    hears. Without these it is MakePieces' hall(feedback, damp, wet), with each line only as long as its delay."""
    mono = g.mul(g.add(source.l, source.r), 0.5)
    if low_cut:
        mono = g.filter("highpass", mono, low_cut)
    if predelay:
        mono = g.node("delay", {"in": mono, "time": predelay}, max=longest(predelay))
    for seconds, gain in diffusers or []:
        mono = diffuser(g, mono, seconds, gain)
    sides = []
    for side, spread in enumerate((0.0, SPREAD)):
        bank = None
        for seconds in COMBS:
            time = seconds * size + spread
            comb = g.node(
                "comb",
                {"in": mono, "time": time, "feedback": feedback, "damp": damp},
                max=longest(time),
            )
            bank = comb if bank is None else g.add(bank, comb)
        for seconds in ALLPASSES:
            time = seconds * size + spread
            bank = g.node(
                "allpass",
                {"in": bank, "time": time, "feedback": 0.5},
                max=longest(time),
            )
        if early:
            bank = g.add(bank, g.mul(reflections(g, mono, early[side]), early_gain))
        sides.append(g.mul(bank, wet))
    return sides[0], sides[1]


# Each side's early reflections, as (seconds after the predelay, gain): the left's and the right's arrive at different
# times, from different walls, and a room's come sooner and closer together than a hall's.
ROOM_EARLY = (
    [
        (0.0043, 0.9),
        (0.0079, -0.7),
        (0.0112, 0.6),
        (0.0157, -0.5),
        (0.0191, 0.42),
        (0.0239, -0.33),
    ],
    [
        (0.0051, 0.85),
        (0.0088, -0.72),
        (0.0126, 0.55),
        (0.0143, -0.5),
        (0.0212, 0.4),
        (0.0257, -0.3),
    ],
)
HALL_EARLY = (
    [
        (0.0, 0.8),
        (0.0107, 0.62),
        (0.0193, -0.5),
        (0.0271, 0.45),
        (0.0373, -0.36),
        (0.0487, 0.3),
        (0.0611, -0.22),
    ],
    [
        (0.0034, 0.75),
        (0.0131, -0.6),
        (0.0219, 0.52),
        (0.0302, -0.42),
        (0.0409, 0.34),
        (0.0523, -0.28),
        (0.0659, 0.2),
    ],
)


def scaled(taps: tuple[list, list], by: float) -> tuple[list, list]:
    return tuple([(seconds * by, gain) for seconds, gain in side] for side in taps)


def reverb(shape: dict):
    return lambda g, source: room(g, source, **shape)


# Two short all-passes before a hall's combs, so its tail is smooth from its first tenth of a second, as a hall's walls
# scatter the sound, where the combs alone take a third of a second to stop sounding like separate echoes.
HALL_DIFFUSERS = [(0.0043, 0.6), (0.0031, 0.6)]
# A plate's: Dattorro's four input diffusers, the lengths his plate reverb uses. A plate takes the sound in everywhere at
# once, so its "reflections" are three taps on the smeared sound, which start it at once and dense.
PLATE_DIFFUSERS = [(0.0048, 0.75), (0.0036, 0.75), (0.0127, 0.625), (0.0093, 0.625)]
PLATE_EARLY = (
    [(0.0, 1.0), (0.0017, 0.8), (0.0041, -0.6)],
    [(0.0009, 1.0), (0.0029, -0.8), (0.0052, 0.6)],
)

# The rooms have short lines and a prompt first reflection, close and loud reflections after it, and lose more treble
# the smaller they are, as a furnished room does.
SMALL_ROOM = {
    "feedback": 0.7,
    "damp": 0.45,
    "wet": 0.057,
    "size": 0.55,
    "predelay": 0.001,
    "early": scaled(ROOM_EARLY, 0.5),
    "early_gain": 2.5,
    "low_cut": 25.0,
}
MEDIUM_ROOM = {
    "feedback": 0.76,
    "damp": 0.42,
    "wet": 0.052,
    "size": 0.75,
    "predelay": 0.003,
    "early": scaled(ROOM_EARLY, 0.75),
    "early_gain": 2.5,
    "low_cut": 25.0,
}
# The Parlour's numbers, The Entertainer's room.
LARGE_ROOM = {
    "feedback": 0.78,
    "damp": 0.4,
    "wet": 0.051,
    "predelay": 0.005,
    "early": ROOM_EARLY,
    "early_gain": 2.5,
    "low_cut": 25.0,
}
# The halls wait longer for their first reflection, space the rest out, and are warm: their treble dies sooner than
# their middle. The medium one has the Concert hall's numbers, the Grieg's, in a room a little bigger.
MEDIUM_HALL = {
    "feedback": 0.86,
    "damp": 0.35,
    "wet": 0.032,
    "size": 1.08,
    "predelay": 0.018,
    "early": HALL_EARLY,
    "early_gain": 2.5,
    "diffusers": HALL_DIFFUSERS,
    "low_cut": 25.0,
}
# The Church's numbers, the chorale's, in a room a quarter bigger.
LARGE_HALL = {
    "feedback": 0.88,
    "damp": 0.3,
    "wet": 0.033,
    "size": 1.27,
    "predelay": 0.026,
    "early": scaled(HALL_EARLY, 1.3),
    "early_gain": 2.5,
    "diffusers": HALL_DIFFUSERS,
    "low_cut": 25.0,
}
# Short lines and little damping, so it is dense and bright, and it barely rings below 120 Hz.
PLATE = {
    "feedback": 0.9,
    "damp": 0.1,
    "wet": 0.0275,
    "size": 0.6,
    "diffusers": PLATE_DIFFUSERS,
    "early": PLATE_EARLY,
    "early_gain": 6.0,
    "low_cut": 120.0,
}


def chorus(g: Graph, source: Ref) -> tuple[Ref, Ref]:
    """The Chorus recipe's moving delays, wet only and gentler: three copies of the sound, each late by an amount that
    drifts, one to each side and one to both, upside down on the right so the sides differ. Their drift is slow and
    shallow, so a copy's pitch moves by 3 to 8 cents and the sound thickens rather than going out of tune. A delay moves
    in whole samples, which roughens the treble it copies (by 22 dB under a tone at 2 kHz, 13 dB under one at 6 kHz),
    so the copies are of the sound below 6 kHz, as an analogue chorus's are."""
    mono = g.filter("lowpass", g.mul(g.add(source.l, source.r), 0.5), 6000.0)
    voices = []
    for rate, depth, centre in (
        (0.31, 0.0016, 0.0121),
        (0.37, 0.0019, 0.0153),
        (0.23, 0.0012, 0.0087),
    ):
        time = g.add(g.node("lfo", {"rate": rate, "depth": depth}), centre)
        voices.append(
            g.node("delay", {"in": mono, "time": time}, max=longest(centre + depth))
        )
    left = g.add(voices[0], g.mul(voices[2], 0.6))
    right = g.add(voices[1], g.mul(voices[2], -0.6))
    return g.mul(left, 1.3), g.mul(right, 1.3)


def tremolo(rate: float, depth: float):
    """MakePieces' tremolo(), Für Elise's: the track's sound swung from side to side, as an electric piano's stereo
    vibrato does."""

    def build(g: Graph, source: Ref) -> tuple[Ref, Ref]:
        swing = g.node(
            "pan",
            {
                "in": g.add(source.l, source.r),
                "position": g.node("lfo", {"rate": rate, "depth": depth}),
            },
        )
        return swing.l, swing.r

    return build


EFFECTS = [
    Effect(
        "SmallRoom",
        "Small room",
        reverb(SMALL_ROOM),
        listen_for="A small, close room: reflections almost at once and a short, slightly dull tail of about 0.4 s.",
    ),
    Effect(
        "MediumRoom",
        "Medium room",
        reverb(MEDIUM_ROOM),
        listen_for="A medium room: close reflections and a tail of about 0.7 s.",
    ),
    Effect(
        "LargeRoom",
        "Large room",
        reverb(LARGE_ROOM),
        listen_for="A large room, as the parlour The Entertainer plays in: a tail of about a second.",
    ),
    Effect(
        "MediumHall",
        "Medium hall",
        reverb(MEDIUM_HALL),
        listen_for="A concert hall: a gap before the first reflection, then a warm tail of about 1.8 s.",
    ),
    Effect(
        "LargeHall",
        "Large hall",
        reverb(LARGE_HALL),
        send="reverb",
        listen_for="A large hall, GM2's default reverb: a longer gap, then a warm tail of about 2.5 s.",
    ),
    Effect(
        "Plate",
        "Plate",
        reverb(PLATE),
        listen_for="A plate: dense and bright from the first moment, a smooth metallic tail of about 1.5 s, little bass.",
    ),
    Effect(
        "Chorus",
        "Chorus",
        chorus,
        send="chorus",
        listen_for="The sound made wider and thicker by slowly drifting copies of itself, still in tune.",
    ),
    Effect(
        "Tremolo",
        "Stereo tremolo",
        tremolo(4.2, 0.45),
        insert=True,
        listen_for="The sound swinging from side to side four times a second, as Für Elise's electric piano does.",
    ),
]
