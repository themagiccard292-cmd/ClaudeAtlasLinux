"""On-screen text recognition with the `tesseract` CLI (offline, keyless).

Returns text *lines with positions* so Claude can read the screen and click what it reads.
Coordinates are returned in the caller's target space (e.g. the 1280x720 model space).
"""
from __future__ import annotations

import io
import os
import re
import shutil
import subprocess
from dataclasses import dataclass

from PIL import Image, ImageOps

from .runner import clean_env

MIN_CONF = 38


@dataclass(frozen=True)
class TextLine:
    text: str
    x: int
    y: int
    w: int
    h: int
    conf: float
    #: word boxes (text, x, y, w, h) in the same coordinate space — lets Claude click one word of a line
    words: tuple = ()

    @property
    def cx(self) -> int:
        return self.x + self.w // 2

    @property
    def cy(self) -> int:
        return self.y + self.h // 2

    def as_dict(self) -> dict:
        return {"text": self.text, "x": self.x, "y": self.y, "w": self.w, "h": self.h, "conf": round(self.conf)}


def available() -> bool:
    return shutil.which("tesseract") is not None


def prepare(img: Image.Image, target_min_width: int = 1920) -> tuple[Image.Image, float]:
    """Grayscale + upscale small UI text (tesseract wants ~20px x-height). Returns (image, scale)."""
    g = ImageOps.grayscale(img)
    scale = 1.0
    if g.width < target_min_width:
        scale = min(2.0, target_min_width / g.width)
        g = g.resize((round(g.width * scale), round(g.height * scale)), Image.LANCZOS)
    # light-on-dark UIs read poorly: normalise to dark-on-light
    if sum(g.resize((32, 18)).getdata()) / (32 * 18) < 110:
        g = ImageOps.invert(g)
    return g, scale


_JUNK = re.compile(r"^[\W_]+$")


def read_lines(img: Image.Image, out_w: int, out_h: int, lang: str | None = None, timeout: float = 12.0,
               psm: int = 11) -> list[TextLine]:
    """OCR `img` and return lines positioned in an (out_w x out_h) coordinate space."""
    prepped, scale = prepare(img)
    buf = io.BytesIO()
    prepped.save(buf, "PNG")
    lang = lang or os.environ.get("ATLAS_OCR_LANG", "eng")
    proc = subprocess.run(
        ["tesseract", "stdin", "stdout", "-l", lang, "--psm", str(psm), "--oem", "1", "tsv"],
        input=buf.getvalue(), capture_output=True, timeout=timeout, env=clean_env({"OMP_THREAD_LIMIT": "2"}))
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode("utf-8", "replace").strip()[:200] or "tesseract failed")
    return parse_tsv(proc.stdout.decode("utf-8", "replace"), scale, prepped.width / scale, prepped.height / scale, out_w, out_h)


def parse_tsv(tsv: str, scale: float, src_w: float, src_h: float, out_w: int, out_h: int) -> list[TextLine]:
    sx, sy = out_w / src_w / scale, out_h / src_h / scale
    groups: dict[tuple, list[tuple[str, float, int, int, int, int]]] = {}
    for row in tsv.splitlines()[1:]:
        parts = row.split("\t")
        if len(parts) < 12 or parts[0] != "5":
            continue
        text = parts[11].strip()
        try:
            conf = float(parts[10])
            left, top, width, height = (int(parts[i]) for i in (6, 7, 8, 9))
        except ValueError:
            continue
        if not text or conf < MIN_CONF or _JUNK.match(text):
            continue
        groups.setdefault(tuple(parts[2:5]), []).append((text, conf, left, top, width, height))

    lines: list[TextLine] = []
    for words in groups.values():
        words.sort(key=lambda w: w[2])
        # split a tesseract "line" at big horizontal gaps (separate UI elements on one row)
        chunk = [words[0]]
        for w in words[1:]:
            prev = chunk[-1]
            # only very wide gaps split a line (separate UI elements); word-level boxes cover the rest
            if w[2] - (prev[2] + prev[4]) > max(40, prev[5] * 2.2):
                lines.append(_make(chunk, sx, sy))
                chunk = [w]
            else:
                chunk.append(w)
        lines.append(_make(chunk, sx, sy))
    # drop OCR hallucinations (tesseract "reads" text out of photos/noise): short AND unsure
    lines = [ln for ln in lines if ln and len(ln.text) >= 2 and (ln.conf >= 70 or (ln.conf >= 50 and len(ln.text) >= 5))]
    lines.sort(key=lambda ln: (round(ln.y / 14), ln.x))
    return lines


def _make(chunk, sx: float, sy: float) -> TextLine:
    x0 = min(w[2] for w in chunk)
    y0 = min(w[3] for w in chunk)
    x1 = max(w[2] + w[4] for w in chunk)
    y1 = max(w[3] + w[5] for w in chunk)
    words = tuple((w[0], round(w[2] * sx), round(w[3] * sy), round(w[4] * sx), round(w[5] * sy)) for w in chunk)
    return TextLine(" ".join(w[0] for w in chunk), round(x0 * sx), round(y0 * sy), round((x1 - x0) * sx),
                    round((y1 - y0) * sy), sum(w[1] for w in chunk) / len(chunk), words)


_TOKEN = re.compile(r"[\w']+")


def locate(lines: list[TextLine], query: str, index: int = 0) -> list[dict]:
    """Find `query` on screen. Prefers an exact word-sequence match (so "Edit" finds that menu word, not the line's
    centre); falls back to a substring inside a line. Returns matches best-first as {text, cx, cy, x, y, w, h}."""
    want = [t.lower() for t in _TOKEN.findall(query)]
    if not want:
        return []
    exact, loose = [], []
    for ln in lines:
        toks = [(_TOKEN.findall(w[0].lower()) or [w[0].lower()])[0] for w in ln.words] if ln.words else []
        for i in range(len(toks) - len(want) + 1):
            if toks[i:i + len(want)] == want:
                seg = ln.words[i:i + len(want)]
                x0, y0 = min(w[1] for w in seg), min(w[2] for w in seg)
                x1, y1 = max(w[1] + w[3] for w in seg), max(w[2] + w[4] for w in seg)
                exact.append({"text": " ".join(w[0] for w in seg), "x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0,
                              "cx": (x0 + x1) // 2, "cy": (y0 + y1) // 2, "conf": ln.conf})
        if " ".join(want) in " ".join(_TOKEN.findall(ln.text.lower())) and not any(e["y"] == ln.y for e in exact):
            loose.append({"text": ln.text, "x": ln.x, "y": ln.y, "w": ln.w, "h": ln.h, "cx": ln.cx, "cy": ln.cy, "conf": ln.conf})
    ranked = sorted(exact, key=lambda m: -m["conf"]) + sorted(loose, key=lambda m: -m["conf"])
    return ranked[index:index + 1] if index else ranked
