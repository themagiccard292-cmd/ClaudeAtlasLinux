import threading
import time

import pytest

from agent_os import keys as K
from agent_os.errors import ActionError, KillSwitchTriggered
from agent_os.killswitch import DoublePressDetector, InjectionGuard, KillSwitch
from agent_os.runner import CommandRunner
from agent_os.session import detect_session
from agent_os.shell import ShellTool


# ----------------------------------------------------------------------- session
def test_detect_wayland_from_xdg():
    env = detect_session({"XDG_SESSION_TYPE": "wayland", "WAYLAND_DISPLAY": "wayland-0", "DISPLAY": ":0"},
                         which=lambda _t: None)
    assert env.is_wayland and env.xwayland and env.detected_from == "XDG_SESSION_TYPE"


def test_detect_x11_from_xdg():
    env = detect_session({"XDG_SESSION_TYPE": "x11", "DISPLAY": ":1"}, which=lambda _t: "/usr/bin/x")
    assert env.is_x11 and not env.xwayland and env.tools["xdotool"]


def test_detect_falls_back_to_display_vars():
    assert detect_session({"XDG_SESSION_TYPE": "tty", "WAYLAND_DISPLAY": "wayland-1"}, which=lambda _t: None).is_wayland
    assert detect_session({"DISPLAY": ":0"}, which=lambda _t: None).is_x11
    assert detect_session({}, which=lambda _t: None).kind == "headless"


def test_forced_session_type():
    env = detect_session({"ATLAS_SESSION_TYPE": "wayland", "XDG_SESSION_TYPE": "x11"}, which=lambda _t: None)
    assert env.is_wayland


# ---------------------------------------------------------------------- keys
def test_key_normalisation_and_aliases():
    assert K.split_combo("Ctrl+Shift+T") == ["ctrl", "shift", "t"]
    assert K.split_combo(["Control", "Return"]) == ["ctrl", "enter"]
    assert K.split_combo("Win+Tab") == ["super", "tab"]
    assert K.split_combo("Alt + F4") == ["alt", "f4"]


def test_unknown_key_rejected():
    with pytest.raises(ActionError):
        K.split_combo("ctrl+nonsense")


def test_backend_key_tables():
    keys = K.split_combo("ctrl+c")
    assert K.xdotool_combo(keys) == "ctrl+c"
    assert K.ydotool_events(keys) == ["29:1", "46:1", "46:0", "29:0"]
    assert K.wtype_args(keys) == ["-M", "ctrl", "-k", "c", "-m", "ctrl"]
    assert K.xdotool_combo(K.split_combo("enter")) == "Return"
    assert K.wtype_args(K.split_combo("super+l"))[:2] == ["-M", "logo"]


def test_evdev_reverse_map():
    assert K.CODE_TO_NAME[1] == "esc" and K.CODE_TO_NAME[57] == "space"
    assert K.CODE_TO_NAME[56] == K.CODE_TO_NAME[100] == "alt"


# ---------------------------------------------------------------- kill switch
def test_double_escape_detection():
    d = DoublePressDetector("esc", 0.5)
    assert not d.feed("esc", True, 0.0)
    assert not d.feed("esc", False, 0.05)
    assert d.feed("esc", True, 0.25)  # second press within window


def test_double_escape_too_slow():
    d = DoublePressDetector("esc", 0.5)
    d.feed("esc", True, 0.0)
    d.feed("esc", False, 0.1)
    assert not d.feed("esc", True, 1.0)


def test_autorepeat_does_not_trigger():
    d = DoublePressDetector("esc", 0.5)
    d.feed("esc", True, 0.0)
    assert not d.feed("esc", True, 0.1)  # key held -> repeat events
    assert not d.feed("esc", True, 0.2)


def test_other_key_between_presses_resets():
    d = DoublePressDetector("esc", 0.5)
    d.feed("esc", True, 0.0)
    d.feed("esc", False, 0.05)
    d.feed("a", True, 0.1)
    assert not d.feed("esc", True, 0.2)


def test_triple_press_fires_once_then_rearms():
    d = DoublePressDetector("esc", 0.5)
    results = []
    for t in (0.0, 0.2, 0.4, 0.6):
        results.append(d.feed("esc", True, t))
        d.feed("esc", False, t + 0.02)
    assert results == [False, True, False, True]


def test_kill_switch_interrupts_sleep_and_fires_listener():
    ks = KillSwitch()
    seen = []
    ks.add_listener(seen.append)
    t = threading.Timer(0.1, ks.trigger, args=("test",))
    t.start()
    started = time.monotonic()
    with pytest.raises(KillSwitchTriggered):
        ks.sleep(5)
    assert time.monotonic() - started < 1.0
    assert seen == ["test"] and ks.active
    ks.reset()
    assert not ks.active
    ks.sleep(0.01)  # no longer raises


def test_kill_switch_kills_running_subprocess():
    ks = KillSwitch()
    runner = CommandRunner(ks)
    threading.Timer(0.2, ks.trigger, args=("t",)).start()
    started = time.monotonic()
    with pytest.raises(KillSwitchTriggered):
        runner.run(["sleep", "10"], timeout=20)
    assert time.monotonic() - started < 2.0


def test_runner_refuses_when_switch_active():
    ks = KillSwitch()
    ks.trigger("pre")
    with pytest.raises(KillSwitchTriggered):
        CommandRunner(ks).run(["true"])


def test_injection_guard():
    g = InjectionGuard()
    assert not g.active
    with g.injecting(grace=0.05):
        assert g.active
    assert g.active  # grace period
    time.sleep(0.08)
    assert not g.active


# ------------------------------------------------------------------------ shell
def test_shell_captures_output_and_exit_code():
    sh = ShellTool(KillSwitch())
    out = sh.run("echo hello; echo oops >&2; exit 3")
    assert out["stdout"].strip() == "hello" and out["stderr"].strip() == "oops" and out["exit_code"] == 3


def test_shell_background_job_does_not_block():
    sh = ShellTool(KillSwitch())
    started = time.monotonic()
    out = sh.run("sleep 5 >/dev/null 2>&1 & echo launched", timeout=10)
    assert out["stdout"].strip() == "launched" and time.monotonic() - started < 2


def test_shell_timeout():
    out = ShellTool(KillSwitch()).run("sleep 5", timeout=1)
    assert out["timed_out"] is True


def test_shell_truncates_huge_output():
    out = ShellTool(KillSwitch()).run("yes x | head -c 100000")
    assert out["truncated"] and len(out["stdout"]) < 13_000


def test_shell_killed_by_switch():
    ks = KillSwitch()
    sh = ShellTool(ks)
    threading.Timer(0.2, ks.trigger, args=("t",)).start()
    with pytest.raises(KillSwitchTriggered):
        sh.run("sleep 10")
