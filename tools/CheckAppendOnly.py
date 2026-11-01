"""Fails if a pull request changes what the format has already promised.

Lines in Opcodes.def may only be added at the end of their list, and golden files may only be added. Everything else in the
format is protected by the golden images themselves, because a change to it stops them loading or changes how they sound.

    CheckAppendOnly.py origin/main
"""

import re
import subprocess
import sys
from pathlib import Path

REGISTRY = "include/modsynth/Opcodes.def"


def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], capture_output=True, text=True, check=False)


def registry_lines(text: str) -> dict[str, list[str]]:
    lists: dict[str, list[str]] = {"OP": [], "INSTR": [], "MIX": []}
    for match in re.finditer(r"^MODSYNTH_(OP|INSTR|MIX)\(.*\)$", text, re.MULTILINE):
        lists[match.group(1)].append(re.sub(r"\s+", "", match.group(0)))
    return lists


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    base = sys.argv[1]
    problems = []

    old = git("show", f"{base}:{REGISTRY}")
    if old.returncode == 0:
        before = registry_lines(old.stdout)
        after = registry_lines(Path(REGISTRY).read_text())
        for name, lines in before.items():
            if after[name][: len(lines)] != lines:
                problems.append(
                    f"a {name} line in {REGISTRY} changed or moved: they may only be added at the end"
                )

    changed = git(
        "diff", "--name-status", "--no-renames", f"{base}...HEAD", "--", "golden"
    )
    if changed.returncode != 0:
        print(changed.stderr, file=sys.stderr)
        return 2
    for line in changed.stdout.splitlines():
        status, path = line.split(maxsplit=1)
        if status != "A" and not path.endswith(".py"):
            problems.append(f"{path} is a golden file, and golden files never change")

    for problem in problems:
        print(problem, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
