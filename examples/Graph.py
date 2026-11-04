"""Builds patches' graphs a node at a time, and writes a project as JSON that reads and diffs a line at a time. The pieces
(MakePieces.py) and the standard instruments (MakeInstruments.py) are made with it."""

import json
from dataclasses import dataclass


@dataclass(frozen=True)
class Ref:
    """One output of a node, which an input can take instead of a number."""

    id: int
    port: str = "out"

    def __getattr__(self, port: str) -> "Ref":
        if port.startswith("_"):
            raise AttributeError(port)
        return Ref(self.id, port)


class Graph:
    """Builds a patch's graph a node at a time. An input is a number, or a Ref, which becomes an edge."""

    def __init__(self) -> None:
        self.params: list[dict] = []
        self.nodes: list[dict] = []
        self.edges: list[dict] = []

    def node(self, kind: str, inputs: dict | None = None, **options) -> Ref:
        id = len(self.nodes) + 1
        node = {"id": id, "type": kind, **options}
        numbers = {}
        for name, value in (inputs or {}).items():
            if isinstance(value, Ref):
                edge = {"from": value.id, "to": id, "input": name}
                if value.port != "out":
                    edge = {
                        "from": value.id,
                        "port": value.port,
                        "to": id,
                        "input": name,
                    }
                self.edges.append(edge)
            elif value is not None:
                numbers[name] = round(float(value), 6)
        if numbers:
            node["inputs"] = numbers
        self.nodes.append(node)
        return Ref(id)

    def mul(self, a, b) -> Ref:
        return self.node("mul", {"a": a, "b": b})

    def add(self, a, b) -> Ref:
        return self.node("add", {"a": a, "b": b})

    def mtof(self, pitch) -> Ref:
        return self.node("mtof", {"in": pitch})

    def snap(self, signal) -> Ref:
        return self.node("snap", {"in": signal})

    def env(self, attack, decay, sustain, release) -> Ref:
        return self.node(
            "env",
            {"attack": attack, "decay": decay, "sustain": sustain, "release": release},
        )

    def osc(self, wave: str, freq, mode: str | None = None, **inputs) -> Ref:
        options = {"wave": wave} | ({"mode": mode} if mode else {})
        return self.node("osc", {"freq": freq, **inputs}, **options)

    def filter(self, mode: str, signal, cutoff, q=0.707) -> Ref:
        return self.node("biquad", {"in": signal, "cutoff": cutoff, "q": q}, mode=mode)

    def keyed(self, pitch, seconds: float) -> Ref:
        """`seconds` at C4, twice as long two octaves down and half as long two octaves up, as strings ring."""
        return self.mul(
            self.node("ratio", {"in": self.add(self.mul(pitch, -0.5), 90.0)}, root=60),
            seconds,
        )

    def out(self, left, right=None) -> None:
        self.node("out", {"l": left, "r": right})

    def json(self) -> dict:
        graph = {"nodes": self.nodes, "edges": self.edges}
        return {"params": self.params, **graph} if self.params else graph


def dump(value, indent: int = 0) -> str:
    """JSON with one note, node or edge to a line, so a piece reads and diffs a line at a time."""
    flat = json.dumps(value, ensure_ascii=False)
    if not isinstance(value, (dict, list)) or len(flat) + indent <= 118:
        return flat
    pad = " " * (indent + 1)
    if isinstance(value, dict):
        items = [
            f"{pad}{json.dumps(k)}: {dump(v, indent + 1)}" for k, v in value.items()
        ]
        return "{\n" + ",\n".join(items) + "\n" + " " * indent + "}"
    return (
        "[\n"
        + ",\n".join(pad + dump(v, indent + 1) for v in value)
        + "\n"
        + " " * indent
        + "]"
    )
