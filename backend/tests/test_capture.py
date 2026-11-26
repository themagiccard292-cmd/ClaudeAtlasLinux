import io

from PIL import Image

from agent_os.capture import (Monitor, ScreenCapturer, Shot, fit_size, parse_xrandr_monitors, pick_primary)
from agent_os.killswitch import KillSwitch
from agent_os.runner import CommandRunner
from agent_os.session import detect_session

XRANDR = """Monitors: 2
 0: +HDMI-1 1920/527x1080/296+1920+0  HDMI-1
 1: +*eDP-1 2560/340x1600/210+0+0  eDP-1
"""


def test_parse_xrandr_and_pick_primary_not_first():
    mons = parse_xrandr_monitors(XRANDR)
    assert len(mons) == 2 and mons[0].name == "HDMI-1"
    p = pick_primary(mons)
    assert p == Monitor("eDP-1", 0, 0, 2560, 1600, True)


def test_pick_primary_defaults_to_first():
    mons = parse_xrandr_monitors(" 0: +DP-1 1920/1x1080/1+0+0  DP-1\n 1: +DP-2 1280/1x720/1+1920+0  DP-2\n")
    assert pick_primary(mons).name == "DP-1" and pick_primary([]) is None


def test_fit_size_preserves_aspect_and_never_upscales():
    assert fit_size(1920, 1080) == (1280, 720)
    assert fit_size(2560, 1600) == (1152, 720)
    assert fit_size(800, 600) == (800, 600)
    assert fit_size(3840, 2160) == (1280, 720)


def test_crop_portal_shot_to_primary_monitor():
    env = detect_session({"XDG_SESSION_TYPE": "wayland"}, which=lambda _t: None)
    cap = ScreenCapturer(env, CommandRunner(KillSwitch()))
    left, right = Monitor("L", 0, 0, 1000, 800, True), Monitor("R", 1000, 0, 1000, 800)
    cap._monitors = [left, right]
    # HiDPI portal screenshot at 2x of the whole 2000x800 desktop
    full = Image.new("RGB", (4000, 1600), (0, 0, 0))
    assert cap._crop_to_monitor(full, left).size == (2000, 1600)
    assert cap._crop_to_monitor(full, right).size == (2000, 1600)


def test_capture_pipeline_with_stubbed_grab(monkeypatch):
    env = detect_session({"XDG_SESSION_TYPE": "x11", "DISPLAY": ":9"}, which=lambda _t: None)
    cap = ScreenCapturer(env, CommandRunner(KillSwitch()))
    img = Image.new("RGB", (2560, 1600), (200, 120, 90))
    mon = Monitor("eDP-1", 0, 0, 2560, 1600, True)
    monkeypatch.setattr(cap, "_grab", lambda: (img.copy(), mon, "stub"))
    monkeypatch.setattr(cap, "_cursor", lambda: None)

    mask = {"x": 0.4, "y": 0.9, "w": 0.2, "h": 0.1}
    shot = cap.capture(mask=mask)
    assert (shot.width, shot.height) == (1152, 720)
    assert (shot.logical_w, shot.logical_h) == (2560, 1600)
    assert shot.changed is None and cap.last is shot
    out = Image.open(io.BytesIO(shot.jpeg))
    assert out.format == "JPEG" and out.size == (1152, 720)
    assert out.getpixel((576, 680))[0] < 80   # masked HUD area is dark
    assert out.getpixel((100, 100))[0] > 150  # untouched area keeps colour
    assert len(shot.jpeg) < 120_000

    assert cap.capture(mask=mask).changed is False  # identical frame
    img2 = Image.new("RGB", (2560, 1600), (10, 10, 10))
    monkeypatch.setattr(cap, "_grab", lambda: (img2, mon, "stub"))
    assert cap.capture().changed is True


def test_shot_meta_is_json_friendly():
    import json

    meta = Shot(b"abc", 1280, 720, 1920, 1080, 0, 0, "mss", 1920, 1080, True, (5, 6)).meta()
    assert json.loads(json.dumps(meta))["cursor"] == [5, 6]
