"""Live view: pushes down-scaled JPEG frames + the pointer position of a target over the event channel."""
from __future__ import annotations

import base64
import threading
import time
from typing import Callable

Emit = Callable[[str, dict], None]


class LiveStreamer:
    def __init__(self, emit: Emit, get_target: Callable[[str], object | None]) -> None:
        self.emit = emit
        self.get_target = get_target
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self.target = ""
        self.mask: dict | None = None
        self.frames_sent = 0

    @property
    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def start(self, target: str = "sandbox", fps: float = 10, width: int = 960, quality: int = 55,
              mask: dict | None = None) -> dict:
        self.stop()
        self._stop = threading.Event()
        self.target, self.mask = target, mask
        fps = max(1.0, min(float(fps), 24.0))
        self._thread = threading.Thread(target=self._loop, args=(self._stop, target, fps, int(width), int(quality)),
                                        name="live-stream", daemon=True)
        self._thread.start()
        return {"running": True, "target": target, "fps": fps}

    def set_mask(self, mask: dict | None) -> None:
        self.mask = mask

    def stop(self) -> dict:
        self._stop.set()
        t = self._thread
        if t and t.is_alive() and t is not threading.current_thread():
            t.join(timeout=2)
        self._thread = None
        return {"running": False}

    def _loop(self, stop: threading.Event, name: str, fps: float, width: int, quality: int) -> None:
        period = 1.0 / fps
        seq = 0
        errors = 0
        while not stop.is_set():
            t0 = time.monotonic()
            tgt = self.get_target(name)
            if tgt is None:  # sandbox was stopped
                self.emit("screen.frame", {"target": name, "ended": True})
                return
            try:
                f = tgt.capturer.live_frame(width=width, quality=quality, mask=self.mask)  # type: ignore[attr-defined]
                seq += 1
                self.frames_sent += 1 if f["jpeg"] else 0
                self.emit("screen.frame", {
                    "target": name, "seq": seq, "w": f["w"], "h": f["h"], "pointer": f["pointer"],
                    "jpeg": base64.b64encode(f["jpeg"]).decode("ascii") if f["jpeg"] else None,
                })
                errors = 0
            except Exception as exc:  # transient grab failure (display busy etc.)
                errors += 1
                if errors in (1, 20):
                    self.emit("screen.frame", {"target": name, "error": str(exc)})
                if errors > 100:
                    return
            stop.wait(max(0.0, period - (time.monotonic() - t0)))
