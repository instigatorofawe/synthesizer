"""The standard set's contract: what every instrument, drum and effect in examples/Sounds is given, and what it gives back.

An instrument is a function from a Voice to its sound. MakeInstruments.py wraps every one the same way: the same four
parameters at the same numbers, so a MIDI file's channel messages reach any instrument alike, and expression and a level
the generator measures applied after it, so every instrument plays at the set's loudness. An instrument never makes its own
`out` node, `note` node or parameters.
"""

from collections.abc import Callable
from dataclasses import dataclass, field

from Graph import Graph, Ref

# Every instrument declares these, at these numbers, whether or not it uses them.
BEND = 1  # Semitones added to the key's pitch: a file's pitch wheel, times its bend range (2 unless it says otherwise)
WHEEL = 2  # The mod wheel, CC 1, 0 to 1: vibrato, or what the instrument makes of it
EXPRESSION = 3  # CC 11, 0 to 1, which the generator applies as gain squared, GM's curve, after the instrument
PRESSURE = 4  # Channel pressure, 0 to 1: what the instrument makes of it
PARAMS = [
    {
        "id": BEND,
        "name": "bend",
        "scope": "track",
        "min": -24.0,
        "max": 24.0,
        "default": 0.0,
        "smooth_ms": 5,
    },
    {
        "id": WHEEL,
        "name": "wheel",
        "scope": "track",
        "min": 0.0,
        "max": 1.0,
        "default": 0.0,
        "smooth_ms": 30,
    },
    {
        "id": EXPRESSION,
        "name": "expression",
        "scope": "track",
        "min": 0.0,
        "max": 1.0,
        "default": 1.0,
        "smooth_ms": 20,
    },
    {
        "id": PRESSURE,
        "name": "pressure",
        "scope": "track",
        "min": 0.0,
        "max": 1.0,
        "default": 0.0,
        "smooth_ms": 30,
    },
]

Sound = Ref | tuple[Ref, Ref]  # Mono, or left and right


class Voice:
    """What an instrument's function is given: its graph, the note playing, and the parameters. A parameter's node, and the
    pitch's, is made the first time it is asked for, so an instrument that ignores one doesn't carry it."""

    def __init__(self, g: Graph) -> None:
        self.g = g
        self.key = g.node(
            "note"
        )  # .pitch in semitones, .velocity 0 to 1, .gate 1 while the note is held
        self.velocity = self.key.velocity
        self._params: dict[int, Ref] = {}
        self._pitch: Ref | None = None
        self._freq: Ref | None = None

    def param(self, id: int) -> Ref:
        if id not in self._params:
            self._params[id] = self.g.node("param", param=id)
        return self._params[id]

    @property
    def pitch(self) -> Ref:
        """The key's pitch with the bend added, in semitones. A drum that ignores the bend takes `key.pitch` instead."""
        if self._pitch is None:
            self._pitch = self.g.add(self.key.pitch, self.param(BEND))
        return self._pitch

    @property
    def freq(self) -> Ref:
        """`pitch` in Hz."""
        if self._freq is None:
            self._freq = self.g.mtof(self.pitch)
        return self._freq

    @property
    def wheel(self) -> Ref:
        return self.param(WHEEL)

    @property
    def pressure(self) -> Ref:
        return self.param(PRESSURE)


Phrase = list[
    tuple[float, int, int, float]
]  # (beat, MIDI note, velocity 1 to 127, beats held)


@dataclass
class Instrument:
    name: str  # UpperCamelCase and unique in the set: its patch's key, and its built-in patch's id, builtin-gm-<name>
    title: str  # As the patch picker lists it, in sentence case: "Grand piano"
    family: str  # One of GeneralMidi.FAMILIES, or GeneralMidi.DRUM_KIT for a drum
    build: Callable[[Voice], Sound]
    low: int  # The range it is written for, as MIDI notes. Its audition and its level are taken inside it.
    high: int
    programs: list[int] = field(
        default_factory=list
    )  # The GM programs it plays, all in its own family
    keys: list[int] = field(
        default_factory=list
    )  # A drum's: the GM percussion keys it plays
    voices: int = 8  # How many notes at once its audition track gives it
    level: float = 0.0  # dB from the set's loudness, for one meant to sit quieter or louder in a mix
    gated: bool = True  # Whether it stops soon after its note ends. A drum that rings out whatever its length is False.
    phrase: Phrase | None = (
        None  # Its audition. Without one, a scale and a chord in the middle of its range.
    )
    listen_for: str = ""  # One sentence on what it should sound like


@dataclass
class Effect:
    name: str  # As an instrument's
    title: str
    # Given the `in` node (.l and .r), the effect's output. On a bus, which is where an effect goes unless it is an insert,
    # that is its effect alone, wet, since the dry sound goes straight on. An insert's is the whole sound, processed.
    build: Callable[[Graph, Ref], Sound]
    insert: bool = False  # Played on a track's own chain, as a tremolo is, rather than on a bus its sends reach
    send: str = (
        ""  # "reverb" for the bus CC 91 sends to, "chorus" for CC 93's, or nothing
    )
    listen_for: str = ""
