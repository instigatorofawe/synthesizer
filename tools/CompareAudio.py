"""Compares two raw 32-bit float renders. Fails if they differ by more than the tolerance, relative to the peak."""

import argparse
import math
import sys
from array import array
from pathlib import Path


def read(path: str) -> array:
    samples = array("f")
    samples.frombytes(Path(path).read_bytes())
    return samples


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("reference")
    parser.add_argument("candidate")
    parser.add_argument(
        "--tolerance", type=float, default=-100.0, help="dB relative to peak"
    )
    args = parser.parse_args()

    a, b = read(args.reference), read(args.candidate)
    if len(a) != len(b):
        print(f"length differs: {len(a)} and {len(b)}")
        return 1
    peak = max(abs(x) for x in a)
    if peak == 0:
        print("the reference is silent")
        return 1
    worst = max(abs(x - y) for x, y in zip(a, b, strict=True))
    different = sum(x != y for x, y in zip(a, b, strict=True))
    level = 20 * math.log10(worst / peak) if worst else -math.inf
    print(
        f"{args.candidate}: peak {peak:.4f}, {different} of {len(a)} samples differ, worst {level:.1f} dB"
    )
    return 0 if level <= args.tolerance else 1


if __name__ == "__main__":
    sys.exit(main())
