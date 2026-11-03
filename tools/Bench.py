#!/usr/bin/env python3
"""Builds and runs the benchmarks, and writes docs/Benchmarks.md from what they report.

    tools/Bench.py host    Google Benchmark on this machine, into build/bench/Host.json
    tools/Bench.py m4      Cortex-M4 instruction counts on QEMU, into build/bench/M4.json, and what each Program's
                           frames did, counted on this machine, into build/bench/Work.json
    tools/Bench.py table   docs/Benchmarks.md from those two
    tools/Bench.py calibrate SCALAR CMSIS --output N --date D
                           firmware/Profiles/Calibration.json, from the board's cycles for the same Programs
    tools/Bench.py baseline  bench/M4.json and bench/Work.json from the last m4, then the cost table from them
    tools/Bench.py costs   firmware/NucleoCosts.hpp from the baseline and the calibration
    tools/Bench.py check   fails if a count moved from the baseline, or the cost table isn't the baseline's

m4 needs what firmware/Check.sh needs, so on a Mac run it in a container and copy M4.json back.
"""

import argparse
import json
import math
import re
import statistics
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build" / "bench"
RECIPES = ROOT / "examples" / "Recipes"
OVERHEAD = (
    ROOT / "bench" / "Overhead"
)  # The cheapest possible voice, to tell the engine's cost from its kernels'
OVERHEAD_FRAMES = 1500
CALIBRATION = (
    BUILD / "Calibration"
)  # Programs that each lean on one kind of work, from bench/MakeCalibration.py
TABLE = ROOT / "docs" / "Benchmarks.md"
# Recipes added since the board last timed every recipe, docs/Board.md, so their Board column is the compiler's bound alone.
NOT_ON_BOARD = {
    "AutoWah",
    "ChipTune",
    "ClipVariations",
    "HardSync",
    "LeanDrumKit",
    "ReleaseSamples",
    "ReverseSwell",
    "RoundRobin",
    "SmallRoom",
    "Subpatches",
    "TapeEcho",
    "TempoRamp",
    "TwoOperatorFm",
}

FRAME = 32
RATE = 48000
BUILDS = {
    "Stereo": "BenchStereo",
    "Mono": "BenchMono",
    "Cmsis": "BenchCmsis",
    "MonoCmsis": "BenchMonoCmsis",  # The board's two builds are the mono ones
}


def run(
    *command: object, check: bool = True, **options: object
) -> subprocess.CompletedProcess:
    return subprocess.run([str(c) for c in command], check=check, **options)


def configure_host() -> None:
    run(
        "cmake",
        "-S",
        ROOT,
        "-B",
        BUILD,
        "-DCMAKE_BUILD_TYPE=Release",
        "-DMODSYNTH_BUILD_BENCH=ON",
        "-DMODSYNTH_BUILD_TESTS=OFF",
        "-DMODSYNTH_INSTALL=OFF",
    )


def host(arguments: argparse.Namespace) -> None:
    configure_host()
    run("cmake", "--build", BUILD, "--target", "modsynth_bench")
    run(
        BUILD / "modsynth_bench",
        f"--benchmark_min_time={arguments.seconds}s",
        f"--benchmark_out={BUILD / 'Host.json'}",
        "--benchmark_out_format=json",
    )


def indexed(folder: Path) -> list[tuple[str, Path, int]]:
    """The Programs an Index.json lists, each with the frames it is measured for."""
    return [
        (r["name"], folder / r["file"], int(r["seconds"] * RATE / FRAME))
        for r in json.loads((folder / "Index.json").read_text())
    ]


def compile_recipes() -> Path:
    """Compiles every recipe and calibration Program, writes the file firmware/Bench.cpp includes to link them, and
    counts what each one's frames do."""
    run("cmake", "--build", BUILD, "--target", "modsynth_compile", "modsynth_work")
    run(sys.executable, ROOT / "bench" / "MakeCalibration.py", CALIBRATION)
    images = BUILD / "images"
    images.mkdir(parents=True, exist_ok=True)
    recipes = indexed(RECIPES)
    recipes += [
        (path.stem, path, OVERHEAD_FRAMES) for path in sorted(OVERHEAD.glob("*.json"))
    ]
    recipes += indexed(CALIBRATION)
    links, rows, work = [], [], []
    for i, (name, request, frames) in enumerate(recipes):
        image = images / f"{name}.image"
        run(BUILD / "modsynth_compile", request, image)
        links.append(f'MODSYNTH_LINK_IMAGE(g_{i}, "{image}")')
        rows.append(f'    {{"{name}", g_{i}, g_{i}_end, {frames}u}},')
        work.append(f"{name} {image} {frames}\n")
    (BUILD / "Work.txt").write_text("".join(work))
    run(BUILD / "modsynth_work", BUILD / "Work.txt", BUILD / "Work.json")
    include = BUILD / "Recipes.inc"
    include.write_text(
        "\n".join(
            [
                *links,
                "namespace {",
                "constexpr Recipe kRecipes[] = {",
                *rows,
                "};",
                "}  // namespace",
                "",
            ]
        )
    )
    return include


def parse(output: str) -> dict:
    """The rows firmware/Bench.cpp prints, as a kernel table and a recipe table. Hundredths become plain numbers."""
    report = {"kernels": {}, "recipes": {}}
    for line in output.splitlines():
        kind, *fields = line.strip().split(",")
        if kind == "engine":
            report["engine_bytes"] = int(fields[1])
        elif kind == "clear":
            report["clear"] = int(fields[-1]) / 100  # instructions for each 64 bytes
        elif kind == "kernel":
            name = ",".join(fields[:-5])  # A name can hold a comma
            op, mode, still, first, value = (int(f) for f in fields[-5:])
            report["kernels"][name] = value / 100
            report.setdefault("cases", {})[name] = {
                "op": op,
                "mode": mode,
                "still": bool(still),
                "first": first,
            }
        elif kind == "recipe":
            name, image, fast, bulk, voices, frames, mean, p999, peak, load, guards = (
                fields
            )
            report["recipes"][name] = {
                "image": int(image),
                "fast": int(fast),
                "bulk": int(bulk),
                "voices": int(voices),
                "frames": int(frames),
                "mean": int(mean) / 100,
                "p999": int(p999) / 100,
                "peak": int(peak) / 100,
                "load": int(load),
                "guards": int(guards),
            }
        elif kind in ("refused", "fault"):
            sys.exit(f"Bench stopped: {line}")
    return report


def m4(_: argparse.Namespace) -> None:
    configure_host()
    include = compile_recipes()
    firmware = ROOT / "build" / "firmware"
    run(
        "cmake",
        "-S",
        ROOT / "firmware",
        "-B",
        firmware,
        "-G",
        "Ninja",
        f"--toolchain={ROOT / 'firmware' / 'ArmNoneEabi.cmake'}",
        "-DCMAKE_BUILD_TYPE=Release",
        f"-DMODSYNTH_BENCH_RECIPES={include}",
    )
    run("cmake", "--build", firmware, "--target", *BUILDS.values())
    version = run(
        "arm-none-eabi-g++", "--version", capture_output=True, text=True
    ).stdout.splitlines()[0]
    report = {"compiler": version, "builds": {}}
    for name, target in BUILDS.items():
        print(f"== {name}", flush=True)
        result = run(
            "qemu-system-arm",
            "-machine",
            "mps2-an386",
            "-cpu",
            "cortex-m4",
            "-nographic",
            "-monitor",
            "none",
            "-serial",
            "null",
            "-semihosting-config",
            "enable=on,target=native",
            "-icount",
            "shift=8,sleep=off",
            "-kernel",
            firmware / f"{target}.elf",
            capture_output=True,
            text=True,
        )
        report["builds"][name] = parse(result.stderr + result.stdout)
    (BUILD / "M4.json").write_text(json.dumps(report, indent=1) + "\n")


def board_fit(names: list[str]) -> dict[str, tuple[str, float, str]]:
    """Each recipe compiled for the board's scalar build: whether it fits, its dearest frame as a share of the budget,
    and how many voices each track could have, as the compiler works them out."""
    profile = json.loads((ROOT / "firmware" / "Profiles" / "Nucleo.json").read_text())
    unlimited = profile | {"cost": profile["cost"] | {"budget": 2**32 - 1}}
    request_path, image, report_path = (
        BUILD / "Fit.json",
        BUILD / "Fit.image",
        BUILD / "Fit.report.json",
    )

    def compile(name: str, target: dict) -> dict:
        request = json.loads((RECIPES / f"{name}.json").read_text())
        request["target"] = target
        request_path.write_text(json.dumps(request))
        run(
            BUILD / "modsynth_compile",
            request_path,
            image,
            report_path,
            check=False,
            capture_output=True,
        )
        return json.loads(report_path.read_text())

    fit = {}
    for name in names:
        report = compile(name, unlimited)
        if not report.get("ok"):
            fit[name] = ("RAM", math.nan, "")
            continue
        share = report["target"]["cycles"][0] / profile["cost"]["budget"]
        report = compile(name, profile)
        if report.get("ok"):
            voices = [t["fit"] for t in report["target"]["programs"][0]["voices"]]
        else:  # Over budget, which the error says track by track
            message = report["errors"][0]["message"]
            voices = [
                int(n) if n else 0
                for n in re.findall(
                    r"(?:fits with (\d+)|no number fits alone)", message
                )
            ]
        fit[name] = (
            "yes" if share <= 1 else "CPU",
            share,
            ", ".join(str(v) if v else "none" for v in voices),
        )
    return fit


def kernel_rows(stereo: dict, cmsis: dict, native: dict) -> list[str]:
    dispatch = stereo["kernels"]["Dispatch only"]
    rows = []
    for name, per_frame in stereo["kernels"].items():
        if name == "Dispatch only":
            continue
        above = (per_frame - dispatch) / FRAME
        with_cmsis = (
            cmsis["kernels"][name] - cmsis["kernels"]["Dispatch only"]
        ) / FRAME
        saved = f"{with_cmsis:.1f}" if abs(with_cmsis - above) >= 0.05 else "same"
        rows.append(
            f"| {name} | {above:.1f} | {saved} | {native[f'Kernel/{name}'] / FRAME:.2f} |"
        )
    return rows


def recipe_rows(
    stereo: dict, mono: dict, cmsis: dict, hosted: dict, groups: dict, fit: dict
) -> list[str]:
    rows = []
    for name, r in sorted(stereo["recipes"].items(), key=lambda item: -item[1]["peak"]):
        h = hosted[f"Recipe/{name}/manual_time"]
        verdict, share, voices = fit[name]
        if name in NOT_ON_BOARD:
            verdict += ", not measured on the board"
        bound = "" if math.isnan(share) else f"{share:.0%}"
        rows.append(
            f"| {name} | {groups[name]} | {r['image'] / 1024:.1f} | {(r['fast'] + r['bulk']) / 1024:.1f} | {r['voices']} "
            f"| {r['mean']:.0f} | {r['p999']:.0f} | {r['peak']:.0f} | {mono['recipes'][name]['peak']:.0f} "
            f"| {cmsis['recipes'][name]['peak']:.0f} | {bound} | {verdict} | {voices} "
            f"| {h['real_time'] / (r['frames'] * FRAME):.1f} | {h['p999_frame_ns'] / 1000:.1f} / {h['worst_frame_ns'] / 1000:.1f} |"
        )
    return rows


def cost_lines(mono: dict, work: dict) -> list[str]:
    """The board's cost table, term by term: instructions on QEMU, the board's cycles for each, and the price."""
    calibration = json.loads(CALIBRATION_FILE.read_text())
    ratios = calibration["builds"]["scalar"]["terms"]
    instr = instructions(mono, work)
    table = priced(mono, work, calibration["builds"]["scalar"], calibration["output"])
    rows = [
        f"| {key} | {max(instr[key], 0):.0f} | {ratios[pair]:.2f} | {table[key]} |"
        for key, pair in TERMS.items()
        if key != "glide"
    ]
    text = (
        f"What the NUCLEO-L476RG's scalar build refuses a Program by, from `firmware/NucleoCosts.hpp`. Its budget is "
        f"{table['budget']:,} cycles a frame: the core's {CORE_HZ * FRAME * TIMER_PERIOD // CORE_HZ:,} less "
        f"{calibration['output']:,} for playing a frame out. Each term is measured by a pair of calibration Programs, in "
        "instructions here and in cycles on the board, and priced at their ratio with "
        f"{MARGIN - 1:.0%} more. A step is priced at its dearest kernel row below, at its op's ratio."
    )
    return [
        text,
        "",
        "| Term | Instructions | Cycles an instruction | Price |",
        "|---|---:|---:|---:|",
        *rows,
    ]


def parallel_lines(hosted: dict) -> list[str]:
    """The pieces and the demo on a thread pool, from bench/ParallelBench.cpp."""
    runs = {}
    for name, b in hosted.items():
        if name.startswith("Parallel/"):
            _, program, frame, executor = name.split("/")[:4]
            runs[(program, frame, executor)] = b
    if not runs:
        return []
    rows = []
    for program, frame in sorted(
        {(p, f) for p, f, _ in runs}, key=lambda k: (k[0], int(k[1]))
    ):
        serial = runs[(program, frame, "serial")]
        cells = [
            f"{serial['frame_ns'] / 1000:.1f} / {serial['worst_frame_ns'] / 1000:.0f}"
        ]
        for workers in ("2", "4", "8"):
            r = runs[(program, frame, workers)]
            cells.append(
                f"{serial['frame_ns'] / r['frame_ns']:.2f}x / {r['worst_frame_ns'] / 1000:.0f}"
            )
        rows.append(f"| {program} | {frame} | " + " | ".join(cells) + " |")
    text = (
        "The first 20 s of each, on a pool of 2, 4 and 8 workers against the same engine run serially. Each cell is the "
        "speedup of the mean frame, then the worst frame in µs."
    )
    return [
        text,
        "",
        "| Program | Frame | Serial µs / worst | 2 workers | 4 workers | 8 workers |",
        "|---|---:|---:|---:|---:|---:|",
        *rows,
    ]


def engine_lines(stereo: dict, overhead: dict) -> list[str]:
    kernels = stereo["kernels"]
    silent, one, four = (
        overhead[name]["mean"] for name in ("Silent", "OneVoice", "FourVoices")
    )
    each = (four - one) / 3
    # Dispatch is per step, and this voice has two: its pitch and its saw.
    work = (
        kernels["Saw, naive"] - kernels["Dispatch only"] + kernels["KMtoF, still"]
    ) / FRAME
    text = (
        f"A Program with nothing to play costs {silent:.1f} instructions a sample. One voice of a naive saw, the cheapest voice "
        f"that makes a sound, costs {one:.1f}, and four cost {four:.1f}, so each voice after the first adds {each:.1f}. Its kernels "
        f"account for {work:.1f} of that, which leaves {each - work:.1f} on every voice whatever it plays: setting up its context, "
        "checking its output for non-finite samples, and adding it to the bus."
    )
    return [text]


def table(_: argparse.Namespace) -> None:
    m4_report = json.loads((BUILD / "M4.json").read_text())
    host_report = json.loads((BUILD / "Host.json").read_text())
    stereo, mono, cmsis = (m4_report["builds"][b] for b in ("Stereo", "Mono", "Cmsis"))
    overhead = {
        path.stem: stereo["recipes"].pop(path.stem) for path in OVERHEAD.glob("*.json")
    }
    shipped = {r["name"] for r in json.loads((RECIPES / "Index.json").read_text())}
    stereo = stereo | {
        "recipes": {n: r for n, r in stereo["recipes"].items() if n in shipped}
    }
    hosted = {b["name"]: b for b in host_report["benchmarks"]}
    native = {
        b["name"]: b["real_time"]
        for b in host_report["benchmarks"]
        if b["name"].startswith("Kernel/")
    }
    index = json.loads((RECIPES / "Index.json").read_text())
    groups = {r["name"]: r["group"] for r in index}
    recipes = list(stereo["recipes"].values())
    fit = board_fit(list(stereo["recipes"]))
    fits = sum(verdict == "yes" for verdict, _, _ in fit.values())
    work = json.loads((BUILD / "Work.json").read_text())
    commit = run(
        "git", "rev-parse", "--short", "HEAD", capture_output=True, text=True, cwd=ROOT
    ).stdout.strip()
    source = (
        f"Cortex-M4 counts come from `firmware/Bench.cpp` on QEMU's mps2-an386, built with {m4_report['compiler']} at -O2, "
        f"frame {FRAME}, {RATE} Hz. They are exact and repeat, so a change in one is a change in the code. Host figures come "
        f"from Google Benchmark on one core of {host_report['context'].get('host_name', 'one machine')}, and move from run to run."
    )
    caution = (
        "Section 17 of `docs/Design.md` applies: host figures rank kernels on that host only and are not carried to Cortex-M. "
        "What a frame costs the board in cycles comes from its own calibration, in the cost table below."
    )
    summary = (
        f"{fits} of {len(recipes)} compile for the NUCLEO-L476RG, whose loader refuses the same ones: the rest could need "
        "more cycles in a frame than it has, or more memory. Images have a median of "
        f"{statistics.median(r['image'] for r in recipes) / 1024:.1f} KB and RAM a median of "
        f"{statistics.median(r['fast'] + r['bulk'] for r in recipes) / 1024:.1f} KB. Loading one takes "
        f"{min(r['load'] for r in recipes):,} to {max(r['load'] for r in recipes):,} instructions."
    )
    if unmeasured := sorted(NOT_ON_BOARD & set(stereo["recipes"])):
        summary += (
            f" {len(unmeasured)} came after the board last timed every recipe, and are not measured on the board: "
            f"{', '.join(unmeasured)}."
        )
    columns = (
        "Instructions are per sample, stereo and scalar unless named. Peak is the worst frame of the whole recipe, played from "
        "start to end. Voices is the most that sounded at once on QEMU. Board is the compiler's bound on a frame for the "
        "board, with every voice sounding, as a share of its budget, and Voices that fit is how many each track could have "
        "with the others as they are. Host ns is per sample of the mean frame. A host's worst frame is mostly the "
        "operating system."
    )
    kernels = (
        f"One step at a time, per sample, on inputs a recipe gives it. A control step runs once a frame, so its figure is its "
        f"frame's cost over {FRAME}. Dispatch costs {stereo['kernels']['Dispatch only']:.1f} instructions a step on top of each "
        "row. CMSIS shows only where it differs. Every opcode has a row, because `bench/KernelCases.hpp` fails to compile otherwise."
    )
    lines = [
        "# Benchmarks",
        "",
        f"Generated by `tools/Bench.py` at `{commit}`. Change the tool, not this file.",
        "",
        source,
        "",
        caution,
        "",
        "## Recipes",
        "",
        summary,
        "",
        columns,
        "",
        "| Recipe | Group | Image KB | RAM KB | Voices | Mean | p99.9 | Peak | Peak, mono | Peak, CMSIS | Board | Fits | Voices that fit | Host ns | Host p99.9 / worst frame µs |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---:|---:|",
        *recipe_rows(stereo, mono, cmsis, hosted, groups, fit),
        "",
        "## Engine",
        "",
        *engine_lines(stereo, overhead),
        "",
        "## The board's cost table",
        "",
        *cost_lines(mono, work),
        "",
        "## Kernels",
        "",
        kernels,
        "",
        "| Kernel | Instructions | With CMSIS | Host ns |",
        "|---|---:|---:|---:|",
        *kernel_rows(stereo, cmsis, native),
        "",
    ]
    if parallel := parallel_lines(hosted):
        lines += ["## Parallel", "", *parallel, ""]
    TABLE.write_text("\n".join(lines))
    print(f"{TABLE.relative_to(ROOT)}: {fits} of {len(recipes)} fit")


# The cost table ---------------------------------------------------------------------------------------------------
#
# A board refuses a Program whose dearest frame could overrun, so it needs what each kind of work costs it in cycles,
# which is firmware/NucleoCosts.hpp. Each term is measured by a pair of calibration Programs that differ in that work
# alone, the same way twice: in instructions on QEMU, which CI can repeat exactly, and in cycles on the board. Their
# ratio is that work's cycles per instruction, which firmware/Profiles/Calibration.json keeps, so a change in the code
# reprices itself from QEMU without the board. Each step is priced at its dearest path in bench/KernelCases.hpp.

BASELINE = (
    ROOT / "bench" / "M4.json"
)  # The counts CI holds the code to, from the container firmware/Check.sh uses
BASELINE_WORK = ROOT / "bench" / "Work.json"
CALIBRATION_FILE = ROOT / "firmware" / "Profiles" / "Calibration.json"
COSTS_HEADER = ROOT / "firmware" / "NucleoCosts.hpp"
CORE_HZ = 80_000_000
TIMER_PERIOD = 1667  # firmware/Nucleo.cpp: the DAC's rate is the core's clock over this
BOARD_BUILDS = {
    "scalar": "Mono",
    "cmsis": "MonoCmsis",
}  # each of the board's builds, and its QEMU build
MARGIN = 1.1  # every price is this much above what was measured
SMALLEST = 5  # instructions below which a term's cycles per instruction can't be told from noise
TOLERANCE = 0.01  # how far a count may move from the baseline before CI fails
SAW = (
    "KMtoF, still",
    "Saw, naive",
)  # the steps of the voice every calibration Program plays
# The calibration Program that leans on each step, and the one it adds to.
OP_PROGRAMS = {
    "Noise": ("OpNoise", "Held4"),
    "Osc": ("OpOsc", "Held4"),
    "Saw": ("OpSaw", "Held4"),
    "Pulse": ("OpPulse", "Held4"),
    "Triangle": ("OpTriangle", "Held4"),
    "Tone": ("OpTone", "Held4"),
    "Biquad": ("OpBiquad", "Held4"),
    "Env": ("OpEnv", "Held4"),
    "Mul": ("OpMul", "Held4"),
    "MulS": ("OpMulS", "Held4"),
    "Add": ("OpAdd", "Held4"),
    "AddS": ("OpAddS", "Held4"),
    "Pan": ("OpPan", "Held4"),
    "DelayWrite": ("OpDelay", "Held4"),
    "DelayRead": ("OpDelay", "Held4"),
    "Comb": ("OpComb", "Held4"),
    "Allpass": ("OpAllpass", "Held4"),
    "DelayWriteI16": ("OpDelayI16", "Held4"),
    "DelayReadI16": ("OpDelayI16", "Held4"),
    "CombI16": ("OpCombI16", "Held4"),
    "AllpassI16": ("OpAllpassI16", "Held4"),
    "Follow": ("OpFollow", "Held4"),
    "KMtoF": ("OpKMtoF", "Held4"),
    "OscMod": ("OpOscMod", "Held2"),
    "Math": ("OpMathDivide", "Held4"),
    "Shape": ("OpShape", "Held4"),
    "Sample": ("OpSample", "Held4"),
    "Sample2": ("OpSample2", "Held4"),
    "Sample3": ("OpSample3", "Held4"),
}
# Costs' terms but its steps, in its order, and the pair each one's cycles per instruction comes from.
TERMS = {
    "frame": "frame",
    "segment": "segment",
    "track": "track",
    "voice": "voice",
    "run": "sounding",
    "fade": "sounding",
    "slot": "slot",
    "param": "param",
    "insert": "insert",
    "gather": "mix",
    "gather_input": "mix",
    "mix_register": "mix_register",
    "glide": "held",
    "held": "held",
    "instruction": "instruction",
    "note": "note",
    "note_voice": "note",
    "note_param": "note",
    "note_block": "note",
    "zone_row": "zone_row",
}


def opcodes() -> dict[str, int]:
    text = (ROOT / "include" / "modsynth" / "Opcodes.def").read_text()
    return {
        name: int(number)
        for name, number in re.findall(
            r"^MODSYNTH_OP\((\w+),\s*(\d+)", text, re.MULTILINE
        )
    }


def pairs(m, w) -> dict[str, float]:
    """What each kind of work costs a frame, from per-frame means `m(name)` of the calibration Programs, in
    instructions or in cycles, and what each one did, `w(name, count)`."""
    t = {}
    t["idle"] = (m("IdleVoices") - m("Idle")) / 63
    t["track"] = (m("Tracks") - m("Idle")) / 15 - t["idle"]
    t["frame"] = m("Idle") - t["track"] - t["idle"]
    t["slot"] = (m("Slots") - m("Idle")) / 7
    t["sounding"] = (
        m("Held16") - m("Held1")
    ) / 15  # A voice of the saw, its steps and all
    t["instruction"] = (m("SetParams") - m("IdleKnob")) / 8
    # Segments1 and Segments16 cut every frame into 4, with 8 instructions from the conductor.
    t["voice"] = ((m("Segments16") - m("Segments1")) - (m("Held16") - m("Held1"))) / (
        3 * 15
    )
    t["segment"] = (m("Segments1") - m("Held1") - 8 * t["instruction"]) / 3 - t["voice"]
    # 4 notes a frame, each with 3 instructions: its NoteOn, a Wait, and its clip's end.
    per_note = lambda voices: (m(f"Notes{voices}") - m(f"Held{voices}")) / 4
    t["note_voice"] = (per_note(8) - per_note(4)) / 4
    t["note"] = per_note(4) - 3 * t["instruction"] - 4 * t["note_voice"]
    t["note_param"] = (
        (m("NotesParams") - m("HeldParams")) - (m("Notes8") - m("Held8"))
    ) / (4 * 32)
    t["held"] = (m("Mono") - m("Poly")) / w("Mono", "held_notes")
    t["param"] = (m("Params") - m("Idle")) / 32
    t["insert"] = (m("Inserts") - m("Held1")) / 8
    # Buses1 adds one Gather and 17 inputs to Tracks, and Buses2 one of each to Buses1.
    a = (
        w("Buses1", "gathers") - w("Tracks", "gathers"),
        w("Buses1", "gather_inputs") - w("Tracks", "gather_inputs"),
    )
    b = (
        w("Buses2", "gathers") - w("Buses1", "gathers"),
        w("Buses2", "gather_inputs") - w("Buses1", "gather_inputs"),
    )
    da, db = m("Buses1") - m("Tracks"), m("Buses2") - m("Buses1")
    det = a[0] * b[1] - a[1] * b[0]
    t["gather"] = (da * b[1] - db * a[1]) / det
    t["gather_input"] = (a[0] * db - b[0] * da) / det
    t["mix"] = da / (a[0] + a[1])  # for pricing both, the whole of the first pair
    t["mix_register"] = (m("MixRamps") - m("MixStill")) / w("MixRamps", "mix_registers")
    t["zone_row"] = (m("Zones256") - m("Zones1")) / (
        w("Zones256", "zone_rows") - w("Zones1", "zone_rows")
    )
    t["fade"] = (m("Fades") - m("Notes4")) - t["sounding"]
    return t


def means(build: dict) -> callable:
    return lambda name: build["recipes"][name]["mean"] * FRAME


def counts(work: dict) -> callable:
    return lambda name, key: work[name]["mean"].get(key, 0.0)


# Modes of an op that cost much less than its dearest, which a step in that mode is priced at instead.
MONO, ONE_ZONE = 0x80, 0x40  # kMonoAssets and kOneZone in include/modsynth/Cost.hpp
CHEAP_MODES = {
    "Saw": [1],
    "Pulse": [1],
    "OscMod": [1, 2, 3, 4, 5],
    "Sample": [MONO],
    "Sample2": [MONO],
    "Sample3": [MONO, ONE_ZONE, MONO | ONE_ZONE],
}


def dearest(build: dict) -> dict[tuple[int, int | None, bool], float]:
    """The dearest kernel case of each opcode, in instructions a frame: (op, None, False) on any path, (op, None, True)
    with nothing it reads once a frame moving, and (op, mode, ...) the same for one of CHEAP_MODES."""
    ops = opcodes()
    cheap = {(ops[name], mode) for name, modes in CHEAP_MODES.items() for mode in modes}
    most = {}
    for case, per_frame in build["kernels"].items():
        c = build["cases"][case]
        if c["op"] == 0:
            continue
        keys = [(c["op"], None, False)] + (
            [(c["op"], None, True)] if c["still"] else []
        )
        if c["mode"] & (MONO | ONE_ZONE) and (c["op"], c["mode"]) not in cheap:
            pass  # a cheaper sampler in another mode is covered by its op's dearest
        elif (c["op"], c["mode"]) in cheap:
            keys = [(c["op"], c["mode"], False)] + (
                [(c["op"], c["mode"], True)] if c["still"] else []
            )
        for key in keys:
            most[key] = max(most.get(key, 0.0), per_frame)
    for (op, mode, still), value in list(most.items()):
        if mode is not None:  # The dearest of the op covers its cheap modes too
            most[(op, None, still)] = max(most.get((op, None, still), 0.0), value)
    for (op, mode, still), value in list(most.items()):
        if not still:  # A path with its inputs still is never dearer than its dearest
            most.setdefault((op, mode, True), value)
    return most


def instructions(build: dict, work: dict) -> dict:
    """Costs' terms in instructions, before pricing."""
    t = pairs(means(build), counts(work))
    k = build["kernels"]
    saw = sum(k[c] for c in SAW)
    # frame_cost() adds each of these on its own, so a term measured with one of them in it has it taken out. The frame
    # itself is Silent's dearest, a Program with nothing in it but the master's Gather, as it takes what the host sends
    # too, such as a board's Play and Locate.
    silent = build["recipes"]["Silent"]["peak"] * FRAME
    return {
        "frame": max(
            t["frame"] - t["gather"] - t["gather_input"] - t["slot"],
            silent - t["gather"],
        ),
        "segment": t["segment"],
        "track": t["track"] - t["slot"] - t["gather_input"],
        "voice": t["voice"],
        "run": t["sounding"] - saw - t["voice"],
        "fade": t["fade"],
        "slot": t["slot"],
        "param": t["param"],
        "insert": t["insert"] - k["MulS"] - t["slot"],
        "gather": t["gather"],
        "gather_input": t["gather_input"],
        "mix_register": t["mix_register"],
        "glide": 0.0,  # in `held`, which Mono and Poly measure with their glides
        "held": t["held"],
        "instruction": t["instruction"],
        "note": t["note"],
        "note_voice": t["note_voice"],
        "note_param": t["note_param"],
        "note_block": build["clear"],
        "zone_row": t["zone_row"],
    }


def calibrate(arguments: argparse.Namespace) -> None:
    """Prices each kind of work from the board's own cycles, against the same Programs' instructions on QEMU."""
    m4_report = json.loads((BUILD / "M4.json").read_text())
    work = json.loads((BUILD / "Work.json").read_text())
    builds = {}
    for backend, path in (("scalar", arguments.scalar), ("cmsis", arguments.cmsis)):
        board = json.loads(Path(path).read_text())
        qemu = m4_report["builds"][BOARD_BUILDS[backend]]
        cycles = pairs(lambda n, board=board: float(board[n]["mean"]), counts(work))
        instr = pairs(means(qemu), counts(work))
        # A term too small to measure, as a frame's extra piece is, takes the dearest ratio of the rest.
        ratio = {
            key: cycles[key] / instr[key]
            for key in sorted(set(TERMS.values()))
            if instr[key] > SMALLEST
        }
        ratio |= {
            key: max(ratio.values()) for key in set(TERMS.values()) if key not in ratio
        }
        ratio = dict(sorted(ratio.items()))
        ops = {}
        for op, (program, base) in OP_PROGRAMS.items():
            ops[op] = (float(board[program]["mean"]) - float(board[base]["mean"])) / (
                means(qemu)(program) - means(qemu)(base)
            )
        builds[backend] = {
            "terms": {k: round(v, 3) for k, v in ratio.items()},
            "steps": {k: round(v, 3) for k, v in sorted(ops.items())},
        }
        print(backend, "cycles per instruction:", builds[backend])
    CALIBRATION_FILE.write_text(
        json.dumps(
            {
                "board": "NUCLEO-L476RG",
                "measured": arguments.date,
                "output": arguments.output,
                "builds": builds,
            },
            indent=1,
        )
        + "\n"
    )
    print(f"wrote {CALIBRATION_FILE.relative_to(ROOT)}")


def priced(build: dict, work: dict, calibration: dict, output: int) -> dict:
    """A Costs table in cycles: each term's instructions, at its own cycles per instruction, with the margin."""
    rate = CORE_HZ / TIMER_PERIOD
    budget = math.floor(CORE_HZ * FRAME / rate) - output
    instr = instructions(build, work)
    terms = {
        key: max(
            math.ceil(max(instr[key], 0.0) * calibration["terms"][pair] * MARGIN), 0
        )
        for key, pair in TERMS.items()
    }
    steps = calibration["steps"]
    fallback = max(
        steps.values()
    )  # A step no calibration Program leans on is priced as the dearest that one did
    most = dearest(build)
    ops = opcodes()
    names = {number: name for name, number in ops.items()}
    price = lambda op, mode, still: math.ceil(
        most[(op, mode, still)] * steps.get(names[op], fallback) * MARGIN
    )
    step = [0] * (max(ops.values()) + 1)
    still = [0] * (max(ops.values()) + 1)
    for number in names:
        step[number] = price(number, None, False)
        still[number] = price(number, None, True)
    modes = [
        [op, mode, price(op, mode, False), price(op, mode, True)]
        for op, mode, flag in sorted(k for k in most if k[1] is not None and not k[2])
    ]
    # A step's dearest first frame, which it runs in the frame its note starts
    first = [0] * (max(ops.values()) + 1)
    for c in build["cases"].values():
        if c["op"] != 0:
            first[c["op"]] = max(first[c["op"]], c["first"])
    first = [
        math.ceil(v * steps.get(names.get(op, ""), fallback) * MARGIN)
        for op, v in enumerate(first)
    ]
    return {
        "budget": budget,
        **terms,
        "step": step,
        "still": still,
        "first": first,
        "modes": modes,
    }


def header(tables: dict) -> str:
    lines = [
        "// What a frame costs the NUCLEO-L476RG, which it refuses a Program by. Generated by `tools/Bench.py costs` from this",
        "// build's instructions on QEMU, priced at what each kind of work took a cycle on the board, which",
        "// firmware/Profiles/Calibration.json holds. Change the tool, not this file. A budget of 0 means not measured yet,",
        "// and then nothing is refused.",
        "#pragma once",
        "",
        "#include <modsynth/Cost.hpp>",
        "",
    ]
    for name, table in tables.items():
        fields = [
            f"    .{key} = {value},"
            for key, value in table.items()
            if key not in ("step", "still", "first", "modes")
        ]
        modes = ", ".join(
            f"{{{op}, {mode}, {moving}, {still}}}"
            for op, mode, moving, still in table["modes"]
        )
        lines += [
            f"inline constexpr modsynth::Costs {name}{{",
            *fields,
            f"    .step = {{{', '.join(str(v) for v in table['step'])}}},",
            f"    .still = {{{', '.join(str(v) for v in table['still'])}}},",
            f"    .first = {{{', '.join(str(v) for v in table['first'])}}},",
            f"    .modes = {{{{{modes}}}}},",
            "};",
        ]
    return "\n".join(lines) + "\n"


def cost_tables() -> str:
    m4_report = json.loads(BASELINE.read_text())
    work = json.loads(BASELINE_WORK.read_text())
    calibration = json.loads(CALIBRATION_FILE.read_text())
    tables = {}
    for backend, name in (("scalar", "kNucleoCosts"), ("cmsis", "kNucleoCmsisCosts")):
        build = m4_report["builds"][BOARD_BUILDS[backend]]
        tables[name] = priced(
            build, work, calibration["builds"][backend], calibration["output"]
        )
    return header(tables)


def costs(_: argparse.Namespace) -> None:
    """Writes firmware/NucleoCosts.hpp from the baseline counts and the board's calibration."""
    COSTS_HEADER.write_text(cost_tables())
    print(f"wrote {COSTS_HEADER.relative_to(ROOT)}")


def baseline(_: argparse.Namespace) -> None:
    """Makes the counts of the last m4 run what CI holds the code to, then writes the cost table from them."""
    BASELINE.write_text((BUILD / "M4.json").read_text())
    BASELINE_WORK.write_text((BUILD / "Work.json").read_text())
    print(f"wrote {BASELINE.relative_to(ROOT)} and {BASELINE_WORK.relative_to(ROOT)}")
    costs(_)


def instruction_profile(build: dict, work: dict) -> dict:
    """The board's profile with its costs in this build's instructions, unpriced and with no margin."""
    unit = {
        "terms": {key: 1.0 for key in set(TERMS.values())},
        "steps": {name: 1.0 for name in opcodes()},
    }
    global MARGIN
    margin, MARGIN = MARGIN, 1.0
    try:
        table = priced(build, work, unit, 0)
    finally:
        MARGIN = margin
    profile = json.loads((ROOT / "firmware" / "Profiles" / "Nucleo.json").read_text())
    profile["cost"] = table | {"budget": 2**32 - 1}
    profile["rate"] = float(RATE)  # as QEMU plays them
    return profile


def unsound(build: dict, work: dict) -> list[str]:
    """Programs whose dearest frame on QEMU took more instructions than frame_cost() says one can."""
    profile = instruction_profile(build, work)
    programs = indexed(RECIPES) + indexed(CALIBRATION)
    programs += [(path.stem, path, 0) for path in sorted(OVERHEAD.glob("*.json"))]
    failed = []
    request_path, image, report_path = (
        BUILD / "Sound.json",
        BUILD / "Sound.image",
        BUILD / "Sound.report.json",
    )
    for name, path, _ in programs:
        request = json.loads(path.read_text())
        request["target"] = profile
        request_path.write_text(json.dumps(request))
        subprocess.run(
            [BUILD / "modsynth_compile", request_path, image, report_path],
            capture_output=True,
            check=False,  # A Program the board can't hold fails, and its report says so
        )
        report = json.loads(report_path.read_text())
        if not report.get("ok"):
            continue  # Too big for the board in memory, which never plays it
        bound = report["target"]["cycles"][0]
        peak = build["recipes"][name]["peak"] * FRAME
        if bound < peak:
            failed.append(
                f"{name}: its dearest frame took {peak:.0f} instructions, and frame_cost() allows {bound}"
            )
    return failed


def check(_: argparse.Namespace) -> None:
    """Fails if a count moved more than TOLERANCE from the baseline, if the cost table isn't the baseline's, or if a
    Program ever took more instructions in a frame than its cost bound."""
    now = json.loads((BUILD / "M4.json").read_text())
    then = json.loads(BASELINE.read_text())
    moved = []
    if now["compiler"] != then["compiler"]:
        moved.append(
            f"the compiler is {now['compiler']}, and the baseline's was {then['compiler']}"
        )
    for name, build in then["builds"].items():
        current = now["builds"].get(name, {"kernels": {}, "recipes": {}})
        for case, value in build["kernels"].items():
            got = current["kernels"].get(case)
            if got is None or abs(got - value) > TOLERANCE * value:
                moved.append(
                    f"{name} kernel {case}: {value} instructions a frame, now {got}"
                )
        for recipe, r in build["recipes"].items():
            got = current["recipes"].get(recipe)
            for key in ("mean", "peak"):
                if got is None or abs(got[key] - r[key]) > TOLERANCE * r[key]:
                    moved.append(
                        f"{name} {recipe} {key}: {r[key]} instructions a sample, now {got and got[key]}"
                    )
        for case in set(current["kernels"]) - set(build["kernels"]):
            moved.append(f"{name} kernel {case} is new")
        for recipe in set(current["recipes"]) - set(build["recipes"]):
            moved.append(f"{name} {recipe} is new")
    if COSTS_HEADER.read_text() != cost_tables():
        moved.append(
            f"{COSTS_HEADER.relative_to(ROOT)} isn't what the baseline and the calibration give"
        )
    work = json.loads((BUILD / "Work.json").read_text())
    for build in BOARD_BUILDS.values():
        moved += [f"{build}: {why}" for why in unsound(now["builds"][build], work)]
    if moved:
        print("\n".join(moved))
        sys.exit(
            f"{len(moved)} differences from {BASELINE.relative_to(ROOT)}. If the change is meant, run tools/Bench.py m4 "
            "in the firmware container, then tools/Bench.py baseline, and commit what changed."
        )
    print(f"every count is within {TOLERANCE:.0%} of {BASELINE.relative_to(ROOT)}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    commands = parser.add_subparsers(required=True)
    command = commands.add_parser("host")
    command.add_argument(
        "--seconds", type=float, default=0.5, help="how long each benchmark runs"
    )
    command.set_defaults(run=host)
    commands.add_parser("m4").set_defaults(run=m4)
    commands.add_parser("table").set_defaults(run=table)
    command = commands.add_parser("calibrate")
    command.add_argument(
        "scalar", help="tools/Board.py time --bench --json from the scalar build"
    )
    command.add_argument("cmsis", help="the same from the CMSIS-DSP build")
    command.add_argument(
        "--output",
        type=int,
        required=True,
        help="cycles a frame the board takes to play out",
    )
    command.add_argument("--date", required=True, help="when the board measured them")
    command.set_defaults(run=calibrate)
    commands.add_parser("costs").set_defaults(run=costs)
    commands.add_parser("baseline").set_defaults(run=baseline)
    commands.add_parser("check").set_defaults(run=check)
    arguments = parser.parse_args()
    arguments.run(arguments)


if __name__ == "__main__":
    main()
