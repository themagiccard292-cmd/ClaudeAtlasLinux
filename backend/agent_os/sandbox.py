"""The sandbox desktop: a private virtual X display (Xvfb) the agent works on.

Why: the user can watch it live in the app while their real desktop stays untouched and unobscured; no
HUD has to cover the screen; and it behaves identically on X11 and Wayland hosts (apps run through
XWayland-less plain X11 inside the sandbox, so no ydotool / portal / compositor tricks are needed).
"""
from __future__ import annotations

import os
import select
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable

from .config import cache_dir
from .errors import ActionError, UnsupportedError
from .killswitch import InjectionGuard, KillSwitch
from .runner import clean_env
from .session import DisplayEnv
from .atspi import AtspiService
from .targets import NoAtspi, Target, build_target

WM_CANDIDATES = ("openbox", "fluxbox", "icewm", "xfwm4", "metacity")
BACKGROUND = "#2f2e2b"

# Make GUI apps launched by the agent use the sandbox's plain X11 display, never the user's real one.
SANDBOX_ENV_BASE: dict[str, str | None] = {
    "WAYLAND_DISPLAY": None,
    "XAUTHORITY": None,
    "XDG_SESSION_TYPE": "x11",
    "GDK_BACKEND": "x11",
    "QT_QPA_PLATFORM": "xcb",
    "MOZ_ENABLE_WAYLAND": "0",
    "ELECTRON_OZONE_PLATFORM_HINT": "x11",
    "SDL_VIDEODRIVER": "x11",
    "CLUTTER_BACKEND": "x11",
}


class Sandbox:
    def __init__(self, ks: KillSwitch, guard: InjectionGuard, real_env: DisplayEnv,
                 on_fx: Callable[[dict], None] | None) -> None:
        self.ks, self.guard, self.real_env, self.on_fx = ks, guard, real_env, on_fx
        self._lock = threading.Lock()
        self._xvfb: subprocess.Popen | None = None
        self._wm: subprocess.Popen | None = None
        self._a11y_procs: list[subprocess.Popen] = []
        self.a11y = False
        self.target: Target | None = None
        self.display: str | None = None
        self.size: tuple[int, int] = (1280, 720)
        self._pidfile = cache_dir() / f"sandbox-{os.getpid()}-{id(self) & 0xffff}.pid"

    # ---------------------------------------------------------------- state
    @property
    def running(self) -> bool:
        return bool(self._xvfb and self._xvfb.poll() is None and self.target)

    def status(self) -> dict:
        import shutil

        return {
            "running": self.running,
            "display": self.display if self.running else None,
            "width": self.size[0], "height": self.size[1],
            "available": shutil.which("Xvfb") is not None and shutil.which("xdotool") is not None,
            "window_manager": self._wm.args[0] if self._wm and self._wm.poll() is None else None,
            "accessibility": self.a11y,
            "reason": None if shutil.which("Xvfb") and shutil.which("xdotool")
            else "Install `xvfb` and `xdotool` (sudo apt install xvfb xdotool) to use the sandbox desktop.",
        }

    # ---------------------------------------------------------------- start
    def start(self, width: int = 1280, height: int = 720) -> dict:
        import shutil

        with self._lock:
            if self.running:
                return self.status()
            if not shutil.which("Xvfb"):
                raise UnsupportedError("Xvfb is not installed (sudo apt install xvfb).")
            if not shutil.which("xdotool"):
                raise UnsupportedError("xdotool is not installed (sudo apt install xdotool).")
            self._reap_stale()
            width = max(640, min(int(width), 2560))
            height = max(480, min(int(height), 1600))

            number = self._launch_xvfb(width, height)
            self.display, self.size = f":{number}", (width, height)
            self._pidfile.write_text(f"{self._xvfb.pid} {os.getpid()}")  # xvfb pid + owning backend pid

            env_extra = {**SANDBOX_ENV_BASE, "DISPLAY": self.display}
            env_extra.update(self._start_a11y(env_extra))
            env = DisplayEnv(kind="x11", desktop="sandbox", display=self.display, wayland_display=None,
                             xwayland=False, detected_from="sandbox", tools=self.real_env.tools)
            self.target = build_target("sandbox", env, self.ks, self.guard, NoAtspi(), self.on_fx,
                                       env_extra=env_extra, force_driver="xdotool",
                                       atspi_factory=(AtspiService if self.a11y else None))
            if self.target.driver is None:
                self._kill_procs()
                self.target = None
                raise UnsupportedError(self.target_error())

            run = self.target.runner.run
            for wm in WM_CANDIDATES:  # a tiny window manager gives windows frames, focus and sane placement
                if shutil.which(wm):
                    self._wm = subprocess.Popen([wm], env=clean_env(env_extra), stdout=subprocess.DEVNULL,
                                                stderr=subprocess.DEVNULL, start_new_session=True)
                    break
            try:
                if shutil.which("xsetroot"):
                    run(["xsetroot", "-solid", BACKGROUND], timeout=5)
            except ActionError:
                pass
            time.sleep(0.3)
            return self.status()

    def _launch_xvfb(self, width: int, height: int, attempts: int = 4) -> str:
        """Start Xvfb and return its display number once it ACCEPTS CONNECTIONS.

        Xvfb sometimes announces its display number (via -displayfd) and then exits straight away, so a
        launch only counts once a client can connect; otherwise retry."""
        from .x11util import query_pointer

        log = cache_dir() / "sandbox-xvfb.log"
        for attempt in range(1, attempts + 1):
            r, w = os.pipe()
            try:
                with open(log, "wb") as errf:
                    self._xvfb = subprocess.Popen(
                        ["Xvfb", "-displayfd", str(w), "-screen", "0", f"{width}x{height}x24", "-nolisten", "tcp", "-noreset"],
                        pass_fds=(w,), stdout=subprocess.DEVNULL, stderr=errf, env=clean_env(), start_new_session=True)
            finally:
                os.close(w)
            try:
                ready, _, _ = select.select([r], [], [], 10)
                number = os.read(r, 32).decode().strip() if ready else ""
            finally:
                os.close(r)
            deadline = time.monotonic() + 6
            while number.isdigit() and time.monotonic() < deadline:
                if self._xvfb.poll() is not None:
                    break
                if query_pointer(f":{number}") is not None:
                    return number
                time.sleep(0.1)
            self._kill_procs()
            time.sleep(0.2 * attempt)
        tail = ""
        try:
            tail = " | ".join(log.read_text(errors="replace").strip().splitlines()[-3:])
        except OSError:
            pass
        raise ActionError(f"Xvfb could not start the sandbox display after {attempts} attempts. {tail}")

    def _start_a11y(self, env_extra: dict) -> dict[str, str | None]:
        """Private D-Bus session + AT-SPI bus for the sandbox, so Claude can read its UI elements.
        Best-effort: without these tools the sandbox simply has no accessibility tree."""
        import shutil

        launcher = next((p for p in ("/usr/libexec/at-spi-bus-launcher", "/usr/lib/at-spi2-core/at-spi-bus-launcher",
                                     shutil.which("at-spi-bus-launcher") or "") if p and os.path.exists(p)), None)
        if not (shutil.which("dbus-daemon") and launcher):
            self.a11y = False
            return {}
        r, w = os.pipe()
        try:
            bus = subprocess.Popen(["dbus-daemon", "--session", "--nofork", f"--print-address={w}"], pass_fds=(w,),
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=clean_env(env_extra),
                                   start_new_session=True)
        finally:
            os.close(w)
        try:
            ready, _, _ = select.select([r], [], [], 5)
            addr = os.read(r, 512).decode().strip() if ready else ""
        finally:
            os.close(r)
        if not addr or bus.poll() is not None:
            if bus.poll() is None:
                bus.terminate()
            self.a11y = False
            return {}
        a11y_env = {
            "DBUS_SESSION_BUS_ADDRESS": addr, "GTK_A11Y": "atspi", "NO_AT_BRIDGE": "0", "GNOME_ACCESSIBILITY": "1",
            "ACCESSIBILITY_ENABLED": "1", "QT_ACCESSIBILITY": "1", "QT_LINUX_ACCESSIBILITY_ALWAYS_ON": "1",
        }
        env = clean_env({**env_extra, **a11y_env})
        self._a11y_procs = [bus]
        try:
            self._a11y_procs.append(subprocess.Popen([launcher, "--launch-immediately"], env=env,
                                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                                     start_new_session=True))
            time.sleep(0.6)
            if shutil.which("dbus-send"):  # tell toolkits (Chromium, Firefox, Qt) that an assistive tech is present
                subprocess.run(["dbus-send", "--session", "--dest=org.a11y.Bus", "--print-reply", "/org/a11y/bus",
                                "org.freedesktop.DBus.Properties.Set", "string:org.a11y.Status", "string:IsEnabled",
                                "variant:boolean:true"], env=env, capture_output=True, timeout=5)
        except Exception:
            pass
        self.a11y = True
        return a11y_env

    def target_error(self) -> str:
        return (self.target.driver_error if self.target else None) or "no input driver for the sandbox"

    # ----------------------------------------------------------------- stop
    def _kill_procs(self) -> None:
        for proc in (self._wm, *self._a11y_procs, self._xvfb):
            if proc and proc.poll() is None:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                except (ProcessLookupError, PermissionError):
                    pass
        for proc in (self._wm, *self._a11y_procs, self._xvfb):
            if proc:
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        pass
        self._wm = self._xvfb = None
        self._a11y_procs = []
        self.a11y = False

    def stop(self) -> dict:
        with self._lock:
            self._kill_procs()  # apps lose their X connection and exit with the display
            self.target = None
            self.display = None
            self._pidfile.unlink(missing_ok=True)
        return self.status()

    def _reap_stale(self) -> None:
        """A backend that was SIGKILLed may have left its Xvfb behind. Scan every sandbox pid-file and reap only
        those whose OWNER backend is gone — never the live sandbox of another running instance."""
        for pf in cache_dir().glob("sandbox-*.pid"):
            if pf == self._pidfile:
                continue
            try:
                parts = pf.read_text().split()
                xvfb_pid, owner = int(parts[0]), int(parts[1])
                if Path(f"/proc/{owner}").exists():
                    continue  # owner is alive: leave it alone
                if "Xvfb" in Path(f"/proc/{xvfb_pid}/cmdline").read_text():
                    os.kill(xvfb_pid, signal.SIGTERM)
            except (OSError, ValueError, IndexError):
                pass
            pf.unlink(missing_ok=True)
