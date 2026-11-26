"""Tiny python-xlib helpers.

`xdotool getmouselocation` is unreliable on some setups (old xdotool + Xvfb /
XWayland report stale coordinates), so the pointer is read with XQueryPointer.
"""
from __future__ import annotations


def query_pointer(display_name: str | None = None) -> tuple[int, int] | None:
    try:
        from Xlib import display

        d = display.Display(display_name)
        try:
            p = d.screen().root.query_pointer()
            return int(p.root_x), int(p.root_y)
        finally:
            d.close()
    except Exception:
        return None
