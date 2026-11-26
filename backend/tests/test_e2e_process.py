"""Spawns `server.py` exactly like Electron does and talks to it over a real socket."""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest
from websockets.sync.client import connect

SERVER = Path(__file__).resolve().parent.parent / "server.py"
TOKEN = "tok-" + "x" * 20


@pytest.fixture()
def backend():
    env = dict(os.environ, XDG_SESSION_TYPE="x11", DISPLAY=os.environ.get("DISPLAY", ":0"),
               ATLAS_HOTKEY_BACKEND="none-such")  # keep global key listeners off in this test
    proc = subprocess.Popen([sys.executable, "-u", str(SERVER), "--port", "0", "--token", TOKEN,
                             "--exit-on-stdin-eof"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, env=env)
    port = None
    deadline = time.time() + 30
    while time.time() < deadline:
        line = proc.stdout.readline()
        if line.startswith("ATLAS_BACKEND_READY"):
            port = json.loads(line.split(" ", 1)[1])["port"]
            break
        if proc.poll() is not None:
            pytest.fail(f"backend exited early: {proc.stderr.read()}")
    assert port, "backend never announced readiness"
    yield proc, port
    if proc.poll() is None:
        proc.kill()


def call(ws, method, params=None, mid=1):
    ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv(timeout=30))
        if msg.get("id") == mid:
            return msg


def test_ready_handshake_auth_and_rpc(backend):
    _proc, port = backend
    with connect(f"ws://127.0.0.1:{port}/ws?token={TOKEN}") as ws:
        assert call(ws, "ping")["result"]["pong"] is True
        info = call(ws, "env.info")["result"]
        assert info["session"]["kind"] == "x11" and "version" in info
        assert call(ws, "kill.status", mid=2)["result"]["active"] is False


def test_wrong_token_is_refused(backend):
    _proc, port = backend
    with pytest.raises(Exception):
        with connect(f"ws://127.0.0.1:{port}/ws?token=nope") as ws:
            ws.recv(timeout=3)


def test_binds_loopback_only(backend):
    import socket
    _proc, port = backend
    # reachable on loopback ...
    socket.create_connection(("127.0.0.1", port), timeout=2).close()
    # ... and the CLI refuses non-loopback hosts outright
    res = subprocess.run([sys.executable, str(SERVER), "--host", "0.0.0.0", "--token", "t"],
                         capture_output=True, text=True, timeout=20)
    assert res.returncode == 2 and "non-loopback" in res.stderr


def test_exits_when_parent_closes_stdin(backend):
    proc, port = backend
    proc.stdin.close()  # what happens when Electron is SIGKILLed
    for _ in range(40):
        if proc.poll() is not None:
            break
        time.sleep(0.1)
    assert proc.poll() == 0, "orphaned backend kept running"


def test_requires_a_token():
    res = subprocess.run([sys.executable, str(SERVER)], capture_output=True, text=True, timeout=20,
                         env={k: v for k, v in os.environ.items() if k != "ATLAS_TOKEN"})
    assert res.returncode == 2 and "--token" in res.stderr
