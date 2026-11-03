# /// script
# requires-python = ">=3.12"
# dependencies = ["pyserial>=3.5"]
# ///
"""Talks to firmware/Nucleo.cpp over the ST-LINK's serial port. docs/Board.md describes the protocol.

uv run tools/Board.py info
uv run tools/Board.py send golden/Steals.image --play
uv run tools/Board.py send examples/Pieces/FurElise.json --play    # compiles with the Python module first
uv run tools/Board.py stats
uv run tools/Board.py loopback                                     # reads PA4 back with the ADC
uv run tools/Board.py render --frames 1920 --out board.f32
uv run tools/Board.py check                                        # every golden image, against its mono render
uv run tools/Board.py test                                         # transfers that fail must change nothing
uv run tools/Board.py time examples/Recipes                        # cycles a frame for each, to its end
"""

import argparse
import glob
import json
import math
import struct
import sys
import time
import zlib
from array import array
from pathlib import Path

import serial

ROOT = Path(__file__).resolve().parent.parent
FRAME = 32
DATA = 1024  # bytes of image in one frame
# The goldens at frame 32, with the frame count firmware/Main.cpp renders for each.
GOLDENS = {
    "Demo32": 1920,
    "AllOps32": 1600,
    "Waves32": 800,
    "Tones32": 800,
    "Lanes": 1920,
    "Zones": 1920,
    "Hold": 1920,
    "Mods": 1920,
    "Steals": 1920,
    "Lines16": 1920,
}


def cobs_encode(data: bytes) -> bytes:
    out = bytearray([0])
    code_at, code = 0, 1
    for b in data:
        if b == 0:
            out[code_at] = code
            code_at, code = len(out), 1
            out.append(0)
        else:
            out.append(b)
            code += 1
            if code == 0xFF:
                out[code_at] = code
                code_at, code = len(out), 1
                out.append(0)
    out[code_at] = code
    return bytes(out) + b"\0"


def cobs_decode(data: bytes) -> bytes | None:
    out, i = bytearray(), 0
    while i < len(data):
        code = data[i]
        i += 1
        if code == 0 or i + code - 1 > len(data):
            return None
        out += data[i : i + code - 1]
        i += code - 1
        if code != 0xFF and i < len(data):
            out.append(0)
    return bytes(out)


class Board:
    def __init__(self, port: str, baud: int):
        self.port = serial.Serial(port, baud, timeout=0.05)
        self.buffer = bytearray()
        self.port.reset_input_buffer()

    def send(self, kind: str, payload: bytes = b"") -> None:
        body = kind.encode() + payload
        self.port.write(cobs_encode(body + struct.pack("<I", zlib.crc32(body))))

    def frame(self, timeout: float) -> tuple[str, bytes] | None:
        """The next good frame, or None after `timeout` seconds. Log frames are printed and skipped."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            end = self.buffer.find(0)
            if end < 0:
                self.buffer += self.port.read(max(1, self.port.in_waiting))
                continue
            raw, self.buffer = bytes(self.buffer[:end]), self.buffer[end + 1 :]
            body = cobs_decode(raw)
            if body is None or len(body) < 5:
                continue
            if struct.unpack("<I", body[-4:])[0] != zlib.crc32(body[:-4]):
                continue
            kind, payload = chr(body[0]), body[1:-4]
            if kind == "l":
                print("board:", payload.decode(errors="replace"), flush=True)
                continue
            return kind, payload
        return None

    def ask(
        self, kind: str, payload: bytes = b"", timeout: float = 5.0
    ) -> tuple[str, bytes]:
        self.send(kind, payload)
        reply = self.frame(timeout)
        if reply is None:
            raise SystemExit(f"no reply to {kind}")
        if reply[0] == "e":
            raise SystemExit("board: " + reply[1].decode(errors="replace"))
        return reply

    def text(
        self, kind: str, payload: bytes = b"", timeout: float = 5.0
    ) -> dict[str, str]:
        return parse(self.ask(kind, payload, timeout)[1].decode())

    def upload(self, image: bytes) -> dict[str, str]:
        _, reply = self.ask("B", struct.pack("<I", len(image)), timeout=10)
        offset, started, tries = 0, time.monotonic(), 0
        while offset < len(image):
            self.send("D", struct.pack("<I", offset) + image[offset : offset + DATA])
            reply = self.frame(2.0)
            if reply is None:  # lost on the way there or back, so send it again
                tries += 1
                if tries > 5:
                    raise SystemExit(f"no reply at offset {offset}")
                continue
            tries = 0
            if reply[0] == "e":
                raise SystemExit("board: " + reply[1].decode(errors="replace"))
            offset = struct.unpack("<I", reply[1][:4])[0]
        seconds = time.monotonic() - started
        result = self.text("E", timeout=30)
        result["seconds"] = f"{seconds:.1f}"
        return result

    def render(
        self, frames: int, rate: float, stream: bool
    ) -> tuple[dict[str, str], array]:
        self.send("R", struct.pack("<IfB", frames, rate, 1 if stream else 0))
        audio = array("f", bytes(4 * FRAME * frames if stream else 0))
        # Without the stream, nothing comes back until the last frame, so wait for a render at up to 8 times real time.
        wait = 30.0 if stream else 30.0 + 8 * frames * FRAME / rate
        got = 0
        while True:
            reply = self.frame(wait)
            if reply is None:
                raise SystemExit(f"render stopped after {got} frames")
            kind, payload = reply
            if kind == "a":
                index = struct.unpack("<I", payload[:4])[0]
                audio[index * FRAME : (index + 1) * FRAME] = array("f", payload[4:])
                got += 1
            elif kind == "e":
                raise SystemExit("board: " + payload.decode(errors="replace"))
            else:
                if stream and got != frames:
                    raise SystemExit(f"{frames - got} frames were lost")
                return parse(payload.decode()), audio

    def capture(self) -> tuple[list[int], list[int]]:
        """What the ADC read on PA4, and what the DAC was given over the same samples."""
        self.send("C")
        parts: list[list[int]] = [[0] * 1024, [0] * 1024]
        while True:
            reply = self.frame(5.0)
            if reply is None:
                raise SystemExit("the capture stopped")
            kind, payload = reply
            if kind == "e":
                raise SystemExit("board: " + payload.decode(errors="replace"))
            if kind == "k":
                return parts[0], parts[1]
            which, at = payload[0], payload[1] | payload[2] << 8
            parts[which][at : at + 512] = struct.unpack("<512H", payload[3:])


def loopback(adc: list[int], dac: list[int]) -> dict[str, float]:
    """Fits the ADC to the DAC as gain and offset at the lag that fits best, and says how far it is off."""
    best = None
    for lag in range(-4, 9):
        pairs = [
            (dac[i + lag], adc[i])
            for i in range(8, len(adc) - 8)
            if 0 <= i + lag < len(dac)
        ]
        n = len(pairs)
        mx = sum(x for x, _ in pairs) / n
        my = sum(y for _, y in pairs) / n
        sxx = sum((x - mx) ** 2 for x, _ in pairs)
        syy = sum((y - my) ** 2 for _, y in pairs)
        sxy = sum((x - mx) * (y - my) for x, y in pairs)
        if sxx == 0 or syy == 0:
            continue
        gain = sxy / sxx
        residual = math.sqrt(max(syy - gain * sxy, 0) / n)
        if best is None or residual < best["residual"]:
            r = sxy / math.sqrt(sxx * syy)
            best = {
                "lag": lag,
                "gain": gain,
                "residual": residual,
                "signal": math.sqrt(sxx / n),
                "r": r,
            }
    if best is None or best["signal"] < 10:
        raise SystemExit(
            "the DAC was close to silent over the capture: play something first"
        )
    return best


def delivery_test(board: Board) -> int:
    """Checks that whatever goes wrong with a transfer, the image that was playing is the one the board keeps."""
    failed = 0

    def expect(what: str, ok: bool, detail: str = "") -> None:
        nonlocal failed
        failed += not ok
        print(f"{'ok' if ok else 'FAILED':6} {what}{': ' + detail if detail else ''}")

    def kept(what: str, before: dict[str, str]) -> None:
        after = board.text("I")
        same = all(after.get(k) == before.get(k) for k in ("slot", "sequence", "image"))
        expect(
            what, same, f"slot {after.get('slot')}, sequence {after.get('sequence')}"
        )

    first = (ROOT / "golden" / "Waves32.image").read_bytes()
    board.upload(first)
    before = board.text("I")

    # The manifest comes first, so an image for frame 128 is refused on the first data frame.
    wrong = (ROOT / "golden" / "Demo.image").read_bytes()
    board.ask("B", struct.pack("<I", len(wrong)))
    board.send("D", struct.pack("<I", 0) + wrong[:DATA])
    reply = board.frame(5.0)
    expect(
        "an image for another frame size is refused from its first frame",
        reply is not None and reply[0] == "e" and b"frame size" in reply[1],
        reply[1].decode(errors="replace") if reply else "no reply",
    )
    kept("  and the board keeps its image", before)

    damaged = bytearray((ROOT / "golden" / "Steals.image").read_bytes())
    damaged[len(damaged) // 2] ^= 0x10
    try:
        board.upload(bytes(damaged))
        expect("a damaged image is refused", False, "it was accepted")
    except SystemExit as e:
        expect("a damaged image is refused", "hash" in str(e), str(e))
    kept("  and the board keeps its image", before)

    # A reset halfway through stands in for a loss of power.
    cut = (ROOT / "golden" / "Zones.image").read_bytes()
    board.ask("B", struct.pack("<I", len(cut)))
    offset = 0
    while offset < len(cut) // 2:
        _, reply = board.ask(
            "D", struct.pack("<I", offset) + cut[offset : offset + DATA]
        )
        offset = struct.unpack("<I", reply[:4])[0]
    board.ask("Z")
    booted = board.frame(
        10.0
    )  # the boot message is printed and skipped, so this waits out the restart
    expect(
        "the board restarts after a transfer cut at half",
        booted is None or booted[0] != "e",
    )
    kept("  and boots the image it had", before)

    after = board.upload(cut)
    expect(
        "the next image commits to the other slot",
        after["slot"] != before["slot"]
        and int(after["sequence"]) == int(before["sequence"]) + 1,
        f"slot {after['slot']}, sequence {after['sequence']}",
    )
    return 1 if failed else 0


def parse(text: str) -> dict[str, str]:
    return dict(item.split("=", 1) for item in text.split())


def find_port() -> str:
    ports = sorted(glob.glob("/dev/cu.usbmodem*") + glob.glob("/dev/ttyACM*"))
    if not ports:
        raise SystemExit("no board: plug in the NUCLEO-L476RG's ST-LINK USB port")
    return ports[0]


class Refused(Exception):
    """A request the compiler refuses, which includes one that won't fit the board."""


def load_image(path: Path, board: Board) -> bytes:
    """An image as it is, or a request compiled against the board's profile, so what won't fit fails here."""
    if path.suffix != ".json":
        return path.read_bytes()
    import modsynth  # only needed to compile

    request = json.loads(path.read_text())
    if not isinstance(request, dict):
        raise Refused("not a request")
    info = board.text("I")
    name = "NucleoCmsis.json" if info["backend"] == "cmsis" else "Nucleo.json"
    request["target"] = json.loads((ROOT / "firmware" / "Profiles" / name).read_text())
    if info.get("budget") == "0":
        # Firmware built with MODSYNTH_COST_LIMIT off refuses nothing for its cost, to measure what Programs cost.
        del request["target"]["cost"]
    try:
        return modsynth.compile_image(request)
    except modsynth.CompileError as e:
        raise Refused(str(e)) from e


def peak_db(reference: array, candidate: array) -> float:
    peak = max(abs(x) for x in reference) or 1.0
    worst = max(abs(a - b) for a, b in zip(reference, candidate))
    return -math.inf if worst == 0 else 20 * math.log10(worst / peak)


def show(result: dict[str, str]) -> None:
    print(" ".join(f"{k}={v}" for k, v in result.items()))


def timing(result: dict[str, str]) -> str:
    budget = int(result["budget"])
    return (
        f"mean {int(result['mean']):>6} cycles ({100 * int(result['mean']) / budget:5.1f}%), "
        f"p99.9 {int(result['p999']):>6}, worst {int(result['worst']):>6} ({100 * int(result['worst']) / budget:5.1f}%)"
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--port", default=None)
    parser.add_argument("--baud", type=int, default=921600)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("info")
    commands.add_parser("stats")
    commands.add_parser("play")
    commands.add_parser("stop")
    commands.add_parser("listen", help="print what the board logs")
    commands.add_parser(
        "loopback",
        help="check that the audio reaches PA4, by reading it back with the ADC",
    )
    send = commands.add_parser("send")
    send.add_argument("image", type=Path, help="an image, or a request to compile")
    send.add_argument("--play", action="store_true")
    render = commands.add_parser("render")
    render.add_argument("--frames", type=int, default=1920)
    render.add_argument("--rate", type=float, default=48000.0)
    render.add_argument("--out", type=Path)
    commands.add_parser("check")
    commands.add_parser(
        "test",
        help="cut and damaged transfers, which must leave the board's image as it was",
    )
    time_ = commands.add_parser("time")
    time_.add_argument(
        "paths", type=Path, nargs="+", help="images, requests, or folders of them"
    )
    time_.add_argument(
        "--seconds",
        type=float,
        help="how long to render each, by default to its end and tail as the Python module renders it",
    )
    time_.add_argument(
        "--bench",
        action="store_true",
        help="render each for the frames tools/Bench.py does, from its folder's Index.json, so the two compare",
    )
    time_.add_argument("--json", type=Path, help="also write the results here")
    args = parser.parse_args()

    board = Board(args.port or find_port(), args.baud)
    if args.command == "info":
        show(board.text("I"))
    elif args.command == "stats":
        show(board.text("T"))
    elif args.command == "play":
        board.ask("P")
    elif args.command == "stop":
        board.ask("S")
    elif args.command == "listen":
        while True:
            reply = board.frame(3600)
            if reply:
                print(reply[0], reply[1])
    elif args.command == "loopback":
        fit = loopback(*board.capture())
        print(
            f"PA4 follows the DAC: correlation {fit['r']:.5f}, gain {fit['gain']:.4f}, lag {fit['lag']} samples, "
            f"signal {fit['signal']:.1f} LSB rms, residual {fit['residual']:.2f} LSB rms"
        )
        return 0 if fit["r"] > 0.999 else 1
    elif args.command == "send":
        show(board.upload(load_image(args.image, board)))
        if args.play:
            board.ask("P")
    elif args.command == "render":
        result, audio = board.render(args.frames, args.rate, args.out is not None)
        show(result)
        if args.out:
            args.out.write_bytes(audio.tobytes())
    elif args.command == "check":
        failed = 0
        for name, frames in GOLDENS.items():
            board.upload((ROOT / "golden" / f"{name}.image").read_bytes())
            result, audio = board.render(frames, 48000.0, True)
            reference = array("f", (ROOT / "golden" / f"{name}.mono.f32").read_bytes())
            same = sum(
                a == b or (math.isnan(a) and math.isnan(b))
                for a, b in zip(reference, audio)
            )
            db = peak_db(reference, audio)
            ok = len(reference) == len(audio) and db <= -100
            failed += not ok
            print(
                f"{name:9} {len(audio) - same:>6} of {len(audio)} samples differ, worst {db:7.1f} dB  "
                f"{timing(result)}  {'ok' if ok else 'FAILED'}"
            )
        return 1 if failed else 0
    elif args.command == "test":
        return delivery_test(board)
    elif args.command == "time":
        files, bench_frames = [], {}
        for path in args.paths:
            files += (
                [p for p in sorted(path.glob("*.json")) if p.name != "Index.json"]
                + sorted(path.glob("*.image"))
                if path.is_dir()
                else [path]
            )
            index = (path if path.is_dir() else path.parent) / "Index.json"
            if args.bench and index.exists():
                for entry in json.loads(index.read_text()):
                    bench_frames[entry["name"]] = int(entry["seconds"] * 48000 / FRAME)
        results = {}
        for path in files:
            try:
                image = load_image(path, board)
            except Refused as e:
                print(f"{path.stem:28} does not compile: {e}")
                results[path.stem] = {"refused": str(e)}
                continue
            try:
                upload = board.upload(image)
            except SystemExit as e:
                print(f"{path.stem:28} {e}")
                results[path.stem] = {"refused": str(e)}
                continue
            if args.bench:
                if path.stem not in bench_frames:
                    raise SystemExit(f"{path} isn't in its folder's Index.json")
                samples = bench_frames[path.stem] * FRAME
            elif args.seconds is None:
                import modsynth  # only needed to find how long it plays

                samples = len(modsynth.render(image))
            else:
                samples = round(args.seconds * 48000)
            result, _ = board.render(math.ceil(samples / FRAME), 48000.0, False)
            results[path.stem] = result | {
                "image": upload["image"],
                "fast": upload["fast"],
                "bulk": upload["bulk"],
            }
            seconds = int(result["frames"]) * FRAME / 48000
            print(
                f"{path.stem:28} {timing(result)}  voices {result['peak_voices']}, {seconds:.1f} s"
            )
        if args.json:
            args.json.write_text(json.dumps(results, indent=1) + "\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Refused as e:
        sys.exit(f"refused: {e}")
