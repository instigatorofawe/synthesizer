# /// script
# requires-python = ">=3.12,<3.14"
# dependencies = ["numpy", "soundcard"]
# ///
"""Plays the oscillators and the recipes through the sound card.

Each oscillator is a scale over six octaves, then a sweep up to the top of the keyboard. Aliasing is easiest to hear on the
sweep, as tones that fall while the note rises. The recipes in examples/Recipes are short pieces made of the same parts, from
a detuned supersaw to a drum loop. Turn your volume down before the first run.

    uv run examples/Listen.py                 # every oscillator, about 95 seconds
    uv run examples/Listen.py saw square      # only these
    uv run examples/Listen.py --mode naive    # only this mode
    uv run examples/Listen.py --gain 0.05     # quieter
    uv run examples/Listen.py --list          # the recipes, and what to listen for
    uv run examples/Listen.py Kick808 Reverb  # any recipes or oscillators, by name
    uv run examples/Listen.py --group drums   # one group of recipes
    uv run examples/Listen.py --recipes       # all of them, about 4 minutes

This renders with the native tools, because the Python binding has no engine in it yet:

    cmake -B build/native
    cmake --build build/native --target modsynth_compile modsynth_render
"""

import argparse
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundcard

ROOT = Path(__file__).resolve().parent.parent
RECIPES = ROOT / "examples" / "Recipes"
RECIPE_PEAK = (
    0.45  # Each recipe is rendered to this, so --gain sets where its peak lands
)
RATE = 48000
BLOCK = 128
TICKS_PER_SECOND = 960  # 480 ticks per beat at 120 bpm

SCALE = [36, 48, 60, 72, 84, 96]
SCALE_STEP = 480
SWEEP_START = len(SCALE) * SCALE_STEP
SWEEP_TICKS = 6720
SWEEP_SEMITONES = 84  # from C2 up to C9, about 8.4 kHz
TOTAL_TICKS = SWEEP_START + SWEEP_TICKS + SCALE_STEP

# Sine and triangle have one form, and pwm is a square whose width moves. Tone is a sine that keeps the pitch its note
# started with, so its sweep stays on one note.
SOUNDS = {
    "sine": {"wave": "sine", "modes": [None]},
    "tone": {"wave": "sine", "modes": ["fixed"]},
    "saw": {"wave": "saw"},
    "square": {"wave": "square"},
    "pwm": {"wave": "square", "moving_width": True},
    "triangle": {"wave": "triangle", "modes": [None]},
}
MODES = ["bandlimited", "naive"]


def find_tool(name: str) -> Path:
    for folder in ("build/native", "build/tools"):
        if (ROOT / folder / name).exists():
            return ROOT / folder / name
    sys.exit(f"{name} is not built. See the build commands at the top of {__file__}.")


def patch(sound: dict, mode: str | None) -> dict:
    """A note, plus a bend the timeline ramps for the sweep, into one oscillator and an envelope."""
    oscillator = {"id": 5, "type": "osc", "wave": sound["wave"]}
    if mode:
        oscillator["mode"] = mode
    nodes = [
        {"id": 1, "type": "note"},
        {"id": 2, "type": "param", "param": 1},
        {"id": 3, "type": "add"},
        {"id": 4, "type": "mtof"},
        oscillator,
        {
            "id": 6,
            "type": "env",
            "inputs": {
                "attack": 0.003,
                "decay": 0.01,
                "sustain": 1.0,
                "release": 0.02,
            },
        },
        {"id": 7, "type": "mul"},
        {"id": 8, "type": "out"},
    ]
    edges = [
        {"from": 1, "port": "pitch", "to": 3, "input": "a"},
        {"from": 2, "to": 3, "input": "b"},
        {"from": 3, "to": 4, "input": "in"},
        {"from": 4, "to": 5, "input": "freq"},
        {"from": 5, "to": 7, "input": "a"},
        {"from": 6, "to": 7, "input": "b"},
        {"from": 7, "to": 8, "input": "l"},
    ]
    if sound.get("moving_width"):
        nodes += [
            {"id": 9, "type": "lfo", "inputs": {"rate": 1.5, "depth": 0.35}},
            {"id": 10, "type": "add", "inputs": {"b": 0.5}},
        ]
        edges += [
            {"from": 9, "to": 10, "input": "a"},
            {"from": 10, "to": 5, "input": "width"},
        ]
    bend = {
        "id": 1,
        "name": "bend",
        "scope": "track",
        "min": 0,
        "max": SWEEP_SEMITONES,
        "default": 0,
        "smooth_ms": 0,
    }
    return {"params": [bend], "nodes": nodes, "edges": edges}


def project(sound: dict, mode: str | None, gain: float) -> dict:
    notes = [
        {"tick": i * SCALE_STEP, "note": note, "vel": 100, "dur": SCALE_STEP - 60}
        for i, note in enumerate(SCALE)
    ]
    notes.append(
        {"tick": SWEEP_START, "note": SCALE[0], "vel": 100, "dur": SWEEP_TICKS}
    )
    clip = {
        "id": "demo",
        "length": TOTAL_TICKS,
        "notes": notes,
        "automation": [
            {"param": 1, "tick": 0, "value": 0},
            {"param": 1, "tick": SWEEP_START, "value": 0},
            {
                "param": 1,
                "tick": SWEEP_START,
                "value": SWEEP_SEMITONES,
                "ramp": SWEEP_TICKS,
            },
        ],
    }
    timeline = {
        "ppq": 480,
        "tempo": [{"tick": 0, "bpm": 120}],
        "clips": [clip],
        "tracks": [
            {
                "id": 1,
                "voices": 1,
                "slots": ["sound"],
                "placements": [{"clip": "demo", "tick": 0}],
            }
        ],
        "master": {"gain": gain},
    }
    return {
        "patches": {"sound": {"name": "Listen", "graph": patch(sound, mode)}},
        "programs": [{"id": "demo", "name": "Demo", "timeline": timeline}],
    }


def render_request(request: Path, blocks: int, channels: int) -> np.ndarray:
    """One row per sample. modsynth_render writes each channel's block in turn."""
    with tempfile.TemporaryDirectory() as folder:
        image = Path(folder) / "out.image"
        samples = Path(folder) / "out.f32"
        subprocess.run([find_tool("modsynth_compile"), request, image], check=True)
        subprocess.run(
            [find_tool("modsynth_render"), image, samples, str(blocks), str(channels)],
            check=True,
        )
        audio = np.fromfile(samples, dtype="<f4")
    return audio.reshape(-1, channels, BLOCK).transpose(0, 2, 1).reshape(-1, channels)


def render(sound: dict, mode: str | None, gain: float) -> np.ndarray:
    blocks = TOTAL_TICKS * RATE // TICKS_PER_SECOND // BLOCK
    with tempfile.TemporaryDirectory() as folder:
        request = Path(folder) / "request.json"
        request.write_text(json.dumps(project(sound, mode, gain)))
        return render_request(request, blocks, 1)


def render_recipe(recipe: dict, gain: float) -> np.ndarray:
    blocks = math.ceil(recipe["seconds"] * RATE / BLOCK)
    return render_request(RECIPES / recipe["file"], blocks, 2) * (gain / RECIPE_PEAK)


def list_recipes(recipes: list[dict]) -> None:
    for group in sorted({r["group"] for r in recipes}):
        print(group)
        for recipe in recipes:
            if recipe["group"] == group:
                print(f"  {recipe['name']:32}{recipe['listen_for']}")


def main() -> None:
    recipes = json.loads((RECIPES / "Index.json").read_text())
    by_name = {recipe["name"]: recipe for recipe in recipes}
    groups = sorted({recipe["group"] for recipe in recipes})

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "sounds", nargs="*", help=f"any of {', '.join(SOUNDS)}, or a recipe"
    )
    parser.add_argument("--mode", choices=MODES, help="play only this mode")
    parser.add_argument("--gain", type=float, default=0.2, help="default 0.2")
    parser.add_argument("--list", action="store_true", help="list the recipes")
    parser.add_argument("--recipes", action="store_true", help="play every recipe")
    parser.add_argument("--group", choices=groups, help="play one group of recipes")
    args = parser.parse_args()
    if unknown := set(args.sounds) - set(SOUNDS) - set(by_name):
        parser.error(f"unknown sound: {', '.join(sorted(unknown))}")
    if args.list:
        list_recipes(recipes)
        return

    chosen = [by_name[name] for name in args.sounds if name in by_name]
    chosen += [r for r in recipes if args.recipes or r["group"] == args.group]
    named = [name for name in args.sounds if name in SOUNDS]
    oscillators = named or ([] if chosen else list(SOUNDS))

    speaker = soundcard.default_speaker()
    print(f"Playing through {speaker.name}. Ctrl-C stops.")
    for name in oscillators:
        sound = SOUNDS[name]
        for mode in sound.get("modes", MODES):
            if mode and args.mode and mode != args.mode:
                continue
            print(f"{name} {mode or ''}".strip(), flush=True)
            speaker.play(render(sound, mode, args.gain), samplerate=RATE)
    for recipe in chosen:
        print(f"{recipe['name']}: {recipe['listen_for']}", flush=True)
        speaker.play(render_recipe(recipe, args.gain), samplerate=RATE)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
