"""The plucked instruments: GM's guitars (programs 24 to 31), basses (32 to 39) and its ethnic family (104 to 111),
whose sitar, banjo, koto and kalimba are plucked too and whose bagpipe, fiddle and shanai are the folk instruments
beside them.

A string here is an oscillator at the note's exact pitch, not a delay line. The comb a Karplus-Strong string rings in
holds a whole number of samples, so a high note lands up to a third of a semitone off, and by a different amount at
each sample rate. The one comb here is the sitar's sympathetic strings, which are meant to be a little out of tune
with what is played. A pulse wave stands in for the pluck instead: its width is where the string was plucked, since a
string plucked a fifth of the way along has no fifth harmonic and neither has a pulse a fifth wide. A low-pass whose
cutoff follows the pitch and falls after the pluck stands in for the string losing its upper harmonics first, and fixed
band-passes for the body, which resonates at its own frequencies whatever note is played. The overdriven guitars carry
their amplifier inside them, since GM has none: a curve that saturates, between filters that keep what it adds below
the top of the band.
"""

import math

from Graph import Graph, Ref
from Instrument import Instrument, Phrase, Sound, Voice

# Pieces every voice here is made of ----------------------------------------------------------------------------------

# A body's resonances: each one's frequency in Hz, its q and its level.
Body = list[tuple[float, float, float]]


def loudness(v: Voice, floor: float) -> Ref:
    """A level from velocity that falls about 10 dB from 127 to 64 and never to silence: `floor` at the softest."""
    g = v.g
    return g.add(g.mul(g.mul(v.velocity, v.velocity), 1.0 - floor), floor)


def clamp_cutoff(g: Graph, cutoff, highest: float = 15000.0) -> Ref:
    """A cutoff held well below the top of the band, however high the note and however hard it is played."""
    return g.node("math", {"a": cutoff, "b": highest}, mode="min")


def tilt(g: Graph, pitch, db_per_octave: float) -> Ref:
    """A gain that rises `db_per_octave` for each octave above middle C and falls as much below it, so an instrument's
    ends play as loud as its middle."""
    k = db_per_octave / (20 * math.log10(2))
    return g.node("ratio", {"in": g.add(g.mul(pitch, k), 60.0 * (1.0 - k))}, root=60)


def wheel_pitch(v: Voice, rate: float, depth: float) -> Ref:
    """The voice's pitch, with as much as `depth` semitones of vibrato as the mod wheel goes up."""
    g = v.g
    return g.add(v.pitch, g.node("lfo", {"rate": rate, "depth": g.mul(v.wheel, depth)}))


def late(g: Graph, wait: float, grow: float) -> Ref:
    """0 for the first `wait` seconds of a note, then rising to 1 over `grow` more, as a player's vibrato arrives on a
    note held long enough for it. The envelope's attack is linear, so a line through it, clipped, starts late."""
    ramp = g.snap(g.env(wait + grow, 0.1, 1.0, 0.1))
    line = g.add(g.mul(ramp, (wait + grow) / grow), -wait / grow)
    return g.node("math", {"a": line, "b": 0.0, "c": 1.0}, mode="clip")


def stepped(g: Graph, envelope: Ref, steps: float = 64.0) -> Ref:
    """An envelope read once a frame, in `steps` steps from 0 to 1. A filter works its coefficients out again only
    when its cutoff moves, which costs more than the filtering, so a cutoff that follows a falling envelope moves
    only a few dozen times a note, each step too small to hear."""
    return g.mul(
        g.node("math", {"a": g.mul(g.snap(envelope), steps)}, mode="floor"), 1.0 / steps
    )


def resonate(g: Graph, sound: Ref, body: Body) -> Ref:
    """The sound with the body's resonances added, each a band-pass at a frequency of its own."""
    for hz, q, gain in body:
        band = g.filter("bandpass", sound, hz, q)
        sound = g.add(sound, band if gain == 1.0 else g.mul(band, gain))
    return sound


def burst(g: Graph, hz: float, q: float, decay: float) -> Ref:
    """A click of band-passed noise, as a pick, a nail or a slap makes before the string sounds."""
    return g.mul(
        g.filter("bandpass", g.node("noise"), hz, q), g.env(0.0003, decay, 0.0, decay)
    )


def curve(shape, points: int = 129) -> list[float]:
    """A waveshaper's table: `shape` sampled evenly from -1 to 1."""
    return [round(shape(2.0 * i / (points - 1) - 1.0), 6) for i in range(points)]


def string(
    v: Voice,
    f: Ref,
    width: float,
    bright: float,
    floor: float,
    fade: float,
    hard: float = 0.5,
    offset: float = 150.0,
    q: float = 0.7,
    second: tuple[float, float, float] | None = None,
    attack: float = 0.0005,
    pick: Ref | None = None,
) -> tuple[Ref, Ref]:
    """A plucked string at `f`, and the envelope of its pluck. The string is a pulse `width` wide, as where it was
    plucked, through a low-pass that starts at `bright + floor` harmonics and falls to `floor` of them, with a time
    constant of `fade` seconds at middle C, shorter higher up. A harder pluck is brighter by up to `hard` again.
    `second` is another string beside it, as a course or the other way the string swings: its detune in cents, its
    width and its level, which beat slowly against the first. `pick` is a noise the pick or the nail makes, which the
    same low-pass shapes."""
    g = v.g
    tone = g.osc("square", f, width=width)
    if second is not None:
        cents, other, level = second
        tone = g.add(
            tone,
            g.mul(g.osc("square", g.mul(f, 2 ** (cents / 1200)), width=other), level),
        )
    if pick is not None:
        tone = g.add(tone, pick)
    pluck = g.env(attack, g.keyed(v.key.pitch, fade), 0.0, 0.05)
    harmonics = g.mul(
        g.add(g.mul(stepped(g, pluck), bright), floor),
        g.add(g.mul(v.velocity, hard), 1.0 - hard * 0.6),
    )
    cutoff = clamp_cutoff(g, g.add(g.mul(f, harmonics), offset))
    return g.filter("lowpass", tone, cutoff, q), pluck


def scratch(g: Graph, v: Voice, level: float, decay: float = 0.006) -> Ref:
    """White noise for a moment at the pluck, louder as it is plucked harder, for a string's low-pass to shape."""
    return g.mul(
        g.node("noise"),
        g.mul(g.env(0.0003, decay, 0.0, decay), g.mul(v.velocity, level)),
    )


def follows(g: Graph, f: Ref, hz: float, harmonics: float) -> Ref:
    """A filter's cutoff of `hz`, or `harmonics` times the note's pitch when that is higher, so that a fixed filter
    on a note far above where the instrument plays still lets the note through."""
    return clamp_cutoff(
        g, g.node("math", {"a": g.mul(f, harmonics), "b": hz}, mode="max")
    )


def ring(
    g: Graph,
    pitch,
    attack: float,
    prompt: float,
    after: float,
    share: float,
    release: float,
) -> Ref:
    """A plucked string's level: a prompt fall, then a long one, as a string's two ways of swinging die at different
    rates, both shorter higher up. `share` is how much of the start is the long one. It decays while the note is held
    and is damped when it is let go."""
    first = g.env(attack, g.keyed(pitch, prompt), 0.0, release)
    second = g.env(attack, g.keyed(pitch, after), 0.0, release)
    return g.add(g.mul(first, 1.0 - share), g.mul(second, share))


# Guitars ------------------------------------------------------------------------------------------------------------


def acoustic(
    width: float,
    bright: float,
    floor: float,
    fade: float,
    attack: float,
    after: float,
    body: Body,
    pick: float,
    second: tuple[float, float, float] | None,
    release: float,
):
    """An acoustic guitar: a string and a second beside it, the nail or the pick, and the box: its top and the air in
    it. The pluck's bright part dies first and then the string rings on for `after` seconds at middle C, and for
    `release` more once the note is let go, as the fingers come down on it."""

    def build(v: Voice) -> Sound:
        g = v.g
        f = g.mtof(wheel_pitch(v, 5.5, 0.25))
        tone, pluck = string(
            v,
            f,
            width,
            bright,
            floor,
            fade,
            second=second,
            attack=attack,
            pick=scratch(g, v, pick),
        )
        rings = g.env(attack, g.keyed(v.key.pitch, after), 0.0, release)
        sound = g.mul(resonate(g, tone, body), g.add(g.mul(pluck, 1.2), rings))
        return g.filter("highpass", g.mul(sound, loudness(v, 0.06)), 70.0)

    return build


def electric(
    width: float,
    bright: float,
    floor: float,
    fade: float,
    after: float,
    pickup: float,
    peak: float,
    release: float,
    pick: float,
):
    """A solid-bodied electric guitar played clean: a string with no box to take its energy, so it rings long, heard
    through a pickup, whose coil and the cable make a resonant low-pass at `pickup` Hz with a q of `peak`. The
    pluck's bright part dies first, and the string rings on for `after` seconds at middle C."""

    def build(v: Voice) -> Sound:
        g = v.g
        f = g.mtof(wheel_pitch(v, 5.5, 0.4))
        tone, pluck = string(
            v,
            f,
            width,
            bright,
            floor,
            fade,
            offset=100.0,
            pick=scratch(g, v, pick, 0.004),
        )
        tone = g.filter("lowpass", tone, follows(g, f, pickup, 2.0), peak)
        rings = g.env(0.0008, g.keyed(v.key.pitch, after), 0.0, release)
        sound = g.mul(tone, g.add(pluck, rings))
        return g.filter("highpass", g.mul(sound, loudness(v, 0.06)), 80.0)

    return build


def driven(
    drive: float,
    table: list[float],
    tight: float,
    after: float,
    tilted: float,
    pre: float | None = None,
):
    """An electric guitar through an amplifier turned up: the string, a band-pass around `tight` Hz that takes the
    bass and the fizz out before the valves as a pedal does, `table`'s curve, which saturates harder as the string is
    plucked harder, and a speaker's cabinet, which passes little above 5 kHz. The saturation holds the level up as the
    string dies, so it sustains while it is held. `pre` is a low-pass ahead of the curve, which keeps the harmonics a
    hard curve makes from reaching past the top of the band and folding back down."""

    def build(v: Voice) -> Sound:
        g = v.g
        f = g.mtof(wheel_pitch(v, 5.5, 0.5))
        tone, _ = string(v, f, 0.13, 14.0, 5.0, 0.6, hard=0.3, offset=200.0)
        held = g.env(0.0008, g.keyed(v.key.pitch, after), 0.0, 0.09)
        tone = g.filter("bandpass", g.mul(tone, held), follows(g, f, tight, 1.0), 0.5)
        if pre is not None:
            tone = g.filter("lowpass", tone, follows(g, f, pre, 1.5), 0.7)
        push = g.add(g.mul(v.velocity, drive * 0.5), drive * 0.5)
        clipped = g.node("shape", {"in": g.mul(tone, push)}, curve=table)
        cabinet = g.filter("lowpass", clipped, follows(g, f, 4200.0, 1.5), 1.1)
        cabinet = g.filter("lowpass", cabinet, follows(g, f, 6500.0, 2.0), 0.7)
        cabinet = g.add(cabinet, g.mul(g.filter("bandpass", cabinet, 1800.0, 1.2), 0.5))
        gate = g.env(0.001, 0.1, 1.0, 0.09)
        level = g.mul(loudness(v, 0.08), tilt(g, v.key.pitch, tilted))
        # A pulse is lopsided, and a curve that clips it leaves an offset, which the last filter takes out.
        return g.filter("highpass", g.mul(g.mul(cabinet, gate), level), 90.0)

    return build


def harmonics(v: Voice) -> Sound:
    """Harmonics, touched over a fret rather than pressed: near-pure tones, with a little of their own octave and the
    fifth above that, as a bell's partials, and a glassy edge at the touch."""
    g = v.g
    f = g.mtof(wheel_pitch(v, 5.5, 0.3))
    tone = g.add(g.osc("sine", f), g.mul(g.osc("sine", g.mul(f, 2.0)), 0.22))
    glass = g.mul(
        g.osc("sine", clamp_cutoff(g, g.mul(f, 3.0), 18000.0)),
        g.env(0.0005, g.keyed(v.key.pitch, 0.25), 0.0, 0.05),
    )
    sound = g.add(tone, g.mul(glass, g.add(g.mul(v.velocity, 0.2), 0.08)))
    touch = g.mul(burst(g, 3500.0, 1.0, 0.004), 0.12)
    sound = g.mul(g.add(sound, touch), ring(g, v.key.pitch, 0.002, 0.4, 2.5, 0.6, 0.35))
    return g.filter("highpass", g.mul(sound, loudness(v, 0.06)), 80.0)


# Basses -------------------------------------------------------------------------------------------------------------


def bass(
    width: float,
    bright: float,
    floor: float,
    fade: float,
    after: float,
    share: float,
    release: float,
    body: Body,
    tone_hz: float | None,
    click: float,
    bloom: float = 0.0005,
    q: float = 0.7,
):
    """A bass guitar's string or a double bass's: rounder than a guitar's, through `body`, and a pickup's low-pass at
    `tone_hz`, if it has one. The pluck's bright part dies first, and `share` of the start rings on for `after`
    seconds at middle C. `click` is noise at the pluck, as a finger on the wood or a slap on the frets makes. A
    fretless's string buzzes along a fingerboard with no frets, which brings its harmonics up just after the pluck:
    `bloom` is how long they take to arrive and `q` the resonance they arrive with, so the note opens like a vowel,
    "mwah", and then settles."""

    def build(v: Voice) -> Sound:
        g = v.g
        f = g.mtof(wheel_pitch(v, 5.0, 0.3))
        tone, pluck = string(
            v,
            f,
            width,
            bright,
            floor,
            fade,
            offset=60.0,
            q=q,
            attack=bloom,
            pick=scratch(g, v, click, 0.005) if click else None,
        )
        if tone_hz is not None:
            tone = g.filter("lowpass", tone, follows(g, f, tone_hz, 2.0), 0.9)
        rings = g.env(0.001, g.keyed(v.key.pitch, after), 0.0, release)
        sound = g.mul(
            resonate(g, tone, body),
            g.add(g.mul(pluck, 1.0 - share), g.mul(rings, share)),
        )
        return g.filter("highpass", g.mul(sound, loudness(v, 0.06)), 32.0)

    return build


def synth_bass(v: Voice) -> Sound:
    """The ResonantSawBass recipe with an octave below it, as the SubOscillator recipe's: a saw, a square an octave
    down, and a resonant low-pass that opens at each note and quickly closes, from higher as it is played harder. It
    sustains, so the mod wheel brings in a vibrato."""
    g = v.g
    f = g.mtof(wheel_pitch(v, 5.5, 0.4))
    tone = g.add(g.osc("saw", f), g.mul(g.osc("square", g.mul(f, 0.5)), 0.5))
    sweep = stepped(g, g.env(0.001, 0.12, 0.0, 0.05), 128.0)
    opened = g.mul(sweep, g.add(g.mul(v.velocity, 3000.0), 800.0))
    cutoff = clamp_cutoff(g, g.add(opened, g.add(g.mul(f, 2.0), 140.0)), 12000.0)
    tone = g.filter("lowpass", g.filter("lowpass", tone, cutoff, 5.0), cutoff, 0.7)
    sound = g.mul(tone, g.env(0.002, 0.3, 0.6, 0.08))
    sound = g.mul(sound, g.mul(loudness(v, 0.08), tilt(g, v.key.pitch, -1.5)))
    return g.filter("highpass", sound, 30.0)


# Ethnic -------------------------------------------------------------------------------------------------------------


def sitar(v: Voice) -> Sound:
    """A sitar: a thin, bright string whose curved bridge, the jawari, keeps making new upper harmonics as it buzzes,
    heard here as a pulse whose width opens as the note rings, sweeping its gaps down through the harmonics; the
    gourd's resonance; and the sympathetic strings under it, a comb two of the note's periods long that rings on after
    it, a little out of tune with it, as they are."""
    g = v.g
    f = g.mtof(wheel_pitch(v, 5.5, 0.4))
    jawari = g.env(0.0008, g.keyed(v.key.pitch, 0.9), 0.0, 0.2)
    sweep = stepped(g, jawari)
    tone = g.osc("square", f, width=g.add(g.mul(sweep, -0.3), 0.36))
    cutoff = clamp_cutoff(g, g.add(g.mul(f, g.add(g.mul(sweep, 20.0), 8.0)), 400.0))
    tone = g.filter("lowpass", tone, cutoff, 0.8)
    tone = g.add(tone, g.mul(g.filter("bandpass", tone, 2600.0, 2.0), 0.8))
    rings = g.env(0.0008, g.keyed(v.key.pitch, 3.0), 0.0, 0.2)
    # A narrow pulse is quieter than a wide one, so the start is lifted to match.
    tone = g.mul(
        g.mul(tone, g.add(jawari, rings)), g.mul(g.add(sweep, 1.0), loudness(v, 0.06))
    )
    period = g.mul(
        g.node("ratio", {"in": g.add(g.mul(v.pitch, -1.0), 138.0)}, root=69),
        2.0 / 440.0,
    )
    # The pluck alone sets them going: fed the whole note, a comb tuned to it would swell it instead.
    struck = g.mul(tone, g.env(0.0005, 0.012, 0.0, 0.012))
    sympathy = g.node(
        "comb", {"in": struck, "time": period, "feedback": 0.95, "damp": 0.35}, max=0.1
    )
    sound = resonate(g, g.add(tone, g.mul(sympathy, 0.4)), [(140.0, 1.4, 0.6)])
    return g.filter("highpass", sound, 70.0)


def banjo(
    width: float,
    bright: float,
    floor: float,
    fade: float,
    after: float,
    share: float,
    head: float,
    twang: float,
    pick: float,
    release: float,
):
    """A string over a drum's skin: very bright at the pick, quickly dull, and quickly gone, through the head's nasal
    resonance at `head` Hz. `twang` is how much the pitch starts sharp, as a string pulled hard does before it
    settles, and `share` how much of the note rings on for `after` seconds at middle C after the pluck's bright part."""

    def build(v: Voice) -> Sound:
        g = v.g
        pitch = wheel_pitch(v, 5.5, 0.3)
        if twang:
            pitch = g.add(pitch, g.mul(g.snap(g.env(0.0005, 0.03, 0.0, 0.01)), twang))
        f = g.mtof(pitch)
        tone, pluck = string(
            v,
            f,
            width,
            bright,
            floor,
            fade,
            offset=300.0,
            q=0.9,
            pick=scratch(g, v, pick, 0.004),
        )
        tone = resonate(g, tone, [(head, 1.6, 1.4), (head * 2.7, 2.0, 0.5)])
        rings = g.env(0.0005, g.keyed(v.key.pitch, after), 0.0, release)
        sound = g.mul(tone, g.add(g.mul(pluck, 1.0 - share), g.mul(rings, share)))
        return g.filter("highpass", g.mul(sound, loudness(v, 0.06)), 120.0)

    return build


def kalimba(v: Voice) -> Sound:
    """A thumb piano's tine: a steel tongue clamped at one end, whose overtones lie at 6.27 and 17.55 times its
    pitch, not on its harmonics, and die in a moment, leaving a near-pure tone in the box's hollow."""
    g = v.g
    f = g.mtof(v.pitch)
    tine = g.osc("sine", f)
    first = g.mul(
        g.osc("sine", clamp_cutoff(g, g.mul(f, 6.27), 18000.0)),
        g.env(0.0003, 0.05, 0.0, 0.03),
    )
    # The top partial and the thumb on the tine are gone within a hundredth of a second, together.
    tick = g.add(
        g.mul(
            g.osc("sine", clamp_cutoff(g, g.mul(f, 17.55), 18000.0)),
            g.mul(v.velocity, 0.12),
        ),
        g.mul(g.filter("bandpass", g.node("noise"), 1200.0, 0.8), 0.2),
    )
    tick = g.mul(tick, g.env(0.0002, 0.008, 0.0, 0.008))
    sound = g.add(g.add(tine, g.mul(first, g.add(g.mul(v.velocity, 0.4), 0.15))), tick)
    sound = resonate(g, sound, [(420.0, 1.5, 0.8)])
    # The thumb leaves the tine at once, so a note let go rings on, only a little shorter.
    sound = g.mul(sound, ring(g, v.key.pitch, 0.0004, 0.15, 0.8, 0.6, 0.5))
    return g.filter("highpass", g.mul(sound, loudness(v, 0.06)), 100.0)


def double_reed(
    low: float, high: float, width: float, attack: float, drone: float, breath: float
):
    """A double reed, as a shanai's or a bagpipe's chanter: a narrow pulse through two formants, brighter as it is
    blown harder, scooped up into at the start, with a vibrato that waits for a long note and the mod wheel's on top.
    `breath` is the air through the reed, which the bore's formants shape as they do the buzz. A bagpipe's `drone` is
    the level of its bass and tenor drones, a constant A2 and A3 under every note, which start and stop with the bag's
    breath."""

    def build(v: Voice) -> Sound:
        g = v.g
        blow = g.env(attack, 0.1, 0.8, 0.06)
        breathed = stepped(g, blow)
        # The pitch rises to the note as the breath rises to its sustain, and stays.
        scoop = g.node(
            "math", {"a": g.mul(g.add(breathed, -0.8), 0.3), "b": 0.0}, mode="min"
        )
        wobble = g.node(
            "lfo",
            {
                "rate": 5.5,
                "depth": g.add(g.mul(v.wheel, 0.4), g.mul(late(g, 0.3, 0.4), 0.08)),
            },
        )
        f = g.mtof(g.add(v.pitch, g.add(scoop, wobble)))
        buzz = g.osc("square", f, width=width)
        if breath:
            buzz = g.add(buzz, g.mul(g.node("noise"), breath))
        effort = g.add(g.mul(v.velocity, 0.6), g.mul(v.pressure, 0.4))
        opened = g.add(
            g.mul(breathed, g.add(g.mul(effort, 3000.0), 1200.0)),
            g.add(g.mul(f, 2.0), 600.0),
        )
        body = g.mul(g.filter("lowpass", buzz, clamp_cutoff(g, opened), 0.7), 0.5)
        body = g.add(body, g.mul(g.filter("bandpass", buzz, low, 2.0), 1.2))
        body = g.add(body, g.mul(g.filter("bandpass", buzz, high, 3.0), 0.8))
        if drone:
            # One saw at A2 has the tenor drones' A3 in it as its second harmonic.
            pipes = g.filter("lowpass", g.osc("saw", 110.0), 1400.0, 1.6)
            body = g.add(body, g.mul(pipes, drone))
        return g.filter("highpass", g.mul(body, g.mul(blow, loudness(v, 0.12))), 90.0)

    return build


def fiddle(v: Voice) -> Sound:
    """A fiddle: a solo string bowed hard near the bridge, brighter and plainer than a violin in an orchestra, a
    little vibrato late in a long note, the bow's rosin as it bites, and the body's resonances."""
    g = v.g
    wobble = g.node(
        "lfo",
        {
            "rate": 6.0,
            "depth": g.add(g.mul(v.wheel, 0.4), g.mul(late(g, 0.35, 0.6), 0.06)),
        },
    )
    f = g.mtof(g.add(v.pitch, wobble))
    saw = g.osc("saw", f)
    bow = g.env(0.04, 0.2, 0.85, 0.08)
    rosin = g.mul(g.node("noise"), g.env(0.005, 0.08, 0.06, 0.08))
    weight = g.add(g.mul(v.velocity, 0.7), g.add(g.mul(v.pressure, 0.3), 0.3))
    cutoff = clamp_cutoff(
        g, g.add(g.mul(f, 4.0), g.mul(stepped(g, bow), g.mul(weight, 5000.0)))
    )
    tone = g.filter("lowpass", g.add(g.mul(saw, bow), g.mul(rosin, 0.15)), cutoff, 0.7)
    tone = resonate(g, tone, [(290.0, 1.6, 0.8), (2800.0, 1.5, 0.6)])
    return g.filter("highpass", g.mul(tone, loudness(v, 0.1)), 150.0)


# The set ------------------------------------------------------------------------------------------------------------


def strum(
    at: float, notes: list[int], velocity: int, held: float, gap: float = 0.04
) -> Phrase:
    """A chord strummed down, low string to high, a little apart."""
    return [
        (at + i * gap, n, max(1, velocity - 3 * i), held - i * gap)
        for i, n in enumerate(notes)
    ]


def line(
    at: float, notes: list[tuple[int, float]], velocity: int, step: float, held: float
) -> Phrase:
    """Notes one after another, `step` beats apart, each held `held` of its step, with a rest where a note is 0."""
    phrase, t = [], at
    for note, beats in notes:
        if note:
            phrase.append((t, note, velocity, beats * step * held))
        t += beats * step
    return phrase


# A valve's gentle bend, and a pedal's: flat at the top, and making no harmonic above the third of what goes in
# until it flattens there, so that little of it reaches past the top of the band to fold back down.
SOFT = curve(lambda x: math.tanh(2.0 * x) / math.tanh(2.0))
HARD = curve(lambda x: 1.5 * x - 0.5 * x**3)

E_CHORD = [40, 47, 52, 56, 59, 64]
A_MINOR = [45, 52, 57, 60, 64]
G_CHORD = [43, 47, 50, 55, 59, 67]
C_CHORD = [48, 52, 55, 60, 64]
D_CHORD = [50, 57, 62, 66]

NYLON = (
    line(
        0.0,
        [(45, 1), (52, 1), (57, 1), (60, 1), (64, 1), (60, 1), (57, 1), (52, 1)],
        88,
        0.5,
        2.0,
    )
    + line(
        4.0,
        [(40, 1), (47, 1), (52, 1), (56, 1), (59, 1), (56, 1), (52, 1), (47, 1)],
        88,
        0.5,
        2.0,
    )
    + strum(8.0, A_MINOR, 96, 3.0, 0.05)
)
STEEL = (
    strum(0.0, G_CHORD, 104, 1.0, 0.025)
    + strum(1.0, G_CHORD[::-1], 86, 0.5, 0.02)
    + strum(1.5, G_CHORD, 100, 1.5, 0.025)
    + strum(3.0, C_CHORD, 104, 1.0, 0.025)
    + strum(4.0, D_CHORD, 104, 1.0, 0.025)
    + strum(5.0, D_CHORD[::-1], 86, 0.5, 0.02)
    + strum(5.5, D_CHORD, 100, 1.5, 0.025)
    + strum(7.0, G_CHORD, 110, 3.0, 0.03)
)
JAZZ = (
    strum(0.0, [48, 55, 59, 64], 84, 1.8, 0.02)
    + strum(2.0, [50, 57, 60, 65], 84, 1.8, 0.02)
    + line(4.0, [(67, 1), (69, 1), (71, 1), (74, 1), (72, 2), (67, 2)], 90, 0.5, 0.95)
    + strum(8.0, [43, 53, 59, 64], 88, 3.0, 0.03)
)
CLEAN = (
    line(
        0.0,
        [(52, 1), (59, 1), (64, 1), (59, 1), (67, 1), (59, 1), (64, 1), (59, 1)],
        96,
        0.5,
        1.5,
    )
    + line(
        4.0,
        [(48, 1), (55, 1), (60, 1), (55, 1), (64, 1), (55, 1), (60, 1), (55, 1)],
        96,
        0.5,
        1.5,
    )
    + line(8.0, [(76, 1), (79, 1), (81, 2), (79, 1), (76, 1), (74, 2)], 100, 0.5, 0.9)
    + strum(12.0, E_CHORD, 100, 3.0, 0.03)
)
MUTED = (
    line(0.0, [(40, 1)] * 6 + [(43, 1), (45, 1)], 100, 0.5, 0.35)
    + line(4.0, [(40, 1)] * 4 + [(47, 1), (45, 1), (43, 1), (40, 1)], 100, 0.5, 0.35)
    + line(
        8.0,
        [(52, 1), (55, 1), (57, 1), (52, 1), (55, 1), (58, 1), (57, 2)],
        96,
        0.5,
        0.35,
    )
)
POWER = (
    strum(0.0, [40, 47, 52], 110, 1.9, 0.01)
    + strum(2.0, [43, 50, 55], 110, 1.9, 0.01)
    + strum(4.0, [45, 52, 57], 110, 0.9, 0.01)
    + strum(5.0, [43, 50, 55], 110, 0.9, 0.01)
    + strum(6.0, [40, 47, 52], 115, 2.0, 0.01)
)
LEAD = line(
    8.0,
    [(64, 1), (67, 1), (69, 2), (72, 1), (71, 1), (69, 1), (67, 1), (69, 4)],
    104,
    0.5,
    0.98,
)
HARMONICS = line(
    0.0, [(64, 1), (71, 1), (76, 1), (71, 1), (83, 2), (76, 2)], 90, 0.5, 3.0
) + strum(4.0, [52, 59, 64, 68, 71, 76], 90, 3.0, 0.06)

UPRIGHT = line(
    0.0,
    [
        (33, 1),
        (36, 1),
        (40, 1),
        (43, 1),
        (38, 1),
        (41, 1),
        (45, 1),
        (43, 1),
        (31, 1),
        (35, 1),
        (38, 1),
        (40, 1),
    ]
    + [(36, 2), (0, 2)],
    92,
    1.0,
    0.8,
)
FINGER = (
    line(
        0.0,
        [
            (40, 1.5),
            (40, 0.5),
            (47, 1),
            (50, 1),
            (52, 1.5),
            (50, 0.5),
            (47, 1),
            (45, 1),
        ],
        96,
        0.5,
        0.9,
    )
    + line(
        4.0,
        [
            (33, 1.5),
            (33, 0.5),
            (40, 1),
            (43, 1),
            (45, 1.5),
            (43, 0.5),
            (40, 1),
            (38, 1),
        ],
        96,
        0.5,
        0.9,
    )
    + line(8.0, [(28, 4)], 100, 0.5, 1.0)
)
FRETLESS = line(
    0.0,
    [(40, 2), (47, 1), (52, 3), (50, 2), (47, 2), (45, 4), (43, 2), (40, 6)],
    92,
    0.5,
    1.0,
)
SLAP = (
    line(
        0.0,
        [(28, 1), (40, 1), (28, 1), (0, 1), (40, 1), (28, 1), (38, 1), (40, 1)],
        112,
        0.5,
        0.45,
    )
    + line(
        4.0,
        [(33, 1), (45, 1), (33, 1), (0, 1), (45, 1), (33, 1), (43, 1), (45, 1)],
        112,
        0.5,
        0.45,
    )
    + line(8.0, [(28, 2)], 118, 0.5, 1.0)
)
SYNTH = (
    line(
        0.0,
        [(36, 1), (36, 1), (48, 1), (36, 1), (39, 1), (36, 1), (46, 1), (48, 1)],
        100,
        0.5,
        0.6,
    )
    + line(
        4.0,
        [(34, 1), (34, 1), (46, 1), (34, 1), (41, 1), (34, 1), (43, 1), (46, 1)],
        100,
        0.5,
        0.6,
    )
    + line(8.0, [(36, 4)], 110, 0.5, 0.95)
)

SITAR = line(
    0.0,
    [
        (60, 1),
        (61, 1),
        (64, 1),
        (65, 2),
        (67, 1),
        (68, 1),
        (71, 1),
        (72, 3),
        (71, 1),
        (68, 1),
        (67, 2),
    ]
    + [(65, 1), (64, 1), (61, 1), (60, 4)],
    96,
    0.5,
    1.6,
)
BANJO = line(
    0.0,
    [(55, 1), (59, 1), (62, 1), (67, 1), (55, 1), (62, 1), (59, 1), (67, 1)] * 2
    + [(54, 1), (60, 1), (62, 1), (67, 1), (54, 1), (62, 1), (60, 1), (67, 1)]
    + [(55, 8)],
    100,
    0.25,
    1.5,
)
KOTO = line(
    0.0,
    [(57, 1), (59, 1), (60, 1), (64, 1), (65, 2), (64, 1), (60, 1), (59, 2), (57, 2)]
    + [(69, 1), (71, 1), (72, 2), (76, 4)],
    92,
    0.5,
    1.8,
)
KALIMBA = line(
    0.0,
    [(60, 1), (64, 1), (67, 1), (72, 1), (71, 1), (67, 1), (64, 1), (62, 1)] * 2
    + [(65, 1), (69, 1), (72, 1), (76, 1), (74, 1), (72, 1), (67, 1), (64, 1), (60, 4)],
    96,
    0.5,
    2.0,
)
PIPES = line(
    0.0,
    [
        (69, 1),
        (74, 3),
        (78, 1),
        (76, 1),
        (74, 1),
        (78, 3),
        (76, 1),
        (74, 3),
        (71, 2),
        (69, 4),
    ],
    100,
    0.5,
    0.97,
)
FIDDLE = line(
    0.0,
    [
        (74, 1),
        (76, 1),
        (78, 1),
        (74, 1),
        (81, 2),
        (78, 1),
        (76, 1),
        (74, 1),
        (71, 1),
        (69, 1),
        (71, 1),
    ]
    + [(74, 1), (76, 1), (78, 2), (81, 1), (83, 1), (86, 4)],
    100,
    0.5,
    0.92,
)
SHANAI = line(
    0.0,
    [
        (64, 2),
        (65, 1),
        (68, 1),
        (69, 3),
        (71, 1),
        (72, 2),
        (71, 1),
        (69, 1),
        (68, 2),
        (65, 1),
        (64, 5),
    ],
    96,
    0.5,
    0.96,
)

INSTRUMENTS = [
    Instrument(
        "NylonGuitar",
        "Nylon guitar",
        "Guitar",
        acoustic(
            width=0.2,
            bright=6.0,
            floor=2.5,
            fade=0.4,
            attack=0.004,
            after=2.6,
            body=[(98.0, 1.6, 0.8), (205.0, 2.0, 0.6)],
            pick=0.05,
            second=(1.2, 0.24, 0.35),
            release=0.25,
        ),
        40,
        83,
        programs=[24],
        voices=14,
        phrase=NYLON,
        listen_for="A classical guitar picked with the fingers: warm and round, a soft start, and a wooden box under it.",
    ),
    Instrument(
        "SteelGuitar",
        "Steel guitar",
        "Guitar",
        acoustic(
            width=0.14,
            bright=16.0,
            floor=4.0,
            fade=0.5,
            attack=0.0008,
            after=3.2,
            body=[(110.0, 1.6, 0.6), (3200.0, 1.2, 0.45)],
            pick=0.12,
            second=(3.5, 0.18, 0.6),
            release=0.2,
        ),
        40,
        86,
        programs=[25],
        voices=24,
        phrase=STEEL,
        listen_for="A flat-picked steel-string guitar strumming: bright and jangly, its strings shimmering against each other.",
    ),
    Instrument(
        "JazzGuitar",
        "Jazz guitar",
        "Guitar",
        electric(
            width=0.3,
            bright=6.0,
            floor=2.5,
            fade=0.6,
            after=3.0,
            pickup=1800.0,
            peak=0.9,
            release=0.12,
            pick=0.02,
        ),
        40,
        84,
        programs=[26],
        voices=8,
        phrase=JAZZ,
        listen_for="An archtop on its neck pickup with the tone turned down: mellow, round chords and a warm single line.",
    ),
    Instrument(
        "CleanGuitar",
        "Clean guitar",
        "Guitar",
        electric(
            width=0.12,
            bright=14.0,
            floor=4.0,
            fade=0.7,
            after=3.6,
            pickup=3400.0,
            peak=2.2,
            release=0.1,
            pick=0.06,
        ),
        40,
        88,
        programs=[27],
        voices=8,
        phrase=CLEAN,
        listen_for="A solid-body electric through a clean amplifier: glassy and clear, ringing long.",
    ),
    Instrument(
        "MutedGuitar",
        "Muted guitar",
        "Guitar",
        electric(
            width=0.12,
            bright=10.0,
            floor=1.6,
            fade=0.07,
            after=0.3,
            pickup=2600.0,
            peak=1.4,
            release=0.05,
            pick=0.08,
        ),
        40,
        76,
        programs=[28],
        voices=6,
        phrase=MUTED,
        listen_for="Palm-muted electric: short, thudding notes with a little pitch in them, as a chugging rhythm part plays.",
    ),
    Instrument(
        "OverdrivenGuitar",
        "Overdriven guitar",
        "Guitar",
        driven(drive=3.0, table=SOFT, tight=800.0, after=4.0, tilted=-2.5),
        40,
        88,
        programs=[29],
        voices=6,
        phrase=POWER + LEAD,
        listen_for="A valve amplifier turned up until it breaks up: warm crunch on power chords, and a singing lead.",
    ),
    Instrument(
        "DistortionGuitar",
        "Distortion guitar",
        "Guitar",
        driven(drive=9.0, table=HARD, tight=650.0, after=8.0, tilted=-2.5, pre=2000.0),
        40,
        88,
        programs=[30],
        voices=6,
        phrase=POWER + LEAD,
        listen_for="Heavy distortion: thick, saturated power chords, and lead notes that sustain as long as they are held.",
    ),
    Instrument(
        "GuitarHarmonics",
        "Guitar harmonics",
        "Guitar",
        harmonics,
        52,
        88,
        programs=[31],
        voices=12,
        phrase=HARMONICS,
        listen_for="Harmonics touched on the strings: bell-like octaves and fifths, glassy and pure.",
    ),
    Instrument(
        "AcousticBass",
        "Acoustic bass",
        "Bass",
        bass(
            width=0.3,
            bright=12.0,
            floor=2.5,
            fade=0.15,
            after=1.0,
            share=0.3,
            release=0.1,
            body=[(110.0, 1.3, 0.5), (240.0, 1.6, 0.5)],
            tone_hz=None,
            click=0.06,
        ),
        28,
        67,
        programs=[32],
        voices=4,
        phrase=UPRIGHT,
        listen_for="A double bass plucked in a jazz walk: round and woody, each note short with a thump of the finger.",
    ),
    Instrument(
        "FingerBass",
        "Finger bass",
        "Bass",
        bass(
            width=0.22,
            bright=12.0,
            floor=3.5,
            fade=0.4,
            after=4.0,
            share=0.55,
            release=0.07,
            body=[],
            tone_hz=2800.0,
            click=0.03,
        ),
        28,
        67,
        programs=[33, 34],
        voices=4,
        phrase=FINGER,
        listen_for="An electric bass played with the fingers: full and round, with a little growl as each note starts.",
    ),
    Instrument(
        "FretlessBass",
        "Fretless bass",
        "Bass",
        bass(
            width=0.28,
            bright=7.0,
            floor=1.5,
            fade=0.45,
            after=4.0,
            share=0.6,
            release=0.09,
            body=[],
            tone_hz=2400.0,
            click=0.0,
            bloom=0.07,
            q=4.0,
        ),
        28,
        67,
        programs=[35],
        voices=4,
        phrase=FRETLESS,
        listen_for="A fretless bass: each note blooms with a vocal 'mwah' and sings on, smooth and round.",
    ),
    Instrument(
        "SlapBass",
        "Slap bass",
        "Bass",
        bass(
            width=0.1,
            bright=60.0,
            floor=4.0,
            fade=0.08,
            after=2.0,
            share=0.4,
            release=0.06,
            body=[(2500.0, 0.9, 1.8), (500.0, 1.2, -0.4)],
            tone_hz=7000.0,
            click=0.1,
        ),
        28,
        67,
        programs=[36, 37],
        voices=4,
        phrase=SLAP,
        listen_for="A slapped bass: a thumb's bright snap on the low notes, a popped octave above, and a scooped, funky body.",
    ),
    Instrument(
        "SynthBass",
        "Synth bass",
        "Bass",
        synth_bass,
        24,
        60,
        programs=[38, 39],
        voices=4,
        phrase=SYNTH,
        listen_for="An analogue synth bass: a saw with an octave under it, each note opening with a resonant squelch that quickly closes.",
    ),
    Instrument(
        "Sitar",
        "Sitar",
        "Ethnic",
        sitar,
        48,
        84,
        programs=[104],
        voices=8,
        phrase=SITAR,
        listen_for="A sitar: a buzzing, bright string whose tone sweeps as it rings, and a shimmer of sympathetic strings after it.",
    ),
    Instrument(
        "Banjo",
        "Banjo",
        "Ethnic",
        banjo(
            width=0.1,
            bright=24.0,
            floor=4.0,
            fade=0.12,
            after=0.9,
            share=0.3,
            head=1100.0,
            twang=0.0,
            pick=0.15,
            release=0.12,
        ),
        50,
        86,
        programs=[105],
        voices=8,
        phrase=BANJO,
        listen_for="A five-string banjo rolling: bright, metallic and nasal, each note quickly gone.",
    ),
    Instrument(
        "Koto",
        "Koto",
        "Ethnic",
        banjo(
            width=0.16,
            bright=14.0,
            floor=3.0,
            fade=0.3,
            after=2.2,
            share=0.45,
            head=750.0,
            twang=0.35,
            pick=0.1,
            release=0.25,
        ),
        48,
        86,
        programs=[106, 107],
        voices=8,
        phrase=KOTO,
        listen_for="A koto or a shamisen: a twangy pluck that starts sharp and settles, ringing out, plain and dry.",
    ),
    Instrument(
        "Kalimba",
        "Kalimba",
        "Ethnic",
        kalimba,
        60,
        88,
        programs=[108],
        voices=12,
        phrase=KALIMBA,
        listen_for="A thumb piano: soft, bell-like tines with a metallic tick as each is struck, in a small wooden box.",
    ),
    Instrument(
        "Bagpipe",
        "Bagpipe",
        "Ethnic",
        double_reed(
            low=1100.0, high=2900.0, width=0.22, attack=0.02, drone=0.5, breath=0.0
        ),
        67,
        81,
        programs=[109],
        voices=4,
        phrase=PIPES,
        listen_for="Highland pipes: a loud, reedy chanter over the constant hum of its drones.",
    ),
    Instrument(
        "Fiddle",
        "Fiddle",
        "Ethnic",
        fiddle,
        55,
        96,
        programs=[110],
        voices=4,
        phrase=FIDDLE,
        listen_for="A folk fiddle: bright and woody, bowed hard, with only a touch of vibrato on its long notes.",
    ),
    Instrument(
        "Shanai",
        "Shanai",
        "Ethnic",
        double_reed(
            low=1300.0, high=3300.0, width=0.14, attack=0.05, drone=0.0, breath=0.15
        ),
        60,
        84,
        programs=[111],
        voices=4,
        phrase=SHANAI,
        listen_for="A shehnai: a piercing, nasal double reed, each note scooped up into, with a vibrato on the long ones.",
    ),
]
