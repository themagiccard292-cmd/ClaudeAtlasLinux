"""Global kill switch.

Design
------
* One `KillSwitch` instance is shared by every component that can move the
  mouse, press keys or spawn processes.
* `trigger()` (a) sets a flag that every primitive checks *before* acting and
  while sleeping, and (b) SIGKILLs the process group of every tracked child
  (xdotool, ydotool, bash, ...). Together this halts all automation threads
  within one scheduling quantum.
* `DoublePressDetector` turns a raw key stream into "Esc pressed twice rapidly".
* `InjectionGuard` lets our own synthetic Esc presses (an agent action) avoid
  tripping the switch.
"""
from __future__ import annotations

import contextlib
import os
import signal
import subprocess
import threading
import time
from typing import Callable, Iterator

from .errors import KillSwitchTriggered


def kill_process_group(proc: subprocess.Popen) -> None:
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    except OSError:
        try:
            proc.kill()
        except OSError:
            pass


class KillSwitch:
    def __init__(self) -> None:
        self._event = threading.Event()
        self._lock = threading.Lock()
        self._procs: set[subprocess.Popen] = set()
        self._listeners: list[Callable[[str], None]] = []
        self.triggered_by: str | None = None
        self.triggered_at: float | None = None

    # ------------------------------------------------------------------ state
    @property
    def active(self) -> bool:
        return self._event.is_set()

    def add_listener(self, cb: Callable[[str], None]) -> None:
        self._listeners.append(cb)

    def trigger(self, source: str = "manual") -> None:
        with self._lock:
            already = self._event.is_set()
            self._event.set()
            if not already:
                self.triggered_by = source
                self.triggered_at = time.time()
            procs = list(self._procs)
        for proc in procs:
            kill_process_group(proc)
        if not already:
            for cb in list(self._listeners):
                try:
                    cb(source)
                except Exception:  # listeners must never block the kill path
                    pass

    def reset(self) -> None:
        with self._lock:
            self._event.clear()
            self.triggered_by = None
            self.triggered_at = None

    def status(self) -> dict:
        return {
            "active": self.active,
            "source": self.triggered_by,
            "at": self.triggered_at,
        }

    # ------------------------------------------------------------- primitives
    def check(self) -> None:
        if self._event.is_set():
            raise KillSwitchTriggered(self.triggered_by)

    def sleep(self, seconds: float) -> None:
        """Interruptible sleep: returns early (by raising) if the switch fires."""
        if seconds <= 0:
            self.check()
            return
        if self._event.wait(seconds):
            raise KillSwitchTriggered(self.triggered_by)

    @contextlib.contextmanager
    def track(self, proc: subprocess.Popen) -> Iterator[subprocess.Popen]:
        with self._lock:
            self._procs.add(proc)
            fired = self._event.is_set()
        if fired:
            kill_process_group(proc)
        try:
            yield proc
        finally:
            with self._lock:
                self._procs.discard(proc)


class DoublePressDetector:
    """Detects `key` pressed twice within `interval` seconds.

    Auto-repeat (a press without an intervening release) is ignored, and any
    other key press in between resets the sequence.
    """

    def __init__(self, key: str = "esc", interval: float = 0.5) -> None:
        self.key = key
        self.interval = interval
        self._down = False
        self._last = float("-inf")

    def feed(self, key: str, pressed: bool, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        if key != self.key:
            if pressed:
                self._last = float("-inf")
            return False
        if not pressed:
            self._down = False
            return False
        if self._down:  # auto-repeat
            return False
        self._down = True
        if now - self._last <= self.interval:
            self._last = float("-inf")
            return True
        self._last = now
        return False


class InjectionGuard:
    """Marks windows of time in which *we* are injecting key events."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._depth = 0
        self._until = 0.0

    @property
    def active(self) -> bool:
        with self._lock:
            return self._depth > 0 or time.monotonic() < self._until

    @contextlib.contextmanager
    def injecting(self, grace: float = 0.25) -> Iterator[None]:
        with self._lock:
            self._depth += 1
        try:
            yield
        finally:
            with self._lock:
                self._depth -= 1
                self._until = time.monotonic() + grace
