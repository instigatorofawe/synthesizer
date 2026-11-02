"""Wrote the frame 32 goldens' projects from the ones before them. Frozen projects stay as they are, so this is how the same
music reaches a frame 32 engine: what changes is the frame size, and the snap nodes their envelopes now need on the way to a
cutoff, which the older projects predate. Run it only to see how these were made."""

import json
from pathlib import Path

HERE = Path(__file__).parent


def add_snaps(graph: dict) -> None:
    """One snap for each wire into a cutoff. On a wire that is already frame rate, a snap does nothing."""
    next_id = max(node["id"] for node in graph["nodes"])
    added = []
    for edge in graph["edges"]:
        if edge["input"] != "cutoff":
            continue
        next_id += 1
        graph["nodes"].append({"id": next_id, "type": "snap"})
        added.append({**edge, "to": next_id, "input": "in"})
        edge.pop("port", None)
        edge["from"] = next_id
    graph["edges"].extend(added)


for name in ("Demo", "AllOps", "Waves", "Tones"):
    project = json.loads((HERE / f"{name}.json").read_text())
    for patch in project.get("patches", {}).values():
        add_snaps(patch["graph"])
    project["frame_size"] = 32
    (HERE / f"{name}32.json").write_text(json.dumps(project, indent=1) + "\n")
