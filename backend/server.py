#!/usr/bin/env python3
"""Claude OS Agent backend — FastAPI + WebSocket on a dynamic localhost port.

Launched by Electron:   backend-linux --port 41234 --token <random> --exit-on-stdin-eof
Protocol (JSON text frames over ws://127.0.0.1:<port>/ws?token=<token>):

    → {"id": 7, "method": "screen.capture", "params": {...}}
    ← {"id": 7, "result": {...}}            or   {"id": 7, "error": {"code": "...", "message": "..."}}
    ← {"event": "kill.triggered", "data": {...}}      (server push)
"""
from __future__ import annotations

import argparse
import asyncio
import hmac
import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Callable

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from agent_os import __version__
from agent_os.context import AppContext
from agent_os.rpc import RpcError, RpcService

READY_MARKER = "ATLAS_BACKEND_READY"


class Hub:
    """Thread-safe broadcast of server events to every connected socket."""

    def __init__(self) -> None:
        self.loop: asyncio.AbstractEventLoop | None = None
        self.queues: set[asyncio.Queue] = set()

    def emit(self, event: str, data: dict) -> None:  # callable from any thread
        loop = self.loop
        if loop is None or loop.is_closed():
            return
        frame = json.dumps({"event": event, "data": data})
        loop.call_soon_threadsafe(self._fanout, frame)

    def _fanout(self, frame: str) -> None:
        for q in list(self.queues):
            if q.qsize() > 500 and '"voice.level"' in frame:  # shed visualiser frames under pressure
                continue
            if q.qsize() > 6 and '"screen.frame"' in frame:  # a slow consumer must never build up video backlog
                continue
            q.put_nowait(frame)


def create_app(token: str, ctx_factory: Callable[[Callable[[str, dict], None]], AppContext] | None = None,
               start_services: bool = True) -> FastAPI:
    hub = Hub()
    pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix="rpc")
    state: dict = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        hub.loop = asyncio.get_running_loop()
        ctx = (ctx_factory or AppContext)(hub.emit)
        state["ctx"], state["rpc"] = ctx, RpcService(ctx)
        ACTIVE["ctx"] = ctx
        if start_services:
            await asyncio.get_running_loop().run_in_executor(pool, ctx.start)
        yield
        ctx.stop()
        pool.shutdown(wait=False, cancel_futures=True)

    app = FastAPI(title="Claude OS Agent backend", version=__version__, lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/health")
    async def health() -> dict:
        return {"ok": True, "version": __version__}

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket) -> None:
        supplied = ws.query_params.get("token", "")
        if not hmac.compare_digest(supplied.encode(), token.encode()):
            await ws.close(code=4401)
            return
        await ws.accept()
        rpc: RpcService = state["rpc"]
        outbox: asyncio.Queue = asyncio.Queue()
        hub.queues.add(outbox)

        async def writer() -> None:
            while True:
                await ws.send_text(await outbox.get())

        async def handle(msg: dict) -> None:
            mid = msg.get("id")
            method = str(msg.get("method", ""))
            try:
                if method in RpcService.FAST:
                    result = rpc.call_sync(method, msg.get("params"))
                else:
                    result = await asyncio.get_running_loop().run_in_executor(
                        pool, rpc.call_sync, method, msg.get("params"))
                frame = {"id": mid, "result": result}
            except RpcError as exc:
                frame = {"id": mid, "error": {"code": exc.code, "message": str(exc)}}
            except Exception as exc:  # pragma: no cover - last resort
                frame = {"id": mid, "error": {"code": "internal", "message": f"{type(exc).__name__}: {exc}"}}
            await outbox.put(json.dumps(frame, default=str))

        writer_task = asyncio.create_task(writer())
        tasks: set[asyncio.Task] = set()
        try:
            while True:
                try:
                    msg = json.loads(await ws.receive_text())
                except ValueError:
                    continue
                t = asyncio.create_task(handle(msg))
                tasks.add(t)
                t.add_done_callback(tasks.discard)
        except WebSocketDisconnect:
            pass
        finally:
            hub.queues.discard(outbox)
            writer_task.cancel()
            for t in tasks:
                t.cancel()

    return app


ACTIVE: dict = {}


def _watch_stdin_for_parent_death() -> None:
    """Electron holds our stdin open; EOF means it died → exit instead of orphaning."""
    def watch() -> None:
        try:
            while sys.stdin.buffer.read(4096):
                pass
        except Exception:
            pass
        ctx = ACTIVE.get("ctx")
        if ctx is not None:  # don't leave the sandbox's Xvfb behind
            try:
                ctx.stop()
            except Exception:
                pass
        os._exit(0)

    threading.Thread(target=watch, name="parent-watch", daemon=True).start()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Claude OS Agent backend")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=0, help="0 = pick a free port")
    ap.add_argument("--token", default=os.environ.get("ATLAS_TOKEN", ""))
    ap.add_argument("--exit-on-stdin-eof", action="store_true")
    ap.add_argument("--version", action="store_true")
    args = ap.parse_args(argv)

    if args.version:
        print(__version__)
        return 0
    if not args.token:
        print("error: --token (or ATLAS_TOKEN) is required", file=sys.stderr)
        return 2
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print("error: refusing to bind to a non-loopback address", file=sys.stderr)
        return 2

    import socket

    import uvicorn

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((args.host, args.port))
    port = sock.getsockname()[1]

    if args.exit_on_stdin_eof:
        _watch_stdin_for_parent_death()

    app = create_app(args.token)
    config = uvicorn.Config(app, log_level="warning", ws_max_size=32 * 1024 * 1024, access_log=False)
    server = uvicorn.Server(config)

    orig_startup = server.startup

    async def startup(sockets=None):  # announce only once we are really serving
        await orig_startup(sockets)
        print(f"{READY_MARKER} {json.dumps({'port': port, 'version': __version__})}", flush=True)

    server.startup = startup  # type: ignore[method-assign]
    server.run(sockets=[sock])
    return 0


if __name__ == "__main__":
    sys.exit(main())
