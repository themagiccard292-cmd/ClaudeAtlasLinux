"""Global keyboard listeners: kill-switch (Esc Esc) and push-to-talk (Alt+Space).

Two interchangeable event sources normalise raw keys to `(name, pressed)`:

* `PynputSource` – X11 (XRecord). On Wayland it only sees XWayland windows.
* `EvdevSource`  – reads /dev/input/event* directly, so it works under any
  Wayland compositor *and* X11, but needs read access (user in `input` group).
"""
from __future__ import annotations

import os
import selectors
import threading
import time
from typing import Callable, Protocol

from .config import env_choice
from .keys import CODE_TO_NAME, normalize
from .killswitch import DoublePressDetector, InjectionGuard, KillSwitch
from .session import DisplayEnv

KeyCallback = Callable[[str, bool], None]


class KeyEventSource(Protocol):
    name: str

    def start(self, cb: KeyCallback) -> None: ...
    def stop(self) -> None: ...


# --------------------------------------------------------------------------- pynput
def _pynput_name(key) -> str | None:
    name = getattr(key, "name", None)
    if name:
        for suffix in ("_l", "_r"):
            if name.endswith(suffix):
                name = name[: -len(suffix)]
        name = {"alt_gr": "altgr", "cmd": "super", "page_up": "pageup", "page_down": "pagedown",
                "caps_lock": "capslock", "print_screen": "printscreen"}.get(name, name)
        return name
    char = getattr(key, "char", None)
    if char:
        return char.lower()
    return None


class PynputSource:
    name = "pynput"

    def __init__(self) -> None:
        self._listener = None

    def start(self, cb: KeyCallback) -> None:
        from pynput import keyboard  # raises when no X display is reachable

        def on_press(key):
            n = _pynput_name(key)
            if n:
                cb(n, True)

        def on_release(key):
            n = _pynput_name(key)
            if n:
                cb(n, False)

        self._listener = keyboard.Listener(on_press=on_press, on_release=on_release)
        self._listener.daemon = True
        self._listener.start()
        self._listener.wait()  # surfaces start-up errors

    def stop(self) -> None:
        if self._listener:
            self._listener.stop()
            self._listener = None


# --------------------------------------------------------------------------- evdev
class EvdevSource:
    name = "evdev"

    def __init__(self, rescan_seconds: float = 5.0) -> None:
        self._rescan = rescan_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._cb: KeyCallback | None = None

    @staticmethod
    def keyboards():
        import evdev
        from evdev import ecodes

        found = []
        for path in evdev.list_devices():
            try:
                dev = evdev.InputDevice(path)
            except OSError:
                continue
            caps = dev.capabilities().get(ecodes.EV_KEY, [])
            lowered = dev.name.lower()
            # Skip virtual devices created by ydotool/uinput so that *our own*
            # injected Esc presses cannot trip the kill switch.
            if "ydotool" in lowered or "virtual" in lowered:
                dev.close()
                continue
            if ecodes.KEY_ESC in caps and ecodes.KEY_A in caps:
                found.append(dev)
            else:
                dev.close()
        return found

    @classmethod
    def available(cls) -> tuple[bool, str]:
        try:
            devices = cls.keyboards()
        except ImportError:
            return False, "python-evdev is not installed"
        except Exception as exc:  # pragma: no cover - defensive
            return False, str(exc)
        if not devices:
            return False, "no readable keyboard in /dev/input (add your user to the 'input' group)"
        for d in devices:
            d.close()
        return True, ""

    def start(self, cb: KeyCallback) -> None:
        ok, why = self.available()
        if not ok:
            raise RuntimeError(why)
        self._cb = cb
        self._thread = threading.Thread(target=self._loop, name="evdev-keys", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        from evdev import ecodes

        sel = selectors.DefaultSelector()
        devices: dict[int, object] = {}
        last_scan = 0.0
        while not self._stop.is_set():
            now = time.monotonic()
            if now - last_scan > self._rescan:  # hot-plug support
                last_scan = now
                known = {d.path for d in devices.values()}
                try:
                    for dev in self.keyboards():
                        if dev.path in known:
                            dev.close()
                            continue
                        devices[dev.fd] = dev
                        sel.register(dev.fd, selectors.EVENT_READ)
                except Exception:
                    pass
            if not devices:
                time.sleep(0.5)
                continue
            for key, _ in sel.select(timeout=0.5):
                dev = devices.get(key.fd)
                if dev is None:
                    continue
                try:
                    for ev in dev.read():
                        if ev.type == ecodes.EV_KEY and ev.value in (0, 1):
                            name = CODE_TO_NAME.get(ev.code)
                            if name and self._cb:
                                self._cb(name, ev.value == 1)
                except OSError:  # device unplugged
                    sel.unregister(key.fd)
                    devices.pop(key.fd, None)


# --------------------------------------------------------------------------- service
def _is_importable(module: str) -> bool:
    try:
        __import__(module)
        return True
    except Exception:
        return False


def choose_sources(env: DisplayEnv) -> list[KeyEventSource]:
    pref = env_choice("ATLAS_HOTKEY_BACKEND")
    if pref == "evdev":
        return [EvdevSource()]
    if pref == "pynput":
        return [PynputSource()]
    if env.is_wayland:
        return [EvdevSource(), PynputSource()]
    return [PynputSource(), EvdevSource()]


class HotkeyService:
    def __init__(
        self,
        killswitch: KillSwitch,
        guard: InjectionGuard,
        on_ptt: Callable[[bool], None],
        env: DisplayEnv,
        ptt_keys: tuple[str, ...] | None = None,
        kill_interval: float = 0.5,
    ) -> None:
        self.ks = killswitch
        self.guard = guard
        self.on_ptt = on_ptt
        self.env = env
        raw = os.environ.get("ATLAS_PTT_KEYS", "alt+space") if ptt_keys is None else "+".join(ptt_keys)
        self.ptt_keys = tuple(normalize(k) for k in raw.split("+"))
        self._detector = DoublePressDetector("esc", kill_interval)
        self._held: set[str] = set()
        self._ptt_active = False
        self._source: KeyEventSource | None = None
        self.status: dict = {"source": None, "error": None, "warning": None}

    # ------------------------------------------------------------------ control
    def start(self) -> dict:
        errors: list[str] = []
        for src in choose_sources(self.env):
            try:
                src.start(self._on_key)
            except Exception as exc:
                errors.append(f"{src.name}: {exc}")
                continue
            self._source = src
            warning = None
            if self.env.is_wayland and src.name == "pynput":
                warning = ("Wayland: pynput only sees keys while an XWayland window is focused. "
                           "Add your user to the 'input' group so the evdev listener can be used for a "
                           "reliable global kill switch.")
            self.status = {"source": src.name, "error": None, "warning": warning,
                           "kill_combo": "Esc Esc", "ptt_combo": "+".join(self.ptt_keys)}
            return self.status
        self.status = {"source": None, "error": "; ".join(errors) or "no key source available",
                       "warning": "Global hotkeys and the Esc-Esc kill switch are DISABLED; use the on-screen STOP button.",
                       "kill_combo": "Esc Esc", "ptt_combo": "+".join(self.ptt_keys)}
        return self.status

    def stop(self) -> None:
        if self._source:
            self._source.stop()
            self._source = None

    # ------------------------------------------------------------------- events
    def _on_key(self, name: str, pressed: bool) -> None:
        if pressed:
            self._held.add(name)
        else:
            self._held.discard(name)

        if name == "esc" and self.guard.active:
            return  # our own synthetic Esc
        if self._detector.feed(name, pressed):
            self.ks.trigger("esc-esc")

        combo_down = all(k in self._held for k in self.ptt_keys)
        if combo_down and not self._ptt_active and pressed:
            self._ptt_active = True
            self._safe(self.on_ptt, True)
        elif self._ptt_active and not combo_down:
            self._ptt_active = False
            self._safe(self.on_ptt, False)

    @staticmethod
    def _safe(fn: Callable[[bool], None], arg: bool) -> None:
        try:
            fn(arg)
        except Exception:
            pass
