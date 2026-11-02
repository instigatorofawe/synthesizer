"""Compile synthesizer projects to images, and play them offline.

    import modsynth
    image = modsynth.compile_image(request)    # a dict, or its JSON, as the web app's exports send
    audio = modsynth.render(image)             # float32, shape (frames, channels), at 48 kHz

`Engine` plays one Program frame by frame and takes live events. A render releases the GIL, so engines on several
threads render at once, and `workers` splits each frame of one engine across a thread pool, with the same output.
"""

import math

import numpy as np

from ._core import CompileError, Engine, compile_report

__all__ = ["CompileError", "Engine", "compile_image", "compile_report", "render"]

SILENCE = 1e-5  # -100 dB, below which a tail counts as over


def compile_image(request) -> bytes:
    """Compiles a request, a dict or its JSON, to an image. Raises CompileError, whose `where` says what failed."""
    return compile_report(request)[0]


def render(
    image: bytes,
    seconds: float | None = None,
    *,
    program: int = 0,
    rate: float = 48000.0,
    channels: int = 2,
    workers: int = 1,
    tail: float = 10.0,
) -> np.ndarray:
    """Plays one Program of an image from its start, and returns float32 of shape (frames, channels).

    With `seconds`, renders exactly that long. Without, renders to the Program's end and then on until every voice has
    stopped and a tenth of a second has stayed below -100 dB, for at most `tail` seconds more.
    """
    engine = Engine(
        image, program=program, rate=rate, channels=channels, workers=workers
    )
    engine.play()
    if seconds is not None:
        return engine.render(round(seconds * rate))
    step = max(1, round(rate / 10))
    parts = []
    while engine.tick < engine.length:
        parts.append(engine.render(step))
    for _ in range(math.ceil(tail * rate / step)):
        parts.append(engine.render(step))
        if engine.active_voices == 0 and np.abs(parts[-1]).max() < SILENCE:
            break
    return np.concatenate(parts)
