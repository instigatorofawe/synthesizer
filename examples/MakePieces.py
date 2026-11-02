# /// script
# requires-python = ">=3.12,<3.14"
# dependencies = ["numpy", "modsynth"]
#
# [tool.uv.sources]
# modsynth = { path = "..", editable = false }
# ///
"""Writes examples/Pieces: public-domain pieces arranged for the engine, in the same form as the recipes.

The notes come from the Mutopia Project's editions, which their typesetters placed in the public domain, and everything
else is a performance made here: the instruments, the tempo and its rubato, dynamics, pedalling, articulation and the
mix. Bach's chorale is copied from its LilyPond source below. The other three are read from the MIDI files LilyPond wrote
from theirs, in examples/Pieces/Scores. Each piece is rendered once to set its master gain, so its peak lands where the
recipes' do.

    uv run examples/MakePieces.py                  # every piece
    uv run examples/MakePieces.py PassionChorale   # only these

Sources, all at https://www.mutopiaproject.org/ftp/ and typeset by the Mutopia maintainers named:
    BachPreludeInC.mid    BachJS/BWV846/wtk1-prelude1/wtk1-prelude1.mid, Tobias Erbsland
    PassionChorale        BachJS/O_Haupt_voll_Blut/O_Haupt_voll_Blut.ly, dwb
    FurElise.mid          BeethovenLv/WoO59/fur_Elise_WoO59/fur_Elise_WoO59.mid, Stelios Samelis
    MountainKing.mid      GriegE/O46/Dans_l_antre_du_roi_de_la_montagne/Dans_l_antre_du_roi_de_la_montagne.mid, Coyau
"""

import itertools
import json
import math
import struct
import sys
from dataclasses import dataclass, replace
from pathlib import Path

import modsynth
import numpy as np

HERE = Path(__file__).resolve().parent
PIECES = HERE / "Pieces"
SCORES = PIECES / "Scores"
PPQ = 480
RATE = 48000
PEAK = 0.45  # Where every recipe's peak lands, so Listen.py's --gain means the same for all of them


# Patches ------------------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Ref:
    """One output of a node, which an input can take instead of a number."""

    id: int
    port: str = "out"

    def __getattr__(self, port: str) -> "Ref":
        if port.startswith("_"):
            raise AttributeError(port)
        return Ref(self.id, port)


class Graph:
    """Builds a patch's graph a node at a time. An input is a number, or a Ref, which becomes an edge."""

    def __init__(self) -> None:
        self.params: list[dict] = []
        self.nodes: list[dict] = []
        self.edges: list[dict] = []

    def node(self, kind: str, inputs: dict | None = None, **options) -> Ref:
        id = len(self.nodes) + 1
        node = {"id": id, "type": kind, **options}
        numbers = {}
        for name, value in (inputs or {}).items():
            if isinstance(value, Ref):
                edge = {"from": value.id, "to": id, "input": name}
                if value.port != "out":
                    edge = {
                        "from": value.id,
                        "port": value.port,
                        "to": id,
                        "input": name,
                    }
                self.edges.append(edge)
            elif value is not None:
                numbers[name] = round(float(value), 6)
        if numbers:
            node["inputs"] = numbers
        self.nodes.append(node)
        return Ref(id)

    def mul(self, a, b) -> Ref:
        return self.node("mul", {"a": a, "b": b})

    def add(self, a, b) -> Ref:
        return self.node("add", {"a": a, "b": b})

    def mtof(self, pitch) -> Ref:
        return self.node("mtof", {"in": pitch})

    def snap(self, signal) -> Ref:
        return self.node("snap", {"in": signal})

    def env(self, attack, decay, sustain, release) -> Ref:
        return self.node(
            "env",
            {"attack": attack, "decay": decay, "sustain": sustain, "release": release},
        )

    def osc(self, wave: str, freq, mode: str | None = None, **inputs) -> Ref:
        options = {"wave": wave} | ({"mode": mode} if mode else {})
        return self.node("osc", {"freq": freq, **inputs}, **options)

    def filter(self, mode: str, signal, cutoff, q=0.707) -> Ref:
        return self.node("biquad", {"in": signal, "cutoff": cutoff, "q": q}, mode=mode)

    def keyed(self, pitch, seconds: float) -> Ref:
        """`seconds` at C4, twice as long two octaves down and half as long two octaves up, as strings ring."""
        return self.mul(
            self.node("ratio", {"in": self.add(self.mul(pitch, -0.5), 90.0)}, root=60),
            seconds,
        )

    def out(self, left, right=None) -> None:
        self.node("out", {"l": left, "r": right})

    def json(self) -> dict:
        graph = {"nodes": self.nodes, "edges": self.edges}
        return {"params": self.params, **graph} if self.params else graph


def harpsichord() -> dict:
    """Two choirs of strings, one an octave up, plucked bright and dying away faster in the treble, as a quill does."""
    g = Graph()
    key = g.node("note")
    f = g.mtof(key.pitch)
    eight = g.osc("square", f, width=0.16)  # A narrow pulse for the nasal 8' choir
    four = g.osc("saw", g.mul(f, 2.003))  # The 4' choir, a hair sharp of the octave
    strings = g.add(eight, g.mul(four, 0.32))
    # The cutoff follows the pitch, as a multiple of it, so every note is as bright and none aliases. It opens at
    # the pluck and settles, and a harder key plucks brighter.
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
    g.out(g.filter("highpass", g.mul(sound, level), 70.0))
    return g.json()


def electric_piano() -> dict:
    """A tine piano: a sine phase-modulated by another at its own pitch, whose bark fades into a bell as it rings."""
    g = Graph()
    key = g.node("note")
    f = g.mtof(key.pitch)
    bark = g.env(0.0005, 0.5, 0.12, 0.3)
    # Turns of phase at the strike: a harder key barks more.
    depth = g.add(g.mul(key.velocity, 0.55), 0.08)
    modulator = g.mul(g.mul(g.osc("sine", f), bark), depth)
    tine = g.osc("sine", f, mode="mod", phase=modulator)
    # The metal of the tine, briefly.
    ping = g.mul(g.osc("sine", g.mul(f, 7.0)), g.env(0.0002, 0.05, 0.0, 0.03))
    sound = g.add(tine, g.mul(ping, g.mul(key.velocity, 0.15)))
    ring = g.env(0.001, g.keyed(key.pitch, 3.0), 0.0, 0.3)
    level = g.mul(g.add(g.mul(g.mul(key.velocity, key.velocity), 0.8), 0.2), 0.3)
    # Modulating a sine at its own pitch leaves a DC offset that depends on where the two start, so it is filtered out.
    g.out(g.filter("highpass", g.mul(g.mul(sound, ring), level), 40.0))
    return g.json()


def tremolo(rate: float, depth: float) -> dict:
    """An insert that swings a track from side to side, as an electric piano's stereo vibrato does."""
    g = Graph()
    source = g.node("in")
    swing = g.node(
        "pan",
        {
            "in": g.add(source.l, source.r),
            "position": g.node("lfo", {"rate": rate, "depth": depth}),
        },
    )
    g.out(swing.l, swing.r)
    return g.json()


def brass(
    bright: float,
    floor: float,
    formant: float,
    vibrato: float,
    breath: float,
    attack: float,
    clean: bool = False,
) -> dict:
    """A brass voice: a saw through a filter that opens as it is blown harder, a soft clip that adds the brassy edge,
    a formant and breath. The same shape as the Trumpet and FrenchHorn recipes, with its colour as arguments."""
    g = Graph()
    key = g.node("note")
    # Lips start a little flat, and vibrato arrives late, on long notes only.
    scoop = g.mul(g.snap(g.env(0.001, 0.05, 0.0, 0.01)), -0.3)
    swell = g.env(0.5, 0.1, 1.0, 0.1)
    wobble = g.mul(g.node("lfo", {"rate": 5.2, "depth": vibrato}), g.snap(swell))
    saw = g.osc("saw", g.mtof(g.add(key.pitch, g.add(scoop, wobble))))
    blow = g.env(attack, 0.15, 0.8, 0.09)
    effort = g.mul(key.velocity, g.snap(blow))
    cutoff = g.add(g.mul(effort, bright), floor)
    tone = g.filter("lowpass", g.filter("lowpass", saw, cutoff, 0.7), bright * 1.2, 0.7)
    driven = g.mul(tone, g.add(g.mul(effort, 1.3), 0.4))
    shaped = g.add(driven, g.mul(g.mul(g.mul(driven, driven), driven), -0.33))
    horn = g.add(shaped, g.mul(g.filter("bandpass", shaped, formant, 1.1), 1.1))
    if clean:
        horn = g.filter("lowpass", g.filter("highpass", horn, 420.0), 4200.0)
    air = g.mul(
        g.filter("bandpass", g.node("noise"), 2600.0, 0.8),
        g.env(0.002, 0.08, 0.03, 0.05),
    )
    sound = g.mul(g.add(horn, g.mul(air, breath)), blow)
    g.out(g.mul(sound, g.mul(g.add(key.velocity, 0.45), 0.42)))
    return g.json()


def reed(low: float, high: float, width: float) -> dict:
    """A double reed: a narrow pulse through two formants, brighter as it is blown harder."""
    g = Graph()
    key = g.node("note")
    vibrato = g.mul(
        g.node("lfo", {"rate": 5.0, "depth": 0.06}), g.snap(g.env(0.35, 0.1, 1.0, 0.1))
    )
    buzz = g.osc("square", g.mtof(g.add(key.pitch, vibrato)), width=width)
    blow = g.env(0.02, 0.1, 0.75, 0.06)
    open_by = g.mul(g.snap(blow), key.velocity)
    body = g.mul(
        g.filter("lowpass", buzz, g.add(g.mul(open_by, 2600.0), 900.0), 0.7), 0.5
    )
    body = g.add(body, g.mul(g.filter("bandpass", buzz, low, 2.0), 1.2))
    body = g.add(body, g.mul(g.filter("bandpass", buzz, high, 3.0), 0.7))
    g.out(g.mul(g.mul(body, blow), g.mul(g.add(g.mul(key.velocity, 0.7), 0.3), 0.8)))
    return g.json()


def pizzicato() -> dict:
    """A plucked string: bright at the pluck, ringing longer the lower it is, through a wooden body."""
    g = Graph()
    key = g.node("note")
    f = g.mtof(key.pitch)
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
    g.out(g.mul(g.mul(body, ring), g.mul(g.add(g.mul(key.velocity, 0.75), 0.25), 0.35)))
    return g.json()


def bowed() -> dict:
    """A string section: three saws a few cents apart, a vibrato they share, and a filter opened by the bow."""
    g = Graph()
    key = g.node("note")
    pitch = g.add(key.pitch, g.node("lfo", {"rate": 5.4, "depth": 0.09}))
    saws = g.add(
        g.osc("saw", g.mtof(g.add(pitch, -0.08))),
        g.osc("saw", g.mtof(g.add(pitch, 0.08))),
    )
    saws = g.add(saws, g.mul(g.osc("saw", g.mtof(pitch)), 0.8))
    bow = g.env(0.03, 0.15, 0.85, 0.22)
    tone = g.filter("lowpass", saws, g.add(g.mul(key.velocity, 4000.0), 1400.0), 0.6)
    tone = g.filter("highpass", tone, 110.0)
    g.out(g.mul(g.mul(tone, bow), g.mul(g.add(g.mul(key.velocity, 0.8), 0.2), 0.45)))
    return g.json()


def timpani() -> dict:
    """A kettledrum: a few inharmonic modes that start a little sharp and settle, over a felt thump."""
    g = Graph()
    key = g.node("note")
    f = g.mtof(g.add(key.pitch, g.mul(g.snap(g.env(0.001, 0.08, 0.0, 0.01)), 0.4)))
    modes = g.osc("sine", f)
    for ratio, level in ((1.504, 0.5), (1.742, 0.25), (2.0, 0.2)):
        modes = g.add(modes, g.mul(g.osc("sine", g.mul(f, ratio)), level))
    ring = g.env(0.002, 2.2, 0.0, 0.6)
    thump = g.filter(
        "lowpass", g.node("noise"), g.add(g.mul(key.velocity, 1500.0), 300.0)
    )
    thump = g.mul(thump, g.env(0.0005, 0.06, 0.0, 0.03))
    sound = g.add(g.mul(modes, ring), g.mul(thump, 0.8))
    g.out(g.mul(sound, g.mul(g.add(g.mul(key.velocity, 0.8), 0.2), 0.35)))
    return g.json()


def cymbal() -> dict:
    """A crash: high noise that takes seconds to die, whatever key plays it."""
    g = Graph()
    key = g.node("note")
    hiss = g.filter("highpass", g.node("noise"), 5000.0)
    hiss = g.add(hiss, g.mul(g.filter("bandpass", hiss, 9000.0, 0.6), 0.8))
    g.out(g.mul(g.mul(hiss, g.env(0.001, 3.0, 0.0, 1.5)), g.mul(key.velocity, 0.25)))
    return g.json()


def hall(feedback: float, damp: float, wet: float) -> dict:
    """The Reverb recipe's room, two banks of eight combs and four allpasses, with its size and colour as arguments."""
    g = Graph()
    source = g.node("in")
    mono = g.mul(g.add(source.l, source.r), 0.5)
    sides = []
    for spread in (0.0, 0.0005):
        bank = None
        for seconds in (0.0297, 0.0371, 0.0411, 0.0437, 0.0253, 0.0269, 0.0290, 0.0307):
            comb = g.node(
                "comb",
                {
                    "in": mono,
                    "time": seconds + spread,
                    "feedback": feedback,
                    "damp": damp,
                },
                max=0.05,
            )
            bank = comb if bank is None else g.add(bank, comb)
        for seconds in (0.0126, 0.0100, 0.0077, 0.0051):
            bank = g.node(
                "allpass",
                {"in": bank, "time": seconds + spread, "feedback": 0.5},
                max=0.02,
            )
        sides.append(g.mul(bank, wet))
    g.out(*sides)
    return g.json()


# Scores -------------------------------------------------------------------------------------------------------------


@dataclass
class Note:
    tick: int
    dur: int
    pitch: int
    vel: int = 64
    part: int = 0  # The staff or voice it came from

    @property
    def end(self) -> int:
        return self.tick + self.dur


def read_midi(path: Path) -> list[Note]:
    """The notes of a Standard MIDI File at PPQ, each with the track it came from as its part."""
    data = path.read_bytes()
    _, _, tracks, division = struct.unpack(">IHHH", data[4:14])
    at, notes = 14, []

    def number(at: int) -> tuple[int, int]:
        value = 0
        while True:
            byte = data[at]
            value, at = (value << 7) | (byte & 0x7F), at + 1
            if byte < 0x80:
                return value, at

    for track in range(tracks):
        end = at + 8 + struct.unpack(">I", data[at + 4 : at + 8])[0]
        at, tick, status, held = at + 8, 0, 0, {}
        while at < end:
            delta, at = number(at)
            tick += delta
            if data[at] == 0xFF:
                length, at = number(at + 2)
                at += length
                continue
            if data[at] in (0xF0, 0xF7):
                length, at = number(at + 1)
                at += length
                continue
            if data[at] & 0x80:  # Otherwise the last channel message's status runs on
                status, at = data[at], at + 1
            if status & 0xF0 in (0xC0, 0xD0):
                at += 1
            else:
                kind, key, velocity = status & 0xF0, data[at], data[at + 1]
                at += 2
                if kind == 0x90 and velocity:
                    held.setdefault(key, []).append(tick)
                elif kind in (0x80, 0x90) and held.get(key):
                    start = held[key].pop(0)
                    tick_at = round(start * PPQ / division)
                    notes.append(
                        Note(
                            tick_at,
                            max(1, round(tick * PPQ / division) - tick_at),
                            key,
                            part=track,
                        )
                    )
        at = end
    return sorted(notes, key=lambda n: (n.tick, n.pitch))


STEPS = {"c": 0, "d": 1, "e": 2, "f": 3, "g": 4, "a": 5, "b": 6}
SEMITONES = [0, 2, 4, 5, 7, 9, 11]


def lilypond(start: str, music: str) -> list[tuple[Note, bool]]:
    """Notes from LilyPond's relative mode, as much of it as a chorale uses, each with whether it has a fermata."""
    position = lambda octaves: 7 * (3 + octaves.count("'") - octaves.count(","))
    previous = position(start[1:]) + STEPS[start[0]]
    tick, length, notes = 0, PPQ, []
    for word in music.replace("|", " ").split():
        if word == "\\fermata":
            notes[-1] = (notes[-1][0], True)
            continue
        word = word.replace("!", "").strip("[]()")
        name, rest = word[0], word[1:]
        alter = 0
        while rest[:2] in ("is", "es"):
            alter, rest = alter + (1 if rest[:2] == "is" else -1), rest[2:]
        # "as" and "es" are the flats LilyPond spells short.
        if name in "ae" and rest[:1] == "s":
            alter, rest = -1, rest[1:]
        marks = "".join(c for c in rest if c in "',")
        digits = rest.lstrip("',")
        if digits:
            length = PPQ * 4 // int(digits.rstrip("."))
            length += length // 2 if digits.endswith(".") else 0
        # Relative mode puts each note within a fourth of the one before, and then moves it by its octave marks.
        up = (STEPS[name] - previous) % 7
        previous += up if up <= 3 else up - 7
        previous += 7 * (marks.count("'") - marks.count(","))
        pitch = 12 * (previous // 7 + 1) + SEMITONES[previous % 7] + alter
        notes.append((Note(tick, length, pitch), False))
        tick += length
    return notes


# Performance --------------------------------------------------------------------------------------------------------


def cut_restrikes(notes: list[Note]) -> list[Note]:
    """Ends a note where the same key is struck again, as a piano's string is."""
    out = sorted((replace(n) for n in notes), key=lambda n: (n.pitch, n.tick))
    for a, b in itertools.pairwise(out):
        if a.pitch == b.pitch and b.tick < a.end:
            a.dur = max(1, b.tick - a.tick)
    return sorted(out, key=lambda n: (n.tick, n.pitch))


def pedal(notes: list[Note], spans: list[tuple[int, int]]) -> list[Note]:
    """Holds every note released while the pedal is down until the pedal comes up. A note released as the pedal goes
    down isn't caught, as a player changing pedal on the beat means. The timeline has no pedal, so a performance
    writes it into how long the notes are."""
    out = []
    for n in notes:
        end = n.end
        for down, up in spans:
            if down < end < up:
                end = up
        out.append(replace(n, dur=end - n.tick))
    return cut_restrikes(out)


def curve(points: list[tuple[int, float]], tick: int) -> float:
    """A value that moves in straight lines between (tick, value) points and holds past the last."""
    if tick <= points[0][0]:
        return points[0][1]
    for (a, x), (b, y) in itertools.pairwise(points):
        if tick < b:
            return x + (y - x) * (tick - a) / (b - a)
    return points[-1][1]


def wobble(*keys: int) -> int:
    """A small offset, from -2 to 2, that is the same every time a note is written, so a velocity can vary as a
    player's does without making the output change from one run to the next."""
    value = 0
    for key in keys:
        value = (value * 1_000_003 + key) % 2_147_483_647
    return (value * 2_654_435_761 >> 16) % 5 - 2


def velocity(value: float) -> int:
    return max(1, min(127, round(value)))


class Tempo:
    """A tempo map built a change at a time. `ramp` glides to the next change rather than holding."""

    def __init__(self, bpm: float) -> None:
        self.changes = [{"tick": 0, "bpm": bpm}]

    def at(self, tick: int, bpm: float, ramp: bool = False) -> None:
        self.changes = [c for c in self.changes if c["tick"] != tick]
        change = {"tick": tick, "bpm": round(bpm, 2)}
        self.changes.append(change | {"ramp": True} if ramp else change)
        self.changes.sort(key=lambda c: c["tick"])

    def glide(self, start: int, end: int, start_bpm: float, end_bpm: float) -> None:
        self.at(start, start_bpm, ramp=True)
        self.at(end, end_bpm)


class Song:
    """A timeline under construction: its tracks, their notes and lanes cut into clips at the piece's sections."""

    def __init__(
        self, tempo: Tempo, sections: list[tuple[str, int]], length: int
    ) -> None:
        self.tempo, self.sections, self.length = tempo, sections, length
        self.patches: dict[str, dict] = {}
        self.clips: list[dict] = []
        self.tracks: list[dict] = []
        self.buses: list[dict] = []

    def patch(self, key: str, name: str, graph: dict) -> str:
        self.patches[key] = {"name": name, "graph": graph}
        return key

    def bus(self, key: str, insert: str, gain: float = 1.0) -> None:
        self.buses.append(
            {
                "id": key,
                "gain": gain,
                "inserts": [{"id": 100 + len(self.buses), "patch": insert}],
            }
        )

    def track(
        self,
        name: str,
        slots: list[str],
        notes: list[Note],
        voices: int,
        gain: float = 1.0,
        pan: float = 0.0,
        sends: dict[str, float] | None = None,
        lanes: list[dict] | None = None,
        inserts: list[str] | None = None,
        slot_of=None,
        steal: str = "cut",
    ) -> int:
        """Adds a track whose notes and fader lane are cut into one clip per section they fall in."""
        id = len(self.tracks) + 1
        key = "".join(c for c in name.lower() if c.isalnum())
        bounds = [tick for _, tick in self.sections[1:]] + [self.length]
        placements = []
        for (section, start), end in zip(self.sections, bounds):
            inside = [n for n in notes if start <= n.tick < end]
            moves = [lane for lane in lanes or [] if start <= lane["tick"] < end]
            if not inside and not moves:
                continue
            clip = {
                "id": f"{key}-{section}",
                "length": end - start,
                "notes": [],
                "automation": [],
            }
            for n in inside:
                note = {
                    "tick": n.tick - start,
                    "note": n.pitch,
                    "vel": n.vel,
                    "dur": n.dur,
                }
                if slot_of is not None and slot_of(n):
                    note["slot"] = slot_of(n)
                clip["notes"].append(note)
            for lane in moves:
                clip["automation"].append(
                    {"target": {"mix": "fader", "track": id}}
                    | {k: v for k, v in lane.items() if k != "target"}
                    | {"tick": lane["tick"] - start}
                )
            if not clip["automation"]:
                del clip["automation"]
            self.clips.append(clip)
            placements.append({"clip": clip["id"], "tick": start})
        self.tracks.append(
            {
                "id": id,
                "name": name,
                "voices": voices,
                "slots": slots,
                "gain": gain,
                "pan": pan,
                "placements": placements,
                "sends": [
                    {"bus": bus, "gain": level} for bus, level in (sends or {}).items()
                ],
                "inserts": [
                    {"id": 50 + id * 4 + i, "patch": p}
                    for i, p in enumerate(inserts or [])
                ],
            }
            | ({"steal": steal} if steal != "cut" else {})
        )
        return id

    def project(self, id: str, name: str, gain: float = 1.0) -> dict:
        timeline = {
            "ppq": PPQ,
            "tempo": self.tempo.changes,
            "clips": self.clips,
            "tracks": self.tracks,
            "buses": self.buses,
            "master": {"gain": gain},
        }
        return {
            "patches": self.patches,
            "programs": [{"id": id, "name": name, "timeline": timeline}],
        }


def fader(points: list[tuple[int, float]]) -> list[dict]:
    """A fader lane that moves in ramps between (tick, gain) points, for a crescendo on held notes or a whole section."""
    lanes = [{"tick": points[0][0], "value": points[0][1]}]
    for (a, _), (b, value) in itertools.pairwise(points):
        lanes.append(
            {"tick": a, "value": value, "ramp": b - a}
            if b > a
            else {"tick": b, "value": value}
        )
    return lanes


# Pieces -------------------------------------------------------------------------------------------------------------


def prelude() -> tuple[dict, str]:
    """Bach, Prelude in C major, BWV 846, from The Well-Tempered Clavier, Book I, on a harpsichord."""
    bar = 4 * PPQ
    notes = read_midi(SCORES / "BachPreludeInC.mid")
    # How much each bar leans: the harmony's tension, as a player shapes it with touch and time. A harpsichord's touch
    # barely changes its loudness, so this mostly moves its brightness.
    lean = [62, 64, 68, 62, 66, 70, 72, 70, 66, 72, 68, 76, 74, 78, 70, 68, 70, 72]
    lean += [64, 70, 72, 80, 84, 76, 70, 72, 76, 82, 78, 74, 72, 76, 80, 84, 74]
    played = []
    for n in notes:
        index, at = divmod(n.tick, bar)
        half_bar = at % (bar // 2)
        vel = (
            lean[index]
            + (8 if half_bar == 0 else 4 if half_bar == PPQ // 4 else 0)
            + wobble(n.tick, n.pitch)
        )
        # Over-holding the figuration lets it ring, as players do.
        dur = n.dur if n.dur > PPQ // 4 else PPQ * 5 // 8
        played.append(Note(n.tick, dur, n.pitch, velocity(vel)))
    # The last chord is rolled from the bottom up.
    last = sorted((n for n in played if n.tick == 34 * bar), key=lambda n: n.pitch)
    for i, n in enumerate(last):
        n.tick += i * 36
        n.dur = bar - i * 36
    played = cut_restrikes(played)

    tempo = Tempo(66)
    # Bars where the harmony arrives somewhere: lean into them, then go on.
    for arrival in (19, 24, 32):
        start = (arrival - 1) * bar
        tempo.glide(start - PPQ, start, 66, 60)
        tempo.at(start + PPQ, 66)
    tempo.glide(32 * bar, 34 * bar, 66, 44)

    song = Song(tempo, [("prelude", 0)], 35 * bar)
    song.patch("harpsichord", "Harpsichord", harpsichord())
    song.patch("room", "Chamber", hall(0.8, 0.35, 0.09))
    song.bus("room", "room")
    song.track("Harpsichord", ["harpsichord"], played, voices=12, sends={"room": 0.3})
    listen = (
        "Bach's C major prelude on a two-choir harpsichord, each figure ringing on under the next, leaning into the "
        "bars where the harmony arrives and slowing into a rolled last chord."
    )
    return song.project("prelude", "Prelude in C"), listen


SOPRANO = r"""a4 | d c bes a | g2 a4 \fermata e' | f f e8 d e4 | d2. \fermata a4 | d c bes a | g2 a4 \fermata e' |
f f e8 d e4 | d2. \fermata f4 | e8 d c4 d e | f2 f4 \fermata c | d c bes8 a bes4 | a2. \fermata f'!4 | e8 f g4 f e |
d2 e4 \fermata a, | bes a g c | a2. \fermata"""
ALTO = r"""f4 | f8 g a4 d,8 e f4 | f( e) f a | a a a a8 g | f2. f4 | f8 g a4 d,8 e f4 | f( e) f a | a a a a8 g |
f2. a4 | g g8 f f4 bes | bes( a8 g) a4 a | a8 g a4 g8 fis g4 | fis2. g4 | g c c c | c( b) c f,8 e | d8 e f4 f e |
f2."""
TENOR = r"""d4 | d8 e f4 g c, | d( c) c e | e d d cis | a2. d4 | d8 e f4 g c, | d( c) c e | e d d cis |
a2. d8 c! | bes4 c c bes8 c | d4( c8 bes) c4 f8 es | d4 d d d | d2. d4 | c8 d e4 f g | a( g) g c, |
bes c c8( bes16 a) g8 c | c2."""
BASS = r"""d'8 c | bes4 a g f | bes,( c) f \fermata cis | d8 e f g a4 a, | d2. \fermata d'8 c | bes4 a g f |
bes,( c) f \fermata cis | d8 e f g a4 a,4 | d2. \fermata d4 | g a bes8 a g4 | f2 f4 \fermata f | bes fis g g, |
d'2. \fermata b4 | c c'8 b a4 g | f( g) c, \fermata f | g a8 bes c4 c, | f2. \fermata"""


def chorale() -> tuple[dict, str]:
    """Bach, chorale "O Haupt voll Blut und Wunden" from the St Matthew Passion, BWV 244, for brass quartet."""
    parts = {
        "Trumpet": (lilypond("c''", SOPRANO), -0.3),
        "Flugelhorn": (lilypond("c'", ALTO), -0.1),
        "Horn": (lilypond("c'", TENOR), 0.15),
        "Trombone": (lilypond("c", BASS), 0.35),
    }
    held = [n.end for n, fermata in parts["Trumpet"][0] if fermata]
    starts = [0] + held[:-1]
    # Each phrase has a level, the second Stollen echoing the first, and swells toward its middle.
    levels = [66, 70, 56, 58, 74, 78, 86, 60]

    def shaped(notes: list[tuple[Note, bool]]) -> list[Note]:
        out = []
        for n, _ in notes:
            phrase = sum(1 for end in held if end <= n.tick)
            start, end = starts[min(phrase, 7)], held[min(phrase, 7)]
            arc = math.sin(math.pi * (n.tick - start) / max(1, end - start))
            vel = levels[min(phrase, 7)] + 8 * arc + wobble(n.tick, n.pitch)
            # Every note is tongued, so it is a little short of the next, and a fermata's end is a breath.
            gap = PPQ // 4 if n.end in held else PPQ // 16
            out.append(Note(n.tick, max(PPQ // 8, n.dur - gap), n.pitch, velocity(vel)))
        return out

    tempo = Tempo(58)
    for i, end in enumerate(held):
        fermata = next(n for n, f in parts["Trumpet"][0] if f and n.end == end)
        last = i == len(held) - 1
        # Slow into each fermata, hold it a beat or so longer than written, and the last one longest.
        tempo.at(fermata.tick - PPQ // 2, 58, ramp=True)
        beats = fermata.dur / PPQ
        tempo.at(
            fermata.tick,
            58 * beats / (beats + (3.0 if last else 1.1 if beats < 2 else 1.5)),
        )
        if not last:
            tempo.at(end, 58)
    length = held[-1] + 2 * PPQ

    song = Song(tempo, [("chorale", 0)], length)
    song.patch(
        "trumpet", "Trumpet", brass(2600, 650, 1300, 0.08, 0.1, 0.03, clean=True)
    )
    song.patch("flugelhorn", "Flugelhorn", brass(1500, 420, 900, 0.06, 0.06, 0.05))
    song.patch("horn", "Horn", brass(1250, 260, 480, 0.04, 0.03, 0.07))
    song.patch("trombone", "Trombone", brass(1700, 300, 600, 0.03, 0.05, 0.05))
    song.patch("church", "Church", hall(0.88, 0.3, 0.07))
    song.bus("church", "church")
    for (name, (notes, pan)), slot in zip(
        parts.items(), ["trumpet", "flugelhorn", "horn", "trombone"]
    ):
        song.track(
            name, [slot], shaped(notes), voices=3, pan=pan, sends={"church": 0.45}
        )
    listen = (
        "Bach's Passion Chorale for trumpet, flugelhorn, horn and trombone in a large church, every phrase slowing "
        "into its fermata and taking a breath, the repeat an echo of the first time."
    )
    return song.project("chorale", "O Haupt voll Blut und Wunden"), listen


def elise() -> tuple[dict, str]:
    """Beethoven, Bagatelle in A minor, WoO 59, "Für Elise", on a tine electric piano."""
    printed = read_midi(SCORES / "FurElise.mid")
    scale = lambda tick: tick * PPQ // 384  # The score's own resolution
    # LilyPond wrote the score as printed, so each half of the opening plays once with both endings after it. Played,
    # each half repeats, with its first ending the first time and its second ending the second.
    body, first, second = (0, 4224), (4224, 4608), (4608, 5184)
    body2, first2, second2 = (5184, 12672), (12672, 13248), (13248, 13824)
    order = [body, first, body, second, body2, first2, body2, second2, (13824, 60480)]
    notes, cursor, starts = [], 0, []
    for a, b in order:
        starts.append(cursor)
        for n in printed:
            if scale(a) <= n.tick < scale(b):
                notes.append(replace(n, tick=n.tick - scale(a) + cursor))
        cursor += scale(b) - scale(a)
    pickup, bar = PPQ // 2, PPQ * 3 // 2  # 3/8, from a pickup of an eighth
    later = lambda k: starts[-1] + k * bar  # Bar k of what follows the repeats
    a1, a2, b_section, back = 0, starts[4], later(0), later(11)
    a3, c_section, run, a4 = later(15), later(36), later(54), later(59)
    length = later(81)
    right, left = 1, 2

    # Dynamics as the score has them, and as a player shapes them: hairpins to each phrase's height.
    dynamic = [
        (0, 48),
        (a2, 48),
        (a2 + 4 * bar, 56),
        (b_section, 58),
        (b_section + 7 * bar, 72),
        (back, 64),
    ]
    dynamic += [
        (back + 3 * bar, 44),
        (a3, 48),
        (c_section, 40),
        (c_section + 5 * bar, 84),
        (c_section + 8 * bar, 90),
    ]
    dynamic += [
        (c_section + 13 * bar, 64),
        (c_section + 17 * bar, 46),
        (run, 50),
        (run + 2 * bar, 74),
    ]
    dynamic += [(run + 5 * bar, 44), (a4, 48), (length - 4 * bar, 44), (length, 34)]
    for n in notes:
        level = curve(dynamic, n.tick)
        lift = max(-8, min(8, (n.pitch - 76) * 0.7)) if n.part == right else -12
        downbeat = 4 if (n.tick - pickup) % bar == 0 else 0
        n.vel = velocity(level + lift + downbeat + wobble(n.tick, n.pitch))

    # The pedal goes down with each bar's bass and comes up a thirty-second before the next, as marked. The passage
    # over a drumming bass A takes none, and the arpeggios that climb out of it hold one through all three bars.
    spans = []
    for k in range((length - pickup) // bar):
        down = pickup + k * bar
        if c_section <= down < run or run + 3 * bar <= down < a4:
            continue
        if run <= down < run + 3 * bar:
            if down == run:
                spans.append((run, run + 3 * bar - PPQ // 8))
            continue
        if any(n.part == left and n.tick == down for n in notes):
            spans.append((down, down + bar - PPQ // 8))
    notes = pedal(notes, spans)

    tempo = Tempo(66)
    # Each phrase that comes to rest on A broadens into it and goes on in time. The last one slows to the end.
    cadences = [
        n.tick for n in notes if n.part == right and n.pitch == 69 and n.dur >= PPQ // 2
    ]
    cadences = [
        t
        for t in cadences
        if (t - pickup) % bar == 0 and not c_section <= t < a4 and t < length - 4 * bar
    ]
    for t in cadences:
        tempo.at(t - bar // 2, 66, ramp=True)
        tempo.at(t, 58)
        tempo.at(t + PPQ // 2, 66)
    # The E and D sharp hesitate before the theme comes back.
    tempo.at(back, 66, ramp=True)
    tempo.at(a3 - bar, 54, ramp=True)
    tempo.at(a3, 66)
    # The drumming bass presses on, and then lets go.
    tempo.at(c_section, 68, ramp=True)
    tempo.at(c_section + 8 * bar, 74)
    tempo.at(c_section + 13 * bar, 72, ramp=True)
    # Up the arpeggios, then down the chromatic scale, slowing, and the theme again in time.
    tempo.at(run, 60, ramp=True)
    tempo.at(run + 3 * bar, 70, ramp=True)
    tempo.at(a4 - PPQ // 4, 50)
    tempo.at(a4, 64)
    tempo.at(length - 4 * bar, 64, ramp=True)
    tempo.at(length - bar, 46)

    sections = [("a", a1), ("a-second", a2), ("b", b_section), ("a-return", back)]
    sections += [("c", c_section), ("run", run), ("a-last", a4)]
    song = Song(tempo, sections, length)
    song.patch("piano", "Electric piano", electric_piano())
    song.patch("tremolo", "Stereo tremolo", tremolo(4.2, 0.45))
    song.patch("room", "Room", hall(0.82, 0.3, 0.08))
    song.bus("room", "room")
    # The pedal keeps every voice busy, so a new note takes one still ringing: fading it out spares a click.
    song.track(
        "Piano",
        ["piano"],
        notes,
        voices=24,
        sends={"room": 0.3},
        inserts=["tremolo"],
        steal="fade",
    )
    listen = (
        "Für Elise on a tine electric piano swaying between the speakers, pedalled bar by bar, broadening into each "
        "cadence, pressing on over the drumming bass and slowing down the chromatic scale."
    )
    return song.project("elise", "Für Elise"), listen


def king() -> tuple[dict, str]:
    """Grieg, "In the Hall of the Mountain King" from Peer Gynt, Op. 46, orchestrated from the piano score."""
    bar = 4 * PPQ
    right = 1  # The score's upper staff, and the lower is 2
    score = read_midi(SCORES / "MountainKing.mid")
    # The score's sections, by bar: the horns' call, the theme three times low down, twice more as it climbs, once
    # with triplets under it, the stretto from Più vivo, the trolls' shrieks, and the roll into the last chord.
    call, theme, rising, building = 0, 1, 25, 41
    stretto, shrieks, roll, last = 49, 73, 85, 87
    starts = (call, theme, rising, building, stretto, shrieks, roll, last)
    section = lambda tick: max(s for s in starts if s * bar <= tick)

    # Velocity follows the score's dynamics: pp for the theme, a long crescendo, ff from Più vivo, a sudden pp before
    # the last shrieks and a crescendo through the roll.
    dynamic = [
        (0, 52),
        (theme * bar, 40),
        (rising * bar, 44),
        (building * bar, 76),
        (stretto * bar - 1, 96),
    ]
    dynamic += [
        (stretto * bar, 104),
        (shrieks * bar, 112),
        (83 * bar, 112),
        (83 * bar + 1, 56),
        (roll * bar, 100),
    ]
    dynamic += [(last * bar, 116)]
    parts: dict[str, list[Note]] = {}

    def play(
        name: str, n: Note, shift: int = 0, lift: float = 0, dur: int | None = None
    ) -> None:
        parts.setdefault(name, []).append(
            Note(n.tick, dur or n.dur, n.pitch + shift, velocity(n.vel + lift))
        )

    for n in score:
        at = section(n.tick)
        # The theme's fifth note is accented.
        accent = 10 if n.tick % bar == 2 * PPQ and theme <= at < shrieks else 0
        n.vel = velocity(curve(dynamic, n.tick) + accent + wobble(n.tick, n.pitch))
        grace = n.dur < PPQ // 8
        if at == call:
            play("Horns", n, dur=bar)
        elif at == theme:
            if n.part == right:
                play("Bassoons", n)
                if n.tick >= 17 * bar:
                    play("Oboes", n, 24, -4)
            else:
                play("Pizzicato", n)
                play("Pizzicato", n, 12, -6)
            if n.part == right and 9 * bar <= n.tick < 17 * bar:
                play("Pizzicato", n, 12, -8)
        elif at in (rising, building):
            if n.part == right:
                play("Violins", n)
                if n.tick >= 33 * bar:
                    play("Oboes", n, 0, -6)
            elif n.pitch < 48:
                play("Pizzicato" if at == rising else "Cellos and basses", n)
            else:
                play("Horns", n, 0, -8)
        elif at in (stretto, shrieks, last):
            if n.part == right:
                play("Violins", n)
                if not grace:
                    play("Trumpets", n, -12 if n.pitch > 84 else 0, -4)
                    play("Oboes", n, -12 if n.pitch > 91 else 0, -10)
            else:
                play("Cellos and basses", n)
                if n.pitch >= 43 or not grace:
                    play("Horns", n, 0 if n.pitch >= 43 else 12, -6)
                # The timpani are tuned to B and F sharp, and take the bass on the beat.
                beat = n.tick % PPQ == 0 and (at != shrieks or n.tick % bar == 0)
                if beat and n.pitch % 12 in (11, 6):
                    drum = 47 if n.pitch % 12 == 11 else 42
                    play("Timpani", n, drum - n.pitch, 6)
        elif at == roll:
            play("Cellos and basses", n)
            play("Timpani", n, 47 - n.pitch, -10)
    for tick, vel in ((stretto * bar, 100), (last * bar, 120)):
        parts.setdefault("Cymbal", []).append(Note(tick, PPQ, 60, vel))
    length = last * bar + 3 * PPQ
    # The last chord is held.
    for name in ("Horns", "Violins", "Trumpets", "Oboes", "Cellos and basses"):
        parts[name] = [
            replace(n, dur=3 * PPQ) if n.tick >= last * bar else n for n in parts[name]
        ]

    tempo = Tempo(60)  # The horns' call is held
    tempo.at(theme * bar, 126, ramp=True)
    tempo.at(rising * bar, 136, ramp=True)
    tempo.at(building * bar, 146, ramp=True)
    tempo.at(stretto * bar - PPQ, 152)
    tempo.at(stretto * bar, 160, ramp=True)  # Più vivo, and sempre stretto sin al fine
    tempo.at(shrieks * bar, 200)
    tempo.at(roll * bar, 196, ramp=True)
    tempo.at(last * bar, 150)

    # A whole orchestra gets louder by more than velocity can say, so each section's fader climbs too, in ramps a few
    # bars long. A ramp's length turns into time at the tempo where it starts, so under an accelerando long ones end
    # late, and short ones keep closer.
    def climb(
        start_bar: int, end_bar: int, start: float, end: float, steps: int = 4
    ) -> list[tuple[int, float]]:
        return [
            (
                (start_bar + (end_bar - start_bar) * k // steps) * bar,
                start + (end - start) * k / steps,
            )
            for k in range(steps + 1)
        ]

    lanes = {
        "Bassoons": fader(climb(theme, rising, 0.7, 1.0)),
        "Pizzicato": fader(climb(theme, building, 0.7, 1.0, 6)),
        "Violins": fader(climb(rising, stretto, 0.7, 1.0, 6)),
        "Horns": fader(climb(rising, stretto, 0.5, 1.0, 6)),
    }
    names = ["call", "theme", "rising", "building", "stretto", "shrieks", "roll"]
    song = Song(
        tempo,
        [(name, start * bar) for name, start in zip(names, starts)],
        length,
    )
    song.patch("horn", "Horn", brass(1250, 260, 480, 0.04, 0.03, 0.04))
    song.patch(
        "trumpet", "Trumpet", brass(2600, 650, 1300, 0.06, 0.1, 0.02, clean=True)
    )
    song.patch("bassoon", "Bassoon", reed(480, 1150, 0.28))
    song.patch("oboe", "Oboe", reed(1100, 2900, 0.18))
    song.patch("pizzicato", "Pizzicato", pizzicato())
    song.patch("strings", "Strings", bowed())
    song.patch("timpani", "Timpani", timpani())
    song.patch("cymbal", "Cymbal", cymbal())
    song.patch("hall", "Concert hall", hall(0.86, 0.35, 0.07))
    song.bus("hall", "hall")
    seats = {  # patch, voices, gain, pan, send
        "Bassoons": ("bassoon", 4, 0.9, 0.1, 0.3),
        "Pizzicato": ("pizzicato", 10, 0.55, 0.3, 0.3),
        "Violins": ("strings", 10, 0.8, -0.35, 0.3),
        "Oboes": ("oboe", 6, 0.35, -0.1, 0.3),
        "Horns": ("horn", 8, 0.8, 0.25, 0.4),
        "Trumpets": ("trumpet", 6, 0.6, 0.15, 0.35),
        "Cellos and basses": ("strings", 8, 0.7, 0.4, 0.3),
        "Timpani": ("timpani", 6, 0.7, 0.0, 0.35),
        "Cymbal": ("cymbal", 2, 0.5, -0.15, 0.4),
    }
    for name, (patch, voices, gain, pan, send) in seats.items():
        song.track(
            name,
            [patch],
            parts[name],
            voices,
            gain,
            pan,
            {"hall": send},
            lanes.get(name),
        )
    listen = (
        "Grieg's trolls, orchestrated from the piano score: bassoons and pizzicato basses tiptoe through the theme, "
        "which climbs, gathers the orchestra and speeds up until the trolls shriek over the timpani."
    )
    return song.project("king", "In the Hall of the Mountain King"), listen


MAKERS = {
    "BachPreludeInC": prelude,
    "PassionChorale": chorale,
    "FurElise": elise,
    "HallOfTheMountainKing": king,
}


def dump(value, indent: int = 0) -> str:
    """JSON with one note, node or edge to a line, so a piece reads and diffs a line at a time."""
    flat = json.dumps(value, ensure_ascii=False)
    if not isinstance(value, (dict, list)) or len(flat) + indent <= 118:
        return flat
    pad = " " * (indent + 1)
    if isinstance(value, dict):
        items = [
            f"{pad}{json.dumps(k)}: {dump(v, indent + 1)}" for k, v in value.items()
        ]
        return "{\n" + ",\n".join(items) + "\n" + " " * indent + "}"
    return (
        "[\n"
        + ",\n".join(pad + dump(v, indent + 1) for v in value)
        + "\n"
        + " " * indent
        + "]"
    )


def main() -> None:
    chosen = sys.argv[1:] or list(MAKERS)
    if unknown := set(chosen) - set(MAKERS):
        sys.exit(f"unknown piece: {', '.join(sorted(unknown))}")
    index_path = PIECES / "Index.json"
    index = (
        {e["name"]: e for e in json.loads(index_path.read_text())}
        if index_path.exists()
        else {}
    )
    for name in chosen:
        project, listen = MAKERS[name]()
        audio = modsynth.render(modsynth.compile_image(project), rate=RATE)
        gain = round(PEAK / float(np.abs(audio).max()), 4)
        project["programs"][0]["timeline"]["master"]["gain"] = gain
        (PIECES / f"{name}.json").write_text(dump(project) + "\n")
        seconds = math.ceil(len(audio) / RATE * 4) / 4
        index[name] = {
            "name": name,
            "file": f"{name}.json",
            "seconds": seconds,
            "group": "pieces",
            "listen_for": listen,
        }
        print(f"{name}: {seconds} s, master gain {gain}")
    ordered = [index[name] for name in MAKERS if name in index]
    index_path.write_text(json.dumps(ordered, indent=1, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
