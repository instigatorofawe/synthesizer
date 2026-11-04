"""Prints what the page's indicators said at each action of a Playwright trace.

    python3 tools/TraceIndicators.py <trace.zip or a directory of them>... [--markdown]

A failed e2e test keeps a trace: the page as it was before and after each action. This reads the indicators the tests wait on out
of those snapshots (the compile light, the engine's state, the image count, the playhead, the unsaved badge, where a patch is
heard, and the voices sounding), and prints one line for each change, with its time and the action. Most of what a failure seen
only on CI needs (what had compiled, what played, at what rate) is there, without opening the trace viewer. CI runs this on a
failed run and writes it into the job's summary (--markdown).
"""

import json
import sys
import zipfile
from pathlib import Path

WATCHED = [
    "status",
    "state",
    "generation",
    "compiles",
    "tick",
    "unsaved",
    "hearing",
    "voices",
]
TEXT = {
    "generation",
    "compiles",
    "tick",
    "unsaved",
    "voices",
}  # Those whose text is the value, not only their attributes


def events_of(trace: Path):
    with zipfile.ZipFile(trace) as archive:
        for name in archive.namelist():
            if name.endswith(".trace") and name != "test.trace":
                for line in archive.read(name).decode().split("\n"):
                    if line:
                        yield json.loads(line)


def nodes_of(snapshot):
    # A snapshot's nodes in document order, which a later snapshot refers back to by index.
    if "_nodes" not in snapshot:
        nodes = []

        def visit(node):
            if isinstance(node, str):
                nodes.append(node)
            elif isinstance(node, list) and node and isinstance(node[0], str):
                for child in node[2:]:
                    visit(child)
                nodes.append(node)

        visit(snapshot["html"])
        snapshot["_nodes"] = nodes
    return snapshot["_nodes"]


def resolve(node, at, history):
    # A node unchanged since an earlier snapshot is a reference to it: [[snapshots back, index]].
    while isinstance(node, list) and node and isinstance(node[0], list):
        at -= node[0][0]
        node = nodes_of(history[at])[node[0][1]]
    return node, at


def text_of(node, at, history):
    node, at = resolve(node, at, history)
    if isinstance(node, str):
        return node
    return "".join(text_of(child, at, history) for child in node[2:])


def find(node, at, history, found):
    node, at = resolve(node, at, history)
    if isinstance(node, str) or not node:
        return
    attributes = node[1] if len(node) > 1 and isinstance(node[1], dict) else {}
    testid = attributes.get("data-testid")
    if testid in WATCHED and testid not in found:
        shown = " ".join(
            f"{name}={value}"
            for name, value in attributes.items()
            if name.startswith(("data-", "aria-")) and name != "data-testid"
        )
        if testid in TEXT:
            shown += f' "{text_of(node, at, history).strip()[:50]}"'
        found[testid] = shown.strip()
    for child in node[2:]:
        find(child, at, history, found)


def lines_of(trace: Path):
    events = list(events_of(trace))
    titles = {}
    for event in events:
        if event.get("type") == "before":
            params = event.get("params", {})
            target = params.get("selector", params.get("url", ""))
            titles[event["callId"]] = (
                f"{event.get('class')}.{event.get('method')} {target[-60:]}"
            )
    frames = {}
    last = None
    for event in events:
        if event.get("type") != "frame-snapshot":
            continue
        snapshot = event["snapshot"]
        if not snapshot.get("isMainFrame"):
            continue
        history = frames.setdefault(snapshot["frameId"], [])
        history.append(snapshot)
        found = {}
        find(snapshot["html"], len(history) - 1, history, found)
        line = " | ".join(
            f"{testid}: {found[testid]}" for testid in WATCHED if testid in found
        )
        if line == last and snapshot["phase"] != "before":
            continue
        last = line
        action = titles.get(snapshot["callId"], snapshot["callId"])[:70]
        yield f"{snapshot['timestamp'] / 1000:9.3f} {snapshot['phase']:6} {action}\n          {line}"


def main():
    markdown = "--markdown" in sys.argv[1:]
    traces = []
    for argument in (a for a in sys.argv[1:] if a != "--markdown"):
        path = Path(argument)
        traces += sorted(path.rglob("trace.zip")) if path.is_dir() else [path]
    for trace in traces:
        if markdown:
            print(f"<details><summary>{trace.parent.name}</summary>\n\n```")
        else:
            print(f"== {trace}")
        for line in lines_of(trace):
            print(line)
        if markdown:
            print("```\n</details>\n")


if __name__ == "__main__":
    main()
