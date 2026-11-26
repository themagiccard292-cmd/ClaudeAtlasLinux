#!/usr/bin/env python3
"""AT-SPI accessibility helper.

Runs under the SYSTEM interpreter (needs `python3-gi` + `gir1.2-atspi-2.0`, or
`python3-pyatspi`). It is a separate process because PyGObject and its typelibs
cannot be bundled reliably inside the PyInstaller `backend-linux` binary.

Protocol: one JSON request on stdin -> one JSON response on stdout.

    {"op": "windows"}
    {"op": "tree",  "scope": "active"|"all"|"app:<name>", "max_nodes": 200, "max_depth": 12}
    {"op": "find",  "name": "Save", "role": "push button", "scope": "active", "limit": 10}
    {"op": "act",   "name": "Save", "role": "push button", "scope": "all", "index": 0}
"""
from __future__ import annotations

import json
import sys
import time

SKIP_LISTING_ROLES = {
    "filler", "panel", "section", "redundant object", "unknown", "scroll pane", "viewport",
    "layered pane", "split pane", "page tab list", "tool bar", "menu bar", "status bar",
    "table cell", "list", "tree", "table", "grouping", "form", "document frame", "frame",
    "application", "window", "separator", "drawing area", "canvas",
}
TOP_LEVEL_ROLES = {"frame", "dialog", "window", "alert", "file chooser", "notification"}
CLICK_ACTIONS = ("click", "press", "activate", "jump", "toggle", "open", "select", "check", "uncheck")


# ------------------------------------------------------------------------------ backends
class GiBackend:
    def __init__(self) -> None:
        import gi

        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi

        self.A = Atspi

    def desktop(self):
        return self.A.get_desktop(0)

    def children(self, acc):
        try:
            n = acc.get_child_count()
        except Exception:
            return
        for i in range(n):
            try:
                child = acc.get_child_at_index(i)
            except Exception:
                continue
            if child is not None:
                yield child

    def name(self, acc) -> str:
        try:
            return acc.get_name() or ""
        except Exception:
            return ""

    def role(self, acc) -> str:
        try:
            return acc.get_role_name() or ""
        except Exception:
            return ""

    def states(self, acc) -> set[str]:
        try:
            return {s.value_nick.replace("-", "_") for s in acc.get_state_set().get_states()}
        except Exception:
            return set()

    def extents(self, acc):
        try:
            comp = acc.get_component_iface()
            if comp is None:
                return None
            r = comp.get_extents(self.A.CoordType.SCREEN)
            return (r.x, r.y, r.width, r.height)
        except Exception:
            return None

    def actions(self, acc) -> list[str]:
        try:
            act = acc.get_action_iface()
            if act is None:
                return []
            return [act.get_action_name(i) for i in range(act.get_n_actions())]
        except Exception:
            return []

    def do_action(self, acc, idx: int) -> bool:
        try:
            return bool(acc.get_action_iface().do_action(idx))
        except Exception:
            return False

    def text(self, acc) -> str:
        try:
            t = acc.get_text_iface()
            if t is None:
                return ""
            # get_text_iface() returns the *Accessible* itself, so `t.get_text(0, n)` would hit the
            # deprecated Accessible.get_text(); the interface-level function is required.
            n = min(self.A.Text.get_character_count(t), 160)
            return (self.A.Text.get_text(t, 0, n) or "").replace("\n", " ")
        except Exception:
            return ""


class PyatspiBackend:
    def __init__(self) -> None:
        import pyatspi

        self.P = pyatspi

    def desktop(self):
        return self.P.Registry.getDesktop(0)

    def children(self, acc):
        try:
            n = acc.childCount
        except Exception:
            return
        for i in range(n):
            try:
                child = acc.getChildAtIndex(i)
            except Exception:
                continue
            if child is not None:
                yield child

    def name(self, acc) -> str:
        try:
            return acc.name or ""
        except Exception:
            return ""

    def role(self, acc) -> str:
        try:
            return acc.getRoleName() or ""
        except Exception:
            return ""

    def states(self, acc) -> set[str]:
        try:
            return {str(s).replace("STATE_", "").lower() for s in acc.getState().getStates()}
        except Exception:
            return set()

    def extents(self, acc):
        try:
            e = acc.queryComponent().getExtents(self.P.DESKTOP_COORDS)
            return (e.x, e.y, e.width, e.height)
        except Exception:
            return None

    def actions(self, acc) -> list[str]:
        try:
            a = acc.queryAction()
            return [a.getName(i) for i in range(a.nActions)]
        except Exception:
            return []

    def do_action(self, acc, idx: int) -> bool:
        try:
            return bool(acc.queryAction().doAction(idx))
        except Exception:
            return False

    def text(self, acc) -> str:
        try:
            t = acc.queryText()
            return (t.getText(0, min(t.characterCount, 160)) or "").replace("\n", " ")
        except Exception:
            return ""


def load_backend():
    errors = []
    for cls in (GiBackend, PyatspiBackend):
        try:
            return cls()
        except Exception as exc:  # ImportError, ValueError (missing typelib)
            errors.append(f"{cls.__name__}: {exc}")
    raise RuntimeError("AT-SPI bindings unavailable (install python3-gi gir1.2-atspi-2.0 or python3-pyatspi). "
                       + "; ".join(errors))


# --------------------------------------------------------------------------- tree logic
def _bbox_ok(box) -> bool:
    return bool(box) and box[2] > 0 and box[3] > 0 and not (box[0] == -1 and box[1] == -1)


def list_windows(be) -> list[dict]:
    out = []
    for app in be.children(be.desktop()):
        app_name = be.name(app)
        for win in be.children(app):
            states = be.states(win)
            out.append({
                "app": app_name, "title": be.name(win), "role": be.role(win),
                "active": "active" in states, "showing": "showing" in states or "visible" in states,
                "bbox": list(be.extents(win) or []) or None,
            })
    return out


def _scope_roots(be, scope: str):
    """Yield (app_name, window) pairs matching the requested scope."""
    pairs = []
    for app in be.children(be.desktop()):
        app_name = be.name(app)
        for win in be.children(app):
            pairs.append((app_name, win))
    if scope == "all":
        return [p for p in pairs if {"showing", "visible"} & be.states(p[1]) or not be.states(p[1])]
    if scope.startswith("app:"):
        needle = scope[4:].lower()
        return [p for p in pairs if needle in p[0].lower()]
    active = [p for p in pairs if "active" in be.states(p[1])]
    return active or [p for p in pairs if "showing" in be.states(p[1])][:1]


def walk(be, roots, max_nodes=200, max_depth=12, budget_s=4.0, only_listed=True):
    """BFS over showing nodes. Returns (nodes, truncated)."""
    deadline = time.monotonic() + budget_s
    nodes: list[dict] = []
    queue = [(app, win, 0, None) for app, win in roots]
    truncated = False
    idx = 0
    while queue:
        app, acc, depth, parent_name = queue.pop(0)
        if time.monotonic() > deadline or len(nodes) >= max_nodes:
            truncated = True
            break
        states = be.states(acc)
        if depth > 0 and states and "showing" not in states and "visible" not in states:
            continue  # prune invisible subtrees (big win for tab-heavy apps)
        role, name = be.role(acc), be.name(acc)
        acts = be.actions(acc)
        listed = (not only_listed) or role not in SKIP_LISTING_ROLES or bool(name and acts)
        if depth == 0:
            listed = True
        if listed and (name or acts or role in {"text", "entry", "password text", "terminal"} or depth == 0):
            box = be.extents(acc)
            idx += 1
            nodes.append({
                "id": idx, "app": app, "role": role, "name": name[:120],
                "text": be.text(acc) if role in {"text", "entry", "password text", "terminal", "paragraph"} else "",
                "bbox": list(box) if _bbox_ok(box) else None,
                "states": sorted(states & {"focused", "checked", "selected", "editable", "expanded",
                                           "collapsed", "pressed", "active", "enabled", "sensitive"}),
                "actions": acts, "depth": depth,
            })
            nodes[-1]["_acc"] = acc
        if depth < max_depth:
            for child in be.children(acc):
                queue.append((app, child, depth + 1, name))
    return nodes, truncated


def _public(node: dict) -> dict:
    return {k: v for k, v in node.items() if k != "_acc"}


def _matches(node: dict, name: str | None, role: str | None) -> bool:
    if name and name.lower() not in (node["name"] or "").lower() and name.lower() not in (node.get("text") or "").lower():
        return False
    if role and role.lower() not in (node["role"] or "").lower():
        return False
    return True


def handle(be, req: dict) -> dict:
    op = req.get("op")
    if op == "windows":
        return {"ok": True, "windows": list_windows(be)}

    scope = req.get("scope", "active")
    roots = _scope_roots(be, scope)
    if op == "tree":
        nodes, truncated = walk(be, roots, int(req.get("max_nodes", 200)), int(req.get("max_depth", 12)))
        return {"ok": True, "nodes": [_public(n) for n in nodes], "truncated": truncated,
                "scope": scope, "windows": len(roots)}

    if op in ("find", "act"):
        nodes, truncated = walk(be, roots, int(req.get("max_nodes", 1500)), 20, budget_s=5.0, only_listed=False)
        hits = [n for n in nodes if (n["name"] or n["text"]) and _matches(n, req.get("name"), req.get("role"))]
        if op == "find":
            limit = int(req.get("limit", 10))
            return {"ok": True, "matches": [_public(n) for n in hits[:limit]], "total": len(hits)}
        index = int(req.get("index", 0))
        if index >= len(hits):
            return {"ok": False, "error": f"No element matched name={req.get('name')!r} role={req.get('role')!r}",
                    "total": len(hits)}
        node = hits[index]
        acc = node["_acc"]
        for wanted in CLICK_ACTIONS:
            for i, act_name in enumerate(node["actions"]):
                if wanted in act_name.lower() and be.do_action(acc, i):
                    return {"ok": True, "method": f"atspi-action:{act_name}", "node": _public(node)}
        return {"ok": True, "method": "coordinates", "node": _public(node)}  # caller clicks bbox centre
    return {"ok": False, "error": f"unknown op {op!r}"}


def main() -> int:
    try:
        req = json.loads(sys.stdin.read() or "{}")
        be = load_backend()
        print(json.dumps(handle(be, req)))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
