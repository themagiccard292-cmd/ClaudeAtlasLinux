"""Mouse / keyboard injection.

X11     : xdotool (primary) -> pynput (fallback)
Wayland : ydotool (uinput; mouse + keys) with wtype for Unicode typing.
          Wayland isolates clients, so XTest-style injection is impossible —
          these tools work at the kernel/compositor level instead.
"""
from __future__ import annotations

import os
import time
from typing import Protocol

from . import keys as K
from .config import env_choice
from .errors import ActionError, UnsupportedError
from .killswitch import InjectionGuard, KillSwitch
from .runner import CommandRunner
from .session import DisplayEnv
from .x11util import query_pointer

BUTTONS_X11 = {"left": "1", "middle": "2", "right": "3"}
YDOTOOL_BUTTON = {"left": 0x00, "right": 0x01, "middle": 0x02}  # | 0x40 down | 0x80 up


class InputDriver(Protocol):
    name: str

    def move(self, x: int, y: int) -> None: ...
    def click(self, x: int, y: int, button: str = "left", count: int = 1) -> None: ...
    def drag(self, x1: int, y1: int, x2: int, y2: int, button: str = "left") -> None: ...
    def scroll(self, x: int | None, y: int | None, dx: int, dy: int) -> None: ...
    def type_text(self, text: str) -> None: ...
    def hotkey(self, keys: list[str]) -> None: ...
    def pointer(self) -> tuple[int, int] | None: ...


def _chunks(text: str, size: int = 240):
    for i in range(0, len(text), size):
        yield text[i : i + size]


def glide_path(x0: int, y0: int, x1: int, y1: int, max_seconds: float = 0.55) -> list[tuple[int, int, float]]:
    """Eased (smoothstep) pointer path from (x0,y0) to (x1,y1) as (x, y, delay) triples.

    Long moves take longer but never more than `max_seconds`; tiny moves are instant. This is what makes
    the cursor *glide* so a person can follow it, instead of teleporting."""
    import math

    dist = math.hypot(x1 - x0, y1 - y0)
    if dist < 14:
        return [(x1, y1, 0.0)]
    steps = max(6, min(30, int(dist / 32)))
    duration = min(max_seconds, 0.16 + dist / 2400)
    dt = duration / steps
    out = []
    for i in range(1, steps + 1):
        t = i / steps
        e = t * t * (3 - 2 * t)
        out.append((round(x0 + (x1 - x0) * e), round(y0 + (y1 - y0) * e), dt))
    return out


def _steps(x1: int, y1: int, x2: int, y2: int, n: int = 10):
    for i in range(1, n + 1):
        yield round(x1 + (x2 - x1) * i / n), round(y1 + (y2 - y1) * i / n)


class _Base:
    name = "base"

    def __init__(self, runner: CommandRunner, ks: KillSwitch, guard: InjectionGuard, display: str | None = None) -> None:
        self.r = runner
        self.ks = ks
        self.guard = guard
        self.display = display  # X display this driver targets (None = $DISPLAY)
        self.glide = env_choice("ATLAS_GLIDE", "1") != "0"

    def _run(self, argv: list[str], timeout: float = 10.0) -> None:
        res = self.r.run(argv, timeout=timeout)
        if res.timed_out:
            raise ActionError(f"{argv[0]} timed out")
        if res.returncode != 0:
            raise ActionError(f"{argv[0]} failed ({res.returncode}): {res.err.strip()[:200]}")

    def pointer(self) -> tuple[int, int] | None:
        return None


# ------------------------------------------------------------------------------ X11
class XdotoolDriver(_Base):
    name = "xdotool"

    def _go(self, x: int, y: int) -> list[str]:
        """xdotool sub-commands that glide the pointer to (x, y), ending with a short settle pause.
        NB: never use `mousemove --sync` — it blocks forever if the pointer is already there."""
        cur = self.pointer() if self.glide else None
        path = glide_path(cur[0], cur[1], x, y) if cur else [(x, y, 0.0)]
        argv: list[str] = []
        for px, py, dt in path:
            argv += ["mousemove", str(px), str(py)]
            if dt:
                argv += ["sleep", f"{dt:.4f}"]
        return argv + ["sleep", "0.05"]

    def move(self, x, y):
        self._run(["xdotool", *self._go(x, y)], timeout=15)

    def click(self, x, y, button="left", count=1):
        b = BUTTONS_X11[button]
        self._run(["xdotool", *self._go(x, y), "click", "--repeat", str(count), "--delay", "90", b], timeout=15)

    def drag(self, x1, y1, x2, y2, button="left"):
        b = BUTTONS_X11[button]
        argv = ["xdotool", *self._go(x1, y1), "mousedown", b, "sleep", "0.12"]
        for px, py, dt in glide_path(x1, y1, x2, y2, max_seconds=0.9):
            argv += ["mousemove", str(px), str(py), "sleep", f"{max(dt, 0.015):.4f}"]
        argv += ["sleep", "0.08", "mouseup", b]
        self._run(argv, timeout=25)

    def scroll(self, x, y, dx, dy):
        argv = ["xdotool"]
        if x is not None and y is not None:
            argv += self._go(x, y)
        # X11 wheel buttons: 4 up, 5 down, 6 left, 7 right
        for amount, pos, neg in ((dy, "5", "4"), (dx, "7", "6")):
            if amount:
                argv += ["click", "--repeat", str(abs(amount)), "--delay", "25", pos if amount > 0 else neg]
        if len(argv) > 1:
            self._run(argv, timeout=15)

    def type_text(self, text):
        for part in _chunks(text):
            self.ks.check()
            self._run(["xdotool", "type", "--clearmodifiers", "--delay", "8", "--", part], timeout=60)

    def hotkey(self, keys):
        with self.guard.injecting():
            self._run(["xdotool", "key", "--clearmodifiers", K.xdotool_combo(keys)])

    def pointer(self):
        pos = query_pointer(self.display)
        if pos:
            return pos
        res = self.r.run(["xdotool", "getmouselocation", "--shell"], timeout=2)
        if not res.ok:
            return None
        vals = dict(p.split("=", 1) for p in res.text.split() if "=" in p)
        return int(vals["X"]), int(vals["Y"])


class PynputDriver(_Base):
    name = "pynput"

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        from pynput import keyboard, mouse  # ImportError when no X display

        self._kb, self._ms = keyboard, mouse
        self.kbc, self.msc = keyboard.Controller(), mouse.Controller()

    def _key(self, name: str):
        special = {
            "enter": "enter", "esc": "esc", "tab": "tab", "space": "space", "backspace": "backspace",
            "delete": "delete", "home": "home", "end": "end", "up": "up", "down": "down", "left": "left",
            "right": "right", "pageup": "page_up", "pagedown": "page_down", "insert": "insert",
            "ctrl": "ctrl", "shift": "shift", "alt": "alt", "super": "cmd", "altgr": "alt_gr",
            "capslock": "caps_lock", "printscreen": "print_screen",
        }
        attr = special.get(name) or (name if name.startswith("f") and name[1:].isdigit() else None)
        if attr:
            return getattr(self._kb.Key, attr)
        chars = {"minus": "-", "equal": "=", "bracketleft": "[", "bracketright": "]", "semicolon": ";",
                 "apostrophe": "'", "grave": "`", "backslash": "\\", "comma": ",", "period": ".", "slash": "/"}
        return chars.get(name, name)

    def _go(self, x, y):
        cur = tuple(int(v) for v in self.msc.position) if self.glide else None
        for px, py, dt in (glide_path(cur[0], cur[1], x, y) if cur else [(x, y, 0.0)]):
            self.msc.position = (px, py)
            if dt:
                self.ks.sleep(dt)

    def move(self, x, y):
        self._go(x, y)

    def click(self, x, y, button="left", count=1):
        self._go(x, y)
        time.sleep(0.05)
        self.msc.click(getattr(self._ms.Button, button), count)

    def drag(self, x1, y1, x2, y2, button="left"):
        btn = getattr(self._ms.Button, button)
        self.msc.position = (x1, y1)
        self.msc.press(btn)
        try:
            for px, py in _steps(x1, y1, x2, y2):
                self.ks.sleep(0.02)
                self.msc.position = (px, py)
        finally:
            self.msc.release(btn)

    def scroll(self, x, y, dx, dy):
        if x is not None and y is not None:
            self.msc.position = (x, y)
        self.msc.scroll(dx, -dy)  # pynput: positive dy scrolls up

    def type_text(self, text):
        for ch in text:
            self.ks.check()
            self.kbc.type(ch)
            time.sleep(0.006)

    def hotkey(self, keys):
        mapped = [self._key(k) for k in keys]
        with self.guard.injecting():
            pressed = []
            try:
                for k in mapped:
                    self.kbc.press(k)
                    pressed.append(k)
                time.sleep(0.03)
            finally:
                for k in reversed(pressed):
                    self.kbc.release(k)

    def pointer(self):
        return tuple(int(v) for v in self.msc.position)  # type: ignore[return-value]


# -------------------------------------------------------------------------- Wayland
class YdotoolDriver(_Base):
    """ydotool >= 1.0 (needs `ydotoold` + access to /dev/uinput)."""

    name = "ydotool"

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self._daemon_checked = False
        self._wtype_ok = bool(self.r.which("wtype")) and env_choice("ATLAS_USE_WTYPE", "auto") != "0"

    # -- daemon ------------------------------------------------------------------
    def _socket_path(self) -> str:
        return os.environ.get("YDOTOOL_SOCKET") or (
            f"/run/user/{os.getuid()}/.ydotool_socket"
            if os.path.exists(f"/run/user/{os.getuid()}/.ydotool_socket") else "/tmp/.ydotool_socket")

    def _ensure_daemon(self) -> None:
        if self._daemon_checked:
            return
        self._daemon_checked = True
        sock = self._socket_path()
        if os.path.exists(sock):
            os.environ.setdefault("YDOTOOL_SOCKET", sock)
            return
        if not self.r.which("ydotoold"):
            return
        import subprocess

        from .runner import clean_env

        env = clean_env({"YDOTOOL_SOCKET": sock})
        try:
            subprocess.Popen(["ydotoold", "--socket-path", sock], env=env, start_new_session=True,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for _ in range(20):
                if os.path.exists(sock):
                    break
                time.sleep(0.1)
            os.environ["YDOTOOL_SOCKET"] = sock
        except OSError:
            pass

    def _yd(self, *args: str, timeout: float = 10.0) -> None:
        self._ensure_daemon()
        env = None
        sock = os.environ.get("YDOTOOL_SOCKET")
        if sock:
            from .runner import clean_env

            env = clean_env({"YDOTOOL_SOCKET": sock})
        res = self.r.run(["ydotool", *args], timeout=timeout, env=env)
        if res.timed_out:
            raise ActionError("ydotool timed out")
        if res.returncode != 0:
            hint = " Is `ydotoold` running and is /dev/uinput writable (udev rule / `input` group)?"
            raise ActionError(f"ydotool failed: {(res.err or res.text).strip()[:160]}.{hint}")

    # -- primitives ---------------------------------------------------------------
    def move(self, x, y):
        self._yd("mousemove", "--absolute", "-x", str(x), "-y", str(y))

    def _btn(self, button: str, phase: int) -> str:
        return hex(YDOTOOL_BUTTON[button] | phase)

    def click(self, x, y, button="left", count=1):
        self.move(x, y)
        self.ks.sleep(0.05)
        for i in range(count):
            self._yd("click", self._btn(button, 0xC0))
            if i + 1 < count:
                self.ks.sleep(0.08)

    def drag(self, x1, y1, x2, y2, button="left"):
        self.move(x1, y1)
        self._yd("click", self._btn(button, 0x40))
        try:
            for px, py in _steps(x1, y1, x2, y2):
                self.ks.sleep(0.02)
                self.move(px, py)
        finally:
            self._yd("click", self._btn(button, 0x80))

    def scroll(self, x, y, dx, dy):
        if x is not None and y is not None:
            self.move(x, y)
        # REL_WHEEL: positive = up, so scrolling "down" is negative.
        if dy:
            self._yd("mousemove", "--wheel", "-x", "0", "-y", str(-dy))
        if dx:
            self._yd("mousemove", "--wheel", "-x", str(dx), "-y", "0")

    def type_text(self, text):
        for part in _chunks(text, 160):
            self.ks.check()
            if self._wtype_ok:
                res = self.r.run(["wtype", "--", part], timeout=60)
                if res.ok:
                    continue
                self._wtype_ok = False  # compositor lacks virtual-keyboard (e.g. GNOME)
            self._yd("type", "--key-delay", "8", "--", part, timeout=60)

    def hotkey(self, keys):
        with self.guard.injecting():
            if self._wtype_ok:
                res = self.r.run(["wtype", *K.wtype_args(keys)], timeout=10)
                if res.ok:
                    return
                self._wtype_ok = False
            self._yd("key", *K.ydotool_events(keys))


def make_driver(env: DisplayEnv, runner: CommandRunner, ks: KillSwitch, guard: InjectionGuard,
                force: str | None = None) -> InputDriver:
    pref = force or env_choice("ATLAS_INPUT_BACKEND")
    have = runner.which

    def build(kind: str):
        if kind == "xdotool":
            if not have("xdotool"):
                raise UnsupportedError("xdotool not installed")
            return XdotoolDriver(runner, ks, guard, env.display)
        if kind == "pynput":
            return PynputDriver(runner, ks, guard, env.display)
        if kind == "ydotool":
            if not have("ydotool"):
                raise UnsupportedError("ydotool not installed")
            return YdotoolDriver(runner, ks, guard)
        raise UnsupportedError(f"Unknown input backend {kind!r}")

    if pref != "auto":
        return build(pref)
    # XTest tools (xdotool/pynput) cannot drive native Wayland windows, so on
    # Wayland they are only a last resort (XWayland clients only).
    order = ["ydotool", "xdotool", "pynput"] if env.is_wayland else ["xdotool", "pynput"]
    errors = []
    for kind in order:
        try:
            return build(kind)
        except Exception as exc:
            errors.append(f"{kind}: {exc}")
    raise UnsupportedError(
        "No input backend available. Install `xdotool` (X11) or `ydotool` (+ `wtype`) (Wayland). " + "; ".join(errors))
