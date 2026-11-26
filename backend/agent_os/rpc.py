"""JSON-RPC style method table exposed over the WebSocket.

Every method takes a `params` dict and returns something JSON-serialisable.
Raw shell access is deliberately NOT exposed: `bash` only runs through
`action.execute`, so the confirmation policy cannot be bypassed.
"""
from __future__ import annotations

import base64
from typing import Any, Callable

from . import __version__
from .config import is_frozen
from .context import AppContext
from .errors import AgentOSError


class RpcError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class RpcService:
    #: methods that must never wait behind a busy worker pool
    FAST = {"ping", "kill.trigger", "kill.reset", "kill.status"}

    def __init__(self, ctx: AppContext) -> None:
        self.ctx = ctx
        self.table: dict[str, Callable[[dict], Any]] = {
            "ping": lambda p: {"pong": True},
            "env.info": self.env_info,
            "screen.capture": self.screen_capture,
            "action.execute": self.action_execute,
            "action.classify": lambda p: ctx.executor.classify(p["action"]),
            "atspi.status": lambda p: ctx.atspi.status(),
            "atspi.windows": lambda p: {"windows": ctx.atspi.windows()},
            "atspi.tree": lambda p: ctx.atspi.tree(ctx.capturer.last, p.get("scope", "active"), int(p.get("max_nodes", 200))),
            "atspi.find": lambda p: ctx.atspi.find(ctx.capturer.last, p.get("name"), p.get("role"), p.get("scope", "all")),
            "kill.status": lambda p: ctx.ks.status(),
            "kill.trigger": self.kill_trigger,
            "kill.reset": self.kill_reset,
            "hotkeys.status": lambda p: ctx.hotkey_status,
            "voice.state": lambda p: ctx.voice.state(),
            "voice.devices": lambda p: ctx.voice.devices(),
            "voice.configure": lambda p: ctx.voice.configure(**p),
            "voice.ptt": self.voice_ptt,
            "voice.hands_free": lambda p: (ctx.voice.set_hands_free(bool(p.get("on"))), ctx.voice.state())[1],
            "voice.listen_once": lambda p: (ctx.voice.listen_once(), {"ok": True})[1],
            "voice.speak": lambda p: (ctx.voice.speak(str(p.get("text", ""))), {"ok": True})[1],
            "voice.stop_speaking": lambda p: (ctx.voice.stop_speaking(), {"ok": True})[1],
            "voice.agent_busy": lambda p: (ctx.voice.set_agent_busy(bool(p.get("busy"))), {"ok": True})[1],
            "voice.preload": lambda p: (ctx.voice.preload(), {"ok": True})[1],
        }

    # ------------------------------------------------------------------ methods
    def env_info(self, _p: dict) -> dict:
        c = self.ctx
        return {
            "version": __version__,
            "frozen": is_frozen(),
            "session": c.env.to_dict(),
            "input": {"driver": c.driver.name if c.driver else None, "error": c.driver_error},
            "atspi": c.atspi.status(),
            "hotkeys": c.hotkey_status,
            "voice": c.voice.state(),
            "kill": c.ks.status(),
            "primary_monitor": _monitor(c.capturer.primary_monitor()),
        }

    def screen_capture(self, p: dict) -> dict:
        shot = self.ctx.capturer.capture(
            max_width=int(p.get("max_width", 1280)), max_height=int(p.get("max_height", 720)),
            quality=int(p.get("quality", 70)), mask=p.get("mask"), draw_cursor=bool(p.get("cursor", True)))
        return {"image_b64": base64.b64encode(shot.jpeg).decode("ascii"), **shot.meta()}

    def action_execute(self, p: dict) -> dict:
        return self.ctx.executor.execute(p["action"], approved=bool(p.get("approved", False)))

    def kill_trigger(self, p: dict) -> dict:
        self.ctx.ks.trigger(str(p.get("source", "ui")))
        return self.ctx.ks.status()

    def kill_reset(self, _p: dict) -> dict:
        self.ctx.ks.reset()
        self.ctx.emit("kill.reset", {})
        return self.ctx.ks.status()

    def voice_ptt(self, p: dict) -> dict:
        self.ctx.voice.ptt(bool(p.get("down")))
        return self.ctx.voice.state()

    # ------------------------------------------------------------------ dispatch
    def lookup(self, method: str) -> Callable[[dict], Any]:
        fn = self.table.get(method)
        if fn is None:
            raise RpcError("method_not_found", f"Unknown method {method!r}")
        return fn

    def call_sync(self, method: str, params: dict | None) -> Any:
        fn = self.lookup(method)
        try:
            return fn(params or {})
        except RpcError:
            raise
        except AgentOSError as exc:
            raise RpcError(exc.code, str(exc)) from exc
        except KeyError as exc:
            raise RpcError("bad_params", f"Missing parameter: {exc}") from exc
        except TypeError as exc:
            raise RpcError("bad_params", str(exc)) from exc


def _monitor(m) -> dict | None:
    return None if m is None else {"name": m.name, "x": m.x, "y": m.y, "width": m.w, "height": m.h}
