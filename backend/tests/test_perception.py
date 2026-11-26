"""Perception on a REAL sandbox: windows, OCR, accessibility elements, change timeline, settle, filmstrip."""
import base64
import glob
import io
import re
import shutil
import subprocess
import textwrap
import time

import pytest
from PIL import Image

from agent_os import ocr
from agent_os.killswitch import InjectionGuard, KillSwitch
from agent_os.perception import Frame, compose_strip, pick_frames
from agent_os.sandbox import Sandbox
from agent_os.session import detect_session

needs_x = pytest.mark.skipif(
    not (shutil.which("Xvfb") and shutil.which("xdotool") and shutil.which("xterm")), reason="needs Xvfb/xdotool/xterm")
needs_ocr = pytest.mark.skipif(not ocr.available(), reason="needs tesseract")


def _gtk_python():
    for py in sorted(glob.glob("/usr/bin/python3.[0-9]*"), reverse=True):
        if py.endswith("config"):
            continue
        probe = "import gi; gi.require_version('Gtk','3.0'); gi.require_version('Atspi','2.0'); from gi.repository import Gtk, Atspi"
        if subprocess.run([py, "-c", probe], capture_output=True).returncode == 0:
            return py
    return None


GTK = _gtk_python()
GTK_APP = textwrap.dedent('''
    import gi, sys
    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk
    marker = sys.argv[1]
    win = Gtk.Window(title="Atlas Form"); win.set_default_size(420, 160); win.move(700, 80)
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8, margin=12)
    entry = Gtk.Entry(); entry.set_text("hello field")
    btn = Gtk.Button(label="Save Document")
    btn.connect("clicked", lambda _b: open(marker, "w").write("clicked"))
    box.pack_start(entry, False, False, 0); box.pack_start(btn, False, False, 0)
    win.add(box); win.connect("destroy", Gtk.main_quit); win.show_all(); Gtk.main()
''')


@pytest.fixture()
def sandbox():
    sb = Sandbox(KillSwitch(), InjectionGuard(), detect_session({}, which=lambda _t: None), None)
    sb.start(1280, 720)
    yield sb
    sb.stop()


def sh(sb, cmd):
    return sb.target.executor.execute({"action": "bash", "command": cmd})


def launch_xterm(sb, text, geometry="60x8+40+60", title="Perception Term", bg="#101820"):
    sh(sb, f"nohup xterm -T '{title}' -fa 'DejaVu Sans Mono' -fs 13 -bg '{bg}' -fg '#e8e8e8' -geometry {geometry} "
           f"-e bash -c \"echo '{text}'; sleep 120\" >/dev/null 2>&1 &")


# ----------------------------------------------------------------------------- pure helpers
def _fake_frames(n):
    return [Frame(t=i * 0.2, small=Image.new("RGB", (480, 270), (i * 20 % 255, 80, 120)), delta=3.0, pointer=(0.5, 0.5)) for i in range(n)]


def test_pick_frames_keeps_first_and_last_and_spreads():
    fr = _fake_frames(20)
    chosen = pick_frames(fr, 6)
    assert len(chosen) == 6 and chosen[0] is fr[0] and chosen[-1] is fr[-1]
    assert len(pick_frames(fr[:3], 6)) == 3


def test_filmstrip_is_a_timestamped_contact_sheet():
    data = compose_strip(_fake_frames(9), since=0)
    img = Image.open(io.BytesIO(data))
    assert img.format == "JPEG" and img.size == (426 * 3, 240 * 2)
    assert len(data) < 150_000
    two = Image.open(io.BytesIO(compose_strip(_fake_frames(2), since=0)))
    assert two.size == (426 * 2, 240)


# ------------------------------------------------------------------------- real sandbox
@needs_x
@needs_ocr
def test_text_view_lists_windows_and_reads_text_with_positions(sandbox):
    launch_xterm(sandbox, "Hello Perception 12345")
    time.sleep(1.5)
    per = sandbox_perceiver(sandbox)
    obs = per.observe(vision="auto")
    assert "[windows]" in obs.text and "Perception Term" in obs.text
    line = next((ln for ln in obs.text.splitlines() if "Hello Perception 12345" in ln), None)
    assert line, obs.text
    x, y = map(int, re.search(r"@\((\d+),(\d+)\)", line).groups())
    assert 30 < x < 560 and 50 < y < 200, (x, y)                 # inside the xterm we placed at +40+60
    assert obs.image is None and obs.image_kind == "none"        # rich text perception => NO image needed
    assert obs.meta["ocr_lines"] >= 1 and obs.meta["windows"] >= 1


@needs_x
@needs_ocr
def test_timeline_reports_a_new_window_and_new_text(sandbox):
    per = sandbox_perceiver(sandbox)
    launch_xterm(sandbox, "first window", geometry="40x6+20+20", title="Alpha")
    time.sleep(1.5)
    per.observe()                                                # baseline (also resets the timeline)
    launch_xterm(sandbox, "Second Window Text", geometry="40x6+500+300", title="Beta")
    time.sleep(1.8)
    obs = per.observe()
    assert "[what changed since your last step]" in obs.text
    assert "window opened: “Beta”" in obs.text, obs.text
    assert re.search(r"text appeared: “[^”]*Second", obs.text), obs.text


@needs_x
@needs_ocr
def test_wait_settled_returns_quickly_once_still(sandbox):
    per = sandbox_perceiver(sandbox)
    per.start()
    time.sleep(1.0)
    t0 = time.monotonic()
    info = per.wait_settled(timeout=5)
    assert info["settled"] is True and time.monotonic() - t0 < 2.0


@needs_x
@needs_ocr
def test_motion_produces_a_filmstrip_and_modes_are_honoured(sandbox):
    per = sandbox_perceiver(sandbox)
    sh(sandbox, "nohup xterm -T Ticker -fa 'DejaVu Sans Mono' -fs 13 -geometry 60x20+40+40 -e bash -c "
                "'i=0; while true; do i=$((i+1)); echo tick $i; sleep 0.12; done' >/dev/null 2>&1 &")
    time.sleep(1.2)
    per.observe(settle=False)                                    # reset window
    time.sleep(1.6)
    obs = per.observe(settle=False)                              # screen is continuously changing
    assert obs.meta["motion"] is True and obs.image_kind == "strip", obs.meta
    sheet = Image.open(io.BytesIO(obs.image))
    assert sheet.format == "JPEG" and sheet.width == 426 * 3 and sheet.height in (240, 480)

    time.sleep(1.0)
    assert per.observe(vision="text", settle=False).image is None                    # text mode: never an image
    forced = per.observe(vision="auto", force_image=True, settle=False)
    assert forced.image_kind == "frame" and Image.open(io.BytesIO(forced.image)).size == (1280, 720)
    assert per.observe(vision="frames", settle=False).image is not None              # legacy mode: always an image


@needs_x
@needs_ocr
def test_an_empty_desktop_needs_no_image(sandbox):
    per = sandbox_perceiver(sandbox)
    time.sleep(1.0)
    obs = per.observe(vision="auto")
    assert obs.image_kind == "none" and "[text on screen] none recognised" in obs.text
    assert obs.meta["unexplained"] < 0.02


@needs_x
@needs_ocr
@pytest.mark.skipif(not shutil.which("display"), reason="needs ImageMagick `display`")
def test_a_photo_that_text_cannot_describe_triggers_a_frame(sandbox, tmp_path):
    import random
    from PIL import ImageDraw
    rnd = random.Random(4)
    photo = Image.new("RGB", (640, 400), (90, 140, 200))
    d = ImageDraw.Draw(photo)
    for _ in range(60):                                           # photo-like: many large, varied, high-contrast shapes
        x, y, r = rnd.randint(0, 600), rnd.randint(0, 360), rnd.randint(25, 110)
        colour = (rnd.randint(0, 255), rnd.randint(0, 255), rnd.randint(0, 255))
        (d.ellipse if rnd.random() < 0.5 else d.rectangle)([x, y, x + r, y + r], fill=colour)
    path = tmp_path / "photo.png"
    photo.save(path)
    sh(sandbox, f"nohup display -geometry +120+80 {path} >/dev/null 2>&1 &")
    time.sleep(2.0)
    per = sandbox_perceiver(sandbox)
    obs = per.observe(vision="auto")
    assert obs.meta["unexplained"] > 0.10, obs.meta
    assert obs.image_kind == "frame" and obs.image, obs.meta


@needs_x
@needs_ocr
@pytest.mark.skipif(GTK is None or not shutil.which("dbus-daemon"), reason="needs system python3-gi + Gtk3 + dbus")
def test_accessibility_elements_in_the_sandbox_and_click_from_text(sandbox, tmp_path):
    assert sandbox.status()["accessibility"] is True
    marker = tmp_path / "clicked"
    app = tmp_path / "app.py"
    app.write_text(GTK_APP)
    sh(sandbox, f"nohup {GTK} {app} {marker} >/dev/null 2>&1 &")
    time.sleep(3.0)
    per = sandbox_perceiver(sandbox)
    obs = per.observe()
    assert "[ui elements]" in obs.text, obs.text
    line = next((ln for ln in obs.text.splitlines() if "Save Document" in ln and "button" in ln), None)
    assert line, obs.text
    x, y = map(int, re.search(r"@\((\d+),(\d+)\)", line).groups())
    # THE POINT: act purely from what the text said
    res = sandbox.target.executor.execute({"action": "click", "x": x, "y": y, "target": "Save Document"})
    assert res["ok"]
    for _ in range(30):
        if marker.exists():
            break
        time.sleep(0.1)
    assert marker.exists(), f"clicking the coordinates from the text view did not press the button: {line}"
    # AT-SPI names are not repeated in the OCR section
    ocr_part = obs.text.split("[text on screen]")[-1] if "[text on screen]" in obs.text else ""
    assert ocr_part.count("Save Document") == 0


def sandbox_perceiver(sb):
    from agent_os.perception import Perceiver
    per = Perceiver(sb.target, "sandbox")
    per.start()
    return per


# --------------------------------------------------------- text-addressed clicking
def test_locate_prefers_the_exact_word_over_the_line_centre():
    words = (("File", 75, 62, 28, 14), ("Edit", 120, 62, 28, 14), ("View", 160, 62, 34, 14))
    line = ocr.TextLine("File Edit View", 75, 62, 119, 14, 96.0, words)
    hit = ocr.locate([line], "edit")[0]
    assert (hit["cx"], hit["cy"]) == (134, 69) and hit["w"] == 28
    assert ocr.locate([line], "missing") == []
    multi = ocr.locate([ocr.TextLine("Save Document now", 10, 10, 120, 14, 90.0,
                                     (("Save", 10, 10, 30, 14), ("Document", 45, 10, 60, 14), ("now", 110, 10, 20, 14)))], "save document")[0]
    assert multi["x"] == 10 and multi["w"] == 95


@needs_x
@needs_ocr
def test_click_text_finds_and_clicks_words_by_what_they_say(sandbox, tmp_path):
    from agent_os.context import AppContext  # noqa: F401  (RpcService needs a context-like object)
    from agent_os.rpc import RpcService

    class Ctx:
        def __init__(self, sb): self.sb = sb; self._p = None
        def get_target(self, name): return self.sb.target
        def perceiver(self, name):
            if self._p is None: self._p = sandbox_perceiver(self.sb)
            return self._p
    rpc = RpcService(Ctx(sandbox))
    out = tmp_path / "typed.txt"
    launch_xterm(sandbox, "Open Settings Delete Account", geometry="60x10+40+60", title="Words")
    time.sleep(1.5)
    found = rpc.call_sync("action.execute", {"target": "sandbox", "action": {"action": "find_text", "text": "Settings"}})
    assert found["ok"] and found["matches"], found
    # click_text on a destructive-looking label is gated just like a coordinate click
    gated = rpc.call_sync("action.execute", {"target": "sandbox", "action": {"action": "click_text", "text": "Delete"}})
    assert gated.get("needs_confirmation") is True, gated
    ok = rpc.call_sync("action.execute", {"target": "sandbox", "action": {"action": "click_text", "text": "Settings"}})
    assert ok["ok"] and "clicked the text" in ok["message"], ok
    pos = sandbox.target.driver.pointer()
    m = found["matches"][0]
    shot = sandbox.target.capturer.last
    sx, sy = shot.to_screen(m["cx"], m["cy"])
    assert abs(pos[0] - sx) <= 3 and abs(pos[1] - sy) <= 3, (pos, (sx, sy))
    miss = rpc.call_sync("action.execute", {"target": "sandbox", "action": {"action": "click_text", "text": "Nonexistent Words"}})
    assert miss["ok"] is False and miss["code"] == "not_found"


@needs_x
@needs_ocr
def test_first_window_on_an_empty_desktop_is_reported(sandbox):
    """Regression: with no windows at start, the first one to open was swallowed as the 'initial listing'."""
    per = sandbox_perceiver(sandbox)
    time.sleep(1.0)
    per.observe()                                              # baseline: empty desktop
    launch_xterm(sandbox, "hello there", title="FirstEver")
    time.sleep(1.8)
    obs = per.observe()
    assert "window opened: “FirstEver”" in obs.text, obs.text
