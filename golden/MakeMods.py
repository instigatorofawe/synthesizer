"""Wrote Mods.json, a project that uses every mode of what revision 6 added: OscMod, Math, KMath and Shape.

Like AllOps it sounds like nothing in particular. Its job is to pin what each one does on every target, so it stays small enough
for an L476. Each is reached by a graph, as an author would, so this also pins which op a graph gets.
"""

import json
from pathlib import Path


def graph(nodes: list[dict], edges: list[tuple]) -> dict:
    return {
        "nodes": nodes,
        "edges": [{"from": f, "port": p, "to": t, "input": i} for f, p, t, i in edges],
    }


# Each wave, each moved a different way, with a slave saw synced to a sine and a sine pushing another sine's frequency and phase.
waves = graph(
    [
        {"id": 1, "type": "note"},
        {"id": 2, "type": "mtof"},
        {
            "id": 3,
            "type": "env",
            "inputs": {"attack": 0.002, "decay": 0.05, "sustain": 0.8, "release": 0.04},
        },
        {
            "id": 4,
            "type": "osc",
            "wave": "sine",
            "mode": "mod",
            "inputs": {"feedback": 0.2},
        },
        {"id": 5, "type": "mul", "inputs": {"b": 900.0}},
        {"id": 6, "type": "add"},
        {"id": 7, "type": "osc", "wave": "sine", "mode": "mod"},
        {
            "id": 8,
            "type": "osc",
            "wave": "saw",
            "mode": "mod",
            "inputs": {"freq": 1300.0},
        },
        {
            "id": 9,
            "type": "osc",
            "wave": "saw",
            "mode": "mod-naive",
            "inputs": {"freq": 1700.0},
        },
        {"id": 10, "type": "osc", "wave": "triangle", "mode": "mod"},
        {"id": 11, "type": "osc", "wave": "square", "mode": "mod"},
        {
            "id": 12,
            "type": "osc",
            "wave": "square",
            "mode": "mod-naive",
            "inputs": {"width": 0.3},
        },
        {"id": 13, "type": "lfo", "inputs": {"rate": 3.0, "depth": 0.3}},
        {"id": 14, "type": "add", "inputs": {"b": 0.5}},
        {"id": 15, "type": "add"},
        {"id": 16, "type": "add"},
        {"id": 17, "type": "add"},
        {"id": 18, "type": "add"},
        {"id": 19, "type": "add"},
        {"id": 20, "type": "mul"},
        {"id": 21, "type": "mul", "inputs": {"b": 0.15}},
        {"id": 22, "type": "out"},
    ],
    [
        (1, "pitch", 2, "in"),
        (2, "out", 4, "freq"),
        (4, "out", 5, "a"),
        (5, "out", 6, "a"),
        (2, "out", 6, "b"),
        (6, "out", 7, "freq"),
        (4, "out", 7, "phase"),
        (4, "out", 8, "sync"),
        (4, "out", 9, "sync"),
        (2, "out", 10, "freq"),
        (4, "out", 10, "phase"),
        (2, "out", 11, "freq"),
        (13, "out", 14, "a"),
        (14, "out", 11, "width"),
        (2, "out", 12, "freq"),
        (7, "out", 15, "a"),
        (8, "out", 15, "b"),
        (15, "out", 16, "a"),
        (9, "out", 16, "b"),
        (16, "out", 17, "a"),
        (10, "out", 17, "b"),
        (17, "out", 18, "a"),
        (11, "out", 18, "b"),
        (18, "out", 19, "a"),
        (12, "out", 19, "b"),
        (19, "out", 20, "a"),
        (3, "out", 20, "b"),
        (20, "out", 21, "a"),
        (21, "out", 22, "l"),
    ],
)

# Every math mode twice, once on audio and once on scalars, then a curve. Each scalar result moves a filter, so none of them is dead.
SOFT = [-0.9, -0.8, -0.6, -0.3, 0.0, 0.3, 0.6, 0.8, 0.9]
MODES = ["min", "max", "abs", "clip", "floor", "divide", "compare", "select"]
nodes = [
    {"id": 1, "type": "note"},
    {"id": 2, "type": "mtof"},
    {
        "id": 3,
        "type": "env",
        "inputs": {"attack": 0.002, "decay": 0.05, "sustain": 0.8, "release": 0.04},
    },
    {"id": 4, "type": "osc", "wave": "triangle"},
    {"id": 5, "type": "mul", "inputs": {"b": 3.0}},
    {"id": 6, "type": "noise"},
    {"id": 7, "type": "mul", "inputs": {"b": 0.25}},
]
edges = [
    (1, "pitch", 2, "in"),
    (2, "out", 4, "freq"),
    (4, "out", 5, "a"),
    (6, "out", 7, "a"),
]
chain = 7
next_id = 8
for mode in MODES:
    audio = next_id
    nodes.append(
        {"id": audio, "type": "math", "mode": mode, "inputs": {"b": 0.4, "c": 0.8}}
    )
    edges.append((5, "out", audio, "a"))
    if mode == "abs" or mode == "floor":
        nodes[-1].pop("inputs")
    total = next_id + 1
    nodes.append({"id": total, "type": "add"})
    edges += [(chain, "out", total, "a"), (audio, "out", total, "b")]
    chain = total
    next_id += 2
scalars = next_id
total = 1
for offset, mode in enumerate(MODES):
    node = scalars + offset * 2
    nodes.append({"id": node, "type": "math", "mode": mode})
    if mode not in ("abs", "floor"):
        nodes[-1]["inputs"] = {"b": 0.4, "c": 0.8}
    edges.append((1, "velocity", node, "a"))
    sum_node = node + 1
    nodes.append({"id": sum_node, "type": "add", "inputs": {"a": 0.5}})
    if offset:
        edges.append((sum_node - 2, "out", sum_node, "a"))
    edges.append((node, "out", sum_node, "b"))
scale = scalars + len(MODES) * 2
filter_id = scale + 1
shape = scale + 2
gain = scale + 3
level = scale + 4
out = scale + 5
nodes += [
    {"id": scale, "type": "mul", "inputs": {"b": 900.0}},
    {"id": filter_id, "type": "biquad", "inputs": {"q": 1.2}},
    {"id": shape, "type": "shape", "curve": SOFT},
    {"id": gain, "type": "mul"},
    {"id": level, "type": "mul", "inputs": {"b": 0.2}},
    {"id": out, "type": "out"},
]
edges += [
    (scale - 1, "out", scale, "a"),
    (chain, "out", filter_id, "in"),
    (scale, "out", filter_id, "cutoff"),
    (filter_id, "out", shape, "in"),
    (shape, "out", gain, "a"),
    (3, "out", gain, "b"),
    (gain, "out", level, "a"),
    (level, "out", out, "l"),
    (level, "out", out, "r"),
]
sums = graph(nodes, edges)

notes = [
    {"tick": t, "note": n, "vel": v, "dur": 110}
    for t, n, v in [(0, 48, 100), (120, 60, 70), (240, 55, 120), (360, 67, 90)]
]
timeline = {
    "ppq": 480,
    "tempo": [{"tick": 0, "bpm": 120}],
    "clips": [{"id": "c", "length": 480, "notes": notes}],
    "tracks": [
        {
            "id": 1,
            "name": "waves",
            "voices": 2,
            "slots": ["waves"],
            "placements": [{"clip": "c", "tick": 0, "repeat": 2}],
        },
        {
            "id": 2,
            "name": "sums",
            "voices": 2,
            "slots": ["sums"],
            "placements": [{"clip": "c", "tick": 60, "repeat": 2}],
        },
    ],
}
project = {
    "patches": {
        "waves": {"name": "waves", "graph": waves},
        "sums": {"name": "sums", "graph": sums},
    },
    "programs": [{"id": "mods", "name": "mods", "timeline": timeline}],
}
Path(__file__).with_name("Mods.json").write_text(json.dumps(project, indent=1) + "\n")
