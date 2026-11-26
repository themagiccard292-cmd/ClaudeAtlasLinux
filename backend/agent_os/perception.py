"""Continuous screen perception.

Claude cannot ingest video, so instead of handing it screenshots this module WATCHES the screen all the time
(~5 Hz) and turns what it sees into text Claude can read and act on:

  * windows        – titles, geometry, which one is active           (python-xlib)
  * UI elements    – buttons / fields with click coordinates         (AT-SPI accessibility tree)
  * text on screen – every line of visible text with its position   (tesseract OCR)
  * a timeline     – what appeared / disappeared / moved while Claude was busy acting
  * settle detection – "wait until the screen stops changing" instead of blind sleeps

Images are the fallback, not the default: a *motion filmstrip* (a contact sheet of the last few frames, with
timestamps) is attached only when something was moving, and a single frame only when text perception is thin or
Claude asks to `look`.
"""
from __future__ import annotations

import io
import threading
import time
from collections import deque
from dataclasses import dataclass, field

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from . import ocr
from .capture import fit_size
from .errors import AgentOSError
from .targets import Target
from .x11util import list_windows

TICK = 0.2
SMALL = (480, 270)
MOTION_DELTA = 0.15         # % of pixels (128x72 map) that changed by >24 levels = "the screen is changing"
PIXEL_STEP = 24
QUIET_FOR = 0.45            # seconds without change = settled
STRIP_COLS, STRIP_ROWS = 3, 2
MAX_ELEMENT_LINES = 70
MAX_TEXT_LINES = 90
MAX_WINDOWS = 12
UNEXPLAINED_LIMIT = 0.10    # share of the screen with visual detail that no text / UI element explains

_FONT = None


def _font(size: int = 15):
    global _FONT
    if _FONT is None:
        for path in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"):
            try:
                _FONT = ImageFont.truetype(path, size)
                break
            except OSError:
                continue
        else:
            _FONT = ImageFont.load_default()
    return _FONT


@dataclass
class Frame:
    t: float
    small: Image.Image
    delta: float
    pointer: tuple[float, float] | None


@dataclass
class Observation:
    text: str
    image: bytes | None
    image_kind: str                 # none | frame | strip
    thumb: bytes
    width: int
    height: int
    changed: bool | None
    meta: dict = field(default_factory=dict)


def _norm(s: str) -> str:
    return " ".join(s.lower().split())


class Perceiver:
    def __init__(self, target: Target, name: str) -> None:
        self.target = target
        self.name = name
        self._ring: deque[Frame] = deque(maxlen=48)
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._prev_gray: np.ndarray | None = None
        self._last_change = time.monotonic()
        self._burst: dict | None = None
        self._events: list[tuple[float, str]] = []
        self._windows: dict[int, tuple[str, tuple[int, int, int, int]]] = {}
        self._windows_seen = False  # initial listing done? (NOT 'dict is empty': an empty desktop is a valid start)
        self._ocr_lines: list[ocr.TextLine] = []
        self._ocr_gray: np.ndarray | None = None
        self._ocr_busy = False
        self._ocr_error: str | None = None
        self._atspi_cache: tuple[float, np.ndarray | None, str, int] | None = None
        self._last_observe_t = time.monotonic()
        self._model_dims: tuple[int, int] | None = None
        self.last_text = ""
        self.mask: dict | None = None

    # ------------------------------------------------------------------ lifecycle
    @property
    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def start(self) -> None:
        if self.running:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name=f"perceive-{self.name}", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    # ----------------------------------------------------------------- watcher loop
    def _event(self, text: str) -> None:
        with self._lock:
            self._events.append((time.monotonic(), text))
            del self._events[:-60]

    def _loop(self) -> None:
        cap = self.target.capturer
        tick = 0
        errors = 0
        while not self._stop.is_set():
            t0 = time.monotonic()
            try:
                img, _mon, _ = cap._grab()
                errors = 0
            except Exception:
                errors += 1
                if errors > 50:
                    return
                self._stop.wait(0.5)
                continue
            self._ingest(img, tick)
            tick += 1
            self._stop.wait(max(0.0, TICK - (time.monotonic() - t0)))

    def _ingest(self, img: Image.Image, tick: int) -> None:
        now = time.monotonic()
        if self.mask:
            ImageDraw.Draw(img).rectangle([self.mask["x"] * img.width, self.mask["y"] * img.height,
                                           (self.mask["x"] + self.mask["w"]) * img.width, (self.mask["y"] + self.mask["h"]) * img.height],
                                          fill=(38, 38, 36))
        small = img.resize(SMALL, Image.BILINEAR)
        gray = np.asarray(small.convert("L").resize((128, 72)), dtype=np.int16)
        delta = 0.0 if self._prev_gray is None else float((np.abs(gray - self._prev_gray) > PIXEL_STEP).mean() * 100)
        changed_cells: set[tuple[int, int]] = set()
        if self._prev_gray is not None and delta > MOTION_DELTA:
            diff = np.abs(gray - self._prev_gray) > PIXEL_STEP
            for cy in range(4):
                for cx in range(8):
                    if diff[cy * 18:(cy + 1) * 18, cx * 16:(cx + 1) * 16].mean() > 0.01:
                        changed_cells.add((cx, cy))
        self._prev_gray = gray
        pointer = None
        try:
            p = self.target.capturer._cursor()
            if p:
                mon = self.target.capturer.primary_monitor()
                ox, oy, lw, lh = (mon.x, mon.y, mon.w, mon.h) if mon else (0, 0, img.width, img.height)
                pointer = ((p[0] - ox) / lw, (p[1] - oy) / lh)
        except Exception:
            pass
        with self._lock:
            self._ring.append(Frame(now, small, delta, pointer))
            if delta > MOTION_DELTA:
                self._last_change = now
                if self._burst is None:
                    self._burst = {"start": now, "cells": set(), "peak": 0.0}
                self._burst["cells"] |= changed_cells
                self._burst["peak"] = max(self._burst["peak"], delta)
            elif self._burst is not None and now - self._last_change >= QUIET_FOR:
                b, self._burst = self._burst, None
                dur = self._last_change - b["start"]
                if dur >= 0.25:
                    self._event(f"screen was changing for {dur:.1f}s ({_region_name(b['cells'])}) and then settled")
        if tick % 2 == 0:
            self._poll_windows()
        # pre-compute OCR while the screen is quiet so observe() can reuse it
        if (not self._ocr_busy and ocr.available() and now - self._last_change >= 0.35
                and self._gray_differs(self._ocr_gray, gray)):
            self._ocr_busy = True
            threading.Thread(target=self._bg_ocr, args=(img.copy(), gray), daemon=True).start()

    @staticmethod
    def _gray_differs(old: np.ndarray | None, new: np.ndarray, thr: float = MOTION_DELTA) -> bool:
        """True when more than `thr` percent of pixels changed noticeably (one line of text is enough)."""
        return old is None or float((np.abs(new - old) > PIXEL_STEP).mean() * 100) > thr

    def _bg_ocr(self, img: Image.Image, gray: np.ndarray) -> None:
        try:
            self._run_ocr(img, gray)
        finally:
            self._ocr_busy = False

    def _model_size(self, img: Image.Image) -> tuple[int, int]:
        return fit_size(img.width, img.height)

    def _run_ocr(self, img: Image.Image, gray: np.ndarray, announce: bool = True) -> None:
        w, h = self._model_size(img)
        try:
            lines = ocr.read_lines(img, w, h)
            self._ocr_error = None
        except Exception as exc:
            self._ocr_error = str(exc)[:160]
            return
        with self._lock:
            old = {_norm(ln.text) for ln in self._ocr_lines}
            new = {_norm(ln.text) for ln in lines}
            first = not self._ocr_lines
            self._ocr_lines, self._ocr_gray = lines, gray
        if announce and not first:
            added = [ln.text for ln in lines if _norm(ln.text) not in old and len(ln.text) >= 3][:5]
            gone = [t for t in sorted(old - new) if len(t) >= 3][:4]
            for t in added:
                self._event(f"text appeared: “{t[:80]}”")
            for t in gone:
                self._event(f"text disappeared: “{t[:80]}”")

    def _poll_windows(self) -> None:
        try:
            wins = list_windows(self.target.env.display)
        except Exception:
            return
        cur = {w["id"]: (w["title"], (w["x"], w["y"], w["w"], w["h"])) for w in wins if w["title"] != "Claude OS Agent"}
        with self._lock:
            old, first = self._windows, not self._windows_seen
            self._windows, self._windows_seen = cur, True
        if first:
            return  # the initial listing is a baseline, not news
        for wid, (title, _g) in cur.items():
            if wid not in old:
                self._event(f"window opened: “{title[:70]}”")
            elif old[wid][0] != title:
                self._event(f"window title changed: “{old[wid][0][:40]}” → “{title[:60]}”")
        for wid, (title, _g) in old.items():
            if wid not in cur:
                self._event(f"window closed: “{title[:70]}”")
        self._active = next((w["id"] for w in wins if w["active"]), None)

    # ------------------------------------------------------------------ settling
    def wait_settled(self, timeout: float = 4.0, quiet: float = QUIET_FOR) -> dict:
        """Block until the screen has been still for `quiet` seconds (or `timeout`)."""
        ks = self.target.capturer.runner.ks
        t0 = time.monotonic()
        while True:
            ks.check()
            now = time.monotonic()
            with self._lock:
                still = now - self._last_change
            if still >= quiet or now - t0 >= timeout:
                return {"settled": still >= quiet, "waited": round(now - t0, 2), "quiet_for": round(still, 2)}
            time.sleep(0.05)

    # ------------------------------------------------------------------ observing
    def observe(self, vision: str = "auto", force_image: bool = False, settle: bool = True,
                settle_timeout: float = 4.0, elements: bool = True, mask: dict | None = None) -> Observation:
        t_start = time.monotonic()
        self.mask = mask
        self.start()
        settle_info = self.wait_settled(settle_timeout) if settle else {"settled": None, "waited": 0}
        cap = self.target.capturer
        shot = cap.capture(mask=mask)                         # also sets the click-coordinate mapping
        raw = cap.last_raw
        model_w, model_h = shot.width, shot.height
        gray = np.asarray(raw.resize(SMALL).convert("L").resize((128, 72)), dtype=np.int16) if raw else None

        # --- text on screen (reuse the background pass when the screen has not changed since)
        ocr_ok = ocr.available()
        if ocr_ok and raw is not None and gray is not None:
            if self._gray_differs(self._ocr_gray, gray) or not self._ocr_lines:
                self._run_ocr(raw, gray, announce=bool(self._ocr_lines))
        lines = list(self._ocr_lines)

        # --- accessibility elements (slow: cached while the screen is unchanged)
        elem_text, elem_count, elem_names = "", 0, []
        elem_boxes: list[tuple[int, int, int, int]] = []
        atspi_ok = False
        if elements:
            st = self.target.atspi.status() if hasattr(self.target.atspi, "status") else {"available": False}
            atspi_ok = bool(st.get("available"))
            if atspi_ok:
                cached = self._atspi_cache
                if cached and gray is not None and cached[1] is not None and time.monotonic() - cached[0] < 12 \
                        and not self._gray_differs(cached[1], gray):
                    elem_text, elem_count = cached[2], cached[3]
                    elem_boxes = list(getattr(self, "_atspi_boxes", []))
                else:
                    try:
                        scope = "all" if self.name == "sandbox" else "active"
                        data = self.target.atspi.tree(shot, scope, MAX_ELEMENT_LINES)
                        elem_text, elem_count = data["text"], len(data["nodes"])
                        self._atspi_cache = (time.monotonic(), gray, elem_text, elem_count)
                        elem_names = [n.get("name", "") for n in data["nodes"] if n.get("name")]
                        for n in data["nodes"]:
                            b = n.get("bbox")
                            if b:
                                x0, y0 = shot.to_model(b[0], b[1])
                                x1, y1 = shot.to_model(b[0] + b[2], b[1] + b[3])
                                elem_boxes.append((x0, y0, x1 - x0, y1 - y0))
                        self._atspi_boxes = elem_boxes
                    except AgentOSError:
                        atspi_ok = False
                if not elem_names and elem_text:
                    elem_names = [ln.split('"')[1] for ln in elem_text.splitlines() if ln.count('"') >= 2]

        # --- windows
        windows = [w for w in (list_windows(self.target.env.display) if self.target.env.display else [])
                   if w["title"] != "Claude OS Agent"]

        # --- timeline since the last observation
        with self._lock:
            since = self._last_observe_t
            events = [(t, e) for t, e in self._events if t >= since - 0.3]
            self._events = [(t, e) for t, e in self._events if t >= time.monotonic() - 30]
            recent = [f for f in self._ring if f.t >= since - 0.3]
            self._last_observe_t = time.monotonic()
        motion_frames = [f for f in recent if f.delta > MOTION_DELTA]
        motion = len(motion_frames) >= 2 and (motion_frames[-1].t - motion_frames[0].t) >= 0.25

        # --- compose
        text = self._compose(shot, windows, elem_text, elem_names, lines, events, since, ocr_ok, atspi_ok,
                             settle_info, motion)
        no_text_channel = not ocr_ok and not atspi_ok
        boxes = [(ln.x, ln.y, ln.w, ln.h) for ln in lines] + elem_boxes
        unexplained = unexplained_detail(raw, boxes, model_w, model_h) if raw is not None else 0.0
        thin = no_text_channel or unexplained > UNEXPLAINED_LIMIT
        image, kind = self._pick_image(vision, force_image, motion, thin, shot.jpeg, recent, shot)
        thumb = _thumb(raw) if raw is not None else shot.jpeg
        self.last_text = text
        return Observation(
            text=text, image=image, image_kind=kind, thumb=thumb, width=model_w, height=model_h, changed=shot.changed,
            meta={"ocr_lines": len(lines), "elements": elem_count, "windows": len(windows), "events": len(events),
                  "motion": motion, "unexplained": round(unexplained, 3), "settled": settle_info.get("settled"), "ocr": ocr_ok, "atspi": atspi_ok,
                  "ocr_error": self._ocr_error, "ms": round((time.monotonic() - t_start) * 1000)})

    # ------------------------------------------------------------------- helpers
    def _pick_image(self, vision: str, force: bool, motion: bool, thin: bool, frame: bytes, recent: list[Frame], shot):
        if vision == "text":
            return None, "none"
        if force:
            return frame, "frame"
        if motion and len(recent) >= 2:
            return compose_strip(recent, self._last_observe_t), "strip"
        if vision == "frames" or thin:
            return frame, "frame"
        return None, "none"

    def _compose(self, shot, windows, elem_text, elem_names, lines, events, since, ocr_ok, atspi_ok, settle, motion) -> str:
        out: list[str] = []
        ptr = shot.cursor and shot.to_model(*shot.cursor)
        out.append(f"[screen] {shot.width}x{shot.height} (all coordinates below are in this space; click them directly)"
                   + (f" · pointer at ({ptr[0]},{ptr[1]})" if ptr else ""))
        if settle.get("settled") is False:
            out.append("[note] the screen was still changing when this was captured (animation / loading) — "
                       "consider a `wait` and look again")
        if windows:
            out.append("[windows]")
            for w in windows[:MAX_WINDOWS]:
                mx, my = shot.to_model(w["x"], w["y"])
                mw, mh = round(w["w"] * shot.width / shot.logical_w), round(w["h"] * shot.height / shot.logical_h)
                out.append(f"  {'*' if w['active'] else ' '} “{w['title'][:80]}” {mw}x{mh} at ({mx},{my})")
            if len(windows) > MAX_WINDOWS:
                out.append(f"  … {len(windows) - MAX_WINDOWS} more")
        if elem_text:
            out.append("[ui elements] (accessibility tree; @(x,y) = click point)")
            out.extend("  " + ln for ln in elem_text.splitlines()[:MAX_ELEMENT_LINES])
        shown = [ln for ln in lines if not any(_norm(ln.text) in _norm(n) or _norm(n) in _norm(ln.text)
                                               for n in elem_names if len(n) >= 3)]
        if lines:
            out.append("[text on screen] (OCR; @(x,y) = centre of the text, WxH size)" if shown else "[text on screen] (all already listed under ui elements)")
            for ln in shown[:MAX_TEXT_LINES]:
                out.append(f"  “{ln.text[:110]}” @({ln.cx},{ln.cy}) {ln.w}x{ln.h}")
            if len(shown) > MAX_TEXT_LINES:
                out.append(f"  … {len(shown) - MAX_TEXT_LINES} more lines")
        elif ocr_ok:
            out.append("[text on screen] none recognised")
        if events:
            out.append("[what changed since your last step]")
            for t, e in events[-14:]:
                out.append(f"  +{max(0.0, t - since):.1f}s {e}")
        elif motion:
            out.append("[what changed since your last step] the screen was moving (see the motion strip)")
        caps = []
        if not ocr_ok:
            caps.append("OCR unavailable (install tesseract-ocr)")
        if not atspi_ok:
            caps.append("no accessibility tree for this display")
        if caps:
            out.append("[perception limits] " + "; ".join(caps))
        return "\n".join(out)

    def locate_text(self, query: str, index: int = 0) -> list[dict]:
        """Where is this text on screen right now? (re-reads the screen if it changed since the last OCR)"""
        cap = self.target.capturer
        shot = cap.capture(draw_cursor=False)
        raw = cap.last_raw
        if ocr.available() and raw is not None:
            gray = np.asarray(raw.resize(SMALL).convert("L").resize((128, 72)), dtype=np.int16)
            if self._gray_differs(self._ocr_gray, gray) or not self._ocr_lines:
                self._run_ocr(raw, gray, announce=False)
        return ocr.locate(list(self._ocr_lines), query, index)

    def status(self) -> dict:
        return {"running": self.running, "ocr": ocr.available(), "ocr_error": self._ocr_error,
                "frames_buffered": len(self._ring), "last_change_age": round(time.monotonic() - self._last_change, 2)}


def unexplained_detail(raw: Image.Image, boxes: list[tuple[int, int, int, int]], model_w: int, model_h: int) -> float:
    """Fraction of the screen that has visual detail (photos, video, canvas, icons) NOT covered by recognised text or
    UI elements. Text/terminal/empty screens score ~0; image-heavy screens score high -> a frame is worth sending."""
    gw, gh = 160, 90
    g = np.asarray(raw.convert("L").resize((gw, gh), Image.BILINEAR), dtype=np.int16)
    grad = np.abs(np.diff(g, axis=1))[:-1, :] + np.abs(np.diff(g, axis=0))[:, :-1]
    detail = grad > 28
    covered = np.zeros_like(detail)
    sx, sy = gw / model_w, gh / model_h
    for x, y, w, h in boxes:
        covered[max(0, int(y * sy) - 1):int((y + h) * sy) + 2, max(0, int(x * sx) - 1):int((x + w) * sx) + 2] = True
    cells = 0
    flagged = 0
    for cy in range(0, detail.shape[0] - 4, 5):         # 5x5-pixel cells of the 160x90 map
        for cx in range(0, detail.shape[1] - 4, 5):
            cells += 1
            block = detail[cy:cy + 5, cx:cx + 5]
            if block.mean() > 0.18 and covered[cy:cy + 5, cx:cx + 5].mean() < 0.5:
                flagged += 1
    return flagged / max(cells, 1)


# ------------------------------------------------------------------------------- images
def _region_name(cells: set[tuple[int, int]]) -> str:
    if not cells:
        return "small area"
    xs = [c[0] for c in cells]
    ys = [c[1] for c in cells]
    if len(cells) >= 24:
        return "most of the screen"
    h = "left" if sum(xs) / len(xs) < 2.7 else "right" if sum(xs) / len(xs) > 4.3 else "centre"
    v = "top" if sum(ys) / len(ys) < 1.0 else "bottom" if sum(ys) / len(ys) > 2.0 else "middle"
    return f"{v} {h}".replace("middle centre", "centre")


def _thumb(raw: Image.Image, width: int = 640) -> bytes:
    h = round(raw.height * width / raw.width)
    buf = io.BytesIO()
    raw.resize((width, h), Image.BILINEAR).save(buf, "JPEG", quality=60)
    return buf.getvalue()


def pick_frames(frames: list[Frame], n: int) -> list[Frame]:
    """Up to n frames spread over the window, always keeping the first and the last."""
    if len(frames) <= n:
        return list(frames)
    idx = sorted({round(i * (len(frames) - 1) / (n - 1)) for i in range(n)})
    return [frames[i] for i in idx]


def compose_strip(frames: list[Frame], since: float, cols: int = STRIP_COLS, rows: int = STRIP_ROWS,
                  tile_w: int = 426) -> bytes:
    """Contact sheet of recent frames, oldest → newest, each stamped with its time (and the pointer)."""
    chosen = pick_frames(frames, cols * rows)
    tile_h = round(tile_w * SMALL[1] / SMALL[0])
    n = len(chosen)
    use_cols = min(cols, n)
    use_rows = (n + use_cols - 1) // use_cols
    sheet = Image.new("RGB", (tile_w * use_cols, tile_h * use_rows), (20, 20, 20))
    t0 = chosen[0].t
    font = _font(15)
    for i, f in enumerate(chosen):
        tile = f.small.resize((tile_w, tile_h), Image.BILINEAR)
        d = ImageDraw.Draw(tile)
        if f.pointer:
            px, py = f.pointer[0] * tile_w, f.pointer[1] * tile_h
            d.ellipse([px - 7, py - 7, px + 7, py + 7], outline=(255, 60, 60), width=2)
        label = f"{i + 1}/{n}  +{f.t - t0:.1f}s"
        w = d.textlength(label, font=font)
        d.rectangle([0, 0, w + 10, 22], fill=(0, 0, 0))
        d.text((5, 3), label, font=font, fill=(255, 255, 255))
        sheet.paste(tile, ((i % use_cols) * tile_w, (i // use_cols) * tile_h))
        ImageDraw.Draw(sheet).rectangle([(i % use_cols) * tile_w, (i // use_cols) * tile_h,
                                         (i % use_cols + 1) * tile_w - 1, (i // use_cols + 1) * tile_h - 1],
                                        outline=(70, 70, 70))
    buf = io.BytesIO()
    sheet.save(buf, "JPEG", quality=72)
    return buf.getvalue()
