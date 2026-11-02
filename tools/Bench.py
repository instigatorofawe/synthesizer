#!/usr/bin/env python3
"""Builds and runs the benchmarks, and writes docs/Benchmarks.md from what they report.

    tools/Bench.py host    Google Benchmark on this machine, into build/bench/Host.json
    tools/Bench.py m4      Cortex-M4 instruction counts on QEMU, into build/bench/M4.json
    tools/Bench.py table   docs/Benchmarks.md from those two

m4 needs what firmware/Check.sh needs, so on a Mac run it in a container and copy M4.json back.
"""

import argparse
import json
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
TABLE = ROOT / "docs" / "Benchmarks.md"

FRAME = 32
RATE = 48000
BUILDS = {"Stereo": "BenchStereo", "Mono": "BenchMono", "Cmsis": "BenchCmsis"}

# What "fits" means. Instructions are exact, but cycles per instruction and the reserve are a model until a board says.
CYCLES_PER_INSTRUCTION = 1.5
RESERVE = 0.3
CLOCK_MHZ = 80
RAM_KB = 128


def run(*command: object, **options: object) -> subprocess.CompletedProcess:
    return subprocess.run([str(c) for c in command], check=True, **options)


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


def compile_recipes() -> Path:
    """Compiles every recipe and writes the file firmware/Bench.cpp includes to link them."""
    run("cmake", "--build", BUILD, "--target", "modsynth_compile")
    images = BUILD / "images"
    images.mkdir(parents=True, exist_ok=True)
    recipes = [
        (r["name"], RECIPES / r["file"], int(r["seconds"] * RATE / FRAME))
        for r in json.loads((RECIPES / "Index.json").read_text())
    ]
    recipes += [
        (path.stem, path, OVERHEAD_FRAMES) for path in sorted(OVERHEAD.glob("*.json"))
    ]
    links, rows = [], []
    for i, (name, request, frames) in enumerate(recipes):
        image = images / f"{name}.image"
        run(BUILD / "modsynth_compile", request, image)
        links.append(f'MODSYNTH_LINK_IMAGE(g_{i}, "{image}")')
        rows.append(f'    {{"{name}", g_{i}, g_{i}_end, {frames}u}},')
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
        elif kind == "kernel":
            report["kernels"][",".join(fields[:-1])] = (
                int(fields[-1]) / 100
            )  # A name can hold a comma
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


def over_budget(recipe: dict, engine_bytes: int) -> str:
    """Why a recipe doesn't fit the floor in docs/Design.md section 15, or an empty string."""
    budget = CLOCK_MHZ * 1e6 * (1 - RESERVE) / (RATE * CYCLES_PER_INSTRUCTION)
    reasons = []
    if recipe["peak"] > budget:
        reasons.append("CPU")
    if (recipe["fast"] + recipe["bulk"] + engine_bytes) / 1024 > RAM_KB:
        reasons.append("RAM")
    return " and ".join(reasons)


def megahertz(instructions: float) -> float:
    return instructions * RATE * CYCLES_PER_INSTRUCTION / 1e6


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
    stereo: dict, mono: dict, cmsis: dict, hosted: dict, groups: dict
) -> list[str]:
    rows = []
    for name, r in sorted(stereo["recipes"].items(), key=lambda item: -item[1]["peak"]):
        h = hosted[f"Recipe/{name}/manual_time"]
        problem = over_budget(r, stereo["engine_bytes"])
        rows.append(
            f"| {name} | {groups[name]} | {r['image'] / 1024:.1f} | {(r['fast'] + r['bulk']) / 1024:.1f} | {r['voices']} "
            f"| {r['mean']:.0f} | {r['p999']:.0f} | {r['peak']:.0f} | {mono['recipes'][name]['peak']:.0f} "
            f"| {cmsis['recipes'][name]['peak']:.0f} | {megahertz(r['peak']):.0f} | {problem or 'yes'} "
            f"| {h['real_time'] / (r['frames'] * FRAME):.1f} | {h['p999_frame_ns'] / 1000:.1f} / {h['worst_frame_ns'] / 1000:.1f} |"
        )
    return rows


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
        "checking both channels for non-finite samples, and adding them to the bus."
    )
    return [text]


def table(_: argparse.Namespace) -> None:
    m4_report = json.loads((BUILD / "M4.json").read_text())
    host_report = json.loads((BUILD / "Host.json").read_text())
    stereo, mono, cmsis = (m4_report["builds"][b] for b in BUILDS)
    overhead = {
        path.stem: stereo["recipes"].pop(path.stem) for path in OVERHEAD.glob("*.json")
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
    problems = {
        n: over_budget(r, stereo["engine_bytes"]) for n, r in stereo["recipes"].items()
    }
    fit = sum(not p for p in problems.values())
    commit = run(
        "git", "rev-parse", "--short", "HEAD", capture_output=True, text=True, cwd=ROOT
    ).stdout.strip()
    budget = CLOCK_MHZ * (1 - RESERVE)
    source = (
        f"Cortex-M4 counts come from `firmware/Bench.cpp` on QEMU's mps2-an386, built with {m4_report['compiler']} at -O2, "
        f"frame {FRAME}, {RATE} Hz. They are exact and repeat, so a change in one is a change in the code. Host figures come "
        f"from Google Benchmark on one core of {host_report['context'].get('host_name', 'one machine')}, and move from run to run."
    )
    caution = (
        "Section 17 of `docs/Design.md` applies: host figures rank kernels on that host only and are not carried to Cortex-M. "
        f"Megahertz here is a model, instructions at {CYCLES_PER_INSTRUCTION} cycles each, with no flash wait states, cache "
        "misses or DMA. Only a board can replace it."
    )
    summary = (
        f"{fit} of {len(recipes)} fit the floor in section 15: an {CLOCK_MHZ} MHz L476 with {RESERVE:.0%} held back, so "
        f"{budget:.0f} MHz at the worst frame, and {RAM_KB} KB of RAM including the {stereo['engine_bytes'] / 1024:.1f} KB engine "
        f"object. Images have a median of {statistics.median(r['image'] for r in recipes) / 1024:.1f} KB and RAM a median of "
        f"{statistics.median(r['fast'] + r['bulk'] for r in recipes) / 1024:.1f} KB. Loading one takes "
        f"{min(r['load'] for r in recipes):,} to {max(r['load'] for r in recipes):,} instructions."
    )
    columns = (
        "Instructions are per sample, stereo and scalar unless named. Peak is the worst frame of the whole recipe, played from "
        "start to end. Host ns is per sample of the mean frame. A host's worst frame is mostly the operating system."
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
        "| Recipe | Group | Image KB | RAM KB | Voices | Mean | p99.9 | Peak | Peak, mono | Peak, CMSIS | Peak MHz | Fits | Host ns | Host p99.9 / worst frame µs |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|",
        *recipe_rows(stereo, mono, cmsis, hosted, groups),
        "",
        "## Engine",
        "",
        *engine_lines(stereo, overhead),
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
    TABLE.write_text("\n".join(lines))
    print(f"{TABLE.relative_to(ROOT)}: {fit} of {len(recipes)} fit")


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
    arguments = parser.parse_args()
    arguments.run(arguments)


if __name__ == "__main__":
    main()
