"""Wrote Lines16.json, a project that uses what revision 8 added: delay lines of 16-bit samples, through a delay that feeds
back, one that doesn't, combs and allpasses.

Like Mods it sounds like nothing in particular. Its job is to pin what each one does on every target: one comb is driven
past full scale so its line is held to the i16 range, and the room keeps an f32 allpass among its i16 lines, so a patch
with both kinds is laid out right. It stays small enough for an L476.
"""

import json
from pathlib import Path


def graph(
    nodes: list[dict], edges: list[tuple], params: list[dict] | None = None
) -> dict:
    out = {
        "nodes": nodes,
        "edges": [{"from": f, "port": p, "to": t, "input": i} for f, p, t, i in edges],
    }
    if params:
        out["params"] = params
    return out


# A plucked triangle into an echo that feeds back, and a short one that doesn't on the right, both on i16 lines.
echo = graph(
    [
        {"id": 1, "type": "note"},
        {"id": 2, "type": "mtof"},
        {"id": 3, "type": "osc", "wave": "triangle"},
        {
            "id": 4,
            "type": "env",
            "inputs": {"attack": 0.002, "decay": 0.15, "sustain": 0.0, "release": 0.05},
        },
        {"id": 5, "type": "mul"},
        {"id": 6, "type": "add"},
        {"id": 7, "type": "delay", "max": 0.2, "line": "i16", "inputs": {"time": 0.13}},
        {"id": 8, "type": "mul", "inputs": {"b": 0.55}},
        {
            "id": 9,
            "type": "delay",
            "max": 0.02,
            "line": "i16",
            "inputs": {"time": 0.011},
        },
        {"id": 10, "type": "mul", "inputs": {"b": 0.4}},
        {"id": 11, "type": "out"},
    ],
    [
        (1, "pitch", 2, "in"),
        (2, "out", 3, "freq"),
        (3, "out", 5, "a"),
        (4, "out", 5, "b"),
        (5, "out", 6, "a"),
        (8, "out", 6, "b"),
        (6, "out", 7, "in"),
        (7, "out", 8, "a"),
        (6, "out", 10, "a"),
        (10, "out", 9, "in"),
        (10, "out", 11, "l"),
        (9, "out", 11, "r"),
    ],
)

# Noise bursts into a comb driven past full scale, so its line saturates, and a saw into an i16 allpass.
drive = graph(
    [
        {"id": 1, "type": "note"},
        {"id": 2, "type": "mtof"},
        {"id": 3, "type": "noise"},
        {
            "id": 4,
            "type": "env",
            "inputs": {"attack": 0.001, "decay": 0.05, "sustain": 0.0, "release": 0.02},
        },
        {"id": 5, "type": "mul"},
        {"id": 6, "type": "mul", "inputs": {"b": 6.0}},
        {
            "id": 7,
            "type": "comb",
            "max": 0.03,
            "line": "i16",
            "inputs": {"time": 0.0061, "feedback": 0.97, "damp": 0.1},
        },
        {"id": 8, "type": "mul", "inputs": {"b": 0.08}},
        {"id": 9, "type": "osc", "wave": "saw", "mode": "naive"},
        {
            "id": 10,
            "type": "allpass",
            "max": 0.01,
            "line": "i16",
            "inputs": {"time": 0.0043, "feedback": 0.6},
        },
        {"id": 11, "type": "mul"},
        {"id": 12, "type": "mul", "inputs": {"b": 0.2}},
        {"id": 13, "type": "out"},
    ],
    [
        (3, "out", 5, "a"),
        (4, "out", 5, "b"),
        (5, "out", 6, "a"),
        (6, "out", 7, "in"),
        (7, "out", 8, "a"),
        (1, "pitch", 2, "in"),
        (2, "out", 9, "freq"),
        (9, "out", 10, "in"),
        (10, "out", 11, "a"),
        (4, "out", 11, "b"),
        (11, "out", 12, "a"),
        (8, "out", 13, "l"),
        (12, "out", 13, "r"),
    ],
)

# A small mono room on a bus, its four combs and first allpass on i16 lines and its last allpass on an f32 one.
room_nodes = [
    {"id": 1, "type": "in"},
    {"id": 2, "type": "add"},
    {"id": 3, "type": "param", "param": 1},
    {"id": 4, "type": "param", "param": 2},
]
room_edges = [(1, "l", 2, "a"), (1, "r", 2, "b")]
for i, seconds in enumerate([0.0253, 0.0269, 0.029, 0.0307]):
    comb = 10 + i
    room_nodes.append(
        {
            "id": comb,
            "type": "comb",
            "max": 0.035,
            "line": "i16",
            "inputs": {"time": seconds},
        }
    )
    room_edges += [
        (2, "out", comb, "in"),
        (3, "out", comb, "feedback"),
        (4, "out", comb, "damp"),
    ]
room_nodes += [
    {"id": 20, "type": "add"},
    {"id": 21, "type": "add"},
    {"id": 22, "type": "add"},
    {
        "id": 23,
        "type": "allpass",
        "max": 0.015,
        "line": "i16",
        "inputs": {"time": 0.0126},
    },
    {"id": 24, "type": "allpass", "max": 0.015, "inputs": {"time": 0.01}},
    {"id": 25, "type": "mul", "inputs": {"b": 0.15}},
    {"id": 26, "type": "out"},
]
room_edges += [
    (10, "out", 20, "a"),
    (11, "out", 20, "b"),
    (12, "out", 21, "a"),
    (13, "out", 21, "b"),
    (20, "out", 22, "a"),
    (21, "out", 22, "b"),
    (22, "out", 23, "in"),
    (23, "out", 24, "in"),
    (24, "out", 25, "a"),
    (25, "out", 26, "l"),
    (25, "out", 26, "r"),
]
room = graph(
    room_nodes,
    room_edges,
    [
        {
            "id": 1,
            "name": "size",
            "scope": "track",
            "min": 0,
            "max": 0.95,
            "default": 0.84,
            "smooth_ms": 20,
        },
        {
            "id": 2,
            "name": "damp",
            "scope": "track",
            "min": 0,
            "max": 0.9,
            "default": 0.25,
            "smooth_ms": 20,
        },
    ],
)


def note(tick: int, key: int, dur: int, vel: int = 100) -> dict:
    return {"tick": tick, "note": key, "vel": vel, "dur": dur}


timeline = {
    "ppq": 480,
    "tempo": [{"tick": 0, "bpm": 120}],
    "clips": [
        {
            "id": "plucks",
            "length": 1200,
            "notes": [
                note(0, 64, 100),
                note(360, 67, 100, 80),
                note(720, 71, 100, 110),
            ],
        },
        {
            "id": "hits",
            "length": 1200,
            "notes": [note(120, 45, 200), note(600, 52, 300, 70)],
        },
    ],
    "tracks": [
        {
            "id": 1,
            "name": "echo",
            "voices": 2,
            "slots": ["echo"],
            "pan": -0.3,
            "placements": [{"clip": "plucks", "tick": 0}],
            "sends": [{"bus": "room", "gain": 0.4}],
        },
        {
            "id": 2,
            "name": "drive",
            "voices": 2,
            "slots": ["drive"],
            "pan": 0.3,
            "placements": [{"clip": "hits", "tick": 0}],
            "sends": [{"bus": "room", "gain": 0.3}],
        },
    ],
    "buses": [{"id": "room", "inserts": [{"id": 1, "patch": "room"}]}],
    "master": {"gain": 0.8},
}

project = {
    "patches": {
        "echo": {"name": "echo", "graph": echo},
        "drive": {"name": "drive", "graph": drive},
        "room": {"name": "room", "graph": room},
    },
    "programs": [{"id": "lines16", "name": "lines16", "timeline": timeline}],
}
Path(__file__).with_name("Lines16.json").write_text(
    json.dumps(project, indent=1) + "\n"
)
