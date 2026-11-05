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


def unfold(
    printed: list[Note], order: list[tuple[int, int]]
) -> tuple[list[Note], list[int]]:
    """A score as it is played: the notes of each span of the printed score, from tick a up to b, one span after another,
    so a strain printed once between repeat signs plays twice with its endings between. Returns the notes and where each
    span starts."""
    notes, cursor, starts = [], 0, []
    for a, b in order:
        starts.append(cursor)
        notes += [
            replace(n, tick=n.tick - a + cursor) for n in printed if a <= n.tick < b
        ]
        cursor += b - a
    return notes, starts


def swing(tick: int, amount: float, beat: int = PPQ) -> int:
    """Where a tick falls when each beat's two halves are played long and short, the first taking `amount` of the beat:
    a half is straight, and two thirds a triplet's lilt. A tick inside a half moves with it."""
    k, at = divmod(tick, beat)
    half, split = beat // 2, round(beat * amount)
    if at < half:
        return k * beat + round(at * split / half)
    return k * beat + split + round((at - half) * (beat - split) / (beat - half))


def swung(notes: list[Note], amount: float, beat: int = PPQ) -> list[Note]:
    """The notes with their starts and ends swung."""
    return [
        replace(
            n,
            tick=swing(n.tick, amount, beat),
            dur=max(1, swing(n.end, amount, beat) - swing(n.tick, amount, beat)),
        )
        for n in notes
    ]


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

    def bus(
        self,
        key: str,
        insert: str | list[str | dict],
        gain: float = 1.0,
        output: str | None = None,
        first_id: int | None = None,
    ) -> None:
        """A bus playing its inserts in order. One insert is numbered 100 on from the buses before it; several start at
        `first_id`. An insert given as a dict brings its own fields, such as a sidechain's `key`."""
        if isinstance(insert, str):
            inserts = [{"id": 100 + len(self.buses), "patch": insert}]
        else:
            inserts = [
                {"id": first_id + i} | ({"patch": p} if isinstance(p, str) else p)
                for i, p in enumerate(insert)
            ]
        self.buses.append(
            {"id": key, "gain": gain, "inserts": inserts}
            | ({"output": output} if output else {})
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
        inserts: list[str | dict] | None = None,
        slot_of=None,
        steal: str = "cut",
        kit: list[dict] | None = None,
        play: dict | None = None,
        output: str | None = None,
    ) -> int:
        """Adds a track whose notes and lanes are cut into one clip per section they fall in. A lane moves the track's
        fader unless it names a `param` of the track's patch or a `target` of its own. An insert given as a dict brings
        its own fields, such as a sidechain's `key`. `kit` names a drum track's keys and the slot each plays, for the
        editor, and `play` is the track's play mode."""
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
                own = "param" in lane or "target" in lane
                clip["automation"].append(
                    ({} if own else {"target": {"mix": "fader", "track": id}})
                    | {k: v for k, v in lane.items() if own or k != "target"}
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
                    {"id": 50 + id * 4 + i}
                    | ({"patch": p} if isinstance(p, str) else p)
                    for i, p in enumerate(inserts or [])
                ],
            }
            | ({"steal": steal} if steal != "cut" else {})
            | ({"kit": kit} if kit else {})
            | ({"play": play} if play else {})
            | ({"output": output} if output else {})
        )
        return id

    def insert_id(self, track: int, index: int = 0) -> int:
        """The id `track` gives its insert at `index`, for a lane that targets it."""
        return 50 + track * 4 + index

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
        ids = [i["id"] for chain in self.tracks + self.buses for i in chain["inserts"]]
        assert len(ids) == len(set(ids)), f"two inserts share an id in {ids}"
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


def strum(
    tick: int, pitches: list[int], dur: int, vel: int, spread: int, up: bool = False
) -> list[Note]:
    """A chord strummed across its strings, `spread` ticks apart, down from the lowest or up from the highest, each
    string a little softer than the one before."""
    order = sorted(pitches, reverse=up)
    return [
        Note(tick + i * spread, max(1, dur - i * spread), p, velocity(vel - 2 * i))
        for i, p in enumerate(order)
    ]


def chords_of(notes: list[Note], step: int) -> dict[int, int]:
    """The root of the chord a chord track holds at every `step`, as the pitch class of its lowest note, by tick."""
    roots: dict[int, int] = {}
    for n in notes:
        for tick in range(n.tick, n.end, step):
            roots[tick] = min(roots.get(tick, 127), n.pitch)
    return {tick: pitch % 12 for tick, pitch in roots.items()}


def soldiers_joy() -> tuple[dict, str]:
    """Traditional, Soldier's Joy, for an old-time string band: fiddle, banjo, guitar and bass."""
    q, bar = PPQ, 4 * PPQ
    printed = read_midi(SCORES / "SoldiersJoy.mid")
    tune, harmony = 1, 2  # The edition's fiddle line and its chords, a chord a beat
    # The edition prints each strain once between repeat signs, with both endings after it, from a pickup of a beat.
    pickup, a, a1, a2 = (0, q), (q, 29 * q), (29 * q, 33 * q), (33 * q, 37 * q)
    b, b1, b2 = (37 * q, 65 * q), (65 * q, 69 * q), (69 * q, 73 * q)
    # Played three times through, AABB, as a dance band does. Between times B ends as A's first ending does, on D with
    # the pickup back into A, and only the last time with the edition's last bar.
    strains = [a, a1, a, a2, b, b1, b]
    order = [pickup] + strains + [a1] + strains + [a1] + strains + [b2]
    played, starts = unfold(printed, order)
    # The fiddle kicks off with three beats on its open D and A strings, and the pickup is the fourth.
    played = [replace(n, tick=n.tick + 3 * q) for n in played]
    starts = [s + 3 * q for s in starts]
    times = [
        starts[1],
        starts[9],
        starts[17],
    ]  # Where each time through begins, on its first A
    length = starts[-1] + 3 * q + bar
    melody = [n for n in played if n.part == tune]
    root = chords_of([n for n in played if n.part == harmony], q)
    root[length - bar] = 2  # The last chord is D, held
    D, G, A = 2, 7, 9
    which = lambda tick: (
        max(i for i, t in enumerate(times) if t <= tick) if tick >= times[0] else -1
    )

    def accent(tick: int) -> int:
        # The bow leans on the backbeat, as an old-time fiddler's does, and the off-beat eighths are lighter.
        at = (tick % bar) % (2 * q)
        return 6 if at == q else 2 if at == 0 else -5

    parts: dict[str, list[Note]] = {
        name: [] for name in ("Fiddle", "Banjo", "Guitar", "Bass")
    }
    # The kick-off: three beats on the open strings, then the pickup.
    for beat in range(3):
        for p in (62, 69):
            parts["Fiddle"].append(Note(beat * q, q - 40, p, 84 if beat != 1 else 90))
    for n in melody:
        time = which(n.tick)
        if time == 1:
            continue  # The banjo has the tune the second time
        level = (80, 0, 90)[max(time, 0)] if time >= 0 else 82
        dur = n.dur - (n.dur // 10 if n.dur < q else n.dur // 6)
        parts["Fiddle"].append(
            Note(
                n.tick,
                dur,
                n.pitch,
                velocity(level + accent(n.tick) + wobble(n.tick, n.pitch)),
            )
        )
        # The last time, the open string under the long notes rings with them.
        if time == 2 and n.dur >= q and n.tick < length - bar:
            drone = 74 if root.get(n.tick) == G and n.pitch >= 76 else 69
            if n.pitch > drone:
                parts["Fiddle"].append(Note(n.tick, dur, drone, velocity(level - 12)))
    # The second time the fiddle backs the banjo: double stops on the chord in its shuffle, long, short, short.
    stops = {D: (62, 69), G: (59, 67), A: (64, 69)}
    for tick in range(times[1], times[2], 2 * q):
        for at, dur, lift in (
            (0, q - 30, 0),
            (q, q // 2 - 30, -8),
            (q + q // 2, q // 2 - 30, -4),
        ):
            for p in stops[root[tick + at - (tick + at) % q]]:
                parts["Fiddle"].append(
                    Note(tick + at, dur, p, velocity(56 + lift + accent(tick + at)))
                )

    # Banjo: the tune itself the second time, and otherwise clawhammer's bum-ditty, a melody note on the beat, a brush
    # across the strings and the thumb on the high fifth string, each half bar. It joins when A repeats.
    brush = {D: (62, 66, 69), G: (62, 67, 71), A: (61, 64, 69)}
    at_tick = {n.tick: n for n in melody}
    for n in melody:
        if which(n.tick) == 1:
            parts["Banjo"].append(
                Note(
                    n.tick,
                    n.dur + q // 2,
                    n.pitch,
                    velocity(94 + accent(n.tick) + wobble(n.tick, n.pitch)),
                )
            )
    for tick in range(starts[3], length - bar, 2 * q):
        if which(tick) == 1:
            continue
        sounding = max((n for n in melody if n.tick <= tick), key=lambda n: n.tick)
        note = at_tick.get(tick, sounding)
        parts["Banjo"].append(
            Note(tick, q + q // 2, note.pitch, velocity(72 + wobble(tick, 7)))
        )
        chord = brush[root[tick + q]]
        parts["Banjo"] += strum(tick + q, list(chord), q // 2 + 40, 54, 10)
        parts["Banjo"].append(
            Note(tick + q + q // 2, q // 2 + 60, 69, velocity(58 + wobble(tick, 9)))
        )
    parts["Banjo"] += strum(length - bar, [50, 57, 62, 66, 69], bar, 84, 14)

    # Guitar: boom-chuck, the bass note on the beat, alternating root and fifth, and a strum on the backbeat. Bass: the
    # root and the fifth, on the beat, under the guitar's.
    shapes = {D: [50, 57, 62, 66], G: [55, 59, 62, 67], A: [57, 61, 64, 69]}
    booms = {D: (50, 45), G: (43, 50), A: (45, 40)}
    lows = {D: (38, 33), G: (31, 38), A: (33, 40)}
    for tick in range(bar, length - bar, q):
        beat = (tick // q) % 4
        chord = root[tick]
        if beat % 2 == 0:
            boom = booms[chord][beat // 2]
            parts["Guitar"].append(
                Note(tick, q - 60, boom, velocity(78 + wobble(tick, boom)))
            )
            parts["Bass"].append(
                Note(
                    tick,
                    q + q // 2,
                    lows[chord][beat // 2],
                    velocity(86 + wobble(tick, 3)),
                )
            )
        else:
            parts["Guitar"] += strum(
                tick, shapes[chord], q // 2, 70 + wobble(tick, 5), 12
            )
    last = length - bar
    parts["Guitar"] += strum(last, [38, 45, 50, 57, 62, 66], bar, 88, 16)
    parts["Bass"].append(Note(last, bar - q, 38, 96))
    swing_of = {"Fiddle": 0.56, "Banjo": 0.56, "Guitar": 0.5, "Bass": 0.5}

    tempo = Tempo(216)  # A dance's pace: 108 half notes a minute
    tempo.glide(last - 2 * q, last, 216, 176)
    tempo.at(last, 176)
    sections = [("kickoff", 0)]
    for i, start in enumerate(times):
        sections += [(f"a{i + 1}", start), (f"b{i + 1}", starts[1 + 8 * i + 4])]
    song = Song(tempo, sections, length)
    song.bus("room", song.standard("MediumRoom"))
    seats = {  # patch, voices, gain, pan, send
        "Fiddle": ("Fiddle", 6, 1.0, -0.2, 0.3),
        "Banjo": ("Banjo", 12, 0.8, 0.35, 0.22),
        "Guitar": ("SteelGuitar", 10, 0.55, -0.45, 0.25),
        "Bass": ("AcousticBass", 2, 0.95, 0.05, 0.15),
    }
    for name, (patch, voices, gain, pan, send) in seats.items():
        song.track(
            name,
            [song.standard(patch)],
            swung(sorted(parts[name], key=lambda n: (n.tick, n.pitch)), swing_of[name]),
            voices,
            gain,
            pan,
            {"room": send},
            steal="fade",
        )
    listen = (
        "A fiddle tune as an old-time string band plays it for a dance, three times through: the fiddle kicks off and "
        "leads, the banjo takes the tune the second time while the fiddle shuffles chords behind it, and the guitar's "
        "boom-chuck and the bass keep the beat."
    )
    return song.project(
        "soldiers-joy", "Soldier's Joy", meter=[(0, 2, 2)], key=[(0, 2, False)]
    ), listen


def kappore() -> tuple[dict, str]:
    """Traditional, Kappore, a street dancer's song from Edo, for shakuhachi, koto, a bamboo flute and festival drums."""
    q, bar = PPQ, 2 * PPQ
    printed = read_midi(SCORES / "Kappore.mid")
    # The edition: a four-bar introduction between repeat signs, then the song, 64 bars of 2/4 ending on a held A.
    intro, verse = (0, 4 * bar), (4 * bar, 68 * bar)
    lead = bar  # A bar for the clappers before anything plays
    order = [intro, intro, verse, intro, verse, intro]
    played, starts = unfold(printed, order)
    played = [replace(n, tick=n.tick + lead) for n in played]
    starts = [s + lead for s in starts]
    first, second, v1, between, v2, coda = starts
    end = (
        coda + 4 * bar
    )  # The last note, the introduction's A, is held into a bar of its own
    length = end + 2 * bar
    within = lambda span, n: (
        span <= n.tick < span + (128 * q if span in (v1, v2) else 4 * bar)
    )
    parts: dict[str, list[Note]] = {
        name: [] for name in ("Shakuhachi", "Koto", "Flute", "Taiko", "Percussion")
    }

    def shape(n: Note, level: float) -> int:
        # A phrase swells as it climbs, and the notes on the beat are leant on.
        return velocity(
            level
            + (n.pitch - 69) * 0.6
            + (4 if n.tick % q == 0 else -2)
            + wobble(n.tick, n.pitch)
        )

    def blown(n: Note) -> int:
        # Each note is tongued apart from the next, and a long one held to its end.
        return n.dur - 40 if n.dur < 2 * q else n.dur - 20

    tuning = [
        57,
        59,
        62,
        64,
        66,
        69,
        71,
        74,
        76,
        78,
        81,
    ]  # A koto tuned to the song's scale, A B D E F sharp

    def sweep(at: int, down: bool = False) -> None:
        # Sararin: a pick swept across every string, ending on the beat.
        strings = tuning[::-1] if down else tuning
        for i, p in enumerate(strings):
            parts["Koto"].append(
                Note(at - (len(strings) - i) * 22, q, p, velocity(48 + 3 * i))
            )

    for n in played:
        last = n.tick >= coda and n.tick == max(m.tick for m in played)
        if within(first, n):  # The koto alone, then with the shakuhachi
            parts["Koto"].append(Note(n.tick, n.dur + q // 2, n.pitch, shape(n, 76)))
            if n.dur >= q:
                parts["Koto"].append(
                    Note(n.tick, n.dur + q // 2, n.pitch - 12, shape(n, 66))
                )
        elif within(second, n) or within(coda, n):
            loud = 80 if within(second, n) else 94
            parts["Shakuhachi"].append(Note(n.tick, blown(n), n.pitch, shape(n, loud)))
            parts["Koto"].append(
                Note(n.tick, n.dur + q // 2, n.pitch - 12, shape(n, loud - 12))
            )
            if within(coda, n):
                parts["Flute"].append(
                    Note(n.tick, blown(n), n.pitch + 12, shape(n, 84))
                )
        elif within(between, n):  # The flute and the koto, as the drums come in
            parts["Flute"].append(Note(n.tick, blown(n), n.pitch + 12, shape(n, 80)))
            parts["Koto"].append(Note(n.tick, n.dur + q // 2, n.pitch, shape(n, 78)))
        else:  # A verse: the shakuhachi sings it, and the koto follows it an octave down, on the beat
            again = n.tick >= v2
            parts["Shakuhachi"].append(
                Note(n.tick, blown(n), n.pitch, shape(n, 90 if again else 78))
            )
            if again:
                parts["Flute"].append(
                    Note(n.tick, blown(n), n.pitch + 12, shape(n, 78))
                )
            if n.tick % q == 0:
                low = n.pitch - 12 if n.pitch >= 64 else n.pitch
                parts["Koto"].append(
                    Note(
                        n.tick,
                        max(n.dur, q) + q // 2,
                        low,
                        shape(n, 72 if again else 66),
                    )
                )
                if n.dur >= 2 * q:  # Awasezume: a long note plucked in octaves
                    parts["Koto"].append(
                        Note(n.tick + 12, max(n.dur, q), low + 12, shape(n, 62))
                    )
        if last:
            for name, shift in (("Shakuhachi", 0), ("Flute", 12), ("Koto", -12)):
                parts[name] = [m for m in parts[name] if m.tick != n.tick]
                parts[name].append(
                    Note(n.tick, end - n.tick + bar, n.pitch + shift, 96)
                )
            parts["Koto"].append(Note(n.tick + 14, end - n.tick + bar, n.pitch, 90))
    sweep(first)
    sweep(v2, down=True)
    sweep(coda)

    # The drums: a taiko's don and doko under the second verse and the coda, with its rim's ka, and a kane, the small
    # gong a festival band keeps time on, chan-chiki on every beat. Every eighth bar the taiko fills.
    WOOD, KANE, RIM = 76, 67, 37

    def taiko(at: int, pitch: int, vel: float) -> None:
        parts["Taiko"].append(Note(at, q, pitch, velocity(vel + wobble(at, pitch))))

    def hit(at: int, key: int, vel: float) -> None:
        parts["Percussion"].append(
            Note(at, q // 4, key, velocity(vel + wobble(at, key)))
        )

    for k in range(3):  # The interlude: a stroke a bar, and a roll into the verse
        taiko(between + k * bar, 45, 84 + 6 * k)
    for i in range(8):
        taiko(between + 3 * bar + i * q // 4, 47 if i % 2 else 45, 64 + 5 * i)
    for start in range(v2, end, bar):
        k = (start - v2) // bar
        if k % 8 == 7 or start >= end - bar:
            for i in range(8):
                taiko(start + i * q // 4, 47 if i % 2 else 45, 72 + 4 * i)
        else:
            taiko(start, 45, 104 if k % 2 == 0 else 96)
            taiko(start + q, 45, 86)
            taiko(start + q + q // 2, 47, 72)
            taiko(start + q + 3 * q // 4, 47, 66)
            hit(start + q // 2, RIM, 58)
        for beat in (0, q):
            hit(start + beat, KANE, 72)
            hit(start + beat + q // 2, KANE, 54)
            hit(start + beat + 3 * q // 4, KANE, 60)
    taiko(end, 43, 112)
    taiko(end + bar - q // 2, 43, 104)
    # The clappers, hyoshigi: two strokes to begin, two before the drums come in, and the last strokes quickening.
    for at in (0, q):
        hit(at, WOOD, 86)
    for at in (between - bar, between - q):
        hit(at, WOOD, 80)
    for i, at in enumerate((0, 340, 600, 790, 920, 1010, 1070, 1110)):
        hit(end + bar + at, WOOD, 100 - 2 * i)
    length = end + bar + 1110 + 2 * bar

    # The shakuhachi gives a long note more breath as it holds it.
    lanes = []
    for n in parts["Shakuhachi"]:
        if n.dur >= 2 * q - 40 and n.tick < end:
            lanes += [
                {"param": 4, "tick": n.tick, "value": 0.0},
                {
                    "param": 4,
                    "tick": n.tick + q // 4,
                    "value": 0.7,
                    "ramp": n.dur - q // 2,
                },
                {"param": 4, "tick": n.end, "value": 0.0},
            ]

    tempo = Tempo(92)
    tempo.glide(v1 + 62 * bar, v1 + 63 * bar, 92, 70)  # Into the verse's held A
    tempo.at(v1 + 63 * bar, 60)
    tempo.at(between, 100)
    tempo.glide(v2, v2 + 48 * bar, 104, 116)  # The second verse presses on
    tempo.at(v2 + 48 * bar, 116)
    tempo.glide(end - bar, end, 116, 72)
    tempo.at(end, 72)
    sections = [
        ("intro", 0),
        ("verse", v1),
        ("interlude", between),
        ("verse-again", v2),
        ("coda", coda),
    ]
    song = Song(tempo, sections, length)
    song.bus("room", song.standard("LargeRoom"))
    kit = [
        {"note": WOOD, "name": "Hyoshigi (Hi Wood Block)", "slot": 0},
        {"note": KANE, "name": "Kane (High Agogo)", "slot": 1},
        {"note": RIM, "name": "Taiko rim (Side Stick)", "slot": 2},
    ]
    slot = {WOOD: 0, KANE: 1, RIM: 2}
    seats = {  # patches, voices, gain, pan, send
        "Shakuhachi": (["Shakuhachi"], 3, 1.0, -0.15, 0.34),
        "Koto": (["Koto"], 16, 0.95, 0.3, 0.3),
        "Flute": (["Flute"], 3, 0.9, -0.4, 0.3),
        "Taiko": (["Taiko"], 6, 0.5, 0.05, 0.28),
        "Percussion": (
            ["KitWoodBlock", "KitAgogo", "KitSideStick"],
            6,
            1.5,
            0.25,
            0.22,
        ),
    }
    for name, (patches, voices, gain, pan, send) in seats.items():
        song.track(
            name,
            [song.standard(p) for p in patches],
            sorted(parts[name], key=lambda n: (n.tick, n.pitch)),
            voices,
            gain,
            pan,
            {"room": send},
            lanes=lanes if name == "Shakuhachi" else None,
            slot_of=(lambda n: slot[n.pitch]) if name == "Percussion" else None,
            steal="fade",
            kit=kit if name == "Percussion" else None,
        )
    listen = (
        "A street dancer's song from Edo for the standard set's shakuhachi and koto, the koto following the tune an "
        "octave down: the first verse unhurried, the second pressing on with a bamboo flute above, taiko and the kane's "
        "chan-chiki, and the clappers quickening at the end."
    )
    return song.project(
        "kappore", "Kappore", meter=[(0, 2, 4)], key=[(0, 1, False)]
    ), listen


def harmony_above(pitch: int, chord: set[int], top: int) -> int:
    """The nearest note of the chord a third to a sixth above `pitch`, as a second part sings over a tune, or the
    octave if the chord has none there. Below `top`, or the part drops an octave."""
    for p in range(pitch + 3, pitch + 10):
        if p % 12 in chord:
            return p if p <= top else p - 12
    return pitch + 12 if pitch + 12 <= top else pitch


def led(previous: int, chord: set[int], low: int, high: int) -> int:
    """The chord's note between `low` and `high` nearest the one before, so an inner part moves as little as it can."""
    candidates = [p for p in range(low, high + 1) if p % 12 in chord]
    return min(candidates, key=lambda p: (abs(p - previous), p))


def maple_leaf() -> tuple[dict, str]:
    """Joplin, Maple Leaf Rag, as a New Orleans band plays it: cornet, clarinet, trombone, banjo, tuba and drums, swung."""
    q, bar = PPQ, 2 * PPQ
    printed = read_midi(SCORES / "MapleLeafRag.mid")
    right, left = 1, 2
    # LilyPond unfolded the repeats, AABBACCDD, from a pickup of an eighth. The band plays B once, with its second
    # ending, and the rest as written.
    p0 = q // 2
    s = lambda k: p0 + k * 16 * bar
    order = [(0, p0), (s(0), s(1)), (s(1), s(2)), (s(2), s(2) + 15 * bar)]
    order += [(s(4) - bar, s(4)), (s(4), s(5)), (s(5), s(6)), (s(6), s(7))]
    order += [(s(7), s(8)), (s(8), s(9))]
    played, starts = unfold(printed, order)
    a1, a2, b, _, a3, c1, c2, d1, d2 = starts[1:]
    end = d2 + 16 * bar
    last = end - q  # The last chord, on the last bar's second beat
    length = end + bar
    strain = lambda tick: max(
        i for i, t in enumerate((0, a1, a2, b, a3, c1, c2, d1, d2)) if t <= tick
    )
    names = ["pickup", "a", "a-clarinet", "b", "a-stop", "c-piano", "c", "d", "d-out"]
    role = lambda tick: names[strain(tick)]
    ensemble = {"pickup", "a", "b", "c", "d", "d-out"}
    level = {
        "pickup": 88,
        "a": 88,
        "a-clarinet": 82,
        "b": 92,
        "a-stop": 90,
        "c-piano": 80,
        "c": 90,
        "d": 94,
        "d-out": 102,
    }

    # What sounds at each eighth: the left hand's harmony, its bass on the beat, and the right hand's top note.
    chord_at: dict[int, set[int]] = {}
    bass_at: dict[int, int] = {}
    for n in played:
        if n.part == left:
            for tick in range(n.tick - n.tick % (q // 2), n.end, q // 2):
                chord_at.setdefault(tick, set()).add(n.pitch % 12)
            if n.tick % q == p0 % q or n.tick % (q // 2) == 0:
                bass_at[n.tick] = min(bass_at.get(n.tick, 127), n.pitch)
    chord = lambda tick: (
        chord_at.get(tick - tick % (q // 2))
        or chord_at.get(tick - tick % (q // 2) - q // 2, {8, 0, 3})
    )
    tops: dict[int, Note] = {}
    for n in played:
        if n.part == right and (n.tick not in tops or n.pitch > tops[n.tick].pitch):
            tops[n.tick] = n

    def lean(tick: int) -> int:
        # A rag leans on its syncopations, the notes that fall between the eighths.
        return 5 if tick % (q // 2) else 0

    parts: dict[str, list[Note]] = {
        name: []
        for name in (
            "Cornet",
            "Clarinet",
            "Trombone",
            "Tuba",
            "Banjo",
            "Piano",
            "Drums",
        )
    }
    for tick, n in sorted(tops.items()):
        r = role(tick)
        vel = level[r] + lean(tick) + wobble(tick, n.pitch)
        dur = max(40, min(n.dur, q) - 30)
        if r in ensemble or r == "a-stop":
            parts["Cornet"].append(Note(tick, dur, n.pitch, velocity(vel)))
        if r in ensemble:
            parts["Clarinet"].append(
                Note(
                    tick,
                    dur,
                    harmony_above(n.pitch, chord(tick), 91),
                    velocity(vel - 8),
                )
            )
        elif r == "a-clarinet":
            parts["Clarinet"].append(Note(tick, dur, n.pitch, velocity(vel + 2)))
    for n in played:
        if role(n.tick) == "c-piano":
            parts["Piano"].append(
                Note(
                    n.tick,
                    n.dur,
                    n.pitch,
                    velocity(
                        level["c-piano"]
                        + lean(n.tick)
                        + (-8 if n.part == left else 0)
                        + wobble(n.tick, n.pitch)
                    ),
                )
            )

    # The rhythm: tuba on the beat, the banjo four to the bar, the drums' bass drum on the beat and snare between. In the
    # stop-time strain they all play only the first beat of every other bar, under the cornet, until the last two bars.
    def stopped(tick: int) -> bool:
        return (
            role(tick) == "a-stop"
            and tick < a3 + 14 * bar
            and ((tick - a3) % (2 * bar) != 0)
        )

    KICK, SNARE, CRASH, WOOD = 36, 38, 49, 76
    trombone = 56
    parts["Tuba"].append(
        Note(0, q // 2 - 40, 39, velocity(level["pickup"]))
    )  # The pickup's E flat
    for tick in range(p0, last, q // 2):
        r = role(tick)
        if stopped(tick):
            continue
        harmony = chord(tick)
        beat = (tick - p0) % q == 0
        if beat:
            low = bass_at.get(tick) or min(
                (p for p in range(32, 52) if p % 12 in harmony), default=44
            )
            low = (
                low - 12 if low > 46 else low
            )  # The left hand's chord, when it has no octave, from its root down
            parts["Tuba"].append(
                Note(tick, q - 80, low, velocity(level[r] - 2 + wobble(tick, low)))
            )
            parts["Drums"].append(Note(tick, q // 4, KICK, velocity(level[r] - 18)))
            if r == "a-stop" and tick < a3 + 14 * bar:
                parts["Drums"].append(
                    Note(tick, q // 4, CRASH, velocity(level[r] - 6))
                )  # Each stop, choked
            # The trombone moves through the harmony a beat at a time, as little as it can, under the tune.
            if r in ensemble and r != "pickup":
                trombone = led(trombone, harmony, 46, 63)
                parts["Trombone"].append(
                    Note(
                        tick,
                        q - 40,
                        trombone,
                        velocity(level[r] - 10 + wobble(tick, trombone)),
                    )
                )
        if r != "c-piano" and r != "pickup":
            voicing = sorted({led(p, harmony, 55, 69) for p in (55, 60, 64, 68)})
            parts["Banjo"] += strum(
                tick, voicing, q // 2 - 30, (58 if beat else 66) + wobble(tick, 2), 8
            )
        if not beat and r != "pickup":
            parts["Drums"].append(
                Note(
                    tick,
                    q // 4,
                    SNARE if r in ensemble else WOOD,
                    velocity(level[r] - (24 if r in ensemble else 20)),
                )
            )
    # Merge the trombone's repeated notes into held ones.
    held: list[Note] = []
    for n in parts["Trombone"]:
        if held and held[-1].pitch == n.pitch and held[-1].end + 40 >= n.tick:
            held[-1].dur = n.end - held[-1].tick
        else:
            held.append(n)
    parts["Trombone"] = held
    # A crash where the band comes back in, and on the last chord, which everyone holds.
    for tick in (b, c2, d2):
        parts["Drums"].append(Note(tick, q, CRASH, 92))
    for name in ("Cornet", "Clarinet", "Trombone", "Tuba", "Banjo"):
        parts[name] = [
            replace(n, dur=bar) if n.tick >= last else n for n in parts[name]
        ]
    parts["Trombone"].append(Note(last, bar, 56, 100))
    parts["Tuba"].append(Note(last, bar, 32, 104))
    parts["Banjo"] += strum(last, [56, 60, 63, 68], bar, 90, 14)
    parts["Drums"] += [Note(last, q // 2, KICK, 100), Note(last, bar, CRASH, 104)]

    # The trombone smears up into each strain the band plays together.
    lanes = []
    for start in (a1, b, c2, d1, d2):
        lanes += [
            {"param": 1, "tick": start, "value": -2.0},
            {"param": 1, "tick": start, "value": 0.0, "ramp": q // 2},
        ]

    # The clarinet's fader comes up for the strain it leads.
    solo = [{"tick": a2, "value": 1.6}, {"tick": b, "value": 0.6}]

    tempo = Tempo(100)  # Joplin's tempo di marcia
    tempo.glide(last - bar, last, 100, 84)
    tempo.at(last, 84)
    keys = [(0, -4, False), (c1, -5, False), (d1, -4, False)]
    sections = [
        ("a", 0),
        ("a-clarinet", a2),
        ("b", b),
        ("a-stop", a3),
        ("c-piano", c1),
        ("c", c2),
        ("d", d1),
        ("d-out", d2),
    ]
    song = Song(tempo, sections, length)
    song.bus("room", song.standard("MediumRoom"))
    kit = [
        {"note": KICK, "name": "Bass Drum 1", "slot": 0},
        {"note": SNARE, "name": "Acoustic Snare", "slot": 1},
        {"note": CRASH, "name": "Crash Cymbal 1", "slot": 2},
        {"note": WOOD, "name": "Hi Wood Block", "slot": 3},
    ]
    slot = {KICK: 0, SNARE: 1, CRASH: 2, WOOD: 3}
    seats = {  # patches, voices, gain, pan, send
        "Cornet": (["Trumpet"], 2, 1.0, 0.0, 0.25),
        "Clarinet": (["Clarinet"], 2, 0.6, -0.35, 0.25),
        "Trombone": (["Trombone"], 2, 0.6, 0.35, 0.25),
        "Tuba": (["Tuba"], 2, 0.8, 0.1, 0.15),
        "Banjo": (["Banjo"], 12, 0.7, -0.2, 0.2),
        "Piano": (["GrandPiano"], 16, 0.9, -0.1, 0.25),
        "Drums": (
            ["KitKick", "KitSnare", "KitCrash", "KitWoodBlock"],
            8,
            0.75,
            0.2,
            0.2,
        ),
    }
    for name, (patches, voices, gain, pan, send) in seats.items():
        song.track(
            name,
            [song.standard(p) for p in patches],
            swung(sorted(parts[name], key=lambda n: (n.tick, n.pitch)), 0.62, q // 2),
            voices,
            gain,
            pan,
            {"room": send},
            lanes={"Trombone": lanes, "Clarinet": solo}.get(name),
            slot_of=(lambda n: slot[n.pitch]) if name == "Drums" else None,
            steal="fade",
            kit=kit if name == "Drums" else None,
        )
    listen = (
        "Joplin's rag as a New Orleans band would swing it: cornet lead with the clarinet a third or sixth above and "
        "the trombone smearing in under them, the clarinet alone the second time, a stop-time strain, the trio's first "
        "time on piano, and the banjo, tuba and drums driving the last strains home."
    )
    return song.project(
        "maple", "Maple Leaf Rag", meter=[(0, 2, 4)], pickup=p0, key=keys
    ), listen


def st_louis_rag() -> tuple[dict, str]:
    """Turpin, The St. Louis Rag, as a nickelodeon's orchestrion plays it: a piano with a mandolin rail, xylophone,
    bells and drums, every repeat in strict time."""
    q, bar = PPQ, 2 * PPQ
    printed = read_midi(SCORES / "StLouisRag.mid")
    right = 1
    # The edition prints a four-bar introduction, then four strains, each once with its two endings after it.
    order = [(0, 4 * bar)]
    for k in range(4):
        body = (4 + 17 * k) * bar
        order += [
            (body, body + 16 * bar),
            (body, body + 15 * bar),
            (body + 16 * bar, body + 17 * bar),
        ]
    played, starts = unfold(printed, order)
    plays = [starts[0]] + [starts[1 + 3 * k + j] for k in range(4) for j in (0, 1)]
    names = ["intro", "a", "a-again", "b", "b-again", "c", "c-again", "d", "d-again"]
    end = starts[-1] + bar
    length = end + bar
    play_of = lambda tick: names[max(i for i, t in enumerate(plays) if t <= tick)]
    # Which of the machine's stops are drawn for each time through. Its piano has two loudnesses, as a soft pedal gives.
    stops = {
        "intro": {"loud", "xylophone", "drums"},
        "a": {"loud", "drums"},
        "a-again": {"xylophone", "kick"},
        "b": {"loud", "mandolin"},
        "b-again": {"loud", "xylophone", "drums", "rolls"},
        "c": {"bells", "triangle"},
        "c-again": {"loud", "mandolin", "drums"},
        "d": {"loud", "xylophone", "drums"},
        "d-again": {"loud", "xylophone", "mandolin", "drums", "rolls"},
    }
    parts: dict[str, list[Note]] = {
        name: [] for name in ("Piano", "Xylophone", "Mandolin", "Bells", "Drums")
    }
    tops: dict[int, Note] = {}
    for n in played:
        drawn = stops[play_of(n.tick)]
        # A machine plays every note at the loudness its stop gives, and its melody, the top line, a little louder.
        top = n.part == right and all(
            m.pitch <= n.pitch for m in played if m.tick == n.tick and m.part == right
        )
        loud = 92 if "loud" in drawn else 72
        parts["Piano"].append(Note(n.tick, n.dur, n.pitch, loud + (6 if top else 0)))
        if top:
            tops[n.tick] = n
    for tick, n in sorted(tops.items()):
        drawn = stops[play_of(tick)]
        if "xylophone" in drawn:
            parts["Xylophone"].append(Note(tick, n.dur, n.pitch, 96))
        if "bells" in drawn:
            parts["Bells"].append(Note(tick, n.dur, n.pitch, 84))
        if "mandolin" in drawn:
            # The rail strikes each melody note again and again, a thirty-second apart, for as long as it is held.
            for at in range(tick, tick + max(n.dur, q // 8), q // 8):
                parts["Mandolin"].append(
                    Note(at, q // 8 - 10, n.pitch, 86 if at == tick else 74)
                )
    KICK, SNARE, CRASH, TRIANGLE = 36, 38, 49, 81
    for tick in range(0, end - bar, q // 2):
        drawn = stops[play_of(tick)]
        beat = tick % q == 0
        if beat and ("drums" in drawn or "kick" in drawn):
            parts["Drums"].append(
                Note(tick, q // 4, KICK, 92 if tick % bar == 0 else 82)
            )
        if not beat and "drums" in drawn:
            # The snare between the beats, and a roll into every fourth bar's end.
            if "rolls" in drawn and tick % (4 * bar) == 4 * bar - q // 2:
                for i in range(4):
                    parts["Drums"].append(
                        Note(tick + i * q // 8, q // 8, SNARE, 70 + 6 * i)
                    )
            else:
                parts["Drums"].append(Note(tick, q // 4, SNARE, 76))
        if "triangle" in drawn and tick % bar == q:
            parts["Drums"].append(Note(tick, q // 4, TRIANGLE, 70))
    for start, name in zip(plays, names):
        if "drums" in stops[name]:
            parts["Drums"].append(
                Note(start, q, CRASH, 90)
            )  # A cymbal on the bass drum's beater, as each strain starts
    last = starts[-1]
    parts["Drums"] += [Note(last, q // 4, KICK, 100), Note(last, bar, CRASH, 100)]
    parts["Piano"] = [
        replace(n, dur=bar + q) if n.tick >= last else n for n in parts["Piano"]
    ]

    song = Song(Tempo(100), list(zip(names, plays)), length)
    song.bus("room", song.standard("MediumRoom"))
    kit = [
        {"note": KICK, "name": "Bass Drum 1", "slot": 0},
        {"note": SNARE, "name": "Acoustic Snare", "slot": 1},
        {"note": CRASH, "name": "Crash Cymbal 1", "slot": 2},
        {"note": TRIANGLE, "name": "Open Triangle", "slot": 3},
    ]
    slot = {KICK: 0, SNARE: 1, CRASH: 2, TRIANGLE: 3}
    seats = {  # patches, voices, gain, pan, send
        "Piano": (["BrightPiano"], 16, 1.0, 0.0, 0.25),
        "Xylophone": (["Xylophone"], 6, 1.25, 0.3, 0.2),
        "Mandolin": (["Dulcimer"], 6, 1.2, -0.3, 0.2),
        "Bells": (["Glockenspiel"], 6, 1.2, 0.25, 0.3),
        "Drums": (
            ["KitKick", "KitSnare", "KitCrash", "KitTriangle"],
            8,
            1.3,
            -0.15,
            0.15,
        ),
    }
    for name, (patches, voices, gain, pan, send) in seats.items():
        song.track(
            name,
            [song.standard(p) for p in patches],
            sorted(parts[name], key=lambda n: (n.tick, n.pitch)),
            voices,
            gain,
            pan,
            {"room": send},
            slot_of=(lambda n: slot[n.pitch]) if name == "Drums" else None,
            steal="fade",
            kit=kit if name == "Drums" else None,
        )
    listen = (
        "Turpin's rag as a nickelodeon's orchestrion plays it, in strict time and every repeat: a piano that is loud or "
        "soft and nothing between, with a mandolin rail, xylophone, bells and drums drawn in and out strain by strain."
    )
    keys = [(0, 0, False), (plays[5], -1, False)]
    return song.project(
        "st-louis", "The St. Louis Rag", meter=[(0, 2, 4)], key=keys
    ), listen


def sounding(notes: list[Note], tick: int) -> set[int]:
    """The pitch classes of the notes sounding at `tick`."""
    return {n.pitch % 12 for n in notes if n.tick <= tick < n.end}


def stars_and_stripes() -> tuple[dict, str]:
    """Sousa, The Stars and Stripes Forever, scored for a military band from the piano edition."""
    q, bar = PPQ, 4 * PPQ
    printed = read_midi(SCORES / "StarsAndStripesForever.mid")
    right, left = 1, 2
    # LilyPond unfolded the repeats: the introduction, each strain twice, the trio, and then the break strain and the
    # trio twice more, 212 bars. The band plays it with one break strain, into the trio's last time.
    played, _ = unfold(printed, [(0, 100 * bar), (156 * bar, 212 * bar)])
    marks = [("intro", 0), ("a", 4), ("a-again", 20), ("b", 36), ("b-again", 52)]
    marks += [("trio", 68), ("break", 100), ("grandioso", 124)]
    end = 156 * bar
    role = lambda tick: max(
        (m for m in marks if m[1] * bar <= tick), key=lambda m: m[1]
    )[0]
    level = {
        "intro": 104,
        "a": 90,
        "a-again": 96,
        "b": 70,
        "b-again": 102,
        "trio": 66,
        "break": 104,
        "grandioso": 110,
    }
    loud = {"intro", "a-again", "b-again", "break", "grandioso"}
    rh = [n for n in played if n.part == right]
    lh = [n for n in played if n.part == left]
    by_tick: dict[int, list[Note]] = {}
    for n in rh:
        by_tick.setdefault(n.tick, []).append(n)

    def vel(r: str, tick: int, lift: float = 0, under: bool = False) -> int:
        # The parts under the tune drop back further in the soft strains, where only the clarinets have it.
        hush = -8 if under and r in ("b", "trio") else 0
        return velocity(
            level[r]
            + lift
            + hush
            + (4 if tick % (2 * q) == 0 else 0)
            + wobble(tick, 11)
        )

    def tongued(r: str, dur: int) -> int:
        # A march is played short, and the trio sung.
        return (
            dur - 30
            if r == "trio"
            else max(60, round(dur * (0.85 if dur <= q else 0.92)))
        )

    parts: dict[str, list[Note]] = {
        name: []
        for name in (
            "Piccolo",
            "Clarinets",
            "Cornets",
            "Horns",
            "Trombones",
            "Tuba",
            "Bells",
            "Drums",
        )
    }
    for tick, chord in sorted(by_tick.items()):
        r = role(tick)
        top = max(chord, key=lambda n: n.pitch)
        dur = tongued(r, top.dur)
        clarinet = top.pitch + 12 if top.pitch < 70 and r != "trio" else top.pitch
        parts["Clarinets"].append(
            Note(tick, dur, clarinet, vel(r, tick, -4 if r in loud else 0))
        )
        if r != "b" and r != "trio":
            cornet = top.pitch - 12 if top.pitch > 80 else top.pitch
            parts["Cornets"].append(Note(tick, dur, cornet, vel(r, tick)))
        if r == "trio":
            parts["Bells"].append(Note(tick, dur, top.pitch + 12, vel(r, tick, 6)))
        if r == "break":  # The right hand's chords below the tune go to the horns
            for n in chord:
                if n is not top and n.pitch < top.pitch - 2:
                    parts["Horns"].append(
                        Note(tick, tongued(r, n.dur), n.pitch, vel(r, tick, -8))
                    )
    # The left hand: its bass on each half note goes to the tuba, an octave down where the piano has no octave, and its
    # afterbeat chords to the horns. In the break strain its octaves are the trombones' chromatic line.
    for n in lh:
        r = role(n.tick)
        on_beat = n.tick % (2 * q) == 0
        lowest = all(m.pitch >= n.pitch for m in lh if m.tick == n.tick)
        if r == "break":
            if not lowest:
                parts["Trombones"].append(
                    Note(n.tick, tongued(r, n.dur), n.pitch, vel(r, n.tick, -2))
                )
            else:
                parts["Tuba"].append(
                    Note(
                        n.tick,
                        tongued(r, n.dur),
                        n.pitch - 12 if n.pitch > 46 else n.pitch,
                        vel(r, n.tick),
                    )
                )
        elif on_beat and lowest:
            low = n.pitch - 12 if n.pitch > 46 else n.pitch
            parts["Tuba"].append(
                Note(n.tick, tongued(r, n.dur), low, vel(r, n.tick, under=True))
            )
        elif not on_beat:
            parts["Horns"].append(
                Note(
                    n.tick,
                    max(60, n.dur - 90),
                    n.pitch,
                    vel(r, n.tick, -10, under=True),
                )
            )
    # The trombones' countermelody: the harmony a half note at a time, moving as little as it can, in the strains the
    # band plays loud, and held a bar at a time in the trio.
    trombone = 58
    for tick in range(4 * bar, end - bar, 2 * q):
        r = role(tick)
        if r == "break" or (r == "trio" and tick % bar):
            continue
        harmony = sounding(lh, tick) | sounding(rh, tick)
        if not harmony:
            continue
        trombone = led(trombone, harmony, 50, 65)
        long = bar if r == "trio" else 2 * q
        lift = -10 if r != "grandioso" else -2
        parts["Trombones"].append(
            Note(tick, long - 50, trombone, vel(r, tick, lift, under=True))
        )
    # The piccolo's descant over the last trio, written here, for the edition has none: the harmony's notes in eighths,
    # high above the tune, rising and falling over two bars.
    grand = 124 * bar
    previous = 0
    for tick in range(grand, end - bar, q // 2):
        harmony = sounding(lh, tick) | sounding(rh, tick)
        target = 91 + 5 * math.sin(2 * math.pi * (tick - grand) / (2 * bar))
        options = sorted(
            (p for p in range(84, 99) if p % 12 in harmony and p != previous),
            key=lambda p: abs(p - target),
        )
        if not options:
            continue
        previous = options[0]
        parts["Piccolo"].append(
            Note(
                tick,
                q // 2 - 40,
                previous,
                velocity(86 + (6 if tick % q == 0 else 0) + wobble(tick, 5)),
            )
        )
    # The drums: the bass drum on the half notes, with the cymbals in the loud strains, and the snare on the afterbeats,
    # rolling into the end of every fourth bar.
    KICK, SNARE, CRASH = 36, 38, 49
    for tick in range(0, end - bar, q):
        r = role(tick)
        half = tick % (2 * q) == 0
        if half and (r != "trio" or tick % bar == 0):
            parts["Drums"].append(Note(tick, q // 4, KICK, vel(r, tick, -14)))
            if r in loud and tick % bar == 0:
                parts["Drums"].append(Note(tick, q // 2, CRASH, vel(r, tick, -22)))
        if not half:
            if r in loud and tick % (4 * bar) == 4 * bar - q:
                for i in range(8):
                    parts["Drums"].append(
                        Note(
                            tick + i * q // 8,
                            q // 8,
                            SNARE,
                            velocity(level[r] - 34 + 3 * i),
                        )
                    )
            else:
                parts["Drums"].append(
                    Note(tick, q // 4, SNARE, vel(r, tick, -26 if r != "trio" else -30))
                )
    stinger = end - 2 * q  # The last chord, on the last bar's third beat
    parts["Drums"] += [Note(stinger, q // 4, KICK, 112), Note(stinger, q, CRASH, 108)]
    parts["Tuba"].append(Note(stinger, q - 60, 32, 112))
    parts["Trombones"] += [Note(stinger, q - 60, p, 108) for p in (44, 51, 56)]
    parts["Horns"] += [Note(stinger, q - 60, p, 100) for p in (60, 63, 68)]
    parts["Piccolo"].append(Note(stinger, q - 60, 92, 104))

    # The clarinets' fader comes up where they have the tune alone.
    clarinets = []
    for name, start, stop in (("b", 36, 52), ("trio", 68, 100)):
        clarinets += [(start * bar, 1.1), (stop * bar - 1, 1.1), (stop * bar, 0.7)]
    clarinets = [(0, 0.7)] + clarinets
    sections = [(name, start * bar) for name, start in marks]
    song = Song(Tempo(240), sections, end)  # Half notes at 120, a march's step
    song.bus("hall", song.standard("MediumHall"))
    kit = [
        {"note": KICK, "name": "Bass Drum 1", "slot": 0},
        {"note": SNARE, "name": "Acoustic Snare", "slot": 1},
        {"note": CRASH, "name": "Crash Cymbal 1", "slot": 2},
    ]
    slot = {KICK: 0, SNARE: 1, CRASH: 2}
    seats = {  # patches, voices, gain, pan, send
        "Piccolo": (["Flute"], 2, 0.9, -0.3, 0.3),
        "Clarinets": (["Clarinet"], 4, 0.7, -0.4, 0.3),
        "Cornets": (["Trumpet"], 4, 0.9, -0.1, 0.28),
        "Horns": (["FrenchHorn"], 8, 0.5, 0.25, 0.35),
        "Trombones": (["Trombone"], 6, 0.6, 0.4, 0.3),
        "Tuba": (["Tuba"], 3, 0.8, 0.15, 0.2),
        "Bells": (["Glockenspiel"], 4, 0.4, 0.1, 0.3),
        "Drums": (["KitKick", "KitSnare", "KitCrash"], 8, 0.45, 0.0, 0.25),
    }
    for name, (patches, voices, gain, pan, send) in seats.items():
        song.track(
            name,
            [song.standard(p) for p in patches],
            sorted(parts[name], key=lambda n: (n.tick, n.pitch)),
            voices,
            gain,
            pan,
            {"hall": send},
            fader(clarinets) if name == "Clarinets" else None,
            slot_of=(lambda n: slot[n.pitch]) if name == "Drums" else None,
            steal="fade",
            kit=kit if name == "Drums" else None,
        )
    listen = (
        "Sousa's march scored here for the standard set's band from the piano edition: cornets and clarinets on the "
        "tune, horns on the afterbeats, tuba and drums marching, the trio soft on clarinets and bells, the trombones' "
        "chromatic break strain, and the last trio grandioso with a piccolo descant of our own above it."
    )
    keys = [(0, -3, False), (68 * bar, -4, False)]
    return song.project(
        "stars-and-stripes",
        "The Stars and Stripes Forever",
        meter=[(0, 2, 2)],
        key=keys,
    ), listen


MAKERS = {
    "BachPreludeInC": prelude,
    "PassionChorale": chorale,
    "FurElise": elise,
    "HallOfTheMountainKing": king,
    "BachInventionInF": invention,
    "TheEntertainer": entertainer,
    "SoldiersJoy": soldiers_joy,
    "Kappore": kappore,
    "MapleLeafRag": maple_leaf,
    "StLouisRag": st_louis_rag,
    "StarsAndStripesForever": stars_and_stripes,
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
