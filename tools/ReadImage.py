"""Reads images using docs/Format.md alone, as a check that the specification is complete and true.

Its opcode, instruction and limit tables are parsed out of the document, then compared with the C++ registry and header, so
the document cannot drift from the code unnoticed. It shares no code with the engine, and it decodes every field of every
chunk, so a wrong offset anywhere in the document makes it fail.

    ReadImage.py image...                 decode and check each image
    ReadImage.py --report report.json image
                                          also compare with the compiler's report
    ReadImage.py --coverage image...      fail unless these images use every opcode, instruction and mixer step
    ReadImage.py --example image          fail unless the example in the document is this image
"""

import argparse
import json
import re
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = (ROOT / "docs/Format.md").read_text()
REGISTRY = (ROOT / "include/modsynth/Opcodes.def").read_text()
HEADER = (ROOT / "include/modsynth/Format.hpp").read_text()

KINDS = {0: "manifest", 1: "asset", 2: "table", 3: "patch", 4: "program"}


class BadImage(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise BadImage(message)


def table_rows(heading: str) -> list[list[str]]:
    """The rows of the first table after a heading, split into stripped cells."""
    rows = []
    for line in SPEC[SPEC.index(heading) :].splitlines():
        if line.startswith("|"):
            rows.append([cell.strip() for cell in line.strip("|").split("|")])
        elif rows:
            break
    return rows[2:]


def operands(cell: str) -> list[str]:
    return [part.split()[0] for part in cell.split(",") if part.strip()]


OPS = {}
for row in table_rows("### Opcodes"):
    OPS[int(row[0])] = {
        "name": row[1],
        "out": operands(row[2]),
        "in": operands(row[3]),
        "mode": row[4],
        "resource": row[5],
        "control": row[6] == "either",
        "since": int(row[7]),
    }
INSTRUCTIONS = {
    int(row[0]): {
        "name": row[1],
        "a": bool(row[2]),
        "b": bool(row[3]),
        "c": bool(row[4]),
        "since": int(row[6]),
    }
    for row in table_rows("| Op | Name | a | b | c | Where | Since |")
}
MIX_OPS = {
    int(number): name
    for number, name in re.findall(
        r"(\d) (RunVoices|RunInsert|Gather)",
        next(line for line in SPEC.splitlines() if "1 RunVoices" in line),
    )
}


def limit_value(text: str) -> float:
    """A limit as the header or the document writes it: 256, 60.0f, 0x7FFFFFFF, 1u << 24, 2^24 or 2^31 − 1."""
    text = text.strip().rstrip("f").replace("u", "").replace("−", "-")
    if "<<" in text:
        left, right = text.split("<<")
        return limit_value(left) * 2 ** limit_value(right)
    if " - " in text:
        left, right = text.split(" - ")
        return limit_value(left) - limit_value(right)
    if "^" in text:
        left, right = text.split("^")
        return limit_value(left) ** limit_value(right)
    return int(text, 16) if text.startswith("0x") else float(text)


def check_document() -> None:
    """Compares the tables in the document with the registry and the header."""
    described = re.search(r"This document describes revision (\d+)", SPEC)
    engine = re.search(r"kFormatRevision = (\d+)", HEADER)
    require(
        described is not None
        and engine is not None
        and described.group(1) == engine.group(1),
        "the document and the header describe different revisions",
    )
    require(
        max(op["since"] for op in [*OPS.values(), *INSTRUCTIONS.values()])
        <= int(engine.group(1)),
        "an opcode or instruction is newer than the newest revision",
    )
    registered = re.findall(r"^MODSYNTH_OP\(([^)]*)\)", REGISTRY, re.MULTILINE)
    require(len(registered) == len(OPS), "document and registry list different opcodes")
    for line in registered:
        cells = [c.strip() for c in line.split(",")]
        name, number, outs, _, ins = (
            cells[0],
            int(cells[1]),
            cells[2],
            cells[3],
            cells[4],
        )
        inputs, resource, max_mode, control = cells[5:9], cells[9], cells[10], cells[11]
        op = OPS[number]
        where = f"opcode {number}"
        require(
            op["name"] == name, f"{where}: document says {op['name']}, registry {name}"
        )
        require(len(op["out"]) == int(outs), f"{where}: output count")
        require(len(op["in"]) == int(ins), f"{where}: input count")
        kinds = {"Buffer": "B", "Scalar": "S", "Either": "E"}
        require(
            op["in"] == [kinds[k] for k in inputs[: int(ins)]],
            f"{where}: input kinds",
        )
        require((op["resource"] or "None") == resource, f"{where}: resource")
        require(op["control"] == (control == "true"), f"{where}: which phase")
        if int(max_mode) == 0:
            require(
                not op["mode"], f"{where}: document gives a mode the registry does not"
            )
        else:
            require(bool(op["mode"]), f"{where}: document gives no mode")
    registered = re.findall(r"^MODSYNTH_INSTR\(([^)]*)\)", REGISTRY, re.MULTILINE)
    require(
        len(registered) == len(INSTRUCTIONS),
        "document and registry list different instructions",
    )
    for line in registered:
        cells = [c.strip() for c in line.split(",")]
        instruction = INSTRUCTIONS[int(cells[1])]
        require(instruction["name"] == cells[0], f"instruction {cells[1]} name")
        for field, cell in zip("abc", cells[2:5]):
            require(
                instruction[field] == (cell == "1"),
                f"instruction {cells[0]} field {field}",
            )
    registered = re.findall(r"^MODSYNTH_MIX\((\w+),\s*(\d+)\)", REGISTRY, re.MULTILINE)
    require(
        {int(number): name for name, number in registered} == MIX_OPS,
        "document and registry list different mixer steps",
    )

    limits = re.findall(r"^\| `(kMax\w+)` \| ([^|]+) \|", SPEC, re.MULTILINE)
    require(len(limits) >= 20, "the limit table is missing")
    for name, text in limits:
        found = re.search(rf"inline constexpr \w+ {name} = ([^;]+);", HEADER)
        require(found is not None, f"{name} is not in Format.hpp")
        value = limit_value(found.group(1))
        require(
            limit_value(text) == value,
            f"{name}: document says {text.strip()}, header {value}",
        )


def fnv(version: int, kind: int, payload: bytes) -> int:
    h = 14695981039346656037
    for b in bytes((version, kind)) + payload:
        h = ((h ^ b) * 1099511628211) % 2**64
    return h


class Cursor:
    """Reads a chunk's payload front to back, and refuses to run off the end."""

    def __init__(self, data: bytes):
        self.data = data
        self.at = 0

    def read(self, layout: str) -> tuple:
        size = struct.calcsize("<" + layout)
        require(
            self.at + size <= len(self.data), "a section runs past the end of its chunk"
        )
        values = struct.unpack_from("<" + layout, self.data, self.at)
        self.at += size
        return values

    def table(self, count: int, layout: str) -> list[tuple]:
        return [self.read(layout) for _ in range(count)]

    def done(self) -> None:
        require(self.at == len(self.data), "a chunk does not end where its sections do")


def bank(operand: int) -> int:
    return operand >> 13


def read_asset(data: bytes) -> dict:
    c = Cursor(data)
    encoding, channels, root, flags, rate, frames, loop_start, loop_end = c.read(
        "BBBBfIII"
    )
    require(
        encoding in (0, 1) and channels in (1, 2) and root <= 127 and flags == 0,
        "asset header",
    )
    require(frames >= 1 and 1 <= rate <= 1000000, "asset frames or rate")
    if loop_end:
        require(loop_start < loop_end <= frames, "asset loop")
    width = 2 if encoding == 0 else 4
    c.at += (frames + 1) * channels * width
    c.done()
    return {
        "encoding": encoding,
        "channels": channels,
        "looping": loop_end != 0,
    }


def read_table(data: bytes) -> dict:
    c = Cursor(data)
    length, reserved = c.read("II")
    require(
        reserved == 0 and length >= 2 and length & (length - 1) == 0, "table header"
    )
    samples = [row[0] for row in c.table(length + 1, "f")]
    c.done()
    return {"length": length, "samples": samples}


def check_zones(
    table: dict, asset_refs: set[int], refs: int, wide: bool = False
) -> None:
    """What section 5 asks of a table that a Sample2 uses, or with `wide` a Sample3."""
    fields = 16 if wide else 8
    length = table["length"]
    require(length % fields == 0 and length // fields <= 256, "zone table size")
    for at in range(0, length, fields):
        row = table["samples"][at : at + fields]
        low_key, high_key, low_velocity, high_velocity, ref, root = row[:6]
        if low_key > high_key:
            require(row == [1] + [0] * (fields - 1), "zone table padding")
            continue
        for value in (low_key, high_key, low_velocity, high_velocity):
            require(value == int(value) and 0 <= value <= 127, "zone range")
        require(low_velocity <= high_velocity, "zone velocities")
        require(0 <= root <= 127, "zone root")
        require(ref == int(ref) and int(ref) < refs, "zone ref")
        require(int(ref) in asset_refs, "a zone must name an asset")
        if not wide:
            require(row[6:] == [0, 0], "zone reserved fields")
            continue
        position, of, fade_in, fade_out = row[6:10]
        require(of == int(of) and 0 <= of <= 256, "round robin length")
        require(
            position == int(position) and 0 <= position <= max(0, of - 1),
            "round robin position",
        )
        span = high_velocity - low_velocity
        require(0 <= fade_in <= span and 0 <= fade_out <= span, "velocity fades")
        require(row[10:] == [0] * 6, "zone reserved fields")


def read_patch(data: bytes) -> dict:
    c = Cursor(data)
    fields = c.read("12HI")
    control, voice, _, voice_scalars, _ = fields[:5]
    params, refs, consts, delays, inputs, left, right, reserved = fields[5:]
    require(reserved == 0 and voice_scalars >= 3 and inputs <= 2, "patch header")
    require(bank(left) == 1 and bank(right) == 1, "patch outputs are buffers")
    for row in c.table(params, "HBBHHfff"):
        require(row[2] == 0 and row[1] <= 2, "parameter")
        require(row[5] <= row[7] <= row[6], "parameter default")
    hashes = [r[0] for r in c.table(refs, "Q")]
    c.table(consts, "f")
    for (seconds,) in c.table(delays, "f"):
        require(0 < seconds <= 60, "delay line")
    c.table(inputs * 2, "H")
    used, modes, zone_tables, wide_tables = set(), set(), set(), set()
    for i, (op, mode, resource, _, *rest) in enumerate(
        c.table(control + voice, "BBHI6H")
    ):
        require(op in OPS, f"unknown opcode {op}")
        spec = OPS[op]
        out, inputs_used = rest[:2], rest[2:]
        require(i >= control or spec["control"], f"{spec['name']} in the control phase")
        for slot, kind in enumerate(spec["out"]):
            require(
                (bank(out[slot]) == 1) == (kind == "B"), f"{spec['name']} output kind"
            )
        for slot, kind in enumerate(spec["in"]):
            require(
                bank(inputs_used[slot]) != 0
                if kind == "E"
                else (bank(inputs_used[slot]) == 1) == (kind == "B"),
                f"{spec['name']} input kind",
            )
        require(not any(out[len(spec["out"]) :]), f"{spec['name']} unused output")
        require(not any(inputs_used[len(spec["in"]) :]), f"{spec['name']} unused input")
        if not spec["resource"]:
            require(resource == 0, f"{spec['name']} unused resource")
        if not spec["mode"]:
            require(mode == 0, f"{spec['name']} unused mode")
        if spec["name"] == "Sample2":
            zone_tables.add(resource)
        if spec["name"] == "Sample3":
            wide_tables.add(resource)
        used.add(op)
        modes.add((op, mode))
    c.done()
    return {
        "ops": used,
        "modes": modes,
        "refs": hashes,
        "inputs": inputs,
        "zone_tables": zone_tables,
        "wide_tables": wide_tables,
    }


def read_program(data: bytes) -> dict:
    c = Cursor(data)
    ppq, uspq, length, conductor_begin, conductor_length, code = c.read("6I")
    patches, tracks, slots, clips, inserts, mix, gather, buses = c.read("8H")
    mix_regs, globals_count, inits, master, features = c.read("4HI")
    require(
        features <= 7 and 1 <= ppq <= 65535 and 1000 <= uspq <= 60000000,
        "program header",
    )
    require(buses >= 1 and master < buses, "program buses")

    hashes = [r[0] for r in c.table(patches, "Q")]
    track_rows = c.table(tracks, "4H2I")
    next_slot = 0
    for _, voices, slot_begin, slot_count, _, _ in track_rows:
        require(1 <= voices <= 256 and 1 <= slot_count <= 256, "track")
        require(slot_begin == next_slot, "tracks must own slots in order")
        next_slot += slot_count
    require(next_slot == slots, "slots nothing owns")
    for (index,) in c.table(slots, "H"):
        require(index < patches, "slot")
    if slots % 2:
        require(c.read("H") == (0,), "padding after slots")
    clip_rows = c.table(clips, "4I")
    c.table(inserts, "2H")
    mix_ops = set()
    for op, reserved, _, _, _, _, key in c.table(mix, "BBHHHHH"):
        require(op in MIX_OPS and reserved == 0, "mixer step")
        if op != 2:
            require(key == 0xFFFF, "unused key")
        mix_ops.add(op)
    for row in c.table(gather, "4H"):
        require(row[3] == 0, "gather input")
    c.table(mix_regs, "f")
    ids = [r[0] for r in c.table(globals_count, "HHf")]
    require(ids == sorted(set(ids)), "globals must ascend")
    for kind, _, _, reserved, _ in c.table(inits, "4Hf"):
        require(kind <= 1 and reserved == 0, "initial value")
    instructions = c.table(code, "BBHI")
    c.done()

    used, slurs = set(), False
    for op, a, b, value in instructions:
        require(op in INSTRUCTIONS, f"unknown instruction {op}")
        spec = INSTRUCTIONS[op]
        for field, number in (("a", a), ("b", b), ("c", value)):
            require(spec[field] or number == 0, f"{spec['name']} unused field {field}")
        if spec["name"] in ("SetInsert", "RampInsert"):
            require(a < inserts, "a lane names an insert the Program lacks")
        if spec["name"] in ("SetMix", "RampMix"):
            require(b < mix_regs, "a lane names a register the Program lacks")
        if spec["name"] == "PlayMode":
            require(a <= 3, "play kind")
            slurs = slurs or a == 3
        if spec["name"] == "Steal":
            require(a <= 1, "steal")
        used.add(op)
    names = {INSTRUCTIONS[op]["name"] for op in used}
    require(
        features
        == ("RampMix" in names) + 2 * ("PlayMode" in names) + 4 * ("Steal" in names),
        "features must say what the code uses",
    )

    def stream_ticks(begin: int, count: int) -> int:
        total = 0
        for op, _, b, value in instructions[begin : begin + count]:
            if INSTRUCTIONS[op]["name"] == "Wait":
                total += value
            elif INSTRUCTIONS[op]["name"] == "Call":
                total += clip_rows[b][2] * value
        return total

    for begin, count, ticks, _ in clip_rows:
        require(stream_ticks(begin, count) == ticks and ticks >= 1, "clip ticks")
    longest = max((stream_ticks(r[4], r[5]) for r in track_rows), default=0)
    require(longest == length, "length_ticks is not the longest track")
    require(
        instructions[conductor_begin + conductor_length - 1][0] == 0,
        "the conductor must end in End",
    )
    return {
        "instructions": used,
        "mix_ops": mix_ops,
        "patches": hashes,
        "length_ticks": length,
        "ppq": ppq,
        "slurs": slurs,
    }


READERS = {1: read_asset, 2: read_table, 3: read_patch, 4: read_program}


def read_chunk_header(image: bytes, at: int) -> tuple:
    require(at + 24 <= len(image), "a chunk header runs past the end of the image")
    magic, kind, version, reserved, size, reserved2, chunk_hash = struct.unpack_from(
        "<IBBHIIQ", image, at
    )
    require(magic == 0x4B43534D and version == 1, "chunk magic or version")
    require(reserved == 0 and reserved2 == 0, "chunk header reserved")
    require(at + 24 + size <= len(image), "a chunk runs past the end of the image")
    return kind, size, chunk_hash


def next_chunk(image: bytes, at: int, size: int) -> int:
    end = at + 24 + size
    padded = at + 24 + (size + 7) // 8 * 8
    require(padded <= len(image), "padding runs past the end of the image")
    require(not any(image[end:padded]), "padding must be zero")
    return padded


def read_image(path: Path) -> dict:
    image = path.read_bytes()
    kind, size, manifest_hash = read_chunk_header(image, 0)
    payload = image[24 : 24 + size]
    require(kind == 0 and fnv(1, 0, payload) == manifest_hash, "manifest")
    entries, programs, revision, frame_size = struct.unpack_from("<4I", payload, 0)
    require(size == 16 + entries * 16, "manifest header")
    require(
        frame_size == 0
        or (
            frame_size != 128
            and frame_size & (frame_size - 1) == 0
            and 8 <= frame_size <= 1024
        ),
        "manifest frame size",
    )

    chunks, at = [], next_chunk(image, 0, size)
    previous = (0, 0)
    for i in range(entries):
        entry_hash, entry_size, entry_kind, present, entry_reserved = (
            struct.unpack_from("<QIBBH", payload, 16 + i * 16)
        )
        require(
            entry_reserved == 0 and present <= 1 and 1 <= entry_kind <= 4,
            "manifest entry",
        )
        require(entry_kind >= previous[0], "chunks out of kind order")
        if entry_kind == previous[0] and entry_kind != 4:
            require(entry_hash > previous[1], "chunks out of hash order")
        previous = (entry_kind, entry_hash)
        chunk = {
            "kind": KINDS[entry_kind],
            "hash": f"{entry_hash:016x}",
            "size": entry_size,
            "present": bool(present),
        }
        if present:
            kind, chunk_size, chunk_hash = read_chunk_header(image, at)
            require(
                (kind, chunk_size, chunk_hash) == (entry_kind, entry_size, entry_hash),
                "chunk and entry differ",
            )
            data = image[at + 24 : at + 24 + chunk_size]
            require(fnv(1, kind, data) == chunk_hash, "chunk hash")
            chunk["decoded"] = READERS[kind](data)
            at = next_chunk(image, at, chunk_size)
        chunks.append(chunk)
    require(at == len(image), "bytes follow the last chunk")
    require(sum(c["kind"] == "program" for c in chunks) == programs, "program count")
    needed = max(
        (
            OPS[op]["since"]
            for c in chunks
            if c["kind"] == "patch"
            for op in c.get("decoded", {}).get("ops", ())
        ),
        default=0,
    )
    needed = max(
        needed,
        *(
            INSTRUCTIONS[op]["since"]
            for c in chunks
            if c["kind"] == "program"
            for op in c.get("decoded", {}).get("instructions", ())
        ),
        0,
    )
    by_hash = {c["hash"]: c for c in chunks}
    for chunk in chunks:
        decoded = chunk.get("decoded", {})
        if chunk["kind"] != "patch" or not decoded:
            continue
        names = [f"{ref:016x}" for ref in decoded["refs"]]
        assets = {
            i
            for i, name in enumerate(names)
            if name in by_hash and by_hash[name]["kind"] == "asset"
        }
        for resources, wide in (
            (decoded["zone_tables"], False),
            (decoded["wide_tables"], True),
        ):
            for resource in resources:
                table = by_hash.get(names[resource], {})
                if "decoded" in table:  # A thin image can omit it
                    check_zones(table["decoded"], assets, len(names), wide)
    # A legato line that brings its notes' velocities is a play kind revision 7 added.
    if any(c.get("decoded", {}).get("slurs") for c in chunks if c["kind"] == "program"):
        needed = max(needed, 7)
    if frame_size != 0:
        needed = max(needed, 3)
    # A thin image can need more than what it carries.
    whole = all(c["present"] for c in chunks)
    require(revision == needed if whole else revision >= needed, "manifest revision")
    return {"chunks": chunks, "programs": programs}


def compare_report(result: dict, report_path: Path) -> None:
    report = json.loads(report_path.read_text())
    expected = [
        (c["kind"], c["hash"], c["size"], c["present"]) for c in report["chunks"]
    ]
    actual = [(c["kind"], c["hash"], c["size"], c["present"]) for c in result["chunks"]]
    require(expected == actual, "chunks differ from the compiler's report")
    decoded = [
        c["decoded"]
        for c in result["chunks"]
        if c["kind"] == "program" and "decoded" in c
    ]
    for program, reported in zip(decoded, report["programs"]):
        require(
            program["length_ticks"] == reported["length_ticks"],
            "program length differs from the report",
        )
        require(program["ppq"] == reported["ppq"], "ppq differs from the report")


def check_coverage(results: list[dict]) -> None:
    ops, modes, instructions, mix_ops, assets = set(), set(), set(), set(), set()
    for result in results:
        for chunk in result["chunks"]:
            decoded = chunk.get("decoded", {})
            ops |= decoded.get("ops", set())
            modes |= decoded.get("modes", set())
            instructions |= decoded.get("instructions", set())
            mix_ops |= decoded.get("mix_ops", set())
            if chunk["kind"] == "asset" and decoded:
                assets.add(
                    (decoded["encoding"], decoded["channels"], decoded["looping"])
                )
    missing = [OPS[op]["name"] for op in OPS if op not in ops]
    missing += [INSTRUCTIONS[i]["name"] for i in INSTRUCTIONS if i not in instructions]
    missing += [MIX_OPS[m] for m in MIX_OPS if m not in mix_ops]
    missing += [f"Biquad mode {m}" for m in (0, 1, 2) if (4, m) not in modes]
    missing += [f"DelayRead mode {m}" for m in (0, 1) if (13, m) not in modes]
    missing += [f"Sample2 mode {m}" for m in range(4) if (27, m) not in modes]
    missing += [f"Sample3 mode {m}" for m in range(6) if (33, m) not in modes]
    require(not missing, "not used by any golden image: " + ", ".join(missing))
    print(
        f"coverage: all {len(OPS)} opcodes, {len(INSTRUCTIONS)} instructions and {len(MIX_OPS)} mixer steps, "
        f"{len(assets)} asset shapes"
    )


def check_example(image: bytes) -> None:
    block = SPEC[SPEC.index("## 8. An example") : SPEC.index("## 9. Limits")]
    written = bytes.fromhex(
        "".join(re.findall(r"^    ([0-9a-f ]+)$", block, re.MULTILINE))
    )
    require(written == image, "the example in the document is not this image")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--coverage", action="store_true")
    parser.add_argument("--example", action="store_true")
    parser.add_argument("images", nargs="+", type=Path)
    args = parser.parse_args()
    try:
        check_document()
        results = [read_image(path) for path in args.images]
        for path, result in zip(args.images, results):
            kinds = [c["kind"] for c in result["chunks"]]
            print(
                f"{path}: {len(kinds)} chunks, {result['programs']} programs, {path.stat().st_size} bytes"
            )
        if args.report:
            compare_report(results[0], args.report)
        if args.coverage:
            check_coverage(results)
        if args.example:
            check_example(args.images[0].read_bytes())
    except BadImage as e:
        print(f"ReadImage: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
