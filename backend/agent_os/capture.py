"""Primary-monitor screen capture for X11 and Wayland.

X11      : mss on the primary RandR monitor.
Wayland  : grim (wlroots / Hyprland / Sway) -> XDG Desktop Portal (GNOME, KDE)
           -> gnome-screenshot -> spectacle -> ImageMagick `import` (XWayland).

The result is always downscaled to fit 1280x720 (aspect ratio preserved) and
JPEG-compressed. `Shot` records how to map model coordinates back to the real
input coordinate space.
"""
from __future__ import annotations

import io
import os
import re
import tempfile
import time
from dataclasses import dataclass
from urllib.parse import unquote, urlparse

import numpy as np
from PIL import Image, ImageDraw

from .config import env_choice
from .errors import ActionError, UnsupportedError
from .runner import CommandRunner
from .session import DisplayEnv
from .x11util import query_pointer

MODEL_MAX_W = 1280
MODEL_MAX_H = 720


@dataclass(frozen=True)
class Monitor:
    name: str
    x: int
    y: int
    w: int
    h: int
    primary: bool = False


@dataclass
class Shot:
    jpeg: bytes
    width: int  # model-space size (what Claude sees)
    height: int
    logical_w: int  # size of the region in *input* coordinates
    logical_h: int
    origin_x: int  # top-left of that region in input coordinates
    origin_y: int
    method: str
    real_w: int  # raw grabbed pixels
    real_h: int
    changed: bool | None = None
    cursor: tuple[int, int] | None = None

    def to_screen(self, x: float, y: float) -> tuple[int, int]:
        x = min(max(x, 0), self.width - 1)
        y = min(max(y, 0), self.height - 1)
        return (
            self.origin_x + round(x * self.logical_w / self.width),
            self.origin_y + round(y * self.logical_h / self.height),
        )

    def to_model(self, sx: float, sy: float) -> tuple[int, int]:
        return (
            round((sx - self.origin_x) * self.width / self.logical_w),
            round((sy - self.origin_y) * self.height / self.logical_h),
        )

    def meta(self) -> dict:
        return {
            "width": self.width,
            "height": self.height,
            "logical_width": self.logical_w,
            "logical_height": self.logical_h,
            "origin": [self.origin_x, self.origin_y],
            "real_width": self.real_w,
            "real_height": self.real_h,
            "method": self.method,
            "changed": self.changed,
            "cursor": list(self.cursor) if self.cursor else None,
            "bytes": len(self.jpeg),
        }


# ------------------------------------------------------------------ geometry parsing
_XRANDR_MON = re.compile(r"^\s*\d+:\s+\+(\*?)(\S+)\s+(\d+)/\d+x(\d+)/\d+\+(-?\d+)\+(-?\d+)")


def parse_xrandr_monitors(text: str) -> list[Monitor]:
    mons = []
    for line in text.splitlines():
        m = _XRANDR_MON.match(line)
        if m:
            mons.append(Monitor(m.group(2), int(m.group(5)), int(m.group(6)),
                                int(m.group(3)), int(m.group(4)), primary=bool(m.group(1))))
    return mons


def pick_primary(mons: list[Monitor]) -> Monitor | None:
    for m in mons:
        if m.primary:
            return m
    return mons[0] if mons else None


def fit_size(w: int, h: int, max_w: int = MODEL_MAX_W, max_h: int = MODEL_MAX_H) -> tuple[int, int]:
    scale = min(max_w / w, max_h / h, 1.0)
    return max(1, round(w * scale)), max(1, round(h * scale))


# ----------------------------------------------------------------------- portal (dbus)
def portal_screenshot(timeout: float = 20.0) -> bytes:
    """org.freedesktop.portal.Screenshot via jeepney (pure Python D-Bus)."""
    from jeepney import DBusAddress, MatchRule, message_bus, new_method_call
    from jeepney.io.blocking import Proxy, open_dbus_connection

    conn = open_dbus_connection(bus="SESSION")
    try:
        token = f"atlas{os.getpid()}x{int(time.time() * 1000)}"
        sender = conn.unique_name.lstrip(":").replace(".", "_")
        handle = f"/org/freedesktop/portal/desktop/request/{sender}/{token}"
        rule = MatchRule(type="signal", interface="org.freedesktop.portal.Request",
                         member="Response", path=handle)
        Proxy(message_bus, conn).AddMatch(rule)
        with conn.filter(rule) as queue:
            addr = DBusAddress("/org/freedesktop/portal/desktop",
                               bus_name="org.freedesktop.portal.Desktop",
                               interface="org.freedesktop.portal.Screenshot")
            msg = new_method_call(addr, "Screenshot", "sa{sv}",
                                  ("", {"handle_token": ("s", token), "interactive": ("b", False)}))
            conn.send_and_get_reply(msg, timeout=timeout)
            reply = conn.recv_until_filtered(queue, timeout=timeout)
        code, results = reply.body
        if code != 0:
            raise ActionError("Screenshot portal request was denied or cancelled")
        uri = results["uri"][1]
        path = unquote(urlparse(uri).path)
        with open(path, "rb") as fh:
            data = fh.read()
        try:
            os.unlink(path)
        except OSError:
            pass
        return data
    finally:
        conn.close()


# ---------------------------------------------------------------------------- capturer
class ScreenCapturer:
    def __init__(self, env: DisplayEnv, runner: CommandRunner) -> None:
        self.env = env
        self.runner = runner
        self.last: Shot | None = None
        self._prev_thumb: np.ndarray | None = None
        self._mon_cache: tuple[float, Monitor | None] = (0.0, None)
        self._monitors: list[Monitor] = []

    # -------------------------------------------------------------- geometry
    def primary_monitor(self) -> Monitor | None:
        now = time.monotonic()
        if now - self._mon_cache[0] < 5.0:
            return self._mon_cache[1]
        mon = self._detect_primary()
        self._mon_cache = (now, mon)
        return mon

    def _detect_primary(self) -> Monitor | None:
        if self.env.is_wayland:
            mon = self._wayland_primary()
            if mon:
                return mon
        if self.env.display and self.runner.which("xrandr"):
            try:
                res = self.runner.run(["xrandr", "--listmonitors"], timeout=3)
                if res.ok:
                    self._monitors = parse_xrandr_monitors(res.text)
                    return pick_primary(self._monitors)
            except ActionError:
                pass
        return None

    def _wayland_primary(self) -> Monitor | None:
        import json

        try:
            if self.runner.which("swaymsg"):
                res = self.runner.run(["swaymsg", "-t", "get_outputs", "-r"], timeout=3)
                if res.ok:
                    outs = [o for o in json.loads(res.text) if o.get("active")]
                    self._monitors = [Monitor(o["name"], o["rect"]["x"], o["rect"]["y"],
                                              o["rect"]["width"], o["rect"]["height"]) for o in outs]
                    outs.sort(key=lambda o: not o.get("focused", False))
                    if outs:
                        r = outs[0]["rect"]
                        return Monitor(outs[0]["name"], r["x"], r["y"], r["width"], r["height"], True)
            if self.runner.which("hyprctl"):
                res = self.runner.run(["hyprctl", "monitors", "-j"], timeout=3)
                if res.ok:
                    outs = json.loads(res.text)
                    self._monitors = [Monitor(o["name"], o["x"], o["y"],
                                              round(o["width"] / (o.get("scale") or 1)),
                                              round(o["height"] / (o.get("scale") or 1))) for o in outs]
                    outs.sort(key=lambda o: not o.get("focused", False))
                    if outs:
                        o = outs[0]
                        scale = o.get("scale", 1) or 1
                        return Monitor(o["name"], o["x"], o["y"], round(o["width"] / scale),
                                       round(o["height"] / scale), True)
        except Exception:
            return None
        return None

    # --------------------------------------------------------------- grabbing
    def _grab(self) -> tuple[Image.Image, Monitor | None, str]:
        pref = env_choice("ATLAS_CAPTURE_BACKEND")
        if self.env.is_wayland and pref in ("auto", "grim", "portal", "gnome-screenshot", "spectacle"):
            return self._grab_wayland(pref)
        if self.env.display:
            return self._grab_x11()
        raise UnsupportedError("No display available: neither X11 ($DISPLAY) nor Wayland ($WAYLAND_DISPLAY)")

    def _grab_x11(self) -> tuple[Image.Image, Monitor | None, str]:
        mon = self.primary_monitor()
        try:
            import mss

            mss_cls = getattr(mss, "MSS", None) or mss.mss  # mss.mss is deprecated in mss>=10
            with mss_cls() as sct:
                region = ({"left": mon.x, "top": mon.y, "width": mon.w, "height": mon.h}
                          if mon else sct.monitors[1])
                raw = sct.grab(region)
                img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
            return img, mon, "mss"
        except Exception as exc:
            if self.runner.which("import"):
                res = self.runner.run(["import", "-window", "root", "png:-"], timeout=10)
                if res.ok:
                    img = Image.open(io.BytesIO(res.stdout)).convert("RGB")
                    if mon:
                        img = img.crop((mon.x, mon.y, mon.x + mon.w, mon.y + mon.h))
                    return img, mon, "imagemagick"
            raise UnsupportedError(f"X11 capture failed: {exc}") from exc

    def _grab_wayland(self, pref: str) -> tuple[Image.Image, Monitor | None, str]:
        mon = self.primary_monitor()
        attempts: list[str] = []
        order = ["grim", "portal", "gnome-screenshot", "spectacle"]
        if pref in order:
            order = [pref] + [o for o in order if o != pref]
        for method in order:
            try:
                if method == "grim" and self.runner.which("grim"):
                    argv = ["grim", "-t", "ppm"]
                    if mon:
                        argv += ["-g", f"{mon.x},{mon.y} {mon.w}x{mon.h}"]
                    res = self.runner.run(argv + ["-"], timeout=10)
                    if res.ok and res.stdout:
                        return Image.open(io.BytesIO(res.stdout)).convert("RGB"), mon, "grim"
                    attempts.append(f"grim: {res.err.strip()[:120] or 'failed'}")
                elif method == "portal":
                    data = portal_screenshot()
                    img = Image.open(io.BytesIO(data)).convert("RGB")
                    return self._crop_to_monitor(img, mon), mon, "portal"
                elif method in ("gnome-screenshot", "spectacle") and self.runner.which(method):
                    with tempfile.TemporaryDirectory() as tmp:
                        out = os.path.join(tmp, "shot.png")
                        argv = (["gnome-screenshot", "-f", out] if method == "gnome-screenshot"
                                else ["spectacle", "-b", "-n", "-f", "-o", out])
                        res = self.runner.run(argv, timeout=15)
                        if res.ok and os.path.exists(out):
                            img = Image.open(out).convert("RGB")
                            return self._crop_to_monitor(img, mon), mon, method
                        attempts.append(f"{method}: {res.err.strip()[:120] or 'failed'}")
            except ImportError as exc:
                attempts.append(f"{method}: missing module {exc.name}")
            except ActionError as exc:
                if "not found" not in str(exc):
                    attempts.append(f"{method}: {exc}")
            except Exception as exc:  # keep trying the next backend
                attempts.append(f"{method}: {exc}")
        if self.env.display:  # XWayland fallback: only shows X11 clients, better than nothing
            try:
                img, mon2, _ = self._grab_x11()
                return img, mon2, "xwayland-only"
            except Exception as exc:
                attempts.append(f"xwayland: {exc}")
        raise UnsupportedError(
            "Wayland screen capture failed. Install `grim` (wlroots compositors) or allow the "
            "XDG Desktop Portal screenshot prompt (GNOME/KDE). Tried: " + "; ".join(attempts or ["nothing available"])
        )

    def _crop_to_monitor(self, img: Image.Image, mon: Monitor | None) -> Image.Image:
        """Portal / gnome-screenshot return the whole desktop (maybe at physical
        resolution). Crop to the primary monitor using the logical layout."""
        if not mon or not self._monitors:
            return img
        desktop_w = max(m.x + m.w for m in self._monitors)
        desktop_h = max(m.y + m.h for m in self._monitors)
        if (img.width, img.height) == (mon.w, mon.h):
            return img
        sx, sy = img.width / desktop_w, img.height / desktop_h
        box = (round(mon.x * sx), round(mon.y * sy), round((mon.x + mon.w) * sx), round((mon.y + mon.h) * sy))
        return img.crop(box)

    def _cursor(self) -> tuple[int, int] | None:
        if self.env.is_wayland or not self.env.display:
            return None  # Wayland clients cannot read the global pointer position
        return query_pointer()

    # ----------------------------------------------------------------- public
    def capture(
        self,
        max_width: int = MODEL_MAX_W,
        max_height: int = MODEL_MAX_H,
        quality: int = 70,
        mask: dict | None = None,
        draw_cursor: bool = True,
    ) -> Shot:
        img, mon, method = self._grab()
        real_w, real_h = img.size
        if mon:
            origin_x, origin_y, logical_w, logical_h = mon.x, mon.y, mon.w, mon.h
        else:
            origin_x = origin_y = 0
            logical_w, logical_h = real_w, real_h

        cursor = self._cursor() if draw_cursor else None
        draw = ImageDraw.Draw(img)
        if cursor:
            cx = round((cursor[0] - origin_x) * real_w / logical_w)
            cy = round((cursor[1] - origin_y) * real_h / logical_h)
            r = max(7, real_w // 150)
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(255, 40, 40), width=max(2, r // 3))
        if mask:  # fractions of the monitor, e.g. the agent's own HUD pill
            x0 = round(mask["x"] * real_w)
            y0 = round(mask["y"] * real_h)
            x1 = round((mask["x"] + mask["w"]) * real_w)
            y1 = round((mask["y"] + mask["h"]) * real_h)
            draw.rectangle([x0, y0, x1, y1], fill=(38, 38, 36))

        out_w, out_h = fit_size(real_w, real_h, max_width, max_height)
        if (out_w, out_h) != (real_w, real_h):
            img = img.resize((out_w, out_h), Image.LANCZOS)

        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=quality, optimize=True)

        thumb = np.asarray(img.convert("L").resize((64, 36)), dtype=np.int16)
        changed = None
        if self._prev_thumb is not None:
            changed = float(np.abs(thumb - self._prev_thumb).mean()) > 0.8
        self._prev_thumb = thumb

        shot = Shot(buf.getvalue(), out_w, out_h, logical_w, logical_h, origin_x, origin_y,
                    method, real_w, real_h, changed, cursor)
        self.last = shot
        return shot
