"""Wrote Steals.json, a project that uses what revision 7 added: a stolen voice that fades, a legato line whose notes bring
their velocities, and Sample3, with a round robin, crossfaded layers, a tail and release samples, forwards and reversed.

Like Mods it sounds like nothing in particular. Its job is to pin what each one does on every target, so its recordings are
short and made here from sines, and it stays small enough for an L476.
"""

import base64
import json
import math
from pathlib import Path

RATE = 48000.0


def recording(
    frames: int,
    partials: list[tuple[float, float]],
    decay: float,
    root: int,
    loop=(0, 0),
) -> dict:
    """i16 mono, a sum of (cycles over the recording, level) partials under an exponential decay."""
    samples = []
    for i in range(frames):
        t = i / frames
        value = sum(
            level * math.sin(2 * math.pi * cycles * t) for cycles, level in partials
        )
        samples.append(round(max(-1.0, min(1.0, value * math.exp(-decay * t))) * 32767))
    data = b"".join(int(s).to_bytes(2, "little", signed=True) for s in samples)
    return {
        "encoding": "i16",
        "channels": 1,
        "frames": frames,
        "rate": RATE,
        "root_key": root,
        "loop_start": loop[0],
        "loop_end": loop[1],
        "data": base64.b64encode(data).decode(),
    }


assets = {
    "rr1": recording(1200, [(40, 0.6), (80, 0.2)], 4.0, 40),
    "rr2": recording(1200, [(41, 0.6), (123, 0.15)], 4.5, 40),
    "rr3": recording(1200, [(39, 0.5), (117, 0.25)], 3.5, 40),
    "soft": recording(2400, [(50, 0.4)], 0.5, 60, (400, 2000)),
    "loud": recording(2400, [(50, 0.5), (100, 0.3), (150, 0.2)], 0.5, 60, (400, 2000)),
    "thud": recording(900, [(13, 0.5), (29, 0.3), (61, 0.2)], 6.0, 60),
}


def graph(nodes: list[dict], edges: list[tuple]) -> dict:
    return {
        "nodes": nodes,
        "edges": [{"from": f, "port": p, "to": t, "input": i} for f, p, t, i in edges],
    }


env = {"attack": 0.002, "decay": 0.2, "sustain": 0.5, "release": 0.08}

# A saw that holds, so a steal is heard as one.
pluck = graph(
    [
        {"id": 1, "type": "note"},
        {"id": 2, "type": "mtof"},
        {"id": 3, "type": "osc", "wave": "saw"},
        {"id": 4, "type": "env", "inputs": env},
        {"id": 5, "type": "mul"},
        {"id": 6, "type": "mul", "inputs": {"b": 0.15}},
        {"id": 7, "type": "out"},
    ],
    [
        (1, "pitch", 2, "in"),
        (2, "out", 3, "freq"),
        (3, "out", 5, "a"),
        (4, "out", 5, "b"),
        (5, "out", 6, "a"),
        (6, "out", 7, "l"),
    ],
)

# Its level is its velocity, which a slur moves.
lead = graph(
    [
        {"id": 1, "type": "note"},
        {"id": 2, "type": "mtof"},
        {"id": 3, "type": "osc", "wave": "triangle"},
        {"id": 4, "type": "mul"},
        {
            "id": 5,
            "type": "env",
            "inputs": {"attack": 0.005, "decay": 0.1, "sustain": 1.0, "release": 0.05},
        },
        {"id": 6, "type": "mul"},
        {"id": 7, "type": "mul", "inputs": {"b": 0.3}},
        {"id": 8, "type": "out"},
    ],
    [
        (1, "pitch", 2, "in"),
        (2, "out", 3, "freq"),
        (3, "out", 4, "a"),
        (1, "velocity", 4, "b"),
        (4, "out", 6, "a"),
        (5, "out", 6, "b"),
        (6, "out", 7, "a"),
        (7, "out", 8, "l"),
    ],
)

rounds = [
    {"asset": f"rr{n}", "keys": [36, 47], "round_robin": [n, 3]} for n in (1, 2, 3)
]
layers = [
    {"asset": "soft", "keys": [48, 72], "velocities": [0, 100], "fade": [0, 40]},
    {"asset": "loud", "keys": [48, 72], "velocities": [60, 127], "fade": [40, 0]},
]
releases = [{"asset": "thud", "keys": [0, 127]}]
kit = graph(
    [
        {"id": 1, "type": "sample", "mode": "zones", "zones": rounds + layers},
        {"id": 2, "type": "sample", "mode": "zones", "tail": True, "zones": layers},
        {"id": 3, "type": "sample", "mode": "zones", "reverse": True, "zones": rounds},
        {
            "id": 4,
            "type": "sample",
            "mode": "zones",
            "release": True,
            "zones": releases,
        },
        {
            "id": 5,
            "type": "sample",
            "mode": "zones",
            "release": True,
            "reverse": True,
            "zones": releases,
        },
        {"id": 6, "type": "env", "inputs": env},
        {"id": 7, "type": "add"},
        {"id": 8, "type": "add"},
        {"id": 9, "type": "mul"},
        {"id": 10, "type": "add"},
        {"id": 11, "type": "add"},
        {"id": 12, "type": "mul", "inputs": {"b": 0.3}},
        {"id": 13, "type": "out"},
        {
            "id": 14,
            "type": "sample",
            "mode": "zones",
            "reverse": True,
            "tail": True,
            "zones": layers,
        },
        {"id": 15, "type": "add"},
    ],
    [
        (1, "l", 7, "a"),
        (2, "l", 7, "b"),
        (7, "out", 15, "a"),
        (14, "l", 15, "b"),
        (15, "out", 8, "a"),
        (3, "l", 8, "b"),
        (8, "out", 9, "a"),
        (6, "out", 9, "b"),
        (4, "l", 10, "a"),
        (5, "l", 10, "b"),
        (9, "out", 11, "a"),
        (10, "out", 11, "b"),
        (11, "out", 12, "a"),
        (12, "out", 13, "l"),
    ],
)


def note(tick: int, key: int, dur: int, vel: int = 100) -> dict:
    return {"tick": tick, "note": key, "vel": vel, "dur": dur}


timeline = {
    "ppq": 480,
    "tempo": [{"tick": 0, "bpm": 120}],
    "clips": [
        # Two voices and four notes: the third and the fourth each take a voice that is still sounding.
        {
            "id": "chords",
            "length": 1200,
            "notes": [
                note(0, 48, 900),
                note(0, 55, 900),
                note(240, 60, 600),
                note(480, 64, 400),
            ],
        },
        {
            "id": "line",
            "length": 1200,
            "notes": [
                note(0, 60, 400, 30),
                note(300, 64, 400, 110),
                note(600, 67, 300, 60),
            ],
        },
        {
            "id": "hits",
            "length": 1200,
            "notes": [
                note(0, 40, 90),
                note(120, 40, 90),
                note(240, 40, 90),
                note(360, 60, 150, 30),
                note(600, 60, 150, 80),
                note(840, 60, 150, 120),
            ],
        },
    ],
    "tracks": [
        {
            "id": 1,
            "name": "chords",
            "voices": 2,
            "steal": "fade",
            "slots": ["pluck"],
            "pan": -0.4,
            "placements": [{"clip": "chords", "tick": 0}],
        },
        {
            "id": 2,
            "name": "line",
            "voices": 1,
            "slots": ["lead"],
            "play": {"mode": "legato", "glide": 0.03, "slur_velocity": True},
            "placements": [{"clip": "line", "tick": 0}],
        },
        {
            "id": 3,
            "name": "hits",
            "voices": 4,
            "slots": ["kit"],
            "pan": 0.4,
            "placements": [{"clip": "hits", "tick": 0}],
        },
    ],
}

project = {
    "assets": assets,
    "patches": {
        "pluck": {"name": "pluck", "graph": pluck},
        "lead": {"name": "lead", "graph": lead},
        "kit": {"name": "kit", "graph": kit},
    },
    "programs": [{"id": "steals", "name": "steals", "timeline": timeline}],
}
Path(__file__).with_name("Steals.json").write_text(json.dumps(project, indent=1) + "\n")
