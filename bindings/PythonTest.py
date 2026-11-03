"""The Python module, held to what the native engine promises: golden renders within -100 dB, the same bits on any number
of workers, renders that continue one another, and a render that lets other Python threads run.

    uv build && uv run --isolated --no-project --with dist/*.whl --with pytest pytest bindings/PythonTest.py
"""

import json
import sys
import threading
import time
from pathlib import Path

import modsynth
import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent
GOLDEN = ROOT / "golden"
RECIPES = ROOT / "examples" / "Recipes"


def recipe(name: str) -> dict:
    return json.loads((RECIPES / f"{name}.json").read_text())


def golden_audio(name: str, frame: int, channels: int) -> np.ndarray:
    """Golden renders are frames one after another, each channel's samples in turn."""
    kind = "stereo" if channels == 2 else "mono"
    raw = np.fromfile(GOLDEN / f"{name}.{kind}.f32", dtype="<f4")
    return raw.reshape(-1, channels, frame).transpose(0, 2, 1).reshape(-1, channels)


@pytest.mark.parametrize("channels", [1, 2])
@pytest.mark.parametrize(
    "name, frame",
    [
        ("Demo", 128),
        ("AllOps", 128),
        ("Demo32", 32),
        ("Lanes", 32),
        ("Zones", 32),
        ("Hold", 32),
        ("Mods", 32),
    ],
)
def test_golden_images_sound_as_they_did_at_the_freeze(name, frame, channels):
    expected = golden_audio(name, frame, channels)
    engine = modsynth.Engine((GOLDEN / f"{name}.image").read_bytes(), channels=channels)
    assert engine.frame_size == frame
    engine.play()
    heard = engine.render(len(expected))
    assert heard.shape == expected.shape
    assert heard.dtype == np.float32
    peak = np.abs(expected).max()
    assert peak > 0
    assert np.abs(heard - expected).max() <= peak * 1e-5  # -100 dB
    assert engine.guard_trips == 0


def test_a_dict_and_its_json_compile_to_the_same_image():
    request = recipe("Kick808")
    image, report = modsynth.compile_report(request)
    assert report["ok"]
    assert report["programs"][0]["name"]
    assert modsynth.compile_image(json.dumps(request)) == image
    assert image[:4] == (GOLDEN / "Minimal.image").read_bytes()[:4]


def test_a_bad_request_says_where():
    request = recipe("Kick808")
    request["programs"][0]["timeline"]["tracks"][0]["slots"] = ["missing"]
    with pytest.raises(modsynth.CompileError) as caught:
        modsynth.compile_image(request)
    assert "track" in caught.value.where
    assert caught.value.errors[0]["message"] in str(caught.value)
    assert isinstance(caught.value, ValueError)


def test_text_that_is_not_json_is_a_compile_error():
    with pytest.raises(modsynth.CompileError):
        modsynth.compile_image("{")


def test_workers_change_nothing_but_speed():
    image = modsynth.compile_image(recipe("DrumLoop"))
    one = modsynth.render(image, 3.0)
    assert np.abs(one).max() > 0.01
    for workers in (2, 3, 8, 64):
        assert (
            modsynth.render(image, 3.0, workers=workers).tobytes() == one.tobytes()
        ), workers
    assert modsynth.Engine(image, workers=64).workers == 16


def test_workers_run_on_threads():
    # Four looped tracks, which can run side by side. A pool's threads use several cores, and one engine alone uses one.
    request = recipe("AdditiveBell")
    timeline = request["programs"][0]["timeline"]
    timeline["tracks"] = [dict(timeline["tracks"][0], id=i + 1) for i in range(4)]
    image = modsynth.compile_image(request)

    def cores(workers: int) -> float:
        engine = modsynth.Engine(image, channels=1, workers=workers)
        engine.play()
        engine.render(1)
        engine.set_loop(0, engine.length)
        wall, cpu = time.perf_counter(), time.process_time()
        engine.render(48000 * 20)
        return (time.process_time() - cpu) / (time.perf_counter() - wall)

    # A render this short shares a busy runner's cores with whatever else is on it, which cost one trial of three workers
    # half a core in CI. The best of three still can't pass an engine that keeps to one thread, which measures about 1.
    assert cores(1) < 1.2
    assert max(cores(3) for _ in range(3)) > 1.4


def test_renders_of_any_length_continue_one_another():
    image = modsynth.compile_image(recipe("DrumLoop"))
    whole, parts = modsynth.Engine(image), modsynth.Engine(image)
    whole.play()
    parts.play()
    sizes = [0, 1, 31, 32, 33, 1000, 8903]
    expected = whole.render(sum(sizes))
    heard = np.concatenate([parts.render(n) for n in sizes])
    assert heard.tobytes() == expected.tobytes()


def test_a_render_lets_other_python_threads_run():
    # Looped, so that every voice keeps working, and the render takes long enough to watch.
    engine = modsynth.Engine(modsynth.compile_image(recipe("AdditiveBell")), channels=1)
    engine.play()
    engine.render(1)
    engine.set_loop(0, engine.length)
    window = []

    def render():
        start = time.perf_counter()
        engine.render(48000 * 60)
        window.extend([start, time.perf_counter()])

    interval = sys.getswitchinterval()
    sys.setswitchinterval(0.001)
    try:
        thread = threading.Thread(target=render)
        stamps = []
        thread.start()
        while thread.is_alive():
            stamps.append(time.perf_counter())
        thread.join()
    finally:
        sys.setswitchinterval(interval)
    start, end = window
    assert end - start > 0.08, "too short a render to show anything"
    # Holding the GIL, the C++ call would leave this thread at most a switch interval, 1 ms, as it began.
    inside = [t for t in stamps if start + 0.02 < t < end - 0.02]
    assert len(inside) > 1000


def test_a_render_without_seconds_plays_to_the_end_and_its_tail():
    image, report = modsynth.compile_report(recipe("Kick808"))
    program = report["programs"][0]
    audio = modsynth.render(image)
    seconds = program["length_ticks"] / program["ppq"] / 2  # 120 bpm
    assert len(audio) >= seconds * 48000
    assert np.abs(audio[-4800:]).max() < modsynth.SILENCE
    assert np.abs(audio).max() > 0.1


def test_mono_has_one_column():
    audio = modsynth.render(modsynth.compile_image(recipe("Kick808")), 0.5, channels=1)
    assert audio.shape == (24000, 1)


def test_live_notes_sound_without_play():
    engine = modsynth.Engine(modsynth.compile_image(recipe("Kick808")))
    assert np.abs(engine.render(4800)).max() == 0
    engine.note_on(0, 36, 120)
    assert np.abs(engine.render(4800)).max() > 0.05
    engine.note_off(0, 36)


def test_events_are_checked():
    engine = modsynth.Engine(modsynth.compile_image(recipe("Kick808")))
    with pytest.raises(ValueError):
        engine.note_on(0, 128)
    with pytest.raises(ValueError):
        engine.set_param(0, 1, float("nan"))
    with pytest.raises(ValueError):
        engine.set_loop(960, 480)
    with pytest.raises(RuntimeError, match="queue is full"):
        for _ in range(64):
            engine.note_on(0, 36)
    engine.render(32)
    engine.note_on(0, 36)


def test_a_refused_image_raises():
    image = bytearray(modsynth.compile_image(recipe("Kick808")))
    with pytest.raises(ValueError, match="hash"):
        modsynth.Engine(bytes(image[:-1] + bytes([image[-1] ^ 1])))
    with pytest.raises(ValueError):
        modsynth.Engine(b"not an image")
    with pytest.raises(IndexError):
        modsynth.Engine(bytes(image), program=1)
    with pytest.raises(ValueError):
        modsynth.Engine(bytes(image), channels=3)
    with pytest.raises(ValueError):
        modsynth.Engine(bytes(image), workers=0)


@pytest.mark.parametrize("frame", [8, 16, 64, 256, 1024])
def test_every_frame_size_plays(frame):
    request = recipe("Kick808")
    request["frame_size"] = frame
    engine = modsynth.Engine(modsynth.compile_image(request))
    assert engine.frame_size == frame
    engine.play()
    assert np.abs(engine.render(48000)).max() > 0.1


def test_limit_holds_audio_to_full_scale_and_leaves_the_rest_alone():
    quiet = (np.sin(np.arange(4800) / 7.0) * 0.9).astype(np.float32)
    stereo = np.stack([quiet, -quiet], axis=1)
    assert np.array_equal(modsynth.limit(stereo), stereo)
    loud = np.stack([quiet * 4, quiet], axis=1)
    held = modsynth.limit(loud)
    assert held.shape == loud.shape and held.dtype == np.float32
    assert np.abs(held).max() <= 1.0
    assert np.abs(held).max() > 0.99
    assert modsynth.limit(quiet[:, None]).shape == (4800, 1)
    with pytest.raises(ValueError):
        modsynth.limit(np.zeros((10, 3), np.float32))


def test_a_target_refuses_an_image_it_would_play_past_full_scale():
    request = recipe("Kick808")
    request["target"] = json.loads(
        (ROOT / "firmware" / "Profiles" / "Nucleo.json").read_text()
    )
    report = modsynth.compile_report(request)[1]
    assert 0 < report["target"]["programs"][0]["peak"] <= 1
    request["programs"][0]["timeline"].setdefault("master", {})["gain"] = 4.0
    with pytest.raises(modsynth.CompileError) as error:
        modsynth.compile_image(request)
    assert error.value.where == "target"
    assert "over full scale" in str(error.value)
