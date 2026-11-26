#!/usr/bin/env python3
"""Render the app icon set (original artwork: a radial spark on a terracotta tile).

    python3 scripts/make-icons.py        # needs Pillow; writes resources/icons/<N>x<N>.png + icon.png
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "resources" / "icons"
SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512, 1024]
TILE = (201, 100, 66)   # terracotta  #C96442
SPARK = (250, 245, 236)  # cream


def render(size: int) -> Image.Image:
    s = size * 4  # supersample for smooth edges
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([s * 0.04, s * 0.04, s * 0.96, s * 0.96], radius=s * 0.22, fill=TILE)
    cx = cy = s / 2
    for i in range(8):
        a = math.radians(i * 45)
        length = s * (0.30 if i % 2 == 0 else 0.25)
        inner = s * 0.09
        w = s * 0.055
        x0, y0 = cx + math.sin(a) * inner, cy - math.cos(a) * inner
        x1, y1 = cx + math.sin(a) * length, cy - math.cos(a) * length
        d.line([(x0, y0), (x1, y1)], fill=SPARK, width=int(w))
        for x, y in ((x0, y0), (x1, y1)):  # round caps
            d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=SPARK)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for n in SIZES:
        render(n).save(OUT / f"{n}x{n}.png")
    render(512).save(OUT.parent / "icon.png")
    print(f"wrote {len(SIZES)} icons to {OUT}")


if __name__ == "__main__":
    main()
