"""Action normalisation + execution.

Claude returns JSON in *screenshot* coordinates. `ActionExecutor` converts them
to real input coordinates using the most recent capture, enforces the
confirmation policy and the kill switch, and dispatches to the right driver.
"""
from __future__ import annotations

import threading
import time
from typing import Any

from . import keys as K
from .atspi import AtspiService
from .capture import ScreenCapturer
from .errors import ActionError, KillSwitchTriggered, UnsupportedError
from .input_drivers import InputDriver
from .killswitch import KillSwitch
from .safety import classify_action
from .shell import ShellTool

ACTION_TYPES = {
    "click", "double_click", "right_click", "middle_click", "move", "drag", "scroll", "type",
    "hotkey", "key", "bash", "wait", "screenshot", "atspi_windows", "atspi_tree", "atspi_find", "atspi_click",
}
_POINT_KEYS = ("coordinate", "coordinates", "position", "point", "at")
_END_KEYS = ("to", "end", "end_coordinate", "target_coordinate")


def _num(v: Any, name: str) -> int:
    try:
        return round(float(v))
    except (TypeError, ValueError):
        raise ActionError(f"'{name}' must be a number, got {v!r}") from None


def _point(raw: dict, xk: str, yk: str, alt_keys: tuple[str, ...]) -> tuple[int, int] | None:
    if raw.get(xk) is not None and raw.get(yk) is not None:
        return _num(raw[xk], xk), _num(raw[yk], yk)
    for k in alt_keys:
        v = raw.get(k)
        if isinstance(v, (list, tuple)) and len(v) == 2:
            return _num(v[0], k), _num(v[1], k)
        if isinstance(v, dict) and "x" in v and "y" in v:
            return _num(v["x"], k), _num(v["y"], k)
    return None


def normalize_action(raw: dict) -> dict:
    """Validate an untrusted action dict and return a canonical one."""
    if not isinstance(raw, dict):
        raise ActionError("Action must be an object")
    kind = str(raw.get("action") or raw.get("type") or "").strip().lower()
    kind = {"left_click": "click", "mouse_move": "move", "press": "hotkey", "keypress": "hotkey",
            "shell": "bash", "run": "bash", "sleep": "wait", "scroll_down": "scroll"}.get(kind, kind)
    if kind not in ACTION_TYPES:
        raise ActionError(f"Unknown action {kind!r}. Valid: {', '.join(sorted(ACTION_TYPES))}")

    out: dict[str, Any] = {"type": kind}
    for passthrough in ("target", "reason"):
        if raw.get(passthrough):
            out[passthrough] = str(raw[passthrough])[:200]
    if raw.get("requires_confirmation"):
        out["requires_confirmation"] = True

    if kind in {"click", "double_click", "right_click", "middle_click", "move"}:
        pt = _point(raw, "x", "y", _POINT_KEYS)
        if pt is None:
            raise ActionError(f"'{kind}' needs x and y")
        out["x"], out["y"] = pt
        if kind == "click":
            button = str(raw.get("button", "left")).lower()
            if button not in ("left", "right", "middle"):
                raise ActionError(f"Invalid button {button!r}")
            out["button"] = button
            if raw.get("double"):
                out["type"] = "double_click"
    elif kind == "drag":
        start = _point(raw, "x", "y", _POINT_KEYS)
        end = _point(raw, "to_x", "to_y", _END_KEYS)
        if start is None or end is None:
            raise ActionError("'drag' needs x, y, to_x, to_y")
        out["x"], out["y"] = start
        out["to_x"], out["to_y"] = end
    elif kind == "scroll":
        direction = str(raw.get("direction", "down")).lower()
        if direction not in ("up", "down", "left", "right"):
            raise ActionError(f"Invalid scroll direction {direction!r}")
        amount = max(1, min(_num(raw.get("amount", 3), "amount"), 50))
        out.update(direction=direction, amount=amount)
        pt = _point(raw, "x", "y", _POINT_KEYS)
        if pt:
            out["x"], out["y"] = pt
    elif kind == "type":
        text = raw.get("text")
        if not isinstance(text, str) or text == "":
            raise ActionError("'type' needs non-empty 'text'")
        if len(text) > 4000:
            raise ActionError("'type' text too long (max 4000 chars); split it")
        out["text"] = text
    elif kind in {"hotkey", "key"}:
        combo = raw.get("keys") or raw.get("key") or raw.get("combo") or raw.get("text")
        if not combo:
            raise ActionError("'hotkey' needs 'keys' (e.g. [\"ctrl\",\"c\"])")
        out["type"] = "hotkey"
        out["keys"] = K.split_combo(combo)
    elif kind == "bash":
        cmd = raw.get("command") or raw.get("cmd")
        if not isinstance(cmd, str) or not cmd.strip():
            raise ActionError("'bash' needs 'command'")
        out["command"] = cmd
        out["timeout"] = max(1, min(_num(raw.get("timeout", 60), "timeout"), 600))
        if raw.get("cwd"):
            out["cwd"] = str(raw["cwd"])
    elif kind == "wait":
        out["seconds"] = max(0.0, min(float(raw.get("seconds", 1)), 30.0))
    elif kind in {"atspi_find", "atspi_click"}:
        name, role = raw.get("name"), raw.get("role")
        if not name and not role:
            raise ActionError(f"'{kind}' needs 'name' and/or 'role'")
        out.update(name=str(name) if name else None, role=str(role) if role else None,
                   index=max(0, _num(raw.get("index", 0), "index")))
        out["scope"] = str(raw.get("scope", "all"))
    elif kind == "atspi_tree":
        out["scope"] = str(raw.get("scope", "active"))
        out["max_nodes"] = max(10, min(_num(raw.get("max_nodes", 200), "max_nodes"), 600))
    return out


class ActionExecutor:
    def __init__(self, capturer: ScreenCapturer, driver: InputDriver | None, driver_error: str | None,
                 atspi: AtspiService, shell: ShellTool, ks: KillSwitch) -> None:
        self.capturer = capturer
        self.driver = driver
        self.driver_error = driver_error
        self.atspi = atspi
        self.shell = shell
        self.ks = ks
        self._lock = threading.Lock()  # one input action at a time

    # ----------------------------------------------------------------- helpers
    def classify(self, raw: dict) -> dict:
        action = normalize_action(raw)
        risk = classify_action(action)
        return {"action": action, "risk": risk.to_dict() if risk else None}

    def _need_driver(self) -> InputDriver:
        if self.driver is None:
            raise UnsupportedError(self.driver_error or "No input driver available")
        return self.driver

    def _screen(self, x: int, y: int) -> tuple[int, int]:
        shot = self.capturer.last
        if shot is None:
            shot = self.capturer.capture()
        return shot.to_screen(x, y)

    # ----------------------------------------------------------------- execute
    def execute(self, raw: dict, approved: bool = False) -> dict:
        started = time.monotonic()
        try:
            action = normalize_action(raw)
        except ActionError as exc:
            return {"ok": False, "error": str(exc), "code": exc.code}

        risk = classify_action(action)
        if risk and not approved:
            return {"ok": False, "needs_confirmation": True, "risk": risk.to_dict(), "action": action,
                    "message": f"Approval required: {risk.reason}"}

        result: dict[str, Any] = {"ok": True, "type": action["type"], "action": action}
        try:
            with self._lock:
                self.ks.check()
                self._dispatch(action, result)
        except KillSwitchTriggered as exc:
            return {"ok": False, "killed": True, "error": str(exc), "code": exc.code, "action": action}
        except (ActionError, UnsupportedError) as exc:
            return {"ok": False, "error": str(exc), "code": exc.code, "action": action}
        except Exception as exc:  # never let a driver bug crash the server
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "code": "internal", "action": action}
        result["duration_ms"] = round((time.monotonic() - started) * 1000)
        return result

    def _dispatch(self, a: dict, res: dict) -> None:
        kind = a["type"]
        if kind in {"click", "double_click", "right_click", "middle_click"}:
            sx, sy = self._screen(a["x"], a["y"])
            button = {"right_click": "right", "middle_click": "middle"}.get(kind, a.get("button", "left"))
            count = 2 if kind == "double_click" else 1
            self._need_driver().click(sx, sy, button, count)
            res.update(screen={"x": sx, "y": sy}, message=f"{kind} at ({a['x']},{a['y']}) → screen ({sx},{sy})")
        elif kind == "move":
            sx, sy = self._screen(a["x"], a["y"])
            self._need_driver().move(sx, sy)
            res.update(screen={"x": sx, "y": sy}, message=f"moved to ({a['x']},{a['y']})")
        elif kind == "drag":
            sx, sy = self._screen(a["x"], a["y"])
            ex, ey = self._screen(a["to_x"], a["to_y"])
            self._need_driver().drag(sx, sy, ex, ey)
            res.update(screen={"x": sx, "y": sy, "to_x": ex, "to_y": ey},
                       message=f"dragged ({a['x']},{a['y']}) → ({a['to_x']},{a['to_y']})")
        elif kind == "scroll":
            point = self._screen(a["x"], a["y"]) if "x" in a else (None, None)
            dx = {"left": -1, "right": 1}.get(a["direction"], 0) * a["amount"]
            dy = {"up": -1, "down": 1}.get(a["direction"], 0) * a["amount"]
            self._need_driver().scroll(point[0], point[1], dx, dy)
            res["message"] = f"scrolled {a['direction']} ×{a['amount']}"
        elif kind == "type":
            self._need_driver().type_text(a["text"])
            res["message"] = f"typed {len(a['text'])} characters"
        elif kind == "hotkey":
            self._need_driver().hotkey(a["keys"])
            res["message"] = "pressed " + "+".join(a["keys"])
        elif kind == "bash":
            out = self.shell.run(a["command"], a["timeout"], a.get("cwd"))
            res.update(output=out, ok=(out["exit_code"] == 0 and not out["timed_out"]),
                       message=f"exit {out['exit_code']}" + (" (timed out)" if out["timed_out"] else ""))
        elif kind == "wait":
            self.ks.sleep(a["seconds"])
            res["message"] = f"waited {a['seconds']}s"
        elif kind == "screenshot":
            res["message"] = "fresh screenshot will be attached"
        elif kind == "atspi_windows":
            wins = self.atspi.windows()
            res.update(output={"windows": wins},
                       message="\n".join(f"{'*' if w['active'] else ' '} {w['app']}: {w['title']}" for w in wins)
                       or "(no windows)")
        elif kind == "atspi_tree":
            data = self.atspi.tree(self.capturer.last, a["scope"], a["max_nodes"])
            res.update(output=data, message=data["text"])
        elif kind == "atspi_find":
            data = self.atspi.find(self.capturer.last, a.get("name"), a.get("role"), a["scope"])
            res.update(output=data, message=data["text"])
        elif kind == "atspi_click":
            data = self.atspi.act(a.get("name"), a.get("role"), a["scope"], a["index"])
            if not data.get("ok"):
                raise ActionError(data.get("error", "AT-SPI action failed"))
            node = data["node"]
            if data["method"] == "coordinates":
                box = node.get("bbox")
                if not box:
                    raise ActionError("Element has no on-screen geometry; try a coordinate click")
                cx, cy = round(box[0] + box[2] / 2), round(box[1] + box[3] / 2)
                self._need_driver().click(cx, cy, "left", 1)
                res.update(screen={"x": cx, "y": cy})
            res.update(output=data, message=f"atspi_click {node['role']} “{node['name']}” via {data['method']}")
