# /// script
# requires-python = ">=3.12,<3.14"
# dependencies = ["numpy", "modsynth"]
#
# [tool.uv.sources]
# modsynth = { path = "..", editable = false }
# ///
"""Writes examples/Instruments: the standard set of instruments, drums and effects that a MIDI file is played on.

Each module in examples/Sounds defines INSTRUMENTS, EFFECTS or both, which Instrument.py describes. This wraps every
instrument in the set's parameters, measures it, sets its level so that every one plays a note at the same loudness, and
writes:
- one example per family (Piano.json, DrumKit.json, Effects.json and so on), whose tracks play its instruments in turn;
- Index.json, which lists those examples as the browser does the recipes;
- GeneralMidi.json, which instrument plays each GM program and percussion key, and which effects CC 91 and CC 93 reach.

    uv run examples/MakeInstruments.py              # every module in examples/Sounds
    uv run examples/MakeInstruments.py Keys Drums   # rewrite only these modules' families; the tables come from every one
    uv run examples/MakeInstruments.py --check      # measure everything and write nothing
    uv run examples/MakeInstruments.py --wav DIR    # also write each family's example as DIR/<Family>.wav, to listen to

It prints what it measured for each instrument: the gain it set, how loud its lowest and highest notes are against its middle
one, its peak at full velocity, how long it rings after its note ends, and what a voice costs to render here.
"""

import importlib.util
import json
import math
import re
import sys
import time
import wave
from pathlib import Path

import modsynth
import numpy as np
from GeneralMidi import (
    CHOKES,
    DRUM_KIT,
    DRUMS,
    EFFECTS,
    FAMILIES,
    HELD,
    PROGRAMS,
    family_of,
)
from Graph import Graph, dump
from Instrument import EXPRESSION, PARAMS, Effect, Instrument, Phrase, Voice

HERE = Path(__file__).resolve().parent
SOUNDS = HERE / "Sounds"
OUT = HERE / "Instruments"
PPQ = 480
RATE = 48000
BPM = 100.0
PREFIX = "builtin-gm-"  # A set's patch is in every library as this and its name
LOUDNESS = -24.0  # Where a note at velocity 100 in the middle of an instrument's range peaks, as momentary loudness (LUFS)
PEAK = 0.45  # Where each example's peak lands, as the recipes' and pieces' do
COST = 25.0  # Nanoseconds a voice may take per sample here before it is reported
EFFECT_SOURCE = (
    "GrandPiano"  # What plays into the effects' examples, when the set has it
)

# Patches ------------------------------------------------------------------------------------------------------------


def wrap(instrument: Instrument, gain: float) -> dict:
    """The instrument's graph as the set plays it: the four parameters, its sound, then expression squared and its gain."""
    g = Graph()
    g.params = [dict(p) for p in PARAMS]
    voice = Voice(g)
    sound = instrument.build(voice)
    left, right = sound if isinstance(sound, tuple) else (sound, None)
    expression = voice.param(EXPRESSION)
    level = g.mul(g.mul(expression, expression), gain)
    g.out(g.mul(left, level), None if right is None else g.mul(right, level))
    return g.json()


def effect_graph(effect: Effect) -> dict:
    g = Graph()
    sound = effect.build(g, g.node("in"))
    left, right = sound if isinstance(sound, tuple) else (sound, None)
    g.out(left, right)
    return g.json()


def audition_tone() -> dict:
    """What the effects' examples play when the set has no EFFECT_SOURCE: a plucked saw, short enough to hear a tail."""
    g = Graph()
    key = g.node("note")
    tone = g.filter("lowpass", g.osc("saw", g.mtof(key.pitch)), 2400.0)
    g.out(g.mul(g.mul(tone, g.env(0.002, 0.4, 0.0, 0.1)), g.mul(key.velocity, 0.3)))
    return g.json()


# Projects -----------------------------------------------------------------------------------------------------------


def beats(n: float) -> int:
    return round(n * PPQ)


def clip(id: str, phrase: Phrase, slot: dict[int, int] | None = None) -> dict:
    """A clip of a phrase, whole bars long with a bar after it to ring into. `slot` gives a kit's notes their sounds."""
    end = max(beat + held for beat, _, _, held in phrase)
    notes = []
    for beat, note, velocity, held in sorted(phrase, key=lambda n: (n[0], n[1])):
        entry = {
            "tick": beats(beat),
            "note": note,
            "vel": velocity,
            "dur": max(1, beats(held)),
        }
        if slot is not None:
            entry["slot"] = slot[note]
        notes.append(entry)
    return {"id": id, "length": beats(4 * (math.ceil(end / 4) + 1)), "notes": notes}


def project(
    name: str,
    patches: dict,
    tracks: list,
    clips: list,
    buses: list | None = None,
    gain: float = 1.0,
) -> dict:
    timeline = {
        "ppq": PPQ,
        "tempo": [{"tick": 0, "bpm": BPM}],
        "clips": clips,
        "tracks": tracks,
        "buses": buses or [],
        "master": {"gain": gain},
    }
    return {
        "patches": patches,
        "programs": [{"id": name.lower(), "name": name, "timeline": timeline}],
    }


def track(
    id: int,
    name: str,
    voices: int,
    slots: list[str],
    clips: list[tuple[str, int]],
    **more,
) -> dict:
    placements = [{"clip": c, "tick": tick} for c, tick in clips]
    return {
        "id": id,
        "name": name,
        "voices": voices,
        "slots": slots,
        "placements": placements,
    } | more


def one_note(
    graph: dict, note: int, velocity: int, held: float, voices: int = 1
) -> dict:
    """A project that plays one patch: a note, or a chord when `note` is a list."""
    notes = note if isinstance(note, list) else [note]
    phrase = [(0.0, n, velocity, held) for n in notes]
    return project(
        "measure",
        {"p": {"name": "p", "graph": graph}},
        [track(1, "p", max(voices, len(notes)), ["p"], [("c", 0)])],
        [clip("c", phrase)],
    )


def render(request: dict, seconds: float | None = None) -> np.ndarray:
    audio = modsynth.render(modsynth.compile_image(request), seconds, rate=RATE)
    if not np.isfinite(audio).all():
        raise ValueError("renders a value that isn't finite")
    return audio


# Measuring ----------------------------------------------------------------------------------------------------------

# ITU-R BS.1770's K-weighting at 48 kHz: a shelf for the head, then a high-pass.
K = [
    (
        [1.53512485958697, -2.69169618940638, 1.19839281085285],
        [1.0, -1.69065929318241, 0.73248077421585],
    ),
    ([1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621]),
]


def loudness(audio: np.ndarray) -> float:
    """The loudest 400 ms of K-weighted audio, as BS.1770's momentary loudness, in LUFS. -inf for silence."""
    frames = (
        len(audio) + RATE
    )  # A second of padding, so the filters' tails don't wrap round
    z = np.exp(-1j * np.linspace(0.0, np.pi, frames // 2 + 1))
    response = np.ones_like(z)
    for b, a in K:
        response *= np.polyval(b[::-1], z) / np.polyval(a[::-1], z)
    weighted = np.fft.irfft(
        np.fft.rfft(audio, frames, axis=0) * response[:, None], frames, axis=0
    )[: len(audio)]
    power = (weighted**2).sum(axis=1)
    window, hop = int(0.4 * RATE), int(0.1 * RATE)
    if len(power) < window:
        power = np.pad(power, (0, window - len(power)))
    sums = np.concatenate([[0.0], np.cumsum(power)])
    starts = np.arange(0, len(power) - window + 1, hop)
    most = ((sums[starts + window] - sums[starts]) / window).max()
    return -math.inf if most <= 0 else -0.691 + 10 * math.log10(most)


def middle(instrument: Instrument) -> int:
    return (
        instrument.keys[0]
        if instrument.keys
        else (instrument.low + instrument.high) // 2
    )


def held(instrument: Instrument) -> float:
    """How long, in beats, the note it is measured with is held: a drum's is struck, an instrument's held for 1.5 s."""
    return 0.2 if instrument.keys else 2.5


def measure(instrument: Instrument) -> tuple[float, list[str], list[str]]:
    """The gain that puts the instrument at the set's loudness, what was measured, and what looks wrong."""
    trouble: list[str] = []
    plain = wrap(instrument, 1.0)
    reference = render(one_note(plain, middle(instrument), 100, held(instrument)))
    measured = loudness(reference)
    if not math.isfinite(measured):
        raise ValueError("is silent")
    gain = float(f"{10 ** ((LOUDNESS + instrument.level - measured) / 20):.4g}")
    graph = wrap(instrument, gain)
    notes: list[str] = []

    if not instrument.keys:
        spread = []
        for note in (instrument.low, instrument.high):
            level = loudness(render(one_note(graph, note, 100, held(instrument)))) - (
                LOUDNESS + instrument.level
            )
            spread.append(f"{level:+.1f}")
            if abs(level) > 9:
                trouble.append(f"note {note} plays {level:+.1f} dB from its middle")
        notes.append(f"ends {'/'.join(spread)} dB")

    loud = render(one_note(graph, middle(instrument), 127, held(instrument)))
    peak = float(np.abs(loud).max())
    notes.append(f"peak {peak:.2f}")
    if peak > 0.9:
        trouble.append(f"peaks at {peak:.2f} at full velocity")
    offset = float(np.abs(loud.mean(axis=0)).max())
    if offset > 0.01:
        trouble.append(f"has a DC offset of {offset:.3f}")

    # How long it sounds after its note ends, to where it falls below -80 dB for good.
    audible = np.nonzero(np.abs(reference).max(axis=1) > 1e-4)[0]
    rings = max(0.0, (audible[-1] + 1) / RATE - held(instrument) * 60 / BPM)
    notes.append(f"rings {rings:.1f} s")
    if instrument.gated and rings > 4.0:
        trouble.append(f"rings {rings:.1f} s after its note ends")

    count = min(instrument.voices, 8)
    chord = [
        instrument.low + (instrument.high - instrument.low) * i // max(1, count - 1)
        for i in range(count)
    ]
    if instrument.keys:
        chord = [middle(instrument)] * count
    image = modsynth.compile_image(one_note(graph, chord, 100, 16.0, voices=count))
    start = time.perf_counter()
    modsynth.render(image, 4.0, rate=RATE)
    cost = (time.perf_counter() - start) / (4.0 * RATE) / count * 1e9
    notes.append(f"{cost:.1f} ns a voice")
    if cost > COST:
        trouble.append(f"costs {cost:.1f} ns a voice-sample, more than {COST:.0f}")
    return gain, notes, trouble


# The set ------------------------------------------------------------------------------------------------------------


def camel(text: str) -> str:
    return "".join(
        word[:1].upper() + word[1:] for word in re.split(r"[^A-Za-z0-9]+", text) if word
    )


def load_modules(names: list[str] | None = None) -> dict[str, object]:
    modules = {}
    sys.path.insert(0, str(SOUNDS))
    for path in sorted(SOUNDS.glob("*.py")):
        if names is not None and path.stem not in names:
            continue
        spec = importlib.util.spec_from_file_location(f"sounds_{path.stem}", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        modules[path.stem] = module
    return modules


def check(modules: dict[str, object]) -> tuple[list[Instrument], list[Effect]]:
    """Every instrument and effect, once its names, programs and keys have been checked against the rest of the set."""
    instruments = [i for m in modules.values() for i in getattr(m, "INSTRUMENTS", [])]
    effects = [e for m in modules.values() for e in getattr(m, "EFFECTS", [])]
    problems = []
    names = [x.name for x in instruments + effects]
    for name in {n for n in names if names.count(n) > 1}:
        problems.append(f"{name} is named twice")
    for name in names:
        if not re.fullmatch(r"[A-Z][A-Za-z0-9]*", name):
            problems.append(f"{name} isn't UpperCamelCase")
    taken: dict[int, str] = {}
    keys: dict[int, str] = {}
    for i in instruments:
        if i.family == DRUM_KIT:
            if i.programs or not i.keys:
                problems.append(f"{i.name} is a drum, so it plays keys and no programs")
        elif i.family not in FAMILIES:
            problems.append(f"{i.name}'s family {i.family!r} isn't one of GM's")
        elif i.keys:
            problems.append(
                f"{i.name} plays percussion keys but isn't in the {DRUM_KIT}"
            )
        for p in i.programs:
            if not 0 <= p < 128 or family_of(p) != i.family:
                problems.append(
                    f"{i.name} plays program {p}, which isn't in its family, {i.family}"
                )
            elif p in taken:
                problems.append(
                    f"program {p} is played by both {taken[p]} and {i.name}"
                )
            taken[p] = i.name
        for k in i.keys:
            if k not in DRUMS:
                problems.append(
                    f"{i.name} plays key {k}, which isn't a GM percussion key"
                )
            elif k in keys:
                problems.append(f"key {k} is played by both {keys[k]} and {i.name}")
            keys[k] = i.name
        if not 0 <= i.low <= i.high <= 127:
            problems.append(f"{i.name}'s range {i.low} to {i.high} isn't one")
    for kind in ("reverb", "chorus"):
        chosen = [e.name for e in effects if e.send == kind]
        if len(chosen) > 1:
            problems.append(f"{', '.join(chosen)} all say they are the {kind}")
    if problems:
        sys.exit("The set has problems:\n  " + "\n  ".join(sorted(problems)))
    return instruments, effects


def tables(instruments: list[Instrument], effects: list[Effect]) -> dict:
    by_program = {p: i.name for i in instruments for p in i.programs}
    by_key = {k: i.name for i in instruments for k in i.keys}
    sends = {
        kind: next((e.name for e in effects if e.send == kind), None)
        for kind in ("reverb", "chorus")
    }
    return {
        "prefix": PREFIX,
        "params": {p["name"]: p["id"] for p in PARAMS},
        "defaults": {p["name"]: p["default"] for p in PARAMS},
        "programs": [
            {
                "program": p,
                "name": name,
                "family": family_of(p),
                "instrument": by_program.get(p),
            }
            for p, name in enumerate(PROGRAMS)
        ],
        "drums": [
            {"note": k, "name": name, "instrument": by_key.get(k)}
            for k, name in DRUMS.items()
        ],
        "chokes": CHOKES,
        "held": HELD,
        "effects": sends,
    }


def default_phrase(instrument: Instrument) -> Phrase:
    if instrument.keys:
        return [(i * 0.5, k, 100, 0.25) for i, k in enumerate(instrument.keys)]
    centre = (instrument.low + instrument.high) // 2
    root = centre - centre % 12
    if root < instrument.low:
        root += 12
    if root + 12 > instrument.high:
        root = max(instrument.low, instrument.high - 12)
    phrase = [
        (i * 0.5, root + step, 92 if i % 2 else 100, 0.45)
        for i, step in enumerate([0, 2, 4, 5, 7, 9, 11, 12])
    ]
    chord = [0, 4, 7] if instrument.voices >= 3 else [0]
    return phrase + [
        (4.0, root + c, 100, 2.0) for c in chord if root + c <= instrument.high
    ]


def family_example(
    family: str, members: list[Instrument], graphs: dict[str, dict]
) -> dict:
    patches = {i.name: {"name": i.title, "graph": graphs[i.name]} for i in members}
    clips, tracks, at = [], [], 0
    for n, i in enumerate(members, 1):
        c = clip(i.name, i.phrase or default_phrase(i))
        clips.append(c)
        tracks.append(track(n, i.title, i.voices, [i.name], [(c["id"], at)]))
        at += c["length"]
    return project(family, patches, tracks, clips)


def kit_example(drums: list[Instrument], graphs: dict[str, dict]) -> dict:
    """One track holding every drum, whose notes choose their sound by key as a kit's do (the `kit` the editor reads)."""
    patches = {d.name: {"name": d.title, "graph": graphs[d.name]} for d in drums}
    slot = {k: n for n, d in enumerate(drums) for k in d.keys}
    order = sorted(slot)
    tour = [(i * 0.5, k, 100, 0.25) for i, k in enumerate(order)]
    start = math.ceil(len(order) / 8) * 4 + 4
    groove = []
    for bar in range(2):
        for eighth in range(8):
            beat = start + bar * 4 + eighth * 0.5
            if 42 in slot:
                groove.append((beat, 42, 90 if eighth % 2 else 110, 0.25))
            if eighth in (0, 5) and 36 in slot:
                groove.append((beat, 36, 120, 0.25))
            if eighth in (2, 6) and 38 in slot:
                groove.append((beat, 38, 115, 0.25))
    c = clip("kit", tour + groove, slot)
    kit = [{"note": k, "name": DRUMS[k], "slot": slot[k]} for k in order]
    tracks = [
        track(1, "Drum kit", 16, [d.name for d in drums], [(c["id"], 0)], kit=kit)
    ]
    return project("DrumKit", patches, tracks, [c])


def effects_example(effects: list[Effect], source: tuple[str, str, dict]) -> dict:
    key, title, graph = source
    patches = {key: {"name": title, "graph": graph}} | {
        e.name: {"name": e.title, "graph": effect_graph(e)} for e in effects
    }
    phrase = [
        (0.0, 60, 100, 0.5),
        (1.0, 64, 96, 0.5),
        (2.0, 67, 100, 0.5),
        (3.0, 72, 110, 1.0),
    ]
    clips, tracks, buses, at = [], [], [], 0
    for n, e in enumerate(effects, 1):
        c = clip(f"{e.name}-phrase", phrase)
        c["length"] += beats(8)  # Two more bars, for a tail
        clips.append(c)
        if e.insert:
            more = {"inserts": [{"id": 100 + n, "patch": e.name}]}
        else:
            buses.append({"id": e.name, "inserts": [{"id": 100 + n, "patch": e.name}]})
            more = {"sends": [{"bus": e.name, "gain": 1.0}]}
        tracks.append(track(n, e.title, 8, [key], [(c["id"], at)], **more))
        at += c["length"]
    return project("Effects", patches, tracks, clips, buses)


def finish(request: dict, wav: Path | None = None) -> tuple[dict, float]:
    """The example with its master gain set so its peak lands at PEAK, and how long it plays. `wav` gets it as 16-bit
    audio, at that gain."""
    audio = render(request)
    gain = round(PEAK / float(np.abs(audio).max()), 4)
    request["programs"][0]["timeline"]["master"]["gain"] = gain
    if wav is not None:
        with wave.open(str(wav), "wb") as out:
            out.setnchannels(audio.shape[1])
            out.setsampwidth(2)
            out.setframerate(RATE)
            out.writeframes(
                (np.clip(audio * gain, -1, 1) * 32767).astype("<i2").tobytes()
            )
    return request, math.ceil(len(audio) / RATE * 4) / 4


def read_set() -> dict[str, dict]:
    """Every patch of the set as it was last written, by name, for the pieces to play the same graphs."""
    graphs = {}
    for entry in json.loads((OUT / "Index.json").read_text()):
        for name, patch in json.loads((OUT / entry["file"]).read_text())[
            "patches"
        ].items():
            graphs[name] = patch["graph"]
    return graphs


def main() -> None:
    argv = sys.argv[1:]
    wavs = None
    if "--wav" in argv:
        at = argv.index("--wav")
        wavs = Path(argv[at + 1]).resolve()
        wavs.mkdir(parents=True, exist_ok=True)
        del argv[at : at + 2]
    args = [a for a in argv if not a.startswith("--")]
    dry = "--check" in argv
    every = load_modules()
    if unknown := set(args) - set(every):
        sys.exit(f"no such module in examples/Sounds: {', '.join(sorted(unknown))}")
    instruments, effects = check(every)
    chosen = check({k: v for k, v in every.items() if not args or k in args})
    families = [
        f for f in [*FAMILIES, DRUM_KIT] if any(i.family == f for i in chosen[0])
    ]
    if chosen[1]:
        families.append(EFFECTS)
    for name in families:
        if (HERE / "Recipes" / f"{camel(name)}.json").exists() or (
            HERE / "Pieces" / f"{camel(name)}.json"
        ).exists():
            sys.exit(f"{camel(name)} is already an example's name")

    graphs: dict[str, dict] = {}
    seen: dict[str, str] = {}
    failed = False
    for i in chosen[0]:
        try:
            gain, notes, trouble = measure(i)
        except (ValueError, modsynth.CompileError) as error:
            print(f"{i.name}: {error}")
            failed = True
            continue
        graphs[i.name] = wrap(i, gain)
        same = json.dumps(graphs[i.name], sort_keys=True)
        if same in seen:
            print(
                f"{i.name}: the same graph as {seen[same]}, so the library would hold one patch for both"
            )
            failed = True
        seen[same] = i.name
        print(
            f"{i.name}: gain {gain}, {', '.join(notes)}"
            + "".join(f"\n  ! {t}" for t in trouble)
        )
    if failed:
        sys.exit("Nothing was written.")
    if dry:
        return

    OUT.mkdir(exist_ok=True)
    index_path = OUT / "Index.json"
    index = (
        {e["family"]: e for e in json.loads(index_path.read_text())}
        if index_path.exists()
        else {}
    )
    for family in families:
        members = [i for i in chosen[0] if i.family == family]
        if family == EFFECTS:
            source = next((i for i in instruments if i.name == EFFECT_SOURCE), None)
            if source is not None:
                graph = graphs.get(source.name) or wrap(source, measure(source)[0])
                request = effects_example(chosen[1], (source.name, source.title, graph))
            else:
                request = effects_example(
                    chosen[1], ("AuditionTone", "Audition tone", audition_tone())
                )
            listen = (
                "Each effect in turn, on the same phrase: "
                + ", ".join(e.title for e in chosen[1])
                + "."
            )
        elif family == DRUM_KIT:
            request = kit_example(members, graphs)
            listen = "Every drum of the kit in turn, by its GM key, and then a groove on the kit."
        else:
            request = family_example(camel(family), members, graphs)
            listen = (
                f"The set's {family.lower()} instruments in turn: "
                + ", ".join(i.title for i in members)
                + "."
            )
        name = camel(family)
        request, seconds = finish(request, wavs / f"{name}.wav" if wavs else None)
        (OUT / f"{name}.json").write_text(dump(request) + "\n")
        index[family] = {
            "name": name,
            "file": f"{name}.json",
            "seconds": seconds,
            "group": "instruments",
            "family": family,
            "listen_for": listen,
        }
        print(f"{name}: {seconds} s")
    order = [*FAMILIES, DRUM_KIT, EFFECTS]
    ordered = sorted(
        (e for e in index.values() if (OUT / e["file"]).exists()),
        key=lambda e: order.index(e["family"]),
    )
    index_path.write_text(json.dumps(ordered, indent=1, ensure_ascii=False) + "\n")
    (OUT / "GeneralMidi.json").write_text(dump(tables(instruments, effects)) + "\n")
    missing = [p for p in range(128) if not any(p in i.programs for i in instruments)]
    if missing:
        print(f"{len(missing)} of 128 programs have no instrument yet")


if __name__ == "__main__":
    main()
