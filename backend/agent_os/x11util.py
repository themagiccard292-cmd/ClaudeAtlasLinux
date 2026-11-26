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


def list_windows(display_name: str | None = None, max_windows: int = 40) -> list[dict]:
    """Visible top-level windows: [{id, title, x, y, w, h, active}] in screen coordinates (X11 / XWayland)."""
    try:
        from Xlib import X, display

        d = display.Display(display_name)
        try:
            root = d.screen().root
            net_name, wm_name = d.intern_atom("_NET_WM_NAME"), d.intern_atom("WM_NAME")
            active_id = None
            try:
                prop = root.get_full_property(d.intern_atom("_NET_ACTIVE_WINDOW"), X.AnyPropertyType)
                if prop is not None and len(prop.value):
                    active_id = int(prop.value[0])
            except Exception:
                pass
            pointer = root.query_pointer()

            def title_of(win) -> str:
                for atom in (net_name, wm_name):
                    try:
                        prop = win.get_full_property(atom, X.AnyPropertyType)
                    except Exception:
                        continue
                    if prop is not None and prop.value:
                        v = prop.value
                        return (v.decode("utf-8", "replace") if isinstance(v, bytes) else str(v)).strip("\x00")
                return ""

            out: list[dict] = []

            def visit(win, depth: int) -> None:
                if len(out) >= max_windows or depth > 3:
                    return
                try:
                    attrs = win.get_attributes()
                    if attrs.map_state != X.IsViewable:
                        return
                    title = title_of(win)
                    geo = win.get_geometry()
                    if title and geo.width >= 24 and geo.height >= 24:
                        pos = win.translate_coords(root, 0, 0)
                        out.append({"id": win.id, "title": title, "x": -pos.x, "y": -pos.y, "w": geo.width, "h": geo.height,
                                    "active": win.id == active_id})
                        return  # do not descend into a titled window's children
                    for child in win.query_tree().children:
                        visit(child, depth + 1)
                except Exception:
                    return

            for child in root.query_tree().children:
                visit(child, 0)
            if active_id is None:  # no EWMH window manager: "focus follows pointer"
                for w in out:
                    if w["x"] <= pointer.root_x < w["x"] + w["w"] and w["y"] <= pointer.root_y < w["y"] + w["h"]:
                        w["active"] = True
            return out
        finally:
            d.close()
    except Exception:
        return []
