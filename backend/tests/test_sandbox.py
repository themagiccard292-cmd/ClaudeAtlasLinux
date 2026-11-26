"""The sandbox desktop (private Xvfb) + live streaming + smooth cursor, against real X servers."""
import base64
import io
import shutil
import threading
import time

import pytest
from PIL import Image

from agent_os.killswitch import InjectionGuard, KillSwitch
from agent_os.input_drivers import glide_path
from agent_os.sandbox import Sandbox
from agent_os.session import detect_session
from agent_os.streamer import LiveStreamer

needs_x = pytest.mark.skipif(
    not (shutil.which("Xvfb") and shutil.which("xdotool") and shutil.which("xterm")),
    reason="needs Xvfb, xdotool and xterm")


# ------------------------------------------------------------------------- pure glide maths
def test_glide_path_is_eased_monotonic_and_ends_exactly():
    path = glide_path(0, 0, 1000, 500)
    xs = [p[0] for p in path]
    assert path[-1][:2] == (1000, 500) and xs == sorted(xs) and len(path) >= 6
    steps = [b - a for a, b in zip(xs, xs[1:])]
    assert steps[0] < max(steps) and steps[-1] < max(steps)           # ease-in / ease-out
    assert sum(p[2] for p in path) <= 0.56                            # never a slow crawl


def test_short_moves_are_instant():
    assert glide_path(100, 100, 105, 103) == [(105, 103, 0.0)]


# ------------------------------------------------------------------------------ real sandbox
@pytest.fixture()
def sandbox():
    fx = []
    sb = Sandbox(KillSwitch(), InjectionGuard(), detect_session({}, which=lambda _t: None), fx.append)
    sb.fx = fx
    sb.start(1280, 720)
    yield sb
    sb.stop()


@needs_x
def test_sandbox_is_a_separate_display_with_x11_env(sandbox):
    st = sandbox.status()
    assert st["running"] and st["display"].startswith(":") and (st["width"], st["height"]) == (1280, 720)
    out = sandbox.target.executor.execute(
        {"action": "bash", "command": "echo D=$DISPLAY W=[$WAYLAND_DISPLAY] G=$GDK_BACKEND"})["output"]["stdout"]
    assert f"D={st['display']}" in out and "W=[]" in out and "G=x11" in out


@needs_x
def test_agent_sees_and_drives_apps_on_the_sandbox(sandbox, tmp_path):
    ex = sandbox.target.executor
    ex.execute({"action": "bash", "command": "nohup xterm -bg '#00aa00' -fg white -geometry 50x12+200+150 >/dev/null 2>&1 &"})
    time.sleep(1.5)
    shot = sandbox.target.capturer.capture(draw_cursor=False)
    img = Image.open(io.BytesIO(shot.jpeg)).convert("RGB")
    mx, my = shot.to_model(300, 250)
    r, g, b = img.getpixel((mx, my))
    assert g > 120 and r < 60 and b < 60, (r, g, b)                  # the green xterm is on the sandbox screen

    out = tmp_path / "typed.txt"
    assert ex.execute({"action": "click", "x": mx, "y": my})["ok"]
    assert ex.execute({"action": "type", "text": f"echo from-sandbox > {out}"})["ok"]
    assert ex.execute({"action": "hotkey", "keys": ["enter"]})["ok"]
    for _ in range(30):
        if out.exists() and out.read_text().strip():
            break
        time.sleep(0.1)
    assert out.read_text().strip() == "from-sandbox"


@needs_x
def test_cursor_glides_and_stream_reports_every_step(sandbox):
    frames, lock = [], threading.Lock()

    def emit(name, data):
        if name == "screen.frame":
            with lock:
                frames.append(data)

    streamer = LiveStreamer(emit, lambda n: sandbox.target if n == "sandbox" else None)
    streamer.start("sandbox", fps=20, width=640, quality=50)
    time.sleep(0.5)
    ex = sandbox.target.executor
    ex.execute({"action": "move", "x": 10, "y": 10})
    time.sleep(0.3)
    with lock:
        frames.clear()
    res = ex.execute({"action": "click", "x": 1200, "y": 650, "target": "far corner"})
    time.sleep(0.4)
    streamer.stop()
    assert res["ok"]

    pts = [tuple(f["pointer"]) for f in frames if f.get("pointer")]
    distinct = list(dict.fromkeys(pts))
    assert len(distinct) >= 4, f"cursor teleported; saw only {distinct}"       # it travelled through intermediate points
    xs = [p[0] for p in distinct]
    assert xs == sorted(xs) and distinct[-1][0] > 0.9                         # monotone towards the target
    first = next(f for f in frames if f.get("jpeg"))
    assert Image.open(io.BytesIO(base64.b64decode(first["jpeg"]))).size == (first["w"], first["h"])
    # idle frames omit the JPEG (cheap), pointer still reported
    assert any(f.get("jpeg") is None and f.get("pointer") for f in frames)

    click_fx = [e for e in sandbox.fx if e["kind"] == "click"]
    assert click_fx and click_fx[0]["label"] == "far corner"
    assert 0.9 < click_fx[0]["x"] <= 1.0 and 0.85 < click_fx[0]["y"] <= 1.0   # normalised 0..1 position


@needs_x
def test_hud_style_mask_is_painted_out_of_live_frames(sandbox):
    cap = sandbox.target.capturer
    plain = cap.live_frame(width=640, quality=80, keepalive=0)
    masked = cap.live_frame(width=640, quality=80, mask={"x": 0.4, "y": 0.4, "w": 0.2, "h": 0.2}, keepalive=0)
    img = Image.open(io.BytesIO(masked["jpeg"])).convert("RGB")
    cx, cy = int(640 * 0.5), int(plain["h"] * 0.5)
    assert max(img.getpixel((cx, cy))) < 70 and plain["jpeg"]


@needs_x
def test_stop_removes_the_display_and_ends_the_stream(sandbox):
    display = sandbox.display
    ended = threading.Event()
    streamer = LiveStreamer(lambda n, d: ended.set() if d.get("ended") else None,
                            lambda n: sandbox.target if sandbox.running else None)
    streamer.start("sandbox", fps=20)
    time.sleep(0.4)
    sandbox.stop()
    assert ended.wait(3), "stream should signal that the sandbox ended"
    assert not sandbox.running and sandbox.status()["display"] is None
    time.sleep(0.3)
    assert not shutil.os.path.exists(f"/tmp/.X11-unix/X{display.lstrip(':')}")
    streamer.stop()


@needs_x
def test_kill_switch_stops_sandbox_actions_too(sandbox):
    ks = sandbox.ks
    threading.Timer(0.4, ks.trigger, args=("t",)).start()
    res = sandbox.target.executor.execute({"action": "bash", "command": "sleep 30"})
    assert res["killed"] is True


def test_missing_xvfb_gives_actionable_error(monkeypatch):
    from agent_os.errors import UnsupportedError
    monkeypatch.setattr(shutil, "which", lambda _n: None)
    sb = Sandbox(KillSwitch(), InjectionGuard(), detect_session({}, which=lambda _t: None), None)
    with pytest.raises(UnsupportedError, match="xvfb"):
        sb.start()
    assert sb.status()["available"] is False and "xvfb" in sb.status()["reason"]


@needs_x
def test_second_instance_never_kills_a_live_sandbox():
    """Regression: starting a sandbox used to SIGTERM another running instance's Xvfb via a shared pid-file."""
    mk = lambda: Sandbox(KillSwitch(), InjectionGuard(), detect_session({}, which=lambda _t: None), None)
    a, b = mk(), mk()
    try:
        a.start()
        b.start()
        time.sleep(0.5)
        assert a.running and b.running and a.display != b.display
    finally:
        a.stop()
        b.stop()


@needs_x
def test_stale_xvfb_of_a_dead_owner_is_reaped():
    import subprocess
    from agent_os.config import cache_dir

    fake = subprocess.Popen(["Xvfb", ":57", "-screen", "0", "640x480x24", "-nolisten", "tcp"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.8)
    pf = cache_dir() / "sandbox-999999-1.pid"
    pf.write_text(f"{fake.pid} 999999")        # owner pid 999999 does not exist -> stale
    sb = Sandbox(KillSwitch(), InjectionGuard(), detect_session({}, which=lambda _t: None), None)
    try:
        sb.start()
        assert fake.wait(timeout=5) is not None and not pf.exists()
    finally:
        sb.stop()
        if fake.poll() is None:
            fake.kill()
