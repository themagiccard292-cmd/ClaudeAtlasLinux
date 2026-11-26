"""End-to-end tests against a real X server (Xvfb). Skipped when Xvfb/xdotool are missing.

Exercises the real mss capture, xdotool input, xrandr primary-monitor detection,
the pynput global-hotkey listener (kill switch + push-to-talk) and the
coordinate mapping from screenshot space to screen space.
"""
import io
import os
import shutil
import subprocess
import time

import pytest
from PIL import Image

pytestmark = pytest.mark.skipif(
    not (shutil.which("Xvfb") and shutil.which("xdotool") and shutil.which("xterm")),
    reason="needs Xvfb, xdotool and xterm",
)

DISPLAY = ":97"


@pytest.fixture(scope="module")
def xserver():
    proc = subprocess.Popen(["Xvfb", DISPLAY, "-screen", "0", "1600x900x24", "-nolisten", "tcp", "-noreset"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    env_backup = {k: os.environ.get(k) for k in ("DISPLAY", "XDG_SESSION_TYPE", "WAYLAND_DISPLAY")}
    os.environ.update({"DISPLAY": DISPLAY, "XDG_SESSION_TYPE": "x11"})
    os.environ.pop("WAYLAND_DISPLAY", None)
    for _ in range(50):
        if subprocess.run(["xdpyinfo"], capture_output=True).returncode == 0 if shutil.which("xdpyinfo") else \
                subprocess.run(["xdotool", "getdisplaygeometry"], capture_output=True).returncode == 0:
            break
        time.sleep(0.1)
    yield DISPLAY
    proc.terminate()
    proc.wait(timeout=5)
    for k, v in env_backup.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


@pytest.fixture()
def ctx(xserver):
    from agent_os.context import AppContext

    events = []
    c = AppContext(lambda name, data: events.append((name, data)))
    c.events = events
    yield c
    c.stop()
    time.sleep(0.3)  # let pynput's listener thread exit before Xvfb goes away


def test_session_and_driver_detection(ctx):
    assert ctx.env.is_x11 and ctx.driver and ctx.driver.name == "xdotool"
    mon = ctx.capturer.primary_monitor()
    assert mon and (mon.w, mon.h) == (1600, 900)


def test_real_capture_scales_to_1280x720(ctx):
    shot = ctx.capturer.capture()
    assert (shot.width, shot.height) == (1280, 720) and shot.method == "mss"
    assert (shot.logical_w, shot.logical_h) == (1600, 900)
    img = Image.open(io.BytesIO(shot.jpeg))
    assert img.format == "JPEG" and img.size == (1280, 720)


def test_capture_sees_a_coloured_window(ctx):
    win = subprocess.Popen(["xterm", "-bg", "#ff0000", "-geometry", "40x10+400+300"])
    try:
        time.sleep(1.2)
        shot = ctx.capturer.capture(draw_cursor=False)
        img = Image.open(io.BytesIO(shot.jpeg)).convert("RGB")
        mx, my = shot.to_model(420 + 100, 320 + 60)  # a point inside the xterm
        r, g, b = img.getpixel((mx, my))
        assert r > 200 and g < 60 and b < 60, (r, g, b)
    finally:
        win.terminate()


def test_click_lands_on_mapped_screen_coordinates(ctx):
    shot = ctx.capturer.capture()
    res = ctx.executor.execute({"action": "click", "x": 640, "y": 360})
    assert res["ok"], res
    assert res["screen"] == {"x": 800, "y": 450}
    assert ctx.driver.pointer() == (800, 450)
    assert ctx.executor.execute({"action": "move", "x": 0, "y": 0})["ok"]
    assert ctx.driver.pointer() == (0, 0)
    assert shot.logical_w == 1600


def test_type_and_enter_reach_a_real_terminal(ctx, tmp_path):
    out = tmp_path / "typed.txt"
    term = subprocess.Popen(["xterm", "-geometry", "60x10+100+100", "-e", "bash"])
    try:
        time.sleep(1.2)
        ctx.capturer.capture()
        assert ctx.executor.execute({"action": "click", "x": 200, "y": 120})["ok"]  # focus follows pointer
        assert ctx.executor.execute({"action": "type", "text": f"echo 'héllo wörld 123' > {out}"})["ok"]
        assert ctx.executor.execute({"action": "hotkey", "keys": ["enter"]})["ok"]
        for _ in range(30):
            if out.exists() and out.read_text().strip():
                break
            time.sleep(0.1)
        assert out.read_text().strip() == "héllo wörld 123"
    finally:
        term.terminate()


def test_bash_action_runs_with_display(ctx):
    res = ctx.executor.execute({"action": "bash", "command": "echo $DISPLAY"})
    assert res["ok"] and res["output"]["stdout"].strip() == DISPLAY


def test_double_escape_kill_switch_via_real_key_events(ctx):
    status = ctx.hotkeys.start()
    assert status["source"] == "pynput", status
    time.sleep(0.5)
    subprocess.run(["xdotool", "key", "Escape"])
    time.sleep(0.1)
    assert not ctx.ks.active  # one press is not enough
    time.sleep(0.7)
    subprocess.run(["xdotool", "key", "Escape"])
    time.sleep(0.15)
    subprocess.run(["xdotool", "key", "Escape"])
    for _ in range(30):
        if ctx.ks.active:
            break
        time.sleep(0.1)
    assert ctx.ks.active and ctx.ks.triggered_by == "esc-esc"
    assert any(e[0] == "kill.triggered" for e in ctx.events)
    # while triggered, no action may run
    assert ctx.executor.execute({"action": "click", "x": 1, "y": 1})["killed"] is True
    ctx.ks.reset()
    ctx.hotkeys.stop()


def test_agents_own_escape_presses_do_not_trip_kill_switch(ctx):
    ctx.hotkeys.start()
    time.sleep(0.5)
    assert ctx.executor.execute({"action": "hotkey", "keys": ["esc"]})["ok"]
    assert ctx.executor.execute({"action": "hotkey", "keys": ["esc"]})["ok"]
    time.sleep(0.4)
    assert not ctx.ks.active
    ctx.hotkeys.stop()


def test_push_to_talk_alt_space(ctx):
    ctx.hotkeys.start()
    time.sleep(0.5)
    ptt = []
    ctx.hotkeys.on_ptt = ptt.append
    subprocess.run(["xdotool", "keydown", "alt"])
    subprocess.run(["xdotool", "keydown", "space"])
    time.sleep(0.2)
    subprocess.run(["xdotool", "keyup", "space"])
    subprocess.run(["xdotool", "keyup", "alt"])
    time.sleep(0.3)
    assert ptt == [True, False]
    ctx.hotkeys.stop()


def test_kill_switch_aborts_a_long_running_bash_action(ctx):
    import threading

    threading.Timer(0.5, ctx.ks.trigger, args=("test",)).start()
    t0 = time.monotonic()
    res = ctx.executor.execute({"action": "bash", "command": "sleep 20"})
    assert res["killed"] is True and time.monotonic() - t0 < 3
