# /// script
# requires-python = ">=3.12,<3.14"
# dependencies = ["numpy", "modsynth"]
#
# [tool.uv.sources]
# modsynth = { path = "..", editable = false }
# ///
"""Writes examples/Pieces: public-domain pieces arranged for the engine, in the same form as the recipes.

The notes come from the Mutopia Project's editions, which their typesetters placed in the public domain, and everything
else is a performance made here: the tempo and its rubato, dynamics, pedalling, articulation and the mix. Bach's chorale
is copied from its LilyPond source below. The others are read from the MIDI files LilyPond wrote from theirs, in
examples/Pieces/Scores.

The pieces play the standard set's instruments and rooms, as a MIDI file does: each such patch is the graph
examples/Instruments has, exactly, so the library holds it as the set's own built-in patch. Two keep patches of their own:
the chorale's flugelhorn, which GM has no program for, and the Invention's console channels and small room, which are
what the board can play. The set plays every instrument at one loudness, so a piece of several instruments trims each
part's fader to keep the mix it was written with, and each send keeps the balance of wet and dry the piece had in a room
of its own. Each piece is rendered once to set its master gain, so its peak lands where the recipes' do.

    uv run examples/MakePieces.py                  # every piece
    uv run examples/MakePieces.py PassionChorale   # only these

It reads the set as examples/Instruments has it, so when the set changes, MakeInstruments.py runs first.

Sources, all at https://www.mutopiaproject.org/ftp/ and typeset by the Mutopia maintainers named:
    BachPreludeInC.mid    BachJS/BWV846/wtk1-prelude1/wtk1-prelude1.mid, Tobias Erbsland
    PassionChorale        BachJS/O_Haupt_voll_Blut/O_Haupt_voll_Blut.ly, dwb
    FurElise.mid          BeethovenLv/WoO59/fur_Elise_WoO59/fur_Elise_WoO59.mid, Stelios Samelis
    MountainKing.mid      GriegE/O46/Dans_l_antre_du_roi_de_la_montagne/Dans_l_antre_du_roi_de_la_montagne.mid, Coyau
    BachInventionInF.mid  BachJS/BWV779/bach-invention-08/bach-invention-08.mid, Allen Garvin, from the Bach-Gesellschaft
    Entertainer.mid       JoplinS/entertainer/entertainer.mid, Chris Sawer, from the original edition of 1902
Each of these editions is marked Public Domain on Mutopia, placed there by its typesetter.
"""

import functools
import itertools
import json
import math
import struct
import sys
from dataclasses import dataclass, replace
from pathlib import Path

import modsynth
import numpy as np
from Graph import Graph, dump
from MakeInstruments import read_set

HERE = Path(__file__).resolve().parent
PIECES = HERE / "Pieces"
SCORES = PIECES / "Scores"
INSTRUMENTS = HERE / "Instruments"
PPQ = 480
RATE = 48000
PEAK = 0.45  # Where every recipe's peak lands, so Listen.py's --gain means the same for all of them


# Patches ------------------------------------------------------------------------------------------------------------


@functools.cache
def standard_set() -> dict[str, dict]:
    """The standard set's patches as examples/Instruments has them, by name: each one's title and its graph, exactly, so
    that the library holds a piece's patch as the set's own, builtin-gm-<Name>, rather than as one of the piece's."""
    graphs = read_set()
    titles = {}
    for entry in json.loads((INSTRUMENTS / "Index.json").read_text()):
        for name, patch in json.loads((INSTRUMENTS / entry["file"]).read_text())[
            "patches"
        ].items():
            titles[name] = patch["name"]
    return {name: {"name": titles[name], "graph": graphs[name]} for name in graphs}


def brass(
    bright: float,
    floor: float,
    formant: float,
    vibrato: float,
    breath: float,
    attack: float,
) -> dict:
    """A brass voice: a saw through a filter that opens as it is blown harder, a soft clip that adds the brassy edge,
    a formant and breath, with its colour as arguments. The set's brass is this voice (examples/Sounds/Winds.py), and the
    chorale's flugelhorn, which GM has no program for, keeps it as the piece's own patch."""
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
    air = g.mul(
        g.filter("bandpass", g.node("noise"), 2600.0, 0.8),
        g.env(0.002, 0.08, 0.03, 0.05),
    )
    sound = g.mul(g.add(horn, g.mul(air, breath)), blow)
    g.out(g.mul(sound, g.mul(g.add(key.velocity, 0.45), 0.42)))
    return g.json()


def console(wave: str) -> dict:
    """One sound channel of an old games console, which is what a board can afford: a single naive oscillator and a
    plucked envelope that dies away faster in the treble, with no filter. Its track's fader sets its level, which costs
    nothing."""
    g = Graph()
    key = g.node("note")
    f = g.mtof(key.pitch)
    if wave == "square":
        tone = g.osc("square", f, mode="naive", width=0.3)
    else:
        tone = g.osc(wave, f)
    ring = g.env(0.001, g.keyed(key.pitch, 0.9), 0.15, 0.04)
    g.out(g.mul(tone, ring))
    return g.json()


def small_room(feedback: float, damp: float, wet: float) -> dict:
    """A mono room a board can hold: four of the Reverb recipe's combs and two of its allpasses, each line only as long
    as its delay, 31 KB in all, where each of the standard set's rooms takes 76 KB or more. It costs a sixth of a frame on
    the board."""
    g = Graph()
    source = g.node("in")
    mono = g.mul(g.add(source.l, source.r), 0.5)
    bank = None
    for seconds in (0.0297, 0.0371, 0.0411, 0.0437):
        comb = g.node(
            "comb",
            {"in": mono, "time": seconds, "feedback": feedback, "damp": damp},
            max=round(seconds + 0.0005, 4),
        )
        bank = comb if bank is None else g.add(bank, comb)
    for seconds in (0.0077, 0.0051):
        bank = g.node(
            "allpass",
            {"in": bank, "time": seconds, "feedback": 0.5},
            max=round(seconds + 0.0005, 4),
        )
    g.out(g.mul(bank, wet))
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

    def standard(self, name: str) -> str:
        """Adds the standard set's patch `name`, keyed and titled as the set has it, for a slot or an insert to play."""
        patch = standard_set()[name]
        return self.patch(name, patch["name"], patch["graph"])

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

    def project(
        self,
        id: str,
        name: str,
        gain: float = 1.0,
        meter: list[tuple[int, int, int]] | None = None,
        pickup: int = 0,
        key: list[tuple[int, int, bool]] | None = None,
    ) -> dict:
        """`meter` is (tick, beats, unit) changes and `key` (tick, fifths, minor) ones: where the editor draws bars and how
        it spells notes, which the compiler ignores. A piece that gives none is in 4/4 from its first tick, in C major."""
        timeline: dict = {"ppq": PPQ, "tempo": self.tempo.changes}
        if meter:
            timeline["meter"] = [
                {"tick": t, "beats": b, "unit": u} for t, b, u in meter
            ]
        if pickup:
            timeline["pickup"] = pickup
        if key:
            timeline["key"] = [
                {"tick": t, "fifths": f} | ({"minor": True} if minor else {})
                for t, f, minor in key
            ]
        timeline |= {
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
    harpsichord, room = song.standard("Harpsichord"), song.standard("LargeRoom")
    song.bus("room", room)
    song.track("Harpsichord", [harpsichord], played, voices=12, sends={"room": 0.54})
    listen = (
        "Bach's C major prelude on the standard set's two-choir harpsichord in a large room, each figure ringing on "
        "under the next, leaning into the bars where the harmony arrives and slowing into a rolled last chord."
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
    slots = {
        "Trumpet": song.standard("Trumpet"),
        "Flugelhorn": song.patch(
            "flugelhorn", "Flugelhorn", brass(1500, 420, 900, 0.06, 0.06, 0.05)
        ),
        "Horn": song.standard("FrenchHorn"),
        "Trombone": song.standard("Trombone"),
    }
    song.bus("hall", song.standard("MediumHall"))
    # The set plays its trumpet, horn and trombone about 12 dB under where the chorale's own did, and the flugelhorn, still
    # the piece's, is turned down as far, so the master gain makes the 12 dB up. Each part's trim, in dB, takes it the
    # rest of the way to where it sat in the mix, and its send gives it the balance of wet and dry it had in the church
    # the chorale had of its own, which the set's hall colours differently for each instrument. Both were measured with
    # each part alone, before and after.
    mix = {  # trim, send
        "Trumpet": (-0.7, 0.81),
        "Flugelhorn": (-12.0, 0.81),
        "Horn": (1.6, 0.97),
        "Trombone": (0.4, 0.92),
    }
    for name, (notes, pan) in parts.items():
        trim, send = mix[name]
        song.track(
            name,
            [slots[name]],
            shaped(notes),
            voices=3,
            gain=round(10 ** (trim / 20), 4),
            pan=pan,
            sends={"hall": send},
        )
    listen = (
        "Bach's Passion Chorale for the standard set's trumpet, French horn and trombone and a flugelhorn of its own, "
        "in a hall, every phrase slowing into its fermata and taking a breath, the repeat an echo of the first time."
    )
    # In F major, from a quarter's pickup.
    return song.project(
        "chorale", "O Haupt voll Blut und Wunden", pickup=PPQ, key=[(0, -1, False)]
    ), listen


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
    piano, tremolo = song.standard("ElectricPiano"), song.standard("Tremolo")
    song.bus("room", song.standard("LargeRoom"))
    # The pedal keeps every voice busy, so a new note takes one still ringing: fading it out spares a click.
    song.track(
        "Piano",
        [piano],
        notes,
        voices=24,
        sends={"room": 0.5},
        inserts=[tremolo],
        steal="fade",
    )
    listen = (
        "Für Elise on the standard set's tine electric piano, swaying between the speakers in a large room, pedalled "
        "bar by bar, broadening into each cadence, pressing on over the drumming bass and slowing down the chromatic "
        "scale."
    )
    return song.project(
        "elise", "Für Elise", meter=[(0, 3, 8)], pickup=pickup, key=[(0, 0, True)]
    ), listen


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
        parts.setdefault("Cymbal", []).append(Note(tick, PPQ, 49, vel))  # GM's crash
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
        "Bassoons": climb(theme, rising, 0.7, 1.0),
        "Pizzicato": climb(theme, building, 0.7, 1.0, 6),
        "Violins": climb(rising, stretto, 0.7, 1.0, 6),
        "Horns": climb(rising, stretto, 0.5, 1.0, 6),
    }
    names = ["call", "theme", "rising", "building", "stretto", "shrieks", "roll"]
    song = Song(
        tempo,
        [(name, start * bar) for name, start in zip(names, starts)],
        length,
    )
    # The set plays its instruments about 14 dB under where the piece's own did, which the master gain makes up. Each
    # part's trim, in dB, takes it the rest of the way to where it sat in the mix, and moves its fader lane with it. Its
    # send gives it the balance of wet and dry it had in the concert hall the piece had of its own, which the set's hall
    # colours differently for each instrument: the timpani's two notes ring in it more, and the pizzicato's less. Both
    # were measured with each part alone, before and after.
    seats = {  # patch, voices, gain, pan, send, trim
        "Bassoons": ("Bassoon", 4, 0.9, 0.1, 0.68, 1.9),
        "Pizzicato": ("PizzicatoStrings", 10, 0.55, 0.3, 0.73, 2.0),
        "Violins": ("StringEnsemble", 10, 0.8, -0.35, 0.66, 0.1),
        "Oboes": ("Oboe", 6, 0.35, -0.1, 0.64, 3.2),
        "Horns": ("FrenchHorn", 8, 0.8, 0.25, 0.7, 0.0),
        "Trumpets": ("Trumpet", 6, 0.6, 0.15, 0.58, -2.6),
        "Cellos and basses": ("StringEnsemble", 8, 0.7, 0.4, 0.61, 0.1),
        "Timpani": ("Timpani", 6, 0.7, 0.0, 0.47, -4.5),
        "Cymbal": ("KitCrash", 2, 0.5, -0.15, 0.85, -1.5),
    }
    for name, (patch, voices, gain, pan, send, trim) in seats.items():
        scale = 10 ** (trim / 20)
        lane = [(tick, round(value * scale, 4)) for tick, value in lanes.get(name, [])]
        song.track(
            name,
            [song.standard(patch)],
            parts[name],
            voices,
            round(gain * scale, 4),
            pan,
            {"hall": send},
            fader(lane) if lane else None,
        )
    song.bus("hall", song.standard("MediumHall"))
    listen = (
        "Grieg's trolls, orchestrated from the piano score for the standard set's orchestra in a concert hall: "
        "bassoons and pizzicato basses tiptoe through the theme, which climbs, gathers the orchestra and speeds up "
        "until the trolls shriek over the timpani."
    )
    return song.project(
        "king", "In the Hall of the Mountain King", key=[(0, 2, True)]
    ), listen


def invention() -> tuple[dict, str]:
    """Bach, Invention No. 8 in F major, BWV 779, on two channels of an old games console, sized so the NUCLEO-L476RG
    plays it, room and all."""
    bar = 3 * PPQ
    notes = read_midi(SCORES / "BachInventionInF.mid")
    length = 34 * bar
    right, left = 1, 2
    # It slows over the last two bars from 104 to 76 bpm. A tempo change can cut a frame in two, which the board's
    # bound counts for every track and voice, so the slowing is written into where the notes fall instead.
    start, span, fast, slow = 32 * bar, 2 * bar - PPQ, 104.0, 76.0
    k = (slow - fast) / span

    def warp(tick: int) -> int:
        x = tick - start
        if x <= 0:
            return tick
        bent = fast / k * math.log((fast + k * min(x, span)) / fast)
        return start + round(bent + max(0, x - span) * fast / slow)

    played = []
    for n in notes:
        # Every note a little short of its value, so the one voice a hand has has let it go before the next takes it.
        end = n.tick + max(30, n.dur * 3 // 4)
        played.append(
            replace(n, tick=warp(n.tick), dur=warp(end) - warp(n.tick), vel=100)
        )
    # The last chord is broken, its third and then its root, and leaves out its fifth: one voice a hand can't hold more.
    last = sorted(
        (n for n in played if n.part == right and n.tick == warp(33 * bar)),
        key=lambda n: n.pitch,
    )
    played.remove(last[1])
    last[0].dur = PPQ // 4
    last[2].tick += PPQ // 4
    last[2].dur -= PPQ // 4
    length = warp(length)

    tempo = Tempo(104)

    song = Song(tempo, [("invention", 0)], length)
    song.patch("pulse", "Pulse channel", console("square"))
    song.patch("triangle", "Triangle channel", console("triangle"))
    song.patch("room", "Small room", small_room(0.78, 0.4, 0.2))
    song.bus("room", "room")
    for name, part, patch, voices, gain, pan in (
        ("Right hand", right, "pulse", 1, 0.22, 0.3),
        ("Left hand", left, "triangle", 1, 0.45, -0.3),
    ):
        song.track(
            name,
            [patch],
            [n for n in played if n.part == part],
            voices=voices,
            gain=gain,
            pan=pan,
            sends={"room": 0.35},
        )
    listen = (
        "Bach's two-part invention in F as an old games console would play it, a pulse wave for the right hand and a "
        "triangle for the left, chasing each other across the speakers in a small room: a whole piece the NUCLEO-L476RG "
        "plays."
    )
    return song.project(
        "invention", "Invention No. 8", meter=[(0, 3, 4)], key=[(0, -1, False)]
    ), listen


def entertainer() -> tuple[dict, str]:
    """Joplin, The Entertainer, on an old upright piano."""
    bar = 2 * PPQ
    printed = read_midi(SCORES / "Entertainer.mid")
    # LilyPond unfolded every repeat: an introduction of 4 bars, then A twice, B twice, A, C twice, 4 bars back to C major,
    # and D twice, 152 bars. This plays C once, its second time, which leads on, and the repeat of B an octave up, as
    # marked.
    cut = (84 * bar, 100 * bar)
    notes = []
    for n in printed:
        if cut[0] <= n.tick < cut[1]:
            continue
        shift = cut[1] - cut[0] if n.tick >= cut[1] else 0
        up = 12 if n.part == 1 and 52 * bar <= n.tick < 67 * bar else 0
        notes.append(replace(n, tick=n.tick - shift, pitch=n.pitch + up))
    intro, a1, b1, b2, a3 = 0, 4 * bar, 36 * bar, 52 * bar, 68 * bar
    c, link, d1, d2 = 84 * bar, 100 * bar, 104 * bar, 120 * bar
    length = 136 * bar
    right, left = 1, 2

    # Each strain at its own level, and the bass stronger than the chords it answers.
    dynamic = [(intro, 92), (a1, 74), (b1 - bar, 74), (b1, 88), (b2, 94), (a3, 76)]
    dynamic += [
        (c, 66),
        (link, 70),
        (d1, 84),
        (d2, 90),
        (length - 4 * bar, 92),
        (length, 100),
    ]
    bass = {}
    for n in notes:
        if n.part == left:
            bass[n.tick] = min(bass.get(n.tick, 127), n.pitch)
    for n in notes:
        level = curve(dynamic, n.tick)
        if n.part == left:
            level += 6 if n.pitch == bass[n.tick] and n.tick % PPQ == 0 else -6
        else:
            level += (
                3 if n.tick % (PPQ // 2) != 0 else 0
            )  # The syncopations, which the tune leans on
        n.vel = velocity(level + wobble(n.tick, n.pitch))
    notes = cut_restrikes(notes)

    tempo = Tempo(88)
    # Not fast, and steady, as Joplin asked, with a breath before the tune comes back and a slower last two bars.
    tempo.glide(a1 - bar // 2, a1, 88, 80)
    tempo.at(a1, 88)
    tempo.glide(a3 - bar, a3, 88, 78)
    tempo.at(a3, 88)
    tempo.glide(d1 - bar, d1, 88, 82)
    tempo.at(d1, 88)
    tempo.glide(length - 2 * bar, length - PPQ // 2, 88, 60)

    sections = [
        ("intro", intro),
        ("a", a1),
        ("b", b1),
        ("b-high", b2),
        ("a-return", a3),
    ]
    sections += [("c", c), ("link", link), ("d", d1), ("d-again", d2)]
    song = Song(tempo, sections, length)
    piano = song.standard("HonkyTonkPiano")
    song.bus("room", song.standard("LargeRoom"))
    for name, part, voices, pan in (
        ("Right hand", right, 12, 0.12),
        ("Left hand", left, 10, -0.12),
    ):
        song.track(
            name,
            [piano],
            [n for n in notes if n.part == part],
            voices=voices,
            pan=pan,
            sends={"room": 0.34},
            steal="fade",
        )
    listen = (
        "Joplin's rag on the standard set's honky-tonk piano, an old upright whose unisons have drifted apart, in a "
        "large room, not fast and steady as he asked, its bass striding under the syncopated tune, the second time "
        "through the B strain an octave up, as marked."
    )
    # In C, with the trio in F, as the score has it.
    keys = [(0, 0, False), (c, -1, False), (link, 0, False)]
    return song.project(
        "entertainer", "The Entertainer", meter=[(0, 2, 4)], key=keys
    ), listen


MAKERS = {
    "BachPreludeInC": prelude,
    "PassionChorale": chorale,
    "FurElise": elise,
    "HallOfTheMountainKing": king,
    "BachInventionInF": invention,
    "TheEntertainer": entertainer,
}


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
