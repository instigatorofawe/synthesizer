"""Regenerates Demo.json, the project every target renders: tests, firmware, wasm and the web app's seed."""

import base64
import json
import math
import struct
from pathlib import Path

RATE = 24000
FRAMES = 2000


def pluck() -> str:
    samples = []
    for i in range(FRAMES):
        t = i / RATE
        value = (
            0.8
            * math.exp(-t * 18)
            * (
                math.sin(2 * math.pi * 261.63 * t)
                + 0.4 * math.sin(2 * math.pi * 523.25 * t)
            )
        )
        samples.append(max(-32768, min(32767, round(value * 32767))))
    return base64.b64encode(struct.pack(f"<{FRAMES}h", *samples)).decode()


lead = {
    "params": [
        {
            "id": 1,
            "name": "cutoff",
            "scope": "track",
            "min": 80,
            "max": 12000,
            "default": 900,
            "smooth_ms": 15,
        },
        {
            "id": 2,
            "name": "env amount",
            "scope": "track",
            "min": 0,
            "max": 8000,
            "default": 2600,
            "smooth_ms": 15,
        },
        {
            "id": 3,
            "name": "detune",
            "scope": "track",
            "min": 0,
            "max": 0.5,
            "default": 0.12,
            "smooth_ms": 0,
        },
    ],
    "nodes": [
        {"id": 1, "type": "note"},
        {"id": 2, "type": "mtof"},
        {"id": 3, "type": "add"},
        {"id": 4, "type": "mtof"},
        {"id": 5, "type": "param", "param": 3},
        {"id": 6, "type": "osc", "wave": "saw"},
        {"id": 7, "type": "osc", "wave": "saw"},
        {
            "id": 8,
            "type": "env",
            "inputs": {
                "attack": 0.004,
                "decay": 0.25,
                "sustain": 0.25,
                "release": 0.18,
            },
        },
        {"id": 9, "type": "mul"},
        {"id": 10, "type": "param", "param": 2},
        {"id": 11, "type": "add"},
        {"id": 12, "type": "param", "param": 1},
        {"id": 13, "type": "biquad", "mode": "lowpass", "inputs": {"q": 2.2}},
        {"id": 14, "type": "biquad", "mode": "lowpass", "inputs": {"q": 2.2}},
        {
            "id": 15,
            "type": "env",
            "inputs": {"attack": 0.002, "decay": 0.4, "sustain": 0.6, "release": 0.2},
        },
        {"id": 16, "type": "mul"},
        {"id": 17, "type": "mul"},
        {"id": 18, "type": "mul", "inputs": {"b": 0.3}},
        {"id": 19, "type": "mul"},
        {"id": 20, "type": "mul"},
        {"id": 21, "type": "out"},
        {"id": 22, "type": "snap"},  # The envelope, read once a frame for the cutoffs
    ],
    "edges": [
        {"from": 1, "port": "pitch", "to": 2, "input": "in"},
        {"from": 1, "port": "pitch", "to": 3, "input": "a"},
        {"from": 5, "to": 3, "input": "b"},
        {"from": 3, "to": 4, "input": "in"},
        {"from": 2, "to": 6, "input": "freq"},
        {"from": 4, "to": 7, "input": "freq"},
        {"from": 8, "to": 9, "input": "a"},
        {"from": 10, "to": 9, "input": "b"},
        {"from": 9, "to": 11, "input": "a"},
        {"from": 12, "to": 11, "input": "b"},
        {"from": 6, "to": 13, "input": "in"},
        {"from": 7, "to": 14, "input": "in"},
        {"from": 11, "to": 22, "input": "in"},
        {"from": 22, "to": 13, "input": "cutoff"},
        {"from": 22, "to": 14, "input": "cutoff"},
        {"from": 13, "to": 16, "input": "a"},
        {"from": 15, "to": 16, "input": "b"},
        {"from": 14, "to": 17, "input": "a"},
        {"from": 15, "to": 17, "input": "b"},
        {"from": 1, "port": "velocity", "to": 18, "input": "a"},
        {"from": 16, "to": 19, "input": "a"},
        {"from": 18, "to": 19, "input": "b"},
        {"from": 17, "to": 20, "input": "a"},
        {"from": 18, "to": 20, "input": "b"},
        {"from": 19, "to": 21, "input": "l"},
        {"from": 20, "to": 21, "input": "r"},
    ],
}

pluck_voice = {
    "params": [
        {
            "id": 1,
            "name": "level",
            "scope": "track",
            "min": 0,
            "max": 1,
            "default": 0.7,
            "smooth_ms": 10,
        }
    ],
    "nodes": [
        {"id": 1, "type": "note"},
        {"id": 2, "type": "ratio", "root": 60},
        {"id": 3, "type": "sample", "asset": "pluck"},
        {"id": 4, "type": "param", "param": 1},
        {"id": 5, "type": "mul"},
        {"id": 6, "type": "out"},
    ],
    "edges": [
        {"from": 1, "port": "pitch", "to": 2, "input": "in"},
        {"from": 2, "to": 3, "input": "ratio"},
        {"from": 3, "port": "l", "to": 5, "input": "a"},
        {"from": 4, "to": 5, "input": "b"},
        {"from": 5, "to": 6, "input": "l"},
    ],
}

COMBS = [0.0253, 0.0269, 0.0290, 0.0307]
reverb_nodes = [
    {"id": 1, "type": "in"},
    {"id": 2, "type": "add"},
    {"id": 3, "type": "param", "param": 1},
    {"id": 4, "type": "param", "param": 2},
]
reverb_edges = [
    {"from": 1, "port": "l", "to": 2, "input": "a"},
    {"from": 1, "port": "r", "to": 2, "input": "b"},
]
next_id = 10
previous = None
for seconds in COMBS:
    comb = next_id
    reverb_nodes.append(
        {"id": comb, "type": "comb", "max": 0.05, "inputs": {"time": seconds}}
    )
    reverb_edges += [
        {"from": 2, "to": comb, "input": "in"},
        {"from": 3, "to": comb, "input": "feedback"},
        {"from": 4, "to": comb, "input": "damp"},
    ]
    next_id += 1
    if previous is None:
        previous = comb
    else:
        total = next_id
        reverb_nodes.append({"id": total, "type": "add"})
        reverb_edges += [
            {"from": previous, "to": total, "input": "a"},
            {"from": comb, "to": total, "input": "b"},
        ]
        previous = total
        next_id += 1
for seconds in [0.0126, 0.0100]:
    allpass = next_id
    reverb_nodes.append(
        {"id": allpass, "type": "allpass", "max": 0.02, "inputs": {"time": seconds}}
    )
    reverb_edges.append({"from": previous, "to": allpass, "input": "in"})
    previous = allpass
    next_id += 1
scale = next_id
reverb_nodes += [
    {"id": scale, "type": "mul", "inputs": {"b": 0.12}},
    {"id": scale + 1, "type": "out"},
]
reverb_edges += [
    {"from": previous, "to": scale, "input": "a"},
    {"from": scale, "to": scale + 1, "input": "l"},
]
reverb = {
    "params": [
        {
            "id": 1,
            "name": "room",
            "scope": "track",
            "min": 0,
            "max": 0.95,
            "default": 0.82,
            "smooth_ms": 20,
        },
        {
            "id": 2,
            "name": "damp",
            "scope": "track",
            "min": 0,
            "max": 0.9,
            "default": 0.3,
            "smooth_ms": 20,
        },
    ],
    "nodes": reverb_nodes,
    "edges": reverb_edges,
}

ducker = {
    "params": [
        {
            "id": 1,
            "name": "depth",
            "scope": "track",
            "min": 0,
            "max": 1,
            "default": 0.7,
            "smooth_ms": 20,
        }
    ],
    "nodes": [
        {"id": 1, "type": "in", "index": 0},
        {"id": 2, "type": "in", "index": 1},
        {"id": 3, "type": "follow", "inputs": {"release": 0.18}},
        {"id": 4, "type": "param", "param": 1},
        {"id": 5, "type": "mul"},
        {"id": 6, "type": "mul", "inputs": {"b": -1.0}},
        {"id": 7, "type": "add", "inputs": {"b": 1.0}},
        {"id": 8, "type": "mul"},
        {"id": 9, "type": "mul"},
        {"id": 10, "type": "out"},
    ],
    "edges": [
        {"from": 2, "port": "l", "to": 3, "input": "in"},
        {"from": 3, "to": 5, "input": "a"},
        {"from": 4, "to": 5, "input": "b"},
        {"from": 5, "to": 6, "input": "a"},
        {"from": 6, "to": 7, "input": "a"},
        {"from": 1, "port": "l", "to": 8, "input": "a"},
        {"from": 7, "to": 8, "input": "b"},
        {"from": 1, "port": "r", "to": 9, "input": "a"},
        {"from": 7, "to": 9, "input": "b"},
        {"from": 8, "to": 10, "input": "l"},
        {"from": 9, "to": 10, "input": "r"},
    ],
}

unused = {
    "nodes": [
        {"id": 1, "type": "note"},
        {"id": 2, "type": "mtof"},
        {"id": 3, "type": "osc", "wave": "square"},
        {"id": 4, "type": "out"},
    ],
    "edges": [
        {"from": 1, "port": "pitch", "to": 2, "input": "in"},
        {"from": 2, "to": 3, "input": "freq"},
        {"from": 3, "to": 4, "input": "l"},
    ],
}


def phrase(notes: list[int]) -> list[dict]:
    return [
        {"tick": i * 240, "note": n, "vel": 100, "dur": 200}
        for i, n in enumerate(notes)
    ]


song = {
    "ppq": 480,
    "tempo": [{"tick": 0, "bpm": 140}],
    "clips": [
        {
            "id": "lead-a",
            "length": 1920,
            "notes": phrase([57, 60, 64, 67, 69, 67, 64, 60]),
            "automation": [
                {"param": 1, "tick": 0, "value": 500},
                {"param": 1, "tick": 0, "value": 2400, "ramp": 1800},
            ],
        },
        {
            "id": "pluck-a",
            "length": 1920,
            "notes": [
                {"tick": 0, "note": 48, "vel": 120, "dur": 400},
                {"tick": 480, "note": 55, "vel": 100, "dur": 400},
                {"tick": 960, "note": 48, "vel": 120, "dur": 400},
                {"tick": 1440, "note": 60, "vel": 100, "dur": 400},
            ],
        },
        {
            "id": "never-placed",
            "length": 480,
            "notes": [{"tick": 0, "note": 60, "vel": 100, "dur": 100}],
        },
    ],
    "tracks": [
        {
            "id": 1,
            "name": "Lead",
            "voices": 4,
            "slots": ["lead"],
            "params": {"1": 1200},
            "gain": 0.8,
            "pan": -0.2,
            "placements": [{"clip": "lead-a", "tick": 0, "repeat": 4}],
            "sends": [{"bus": "room", "gain": 0.35}],
            "inserts": [{"id": 1, "patch": "ducker", "key": "track:2"}],
        },
        {
            "id": 2,
            "name": "Pluck",
            "voices": 3,
            "slots": ["pluck"],
            "gain": 0.9,
            "pan": 0.2,
            "placements": [{"clip": "pluck-a", "tick": 0, "repeat": 4}],
            "sends": [{"bus": "room", "gain": 0.2}],
        },
    ],
    "buses": [{"id": "room", "inserts": [{"id": 2, "patch": "reverb"}]}],
    "master": {"gain": 0.9},
}

ballad = {
    "ppq": 480,
    "tempo": [{"tick": 0, "bpm": 84}],
    "clips": [
        {
            "id": "pad",
            "length": 3840,
            "notes": [
                {"tick": 0, "note": n, "vel": 80, "dur": 3600} for n in (52, 59, 64)
            ],
        }
    ],
    "tracks": [
        {
            "id": 1,
            "name": "Pad",
            "voices": 4,
            "slots": ["lead"],
            "gain": 0.7,
            "placements": [{"clip": "pad", "tick": 0, "repeat": 2}],
            "sends": [{"bus": "room", "gain": 0.5}],
        }
    ],
    "buses": [{"id": "room", "inserts": [{"id": 2, "patch": "reverb"}]}],
    "master": {"gain": 0.9},
}

demo = {
    "patches": {
        "lead": {"name": "Stereo lead", "graph": lead},
        "pluck": {"name": "Sampled pluck", "graph": pluck_voice},
        "reverb": {"name": "Room", "graph": reverb},
        "ducker": {"name": "Sidechain ducker", "graph": ducker},
        "unused": {
            "name": "Square, in the library but on no timeline",
            "graph": unused,
        },
    },
    "assets": {
        "pluck": {
            "name": "Pluck",
            "encoding": "i16",
            "channels": 1,
            "rate": RATE,
            "frames": FRAMES,
            "root_key": 60,
            "loop_start": 0,
            "loop_end": 0,
            "data": pluck(),
        }
    },
    "programs": [
        {"id": "song", "name": "Song", "timeline": song},
        {"id": "ballad", "name": "Ballad", "timeline": ballad},
    ],
}

Path(__file__).with_name("Demo.json").write_text(json.dumps(demo, indent=1) + "\n")
