#!/usr/bin/env python3
"""Writes Programs that each lean on one kind of work, so tools/Bench.py can fit what each kind costs.

Every one plays at 750 bpm at 480 ticks a quarter, which is 4 ticks in each frame of 32 samples at 48 kHz, so a note on
every tick starts 4 a frame. Each stays well within a NUCLEO-L476RG's budget, so the board's own check passes it.

    bench/MakeCalibration.py [DIR]    into DIR, build/bench/Calibration by default, with an Index.json
"""

import base64
import json
import math
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PPQ, BPM = 480, 750
SECONDS = 1.0
TICKS = round(SECONDS * 48000 / 32) * 4


def patch(nodes: list, edges: list, params: list | None = None) -> dict:
    return {
        "name": "p",
        "graph": {"params": params or [], "nodes": nodes, "edges": edges},
    }


def wire(a: int, b: int, input: str, port: str = "out") -> dict:
    return {"from": a, "port": port, "to": b, "input": input}


# A naive saw at the note's pitch, which every voice here starts from: note 1, mtof 2, saw 3.
HEAD = [
    {"id": 1, "type": "note"},
    {"id": 2, "type": "mtof"},
    {"id": 3, "type": "osc", "wave": "saw", "mode": "naive"},
]
HEAD_WIRES = [wire(1, 2, "in", "pitch"), wire(2, 3, "freq")]


def saw_patch() -> dict:
    return patch(HEAD + [{"id": 4, "type": "out"}], HEAD_WIRES + [wire(3, 4, "l")])


def chain(make, copies: int) -> dict:
    """The saw through `copies` of a node in series. make(id, source) gives the node and its wires from `source`."""
    nodes, wires, source = list(HEAD), list(HEAD_WIRES), 3
    for i in range(copies):
        made, made_wires = make(10 + 10 * i, source)
        nodes += made
        wires += made_wires
        source = made[-1]["id"]
    nodes.append({"id": 9, "type": "out"})
    wires.append(wire(source, 9, "l"))
    return patch(nodes, wires)


def summed(make, copies: int) -> dict:
    """`copies` of a source added to the saw, for a node that takes no audio."""
    nodes, wires, total = list(HEAD), list(HEAD_WIRES), 3
    for i in range(copies):
        made, made_wires = make(10 + 10 * i)
        nodes += made
        wires += made_wires
        add = 15 + 10 * i
        port = "l" if made[-1]["type"] == "sample" else "out"
        nodes.append({"id": add, "type": "add"})
        wires += [wire(total, add, "a"), wire(made[-1]["id"], add, "b", port)]
        total = add
    nodes.append({"id": 9, "type": "out"})
    wires.append(wire(total, 9, "l"))
    return patch(nodes, wires)


def lfo(id: int, rate: float = 3.0, depth: float = 1.0) -> dict:
    return {"id": id, "type": "lfo", "inputs": {"rate": rate, "depth": depth}}


def asset(frames: int = 4800, channels: int = 1) -> dict:
    samples = [
        round(12000 * math.sin(2 * math.pi * 220 * i / 48000))
        for i in range(frames)
        for _ in range(channels)
    ]
    data = struct.pack(f"<{len(samples)}h", *samples)
    return {
        "encoding": "i16",
        "channels": channels,
        "frames": frames,
        "rate": 48000.0,
        "root_key": 60,
        "loop_start": 0,
        "loop_end": frames,
        "data": base64.b64encode(data).decode(),
    }


def program(
    tracks: list,
    clips: list,
    tempo: list | None = None,
    buses: list | None = None,
    master: dict | None = None,
) -> dict:
    timeline = {
        "ppq": PPQ,
        "tempo": tempo or [{"tick": 0, "bpm": BPM}],
        "clips": clips,
        "tracks": tracks,
        "master": master or {"gain": 0.25},
    }
    if buses:
        timeline["buses"] = buses
    return {"id": "p", "name": "p", "timeline": timeline}


def held_clip(keys: int, id: str = "held") -> dict:
    """`keys` notes from tick 0 to the end."""
    return {
        "id": id,
        "length": TICKS,
        "notes": [
            {"tick": 0, "note": 36 + k, "vel": 100, "dur": TICKS} for k in range(keys)
        ],
    }


def every_tick_clip(id: str = "ticks", dur: int = TICKS) -> dict:
    """A note on every tick, repeated: a clip of one tick played to the end."""
    return {
        "id": id,
        "length": 1,
        "notes": [{"tick": 0, "note": 60, "vel": 100, "dur": dur}],
    }


def track(
    id: int, voices: int, slot: str = "p", clip: str | None = None, **more
) -> dict:
    t = {"id": id, "voices": voices, "slots": [slot], "placements": []}
    if clip == "ticks":
        t["placements"] = [{"clip": clip, "tick": 0, "repeat": TICKS}]
    elif clip:
        t["placements"] = [{"clip": clip, "tick": 0}]
    t.update(more)
    return t


def request(patches: dict, prog: dict, assets: dict | None = None) -> dict:
    r = {"patches": patches, "programs": [prog]}
    if assets:
        r["assets"] = assets
    return r


def empty_clip() -> dict:
    """One note of a tick at the start, since a track with no notes is left out, and then nothing."""
    return {
        "id": "held",
        "length": TICKS,
        "notes": [{"tick": 0, "note": 60, "vel": 100, "dur": 1}],
    }


def engine_programs() -> dict:
    """Pairs that differ in one kind of work. tools/Bench.py says which pair measures which term."""
    saw = {"p": saw_patch()}
    out = {}
    held = lambda voices, **more: program(
        [track(1, voices, clip="held", **more)], [held_clip(voices)]
    )
    notes = lambda voices, **more: program(
        [track(1, voices, clip="ticks", **more)], [every_tick_clip()]
    )
    out["Idle"] = request(saw, program([track(1, 1, clip="held")], [empty_clip()]))
    out["IdleVoices"] = request(
        saw, program([track(1, 64, clip="held")], [empty_clip()])
    )
    out["Tracks"] = request(
        saw, program([track(i, 1, clip="held") for i in range(1, 17)], [empty_clip()])
    )
    blips = {
        "id": "held",
        "length": TICKS,
        "notes": [
            {"tick": 0, "note": 60, "vel": 100, "dur": 1, "slot": i} for i in range(8)
        ],
    }
    out["Slots"] = request(
        {f"p{i}": saw_patch() for i in range(8)},
        program([track(1, 1, clip="held", slots=[f"p{i}" for i in range(8)])], [blips]),
    )
    for voices in (1, 2, 4, 8, 16):
        out[f"Held{voices}"] = request(saw, held(voices))
    # A tempo change on every tick cuts each frame into 4 pieces.
    tempo = [{"tick": t, "bpm": BPM + (t % 2) * 0.001} for t in range(TICKS)]
    out["Segments1"] = request(
        saw, program([track(1, 1, clip="held")], [held_clip(1)], tempo=tempo)
    )
    out["Segments16"] = request(
        saw, program([track(1, 16, clip="held")], [held_clip(16)], tempo=tempo)
    )
    # 32 parameters moving on every frame, each ramping over the whole Program.
    params = [
        {
            "id": 100 + i,
            "name": f"k{i}",
            "scope": "track",
            "min": 0,
            "max": 1,
            "default": 0,
            "smooth_ms": 0,
        }
        for i in range(32)
    ]
    nodes, wires, total = HEAD + [{"id": 4, "type": "out"}], list(HEAD_WIRES), 3
    for i in range(32):
        nodes += [
            {"id": 200 + i, "type": "param", "param": 100 + i},
            {"id": 300 + i, "type": "add"},
        ]
        wires += [wire(200 + i, 300 + i, "a"), wire(total, 300 + i, "b")]
        total = 300 + i
    wires.append(wire(total, 4, "l"))
    lanes = [
        {"tick": 1, "param": 100 + i, "value": 1.0, "ramp": TICKS - 2}
        for i in range(32)
    ]
    out["Params"] = request(
        {"p": patch(nodes, wires, params)},
        program([track(1, 1, clip="held")], [empty_clip() | {"automation": lanes}]),
    )
    gain = patch(
        [
            {"id": 1, "type": "in", "index": 0},
            {"id": 2, "type": "mul", "inputs": {"b": 0.5}},
            {"id": 3, "type": "out"},
        ],
        [wire(1, 2, "a", "l"), wire(2, 3, "l")],
    )
    out["Inserts"] = request(
        {"p": saw_patch(), "g": gain},
        program(
            [track(1, 1, clip="held")],
            [held_clip(1)],
            master={
                "gain": 0.25,
                "inserts": [{"id": i, "patch": "g"} for i in range(1, 9)],
            },
        ),
    )
    # 16 sends into one bus, then into two.
    for buses in (1, 2):
        out[f"Buses{buses}"] = request(
            saw,
            program(
                [
                    track(
                        i, 1, clip="held", sends=[{"bus": f"b{i % buses}", "gain": 0.5}]
                    )
                    for i in range(1, 17)
                ],
                [empty_clip()],
                buses=[{"id": f"b{b}"} for b in range(buses)],
            ),
        )
    # A note on every tick, so 4 a frame, each taking a voice from one that is still held.
    for voices in (2, 4, 8, 64):
        out[f"Notes{voices}"] = request(saw, notes(voices))
    vparams = [
        {
            "id": 100 + i,
            "name": f"v{i}",
            "scope": "voice",
            "min": 0,
            "max": 1,
            "default": 0.5,
        }
        for i in range(32)
    ]
    vnodes, vwires, total = HEAD + [{"id": 4, "type": "out"}], list(HEAD_WIRES), 3
    for i in range(32):
        vnodes += [
            {"id": 200 + i, "type": "param", "param": 100 + i},
            {"id": 300 + i, "type": "mul"},
        ]
        vwires += [wire(total, 300 + i, "a"), wire(200 + i, 300 + i, "b")]
        total = 300 + i
    vwires.append(wire(total, 4, "l"))
    out["NotesParams"] = request({"p": patch(vnodes, vwires, vparams)}, notes(8))
    out["HeldParams"] = request({"p": patch(vnodes, vwires, vparams)}, held(8))
    # A parameter set on every tick, and no notes after the first.
    knob = [
        {
            "id": 100,
            "name": "k",
            "scope": "track",
            "min": 0,
            "max": 1,
            "default": 0,
            "smooth_ms": 0,
        }
    ]
    knob_patch = patch(
        HEAD
        + [
            {"id": 5, "type": "param", "param": 100},
            {"id": 6, "type": "add"},
            {"id": 4, "type": "out"},
        ],
        HEAD_WIRES + [wire(3, 6, "a"), wire(5, 6, "b"), wire(6, 4, "l")],
        knob,
    )
    automation = [
        {"tick": t, "param": 100, "value": t % 2 * 0.5} for t in range(1, TICKS)
    ]
    out["SetParams"] = request(
        {"p": knob_patch},
        program(
            [track(1, 1, clip="held")], [empty_clip() | {"automation": automation}]
        ),
    )
    out["IdleKnob"] = request(
        {"p": knob_patch}, program([track(1, 1, clip="held")], [empty_clip()])
    )
    # A mono line holding 16 notes, one more starting every tick, against the same notes played poly.
    out["Mono"] = request(
        saw,
        program(
            [track(1, 2, clip="ticks", play={"mode": "mono", "glide": 0.01})],
            [every_tick_clip(dur=16)],
        ),
    )
    out["Poly"] = request(
        saw, program([track(1, 2, clip="ticks")], [every_tick_clip(dur=16)])
    )
    # Faders ramping, which has the mixer look at every register for a ramp, against the same faders still.
    fader_clips = [
        held_clip(1, f"c{i}")
        | {
            "automation": [
                {
                    "target": {"mix": "fader", "track": i},
                    "tick": 1,
                    "value": 0.5,
                    "ramp": TICKS - 2,
                }
            ]
        }
        for i in range(1, 9)
    ]
    out["MixRamps"] = request(
        saw, program([track(i, 1, clip=f"c{i}") for i in range(1, 9)], fader_clips)
    )
    still = [held_clip(1, f"c{i}") for i in range(1, 9)]
    out["MixStill"] = request(
        saw, program([track(i, 1, clip=f"c{i}") for i in range(1, 9)], still)
    )
    # A sampler whose note is found in the last of 256 zones, against one with a single zone.
    for rows in (1, 256):
        zones = [
            {"asset": "a", "keys": [0, 0], "velocities": [0, 0]}
            for _ in range(rows - 1)
        ]
        zones.append({"asset": "a", "keys": [1, 127]})
        zoned = patch(
            HEAD
            + [
                {"id": 5, "type": "sample", "mode": "zones", "zones": zones},
                {"id": 4, "type": "out"},
            ],
            HEAD_WIRES + [wire(5, 4, "l", "l")],
        )
        out[f"Zones{rows}"] = request({"p": zoned}, notes(8), {"a": asset()})
    # Steals that fade, on every tick, against steals that cut.
    out["Fades"] = request(saw, notes(4, steal="fade"))
    return out


def op_programs() -> dict:
    """Each op, many times in a few voices, on the path that costs it most where a graph can choose."""
    defs = {
        "Noise": ("sum", lambda id: ([{"id": id, "type": "noise"}], []), 8, 4),
        "Osc": (
            "sum",
            lambda id: (
                [{"id": id, "type": "osc", "wave": "sine", "inputs": {"freq": 440.0}}],
                [],
            ),
            8,
            4,
        ),
        "Saw": (
            "sum",
            lambda id: (
                [{"id": id, "type": "osc", "wave": "saw", "inputs": {"freq": 23000.0}}],
                [],
            ),
            8,
            4,
        ),
        "Pulse": (
            "sum",
            lambda id: (
                [
                    {
                        "id": id,
                        "type": "osc",
                        "wave": "square",
                        "inputs": {"freq": 23000.0},
                    }
                ],
                [],
            ),
            8,
            4,
        ),
        "Triangle": (
            "sum",
            lambda id: (
                [
                    {
                        "id": id,
                        "type": "osc",
                        "wave": "triangle",
                        "inputs": {"freq": 440.0},
                    }
                ],
                [],
            ),
            8,
            4,
        ),
        "Tone": (
            "sum",
            lambda id: (
                [
                    {
                        "id": id,
                        "type": "osc",
                        "wave": "sine",
                        "mode": "fixed",
                        "inputs": {"freq": 0.0},
                    }
                ],
                [],
            ),
            8,
            4,
        ),
        "Biquad": (
            "chain",
            lambda id, s: (
                [
                    lfo(id + 1, 7.0, 500.0),
                    {"id": id + 2, "type": "add", "inputs": {"b": 1500.0}},
                    {"id": id, "type": "biquad", "mode": "lowpass"},
                ],
                [
                    wire(id + 1, id + 2, "a"),
                    wire(id + 2, id, "cutoff"),
                    wire(s, id, "in"),
                ],
            ),
            8,
            4,
        ),
        "Env": (
            "sum",
            lambda id: (
                [
                    lfo(id + 1, 7.0, 0.01),
                    {"id": id + 2, "type": "add", "inputs": {"b": 0.05}},
                    {
                        "id": id,
                        "type": "env",
                        "inputs": {"attack": 30.0, "sustain": 0.5},
                    },
                ],
                [
                    wire(id + 1, id + 2, "a"),
                    wire(id + 2, id, "decay"),
                    wire(id + 2, id, "release"),
                ],
            ),
            8,
            4,
        ),
        "Mul": (
            "chain",
            lambda id, s: (
                [{"id": id, "type": "mul"}],
                [wire(s, id, "a"), wire(3, id, "b")],
            ),
            16,
            4,
        ),
        "MulS": (
            "chain",
            lambda id, s: (
                [{"id": id, "type": "mul", "inputs": {"b": 0.99}}],
                [wire(s, id, "a")],
            ),
            16,
            4,
        ),
        "Add": (
            "chain",
            lambda id, s: (
                [{"id": id, "type": "add"}],
                [wire(s, id, "a"), wire(3, id, "b")],
            ),
            16,
            4,
        ),
        "AddS": (
            "chain",
            lambda id, s: (
                [{"id": id, "type": "add", "inputs": {"b": 0.001}}],
                [wire(s, id, "a")],
            ),
            16,
            4,
        ),
        "Pan": (
            "chain",
            lambda id, s: (
                [{"id": id, "type": "pan"}, {"id": id + 1, "type": "add"}],
                [
                    wire(s, id, "in"),
                    wire(id, id + 1, "a", "l"),
                    wire(id, id + 1, "b", "r"),
                ],
            ),
            8,
            4,
        ),
        "Delay": (
            "chain",
            lambda id, s: (
                [{"id": id, "type": "delay", "max": 0.005, "inputs": {"time": 0.004}}],
                [wire(s, id, "in")],
            ),
            8,
            4,
        ),
        "Comb": (
            "chain",
            lambda id, s: (
                [{"id": id, "type": "comb", "max": 0.005, "inputs": {"time": 0.004}}],
                [wire(s, id, "in")],
            ),
            8,
            4,
        ),
        "Allpass": (
            "chain",
            lambda id, s: (
                [
                    {
                        "id": id,
                        "type": "allpass",
                        "max": 0.005,
                        "inputs": {"time": 0.004},
                    }
                ],
                [wire(s, id, "in")],
            ),
            8,
            4,
        ),
        "Follow": (
            "chain",
            lambda id, s: (
                [
                    lfo(id + 1, 7.0, 0.01),
                    {"id": id + 2, "type": "add", "inputs": {"b": 0.05}},
                    {"id": id, "type": "follow"},
                ],
                [
                    wire(id + 1, id + 2, "a"),
                    wire(id + 2, id, "release"),
                    wire(s, id, "in"),
                ],
            ),
            8,
            4,
        ),
        "KMtoF": (
            "chain",
            lambda id, s: (
                [
                    lfo(id + 1, 7.0, 12.0),
                    {"id": id + 2, "type": "mtof"},
                    {"id": id, "type": "mul"},
                ],
                [wire(id + 1, id + 2, "in"), wire(id + 2, id, "b"), wire(s, id, "a")],
            ),
            16,
            4,
        ),
        "OscMod": (
            "sum",
            lambda id: (
                [
                    {
                        "id": id + 1,
                        "type": "osc",
                        "wave": "square",
                        "mode": "naive",
                        "inputs": {"freq": 24000.0},
                    },
                    {
                        "id": id,
                        "type": "osc",
                        "wave": "sine",
                        "mode": "mod",
                        "inputs": {"freq": 440.0, "feedback": 0.5},
                    },
                ],
                [wire(id + 1, id, "sync"), wire(id + 1, id, "phase")],
            ),
            2,
            2,
        ),
        "Math": (
            "chain",
            lambda id, s: (
                [{"id": id, "type": "math", "mode": "floor"}],
                [wire(s, id, "a")],
            ),
            16,
            4,
        ),
        "MathDivide": (
            "chain",
            lambda id, s: (
                [
                    {"id": id + 1, "type": "add", "inputs": {"b": 2.0}},
                    {"id": id, "type": "math", "mode": "divide"},
                ],
                [wire(3, id + 1, "a"), wire(s, id, "a"), wire(id + 1, id, "b")],
            ),
            16,
            4,
        ),
        "Shape": (
            "chain",
            lambda id, s: (
                [{"id": id, "type": "shape", "curve": [-1.0, -0.5, 0.0, 0.5, 1.0]}],
                [wire(s, id, "in")],
            ),
            16,
            4,
        ),
        "Sample": (
            "sum",
            lambda id: (
                [{"id": id, "type": "sample", "asset": "a", "inputs": {"ratio": 1.37}}],
                [],
            ),
            4,
            4,
        ),
        "Sample2": (
            "sum",
            lambda id: (
                [
                    lfo(id + 1, 7.0, 1.0),
                    {"id": id + 2, "type": "add", "inputs": {"b": 60.0}},
                    {
                        "id": id,
                        "type": "sample",
                        "mode": "zones",
                        "zones": [{"asset": "s", "keys": [0, 127]}],
                    },
                ],
                [wire(id + 1, id + 2, "a"), wire(id + 2, id, "note")],
            ),
            4,
            4,
        ),
        "Sample3": (
            "sum",
            lambda id: (
                [
                    lfo(id + 1, 7.0, 1.0),
                    {"id": id + 2, "type": "add", "inputs": {"b": 60.0}},
                    {
                        "id": id,
                        "type": "sample",
                        "mode": "zones",
                        "zones": [
                            {"asset": "s", "keys": [0, 127], "fade": [0, 127]},
                            {"asset": "s", "keys": [0, 127], "fade": [127, 0]},
                        ],
                    },
                ],
                [wire(id + 1, id + 2, "a"), wire(id + 2, id, "note")],
            ),
            4,
            4,
        ),
    }
    out = {}
    for name, (shape, make, copies, voices) in defs.items():
        body = chain(make, copies) if shape == "chain" else summed(make, copies)
        assets = (
            {"a": asset(), "s": asset(channels=2)}
            if name.startswith("Sample")
            else None
        )
        out["Op" + name] = request(
            {"p": body},
            program([track(1, voices, clip="held")], [held_clip(voices)]),
            assets,
        )
    return out


def main() -> None:
    out = (
        Path(sys.argv[1])
        if len(sys.argv) > 1
        else ROOT / "build" / "bench" / "Calibration"
    )
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("*.json"):
        old.unlink()
    programs = engine_programs() | op_programs()
    for name, req in programs.items():
        (out / f"{name}.json").write_text(json.dumps(req) + "\n")
    index = [
        {"name": name, "file": f"{name}.json", "seconds": SECONDS} for name in programs
    ]
    (out / "Index.json").write_text(json.dumps(index, indent=1) + "\n")
    print(f"{len(programs)} programs in {out}")


if __name__ == "__main__":
    main()
