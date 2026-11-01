"""Wrote AllOps.json, a project built to use every opcode, instruction and mixer step in revision 0 of the format.

It sounds like nothing in particular, and that is fine. Its job is to pin what each one does. The images in this directory
never change: a later revision adds a new project alongside this one. See docs/Format.md.
"""

import base64
import json
import math
import struct
from pathlib import Path

RATE = 48000


def tone(frames: int, cycles: float, channels: int) -> list[float]:
    samples = []
    for i in range(frames):
        fade = 1.0 - i / frames
        for c in range(channels):
            samples.append(
                0.7 * fade * math.sin(2 * math.pi * cycles * (c + 1) * i / frames)
            )
    return samples


def i16(samples: list[float]) -> str:
    return base64.b64encode(
        struct.pack(f"<{len(samples)}h", *(round(s * 32767) for s in samples))
    ).decode()


def f32(samples: list[float]) -> str:
    return base64.b64encode(struct.pack(f"<{len(samples)}f", *samples)).decode()


kitchen = {
    "params": [
        {
            "id": 1,
            "name": "cutoff",
            "scope": "track",
            "min": 80,
            "max": 12000,
            "default": 1500,
            "smooth_ms": 5,
        },
        {
            "id": 2,
            "name": "bright",
            "scope": "voice",
            "min": 0,
            "max": 1,
            "default": 0.5,
        },
        {
            "id": 3,
            "name": "drift",
            "scope": "global",
            "min": 0,
            "max": 1,
            "default": 0.25,
        },
    ],
    "nodes": [
        {"id": 1, "type": "note"},
        {"id": 2, "type": "mtof"},  # KMtoF on a voice
        {"id": 3, "type": "param", "param": 1},
        {"id": 4, "type": "param", "param": 2},
        {"id": 5, "type": "param", "param": 3},
        {"id": 6, "type": "lfo", "inputs": {"rate": 3.0}},  # KLfo, hoisted
        {"id": 7, "type": "add"},  # KAdd, hoisted
        {"id": 8, "type": "mul", "inputs": {"b": 40.0}},  # KMul, hoisted
        {"id": 9, "type": "osc", "wave": "sine"},
        {"id": 10, "type": "osc", "wave": "saw"},
        {"id": 11, "type": "noise"},
        {"id": 12, "type": "mul"},  # Mul
        {"id": 13, "type": "mul"},  # MulS
        {"id": 14, "type": "add"},  # Add
        {"id": 15, "type": "add", "inputs": {"b": 0.05}},  # AddS
        {
            "id": 16,
            "type": "env",
            "inputs": {"attack": 0.004, "decay": 0.08, "sustain": 0.6, "release": 0.05},
        },
        {"id": 17, "type": "biquad", "mode": "lowpass", "inputs": {"q": 3.0}},
        {
            "id": 18,
            "type": "biquad",
            "mode": "highpass",
            "inputs": {"cutoff": 2000.0, "q": 0.8},
        },
        {
            "id": 19,
            "type": "mul",
            "inputs": {"b": 3000.0},
        },  # Scale the envelope to a cutoff
        {"id": 20, "type": "biquad", "mode": "bandpass", "inputs": {"q": 1.5}},  # KSnap
        {"id": 21, "type": "ratio", "root": 60},  # KRatio
        {"id": 22, "type": "sample", "asset": "loop-i16-mono"},
        {
            "id": 23,
            "type": "delay",
            "max": 0.1,
            "inputs": {"time": 0.01},
        },  # Feed-forward
        {"id": 24, "type": "add"},
        {"id": 25, "type": "delay", "max": 0.1, "inputs": {"time": 0.03}},  # Feedback
        {"id": 26, "type": "mul", "inputs": {"b": 0.4}},
        {"id": 27, "type": "comb", "max": 0.05, "inputs": {"time": 0.02}},
        {"id": 28, "type": "allpass", "max": 0.02, "inputs": {"time": 0.007}},
        {"id": 29, "type": "follow", "inputs": {"release": 0.05}},
        {"id": 30, "type": "mul"},
        {"id": 31, "type": "add"},
        {"id": 32, "type": "pan"},  # Fill, since a scalar drives an audio input
        {"id": 33, "type": "mul"},
        {"id": 34, "type": "add"},
        {"id": 35, "type": "add"},
        {"id": 36, "type": "out"},
    ],
    "edges": [
        {"from": 1, "port": "pitch", "to": 2, "input": "in"},
        {"from": 1, "port": "pitch", "to": 21, "input": "in"},
        {"from": 5, "to": 6, "input": "depth"},
        {"from": 3, "to": 7, "input": "a"},
        {"from": 6, "to": 7, "input": "b"},
        {"from": 5, "to": 8, "input": "a"},
        {"from": 2, "to": 9, "input": "freq"},
        {"from": 2, "to": 10, "input": "freq"},
        {"from": 9, "to": 12, "input": "a"},
        {"from": 10, "to": 12, "input": "b"},
        {"from": 10, "to": 13, "input": "a"},
        {"from": 4, "to": 13, "input": "b"},
        {"from": 12, "to": 14, "input": "a"},
        {"from": 13, "to": 14, "input": "b"},
        {"from": 14, "to": 15, "input": "a"},
        {"from": 15, "to": 17, "input": "in"},
        {"from": 7, "to": 17, "input": "cutoff"},
        {"from": 11, "to": 18, "input": "in"},
        {"from": 16, "to": 19, "input": "a"},
        {"from": 18, "to": 20, "input": "in"},
        {"from": 19, "to": 20, "input": "cutoff"},
        {"from": 21, "to": 22, "input": "ratio"},
        {"from": 20, "to": 23, "input": "in"},
        {"from": 23, "to": 24, "input": "a"},
        {"from": 26, "to": 24, "input": "b"},
        {"from": 24, "to": 25, "input": "in"},
        {"from": 25, "to": 26, "input": "a"},
        {"from": 24, "to": 27, "input": "in"},
        {"from": 27, "to": 28, "input": "in"},
        {"from": 17, "to": 29, "input": "in"},
        {"from": 28, "to": 30, "input": "a"},
        {"from": 29, "to": 30, "input": "b"},
        {"from": 8, "to": 32, "input": "position"},
        {"from": 4, "to": 32, "input": "in"},
        {"from": 32, "port": "l", "to": 33, "input": "a"},
        {"from": 16, "to": 33, "input": "b"},
        {"from": 17, "to": 31, "input": "a"},
        {"from": 30, "to": 31, "input": "b"},
        {"from": 31, "to": 34, "input": "a"},
        {"from": 33, "to": 34, "input": "b"},
        {"from": 22, "port": "l", "to": 35, "input": "a"},
        {"from": 34, "to": 35, "input": "b"},
        {"from": 35, "to": 36, "input": "l"},
        {"from": 34, "to": 36, "input": "r"},
    ],
}


def sampler(asset: str) -> dict:
    return {
        "nodes": [
            {"id": 1, "type": "note"},
            {"id": 2, "type": "ratio", "root": 60},
            {"id": 3, "type": "sample", "asset": asset},
            {"id": 4, "type": "out"},
        ],
        "edges": [
            {"from": 1, "port": "pitch", "to": 2, "input": "in"},
            {"from": 2, "to": 3, "input": "ratio"},
            {"from": 3, "port": "l", "to": 4, "input": "l"},
            {"from": 3, "port": "r", "to": 4, "input": "r"},
        ],
    }


# Reads the same global as `kitchen`, from a track whose task is independent of that one. If a step could write a global, task
# order would change this track's sound, which is the case section 18 of the design exists to rule out.
shared = sampler("loop-i16-stereo")
shared["params"] = [
    {"id": 3, "name": "drift", "scope": "global", "min": 0, "max": 1, "default": 0.25}
]
shared["nodes"] = [
    {"id": 1, "type": "note"},
    {"id": 2, "type": "ratio", "root": 60},
    {"id": 3, "type": "sample", "asset": "loop-i16-stereo"},
    {"id": 4, "type": "param", "param": 3},
    {"id": 5, "type": "mul"},
    {"id": 6, "type": "mul"},
    {"id": 7, "type": "out"},
]
shared["edges"] = [
    {"from": 1, "port": "pitch", "to": 2, "input": "in"},
    {"from": 2, "to": 3, "input": "ratio"},
    {"from": 3, "port": "l", "to": 5, "input": "a"},
    {"from": 3, "port": "r", "to": 6, "input": "a"},
    {"from": 4, "to": 5, "input": "b"},
    {"from": 4, "to": 6, "input": "b"},
    {"from": 5, "to": 7, "input": "l"},
    {"from": 6, "to": 7, "input": "r"},
]

space = {
    "nodes": [
        {"id": 1, "type": "in"},
        {"id": 2, "type": "allpass", "max": 0.02, "inputs": {"time": 0.011}},
        {"id": 3, "type": "allpass", "max": 0.02, "inputs": {"time": 0.013}},
        {"id": 4, "type": "out"},
    ],
    "edges": [
        {"from": 1, "port": "l", "to": 2, "input": "in"},
        {"from": 1, "port": "r", "to": 3, "input": "in"},
        {"from": 2, "to": 4, "input": "l"},
        {"from": 3, "to": 4, "input": "r"},
    ],
}

ducker = {
    "params": [{"id": 1, "name": "depth", "scope": "track", "default": 0.6}],
    "nodes": [
        {"id": 1, "type": "in", "index": 0},
        {"id": 2, "type": "in", "index": 1},
        {"id": 3, "type": "follow", "inputs": {"release": 0.1}},
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

timeline = {
    "ppq": 480,
    "tempo": [{"tick": 0, "bpm": 240}, {"tick": 720, "bpm": 300}],
    "globals": {"3": 0.5},
    "clips": [
        {
            "id": "two-slots",
            "length": 480,
            "notes": [
                {"tick": 0, "note": 57, "vel": 110, "dur": 200},
                {"tick": 120, "note": 72, "vel": 90, "dur": 60, "slot": 1},
                {"tick": 240, "note": 64, "vel": 100, "dur": 200},
            ],
            "automation": [
                {"param": 1, "tick": 0, "value": 600},
                {"param": 1, "tick": 60, "value": 3000, "ramp": 300},
            ],
        },
        {
            "id": "held",
            "length": 960,
            "notes": [{"tick": 0, "note": 60, "vel": 100, "dur": 800}],
        },
        {
            "id": "ticks",
            "length": 240,
            "notes": [
                {"tick": 0, "note": 67, "vel": 120, "dur": 40},
                {"tick": 120, "note": 55, "vel": 100, "dur": 40},
            ],
        },
    ],
    "tracks": [
        {
            "id": 1,
            "name": "Kitchen",
            "voices": 3,
            "slots": ["kitchen", "stereo-f32"],
            "params": {"1": 900},
            "gain": 0.7,
            "pan": -0.3,
            "placements": [
                {"clip": "two-slots", "tick": 0, "repeat": 2},
                {"clip": "two-slots", "tick": 1200},
            ],
            "sends": [{"bus": "room", "gain": 0.4}],
            "inserts": [{"id": 1, "patch": "ducker", "key": "track:3"}],
        },
        {
            "id": 2,
            "name": "Loop",
            "voices": 2,
            "slots": ["stereo-i16"],
            "gain": 0.5,
            "pan": 0.4,
            "placements": [{"clip": "held", "tick": 0, "repeat": 2}],
            "sends": [{"bus": "room", "gain": 0.3}],
        },
        {
            "id": 3,
            "name": "Short",
            "voices": 2,
            "slots": ["short-f32"],
            "gain": 0.6,
            "placements": [{"clip": "ticks", "tick": 0, "repeat": 8}],
        },
    ],
    "buses": [{"id": "room", "inserts": [{"id": 2, "patch": "space"}]}],
    "master": {"gain": 0.8},
}

project = {
    "patches": {
        "kitchen": {"name": "Every kernel", "graph": kitchen},
        "stereo-f32": {
            "name": "One-shot, f32 stereo",
            "graph": sampler("hit-f32-stereo"),
        },
        "stereo-i16": {"name": "Loop, i16 stereo", "graph": shared},
        "short-f32": {"name": "Tiny loop, f32 mono", "graph": sampler("tiny-f32-mono")},
        "space": {"name": "Two allpasses", "graph": space},
        "ducker": {"name": "Sidechain ducker", "graph": ducker},
    },
    "assets": {
        "loop-i16-mono": {
            "name": "Loop, i16 mono",
            "encoding": "i16",
            "channels": 1,
            "rate": 24000,
            "frames": 400,
            "root_key": 60,
            "loop_start": 100,
            "loop_end": 300,
            "data": i16(tone(400, 8, 1)),
        },
        "hit-f32-stereo": {
            "name": "One-shot, f32 stereo",
            "encoding": "f32",
            "channels": 2,
            "rate": 48000,
            "frames": 600,
            "root_key": 60,
            "loop_start": 0,
            "loop_end": 0,
            "data": f32(tone(600, 12, 2)),
        },
        "loop-i16-stereo": {
            "name": "Loop, i16 stereo",
            "encoding": "i16",
            "channels": 2,
            "rate": 44100,
            "frames": 300,
            "root_key": 60,
            "loop_start": 0,
            "loop_end": 300,
            "data": i16(tone(300, 6, 2)),
        },
        "tiny-f32-mono": {
            "name": "Tiny loop, f32 mono",
            "encoding": "f32",
            "channels": 1,
            "rate": RATE,
            "frames": 32,
            "root_key": 60,
            "loop_start": 8,
            "loop_end": 24,
            "data": f32(tone(32, 1, 1)),
        },
    },
    "programs": [{"id": "all", "name": "All ops", "timeline": timeline}],
}

Path(__file__).with_name("AllOps.json").write_text(json.dumps(project, indent=1) + "\n")
