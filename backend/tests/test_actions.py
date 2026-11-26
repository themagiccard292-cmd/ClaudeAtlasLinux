import pytest

from agent_os.actions import ActionExecutor, normalize_action
from agent_os.capture import Shot
from agent_os.errors import ActionError
from agent_os.killswitch import KillSwitch
from agent_os.shell import ShellTool


class FakeDriver:
    name = "fake"

    def __init__(self):
        self.calls = []

    def move(self, x, y): self.calls.append(("move", x, y))
    def click(self, x, y, button="left", count=1): self.calls.append(("click", x, y, button, count))
    def drag(self, x1, y1, x2, y2, button="left"): self.calls.append(("drag", x1, y1, x2, y2))
    def scroll(self, x, y, dx, dy): self.calls.append(("scroll", x, y, dx, dy))
    def type_text(self, text): self.calls.append(("type", text))
    def hotkey(self, keys): self.calls.append(("hotkey", tuple(keys)))
    def pointer(self): return (0, 0)


class FakeCapturer:
    def __init__(self, shot):
        self.last = shot

    def capture(self, **_):
        return self.last


class FakeAtspi:
    def windows(self): return [{"app": "Files", "title": "Home", "active": True}]
    def act(self, name, role, scope, index): return {"ok": True, "method": "coordinates", "node": {
        "role": "push button", "name": name, "bbox": [100, 200, 40, 20]}}


def make_exec(shot=None):
    # real screen 1920x1200 at origin (100, 50); model image 1152x720 (16:10 letterbox-free)
    shot = shot or Shot(b"", 1152, 720, 1920, 1200, 100, 50, "fake", 1920, 1200)
    ks = KillSwitch()
    drv = FakeDriver()
    return ActionExecutor(FakeCapturer(shot), drv, None, FakeAtspi(), ShellTool(ks), ks), drv, ks


# ------------------------------------------------------------------ normalisation
def test_normalize_click_variants():
    assert normalize_action({"action": "click", "x": 10.4, "y": 20.6})["x"] == 10
    a = normalize_action({"action": "click", "coordinate": [5, 6], "button": "right"})
    assert (a["x"], a["y"], a["button"]) == (5, 6, "right")
    assert normalize_action({"action": "click", "x": 1, "y": 2, "double": True})["type"] == "double_click"


def test_normalize_hotkey_forms():
    assert normalize_action({"action": "hotkey", "keys": "Ctrl+Shift+T"})["keys"] == ["ctrl", "shift", "t"]
    assert normalize_action({"action": "key", "key": "Return"})["keys"] == ["enter"]


@pytest.mark.parametrize("bad", [
    {"action": "click"}, {"action": "click", "x": "a", "y": 1}, {"action": "teleport"}, {},
    {"action": "type", "text": ""}, {"action": "bash"}, {"action": "drag", "x": 1, "y": 1},
    {"action": "scroll", "direction": "sideways"}, {"action": "hotkey", "keys": ["ctrl", "bogus"]},
    {"action": "type", "text": "x" * 5000}, "not-a-dict",
])
def test_normalize_rejects_bad_input(bad):
    with pytest.raises(ActionError):
        normalize_action(bad)


def test_normalize_clamps_numbers():
    assert normalize_action({"action": "wait", "seconds": 999})["seconds"] == 30
    assert normalize_action({"action": "scroll", "amount": 9999})["amount"] == 50
    assert normalize_action({"action": "bash", "command": "ls", "timeout": 99999})["timeout"] == 600


# ----------------------------------------------------------------- coordinate map
def test_click_maps_model_to_screen_coordinates():
    ex, drv, _ = make_exec()
    res = ex.execute({"action": "click", "x": 576, "y": 360})  # centre of model image
    assert res["ok"] and res["screen"] == {"x": 100 + 960, "y": 50 + 600}
    assert drv.calls == [("click", 1060, 650, "left", 1)]


def test_coordinates_are_clamped_inside_image():
    ex, drv, _ = make_exec()
    ex.execute({"action": "click", "x": 99999, "y": -50})
    x, y = drv.calls[0][1:3]
    assert x <= 100 + 1920 and y == 50


def test_shot_round_trip():
    shot = Shot(b"", 1280, 720, 2560, 1440, 0, 0, "t", 2560, 1440)
    assert shot.to_screen(640, 360) == (1280, 720)
    assert shot.to_model(1280, 720) == (640, 360)


def test_double_and_right_click_and_drag_scroll():
    ex, drv, _ = make_exec()
    ex.execute({"action": "double_click", "x": 0, "y": 0})
    ex.execute({"action": "right_click", "x": 0, "y": 0})
    ex.execute({"action": "drag", "x": 0, "y": 0, "to_x": 1152, "to_y": 720})
    ex.execute({"action": "scroll", "direction": "down", "amount": 4, "x": 576, "y": 360})
    ex.execute({"action": "scroll", "direction": "left", "amount": 2})
    kinds = [c[0] for c in drv.calls]
    assert kinds == ["click", "click", "drag", "scroll", "scroll"]
    assert drv.calls[0][4] == 2 and drv.calls[1][3] == "right"
    assert drv.calls[3][3:] == (0, 4) and drv.calls[4][3:] == (-2, 0)


def test_type_and_hotkey_dispatch():
    ex, drv, _ = make_exec()
    ex.execute({"action": "type", "text": "hello"})
    ex.execute({"action": "hotkey", "keys": ["ctrl", "c"]})
    assert drv.calls == [("type", "hello"), ("hotkey", ("ctrl", "c"))]


# --------------------------------------------------------------- confirmation gate
def test_dangerous_bash_is_blocked_until_approved():
    ex, _, _ = make_exec()
    res = ex.execute({"action": "bash", "command": "rm -rf /tmp/atlas-nonexistent-dir"})
    assert res["ok"] is False and res["needs_confirmation"] and res["risk"]["category"] == "destructive"
    ok = ex.execute({"action": "bash", "command": "rm -rf /tmp/atlas-nonexistent-dir"}, approved=True)
    assert ok["ok"] and "needs_confirmation" not in ok


def test_safe_bash_runs_immediately():
    ex, _, _ = make_exec()
    res = ex.execute({"action": "bash", "command": "echo hi"})
    assert res["ok"] and res["output"]["stdout"].strip() == "hi"


def test_failed_bash_reports_not_ok_with_output():
    ex, _, _ = make_exec()
    res = ex.execute({"action": "bash", "command": "ls /definitely/not/here"})
    assert res["ok"] is False and res["output"]["exit_code"] != 0 and res["output"]["stderr"]


def test_model_flagged_click_requires_approval():
    ex, drv, _ = make_exec()
    res = ex.execute({"action": "click", "x": 1, "y": 1, "requires_confirmation": True, "reason": "Sends email"})
    assert res["needs_confirmation"] and drv.calls == []
    assert ex.execute({"action": "click", "x": 1, "y": 1, "requires_confirmation": True}, approved=True)["ok"]


# --------------------------------------------------------------------- kill switch
def test_nothing_executes_after_kill_switch():
    ex, drv, ks = make_exec()
    ks.trigger("test")
    res = ex.execute({"action": "click", "x": 1, "y": 1})
    assert res["ok"] is False and res["killed"] is True and drv.calls == []
    ks.reset()
    assert ex.execute({"action": "click", "x": 1, "y": 1})["ok"]


def test_atspi_click_falls_back_to_bbox_centre():
    ex, drv, _ = make_exec()
    res = ex.execute({"action": "atspi_click", "name": "Open", "role": "push button"})
    assert res["ok"] and drv.calls == [("click", 120, 210, "left", 1)]


def test_atspi_click_with_sensitive_name_needs_approval():
    ex, drv, _ = make_exec()
    res = ex.execute({"action": "atspi_click", "name": "Delete account"})
    assert res.get("needs_confirmation") and drv.calls == []


def test_driverless_executor_reports_clean_error():
    shot = Shot(b"", 100, 100, 100, 100, 0, 0, "t", 100, 100)
    ks = KillSwitch()
    ex = ActionExecutor(FakeCapturer(shot), None, "no xdotool", FakeAtspi(), ShellTool(ks), ks)
    res = ex.execute({"action": "click", "x": 1, "y": 1})
    assert res["ok"] is False and "no xdotool" in res["error"]
